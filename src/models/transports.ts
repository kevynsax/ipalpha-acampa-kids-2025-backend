import { ObjectId } from "mongodb";
import { getDb } from "../db";
import { deleteCategory, findCategoryByKey } from "./categories";
import { BUS_COLORS, type Transport, type TransportKind } from "../types";

const COLLECTION = "transports";
const LEGACY_CATEGORY_KEY = "transporte";

function toTransport(doc: Record<string, unknown> | null): Transport | null {
  if (!doc) return null;
  return {
    _id: (doc._id as ObjectId).toString(),
    draft: doc.draft === true,
    importId: (doc.importId as string) ?? undefined,
    kind: (doc.kind as TransportKind) ?? "bus",
    name: (doc.name as string) ?? undefined,
    color: (doc.color as string) ?? undefined,
    number: (doc.number as string) ?? undefined,
    capacity: (doc.capacity as number) ?? undefined,
    order: (doc.order as number) ?? 0,
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

export async function listTransports(includeDraft = false): Promise<Transport[]> {
  const db = await getDb();
  const docs = await db.collection(COLLECTION).find(includeDraft ? {} : { draft: { $ne: true } }).sort({ order: 1 }).toArray();
  return docs.map((d) => toTransport(d as Record<string, unknown>)!);
}

export async function findTransportById(id: string): Promise<Transport | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  return toTransport(await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) }));
}

export async function insertTransport(
  data: Omit<Transport, "_id" | "createdAt" | "updatedAt">,
): Promise<Transport> {
  const db = await getDb();
  const now = new Date();
  const { insertedId } = await db
    .collection(COLLECTION)
    .insertOne({ ...data, createdAt: now, updatedAt: now });
  return { ...data, _id: insertedId.toString(), createdAt: now, updatedAt: now };
}

export async function updateTransport(
  id: string,
  patch: Partial<Omit<Transport, "_id" | "createdAt" | "updatedAt">>,
): Promise<Transport | null> {
  const db = await getDb();
  // undefined fields (a bus becoming a car) must be $unset, not $set
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const unset: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) unset[k] = "";
    else set[k] = v;
  }
  const update: Record<string, unknown> = { $set: set };
  if (Object.keys(unset).length) update.$unset = unset;
  const res = await db
    .collection(COLLECTION)
    .findOneAndUpdate({ _id: new ObjectId(id) }, update, { returnDocument: "after" });
  return toTransport(res as Record<string, unknown> | null);
}

export async function deleteTransport(id: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });
  return res.deletedCount === 1;
}

export async function nextTransportOrder(): Promise<number> {
  const db = await getDb();
  const last = await db.collection(COLLECTION).find().sort({ order: -1 }).limit(1).toArray();
  return last.length ? ((last[0].order as number) ?? 0) + 1 : 0;
}

export async function ensureTransportIndexes(): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).createIndex({ order: 1 });
  await migrateLegacyTransportCategory();
}

/**
 * One-off migration, run at boot: transports used to be the options of the
 * `transporte` category. Each option becomes a Transport document with the
 * SAME id (option ids are ObjectId strings), so every `Staff.transportation`,
 * `Camper.transportation` and `busHelpers.vehicleId` keeps pointing at the
 * right vehicle. All options are imported as BUSES (they carried no car/bus
 * distinction before) with a colour from the palette and a sequential number
 * (buses have no name); the admin turns the ones that are actually cars into
 * cars afterwards. The category is then removed.
 */
async function migrateLegacyTransportCategory(): Promise<void> {
  const legacy = await findCategoryByKey(LEGACY_CATEGORY_KEY);
  if (!legacy) return;
  const db = await getDb();
  const existing = new Set((await listTransports()).map((t) => t._id));
  const now = new Date();
  let created = 0;
  for (const [i, o] of legacy.options.entries()) {
    if (existing.has(o.id) || !ObjectId.isValid(o.id)) continue;
    await db.collection(COLLECTION).insertOne({
      _id: new ObjectId(o.id),
      kind: "bus",
      color: BUS_COLORS[i % BUS_COLORS.length].hex,
      number: String(i + 1),
      order: o.order,
      createdAt: now,
      updatedAt: now,
    });
    created++;
  }
  await deleteCategory(legacy._id);
  console.log(`🚌 transports: migrated ${created} vehicle(s) from the "${LEGACY_CATEGORY_KEY}" category`);
}
