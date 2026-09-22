import { createMiddleware } from "hono/factory";
import { findById, toPublicUser } from "../models/users";
import { listCampersOfGuardian } from "../models/campers";
import { revokeSession, revokeUserSessions, verifySessionToken } from "../services/session";
import { getSettings, staffAccessOpen } from "../models/settings";
import { findStaffByPhone } from "../models/staff";
import { staffHasAccess } from "../services/scope";
import { activeCampId, withCamp } from "../services/campContext";
import { canSwitchCamps } from "../services/campAccess";
import type { Role, SessionUser, User } from "../types";

/**
 * A live session whose profile the person may no longer enter with (tokens
 * last days, the data changes under them):
 *
 *   - PARENT without a single kid enrolled — the enrolment was cancelled, or
 *     the account merely carries a stale `roles: ["parent"]`.
 *   - STAFF without an active roster record — including an administrator who
 *     chose the separate team profile after OTP.
 *
 * Returns true when the session must be dropped (and drops it).
 */
export async function roleNoLongerValid(role: Role, user: Pick<User, "_id" | "phone" | "roles">): Promise<boolean> {
  const invalid = role === "parent"
    ? (await listCampersOfGuardian(user.phone)).length === 0
    : role === "staff" ? !(await findStaffByPhone(user.phone))?.active : false;
  if (!invalid) return false;
  await revokeUserSessions(user._id);
  return true;
}

/**
 * Ordinary team members lose their session the moment `staffAccessWindow`
 * closes; parents the moment `parentAccessWindow` closes. Returns true when the session must be dropped (and drops it).
 */
export async function staffSessionExpired(role: Role, phone: string, userId: string): Promise<boolean> {
  if (role === "parent") {
    if (staffAccessOpen((await getSettings()).parentAccessWindow)) return false;
    await revokeUserSessions(userId);
    return true;
  }
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
    campId: string;
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

  return withCamp(payload.campId, async () => {
    const user = await findById(payload.userId);
    if (!user) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Usuário não encontrado." } },
        401,
      );
    }

    const history = payload.campId !== activeCampId();

    if (history) {
      // the roster row / access window belong to another year — irrelevant here
      if (!(await canSwitchCamps(toPublicUser(user), payload.role))) {
        await revokeSession(payload.sessionId);
        return c.json(
          { error: { code: "UNAUTHORIZED", message: "Sessão inválida ou expirada." } },
          401,
        );
      }
    } else {
      if (await staffSessionExpired(payload.role, user.phone, user._id)) {
        return c.json(
          { error: { code: "UNAUTHORIZED", message: "O período de acesso da equipe terminou." } },
          401,
        );
      }

      if (await roleNoLongerValid(payload.role, user)) {
        return c.json(
          { error: { code: "UNAUTHORIZED", message: "Este perfil não está mais disponível para você. Entre novamente." } },
          401,
        );
      }
    }

    // the active role is the one chosen at login — forced to admin for reads on a history session
    const activeRole: Role = history ? "admin" : payload.role;
    c.set("userId", user._id);
    c.set("sessionId", payload.sessionId);
    c.set("activeRole", activeRole);
    c.set("user", { ...toPublicUser(user), activeRole });
    c.set("campId", payload.campId);

    await next();
  });
});
