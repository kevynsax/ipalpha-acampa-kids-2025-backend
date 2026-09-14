import type { EventAssignment, ScheduleRole, Staff, Team } from "../types";

/**
 * The per-person detail of a role assignment ("Base 3", "Time Belém", a shift).
 *
 * Two sources, decided by the role:
 *  - `detailFromTeam` → the detail IS the person's team (`Staff.team`), read
 *    live from the staff record. Nothing is stored on the assignment, so
 *    moving somebody between teams re-labels every event at once.
 *  - otherwise → whatever the organizer typed on the assignment itself.
 *
 * `role`, `staff` or the team may be missing (deleted role, stale id): the
 * result is then simply an empty label, never a throw.
 */
export function assignmentDetail(
  role: ScheduleRole | undefined | null,
  assignment: Pick<EventAssignment, "detail" | "detailColor"> | undefined | null,
  staff: Pick<Staff, "team"> | undefined | null,
  teamById: Map<string, Team>,
): { detail: string; detailColor: string } {
  if (role?.detailFromTeam) {
    const team = staff?.team ? teamById.get(staff.team) : undefined;
    return team ? { detail: team.name, detailColor: team.color } : { detail: "", detailColor: "" };
  }
  return { detail: assignment?.detail ?? "", detailColor: assignment?.detailColor ?? "" };
}

/** `teamById` for `assignmentDetail`, from the teams collection. */
export function teamMap(teams: Team[]): Map<string, Team> {
  return new Map(teams.map((t) => [t._id, t]));
}
