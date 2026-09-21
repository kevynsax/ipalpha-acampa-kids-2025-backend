import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { config } from "../config";
import { getDb } from "../db";
import { requireAuth } from "../middleware/auth";
import { requireAdmin, requireSuperAdmin } from "../middleware/roles";
import { ensureLoginAccount, listAdmins, loadAdminPhones } from "../models/users";
import { handoverCamp } from "../services/campHandover";
import { comteleEnabled, comteleSendSms } from "../services/comtele";
import { publish } from "../services/realtime";
import type { Role, SessionUser } from "../types";
import { normalizeBrazilPhone, normalizeEmail } from "../utils";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

const admins = new Hono<Env>();

/** What the wizard needs to invite another admin: the link + whether an SMS can carry it. */
function superAdminPhone(): string | null {
  return config.superAdminPhone ? normalizeBrazilPhone(config.superAdminPhone) : null;
}

/**
 * GET /api/admins — admin. Every admin account (name + phone), so the setup
 * wizard can show who already manages the app and who else can be invited.
 */
admins.get("/", requireAuth, requireAdmin, async (c) => {
  const superPhone = superAdminPhone();
  const list = (await listAdmins()).map((a) => ({
    id: a._id,
    name: a.name,
    phone: a.phone,
    /** the SUPER_ADMIN_PHONE account: cannot lose the admin role */
    superAdmin: !!superPhone && a.phone === superPhone,
  }));
  return c.json({ admins: list, appUrl: config.appUrl, smsEnabled: comteleEnabled() });
});

/**
 * POST /api/admins — admin. Grants the admin role to a phone (creating the
 * login account when needed) and, when `sendSms` is on, texts the person the
 * app link so they can log in right away. Does not put them on the team roster.
 */
/** SUPER ADMIN: reset the camp and hand it to one new admin, forced through the wizard. */
admins.post("/handover", requireAuth, requireAdmin, async (c) => {
  const superPhone = superAdminPhone();
  if (!superPhone || c.get("user").phone !== superPhone) {
    return c.json({ error: { code: "FORBIDDEN", message: "Só o administrador da implantação pode passar o acampamento." } }, 403);
  }

  const body = await c.req.json<{ name?: string; phone?: string; email?: string; notify?: boolean }>().catch(() => null);
  const name = (body?.name ?? "").trim();
  const phone = body?.phone ? normalizeBrazilPhone(body.phone) : null;
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : null;
  if (!name) return c.json({ error: { code: "NAME_INVALID", message: "Informe o nome." } }, 400);
  if (!phone) return c.json({ error: { code: "PHONE_INVALID", message: "Informe um celular brasileiro válido com DDD." } }, 400);
  if (!email) return c.json({ error: { code: "EMAIL_INVALID", message: email === "" ? "Informe um e-mail válido." : "Informe o e-mail." } }, 400);
  if (phone === superPhone) {
    return c.json({ error: { code: "SUPER_ADMIN_LOCKED", message: "Esse celular é o da implantação. Escolha o admin do acampamento." } }, 400);
  }

  try {
    const result = await handoverCamp({ superPhone, name, phone, email, notify: body?.notify !== false });
    console.log(`🧹 handover by ${c.get("user").name} → ${result.admin.name} ${result.admin.phone}: users ${result.usersRemoved}`);
    return c.json(result);
  } catch (err) {
    console.error("handover failed", err);
    return c.json({ error: { code: "HANDOVER_FAILED", message: "Não foi possível limpar e criar o novo administrador." } }, 500);
  }
});

admins.post("/", requireAuth, requireSuperAdmin, async (c) => {
  const body = await c.req.json<{ name?: string; phone?: string; sendSms?: boolean; locale?: string }>().catch(() => null);
  const name = (body?.name ?? "").trim();
  const phone = body?.phone ? normalizeBrazilPhone(body.phone) : null;
  if (!name) return c.json({ error: { code: "NAME_INVALID", message: "Informe o nome." } }, 400);
  if (!phone) return c.json({ error: { code: "PHONE_INVALID", message: "Informe um celular brasileiro válido com DDD." } }, 400);

  await ensureLoginAccount(name, phone, "admin");
  await loadAdminPhones();
  publish("staff");

  // the invite SMS: admins always receive their own texts (never redirected)
  let smsSent = false;
  if (body?.sendSms !== false && comteleEnabled() && config.appUrl) {
    const first = name.split(/\s+/)[0];
    const { resolveLocale, sms, smsPrefix } = await import("../i18n");
    const locale = resolveLocale(body?.locale);
    const result = await comteleSendSms(phone, sms(locale, "adminInvite", { prefix: smsPrefix(), name: first, url: config.appUrl }));
    smsSent = result.ok;
    if (!result.ok) console.error("[comtele] admin invite failed:", result.message);
  }

  const doc = await (await getDb()).collection("users").findOne({ phone });
  return c.json({
    admin: { id: (doc?._id as ObjectId).toString(), name: (doc?.name as string) ?? name, phone, superAdmin: phone === superAdminPhone() },
    appUrl: config.appUrl,
    smsSent,
  });
});

/**
 * DELETE /api/admins/:id — admin. Removes the admin role from an account
 * (never from yourself, never from SUPER_ADMIN_PHONE). Other roles the
 * person holds (team, parent) are kept.
 */
admins.delete("/:id", requireAuth, requireSuperAdmin, async (c) => {
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: { code: "NOT_FOUND", message: "Conta não encontrada." } }, 404);
  if (id === c.get("userId")) return c.json({ error: { code: "SELF_FORBIDDEN", message: "Você não pode remover o próprio acesso de admin." } }, 400);
  const db = await getDb();
  const doc = await db.collection("users").findOne({ _id: new ObjectId(id) });
  if (!doc) return c.json({ error: { code: "NOT_FOUND", message: "Conta não encontrada." } }, 404);
  const superPhone = superAdminPhone();
  if (superPhone && doc.phone === superPhone) {
    return c.json({ error: { code: "SUPER_ADMIN_LOCKED", message: "O administrador da implantação sempre mantém o acesso." } }, 403);
  }
  const roles = ((doc.roles as Role[]) ?? []).filter((r) => r !== "admin");
  if (roles.length === 0) await db.collection("users").deleteOne({ _id: new ObjectId(id) });
  else await db.collection("users").updateOne({ _id: new ObjectId(id) }, { $set: { roles, updatedAt: new Date() } });
  await loadAdminPhones();
  publish("staff");
  return c.json({ success: true });
});

export default admins;
