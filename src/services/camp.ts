import { listEvents } from "../models/schedule";
import { getSettings } from "../models/settings";
import type { CampEvent, Settings } from "../types";
import { saoPauloWallClock, saoPauloWallClockToIso, todayInSaoPaulo } from "../utils";

/**
 * "Is the camp happening right now?" — decided by the programme: from the
 * day of the FIRST event (São Paulo calendar day) until the END of the LAST
 * event — its `endTime`, or its `startTime` when it has no end (e.g. "Chegada
 * das crianças na igreja"). Ordinary caretakers only see the OTHER kids of
 * their room (not the ones under their own care) inside this period — see
 * scope.ts.
 */
export interface CampPeriod {
  /** "YYYY-MM-DD" of the first event (null when there is no programme) */
  from: string | null;
  /** "YYYY-MM-DD" of the last event */
  until: string | null;
  /** the instant the camp is over: end (or start) of the last event */
  endsAt: Date | null;
}

export async function campPeriod(): Promise<CampPeriod> {
  const events = await listEvents(); // sorted by (date, startTime)
  if (events.length === 0) return { from: null, until: null, endsAt: null };
  const last = events[events.length - 1];
  return { from: events[0].date, until: last.date, endsAt: eventEnd(last) };
}

export function campInProgress(p: CampPeriod, now = new Date()): boolean {
  return !!p.from && !!p.endsAt && p.from <= todayInSaoPaulo(now) && now < p.endsAt;
}

/**
 * "YYYY-MM-DD" of the kid's birthday that falls inside the camp (first → last
 * event day, inclusive), or null. The camp may straddle a year boundary, so
 * both years are tried.
 */
export function birthdayDuringCamp(birthDate: string | null, p: Pick<CampPeriod, "from" | "until">): string | null {
  if (!birthDate || !p.from || !p.until) return null;
  const md = birthDate.slice(5, 10);
  if (md.length !== 5) return null;
  for (const y of new Set([p.from.slice(0, 4), p.until.slice(0, 4)])) {
    const day = `${y}-${md}`;
    if (day >= p.from && day <= p.until) return day;
  }
  return null;
}

/** how long after the camp the VEST helpers keep their tab (people return the vests in the days after) */
export const VEST_GRACE_DAYS = 7;

/** Is the vest (colete) window open? Any time before / during the camp and up to VEST_GRACE_DAYS after its end; always when there is no programme. */
export function vestWindowOpen(p: CampPeriod, now = new Date()): boolean {
  if (!p.endsAt) return true;
  return now.getTime() < p.endsAt.getTime() + VEST_GRACE_DAYS * 24 * 60 * 60 * 1000;
}

// ── parents' window ──────────────────────────────────────────────────────────

/**
 * When a PARENT sees the team's contacts (important contacts, caretaker and
 * room staff phones): from the START of the kids' check-in window
 * (Settings → Check-in; one hour before the first event when unset) until
 * the END of the last event of the programme. Outside it the parent only
 * gets their kid's own data. The programme itself is the full timeline
 * (past items stay on the phone, collapsed like the team's view).
 */
export interface ParentWindow {
  from: Date | null;
  until: Date | null;
}

/** the parent window opens this long before the first event when no check-in window is set */
const FALLBACK_OPENS_MINUTES_BEFORE = 60;

/** instant at which `e` ends (its `endTime`, else its start), assuming São Paulo wall-clock */
function eventEnd(e: CampEvent): Date {
  return new Date(saoPauloWallClockToIso(saoPauloWallClock(e.date, e.endTime ?? e.startTime)));
}

export function parentWindowOf(settings: Settings, events: CampEvent[]): ParentWindow {
  const first = events[0] ?? null;
  const last = events[events.length - 1] ?? null;
  const from = settings.checkinWindow.from ?? (first ? new Date(new Date(saoPauloWallClockToIso(saoPauloWallClock(first.date, first.startTime))).getTime() - FALLBACK_OPENS_MINUTES_BEFORE * 60_000) : null);
  return { from, until: last ? eventEnd(last) : null };
}

export async function parentWindow(settings?: Settings, events?: CampEvent[]): Promise<ParentWindow> {
  const [s, e] = await Promise.all([settings ?? getSettings(), events ?? listEvents()]);
  return parentWindowOf(s, e);
}

/** Is the parents' window open at `now`? Needs both ends (no programme = never). */
export function parentWindowOpen(w: ParentWindow, now = new Date()): boolean {
  return !!w.from && !!w.until && w.from <= now && now < w.until;
}
