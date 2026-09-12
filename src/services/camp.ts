import { listEvents } from "../models/schedule";
import { getSettings } from "../models/settings";
import type { CampEvent, Settings } from "../types";
import { nowInSaoPauloWallClock, saoPauloWallClock, saoPauloWallClockToIso, todayInSaoPaulo } from "../utils";

/**
 * "Is the camp happening right now?" — decided by the programme: from the
 * day of the FIRST event to the day of the LAST one, inclusive (São Paulo
 * calendar days). Ordinary caretakers only see the OTHER kids of their room
 * (not the ones under their own care) inside this period — see scope.ts.
 */
export interface CampPeriod {
  /** "YYYY-MM-DD" (null when there is no programme) */
  from: string | null;
  until: string | null;
}

export async function campPeriod(): Promise<CampPeriod> {
  const events = await listEvents(); // sorted by (date, startTime)
  if (events.length === 0) return { from: null, until: null };
  return { from: events[0].date, until: events[events.length - 1].date };
}

export function campInProgress(p: CampPeriod, today = todayInSaoPaulo()): boolean {
  return !!p.from && !!p.until && p.from <= today && today <= p.until;
}

// ── parents' window ──────────────────────────────────────────────────────────

/**
 * When a PARENT sees the team's contacts (important contacts, caretaker and
 * room staff phones): from the START of the kids' check-in window
 * (Settings → Check-in; one hour before the first event when unset) until
 * the END of the last event of the programme. Outside it the parent only
 * gets their kid's own data. The programme shown to parents is cut the same
 * way: events from the check-in start onwards.
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

/** The programme as parents see it: every event from the check-in start onwards (all when no window is set). */
export function parentEvents(settings: Settings, events: CampEvent[]): CampEvent[] {
  const from = settings.checkinWindow.from;
  if (!from) return events;
  const wall = nowInSaoPauloWallClock(from);
  return events.filter((e) => saoPauloWallClock(e.date, e.startTime) >= wall);
}
