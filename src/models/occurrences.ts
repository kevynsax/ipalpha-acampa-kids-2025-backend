import { ObjectId } from "mongodb";
import { getDb } from "../db";
import { getSettings } from "./settings";
import type { Occurrence, OccurrenceGroup, OccurrencePerson } from "../types";

const COLLECTION = "occurrences";
const GROUPS = new Set<OccurrenceGroup>(["admin", "organizer", "medical"]);

function toPerson(value: unknown): OccurrencePerson | null {
  if (!value || typeof value !== "object") return null;
  const person = value as Record<string, unknown>;
  if (typeof person.id !== "string" || typeof person.name !== "string") return null;
  return { id: person.id, name: person.name };
}

function toGroup(value: unknown): OccurrenceGroup | undefined {
  return typeof value === "string" && GROUPS.has(value as OccurrenceGroup) ? (value as OccurrenceGroup) : undefined;
}

function toOccurrence(doc: Record<string, unknown> | null): Occurrence | null {
  if (!doc) return null;
  return {
    _id: (doc._id as ObjectId).toString(),
    campers: Array.isArray(doc.campers) ? doc.campers.map(toPerson).filter((person): person is OccurrencePerson => person !== null) : [],
    staff: Array.isArray(doc.staff) ? doc.staff.map(toPerson).filter((person): person is OccurrencePerson => person !== null) : [],
    description: (doc.description as string) ?? "",
    createdByUserId: (doc.createdByUserId as string) ?? "",
    createdByName: (doc.createdByName as string) ?? "",
    createdByRole: (doc.createdByRole as Occurrence["createdByRole"]) ?? "admin",
    createdByGroup: toGroup(doc.createdByGroup),
    createdAt: doc.createdAt as Date,
  };
}

export type OccurrenceData = Omit<Occurrence, "_id" | "createdAt">;

function groupFromRole(occurrence: Occurrence): OccurrenceGroup {
  if (occurrence.createdByRole === "admin") return "admin";
  if (occurrence.createdByRole === "health_staff") return "medical";
  return "organizer";
}

/** Staff ids of authors who wrote before `createdByGroup` existed, keyed by user id. */
async function staffIdByUserId(userIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(userIds.filter((id) => ObjectId.isValid(id)))];
  if (unique.length === 0) return new Map();
  const db = await getDb();
  const users = await db.collection("users").find({ _id: { $in: unique.map((id) => new ObjectId(id)) } }).project({ phone: 1 }).toArray();
  const phoneByUser = new Map(users.map((user) => [(user._id as ObjectId).toString(), user.phone as string]));
  const phones = [...new Set([...phoneByUser.values()].filter(Boolean))];
  if (phones.length === 0) return new Map();
  const staff = await db.collection("staff").find({ phone: { $in: phones } }).project({ phone: 1 }).toArray();
  const staffIdByPhone = new Map(staff.map((person) => [person.phone as string, (person._id as ObjectId).toString()]));
  const out = new Map<string, string>();
  for (const [userId, phone] of phoneByUser) {
    const staffId = staffIdByPhone.get(phone);
    if (staffId) out.set(userId, staffId);
  }
  return out;
}

function occurrenceGroupOf(occurrence: Occurrence, organizers: Set<string>, medical: Set<string>, staffIdByUser: Map<string, string>): OccurrenceGroup {
  if (occurrence.createdByGroup) return occurrence.createdByGroup;
  const staffId = staffIdByUser.get(occurrence.createdByUserId);
  if (staffId && organizers.has(staffId)) return "organizer";
  if (staffId && medical.has(staffId)) return "medical";
  return groupFromRole(occurrence);
}

/** Admin reads every group; medical / organizers only the records their peers created. */
export async function occurrencesForGroup(list: Occurrence[], group: OccurrenceGroup): Promise<Occurrence[]> {
  if (group === "admin") return list;
  const settings = await getSettings();
  const organizers = new Set(settings.organizers.staffIds);
  const medical = new Set(settings.medicalStaff.staffIds);
  const staffIdByUser = await staffIdByUserId(list.filter((occurrence) => !occurrence.createdByGroup).map((occurrence) => occurrence.createdByUserId));
  return list.filter((occurrence) => occurrenceGroupOf(occurrence, organizers, medical, staffIdByUser) === group);
}

export async function listOccurrences(): Promise<Occurrence[]> {
  const db = await getDb();
  const docs = await db.collection(COLLECTION).find().sort({ createdAt: -1 }).toArray();
  return docs.map((doc) => toOccurrence(doc as Record<string, unknown>)!);
}

export async function insertOccurrence(data: OccurrenceData): Promise<Occurrence> {
  const db = await getDb();
  const createdAt = new Date();
  const { insertedId } = await db.collection(COLLECTION).insertOne({ ...data, createdAt });
  return { ...data, _id: insertedId.toString(), createdAt };
}

export async function ensureOccurrenceIndexes(): Promise<void> {
  const db = await getDb();
  await Promise.all([
    db.collection(COLLECTION).createIndex({ createdAt: -1 }),
    db.collection(COLLECTION).createIndex({ createdByGroup: 1, createdAt: -1 }),
    db.collection(COLLECTION).createIndex({ "campers.id": 1, createdAt: -1 }),
    db.collection(COLLECTION).createIndex({ "staff.id": 1, createdAt: -1 }),
  ]);
}
