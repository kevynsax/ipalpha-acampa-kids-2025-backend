import { getDb } from "../db";
import type { BusHelperList, CheckinReminder, CheckinWindow, ParentContact, Settings, StaffList } from "../types";

const COLLECTION = "settings";
/** the settings live in ONE document (there is a single camp) */
const DOC_ID = "global";

/** Igreja Presbiteriana em Alphaville — where the team meets on departure day. */
export const DEFAULT_SETTINGS: Settings = {
  checkinLocation: {
    lat: -23.48053637134259,
    lng: -46.83077891444747,
    radiusM: 300,
  },
  // every kind starts OFF: the admin switches on what they want texted
  notifications: { bedroomChanges: false, roleChanges: false, checkinConfirmation: false, contentChanges: false, parentContentChanges: false, staffChanges: false, enrolments: false, occurrences: false, checkinReminder: false, parentEdits: false, busCheckin: false, parentWelcome: false },
  checkinWindow: { from: null, until: null },
  checkinHelpers: { staffIds: [] },
  busHelpers: { helpers: [] },
  organizers: { staffIds: [] },
  gameOrganizers: { staffIds: [] },
  scoreHelpers: { staffIds: [] },
  medicalStaff: { staffIds: [] },
  vestHelpers: { staffIds: [] },
  parentContacts: [],
  staffAccessWindow: { from: null, until: null },
  parentAccessWindow: { from: null, until: null },
  checkinTestMode: false,
  kidsRoomsDraft: false,
  scoreDraft: false,
  checkinReminder: { at: null, sentAt: null },
  updatedAt: null,
};

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Is the check-in window open at `now`? (needs both ends) */
export function checkinWindowOpen(w: CheckinWindow, now = new Date()): boolean {
  return !!w.from && !!w.until && w.from <= now && now < w.until;
}

/** Is the ordinary team's access window open? Unlike the check-in window, an UNSET window means "always". */
export function staffAccessOpen(w: CheckinWindow, now = new Date()): boolean {
  if (!w.from && !w.until) return true;
  if (w.from && now < w.from) return false;
  if (w.until && now >= w.until) return false;
  return true;
}

function toStaffList(raw: unknown): StaffList {
  const h = (raw as Partial<Record<"staffIds", unknown>> | undefined) ?? {};
  return { staffIds: Array.isArray(h.staffIds) ? h.staffIds.filter((x): x is string => typeof x === "string") : [] };
}

/** `{ helpers: [{ staffId, vehicleId }] }` — older documents held `{ staffIds }` (helper rode in their own vehicle): those entries are dropped, the admin re-links them */
function toBusHelperList(raw: unknown): BusHelperList {
  const h = (raw as Partial<Record<"helpers", unknown>> | undefined) ?? {};
  if (!Array.isArray(h.helpers)) return { helpers: [] };
  const helpers = h.helpers
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null))
    .filter((x): x is Record<string, unknown> => !!x && typeof x.staffId === "string" && typeof x.vehicleId === "string")
    .map((x) => ({ staffId: x.staffId as string, vehicleId: x.vehicleId as string }));
  return { helpers };
}

function toWindow(raw: unknown): CheckinWindow {
  const w = (raw as Partial<Record<keyof CheckinWindow, unknown>> | undefined) ?? {};
  return { from: asDate(w.from), until: asDate(w.until) };
}

function toReminder(raw: unknown): CheckinReminder {
  const r = (raw as Partial<Record<keyof CheckinReminder, unknown>> | undefined) ?? {};
  return { at: asDate(r.at), sentAt: asDate(r.sentAt) };
}

function toParentContacts(raw: unknown): ParentContact[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null))
    .filter(
      (x): x is Record<string, unknown> =>
        !!x && typeof x.id === "string" && typeof x.title === "string" && typeof x.staffId === "string",
    )
    .map((x) => ({ id: x.id as string, title: x.title as string, staffId: x.staffId as string }));
}

function toSettings(doc: Record<string, unknown> | null): Settings {
  if (!doc) return DEFAULT_SETTINGS;
  const loc = (doc.checkinLocation as Partial<Settings["checkinLocation"]> | undefined) ?? {};
  const n = (doc.notifications as Partial<Settings["notifications"]> | undefined) ?? {};
  return {
    checkinWindow: toWindow(doc.checkinWindow),
    checkinHelpers: toStaffList(doc.checkinHelpers),
    busHelpers: toBusHelperList(doc.busHelpers),
    organizers: toStaffList(doc.organizers),
    gameOrganizers: toStaffList(doc.gameOrganizers),
    scoreHelpers: toStaffList(doc.scoreHelpers),
    medicalStaff: toStaffList(doc.medicalStaff),
    vestHelpers: toStaffList(doc.vestHelpers),
    parentContacts: toParentContacts(doc.parentContacts),
    staffAccessWindow: toWindow(doc.staffAccessWindow),
    parentAccessWindow: toWindow(doc.parentAccessWindow),
    checkinTestMode: doc.checkinTestMode === true,
    kidsRoomsDraft: doc.kidsRoomsDraft === true,
    scoreDraft: doc.scoreDraft === true,
    checkinReminder: toReminder(doc.checkinReminder),
    notifications: {
      bedroomChanges: typeof n.bedroomChanges === "boolean" ? n.bedroomChanges : DEFAULT_SETTINGS.notifications.bedroomChanges,
      roleChanges: typeof n.roleChanges === "boolean" ? n.roleChanges : DEFAULT_SETTINGS.notifications.roleChanges,
      checkinConfirmation: typeof n.checkinConfirmation === "boolean" ? n.checkinConfirmation : DEFAULT_SETTINGS.notifications.checkinConfirmation,
      contentChanges: typeof n.contentChanges === "boolean" ? n.contentChanges : DEFAULT_SETTINGS.notifications.contentChanges,
      parentContentChanges: typeof n.parentContentChanges === "boolean" ? n.parentContentChanges : DEFAULT_SETTINGS.notifications.parentContentChanges,
      staffChanges: typeof n.staffChanges === "boolean" ? n.staffChanges : DEFAULT_SETTINGS.notifications.staffChanges,
      enrolments: typeof n.enrolments === "boolean" ? n.enrolments : DEFAULT_SETTINGS.notifications.enrolments,
      occurrences: typeof n.occurrences === "boolean" ? n.occurrences : DEFAULT_SETTINGS.notifications.occurrences,
      checkinReminder: typeof n.checkinReminder === "boolean" ? n.checkinReminder : DEFAULT_SETTINGS.notifications.checkinReminder,
      parentEdits: typeof n.parentEdits === "boolean" ? n.parentEdits : DEFAULT_SETTINGS.notifications.parentEdits,
      busCheckin: typeof n.busCheckin === "boolean" ? n.busCheckin : DEFAULT_SETTINGS.notifications.busCheckin,
      parentWelcome: typeof n.parentWelcome === "boolean" ? n.parentWelcome : DEFAULT_SETTINGS.notifications.parentWelcome,
    },
    checkinLocation: {
      lat: typeof loc.lat === "number" ? loc.lat : DEFAULT_SETTINGS.checkinLocation.lat,
      lng: typeof loc.lng === "number" ? loc.lng : DEFAULT_SETTINGS.checkinLocation.lng,
      radiusM: typeof loc.radiusM === "number" ? loc.radiusM : DEFAULT_SETTINGS.checkinLocation.radiusM,
    },
    updatedAt: (doc.updatedAt as Date) ?? null,
  };
}

/** Always returns something: the defaults until an admin saves for the first time. */
export async function getSettings(): Promise<Settings> {
  const db = await getDb();
  return toSettings((await db.collection(COLLECTION).findOne({ _id: DOC_ID as never })) as Record<string, unknown> | null);
}

export async function updateSettings(patch: Partial<Omit<Settings, "updatedAt">>): Promise<Settings> {
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .findOneAndUpdate({ _id: DOC_ID as never }, { $set: { ...patch, updatedAt: new Date() } }, { upsert: true, returnDocument: "after" });
  return toSettings(res as Record<string, unknown> | null);
}

/**
 * Marks the check-in reminder scheduled for `at` as sent — atomically, only
 * if that exact instant is still scheduled and was NOT sent yet. Returns true
 * when this call won (so the caller may text the team).
 */
export async function claimCheckinReminder(at: Date): Promise<boolean> {
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .updateOne({ _id: DOC_ID as never, "checkinReminder.at": at, "checkinReminder.sentAt": null }, { $set: { "checkinReminder.sentAt": new Date() } });
  return res.modifiedCount === 1;
}
