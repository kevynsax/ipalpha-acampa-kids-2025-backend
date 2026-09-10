import { Hono } from "hono";
import { config } from "../config";
import { findByPhone, toPublicUser, updateUser } from "../models/users";
import { comteleEnabled, comteleSendSms } from "../services/comtele";
import { generateLocalCode, hashCode, verifyLocalCode } from "../services/otp";
import { createSession, revokeSession, verifySessionToken } from "../services/session";
import type { PublicUser, Role, SessionUser } from "../types";
import { formatBrazilPhone, minutesBetween, normalizeBrazilPhone, pickActiveRole } from "../utils";
import { requireAuth } from "../middleware/auth";

interface AuthEnv {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

const auth = new Hono<AuthEnv>();

/**
 * The same person can hold multiple roles (parent + staff + admin).
 * Login flow: phone number only. The session's active role is picked
 * automatically as the highest-privilege role the person holds.
 */
auth.post("/otp/request", async (c) => {
  const body = await c.req.json<{ phone?: string }>().catch(() => null);

  const phone = body?.phone ? normalizeBrazilPhone(body.phone) : null;
  if (!phone) {
    return c.json(
      { error: { code: "PHONE_INVALID", message: "Informe um celular brasileiro válido com DDD." } },
      400,
    );
  }

  // look up the PERSON by phone (unique)
  const user = await findByPhone(phone);
  if (!user) {
    return c.json(
      {
        error: {
          code: "USER_NOT_FOUND",
          message: "Nenhum cadastro encontrado para este telefone.",
        },
      },
      404,
    );
  }
  const role: Role = pickActiveRole(user.roles);

  // frozen account?
  if (user.frozenUntil && user.frozenUntil > new Date()) {
    const minutesLeft = minutesBetween(new Date(), user.frozenUntil);
    return c.json(
      {
        error: {
          code: "ACCOUNT_FROZEN",
          message: `Conta bloqueada por tentativas incorretas. Tente novamente em ${minutesLeft} minuto(s).`,
          minutesLeft,
        },
      },
      423,
    );
  }

  // resend cooldown
  if (user.otp) {
    const secondsSince = (Date.now() - user.otp.requestedAt.getTime()) / 1000;
    if (secondsSince < config.otp.resendCooldownSeconds) {
      const secondsLeft = Math.ceil(config.otp.resendCooldownSeconds - secondsSince);
      return c.json(
        {
          error: {
            code: "OTP_COOLDOWN",
            message: `Aguarde ${secondsLeft}s para pedir um novo código.`,
            secondsLeft,
          },
        },
        429,
      );
    }
  }

  // send the code
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.otp.expireMinutes * 60 * 1000);

  // the code is ALWAYS generated here (so it can be logged and verified
  // locally); Comtele only delivers it by SMS when configured
  const code = generateLocalCode();
  const viaSms = comteleEnabled();

  if (viaSms) {
    const result = await comteleSendSms(
      phone,
      `${config.comtele.prefix}: seu código de acesso é ${code}. Vale por ${config.otp.expireMinutes} minutos.`,
    );
    if (!result.ok) {
      console.error("[comtele] send failed:", result.message);
      return c.json(
        {
          error: {
            code: "SMS_SEND_FAILED",
            message: "Não foi possível enviar o SMS agora. Tente novamente em instantes.",
          },
        },
        502,
      );
    }
  }

  console.log(
    `\n📩 [OTP${viaSms ? " · SMS" : " · DEV MOCK"}] ${user.name} — ${formatBrazilPhone(phone)} (entrando como ${role}): ${code}\n`,
  );

  await updateUser(user._id, {
    otp: {
      provider: viaSms ? "comtele" : "local",
      codeHash: hashCode(code),
      requestedRole: role,
      requestedAt: now,
      expiresAt,
      attempts: 0,
    },
  });

  return c.json({
    success: true,
    phone,
    role,
    roles: user.roles,
    expiresAt: expiresAt.toISOString(),
    expireMinutes: config.otp.expireMinutes,
    delivery: comteleEnabled() ? "sms" : "mock",
  });
});

auth.post("/otp/verify", async (c) => {
  const body = await c.req.json<{ phone?: string; code?: string }>().catch(() => null);

  const phone = body?.phone ? normalizeBrazilPhone(body.phone) : null;
  const code = (body?.code ?? "").replace(/\D/g, "");

  if (!phone) {
    return c.json(
      { error: { code: "PHONE_INVALID", message: "Telefone inválido." } },
      400,
    );
  }
  if (code.length !== config.otp.length) {
    return c.json(
      { error: { code: "OTP_INVALID_FORMAT", message: `Informe os ${config.otp.length} dígitos do código.` } },
      400,
    );
  }

  const user = await findByPhone(phone);
  if (!user) {
    return c.json(
      { error: { code: "USER_NOT_FOUND", message: "Cadastro não encontrado." } },
      404,
    );
  }
  const role: Role = pickActiveRole(user.roles);

  // frozen?
  if (user.frozenUntil && user.frozenUntil > new Date()) {
    const minutesLeft = minutesBetween(new Date(), user.frozenUntil);
    return c.json(
      {
        error: {
          code: "ACCOUNT_FROZEN",
          message: `Conta bloqueada por tentativas incorretas. Tente novamente em ${minutesLeft} minuto(s).`,
          minutesLeft,
        },
      },
      423,
    );
  }

  if (!user.otp) {
    return c.json(
      { error: { code: "OTP_NOT_REQUESTED", message: "Peça um código primeiro." } },
      400,
    );
  }

  // expired?
  if (user.otp.expiresAt <= new Date()) {
    return c.json(
      {
        error: {
          code: "OTP_EXPIRED",
          message: "O código expirou. Peça um novo código.",
        },
      },
      400,
    );
  }

  // validate the code (always generated and hashed on our side)
  const valid = !!user.otp.codeHash && verifyLocalCode(code, user.otp.codeHash);

  if (!valid) {
    const attempts = user.otp.attempts + 1;

    if (attempts >= config.otp.maxAttempts) {
      // freeze the account
      const frozenUntil = new Date(Date.now() + config.otp.freezeMinutes * 60 * 1000);
      await updateUser(user._id, { otp: null, frozenUntil });
      console.warn(
        `[auth] Account frozen for ${config.otp.freezeMinutes}min: ${formatBrazilPhone(phone)} (${user.roles.join(", ")})`,
      );
      return c.json(
        {
          error: {
            code: "ACCOUNT_FROZEN",
            message: `Código incorreto ${config.otp.maxAttempts}x. A conta foi bloqueada por ${config.otp.freezeMinutes} minutos.`,
            minutesLeft: config.otp.freezeMinutes,
          },
        },
        423,
      );
    }

    await updateUser(user._id, { otp: { ...user.otp, attempts } });
    const attemptsLeft = config.otp.maxAttempts - attempts;
    return c.json(
      {
        error: {
          code: "OTP_INVALID",
          message: "Código incorreto.",
          attemptsLeft,
        },
      },
      400,
    );
  }

  // success — clear OTP, unfreeze, create session for the highest role held (24h)
  await updateUser(user._id, { otp: null, frozenUntil: null });

  const { token, session } = await createSession(user._id, role);

  return c.json({
    success: true,
    token,
    tokenExpiresAt: session.expiresAt.toISOString(),
    user: { ...toPublicUser(user), activeRole: role },
  });
});

/** Who am I? (requires Bearer token) */
auth.get("/me", requireAuth, async (c) => {
  return c.json({ user: c.get("user") });
});

/** Logout — revokes the session */
auth.post("/logout", requireAuth, async (c) => {
  await revokeSession(c.get("sessionId"));
  return c.json({ success: true });
});

export default auth;
export type { PublicUser };
