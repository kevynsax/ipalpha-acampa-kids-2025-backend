import { ObjectId } from "mongodb";
import { getDb } from "../db";
import type { Camper, CamperChangeLog, CamperCheckin, CamperSex, CheckinKind, CheckinLog, Medication } from "../types";
import { formatCpf } from "../utils";

const LOG_COLLECTION = "checkinLog";
/** every edit a PARENT made to their kid (append-only) */
const CHANGE_LOG_COLLECTION = "camperChangeLog";

const COLLECTION = "campers";

function toCamper(doc: Record<string, unknown> | null): Camper | null {
  if (!doc) return null;
  const s = (k: string) => (doc[k] as string) ?? "";
  return {
    _id: (doc._id as ObjectId).toString(),
    name: doc.name as string,
    birthDate: (doc.birthDate as string) ?? null,
    sex: doc.sex === "F" || doc.sex === "M" ? (doc.sex as CamperSex) : null,
    cpf: formatCpf(s("cpf")),
    rg: s("rg"),
    school: s("school"),
    schoolGrade: s("schoolGrade"),
    church: s("church"),
    invitedBy: s("invitedBy"),
    caretakerId: (doc.caretakerId as string) ?? null,
    qrToken: s("qrToken"),
    externalId: s("externalId"),
    team: (doc.team as string) ?? null,
    transportation: (doc.transportation as string) ?? null,
    bed: (doc.bed as string) ?? null,
    bedroom: (doc.bedroom as string) ?? null,
    weightKg: typeof doc.weightKg === "number" ? doc.weightKg : null,
    allergies: (doc.allergies as string[]) ?? [],
    drugAllergies: (doc.drugAllergies as string[]) ?? [],
    healthIssues: (doc.healthIssues as string[]) ?? [],
    neurodivergent: doc.neurodivergent === true,
    medications: toMedications(doc.medications),
    foodRestrictions: s("foodRestrictions"),
    healthNotes: s("healthNotes"),
    generalNotes: s("generalNotes"),
    bedroomPreference: s("bedroomPreference"),
    insurance: s("insurance"),
    insuranceCard: s("insuranceCard"),
    emergencyContact: s("emergencyContact"),
    guardianName: s("guardianName"),
    guardianPhone: (doc.guardianPhone as string) ?? null,
    guardianCpf: formatCpf(s("guardianCpf")),
    guardianEmail: s("guardianEmail"),
    checkin: toCheckin(doc.checkin),
    busCheckin: toCheckin(doc.busCheckin),
    busReturnCheckin: toCheckin(doc.busReturnCheckin),
    parentEditedAt: (doc.parentEditedAt as Date) ?? null,
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

export function toMedications(v: unknown): Medication[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m) => ({
      name: (m.name as string) ?? "",
      dose: (m.dose as string) ?? "",
      times: Array.isArray(m.times) ? (m.times as string[]) : [],
      asNeeded: m.asNeeded === true,
      notes: (m.notes as string) ?? "",
    }))
    .filter((m) => m.name);
}

export function toCheckin(v: unknown): CamperCheckin | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!(o.at instanceof Date)) return null;
  return { at: o.at, byUserId: (o.byUserId as string) ?? "", byName: (o.byName as string) ?? "", byRole: (o.byRole as CamperCheckin["byRole"]) ?? "staff", ...(typeof o.note === "string" && o.note ? { note: o.note } : {}) };
}

export type CamperData = Omit<Camper, "_id" | "createdAt" | "updatedAt" | "checkin" | "busCheckin" | "busReturnCheckin" | "parentEditedAt">;

/** which document field holds each kind of check-in */
export const CHECKIN_FIELD: Record<CheckinKind, "checkin" | "busCheckin" | "busReturnCheckin"> = {
  church: "checkin",
  bus: "busCheckin",
  bus_return: "busReturnCheckin",
};

export async function listCampers(filter: { bedroom?: string; caretakerId?: string } = {}): Promise<Camper[]> {
  const db = await getDb();
  const query: Record<string, unknown> = {};
  if (filter.bedroom) query.bedroom = filter.bedroom;
  if (filter.caretakerId) query.caretakerId = filter.caretakerId;
  const docs = await db.collection(COLLECTION).find(query).collation({ locale: "pt", strength: 1 }).sort({ name: 1 }).toArray();
  return docs.map((d) => toCamper(d as Record<string, unknown>)!);
}

export async function findCamperById(id: string): Promise<Camper | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  return toCamper(await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) }));
}

export async function findCamperByExternalId(externalId: string): Promise<Camper | null> {
  const db = await getDb();
  return toCamper(await db.collection(COLLECTION).findOne({ externalId }));
}

export async function findCamperByQrToken(qrToken: string): Promise<Camper | null> {
  const db = await getDb();
  return toCamper(await db.collection(COLLECTION).findOne({ qrToken }));
}

export async function findCamperByName(name: string): Promise<Camper | null> {
  const db = await getDb();
  return toCamper(await db.collection(COLLECTION).findOne({ name }, { collation: { locale: "pt", strength: 1 } }));
}

export async function insertCamper(data: CamperData): Promise<Camper> {
  const db = await getDb();
  const now = new Date();
  const { insertedId } = await db.collection(COLLECTION).insertOne({ ...data, createdAt: now, updatedAt: now });
  return { ...data, checkin: null, busCheckin: null, busReturnCheckin: null, parentEditedAt: null, _id: insertedId.toString(), createdAt: now, updatedAt: now };
}

export async function updateCamper(id: string, patch: Partial<CamperData>): Promise<Camper | null> {
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: "after" });
  return toCamper(res as Record<string, unknown> | null);
}

/** Every kid of caretaker `from` goes to caretaker `to` (null = orphans). Returns how many moved. */
export async function reassignCampers(from: string, to: string | null, extra: Partial<CamperData> = {}): Promise<number> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).updateMany({ caretakerId: from }, { $set: { ...extra, caretakerId: to, updatedAt: new Date() } });
  return res.modifiedCount;
}

/** The given kids (by id) get caretaker `to` (null = orphans). */
export async function setCaretakerOf(ids: string[], to: string | null): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  await db.collection(COLLECTION).updateMany({ _id: { $in: ids.map((id) => new ObjectId(id)) } }, { $set: { caretakerId: to, updatedAt: new Date() } });
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

/** Clears church + both bus check-ins of every kid (rehearsal reset). Returns how many had one. */
export async function resetCamperCheckins(): Promise<number> {
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .updateMany(
      { $or: [{ checkin: { $ne: null } }, { busCheckin: { $ne: null } }, { busReturnCheckin: { $ne: null } }] },
      { $set: { checkin: null, busCheckin: null, busReturnCheckin: null, updatedAt: new Date() } },
    );
  return res.modifiedCount;
}

/** Wipes the audit trail (rehearsal reset). */
export async function clearCheckinLog(): Promise<void> {
  const db = await getDb();
  await db.collection(LOG_COLLECTION).deleteMany({});
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

/** Append-only: one line per parent edit, with the fields that changed (before / after). Also stamps the kid's `parentEditedAt`. */
export async function logCamperChange(entry: Omit<CamperChangeLog, "_id">): Promise<void> {
  const db = await getDb();
  await db.collection(CHANGE_LOG_COLLECTION).insertOne(entry);
  await db.collection(COLLECTION).updateOne({ _id: new ObjectId(entry.camperId) }, { $set: { parentEditedAt: entry.at } });
}

/** Boot: kids edited by a parent BEFORE `parentEditedAt` existed get the stamp from their newest log line. */
export async function backfillParentEditedAt(): Promise<number> {
  const db = await getDb();
  const latest = await db.collection(CHANGE_LOG_COLLECTION).aggregate<{ _id: string; at: Date }>([{ $group: { _id: "$camperId", at: { $max: "$at" } } }]).toArray();
  let n = 0;
  for (const { _id, at } of latest) {
    if (!ObjectId.isValid(_id)) continue;
    const res = await db.collection(COLLECTION).updateOne({ _id: new ObjectId(_id), parentEditedAt: { $exists: false } }, { $set: { parentEditedAt: at } });
    n += res.modifiedCount;
  }
  return n;
}

/** The parent-edit history of one kid, newest first. */
export async function listCamperChanges(camperId: string): Promise<CamperChangeLog[]> {
  const db = await getDb();
  const docs = await db.collection(CHANGE_LOG_COLLECTION).find({ camperId }).sort({ at: -1 }).toArray();
  return docs.map((d) => ({ ...(d as unknown as CamperChangeLog), _id: (d._id as ObjectId).toString() }));
}

/** Every kid whose guardian phone is `phone` (a parent may have several kids enrolled). */
export async function listCampersOfGuardian(phone: string): Promise<Camper[]> {
  const db = await getDb();
  const docs = await db.collection(COLLECTION).find({ guardianPhone: phone }).collation({ locale: "pt", strength: 1 }).sort({ name: 1 }).toArray();
  return docs.map((d) => toCamper(d as Record<string, unknown>)!);
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

/**
 * Marks the birthday SMS for `day` ("YYYY-MM-DD") as sent — atomically, only
 * if it was NOT sent for that day yet. Returns true when this call won (so the
 * caller may text the room). A different day (next year's camp) re-arms it.
 */
export async function claimBirthdayNotice(id: string, day: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const db = await getDb();
  const res = await db.collection(COLLECTION).updateOne({ _id: new ObjectId(id), birthdayNoticeDay: { $ne: day } }, { $set: { birthdayNoticeDay: day } });
  return res.modifiedCount === 1;
}

export async function ensureCamperIndexes(): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).createIndex({ name: 1 }, { collation: { locale: "pt", strength: 1 } });
  await db.collection(COLLECTION).createIndex({ bedroom: 1 });
  await db.collection(COLLECTION).createIndex({ team: 1 });
  await db.collection(COLLECTION).createIndex({ externalId: 1 }, { sparse: true });
  await db.collection(COLLECTION).createIndex({ caretakerId: 1 });
  await db.collection(COLLECTION).createIndex({ qrToken: 1 }, { sparse: true });
  await db.collection(LOG_COLLECTION).createIndex({ camperId: 1, at: -1 });
  await db.collection(LOG_COLLECTION).createIndex({ at: -1 });
  await db.collection(COLLECTION).createIndex({ guardianPhone: 1 }, { sparse: true });
  await db.collection(CHANGE_LOG_COLLECTION).createIndex({ camperId: 1, at: -1 });
}
