import { randomBytes } from "node:crypto";
import { Binary } from "mongodb";
import { getDb } from "../db";
import type { StoredFile } from "../types";

/**
 * Small images uploaded through the WYSIWYG editor. They live in MongoDB
 * (one document each, `data` as a Binary) so a single-container deploy needs
 * no disk volume and the images survive restarts. Ids are 24 random bytes in
 * hex — unguessable — which is what lets `GET /api/files/:id` be public
 * (an <img> tag cannot send an Authorization header).
 */
const COLLECTION = "files";

export async function insertFile(input: { name: string; type: string; data: Uint8Array; byUserId: string }): Promise<StoredFile> {
  const db = await getDb();
  const _id = randomBytes(24).toString("hex");
  const doc = {
    _id,
    name: input.name,
    type: input.type,
    size: input.data.byteLength,
    byUserId: input.byUserId,
    createdAt: new Date(),
    data: new Binary(input.data),
  };
  await db.collection(COLLECTION).insertOne(doc as never);
  const { data: _omit, ...meta } = doc;
  return meta;
}

export async function findFileWithData(id: string): Promise<(StoredFile & { data: Uint8Array }) | null> {
  if (!/^[a-f0-9]{16,64}$/.test(id)) return null;
  const db = await getDb();
  const doc = (await db.collection(COLLECTION).findOne({ _id: id as never })) as Record<string, unknown> | null;
  if (!doc) return null;
  const bin = doc.data as Binary;
  return {
    _id: doc._id as string,
    name: doc.name as string,
    type: doc.type as string,
    size: doc.size as number,
    byUserId: doc.byUserId as string,
    createdAt: doc.createdAt as Date,
    data: bin.buffer,
  };
}

/** Id of the most recent upload with this exact name (used by the seeds to avoid re-uploading their assets). */
export async function findFileIdByName(name: string): Promise<string | null> {
  const db = await getDb();
  const doc = await db.collection(COLLECTION).findOne({ name }, { projection: { _id: 1 }, sort: { createdAt: -1 } });
  return doc ? (doc._id as unknown as string) : null;
}

export async function deleteFile(id: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).deleteOne({ _id: id as never });
  return res.deletedCount === 1;
}

export async function ensureFileIndexes(): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).createIndex({ createdAt: 1 });
}
