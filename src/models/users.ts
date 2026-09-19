import { ObjectId } from "mongodb";
import { getDb } from "../db";
import { DEFAULT_LOCALE, resolveLocale, type Locale } from "../i18n";
import type { PublicUser, Role, User } from "../types";
import { titleCaseName } from "../utils";

function toUser(doc: Record<string, unknown> | null): User | null {
  if (!doc) return null;
  return {
    _id: (doc._id as ObjectId).toString(),
    name: doc.name as string,
    phone: doc.phone as string,
    roles: (doc.roles as User["roles"]) ?? [],
    locale: resolveLocale(doc.locale as string | undefined),
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
    otp: doc.otp as User["otp"],
    frozenUntil: doc.frozenUntil as Date | undefined,
    prepDone: (doc.prepDone as string[]) ?? [],
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

/**
 * Login needs a `users` doc (OTP lives there). The roster / kids can exist
 * without one — imports and the admin form never created accounts. Upsert by
 * phone; `$addToSet` the role so a parent who joins the team keeps both.
 */
export async function ensureLoginAccount(name: string, phone: string, role: Role): Promise<{ created: boolean }> {
  if (!phone) return { created: false };
  const db = await getDb();
  const now = new Date();
  const res = await db.collection("users").updateOne(
    { phone },
    {
      $setOnInsert: {
        name: titleCaseName(name) || name,
        phone,
        locale: DEFAULT_LOCALE,
        prepDone: [],
        welcomeSentAt: null,
        createdAt: now,
      },
      $addToSet: { roles: role },
      $set: { updatedAt: now },
    },
    { upsert: true },
  );
  return { created: res.upsertedCount === 1 };
}

/** Boot: a login account for every roster phone and every guardian phone. */
export async function ensureRosterLogins(): Promise<{ staffPhones: number; staffCreated: number; guardianPhones: number; parentsCreated: number }> {
  const db = await getDb();
  const [team, kids] = await Promise.all([
    db.collection("staff").find({ phone: { $type: "string" } }).project({ name: 1, phone: 1 }).toArray(),
    db.collection("campers").find({ guardianPhone: { $type: "string" } }).project({ name: 1, guardianName: 1, guardianPhone: 1 }).toArray(),
  ]);
  let staffCreated = 0;
  for (const s of team) {
    const phone = s.phone as string;
    if ((await ensureLoginAccount((s.name as string) ?? "", phone, "staff")).created) staffCreated++;
  }
  const seen = new Set<string>();
  let parentsCreated = 0;
  for (const k of kids) {
    const phone = k.guardianPhone as string;
    if (seen.has(phone)) continue;
    seen.add(phone);
    if ((await ensureLoginAccount((k.guardianName as string) || (k.name as string) || "", phone, "parent")).created) parentsCreated++;
  }
  return { staffPhones: team.length, staffCreated, guardianPhones: seen.size, parentsCreated };
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
 * The admins' phones (E.164), cached at boot (`loadAdminPhones`): used to badge
 * a roster row that happens to belong to an admin. Being admin does not require
 * a staff record — the login lives on `users`.
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

/** Ticks / unticks one Preparação item for a PARENT (their checklist lives on the user record). */
export async function setUserPrepDone(id: string, key: string, done: boolean): Promise<User | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  const res = await db
    .collection("users")
    .findOneAndUpdate(
      { _id: new ObjectId(id) },
      (done ? { $addToSet: { prepDone: key }, $set: { updatedAt: new Date() } } : { $pull: { prepDone: key }, $set: { updatedAt: new Date() } }) as never,
      { returnDocument: "after" },
    );
  return toUser(res as Record<string, unknown> | null);
}

export async function updateUser(id: string, patch: Record<string, unknown>): Promise<void> {
  const db = await getDb();
  await db
    .collection("users")
    .updateOne({ _id: new ObjectId(id) }, { $set: { ...patch, updatedAt: new Date() } });
}

/** Persist the device language seen at login (transparent — no UI). */
export async function setUserLocale(id: string, locale: Locale): Promise<void> {
  await updateUser(id, { locale: resolveLocale(locale) });
}

export function toPublicUser(user: User): PublicUser {
  return { id: user._id, name: user.name, phone: user.phone, roles: user.roles, locale: user.locale };
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
