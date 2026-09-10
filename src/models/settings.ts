import { getDb } from "../db";
import type { BusHelperList, CheckinWindow, ParentContact, Settings, StaffList } from "../types";

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
  notifications: { bedroomChanges: true, roleChanges: true, checkinConfirmation: true },
  checkinWindow: { from: null, until: null },
  checkinHelpers: { staffIds: [] },
  busHelpers: { helpers: [] },
  organizers: { staffIds: [] },
  medicalStaff: { staffIds: [] },
  parentContacts: [],
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
    medicalStaff: toStaffList(doc.medicalStaff),
    parentContacts: toParentContacts(doc.parentContacts),
    notifications: {
      bedroomChanges: typeof n.bedroomChanges === "boolean" ? n.bedroomChanges : DEFAULT_SETTINGS.notifications.bedroomChanges,
      roleChanges: typeof n.roleChanges === "boolean" ? n.roleChanges : DEFAULT_SETTINGS.notifications.roleChanges,
      checkinConfirmation: typeof n.checkinConfirmation === "boolean" ? n.checkinConfirmation : DEFAULT_SETTINGS.notifications.checkinConfirmation,
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
