/**
 * Imports / refreshes the CAMPERS from the registration system export
 * (Supabase `children` joined with guardians, teams, rooms and buses).
 *
 * Source (kept OUT of git — see .gitignore):
 *   data/children.json   ← the JSON answered by the Supabase REST call
 *
 * Requires: seed:categories, seed:bedrooms (run before).
 *
 * The registration system is the SOURCE OF TRUTH. Kids are matched by
 * `externalId` (Supabase id), then by name (case/accent-insensitive; a local
 * name that ENDS with the remote name is also accepted and renamed). Every
 * field that exists remotely is overwritten (identity, guardian, links to
 * team / room / bed / bus, weight, notes…); kids that exist only locally are
 * DELETED. `tio_atribuido` (a first name / nickname) is resolved to the staff
 * member sleeping in the kid's room — who is then flagged `roomRole:
 * "caretaker"`; unresolved names are reported and the kid stays an orphan. Only the locally-curated health categories (allergies /
 * drugAllergies / healthIssues) and `healthNotes` are kept on existing kids.
 *
 *   bun run import:supabase          # apply
 *   bun run import:supabase --dry    # only report
 */
import { closeDb } from "../db";
import { listBedrooms } from "../models/bedrooms";
import { deleteCamper, ensureCamperIndexes, findCamperByExternalId, insertCamper, listCampers, updateCamper, type CamperData } from "../models/campers";
import { listCategories } from "../models/categories";
import { listStaff, updateStaff } from "../models/staff";
import { listTeams } from "../models/teams";
import type { Camper, CamperSex } from "../types";
import { normalizeBrazilPhone } from "../utils";

const JSON_PATH = new URL("../../data/children.json", import.meta.url).pathname;
const DRY = process.argv.includes("--dry");

interface RemoteChild {
  id: string;
  nome: string;
  cpf: string | null;
  data_nascimento: string | null;
  posicao_cama: string | null;
  alergias: string | null;
  alimentacao: string | null;
  observacoes_medicas: string | null;
  contato_emergencia: string | null;
  sexo: string | null;
  rg: string | null;
  escola: string | null;
  serie_escolar: string | null;
  peso: string | null;
  convenio_medico: string | null;
  numero_carteirinha: string | null;
  condicao_cronica: string | null;
  medicacao_uso_diario: string | null;
  observacoes_gerais: string | null;
  preferencia_quarto: string | null;
  frequenta_igreja: string | null;
  convidado_por: string | null;
  qr_token: string | null;
  tio_atribuido: string | null;
  guardians: { id: string; nome: string; cpf: string | null; telefone: string | null; email: string | null } | null;
  teams: { nome: string } | null;
  rooms: { nome: string } | null;
  buses: { nome: string } | null;
}

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

const str = (v: string | null | undefined) => (v ?? "").trim();
const words = (s: string) => norm(s).replace(/[^a-z0-9 ]/g, "").split(" ").filter(Boolean);
/** hand-made aliases: nickname in the registration system → staff name here */
const ALIASES: Record<string, string> = { lolly: "Isa Mafra", riciella: "Gabi Santa Cruz", ricciella: "Gabi Santa Cruz", "aurelio dici": "Aurélio Carlos Martino Jr", wesley: "Weslei", leone: "Lucas Leone", lais: "Laís" };
const NO = /^(n[aã]o|nenhum[a]?|-)$/i;
const meaningful = (v: string | null | undefined) => (NO.test(str(v)) ? "" : str(v));

function sexOf(v: string | null): CamperSex | null {
  const n = norm(v ?? "");
  if (n.startsWith("f")) return "F";
  if (n.startsWith("m")) return "M";
  return null;
}

function weightOf(v: string | null): number | null {
  const n = Number(str(v).replace(",", "."));
  return Number.isFinite(n) && n >= 5 && n <= 200 ? Math.round(n * 10) / 10 : null;
}

async function main() {
  await ensureCamperIndexes();

  const categories = await listCategories();
  const cat = (key: string) => categories.find((c) => c.key === key)!;
  const optByLabel = (key: string, label: string) => cat(key).options.find((o) => norm(o.label) === norm(label))?.id ?? null;
  const teams = await listTeams();
  const teamId = (raw: string | undefined) => {
    if (!raw) return null;
    const want = norm(raw).replace(/^time /, "").replace("galeleia", "galileia");
    return teams.find((t) => norm(t.name).replace(/^time /, "") === want)?._id ?? null;
  };
  const bedrooms = await listBedrooms();
  const bedroomId = (raw: string | undefined) => {
    const m = raw?.match(/\d{3}/);
    return m ? (bedrooms.find((b) => b.name === m[0])?._id ?? null) : null;
  };
  const busId = (raw: string | undefined) => (raw ? optByLabel("transporte", raw) : null);
  const staff = await listStaff({ active: true });
  /** "RAFA MARANO" in room X → the staff of room X whose name words start with every token (alias first) */
  const caretakerOf = (raw: string, bedroom: string | null): string | null => {
    if (!raw || !bedroom) return null;
    const alias = ALIASES[norm(raw)];
    const inRoom = staff.filter((s) => s.bedroom === bedroom);
    const pool = alias ? inRoom.filter((s) => norm(s.name) === norm(alias)) : inRoom;
    const toks = words(alias ?? raw);
    const hit = pool.filter((s) => toks.every((t) => words(s.name).some((w) => w.startsWith(t))));
    return hit.length === 1 ? hit[0]._id : null;
  };
  const promote = new Set<string>();

  const remote: RemoteChild[] = JSON.parse(await Bun.file(JSON_PATH).text());
  const local = await listCampers();
  const byName = new Map(local.map((c) => [norm(c.name), c]));
  const matched = new Set<string>();

  async function locate(r: RemoteChild): Promise<Camper | null> {
    const byExt = await findCamperByExternalId(r.id);
    if (byExt) return byExt;
    const want = norm(r.nome);
    const exact = byName.get(want);
    if (exact) return exact;
    return local.find((c) => !matched.has(c._id) && norm(c.name).endsWith(want)) ?? null;
  }

  let inserted = 0;
  let updated = 0;
  const warn: string[] = [];
  const diff: string[] = [];

  for (const r of remote) {
    const name = titleCase(r.nome);
    const g = r.guardians;
    const links = { team: teamId(r.teams?.nome), bedroom: bedroomId(r.rooms?.nome), bed: r.posicao_cama ? optByLabel("cama", r.posicao_cama) : null, transportation: busId(r.buses?.nome) };
    if (r.teams?.nome && !links.team) warn.push(`team "${r.teams.nome}" (${name})`);
    if (r.rooms?.nome && !links.bedroom) warn.push(`room "${r.rooms.nome}" (${name})`);
    if (r.buses?.nome && !links.transportation) warn.push(`bus "${r.buses.nome}" (${name})`);
    if (str(r.tio_atribuido) && !caretakerOf(str(r.tio_atribuido), links.bedroom)) warn.push(`tio "${r.tio_atribuido}" in ${r.rooms?.nome ?? "no room"} (${name})`);

    const identity = {
      sex: sexOf(r.sexo),
      cpf: str(r.cpf),
      rg: str(r.rg),
      school: str(r.escola),
      schoolGrade: str(r.serie_escolar),
      church: str(r.frequenta_igreja),
      invitedBy: str(r.convidado_por),
      caretakerId: caretakerOf(str(r.tio_atribuido), links.bedroom),
      qrToken: str(r.qr_token),
      externalId: r.id,
      guardianCpf: str(g?.cpf),
      guardianEmail: str(g?.email).toLowerCase(),
    };
    const fillable = {
      birthDate: r.data_nascimento || null,
      weightKg: weightOf(r.peso),
      medicines: meaningful(r.medicacao_uso_diario),
      foodRestrictions: meaningful(r.alimentacao),
      generalNotes: str(r.observacoes_gerais),
      bedroomPreference: str(r.preferencia_quarto),
      insurance: meaningful(r.convenio_medico),
      insuranceCard: str(r.numero_carteirinha),
      emergencyContact: str(r.contato_emergencia),
      guardianName: titleCase(str(g?.nome)),
      guardianPhone: g?.telefone ? normalizeBrazilPhone(g.telefone) : null,
    };

    if (identity.caretakerId) promote.add(identity.caretakerId);
    const existing = await locate(r);
    if (existing) {
      matched.add(existing._id);
      const patch: Partial<CamperData> = { ...identity, ...fillable, ...links };
      if (norm(existing.name) !== norm(name)) patch.name = name;
      const remoteLabel = { team: r.teams?.nome, bedroom: r.rooms?.nome, bed: r.posicao_cama, transportation: r.buses?.nome };
      for (const [k, v] of Object.entries(links) as [keyof typeof links, string | null][]) {
        if (existing[k] !== v) diff.push(`${name}: ${k} → ${remoteLabel[k] ?? "—"}`);
      }
      if (!DRY) await updateCamper(existing._id, patch);
      updated++;
      continue;
    }

    const allergyText = meaningful(r.alergias);
    const chronicText = meaningful(r.condicao_cronica);
    const data: CamperData = {
      name,
      ...identity,
      ...links,
      ...fillable,
      allergies: [],
      drugAllergies: [],
      healthIssues: [],
      healthNotes: [allergyText && `Alergias: ${allergyText}`, chronicText && `Condição: ${chronicText}`, str(r.observacoes_medicas)].filter(Boolean).join(" | "),
    };
    console.log(`  ➕ ${name} (${r.rooms?.nome ?? "sem quarto"}, ${r.teams?.nome ?? "sem time"})`);
    if (!DRY) await insertCamper(data);
    inserted++;
  }

  let promoted = 0;
  for (const id of promote) {
    const s = staff.find((x) => x._id === id)!;
    if (s.roomRole === "caretaker") continue;
    if (!DRY) await updateStaff(id, { roomRole: "caretaker" });
    promoted++;
  }
  if (promoted) console.log(`  🧑 ${promoted} staff flagged as caretaker (responsável)`);

  const orphans = local.filter((c) => !matched.has(c._id));
  for (const o of orphans) {
    console.warn(`  🗑️  removing (not in the registration system): ${o.name}`);
    if (!DRY) await deleteCamper(o._id);
  }
  for (const w of warn) console.warn(`  ⚠️  not found: ${w}`);
  for (const d of diff) console.log(`  ↔️  ${d}`);
  console.log(`  🧒 ${inserted + updated} acampantes (${inserted} inseridos, ${updated} atualizados, ${orphans.length} removidos)${DRY ? " — DRY RUN, nothing written" : ""}`);
  await closeDb();
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
