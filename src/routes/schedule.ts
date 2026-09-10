import { Hono, type Context } from "hono";
import { isEmojiLike } from "../utils";
import { publish } from "../services/realtime";
import { notifyEventChange, notifyRoleEdited } from "../services/notify";
import { cleanHtml as sanitizeEditorHtml } from "../services/html";
import { requireAuth } from "../middleware/auth";
import { requireOrganizer, requireRole } from "../middleware/roles";
import { resolveScope, scopeEvent, scopeRoles } from "../services/scope";
import {
  countEventsUsingRole,
  deleteEvent,
  deleteRole,
  findEventById,
  findRoleById,
  findRoleByName,
  insertEvent,
  insertRole,
  listEvents,
  listRoles,
  updateEvent,
  updateRole,
  type CampEventData,
  type ScheduleRoleData,
} from "../models/schedule";
import { listStaff } from "../models/staff";
import type { CampEvent, EventAssignment, Role, ScheduleRole, SessionUser } from "../types";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

const schedule = new Hono<Env>();

const NAME_MAX = 80;
const TITLE_MAX = 80;
const NOTES_MAX = 500;
const INSTRUCTIONS_MAX = 20_000;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DETAIL_MAX = 60;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function fail(c: Context, code: string, message: string, status: 400 | 403 | 404 | 409 = 400) {
  return c.json({ error: { code, message } }, status);
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().replace(/\s+/g, " ");
  if (!v || v.length > max) return null;
  return v;
}

function cleanEmoji(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return isEmojiLike(value.trim()) ? value.trim() : fallback;
}

/** Sanitizes editor HTML (see services/html.ts); returns "" when the content is effectively empty. */
function cleanHtml(value: unknown): string | null {
  return sanitizeEditorHtml(value, INSTRUCTIONS_MAX);
}

export function serializeRole(r: ScheduleRole) {
  return {
    id: r._id,
    name: r.name,
    emoji: r.emoji,
    instructions: r.instructions,
    preparation: r.preparation,
    forEveryone: r.forEveryone,
    hasDetail: r.hasDetail,
    detailPlaceholder: r.detailPlaceholder,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function serializeEvent(e: CampEvent) {
  return {
    id: e._id,
    date: e.date,
    title: e.title,
    emoji: e.emoji,
    startTime: e.startTime,
    endTime: e.endTime,
    notes: e.notes,
    roles: e.roles,
    assignments: e.assignments,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

schedule.use("*", requireAuth);

// ═══════════════════════════════════════════════════════════════════════════
// Roles (funções)
// ═══════════════════════════════════════════════════════════════════════════

const TEAM = requireRole("admin", "staff", "health_staff");

/** Writes to the programme: admin, or a team member the admin listed as an ORGANIZER (Settings → Organizadores). */
const ORGANIZER = requireOrganizer;

/** Roles + events as the viewer may see them (admin: everything; team: only their own roles per event). */
async function scopedSchedule(c: Context<Env>) {
  const [scope, roles, events] = await Promise.all([resolveScope(c.get("user")), listRoles(), listEvents()]);
  const roleById = new Map(roles.map((r) => [r._id, r]));
  const scopedEvents = events.map((e) => scopeEvent(scope, e, roleById));
  return { roles: scopeRoles(scope, roles, scopedEvents), events: scopedEvents };
}

schedule.get("/roles", TEAM, async (c) => {
  const { roles } = await scopedSchedule(c);
  return c.json({ roles: roles.map(serializeRole) });
});

schedule.get("/roles/:id", TEAM, async (c) => {
  const { roles } = await scopedSchedule(c);
  const r = roles.find((x) => x._id === c.req.param("id"));
  if (!r) return fail(c, "ROLE_NOT_FOUND", "Função não encontrada.", 404);
  return c.json({ role: serializeRole(r) });
});

/**
 * GET /api/schedule/roles/:id/detail — the role + every event that uses it,
 * with the people assigned to it in each one (for "for everyone" roles the
 * list is who is NOT explicitly doing something else).
 */
schedule.get("/roles/:id/detail", ORGANIZER, async (c) => {
  const r = await findRoleById(c.req.param("id"));
  if (!r) return fail(c, "ROLE_NOT_FOUND", "Função não encontrada.", 404);

  const [events, staff] = await Promise.all([listEvents(), listStaff()]);
  const active = staff.filter((s) => s.active);
  const usedIn = events
    .filter((e) => e.roles.includes(r._id))
    .map((e) => {
      const people = r.forEveryone
        ? active.filter((s) => !e.assignments.some((a) => a.staffId === s._id)).map((s) => ({ staffId: s._id, name: s.name, detail: "" }))
        : e.assignments
            .filter((a) => a.roleId === r._id)
            .map((a) => ({ staffId: a.staffId, name: staff.find((s) => s._id === a.staffId)?.name ?? "?", detail: a.detail }))
            .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
      return {
        eventId: e._id,
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime,
        title: e.title,
        emoji: e.emoji,
        people,
      };
    });

  return c.json({ role: serializeRole(r), events: usedIn });
});

async function buildRolePatch(
  body: Record<string, unknown>,
  partial: boolean,
): Promise<{ patch: Partial<ScheduleRoleData> } | { code: string; message: string }> {
  const patch: Partial<ScheduleRoleData> = {};
  const has = (k: string) => !partial || body[k] !== undefined;

  if (has("name")) {
    const name = cleanText(body.name, NAME_MAX);
    if (!name) return { code: "NAME_INVALID", message: `Informe um nome com até ${NAME_MAX} caracteres.` };
    patch.name = name;
  }
  if (has("emoji")) patch.emoji = cleanEmoji(body.emoji, "🎯");
  if (has("instructions")) {
    const html = cleanHtml(body.instructions);
    if (html === null) return { code: "INSTRUCTIONS_INVALID", message: "Instruções inválidas ou muito longas." };
    patch.instructions = html;
  }
  if (has("preparation")) {
    const html = cleanHtml(body.preparation);
    if (html === null) return { code: "PREPARATION_INVALID", message: "Preparação inválida ou muito longa." };
    patch.preparation = html;
  }
  if (has("forEveryone")) {
    const v = body.forEveryone ?? false;
    if (typeof v !== "boolean") return { code: "FOR_EVERYONE_INVALID", message: "'Para toda a equipe' deve ser sim ou não." };
    patch.forEveryone = v;
  }
  if (has("hasDetail")) {
    const v = body.hasDetail ?? false;
    if (typeof v !== "boolean") return { code: "HAS_DETAIL_INVALID", message: "'Tem detalhe' deve ser sim ou não." };
    patch.hasDetail = v;
  }
  if (has("detailPlaceholder")) {
    const v = body.detailPlaceholder ?? "";
    if (typeof v !== "string") return { code: "DETAIL_PLACEHOLDER_INVALID", message: "Dica do detalhe inválida." };
    patch.detailPlaceholder = v.trim().slice(0, DETAIL_MAX);
  }
  return { patch };
}

/** POST /api/schedule/roles  { name, emoji?, instructions?, preparation?, forEveryone?, hasDetail?, detailPlaceholder? } */
schedule.post("/roles", ORGANIZER, async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const result = await buildRolePatch(body, false);
  if (!("patch" in result)) return fail(c, result.code, result.message);
  const data = result.patch as ScheduleRoleData;

  if (await findRoleByName(data.name)) return fail(c, "NAME_DUPLICATE", `Já existe a função "${data.name}".`, 409);

  const created = await insertRole(data);
  publish("roles");
  return c.json({ role: serializeRole(created) }, 201);
});

schedule.put("/roles/:id", ORGANIZER, async (c) => {
  const existing = await findRoleById(c.req.param("id"));
  if (!existing) return fail(c, "ROLE_NOT_FOUND", "Função não encontrada.", 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const result = await buildRolePatch(body, true);
  if (!("patch" in result)) return fail(c, result.code, result.message);

  if (result.patch.name) {
    const clash = await findRoleByName(result.patch.name);
    if (clash && clash._id !== existing._id) {
      return fail(c, "NAME_DUPLICATE", `Já existe a função "${result.patch.name}".`, 409);
    }
  }

  const updated = await updateRole(existing._id, result.patch);
  publish("roles");
  void listEvents().then((events) => notifyRoleEdited(existing, updated!, events));
  return c.json({ role: serializeRole(updated!) });
});

schedule.delete("/roles/:id", ORGANIZER, async (c) => {
  const id = c.req.param("id");
  const existing = await findRoleById(id);
  if (!existing) return fail(c, "ROLE_NOT_FOUND", "Função não encontrada.", 404);

  const used = await countEventsUsingRole(id);
  if (used > 0) {
    return fail(c, "ROLE_IN_USE", `Esta função é usada em ${used} evento${used > 1 ? "s" : ""}. Remova-a deles antes.`, 409);
  }
  await deleteRole(id);
  publish("roles");
  return c.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// Events (programação)
// ═══════════════════════════════════════════════════════════════════════════

schedule.get("/events", TEAM, async (c) => {
  const { events } = await scopedSchedule(c);
  return c.json({ events: events.map(serializeEvent) });
});

schedule.get("/events/:id", TEAM, async (c) => {
  const { events } = await scopedSchedule(c);
  const e = events.find((x) => x._id === c.req.param("id"));
  if (!e) return fail(c, "EVENT_NOT_FOUND", "Evento não encontrado.", 404);
  return c.json({ event: serializeEvent(e) });
});

/** Accepts ["id", …] (or the legacy [{ roleId }] shape); validates and de-dupes. */
async function parseRoleIds(value: unknown): Promise<string[] | { error: string }> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return { error: "Funções inválidas." };
  const known = new Set((await listRoles()).map((r) => r._id));
  const out: string[] = [];
  for (const item of value) {
    const roleId = typeof item === "string" ? item : (item as { roleId?: unknown })?.roleId;
    if (typeof roleId !== "string" || !known.has(roleId)) return { error: "Função não encontrada." };
    if (out.includes(roleId)) return { error: "Função repetida no mesmo evento." };
    out.push(roleId);
  }
  return out;
}

async function buildEventPatch(
  body: Record<string, unknown>,
  partial: boolean,
): Promise<{ patch: Partial<CampEventData> } | { code: string; message: string }> {
  const patch: Partial<CampEventData> = {};
  const has = (k: string) => !partial || body[k] !== undefined;

  if (has("date")) {
    const d = body.date;
    if (typeof d !== "string" || !DATE_RE.test(d) || Number.isNaN(Date.parse(d))) {
      return { code: "DATE_INVALID", message: "Data inválida (use AAAA-MM-DD)." };
    }
    patch.date = d;
  }
  if (has("title")) {
    const title = cleanText(body.title, TITLE_MAX);
    if (!title) return { code: "TITLE_INVALID", message: `Informe um título com até ${TITLE_MAX} caracteres.` };
    patch.title = title;
  }
  if (has("emoji")) patch.emoji = cleanEmoji(body.emoji, "📅");
  if (has("startTime")) {
    if (typeof body.startTime !== "string" || !TIME_RE.test(body.startTime)) {
      return { code: "START_TIME_INVALID", message: "Horário de início inválido (use HH:mm)." };
    }
    patch.startTime = body.startTime;
  }
  if (has("endTime")) {
    const v = body.endTime;
    if (v === undefined || v === null || v === "") patch.endTime = null;
    else if (typeof v !== "string" || !TIME_RE.test(v)) {
      return { code: "END_TIME_INVALID", message: "Horário de fim inválido (use HH:mm)." };
    } else patch.endTime = v;
  }
  if (has("notes")) {
    if (body.notes !== undefined && body.notes !== null && typeof body.notes !== "string") {
      return { code: "NOTES_INVALID", message: "Observações inválidas." };
    }
    patch.notes = ((body.notes as string | undefined) ?? "").trim().slice(0, NOTES_MAX);
  }
  if (has("roles")) {
    const roles = await parseRoleIds(body.roles);
    if (!Array.isArray(roles)) return { code: "ROLES_INVALID", message: roles.error };
    patch.roles = roles;
  }
  return { patch };
}

/** POST /api/schedule/events  { date, title, emoji?, startTime, endTime?, notes?, roles?: string[] } */
schedule.post("/events", ORGANIZER, async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const result = await buildEventPatch(body, false);
  if (!("patch" in result)) return fail(c, result.code, result.message);
  const data = result.patch as CampEventData;
  if (data.endTime && data.endTime <= data.startTime) {
    return fail(c, "END_TIME_INVALID", "O fim precisa ser depois do início.");
  }

  const created = await insertEvent({ ...data, assignments: [] });
  publish("events");
  void notifyEventChange(null, created);
  return c.json({ event: serializeEvent(created) }, 201);
});

/**
 * PUT /api/schedule/events/:id/assignments
 * { assignments: [{ staffId, roleId, detail? }] } — replaces the whole list.
 * Each person appears at most once; the role must be one of the event's roles.
 */
schedule.put("/events/:id/assignments", ORGANIZER, async (c) => {
  const existing = await findEventById(c.req.param("id"));
  if (!existing) return fail(c, "EVENT_NOT_FOUND", "Evento não encontrado.", 404);

  const body = await c.req.json<{ assignments?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.assignments)) {
    return fail(c, "BODY_INVALID", "Envie a lista de escalações.");
  }

  const eventRoles = new Set(existing.roles);
  const staffIds = new Set((await listStaff()).map((s) => s._id));
  const seen = new Set<string>();
  const assignments: EventAssignment[] = [];
  for (const item of body.assignments as Record<string, unknown>[]) {
    const staffId = item?.staffId;
    const roleId = item?.roleId;
    if (typeof staffId !== "string" || !staffIds.has(staffId)) return fail(c, "STAFF_INVALID", "Membro da equipe não encontrado.");
    if (typeof roleId !== "string" || !eventRoles.has(roleId)) return fail(c, "ROLE_INVALID", "A função precisa estar entre as funções do evento.");
    if (seen.has(staffId)) return fail(c, "STAFF_DUPLICATE", "Uma pessoa só pode ter uma função por evento.", 409);
    seen.add(staffId);
    const detail = typeof item.detail === "string" ? item.detail.trim().slice(0, DETAIL_MAX) : "";
    assignments.push({ staffId, roleId, detail });
  }

  const updated = await updateEvent(existing._id, { assignments });
  publish("events");
  void notifyEventChange(existing, updated);
  return c.json({ event: serializeEvent(updated!) });
});

schedule.put("/events/:id", ORGANIZER, async (c) => {
  const existing = await findEventById(c.req.param("id"));
  if (!existing) return fail(c, "EVENT_NOT_FOUND", "Evento não encontrado.", 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const result = await buildEventPatch(body, true);
  if (!("patch" in result)) return fail(c, result.code, result.message);

  const merged = { ...existing, ...result.patch };
  if (merged.endTime && merged.endTime <= merged.startTime) {
    return fail(c, "END_TIME_INVALID", "O fim precisa ser depois do início.");
  }

  // a role removed from the event drops its assignments too
  if (result.patch.roles) {
    const keep = new Set(result.patch.roles);
    result.patch.assignments = existing.assignments.filter((a) => keep.has(a.roleId));
  }

  const updated = await updateEvent(existing._id, result.patch);
  publish("events");
  void notifyEventChange(existing, updated);
  return c.json({ event: serializeEvent(updated!) });
});

/**
 * PUT /api/schedule/events/:id/assignments/:staffId  { roleId, detail? }
 * Sets ONE person's role in the event (replacing any previous one).
 */
schedule.put("/events/:id/assignments/:staffId", ORGANIZER, async (c) => {
  const existing = await findEventById(c.req.param("id"));
  if (!existing) return fail(c, "EVENT_NOT_FOUND", "Evento não encontrado.", 404);
  const staffId = c.req.param("staffId");
  if (!(await listStaff()).some((s) => s._id === staffId)) return fail(c, "STAFF_INVALID", "Membro da equipe não encontrado.");

  const body = await c.req.json<{ roleId?: unknown; detail?: unknown }>().catch(() => null);
  if (!body || typeof body.roleId !== "string" || !existing.roles.includes(body.roleId)) {
    return fail(c, "ROLE_INVALID", "A função precisa estar entre as funções do evento.");
  }
  const detail = typeof body.detail === "string" ? body.detail.trim().slice(0, DETAIL_MAX) : "";
  const assignments = [...existing.assignments.filter((a) => a.staffId !== staffId), { staffId, roleId: body.roleId, detail }];
  const updated = await updateEvent(existing._id, { assignments });
  publish("events");
  void notifyEventChange(existing, updated);
  return c.json({ event: serializeEvent(updated!) });
});

/** DELETE /api/schedule/events/:id/assignments/:staffId — removes the person from the event. */
schedule.delete("/events/:id/assignments/:staffId", ORGANIZER, async (c) => {
  const existing = await findEventById(c.req.param("id"));
  if (!existing) return fail(c, "EVENT_NOT_FOUND", "Evento não encontrado.", 404);
  const staffId = c.req.param("staffId");
  const updated = await updateEvent(existing._id, { assignments: existing.assignments.filter((a) => a.staffId !== staffId) });
  publish("events");
  void notifyEventChange(existing, updated);
  return c.json({ event: serializeEvent(updated!) });
});

schedule.delete("/events/:id", ORGANIZER, async (c) => {
  const existing = await findEventById(c.req.param("id"));
  const ok = existing ? await deleteEvent(existing._id) : false;
  if (!ok) return fail(c, "EVENT_NOT_FOUND", "Evento não encontrado.", 404);
  publish("events");
  void notifyEventChange(existing, null);
  return c.json({ success: true });
});

export default schedule;
