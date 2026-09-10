/**
 * Seeds the bedrooms (quartos) from the 2025 spreadsheets.
 *
 * Bedrooms are their own collection (not a category) because each has a bed
 * layout: N bunk beds (beliches, 2 people each) + N single beds (camas de
 * solteiro, 1 each), which defines its capacity.
 *
 * Re-runnable: rooms are matched by name. NEW rooms are inserted; EXISTING
 * rooms only get their group refreshed — bunk/single counts and notes edited
 * by the admin in the UI are never overwritten.
 *
 *   bun run seed:bedrooms
 */
import { closeDb } from "../db";
import { ensureBedroomIndexes, findBedroomByName, insertBedroom, updateBedroom } from "../models/bedrooms";
import type { BedroomGroup } from "../types";

/**
 * Bed layouts are inferred from the 2025 allocation (kids + staff per room):
 * girls/boys 1xx–4xx hold up to 7 (3 bunk beds + 1 single), the big 6xx
 * dorms hold 14 (7 bunk beds), staff rooms hold 2 (1 bunk bed). Adjust in
 * the UI — the seed never overwrites a layout that differs from these.
 */
const SMALL = { bunkBeds: 3, singleBeds: 1 }; // 7
const BIG = { bunkBeds: 7, singleBeds: 0 }; // 14
const STAFF_ROOM = { bunkBeds: 1, singleBeds: 0 }; // 2

const GIRLS = [103, 104, 106, 107, 108, 110, 111, 112, 113, 114, 115, 116, 201, 202, 203, 204, 205, 206, 209, 210, 211, 212, 213];
const BOYS_SMALL = [402, 403, 404, 405];
const BOYS_BIG = [601, 602, 603, 604, 605, 606];
const STAFF = [501, 502, 503, 504, 505, 506];

type Layout = { bunkBeds: number; singleBeds: number };
const rooms: { name: string; group: BedroomGroup; layout: Layout }[] = [
  ...GIRLS.map((n) => ({ name: String(n), group: "girls" as const, layout: SMALL })),
  ...BOYS_SMALL.map((n) => ({ name: String(n), group: "boys" as const, layout: SMALL })),
  ...BOYS_BIG.map((n) => ({ name: String(n), group: "boys" as const, layout: BIG })),
  ...STAFF.map((n) => ({ name: String(n), group: "staff" as const, layout: STAFF_ROOM })),
];

/** the layout every room got from the FIRST version of this seed */
const LEGACY_DEFAULT: Layout = { bunkBeds: 2, singleBeds: 0 };

const GROUP_LABEL: Record<BedroomGroup, string> = { girls: "Meninas", boys: "Meninos", staff: "Equipe" };

async function main() {
  await ensureBedroomIndexes();

  let inserted = 0;
  let kept = 0;
  for (const r of rooms) {
    const existing = await findBedroomByName(r.name);
    if (existing) {
      const patch: Partial<Layout & { group: BedroomGroup }> = {};
      if (existing.group !== r.group) patch.group = r.group;
      // upgrade rooms still on the old placeholder layout; keep anything the admin changed
      if (existing.bunkBeds === LEGACY_DEFAULT.bunkBeds && existing.singleBeds === LEGACY_DEFAULT.singleBeds) {
        Object.assign(patch, r.layout);
      }
      if (Object.keys(patch).length) await updateBedroom(existing._id, patch);
      kept++;
    } else {
      await insertBedroom({ name: r.name, group: r.group, ...r.layout, notes: "" });
      inserted++;
    }
  }

  for (const g of ["girls", "boys", "staff"] as const) {
    console.log(`  🛏️  ${GROUP_LABEL[g].padEnd(8)} ${rooms.filter((r) => r.group === g).length} quartos`);
  }
  console.log(`\n🌱 Bedrooms ready — ${inserted} inseridos, ${kept} já existiam.`);

  await closeDb();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
