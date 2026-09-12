export const ROLES = ["parent", "staff", "health_staff", "admin"] as const;
export type Role = (typeof ROLES)[number];

export interface OtpState {
  /** how the code was delivered: "comtele" (real SMS) or "local" (dev mock — console only) */
  provider: "comtele" | "local";
  /** sha256 hash of the code (always generated server-side) */
  codeHash?: string;
  /** the role the user picked when requesting the code */
  requestedRole: Role;
  requestedAt: Date;
  expiresAt: Date;
  attempts: number;
}

export interface User {
  _id: string;
  name: string;
  phone: string; // E.164, e.g. +5511981234567 (always Brazilian mobile)
  /** the SAME person can hold multiple roles (e.g. parent + staff + admin) */
  roles: Role[];
  createdAt: Date;
  updatedAt: Date;
  otp?: OtpState;
  /** set when the account is frozen after too many wrong OTP attempts */
  frozenUntil?: Date;
}

/** User shape returned to the client (never leaks OTP internals) */
export interface PublicUser {
  id: string;
  name: string;
  phone: string;
  roles: Role[];
}

/** PublicUser + the role chosen at login (the "active" one for this session) */
export type SessionUser = PublicUser & { activeRole: Role };

// ── Categories (admin-managed enumerations) ──────────────────────────────

/** Who a category applies to: campers (kids), staff members, or both. */
export const CATEGORY_AUDIENCES = ["camper", "staff"] as const;
export type CategoryAudience = (typeof CATEGORY_AUDIENCES)[number];

/** Whether a person picks ONE option (team) or MANY (allergies). */
export const CATEGORY_SELECTIONS = ["single", "multiple"] as const;
export type CategorySelection = (typeof CATEGORY_SELECTIONS)[number];

export interface CategoryOption {
  id: string;
  label: string;
  order: number;
  /** inactive options are hidden from forms but kept for existing records */
  active: boolean;
}

/**
 * A category is ALWAYS an enumeration: the admin defines the closed list of
 * options (e.g. teams, transport, bunk position) and camper/staff forms pick
 * from it — never a free-text field.
 */
export interface Category {
  _id: string;
  /** stable slug used by forms to reference the category (never changes on rename) */
  key: string;
  name: string;
  emoji: string;
  description?: string;
  appliesTo: CategoryAudience[];
  selection: CategorySelection;
  options: CategoryOption[];
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

// ── Bedrooms (quartos) ──────────────────────────────────────────────

/** Which wing a bedroom belongs to — drives who can be assigned to it. */
export const BEDROOM_GROUPS = ["girls", "boys", "staff"] as const;
export type BedroomGroup = (typeof BEDROOM_GROUPS)[number];

/**
 * Bedrooms are NOT a category: each has its own bed layout (how many bunk
 * beds and how many single beds), which defines its capacity.
 */
export interface Bedroom {
  _id: string;
  /** door label, e.g. "103" */
  name: string;
  group: BedroomGroup;
  /** beliches — each sleeps 2 (top + bottom) */
  bunkBeds: number;
  /** camas de solteiro — each sleeps 1 */
  singleBeds: number;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}

export function bedroomCapacity(b: Pick<Bedroom, "bunkBeds" | "singleBeds">): number {
  return b.bunkBeds * 2 + b.singleBeds;
}

// ── Staff (equipe / voluntários) ────────────────────────────────────────

/**
 * Category keys (see scripts/seedCategories.ts) that feed each staff field.
 * The staff record stores the chosen OPTION ids; labels come from the category.
 */
export const STAFF_CATEGORY_KEYS = {
  team: "equipe",
  transportation: "transporte",
  allergies: "alergias",
  drugAllergies: "alergia-medicamentos",
  healthIssues: "condicao-cronica",
} as const;

export interface Staff {
  _id: string;
  name: string;
  /** E.164 — null while the person hasn't registered a phone yet */
  phone: string | null;
  /** inactive members are kept for history but hidden from the default lists */
  active: boolean;
  /** single-choice category option ids */
  team: string | null;
  transportation: string | null;
  /** id of a Bedroom document (not a category) */
  bedroom: string | null;
  /** "observações": multi-choice option ids + free text */
  allergies: string[];
  /** category option ids (alergia-medicamentos) */
  drugAllergies: string[];
  foodRestrictions: string;
  healthIssues: string[];
  medicines: string;
  /** free-text health/allergy remarks (e.g. from the registration form) */
  healthNotes: string;
  /** set when the person arrived on departure day */
  checkin: CamperCheckin | null;
  /**
   * Preparação items the person ticked as done: "section:<id>" for a general
   * section, "role:<id>" for a role's preparation. Their own checklist —
   * only they (and the admin) see it.
   */
  prepDone: string[];
  /** when the welcome SMS (app link) went out — null until then; it is sent ONCE, ever (see services/notify.ts syncWelcomes) */
  welcomeSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── Campers (acampantes / crianças) ───────────────────────────────────

export const CAMPER_CATEGORY_KEYS = {
  team: "equipe",
  transportation: "transporte",
  bed: "cama",
  allergies: "alergias",
  drugAllergies: "alergia-medicamentos",
  healthIssues: "condicao-cronica",
} as const;

export interface Camper {
  _id: string;
  name: string;
  /** "YYYY-MM-DD" or null */
  birthDate: string | null;
  /** "F" | "M" | null */
  sex: CamperSex | null;
  cpf: string;
  rg: string;
  school: string;
  schoolGrade: string;
  /** which church the kid attends (free text) */
  church: string;
  /** who invited the kid (free text) */
  invitedBy: string;
  /** the "tio(a)" assigned to the kid (free text, from the registration system) */
  caretaker: string;
  /** token printed on the kid's QR badge (from the registration system) */
  qrToken: string;
  /** id of the kid in the registration system (Supabase) — for re-syncs */
  externalId: string;
  /** category option ids */
  team: string | null;
  transportation: string | null;
  bed: string | null;
  /** Bedroom id */
  bedroom: string | null;
  /** kilograms (e.g. 28.5) or null */
  weightKg: number | null;
  allergies: string[];
  /** category option ids (alergia-medicamentos) */
  drugAllergies: string[];
  healthIssues: string[];
  medicines: string;
  foodRestrictions: string;
  healthNotes: string;
  generalNotes: string;
  /** who the kid would like to share the room with (free text from the form) */
  bedroomPreference: string;
  insurance: string;
  insuranceCard: string;
  emergencyContact: string;
  guardianName: string;
  /** E.164 or null */
  guardianPhone: string | null;
  guardianCpf: string;
  guardianEmail: string;
  /** set when the kid arrived at the church and the parent confirmed the registration data */
  checkin: CamperCheckin | null;
  /** set when the kid boarded the bus (the roll call done inside the vehicle) */
  busCheckin: CamperCheckin | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CamperSex = "F" | "M";

export interface CamperCheckin {
  at: Date;
  byUserId: string;
  byName: string;
  byRole: Role;
}

// ── Occurrences (incident / situation records) ──────────────────────────

/** Name snapshot kept with an occurrence so its history survives later renames or deletions. */
export interface OccurrencePerson {
  id: string;
  name: string;
}

/**
 * A record of something that happened during camp. Admins and the medical
 * team create and read them. An occurrence may involve staff, campers, both,
 * or neither; records without a camper are restricted to admins.
 */
export interface Occurrence {
  _id: string;
  campers: OccurrencePerson[];
  staff: OccurrencePerson[];
  /** sanitized HTML, including uploaded images */
  description: string;
  createdByUserId: string;
  createdByName: string;
  createdByRole: Role;
  createdAt: Date;
}

/** The two roll calls on departure day: at the church gate, then inside the bus. */
export const CHECKIN_KINDS = ["church", "bus"] as const;
export type CheckinKind = (typeof CHECKIN_KINDS)[number];

/** Permanent audit trail of every check-in and undo (survives the undo itself). */
export interface CheckinLog {
  _id: string;
  /** "camper" (default) or "staff" — which collection `camperId` points at */
  who?: "camper" | "staff";
  camperId: string;
  camperName: string;
  kind: CheckinKind;
  action: "checkin" | "undo";
  at: Date;
  byUserId: string;
  byName: string;
  byRole: Role;
}

// ── Schedule (programação): events + the roles staff fulfil in them ───────

/**
 * A role (função) a staff member can be assigned to during an event, e.g.
 * "Cuidar das crianças", "Base 3", "Coringa Belém". Defined ONCE and reused
 * across events; `instructions` is sanitized HTML written in the admin WYSIWYG
 * and shown to the staff member so they know what to do.
 */
export interface ScheduleRole {
  _id: string;
  name: string;
  emoji: string;
  /** sanitized HTML (may be empty) */
  instructions: string;
  /**
   * sanitized HTML (may be empty): what a person in this role must bring,
   * wear or prepare BEFORE the camp ("green army-style shirt + hat"). Shown
   * in the Preparação page, not in the programme.
   */
  preparation: string;
  /**
   * When true this role applies to EVERY active staff member in the events
   * that include it (e.g. "Cuidar das crianças", "Ajudar a arrumar o quarto"),
   * except those explicitly assigned another role in that event. No
   * per-person assignments are needed.
   */
  forEveryone: boolean;
  /** whether an assignment of this role carries a per-person detail (team, base number, shift…) */
  hasDetail: boolean;
  /** placeholder / hint for that detail, e.g. "Time Belém", "Base 3", "14h–14h45" */
  detailPlaceholder: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A staff member scaled into a role of an event. `detail` holds the specifics
 *  the generic role doesn't (team name, base/colour number, shift). */
export interface EventAssignment {
  staffId: string;
  roleId: string;
  detail: string;
}

/** A moment of the camp programme: "12/09 · 14:00 Piscina". */
export interface CampEvent {
  _id: string;
  /** calendar date "YYYY-MM-DD" */
  date: string;
  title: string;
  emoji: string;
  /** "HH:mm" */
  startTime: string;
  /** "HH:mm" or null when open-ended */
  endTime: string | null;
  notes: string;
  /** ids of the roles staff fulfil in this event */
  roles: string[];
  assignments: EventAssignment[];
  createdAt: Date;
  updatedAt: Date;
}

// ── Preparation (preparação): what the team must know / bring before the camp ──

/**
 * A block of the Preparação page, written by the admin in the WYSIWYG
 * ("O que levar", "Chegada na igreja", "Uniforme"…). Shown to the whole
 * team, in `order`. Role-specific preparation lives on ScheduleRole.preparation.
 */
export interface PrepSection {
  _id: string;
  title: string;
  emoji: string;
  /** sanitized HTML (may include uploaded images) */
  content: string;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A general instructions DOCUMENT for the whole camp ("Regras do
 * acampamento", "Plano de emergência", "Rotina do dia"…), written by the
 * admin in the WYSIWYG editor and read by every team member.
 */
export interface InstructionDoc {
  _id: string;
  title: string;
  emoji: string;
  /** sanitized HTML (may include uploaded images) — can be long */
  content: string;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

/** An image uploaded through the WYSIWYG editor (kept in MongoDB, served by GET /api/files/:id). */
export interface StoredFile {
  /** random hex id — unguessable, so the GET route needs no auth (img tags can't send headers) */
  _id: string;
  name: string;
  /** MIME type, e.g. image/jpeg */
  type: string;
  size: number;
  byUserId: string;
  createdAt: Date;
}

// ── Settings (admin-managed, one document for the whole camp) ─────────────

/** Where the team must be to check themselves in on departure day. */
export interface CheckinLocation {
  lat: number;
  lng: number;
  /** how far from the point (in metres) still counts as "at the church" */
  radiusM: number;
}

/** Which changes are texted (SMS) to the team members concerned (see services/notify.ts). */
export interface NotificationSettings {
  /** a kid enters / leaves / is created in / removed from the person's bedroom */
  bedroomChanges: boolean;
  /** the person is assigned, reassigned or removed from an event role, or that event moves / is deleted */
  roleChanges: boolean;
  /** the person's church check-in was recorded (by themselves or by the admin roll call) */
  checkinConfirmation: boolean;
  /** an Instruções document / Preparação section was created or edited, or the instructions / preparation text of one of the person's roles changed */
  contentChanges: boolean;
  /** the person's OWN allocation changed: bedroom, team or vehicle (bus) */
  staffChanges: boolean;
  /** the person was added to the team, or to an admin list (organizer, check-in / bus helper, medical, parent contact) — always carries the app link */
  enrolments: boolean;
  /** an occurrence was registered (by the admin or the medical team) — every admin is texted */
  occurrences: boolean;
  /** at `settings.checkinReminder.at` the WHOLE team is reminded to do their check-in (nothing goes out while the date is unset) */
  checkinReminder: boolean;
}

/** One-shot reminder to the whole team to do their check-in. */
export interface CheckinReminder {
  /** when to text everyone; null = no reminder */
  at: Date | null;
  /** when it actually went out (sent ONCE per `at`; reset whenever `at` changes) */
  sentAt: Date | null;
}

/** The time window in which the check-in helpers (church AND bus) may act. Both ends must be set for it to ever open. */
export interface CheckinWindow {
  from: Date | null;
  until: Date | null;
}

/**
 * Team members allowed to run one of the KIDS' roll calls (normally an admin
 * job) while `checkinWindow` is open:
 *
 *   checkinHelpers — church check-in: each listed person receives every
 *                    camper (health included — they confirm it with the parents)
 *                    and every bedroom.
 *   busHelpers     — bus roll call: each entry links a person to ONE vehicle
 *                    (a transportation option). The person stands at the DOOR
 *                    of that vehicle confirming the kid the parents handed over
 *                    is now with our team — they do not necessarily ride in it,
 *                    so this link is independent from `staff.transportation`.
 *                    They receive the campers of THAT vehicle as NAME-ONLY
 *                    records (name, age, room, team, check-in stamps). Never
 *                    health data.
 *
 * Outside the window they are back to their own room.
 */
export interface StaffList {
  staffIds: string[];
}

/** One bus helper at the door of one vehicle (a `transporte` category option id). */
export interface BusHelper {
  staffId: string;
  vehicleId: string;
}

export interface BusHelperList {
  helpers: BusHelper[];
}

/** A staff member and the purpose shown beside them on the future parent contacts screen. */
export interface ParentContact {
  /** stable client-generated id so entries can be edited without relying on their position */
  id: string;
  /** purpose shown to parents, e.g. "Coordenação do acampamento" */
  title: string;
  staffId: string;
}

export interface Settings {
  checkinLocation: CheckinLocation;
  notifications: NotificationSettings;
  checkinWindow: CheckinWindow;
  checkinHelpers: StaffList;
  busHelpers: BusHelperList;
  /**
   * Team members who ORGANIZE the programme (no time window): they may
   * create / edit / delete events and roles and assign anyone to a função,
   * and they see every staff member in full (health included) — but they
   * cannot add, edit or remove staff, nor download the list.
   */
  organizers: StaffList;
  /**
   * MEDICAL team (no time window): they see EVERY camper in full (health
   * included), every bedroom and every vehicle, the whole time — before,
   * during and after the camp. Read-only: they never write campers, rooms or
   * check-ins.
   */
  medicalStaff: StaffList;
  /** ordered contacts that will be shared with parents */
  parentContacts: ParentContact[];
  /**
   * When ORDINARY team members (not organizers, check-in helpers, medical
   * team or parent contacts) may use the app. Both ends null = always. Outside
   * it the server sends them nothing (see services/scope.ts).
   */
  staffAccessWindow: CheckinWindow;
  /** test mode: church + bus check-in behave as if the window were open (the team's own self check-in is NOT affected) */
  checkinTestMode: boolean;
  /**
   * The kids' room allocation is still a DRAFT: while true, ordinary room
   * caretakers do not receive the kids of their room (admin, medical team and
   * check-in helpers are unaffected) and no "kid moved room" SMS goes out.
   */
  kidsRoomsDraft: boolean;
  /** the "do your check-in" SMS to the whole team, scheduled for one instant */
  checkinReminder: CheckinReminder;
  updatedAt: Date | null;
}

export interface Session {
  _id: string;
  userId: string;
  /** the role selected by the user at login */
  role: Role;
  createdAt: Date;
  expiresAt: Date;
}
