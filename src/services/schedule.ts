import type { CampEvent, EventAssignment, RoomRole, ScheduleRole, Staff, Team } from "../types";

/**
 * WHO does a função in an event. The ways ADD UP — a função may be linked to
 * people in several ways at once:
 *
 *   - by POSITION   (`ScheduleRole.forRoomRoles`): every Líder, every Auxiliar,
 *                   or both (= the whole team). Nobody is picked one by one:
 *                   the link is the person's `Staff.roomRole`, so moving
 *                   somebody between positions re-does every event at once.
 *   - by PERSON     (`CampEvent.assignments`): the organizer scales this one
 *                   by hand, with an optional detail ("Base 3", the team…).
 *
 * So "os líderes + a Ana e o Pedro" is a role with `forRoomRoles: ["caretaker"]`
 * and two assignments; "só a Ana" is `forRoomRoles: []` and one assignment.
 *
 * One rule keeps it unambiguous: a person does ONE função per event — an
 * explicit assignment always wins over every automatic link (see `autoRoleFor`).
 */

/** Does this função fall on somebody by their POSITION, with no escala? */
export function isAutomatic(role: Pick<ScheduleRole, "forRoomRoles"> | undefined | null): boolean {
  return !!role && role.forRoomRoles.length > 0;
}

/** Does it fall on EVERY position (= the whole team)? */
export function isForWholeTeam(role: Pick<ScheduleRole, "forRoomRoles"> | undefined | null): boolean {
  return !!role && role.forRoomRoles.length >= 2;
}

/** Does this função reach somebody in that position by itself? */
export function autoRoleCovers(role: Pick<ScheduleRole, "forRoomRoles"> | undefined | null, roomRole: RoomRole): boolean {
  return !!role?.forRoomRoles.includes(roomRole);
}

/**
 * The automatic função of `e` for somebody in that position — what they do
 * there when nobody scaled them by hand. A função aimed at ONE position wins
 * over the whole-team one ("Líderes: passar a lição" beats "Todos: cuidar das
 * crianças"); ties keep the event's own order.
 */
export function autoRoleFor(e: Pick<CampEvent, "roles">, roomRole: RoomRole, roleById: Map<string, ScheduleRole>): ScheduleRole | undefined {
  const mine = e.roles.map((id) => roleById.get(id)).filter((r) => autoRoleCovers(r, roomRole)) as ScheduleRole[];
  return mine.find((r) => !isForWholeTeam(r)) ?? mine[0];
}

/**
 * What ONE person does in an event: their explicit assignment if they have
 * one, otherwise the automatic função covering their position (active people
 * only). `null` when the event asks nothing of them.
 */
export function dutyOf(
  e: Pick<CampEvent, "roles" | "assignments">,
  s: Pick<Staff, "_id" | "active" | "roomRole">,
  roleById: Map<string, ScheduleRole>,
): { role: ScheduleRole | undefined; assignment: EventAssignment | undefined } | null {
  const assignment = e.assignments.find((a) => a.staffId === s._id);
  if (assignment) return { role: roleById.get(assignment.roleId), assignment };
  if (!s.active) return null;
  const role = autoRoleFor(e, s.roomRole, roleById);
  return role ? { role, assignment: undefined } : null;
}

/**
 * Everyone a função reaches in an event, both ways at once: the people scaled
 * by hand, plus those it falls on by position (minus anyone doing something
 * else there). `via` says which link brought each one in.
 */
export function peopleInRole<T extends Pick<Staff, "_id" | "active" | "roomRole">>(
  e: Pick<CampEvent, "roles" | "assignments">,
  role: Pick<ScheduleRole, "_id" | "forRoomRoles">,
  staff: T[],
  roleById: Map<string, ScheduleRole>,
): { staff: T; via: "person" | "position"; assignment?: EventAssignment }[] {
  const out: { staff: T; via: "person" | "position"; assignment?: EventAssignment }[] = [];
  for (const s of staff) {
    const duty = dutyOf(e, s, roleById);
    if (duty?.role?._id !== role._id) continue;
    out.push({ staff: s, via: duty.assignment ? "person" : "position", assignment: duty.assignment });
  }
  return out;
}

/** pt-BR name of the positions a função falls on: "toda a equipe" / "os líderes" / "os auxiliares" / "" (ninguém). */
export function autoAudienceLabel(role: Pick<ScheduleRole, "forRoomRoles">): string {
  if (isForWholeTeam(role)) return "toda a equipe";
  if (role.forRoomRoles.includes("caretaker")) return "os líderes";
  if (role.forRoomRoles.includes("helper")) return "os auxiliares";
  return "";
}

/**
 * The per-person detail of a role assignment ("Base 3", "Time Belém", a shift).
 *
 * Two sources, decided by the role:
 *  - `detailFromTeam` → the detail IS the person's team (`Staff.team`), read
 *    live from the staff record. Nothing is stored on the assignment, so
 *    moving somebody between teams re-labels every event at once — and it
 *    works for the people the função reaches by POSITION too, who have no
 *    assignment to type a detail on.
 *  - otherwise → whatever the organizer typed on the assignment itself (so
 *    only the people scaled by hand carry it).
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
