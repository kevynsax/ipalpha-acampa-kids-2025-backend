import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roles";
import { deleteScore, insertScore, listScores, teamTotal } from "../models/scores";
import { findTeamById } from "../models/teams";
import { publish } from "../services/realtime";
import { canKeepScore, resolveScope } from "../services/scope";
import type { Role, ScoreEntry, SessionUser } from "../types";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

const scores = new Hono<Env>();

const NOTE_MAX = 200;
const POINTS_MAX = 100_000;

function fail(c: Context, code: string, message: string, status: 400 | 404 | 409 = 400) {
  return c.json({ error: { code, message } }, status);
}

export function serializeScore(e: ScoreEntry) {
  return {
    id: e._id,
    teamId: e.teamId,
    points: e.points,
    kind: e.kind,
    note: e.note,
    by: { id: e.byUserId, name: e.byName },
    createdAt: e.createdAt,
  };
}

/** admin, or a GAME organizer (Settings → Placar) */
const requireScorekeeper = createMiddleware<Env>(async (c, next) => {
  if (!canKeepScore(await resolveScope(c.get("user")))) {
    return c.json({ error: { code: "FORBIDDEN", message: "Só a organização dos jogos altera o placar." } }, 403);
  }
  await next();
});

scores.use("*", requireAuth);

/** GET /api/scores — the whole ledger, newest first (any team member / admin: the scoreboard is public inside the app). */
scores.get("/", requireRole("admin", "staff", "health_staff"), async (c) => c.json({ scores: (await listScores()).map(serializeScore) }));

/**
 * POST /api/scores  { teamId, points, note? }
 * `points` > 0 gives, < 0 takes. Written by the admin or a game organizer.
 */
scores.post("/", requireRole("admin", "staff", "health_staff"), requireScorekeeper, async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const team = typeof body.teamId === "string" ? await findTeamById(body.teamId) : null;
  if (!team) return fail(c, "TEAM_NOT_FOUND", "Time não encontrado.", 404);
  const points = Number(body.points);
  if (!Number.isInteger(points) || points === 0 || Math.abs(points) > POINTS_MAX) return fail(c, "POINTS_INVALID", "Informe uma quantidade inteira de pontos (diferente de zero).");
  const note = typeof body.note === "string" ? body.note.trim().slice(0, NOTE_MAX) : "";
  const user = c.get("user");
  const entry = await insertScore({ teamId: team._id, points, kind: points > 0 ? "add" : "remove", note, byUserId: user.id, byName: user.name });
  publish("scores");
  return c.json({ score: serializeScore(entry) }, 201);
});

/** POST /api/scores/reset/:teamId  { note? } — zeroes the team: writes a line cancelling the current total (history kept). */
scores.post("/reset/:teamId", requireRole("admin", "staff", "health_staff"), requireScorekeeper, async (c) => {
  const team = await findTeamById(c.req.param("teamId"));
  if (!team) return fail(c, "TEAM_NOT_FOUND", "Time não encontrado.", 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const note = typeof body.note === "string" ? body.note.trim().slice(0, NOTE_MAX) : "";
  const total = await teamTotal(team._id);
  if (total === 0) return fail(c, "ALREADY_ZERO", `${team.name} já está com zero pontos.`, 409);
  const user = c.get("user");
  const entry = await insertScore({ teamId: team._id, points: -total, kind: "reset", note, byUserId: user.id, byName: user.name });
  publish("scores");
  return c.json({ score: serializeScore(entry) }, 201);
});

/** DELETE /api/scores/:id — removes one line (a mistake), which also undoes its points. */
scores.delete("/:id", requireRole("admin", "staff", "health_staff"), requireScorekeeper, async (c) => {
  const ok = await deleteScore(c.req.param("id"));
  if (!ok) return fail(c, "SCORE_NOT_FOUND", "Lançamento não encontrado.", 404);
  publish("scores");
  return c.json({ success: true });
});

export default scores;
