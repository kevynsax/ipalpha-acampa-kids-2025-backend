import { ObjectId } from "mongodb";
import { getDb } from "../db";
import type { ScoreEntry } from "../types";

const COLLECTION = "scores";

function toEntry(doc: Record<string, unknown> | null): ScoreEntry | null {
  if (!doc) return null;
  return {
    _id: (doc._id as ObjectId).toString(),
    teamId: doc.teamId as string,
    points: typeof doc.points === "number" ? doc.points : 0,
    kind: (doc.kind as ScoreEntry["kind"]) ?? "add",
    note: (doc.note as string) ?? "",
    byUserId: (doc.byUserId as string) ?? "",
    byName: (doc.byName as string) ?? "",
    createdAt: doc.createdAt as Date,
  };
}

export type ScoreEntryData = Omit<ScoreEntry, "_id" | "createdAt">;

/** Every line, newest first. */
export async function listScores(): Promise<ScoreEntry[]> {
  const db = await getDb();
  const docs = await db.collection(COLLECTION).find().sort({ createdAt: -1 }).toArray();
  return docs.map((d) => toEntry(d as Record<string, unknown>)!);
}

/** Current total of one team (sum of its lines). */
export async function teamTotal(teamId: string): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .collection(COLLECTION)
    .aggregate<{ total: number }>([{ $match: { teamId } }, { $group: { _id: null, total: { $sum: "$points" } } }])
    .toArray();
  return row?.total ?? 0;
}

export async function insertScore(data: ScoreEntryData): Promise<ScoreEntry> {
  const db = await getDb();
  const createdAt = new Date();
  const { insertedId } = await db.collection(COLLECTION).insertOne({ ...data, createdAt });
  return { ...data, _id: insertedId.toString(), createdAt };
}

export async function deleteScore(id: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const db = await getDb();
  const res = await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });
  return res.deletedCount === 1;
}

/** Drops every line of a team (after the team is deleted). */
export async function deleteScoresOfTeam(teamId: string): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).deleteMany({ teamId });
}

export async function ensureScoreIndexes(): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).createIndex({ teamId: 1, createdAt: -1 });
  await db.collection(COLLECTION).createIndex({ createdAt: -1 });
}
