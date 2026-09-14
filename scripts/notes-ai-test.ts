/**
 * Prompt lab for "Organizar observações" (camperNotesAi). Feeds the raw
 * registration text of real kids (Supabase export in .supabase-children.json,
 * the same blob the admin pastes into "Observações gerais") through every
 * model and prints the sorted fields side by side, so the prompt can be
 * tuned until the answers agree.
 *
 *   set -a; source .env; set +a
 *   MODE=live|bulk bun run scripts/notes-ai-test.ts [limit] [model,model|all] [offset] [name-filter]
 *
 * MODE picks the prompt + reasoning effort (default "live"). The model list
 * defaults to that mode's chain; "all" runs every model of both chains.
 */
import { NOTES_MODES, sortCamperNotes, type CamperNotesFields, type NotesMode, type NotesModel } from "../src/services/camperNotesAi";

interface Row {
  nome: string;
  alergias: string | null;
  condicao_cronica: string | null;
  medicacao_uso_diario: string | null;
  observacoes_gerais: string | null;
  observacoes_medicas: string | null;
  contato_emergencia: string | null;
  preferencia_quarto: string | null;
}

const limit = Number(process.argv[2] ?? 5);
const only = process.argv[3]?.split(",").filter(Boolean);
const offset = Number(process.argv[4] ?? 0);
const filter = (process.argv[5] ?? "").toLowerCase();
const mode: NotesMode = process.env.MODE === "bulk" ? "bulk" : "live";
const everyModel = [...NOTES_MODES.live.models, ...NOTES_MODES.bulk.models].filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i);
const models: NotesModel[] = only?.[0] === "all" ? everyModel : only?.length ? everyModel.filter((m) => only.includes(m.id)) : NOTES_MODES[mode].models;
console.log(`mode=${mode} effort=${NOTES_MODES[mode].reasoningEffort} models=${models.map((m) => m.id).join(",")}`);

const rows = (await Bun.file(new URL("./.supabase-children.json", import.meta.url)).json()) as Row[];

/** what the parents wrote, the way it lands in the clipboard: the "observacoes_medicas" blob already joins the form fields with " | " */
function rawText(r: Row): string {
  const parts = [r.observacoes_medicas, r.alergias && `Alergias: ${r.alergias}`, r.contato_emergencia && `Contato de emergência: ${r.contato_emergencia}`];
  // fields not already inside the blob
  if (r.condicao_cronica && !r.observacoes_medicas?.includes(r.condicao_cronica)) parts.push(`Condição crônica: ${r.condicao_cronica}`);
  if (r.medicacao_uso_diario && !r.observacoes_medicas?.includes(r.medicacao_uso_diario)) parts.push(`Medicação: ${r.medicacao_uso_diario}`);
  if (r.observacoes_gerais && !r.observacoes_medicas?.includes(r.observacoes_gerais.slice(0, 40))) parts.push(r.observacoes_gerais);
  if (r.preferencia_quarto && !r.observacoes_medicas?.includes(r.preferencia_quarto)) parts.push(`Prefere dividir quarto com: ${r.preferencia_quarto}`);
  return parts.filter(Boolean).join("\n");
}

const kids = rows
  .map((r) => ({ name: r.nome, notes: rawText(r) }))
  .filter((k) => k.notes && (!filter || k.name.toLowerCase().includes(filter)))
  // hardest first
  .sort((a, b) => b.notes.length - a.notes.length)
  .slice(offset, offset + limit);

function print(f: CamperNotesFields) {
  const line = (label: string, v: unknown) => {
    if (v === "" || v === false || v === null || (Array.isArray(v) && !v.length)) return;
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
  line("peso", f.weightKg);
  line("convênio", f.insurance);
  line("carteirinha", f.insuranceCard);
  line("cpf", f.cpf);
  line("rg", f.rg);
  line("escola", f.school);
  line("série", f.schoolGrade);
  line("igreja", f.church);
  line("convidado", f.invitedBy);
  line("responsável", f.guardianName);
  line("tel resp", f.guardianPhone);
  line("cpf resp", f.guardianCpf);
  line("email resp", f.guardianEmail);
  line("gerais", f.generalNotes);
}

for (const k of kids) {
  console.log(`\n${"═".repeat(100)}\n${k.name}\n${"─".repeat(100)}\n${k.notes}\n`);
  const answers = await Promise.all(
    models.map(async (m) => {
      const started = Date.now();
      const r = await sortCamperNotes({ notes: k.notes, current: {} }, { mode, models: [m] });
      return { m, r, ms: Date.now() - started };
    }),
  );
  for (const { m, r, ms } of answers) {
    console.log(`▶ ${m.label} (${ms}ms)`);
    if (!r) console.log("  FAILED");
    else print(r.fields);
  }
}
process.exit(0);
