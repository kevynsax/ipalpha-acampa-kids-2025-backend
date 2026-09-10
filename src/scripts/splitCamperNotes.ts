/**
 * Existing campers: pulls two things out of "Observações gerais" into their
 * own fields —
 *   • "Prefere dividir quarto com: …"  → bedroomPreference
 *   • notes that are about food        → foodRestrictions (kept out of
 *     general notes; sentences mixing food with something else stay put)
 *
 * Idempotent. Pass --dry to only print what would change.
 *
 *   bun run src/scripts/splitCamperNotes.ts [--dry]
 */
import { closeDb, getDb } from "../db";

const DRY = process.argv.includes("--dry");
const SEP = " | ";
const PREF = /^prefere dividir quarto com:\s*/i;
/** a whole note that is about eating/drinking — moved to foodRestrictions */
const FOOD = /\b(n[ãa]o come|s[óo] (come|bebe)|intoler[âa]ncia|lactose|gl[úu]ten|vegetarian|vegan|alergia .*leite|aliment)/i;
/** …unless it is really about something else too (bed, health protocol) */
const NOT_FOOD = /beliche|dormir|insulina|glicemia|vomita/i;

function classify(part: string): "pref" | "food" | "general" {
  if (PREF.test(part)) return "pref";
  if (FOOD.test(part) && !NOT_FOOD.test(part)) return "food";
  return "general";
}

async function main() {
  const db = await getDb();
  const kids = await db.collection("campers").find({ generalNotes: { $nin: ["", null] } }).toArray();

  let changed = 0;
  for (const k of kids) {
    const parts = String(k.generalNotes).split(SEP).map((p) => p.trim()).filter(Boolean);
    const general: string[] = [];
    const food: string[] = String(k.foodRestrictions ?? "").trim() ? [String(k.foodRestrictions).trim()] : [];
    const pref: string[] = String(k.bedroomPreference ?? "").trim() ? [String(k.bedroomPreference).trim()] : [];
    for (const p of parts) {
      const c = classify(p);
      if (c === "pref") pref.push(p.replace(PREF, ""));
      else if (c === "food") food.push(p);
      else general.push(p);
    }
    const next = { generalNotes: general.join(SEP), foodRestrictions: [...new Set(food)].join(SEP), bedroomPreference: [...new Set(pref)].join(SEP) };
    const same = next.generalNotes === k.generalNotes && next.foodRestrictions === (k.foodRestrictions ?? "") && next.bedroomPreference === (k.bedroomPreference ?? "");
    if (same) continue;
    changed++;
    console.log(`\n${String(k.name)}`);
    if (next.bedroomPreference !== (k.bedroomPreference ?? "")) console.log(`  🛏️  ${next.bedroomPreference}`);
    if (next.foodRestrictions !== (k.foodRestrictions ?? "")) console.log(`  🥗 ${next.foodRestrictions}`);
    if (next.generalNotes !== k.generalNotes) console.log(`  📝 ${next.generalNotes || "(vazio)"}`);
    if (!DRY) await db.collection("campers").updateOne({ _id: k._id }, { $set: { ...next, updatedAt: new Date() } });
  }

  console.log(`\n${DRY ? "[dry] " : ""}${changed} alterados, ${kids.length - changed} mantidos.\n`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
