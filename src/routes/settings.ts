import { Hono, type Context } from "hono";
import { config } from "../config";
import { requireAuth } from "../middleware/auth";
import { requireAdmin, requireManager } from "../middleware/roles";
import { listTransports } from "../models/transports";
import { checkinWindowOpen, getSettings, scoreHidden, staffAccessOpen, updateSettings } from "../models/settings";
import { FOREIGN_LOOKUP_ALERT_AT, findStaffByPhone, listForeignLookupOffenders, listStaff, resetForeignLookups, resetStaffCheckins, resetStaffPhotosNotice, resetStaffVests, updateStaff } from "../models/staff";
import { clearCheckinLog, resetCamperCheckins } from "../models/campers";
import { resetParentPhotosNotice } from "../models/users";
import { comteleEnabled } from "../services/comtele";
import { sampleNotificationEmails } from "../services/emails";
import { mailEnabled, sendMail } from "../services/mail";
import { normalizeBrazilPhone, normalizeEmail } from "../utils";
import { notifyAccessListChange, sendBirthdayNotices, syncParentWelcomes, syncWelcomes, welcomePreview } from "../services/notify";
import { evictStaffOutsideWindow, publish, rearmWindows, scheduleCheckinReminder } from "../services/realtime";
import { listEvents } from "../models/schedule";
import { parentWindowOf, parentWindowOpen } from "../services/camp";
import { type BusHelperList, type CheckinLocation, type CheckinWindow, type NotificationSettings, type ParentContact, type Role, type SessionUser, type Settings, type SmsRedirect, type StaffList } from "../types";

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

/**
 * Async because the PARENTS' window (when they see the team's contacts) is
 * derived from the programme: check-in start → end of the last event.
 */
export async function serializeSettings(s: Settings) {
  const pw = parentWindowOf(s, await listEvents());
  return {
    checkinLocations: s.checkinLocations.map((l) => ({ ...l })),
    /** read-only: when parents see the team's contacts (from the check-in start to the end of the last event) */
    parentWindow: serializeWindow(pw, parentWindowOpen(pw)),
    notifications: s.notifications,
    checkinWindow: serializeWindow(s.checkinWindow, s.checkinTestMode || checkinWindowOpen(s.checkinWindow)),
    busReturnWindow: serializeWindow(s.busReturnWindow, s.checkinTestMode || checkinWindowOpen(s.busReturnWindow)),
    checkinTestMode: s.checkinTestMode,
    kidsRoomsDraft: s.kidsRoomsDraft,
    scoreDraft: s.scoreDraft,
    /** the suspense window: written through PUT /api/scores/suspense (game organizers too) */
    scoreHideWindow: serializeWindow(s.scoreHideWindow, scoreHidden(s.scoreHideWindow)),
    wizardMode: s.wizardMode,
    galleryPublished: s.galleryPublished,
    staffAccessWindow: serializeWindow(s.staffAccessWindow, staffAccessOpen(s.staffAccessWindow)),
    parentAccessWindow: serializeWindow(s.parentAccessWindow, staffAccessOpen(s.parentAccessWindow)),
    checkinReminder: { at: s.checkinReminder.at?.toISOString() ?? null, sentAt: s.checkinReminder.sentAt?.toISOString() ?? null },
    smsRedirect: { ...s.smsRedirect },
    checkinHelpers: { staffIds: s.checkinHelpers.staffIds },
    busHelpers: { helpers: s.busHelpers.helpers.map((h) => ({ staffId: h.staffId, vehicleId: h.vehicleId })) },
    organizers: { staffIds: s.organizers.staffIds },
    gameOrganizers: { staffIds: s.gameOrganizers.staffIds },
    scoreHelpers: { staffIds: s.scoreHelpers.staffIds },
    medicalStaff: { staffIds: s.medicalStaff.staffIds },
    vestHelpers: { staffIds: s.vestHelpers.staffIds },
    photographers: { staffIds: s.photographers.staffIds },
    parentContacts: s.parentContacts.map((contact) => ({ ...contact })),
    /** whether SMS can actually go out (Comtele key configured) — read-only, shown on the settings page */
    smsEnabled: comteleEnabled(),
    /** whether notification emails can actually go out (SendGrid API key + from-address) */
    mailEnabled: mailEnabled(),
    /**
     * Staff who scanned ≥3 kids outside their scope (emergency QR). Always an
     * empty list for non-managers; empty for managers too when nobody reached
     * the threshold — the Geral card stays hidden then.
     */
    foreignLookupOffenders: [] as { staffId: string; name: string; count: number; names: string[]; blocked: boolean }[],
    updatedAt: s.updatedAt,
  };
}

/** Same as serializeSettings, plus the offenders list (admin / organizer only) and the super-admin flag (drives the ⚙️ → Sementes tab). */
export async function serializeSettingsForManager(s: Awaited<ReturnType<typeof getSettings>>, viewerPhone?: string) {
  const base = await serializeSettings(s);
  const superPhone = config.superAdminPhone ? normalizeBrazilPhone(config.superAdminPhone) : null;
  return {
    ...base,
    /** read-only: this session is the deployment owner (SUPER_ADMIN_PHONE) — the only one who maintains the seeds */
    superAdmin: !!superPhone && viewerPhone === superPhone,
    foreignLookupOffenders: (await listForeignLookupOffenders(FOREIGN_LOOKUP_ALERT_AT)).map((p) => ({
      staffId: p._id,
      name: p.name,
      count: p.foreignLookupCount,
      names: p.foreignLookupNames,
      blocked: p.foreignLookupCount >= 5,
    })),
  };
}

function parseNotifications(value: unknown, current: NotificationSettings): NotificationSettings | { error: string } {
  if (!value || typeof value !== "object") return { error: "Informe as notificações." };
  const o = value as Record<string, unknown>;
  const out = { ...current };
  for (const k of ["bedroomChanges", "roleChanges", "checkinConfirmation", "contentChanges", "parentContentChanges", "staffChanges", "enrolments", "occurrences", "checkinReminder", "parentEdits", "busCheckin", "parentWelcome", "birthdays", "photoPublishes"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "boolean") return { error: "Cada notificação deve ser ligada ou desligada." };
    out[k] = o[k] as boolean;
  }
  return out;
}

/** `{ enabled?, staffPhone?, parentPhone? }` — partial; phones are normalised to E.164 (empty / null clears). */
function parseSmsRedirect(value: unknown, current: SmsRedirect): SmsRedirect | { error: string } {
  if (!value || typeof value !== "object") return { error: "Informe o redirecionamento de SMS." };
  const o = value as Record<string, unknown>;
  const out: SmsRedirect = { ...current };
  if (o.enabled !== undefined) {
    if (typeof o.enabled !== "boolean") return { error: "O redirecionamento deve ser ligado ou desligado." };
    out.enabled = o.enabled;
  }
  for (const key of ["staffPhone", "parentPhone"] as const) {
    if (o[key] === undefined) continue;
    const raw = o[key];
    if (raw === null || (typeof raw === "string" && !raw.trim())) {
      out[key] = null;
      continue;
    }
    const phone = typeof raw === "string" ? normalizeBrazilPhone(raw) : null;
    if (!phone) return { error: `Celular de ${key === "staffPhone" ? "equipe" : "pais"} inválido: informe um celular brasileiro com DDD.` };
    out[key] = phone;
  }
  return out;
}

/** `[{ id, name, lat, lng, radiusM }]` — at least one spot; ids unique (the client mints them). */
function parseLocations(value: unknown): CheckinLocation[] | { error: string } {
  if (!Array.isArray(value)) return { error: "Informe a lista de pontos de encontro." };
  if (value.length === 0) return { error: "Deixe pelo menos um ponto de encontro." };
  if (value.length > 20) return { error: "Pontos de encontro demais (máx. 20)." };
  const out: CheckinLocation[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return { error: "Ponto de encontro inválido." };
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!id || id.length > 80 || ids.has(id)) return { error: "Algum ponto de encontro tem um identificador inválido ou repetido." };
    ids.add(id);
    const name = typeof o.name === "string" ? o.name.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > 60) return { error: "Dê um nome (até 60 caracteres) a cada ponto de encontro." };
    const lat = Number(o.lat);
    const lng = Number(o.lng);
    const radiusM = o.radiusM === undefined ? 300 : Number(o.radiusM);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { error: `${name}: latitude inválida (entre -90 e 90).` };
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) return { error: `${name}: longitude inválida (entre -180 e 180).` };
    if (!Number.isFinite(radiusM) || radiusM < RADIUS_MIN || radiusM > RADIUS_MAX) {
      return { error: `${name}: o raio precisa estar entre ${RADIUS_MIN} e ${RADIUS_MAX} metros.` };
    }
    out.push({ id, name, lat, lng, radiusM: Math.round(radiusM) });
  }
  return out;
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
export function parseWindow(value: unknown): CheckinWindow | { error: string } {
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

/** { helpers: [{ staffId, vehicleId }] } — active staff, an existing Transport (bus / car), one vehicle per person */
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
  const [staff, transports] = await Promise.all([listStaff({ active: true }), listTransports()]);
  const active = new Set(staff.map((s) => s._id));
  if (helpers.some((h) => !active.has(h.staffId))) return { error: "Alguma pessoa não existe ou está inativa na equipe." };
  const vehicles = new Set(transports.map((v) => v._id));
  if (helpers.some((h) => !vehicles.has(h.vehicleId))) return { error: "Algum veículo não existe." };
  return { helpers };
}

settings.use("*", requireAuth);

/** GET /api/settings — any logged-in role (the team needs the check-in spot to know how far they are). */
settings.get("/", async (c) => c.json({ settings: await serializeSettings(await getSettings()) }));

/** PUT /api/settings — admin or organizer (`organizers` and `notifications` are admin-only). { checkinLocations?: [{ id, name, lat, lng, radiusM }], notifications?, checkinWindow?: { from, until }, checkinReminder?: { at }, checkinHelpers?: { staffIds }, busHelpers?: { helpers: [{ staffId, vehicleId }] }, organizers?: { staffIds }, gameOrganizers?: { staffIds }, scoreHelpers?: { staffIds }, medicalStaff?: { staffIds }, vestHelpers?: { staffIds }, parentContacts?: [{ id, title, staffId }] } */
settings.put("/", requireManager, async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");
  // an organizer never edits the organizers list nor the SMS switches (except the check-in reminder toggle, which lives on Geral)
  if (c.get("activeRole") !== "admin") {
    const n = body.notifications;
    const onlyReminder = n === undefined || (typeof n === "object" && n !== null && Object.keys(n).every((k) => k === "checkinReminder"));
    if (body.organizers !== undefined || body.smsRedirect !== undefined || !onlyReminder) {
      return c.json({ error: { code: "FORBIDDEN", message: "Só o admin altera os organizadores, as notificações e o redirecionamento de SMS." } }, 403);
    }
  }

  const patch: Partial<Omit<Settings, "updatedAt">> = {};
  if (body.checkinLocations !== undefined) {
    const locs = parseLocations(body.checkinLocations);
    if (!Array.isArray(locs)) return fail(c, "LOCATION_INVALID", locs.error);
    patch.checkinLocations = locs;
  }
  if (body.notifications !== undefined) {
    const n = parseNotifications(body.notifications, (await getSettings()).notifications);
    if ("error" in n) return fail(c, "NOTIFICATIONS_INVALID", n.error);
    patch.notifications = n;
  }
  let windowChanged = false;
  const LIST_ERROR = { checkinHelpers: "HELPERS_INVALID", organizers: "ORGANIZERS_INVALID", gameOrganizers: "GAME_ORGANIZERS_INVALID", scoreHelpers: "SCORE_HELPERS_INVALID", medicalStaff: "MEDICAL_INVALID", vestHelpers: "VEST_HELPERS_INVALID", photographers: "PHOTOGRAPHERS_INVALID" } as const;
  for (const key of ["checkinHelpers", "organizers", "gameOrganizers", "scoreHelpers", "medicalStaff", "vestHelpers", "photographers"] as const) {
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
  if (body.busReturnWindow !== undefined) {
    const w = parseWindow(body.busReturnWindow);
    if ("error" in w) return fail(c, "WINDOW_INVALID", w.error);
    patch.busReturnWindow = w;
    windowChanged = true;
  }
  if (body.staffAccessWindow !== undefined) {
    const w = parseWindow(body.staffAccessWindow);
    if ("error" in w) return fail(c, "WINDOW_INVALID", w.error);
    patch.staffAccessWindow = w;
    windowChanged = true;
  }
  if (body.parentAccessWindow !== undefined) {
    const w = parseWindow(body.parentAccessWindow);
    if ("error" in w) return fail(c, "WINDOW_INVALID", w.error);
    patch.parentAccessWindow = w;
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
  if (body.galleryPublished !== undefined) {
    if (typeof body.galleryPublished !== "boolean") return fail(c, "PUBLISHED_INVALID", "A publicação das fotos deve ser ligada ou desligada.");
    patch.galleryPublished = body.galleryPublished;
  }

  if (body.scoreDraft !== undefined) {
    if (typeof body.scoreDraft !== "boolean") return fail(c, "SCORE_DRAFT_INVALID", "O rascunho do placar deve ser ligado ou desligado.");
    patch.scoreDraft = body.scoreDraft;
  }
  if (body.wizardMode !== undefined) {
    if (typeof body.wizardMode !== "boolean") return fail(c, "WIZARD_MODE_INVALID", "O modo assistente deve ser ligado ou desligado.");
    const superPhone = config.superAdminPhone ? normalizeBrazilPhone(config.superAdminPhone) : null;
    const isSuper = !!superPhone && c.get("user").phone === superPhone;
    // only the deployment owner turns the lock ON; any admin may turn it OFF (finish / leave the wizard)
    if (body.wizardMode === true && !isSuper) {
      return c.json({ error: { code: "FORBIDDEN", message: "Só o administrador da implantação liga o assistente." } }, 403);
    }
    patch.wizardMode = body.wizardMode;
  }
  if (body.smsRedirect !== undefined) {
    const r = parseSmsRedirect(body.smsRedirect, (await getSettings()).smsRedirect);
    if ("error" in r) return fail(c, "SMS_REDIRECT_INVALID", r.error);
    patch.smsRedirect = r;
  }
  if (Object.keys(patch).length === 0) return fail(c, "NOTHING_TO_UPDATE", "Nada para atualizar.");

  const previous = await getSettings();
  const updated = await updateSettings(patch);
  void notifyAccessListChange(previous, updated); // fire-and-forget: the SMS never delays the write
  const scopeChanged = patch.organizers || patch.gameOrganizers || patch.scoreHelpers || patch.checkinHelpers || patch.busHelpers || patch.medicalStaff || patch.vestHelpers || patch.photographers || windowChanged || draftChanged;
  if (scopeChanged) {
    // Any access-list change may alter which records a phone is allowed to keep.
    // Re-send every scoped collection so gains and revocations happen live.
    publish("campers", "staff", "bedrooms", "roles", "events", "occurrences", "medications", "scores", "gallery");
    // someone may have just left every list while the team window is closed: log them out now
    if (!windowChanged) void evictStaffOutsideWindow().catch((err) => console.error("realtime: evict failed", err));
  }
  // Settings are shared application data too: every connected admin/team
  // client receives the canonical value through the WebSocket collection.
  publish("settings");
  // the date or the toggle changed: re-arm (a pending past instant with the toggle now on fires at once)
  if (reminderChanged || patch.notifications) scheduleCheckinReminder(updated.checkinReminder.at);
  // the album notice is a ONCE-PER-CAMP SMS: turning it back ON re-arms it for everybody
  if (patch.notifications?.photoPublishes && !previous.notifications.photoPublishes) {
    const [staff, parents] = await Promise.all([resetStaffPhotosNotice(), resetParentPhotosNotice()]);
    if (staff + parents > 0) console.log(`🧹 album notice re-armed: ${staff} staff, ${parents} parents`);
  }
  // a welcome toggle switched ON: whoever is inside their window and was never welcomed gets the SMS now
  if (patch.notifications?.enrolments && !previous.notifications.enrolments) void syncWelcomes();
  if (patch.notifications?.parentWelcome && !previous.notifications.parentWelcome) void syncParentWelcomes();
  // birthdays switched ON after 07:45 on a camp day: today's birthday kids' rooms are texted now
  if (patch.notifications?.birthdays && !previous.notifications.birthdays) void sendBirthdayNotices();
  if (windowChanged) {
    void rearmWindows();
    if (patch.staffAccessWindow) void syncWelcomes(); // the window may have just opened (start moved to the past)
    if (patch.parentAccessWindow) void syncParentWelcomes();
    // the admin may have closed the team's window right now: log those people out
    void evictStaffOutsideWindow().catch((err) => console.error("realtime: evict failed", err));
  }
  return c.json({ settings: await serializeSettingsForManager(updated, c.get("user").phone) });
});

/** GET /api/settings/welcome-preview — admin. How many people would get the welcome SMS RIGHT NOW if the toggle were on (never welcomed, inside their window, with a phone). */
settings.get("/welcome-preview", requireAdmin, async (c) => c.json(await welcomePreview()));

function sampleEmailList() {
  return sampleNotificationEmails().map(({ id, audience, title, subject }) => ({ id, audience, title, subject }));
}

function testSubject(audience: "parent" | "staff", subject: string): string {
  return `Teste - ${audience === "parent" ? "Pais" : "Equipe"} - ${subject}`;
}

/** GET /api/settings/sample-emails — admin. Catalog of every notification email, plus this admin's roster email. */
settings.get("/sample-emails", requireAdmin, async (c) => {
  const me = await findStaffByPhone(c.get("user").phone);
  return c.json({ emails: sampleEmailList(), adminEmail: me?.email ?? null, mailEnabled: mailEnabled() });
});

/**
 * POST /api/settings/sample-emails — admin. Sends the sample `id` (or every
 * sample when omitted) to `email` (subjects prefixed "Teste - Pais/Equipe - …").
 * When `save` is true, that address is written on the admin's roster record.
 */
settings.post("/sample-emails", requireAdmin, async (c) => {
  const body = await c.req.json<{ email?: string; save?: boolean; id?: string }>().catch(() => null);
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : null;
  if (!email) return fail(c, "EMAIL_INVALID", "Informe um e-mail válido.");
  const user = c.get("user");
  const me = await findStaffByPhone(user.phone);
  if (!me) return fail(c, "STAFF_NOT_FOUND", "Seu cadastro na equipe não foi encontrado.", 404);
  if (body?.save !== false && me.email !== email) {
    await updateStaff(me._id, { email });
    publish("staff");
  }
  const all = sampleNotificationEmails();
  const samples = typeof body?.id === "string" && body.id ? all.filter((s) => s.id === body.id) : all;
  if (typeof body?.id === "string" && body.id && samples.length === 0) return fail(c, "SAMPLE_NOT_FOUND", "Amostra não encontrada.", 404);
  let sent = 0;
  const failed: string[] = [];
  for (const sample of samples) {
    const res = await sendMail(email, testSubject(sample.audience, sample.subject), sample.html, sample.text);
    if (res.ok) sent++;
    else failed.push(sample.title);
  }
  console.log(`✉️  sample emails → ${email} (${sent}/${samples.length}) by ${user.name}`);
  return c.json({ sent, total: samples.length, failed, email, emails: sampleEmailList(), adminEmail: email, mailEnabled: mailEnabled() });
});

/** POST /api/settings/checkin/reset — admin only. Clears EVERY check-in (kids' church + both bus trips, team), the team vests and the audit log, so the process can be rehearsed. */
settings.post("/checkin/reset", requireManager, async (c) => {
  const [campers, staff, vests] = await Promise.all([resetCamperCheckins(), resetStaffCheckins(), resetStaffVests()]);
  await clearCheckinLog();
  console.log(`🧹 check-ins reset by ${c.get("user").name}: ${campers} campers, ${staff} staff, ${vests} vests`);
  publish("campers", "staff");
  return c.json({ campers, staff, vests });
});

/**
 * POST /api/settings/foreign-lookups/reset — admin / organizer. Zeroes every
 * staff member's out-of-scope emergency-QR counter (and unblocks anyone at ≥5).
 * The scan log itself is kept for audit.
 */
settings.post("/foreign-lookups/reset", requireManager, async (c) => {
  const staff = await resetForeignLookups();
  console.log(`🧹 foreign lookups reset by ${c.get("user").name}: ${staff} staff`);
  publish("staff", "settings");
  return c.json({ staff, settings: await serializeSettingsForManager(await getSettings(), c.get("user").phone) });
});

export default settings;
