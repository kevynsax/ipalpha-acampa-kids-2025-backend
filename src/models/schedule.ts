import { ObjectId } from "mongodb";
import { getDb } from "../db";
import type { CampEvent, EventAssignment, ScheduleRole } from "../types";

const ROLES = "schedule_roles";
const EVENTS = "schedule_events";

// ── roles ───────────────────────────────────────────────────────────────────

function toRole(doc: Record<string, unknown> | null): ScheduleRole | null {
  if (!doc) return null;
  return {
    _id: (doc._id as ObjectId).toString(),
    name: doc.name as string,
    emoji: (doc.emoji as string) ?? "🎯",
    instructions: (doc.instructions as string) ?? "",
    preparation: (doc.preparation as string) ?? "",
    forEveryone: (doc.forEveryone as boolean) ?? false,
    hasDetail: (doc.hasDetail as boolean) ?? false,
    detailPlaceholder: (doc.detailPlaceholder as string) ?? "",
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

export type ScheduleRoleData = Omit<ScheduleRole, "_id" | "createdAt" | "updatedAt">;

export async function listRoles(): Promise<ScheduleRole[]> {
  const db = await getDb();
  const docs = await db.collection(ROLES).find().collation({ locale: "pt", strength: 1 }).sort({ name: 1 }).toArray();
  return docs.map((d) => toRole(d as Record<string, unknown>)!);
}

export async function findRoleById(id: string): Promise<ScheduleRole | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  return toRole(await db.collection(ROLES).findOne({ _id: new ObjectId(id) }));
}

export async function findRoleByName(name: string): Promise<ScheduleRole | null> {
  const db = await getDb();
  return toRole(await db.collection(ROLES).findOne({ name }, { collation: { locale: "pt", strength: 1 } }));
}

export async function insertRole(data: ScheduleRoleData): Promise<ScheduleRole> {
  const db = await getDb();
  const now = new Date();
  const { insertedId } = await db.collection(ROLES).insertOne({ ...data, createdAt: now, updatedAt: now });
  return { ...data, _id: insertedId.toString(), createdAt: now, updatedAt: now };
}

export async function updateRole(id: string, patch: Partial<ScheduleRoleData>): Promise<ScheduleRole | null> {
  const db = await getDb();
  const res = await db
    .collection(ROLES)
    .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: "after" });
  return toRole(res as Record<string, unknown> | null);
}

export async function deleteRole(id: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.collection(ROLES).deleteOne({ _id: new ObjectId(id) });
  return res.deletedCount === 1;
}

/** Events that reference a role (used to block deletion). */
export async function countEventsUsingRole(roleId: string): Promise<number> {
  const db = await getDb();
  return db.collection(EVENTS).countDocuments({ roles: roleId });
}

// ── events ──────────────────────────────────────────────────────────────────

function toEvent(doc: Record<string, unknown> | null): CampEvent | null {
  if (!doc) return null;
  return {
    _id: (doc._id as ObjectId).toString(),
    date: doc.date as string,
    title: doc.title as string,
    emoji: (doc.emoji as string) ?? "📅",
    startTime: doc.startTime as string,
    endTime: (doc.endTime as string) ?? null,
    notes: (doc.notes as string) ?? "",
    // legacy docs stored [{ roleId, slots }] — normalise to plain ids
    roles: ((doc.roles as unknown[]) ?? []).map((r) => (typeof r === "string" ? r : (r as { roleId: string }).roleId)),
    assignments: (doc.assignments as EventAssignment[]) ?? [],
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

export type CampEventData = Omit<CampEvent, "_id" | "createdAt" | "updatedAt">;

export async function listEvents(): Promise<CampEvent[]> {
  const db = await getDb();
  const docs = await db.collection(EVENTS).find().sort({ date: 1, startTime: 1, title: 1 }).toArray();
  return docs.map((d) => toEvent(d as Record<string, unknown>)!);
}

export async function findEventById(id: string): Promise<CampEvent | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  return toEvent(await db.collection(EVENTS).findOne({ _id: new ObjectId(id) }));
}

export async function insertEvent(data: CampEventData): Promise<CampEvent> {
  const db = await getDb();
  const now = new Date();
  const { insertedId } = await db.collection(EVENTS).insertOne({ ...data, createdAt: now, updatedAt: now });
  return { ...data, _id: insertedId.toString(), createdAt: now, updatedAt: now };
}

export async function updateEvent(id: string, patch: Partial<CampEventData>): Promise<CampEvent | null> {
  const db = await getDb();
  const res = await db
    .collection(EVENTS)
    .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: "after" });
  return toEvent(res as Record<string, unknown> | null);
}

export async function deleteEvent(id: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.collection(EVENTS).deleteOne({ _id: new ObjectId(id) });
  return res.deletedCount === 1;
}

/** Removes a staff member from every event (used when they are deleted). */
export async function unassignStaffEverywhere(staffId: string): Promise<void> {
  const db = await getDb();
  await db
    .collection<Record<string, unknown>>(EVENTS)
    .updateMany({ "assignments.staffId": staffId }, { $pull: { assignments: { staffId } } as never, $set: { updatedAt: new Date() } });
}

export async function ensureScheduleIndexes(): Promise<void> {
  const db = await getDb();
  await db.collection(ROLES).createIndex({ name: 1 }, { unique: true, collation: { locale: "pt", strength: 1 } });
  try {
    await db.collection(EVENTS).dropIndex("day_1_startTime_1"); // legacy (day number)
  } catch {
    // may not exist
  }
  await db.collection(EVENTS).createIndex({ date: 1, startTime: 1 });
  try {
    await db.collection(EVENTS).dropIndex("roles.roleId_1"); // legacy shape
  } catch {
    // may not exist
  }
  await db.collection(EVENTS).createIndex({ roles: 1 });
  await db.collection(EVENTS).createIndex({ "assignments.staffId": 1 });
}
