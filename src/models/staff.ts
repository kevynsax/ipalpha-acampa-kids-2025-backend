import { ObjectId } from "mongodb";
import { getDb } from "../db";
import type { CamperCheckin, Staff } from "../types";
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
    transportation: (doc.transportation as string) ?? null,
    allergies: (doc.allergies as string[]) ?? [],
    drugAllergies: (doc.drugAllergies as string[]) ?? [],
    foodRestrictions: (doc.foodRestrictions as string) ?? "",
    healthIssues: (doc.healthIssues as string[]) ?? [],
    medicines: (doc.medicines as string) ?? "",
    healthNotes: (doc.healthNotes as string) ?? "",
    checkin: toCheckin(doc.checkin),
    prepDone: (doc.prepDone as string[]) ?? [],
    welcomeSentAt: (doc.welcomeSentAt as Date) ?? null,
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

export type StaffData = Omit<Staff, "_id" | "createdAt" | "updatedAt" | "checkin" | "prepDone" | "welcomeSentAt">;

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
  return { ...data, checkin: null, prepDone: [], welcomeSentAt: null, _id: insertedId.toString(), createdAt: now, updatedAt: now };
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
