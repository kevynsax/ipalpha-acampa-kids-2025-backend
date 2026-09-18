import { Hono } from "hono";
import { config } from "../config";
import { emitAiReviewed, publish, type AiReviewedKind, type AiReviewedStatus } from "../services/realtime";

/**
 * POST /api/worker/reviewed — the background import worker reports that one
 * record's AI review reached a terminal state (reviewed, or error with no
 * tries left). The API process owns the WebSocket clients, so it re-reads and
 * publishes the changed collection here. The worker process cannot do that
 * directly because its in-memory realtime hub has no browser connections.
 *
 * Auth: shared secret, `Authorization: Bearer <WORKER_SECRET>`. Fail closed:
 * a missing or wrong secret (or none configured) is always 401.
 */
const worker = new Hono();

worker.post("/reviewed", async (c) => {
  const secret = config.worker.secret;
  const bearer = c.req.header("authorization") ?? "";
  if (!secret || bearer !== `Bearer ${secret}`) return c.json({ error: { code: "UNAUTHORIZED", message: "Segredo do worker inválido." } }, 401);
  const body = await c.req.json<{ kind?: unknown; id?: unknown; status?: unknown; attempts?: unknown }>().catch(() => null);
  const kind = body?.kind;
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const status = body?.status;
  const attempts = typeof body?.attempts === "number" && Number.isFinite(body.attempts) ? Math.max(0, Math.floor(body.attempts)) : 0;
  if ((kind !== "camper" && kind !== "staff") || !id || (status !== "reviewed" && status !== "error")) {
    return c.json({ error: { code: "BAD_BODY", message: "Informe kind (camper|staff), id e status (reviewed|error)." } }, 400);
  }
  publish(kind === "camper" ? "campers" : "staff");
  emitAiReviewed(kind as AiReviewedKind, id, status as AiReviewedStatus, attempts);
  return c.json({ ok: true });
});

export default worker;
