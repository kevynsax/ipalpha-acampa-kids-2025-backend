import { rawDb } from "../db";
import { activeCampId, refreshActiveCamp } from "./campContext";
import { SCOPED } from "./campScope";

const SCHEDULE_EVENTS_COLLECTION = "schedule_events";
const SETTINGS_COLLECTION = "settings";
const USERS_COLLECTION = "users";
const USER_CAMP_STATE_COLLECTION = "userCampState";
const CAMPS_COLLECTION = "camps";
const LEGACY_SETTINGS_ID = "global";

async function firstEventYear(): Promise<number> {
  const db = await rawDb();
  const [earliest] = await db.collection(SCHEDULE_EVENTS_COLLECTION).find().sort({ date: 1 }).limit(1).toArray();
  const date = earliest?.date as string | undefined;
  const year = date ? Number(date.slice(0, 4)) : NaN;
  return Number.isFinite(year) ? year : new Date().getFullYear();
}

/** Step 1: exactly one camp exists after this — the pre-existing single-camp deployment becomes its ACTIVE camp. */
async function ensureFirstCamp(): Promise<void> {
  const db = await rawDb();
  const count = await db.collection(CAMPS_COLLECTION).countDocuments({});
  if (count === 0) {
    const year = await firstEventYear();
    await db.collection(CAMPS_COLLECTION).insertOne({
      label: `Acampa Kids ${year}`,
      year,
      active: true,
      archivedAt: null,
      createdAt: new Date(),
      createdByUserId: null,
    });
    console.log(`🏕️  camps: created the first camp — "Acampa Kids ${year}"`);
  }
  await refreshActiveCamp();
}

/** Step 2: every SCOPED document that predates this feature gets the active camp's id. */
async function stampScopedCollections(campId: string): Promise<void> {
  const db = await rawDb();
  for (const name of SCOPED) {
    const res = await db.collection(name).updateMany({ campId: { $exists: false } }, { $set: { campId } });
    if (res.modifiedCount > 0) console.log(`🏕️  camps: stamped campId on ${res.modifiedCount} "${name}" document(s)`);
  }
}

/** Step 3: the single `settings._id:"global"` document is copied to `_id: <activeCampId>` (the old doc is left, unused). */
async function migrateSettingsDoc(campId: string): Promise<void> {
  const db = await rawDb();
  const already = await db.collection(SETTINGS_COLLECTION).findOne({ _id: campId as never });
  if (already) return;
  const legacy = await db.collection(SETTINGS_COLLECTION).findOne({ _id: LEGACY_SETTINGS_ID as never });
  if (!legacy) return;
  const { _id, ...rest } = legacy;
  await db.collection(SETTINGS_COLLECTION).insertOne({ ...rest, _id: campId as never, campId });
  console.log("🏕️  camps: copied settings.global → settings for the active camp");
}

/**
 * Step 4: every legacy index of a SCOPED collection whose key does NOT start
 * with `campId` is dropped — the app's own `ensure*Indexes()` calls (which run
 * right after this) recreate them through the scoped `Db` wrapper as
 * `{ campId, ... }`, so a second camp never collides on the old unique keys.
 */
async function dropLegacyIndexes(): Promise<void> {
  const db = await rawDb();
  for (const name of SCOPED) {
    const indexes = await db.collection(name).listIndexes().toArray().catch(() => []);
    for (const index of indexes) {
      if (index.name === "_id_") continue;
      const firstKey = Object.keys(index.key ?? {})[0];
      if (firstKey === "campId") continue;
      try {
        await db.collection(name).dropIndex(index.name);
        console.log(`🏕️  camps: dropped legacy index "${name}.${index.name}"`);
      } catch (err) {
        console.error(`camps: could not drop legacy index "${name}.${index.name}"`, err);
      }
    }
  }
}

/** Step 5: the per-year marks that used to live on `users` move to `userCampState` for the first camp. */
async function migrateUserCampState(campId: string): Promise<void> {
  const db = await rawDb();
  const users = await db
    .collection(USERS_COLLECTION)
    .find({
      $or: [{ prepDone: { $exists: true, $ne: [] } }, { welcomeSentAt: { $exists: true, $ne: null } }, { photosSmsSentAt: { $exists: true, $ne: null } }],
    })
    .toArray();
  if (users.length === 0) return;
  for (const user of users) {
    const userId = user._id.toString();
    await db.collection(USER_CAMP_STATE_COLLECTION).updateOne(
      { userId, campId },
      {
        $set: {
          prepDone: (user.prepDone as string[]) ?? [],
          welcomeSentAt: (user.welcomeSentAt as Date) ?? null,
          photosSmsSentAt: (user.photosSmsSentAt as Date) ?? null,
        },
      },
      { upsert: true },
    );
    await db.collection(USERS_COLLECTION).updateOne({ _id: user._id }, { $unset: { prepDone: "", welcomeSentAt: "", photosSmsSentAt: "" } });
  }
  console.log(`🏕️  camps: moved prep/welcome marks of ${users.length} user(s) to userCampState`);
}

/** Idempotent boot migration — safe to run on every start, including a fresh (single-camp) database. */
export async function migrateToCamps(): Promise<void> {
  await ensureFirstCamp();
  const campId = activeCampId();
  await stampScopedCollections(campId);
  await migrateSettingsDoc(campId);
  await dropLegacyIndexes();
  await migrateUserCampState(campId);
}
