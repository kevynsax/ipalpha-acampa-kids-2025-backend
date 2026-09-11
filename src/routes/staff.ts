import { Hono, type Context } from "hono";
import { publish } from "../services/realtime";
import { requireAuth } from "../middleware/auth";
import { requireAdmin, requireRole } from "../middleware/roles";
import { findBedroomById } from "../models/bedrooms";
import { listCampers } from "../models/campers";
import { listEvents, listRoles, unassignStaffEverywhere } from "../models/schedule";
import { serializeCamperList } from "./campers";
import {
  deleteStaff,
  findStaffById,
  findStaffByPhone,
  insertStaff,
  listStaff,
  setStaffCheckin,
  setStaffPrepDone,
  updateStaff,
  type StaffData,
} from "../models/staff";
import { logCheckin } from "../models/campers";
import { STAFF_CATEGORY_KEYS, type Role, type SessionUser, type Staff } from "../types";
import { hideOwnBedroom, resolveScope, staffVisibility, type Scope } from "../services/scope";
import { bedroomFullMessage, isInvalid, parseBedroom, parseMulti, parseSingle, parseText } from "./_validate";
import { distanceMeters, normalizeBrazilPhone, nowInSaoPauloWallClock, saoPauloWallClock, saoPauloWallClockToIso, todayInSaoPaulo } from "../utils";
import { getSettings } from "../models/settings";
import { notifyCheckin, notifyStaffChange, syncWelcomes } from "../services/notify";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

const staff = new Hono<Env>();

const NAME_MAX = 80;
const TEXT_MAX = 500;

function fail(c: Context, code: string, message: string, status: 400 | 404 | 409 = 400) {
  return c.json({ error: { code, message } }, status);
}

/** Full record — admin only (or the person themself). */
export function serializeStaff(s: Staff) {
  return serialize(s);
}

/**
 * Serializes `s` according to the viewer's scope, or returns `null` when the
 * viewer may not see this person at all. A colleague in the same room comes
 * back as a NAME-ONLY record (`redacted: true`): no phone, no health data,
 * no team/transport — just what is needed to know who shares the room.
 */
export function serializeStaffFor(s: Staff, scope: Scope) {
  const vis = staffVisibility(scope, s);
  if (vis === "none") return null;
  const full = serialize(s);
  // draft rooms: the person's own record travels without the bedroom
  if (vis === "full") return hideOwnBedroom(scope) ? { ...full, bedroom: null } : full;
  return {
    ...full,
    redacted: true,
    phone: null,
    team: null,
    transportation: null,
    allergies: [],
    drugAllergies: [],
    foodRestrictions: "",
    healthIssues: [],
    medicines: "",
    healthNotes: "",
    checkin: null,
    prepDone: [],
  };
}

/** Every member the viewer may see (already serialized per their scope). */
export function serializeStaffList(list: Staff[], scope: Scope) {
  return list.map((s) => serializeStaffFor(s, scope)).filter((x): x is NonNullable<typeof x> => x !== null);
}

function serialize(s: Staff) {
  return {
    id: s._id,
    name: s.name,
    phone: s.phone,
    active: s.active,
    team: s.team,
    bedroom: s.bedroom,
    transportation: s.transportation,
    allergies: s.allergies,
    drugAllergies: s.drugAllergies,
    foodRestrictions: s.foodRestrictions,
    healthIssues: s.healthIssues,
    medicines: s.medicines,
    healthNotes: s.healthNotes,
    checkin: s.checkin,
    prepDone: s.prepDone,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/**
 * Builds a validated patch from a request body. When `partial` is true only
 * the keys present in the body are validated (PUT); otherwise every field is
 * resolved and required ones are enforced (POST).
 */
async function buildPatch(
  body: Record<string, unknown>,
  partial: boolean,
): Promise<{ patch: Partial<StaffData> } | { code: string; message: string; status?: 400 | 409 }> {
  const patch: Partial<StaffData> = {};
  const has = (k: string) => !partial || body[k] !== undefined;

  if (has("name")) {
    const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > NAME_MAX) {
      return { code: "NAME_INVALID", message: `Informe um nome com até ${NAME_MAX} caracteres.` };
    }
    patch.name = name;
  }

  if (has("phone")) {
    const raw = body.phone;
    if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
      patch.phone = null; // allowed: person hasn't registered a phone yet
    } else {
      const phone = typeof raw === "string" ? normalizeBrazilPhone(raw) : null;
      if (!phone) return { code: "PHONE_INVALID", message: "Informe um celular brasileiro válido com DDD." };
      patch.phone = phone;
    }
  }

  if (has("active")) {
    const active = body.active === undefined ? true : body.active;
    if (typeof active !== "boolean") return { code: "ACTIVE_INVALID", message: "Ativo deve ser sim ou não." };
    patch.active = active;
  }

  const singles: ["team" | "transportation", string][] = [
    ["team", "Time"],
    ["transportation", "Transporte"],
  ];
  for (const [field, label] of singles) {
    if (!has(field)) continue;
    const v = await parseSingle(body[field], STAFF_CATEGORY_KEYS[field], label);
    if (isInvalid(v)) return { code: `${field.toUpperCase()}_INVALID`, message: v.error };
    patch[field] = v;
  }

  if (has("bedroom")) {
    const v = await parseBedroom(body.bedroom);
    if (isInvalid(v)) return { code: "BEDROOM_INVALID", message: v.error };
    patch.bedroom = v;
  }

  const multis: [("allergies" | "drugAllergies" | "healthIssues"), string][] = [
    ["allergies", "Alergias"],
    ["drugAllergies", "Alergia a medicamentos"],
    ["healthIssues", "Problemas de saúde"],
  ];
  for (const [field, label] of multis) {
    if (!has(field)) continue;
    const v = await parseMulti(body[field], STAFF_CATEGORY_KEYS[field], label);
    if (isInvalid(v)) return { code: `${field.toUpperCase()}_INVALID`, message: v.error };
    patch[field] = v;
  }

  for (const field of ["foodRestrictions", "medicines", "healthNotes"] as const) {
    if (!has(field)) continue;
    const v = parseText(body[field], TEXT_MAX);
    if (isInvalid(v)) return { code: `${field.toUpperCase()}_INVALID`, message: v.error };
    patch[field] = v;
  }

  return { patch };
}

staff.use("*", requireAuth);

// ── read: admin sees everyone; staff/health staff only their own room (see services/scope.ts) ──

/** GET /api/staff?active=true|false — lists members sorted by name (scoped). */
staff.get("/", requireRole("admin", "staff", "health_staff"), async (c) => {
  const q = c.req.query("active");
  const active = q === "true" ? true : q === "false" ? false : undefined;
  const [list, scope] = await Promise.all([listStaff({ active }), resolveScope(c.get("user"))]);
  return c.json({ staff: serializeStaffList(list, scope) });
});

staff.get("/:id", requireRole("admin", "staff", "health_staff"), async (c) => {
  const s = await findStaffById(c.req.param("id"));
  // outside the viewer's scope → same answer as "does not exist" (no probing)
  const out = s ? serializeStaffFor(s, await resolveScope(c.get("user"))) : null;
  if (!out) return fail(c, "STAFF_NOT_FOUND", "Membro da equipe não encontrado.", 404);
  return c.json({ staff: out });
});

/**
 * GET /api/staff/:id/detail — the person + their schedule (every event they
 * are assigned to, with the role) + the campers in their bedroom (the kids
 * they are responsible for) + the other staff sharing the room.
 */
staff.get("/:id/detail", requireRole("admin", "staff", "health_staff"), async (c) => {
  const s = await findStaffById(c.req.param("id"));
  const scope = await resolveScope(c.get("user"));
  // the full detail (schedule, kids) is only for the admin or the person themself
  if (!s || staffVisibility(scope, s) !== "full") return fail(c, "STAFF_NOT_FOUND", "Membro da equipe não encontrado.", 404);
  // draft rooms: no bedroom, kids or roommates for the person themself
  const roomId = hideOwnBedroom(scope) ? null : s.bedroom;

  const [events, roles, bedroom, allStaff] = await Promise.all([
    listEvents(),
    listRoles(),
    roomId ? findBedroomById(roomId) : null,
    roomId ? listStaff() : [],
  ]);
  const roleById = new Map(roles.map((r) => [r._id, r]));

  const schedule = events
    .map((e) => {
      // explicit assignment wins; otherwise a "for everyone" role of the event applies (active members only)
      const a = e.assignments.find((x) => x.staffId === s._id);
      const everyone = !a && s.active ? e.roles.map((id) => roleById.get(id)).find((r) => r?.forEveryone) : undefined;
      const r = a ? roleById.get(a.roleId) : everyone;
      if (!a && !everyone) return null;
      /** the event's "for everyone" role — what the person falls back to when unassigned */
      const fallback = e.roles.map((id) => roleById.get(id)).find((x) => x?.forEveryone);
      return {
        eventId: e._id,
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime,
        title: e.title,
        emoji: e.emoji,
        role: r ? { id: r._id, name: r.name, emoji: r.emoji, instructions: r.instructions } : null,
        detail: a?.detail ?? "",
        /** true when this comes from a "for everyone" role rather than an explicit assignment */
        implicit: !a,
        defaultRole: fallback ? { id: fallback._id, name: fallback.name, emoji: fallback.emoji } : null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  const campers = roomId ? await listCampers({ bedroom: roomId }) : [];
  const roommates = roomId ? allStaff.filter((x) => x.bedroom === roomId && x._id !== s._id) : [];

  return c.json({
    staff: roomId === s.bedroom ? serialize(s) : { ...serialize(s), bedroom: null },
    bedroom: bedroom ? { id: bedroom._id, name: bedroom.name, group: bedroom.group } : null,
    schedule,
    campers: serializeCamperList(campers, scope),
    roommates: serializeStaffList(roommates, scope),
  });
});

// ── self check-in: a team member marks their OWN arrival ────────────────────

/**
 * The rule, so the phone can't lie about it: it must be the departure day
 * (the day of the FIRST event of the programme), the window opens
 * `SELF_CHECKIN_OPENS_MINUTES_BEFORE` before that event starts, and the
 * device must be at the church — within `checkinLocation.radiusM` of the
 * point the admin set on the settings page. All checks run here, never
 * trusted from the client. Times are compared in São Paulo wall-clock.
 */
export type SelfCheckinBlock = "NOT_LINKED" | "INACTIVE" | "NO_SCHEDULE" | "NOT_TODAY" | "NOT_YET" | "ALREADY_CHECKED_IN";

const SELF_CHECKIN_OPENS_MINUTES_BEFORE = 60;

interface SelfCheckinWindow {
  /** departure day "YYYY-MM-DD" (null when there is no programme) */
  date: string | null;
  /** ISO instant from which the check-in is accepted (null when there is no programme) */
  opensAt: string | null;
}

async function selfCheckinGate(user: SessionUser): Promise<({ ok: true; me: Staff } | { ok: false; code: SelfCheckinBlock; message: string }) & SelfCheckinWindow> {
  const [me, events] = await Promise.all([findStaffByPhone(user.phone), listEvents()]);
  const first = events[0] ?? null; // listEvents() sorts by (date, startTime)
  const date = first?.date ?? null;
  const opensWall = first ? saoPauloWallClock(first.date, first.startTime) - SELF_CHECKIN_OPENS_MINUTES_BEFORE * 60_000 : null;
  const window: SelfCheckinWindow = { date, opensAt: opensWall === null ? null : saoPauloWallClockToIso(opensWall) };
  if (!me) return { ok: false, code: "NOT_LINKED", message: "Seu celular não está vinculado a um cadastro da equipe.", ...window };
  if (!me.active) return { ok: false, code: "INACTIVE", message: "Seu cadastro na equipe está inativo.", ...window };
  if (!first || opensWall === null) return { ok: false, code: "NO_SCHEDULE", message: "A programação ainda não foi cadastrada.", ...window };
  if (todayInSaoPaulo() !== first.date) return { ok: false, code: "NOT_TODAY", message: "O check-in só abre no dia da saída.", ...window };
  if (nowInSaoPauloWallClock() < opensWall) {
    const hh = new Date(opensWall).toISOString().slice(11, 16); // wall-clock laid over UTC → HH:mm as-is
    return { ok: false, code: "NOT_YET", message: `O check-in abre às ${hh.replace(":", "h")}, uma hora antes da saída.`, ...window };
  }
  if (me.checkin) return { ok: false, code: "ALREADY_CHECKED_IN", message: "Você já fez check-in.", ...window };
  return { ok: true, me, ...window };
}

/**
 * GET /api/staff/me/checkin — can I check myself in right now? Returns the
 * status + the target spot so the phone can show "você está a 120 m", and
 * `opensAt` so it can re-ask when the window opens.
 */
staff.get("/me/checkin", requireRole("staff", "health_staff", "admin"), async (c) => {
  const [gate, settings] = await Promise.all([selfCheckinGate(c.get("user")), getSettings()]);
  return c.json({
    allowed: gate.ok,
    reason: gate.ok ? null : { code: gate.code, message: gate.message },
    date: gate.date,
    opensAt: gate.opensAt,
    location: settings.checkinLocation,
    staff: gate.ok ? serialize(gate.me) : null,
  });
});

/** POST /api/staff/me/checkin  { lat, lng, accuracyM? } — marks the logged-in member as arrived. */
staff.post("/me/checkin", requireRole("staff", "health_staff", "admin"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const lat = Number(body?.lat);
  const lng = Number(body?.lng);
  const accuracyM = Number.isFinite(Number(body?.accuracyM)) ? Math.max(0, Number(body?.accuracyM)) : 0;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return fail(c, "LOCATION_REQUIRED", "Não foi possível ler a sua localização. Ative o GPS e tente de novo.");
  }

  const gate = await selfCheckinGate(user);
  if (!gate.ok) return fail(c, gate.code, gate.message, gate.code === "ALREADY_CHECKED_IN" ? 409 : 400);

  const { checkinLocation } = await getSettings();
  const distance = Math.round(distanceMeters({ lat, lng }, checkinLocation));
  // give the benefit of the GPS error margin (capped, so a 5 km "accuracy" can't be abused)
  const tolerance = checkinLocation.radiusM + Math.min(accuracyM, 200);
  if (distance > tolerance) {
    return c.json(
      { error: { code: "TOO_FAR", message: `Você está a ${fmtDistance(distance)} da igreja. Chegue mais perto para fazer o check-in.`, distanceM: distance } },
      400,
    );
  }

  const stamp = { at: new Date(), byUserId: user.id, byName: user.name, byRole: user.activeRole };
  const updated = await setStaffCheckin(gate.me._id, stamp);
  await logCheckin({ who: "staff", camperId: gate.me._id, camperName: gate.me.name, kind: "church", action: "checkin", ...stamp });
  publish("staff");
  void notifyCheckin(updated!); // fire-and-forget: the SMS never delays or fails the check-in
  return c.json({ staff: serialize(updated!), distanceM: distance });
});

/**
 * PUT /api/staff/me/prep/:key  { done: boolean } — ticks / unticks one item of
 * the person's Preparação checklist. `key` is "section:<id>" or "role:<id>".
 */
staff.put("/me/prep/:key", requireRole("staff", "health_staff", "admin"), async (c) => {
  const key = c.req.param("key");
  if (!/^(section|role):[a-f0-9]{24}$/.test(key)) return fail(c, "KEY_INVALID", "Item inválido.");
  const body = await c.req.json<{ done?: unknown }>().catch(() => null);
  if (!body || typeof body.done !== "boolean") return fail(c, "BODY_INVALID", "Envie { done: true | false }.");
  const me = await findStaffByPhone(c.get("user").phone);
  if (!me) return fail(c, "NOT_LINKED", "Seu celular não está vinculado a um cadastro da equipe.", 404);
  const updated = await setStaffPrepDone(me._id, key, body.done);
  publish("staff");
  return c.json({ staff: serialize(updated!) });
});

function fmtDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1).replace(".", ",")} km` : `${m} m`;
}

// ── check-in: admin only (for now the roll calls are an admin feature) ─────

const canCheckin = requireAdmin;

/** Marks or unmarks the arrival of a team member, stamping who did it and writing the audit line. */
async function doCheckin(c: Context<Env>, action: "checkin" | "undo") {
  const existing = await findStaffById(c.req.param("id") ?? "");
  if (!existing) return fail(c, "STAFF_NOT_FOUND", "Pessoa não encontrada.", 404);
  if (action === "checkin" && existing.checkin) return fail(c, "ALREADY_CHECKED_IN", `${existing.name} já fez check-in.`, 409);
  if (action === "undo" && !existing.checkin) return fail(c, "NOT_CHECKED_IN", `${existing.name} ainda não fez check-in.`, 409);
  const user = c.get("user");
  const stamp = { at: new Date(), byUserId: user.id, byName: user.name, byRole: user.activeRole };
  const updated = await setStaffCheckin(existing._id, action === "checkin" ? stamp : null);
  await logCheckin({ who: "staff", camperId: existing._id, camperName: existing.name, kind: "church", action, ...stamp });
  publish("staff");
  if (action === "checkin") void notifyCheckin(updated!); // the person gets the same receipt when the admin marks them
  return c.json({ staff: serialize(updated!) });
}

/** POST /api/staff/:id/checkin — the person arrived. DELETE undoes. */
staff.post("/:id/checkin", canCheckin, (c) => doCheckin(c, "checkin"));
staff.delete("/:id/checkin", canCheckin, (c) => doCheckin(c, "undo"));

// ── write: admin only ──────────────────────────────────────────────────────

staff.use("/*", requireAdmin);

/**
 * POST /api/staff
 * { name, phone, active?, team?, bedroom?, transportation?, allergies?, foodRestrictions?, healthIssues?, medicines? }
 */
staff.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const result = await buildPatch(body, false);
  if (!("patch" in result)) return fail(c, result.code, result.message, result.status);

  const data = result.patch as StaffData;
  if (data.phone && (await findStaffByPhone(data.phone))) {
    return fail(c, "PHONE_DUPLICATE", "Já existe alguém na equipe com este celular.", 409);
  }
  const full = await bedroomFullMessage(data.bedroom, null);
  if (full) return fail(c, "BEDROOM_FULL", full, 409);

  const created = await insertStaff(data);
  publish("staff", "bedrooms");
  void syncWelcomes(); // welcome SMS with the app link — only if the team window is already open, never twice
  return c.json({ staff: serialize(created) }, 201);
});

/** PUT /api/staff/:id — partial update. */
staff.put("/:id", async (c) => {
  const existing = await findStaffById(c.req.param("id"));
  if (!existing) return fail(c, "STAFF_NOT_FOUND", "Membro da equipe não encontrado.", 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const result = await buildPatch(body, true);
  if (!("patch" in result)) return fail(c, result.code, result.message, result.status);

  if (result.patch.phone && result.patch.phone !== existing.phone) {
    const clash = await findStaffByPhone(result.patch.phone);
    if (clash && clash._id !== existing._id) {
      return fail(c, "PHONE_DUPLICATE", "Já existe alguém na equipe com este celular.", 409);
    }
  }

  if (result.patch.bedroom !== undefined && result.patch.bedroom !== existing.bedroom) {
    const full = await bedroomFullMessage(result.patch.bedroom, existing.bedroom);
    if (full) return fail(c, "BEDROOM_FULL", full, 409);
  }

  const updated = await updateStaff(existing._id, result.patch);
  publish("staff", "bedrooms");
  // fire-and-forget: the SMS never delays the write (deactivation is silent)
  if (!existing.active && updated!.active) void syncWelcomes();
  else if (updated!.active) void notifyStaffChange(existing, updated!);
  return c.json({ staff: serialize(updated!) });
});

staff.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const ok = await deleteStaff(id);
  if (!ok) return fail(c, "STAFF_NOT_FOUND", "Membro da equipe não encontrado.", 404);
  await unassignStaffEverywhere(id);
  publish("staff", "bedrooms", "events");
  return c.json({ success: true });
});

export default staff;
