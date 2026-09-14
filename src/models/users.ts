import { ObjectId } from "mongodb";
import { getDb } from "../db";
import type { PublicUser, User } from "../types";

function toUser(doc: Record<string, unknown> | null): User | null {
  if (!doc) return null;
  return {
    _id: (doc._id as ObjectId).toString(),
    name: doc.name as string,
    phone: doc.phone as string,
    roles: (doc.roles as User["roles"]) ?? [],
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
    otp: doc.otp as User["otp"],
    frozenUntil: doc.frozenUntil as Date | undefined,
    welcomeSentAt: (doc.welcomeSentAt as Date) ?? null,
  };
}

/** Every account holding the parent role. */
export async function listParents(): Promise<User[]> {
  const db = await getDb();
  const docs = await db.collection("users").find({ roles: "parent" }).sort({ name: 1 }).toArray();
  return docs.map((d) => toUser(d as Record<string, unknown>)!);
}

/** Marks a parent's welcome SMS as sent — atomically, only if NOT sent yet. True when this call won. */
export async function claimParentWelcome(id: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.collection("users").updateOne({ _id: new ObjectId(id), $or: [{ welcomeSentAt: null }, { welcomeSentAt: { $exists: false } }] }, { $set: { welcomeSentAt: new Date() } });
  return res.modifiedCount === 1;
}

/**
 * Marks the "there are photos in the app" SMS as sent to this parent —
 * atomically, only if it never went out. Each responsible hears about the
 * album ONCE per camp, however many batches the photographer publishes.
 */
export async function claimParentPhotosNotice(id: string): Promise<boolean> {
  const db = await getDb();
  const res = await db
    .collection("users")
    .updateOne({ _id: new ObjectId(id), $or: [{ photosSmsSentAt: null }, { photosSmsSentAt: { $exists: false } }] }, { $set: { photosSmsSentAt: new Date() } });
  return res.modifiedCount === 1;
}

/** Clears the album notice stamp on every parent (a new camp starts). */
export async function resetParentPhotosNotice(): Promise<number> {
  const db = await getDb();
  const res = await db.collection("users").updateMany({ photosSmsSentAt: { $ne: null } }, { $set: { photosSmsSentAt: null } });
  return res.modifiedCount;
}

/** A person is unique by phone — they may hold several roles at once. */
export async function findByPhone(phone: string): Promise<User | null> {
  const db = await getDb();
  return toUser(await db.collection("users").findOne({ phone }));
}

export async function findById(id: string): Promise<User | null> {
  const db = await getDb();
  return toUser(await db.collection("users").findOne({ _id: new ObjectId(id) }));
}

/** Every account holding the admin role (name + phone). */
export async function listAdmins(): Promise<User[]> {
  const db = await getDb();
  const docs = await db.collection("users").find({ roles: "admin" }).sort({ name: 1 }).toArray();
  return docs.map((d) => toUser(d as Record<string, unknown>)!);
}

/**
 * The admins' phones (E.164), cached at boot (`loadAdminPhones`): the staff
 * records carrying one of these are the admins' own — locked (no delete, no
 * phone change, no deactivation). Roles only change through the seed scripts,
 * so a boot-time cache is enough.
 */
let ADMIN_PHONES = new Set<string>();

export async function loadAdminPhones(): Promise<Set<string>> {
  const db = await getDb();
  const docs = await db.collection("users").find({ roles: "admin" }, { projection: { phone: 1 } }).toArray();
  ADMIN_PHONES = new Set(docs.map((d) => d.phone as string));
  return ADMIN_PHONES;
}

/** Is this phone an admin account's? (see loadAdminPhones) */
export function isAdminPhone(phone: string | null): boolean {
  return phone !== null && ADMIN_PHONES.has(phone);
}

export async function updateUser(id: string, patch: Record<string, unknown>): Promise<void> {
  const db = await getDb();
  await db
    .collection("users")
    .updateOne({ _id: new ObjectId(id) }, { $set: { ...patch, updatedAt: new Date() } });
}

export function toPublicUser(user: User): PublicUser {
  return { id: user._id, name: user.name, phone: user.phone, roles: user.roles };
}

export async function ensureIndexes(): Promise<void> {
  const db = await getDb();

  // legacy index from the single-role schema → replaced by phone-only unique index
  try {
    await db.collection("users").dropIndex("phone_1_role_1");
  } catch {
    // may not exist — fine
  }

  await db.collection("users").createIndex({ phone: 1 }, { unique: true });
  await db.collection("sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}
