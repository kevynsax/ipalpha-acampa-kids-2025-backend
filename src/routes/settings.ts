import { Hono, type Context } from "hono";
import { requireAuth } from "../middleware/auth";
import { requireAdmin } from "../middleware/roles";
import { findCategoryByKey } from "../models/categories";
import { checkinWindowOpen, getSettings, staffAccessOpen, updateSettings } from "../models/settings";
import { listStaff, resetStaffCheckins, resetStaffVests } from "../models/staff";
import { clearCheckinLog, resetCamperCheckins } from "../models/campers";
import { comteleEnabled } from "../services/comtele";
import { notifyAccessListChange, syncWelcomes } from "../services/notify";
import { evictStaffOutsideWindow, publish, scheduleCheckinReminder, scheduleCheckinWindow } from "../services/realtime";
import { CAMPER_CATEGORY_KEYS, type BusHelperList, type CheckinLocation, type CheckinWindow, type NotificationSettings, type ParentContact, type Role, type SessionUser, type Settings, type StaffList } from "../types";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

const settings = new Hono<Env>();

const RADIUS_MIN = 50;
const RADIUS_MAX = 5000;

function fail(c: Context, code: string, message: string, status: 400 | 404 | 409 = 400) {
  return c.json({ error: { code, message } }, status);
}

function serializeWindow(w: CheckinWindow, open: boolean) {
  return {
    from: w.from?.toISOString() ?? null,
    until: w.until?.toISOString() ?? null,
    /** read-only: is the window open right now (server clock)? */
    open,
  };
}

export function serializeSettings(s: Settings) {
  return {
    checkinLocation: s.checkinLocation,
    notifications: s.notifications,
    checkinWindow: serializeWindow(s.checkinWindow, s.checkinTestMode || checkinWindowOpen(s.checkinWindow)),
    checkinTestMode: s.checkinTestMode,
    kidsRoomsDraft: s.kidsRoomsDraft,
    staffAccessWindow: serializeWindow(s.staffAccessWindow, staffAccessOpen(s.staffAccessWindow)),
    checkinReminder: { at: s.checkinReminder.at?.toISOString() ?? null, sentAt: s.checkinReminder.sentAt?.toISOString() ?? null },
    checkinHelpers: { staffIds: s.checkinHelpers.staffIds },
    busHelpers: { helpers: s.busHelpers.helpers.map((h) => ({ staffId: h.staffId, vehicleId: h.vehicleId })) },
    organizers: { staffIds: s.organizers.staffIds },
    gameOrganizers: { staffIds: s.gameOrganizers.staffIds },
    medicalStaff: { staffIds: s.medicalStaff.staffIds },
    vestHelpers: { staffIds: s.vestHelpers.staffIds },
    parentContacts: s.parentContacts.map((contact) => ({ ...contact })),
    /** whether SMS can actually go out (Comtele key configured) — read-only, shown on the settings page */
    smsEnabled: comteleEnabled(),
    updatedAt: s.updatedAt,
  };
}

function parseNotifications(value: unknown, current: NotificationSettings): NotificationSettings | { error: string } {
  if (!value || typeof value !== "object") return { error: "Informe as notificações." };
  const o = value as Record<string, unknown>;
  const out = { ...current };
  for (const k of ["bedroomChanges", "roleChanges", "checkinConfirmation", "contentChanges", "staffChanges", "enrolments", "occurrences", "checkinReminder", "parentEdits"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "boolean") return { error: "Cada notificação deve ser ligada ou desligada." };
    out[k] = o[k] as boolean;
  }
  return out;
}

function parseLocation(value: unknown): CheckinLocation | { error: string } {
  if (!value || typeof value !== "object") return { error: "Informe a localização do check-in." };
  const o = value as Record<string, unknown>;
  const lat = Number(o.lat);
  const lng = Number(o.lng);
  const radiusM = o.radiusM === undefined ? 300 : Number(o.radiusM);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { error: "Latitude inválida (entre -90 e 90)." };
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return { error: "Longitude inválida (entre -180 e 180)." };
  if (!Number.isFinite(radiusM) || radiusM < RADIUS_MIN || radiusM > RADIUS_MAX) {
    return { error: `O raio precisa estar entre ${RADIUS_MIN} e ${RADIUS_MAX} metros.` };
  }
  return { lat, lng, radiusM: Math.round(radiusM) };
}

/** string[] of ACTIVE staff ids (deduplicated) */
async function parseStaffIds(value: unknown): Promise<string[] | { error: string }> {
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) return { error: "A lista de pessoas é inválida." };
  const staffIds = [...new Set(value as string[])];
  const active = new Set((await listStaff({ active: true })).map((s) => s._id));
  if (staffIds.some((id) => !active.has(id))) return { error: "Alguma pessoa não existe ou está inativa na equipe." };
  return staffIds;
}

/** { from: ISO | null, until: ISO | null } — from < until when both are set */
function parseWindow(value: unknown): CheckinWindow | { error: string } {
  if (!value || typeof value !== "object") return { error: "Informe a janela do check-in." };
  const o = value as Record<string, unknown>;
  const parseDate = (v: unknown, label: string): Date | null | { error: string } => {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v !== "string") return { error: `${label} inválido.` };
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? { error: `${label} inválido.` } : d;
  };
  const from = parseDate(o.from, "Início da janela");
  if (from && "error" in from) return from;
  const until = parseDate(o.until, "Fim da janela");
  if (until && "error" in until) return until;
  if (from && until && from >= until) return { error: "O fim da janela precisa ser depois do início." };
  return { from, until };
}

/** { at: ISO | null } — the instant of the check-in reminder (null / "" = none) */
function parseReminderAt(value: unknown): Date | null | { error: string } {
  const o = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const v = o ? o.at : value;
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") return { error: "Data do lembrete inválida." };
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? { error: "Data do lembrete inválida." } : d;
}

/** { staffIds: string[] } */
async function parseStaffList(value: unknown): Promise<StaffList | { error: string }> {
  const o = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const staffIds = await parseStaffIds(o ? o.staffIds : undefined);
  return Array.isArray(staffIds) ? { staffIds } : staffIds;
}

/** [{ id, title, staffId }] — ordered, unique entries pointing to active staff */
async function parseParentContacts(value: unknown): Promise<ParentContact[] | { error: string }> {
  if (!Array.isArray(value)) return { error: "A lista de contatos é inválida." };
  const contacts: ParentContact[] = [];
  for (const x of value) {
    const contact = x && typeof x === "object" ? (x as Record<string, unknown>) : null;
    if (!contact || typeof contact.id !== "string" || typeof contact.title !== "string" || typeof contact.staffId !== "string") {
      return { error: "Cada contato precisa de um título e uma pessoa da equipe." };
    }
    const id = contact.id.trim();
    const title = contact.title.trim();
    const staffId = contact.staffId.trim();
    if (!id || id.length > 80) return { error: "Algum contato tem um identificador inválido." };
    if (!title || title.length > 80) return { error: "O título de cada contato deve ter entre 1 e 80 caracteres." };
    if (!staffId) return { error: "Escolha uma pessoa da equipe para cada contato." };
    contacts.push({ id, title, staffId });
  }
  if (new Set(contacts.map((contact) => contact.id)).size !== contacts.length) return { error: "Há contatos duplicados." };
  const active = new Set((await listStaff({ active: true })).map((staff) => staff._id));
  if (contacts.some((contact) => !active.has(contact.staffId))) return { error: "Alguma pessoa não existe ou está inativa na equipe." };
  return contacts;
}

/** { helpers: [{ staffId, vehicleId }] } — active staff, active `transporte` option, one vehicle per person */
async function parseBusHelpers(value: unknown): Promise<BusHelperList | { error: string }> {
  const o = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const raw = o ? o.helpers : undefined;
  if (!Array.isArray(raw)) return { error: "A lista de ajudantes do ônibus é inválida." };
  const helpers: BusHelperList["helpers"] = [];
  for (const x of raw) {
    const h = x && typeof x === "object" ? (x as Record<string, unknown>) : null;
    if (!h || typeof h.staffId !== "string" || typeof h.vehicleId !== "string") return { error: "Cada ajudante do ônibus precisa de uma pessoa e um veículo." };
    helpers.push({ staffId: h.staffId, vehicleId: h.vehicleId });
  }
  if (new Set(helpers.map((h) => h.staffId)).size !== helpers.length) return { error: "Cada pessoa só pode ficar na porta de um veículo." };
  const [staff, transport] = await Promise.all([listStaff({ active: true }), findCategoryByKey(CAMPER_CATEGORY_KEYS.transportation)]);
  const active = new Set(staff.map((s) => s._id));
  if (helpers.some((h) => !active.has(h.staffId))) return { error: "Alguma pessoa não existe ou está inativa na equipe." };
  const vehicles = new Set((transport?.options ?? []).filter((v) => v.active).map((v) => v.id));
  if (helpers.some((h) => !vehicles.has(h.vehicleId))) return { error: "Algum veículo não existe ou está inativo." };
  return { helpers };
}

settings.use("*", requireAuth);

/** GET /api/settings — any logged-in role (the team needs the check-in spot to know how far they are). */
settings.get("/", async (c) => c.json({ settings: serializeSettings(await getSettings()) }));

/** PUT /api/settings — admin only. { checkinLocation?, notifications?, checkinWindow?: { from, until }, checkinReminder?: { at }, checkinHelpers?: { staffIds }, busHelpers?: { helpers: [{ staffId, vehicleId }] }, organizers?: { staffIds }, gameOrganizers?: { staffIds }, medicalStaff?: { staffIds }, vestHelpers?: { staffIds }, parentContacts?: [{ id, title, staffId }] } */
settings.put("/", requireAdmin, async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const patch: Partial<Omit<Settings, "updatedAt">> = {};
  if (body.checkinLocation !== undefined) {
    const loc = parseLocation(body.checkinLocation);
    if ("error" in loc) return fail(c, "LOCATION_INVALID", loc.error);
    patch.checkinLocation = loc;
  }
  if (body.notifications !== undefined) {
    const n = parseNotifications(body.notifications, (await getSettings()).notifications);
    if ("error" in n) return fail(c, "NOTIFICATIONS_INVALID", n.error);
    patch.notifications = n;
  }
  let windowChanged = false;
  const LIST_ERROR = { checkinHelpers: "HELPERS_INVALID", organizers: "ORGANIZERS_INVALID", gameOrganizers: "GAME_ORGANIZERS_INVALID", medicalStaff: "MEDICAL_INVALID", vestHelpers: "VEST_HELPERS_INVALID" } as const;
  for (const key of ["checkinHelpers", "organizers", "gameOrganizers", "medicalStaff", "vestHelpers"] as const) {
    if (body[key] === undefined) continue;
    const l = await parseStaffList(body[key]);
    if ("error" in l) return fail(c, LIST_ERROR[key], l.error);
    patch[key] = l;
  }
  if (body.busHelpers !== undefined) {
    const l = await parseBusHelpers(body.busHelpers);
    if ("error" in l) return fail(c, "HELPERS_INVALID", l.error);
    patch.busHelpers = l;
  }
  if (body.parentContacts !== undefined) {
    const contacts = await parseParentContacts(body.parentContacts);
    if (!Array.isArray(contacts)) return fail(c, "CONTACTS_INVALID", contacts.error);
    patch.parentContacts = contacts;
  }
  if (body.checkinWindow !== undefined) {
    const w = parseWindow(body.checkinWindow);
    if ("error" in w) return fail(c, "WINDOW_INVALID", w.error);
    patch.checkinWindow = w;
    windowChanged = true;
  }
  if (body.staffAccessWindow !== undefined) {
    const w = parseWindow(body.staffAccessWindow);
    if ("error" in w) return fail(c, "WINDOW_INVALID", w.error);
    patch.staffAccessWindow = w;
    windowChanged = true;
  }
  if (body.checkinTestMode !== undefined) {
    if (typeof body.checkinTestMode !== "boolean") return fail(c, "TEST_MODE_INVALID", "O modo de teste deve ser ligado ou desligado.");
    patch.checkinTestMode = body.checkinTestMode;
    windowChanged = true;
  }
  let reminderChanged = false;
  if (body.checkinReminder !== undefined) {
    const at = parseReminderAt(body.checkinReminder);
    if (at && "error" in at) return fail(c, "REMINDER_INVALID", at.error);
    const current = (await getSettings()).checkinReminder;
    // same instant → keep the "already sent" mark; a new instant re-arms the reminder
    const same = (at?.getTime() ?? null) === (current.at?.getTime() ?? null);
    patch.checkinReminder = { at, sentAt: same ? current.sentAt : null };
    reminderChanged = true;
  }
  let draftChanged = false;
  if (body.kidsRoomsDraft !== undefined) {
    if (typeof body.kidsRoomsDraft !== "boolean") return fail(c, "DRAFT_INVALID", "O rascunho dos quartos deve ser ligado ou desligado.");
    patch.kidsRoomsDraft = body.kidsRoomsDraft;
    draftChanged = true;
  }
  if (Object.keys(patch).length === 0) return fail(c, "NOTHING_TO_UPDATE", "Nada para atualizar.");

  const previous = await getSettings();
  const updated = await updateSettings(patch);
  void notifyAccessListChange(previous, updated); // fire-and-forget: the SMS never delays the write
  const scopeChanged = patch.organizers || patch.gameOrganizers || patch.checkinHelpers || patch.busHelpers || patch.medicalStaff || patch.vestHelpers || windowChanged || draftChanged;
  if (scopeChanged) {
    // Any access-list change may alter which records a phone is allowed to keep.
    // Re-send every scoped collection so gains and revocations happen live.
    publish("campers", "staff", "bedrooms", "roles", "events", "occurrences", "scores");
    // someone may have just left every list while the team window is closed: log them out now
    if (!windowChanged) void evictStaffOutsideWindow().catch((err) => console.error("realtime: evict failed", err));
  }
  // Settings are shared application data too: every connected admin/team
  // client receives the canonical value through the WebSocket collection.
  publish("settings");
  // the date or the toggle changed: re-arm (a pending past instant with the toggle now on fires at once)
  if (reminderChanged || patch.notifications) scheduleCheckinReminder(updated.checkinReminder.at);
  if (windowChanged) {
    scheduleCheckinWindow(updated.checkinWindow, updated.staffAccessWindow);
    if (patch.staffAccessWindow) void syncWelcomes(); // the window may have just opened (start moved to the past)
    // the admin may have closed the team's window right now: log those people out
    void evictStaffOutsideWindow().catch((err) => console.error("realtime: evict failed", err));
  }
  return c.json({ settings: serializeSettings(updated) });
});

/** POST /api/settings/checkin/reset — admin only. Clears EVERY check-in (kids' church + bus, team), the team vests and the audit log, so the process can be rehearsed. */
settings.post("/checkin/reset", requireAdmin, async (c) => {
  const [campers, staff, vests] = await Promise.all([resetCamperCheckins(), resetStaffCheckins(), resetStaffVests()]);
  await clearCheckinLog();
  console.log(`🧹 check-ins reset by ${c.get("user").name}: ${campers} campers, ${staff} staff, ${vests} vests`);
  publish("campers", "staff");
  return c.json({ campers, staff, vests });
});

export default settings;
