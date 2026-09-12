/**
 * Resets the SMS notification settings to their defaults: EVERY kind OFF and
 * no check-in reminder date. The rest of the settings document (windows,
 * lists, location) is untouched.
 *
 *   bun run seed:notifications
 */
import { closeDb, getDb } from "../db";
import { DEFAULT_SETTINGS } from "../models/settings";

async function main() {
  const db = await getDb();
  await db.collection("settings").updateOne(
    { _id: "global" as never },
    { $set: { notifications: DEFAULT_SETTINGS.notifications, checkinReminder: DEFAULT_SETTINGS.checkinReminder, updatedAt: new Date() } },
    { upsert: true },
  );
  console.log("📲 notifications reset — every SMS kind OFF, check-in reminder date cleared:");
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS.notifications)) console.log(`   ${v ? "🟢" : "⚫"} ${k}`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
