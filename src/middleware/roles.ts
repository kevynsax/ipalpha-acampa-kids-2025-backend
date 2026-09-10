import { createMiddleware } from "hono/factory";
import type { Role, SessionUser } from "../types";

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

export const requireAdmin = requireRole("admin");

/**
 * Writes to the programme (events, roles, assignments, editor images): admin,
 * or a team member the admin listed as an ORGANIZER (Settings → Organizadores;
 * see services/scope.ts#canOrganize). Must run after `requireAuth`.
 */
export const requireOrganizer = createMiddleware<{ Variables: { activeRole: Role; user: SessionUser } }>(async (c, next) => {
  const role = c.get("activeRole");
  const forbid = (message: string) => c.json({ error: { code: "FORBIDDEN", message } }, 403);
  if (role !== "admin" && role !== "staff" && role !== "health_staff") return forbid("Você não tem permissão para acessar este recurso.");
  // lazy import: scope.ts → models → … keeps this module free of a load-order cycle
  const { canOrganize, resolveScope } = await import("../services/scope");
  if (!canOrganize(await resolveScope(c.get("user")))) return forbid("Só a organização pode alterar a programação.");
  await next();
});
