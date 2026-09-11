import { Hono, type Context } from "hono";
import { requireAuth } from "../middleware/auth";
import { requireAdmin, requireRole } from "../middleware/roles";
import {
  deletePrepSection,
  findPrepSectionById,
  insertPrepSection,
  listPrepSections,
  nextPrepOrder,
  updatePrepSection,
  type PrepSectionData,
} from "../models/preparation";
import { cleanHtml } from "../services/html";
import { publish } from "../services/realtime";
import { notifyPreparationChange } from "../services/notify";
import { isEmojiLike } from "../utils";
import type { PrepSection, Role, SessionUser } from "../types";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

/**
 * Preparação — general sections every team member reads before the camp
 * ("O que levar", "Chegada", "Uniforme"…). Role-specific preparation lives
 * on the role itself (PUT /api/schedule/roles/:id { preparation }).
 *
 *   GET    /api/preparation              team + admin
 *   POST   /api/preparation              admin   { title, emoji?, content? }
 *   PUT    /api/preparation/reorder      admin   { ids }
 *   PUT    /api/preparation/:id          admin
 *   DELETE /api/preparation/:id          admin
 */
const preparation = new Hono<Env>();

const TITLE_MAX = 80;
const CONTENT_MAX = 60_000;

function fail(c: Context, code: string, message: string, status: 400 | 404 = 400) {
  return c.json({ error: { code, message } }, status);
}

export function serializePrepSection(s: PrepSection) {
  return {
    id: s._id,
    title: s.title,
    emoji: s.emoji,
    content: s.content,
    order: s.order,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function buildPatch(body: Record<string, unknown>, partial: boolean): { patch: Partial<PrepSectionData> } | { code: string; message: string } {
  const patch: Partial<PrepSectionData> = {};
  const has = (k: string) => !partial || body[k] !== undefined;

  if (has("title")) {
    const t = typeof body.title === "string" ? body.title.trim().replace(/\s+/g, " ") : "";
    if (!t || t.length > TITLE_MAX) return { code: "TITLE_INVALID", message: `Informe um título com até ${TITLE_MAX} caracteres.` };
    patch.title = t;
  }
  if (has("emoji")) {
    const e = typeof body.emoji === "string" ? body.emoji.trim() : "";
    patch.emoji = isEmojiLike(e) ? e : "📌";
  }
  if (has("content")) {
    const html = cleanHtml(body.content, CONTENT_MAX);
    if (html === null) return { code: "CONTENT_INVALID", message: "Conteúdo inválido ou muito longo." };
    patch.content = html;
  }
  return { patch };
}

preparation.use("*", requireAuth);

preparation.get("/", requireRole("admin", "staff", "health_staff"), async (c) => {
  const list = await listPrepSections();
  return c.json({ sections: list.map(serializePrepSection) });
});

preparation.post("/", requireAdmin, async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const result = buildPatch(body, false);
  if (!("patch" in result)) return fail(c, result.code, result.message);
  const created = await insertPrepSection({ ...(result.patch as PrepSectionData), order: await nextPrepOrder() });
  publish("preparation");
  void notifyPreparationChange(null, created);
  return c.json({ section: serializePrepSection(created) }, 201);
});

/** PUT /api/preparation/reorder  { ids: string[] } — must be declared before /:id */
preparation.put("/reorder", requireAdmin, async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return fail(c, "IDS_INVALID", "Envie a lista de ids.");
  const existing = await listPrepSections();
  const known = new Set(existing.map((s) => s._id));
  const ordered = (ids as string[]).filter((id) => known.has(id));
  const rest = existing.map((s) => s._id).filter((id) => !ordered.includes(id));
  await Promise.all([...ordered, ...rest].map((id, order) => updatePrepSection(id, { order })));
  publish("preparation");
  return c.json({ sections: (await listPrepSections()).map(serializePrepSection) });
});

preparation.put("/:id", requireAdmin, async (c) => {
  const existing = await findPrepSectionById(c.req.param("id"));
  if (!existing) return fail(c, "SECTION_NOT_FOUND", "Seção não encontrada.", 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const result = buildPatch(body, true);
  if (!("patch" in result)) return fail(c, result.code, result.message);
  const updated = await updatePrepSection(existing._id, result.patch);
  publish("preparation");
  void notifyPreparationChange(existing, updated!);
  return c.json({ section: serializePrepSection(updated!) });
});

preparation.delete("/:id", requireAdmin, async (c) => {
  const ok = await deletePrepSection(c.req.param("id"));
  if (!ok) return fail(c, "SECTION_NOT_FOUND", "Seção não encontrada.", 404);
  publish("preparation");
  return c.json({ success: true });
});

export default preparation;
