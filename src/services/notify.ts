import { config } from "../config";
import { findBedroomById } from "../models/bedrooms";
import { claimBirthdayNotice, countCampersPerBedroom, listCampers } from "../models/campers";
import { findTransportById } from "../models/transports";
import { transportLabel as transportLabelOf } from "../routes/transports";
import { listRoles } from "../models/schedule";
import { claimCheckinReminder, getSettings, staffAccessOpen } from "../models/settings";
import { claimStaffPhotosNotice, claimStaffWelcome, findStaffById, listStaff } from "../models/staff";
import { findTeamById, listTeams } from "../models/teams";
import { claimParentPhotosNotice, claimParentWelcome, listAdmins, listParents } from "../models/users";
import { PARENT_FIELD_LABEL, PREP_AUDIENCES } from "../types";
import type { CampEvent, Camper, CamperChangeLog, DocAudience, InstructionDoc, Occurrence, PrepAudience, PrepSection, ScheduleRole, Settings, Staff, Team } from "../types";
import { formatBrazilPhone, saoPauloWallClock, saoPauloWallClockToIso, todayInSaoPaulo } from "../utils";
import { birthdayDuringCamp, campPeriod } from "./camp";
import { comteleEnabled, comteleSendSms, resolveSmsTarget, type SmsAudience } from "./comtele";
import { staffHasAccess } from "./scope";
import { assignmentDetail, teamMap } from "./schedule";

/**
 * Texts (SMS via Comtele) the team members concerned by a change, saying
 * WHAT changed in one short line each, so most of the time the person does
 * not even need to open the app:
 *
 *   - a kid was put under / taken from someone's care (caretakers only —
 *     helpers are never texted about kids)
 *   - someone's role in an event changed (assigned, reassigned, removed,
 *     the event moved or was deleted)
 *   - a general Instruções / Preparação document changed, or the
 *     instructions / preparation text of one of the person's roles
 *   - (PARENTS) a Preparação section posted to them changed — only inside
 *     `settings.parentAccessWindow`
 *   - the person's own room / room role (responsável ↔ auxiliar) / team / vehicle changed
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

export type NotifyKind = "bedroom" | "role" | "instructions" | "preparation" | "myRoom" | "myRoomRole" | "myTeam" | "myBus" | "photos";

interface Item {
  kind: NotifyKind;
  /** one short sentence, no trailing period, e.g. "Maria entrou no seu quarto 103" */
  text: string;
}

/** whoever gets the coalesced text: a team member (gated by the team window) or a parent (gated by the parents' window) */
interface Pending {
  to: { name: string; phone: string | null };
  gate: { kind: "staff"; staffId: string } | { kind: "parent" };
  items: Item[];
}

/** one SMS segment — longer texts are split and billed as several */
export const SMS_MAX = 160;

/** how long to wait for more changes to the same person before texting */
const COALESCE_MS = Number(process.env.NOTIFY_COALESCE_SECONDS ?? 20) * 1000;

const queue = new Map<string, Pending>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** may this queued person still be texted right now? (checked when queued AND when sent) */
function gateOpen(gate: Pending["gate"], settings: Settings): boolean {
  return gate.kind === "staff" ? staffHasAccess(gate.staffId, settings) : staffAccessOpen(settings.parentAccessWindow);
}

function push(key: string, to: Pending["to"], gate: Pending["gate"], kind: NotifyKind, text: string, settings: Settings): void {
  if (!to.phone) return;
  if (!gateOpen(gate, settings)) return;
  const p = queue.get(key) ?? { to, gate, items: [] };
  if (!p.items.some((i) => i.text === text)) p.items.push({ kind, text }); // same change twice (double save) → once
  queue.set(key, p);
  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, COALESCE_MS);
  }
}

function enqueue(staff: Staff, kind: NotifyKind, text: string, settings: Settings): void {
  push(`staff:${staff._id}`, staff, { kind: "staff", staffId: staff._id }, kind, text, settings);
}

/** a PARENT (users doc with the parent role) — only inside the parents' access window */
function enqueueParent(parent: { _id: string; name: string; phone: string | null }, kind: NotifyKind, text: string, settings: Settings): void {
  push(`parent:${parent._id}`, parent, { kind: "parent" }, kind, text, settings);
}

function first(name: string): string {
  return name.split(" ")[0] || name;
}

// ── text helpers ─────────────────────────────────────────────────────────────

/** "2026-09-12" → "sáb 12/09" — same voice as frontend speakDaySlash */
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

async function transportLabel(id: string | null): Promise<string | null> {
  if (!id) return null;
  const t = await findTransportById(id);
  return t ? transportLabelOf(t) : null;
}

/**
 * The SMS text — one line, packed into a single segment: as many change
 * lines as fit, then "+N mudanças" for the rest, and the app link.
 */
export function composeSms(p: Pick<Pending, "to" | "items">): string {
  const head = `${config.comtele.prefix}: ${first(p.to.name)}, `;
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

/**
 * Actually texts one person (or prints it, without a Comtele key). While the
 * SMS redirect (Settings → Testes) is on, the text goes to the admin's test
 * phone for `audience` instead — or nowhere, when that phone is unset.
 */
async function deliver(to: { name: string; phone: string | null }, text: string, label: string, audience: SmsAudience = "staff"): Promise<void> {
  const target = await resolveSmsTarget(to.phone!, audience);
  if (!target) {
    console.log(`📲 [NOTIFY · REDIRECT] ${to.name} (${label}) dropped — no test phone for ${audience}`);
    return;
  }
  const tag = target.redirected ? ` → redirect ${formatBrazilPhone(target.phone)}` : "";
  if (!comteleEnabled()) {
    console.log(`\n📲 [NOTIFY · DEV MOCK] ${to.name} — ${formatBrazilPhone(to.phone!)}${tag}: ${text}\n`);
    return;
  }
  const res = await comteleSendSms(target.phone, text);
  if (res.ok) console.log(`📲 [NOTIFY · SMS] ${to.name} (${label})${tag}`);
  else console.error(`[comtele] notify to ${to.name} failed:`, res.message);
}

async function flush(): Promise<void> {
  const batch = [...queue.values()];
  queue.clear();
  if (batch.length === 0) return;
  const settings = await getSettings().catch(() => null);
  for (const p of batch) {
    if (settings && !gateOpen(p.gate, settings)) continue; // window closed while coalescing
    await deliver(p.to, composeSms(p), [...new Set(p.items.map((i) => i.kind))].join("+"), p.gate.kind);
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
      transportLabel(staff.transportation),
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

// ── a kid's birthday on a camp day → the whole team of the room ─────────────────────────────

/** São Paulo wall-clock at which the birthday SMS goes out */
export const BIRTHDAY_SMS_TIME = "07:45";

/** "João, hoje é aniversário da Ana (8 anos), do quarto 103! 🎂 Vamos fazer o dia dela especial." */
export function composeBirthdaySms(toName: string, kid: Pick<Camper, "name" | "sex" | "birthDate">, room: string | null, day: string): string {
  const age = kid.birthDate ? Number(day.slice(0, 4)) - Number(kid.birthDate.slice(0, 4)) : null;
  const of = kid.sex === "F" ? "da" : "do";
  const pron = kid.sex === "F" ? "dela" : "dele";
  const build = (withAge: boolean) =>
    `${config.comtele.prefix}: ${first(toName)}, hoje é aniversário ${of} ${first(kid.name)}${withAge && age ? ` (${age} anos)` : ""}${room ? `, do quarto ${room}` : ""}! 🎂 Vamos fazer o dia ${pron} especial.`;
  const msg = build(true);
  return msg.length <= SMS_MAX ? msg : build(false);
}

/**
 * The instant (real) at which today's birthday SMS is due: BIRTHDAY_SMS_TIME
 * São Paulo on `day`.
 */
export function birthdaySmsDue(day: string): Date {
  return new Date(saoPauloWallClockToIso(saoPauloWallClock(day, BIRTHDAY_SMS_TIME)));
}

/**
 * Texts EVERY active team member sleeping in the room of a kid whose birthday
 * is TODAY (a camp day), from 07:45 São Paulo on. Runs from the daily timer
 * (services/realtime.ts), the hourly safety net and boot. Nothing goes out when:
 *   - the `birthdays` toggle is off, or the rooms are still a draft,
 *   - today is not a camp day, or it is before 07:45,
 *   - it already went out for that kid on that day (claimed atomically).
 * Not coalesced; the room staff is gated by the team access window like every
 * other text.
 */
export async function sendBirthdayNotices(now = new Date()): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notifications.birthdays || settings.kidsRoomsDraft) return;
    const period = await campPeriod();
    const today = todayInSaoPaulo(now);
    if (!period.from || !period.until || today < period.from || today > period.until) return;
    if (now < birthdaySmsDue(today)) return;
    const kids = (await listCampers()).filter((k) => k.bedroom && birthdayDuringCamp(k.birthDate, period) === today);
    if (kids.length === 0) return;
    const staff = (await listStaff({ active: true })).filter((s) => s.phone && s.bedroom);
    for (const kid of kids) {
      if (!(await claimBirthdayNotice(kid._id, today))) continue;
      const room = await bedroomName(kid.bedroom);
      const team = staff.filter((s) => s.bedroom === kid.bedroom && staffHasAccess(s._id, settings));
      console.log(`🎂 birthday of ${kid.name} today → texting ${team.length} team members of room ${room ?? kid.bedroom}`);
      for (const s of team) await deliver(s, composeBirthdaySms(s.name, kid, room, today), "birthday");
    }
  } catch (err) {
    console.error("notify: birthday notices failed", err);
  }
}

// ── a parent edited their kid's "Pontos de atenção" ───────────────────────────────────

/**
 * The parent-edit text — who edited what on which kid, then the app link.
 * The values stay in the app (they may be long and sensitive).
 */
export function composeParentEditSms(toName: string, kid: Camper, entry: Pick<CamperChangeLog, "byName" | "medical" | "changes">): string {
  const fields = [...new Set(entry.changes.map((x) => PARENT_FIELD_LABEL[x.field]))];
  const what = entry.medical ? "dados médicos" : "observações";
  const build = (list: string) => `${config.comtele.prefix}: ${first(toName)}, ${first(entry.byName)} alterou ${what} de ${first(kid.name)}${list ? ` (${list})` : ""}. Veja em ${appLink()}`;
  const msg = build(fields.join(", "));
  return msg.length <= SMS_MAX ? msg : build("");
}

/**
 * Call right after a parent's edit is saved. MEDICAL fields changed → the
 * medical team, every admin and the kid's caretaker; only the observations
 * changed → the caretaker alone. Not coalesced: it is about ONE kid and the
 * team may need to act before the camp. The caretaker is gated by the team
 * access window like every other text (people on admin lists never are).
 */
export async function notifyParentEdit(kid: Camper, entry: Pick<CamperChangeLog, "byName" | "medical" | "changes">): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notifications.parentEdits) return;
    const sent = new Set<string>();
    const send = async (to: { _id: string; name: string; phone: string | null }, label: string) => {
      if (!to.phone || sent.has(to.phone)) return;
      sent.add(to.phone);
      await deliver(to, composeParentEditSms(to.name, kid, entry), label);
    };
    const caretaker = kid.caretakerId ? await findStaffById(kid.caretakerId) : null;
    if (caretaker?.active && staffHasAccess(caretaker._id, settings)) await send(caretaker, "parent-edit");
    if (!entry.medical) return;
    const staff = await listStaff({ active: true });
    for (const s of staff) if (settings.medicalStaff.staffIds.includes(s._id)) await send(s, "parent-edit-medical");
    for (const admin of await listAdmins()) await send(admin, "parent-edit-admin");
  } catch (err) {
    console.error("notify: parent edit failed", err);
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

/**
 * SMS when a team member has scanned ≥3 kids OUTSIDE their normal scope
 * (emergency QR lookup). Always sent — not gated by the occurrences toggle
 * (this is a security alert, not an occurrence). Once per streak until the
 * admin zeroes the counter in Settings → Geral.
 */
export function composeForeignLookupSms(adminName: string, staffName: string, count: number, kidNames: string[]): string {
  const kids = kidNames.slice(0, 3).map(first).join(", ");
  const extra = kidNames.length > 3 ? ` +${kidNames.length - 3}` : "";
  const build = (list: string) =>
    `${config.comtele.prefix}: ${first(adminName)}, ${first(staffName)} leu ${count} criança${count === 1 ? "" : "s"} fora do escopo${list ? ` (${list}${extra})` : ""}. Veja em ${appLink()}`;
  const msg = build(kids);
  return msg.length <= SMS_MAX ? msg : build("");
}

export async function notifyForeignLookupAlert(staff: Pick<Staff, "_id" | "name">, count: number, kidNames: string[]): Promise<void> {
  try {
    for (const admin of await listAdmins()) {
      if (!admin.phone) continue;
      await deliver(admin, composeForeignLookupSms(admin.name, staff.name, count, kidNames), "foreign-lookup");
    }
  } catch (err) {
    console.error("notify: foreign-lookup alert failed", err);
  }
}

// ── caretaker changes ─────────────────────────────────────────────────────

async function countKidsOf(caretakerId: string): Promise<number> {
  const { listCampers } = await import("../models/campers");
  return (await listCampers({ caretakerId })).length;
}

/**
 * Call after a camper write with the record BEFORE and AFTER (null on create /
 * delete). Only `caretakerId` matters: the caretaker who LOST the kid and the
 * one who RECEIVED it are texted. Helpers and the other caretakers of the
 * room are never texted — they see it in the app.
 */
export async function notifyCamperChange(before: Camper | null, after: Camper | null): Promise<void> {
  try {
    const from = before?.caretakerId ?? null;
    const to = after?.caretakerId ?? null;
    if (from === to) return;
    const settings = await getSettings();
    if (!settings.notifications.bedroomChanges) return;
    if (settings.kidsRoomsDraft) return; // rooms still being drafted: caretakers can't see the kids anyway

    const kid = (after ?? before)!;
    const [lost, got] = await Promise.all([from ? findStaffById(from) : null, to ? findStaffById(to) : null]);
    if (lost?.active) enqueue(lost, "bedroom", `${first(kid.name)} não está mais sob seus cuidados${got ? ` (agora com ${first(got.name)})` : ""}`, settings);
    if (got?.active && after) {
      const [room, n] = await Promise.all([bedroomName(after.bedroom), countKidsOf(got._id)]);
      enqueue(got, "bedroom", `${first(after.name)}${room ? ` (quarto ${room})` : ""} passou a ser sua responsabilidade (agora ${n} criança${n === 1 ? "" : "s"} com você)`, settings);
    }
  } catch (err) {
    console.error("notify: camper change failed", err);
  }
}

/**
 * Several kids changed hands at once (a caretaker moved rooms — see
 * POST /api/staff/:id/move). One line for the caretaker who lost them and one
 * for the one who received them (`to` null = the kids became orphans).
 */
export async function notifyCaretakerChange(kids: Camper[], from: Staff, to: Staff | null): Promise<void> {
  try {
    if (kids.length === 0) return;
    const settings = await getSettings();
    if (!settings.notifications.bedroomChanges || settings.kidsRoomsDraft) return;
    const names = peopleLabel(kids);
    const n = kids.length;
    if (from.active) enqueue(from, "bedroom", `${names} não ${n === 1 ? "está" : "estão"} mais sob seus cuidados${to ? ` (agora com ${first(to.name)})` : ""}`, settings);
    if (to?.active) {
      const room = await bedroomName(kids[0].bedroom);
      enqueue(to, "bedroom", `${names} ${n === 1 ? "passou" : "passaram"} a ser sua responsabilidade${room ? ` (quarto ${room})` : ""}`, settings);
    }
  } catch (err) {
    console.error("notify: caretaker change failed", err);
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
    if (before.roomRole !== after.roomRole) {
      const text = after.roomRole === "caretaker" ? "agora você é LÍDER de crianças no seu quarto (veja quais no app)" : "agora você é AUXILIAR no seu quarto (sem crianças próprias)";
      enqueue(after, "myRoomRole", text, settings);
    }
    if (before.team !== after.team) {
      const team = after.team ? (await findTeamById(after.team))?.name ?? null : null;
      enqueue(after, "myTeam", team ? `seu time agora é ${team}` : "você saiu do seu time", settings);
    }
    if (before.transportation !== after.transportation) {
      const bus = await transportLabel(after.transportation);
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

/**
 * What each staff member does in the event: explicit assignment, else the
 * "for everyone" role (active only). A role whose detail is the person's team
 * takes its label from the staff record, so the text says the team.
 */
function dutiesOf(e: CampEvent | null, staff: Staff[], roleById: Map<string, ScheduleRole>, teamById: Map<string, Team>): Map<string, Duty> {
  const out = new Map<string, Duty>();
  if (!e) return out;
  const everyone = e.roles.find((id) => roleById.get(id)?.forEveryone) ?? null;
  for (const s of staff) {
    const a = e.assignments.find((x) => x.staffId === s._id);
    if (a) out.set(s._id, { roleId: a.roleId, detail: assignmentDetail(roleById.get(a.roleId), a, s, teamById).detail });
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

    const [staff, roles, teams] = await Promise.all([listStaff(), listRoles(), listTeams()]);
    const roleById = new Map(roles.map((r) => [r._id, r]));
    const teamById = teamMap(teams);
    const prev = dutiesOf(before, staff, roleById, teamById);
    const next = dutiesOf(after, staff, roleById, teamById);
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

/** the whole active team, or only the caretakers / helpers when the document has a narrower audience */
async function notifyEveryone(kind: NotifyKind, text: string, enabled: (n: Settings["notifications"]) => boolean, audience: DocAudience = "all"): Promise<void> {
  const settings = await getSettings();
  if (!enabled(settings.notifications)) return;
  for (const s of await listStaff({ active: true })) if (audience === "all" || s.roomRole === audience) enqueue(s, kind, text, settings);
}

/** A general instructions document was created or its title / content changed → the whole active team. */
export async function notifyInstructionChange(before: InstructionDoc | null, after: InstructionDoc): Promise<void> {
  try {
    if (before && before.title === after.title && before.content === after.content) return; // reorder / emoji only
    const text = !before ? `novas instruções: "${after.title}"` : before.title !== after.title ? `instruções "${before.title}" viraram "${after.title}"` : `instruções "${after.title}" atualizadas`;
    await notifyEveryone("instructions", text, (n) => n.contentChanges, after.audience);
  } catch (err) {
    console.error("notify: instruction change failed", err);
  }
}

/**
 * A Preparação section was created, its title / content changed, or it was
 * posted to a new group. The team members in its audiences are texted
 * (`contentChanges`); when it is posted to the PARENTS every parent with a
 * phone is texted too (`parentContentChanges`) — only while the parents'
 * access window is open (checked at send time, like the team's window).
 * Somebody who just LOST the section (audience removed) is not texted.
 */
export async function notifyPreparationChange(before: PrepSection | null, after: PrepSection): Promise<void> {
  try {
    const changed = !before || before.title !== after.title || before.content !== after.content;
    const gained = (a: PrepAudience) => after.audiences.includes(a) && (!before || !before.audiences.includes(a));
    const isNew = (a: PrepAudience) => !before || gained(a);
    const textFor = (a: PrepAudience) => (isNew(a) ? `nova preparação: "${after.title}"` : before!.title !== after.title ? `preparação "${before!.title}" virou "${after.title}"` : `preparação "${after.title}" atualizada`);
    const concerned = (a: PrepAudience) => after.audiences.includes(a) && (changed || gained(a));
    if (!PREP_AUDIENCES.some(concerned)) return;

    const settings = await getSettings();
    const n = settings.notifications;
    if (n.contentChanges && (concerned("caretaker") || concerned("helper"))) {
      for (const s of await listStaff({ active: true })) if (concerned(s.roomRole)) enqueue(s, "preparation", textFor(s.roomRole), settings);
    }
    if (n.parentContentChanges && concerned("parent")) {
      const text = textFor("parent");
      for (const p of await listParents()) enqueueParent(p, "preparation", text, settings);
    }
  } catch (err) {
    console.error("notify: preparation change failed", err);
  }
}

/**
 * The photographer published photos in the album (Fotos tab). Everyone is
 * nudged ONCE for the whole camp: the whole active TEAM (each inside their
 * access window) and every PARENT with a phone (inside the parents' window).
 * The stamp lives on the person (`photosSmsSentAt`), so publishing more
 * batches later — or hiding and publishing again — never texts them twice;
 * whoever was outside their window at the time is still eligible later.
 * Nothing goes out when the photos are hidden.
 */
export async function notifyPhotosPublished(count: number): Promise<void> {
  try {
    if (count <= 0) return;
    const settings = await getSettings();
    if (!settings.notifications.photoPublishes) return;
    const text = "as fotos do acampamento j\u00e1 est\u00e3o no app \u{1F4F7}";
    for (const s of await listStaff({ active: true })) {
      if (!s.phone || !staffHasAccess(s._id, settings)) continue; // claim only for someone who will really be texted
      if (await claimStaffPhotosNotice(s._id)) enqueue(s, "photos", text, settings);
    }
    for (const p of await listParents()) {
      if (!p.phone || !staffAccessOpen(settings.parentAccessWindow)) continue;
      if (await claimParentPhotosNotice(p._id)) enqueueParent(p, "photos", text, settings);
    }
  } catch (err) {
    console.error("notify: photos published failed", err);
  }
}

// ── parents: the kid boarded the bus ─────────────────────────────────────────

/**
 * "Maria, a Ana está a caminho de um fim de semana incrível para aprender
 * sobre Jesus! Aproveite o fim de semana livre e fique tranquila: vamos
 * cuidar muito bem dela." — gendered by the kid's `sex` ("dele" / "dela").
 * Exported so the admin panel shows the exact text.
 */
export function composeBusCheckinSms(kid: Pick<Camper, "name" | "sex" | "guardianName">): string {
  const article = kid.sex === "F" ? "a" : "o";
  const pron = kid.sex === "F" ? "dela" : "dele";
  const to = first(kid.guardianName || "");
  const build = (greet: string) => `${config.comtele.prefix}: ${greet}${article} ${first(kid.name)} está a caminho de um fim de semana incrível para aprender sobre Jesus! Aproveite o fim de semana livre: vamos cuidar muito bem ${pron}.`;
  const msg = build(to ? `${to}, ` : "");
  return msg.length <= SMS_MAX ? msg : build("");
}

/**
 * Call right after a kid's BUS check-in is recorded. Texts the guardian
 * (`Camper.guardianPhone`). Not coalesced; undoing a check-in sends nothing.
 * Parents are never texted about anything else (rooms, roles…).
 */
export async function notifyBusCheckin(kid: Camper): Promise<void> {
  try {
    if (!kid.guardianPhone) return;
    const settings = await getSettings();
    if (!settings.notifications.busCheckin) return;
    await deliver({ name: kid.guardianName || `responsável de ${first(kid.name)}`, phone: kid.guardianPhone }, composeBusCheckinSms(kid), "bus-checkin", "parent");
  } catch (err) {
    console.error("notify: bus check-in failed", err);
  }
}

// ── parents: welcome (app link) ──────────────────────────────────────────────

/** "Maria, a Ana está inscrita no Acampa Kids! Acompanhe tudo pelo app. Entre com o celular (11) 9… em <app>" */
export function composeParentWelcomeSms(parent: { name: string; phone: string }, kids: Pick<Camper, "name" | "sex">[]): string {
  const names = kids.map((k) => first(k.name));
  const who =
    kids.length === 0
      ? "sua criança está inscrita"
      : kids.length === 1
        ? `${kids[0].sex === "F" ? "a" : "o"} ${names[0]} está inscrit${kids[0].sex === "F" ? "a" : "o"}`
        : `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]} estão inscrit${kids.every((k) => k.sex === "F") ? "as" : "os"}`;
  const build = (w: string, p: string) => `${config.comtele.prefix}: ${first(parent.name)}, ${w} no Acampa Kids! Acompanhe tudo pelo app.${p ? ` Entre com o celular ${p}` : " Entre"} em ${appLink()}`;
  for (const msg of [build(who, formatBrazilPhone(parent.phone)), build(who, ""), build("sua criança está inscrita", "")]) if (msg.length <= SMS_MAX) return msg;
  return build("sua criança está inscrita", "");
}

/** the parents who would be welcomed right now: parent role, a phone, never welcomed (the window is checked by the caller) */
async function pendingParentWelcomes(): Promise<{ id: string; name: string; phone: string; kids: Pick<Camper, "name" | "sex">[] }[]> {
  const [parents, kids] = await Promise.all([listParents(), listCampers()]);
  const kidsOf = new Map<string, Pick<Camper, "name" | "sex">[]>();
  for (const k of kids) if (k.guardianPhone) kidsOf.set(k.guardianPhone, [...(kidsOf.get(k.guardianPhone) ?? []), { name: k.name, sex: k.sex }]);
  return parents.filter((p) => !p.welcomeSentAt && p.phone && kidsOf.has(p.phone)).map((p) => ({ id: p._id, name: p.name, phone: p.phone, kids: kidsOf.get(p.phone)! }));
}

/**
 * THE parents' welcome scheduler — same logic as `syncWelcomes` for the
 * team: whoever may use the app right now (parentAccessWindow open) and was
 * never welcomed gets the SMS, ONCE ever (atomic claim). Called at boot, at
 * the window edges, when the window is edited, when the toggle is switched on.
 */
export async function syncParentWelcomes(): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notifications.parentWelcome) return;
    if (!staffAccessOpen(settings.parentAccessWindow)) return;
    for (const p of await pendingParentWelcomes()) {
      if (!(await claimParentWelcome(p.id))) continue;
      await deliver(p, composeParentWelcomeSms(p, p.kids), "parent-welcome", "parent");
    }
  } catch (err) {
    console.error("notify: parent welcome sync failed", err);
  }
}

/**
 * What the admin sees before switching a welcome toggle on: how many people
 * would be texted RIGHT NOW (never welcomed + phone + their window open).
 */
export async function welcomePreview(): Promise<{ staff: { count: number; windowOpen: boolean; names: string[] }; parents: { count: number; windowOpen: boolean; names: string[] } }> {
  const settings = await getSettings();
  const staffOpen = staffAccessOpen(settings.staffAccessWindow);
  const team = (await listStaff({ active: true })).filter((s) => !s.welcomeSentAt && s.phone);
  const parentsOpen = staffAccessOpen(settings.parentAccessWindow);
  const parents = await pendingParentWelcomes();
  return {
    staff: { count: staffOpen ? team.length : 0, windowOpen: staffOpen, names: staffOpen ? team.map((s) => s.name) : [] },
    parents: { count: parentsOpen ? parents.length : 0, windowOpen: parentsOpen, names: parentsOpen ? parents.map((p) => p.name) : [] },
  };
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
  if (s.organizers.staffIds.includes(id)) out.push("organizador (acesso de administração)");
  if (s.gameOrganizers.staffIds.includes(id)) out.push("organizador dos jogos (programação e placar)");
  if (s.scoreHelpers.staffIds.includes(id)) out.push("ajudante do placar (lança pontos)");
  if (s.checkinHelpers.staffIds.includes(id)) out.push("ajudante do check-in");
  const bus = s.busHelpers.helpers.find((h) => h.staffId === id);
  if (bus) {
    const v = await transportLabel(bus.vehicleId);
    out.push(v ? `ajudante do ${v}` : "ajudante do ônibus");
  }
  if (s.medicalStaff.staffIds.includes(id)) out.push("equipe médica");
  if (s.vestHelpers.staffIds.includes(id)) out.push("responsável pelos coletes (entrega e devolução)");
  if (s.photographers.staffIds.includes(id)) out.push("fotógrafo do acampamento (envia as fotos)");
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
      for (const id of [...s.organizers.staffIds, ...s.gameOrganizers.staffIds, ...s.scoreHelpers.staffIds, ...s.checkinHelpers.staffIds, ...s.medicalStaff.staffIds, ...s.vestHelpers.staffIds, ...s.photographers.staffIds]) ids.add(id);
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
