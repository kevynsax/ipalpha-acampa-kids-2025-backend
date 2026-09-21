import { createMiddleware } from "hono/factory";
import { config } from "../config";
import type { Role, SessionUser } from "../types";
import { normalizeBrazilPhone } from "../utils";

/**
 * Restricts a route to sessions whose ACTIVE role is one of `allowed`.
 * Must run after `requireAuth` (relies on `activeRole`).
 */
export function requireRole(...allowed: Role[]) {
  return createMiddleware<{ Variables: { activeRole: Role } }>(async (c, next) => {
    const role = c.get("activeRole");
    if (!role || !allowed.includes(role)) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "Você não tem permissão para acessar este recurso.",
          },
        },
        403,
      );
    }
    await next();
  });
}

/** The real admin only: organizers list, categories, notifications, about. */
export const requireAdmin = requireRole("admin");

/**
 * Deployment owner only (SUPER_ADMIN_PHONE): granting/removing the admin role
 * itself. Regular admins can no longer create, edit or remove other admins.
 * Must run after `requireAuth` (relies on `user`).
 */
export const requireSuperAdmin = createMiddleware<{ Variables: { user: SessionUser } }>(async (c, next) => {
  const superPhone = config.superAdminPhone ? normalizeBrazilPhone(config.superAdminPhone) : null;
  if (!superPhone || c.get("user").phone !== superPhone) {
    return c.json({ error: { code: "FORBIDDEN", message: "Só o administrador da implantação pode gerenciar administradores." } }, 403);
  }
  await next();
});

type ScopeEnv = { Variables: { activeRole: Role; user: SessionUser } };

/** admin, or a team session whose resolved scope passes `check` */
function requireScope(check: (scope: import("../services/scope").Scope) => boolean, message: string) {
  return createMiddleware<ScopeEnv>(async (c, next) => {
    const role = c.get("activeRole");
    const forbid = (msg: string) => c.json({ error: { code: "FORBIDDEN", message: msg } }, 403);
    if (role === "admin") return next();
    if (role !== "staff" && role !== "health_staff") return forbid("Você não tem permissão para acessar este recurso.");
    // lazy import: scope.ts → models → … keeps this module free of a load-order cycle
    const { resolveScope } = await import("../services/scope");
    if (!check(await resolveScope(c.get("user")))) return forbid(message);
    await next();
  });
}

/**
 * Everything the admin does except the admin-only settings: admin, or a team
 * member the admin listed as an ORGANIZER (Settings → Organizadores; see
 * services/scope.ts#canManage). Must run after `requireAuth`.
 */
export const requireManager = requireScope((s) => s.all, "Só a organização pode fazer isso.");

/**
 * Writes to the programme (events, roles, assignments, editor images): admin,
 * organizer or GAME organizer (see services/scope.ts#canOrganize).
 */
export const requireOrganizer = requireScope((s) => s.all || s.organizer, "Só a organização pode alterar a programação.");
