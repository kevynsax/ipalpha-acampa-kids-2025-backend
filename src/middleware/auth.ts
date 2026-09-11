import { createMiddleware } from "hono/factory";
import { findById, toPublicUser } from "../models/users";
import { revokeUserSessions, verifySessionToken } from "../services/session";
import { getSettings } from "../models/settings";
import { findStaffByPhone } from "../models/staff";
import { staffHasAccess } from "../services/scope";
import type { Role, SessionUser } from "../types";

/**
 * Ordinary team members lose their session the moment `staffAccessWindow`
 * closes. Returns true when the session must be dropped (and drops it).
 */
export async function staffSessionExpired(role: Role, phone: string, userId: string): Promise<boolean> {
  if (role !== "staff" && role !== "health_staff") return false;
  const me = await findStaffByPhone(phone);
  if (!me) return false;
  if (staffHasAccess(me._id, await getSettings())) return false;
  await revokeUserSessions(userId);
  return true;
}

export const requireAuth = createMiddleware<{
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: SessionUser["activeRole"];
    user: SessionUser;
  };
}>(async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Token ausente." } },
      401,
    );
  }

  const payload = await verifySessionToken(token);
  if (!payload) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Sessão inválida ou expirada." } },
      401,
    );
  }

  const user = await findById(payload.userId);
  if (!user) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Usuário não encontrado." } },
      401,
    );
  }

  if (await staffSessionExpired(payload.role, user.phone, user._id)) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "O período de acesso da equipe terminou." } },
      401,
    );
  }

  // the active role is the one chosen at login
  c.set("userId", user._id);
  c.set("sessionId", payload.sessionId);
  c.set("activeRole", payload.role);
  c.set("user", { ...toPublicUser(user), activeRole: payload.role });

  await next();
});
