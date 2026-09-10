import { ObjectId } from "mongodb";
import { getDb } from "../db";
import type { PrepSection } from "../types";

const COLLECTION = "prep_sections";

function toSection(doc: Record<string, unknown> | null): PrepSection | null {
  if (!doc) return null;
  return {
    _id: (doc._id as ObjectId).toString(),
    title: doc.title as string,
    emoji: (doc.emoji as string) ?? "📌",
    content: (doc.content as string) ?? "",
    order: (doc.order as number) ?? 0,
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

export type PrepSectionData = Omit<PrepSection, "_id" | "createdAt" | "updatedAt">;

export async function listPrepSections(): Promise<PrepSection[]> {
  const db = await getDb();
  const docs = await db.collection(COLLECTION).find().sort({ order: 1, createdAt: 1 }).toArray();
  return docs.map((d) => toSection(d as Record<string, unknown>)!);
}

export async function findPrepSectionById(id: string): Promise<PrepSection | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  return toSection(await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) }));
}

export async function nextPrepOrder(): Promise<number> {
  const db = await getDb();
  const last = await db.collection(COLLECTION).find().sort({ order: -1 }).limit(1).toArray();
  return last.length ? ((last[0].order as number) ?? 0) + 1 : 0;
}

export async function insertPrepSection(data: PrepSectionData): Promise<PrepSection> {
  const db = await getDb();
  const now = new Date();
  const { insertedId } = await db.collection(COLLECTION).insertOne({ ...data, createdAt: now, updatedAt: now });
  return { ...data, _id: insertedId.toString(), createdAt: now, updatedAt: now };
}

export async function updatePrepSection(id: string, patch: Partial<PrepSectionData>): Promise<PrepSection | null> {
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: "after" });
  return toSection(res as Record<string, unknown> | null);
}

export async function deletePrepSection(id: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });
  return res.deletedCount === 1;
}

export async function ensurePrepIndexes(): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).createIndex({ order: 1 });
}
