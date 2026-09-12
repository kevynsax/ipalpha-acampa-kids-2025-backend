/**
 * Creates (or updates) a login for every kid's guardian: one `users` doc per
 * distinct `guardianPhone`, holding the `parent` role. People who already
 * have an account (e.g. staff who are also parents) simply GAIN the role.
 * Idempotent — run it again after every `seed:campers` / `import:supabase`.
 *
 *   bun run seed:parents [--dry]
 */
import { closeDb, getDb } from "../db";
import { listCampers } from "../models/campers";
import { formatBrazilPhone } from "../utils";

const dry = process.argv.includes("--dry");

async function main() {
  const db = await getDb();
  const users = db.collection("users");
  const kids = await listCampers();
  const byPhone = new Map<string, { name: string; kids: string[] }>();
  for (const k of kids) {
    if (!k.guardianPhone) continue;
    const cur = byPhone.get(k.guardianPhone) ?? { name: k.guardianName || `Responsável de ${k.name.split(" ")[0]}`, kids: [] };
    cur.kids.push(k.name.split(" ")[0]);
    byPhone.set(k.guardianPhone, cur);
  }

  let created = 0;
  let gained = 0;
  for (const [phone, g] of byPhone) {
    const existing = await users.findOne({ phone });
    if (existing) {
      const roles: string[] = existing.roles ?? [];
      if (!roles.includes("parent")) {
        gained++;
        console.log(`➕ ${existing.name} (${formatBrazilPhone(phone)}) ganha o perfil parent — ${g.kids.join(", ")}`);
        if (!dry) await users.updateOne({ _id: existing._id }, { $addToSet: { roles: "parent" }, $set: { updatedAt: new Date() } });
      }
      continue;
    }
    created++;
    console.log(`🆕 ${g.name} (${formatBrazilPhone(phone)}) — ${g.kids.join(", ")}`);
    if (!dry) {
      const now = new Date();
      await users.insertOne({ name: g.name, phone, roles: ["parent"], otp: null, frozenUntil: null, welcomeSentAt: null, createdAt: now, updatedAt: now });
    }
  }
  const skipped = kids.filter((k) => !k.guardianPhone).length;
  console.log(`\n👨‍👩‍👧 ${byPhone.size} responsáveis: ${created} contas novas, ${gained} contas existentes ganharam o perfil${skipped ? `, ${skipped} crianças sem telefone do responsável` : ""}${dry ? " (dry run — nada gravado)" : ""}`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
