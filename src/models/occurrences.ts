import { ObjectId } from "mongodb";
import { getDb } from "../db";
import type { Occurrence, OccurrencePerson } from "../types";

const COLLECTION = "occurrences";

function toPerson(value: unknown): OccurrencePerson | null {
  if (!value || typeof value !== "object") return null;
  const person = value as Record<string, unknown>;
  if (typeof person.id !== "string" || typeof person.name !== "string") return null;
  return { id: person.id, name: person.name };
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
    createdAt: doc.createdAt as Date,
  };
}

export type OccurrenceData = Omit<Occurrence, "_id" | "createdAt">;

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
    db.collection(COLLECTION).createIndex({ "campers.id": 1, createdAt: -1 }),
    db.collection(COLLECTION).createIndex({ "staff.id": 1, createdAt: -1 }),
  ]);
}
