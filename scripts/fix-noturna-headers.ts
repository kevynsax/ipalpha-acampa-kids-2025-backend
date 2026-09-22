/**
 * One-off content fix: the "Brincadeira Noturna" role documents opened by
 * restating what the app's own header already shows.
 *
 * The instructions dialog is opened FROM an event and already shows the função
 * name, the event name and the time. These five documents then repeated:
 *
 *     <h2>🌙 Brincadeira Noturna</h2>
 *     <p><strong>🌙 Brincadeira Noturna — Cartório do Renascimento</strong> (sábado, 21h45–22h30). O acampamento…
 *
 * so the reader saw the same thing four times before the first instruction.
 * This drops the echo and keeps only what the header does NOT say: the name of
 * the story ("Cartório do Renascimento") and the premise.
 *
 * Idempotent: it matches the old text exactly, so a second run changes nothing.
 *
 *   bun run backend/scripts/fix-noturna-headers.ts          # show what would change
 *   bun run backend/scripts/fix-noturna-headers.ts --apply  # write it
 */
import { getDb, closeDb } from "../src/db";
import { migrateToCamps } from "../src/services/campMigration";

/** the repeated preamble: title + date/time, both already in the dialog header */
const ECHO_PARAGRAPH =
  "<p><strong>🌙 Brincadeira Noturna — Cartório do Renascimento</strong> (sábado, 21h45–22h30). O acampamento virou o Cartório Central do Reino: os arquivos se perderam e as equipes de crianças, como tabeliães, passam pelos 8 guichês (bases) pra registrar as mudanças de nome. A história completa está em <strong>📖 Instruções</strong>.</p>";

/** same premise, without repeating the função, the event or the time */
const KEPT_PARAGRAPH =
  "<p><strong>Cartório do Renascimento:</strong> o acampamento virou o Cartório Central do Reino — os arquivos se perderam e as equipes de crianças, como tabeliães, passam pelos 8 guichês (bases) pra registrar as mudanças de nome. A história completa está em <strong>📖 Instruções</strong>.</p>";

/** headings that only restate the event (optionally + the função, which the header also shows) */
const ECHO_HEADINGS = [
  "<h2>🌙 Brincadeira Noturna</h2>",
  "<h2>🌙 Brincadeira Noturna — organização</h2>",
  "<h2>🌙 Brincadeira Noturna — coringa do time</h2>",
  "<h2>🌙 Brincadeira Noturna — sua base</h2>",
  "<h2>🌙 Brincadeira Noturna — caminhando com o time</h2>",
];

function fix(html: string): string {
  let out = html;
  for (const h of ECHO_HEADINGS) out = out.split(h).join("");
  out = out.split(ECHO_PARAGRAPH).join(KEPT_PARAGRAPH);
  // the <hr /> stays (it still separates "your role in one line" from the brief),
  // but the blank line the dropped heading left behind goes
  return out.replace(/^\s*<hr\s*\/?>\s*/i, "").replace(/\n\s*\n/g, "\n").trim();
}

async function main() {
  const apply = process.argv.includes("--apply");
  const db = await getDb();
  await migrateToCamps(); // one-off scripts run outside the server boot: load the active camp so SCOPED collections resolve
  // matches both the untouched documents and the already-fixed ones (so a re-run
  // can still tidy them), hence the story name rather than the dropped title
  const roles = await db
    .collection("schedule_roles")
    .find({ instructions: /Renascimento|Brincadeira Noturna/ })
    .toArray();

  let changed = 0;
  for (const r of roles) {
    const before = (r.instructions as string) ?? "";
    const after = fix(before);
    if (after === before) {
      console.log(`· ${r.emoji} ${r.name} — already clean`);
      continue;
    }
    changed++;
    console.log(`\n✎ ${r.emoji} ${r.name}  (${before.length} → ${after.length} chars)`);
    console.log("  first line now:", after.split("\n")[0].slice(0, 120));
    if (apply) {
      await db.collection("schedule_roles").updateOne(
        { _id: r._id },
        { $set: { instructions: after, updatedAt: new Date().toISOString() } },
      );
    }
  }

  console.log(`\n${apply ? "Updated" : "Would update"} ${changed} of ${roles.length} documents.`);
  if (!changed) console.log("Nothing to do.");
  else if (!apply) console.log("Re-run with --apply to write.");
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
