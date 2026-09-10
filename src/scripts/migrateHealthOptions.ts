/**
 * Re-files health chips after the taxonomy change:
 *   • drug allergies (Dipirona, Amoxicilina, …) lived in "Alergias" → now in
 *     "Alergia a medicamentos" (their own field: drugAllergies)
 *   • "Rinite" (condição crônica) duplicates "Rinite alérgica" (alergia) →
 *     the condition is dropped and the allergy is guaranteed
 *   • ids that point to options that no longer exist are removed
 *   • "Nenhuma" is never stored (an empty list means none)
 *
 * Needs `seed:categories` to have run first (it creates the new category and
 * keeps the old option ids around, hidden, so this script can find them).
 * Idempotent. Pass --dry to only print what would change.
 *
 *   bun run src/scripts/migrateHealthOptions.ts [--dry]
 */
import { closeDb, getDb } from "../db";
import { ObjectId } from "mongodb";
import { findCategoryByKey } from "../models/categories";

const DRY = process.argv.includes("--dry");
const lc = (s: string) => s.toLocaleLowerCase("pt-BR");

async function main() {
  const db = await getDb();
  const [allergies, drugs, conditions] = await Promise.all([findCategoryByKey("alergias"), findCategoryByKey("alergia-medicamentos"), findCategoryByKey("condicao-cronica")]);
  if (!allergies || !drugs || !conditions) throw new Error("run `bun run seed:categories` first");

  const drugByLabel = new Map(drugs.options.map((o) => [lc(o.label), o.id]));
  /** old allergy option id → new drug option id (same label) */
  const allergyToDrug = new Map<string, string>();
  for (const o of allergies.options) {
    if (lc(o.label) === "nenhuma") continue; // both categories have it; it is not a "move"
    const target = drugByLabel.get(lc(o.label));
    if (target) allergyToDrug.set(o.id, target);
  }
  const activeAllergy = new Set(allergies.options.filter((o) => o.active && lc(o.label) !== "nenhuma").map((o) => o.id));
  const activeDrug = new Set(drugs.options.filter((o) => o.active && lc(o.label) !== "nenhuma").map((o) => o.id));
  const activeCond = new Set(conditions.options.filter((o) => o.active && lc(o.label) !== "nenhuma").map((o) => o.id));
  const riniteAllergy = allergies.options.find((o) => lc(o.label) === "rinite alérgica")?.id;
  const riniteCond = conditions.options.find((o) => lc(o.label) === "rinite")?.id;

  let total = 0;
  for (const col of ["campers", "staff"] as const) {
    const people = await db.collection(col).find({}).toArray();
    let changed = 0;
    for (const p of people) {
      const a = new Set<string>();
      const d = new Set<string>((p.drugAllergies as string[]) ?? []);
      const h = new Set<string>();
      for (const id of (p.allergies as string[]) ?? []) {
        const drug = allergyToDrug.get(id);
        if (drug) d.add(drug);
        else if (activeAllergy.has(id)) a.add(id);
      }
      for (const id of (p.healthIssues as string[]) ?? []) {
        if (id === riniteCond) {
          if (riniteAllergy) a.add(riniteAllergy);
          continue;
        }
        if (activeCond.has(id)) h.add(id);
      }
      const next = { allergies: [...a], drugAllergies: [...d].filter((id) => activeDrug.has(id)), healthIssues: [...h] };
      const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
      if (same(next.allergies, p.allergies ?? []) && same(next.drugAllergies, p.drugAllergies ?? []) && same(next.healthIssues, p.healthIssues ?? [])) continue;
      changed++;
      const lab = (ids: string[], cat: typeof allergies) => ids.map((id) => cat.options.find((o) => o.id === id)?.label ?? "?").join(", ");
      console.log(`  ${String(p.name).padEnd(36)} 🤧 ${lab(next.allergies, allergies)}  💉 ${lab(next.drugAllergies, drugs)}  ⚠️ ${lab(next.healthIssues, conditions)}`);
      if (!DRY) await db.collection(col).updateOne({ _id: p._id }, { $set: { ...next, updatedAt: new Date() } });
    }
    console.log(`${DRY ? "[dry] " : ""}${col}: ${changed} alterados, ${people.length - changed} mantidos.\n`);
    total += changed;
  }

  // once nobody references the moved / dropped options any more, forget them
  if (!DRY) {
    const stillUsed = async (field: string, id: string) =>
      (await db.collection("campers").countDocuments({ [field]: id })) + (await db.collection("staff").countDocuments({ [field]: id })) > 0;
    const keepA: typeof allergies.options = [];
    for (const o of allergies.options) if (!(allergyToDrug.has(o.id) && !(await stillUsed("allergies", o.id)))) keepA.push(o);
    const keepC: typeof conditions.options = [];
    for (const o of conditions.options) if (!(o.id === riniteCond && !(await stillUsed("healthIssues", o.id)))) keepC.push(o);
    const idOf = (c: { _id: string }) => new ObjectId(c._id);
    if (keepA.length !== allergies.options.length) await db.collection("categories").updateOne({ _id: idOf(allergies) }, { $set: { options: keepA.map((o, i) => ({ ...o, order: i })), updatedAt: new Date() } });
    if (keepC.length !== conditions.options.length) await db.collection("categories").updateOne({ _id: idOf(conditions) }, { $set: { options: keepC.map((o, i) => ({ ...o, order: i })), updatedAt: new Date() } });
    console.log(`🧹 opções antigas removidas: ${allergies.options.length - keepA.length} alergias, ${conditions.options.length - keepC.length} condições`);
  }

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
