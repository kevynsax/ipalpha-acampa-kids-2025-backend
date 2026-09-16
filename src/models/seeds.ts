import { getDb } from "../db";
import type { Seeds } from "../types";

const COLLECTION = "seeds";
/** the seeds live in ONE document (there is a single deployment) */
const DOC_ID = "global";

function toSeeds(doc: Record<string, unknown> | null): Seeds | null {
  if (!doc || typeof doc !== "object") return null;
  const s = doc.seeds;
  return s && typeof s === "object" ? (s as Seeds) : null;
}

/** The super-admin's saved seeds, or null when nothing was ever saved (the app's built-in defaults apply). */
export async function getSeeds(): Promise<Seeds | null> {
  const db = await getDb();
  return toSeeds((await db.collection(COLLECTION).findOne({ _id: DOC_ID as never })) as Record<string, unknown> | null);
}

/** Saves the whole seeds document (validated by the route before it gets here). */
export async function saveSeeds(seeds: Seeds): Promise<Seeds> {
  const db = await getDb();
  await db
    .collection(COLLECTION)
    .updateOne({ _id: DOC_ID as never }, { $set: { seeds, updatedAt: new Date() } }, { upsert: true });
  return seeds;
}

/** Throws the saved seeds away — the wizard goes back to the app's built-in defaults. */
export async function clearSeeds(): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).deleteOne({ _id: DOC_ID as never });
}
