/**
 * Dev helper: inserts a handful of "🧪 TESTE" events for TODAY around the
 * current time (two finished, one happening now, one upcoming) so the
 * team schedule's "agora" marker and the collapsed-past toggle can be
 * exercised without waiting for the real programme.
 *
 *   bun run src/scripts/seedTestToday.ts          # add
 *   bun run src/scripts/seedTestToday.ts --clean  # remove every 🧪 TESTE event
 */
import { closeDb, getDb } from "../db";
import { insertEvent } from "../models/schedule";

const TAG = "🧪 TESTE";
const db = await getDb();

if (process.argv.includes("--clean")) {
  const { deletedCount } = await db.collection("schedule_events").deleteMany({ title: { $regex: `^${TAG}` } });
  console.log(`removed ${deletedCount} test event(s)`);
  await closeDb();
  process.exit(0);
}

const pad = (n: number) => String(n).padStart(2, "0");
const now = new Date();
const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const hm = (offsetMin: number) => {
  const d = new Date(now.getTime() + offsetMin * 60_000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const events = [
  { title: `${TAG} — já aconteceu 1`, emoji: "⏪", start: -180, end: -120 },
  { title: `${TAG} — já aconteceu 2`, emoji: "⏪", start: -90, end: -30 },
  { title: `${TAG} — acontecendo agora`, emoji: "🔥", start: -10, end: 30 },
  { title: `${TAG} — ainda vai acontecer`, emoji: "⏩", start: 60, end: 120 },
];

for (const e of events) {
  await insertEvent({ date, title: e.title, emoji: e.emoji, startTime: hm(e.start), endTime: hm(e.end), notes: "Evento de teste — pode apagar.", roles: [], assignments: [] });
  console.log(`+ ${date} ${hm(e.start)}–${hm(e.end)} ${e.title}`);
}
await closeDb();
