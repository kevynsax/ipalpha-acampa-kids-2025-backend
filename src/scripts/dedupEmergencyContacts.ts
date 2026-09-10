/**
 * The registration form asked for "Contato de emergência" separately from the
 * guardian, and most parents typed themselves again ("Marcela/11999488182").
 * This script clears the emergency contact when it is just the guardian, or
 * removes the guardian's part when other people are also listed
 * ("Elaíde 11965636070 / Jailson 965214635" → "Jailson 965214635").
 *
 * Idempotent. Pass --dry to only print what would change.
 *
 *   bun run src/scripts/dedupEmergencyContacts.ts [--dry]
 */
import { closeDb, getDb } from "../db";

const DRY = process.argv.includes("--dry");

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
const norm = (s: string | null | undefined) =>
  (s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
/** last 8 digits — tolerant to missing DDD / 9th digit / a typo'd extra digit */
const tail = (d: string) => d.slice(-8);

const RELATION = new Set(["mae", "pai", "avo", "tia", "tio", "madrasta", "padrasto", "responsavel", "resp"]);

interface Person {
  raw: string;
  phone: string; // digits
  names: string[]; // lowercase words that are not relation labels
}

/**
 * Splits free text into people. A person = one phone number plus the words
 * around it. Text without any phone is one person. Separators that appear
 * BETWEEN two phones (/, ;, ",", "e", "ou", "-") mark boundaries.
 */
function people(text: string): Person[] {
  // tokens: phone-ish runs (≥8 digits, allowing spaces/dots/dashes/parens) or words
  const re = /\(?\+?\d[\d .\-()]{6,}\d|[^\s/;,|]+/g;
  const tokens = text.match(re) ?? [];
  // Layouts seen in the data: "Name Phone", "Phone Name", "Name (rel) Phone",
  // "Phone - rel Name". Rule: a phone closes the current person UNLESS the
  // person has no words yet ("Phone Name" layout, where the name follows);
  // in that layout a relation word or a name right after the phone still
  // belongs to it, until a separator or another phone.
  const groups: string[][] = [[]];
  let phonesInCurrent = 0;
  let wordsBeforePhone = 0;
  const start = () => {
    groups.push([]);
    phonesInCurrent = 0;
    wordsBeforePhone = 0;
  };
  for (const t of tokens) {
    const isPhone = digits(t).length >= 8;
    const isSep = /^(e|ou|-|–|:|\/)$/i.test(t);
    if (isSep) {
      if (phonesInCurrent > 0) start();
      continue;
    }
    if (isPhone) {
      if (phonesInCurrent > 0) start();
      groups[groups.length - 1].push(t);
      phonesInCurrent++;
      continue;
    }
    // a word
    if (phonesInCurrent > 0 && wordsBeforePhone > 0) start(); // "Name Phone | Name…" → new person
    groups[groups.length - 1].push(t);
    if (phonesInCurrent === 0) wordsBeforePhone++;
  }
  return groups
    .filter((g) => g.length)
    .map((g) => {
      const raw = g.join(" ").replace(/\s+/g, " ").trim();
      const phoneTok = g.find((t) => digits(t).length >= 8);
      const names = g
        .filter((t) => digits(t).length < 8)
        .map((t) => norm(t).replace(/[^a-z]/g, ""))
        .filter((w) => w && !RELATION.has(w));
      return { raw, phone: phoneTok ? digits(phoneTok) : "", names };
    });
}

function isGuardian(p: Person, guardianName: string, guardianPhone: string | null): boolean {
  const gd = digits(guardianPhone);
  const gFirst = norm(guardianName).split(/\s+/)[0]?.replace(/[^a-z]/g, "") ?? "";
  const samePhone = p.phone.length >= 8 && gd.length >= 8 && tail(p.phone) === tail(gd);
  const sameName = !!gFirst && p.names.includes(gFirst);
  if (samePhone) return true; // same number → same person, whatever the nickname
  if (!p.phone && sameName && p.names.length <= 3) return true; // "Rachel" / "Mauricio Cardoso" with no number
  return false;
}

async function main() {
  const db = await getDb();
  const kids = await db.collection("campers").find({ emergencyContact: { $nin: ["", null] } }).toArray();

  let cleared = 0;
  let trimmed = 0;
  for (const k of kids) {
    const original = String(k.emergencyContact).trim();
    const all = people(original);
    const kept = all.filter((p) => !isGuardian(p, k.guardianName, k.guardianPhone));
    if (kept.length === all.length) continue; // nothing to remove
    const next = kept.map((p) => p.raw).join(" / ");

    console.log(`  ${next ? "TRIM " : "CLEAR"} ${String(k.name).padEnd(34)} ${original}  →  ${next || "(vazio)"}`);
    if (next) trimmed++;
    else cleared++;
    if (!DRY) await db.collection("campers").updateOne({ _id: k._id }, { $set: { emergencyContact: next, updatedAt: new Date() } });
  }

  console.log(`\n${DRY ? "[dry] " : ""}${cleared} limpos, ${trimmed} reduzidos, ${kids.length - cleared - trimmed} mantidos.\n`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
