import { createMiddleware } from "hono/factory";
import { config } from "../config";
import { findById } from "../models/users";
import { activeCampId } from "../services/campContext";
import { verifySessionToken } from "../services/session";
import { normalizeBrazilPhone } from "../utils";

/**
 * Refuses every WRITE made from a history session (a token whose camp is not
 * the active one): the year is read-only once archived. Mounted on `/api/*`
 * before the routes, so it never has to run inside `requireAuth`. Passes
 * through GET/HEAD/OPTIONS, `/api/auth/*`, unauthenticated requests (the
 * normal 401 path answers those) and the super admin (may fix old data).
 */
export const campWriteGuard = createMiddleware(async (c, next) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  if (c.req.path.startsWith("/api/auth/") || c.req.path.startsWith("/api/camps")) return next();

  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next();

  const payload = await verifySessionToken(token);
  if (!payload) return next();
  if (payload.campId === activeCampId()) return next();

  const superPhone = config.superAdminPhone ? normalizeBrazilPhone(config.superAdminPhone) : null;
  const user = await findById(payload.userId);
  if (user && superPhone && user.phone === superPhone) return next();

  return c.json({ error: { code: "CAMP_ARCHIVED", message: "Este ano está arquivado — só leitura." } }, 403);
});
