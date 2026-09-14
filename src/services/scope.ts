import { listCampersOfGuardian } from "../models/campers";
import { listEvents } from "../models/schedule";
import { checkinWindowOpen, getSettings, staffAccessOpen } from "../models/settings";
import { findStaffByPhone } from "../models/staff";
import type { CampEvent, Camper, DocAudience, PrepAudience, Role, RoomRole, ScheduleRole, Settings, Staff } from "../types";
import { campInProgress, campPeriod, parentWindowOf, parentWindowOpen, vestWindowOpen } from "./camp";

/**
 * Data scope of a session — the ONE place that decides what a non-admin may
 * read. Every read path (REST lists/details and the realtime snapshot) filters
 * through here, so the frontend never receives what it must not show.
 *
 *   admin        → everything
 *   staff /      → only their own room. A CARETAKER (staff.roomRole) gets the
 *   health_staff   kids under THEIR care (Camper.caretakerId) any time, and the
 *                  other kids of the room only WHILE THE CAMP IS HAPPENING
 *                  (see services/camp.ts); a HELPER gets the room's kids only
 *                  during the camp. Both as "care" records: health, notes and
 *                  preferences included, but NO guardian / emergency contact
 *                  data (that stays with the admin, the medical team and the
 *                  check-in helpers). Plus their own staff record and the
 *                  NAME + room role of the colleagues in the same room.
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
 *                  window): the ADMIN'S data scope (`all: true`) — every
 *                  camper, staff member, bedroom, occurrence and the whole
 *                  programme — and the admin's writes, EXCEPT the four
 *                  admin-only areas: the organizers list itself, categories,
 *                  notifications and the "about" page (`admin: false`).
 *   game         → a staff member the admin listed as a GAME organizer (no
 *   organizer      window): writes the programme (events, roles, assignments)
 *                  and the scoreboard (Placar): give / take / zero points of
 *                  any team. Sees every staff member in FULL and the whole
 *                  programme. NOT an organizer: campers / bedrooms as any team
 *                  member, no settings.
 *   score helper → a staff member the admin listed as a SCORE helper (no
 *                  window): ONLY the bulk QR scan tied to a programme event
 *                  (the kid's team gets the event's points). Never gives /
 *                  takes points by team, never zeroes, deletes only their
 *                  own scan lines, no organizer rights. Every camper reaches
 *                  them as a "name" record (name + team) so the scan can be
 *                  resolved and shown. Everything else: as any team member.
 *   medical      → a staff member the admin listed as MEDICAL team (no time
 *                  window): every camper in FULL (health included), every
 *                  bedroom — hence every vehicle — the whole time. Read-only:
 *                  never writes campers, rooms or check-ins. Staff / programme:
 *                  as any team member.
 *   vest helper  → a staff member the admin listed as a VEST (colete) helper,
 *                  until VEST_GRACE_DAYS after the camp ends (they collect the
 *                  vests back in the days after): every staff member as NAME + PHONE +
 *                  vest status ("contact" visibility) — never health, room,
 *                  team or check-in — and may stamp the vest delivery /
 *                  return. Everything else: as any team member.
 *   parent       → their OWN kids (matched by the guardian phone), in full,
 *                  and the kids' rooms. WHILE THE PARENTS' WINDOW is open
 *                  (from the kids' check-in start to the end of the last
 *                  event — see services/camp.ts#parentWindow) additionally
 *                  the team members of those rooms and the "important
 *                  contacts" (Settings → Contatos) as NAME + PHONE records.
 *                  Outside the window: no staff at all. The programme: every
 *                  event from the check-in start onwards, without roles or
 *                  assignments. They may edit their kid's health block
 *                  (PUT /api/campers/:id/parent).
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
  | {
      all: true;
      /** true for the real admin session; false for an ORGANIZER (same data, minus the admin-only settings) */
      admin: boolean;
    }
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
      /** true when this person may write the PROGRAMME (events, roles, assignments) and sees the whole team: game organizers (real organizers get `all: true` instead) */
      organizer: boolean;
      /** true when this person is a listed GAME organizer (no window): programme + writes the scoreboard */
      gameOrganizer: boolean;
      /** true when this person is a listed SCORE helper (no window): bulk QR scan by event only — no per-team points, no zero, no organizer rights */
      scoreHelper: boolean;
      /** true when this person is on the MEDICAL team (no window): every camper + bedroom in full, read-only */
      medical: boolean;
      /** true when this person hands out / takes back the team VESTS — listed AND before / during / up to VEST_GRACE_DAYS after the camp: every staff member as name + phone */
      vestHelper: boolean;
      /** true while the kids' room allocation is still a draft (Settings → Geral): the viewer's OWN room shows no kids */
      kidsRoomsDraft: boolean;
      /** true while the camp is happening (first → last programme day): the whole room's kids become visible */
      campActive: boolean;
      /** the viewer's role in their room — decides which general documents (Instruções / Preparação) they get */
      roomRole: RoomRole;
      /** PARENT session: the ids of their own kids (empty for every other role) */
      parentKids: string[];
      /** PARENT session: the rooms of those kids */
      parentBedrooms: string[];
      /** PARENT session: true while the parents' window is open — room staff + important contacts are sent (name + phone) */
      parentContacts: boolean;
      /** PARENT session: staff ids listed as important contacts (Settings → Contatos), inside the window */
      parentContactIds: string[];
    };

export const NO_ACCESS: Extract<Scope, { all: false }> = { all: false, staffId: null, bedroom: null, checkinHelper: false, busHelperVehicle: null, organizer: false, gameOrganizer: false, scoreHelper: false, medical: false, vestHelper: false, kidsRoomsDraft: false, campActive: false, roomRole: "helper", parentKids: [], parentBedrooms: [], parentContacts: false, parentContactIds: [] };

/** Is this a PARENT session with at least one kid enrolled? */
export function isParent(scope: Scope): boolean {
  return !scope.all && scope.parentKids.length > 0;
}

/** the parent branch of a scope (only meaningful when `isParent(scope)`) */
function asParent(scope: Scope): Extract<Scope, { all: false }> {
  return scope as Extract<Scope, { all: false }>;
}

/** On some admin list (organizer, church / bus helper, medical, vest helper, parent contact)? These people are never gated by the staff access window. */
export function isPrivilegedStaff(staffId: string, s: Settings): boolean {
  return (
    s.organizers.staffIds.includes(staffId) ||
    s.gameOrganizers.staffIds.includes(staffId) ||
    s.scoreHelpers.staffIds.includes(staffId) ||
    s.medicalStaff.staffIds.includes(staffId) ||
    s.vestHelpers.staffIds.includes(staffId) ||
    s.checkinHelpers.staffIds.includes(staffId) ||
    s.busHelpers.helpers.some((h) => h.staffId === staffId) ||
    s.parentContacts.some((p) => p.staffId === staffId)
  );
}

/** May this team member use the app (and be notified) right now? Ordinary members only inside `staffAccessWindow`. */
export function staffHasAccess(staffId: string, s: Settings, now = new Date()): boolean {
  return isPrivilegedStaff(staffId, s) || staffAccessOpen(s.staffAccessWindow, now);
}

/** The parent's scope: their kids (by guardian phone), the kids' rooms and — inside the parents' window — the contacts. */
async function resolveParentScope(phone: string): Promise<Scope> {
  const [kids, settings, events] = await Promise.all([listCampersOfGuardian(phone), getSettings(), listEvents()]);
  if (kids.length === 0) return NO_ACCESS;
  const open = parentWindowOpen(parentWindowOf(settings, events));
  return {
    ...NO_ACCESS,
    kidsRoomsDraft: settings.kidsRoomsDraft,
    parentKids: kids.map((k) => k._id),
    parentBedrooms: settings.kidsRoomsDraft ? [] : [...new Set(kids.map((k) => k.bedroom).filter((b): b is string => !!b))],
    parentContacts: open,
    parentContactIds: open ? settings.parentContacts.map((p) => p.staffId) : [],
  };
}

export const ADMIN: Extract<Scope, { all: true }> = { all: true, admin: true };
export const ORGANIZER: Extract<Scope, { all: true }> = { all: true, admin: false };

export async function resolveScope(viewer: Viewer): Promise<Scope> {
  if (viewer.activeRole === "admin") return ADMIN;
  if (viewer.activeRole === "parent") return resolveParentScope(viewer.phone);
  if (viewer.activeRole !== "staff" && viewer.activeRole !== "health_staff") return NO_ACCESS;
  const me = await findStaffByPhone(viewer.phone);
  if (!me || !me.active) return NO_ACCESS;
  const settings = await getSettings();
  // ORDINARY team members (on no list at all) only get in during the staff access window
  if (!staffHasAccess(me._id, settings)) return NO_ACCESS;
  const { checkinWindow, checkinTestMode, checkinHelpers, busHelpers, organizers, gameOrganizers, scoreHelpers, medicalStaff, vestHelpers, kidsRoomsDraft } = settings;
  // an ORGANIZER is an admin minus a few settings: same data scope
  if (organizers.staffIds.includes(me._id)) return ORGANIZER;
  const gameOrganizer = gameOrganizers.staffIds.includes(me._id);
  const scoreHelper = scoreHelpers.staffIds.includes(me._id);
  // a game organizer also writes the programme (and sees the whole team for the roster)
  const organizer = gameOrganizer;
  const medical = medicalStaff.staffIds.includes(me._id);
  const period = await campPeriod();
  // the vest helper keeps the tab for a few days after the camp (vests come back then), not forever
  const vestHelper = vestHelpers.staffIds.includes(me._id) && vestWindowOpen(period);
  const listedChurch = checkinHelpers.staffIds.includes(me._id);
  const linkedVehicle = busHelpers.helpers.find((h) => h.staffId === me._id)?.vehicleId ?? null;
  // test mode opens the kids' roll calls for the helpers regardless of the window
  const windowOpen = checkinTestMode || checkinWindowOpen(checkinWindow);
  const checkinHelper = windowOpen && listedChurch;
  const busHelperVehicle = windowOpen ? linkedVehicle : null;
  const campActive = campInProgress(period);
  return { ...NO_ACCESS, staffId: me._id, bedroom: me.bedroom, checkinHelper, busHelperVehicle, organizer, gameOrganizer, scoreHelper, medical, vestHelper, kidsRoomsDraft, campActive, roomRole: me.roomRole };
}

/** May this PARENT session edit `k`'s "Pontos de atenção"? (their own kid) */
export function canParentEdit(scope: Scope, k: Pick<Camper, "_id">): boolean {
  return isParent(scope) && asParent(scope).parentKids.includes(k._id);
}

/** A general Instruções document reaches everyone, or only the caretakers / helpers. Admins and organizers see all. */
export function canSeeDoc(scope: Scope, d: { audience: DocAudience }): boolean {
  if (scope.all || scope.organizer) return true;
  return d.audience === "all" || d.audience === scope.roomRole;
}

/**
 * A Preparação section is posted to one or more groups: parents see only the
 * sections posted to `parent`; a team member sees the ones posted to their room
 * role. Admins and organizers see all.
 */
export function canSeePrep(scope: Scope, s: { audiences: PrepAudience[] }): boolean {
  if (scope.all || scope.organizer) return true;
  if (isParent(scope)) return s.audiences.includes("parent");
  return s.audiences.includes(scope.roomRole);
}

/** May this session do what the admin does (campers, staff, rooms, check-ins, documents, most settings)? (admin or organizer) */
export function canManage(scope: Scope): boolean {
  return scope.all;
}

/** Is this the real admin? (organizers list, categories, notifications, about) */
export function isAdmin(scope: Scope): boolean {
  return scope.all && scope.admin;
}

/** May this session write the scoreboard (give / take / zero points, delete any line)? (admin, organizer or game organizer) */
export function canKeepScore(scope: Scope): boolean {
  return scope.all || scope.gameOrganizer;
}

/** May this session run the bulk QR scan (points by event)? (scorekeepers + score helpers) */
export function canLaunchScore(scope: Scope): boolean {
  return scope.all || scope.gameOrganizer || scope.scoreHelper;
}

/** May this session hand out / take back the team vests? (admin, organizer or vest helper) */
export function canHandleVests(scope: Scope): boolean {
  return scope.all || scope.vestHelper;
}

/** May this session write the programme (events, roles, assignments)? (admin, organizer or game organizer) */
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
  if (isParent(scope)) return asParent(scope).parentBedrooms.includes(bedroomId);
  return scope.all || scope.medical || scope.checkinHelper || scope.busHelperVehicle !== null || (!scope.kidsRoomsDraft && scope.bedroom !== null && scope.bedroom === bedroomId);
}

/**
 * "full" = whole record, "care" = what a room caretaker / helper needs (health,
 * notes, preferences — no guardian / emergency / documents), "name" = roll-call
 * view (no health / contacts / notes), "none" = invisible.
 */
export type CamperVisibility = "full" | "care" | "name" | "none";

export function camperVisibility(scope: Scope, k: Pick<Camper, "_id" | "bedroom" | "transportation" | "caretakerId">): CamperVisibility {
  if (scope.all || scope.medical || scope.checkinHelper) return "full";
  // a parent: their own kids, nothing else
  if (isParent(scope)) return asParent(scope).parentKids.includes(k._id) ? "full" : "none";
  if (!scope.kidsRoomsDraft && scope.staffId !== null) {
    // the kids under my care: any time
    if (k.caretakerId === scope.staffId) return "care";
    // the rest of my room: only while the camp is happening
    if (scope.campActive && k.bedroom !== null && k.bedroom === scope.bedroom) return "care";
  }
  // a bus helper works the door of ONE vehicle: its kids, names only
  if (scope.busHelperVehicle !== null && k.transportation === scope.busHelperVehicle) return "name";
  // a score helper scans any kid at the door: name + team, nothing else
  return scope.scoreHelper ? "name" : "none";
}

export function canSeeCamper(scope: Scope, k: Pick<Camper, "_id" | "bedroom" | "transportation" | "caretakerId">): boolean {
  return camperVisibility(scope, k) !== "none";
}

/**
 * "full" = whole record, "contact" = name + phone + vest status (vest helper),
 * "name" = colleague in the same room (name only), "none" = invisible.
 */
export type StaffVisibility = "full" | "contact" | "name" | "none";

export function staffVisibility(scope: Scope, s: Pick<Staff, "_id" | "bedroom" | "active">): StaffVisibility {
  if (scope.all || scope.organizer) return "full";
  // a parent, inside the parents' window: the team of their kids' rooms + the important contacts, name + phone only
  if (isParent(scope)) {
    if (!scope.parentContacts || !s.active) return "none";
    return scope.parentContactIds.includes(s._id) || (s.bedroom !== null && scope.parentBedrooms.includes(s.bedroom)) ? "contact" : "none";
  }
  if (scope.staffId === s._id) return "full";
  // the vest helper reaches everyone by phone, and nothing more
  if (scope.vestHelper) return "contact";
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
  // parents see the programme, never who does what
  if (isParent(scope)) return { ...e, roles: [], assignments: [] };
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
