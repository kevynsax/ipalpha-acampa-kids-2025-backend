import { ObjectId } from "mongodb";
import { getDb } from "../db";
import type { CamperCheckin, Staff, VestStatus } from "../types";
import { ROOM_ROLES } from "../types";
import { toCheckin } from "./campers";

const COLLECTION = "staff";

function toStaff(doc: Record<string, unknown> | null): Staff | null {
  if (!doc) return null;
  return {
    _id: (doc._id as ObjectId).toString(),
    name: doc.name as string,
    phone: (doc.phone as string) ?? null,
    active: (doc.active as boolean) ?? true,
    team: (doc.team as string) ?? null,
    bedroom: (doc.bedroom as string) ?? null,
    roomRole: ROOM_ROLES.includes(doc.roomRole as Staff["roomRole"]) ? (doc.roomRole as Staff["roomRole"]) : "helper",
    transportation: (doc.transportation as string) ?? null,
    allergies: (doc.allergies as string[]) ?? [],
    drugAllergies: (doc.drugAllergies as string[]) ?? [],
    foodRestrictions: (doc.foodRestrictions as string) ?? "",
    healthIssues: (doc.healthIssues as string[]) ?? [],
    medicines: (doc.medicines as string) ?? "",
    healthNotes: (doc.healthNotes as string) ?? "",
    checkin: toCheckin(doc.checkin),
    vest: toVest(doc.vest),
    prepDone: (doc.prepDone as string[]) ?? [],
    welcomeSentAt: (doc.welcomeSentAt as Date) ?? null,
    foreignLookupCount: typeof doc.foreignLookupCount === "number" ? (doc.foreignLookupCount as number) : 0,
    foreignLookupNames: Array.isArray(doc.foreignLookupNames) ? (doc.foreignLookupNames as string[]) : [],
    foreignLookupAlertedAt: (doc.foreignLookupAlertedAt as Date) ?? null,
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

function toVest(v: unknown): VestStatus {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const delivered = toCheckin(o.delivered);
  // a return without a delivery makes no sense: ignore it
  return { delivered, returned: delivered ? toCheckin(o.returned) : null };
}

export const NO_VEST: VestStatus = { delivered: null, returned: null };

export type StaffData = Omit<Staff, "_id" | "createdAt" | "updatedAt" | "checkin" | "vest" | "prepDone" | "welcomeSentAt" | "foreignLookupCount" | "foreignLookupNames" | "foreignLookupAlertedAt">;

export async function listStaff(filter: { active?: boolean } = {}): Promise<Staff[]> {
  const db = await getDb();
  const query: Record<string, unknown> = {};
  if (filter.active !== undefined) query.active = filter.active;
  const docs = await db
    .collection(COLLECTION)
    .find(query)
    .collation({ locale: "pt", strength: 1 })
    .sort({ name: 1 })
    .toArray();
  return docs.map((d) => toStaff(d as Record<string, unknown>)!);
}

export async function findStaffById(id: string): Promise<Staff | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  return toStaff(await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) }));
}

export async function findStaffByPhone(phone: string): Promise<Staff | null> {
  const db = await getDb();
  return toStaff(await db.collection(COLLECTION).findOne({ phone }));
}

export async function insertStaff(data: StaffData): Promise<Staff> {
  const db = await getDb();
  const now = new Date();
  const { insertedId } = await db.collection(COLLECTION).insertOne({ ...data, createdAt: now, updatedAt: now });
  return { ...data, checkin: null, vest: NO_VEST, prepDone: [], welcomeSentAt: null, foreignLookupCount: 0, foreignLookupNames: [], foreignLookupAlertedAt: null, _id: insertedId.toString(), createdAt: now, updatedAt: now };
}

export async function updateStaff(id: string, patch: Partial<StaffData>): Promise<Staff | null> {
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { ...patch, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
  return toStaff(res as Record<string, unknown> | null);
}

/** Marks the person as arrived (`null` undoes it). */
export async function setStaffCheckin(id: string, checkin: CamperCheckin | null): Promise<Staff | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { checkin, updatedAt: new Date() } }, { returnDocument: "after" });
  return toStaff(res as Record<string, unknown> | null);
}

/** Sets the vest (colete) status: delivered / returned stamps. */
export async function setStaffVest(id: string, vest: VestStatus): Promise<Staff | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { vest, updatedAt: new Date() } }, { returnDocument: "after" });
  return toStaff(res as Record<string, unknown> | null);
}

/** Clears every vest stamp (rehearsal reset). Returns how many had one. */
export async function resetStaffVests(): Promise<number> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).updateMany({ "vest.delivered": { $ne: null } }, { $set: { vest: NO_VEST, updatedAt: new Date() } });
  return res.modifiedCount;
}

/**
 * Marks the welcome SMS as sent — atomically, only if it was NOT sent yet.
 * Returns true when this call won (so the caller may send), false otherwise.
 */
export async function claimStaffWelcome(id: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const db = await getDb();
  const res = await db.collection(COLLECTION).updateOne({ _id: new ObjectId(id), welcomeSentAt: null }, { $set: { welcomeSentAt: new Date() } });
  return res.modifiedCount === 1;
}

/** Clears every team member's check-in (rehearsal reset). Returns how many had one. */
export async function resetStaffCheckins(): Promise<number> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).updateMany({ checkin: { $ne: null } }, { $set: { checkin: null, updatedAt: new Date() } });
  return res.modifiedCount;
}

/** Thresholds for out-of-scope emergency QR lookups (see routes/campers.ts lookup). */
export const FOREIGN_LOOKUP_ALERT_AT = 3;
export const FOREIGN_LOOKUP_BLOCK_AT = 5;
const FOREIGN_LOOKUP_NAMES_MAX = 20;

/**
 * Records one more DISTINCT out-of-scope kid for this staff member.
 * No-op (returns the current record) when `camperId` was already counted.
 * Returns null when the staff id is unknown.
 */
export async function recordForeignLookup(staffId: string, camperId: string, camperName: string): Promise<Staff | null> {
  if (!ObjectId.isValid(staffId)) return null;
  const db = await getDb();
  const current = await findStaffById(staffId);
  if (!current) return null;
  // kid ids live in a hidden array so re-scans of the same kid don't bump the counter
  const doc = await db.collection(COLLECTION).findOne({ _id: new ObjectId(staffId) });
  const seen = Array.isArray(doc?.foreignLookupCamperIds) ? (doc!.foreignLookupCamperIds as string[]) : [];
  if (seen.includes(camperId)) return current;
  const names = [...current.foreignLookupNames.filter((n) => n !== camperName), camperName].slice(-FOREIGN_LOOKUP_NAMES_MAX);
  const res = await db.collection(COLLECTION).findOneAndUpdate(
    { _id: new ObjectId(staffId) },
    {
      $inc: { foreignLookupCount: 1 },
      $addToSet: { foreignLookupCamperIds: camperId },
      $set: { foreignLookupNames: names, updatedAt: new Date() },
    },
    { returnDocument: "after" },
  );
  return toStaff(res as Record<string, unknown> | null);
}

/** Marks that the admins were already SMS'd about this person's out-of-scope scans (once until reset). */
export async function markForeignLookupAlerted(staffId: string): Promise<void> {
  if (!ObjectId.isValid(staffId)) return;
  const db = await getDb();
  await db.collection(COLLECTION).updateOne(
    { _id: new ObjectId(staffId), foreignLookupAlertedAt: null },
    { $set: { foreignLookupAlertedAt: new Date(), updatedAt: new Date() } },
  );
}

/** Zeroes every staff member's out-of-scope lookup counter (Settings → Geral). Returns how many had a count. */
export async function resetForeignLookups(): Promise<number> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).updateMany(
    { $or: [{ foreignLookupCount: { $gt: 0 } }, { foreignLookupCamperIds: { $exists: true, $ne: [] } }] },
    {
      $set: {
        foreignLookupCount: 0,
        foreignLookupNames: [],
        foreignLookupCamperIds: [],
        foreignLookupAlertedAt: null,
        updatedAt: new Date(),
      },
    },
  );
  return res.modifiedCount;
}

/** Staff members currently at / past the alert threshold (for the admin settings card). */
export async function listForeignLookupOffenders(minCount = FOREIGN_LOOKUP_ALERT_AT): Promise<Staff[]> {
  const db = await getDb();
  const docs = await db
    .collection(COLLECTION)
    .find({ foreignLookupCount: { $gte: minCount } })
    .collation({ locale: "pt", strength: 1 })
    .sort({ foreignLookupCount: -1, name: 1 })
    .toArray();
  return docs.map((d) => toStaff(d as Record<string, unknown>)!);
}

/** Ticks / unticks one Preparação item for the person. */
export async function setStaffPrepDone(id: string, key: string, done: boolean): Promise<Staff | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .findOneAndUpdate(
      { _id: new ObjectId(id) },
      (done ? { $addToSet: { prepDone: key }, $set: { updatedAt: new Date() } } : { $pull: { prepDone: key }, $set: { updatedAt: new Date() } }) as never,
      { returnDocument: "after" },
    );
  return toStaff(res as Record<string, unknown> | null);
}

export async function deleteStaff(id: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });
  return res.deletedCount === 1;
}

/**
 * Every admin account (users.roles ∋ "admin") also lives on the team roster,
 * so they get a room, food restrictions, a vest… like everyone else. Called at
 * boot: creates the missing records (matched by phone), never touches the
 * existing ones. Returns the number of records created.
 */
export async function ensureAdminsOnRoster(admins: { name: string; phone: string }[]): Promise<number> {
  let created = 0;
  for (const a of admins) {
    if (await findStaffByPhone(a.phone)) continue;
    await insertStaff({ name: a.name, phone: a.phone, active: true, team: null, bedroom: null, roomRole: "helper", transportation: null, allergies: [], drugAllergies: [], foodRestrictions: "", healthIssues: [], medicines: "", healthNotes: "" });
    created++;
  }
  return created;
}

export async function ensureStaffIndexes(): Promise<void> {
  const db = await getDb();
  // legacy index without partial filter (would reject a second null phone)
  try {
    await db.collection(COLLECTION).dropIndex("phone_1");
  } catch {
    // may not exist — fine
  }
  await db
    .collection(COLLECTION)
    .createIndex({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: "string" } } });
  await db.collection(COLLECTION).createIndex({ active: 1, name: 1 });
}
