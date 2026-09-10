/**
 * Campers + staff: the free-text "healthNotes" was built from the form's
 * "Alergias: … | Condição: …" / "Alergia/restrição: …" answers, which the seed
 * ALSO turned into structured chips (allergies / healthIssues) and
 * foodRestrictions. This removes every segment that says nothing beyond the
 * chips + food text, and strips the "Alergias:" style prefixes from what stays
 * (the icon already tells what it is).
 *
 * A segment is redundant when, after removing the words covered by the chip
 * labels / matching rules / food text / connector words, nothing meaningful
 * is left. "Cardiopatia congênita - insuficiência da válvula pulmonar" keeps
 * its extra info; "Rinite alérgica e picada de insetos" (both chips) goes.
 *
 * Idempotent. Pass --dry to only print what would change.
 *
 *   bun run src/scripts/dedupHealthNotes.ts [--dry]
 */
import { closeDb, getDb } from "../db";

const DRY = process.argv.includes("--dry");
const SEP = " | ";

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/** "Alergias:", "Condição:", "Alergia/restrição:", "Problema de saúde:", "Restrição alimentar:" … */
const PREFIX = /^(alergias?(\/restri[cç][aã]o)?|condi[cç][aã]o( cr[oô]nica)?|problemas? de sa[uú]de|restri[cç][aã]o alimentar|medica[cç][aã]o de uso di[aá]rio|outras observa[cç][oõ]es)\s*:\s*/i;

/** words that carry no information on their own in this context */
const STOP = new Set(
  `a as o os e ou de do da dos das em no na nos nas com sem para por que um uma
   alergia alergias alergica alergico alergicas alergicos alergia/restricao restricao restricoes alimentar
   picada picadas mordida mordidas inseto insetos formiga formigas
   problema problemas saude condicao cronica sim nao tenho tem possui
   remedio remedios medicamento medicamentos
   derivados mar tipo leve intolerancia intolerante todas todos possiveis existentes`
    .split(/\s+/)
    .filter(Boolean),
);

/** synonyms the chips imply (chip label → words it covers) */
const COVERS: Record<string, string[]> = {
  "rinite alergica": ["rinite", "renite"],
  rinite: ["rinite", "renite"],
  "poeira / mofo": ["poeira", "poeiras", "po", "mofo", "fungos", "leveduras"],
  "pelos de animais": ["pelo", "pelos", "gato", "gatos", "cachorro", "cachorros"],
  "picada de inseto": ["picada", "picadas", "inseto", "insetos", "formiga", "mordida"],
  "lactose / leite": ["lactose", "leite", "laticinios"],
  gluten: ["gluten", "celiaca", "celiaco"],
  amendoim: ["amendoim"],
  "peixe / frutos do mar": ["peixe", "peixes", "frutos", "camarao", "marisco"],
  corante: ["corante", "corantes"],
  pimenta: ["pimenta"],
  asma: ["asma", "asmatica", "asmatico"],
  bronquite: ["bronquite"],
  "penicilina / benzetacil": ["penicilina", "benzetacil"],
  "autismo (tea)": ["autismo", "autista", "tea"],
};

function coveredWords(chipLabels: string[], extraText: string): Set<string> {
  const w = new Set<string>();
  for (const label of chipLabels) {
    const n = norm(label);
    for (const t of n.split(/[^a-z0-9]+/)) if (t) w.add(t);
    for (const t of COVERS[n] ?? []) w.add(t);
  }
  for (const t of norm(extraText).split(/[^a-z0-9]+/)) if (t) w.add(t);
  return w;
}

/** strips the prefix; returns "" when the segment adds nothing to the chips */
function reduce(segment: string, covered: Set<string>): string {
  const body = segment.replace(PREFIX, "").trim();
  if (!body) return "";
  const words = norm(body)
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t) && !covered.has(t));
  return words.length === 0 ? "" : body;
}

async function run(collection: "campers" | "staff", label: Map<string, string>) {
  const db = await getDb();
  const people = await db.collection(collection).find({ healthNotes: { $nin: ["", null] } }).toArray();
  let changed = 0;
  for (const p of people) {
    const chips = [...((p.allergies as string[]) ?? []), ...((p.healthIssues as string[]) ?? [])].map((id) => label.get(id) ?? "");
    const covered = coveredWords(chips, `${p.foodRestrictions ?? ""} ${p.medicines ?? ""}`);
    const kept = new Set<string>();
    for (const seg of String(p.healthNotes).split(SEP)) {
      const r = reduce(seg.trim(), covered);
      if (r) kept.add(r);
    }
    const next = [...kept].join(SEP);
    if (next === p.healthNotes) continue;
    changed++;
    console.log(`  ${String(p.name).padEnd(34)} ${String(p.healthNotes)}\n  ${"".padEnd(34)} → ${next || "(vazio)"}`);
    if (!DRY) await db.collection(collection).updateOne({ _id: p._id }, { $set: { healthNotes: next, updatedAt: new Date() } });
  }
  console.log(`${DRY ? "[dry] " : ""}${collection}: ${changed} alterados, ${people.length - changed} mantidos.\n`);
}

async function main() {
  const db = await getDb();
  const cats = await db.collection("categories").find({}).toArray();
  const label = new Map<string, string>();
  for (const c of cats) for (const o of (c.options as { id: string; label: string }[]) ?? []) label.set(o.id, o.label);

  await run("campers", label);
  await run("staff", label);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
