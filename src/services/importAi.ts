import { config } from "../config";
import type { AiVendor } from "../routes/ai";
import type { CamperSex } from "../types";

export const IMPORT_FAST_MODEL = { id: "glm-5.3-flash", label: "GLM 5.3 Flash", vendor: "zhipu" as AiVendor };
export const IMPORT_FAST_FALLBACKS = ["muse-spark-1.3"];
export const IMPORT_DATE_MODEL = { id: "claude-fable-5-1", label: "Fable 5.1", vendor: "anthropic" as AiVendor };

const TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_IMPORT_AI = 3;
let activeImportAi = 0;
const importAiWaiters: (() => void)[] = [];
const importAiCooldownUntil = new Map<string, number>();
const importAiStats = { requests: 0, succeeded: 0, failed: 0, skippedCooldown: 0, byModel: {} as Record<string, number> };

export function resetImportAiStats(): void {
  importAiStats.requests = 0;
  importAiStats.succeeded = 0;
  importAiStats.failed = 0;
  importAiStats.skippedCooldown = 0;
  importAiStats.byModel = {};
}

export function getImportAiStats(): typeof importAiStats {
  return { ...importAiStats, byModel: { ...importAiStats.byModel } };
}

async function acquireImportAi(): Promise<void> {
  if (activeImportAi < MAX_CONCURRENT_IMPORT_AI) { activeImportAi++; return; }
  await new Promise<void>((resolve) => importAiWaiters.push(resolve));
  activeImportAi++;
}

function releaseImportAi(): void {
  activeImportAi--;
  importAiWaiters.shift()?.();
}

async function jsonCall<T>(model: string, system: string, input: unknown, signal?: AbortSignal, fallbacks: string[] = []): Promise<T | null> {
  if (!config.ai.apiKey) return null;
  await acquireImportAi();
  const started = Date.now();
  const models = [model, ...fallbacks.filter((id) => id && id !== model)];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const abort = () => ctrl.abort();
  signal?.addEventListener("abort", abort);
  try {
    for (let i = 0; i < models.length; i++) {
      const current = models[i]!;
      if ((importAiCooldownUntil.get(current) ?? 0) > Date.now()) {
        importAiStats.skippedCooldown++;
        if (process.env.IMPORT_AI_TRACE === "1") console.error(`[import-ai] ${current} skipped during provider cooldown`);
        continue;
      }
      let res: Response | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        importAiStats.requests++;
        importAiStats.byModel[current] = (importAiStats.byModel[current] ?? 0) + 1;
        res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.ai.apiKey}` },
          body: JSON.stringify({
            model: current,
            temperature: 0,
            reasoning_effort: "low",
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: system },
              { role: "user", content: JSON.stringify(input) },
            ],
          }),
          signal: ctrl.signal,
        });
        if (res.status !== 429 || attempt === 2) break;
        const retryAfter = Number(res.headers.get("retry-after"));
        const requestedWait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 750 * 2 ** attempt;
        if (requestedWait > TIMEOUT_MS) {
          importAiCooldownUntil.set(current, Date.now() + requestedWait);
          console.warn(`[import-ai] ${current} HTTP 429; cooldown exceeds request timeout, using deterministic fallback`);
          break;
        }
        const waitMs = Math.min(requestedWait, 5_000);
        console.warn(`[import-ai] ${current} HTTP 429; retrying in ${waitMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      if (!res) continue;
      if (res.status === 429 || !res.ok) {
        importAiStats.failed++;
        console.warn(`[import-ai] ${current} HTTP ${res.status} (${Date.now() - started}ms)${i < models.length - 1 ? `, trying ${models[i + 1]}` : ""}`);
        continue;
      }
      const data = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
      const text = (data?.choices?.[0]?.message?.content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      const from = text.indexOf("{");
      const to = text.lastIndexOf("}");
      if (from < 0 || to < from) {
        console.warn(`[import-ai] ${current} returned no JSON (${Date.now() - started}ms)`);
        continue;
      }
      try {
        const parsed = JSON.parse(text.slice(from, to + 1)) as T;
        importAiStats.succeeded++;
        if (process.env.IMPORT_AI_TRACE === "1") console.error(`[import-ai] ${current} ok (${Date.now() - started}ms)`);
        return parsed;
      } catch (error) {
        console.warn(`[import-ai] ${current} JSON parse failed (${Date.now() - started}ms): ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
    return null;
  } catch (error) {
    console.warn(`[import-ai] failed (${Date.now() - started}ms): ${error instanceof Error ? error.message : "unknown error"}`);
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    releaseImportAi();
  }
}

export async function mapImportColumns(
  columns: { name: string; samples: string[] }[],
  targets: { key: string; label: string; aliases: string[]; required?: boolean }[],
  signal?: AbortSignal,
): Promise<Record<string, { target: string | null; confidence: number }>> {
  const answer = await jsonCall<{ mappings?: { source?: string; target?: string | null; confidence?: number }[] }>(
    IMPORT_FAST_MODEL.id,
    `Você mapeia colunas de CSV/Excel para uma ficha de acampamento no Brasil. Use o nome da coluna e até 5 exemplos. Responda somente JSON {"mappings":[{"source":"...","target":"chave ou null","confidence":0-1}]}. Não force: target null se não houver campo claro. Campos possíveis: ${targets.map((t) => `${t.key}=${t.label} (sinônimos: ${t.aliases.join(", ")})`).join("; ")}.`,
    { columns },
    signal,
    IMPORT_FAST_FALLBACKS,
  );
  const out: Record<string, { target: string | null; confidence: number }> = {};
  for (const m of answer?.mappings ?? []) {
    if (!m.source) continue;
    out[m.source] = { target: typeof m.target === "string" && targets.some((t) => t.key === m.target) ? m.target : null, confidence: Math.max(0, Math.min(1, Number(m.confidence) || 0)) };
  }
  return out;
}

/** Category fields whose cells can list several conditions at once — these are split into atomic items. */
export const SPLIT_CATEGORY_FIELDS = ["allergies", "drugAllergies", "healthIssues"];

export async function dedupeImportValues(field: string, values: string[], signal?: AbortSignal, split = false): Promise<Record<string, string | boolean | string[]>> {
  if (values.length === 0) return {};
  const bool = field === "neurodivergent";
  const splitPrompt = `Você normaliza valores da coluna "${field}" de uma planilha de acampamento. Cada célula pode listar VÁRIAS condições: divida em itens individuais (separados por vírgula, ponto e vírgula, barra, travessão ou "e") e agrupe grafias equivalentes de cada item em um texto canônico curto em português do Brasil, sem inventar fatos — por exemplo "Rinite, Asma e Picadas de Insetos" vira ["Rinite", "Asma", "Picada de inseto"]. Cada item deve ser um NOME CURTO (no máximo 4 palavras): se a célula for um texto narrativo, extraia só os nomes das condições citadas e ignore dosagens, instruções e recomendações — "Portador de valva aórtica bicúspide, com insuficiência discreta... Amoxil 500mg antes de procedimentos" vira ["Valva aórtica bicúspide"]. Nomes de medicamentos e substâncias específicas (Plasil, amoxicilina, ibuprofeno…) são itens válidos SOMENTE quando o texto afirma alergia, reação ou uso atual; menção condicional ou profilática ("caso necessidade", "se precisar", "profilaxia", "antes de procedimentos") NÃO vira item — fica nas observações. Apenas negações (não, nenhuma, sem alergia) ou texto que claramente não cita nenhuma alergia/condição viram lista vazia. Cada valor bruto deve aparecer uma vez na resposta, preservado exatamente. Responda JSON {"values":[{"raw":"...","items":["..."]}]}`;
  const answer = await jsonCall<{ values?: { raw?: string; canonical?: string; boolean?: boolean; items?: string[] }[] }>(
    IMPORT_FAST_MODEL.id,
    bool
      ? `Você deduplica valores de uma coluna de planilha de pessoas de um acampamento. Campo: ${field}. Cada valor bruto deve aparecer uma vez na resposta. Classifique cada valor como booleano; vazio/ausência não vem nesta lista. TEA, autismo, TDAH e neurodivergências explícitas=true; negações=false. Responda JSON {"values":[{"raw":"...","boolean":true}]}.`
      : split
        ? splitPrompt
        : `Você deduplica valores de uma coluna de planilha de pessoas de um acampamento. Campo: ${field}. Cada valor bruto deve aparecer uma vez na resposta. Agrupe grafias equivalentes e devolva um texto canônico curto em português do Brasil, sem inventar fatos. Responda JSON {"values":[{"raw":"...","canonical":"..."}]}.`,
    { values },
    signal,
    IMPORT_FAST_FALLBACKS,
  );
  const out: Record<string, string | boolean | string[]> = {};
  for (const item of answer?.values ?? []) {
    if (!item.raw || !values.includes(item.raw)) continue;
    if (bool) out[item.raw] = item.boolean === true;
    else if (split) out[item.raw] = [...new Set((item.items ?? []).map((v) => v?.trim()).filter((v): v is string => !!v && v.length <= 48))].slice(0, 6);
    else out[item.raw] = item.canonical?.trim() || item.raw;
  }
  return out;
}

export async function bestImportMatch(
  kind: string,
  raw: string,
  candidates: { id: string; label: string }[],
  signal?: AbortSignal,
): Promise<{ id: string | null; createName: string | null }> {
  if (!raw) return { id: null, createName: null };
  const answer = await jsonCall<{ id?: string | null; createName?: string | null }>(
    IMPORT_FAST_MODEL.id,
    `Tente encontrar um ${kind} existente equivalente ao texto bruto. Erros, abreviações, acentos e ordem de palavras podem variar. Só escolha um id se for realmente o mesmo item. Se não houver, sugira createName com o melhor nome possível em português do Brasil, primeira letra maiúscula. Responda JSON {"id":"id ou null","createName":"nome ou null"}.`,
    { raw, candidates },
    signal,
  );
  return {
    id: typeof answer?.id === "string" && candidates.some((c) => c.id === answer.id) ? answer.id : null,
    createName: typeof answer?.createName === "string" ? answer.createName.trim() : null,
  };
}

export async function bestImportMatches(
  kind: string,
  values: string[],
  candidates: { id: string; label: string }[],
  signal?: AbortSignal,
): Promise<Record<string, { id: string | null; createName: string | null }>> {
  const out: Record<string, { id: string | null; createName: string | null }> = {};
  for (let from = 0; from < values.length; from += 25) {
    const chunk = values.slice(from, from + 25);
    const call = () => jsonCall<{ matches?: { raw?: string; id?: string | null; createName?: string | null }[] }>(
      IMPORT_FAST_MODEL.id,
      `Para cada texto bruto, encontre a opção existente equivalente. Considere erros, abreviações, acentos e ordem de palavras. Só escolha id se for realmente o mesmo item. Quando for uma condição real sem opção existente, sugira createName curto e claro em português do Brasil. Quando o texto negar a condição (não, nenhuma, sem alergia), for só observação livre ou não representar esta categoria, devolva id e createName null: nunca crie uma categoria para uma ausência. Preserve exatamente cada raw. JSON {"matches":[{"raw":"...","id":"id ou null","createName":"nome ou null"}]}.`,
      { kind, values: chunk, candidates },
      signal,
      IMPORT_FAST_FALLBACKS,
    );
    const answer = await call();
    for (const match of answer?.matches ?? []) {
      if (!match.raw || !chunk.includes(match.raw)) continue;
      out[match.raw] = {
        id: typeof match.id === "string" && candidates.some((c) => c.id === match.id) ? match.id : null,
        createName: typeof match.createName === "string" ? match.createName.trim() : null,
      };
    }
  }
  return out;
}

export type ImportCategoryBucket = "allergies" | "drugAllergies" | "healthIssues" | "none";

/**
 * A spreadsheet often pours everything into one "allergies" column. Before any
 * option is matched or created, each atom is routed to the category it really
 * belongs to: medications never stay in allergies, chronic conditions either.
 */
export async function classifyImportItems(items: string[], signal?: AbortSignal, sourceOf?: (item: string) => string | undefined): Promise<Record<string, ImportCategoryBucket>> {
  const out: Record<string, ImportCategoryBucket> = {};
  if (items.length === 0) return out;
  const prompt = (chunk: string[]) => `Você classifica itens de saúde de fichas de acampamento. Para CADA item, escolha exatamente uma categoria:
- "drugAllergies": alergia ou reação a MEDICAMENTO — nome de remédio (amoxicilina, ibuprofeno, paracetamol, plasil, dipirona, novalgina...) quando o item AFIRMA alergia/reação ("alergia a", "reação a", "urticária", "choque") OU quando vem de uma coluna de alergia (a coluna já afirma a alergia).
- "healthIssues": condição de saúde ou crônica — asma, bronquite, cardiopatia, valva aórtica, terror noturno, TEA, epilepsia, diabetes...
- "allergies": gatilho ou quadro alérgico ambiental, de contato ou alimentar — rinite, rinite alérgica, sinusite alérgica, dermatite, poeira, mofo, pólen, picada de inseto/formiga, pelo de animal, peixe, glúten, levedura.
- "none": o resto — negações, observações livres, intolerâncias sem alergia E nome de remédio sozinho, sem palavra de alergia, vindo de coluna que não é de alergia (é menção de uso, profilaxia ou instrução — vai para as observações, nunca vira alergia).
Regras: nome de medicamento JAMAIS é "allergies"; condição crônica não alérgica JAMAIS é "allergies"; rinite e demais quadros alérgicos SEMPRE são "allergies"; instrução de uso ou profilaxia ("caso necessidade", "se precisar", "antes de procedimentos") NUNCA é "drugAllergies". Preserve cada item exatamente como recebido. Responda JSON {"items":[{"item":"...","category":"..."}]} para todos os itens: ${JSON.stringify(sourceOf ? chunk.map((item) => ({ item, from: sourceOf(item) ?? "" })) : chunk)}`;
  for (let from = 0; from < items.length; from += 25) {
    const chunk = items.slice(from, from + 25);
    const answer = await jsonCall<{ items?: { item?: string; category?: string }[] }>(IMPORT_FAST_MODEL.id, prompt(chunk), {}, signal, IMPORT_FAST_FALLBACKS);
    for (const entry of answer?.items ?? []) {
      if (!entry.item || !chunk.includes(entry.item)) continue;
      if (entry.category === "allergies" || entry.category === "drugAllergies" || entry.category === "healthIssues" || entry.category === "none") out[entry.item] = entry.category;
    }
  }
  return out;
}

export async function matchLeaderWithAi(
  raw: string,
  staff: { id: string; name: string }[],
  signal?: AbortSignal,
): Promise<string | null> {
  const answer = await jsonCall<{ id?: string | null }>(
    IMPORT_FAST_MODEL.id,
    `Encontre qual membro da equipe é a mesma pessoa do nome bruto. Considere apelidos, sobrenomes omitidos e erros. Só responda id quando houver uma opção claramente melhor; em ambiguidade use null. JSON {"id":"id ou null"}.`,
    { raw, staff },
    signal,
    IMPORT_FAST_FALLBACKS,
  );
  return typeof answer?.id === "string" && staff.some((s) => s.id === answer.id) ? answer.id : null;
}

export async function guessNamesSex(names: string[], signal?: AbortSignal): Promise<CamperSex | null> {
  const answer = await jsonCall<{ sex?: string | null }>(
    IMPORT_FAST_MODEL.id,
    `Os nomes são primeiros nomes de até 7 crianças brasileiras que vão para o mesmo quarto. Classifique o quarto como feminino F ou masculino M. Se os nomes não sustentam uma única resposta, use null. JSON {"sex":"F|M|null"}.`,
    { names },
    signal,
    IMPORT_FAST_FALLBACKS,
  );
  return answer?.sex === "F" || answer?.sex === "M" ? answer.sex : null;
}

function parseSexValue(v: unknown): CamperSex | null {
  if (v === "F" || v === "M") return v;
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  if (s === "F" || s === "FEMININO" || s === "GIRL" || s === "MENINA" || s === "FEMALE") return "F";
  if (s === "M" || s === "MASCULINO" || s === "BOY" || s === "MENINO" || s === "MALE") return "M";
  return null;
}

const nameKey = (name: string): string =>
  name.split(" ")[0]?.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]+/g, "").trim() ?? "";

/** One request classifies many unrelated first names; used by staff without rooms. */
export async function guessIndividualNamesSex(names: string[], signal?: AbortSignal): Promise<Record<string, CamperSex | null>> {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))].slice(0, 60);
  if (!unique.length) return {};
  const answer = await jsonCall<Record<string, unknown>>(
    IMPORT_FAST_MODEL.id,
    `Classifique primeiros nomes brasileiros individualmente como feminino F ou masculino M. Se um nome for realmente ambíguo, use null. Preserve exatamente cada nome recebido. Responda JSON {"people":[{"name":"...","sex":"F|M|null"}]}.`,
    { names: unique },
    signal,
    IMPORT_FAST_FALLBACKS,
  );
  const out: Record<string, CamperSex | null> = {};
  const byKey = new Map<string, string>();
  for (const name of unique) {
    const key = nameKey(name);
    if (key && !byKey.has(key)) byKey.set(key, name);
  }
  const apply = (raw: string, sex: CamperSex | null) => {
    const original = unique.includes(raw) ? raw : byKey.get(nameKey(raw));
    if (original && sex) out[original] = sex;
  };
  const people = Array.isArray(answer?.people) ? answer.people : Array.isArray(answer?.names) ? answer.names : null;
  if (Array.isArray(people)) {
    for (const item of people) {
      if (!item || typeof item !== "object") continue;
      const person = item as Record<string, unknown>;
      const name = typeof person.name === "string" ? person.name : typeof person.nome === "string" ? person.nome : "";
      if (name) apply(name, parseSexValue(person.sex ?? person.sexo ?? person.gender));
    }
  } else if (answer) {
    for (const [name, value] of Object.entries(answer)) {
      if (name === "people" || name === "names") continue;
      apply(name, parseSexValue(value));
    }
  }
  return out;
}

export async function askDateParser(samples: string[], signal?: AbortSignal): Promise<string | null> {
  const answer = await jsonCall<{ source?: string }>(
    IMPORT_DATE_MODEL.id,
    `Crie o corpo de uma função JavaScript segura que recebe value e devolve uma data ISO YYYY-MM-DD ou null. Datas são de nascimento, priorize formato brasileiro dd/MM/yyyy. Não use eval, Function, require, import, rede, filesystem, timers ou variáveis externas. Responda JSON {"source":"..."}. O source será validado e guardado para auditoria; mantenha curto.`,
    { samples },
    signal,
    [IMPORT_FAST_MODEL.id, ...IMPORT_FAST_FALLBACKS],
  );
  return typeof answer?.source === "string" ? answer.source.trim().slice(0, 4_000) : null;
}
