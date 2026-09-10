/**
 * Seeds 4 test users — covering every role, including multi-role people —
 * so the login flow can be tested.
 *
 *   bun run seed
 */
import { ensureIndexes } from "../models/users";
import { closeDb, getDb } from "../db";
import { formatBrazilPhone } from "../utils";
import type { Role } from "../types";

const testUsers: { name: string; phone: string; roles: Role[] }[] = [
  { name: "Maria Silva", phone: "+5511981234567", roles: ["parent"] },
  { name: "João Pereira", phone: "+5511982345678", roles: ["staff"] },
  { name: "Paula Costa", phone: "+5511983456789", roles: ["health_staff", "staff"] },
  { name: "André Almeida", phone: "+5511992617404", roles: ["admin", "parent"] },
];

const roleLabels: Record<Role, string> = {
  parent: "Pais & Responsáveis",
  staff: "Equipe",
  health_staff: "Equipe de Saúde",
  admin: "Administração",
};

async function main() {
  const db = await getDb();
  const collection = db.collection("users");

  // ── migrate legacy single-role docs (role: string) → multi-role (roles: []) ──
  const migrated = await collection.updateMany(
    { roles: { $exists: false }, role: { $exists: true } },
    [
      {
        $set: {
          roles: ["$role"],
          otp: null,
          frozenUntil: null,
          updatedAt: new Date(),
        },
      },
      { $unset: "role" },
    ],
  );
  if (migrated.modifiedCount > 0) {
    console.log(`🔄 Migrated ${migrated.modifiedCount} user(s) to the multi-role schema.`);
  }

  // unique by phone (one person = one account with N roles)
  await ensureIndexes();

  for (const user of testUsers) {
    await collection.updateOne(
      { phone: user.phone },
      {
        $set: {
          name: user.name,
          roles: user.roles,
          otp: null,
          frozenUntil: null,
          updatedAt: new Date(),
        },
        $setOnInsert: { phone: user.phone, createdAt: new Date() },
      },
      { upsert: true },
    );
  }

  console.log("\n🌱 Test users ready — one person can have several roles:\n");
  for (const user of testUsers) {
    const roles = user.roles.map((r) => roleLabels[r]).join(" + ");
    console.log(
      `  ${user.name.padEnd(16)} 📱 ${formatBrazilPhone(user.phone).padEnd(16)} ${roles}`,
    );
  }
  console.log(
    "\n(OTP codes appear in the backend console while COMTELE_API_KEY is empty)\n",
  );

  await closeDb();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
