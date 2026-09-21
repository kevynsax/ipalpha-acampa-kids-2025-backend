import { ObjectId } from "mongodb";
import { getDb } from "../db";
import type { CamperCheckin, CamperSex, Staff, VestStatus } from "../types";
import { ROOM_ROLES } from "../types";
import { toCheckin, toMedications } from "./campers";
import { AI_REVIEW_MAX_ATTEMPTS, aiReviewDueFilter, aiReviewRetryAt } from "./aiReviewRetry";

const COLLECTION = "staff";

function toStaff(doc: Record<string, unknown> | null): Staff | null {
  if (!doc) return null;
  return {
    _id: (doc._id as ObjectId).toString(),
    draft: doc.draft === true,
    importId: (doc.importId as string) ?? undefined,
    aiReviewStatus: (["pending", "processing", "structured", "reviewed", "error"] as const).includes(doc.aiReviewStatus as never) ? doc.aiReviewStatus as Staff["aiReviewStatus"] : null,
    aiReviewError: (doc.aiReviewError as string) ?? "",
    aiReviewStartedAt: (doc.aiReviewStartedAt as Date) ?? null,
    aiReviewFinishedAt: (doc.aiReviewFinishedAt as Date) ?? null,
    aiReviewAttempts: typeof doc.aiReviewAttempts === "number" ? doc.aiReviewAttempts : 0,
    aiReviewNextRetryAt: (doc.aiReviewNextRetryAt as Date) ?? null,
    name: doc.name as string,
    sex: doc.sex === "F" || doc.sex === "M" ? (doc.sex as CamperSex) : null,
    probableGender: doc.probableGender === "F" || doc.probableGender === "M" ? (doc.probableGender as CamperSex) : null,
    phone: (doc.phone as string) ?? null,
    email: typeof doc.email === "string" && doc.email.trim() ? doc.email : null,
    document: typeof doc.document === "string" ? doc.document : "",
    birthDate: typeof doc.birthDate === "string" && doc.birthDate ? doc.birthDate : null,
    active: (doc.active as boolean) ?? true,
    team: (doc.team as string) ?? null,
    bedroom: (doc.bedroom as string) ?? null,
    roomRole: ROOM_ROLES.includes(doc.roomRole as Staff["roomRole"]) ? (doc.roomRole as Staff["roomRole"]) : "helper",
    transportation: (doc.transportation as string) ?? null,
    allergies: (doc.allergies as string[]) ?? [],
    drugAllergies: (doc.drugAllergies as string[]) ?? [],
    foodRestrictions: (doc.foodRestrictions as string) ?? "",
    healthIssues: (doc.healthIssues as string[]) ?? [],
    medications: toMedications(doc.medications),
    healthNotes: (doc.healthNotes as string) ?? "",
    checkin: toCheckin(doc.checkin),
    vest: toVest(doc.vest),
    prepDone: (doc.prepDone as string[]) ?? [],
    welcomeSentAt: (doc.welcomeSentAt as Date) ?? null,
    foreignLookupCount: typeof doc.foreignLookupCount === "number" ? (doc.foreignLookupCount as number) : 0,
    foreignLookupNames: Array.isArray(doc.foreignLookupNames) ? (doc.foreignLookupNames as string[]) : [],
    foreignLookupAlertedAt: (doc.foreignLookupAlertedAt as Date) ?? null,
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

function toVest(v: unknown): VestStatus {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const delivered = toCheckin(o.delivered);
  // a return without a delivery makes no sense: ignore it
  return { delivered, returned: delivered ? toCheckin(o.returned) : null };
}

export const NO_VEST: VestStatus = { delivered: null, returned: null };

export type StaffData = Omit<Staff, "_id" | "createdAt" | "updatedAt" | "checkin" | "vest" | "prepDone" | "welcomeSentAt" | "foreignLookupCount" | "foreignLookupNames" | "foreignLookupAlertedAt">;

export async function listStaff(filter: { active?: boolean; includeDraft?: boolean } = {}): Promise<Staff[]> {
  const db = await getDb();
  const query: Record<string, unknown> = filter.includeDraft ? {} : { draft: { $ne: true } };
  if (filter.active !== undefined) query.active = filter.active;
  const docs = await db
    .collection(COLLECTION)
    .find(query)
    .collation({ locale: "pt", strength: 1 })
    .sort({ name: 1 })
    .toArray();
  return docs.map((d) => toStaff(d as Record<string, unknown>)!);
}

export async function findStaffById(id: string): Promise<Staff | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  return toStaff(await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) }));
}

export async function findStaffByPhone(phone: string): Promise<Staff | null> {
  const db = await getDb();
  return toStaff(await db.collection(COLLECTION).findOne({ phone }));
}

export async function insertStaff(data: StaffData): Promise<Staff> {
  const db = await getDb();
  const now = new Date();
  const { insertedId } = await db.collection(COLLECTION).insertOne({ ...data, createdAt: now, updatedAt: now });
  return { ...data, checkin: null, vest: NO_VEST, prepDone: [], welcomeSentAt: null, foreignLookupCount: 0, foreignLookupNames: [], foreignLookupAlertedAt: null, _id: insertedId.toString(), createdAt: now, updatedAt: now };
}

export async function updateStaff(id: string, patch: Partial<StaffData>): Promise<Staff | null> {
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { ...patch, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
  return toStaff(res as Record<string, unknown> | null);
}

/** Phase 1 claim — the fast Jev structuring pass; skips records already structured. */
export async function claimStaffForAiReview(limit: number): Promise<Staff[]> {
  const db = await getDb();
  const out: Staff[] = [];
  for (let i = 0; i < limit; i++) {
    const now = new Date();
    const doc = await db.collection(COLLECTION).findOneAndUpdate(
      { $or: [{ aiReviewStatus: "pending" }, aiReviewDueFilter(now)], aiReviewStructured: { $ne: true } },
      { $set: { aiReviewStatus: "processing", aiReviewStartedAt: now, aiReviewError: "", aiReviewNextRetryAt: null, updatedAt: now } },
      { sort: { createdAt: 1 }, returnDocument: "after" },
    );
    const staff = toStaff(doc as Record<string, unknown> | null);
    if (!staff) break;
    out.push(staff);
  }
  return out;
}

/** Phase 2 claim — the slow generative cleanup: records the Jev pass already structured (fresh, requeued or due retries). */
export async function claimStaffForCleanup(limit: number): Promise<Staff[]> {
  const db = await getDb();
  const out: Staff[] = [];
  for (let i = 0; i < limit; i++) {
    const now = new Date();
    const doc = await db.collection(COLLECTION).findOneAndUpdate(
      { aiReviewStructured: true, $or: [{ aiReviewStatus: { $in: ["pending", "structured"] } }, aiReviewDueFilter(now)] },
      { $set: { aiReviewStatus: "processing", aiReviewStartedAt: now, aiReviewError: "", aiReviewNextRetryAt: null, updatedAt: now } },
      { sort: { createdAt: 1 }, returnDocument: "after" },
    );
    const staff = toStaff(doc as Record<string, unknown> | null);
    if (!staff) break;
    out.push(staff);
  }
  return out;
}

/**
 * Finishes phase 1 (Jev structuring): writes the structured health fields
 * right away and marks the member "structured" while cleanup is pending.
 * Returns the failed-attempt count on error (for retry logs).
 */
export async function finishStaffStructure(id: string, patch: Partial<StaffData>, error = ""): Promise<number> {
  if (!error) {
    const db = await getDb();
    await db.collection(COLLECTION).updateOne({ _id: new ObjectId(id) }, { $set: { ...patch, aiReviewStatus: "structured", aiReviewStructured: true, aiReviewError: "", aiReviewNextRetryAt: null, updatedAt: new Date() } });
    return 0;
  }
  return failStaffReview(id, patch, error);
}

async function failStaffReview(id: string, patch: Partial<StaffData>, error: string): Promise<number> {
  const db = await getDb();
  const now = new Date();
  const after = await db.collection(COLLECTION).findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: { ...patch, aiReviewStatus: "error", aiReviewError: error, aiReviewFinishedAt: now, updatedAt: now }, $inc: { aiReviewAttempts: 1 } },
    { returnDocument: "after" },
  );
  const attempts = typeof (after as Record<string, unknown> | null)?.aiReviewAttempts === "number"
    ? (after as Record<string, unknown>).aiReviewAttempts as number
    : 1;
  await db.collection(COLLECTION).updateOne(
    { _id: new ObjectId(id) },
    { $set: { aiReviewNextRetryAt: attempts < AI_REVIEW_MAX_ATTEMPTS ? aiReviewRetryAt(attempts, now) : null, updatedAt: new Date() } },
  );
  return attempts;
}

/**
 * Finishes phase 2 (generative cleanup): the terminal "reviewed" state.
 * Errors keep `aiReviewStructured` set so the retry skips the Jev pass.
 * Returns the failed-attempt count (for retry logs).
 */
export async function finishStaffAiReview(id: string, patch: Partial<StaffData>, error = ""): Promise<number> {
  if (!error) {
    const db = await getDb();
    await db.collection(COLLECTION).updateOne({ _id: new ObjectId(id) }, { $set: { ...patch, aiReviewStatus: "reviewed", aiReviewError: "", aiReviewFinishedAt: new Date(), aiReviewNextRetryAt: null, updatedAt: new Date() } });
    return 0;
  }
  return failStaffReview(id, patch, error);
}

export async function requeueStaleStaffAiReviews(staleMs = 15 * 60_000): Promise<number> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).updateMany(
    { aiReviewStatus: "processing", aiReviewStartedAt: { $lt: new Date(Date.now() - staleMs) } },
    { $set: { aiReviewStatus: "pending", aiReviewStartedAt: null, aiReviewError: "", updatedAt: new Date() } },
  );
  return res.modifiedCount;
}

/** Marks the person as arrived (`null` undoes it). */
export async function setStaffCheckin(id: string, checkin: CamperCheckin | null): Promise<Staff | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { checkin, updatedAt: new Date() } }, { returnDocument: "after" });
  return toStaff(res as Record<string, unknown> | null);
}

/** Sets the vest (colete) status: delivered / returned stamps. */
export async function setStaffVest(id: string, vest: VestStatus): Promise<Staff | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { vest, updatedAt: new Date() } }, { returnDocument: "after" });
  return toStaff(res as Record<string, unknown> | null);
}

/** Clears every vest stamp (rehearsal reset). Returns how many had one. */
export async function resetStaffVests(): Promise<number> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).updateMany({ "vest.delivered": { $ne: null } }, { $set: { vest: NO_VEST, updatedAt: new Date() } });
  return res.modifiedCount;
}

/**
 * Marks the welcome SMS as sent — atomically, only if it was NOT sent yet.
 * Returns true when this call won (so the caller may send), false otherwise.
 */
export async function claimStaffWelcome(id: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const db = await getDb();
  const res = await db.collection(COLLECTION).updateOne({ _id: new ObjectId(id), welcomeSentAt: null }, { $set: { welcomeSentAt: new Date() } });
  return res.modifiedCount === 1;
}

/**
 * Marks the "there are photos in the app" SMS as sent to this team member —
 * atomically, only if it never went out. True when this call won, so the
 * photographer can publish as many batches as they like and each person is
 * still texted about the album ONCE for the whole camp.
 */
export async function claimStaffPhotosNotice(id: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .updateOne({ _id: new ObjectId(id), $or: [{ photosSmsSentAt: null }, { photosSmsSentAt: { $exists: false } }] }, { $set: { photosSmsSentAt: new Date() } });
  return res.modifiedCount === 1;
}

/** Clears the album notice stamp on the whole team (a new camp starts → everyone may be told again). */
export async function resetStaffPhotosNotice(): Promise<number> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).updateMany({ photosSmsSentAt: { $ne: null } }, { $set: { photosSmsSentAt: null } });
  return res.modifiedCount;
}

/** Clears every team member's check-in (rehearsal reset). Returns how many had one. */
export async function resetStaffCheckins(): Promise<number> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).updateMany({ checkin: { $ne: null } }, { $set: { checkin: null, updatedAt: new Date() } });
  return res.modifiedCount;
}

/** Thresholds for out-of-scope emergency QR lookups (see routes/campers.ts lookup). */
export const FOREIGN_LOOKUP_ALERT_AT = 3;
export const FOREIGN_LOOKUP_BLOCK_AT = 5;
const FOREIGN_LOOKUP_NAMES_MAX = 20;

/**
 * Records one more DISTINCT out-of-scope kid for this staff member.
 * No-op (returns the current record) when `camperId` was already counted.
 * Returns null when the staff id is unknown.
 */
export async function recordForeignLookup(staffId: string, camperId: string, camperName: string): Promise<Staff | null> {
  if (!ObjectId.isValid(staffId)) return null;
  const db = await getDb();
  const current = await findStaffById(staffId);
  if (!current) return null;
  // kid ids live in a hidden array so re-scans of the same kid don't bump the counter
  const doc = await db.collection(COLLECTION).findOne({ _id: new ObjectId(staffId) });
  const seen = Array.isArray(doc?.foreignLookupCamperIds) ? (doc!.foreignLookupCamperIds as string[]) : [];
  if (seen.includes(camperId)) return current;
  const names = [...current.foreignLookupNames.filter((n) => n !== camperName), camperName].slice(-FOREIGN_LOOKUP_NAMES_MAX);
  const res = await db.collection(COLLECTION).findOneAndUpdate(
    { _id: new ObjectId(staffId) },
    {
      $inc: { foreignLookupCount: 1 },
      $addToSet: { foreignLookupCamperIds: camperId },
      $set: { foreignLookupNames: names, updatedAt: new Date() },
    },
    { returnDocument: "after" },
  );
  return toStaff(res as Record<string, unknown> | null);
}

/** Marks that the admins were already SMS'd about this person's out-of-scope scans (once until reset). */
export async function markForeignLookupAlerted(staffId: string): Promise<void> {
  if (!ObjectId.isValid(staffId)) return;
  const db = await getDb();
  await db.collection(COLLECTION).updateOne(
    { _id: new ObjectId(staffId), foreignLookupAlertedAt: null },
    { $set: { foreignLookupAlertedAt: new Date(), updatedAt: new Date() } },
  );
}

/** Zeroes every staff member's out-of-scope lookup counter (Settings → Geral). Returns how many had a count. */
export async function resetForeignLookups(): Promise<number> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).updateMany(
    { $or: [{ foreignLookupCount: { $gt: 0 } }, { foreignLookupCamperIds: { $exists: true, $ne: [] } }] },
    {
      $set: {
        foreignLookupCount: 0,
        foreignLookupNames: [],
        foreignLookupCamperIds: [],
        foreignLookupAlertedAt: null,
        updatedAt: new Date(),
      },
    },
  );
  return res.modifiedCount;
}

/** Staff members currently at / past the alert threshold (for the admin settings card). */
export async function listForeignLookupOffenders(minCount = FOREIGN_LOOKUP_ALERT_AT): Promise<Staff[]> {
  const db = await getDb();
  const docs = await db
    .collection(COLLECTION)
    .find({ foreignLookupCount: { $gte: minCount } })
    .collation({ locale: "pt", strength: 1 })
    .sort({ foreignLookupCount: -1, name: 1 })
    .toArray();
  return docs.map((d) => toStaff(d as Record<string, unknown>)!);
}

/** Ticks / unticks one Preparação item for the person. */
export async function setStaffPrepDone(id: string, key: string, done: boolean): Promise<Staff | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  const res = await db
    .collection(COLLECTION)
    .findOneAndUpdate(
      { _id: new ObjectId(id) },
      (done ? { $addToSet: { prepDone: key }, $set: { updatedAt: new Date() } } : { $pull: { prepDone: key }, $set: { updatedAt: new Date() } }) as never,
      { returnDocument: "after" },
    );
  return toStaff(res as Record<string, unknown> | null);
}

export async function deleteStaff(id: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });
  return res.deletedCount === 1;
}

export async function ensureStaffIndexes(): Promise<void> {
  const db = await getDb();
  // legacy index without partial filter (would reject a second null phone)
  try {
    await db.collection(COLLECTION).dropIndex("phone_1");
  } catch {
    // may not exist — fine
  }
  await db
    .collection(COLLECTION)
    .createIndex({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: "string" } } });
  await db.collection(COLLECTION).createIndex({ active: 1, name: 1 });
  await db.collection(COLLECTION).createIndex({ aiReviewStatus: 1, createdAt: 1 });
  await db.collection(COLLECTION).createIndex({ importId: 1, aiReviewStatus: 1 });
}
