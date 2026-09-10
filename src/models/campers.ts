import { ObjectId } from "mongodb";
import { getDb } from "../db";
import type { Camper, CamperCheckin, CheckinKind, CheckinLog } from "../types";

const LOG_COLLECTION = "checkinLog";

const COLLECTION = "campers";

function toCamper(doc: Record<string, unknown> | null): Camper | null {
  if (!doc) return null;
  const s = (k: string) => (doc[k] as string) ?? "";
  return {
    _id: (doc._id as ObjectId).toString(),
    name: doc.name as string,
    birthDate: (doc.birthDate as string) ?? null,
    team: (doc.team as string) ?? null,
    transportation: (doc.transportation as string) ?? null,
    bed: (doc.bed as string) ?? null,
    bedroom: (doc.bedroom as string) ?? null,
    weightKg: typeof doc.weightKg === "number" ? doc.weightKg : null,
    allergies: (doc.allergies as string[]) ?? [],
    drugAllergies: (doc.drugAllergies as string[]) ?? [],
    healthIssues: (doc.healthIssues as string[]) ?? [],
    medicines: s("medicines"),
    foodRestrictions: s("foodRestrictions"),
    healthNotes: s("healthNotes"),
    generalNotes: s("generalNotes"),
    bedroomPreference: s("bedroomPreference"),
    insurance: s("insurance"),
    insuranceCard: s("insuranceCard"),
    emergencyContact: s("emergencyContact"),
    guardianName: s("guardianName"),
    guardianPhone: (doc.guardianPhone as string) ?? null,
    checkin: toCheckin(doc.checkin),
    busCheckin: toCheckin(doc.busCheckin),
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

export function toCheckin(v: unknown): CamperCheckin | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!(o.at instanceof Date)) return null;
  return { at: o.at, byUserId: (o.byUserId as string) ?? "", byName: (o.byName as string) ?? "", byRole: (o.byRole as CamperCheckin["byRole"]) ?? "staff" };
}

export type CamperData = Omit<Camper, "_id" | "createdAt" | "updatedAt" | "checkin" | "busCheckin">;

/** which document field holds each kind of check-in */
export const CHECKIN_FIELD: Record<CheckinKind, "checkin" | "busCheckin"> = { church: "checkin", bus: "busCheckin" };

export async function listCampers(filter: { bedroom?: string } = {}): Promise<Camper[]> {
  const db = await getDb();
  const query: Record<string, unknown> = {};
  if (filter.bedroom) query.bedroom = filter.bedroom;
  const docs = await db.collection(COLLECTION).find(query).collation({ locale: "pt", strength: 1 }).sort({ name: 1 }).toArray();
  return docs.map((d) => toCamper(d as Record<string, unknown>)!);
}

export async function findCamperById(id: string): Promise<Camper | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  return toCamper(await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) }));
}

export async function findCamperByName(name: string): Promise<Camper | null> {
  const db = await getDb();
  return toCamper(await db.collection(COLLECTION).findOne({ name }, { collation: { locale: "pt", strength: 1 } }));
}

export async function insertCamper(data: CamperData): Promise<Camper> {
  const db = await getDb();
  const now = new Date();
  const { insertedId } = await db.collection(COLLECTION).insertOne({ ...data, createdAt: now, updatedAt: now });
  return { ...data, checkin: null, busCheckin: null, _id: insertedId.toString(), createdAt: now, updatedAt: now };
}

export async function updateCamper(id: string, patch: Partial<CamperData>): Promise<Camper | null> {
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: "after" });
  return toCamper(res as Record<string, unknown> | null);
}

/** Marks the kid as arrived (church) or boarded (bus); `null` undoes it. */
export async function setCamperCheckin(id: string, kind: CheckinKind, checkin: CamperCheckin | null): Promise<Camper | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { [CHECKIN_FIELD[kind]]: checkin, updatedAt: new Date() } }, { returnDocument: "after" });
  return toCamper(res as Record<string, unknown> | null);
}

/** Append-only audit line: who did (or undid) a check-in and when. */
export async function logCheckin(entry: Omit<CheckinLog, "_id">): Promise<void> {
  const db = await getDb();
  await db.collection(LOG_COLLECTION).insertOne(entry);
}

/** Audit trail, newest first (optionally for one kid). */
export async function listCheckinLog(camperId?: string): Promise<CheckinLog[]> {
  const db = await getDb();
  const docs = await db
    .collection(LOG_COLLECTION)
    .find(camperId ? { camperId } : {})
    .sort({ at: -1 })
    .toArray();
  return docs.map((d) => ({ ...(d as unknown as CheckinLog), _id: (d._id as ObjectId).toString() }));
}

export async function deleteCamper(id: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });
  return res.deletedCount === 1;
}

/** How many campers are in each bedroom. */
export async function countCampersPerBedroom(): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db
    .collection(COLLECTION)
    .aggregate<{ _id: string; n: number }>([{ $match: { bedroom: { $type: "string" } } }, { $group: { _id: "$bedroom", n: { $sum: 1 } } }])
    .toArray();
  return new Map(rows.map((r) => [r._id, r.n]));
}

export async function ensureCamperIndexes(): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).createIndex({ name: 1 }, { collation: { locale: "pt", strength: 1 } });
  await db.collection(COLLECTION).createIndex({ bedroom: 1 });
  await db.collection(COLLECTION).createIndex({ team: 1 });
  await db.collection(LOG_COLLECTION).createIndex({ camperId: 1, at: -1 });
  await db.collection(LOG_COLLECTION).createIndex({ at: -1 });
}
