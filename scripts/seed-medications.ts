/**
 * Test data for the Medicações tab (a dev machine — never production).
 *
 *   bun run scripts/seed-medications.ts          add the sample prescriptions
 *   bun run scripts/seed-medications.ts --undo   remove them again
 *
 * It only ever touches kids it marked itself: every medicine it writes carries
 * `seed: true`, and the undo deletes exactly those. A kid who already had
 * medication (real data typed by the parents / admin) is skipped entirely, so
 * nothing anybody entered by hand can be overwritten or lost.
 *
 * The ticks the medical team makes (`medicationDoses`) are NOT written here —
 * that is what you are testing. `--undo` clears the ones belonging to the
 * seeded medicines so a second run starts clean.
 */
import { getDb } from "../src/db";
import { migrateToCamps } from "../src/services/campMigration";

interface SeedMed {
  name: string;
  dose: string;
  times: string[];
  asNeeded: boolean;
  notes: string;
}

/** Shapes chosen to cover every branch of the page at once. */
const PLANS: { label: string; meds: SeedMed[] }[] = [
  // the plain case: one pill, one moment of the day
  { label: "one scheduled dose", meds: [{ name: "Ritalina", dose: "10mg", times: ["08:30"], asNeeded: false, notes: "junto com o café" }] },
  // several moments — the same kid shows up in three different blocks
  { label: "three scheduled doses", meds: [{ name: "Depakote", dose: "1 comprimido", times: ["08:30", "12:30", "22:00"], asNeeded: false, notes: "" }] },
  // two medicines at once, one of them at a custom time (not a preset)
  {
    label: "two medicines, custom time",
    meds: [
      { name: "Sertralina", dose: "50mg", times: ["08:30"], asNeeded: false, notes: "" },
      { name: "Colírio Hyabak", dose: "1 gota em cada olho", times: ["10:00", "16:30"], asNeeded: false, notes: "olho direito primeiro" },
    ],
  },
  // "quando necessário": repeatable, lands in its own block
  { label: "as-needed only", meds: [{ name: "Dipirona", dose: "20 gotas", times: [], asNeeded: true, notes: "se tiver febre acima de 38°" }] },
  // mixed: a fixed dose + an SOS one on the same kid
  {
    label: "scheduled + as-needed",
    meds: [
      { name: "Predsim", dose: "5ml", times: ["19:00"], asNeeded: false, notes: "" },
      { name: "Salbutamol", dose: "2 jatos", times: [], asNeeded: true, notes: "em caso de chiado no peito" },
    ],
  },
  // neither time nor SOS → the red "horário a confirmar" warning
  { label: "unscheduled (warning row)", meds: [{ name: "Amoxicilina", dose: "5ml", times: [], asNeeded: false, notes: "os pais não informaram o horário" }] },
];

const SEED_FLAG = "seed";

async function main() {
  const undo = process.argv.includes("--undo");
  const db = await getDb();
  await migrateToCamps(); // one-off scripts run outside the server boot: load the active camp so SCOPED collections resolve
  const campers = db.collection("campers");

  if (undo) {
    const touched = await campers.find({ "medications.seed": true }).project({ _id: 1, name: 1, medications: 1 }).toArray();
    let cleared = 0;
    for (const k of touched) {
      const kept = (k.medications as (SeedMed & { seed?: boolean })[]).filter((m) => m[SEED_FLAG] !== true);
      await campers.updateOne({ _id: k._id }, { $set: { medications: kept, updatedAt: new Date() } });
      cleared++;
    }
    // the ticks made against the seeded medicines go too, so the next run is clean
    const names = new Set(PLANS.flatMap((p) => p.meds.map((m) => m.name.toLowerCase())));
    const doses = await db.collection("medicationDoses").deleteMany({ medKey: { $in: [...names] } });
    console.log(`🧹 removed seeded medication from ${cleared} kid(s) and ${doses.deletedCount} tick(s).`);
    console.log("   Real prescriptions (no seed flag) were left untouched.");
    process.exit(0);
  }

  // only kids with NO medication at all: never touch what a human entered
  const free = await campers.find({ $or: [{ medications: { $exists: false } }, { medications: { $size: 0 } }] }).project({ _id: 1, name: 1 }).sort({ name: 1 }).toArray();
  if (free.length < PLANS.length) {
    console.error(`Only ${free.length} kid(s) without medication — need ${PLANS.length}. Run with --undo first.`);
    process.exit(1);
  }

  console.log(`Seeding ${PLANS.length} kid(s) (of ${free.length} without medication):\n`);
  for (let i = 0; i < PLANS.length; i++) {
    const kid = free[i];
    const plan = PLANS[i];
    const meds = plan.meds.map((m) => ({ ...m, [SEED_FLAG]: true }));
    await campers.updateOne({ _id: kid._id }, { $set: { medications: meds, updatedAt: new Date() } });
    console.log(`  ✅ ${kid.name} — ${plan.label}`);
    for (const m of plan.meds) {
      const when = m.asNeeded ? "quando necessário" : m.times.length ? m.times.join(", ") : "sem horário (a confirmar)";
      console.log(`       💊 ${m.name} ${m.dose} · ${when}`);
    }
  }
  console.log("\nOpen the Medicações tab as the medical team. Undo with: bun run scripts/seed-medications.ts --undo");
  process.exit(0);
}

await main();
