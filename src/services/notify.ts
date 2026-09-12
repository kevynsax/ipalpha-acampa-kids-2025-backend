import { config } from "../config";
import { findBedroomById } from "../models/bedrooms";
import { countCampersPerBedroom } from "../models/campers";
import { findCategoryByKey } from "../models/categories";
import { listRoles } from "../models/schedule";
import { claimCheckinReminder, getSettings, staffAccessOpen } from "../models/settings";
import { claimStaffWelcome, listStaff } from "../models/staff";
import { listAdmins } from "../models/users";
import { STAFF_CATEGORY_KEYS } from "../types";
import type { CampEvent, Camper, InstructionDoc, Occurrence, PrepSection, ScheduleRole, Settings, Staff } from "../types";
import { formatBrazilPhone } from "../utils";
import { comteleEnabled, comteleSendSms } from "./comtele";
import { staffHasAccess } from "./scope";

/**
 * Texts (SMS via Comtele) the team members concerned by a change, saying
 * WHAT changed in one short line each, so most of the time the person does
 * not even need to open the app:
 *
 *   - a kid moved into / out of someone's bedroom (created / deleted there)
 *   - someone's role in an event changed (assigned, reassigned, removed,
 *     the event moved or was deleted)
 *   - a general Instruções / Preparação document changed, or the
 *     instructions / preparation text of one of the person's roles
 *   - the person's own room / team / vehicle changed
 *   - the person's church check-in was recorded (confirmation, sent at once)
 *   - an occurrence was registered (every ADMIN, sent at once)
 *   - the check-in reminder (WHOLE team, at the instant the admin picked)
 *
 * Each kind can be switched off by the admin (Settings → Notificações).
 * ORDINARY team members are only texted inside `settings.staffAccessWindow`
 * (Settings → Geral) — the same period in which they may use the app; people
 * on an admin list (organizers, helpers, medical, vest helpers, contacts) are always texted.
 * Checked at SEND time, so a queued text is dropped if the window closed.
 *
 * Sends are COALESCED: every change for the same person within a short window
 * becomes one SMS, so bulk edits on the admin screen don't flood anyone's
 * phone. The text is packed into ONE SMS (160 chars): as many change lines as
 * fit, then "+N mudanças" and the app link. Delivery is best-effort and never
 * blocks the write.
 */

export type NotifyKind = "bedroom" | "role" | "instructions" | "preparation" | "myRoom" | "myTeam" | "myBus";

interface Item {
  kind: NotifyKind;
  /** one short sentence, no trailing period, e.g. "Maria entrou no seu quarto 103" */
  text: string;
}

interface Pending {
  staff: Staff;
  items: Item[];
}

/** one SMS segment — longer texts are split and billed as several */
export const SMS_MAX = 160;

/** how long to wait for more changes to the same person before texting */
const COALESCE_MS = Number(process.env.NOTIFY_COALESCE_SECONDS ?? 20) * 1000;

const queue = new Map<string, Pending>();
let timer: ReturnType<typeof setTimeout> | null = null;

function enqueue(staff: Staff, kind: NotifyKind, text: string, settings: Settings): void {
  if (!staff.phone) return;
  if (!staffHasAccess(staff._id, settings)) return;
  const p = queue.get(staff._id) ?? { staff, items: [] };
  if (!p.items.some((i) => i.text === text)) p.items.push({ kind, text }); // same change twice (double save) → once
  queue.set(staff._id, p);
  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, COALESCE_MS);
  }
}

function first(name: string): string {
  return name.split(" ")[0] || name;
}

// ── text helpers ─────────────────────────────────────────────────────────────

/** "2026-09-12" → "sáb 12/09" */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const wd = new Intl.DateTimeFormat("pt-BR", { weekday: "short", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, m - 1, d)))
    .replace(".", "");
  return `${wd} ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
}

/** "sáb 12/09 14:00 Piscina" */
function eventLabel(e: CampEvent): string {
  return `${shortDate(e.date)} ${e.startTime} ${e.title}`;
}

/** "Monitor (Base 3)" */
function dutyLabel(roleId: string, detail: string, roleById: Map<string, ScheduleRole>): string {
  const name = roleById.get(roleId)?.name ?? "outra função";
  return detail ? `${name} (${detail})` : name;
}

/** the link the SMS points at — the bare word "app" when no APP_URL is configured */
function appLink(): string {
  return config.appUrl || "app";
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

async function bedroomName(id: string | null): Promise<string | null> {
  if (!id) return null;
  return (await findBedroomById(id))?.name ?? null;
}

async function optionLabel(key: string, id: string | null): Promise<string | null> {
  if (!id) return null;
  const cat = await findCategoryByKey(key);
  return cat?.options.find((o) => o.id === id)?.label ?? null;
}

/**
 * The SMS text — one line, packed into a single segment: as many change
 * lines as fit, then "+N mudanças" for the rest, and the app link.
 */
export function composeSms(p: Pending): string {
  const head = `${config.comtele.prefix}: ${first(p.staff.name)}, `;
  const texts = p.items.map((i) => i.text);

  const render = (shown: string[], rest: number): string => {
    const tail = rest > 0 ? ` +${rest} mudança${rest > 1 ? "s" : ""}. Veja em ${appLink()}` : `. ${appLink()}`;
    return `${head}${shown.join("; ")}${tail}`;
  };

  for (let n = texts.length; n >= 1; n--) {
    const msg = render(texts.slice(0, n), texts.length - n);
    if (msg.length <= SMS_MAX) return msg;
  }
  // even the first line alone overflows: clip it
  const fixed = render([""], texts.length - 1).length;
  return render([clip(texts[0], SMS_MAX - fixed)], texts.length - 1);
}

/** Actually texts one person (or prints it, without a Comtele key). */
async function deliver(to: { name: string; phone: string | null }, text: string, label: string): Promise<void> {
  if (!comteleEnabled()) {
    console.log(`\n📲 [NOTIFY · DEV MOCK] ${to.name} — ${formatBrazilPhone(to.phone!)}: ${text}\n`);
    return;
  }
  const res = await comteleSendSms(to.phone!, text);
  if (res.ok) console.log(`📲 [NOTIFY · SMS] ${to.name} (${label})`);
  else console.error(`[comtele] notify to ${to.name} failed:`, res.message);
}

async function flush(): Promise<void> {
  const batch = [...queue.values()];
  queue.clear();
  if (batch.length === 0) return;
  const settings = await getSettings().catch(() => null);
  for (const p of batch) {
    if (settings && !staffHasAccess(p.staff._id, settings)) continue; // window closed while coalescing
    await deliver(p.staff, composeSms(p), [...new Set(p.items.map((i) => i.kind))].join("+"));
  }
}

/** Sends whatever is queued right now (tests / graceful shutdown). */
export async function flushNotifications(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await flush();
}

// ── check-in confirmation ────────────────────────────────────────────────────────────

/**
 * The confirmation text — a receipt plus what the person needs next: their
 * room (and how many kids are in it) and their vehicle.
 */
export function composeCheckinSms(staff: Staff, ctx: { room?: string | null; kids?: number; bus?: string | null } = {}): string {
  const parts: string[] = [];
  if (ctx.room) parts.push(`Seu quarto: ${ctx.room}${ctx.kids !== undefined ? ` (${ctx.kids} crianças)` : ""}`);
  if (ctx.bus) parts.push(`Transporte: ${ctx.bus}`);
  const info = parts.length ? ` ${parts.join(". ")}.` : "";
  const msg = `${config.comtele.prefix}: ${first(staff.name)}, check-in feito!${info} Confira as crianças do seu quarto em ${appLink()}`;
  if (msg.length <= SMS_MAX) return msg;
  return `${config.comtele.prefix}: ${first(staff.name)}, check-in feito!${info} ${appLink()}`;
}

/**
 * Call right after a team member's check-in is recorded — by themselves
 * (self check-in) or by the admin roll call. Not coalesced: it is a receipt
 * for one action, so it goes out immediately.
 */
export async function notifyCheckin(staff: Staff): Promise<void> {
  try {
    if (!staff.phone) return;
    const settings = await getSettings();
    if (!settings.notifications.checkinConfirmation) return;
    if (!staffHasAccess(staff._id, settings)) return;
    const [room, bus, counts] = await Promise.all([
      settings.kidsRoomsDraft ? null : bedroomName(staff.bedroom),
      optionLabel(STAFF_CATEGORY_KEYS.transportation, staff.transportation),
      staff.bedroom && !settings.kidsRoomsDraft ? countCampersPerBedroom() : null,
    ]);
    const kids = counts && staff.bedroom ? (counts.get(staff.bedroom) ?? 0) : undefined;
    await deliver(staff, composeCheckinSms(staff, { room, kids, bus }), "checkin");
  } catch (err) {
    console.error("notify: check-in confirmation failed", err);
  }
}

// ── check-in reminder → whole team ───────────────────────────────────────────────────

/** "João, chegou a hora do seu check-in! Faça em <app>" */
export function composeCheckinReminderSms(staff: Staff): string {
  return `${config.comtele.prefix}: ${first(staff.name)}, chegou a hora do seu check-in! Ao chegar na igreja, faça o check-in em ${appLink()}`;
}

/**
 * Texts EVERY active team member with a phone reminding them to do their
 * check-in. Runs at `settings.checkinReminder.at` (timer in services/realtime.ts,
 * plus the hourly safety net and boot). Nothing goes out when:
 *   - the `checkinReminder` toggle is off,
 *   - no date is set, or the date is still in the future,
 *   - it already went out for that date (claimed atomically — restarts and
 *     double timers can't text twice; changing the date re-arms it).
 * Not coalesced and not gated by the team access window: the reminder IS the
 * call to show up.
 */
export async function sendCheckinReminder(): Promise<void> {
  try {
    const settings = await getSettings();
    const { at, sentAt } = settings.checkinReminder;
    if (!settings.notifications.checkinReminder || !at || sentAt || at.getTime() > Date.now()) return;
    if (!(await claimCheckinReminder(at))) return;
    const team = (await listStaff({ active: true })).filter((s) => s.phone && !s.checkin);
    console.log(`📲 check-in reminder scheduled for ${at.toISOString()} → texting ${team.length} team members`);
    for (const s of team) await deliver(s, composeCheckinReminderSms(s), "checkin-reminder");
  } catch (err) {
    console.error("notify: check-in reminder failed", err);
  }
}

// ── occurrence registered → admins ─────────────────────────────────────────────────────

/** "Maria e João" / "Maria, João +2" — first names of the people involved */
function peopleLabel(people: { name: string }[]): string {
  const names = people.map((p) => first(p.name));
  if (names.length <= 2) return names.join(" e ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

/**
 * The occurrence text — who registered it and who is involved, then the app
 * link. The description stays in the app (it may be long and sensitive).
 */
export function composeOccurrenceSms(adminName: string, o: Occurrence): string {
  const who = [o.campers.length ? `criança${o.campers.length > 1 ? "s" : ""} ${peopleLabel(o.campers)}` : "", o.staff.length ? `equipe ${peopleLabel(o.staff)}` : ""].filter(Boolean).join(" e ");
  const build = (w: string) => `${config.comtele.prefix}: ${first(adminName)}, nova ocorrência registrada por ${first(o.createdByName)}${w ? ` (${w})` : ""}. Veja em ${appLink()}`;
  const msg = build(who);
  return msg.length <= SMS_MAX ? msg : build("");
}

/**
 * Call right after an occurrence is inserted. Texts EVERY admin account
 * (except the one who registered it). Not coalesced: an occurrence is an
 * incident, so it goes out immediately. Admins are never gated by the team window.
 */
export async function notifyOccurrence(o: Occurrence): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notifications.occurrences) return;
    for (const admin of await listAdmins()) {
      if (!admin.phone || admin._id === o.createdByUserId) continue;
      await deliver(admin, composeOccurrenceSms(admin.name, o), "occurrence");
    }
  } catch (err) {
    console.error("notify: occurrence failed", err);
  }
}

// ── bedroom changes ─────────────────────────────────────────────────────────

/**
 * Call after a camper write with the record BEFORE and AFTER (null on create /
 * delete). Only the `bedroom` field matters here: the caretakers of the room
 * the kid left and of the room the kid entered are texted, with the kid's
 * name and the room's new head count.
 */
export async function notifyCamperChange(before: Camper | null, after: Camper | null): Promise<void> {
  try {
    const from = before?.bedroom ?? null;
    const to = after?.bedroom ?? null;
    if (from === to) return;
    const settings = await getSettings();
    if (!settings.notifications.bedroomChanges) return;
    if (settings.kidsRoomsDraft) return; // rooms still being drafted: caretakers can't see the kids anyway

    const kid = first((after ?? before)!.name);
    const [staff, counts, fromName, toName] = await Promise.all([listStaff({ active: true }), countCampersPerBedroom(), bedroomName(from), bedroomName(to)]);
    const heads = (id: string) => `agora ${counts.get(id) ?? 0} crianças`;
    for (const s of staff) {
      if (!s.bedroom) continue;
      if (s.bedroom === from) {
        const where = toName ? `foi para o quarto ${toName}` : "saiu do seu quarto";
        enqueue(s, "bedroom", `${kid} ${where} (${heads(from!)})`, settings);
      } else if (s.bedroom === to) {
        const where = fromName ? `veio do quarto ${fromName}` : "";
        enqueue(s, "bedroom", `${kid} entrou no seu quarto${where ? `, ${where}` : ""} (${heads(to!)})`, settings);
      }
    }
  } catch (err) {
    console.error("notify: camper change failed", err);
  }
}

// ── the person's own allocation (room / team / bus) ─────────────────────────────────────

/**
 * Call after a staff update with the record BEFORE and AFTER. Texts the person
 * themselves when their bedroom, team or vehicle changed, naming the new one.
 * Room changes are muted while the kids' rooms are still a draft (Settings → Geral).
 */
export async function notifyStaffChange(before: Staff, after: Staff): Promise<void> {
  try {
    if (!after.active || !after.phone) return;
    const settings = await getSettings();
    if (!settings.notifications.staffChanges) return;
    if (before.bedroom !== after.bedroom && !settings.kidsRoomsDraft) {
      const room = await bedroomName(after.bedroom);
      enqueue(after, "myRoom", room ? `seu quarto agora é o ${room}` : "você saiu do seu quarto", settings);
    }
    if (before.team !== after.team) {
      const team = await optionLabel(STAFF_CATEGORY_KEYS.team, after.team);
      enqueue(after, "myTeam", team ? `seu time agora é ${team}` : "você saiu do seu time", settings);
    }
    if (before.transportation !== after.transportation) {
      const bus = await optionLabel(STAFF_CATEGORY_KEYS.transportation, after.transportation);
      enqueue(after, "myBus", bus ? `seu transporte agora é ${bus}` : "você ficou sem transporte definido", settings);
    }
  } catch (err) {
    console.error("notify: staff change failed", err);
  }
}

// ── role (event function) changes ───────────────────────────────────────────

interface Duty {
  roleId: string;
  detail: string;
}

/** what each staff member does in the event: explicit assignment, else the "for everyone" role (active only) */
function dutiesOf(e: CampEvent | null, staff: Staff[], roleById: Map<string, ScheduleRole>): Map<string, Duty> {
  const out = new Map<string, Duty>();
  if (!e) return out;
  const everyone = e.roles.find((id) => roleById.get(id)?.forEveryone) ?? null;
  for (const s of staff) {
    const a = e.assignments.find((x) => x.staffId === s._id);
    if (a) out.set(s._id, { roleId: a.roleId, detail: a.detail });
    else if (everyone && s.active) out.set(s._id, { roleId: everyone, detail: "" });
  }
  return out;
}

/**
 * Call after an event write with the event BEFORE and AFTER (null on create /
 * delete). Diffs each person's duty and texts the ones whose duty changed —
 * or, when the event itself moved (date / time), everyone who has a duty in it.
 * The text names the event, when it is and what the person does there.
 */
export async function notifyEventChange(before: CampEvent | null, after: CampEvent | null): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notifications.roleChanges) return;

    const [staff, roles] = await Promise.all([listStaff(), listRoles()]);
    const roleById = new Map(roles.map((r) => [r._id, r]));
    const prev = dutiesOf(before, staff, roleById);
    const next = dutiesOf(after, staff, roleById);
    const moved = !!before && !!after && (before.date !== after.date || before.startTime !== after.startTime || before.endTime !== after.endTime);
    const duty = (d: Duty) => dutyLabel(d.roleId, d.detail, roleById);

    for (const s of staff) {
      const a = prev.get(s._id);
      const b = next.get(s._id);
      let text: string | null = null;
      if (b && !a) text = `${eventLabel(after!)}: você é ${duty(b)}`;
      else if (a && !b && !after) text = `${eventLabel(before!)} foi cancelado`;
      else if (a && !b) text = `${eventLabel(after ?? before!)}: você saiu da escala`;
      else if (a && b && (a.roleId !== b.roleId || a.detail !== b.detail)) text = `${eventLabel(after!)}: agora você é ${duty(b)}`;
      else if (b && moved) text = `${before!.title} mudou para ${shortDate(after!.date)} ${after!.startTime}: você é ${duty(b)}`;
      if (text) enqueue(s, "role", text, settings);
    }
  } catch (err) {
    console.error("notify: event change failed", err);
  }
}

/**
 * A role was edited → everyone who does it in some event (explicitly, or via
 * "for everyone"). Which switch applies depends on WHAT changed:
 *   name / forEveryone → roleChanges, instructions / preparation → contentChanges.
 */
export async function notifyRoleEdited(roleBefore: ScheduleRole, roleAfter: ScheduleRole, events: CampEvent[]): Promise<void> {
  try {
    const settings = await getSettings();
    const n = settings.notifications;
    const items: Item[] = [];
    if (n.roleChanges && roleBefore.name !== roleAfter.name) items.push({ kind: "role", text: `sua função "${roleBefore.name}" agora se chama "${roleAfter.name}"` });
    if (n.roleChanges && roleBefore.forEveryone !== roleAfter.forEveryone) {
      items.push({ kind: "role", text: roleAfter.forEveryone ? `a função ${roleAfter.name} agora vale para todos: confira sua escala` : `a função ${roleAfter.name} não vale mais para todos: confira sua escala` });
    }
    if (n.contentChanges && roleBefore.instructions !== roleAfter.instructions) items.push({ kind: "instructions", text: `instruções da função ${roleAfter.name} atualizadas` });
    if (n.contentChanges && roleBefore.preparation !== roleAfter.preparation) items.push({ kind: "preparation", text: `preparação da função ${roleAfter.name} atualizada` });
    if (items.length === 0) return;

    const staff = await listStaff({ active: true });
    const using = events.filter((e) => e.roles.includes(roleAfter._id));
    for (const s of staff) {
      const concerned = using.some((e) => {
        const a = e.assignments.find((x) => x.staffId === s._id);
        return a ? a.roleId === roleAfter._id : roleAfter.forEveryone || roleBefore.forEveryone;
      });
      if (concerned) for (const i of items) enqueue(s, i.kind, i.text, settings);
    }
  } catch (err) {
    console.error("notify: role edit failed", err);
  }
}

// ── general documents (Instruções / Preparação) ─────────────────────────────

async function notifyEveryone(kind: NotifyKind, text: string, enabled: (n: Settings["notifications"]) => boolean): Promise<void> {
  const settings = await getSettings();
  if (!enabled(settings.notifications)) return;
  for (const s of await listStaff({ active: true })) enqueue(s, kind, text, settings);
}

/** A general instructions document was created or its title / content changed → the whole active team. */
export async function notifyInstructionChange(before: InstructionDoc | null, after: InstructionDoc): Promise<void> {
  try {
    if (before && before.title === after.title && before.content === after.content) return; // reorder / emoji only
    const text = !before ? `novas instruções: "${after.title}"` : before.title !== after.title ? `instruções "${before.title}" viraram "${after.title}"` : `instruções "${after.title}" atualizadas`;
    await notifyEveryone("instructions", text, (n) => n.contentChanges);
  } catch (err) {
    console.error("notify: instruction change failed", err);
  }
}

/** A Preparação section was created or its title / content changed → the whole active team. */
export async function notifyPreparationChange(before: PrepSection | null, after: PrepSection): Promise<void> {
  try {
    if (before && before.title === after.title && before.content === after.content) return;
    const text = !before ? `nova preparação: "${after.title}"` : before.title !== after.title ? `preparação "${before.title}" virou "${after.title}"` : `preparação "${after.title}" atualizada`;
    await notifyEveryone("preparation", text, (n) => n.contentChanges);
  } catch (err) {
    console.error("notify: preparation change failed", err);
  }
}

// ── enrolment: added to the team / to an admin list ─────────────────────────

/**
 * The enrolment text — says WHICH role the person got (none = the plain
 * welcome, when the team window opens) and ALWAYS carries the app link (with
 * the phone they must log in with), since this is how they find the app.
 */
export function composeEnrolSms(staff: Staff, roles: string[]): string {
  const name = first(staff.name);
  const list = roles.length > 1 ? `${roles.slice(0, -1).join(", ")} e ${roles[roles.length - 1]}` : roles[0];
  const what = roles.length ? `você agora é ${list}` : "o app do acampamento está liberado para você";
  const phone = staff.phone ? ` com o celular ${formatBrazilPhone(staff.phone)}` : "";
  const build = (w: string, p: string) => `${config.comtele.prefix}: ${name}, ${w}!${p ? ` Entre${p}` : " Entre"} em ${appLink()}`;
  for (const msg of [build(what, phone), build(what, ""), build(`você recebeu ${roles.length} novas funções no acampamento`, "")]) {
    if (msg.length <= SMS_MAX) return msg;
  }
  return build(clip(what, 60), "");
}

/**
 * Sends the welcome SMS (app link) to one person — ONCE, ever. The claim is
 * atomic in the database, so restarts, double saves or two triggers firing
 * together can't text twice. Returns true when it went out.
 */
async function sendWelcome(staff: Staff, roles: string[] = []): Promise<boolean> {
  if (!staff.phone || !staff.active) return false;
  if (!(await claimStaffWelcome(staff._id))) return false;
  await deliver(staff, composeEnrolSms(staff, roles), roles.length ? "enrol" : "welcome");
  return true;
}

/**
 * THE welcome scheduler. Whoever may use the app right now and has never
 * been welcomed gets the welcome SMS. Call it whenever that set may have
 * grown: boot, the team window (re)opening — via the edge timer in
 * services/realtime.ts — the window being edited, a member created or
 * reactivated. Each person is welcomed at most once (see sendWelcome), no
 * matter how many times the admin moves the window start.
 */
export async function syncWelcomes(): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notifications.enrolments) return;
    if (!staffAccessOpen(settings.staffAccessWindow)) return; // people on admin lists were welcomed when listed
    for (const s of await listStaff({ active: true })) {
      if (s.welcomeSentAt || !s.phone) continue;
      await sendWelcome(s);
    }
  } catch (err) {
    console.error("notify: welcome sync failed", err);
  }
}

/** every admin-list membership of one person, as the person reads it */
async function listRolesOf(id: string, s: Settings): Promise<string[]> {
  const out: string[] = [];
  if (s.organizers.staffIds.includes(id)) out.push("organizador da programação");
  if (s.checkinHelpers.staffIds.includes(id)) out.push("ajudante do check-in");
  const bus = s.busHelpers.helpers.find((h) => h.staffId === id);
  if (bus) {
    const v = await optionLabel(STAFF_CATEGORY_KEYS.transportation, bus.vehicleId);
    out.push(v ? `ajudante do ${v}` : "ajudante do ônibus");
  }
  if (s.medicalStaff.staffIds.includes(id)) out.push("equipe médica");
  if (s.vestHelpers.staffIds.includes(id)) out.push("responsável pelos coletes (entrega e devolução)");
  for (const p of s.parentContacts) if (p.staffId === id) out.push(`contato dos pais (${p.title})`);
  return out;
}

/**
 * Call after Settings are written with the document BEFORE and AFTER. Texts
 * each person who was ADDED to an admin list (organizers, check-in / bus
 * helpers, medical team, vest helpers, parent contacts) — one SMS per person, naming every
 * list they entered. Being on a list is what lets the person use the app
 * outside the team window, so this is NOT gated by the window. Nobody is
 * texted when they LEAVE a list (or the team): no need to rub it in.
 */
export async function notifyAccessListChange(before: Settings, after: Settings): Promise<void> {
  try {
    if (!after.notifications.enrolments) return;
    const ids = new Set<string>();
    for (const s of [before, after]) {
      for (const id of [...s.organizers.staffIds, ...s.checkinHelpers.staffIds, ...s.medicalStaff.staffIds, ...s.vestHelpers.staffIds]) ids.add(id);
      for (const h of s.busHelpers.helpers) ids.add(h.staffId);
      for (const p of s.parentContacts) ids.add(p.staffId);
    }
    if (ids.size === 0) return;

    const staff = await listStaff({ active: true });
    for (const s of staff) {
      if (!ids.has(s._id) || !s.phone) continue;
      const [was, now] = await Promise.all([listRolesOf(s._id, before), listRolesOf(s._id, after)]);
      const gained = now.filter((r) => !was.includes(r));
      // a role text carries the link too, so it doubles as the welcome; someone already welcomed still hears about the new role
      if (gained.length && !(await sendWelcome(s, gained))) await deliver(s, composeEnrolSms(s, gained), "enrol");
    }
  } catch (err) {
    console.error("notify: access list change failed", err);
  }
}
