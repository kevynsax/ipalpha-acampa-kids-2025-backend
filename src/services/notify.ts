import { config } from "../config";
import { listRoles } from "../models/schedule";
import { getSettings } from "../models/settings";
import { listStaff } from "../models/staff";
import type { CampEvent, Camper, ScheduleRole, Staff } from "../types";
import { formatBrazilPhone } from "../utils";
import { comteleEnabled, comteleSendSms } from "./comtele";

/**
 * Texts (SMS via Comtele) the team members concerned by a change, so they
 * open the app and read what changed:
 *
 *   - a kid moved into / out of someone's bedroom (created / deleted there)
 *   - someone's role in an event changed (assigned, reassigned, removed,
 *     the event moved or was deleted)
 *   - the person's church check-in was recorded (confirmation, sent at once)
 *
 * Each kind can be switched off by the admin (Settings → Notificações).
 * Messages are deliberately short (one SMS = 160 chars) and never carry the
 * details — the app is the source of truth, the SMS is just the nudge.
 *
 * Sends are COALESCED: every text for the same person within a short window
 * becomes one SMS ("2 mudanças…"), so bulk edits on the admin screen don't
 * flood anyone's phone. Delivery is best-effort and never blocks the write.
 */

export type NotifyKind = "bedroom" | "role";

interface Pending {
  staff: Staff;
  kinds: Set<NotifyKind>;
  count: number;
}

/** how long to wait for more changes to the same person before texting */
const COALESCE_MS = Number(process.env.NOTIFY_COALESCE_SECONDS ?? 20) * 1000;

const queue = new Map<string, Pending>();
let timer: ReturnType<typeof setTimeout> | null = null;

function enqueue(staff: Staff, kind: NotifyKind): void {
  if (!staff.phone) return;
  const p = queue.get(staff._id) ?? { staff, kinds: new Set(), count: 0 };
  p.kinds.add(kind);
  p.count++;
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

/** The SMS text — one line, short, and always pointing at the app. */
export function composeSms(p: Pending): string {
  const name = first(p.staff.name);
  const bedroom = p.kinds.has("bedroom");
  const role = p.kinds.has("role");
  let what: string;
  if (bedroom && role) what = "houve mudanças no seu quarto e na sua escala";
  else if (bedroom) what = p.count > 1 ? "houve mudanças nas crianças do seu quarto" : "houve uma mudança nas crianças do seu quarto";
  else what = p.count > 1 ? "houve mudanças na sua escala (funções)" : "houve uma mudança na sua escala (função)";
  const url = config.appUrl ? ` ${config.appUrl}` : "";
  return `${config.comtele.prefix}: ${name}, ${what}. Abra o app para ver suas instruções.${url}`;
}

/** Actually texts one person (or prints it, without a Comtele key). */
async function deliver(staff: Staff, text: string, label: string): Promise<void> {
  if (!comteleEnabled()) {
    console.log(`\n📲 [NOTIFY · DEV MOCK] ${staff.name} — ${formatBrazilPhone(staff.phone!)}: ${text}\n`);
    return;
  }
  const res = await comteleSendSms(staff.phone!, text);
  if (res.ok) console.log(`📲 [NOTIFY · SMS] ${staff.name} (${label})`);
  else console.error(`[comtele] notify to ${staff.name} failed:`, res.message);
}

async function flush(): Promise<void> {
  const batch = [...queue.values()];
  queue.clear();
  for (const p of batch) await deliver(p.staff, composeSms(p), [...p.kinds].join("+"));
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

/** The confirmation text — a receipt plus the one thing to do next. */
export function composeCheckinSms(staff: Staff): string {
  const url = config.appUrl ? ` ${config.appUrl}` : "";
  return `${config.comtele.prefix}: ${first(staff.name)}, seu check-in foi feito com sucesso. Lembre-se de conferir as crianças do seu quarto no app.${url}`;
}

/**
 * Call right after a team member's check-in is recorded — by themselves
 * (self check-in) or by the admin roll call. Not coalesced: it is a receipt
 * for one action, so it goes out immediately.
 */
export async function notifyCheckin(staff: Staff): Promise<void> {
  try {
    if (!staff.phone) return;
    const { notifications } = await getSettings();
    if (!notifications.checkinConfirmation) return;
    await deliver(staff, composeCheckinSms(staff), "checkin");
  } catch (err) {
    console.error("notify: check-in confirmation failed", err);
  }
}

// ── bedroom changes ─────────────────────────────────────────────────────────

/**
 * Call after a camper write with the record BEFORE and AFTER (null on create /
 * delete). Only the `bedroom` field matters here: the caretakers of the room
 * the kid left and of the room the kid entered are texted.
 */
export async function notifyCamperChange(before: Camper | null, after: Camper | null): Promise<void> {
  try {
    const from = before?.bedroom ?? null;
    const to = after?.bedroom ?? null;
    if (from === to) return;
    const { notifications } = await getSettings();
    if (!notifications.bedroomChanges) return;

    const staff = await listStaff({ active: true });
    for (const s of staff) {
      if (s.bedroom && (s.bedroom === from || s.bedroom === to)) enqueue(s, "bedroom");
    }
  } catch (err) {
    console.error("notify: camper change failed", err);
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
 */
export async function notifyEventChange(before: CampEvent | null, after: CampEvent | null): Promise<void> {
  try {
    const { notifications } = await getSettings();
    if (!notifications.roleChanges) return;

    const [staff, roles] = await Promise.all([listStaff(), listRoles()]);
    const roleById = new Map(roles.map((r) => [r._id, r]));
    const prev = dutiesOf(before, staff, roleById);
    const next = dutiesOf(after, staff, roleById);
    const moved = !!before && !!after && (before.date !== after.date || before.startTime !== after.startTime || before.endTime !== after.endTime);

    for (const s of staff) {
      const a = prev.get(s._id);
      const b = next.get(s._id);
      const changed = (a ? !b || a.roleId !== b.roleId || a.detail !== b.detail : !!b) || (moved && !!b);
      if (changed) enqueue(s, "role");
    }
  } catch (err) {
    console.error("notify: event change failed", err);
  }
}

/**
 * A role's instructions / name changed → everyone who does it in some event
 * (explicitly, or via "for everyone").
 */
export async function notifyRoleEdited(roleBefore: ScheduleRole, roleAfter: ScheduleRole, events: CampEvent[]): Promise<void> {
  try {
    if (
      roleBefore.name === roleAfter.name &&
      roleBefore.instructions === roleAfter.instructions &&
      roleBefore.preparation === roleAfter.preparation &&
      roleBefore.forEveryone === roleAfter.forEveryone
    )
      return;
    const { notifications } = await getSettings();
    if (!notifications.roleChanges) return;

    const staff = await listStaff({ active: true });
    const using = events.filter((e) => e.roles.includes(roleAfter._id));
    for (const s of staff) {
      const concerned = using.some((e) => {
        const a = e.assignments.find((x) => x.staffId === s._id);
        return a ? a.roleId === roleAfter._id : roleAfter.forEveryone || roleBefore.forEveryone;
      });
      if (concerned) enqueue(s, "role");
    }
  } catch (err) {
    console.error("notify: role edit failed", err);
  }
}
