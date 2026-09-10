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
  };
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
