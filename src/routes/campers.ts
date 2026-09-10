import { Hono, type Context } from "hono";
import { publish } from "../services/realtime";
import { notifyCamperChange } from "../services/notify";
import { requireAuth } from "../middleware/auth";
import { requireAdmin, requireRole } from "../middleware/roles";
import { findBedroomById } from "../models/bedrooms";
import { CHECKIN_FIELD, deleteCamper, findCamperById, insertCamper, listCampers, listCheckinLog, logCheckin, setCamperCheckin, updateCamper, type CamperData } from "../models/campers";
import { listStaff } from "../models/staff";
import { CAMPER_CATEGORY_KEYS, type Camper, type CheckinKind, type Role, type SessionUser } from "../types";
import { normalizeBrazilPhone } from "../utils";
import { bedroomFullMessage, isInvalid, parseBedroom, parseMulti, parseSingle, parseText } from "./_validate";
import { serializeStaffList } from "./staff";
import { camperVisibility, canRunBusCheckin, canRunCheckin, resolveScope, type Scope } from "../services/scope";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

const campers = new Hono<Env>();

const NAME_MAX = 100;
const SHORT_MAX = 120;
const TEXT_MAX = 1000;
const WEIGHT_MIN = 5;
const WEIGHT_MAX = 200;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function fail(c: Context, code: string, message: string, status: 400 | 403 | 404 | 409 = 400) {
  return c.json({ error: { code, message } }, status);
}

export function serializeCamper(k: Camper) {
  return {
    id: k._id,
    name: k.name,
    birthDate: k.birthDate,
    team: k.team,
    transportation: k.transportation,
    bed: k.bed,
    bedroom: k.bedroom,
    weightKg: k.weightKg,
    allergies: k.allergies,
    drugAllergies: k.drugAllergies,
    healthIssues: k.healthIssues,
    medicines: k.medicines,
    foodRestrictions: k.foodRestrictions,
    healthNotes: k.healthNotes,
    generalNotes: k.generalNotes,
    bedroomPreference: k.bedroomPreference,
    insurance: k.insurance,
    insuranceCard: k.insuranceCard,
    emergencyContact: k.emergencyContact,
    guardianName: k.guardianName,
    guardianPhone: k.guardianPhone,
    checkin: k.checkin,
    busCheckin: k.busCheckin,
    createdAt: k.createdAt,
    updatedAt: k.updatedAt,
  };
}

/**
 * Serializes `k` according to the viewer's scope, or `null` when invisible.
 * A bus helper gets the kids outside their room as NAME-ONLY records
 * (`redacted: true`): what the roll call needs — name, age, vehicle, room,
 * team and the check-in stamps — and nothing about health, contacts or notes.
 */
export function serializeCamperFor(k: Camper, scope: Scope) {
  const vis = camperVisibility(scope, k);
  if (vis === "none") return null;
  const full = serializeCamper(k);
  if (vis === "full") return full;
  return {
    ...full,
    redacted: true,
    bed: null,
    weightKg: null,
    allergies: [],
    drugAllergies: [],
    healthIssues: [],
    medicines: "",
    foodRestrictions: "",
    healthNotes: "",
    generalNotes: "",
    bedroomPreference: "",
    insurance: "",
    insuranceCard: "",
    emergencyContact: "",
    guardianName: "",
    guardianPhone: "",
  };
}

/** Every kid the viewer may see, each serialized per their scope. */
export function serializeCamperList(list: Camper[], scope: Scope) {
  return list.map((k) => serializeCamperFor(k, scope)).filter((x): x is NonNullable<typeof x> => x !== null);
}

/** Builds a validated patch; `partial` (PUT) only touches keys present in the body. */
async function buildPatch(
  body: Record<string, unknown>,
  partial: boolean,
): Promise<{ patch: Partial<CamperData> } | { code: string; message: string }> {
  const patch: Partial<CamperData> = {};
  const has = (k: string) => !partial || body[k] !== undefined;

  if (has("name")) {
    const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > NAME_MAX) return { code: "NAME_INVALID", message: `Informe um nome com até ${NAME_MAX} caracteres.` };
    patch.name = name;
  }

  if (has("birthDate")) {
    const v = body.birthDate;
    if (v === undefined || v === null || v === "") patch.birthDate = null;
    else if (typeof v !== "string" || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
      return { code: "BIRTH_DATE_INVALID", message: "Data de nascimento inválida." };
    } else patch.birthDate = v;
  }

  const singles: ["team" | "transportation" | "bed", string][] = [
    ["team", "Time"],
    ["transportation", "Transporte"],
    ["bed", "Cama"],
  ];
  for (const [field, label] of singles) {
    if (!has(field)) continue;
    const v = await parseSingle(body[field], CAMPER_CATEGORY_KEYS[field], label);
    if (isInvalid(v)) return { code: `${field.toUpperCase()}_INVALID`, message: v.error };
    patch[field] = v;
  }

  if (has("bedroom")) {
    const v = await parseBedroom(body.bedroom);
    if (isInvalid(v)) return { code: "BEDROOM_INVALID", message: v.error };
    patch.bedroom = v;
  }

  if (has("weightKg")) {
    const v = body.weightKg;
    if (v === undefined || v === null || v === "") patch.weightKg = null;
    else {
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(",", ".")) : NaN;
      if (!Number.isFinite(n) || n < WEIGHT_MIN || n > WEIGHT_MAX) {
        return { code: "WEIGHT_INVALID", message: `Peso inválido (entre ${WEIGHT_MIN} e ${WEIGHT_MAX} kg).` };
      }
      patch.weightKg = Math.round(n * 10) / 10;
    }
  }

  const multis: ["allergies" | "drugAllergies" | "healthIssues", string][] = [
    ["allergies", "Alergias"],
    ["drugAllergies", "Alergia a medicamentos"],
    ["healthIssues", "Condição crônica"],
  ];
  for (const [field, label] of multis) {
    if (!has(field)) continue;
    const v = await parseMulti(body[field], CAMPER_CATEGORY_KEYS[field], label);
    if (isInvalid(v)) return { code: `${field.toUpperCase()}_INVALID`, message: v.error };
    patch[field] = v;
  }

  const shorts = ["insurance", "insuranceCard", "emergencyContact", "guardianName"] as const;
  for (const field of shorts) {
    if (!has(field)) continue;
    const v = parseText(body[field], SHORT_MAX);
    if (isInvalid(v)) return { code: `${field.toUpperCase()}_INVALID`, message: v.error };
    patch[field] = v;
  }
  const longs = ["medicines", "foodRestrictions", "healthNotes", "generalNotes", "bedroomPreference"] as const;
  for (const field of longs) {
    if (!has(field)) continue;
    const v = parseText(body[field], TEXT_MAX);
    if (isInvalid(v)) return { code: `${field.toUpperCase()}_INVALID`, message: v.error };
    patch[field] = v;
  }

  if (has("guardianPhone")) {
    const raw = body.guardianPhone;
    if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) patch.guardianPhone = null;
    else {
      const phone = typeof raw === "string" ? normalizeBrazilPhone(raw) : null;
      if (!phone) return { code: "GUARDIAN_PHONE_INVALID", message: "Telefone do responsável inválido." };
      patch.guardianPhone = phone;
    }
  }

  return { patch };
}

campers.use("*", requireAuth);

// ── read: admin sees every kid; staff/health staff only the kids in their own room (see services/scope.ts) ──

/** GET /api/campers?bedroom=<id> (scoped) */
campers.get("/", requireRole("admin", "staff", "health_staff"), async (c) => {
  const bedroom = c.req.query("bedroom") || undefined;
  const [list, scope] = await Promise.all([listCampers({ bedroom }), resolveScope(c.get("user"))]);
  return c.json({ campers: serializeCamperList(list, scope) });
});

campers.get("/:id", requireRole("admin", "staff", "health_staff"), async (c) => {
  const k = await findCamperById(c.req.param("id"));
  // outside the viewer's scope → same answer as "does not exist" (no probing)
  const out = k ? serializeCamperFor(k, await resolveScope(c.get("user"))) : null;
  if (!out) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
  return c.json({ camper: out });
});

/** GET /api/campers/:id/detail — the kid + their room + the staff caretakers of that room. */
campers.get("/:id/detail", requireRole("admin", "staff", "health_staff"), async (c) => {
  const k = await findCamperById(c.req.param("id"));
  const scope = await resolveScope(c.get("user"));
  const out = k ? serializeCamperFor(k, scope) : null;
  if (!k || !out) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
  const [bedroom, allStaff, roommates] = await Promise.all([
    k.bedroom ? findBedroomById(k.bedroom) : null,
    k.bedroom ? listStaff() : [],
    k.bedroom ? listCampers({ bedroom: k.bedroom }) : [],
  ]);
  return c.json({
    camper: out,
    bedroom: bedroom ? { id: bedroom._id, name: bedroom.name, group: bedroom.group } : null,
    caretakers: serializeStaffList(allStaff.filter((s) => s.bedroom === k.bedroom), scope),
    roommates: serializeCamperList(roommates.filter((x) => x._id !== k._id), scope),
  });
});

// ── check-in: admin, or a team member the admin listed as a CHECK-IN HELPER while
//    the configured window is open (Settings → Ajudantes do check-in; see scope.ts) ──

const KIND_LABEL: Record<CheckinKind, string> = { church: "check-in", bus: "check-in no ônibus" };
const TEAM_OR_ADMIN = requireRole("admin", "staff", "health_staff");

/**
 * Marks or unmarks one kind of check-in, stamping who did it and writing the
 * audit line. Permission: admin, or a helper of that roll call inside the
 * check-in window — bus helpers only for the kids of the vehicle the admin
 * linked them to (Settings → Check-in; see scope.ts). Checked here, per kid, never trusted
 * from the client.
 */
async function doCheckin(c: Context<Env>, kind: CheckinKind, action: "checkin" | "undo") {
  const [existing, scope] = await Promise.all([findCamperById(c.req.param("id") ?? ""), resolveScope(c.get("user"))]);
  // unknown kid: admins / helpers get a 404, everyone else the same 403 (no probing)
  const allowed = existing ? (kind === "bus" ? canRunBusCheckin(scope, existing) : canRunCheckin(scope)) : canRunCheckin(scope) || (!scope.all && scope.busHelperVehicle !== null);
  if (!allowed) return fail(c, "CHECKIN_WINDOW_CLOSED", "O check-in não está liberado para você neste momento.", 403);
  if (!existing) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
  const current = existing[CHECKIN_FIELD[kind]];
  if (action === "checkin" && current) return fail(c, "ALREADY_CHECKED_IN", `${existing.name} já fez ${KIND_LABEL[kind]}.`, 409);
  if (action === "undo" && !current) return fail(c, "NOT_CHECKED_IN", `${existing.name} ainda não fez ${KIND_LABEL[kind]}.`, 409);
  // the bus roll call only makes sense after the parent handed the kid over at the church
  if (kind === "bus" && action === "checkin" && !existing.checkin) {
    return fail(c, "CHURCH_CHECKIN_REQUIRED", `${existing.name} ainda não fez o check-in na igreja.`, 409);
  }
  const user = c.get("user");
  const stamp = { at: new Date(), byUserId: user.id, byName: user.name, byRole: user.activeRole };
  const updated = await setCamperCheckin(existing._id, kind, action === "checkin" ? stamp : null);
  await logCheckin({ camperId: existing._id, camperName: existing.name, kind, action, ...stamp });
  publish("campers");
  // the answer is scoped too: a bus helper gets the name-only record back
  return c.json({ camper: serializeCamperFor(updated!, scope) });
}

/** POST /api/campers/:id/checkin — arrived at the church, parent confirmed the data. DELETE undoes. */
campers.post("/:id/checkin", TEAM_OR_ADMIN, (c) => doCheckin(c, "church", "checkin"));
campers.delete("/:id/checkin", TEAM_OR_ADMIN, (c) => doCheckin(c, "church", "undo"));

/** POST /api/campers/:id/checkin/bus — boarded the bus (roll call inside the vehicle). DELETE undoes. */
campers.post("/:id/checkin/bus", TEAM_OR_ADMIN, (c) => doCheckin(c, "bus", "checkin"));
campers.delete("/:id/checkin/bus", TEAM_OR_ADMIN, (c) => doCheckin(c, "bus", "undo"));

/** GET /api/campers/checkin/log — full audit trail (admin). GET /api/campers/:id/checkin/log — one kid. */
function serializeLog(l: Awaited<ReturnType<typeof listCheckinLog>>[number]) {
  return { id: l._id, camperId: l.camperId, camperName: l.camperName, kind: l.kind ?? "church", action: l.action, at: l.at, byUserId: l.byUserId, byName: l.byName, byRole: l.byRole };
}
campers.get("/checkin/log", requireAdmin, async (c) => c.json({ log: (await listCheckinLog()).map(serializeLog) }));
campers.get("/:id/checkin/log", requireAdmin, async (c) => {
  const k = await findCamperById(c.req.param("id"));
  if (!k) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
  return c.json({ log: (await listCheckinLog(k._id)).map(serializeLog) });
});

// ── write: admin only ──────────────────────────────────────────────────────────

campers.use("/*", requireAdmin);

campers.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const result = await buildPatch(body, false);
  if (!("patch" in result)) return fail(c, result.code, result.message);
  const data = result.patch as CamperData;

  const full = await bedroomFullMessage(data.bedroom, null);
  if (full) return fail(c, "BEDROOM_FULL", full, 409);

  const created = await insertCamper(data);
  publish("campers", "bedrooms");
  void notifyCamperChange(null, created);
  return c.json({ camper: serializeCamper(created) }, 201);
});

campers.put("/:id", async (c) => {
  const existing = await findCamperById(c.req.param("id"));
  if (!existing) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const result = await buildPatch(body, true);
  if (!("patch" in result)) return fail(c, result.code, result.message);

  if (result.patch.bedroom !== undefined && result.patch.bedroom !== existing.bedroom) {
    const full = await bedroomFullMessage(result.patch.bedroom, existing.bedroom);
    if (full) return fail(c, "BEDROOM_FULL", full, 409);
  }

  const updated = await updateCamper(existing._id, result.patch);
  publish("campers", "bedrooms");
  void notifyCamperChange(existing, updated);
  return c.json({ camper: serializeCamper(updated!) });
});

campers.delete("/:id", async (c) => {
  const existing = await findCamperById(c.req.param("id"));
  const ok = existing ? await deleteCamper(existing._id) : false;
  if (!ok) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
  publish("campers", "bedrooms");
  void notifyCamperChange(existing, null);
  return c.json({ success: true });
});

export default campers;
