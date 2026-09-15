import { Hono, type Context } from "hono";
import { publish } from "../services/realtime";
import { notifyBusCheckin, notifyCamperChange, notifyForeignLookupAlert, notifyParentEdit } from "../services/notify";
import { requireAuth } from "../middleware/auth";
import { requireManager, requireRole } from "../middleware/roles";
import { findBedroomById } from "../models/bedrooms";
import { insertCamperLookup } from "../models/camperLookups";
import { CHECKIN_FIELD, deleteCamper, findCamperById, insertCamper, listCamperChanges, listCampers, listCheckinLog, logCamperChange, logCheckin, setCamperCheckin, updateCamper, type CamperData } from "../models/campers";
import { FOREIGN_LOOKUP_ALERT_AT, FOREIGN_LOOKUP_BLOCK_AT, findStaffById, findStaffByPhone, listStaff, markForeignLookupAlerted, recordForeignLookup } from "../models/staff";
import { CAMPER_CATEGORY_KEYS, PARENT_EDITABLE_FIELDS, type Camper, type CamperChangeLog, type CheckinKind, type ParentEditableField, type Role, type SessionUser } from "../types";
import { formatCpf, normalizeBrazilPhone, titleCaseName } from "../utils";
import { bedroomFullMessage, isInvalid, parseBedroom, parseMedications, parseMulti, parseSingle, parseTeam, parseText, parseTransport } from "./_validate";
import { serializeStaffList } from "./staff";
import { camperVisibility, canParentEdit, canRunBusCheckin, canRunCheckin, resolveScope, type Scope } from "../services/scope";
import { campInProgress, campPeriod } from "../services/camp";

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
    sex: k.sex,
    cpf: formatCpf(k.cpf),
    rg: k.rg,
    school: k.school,
    schoolGrade: k.schoolGrade,
    church: k.church,
    invitedBy: k.invitedBy,
    caretakerId: k.caretakerId,
    qrToken: k.qrToken,
    externalId: k.externalId,
    team: k.team,
    transportation: k.transportation,
    bed: k.bed,
    bedroom: k.bedroom,
    weightKg: k.weightKg,
    allergies: k.allergies,
    drugAllergies: k.drugAllergies,
    healthIssues: k.healthIssues,
    neurodivergent: k.neurodivergent,
    medications: k.medications,
    foodRestrictions: k.foodRestrictions,
    healthNotes: k.healthNotes,
    generalNotes: k.generalNotes,
    bedroomPreference: k.bedroomPreference,
    insurance: k.insurance,
    insuranceCard: k.insuranceCard,
    emergencyContact: k.emergencyContact,
    guardianName: k.guardianName,
    guardianPhone: k.guardianPhone,
    guardianCpf: formatCpf(k.guardianCpf),
    guardianEmail: k.guardianEmail,
    checkin: k.checkin,
    busCheckin: k.busCheckin,
    busReturnCheckin: k.busReturnCheckin,
    parentEditedAt: k.parentEditedAt,
    createdAt: k.createdAt,
    updatedAt: k.updatedAt,
  };
}

/** the parts of the record only the admin / medical team / check-in helpers get: who to call, documents */
const CONTACT_BLANK = {
  cpf: "",
  rg: "",
  school: "",
  schoolGrade: "",
  church: "",
  invitedBy: "",
  qrToken: "",
  externalId: "",
  insurance: "",
  insuranceCard: "",
  emergencyContact: "",
  guardianName: "",
  guardianPhone: null,
  guardianCpf: "",
  guardianEmail: "",
} as const;

/**
 * Serializes `k` according to the viewer's scope, or `null` when invisible.
 * A room caretaker / helper gets a CARE record (`contactsHidden: true`):
 * everything they need to look after the kid — health, notes, preferences and
 * the guardian's name + phone (to reach the parents) — but no emergency
 * contact, documents, insurance or e-mail. A bus helper gets the kids
 * outside their room as NAME-ONLY records (`redacted: true`): what the roll
 * call needs — name, age, vehicle, room, team and the check-in stamps — and
 * nothing about health, contacts or notes.
 */
export function serializeCamperFor(k: Camper, scope: Scope) {
  const vis = camperVisibility(scope, k);
  if (vis === "none") return null;
  const full = serializeCamper(k);
  // a parent while the rooms are still a draft: the room, bed and caretaker are not decided yet
  if (vis === "full" && !scope.all && scope.kidsRoomsDraft && scope.parentKids.length > 0) return { ...full, bedroom: null, bed: null, caretakerId: null };
  if (vis === "full") return full;
  // neurodivergence is a diagnosis: admin + medical team only
  if (vis === "care") return { ...full, ...CONTACT_BLANK, guardianName: k.guardianName, guardianPhone: k.guardianPhone, neurodivergent: false, contactsHidden: true };
  return {
    ...full,
    ...CONTACT_BLANK,
    redacted: true,
    neurodivergent: false,
    parentEditedAt: null,
    bed: null,
    weightKg: null,
    allergies: [],
    drugAllergies: [],
    healthIssues: [],
    medications: [],
    foodRestrictions: "",
    healthNotes: "",
    generalNotes: "",
    bedroomPreference: "",
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
    const name = typeof body.name === "string" ? titleCaseName(body.name) : "";
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

  if (has("sex")) {
    const v = body.sex;
    if (v === undefined || v === null || v === "") patch.sex = null;
    else if (v !== "F" && v !== "M") return { code: "SEX_INVALID", message: "Sexo inválido." };
    else patch.sex = v;
  }

  if (has("team")) {
    const v = await parseTeam(body.team);
    if (isInvalid(v)) return { code: "TEAM_INVALID", message: v.error };
    patch.team = v;
  }

  if (has("transportation")) {
    const v = await parseTransport(body.transportation);
    if (isInvalid(v)) return { code: "TRANSPORTATION_INVALID", message: v.error };
    patch.transportation = v;
  }

  if (has("bed")) {
    const v = await parseSingle(body.bed, CAMPER_CATEGORY_KEYS.bed, "Cama");
    if (isInvalid(v)) return { code: "BED_INVALID", message: v.error };
    patch.bed = v;
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

  if (has("neurodivergent")) {
    const v = body.neurodivergent === undefined ? false : body.neurodivergent;
    if (typeof v !== "boolean") return { code: "NEURODIVERGENT_INVALID", message: "Neurodivergente deve ser sim ou não." };
    patch.neurodivergent = v;
  }

  if (has("caretakerId")) {
    const v = body.caretakerId;
    if (v === undefined || v === null || v === "") patch.caretakerId = null;
    else if (typeof v !== "string" || !(await findStaffById(v))) return { code: "CARETAKER_INVALID", message: "Líder não encontrado." };
    else patch.caretakerId = v;
  }

  const shorts = ["insurance", "insuranceCard", "emergencyContact", "guardianName", "cpf", "rg", "school", "schoolGrade", "church", "invitedBy", "qrToken", "externalId", "guardianCpf", "guardianEmail"] as const;
  for (const field of shorts) {
    if (!has(field)) continue;
    const v = parseText(body[field], SHORT_MAX);
    if (isInvalid(v)) return { code: `${field.toUpperCase()}_INVALID`, message: v.error };
    patch[field] = field === "guardianName" ? titleCaseName(v) : field === "cpf" || field === "guardianCpf" ? formatCpf(v) : v;
  }
  if (has("medications")) {
    const v = parseMedications(body.medications);
    if (isInvalid(v)) return { code: "MEDICATIONS_INVALID", message: v.error };
    patch.medications = v;
  }

  const longs = ["foodRestrictions", "healthNotes", "generalNotes", "bedroomPreference"] as const;
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

/**
 * The caretaker must sleep in the kid's room and be a CARETAKER there. A room
 * change without a caretaker leaves the kid an orphan; one with a caretaker
 * from another room is refused. Returns an error message or null.
 */
async function caretakerConsistent(bedroom: string | null, caretakerId: string | null): Promise<string | null> {
  if (!caretakerId) return null;
  const s = await findStaffById(caretakerId);
  if (!s) return "Líder não encontrado.";
  if (!bedroom || s.bedroom !== bedroom) return `${s.name.split(" ")[0]} não dorme neste quarto.`;
  if (s.roomRole !== "caretaker") return `${s.name.split(" ")[0]} é auxiliar neste quarto, não líder.`;
  return null;
}

campers.use("*", requireAuth);

// ── read: admin sees every kid; staff/health staff only the kids in their own room; parents their own kids (see services/scope.ts) ──

/** GET /api/campers?bedroom=<id> (scoped) */
campers.get("/", requireRole("admin", "staff", "health_staff", "parent"), async (c) => {
  const bedroom = c.req.query("bedroom") || undefined;
  const [list, scope] = await Promise.all([listCampers({ bedroom }), resolveScope(c.get("user"))]);
  return c.json({ campers: serializeCamperList(list, scope) });
});

/**
 * GET /api/campers/lookup/:id — emergency QR lookup (the ONLY intentional HTTP
 * GET for a kid outside the realtime snapshot). Any team member / admin may
 * open a kid's badge: when the kid already belongs to their scope the CARE
 * (or FULL) record is returned with `belonged: true` and nothing is counted;
 * otherwise they get a CARE record (`contactsHidden`, no emergency / documents) with
 * `belonged: false` + a warning, the scan is logged, and the staff member's
 * out-of-scope counter ticks (distinct kids). ≥3 → SMS to every admin; ≥5 →
 * further out-of-scope lookups are blocked until Settings → Geral zeroes it.
 * Parents never use this endpoint. Only WHILE THE CAMP IS HAPPENING (first
 * programme day → end of the last event): outside it the badge means nothing
 * and the endpoint answers 403 `CAMP_NOT_ACTIVE` (admins / organizers
 * included — they have the regular pages).
 */
campers.get("/lookup/:id", requireRole("admin", "staff", "health_staff"), async (c) => {
  if (!campInProgress(await campPeriod())) return fail(c, "CAMP_NOT_ACTIVE", "A leitura de crachás só funciona durante o acampamento.", 403);
  const user = c.get("user");
  const scope = await resolveScope(user);
  const k = await findCamperById(c.req.param("id"));
  if (!k) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);

  // "belongs to me" = I already look after this kid (full / care). Name-only
  // visibility (score helper, bus helper) still counts as out-of-scope for the
  // emergency lookup — those people only know the name for a roll call / scan.
  const vis = camperVisibility(scope, k);
  const belonged = scope.all || vis === "full" || vis === "care";
  if (belonged) {
    const camper = serializeCamperFor(k, scope) ?? { ...serializeCamper(k), ...CONTACT_BLANK, neurodivergent: false, contactsHidden: true };
    return c.json({ camper, belonged: true, foreignLookupCount: 0, foreignLookupBlocked: false });
  }

  const me = scope.staffId ? await findStaffById(scope.staffId) : await findStaffByPhone(user.phone);
  if (!me || !me.active) return fail(c, "STAFF_NOT_LINKED", "Seu celular não está vinculado a um cadastro da equipe.", 403);

  if (me.foreignLookupCount >= FOREIGN_LOOKUP_BLOCK_AT) {
    return c.json(
      {
        error: {
          code: "LOOKUP_BLOCKED",
          message: `Você já leu ${me.foreignLookupCount} crianças que não são do seu quarto. Peça à organização para liberar o acesso.`,
          foreignLookupCount: me.foreignLookupCount,
        },
      },
      403,
    );
  }

  // CARE view for emergencies: health + notes the team needs, never guardian / documents
  const camper = { ...serializeCamper(k), ...CONTACT_BLANK, neurodivergent: false, contactsHidden: true };
  // room + caretaker names travel with the response — the scanner's store may not have them
  const [bedroom, caretaker] = await Promise.all([
    k.bedroom ? findBedroomById(k.bedroom) : null,
    k.caretakerId ? findStaffById(k.caretakerId) : null,
  ]);
  await insertCamperLookup({
    at: new Date(),
    camperId: k._id,
    camperName: k.name,
    byStaffId: me._id,
    byStaffName: me.name,
    byUserId: user.id,
    belonged: false,
  });
  const updated = (await recordForeignLookup(me._id, k._id, k.name)) ?? me;
  if (updated.foreignLookupCount >= FOREIGN_LOOKUP_ALERT_AT && !updated.foreignLookupAlertedAt) {
    await markForeignLookupAlerted(me._id);
    void notifyForeignLookupAlert(updated, updated.foreignLookupCount, updated.foreignLookupNames);
  }
  // staff list carries the counter for the admin export; settings refreshes the Geral card once someone is at/above the threshold
  if (updated.foreignLookupCount >= FOREIGN_LOOKUP_ALERT_AT) publish("staff", "settings");
  else publish("staff");
  return c.json({
    camper,
    bedroom: bedroom ? { id: bedroom._id, name: bedroom.name, group: bedroom.group } : null,
    caretaker: caretaker ? { id: caretaker._id, name: caretaker.name } : null,
    belonged: false,
    foreignLookupCount: updated.foreignLookupCount,
    foreignLookupBlocked: updated.foreignLookupCount >= FOREIGN_LOOKUP_BLOCK_AT,
  });
});

campers.get("/:id", requireRole("admin", "staff", "health_staff", "parent"), async (c) => {
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

const KIND_LABEL: Record<CheckinKind, string> = {
  church: "check-in",
  bus: "check-in no ônibus para o acampamento",
  bus_return: "check-in no ônibus de volta para a igreja",
};
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
  const allowed = existing
    ? kind === "church"
      ? canRunCheckin(scope)
      : canRunBusCheckin(scope, existing, kind)
    : canRunCheckin(scope) || (!scope.all && scope.busHelperVehicle !== null);
  if (!allowed) return fail(c, "CHECKIN_WINDOW_CLOSED", "O check-in não está liberado para você neste momento.", 403);
  if (!existing) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
  const current = existing[CHECKIN_FIELD[kind]];
  if (action === "checkin" && current) return fail(c, "ALREADY_CHECKED_IN", `${existing.name} já fez ${KIND_LABEL[kind]}.`, 409);
  if (action === "undo" && !current) return fail(c, "NOT_CHECKED_IN", `${existing.name} ainda não fez ${KIND_LABEL[kind]}.`, 409);
  // outbound bus: the parent must have handed the kid over at church first
  if (kind === "bus" && action === "checkin" && !existing.checkin) {
    return fail(c, "CHURCH_CHECKIN_REQUIRED", `${existing.name} ainda não fez o check-in na igreja.`, 409);
  }
  // return bus: only kids who actually travelled to camp can board on the way back
  if (kind === "bus_return" && action === "checkin" && !existing.busCheckin) {
    return fail(c, "OUTBOUND_BUS_CHECKIN_REQUIRED", `${existing.name} não fez o check-in do ônibus na ida.`, 409);
  }
  const user = c.get("user");
  const stamp = { at: new Date(), byUserId: user.id, byName: user.name, byRole: user.activeRole };
  const updated = await setCamperCheckin(existing._id, kind, action === "checkin" ? stamp : null);
  await logCheckin({ camperId: existing._id, camperName: existing.name, kind, action, ...stamp });
  publish("campers");
  // the kid left for camp → tell the parent (return and undo send nothing)
  if (kind === "bus" && action === "checkin") void notifyBusCheckin(updated!);
  // the answer is scoped too: a bus helper gets the name-only record back
  return c.json({ camper: serializeCamperFor(updated!, scope) });
}

/** POST /api/campers/:id/checkin — arrived at the church, parent confirmed the data. DELETE undoes. */
campers.post("/:id/checkin", TEAM_OR_ADMIN, (c) => doCheckin(c, "church", "checkin"));
campers.delete("/:id/checkin", TEAM_OR_ADMIN, (c) => doCheckin(c, "church", "undo"));

/** POST /api/campers/:id/checkin/bus — boarded the bus going to camp. DELETE undoes. */
campers.post("/:id/checkin/bus", TEAM_OR_ADMIN, (c) => doCheckin(c, "bus", "checkin"));
campers.delete("/:id/checkin/bus", TEAM_OR_ADMIN, (c) => doCheckin(c, "bus", "undo"));

/** POST /api/campers/:id/checkin/bus-return — boarded the bus returning to church. DELETE undoes. */
campers.post("/:id/checkin/bus-return", TEAM_OR_ADMIN, (c) => doCheckin(c, "bus_return", "checkin"));
campers.delete("/:id/checkin/bus-return", TEAM_OR_ADMIN, (c) => doCheckin(c, "bus_return", "undo"));

/** GET /api/campers/checkin/log — full audit trail (admin). GET /api/campers/:id/checkin/log — one kid. */
function serializeLog(l: Awaited<ReturnType<typeof listCheckinLog>>[number]) {
  return { id: l._id, camperId: l.camperId, camperName: l.camperName, kind: l.kind ?? "church", action: l.action, at: l.at, byUserId: l.byUserId, byName: l.byName, byRole: l.byRole, note: l.note ?? null };
}
campers.get("/checkin/log", requireManager, async (c) => c.json({ log: (await listCheckinLog()).map(serializeLog) }));
campers.get("/:id/checkin/log", requireManager, async (c) => {
  const k = await findCamperById(c.req.param("id"));
  if (!k) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
  return c.json({ log: (await listCheckinLog(k._id)).map(serializeLog) });
});

// ── parent edits: the kid's own guardian may change the "Pontos de atenção" block ──

function serializeChange(l: CamperChangeLog) {
  return { id: l._id, camperId: l.camperId, camperName: l.camperName, at: l.at, byUserId: l.byUserId, byName: l.byName, byRole: l.byRole, medical: l.medical, changes: l.changes };
}

/** GET /api/campers/:id/changes — every edit the parent made to this kid, newest first (admin). */
campers.get("/:id/changes", requireManager, async (c) => {
  const k = await findCamperById(c.req.param("id"));
  if (!k) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);
  return c.json({ changes: (await listCamperChanges(k._id)).map(serializeChange) });
});

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * PUT /api/campers/:id/parent — a PARENT edits the health block of THEIR kid
 * (allergies, drug allergies, conditions, medicines, food, medical notes,
 * weight, insurance + card) and / or the observations (`generalNotes`).
 * Only the fields in PARENT_EDITABLE_FIELDS are accepted; everything else in
 * the body is ignored. Every real change is written to the kid's change log
 * (read by the admin) and texted: medical fields → medical team + admins +
 * caretaker; observations alone → caretaker (see services/notify.ts).
 */
campers.put("/:id/parent", requireRole("parent"), async (c) => {
  const [existing, scope] = await Promise.all([findCamperById(c.req.param("id")), resolveScope(c.get("user"))]);
  // not their kid → same answer as "does not exist" (no probing)
  if (!existing || !canParentEdit(scope, existing)) return fail(c, "CAMPER_NOT_FOUND", "Acampante não encontrado.", 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  const allowed: Record<string, unknown> = {};
  for (const f of PARENT_EDITABLE_FIELDS) if (body[f] !== undefined) allowed[f] = body[f];
  if (Object.keys(allowed).length === 0) return fail(c, "NOTHING_TO_UPDATE", "Nada para atualizar.");

  const result = await buildPatch(allowed, true);
  if (!("patch" in result)) return fail(c, result.code, result.message);

  const changes: CamperChangeLog["changes"] = [];
  for (const f of PARENT_EDITABLE_FIELDS) {
    if (!(f in result.patch)) continue;
    const before = existing[f];
    const after = (result.patch as Record<ParentEditableField, unknown>)[f];
    if (!sameValue(before, after)) changes.push({ field: f, before, after });
  }
  if (changes.length === 0) return c.json({ camper: serializeCamperFor(existing, scope), changed: false });

  const updated = (await updateCamper(existing._id, result.patch))!;
  const user = c.get("user");
  const entry = { camperId: existing._id, camperName: existing.name, at: new Date(), byUserId: user.id, byName: user.name, byRole: user.activeRole, medical: changes.some((x) => x.field !== "generalNotes"), changes };
  await logCamperChange(entry);
  publish("campers");
  void notifyParentEdit(updated, entry);
  return c.json({ camper: serializeCamperFor(updated, scope), changed: true });
});

// ── write: admin or organizer ──────────────────────────────────────────────────────────

campers.use("/*", requireManager);

campers.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const result = await buildPatch(body, false);
  if (!("patch" in result)) return fail(c, result.code, result.message);
  const data = result.patch as CamperData;

  const full = await bedroomFullMessage(data.bedroom, null);
  if (full) return fail(c, "BEDROOM_FULL", full, 409);
  const bad = await caretakerConsistent(data.bedroom, data.caretakerId);
  if (bad) return fail(c, "CARETAKER_INVALID", bad, 409);

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
    // moved without naming a caretaker of the new room → orphan (the old caretaker stays behind)
    if (result.patch.caretakerId === undefined) result.patch.caretakerId = null;
  }
  const bedroom = result.patch.bedroom !== undefined ? result.patch.bedroom : existing.bedroom;
  const caretakerId = result.patch.caretakerId !== undefined ? result.patch.caretakerId : existing.caretakerId;
  if (result.patch.bedroom !== undefined || result.patch.caretakerId !== undefined) {
    const bad = await caretakerConsistent(bedroom, caretakerId);
    if (bad) return fail(c, "CARETAKER_INVALID", bad, 409);
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
