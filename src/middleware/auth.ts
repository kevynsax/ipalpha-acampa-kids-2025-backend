import { createMiddleware } from "hono/factory";
import { findById, toPublicUser } from "../models/users";
import { verifySessionToken } from "../services/session";
import type { SessionUser } from "../types";

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

  // the active role is the one chosen at login
  c.set("userId", user._id);
  c.set("sessionId", payload.sessionId);
  c.set("activeRole", payload.role);
  c.set("user", { ...toPublicUser(user), activeRole: payload.role });

  await next();
});
