import { ObjectId } from "mongodb";
import { getDb } from "../db";
import { deleteCategory, findCategoryByKey } from "./categories";
import type { Team } from "../types";

const COLLECTION = "teams";

/** the category key the teams used to live under (before they got their own collection) */
const LEGACY_CATEGORY_KEY = "equipe";

/** a pleasant default palette for the migrated / new teams */
export const TEAM_PALETTE = ["#e63946", "#f4a261", "#e9c46a", "#2a9d8f", "#264653", "#8e44ad", "#3498db", "#27ae60", "#d35400", "#7f8c8d"];

function toTeam(doc: Record<string, unknown> | null): Team | null {
  if (!doc) return null;
  return {
    _id: (doc._id as ObjectId).toString(),
    name: doc.name as string,
    color: typeof doc.color === "string" ? doc.color : "#2a9d8f",
    jokerStaffId: typeof doc.jokerStaffId === "string" ? doc.jokerStaffId : null,
    order: (doc.order as number) ?? 0,
    createdAt: doc.createdAt as Date,
    updatedAt: doc.updatedAt as Date,
  };
}

export type TeamData = Omit<Team, "_id" | "createdAt" | "updatedAt">;

export async function listTeams(): Promise<Team[]> {
  const db = await getDb();
  const docs = await db.collection(COLLECTION).find().sort({ order: 1, name: 1 }).toArray();
  return docs.map((d) => toTeam(d as Record<string, unknown>)!);
}

export async function findTeamById(id: string): Promise<Team | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  return toTeam(await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) }));
}

export async function insertTeam(data: TeamData): Promise<Team> {
  const db = await getDb();
  const now = new Date();
  const { insertedId } = await db.collection(COLLECTION).insertOne({ ...data, createdAt: now, updatedAt: now });
  return { ...data, _id: insertedId.toString(), createdAt: now, updatedAt: now };
}

export async function updateTeam(id: string, patch: Partial<TeamData>): Promise<Team | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  const res = await db.collection(COLLECTION).findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: "after" });
  return toTeam(res as Record<string, unknown> | null);
}

export async function deleteTeam(id: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const db = await getDb();
  const res = await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });
  return res.deletedCount === 1;
}

/** Unlinks every camper / staff member from the team (after it is deleted). */
export async function unlinkTeamEverywhere(teamId: string): Promise<void> {
  const db = await getDb();
  const now = new Date();
  await Promise.all([
    db.collection("campers").updateMany({ team: teamId }, { $set: { team: null, updatedAt: now } }),
    db.collection("staff").updateMany({ team: teamId }, { $set: { team: null, updatedAt: now } }),
  ]);
}

/** Clears the joker of every team that pointed at this staff member (after they are deleted). */
export async function clearJokerEverywhere(staffId: string): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).updateMany({ jokerStaffId: staffId }, { $set: { jokerStaffId: null, updatedAt: new Date() } });
}

export async function ensureTeamIndexes(): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).createIndex({ order: 1, name: 1 });
  await migrateLegacyTeamCategory();
}

/**
 * One-off migration, run at boot: the teams used to be the options of the
 * `equipe` category. Each option becomes a Team document with the SAME id
 * (the option ids are ObjectId strings), so every `Staff.team` /
 * `Camper.team` keeps pointing at the right team. Inactive options come along
 * too (people may still reference them). The category is then removed.
 */
async function migrateLegacyTeamCategory(): Promise<void> {
  const legacy = await findCategoryByKey(LEGACY_CATEGORY_KEY);
  if (!legacy) return;
  const db = await getDb();
  const existing = new Set((await listTeams()).map((t) => t._id));
  const now = new Date();
  let created = 0;
  for (const [i, o] of legacy.options.entries()) {
    if (existing.has(o.id) || !ObjectId.isValid(o.id)) continue;
    await db.collection(COLLECTION).insertOne({
      _id: new ObjectId(o.id),
      name: o.label,
      color: TEAM_PALETTE[i % TEAM_PALETTE.length],
      jokerStaffId: null,
      order: o.order,
      createdAt: now,
      updatedAt: now,
    });
    created++;
  }
  await deleteCategory(legacy._id);
  console.log(`🚩 teams: migrated ${created} team(s) from the "${LEGACY_CATEGORY_KEY}" category`);
}
