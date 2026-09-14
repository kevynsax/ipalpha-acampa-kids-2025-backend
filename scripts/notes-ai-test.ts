/**
 * Prompt lab for "Organizar observações" (camperNotesAi). Runs the same
 * observations through every model and prints the sorted fields side by
 * side, so the prompt can be tuned until the answers agree.
 *
 *   set -a; source .env; set +a
 *   bun run scripts/notes-ai-test.ts [limit] [model,model]
 */
import { listCampers } from "../src/models/campers";
import { NOTES_MODELS, sortCamperNotes } from "../src/services/camperNotesAi";

const limit = Number(process.argv[2] ?? 5);
const only = process.argv[3]?.split(",").filter(Boolean);
const models = only ? NOTES_MODELS.filter((m) => only.includes(m.id)) : NOTES_MODELS;

const offset = Number(process.argv[4] ?? 0);
// hardest first: kids whose parents wrote real notes
const campers = (await listCampers())
  .filter((c) => c.generalNotes || c.healthNotes || c.emergencyContact || c.bedroomPreference)
  .sort((a, b) => (b.generalNotes.length + b.healthNotes.length) - (a.generalNotes.length + a.healthNotes.length))
  .slice(offset, offset + limit);

for (const k of campers) {
  // the raw registration text: everything the parents wrote, mixed, as it would be pasted
  const notes = [k.generalNotes, k.healthNotes, k.emergencyContact && `Contato de emergência: ${k.emergencyContact}`, k.bedroomPreference && `Quer ficar com: ${k.bedroomPreference}`].filter(Boolean).join("\n");
  console.log(`\n${"═".repeat(100)}\n${k.name}\n${"─".repeat(100)}\n${notes}\n`);
  const answers = await Promise.all(
    models.map(async (m) => {
      const started = Date.now();
      const r = await sortCamperNotes({ notes, current: { allergies: k.allergies, healthIssues: k.healthIssues, drugAllergies: k.drugAllergies, neurodivergent: k.neurodivergent } }, { models: [m] });
      return { m, r, ms: Date.now() - started };
    }),
  );
  for (const { m, r, ms } of answers) {
    console.log(`▶ ${m.label} (${ms}ms)`);
    if (!r) {
      console.log("  FAILED");
      continue;
    }
    const f = r.fields;
    const line = (label: string, v: unknown) => {
      if (v === "" || v === false || (Array.isArray(v) && !v.length)) return;
      console.log(`  ${label.padEnd(12)} ${typeof v === "string" ? v.replace(/\n/g, " ⏎ ") : JSON.stringify(v)}`);
    };
    line("alergias", f.allergies);
    line("alergia med", f.drugAllergies);
    line("crônicas", f.healthIssues);
    line("neuro", f.neurodivergent);
    line("medicação", f.medications.map((x) => `${x.name} ${x.dose} [${x.asNeeded ? "SOS" : x.times.join(",")}] ${x.notes}`));
    line("alimentação", f.foodRestrictions);
    line("saúde", f.healthNotes);
    line("quarto", f.bedroomPreference);
    line("emergência", f.emergencyContact);
    line("gerais", f.generalNotes);
  }
}
process.exit(0);
