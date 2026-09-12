import { listEvents } from "../models/schedule";
import { todayInSaoPaulo } from "../utils";

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
