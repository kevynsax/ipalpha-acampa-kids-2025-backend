/**
 * Seeds the STAFF (equipe) and links each person to their bedroom, team,
 * transport, health categories and to the schedule (event assignments).
 *
 * Sources (kept OUT of git — see .gitignore):
 *   data/voluntarios-acampa-kids.xlsx   name, RG, phone, team, room, transport, health, status
 *   data/escala-equipe-2025.txt         `pdftotext -layout AcampaKids.pdf` — one row per
 *                                        volunteer, one column per event, cell = role.
 *                                        The 2nd column ("PG") is the person's function in
 *                                        the pequeno grupo: Líder (gives the study) or Auxiliar.
 *
 * Requires: seed:categories, seed:bedrooms, seed:schedule (run before).
 *
 * Re-runnable: people are matched by phone, falling back to name. Fields the
 * admin may have edited (name, active, observations) are only set on insert;
 * links (team/bedroom/transport) and schedule assignments are refreshed.
 *
 *   bun run seed:staff
 */
import * as XLSX from "xlsx";
import { closeDb } from "../db";
import { findBedroomByName, listBedrooms } from "../models/bedrooms";
import { listCategories } from "../models/categories";
import { listEvents, listRoles, updateEvent } from "../models/schedule";
import { ensureStaffIndexes, insertStaff, listStaff, updateStaff, type StaffData } from "../models/staff";
import type { EventAssignment } from "../types";
import { normalizeBrazilPhone } from "../utils";

const XLSX_PATH = new URL("../../data/voluntarios-acampa-kids.xlsx", import.meta.url).pathname;
const SCHEDULE_PATH = new URL("../../data/escala-equipe-2025.txt", import.meta.url).pathname;

// ── helpers ─────────────────────────────────────────────────────────────────

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** "ANNA SOPHIA MUNIZ" → "Anna Sophia Muniz" (keeps "Jr", "D'Amore"…) */
function titleCase(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w) => (w.length <= 2 && /^(de|da|do|e)$/i.test(w) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ")
    .replace(/D'(\w)/g, (_, c: string) => `D'${c.toUpperCase()}`);
}

// ── source 1: spreadsheet ──────────────────────────────────────────────────

interface Row {
  name: string;
  phone: string | null;
  team: string;
  room: string;
  transport: string;
  health: string;
  status: string;
}

function readSpreadsheet(): Row[] {
  const wb = XLSX.readFile(XLSX_PATH);
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
  return rows
    .slice(1)
    .filter((r) => String(r[0]).trim())
    .map((r) => ({
      name: titleCase(String(r[0])),
      phone: normalizeBrazilPhone(String(r[2])) ?? null,
      team: String(r[3]).trim(),
      room: String(r[4]).trim(),
      transport: String(r[5]).trim(),
      health: String(r[6]).trim(),
      status: String(r[7]).trim(),
    }));
}

// ── source 2: schedule matrix (PDF text) ───────────────────────────────────

interface ScheduleRow {
  name: string;
  /** "Líder" | "Auxiliar" (PG column) */
  pg: string;
  /** event column title → cell text */
  cells: { event: string; text: string }[];
}

async function readScheduleMatrix(): Promise<{ events: string[]; rows: ScheduleRow[] }> {
  const text = await Bun.file(SCHEDULE_PATH).text();
  const lines = text.split("\n").filter((l) => l.trim());
  const header = lines[0];
  const cols = [...header.matchAll(/\S+(?: \S+)*/g)].map((m) => ({ name: m[0], start: m.index! }));
  const rows: ScheduleRow[] = [];
  for (const line of lines.slice(1)) {
    const name = line.slice(cols[0].start, cols[1].start).trim();
    if (!name) continue;
    const pg = line.slice(cols[1].start, cols[2].start).trim();
    const cells = [];
    for (let i = 2; i < cols.length; i++) {
      const s = cols[i].start;
      const e = i + 1 < cols.length ? cols[i + 1].start : line.length;
      cells.push({ event: cols[i].name, text: line.slice(s, e).trim() });
    }
    rows.push({ name, pg, cells });
  }
  return { events: cols.slice(2).map((c) => c.name), rows };
}

/** PDF nickname → spreadsheet name, where first-name matching is ambiguous or absent. */
const SCHEDULE_ALIASES: Record<string, string> = {
  "aurelio dici": "Aurélio Carlos Martino Jr",
  "dani luque": "Daniela Luque",
  "duda damore": "Eduarda D'Amore",
  "gabi santacruz": "Gabi Santa Cruz",
  "henrique rosa": "Henrique",
  leone: "Lucas Leone",
  "mari zambrana": "Mariana Sartori",
  "michelle aroni": "Michele Aroni",
  priscilla: "Pri Mafra",
  tonon: "Lucas Tonon",
  wesley: "Weslei",
  "thiago santacruz": "Thiago Santa Cruz",
};

/**
 * Columns of the PDF (in order) → seeded event(s) (date + startTime, see
 * seedSchedule.ts). The two repeated columns at the end are Sunday.
 * "Ao Acordar" maps to TWO events: the role decides which one (Inspção goes
 * to "Inspeção nos quartos", the rest to "Acordar").
 */
const EVENT_COLUMNS: { date: string; startTime: string }[][] = [
  [{ date: "2026-09-12", startTime: "08:00" }, { date: "2026-09-12", startTime: "08:15" }], // Ao Acordar
  [{ date: "2026-09-12", startTime: "08:30" }], // Café da manhã
  [{ date: "2026-09-12", startTime: "12:30" }], // Almoço
  [{ date: "2026-09-12", startTime: "14:00" }], // Piscina
  [{ date: "2026-09-12", startTime: "15:30" }], // Brincadeira tarde (Canibal)
  [{ date: "2026-09-12", startTime: "19:00" }], // Jantar
  [{ date: "2026-09-12", startTime: "21:45" }], // Brincadeira noturna
  [{ date: "2026-09-13", startTime: "08:30" }], // Café da manhã (dom)
  [{ date: "2026-09-13", startTime: "11:30" }], // Piscina (dom)
];

/** The two PG events (see seedSchedule.ts) and the role each PG function maps to there. */
const PG_EVENTS: { date: string; startTime: string; leader: string }[] = [
  { date: "2026-09-12", startTime: "10:45", leader: "Líder do PG — Dia 1" },
  { date: "2026-09-13", startTime: "10:45", leader: "Líder do PG — Dia 2" },
];
const PG_HELPER_ROLE = "Auxiliar do PG";

/** "BELEM" / "GALELEIA" (PDF, unaccented, sometimes misspelt) → "Time Belém" (category label) */
function teamLabel(raw: string, teamLabels: string[]): string {
  const want = norm(raw).replace("galeleia", "galileia");
  return teamLabels.find((l) => norm(l).replace(/^time /, "") === want) ?? `Time ${titleCase(raw)}`;
}

/** PDF cell → { role name (seedSchedule), detail } */
function parseRoleCell(cell: string, teamLabels: string[]): { role: string; detail: string } | null {
  const c = norm(cell);
  if (!c) return null;
  if (c.startsWith("ajudar as criancas")) return { role: "Ajudar as crianças a arrumar o quarto", detail: "" };
  if (c === "inspecao") return { role: "Inspeção", detail: "" };
  if (c === "radio") return { role: "Rádio", detail: "" };
  if (c === "cuidar criancas") return { role: "Cuidar das crianças", detail: "" };
  if (c === "cuidar criancas fora piscina") return { role: "Cuidar das crianças fora da piscina", detail: "" };
  if (c.startsWith("cuidar criancas que nao querem")) return { role: "Cuidar das crianças que não querem jogar", detail: "" };
  if (c.startsWith("supervisao")) return { role: "Supervisão da piscina", detail: cell.match(/\((.+)\)/)?.[1] ?? "" };
  if (c === "pontuacao fantasia") return { role: "Pontuação fantasia", detail: "" };
  if (c === "organizacao") return { role: "Organização", detail: "" };
  if (c === "canibal") return { role: "Canibal", detail: "" };
  let m = c.match(/^cor (\d+)$/);
  if (m) return { role: "Cor", detail: `Cor ${m[1]}` };
  m = c.match(/^base (\d+)$/);
  if (m) return { role: "Base", detail: `Base ${m[1]}` };
  m = cell.match(/^CORINGA (.+)$/i);
  if (m) return { role: "Coringa do time", detail: teamLabel(m[1], teamLabels) };
  m = cell.match(/^CAMINHAR COM (.+)$/i);
  if (m) return { role: "Caminhar com o time", detail: teamLabel(m[1], teamLabels) };
  console.warn(`  ⚠️  unknown role cell: "${cell}"`);
  return null;
}

// ── health text → category options + free text ────────────────────────────

const ALLERGY_RULES: [RegExp, string][] = [
  [/rinite/i, "Rinite alérgica"],
  [/lactose|leite/i, "Lactose / leite"],
  [/gl[uú]ten|cel[ií]ac/i, "Glúten"],
  [/peixe|frutos do mar/i, "Peixe / frutos do mar"],
  [/pimenta/i, "Pimenta"],
];
/** drugs the person must NOT take — their own category (💉) */
const DRUG_RULES: [RegExp, string][] = [
  [/dipirona/i, "Dipirona"],
  [/nimesulida/i, "Nimesulida"],
  [/benzetacil|penicilina/i, "Penicilina / Benzetacil"],
  [/cipro|hydantal|rem[eé]dio|medicamento/i, "Outro medicamento"],
];
const HEALTH_RULES: [RegExp, string][] = [
  [/press[aã]o alta/i, "Pressão alta"],
  [/pr[eé]-?diabet/i, "Pré-diabetes"],
  [/\basma\b/i, "Asma"],
  [/labirintite/i, "Labirintite"],
];

function parseHealth(text: string, opt: (cat: string, label: string) => string) {
  const allergies = new Set<string>();
  const drugAllergies = new Set<string>();
  const healthIssues = new Set<string>();
  let foodRestrictions = "";
  if (!text) return { allergies: [], drugAllergies: [], healthIssues: [], foodRestrictions, healthNotes: "" };

  for (const [re, label] of ALLERGY_RULES) if (re.test(text)) allergies.add(opt("alergias", label));
  for (const [re, label] of DRUG_RULES) if (re.test(text)) drugAllergies.add(opt("alergia-medicamentos", label));
  for (const [re, label] of HEALTH_RULES) if (re.test(text)) healthIssues.add(opt("condicao-cronica", label));

  const food = text.match(/restri[cç][aã]o alimentar:\s*([^.]+)/i);
  if (food) foodRestrictions = food[1].trim();
  else if (/gl[uú]ten|lactose|leite/i.test(text) && !/rem[eé]dio|medicamento/i.test(text)) {
    foodRestrictions = text.replace(/^alergia\/restri[cç][aã]o:\s*/i, "").trim();
  }

  return { allergies: [...allergies], drugAllergies: [...drugAllergies], healthIssues: [...healthIssues], foodRestrictions, healthNotes: text };
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  await ensureStaffIndexes();

  // lookups
  const categories = await listCategories();
  const optionId = (catKey: string, label: string): string => {
    const cat = categories.find((c) => c.key === catKey);
    const o = cat?.options.find((x) => norm(x.label) === norm(label));
    if (!o) throw new Error(`option not found: ${catKey} / ${label}`);
    return o.id;
  };
  const teamId = (raw: string): string | null => {
    if (!raw) return null;
    const cat = categories.find((c) => c.key === "equipe")!;
    const want = norm(raw).replace(/^time /, "").replace("galeleia", "galileia");
    const o = cat.options.find((x) => norm(x.label).replace(/^time /, "") === want);
    if (!o) console.warn(`  ⚠️  team not found: "${raw}"`);
    return o?.id ?? null;
  };
  const transportId = (raw: string): string | null => {
    if (!raw) return null;
    const cat = categories.find((c) => c.key === "transporte")!;
    const o = cat.options.find((x) => norm(x.label) === norm(raw));
    if (!o) console.warn(`  ⚠️  transport not found: "${raw}"`);
    return o?.id ?? null;
  };
  const bedrooms = await listBedrooms();
  const bedroomId = async (raw: string): Promise<string | null> => {
    const m = raw.match(/\d{3}/);
    if (!m) return null; // "sem quarto"
    const b = bedrooms.find((x) => x.name === m[0]) ?? (await findBedroomByName(m[0]));
    if (!b) console.warn(`  ⚠️  bedroom not found: "${raw}"`);
    return b?._id ?? null;
  };

  // 1) staff from the spreadsheet
  const rows = readSpreadsheet();
  const existing = await listStaff();
  const byPhone = new Map(existing.filter((s) => s.phone).map((s) => [s.phone!, s]));
  const byName = new Map(existing.map((s) => [norm(s.name), s]));
  const idByName = new Map<string, string>();
  const usedPhones = new Set<string>();

  let inserted = 0;
  let updated = 0;
  for (const r of rows) {
    // two people share a phone in the sheet (family) → only the first keeps it
    let phone = r.phone;
    if (phone && usedPhones.has(phone)) {
      console.warn(`  ⚠️  ${r.name}: phone ${phone} already used by another member — left empty`);
      phone = null;
    }
    if (phone) usedPhones.add(phone);

    const links = {
      team: teamId(r.team),
      bedroom: await bedroomId(r.room),
      transportation: transportId(r.transport),
    };
    const health = parseHealth(r.health, optionId);

    const found = (phone && byPhone.get(phone)) || byName.get(norm(r.name));
    if (found) {
      await updateStaff(found._id, { ...links, ...(found.phone ? {} : { phone }) });
      idByName.set(norm(r.name), found._id);
      updated++;
    } else {
      const data: StaffData = {
        name: r.name,
        phone,
        active: !/inativ/i.test(r.status),
        ...links,
        allergies: health.allergies,
        drugAllergies: health.drugAllergies,
        foodRestrictions: health.foodRestrictions,
        healthIssues: health.healthIssues,
        medicines: "",
        healthNotes: health.healthNotes,
      };
      const created = await insertStaff(data);
      idByName.set(norm(r.name), created._id);
      inserted++;
    }
  }
  console.log(`  🎒 ${rows.length} pessoas (${inserted} inseridas, ${updated} atualizadas)`);

  // 2) schedule assignments from the PDF matrix
  const { rows: matrix } = await readScheduleMatrix();
  const roles = await listRoles();
  const roleIdByName = new Map(roles.map((r) => [norm(r.name), r._id]));
  const forEveryone = new Set(roles.filter((r) => r.forEveryone).map((r) => r._id));
  const events = await listEvents();
  const teamLabels = categories.find((c) => c.key === "equipe")!.options.map((o) => o.label);

  const resolveStaff = (pdfName: string): string | null => {
    const key = norm(pdfName);
    const alias = SCHEDULE_ALIASES[key];
    if (alias) return idByName.get(norm(alias)) ?? null;
    if (idByName.has(key)) return idByName.get(key)!;
    // first-name match when unique
    const first = key.split(" ")[0];
    const cands = [...idByName.keys()].filter((n) => n.split(" ")[0] === first);
    if (cands.length === 1) return idByName.get(cands[0])!;
    // "Anna Sophia" → "anna sophia muniz"
    const prefix = [...idByName.keys()].filter((n) => n.startsWith(key + " "));
    if (prefix.length === 1) return idByName.get(prefix[0])!;
    console.warn(`  ⚠️  schedule name not matched: "${pdfName}" (${cands.length} candidates)`);
    return null;
  };

  const perEvent = new Map<string, EventAssignment[]>(); // event _id → assignments
  let assigned = 0;
  for (const row of matrix) {
    const staffId = resolveStaff(row.name);
    if (!staffId) continue;
    row.cells.forEach((cell, i) => {
      const parsed = parseRoleCell(cell.text, teamLabels);
      if (!parsed) return;
      const roleId = roleIdByName.get(norm(parsed.role));
      if (!roleId) {
        console.warn(`  ⚠️  role not found: ${parsed.role}`);
        return;
      }
      // pick the candidate event (for this column) that actually has the role
      const candidates = EVENT_COLUMNS[i]
        .map((c) => events.find((e) => e.date === c.date && e.startTime === c.startTime))
        .filter((e): e is NonNullable<typeof e> => !!e);
      if (candidates.length === 0) {
        console.warn(`  ⚠️  event not found for column ${i}`);
        return;
      }
      const ev = candidates.find((e) => e.roles.includes(roleId));
      if (!ev) {
        console.warn(`  ⚠️  role "${parsed.role}" is not in ${candidates.map((e) => `"${e.title}"`).join(" / ")}`);
        return;
      }
      if (forEveryone.has(roleId)) return; // implicit — applies to the whole staff, no assignment needed
      const list = perEvent.get(ev._id) ?? [];
      if (!list.some((a) => a.staffId === staffId)) {
        list.push({ staffId, roleId, detail: parsed.detail });
        assigned++;
      }
      perEvent.set(ev._id, list);
    });

    // PG column → both PG events (the líder gets that day's study, the auxiliar the helper role)
    const pg = norm(row.pg);
    if (pg) {
      const roleName = pg === "lider" ? null : pg === "auxiliar" ? PG_HELPER_ROLE : undefined;
      if (roleName === undefined) {
        console.warn(`  ⚠️  unknown PG function: "${row.pg}" (${row.name})`);
      } else {
        for (const pgEvent of PG_EVENTS) {
          const ev = events.find((e) => e.date === pgEvent.date && e.startTime === pgEvent.startTime);
          const roleId = roleIdByName.get(norm(roleName ?? pgEvent.leader));
          if (!ev || !roleId) {
            console.warn(`  ⚠️  PG event/role not seeded for ${pgEvent.date} (run seed:schedule)`);
            continue;
          }
          const list = perEvent.get(ev._id) ?? [];
          if (!list.some((a) => a.staffId === staffId)) {
            list.push({ staffId, roleId, detail: "" });
            assigned++;
          }
          perEvent.set(ev._id, list);
        }
      }
    }
  }
  for (const [eventId, assignments] of perEvent) await updateEvent(eventId, { assignments });
  console.log(`  📅 ${assigned} escalações em ${perEvent.size} eventos`);

  console.log("\n🌱 Staff ready.\n");
  await closeDb();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
