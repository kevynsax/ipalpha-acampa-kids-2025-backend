/**
 * Seeds the admin-managed categories (closed enumerations) used by the
 * camper and staff forms.
 *
 * Values come from the real 2025 spreadsheets:
 *   - acampakids_lista_geral_alfabetica.xlsx  (campers: Time, Cama, Transporte, Alergias, Condição crônica)
 *   - voluntarios-acampa-kids.xlsx            (staff:   Time, Transporte)
 *
 * Bedrooms are NOT categories (they have bed layouts) — see seedBedrooms.ts.
 *
 * Re-runnable: default categories are UPSERTED (metadata + options refreshed,
 * existing option ids preserved when the label matches) and categories from
 * older seeds that no longer exist are removed. Categories created by the
 * admin in the UI (other keys) are never touched.
 *
 *   bun run seed:categories
 */
import { closeDb } from "../db";
import {
  deleteCategory,
  ensureCategoryIndexes,
  findCategoryByKey,
  insertCategory,
  newOptionId,
  updateCategory,
} from "../models/categories";
import type { CategoryAudience, CategoryOption, CategorySelection } from "../types";

interface SeedCategory {
  key: string;
  name: string;
  emoji: string;
  description?: string;
  appliesTo: CategoryAudience[];
  selection: CategorySelection;
  options: string[];
}

const defaults: SeedCategory[] = [
  {
    key: "equipe",
    name: "Time",
    emoji: "🚩",
    description: "Time do acampamento",
    appliesTo: ["camper", "staff"],
    selection: "single",
    options: [
      "Time Belém",
      "Time Calvário",
      "Time Canaã",
      "Time Éden",
      "Time Galileia",
      "Time Jericó",
      "Time Jerusalém",
      "Time Sinai",
    ],
  },
  {
    key: "cama",
    name: "Cama",
    emoji: "🛏️",
    description: "Posição na beliche",
    appliesTo: ["camper"],
    selection: "single",
    options: ["Cima", "Baixo"],
  },
  {
    key: "transporte",
    name: "Transporte",
    emoji: "🚌",
    description: "Como a pessoa vai para o acampamento",
    appliesTo: ["camper", "staff"],
    selection: "single",
    options: [
      "Ônibus 1 - Vermelho",
      "Ônibus 2 - Laranja",
      "Ônibus 3 - Verde",
      "Ônibus 4 - Azul",
      "Carro",
      "Louvor",
      "Sem ônibus",
    ],
  },
  {
    key: "alergias",
    name: "Alergias",
    emoji: "🤮",
    description: "Alergias e intolerâncias (pode marcar várias)",
    appliesTo: ["camper", "staff"],
    selection: "multiple",
    options: [
      "Nenhuma",
      "Rinite alérgica",
      "Poeira / mofo",
      "Pelos de animais",
      "Picada de inseto",
      "Lactose / leite",
      "Glúten",
      "Amendoim",
      "Peixe / frutos do mar",
      "Corante",
      "Pimenta",
    ],
  },
  {
    key: "alergia-medicamentos",
    name: "Alergia a medicamentos",
    emoji: "🚫",
    description: "Remédios que a pessoa NÃO pode tomar",
    appliesTo: ["camper", "staff"],
    selection: "multiple",
    options: ["Nenhuma", "Dipirona", "Paracetamol", "Ibuprofeno", "Nimesulida", "Amoxicilina", "Penicilina / Benzetacil", "Plasil", "Outro medicamento"],
  },
  {
    key: "condicao-cronica",
    name: "Condição crônica",
    emoji: "🩺",
    description: "Condições de saúde que a equipe precisa conhecer",
    appliesTo: ["camper", "staff"],
    selection: "multiple",
    options: [
      "Nenhuma",
      "Asma",
      "Bronquite",
      "Diabetes",
      "Pré-diabetes",
      "Pressão alta",
      "Cardiopatia",
      "Artrite reumatoide juvenil",
      "TDAH",
      "Autismo (TEA)",
      "Labirintite",
    ],
  },
];

/**
 * keys that were renamed: old → new. The document is updated in place so
 * option ids (referenced by staff/camper records) are preserved.
 */
const RENAMED_KEYS: Record<string, string> = { onibus: "transporte" };

/** keys from earlier seeds that are no longer categories ("quarto" moved to its own collection) */
const OBSOLETE_KEYS = ["quarto", "beliche", "medicacoes", "restricao-alimentar", "tamanho-camiseta", "funcao"];

/**
 * Options dropped from the defaults are kept (hidden) so ids still referenced
 * by people keep resolving; `migrateHealthOptions` moves those references.
 */
function mergeOptions(existing: CategoryOption[], labels: string[]): CategoryOption[] {
  const want = new Set(labels.map((l) => l.toLocaleLowerCase("pt-BR")));
  const byLabel = new Map(existing.map((o) => [o.label.toLocaleLowerCase("pt-BR"), o]));
  const merged = labels.map((label, order) => {
    const prev = byLabel.get(label.toLocaleLowerCase("pt-BR"));
    return { id: prev?.id ?? newOptionId(), label, order, active: prev?.active ?? true };
  });
  const leftovers = existing.filter((o) => !want.has(o.label.toLocaleLowerCase("pt-BR"))).map((o, i) => ({ ...o, order: merged.length + i, active: false }));
  return [...merged, ...leftovers];
}

async function main() {
  await ensureCategoryIndexes();

  for (const [oldKey, newKey] of Object.entries(RENAMED_KEYS)) {
    const old = await findCategoryByKey(oldKey);
    if (!old) continue;
    if (await findCategoryByKey(newKey)) {
      // both exist (shouldn't happen) — keep the new one, drop the stale one
      await deleteCategory(old._id);
      console.log(`  🗑️  removed stale "${oldKey}" ("${newKey}" already exists)`);
    } else {
      await updateCategory(old._id, { key: newKey });
      console.log(`  ✏️  renamed "${oldKey}" → "${newKey}" (option ids preserved)`);
    }
  }

  for (const key of OBSOLETE_KEYS) {
    const old = await findCategoryByKey(key);
    if (old) {
      await deleteCategory(old._id);
      console.log(`  🗑️  removed obsolete "${key}"`);
    }
  }

  for (const [order, def] of defaults.entries()) {
    const existing = await findCategoryByKey(def.key);
    if (existing) {
      await updateCategory(existing._id, {
        name: def.name,
        emoji: def.emoji,
        description: def.description,
        appliesTo: def.appliesTo,
        selection: def.selection,
        order,
        options: mergeOptions(existing.options, def.options),
      });
      console.log(`  🔄 ${def.emoji} ${def.name} — ${def.options.length} opções (atualizada)`);
    } else {
      await insertCategory({
        key: def.key,
        name: def.name,
        emoji: def.emoji,
        description: def.description,
        appliesTo: def.appliesTo,
        selection: def.selection,
        order,
        options: def.options.map((label, i) => ({ id: newOptionId(), label, order: i, active: true })),
      });
      console.log(`  ✅ ${def.emoji} ${def.name} — ${def.options.length} opções (${def.appliesTo.join(" + ")})`);
    }
  }

  console.log("\n🌱 Categories ready.\n");
  await closeDb();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
