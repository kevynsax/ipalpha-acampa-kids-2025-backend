/**
 * Existing campers: pulls the weight out of "Observações médicas" into the
 * `weightKg` field and drops the parts of that text that just repeat other
 * columns (insurance, daily medication, chronic condition, general notes).
 * "Prefere dividir quarto com" moves to general notes.
 *
 * Idempotent. Pass --dry to only print what would change.
 *
 *   bun run src/scripts/cleanHealthNotes.ts [--dry]
 */
import { closeDb, getDb } from "../db";
import { splitHealthNotes } from "./_healthNotes";

const DRY = process.argv.includes("--dry");

async function main() {
  const db = await getDb();
  const kids = await db.collection("campers").find({ healthNotes: { $nin: ["", null] } }).toArray();

  let changed = 0;
  for (const k of kids) {
    const healthNotes = String(k.healthNotes ?? "");
    const generalNotes = String(k.generalNotes ?? "");
    const split = splitHealthNotes(healthNotes, { medicines: String(k.medicines ?? ""), generalNotes });
    const weightKg = split.weightKg ?? (typeof k.weightKg === "number" ? k.weightKg : null);

    const same = split.healthNotes === healthNotes && split.generalNotes === generalNotes && weightKg === (k.weightKg ?? null);
    if (same) continue;
    changed++;

    console.log(`\n${String(k.name)}`);
    if (weightKg !== (k.weightKg ?? null)) console.log(`  ⚖️  ${weightKg ?? "?"} kg`);
    if (split.weightRaw) console.log(`  ⚠️  peso ilegível: "${split.weightRaw}"`);
    if (split.healthNotes !== healthNotes) console.log(`  🩺 ${healthNotes}\n   → ${split.healthNotes || "(vazio)"}`);
    if (split.generalNotes !== generalNotes) console.log(`  📝 ${generalNotes || "(vazio)"}\n   → ${split.generalNotes}`);

    if (!DRY) {
      await db
        .collection("campers")
        .updateOne({ _id: k._id }, { $set: { weightKg, healthNotes: split.healthNotes, generalNotes: split.generalNotes, updatedAt: new Date() } });
    }
  }

  console.log(`\n${DRY ? "[dry] " : ""}${changed} alterados, ${kids.length - changed} mantidos.\n`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
