/**
 * Seeds the camp TEAMS (times) — the ones from the 2025 spreadsheets.
 *
 * Re-runnable: teams are matched by name (accent / case insensitive) and
 * only created when missing, so ids referenced by campers / staff never
 * change. Names, colours and jokers set by the admin are never touched.
 *
 *   bun run seed:teams
 */
import { closeDb } from "../db";
import { ensureTeamIndexes, insertTeam, listTeams, TEAM_PALETTE } from "../models/teams";

const DEFAULT_TEAMS = ["Time Belém", "Time Calvário", "Time Canaã", "Time Éden", "Time Galileia", "Time Jericó", "Time Jerusalém", "Time Sinai"];

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

async function main() {
  await ensureTeamIndexes(); // migrates the legacy "equipe" category first, if it is still there
  const existing = await listTeams();
  const byName = new Set(existing.map((t) => norm(t.name)));
  let order = existing.length ? Math.max(...existing.map((t) => t.order)) + 1 : 0;
  let created = 0;
  for (const [i, name] of DEFAULT_TEAMS.entries()) {
    if (byName.has(norm(name))) continue;
    await insertTeam({ name, color: TEAM_PALETTE[i % TEAM_PALETTE.length], jokerStaffId: null, order: order++ });
    created++;
  }
  console.log(`🚩 teams: ${created} created, ${existing.length} already there`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
