import { Hono, type Context } from "hono";
import { isEmojiLike } from "../utils";
import { publish } from "../services/realtime";
import { requireAuth } from "../middleware/auth";
import { requireAdmin } from "../middleware/roles";
import {
  deleteCategory,
  findCategoryById,
  findCategoryByKey,
  insertCategory,
  listCategories,
  newOptionId,
  nextCategoryOrder,
  slugify,
  updateCategory,
} from "../models/categories";
import {
  CATEGORY_AUDIENCES,
  CATEGORY_SELECTIONS,
  type Category,
  type CategoryAudience,
  type CategoryOption,
  type CategorySelection,
  type Role,
  type SessionUser,
} from "../types";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

const categories = new Hono<Env>();

// ── helpers ─────────────────────────────────────────────────────────────────

const NAME_MAX = 60;
const OPTION_MAX = 80;

function fail(c: Context, code: string, message: string, status: 400 | 404 | 409 = 400) {
  return c.json({ error: { code, message } }, status);
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().replace(/\s+/g, " ");
  if (!v || v.length > max) return null;
  return v;
}

function cleanEmoji(value: unknown): string {
  if (typeof value !== "string") return "🏷️";
  const v = value.trim();
  // keep it short: an emoji (possibly with ZWJ/variation selectors), not a sentence
  return isEmojiLike(v) ? v : "🏷️";
}

function parseAudience(value: unknown): CategoryAudience[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const set = new Set<CategoryAudience>();
  for (const item of value) {
    if (!CATEGORY_AUDIENCES.includes(item)) return null;
    set.add(item);
  }
  return [...set];
}

function parseSelection(value: unknown): CategorySelection | null {
  return CATEGORY_SELECTIONS.includes(value as CategorySelection) ? (value as CategorySelection) : null;
}

/** Only exposes what clients need (no Mongo internals). */
export function serializeCategory(cat: Category) {
  return {
    id: cat._id,
    key: cat.key,
    name: cat.name,
    emoji: cat.emoji,
    description: cat.description ?? "",
    appliesTo: cat.appliesTo,
    selection: cat.selection,
    order: cat.order,
    options: cat.options.map((o) => ({ id: o.id, label: o.label, order: o.order, active: o.active, draft: o.draft === true })),
    createdAt: cat.createdAt,
    updatedAt: cat.updatedAt,
  };
}

async function uniqueKey(base: string): Promise<string> {
  const root = slugify(base) || "categoria";
  let key = root;
  let n = 2;
  while (await findCategoryByKey(key)) key = `${root}-${n++}`;
  return key;
}

// every route needs a session
categories.use("*", requireAuth);

// ── read (any logged-in role — camper/staff forms consume these) ───────────

/**
 * GET /api/categories?audience=camper|staff
 * Lists categories (optionally only those that apply to one audience).
 * Non-admins only receive ACTIVE options.
 */
categories.get("/", async (c) => {
  const audience = c.req.query("audience");
  if (audience && !CATEGORY_AUDIENCES.includes(audience as CategoryAudience)) {
    return fail(c, "AUDIENCE_INVALID", "Público inválido. Use camper ou staff.");
  }

  const list = await listCategories({ audience: audience as CategoryAudience | undefined });
  const isAdmin = c.get("activeRole") === "admin";

  return c.json({
    categories: list.map((cat) => {
      const s = serializeCategory(cat);
      return isAdmin ? { ...s, options: s.options.filter((o) => !o.draft) } : { ...s, options: s.options.filter((o) => o.active && !o.draft) };
    }),
  });
});

categories.get("/:id", async (c) => {
  const cat = await findCategoryById(c.req.param("id"));
  if (!cat) return fail(c, "CATEGORY_NOT_FOUND", "Categoria não encontrada.", 404);
  const serialized = serializeCategory(cat);
  return c.json({ category: { ...serialized, options: serialized.options.filter((o) => !o.draft) } });
});

// ── write (admin only) ──────────────────────────────────────────────────────

categories.use("/*", requireAdmin);

/**
 * POST /api/categories
 * { name, emoji?, description?, appliesTo: ["camper"|"staff"], selection: "single"|"multiple", options?: string[] }
 */
categories.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const name = cleanText(body.name, NAME_MAX);
  if (!name) return fail(c, "NAME_INVALID", `Informe um nome com até ${NAME_MAX} caracteres.`);

  const appliesTo = parseAudience(body.appliesTo);
  if (!appliesTo) {
    return fail(c, "AUDIENCE_INVALID", "Escolha ao menos um público: acampante e/ou equipe.");
  }

  const selection = parseSelection(body.selection ?? "single");
  if (!selection) return fail(c, "SELECTION_INVALID", "Tipo de seleção inválido.");

  const description = typeof body.description === "string" ? body.description.trim().slice(0, 200) : undefined;

  // optional initial options (labels)
  const options: CategoryOption[] = [];
  if (Array.isArray(body.options)) {
    const seen = new Set<string>();
    for (const raw of body.options) {
      const label = cleanText(raw, OPTION_MAX);
      if (!label) return fail(c, "OPTION_INVALID", `Opções devem ter até ${OPTION_MAX} caracteres.`);
      const norm = label.toLocaleLowerCase("pt-BR");
      if (seen.has(norm)) return fail(c, "OPTION_DUPLICATE", `Opção repetida: "${label}".`, 409);
      seen.add(norm);
      options.push({ id: newOptionId(), label, order: options.length, active: true });
    }
  }

  const cat = await insertCategory({
    key: await uniqueKey(name),
    name,
    emoji: cleanEmoji(body.emoji),
    description: description || undefined,
    appliesTo,
    selection,
    options,
    order: await nextCategoryOrder(),
  });

  publish("categories");
  return c.json({ category: serializeCategory(cat) }, 201);
});

/** PUT /api/categories/reorder  { ids: string[] } — must be declared before /:id */
categories.put("/reorder", async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.ids) || !body.ids.every((i) => typeof i === "string")) {
    return fail(c, "BODY_INVALID", "Envie a lista de ids na nova ordem.");
  }
  const ids = body.ids as string[];
  await Promise.all(ids.map((id, order) => updateCategory(id, { order })));
  const list = await listCategories();
  publish("categories");
  return c.json({ categories: list.map(serializeCategory) });
});

/**
 * PUT /api/categories/:id
 * Partial update: { name?, emoji?, description?, appliesTo?, selection? }
 */
categories.put("/:id", async (c) => {
  const cat = await findCategoryById(c.req.param("id"));
  if (!cat) return fail(c, "CATEGORY_NOT_FOUND", "Categoria não encontrada.", 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const patch: Partial<Category> = {};

  if (body.name !== undefined) {
    const name = cleanText(body.name, NAME_MAX);
    if (!name) return fail(c, "NAME_INVALID", `Informe um nome com até ${NAME_MAX} caracteres.`);
    patch.name = name;
  }
  if (body.emoji !== undefined) patch.emoji = cleanEmoji(body.emoji);
  if (body.description !== undefined) {
    patch.description =
      typeof body.description === "string" ? body.description.trim().slice(0, 200) || undefined : undefined;
  }
  if (body.appliesTo !== undefined) {
    const appliesTo = parseAudience(body.appliesTo);
    if (!appliesTo) {
      return fail(c, "AUDIENCE_INVALID", "Escolha ao menos um público: acampante e/ou equipe.");
    }
    patch.appliesTo = appliesTo;
  }
  if (body.selection !== undefined) {
    const selection = parseSelection(body.selection);
    if (!selection) return fail(c, "SELECTION_INVALID", "Tipo de seleção inválido.");
    patch.selection = selection;
  }

  const updated = await updateCategory(cat._id, patch);
  publish("categories");
  return c.json({ category: serializeCategory(updated!) });
});

categories.delete("/:id", async (c) => {
  const ok = await deleteCategory(c.req.param("id"));
  if (!ok) return fail(c, "CATEGORY_NOT_FOUND", "Categoria não encontrada.", 404);
  publish("categories");
  return c.json({ success: true });
});

// ── options (the enumeration values) ───────────────────────────────────────

/** POST /api/categories/:id/options  { label } */
categories.post("/:id/options", async (c) => {
  const cat = await findCategoryById(c.req.param("id"));
  if (!cat) return fail(c, "CATEGORY_NOT_FOUND", "Categoria não encontrada.", 404);

  const body = await c.req.json<{ label?: unknown }>().catch(() => null);
  const label = cleanText(body?.label, OPTION_MAX);
  if (!label) return fail(c, "OPTION_INVALID", `Informe uma opção com até ${OPTION_MAX} caracteres.`);

  const norm = label.toLocaleLowerCase("pt-BR");
  if (cat.options.some((o) => o.label.toLocaleLowerCase("pt-BR") === norm)) {
    return fail(c, "OPTION_DUPLICATE", `"${label}" já existe nesta categoria.`, 409);
  }

  const option: CategoryOption = { id: newOptionId(), label, order: cat.options.length, active: true };
  const updated = await updateCategory(cat._id, { options: [...cat.options, option] });
  publish("categories");
  return c.json({ category: serializeCategory(updated!), option }, 201);
});

/** PUT /api/categories/:id/options/reorder  { ids: string[] } */
categories.put("/:id/options/reorder", async (c) => {
  const cat = await findCategoryById(c.req.param("id"));
  if (!cat) return fail(c, "CATEGORY_NOT_FOUND", "Categoria não encontrada.", 404);

  const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.ids)) return fail(c, "BODY_INVALID", "Envie a lista de ids na nova ordem.");
  const ids = body.ids as string[];

  const byId = new Map(cat.options.map((o) => [o.id, o]));
  const reordered: CategoryOption[] = [];
  for (const id of ids) {
    const o = byId.get(id);
    if (o) {
      reordered.push({ ...o, order: reordered.length });
      byId.delete(id);
    }
  }
  // anything not mentioned keeps its relative order at the end
  for (const o of byId.values()) reordered.push({ ...o, order: reordered.length });

  const updated = await updateCategory(cat._id, { options: reordered });
  publish("categories");
  return c.json({ category: serializeCategory(updated!) });
});

/** PUT /api/categories/:id/options/:optionId  { label?, active? } */
categories.put("/:id/options/:optionId", async (c) => {
  const cat = await findCategoryById(c.req.param("id"));
  if (!cat) return fail(c, "CATEGORY_NOT_FOUND", "Categoria não encontrada.", 404);

  const optionId = c.req.param("optionId");
  const idx = cat.options.findIndex((o) => o.id === optionId);
  if (idx < 0) return fail(c, "OPTION_NOT_FOUND", "Opção não encontrada.", 404);

  const body = await c.req.json<{ label?: unknown; active?: unknown }>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const option = { ...cat.options[idx] };
  if (body.label !== undefined) {
    const label = cleanText(body.label, OPTION_MAX);
    if (!label) return fail(c, "OPTION_INVALID", `Informe uma opção com até ${OPTION_MAX} caracteres.`);
    const norm = label.toLocaleLowerCase("pt-BR");
    if (cat.options.some((o) => o.id !== optionId && o.label.toLocaleLowerCase("pt-BR") === norm)) {
      return fail(c, "OPTION_DUPLICATE", `"${label}" já existe nesta categoria.`, 409);
    }
    option.label = label;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") return fail(c, "BODY_INVALID", "active deve ser true/false.");
    option.active = body.active;
  }

  const options = cat.options.slice();
  options[idx] = option;
  const updated = await updateCategory(cat._id, { options });
  publish("categories");
  return c.json({ category: serializeCategory(updated!), option });
});

/** DELETE /api/categories/:id/options/:optionId */
categories.delete("/:id/options/:optionId", async (c) => {
  const cat = await findCategoryById(c.req.param("id"));
  if (!cat) return fail(c, "CATEGORY_NOT_FOUND", "Categoria não encontrada.", 404);

  const optionId = c.req.param("optionId");
  if (!cat.options.some((o) => o.id === optionId)) {
    return fail(c, "OPTION_NOT_FOUND", "Opção não encontrada.", 404);
  }

  const options = cat.options.filter((o) => o.id !== optionId).map((o, order) => ({ ...o, order }));
  const updated = await updateCategory(cat._id, { options });
  publish("categories");
  return c.json({ category: serializeCategory(updated!) });
});

export default categories;
