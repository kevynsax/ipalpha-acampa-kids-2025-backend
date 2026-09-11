import { checkinWindowOpen, getSettings, staffAccessOpen } from "../models/settings";
import { findStaffByPhone } from "../models/staff";
import type { CampEvent, Camper, Role, ScheduleRole, Settings, Staff } from "../types";

/**
 * Data scope of a session — the ONE place that decides what a non-admin may
 * read. Every read path (REST lists/details and the realtime snapshot) filters
 * through here, so the frontend never receives what it must not show.
 *
 *   admin        → everything
 *   staff /      → only their own room: the kids sleeping there (full record,
 *   health_staff   health included — they look after them), their own staff
 *                  record, and the NAME of the colleagues in the same room.
 *                  The programme: every event, but only the roles that apply
 *                  to THEM (see scopeEvent) — never who does what elsewhere.
 *   check-in     → a staff member the admin listed as a check-in helper, WHILE
 *   helper         the check-in window is open: additionally every camper
 *                  (full record, health included — they confirm it with the
 *                  parents) and every bedroom. Other staff stay invisible.
 *                  The moment the window closes the extra data stops being
 *                  sent (snapshot, updates and REST alike).
 *   bus helper   → same window, for the bus roll call. The admin links the
 *                  helper to ONE vehicle (Settings → busHelpers, independent
 *                  from staff.transportation: they stand at the DOOR of that
 *                  vehicle, they need not ride in it). They get the campers of
 *                  THAT vehicle as NAME-ONLY records (name, age, room, team,
 *                  check-in stamps) — never health, contacts or notes — plus
 *                  every bedroom (for the labels). Kids in their own room stay
 *                  full (they look after them).
 *   organizer    → a staff member the admin listed as an ORGANIZER (no time
 *                  window): every staff member in FULL (health included) and
 *                  the whole programme (every role, every assignment), and
 *                  may write the schedule. Campers / bedrooms: as any team
 *                  member. Never writes staff.
 *   medical      → a staff member the admin listed as MEDICAL team (no time
 *                  window): every camper in FULL (health included), every
 *                  bedroom — hence every vehicle — the whole time. Read-only:
 *                  never writes campers, rooms or check-ins. Staff / programme:
 *                  as any team member.
 *   parent       → nothing from these collections (categories only)
 *
 * ORDINARY team members (on none of the lists above, nor a parent contact)
 * are further gated by `settings.staffAccessWindow`: outside it they get
 * NO_ACCESS. `settings.checkinTestMode` makes the check-in window count as
 * open for the church / bus helpers (testing before the real day).
 */
export interface Viewer {
  activeRole: Role;
  /** the person's login phone — how the session is matched to a staff record */
  phone: string;
}

export type Scope =
  | { all: true }
  | {
      all: false;
      /** the viewer's own staff record id (null when the phone isn't linked to one) */
      staffId: string | null;
      /** the viewer's bedroom id (null when unassigned) */
      bedroom: string | null;
      /** true while this person is a listed CHURCH check-in helper AND that window is open */
      checkinHelper: boolean;
      /** the vehicle (transportation option id) the admin linked this person to as a BUS helper, while the window is open; null otherwise */
      busHelperVehicle: string | null;
      /** true when this person is a listed programme ORGANIZER (no window) */
      organizer: boolean;
      /** true when this person is on the MEDICAL team (no window): every camper + bedroom in full, read-only */
      medical: boolean;
      /** true while the kids' room allocation is still a draft (Settings → Geral): the viewer's OWN room shows no kids */
      kidsRoomsDraft: boolean;
    };

export const NO_ACCESS: Scope = { all: false, staffId: null, bedroom: null, checkinHelper: false, busHelperVehicle: null, organizer: false, medical: false, kidsRoomsDraft: false };

/** On some admin list (organizer, church / bus helper, medical, parent contact)? These people are never gated by the staff access window. */
export function isPrivilegedStaff(staffId: string, s: Settings): boolean {
  return (
    s.organizers.staffIds.includes(staffId) ||
    s.medicalStaff.staffIds.includes(staffId) ||
    s.checkinHelpers.staffIds.includes(staffId) ||
    s.busHelpers.helpers.some((h) => h.staffId === staffId) ||
    s.parentContacts.some((p) => p.staffId === staffId)
  );
}

/** May this team member use the app (and be notified) right now? Ordinary members only inside `staffAccessWindow`. */
export function staffHasAccess(staffId: string, s: Settings, now = new Date()): boolean {
  return isPrivilegedStaff(staffId, s) || staffAccessOpen(s.staffAccessWindow, now);
}

export async function resolveScope(viewer: Viewer): Promise<Scope> {
  if (viewer.activeRole === "admin") return { all: true };
  if (viewer.activeRole !== "staff" && viewer.activeRole !== "health_staff") return NO_ACCESS;
  const me = await findStaffByPhone(viewer.phone);
  if (!me || !me.active) return NO_ACCESS;
  const settings = await getSettings();
  // ORDINARY team members (on no list at all) only get in during the staff access window
  if (!staffHasAccess(me._id, settings)) return NO_ACCESS;
  const { checkinWindow, checkinTestMode, checkinHelpers, busHelpers, organizers, medicalStaff, kidsRoomsDraft } = settings;
  const organizer = organizers.staffIds.includes(me._id);
  const medical = medicalStaff.staffIds.includes(me._id);
  const listedChurch = checkinHelpers.staffIds.includes(me._id);
  const linkedVehicle = busHelpers.helpers.find((h) => h.staffId === me._id)?.vehicleId ?? null;
  // test mode opens the kids' roll calls for the helpers regardless of the window
  const windowOpen = checkinTestMode || checkinWindowOpen(checkinWindow);
  const checkinHelper = windowOpen && listedChurch;
  const busHelperVehicle = windowOpen ? linkedVehicle : null;
  return { all: false, staffId: me._id, bedroom: me.bedroom, checkinHelper, busHelperVehicle, organizer, medical, kidsRoomsDraft };
}

/** May this session write the programme (events, roles, assignments)? (admin or organizer) */
export function canOrganize(scope: Scope): boolean {
  return scope.all || scope.organizer;
}

/** May this session run the kids' CHURCH check-in right now? (admin, or a church helper inside the window) */
export function canRunCheckin(scope: Scope): boolean {
  return scope.all || scope.checkinHelper;
}

/** May this session roll-call `k` on the bus right now? (admin, or a bus helper inside the window — only for kids of the vehicle they were linked to) */
export function canRunBusCheckin(scope: Scope, k: Pick<Camper, "transportation">): boolean {
  return scope.all || (scope.busHelperVehicle !== null && k.transportation === scope.busHelperVehicle);
}

export function canSeeBedroom(scope: Scope, bedroomId: string): boolean {
  return scope.all || scope.medical || scope.checkinHelper || scope.busHelperVehicle !== null || (!scope.kidsRoomsDraft && scope.bedroom !== null && scope.bedroom === bedroomId);
}

/** "full" = whole record, "name" = roll-call view (no health / contacts / notes), "none" = invisible. */
export type CamperVisibility = "full" | "name" | "none";

export function camperVisibility(scope: Scope, k: Pick<Camper, "bedroom" | "transportation">): CamperVisibility {
  if (scope.all || scope.medical || scope.checkinHelper) return "full";
  // own room: hidden while the kids' allocation is still a draft
  if (!scope.kidsRoomsDraft && k.bedroom !== null && k.bedroom === scope.bedroom) return "full";
  // a bus helper works the door of ONE vehicle: its kids, names only
  return scope.busHelperVehicle !== null && k.transportation === scope.busHelperVehicle ? "name" : "none";
}

export function canSeeCamper(scope: Scope, k: Pick<Camper, "bedroom" | "transportation">): boolean {
  return camperVisibility(scope, k) !== "none";
}

/** "full" = whole record, "name" = colleague in the same room (name only), "none" = invisible. */
export type StaffVisibility = "full" | "name" | "none";

export function staffVisibility(scope: Scope, s: Pick<Staff, "_id" | "bedroom">): StaffVisibility {
  if (scope.all || scope.organizer) return "full";
  if (scope.staffId === s._id) return "full";
  // roommates are unknown while the rooms are still a draft
  if (!scope.kidsRoomsDraft && scope.bedroom !== null && s.bedroom === scope.bedroom) return "name";
  return "none";
}

/** While the rooms are a draft the viewer must not learn their OWN room either (admins / organizers excepted). */
export function hideOwnBedroom(scope: Scope): boolean {
  return !scope.all && !scope.organizer && scope.kidsRoomsDraft;
}

/**
 * What a non-admin sees of an event: the event itself (everyone may know the
 * programme) with `roles` cut down to the ones that concern the viewer —
 * their explicit assignment, or the "for everyone" defaults when they have
 * none — and `assignments` reduced to their own entry. Other people's roles
 * and names never leave the server.
 */
export function scopeEvent(scope: Scope, e: CampEvent, roleById: Map<string, ScheduleRole>): CampEvent {
  if (scope.all || scope.organizer) return e;
  const mine = scope.staffId ? e.assignments.find((a) => a.staffId === scope.staffId) : undefined;
  const roles = mine ? e.roles.filter((id) => id === mine.roleId) : e.roles.filter((id) => roleById.get(id)?.forEveryone);
  return { ...e, roles, assignments: mine ? [mine] : [] };
}

/** Roles a non-admin may know about: only the ones left in their scoped events. */
export function scopeRoles(scope: Scope, roles: ScheduleRole[], scopedEvents: CampEvent[]): ScheduleRole[] {
  if (scope.all || scope.organizer) return roles;
  const used = new Set(scopedEvents.flatMap((e) => e.roles));
  return roles.filter((r) => used.has(r._id));
}
