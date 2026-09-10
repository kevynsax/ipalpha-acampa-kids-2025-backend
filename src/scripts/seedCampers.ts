/**
 * Seeds the CAMPERS (acampantes) from the 2025 registration export and links
 * each kid to bedroom, bed (cima/baixo), team, transport and health
 * categories.
 *
 * Source (kept OUT of git — see .gitignore):
 *   data/acampakids_lista_geral_alfabetica.xlsx
 *
 * Requires: seed:categories, seed:bedrooms (run before).
 *
 * Re-runnable: kids are matched by name (case/accent-insensitive). Links are
 * refreshed on every run; notes/health text only set on insert.
 *
 *   bun run seed:campers
 */
import * as XLSX from "xlsx";
import { closeDb } from "../db";
import { listBedrooms } from "../models/bedrooms";
import { ensureCamperIndexes, findCamperByName, insertCamper, updateCamper, type CamperData } from "../models/campers";
import { listCategories } from "../models/categories";
import { normalizeBrazilPhone } from "../utils";
import { splitHealthNotes } from "./_healthNotes";

const XLSX_PATH = new URL("../../data/acampakids_lista_geral_alfabetica.xlsx", import.meta.url).pathname;

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

function titleCase(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => (/^(de|da|do|dos|das|e)$/i.test(w) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

/** "11/08/2015" → "2015-08-11" (null when missing/invalid) */
function isoDate(br: string): string | null {
  const m = br.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

const NO = /^(n[aã]o|nenhum[a]?|-)$/i;

const ALLERGY_RULES: [RegExp, string][] = [
  [/rinite|renite/i, "Rinite alérgica"],
  [/poeira|mofo|\bp[óo]\b|fungos|leveduras/i, "Poeira / mofo"],
  [/gato|cachorro|pelo/i, "Pelos de animais"],
  [/picada|inseto|formiga|mordida/i, "Picada de inseto"],
  [/lactose|leite/i, "Lactose / leite"],
  [/gl[uú]ten/i, "Glúten"],
  [/amendoim/i, "Amendoim"],
  [/peixe|frutos do mar/i, "Peixe / frutos do mar"],
  [/corante/i, "Corante"],
  [/pimenta/i, "Pimenta"],
];
/** drugs the kid must NOT take — their own category (💉), not mixed with food/environment */
const DRUG_RULES: [RegExp, string][] = [
  [/dipirona/i, "Dipirona"],
  [/paracetamol/i, "Paracetamol"],
  [/ibuprofeno/i, "Ibuprofeno"],
  [/nimesulida/i, "Nimesulida"],
  [/amoxicilina/i, "Amoxicilina"],
  [/benzetacil|penicilina/i, "Penicilina / Benzetacil"],
  [/plasil/i, "Plasil"],
];
const HEALTH_RULES: [RegExp, string][] = [
  [/asma|asm[aá]tic/i, "Asma"],
  [/bronquite/i, "Bronquite"],
  [/diabetes/i, "Diabetes"],
  [/cardiopatia/i, "Cardiopatia"],
  [/artrite/i, "Artrite reumatoide juvenil"],
  [/tdah/i, "TDAH"],
  [/autis/i, "Autismo (TEA)"],
];

async function main() {
  await ensureCamperIndexes();

  const categories = await listCategories();
  const cat = (key: string) => categories.find((c) => c.key === key)!;
  const optByLabel = (key: string, label: string) => cat(key).options.find((o) => norm(o.label) === norm(label))?.id ?? null;
  const teamId = (raw: string) => {
    if (!raw) return null;
    const want = norm(raw).replace(/^time /, "").replace("galeleia", "galileia");
    return cat("equipe").options.find((o) => norm(o.label).replace(/^time /, "") === want)?.id ?? null;
  };
  const bedrooms = await listBedrooms();
  const bedroomId = (raw: string) => {
    const m = raw.match(/\d{3}/);
    return m ? (bedrooms.find((b) => b.name === m[0])?._id ?? null) : null;
  };

  const wb = XLSX.readFile(XLSX_PATH);
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" }).slice(1);

  let inserted = 0;
  let updated = 0;
  const warn = new Set<string>();
  for (const r of rows) {
    const s = (i: number) => String(r[i] ?? "").trim();
    if (!s(0)) continue;
    const name = titleCase(s(0));

    // structured health from the explicit columns + the notes column
    const allergyText = NO.test(s(6)) ? "" : s(6);
    const chronicText = s(7);
    const notes = s(10);
    const allergies = new Set<string>();
    const drugAllergies = new Set<string>();
    const healthIssues = new Set<string>();
    for (const [re, label] of ALLERGY_RULES) if (re.test(allergyText)) allergies.add(optByLabel("alergias", label)!);
    for (const [re, label] of DRUG_RULES) if (re.test(allergyText)) drugAllergies.add(optByLabel("alergia-medicamentos", label)!);
    // "asma" written in the allergy column is a condition, not an allergy
    for (const [re, label] of HEALTH_RULES) if (re.test(`${chronicText} ${allergyText}`)) healthIssues.add(optByLabel("condicao-cronica", label)!);
    // unmatched non-empty allergy text → "Outro medicamento" only if it looks like a drug
    if (allergyText && allergies.size === 0 && drugAllergies.size === 0 && /med|rem[eé]dio/i.test(allergyText)) drugAllergies.add(optByLabel("alergia-medicamentos", "Outro medicamento")!);

    const links = {
      team: teamId(s(2)),
      bedroom: bedroomId(s(3)),
      bed: s(4) ? optByLabel("cama", s(4)) : null,
      transportation: s(5) ? optByLabel("transporte", s(5)) : null,
    };
    if (s(2) && !links.team) warn.add(`team "${s(2)}"`);
    if (s(3) && !links.bedroom) warn.add(`room "${s(3)}"`);
    if (s(5) && !links.transportation) warn.add(`transport "${s(5)}"`);

    const existing = await findCamperByName(name);
    if (existing) {
      await updateCamper(existing._id, links);
      updated++;
      continue;
    }

    // "Observações médicas" repeats weight / insurance / medicines / etc. that
    // already have their own column → keep only the extra bits
    const split = splitHealthNotes(notes, { medicines: s(8), generalNotes: s(11), chronic: chronicText });
    if (split.weightRaw) warn.add(`weight "${split.weightRaw}" (${name})`);

    const data: CamperData = {
      name,
      birthDate: isoDate(s(1)),
      ...links,
      weightKg: split.weightKg,
      allergies: [...allergies].filter(Boolean),
      drugAllergies: [...drugAllergies].filter(Boolean),
      healthIssues: [...healthIssues].filter(Boolean),
      medicines: s(8),
      foodRestrictions: s(9),
      healthNotes: [allergyText && `Alergias: ${allergyText}`, chronicText && `Condição: ${chronicText}`, split.healthNotes].filter(Boolean).join(" | "),
      generalNotes: split.generalNotes,
      bedroomPreference: split.bedroomPreference,
      insurance: s(12),
      insuranceCard: s(13),
      emergencyContact: s(14),
      guardianName: titleCase(s(15)),
      guardianPhone: normalizeBrazilPhone(s(16)) ?? null,
    };
    await insertCamper(data);
    inserted++;
  }

  for (const w of warn) console.warn(`  ⚠️  not found: ${w}`);
  console.log(`  🧒 ${inserted + updated} acampantes (${inserted} inseridos, ${updated} atualizados)`);
  console.log("\n🌱 Campers ready.\n");
  await closeDb();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
