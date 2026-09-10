/**
 * Seeds the camp schedule (events + staff roles).
 *
 * Sources:
 *   - the official 2026 programme (11–13 Sep) — every event, most with no
 *     staff roles (arrival, louvor, meals, sleeping…)
 *   - the staff assignment sheet (AcampaKids.pdf): which roles are needed in
 *     the 9 events where the team is scaled (see seedStaff.ts for the people)
 *
 * Roles are normalised: team-specific cells ("Coringa Belém", "Base 3",
 * "Caminhar com Canaã", "Cor 4") collapse into ONE generic role, since the
 * team/number is decided at assignment time. Pool supervision shifts collapse
 * into a single "Supervisão da piscina" role.
 *
 * The PG (pequeno grupo) study material lives in assets/pg/: one HTML file
 * per day (same tags the WYSIWYG produces) + the illustration, which is
 * stored in the `files` collection like an editor upload. The Líder roles
 * get that HTML as instructions and are REFRESHED on every run (the assets
 * are the source of truth); the Auxiliar has no task in the PG.
 *
 * Re-runnable: roles are matched by name (instructions written by the admin
 * are never overwritten, except the PG ones above); events by (date,
 * startTime, title) — only the role list is refreshed on existing events. Legacy events from the old "day 1/2"
 * schema are removed (re-run seed:staff afterwards to restore assignments).
 *
 *   bun run seed:schedule
 */
import { closeDb, getDb } from "../db";
import { findFileIdByName, insertFile } from "../models/files";
import { cleanHtml } from "../services/html";
import {
  ensureScheduleIndexes,
  findRoleByName,
  insertEvent,
  insertRole,
  listEvents,
  updateEvent,
  updateRole,
} from "../models/schedule";

// ── roles ───────────────────────────────────────────────────────────────────

interface SeedRole {
  name: string;
  emoji: string;
  /** starter instructions — only used when the role is created */
  instructions?: string;
  /** applies to every active staff member of the event (no per-person assignment) */
  forEveryone?: boolean;
  /** the assignment carries a per-person detail; the string is its placeholder */
  detail?: string;
  /**
   * instructions imported from assets/pg/ (refreshed on every run): the HTML
   * file, with `{{IMG}}` replaced by the url of the uploaded illustration
   */
  instructionsFile?: { html: string; image: string };
}

const ASSETS = new URL("../../assets/pg/", import.meta.url);
/** same cap as PATCH /api/schedule/roles (routes/schedule.ts) */
const INSTRUCTIONS_MAX = 20_000;

const roles: SeedRole[] = [
  { name: "Ajudar as crianças a arrumar o quarto", emoji: "🧹", forEveryone: true },
  { name: "Inspeção", emoji: "🔍", instructions: "<p>Passar nos quartos e conferir a arrumação.</p>" },
  { name: "Rádio", emoji: "📻" },
  { name: "Cuidar das crianças", emoji: "🧒", forEveryone: true },
  { name: "Cuidar das crianças fora da piscina", emoji: "🏖️", forEveryone: true },
  { name: "Cuidar das crianças que não querem jogar", emoji: "🪑", forEveryone: true },
  {
    name: "Supervisão da piscina",
    emoji: "🏊",
    detail: "turno, ex.: 14h–14h45",
    instructions: "<p>Ficar <strong>dentro da área da piscina</strong> durante o turno combinado, sem se afastar.</p>",
  },
  { name: "Pontuação fantasia", emoji: "🏆" },
  { name: "Organização", emoji: "📋" },
  { name: "Canibal", emoji: "😈" },
  { name: "Cor", emoji: "🎨", detail: "ex.: Cor 4", instructions: "<p>Você fica responsável por uma <strong>cor</strong> (1 a 7).</p>" },
  { name: "Coringa do time", emoji: "🃏", detail: "ex.: Time Belém", instructions: "<p>Você acompanha o <strong>seu time</strong> como coringa.</p>" },
  { name: "Base", emoji: "🚩", detail: "ex.: Base 3", instructions: "<p>Você fica responsável por uma <strong>base</strong> (1 a 8).</p>" },
  { name: "Caminhar com o time", emoji: "🚶", detail: "ex.: Time Canaã", instructions: "<p>Você caminha junto com o <strong>seu time</strong> entre as bases.</p>" },
  // PG (pequeno grupo) — the líder gives the study; the auxiliar has no task
  { name: "Líder do PG — Dia 1", emoji: "📖", instructionsFile: { html: "dia1.html", image: "dia1-baloes.jpg" } },
  { name: "Líder do PG — Dia 2", emoji: "📖", instructionsFile: { html: "dia2.html", image: "dia2-desenho.jpg" } },
  {
    name: "Auxiliar do PG",
    emoji: "🤝",
    instructions: "<p>Fique com o seu PG e acompanhe o líder — <strong>não há tarefa específica</strong> para o auxiliar.</p>",
  },
];

/** Reads assets/pg/<html>, uploads the illustration (once) and returns sanitized editor HTML. */
async function loadPgInstructions(file: NonNullable<SeedRole["instructionsFile"]>): Promise<string> {
  const image = new URL(file.image, ASSETS);
  let fileId = await findFileIdByName(file.image);
  if (!fileId) {
    const data = new Uint8Array(await Bun.file(image).arrayBuffer());
    const type = file.image.endsWith(".png") ? "image/png" : "image/jpeg";
    fileId = (await insertFile({ name: file.image, type, data, byUserId: "seed" }))._id;
  }
  const raw = (await Bun.file(new URL(file.html, ASSETS)).text()).replaceAll("{{IMG}}", `/api/files/${fileId}`);
  const html = cleanHtml(raw, INSTRUCTIONS_MAX);
  if (!html) throw new Error(`invalid or too long PG material: ${file.html}`);
  return html;
}

// ── events ──────────────────────────────────────────────────────────────────

/** role names (see `roles` above) */
type RoleNames = string[];

interface SeedEvent {
  date: string;
  startTime: string;
  title: string;
  emoji?: string;
  endTime?: string;
  notes?: string;
  roles?: RoleNames;
}

const EVERYONE_CARES: RoleNames = ["Cuidar das crianças", "Pontuação fantasia"];
const POOL: RoleNames = ["Cuidar das crianças fora da piscina", "Supervisão da piscina"];

const events: SeedEvent[] = [
  // ── Sexta 11/09 — chegada ──
  { date: "2026-09-11", startTime: "09:00", title: "Chegada equipe SOM no acampamento", emoji: "🔊" },
  { date: "2026-09-11", startTime: "15:30", title: "Saída Grupo Louvor Campus Alpha", emoji: "🎸" },
  { date: "2026-09-11", startTime: "17:00", title: "Chegada Equipe Check-in Campus Tamboré", emoji: "📋" },
  { date: "2026-09-11", startTime: "18:00", title: "Chegada TODOS Equipe Campus Tamboré", emoji: "🎒" },
  { date: "2026-09-11", startTime: "18:30", title: "Check-in", emoji: "✅" },
  { date: "2026-09-11", startTime: "19:30", title: "Pais no Templo - Pr. Rafa e Pr. Léo", emoji: "⛪" },
  { date: "2026-09-11", startTime: "19:45", title: "Divisão para os ônibus", emoji: "🚌" },
  { date: "2026-09-11", startTime: "20:00", title: "Saída Ônibus", emoji: "🚌" },
  { date: "2026-09-11", startTime: "21:30", title: "Chegada e Lanche", emoji: "🥪" },
  { date: "2026-09-11", startTime: "22:30", title: "Louvor e Introdução ao tema", emoji: "🎶" },
  { date: "2026-09-11", startTime: "23:30", title: "Dormir (nos quartos)", emoji: "🛏️" },
  { date: "2026-09-11", startTime: "23:59", title: "Silêncio Total", emoji: "🤫" },

  // ── Sábado 12/09 ──
  {
    date: "2026-09-12", startTime: "08:00", endTime: "08:15", title: "Acordar", emoji: "🌅",
    roles: ["Ajudar as crianças a arrumar o quarto", "Rádio"],
  },
  { date: "2026-09-12", startTime: "08:15", endTime: "08:30", title: "Inspeção nos quartos", emoji: "🔍", roles: ["Inspeção"] },
  { date: "2026-09-12", startTime: "08:30", endTime: "09:30", title: "Café da manhã do Pijama", emoji: "🥐", roles: EVERYONE_CARES },
  { date: "2026-09-12", startTime: "09:30", title: "Louvor", emoji: "🎶" },
  { date: "2026-09-12", startTime: "10:00", title: "Pr. Vinicius", emoji: "🙏" },
  { date: "2026-09-12", startTime: "10:30", title: "Pr. Léo", emoji: "🙏" },
  { date: "2026-09-12", startTime: "10:45", title: "PG", emoji: "👥", roles: ["Líder do PG — Dia 1", "Auxiliar do PG"] },
  { date: "2026-09-12", startTime: "11:30", title: "LIVRE", emoji: "🆓" },
  { date: "2026-09-12", startTime: "12:30", endTime: "13:30", title: "Almoço no Circo", emoji: "🎪", roles: EVERYONE_CARES },
  {
    date: "2026-09-12", startTime: "14:00", endTime: "15:30", title: "LIVRE - Piscina liberada - checar escala", emoji: "🏊",
    roles: POOL, notes: "Turnos de supervisão: 14h–14h45 e 14h45–15h30",
  },
  {
    date: "2026-09-12", startTime: "15:30", endTime: "16:30", title: "Canibal", emoji: "😈",
    roles: ["Canibal", "Cor", "Coringa do time", "Organização", "Cuidar das crianças que não querem jogar"],
  },
  { date: "2026-09-12", startTime: "16:30", title: "Lanche", emoji: "🍎" },
  { date: "2026-09-12", startTime: "17:30", title: "Banho", emoji: "🚿" },
  { date: "2026-09-12", startTime: "19:00", endTime: "20:00", title: "Jantar da Torre de Babel - Países", emoji: "🌍", roles: EVERYONE_CARES },
  { date: "2026-09-12", startTime: "20:00", title: "Louvor no Salão", emoji: "🎶" },
  { date: "2026-09-12", startTime: "20:30", title: "Ir ao espaço da Fogueira", emoji: "🚶" },
  { date: "2026-09-12", startTime: "20:40", title: "Palavra + Fogueira", emoji: "🔥" },
  { date: "2026-09-12", startTime: "21:30", title: "Preparação para Brincadeira Noturna", emoji: "🔦" },
  {
    date: "2026-09-12", startTime: "21:45", endTime: "22:30", title: "Brincadeira Noturna", emoji: "🌙",
    roles: ["Base", "Caminhar com o time", "Coringa do time", "Organização", "Cuidar das crianças que não querem jogar"],
  },
  { date: "2026-09-12", startTime: "22:30", title: "Chá da noite", emoji: "🍵" },
  { date: "2026-09-12", startTime: "23:30", title: "Dormir (nos quartos)", emoji: "🛏️" },
  { date: "2026-09-12", startTime: "23:59", title: "Silêncio Total", emoji: "🤫" },

  // ── Domingo 13/09 ──
  {
    date: "2026-09-13", startTime: "08:00", endTime: "08:15", title: "Acordar", emoji: "🌅",
    roles: ["Ajudar as crianças a arrumar o quarto", "Rádio"],
  },
  { date: "2026-09-13", startTime: "08:15", endTime: "08:30", title: "Inspeção nos quartos", emoji: "🔍", roles: ["Inspeção"] },
  { date: "2026-09-13", startTime: "08:30", endTime: "09:30", title: "Café da manhã do chapéu das Pragas do Egito", emoji: "🎩", roles: EVERYONE_CARES },
  { date: "2026-09-13", startTime: "09:30", title: "Louvor", emoji: "🎶" },
  { date: "2026-09-13", startTime: "10:00", title: "Girafael & Chulingo - Giralingo", emoji: "🦒" },
  { date: "2026-09-13", startTime: "10:45", title: "PG", emoji: "👥", roles: ["Líder do PG — Dia 2", "Auxiliar do PG"] },
  {
    date: "2026-09-13", startTime: "11:30", endTime: "12:20", title: "LIVRE - Piscina liberada - checar escala", emoji: "🏊",
    roles: POOL, notes: "Turnos de supervisão: 11h30–11h50 e 11h50–12h20",
  },
  { date: "2026-09-13", startTime: "12:30", endTime: "13:30", title: "Almoço do Avesso", emoji: "🙃", roles: EVERYONE_CARES },
  { date: "2026-09-13", startTime: "13:30", title: "Saída da Equipe que Recepcionará os pais", emoji: "🚗" },
  { date: "2026-09-13", startTime: "13:30", title: "Premiações", emoji: "🏆" },
  { date: "2026-09-13", startTime: "14:00", title: "Arrumar malas", emoji: "🧳" },
  { date: "2026-09-13", startTime: "14:30", title: "Picolé", emoji: "🍦" },
  { date: "2026-09-13", startTime: "14:45", title: "Arrastão organização e malas nos ônibus", emoji: "🧹" },
  { date: "2026-09-13", startTime: "15:00", title: "Saída ônibus", emoji: "🚌" },
  { date: "2026-09-13", startTime: "15:30", title: "Chegada pais na igreja", emoji: "⛪" },
  { date: "2026-09-13", startTime: "16:30", title: "Previsão de chegada das crianças na igreja", emoji: "🎉" },
];

async function main() {
  await ensureScheduleIndexes();

  // legacy schema (day: 1|2) → drop; seed:staff rebuilds the assignments
  const db = await getDb();
  const legacy = await db.collection("schedule_events").deleteMany({ date: { $exists: false } });
  if (legacy.deletedCount) console.log(`  🗑️  removed ${legacy.deletedCount} legacy day-based events (run seed:staff again)`);

  const idByName = new Map<string, string>();
  let newRoles = 0;
  for (const r of roles) {
    const existing = await findRoleByName(r.name);
    const imported = r.instructionsFile ? await loadPgInstructions(r.instructionsFile) : null;
    if (existing) {
      idByName.set(r.name, existing._id);
      const patch: Record<string, unknown> = {};
      if (imported !== null && imported !== existing.instructions) patch.instructions = imported;
      if ((r.forEveryone ?? false) !== existing.forEveryone) patch.forEveryone = r.forEveryone ?? false;
      if (!!r.detail !== existing.hasDetail) patch.hasDetail = !!r.detail;
      if ((r.detail ?? "") !== existing.detailPlaceholder && !existing.detailPlaceholder) patch.detailPlaceholder = r.detail ?? "";
      if (Object.keys(patch).length) await updateRole(existing._id, patch);
    } else {
      const created = await insertRole({
        name: r.name,
        emoji: r.emoji,
        instructions: imported ?? r.instructions ?? "",
        preparation: "",
        forEveryone: r.forEveryone ?? false,
        hasDetail: !!r.detail,
        detailPlaceholder: r.detail ?? "",
      });
      idByName.set(r.name, created._id);
      newRoles++;
    }
  }
  console.log(`  🎯 ${roles.length} funções (${newRoles} novas)`);

  const existingEvents = await listEvents();
  let newEvents = 0;
  let updatedEvents = 0;
  for (const e of events) {
    const roleIds = (e.roles ?? []).map((name) => {
      const roleId = idByName.get(name);
      if (!roleId) throw new Error(`role not seeded: ${name}`);
      return roleId;
    });
    const match = existingEvents.find((x) => x.date === e.date && x.startTime === e.startTime && x.title === e.title);
    if (match) {
      await updateEvent(match._id, { roles: roleIds }); // times/notes/emoji belong to the admin after first seed
      updatedEvents++;
    } else {
      await insertEvent({
        date: e.date,
        title: e.title,
        emoji: e.emoji ?? "📅",
        startTime: e.startTime,
        endTime: e.endTime ?? null,
        notes: e.notes ?? "",
        roles: roleIds,
        assignments: [],
      });
      newEvents++;
    }
  }
  const dates = [...new Set(events.map((e) => e.date))];
  console.log(`  📅 ${events.length} eventos em ${dates.length} dias (${newEvents} novos, ${updatedEvents} atualizados)`);
  console.log("\n🌱 Schedule ready.\n");
  await closeDb();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
