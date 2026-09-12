/**
 * Marks EVERY team member and EVERY parent as already welcomed
 * (`welcomeSentAt` = now), so switching the welcome toggles on later never
 * texts the people who were already in the camp when the app went live.
 * Use once at rollout; new people added afterwards start unwelcomed as usual.
 *
 *   bun run seed:welcomed [--dry]
 */
import { closeDb, getDb } from "../db";

const dry = process.argv.includes("--dry");

async function main() {
  const db = await getDb();
  const now = new Date();
  const staffQ = { welcomeSentAt: null };
  const parentQ = { roles: "parent", $or: [{ welcomeSentAt: null }, { welcomeSentAt: { $exists: false } }] };
  const staffN = await db.collection("staff").countDocuments(staffQ);
  const parentN = await db.collection("users").countDocuments(parentQ);
  if (!dry) {
    await db.collection("staff").updateMany(staffQ, { $set: { welcomeSentAt: now } });
    await db.collection("users").updateMany(parentQ, { $set: { welcomeSentAt: now } });
  }
  console.log(`✅ marked as already welcomed: ${staffN} team members, ${parentN} parents${dry ? " (dry run — nada gravado)" : ""}`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
