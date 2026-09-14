import { config } from "../config";
import { listCategories } from "../models/categories";
import { CAMPER_CATEGORY_KEYS, MEDICATION_TIMES_MAX, MEDICATIONS_MAX, type Medication } from "../types";
import { normalizeBrazilPhone } from "../utils";
import type { AiVendor } from "../routes/ai";

/**
 * "Organizar observações": the admin pastes the free-text observations that
 * came with a kid's registration (health, preferences, emergency contacts,
 * all mixed) into "Observações gerais" and the model sorts each fact into the
 * right field of the form. Only what fits nowhere stays in the general notes.
 *
 * Non-streaming, JSON in/out. Tries the models in order until one answers
 * with parseable JSON.
 */

/** in order: first is the default, the others are fallbacks */
export const NOTES_MODELS: { id: string; label: string; vendor: AiVendor }[] = [
  { id: "grok-4.5", label: "Grok 4.5", vendor: "xai" },
  { id: "claude-fable-5-1", label: "Fable 5.1", vendor: "anthropic" },
  { id: "gpt-5.6-luna", label: "GPT 5.6", vendor: "openai" },
];

/** one model may take this long before we move to the next */
const MODEL_TIMEOUT_MS = 40_000;
export const NOTES_MAX_CHARS = 4_000;

/** the form fields the model may fill (all optional in the answer) */
export interface CamperNotesFields {
  /** category option ids */
  allergies: string[];
  drugAllergies: string[];
  healthIssues: string[];
  neurodivergent: boolean;
  medications: Medication[];
  foodRestrictions: string;
  healthNotes: string;
  bedroomPreference: string;
  emergencyContact: string;
  /** what was left in the general notes after sorting */
  generalNotes: string;
}

export interface CamperNotesInput {
  /** the text to sort (current content of "Observações gerais") */
  notes: string;
  /** what the form already holds — the answer must keep it */
  current: Partial<CamperNotesFields>;
}

export interface CamperNotesResult {
  fields: CamperNotesFields;
  model: string;
  vendor: AiVendor;
  usage: { promptTokens: number; completionTokens: number };
  /** models that failed before this one answered */
  failed: string[];
}

interface OptionList {
  key: string;
  labels: string[];
  /** lower-cased label → option id */
  byLabel: Map<string, string>;
  /** option id → label */
  byId: Map<string, string>;
}

async function optionLists(): Promise<Record<"allergies" | "drugAllergies" | "healthIssues", OptionList>> {
  const cats = await listCategories();
  const build = (key: string): OptionList => {
    const c = cats.find((x) => x.key === key);
    const options = (c?.options ?? []).filter((o) => o.active && !/^nenhum/i.test(o.label));
    return {
      key,
      labels: options.map((o) => o.label),
      byLabel: new Map(options.map((o) => [o.label.toLowerCase(), o.id])),
      byId: new Map(options.map((o) => [o.id, o.label])),
    };
  };
  return {
    allergies: build(CAMPER_CATEGORY_KEYS.allergies),
    drugAllergies: build(CAMPER_CATEGORY_KEYS.drugAllergies),
    healthIssues: build(CAMPER_CATEGORY_KEYS.healthIssues),
  };
}

export function notesSystemPrompt(lists: { allergies: string[]; drugAllergies: string[]; healthIssues: string[] }): string {
  return `Você organiza a ficha de uma criança no sistema de um ACAMPAMENTO INFANTIL de igreja (Brasil). A organização colou no campo "Observações gerais" o texto livre que os pais escreveram na inscrição: saúde, medicamentos, preferências de quarto, contatos de emergência, comportamento, tudo misturado. Sua tarefa: distribuir cada informação para o campo certo da ficha e deixar em "Observações gerais" SOMENTE o que não cabe em nenhum outro campo.

## Campos da ficha (responda um objeto JSON com exatamente estas chaves)
- "allergies": lista de strings. Alergias (ambiente, insetos, alimentos). Use SOMENTE valores desta lista, escritos exatamente assim: ${JSON.stringify(lists.allergies)}. Se o texto cita uma alergia que não está na lista, NÃO invente um valor: descreva-a em "healthNotes".
- "drugAllergies": lista de strings. Alergia a medicamentos. Use SOMENTE valores desta lista: ${JSON.stringify(lists.drugAllergies)}. Medicamento fora da lista → "Outro medicamento" (se existir na lista) E o nome do remédio em "healthNotes".
- "healthIssues": lista de strings. Condições crônicas. Use SOMENTE valores desta lista: ${JSON.stringify(lists.healthIssues)}. Condição fora da lista → descreva em "healthNotes".
- "neurodivergent": boolean. true se o texto indica TEA/autismo, TDAH ou outra neurodivergência diagnosticada. Se não menciona, false.
- "medications": lista de objetos {"name","dose","times","asNeeded","notes"}. Um item por medicamento de uso ROTINEIRO ou de crise que a equipe médica precisa ter à mão. "name": nome comercial ou princípio ativo como escrito ("Aerolin", "Ritalina"). "dose": quantidade por administração ("10mg", "5ml", "4 puffs"), vazio se não informada. "times": horários fixos no formato "HH:MM" (café da manhã = "08:30", almoço = "12:30", lanche = "16:30", jantar = "19:00", dormir = "22:00"); vazio se não há horário fixo. "asNeeded": true quando é só em caso de crise/necessidade. "notes": modo de uso e condição, curto ("em crise de asma, com espaçador, 10 s entre os jatos"). Não repita o nome nem a dose nas notes.
- "foodRestrictions": string. Restrições e preferências ALIMENTARES (intolerâncias, dieta, "seletiva", "não come carne"). Alergia alimentar entra em "allergies" (se estiver na lista) e a orientação prática aqui.
- "healthNotes": string. Orientações de saúde para a equipe médica que não cabem nos campos acima: como agir em crise, condições fora da lista, cuidados (sonambulismo, enurese, vômitos, sono, objetos de apoio médico, "não sabe nadar" NÃO é saúde). Frases curtas, uma por linha quando forem assuntos diferentes.
- "bedroomPreference": string. Com quem a criança quer dividir o quarto e pedidos sobre a cama/quarto. Formato: nomes separados por vírgula, com o vínculo entre parênteses quando informado: "Bernardo Faria, Lucas (primo)". Pedidos sobre a cama entram depois dos nomes, curto: "Enzo Dalfovo · só cama de baixo". Se o texto só diz "cama de baixo", escreva "só cama de baixo".
- "emergencyContact": string. Contatos de emergência. Formato SEMPRE: "Nome (vínculo) 11 99999-0000". Vínculo entre parênteses só se informado (pai, mãe, avó, tia…). Telefone SEMPRE como "DD 9XXXX-XXXX" (DDD, espaço, 5 dígitos, hífen, 4 dígitos); se faltar o DDD, use 11. Vários contatos separados por " / ". Se só há telefone, escreva só o telefone. Nome com iniciais maiúsculas.
- "generalNotes": string. O que sobrou: comportamento, emoções, medos, primeira vez no acampamento, pedidos para os monitores (ficar perto de alguém nas brincadeiras, não sabe nadar, tem um objeto de apego), pendências de cadastro. Texto limpo, em frases curtas, uma ideia por frase. Se tudo foi para outros campos, devolva "".

## Regras
1. NÃO invente nada. Só use o que está no texto e nos campos atuais. Nada de doses, horários, nomes ou telefones que não estão escritos. Se uma frase for ambígua, deixe-a em "generalNotes" em vez de chutar um campo.
2. Cada informação aparece UMA vez, no campo mais específico. Depois de mover uma informação, ela NÃO fica em "generalNotes".
3. Os campos que você devolve SUBSTITUEM os atuais: repita o conteúdo que já existe neles (listas e textos) e acrescente o novo. Nunca remova o que já está lá; nunca duplique um item já presente. Para listas, a união; para textos, o atual e o novo em linhas/frases separadas.
4. Normalize a escrita: corrija ortografia e acentuação, iniciais maiúsculas em nomes próprios, remova CAIXA ALTA, emojis e repetições ("NOAHHHHHH Ribeiro" → "Noah Ribeiro"). Mantenha o sentido e os fatos exatos (doses, quantidades, nomes de remédios).
5. Português do Brasil. Sem comentários, sem markdown, sem cercas de código: responda SOMENTE o objeto JSON.`;
}

function userMessage(input: CamperNotesInput, lists: Record<"allergies" | "drugAllergies" | "healthIssues", OptionList>): string {
  const cur = input.current;
  const labels = (list: OptionList, ids?: string[]) => (ids ?? []).map((id) => list.byId.get(id) ?? id).filter(Boolean);
  const current = {
    allergies: labels(lists.allergies, cur.allergies),
    drugAllergies: labels(lists.drugAllergies, cur.drugAllergies),
    healthIssues: labels(lists.healthIssues, cur.healthIssues),
    neurodivergent: cur.neurodivergent === true,
    medications: cur.medications ?? [],
    foodRestrictions: cur.foodRestrictions ?? "",
    healthNotes: cur.healthNotes ?? "",
    bedroomPreference: cur.bedroomPreference ?? "",
    emergencyContact: cur.emergencyContact ?? "",
  };
  return `CAMPOS ATUAIS DA FICHA (mantenha e complete):\n${JSON.stringify(current, null, 1)}\n\nOBSERVAÇÕES GERAIS (texto a organizar):\n${input.notes.trim() || "(vazio)"}`;
}

// ── normalisation of the model output ─────────────────────────────────

/** "Alison(pai)/ 1196305-5033" → "Alison (pai) 11 96305-5033" — one pass over every phone-looking run */
export function formatEmergencyContact(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/(\+?55)?[\s.(-]*(\d{2})?[\s.)-]*(9\s?\d{4})[\s.-]?(\d{4})(?!\d)/g, (m, _cc, ddd, a, b) => {
      const e164 = normalizeBrazilPhone(`${ddd ?? "11"}${a}${b}`.replace(/\s/g, ""));
      if (!e164) return m;
      const n = e164.slice(3);
      return ` ${n.slice(0, 2)} ${n.slice(2, 7)}-${n.slice(7)}`;
    })
    .replace(/\s*\(\s*/g, " (")
    .replace(/\s*\)\s*/g, ") ")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim();
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function labelsToIds(list: OptionList, v: unknown, current: string[] = []): { ids: string[]; unmatched: string[] } {
  const ids = new Set(current.filter((id) => list.byId.has(id)));
  const unmatched: string[] = [];
  if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item !== "string") continue;
      const id = list.byLabel.get(item.trim().toLowerCase());
      if (id) ids.add(id);
      else if (item.trim()) unmatched.push(item.trim());
    }
  }
  return { ids: [...ids], unmatched };
}

function toMedications(v: unknown, current: Medication[] = []): Medication[] {
  const out: Medication[] = [];
  const seen = new Set<string>();
  const push = (m: Medication) => {
    const k = m.name.toLowerCase();
    if (!m.name || seen.has(k)) return;
    seen.add(k);
    out.push(m);
  };
  if (Array.isArray(v)) {
    for (const raw of v) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Record<string, unknown>;
      const times = Array.isArray(m.times) ? [...new Set((m.times as unknown[]).filter((t): t is string => typeof t === "string" && TIME_RE.test(t)))].sort().slice(0, MEDICATION_TIMES_MAX) : [];
      push({ name: str(m.name, 120), dose: str(m.dose, 120), times, asNeeded: m.asNeeded === true || (times.length === 0 && m.asNeeded !== false), notes: str(m.notes, 300) });
    }
  }
  // anything the model dropped from the form is kept
  for (const m of current) push(m);
  return out.slice(0, MEDICATIONS_MAX);
}

/** merges "a" and "b" as separate lines when both exist and b doesn't already contain a */
function mergeText(current: string, next: string, max: number): string {
  const c = current.trim();
  const n = next.trim();
  if (!c) return n.slice(0, max);
  if (!n || n.includes(c)) return (n || c).slice(0, max);
  return `${c}\n${n}`.slice(0, max);
}

export function normalizeNotesAnswer(raw: unknown, input: CamperNotesInput, lists: Record<"allergies" | "drugAllergies" | "healthIssues", OptionList>): CamperNotesFields {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const cur = input.current;
  const allergies = labelsToIds(lists.allergies, a.allergies, cur.allergies);
  const drugAllergies = labelsToIds(lists.drugAllergies, a.drugAllergies, cur.drugAllergies);
  const healthIssues = labelsToIds(lists.healthIssues, a.healthIssues, cur.healthIssues);
  // labels the model made up outside the lists are not lost: they go to the health notes
  const extra = [...allergies.unmatched.map((x) => `Alergia: ${x}`), ...drugAllergies.unmatched.map((x) => `Alergia a medicamento: ${x}`), ...healthIssues.unmatched];
  let healthNotes = str(a.healthNotes, 1000);
  for (const line of extra) if (!healthNotes.toLowerCase().includes(line.toLowerCase().replace(/^.*?: /, ""))) healthNotes = mergeText(healthNotes, line, 1000);
  return {
    allergies: allergies.ids,
    drugAllergies: drugAllergies.ids,
    healthIssues: healthIssues.ids,
    neurodivergent: cur.neurodivergent === true || a.neurodivergent === true,
    medications: toMedications(a.medications, cur.medications),
    foodRestrictions: mergeText(cur.foodRestrictions ?? "", str(a.foodRestrictions, 1000), 1000),
    healthNotes: mergeText(cur.healthNotes ?? "", healthNotes, 1000),
    bedroomPreference: mergeText(cur.bedroomPreference ?? "", str(a.bedroomPreference, 120), 120).replace(/\n/g, ", "),
    emergencyContact: formatEmergencyContact(mergeText(cur.emergencyContact ?? "", str(a.emergencyContact, 120), 120).replace(/\n/g, " / ")),
    generalNotes: str(a.generalNotes, 1000),
  };
}

// ── gateway call ───────────────────────────────────────────────────────

export interface RawNotesCall {
  ok: boolean;
  json?: unknown;
  usage: { promptTokens: number; completionTokens: number };
  error?: string;
  ms: number;
}

/** one model, one shot: returns the parsed JSON object or an error */
export async function callNotesModel(modelId: string, system: string, user: string, signal?: AbortSignal): Promise<RawNotesCall> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MODEL_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  const usage = { promptTokens: 0, completionTokens: 0 };
  try {
    const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.ai.apiKey}` },
      body: JSON.stringify({
        model: modelId,
        temperature: 0,
        // structured extraction: thinking long doesn't help and the form waits on this
        reasoning_effort: "low",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      return { ok: false, usage, error: `http ${res.status} ${detail}`, ms: Date.now() - started };
    }
    const data = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
    usage.promptTokens = data?.usage?.prompt_tokens ?? 0;
    usage.completionTokens = data?.usage?.completion_tokens ?? 0;
    const content = data?.choices?.[0]?.message?.content ?? "";
    const text = content
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < start) return { ok: false, usage, error: `no json: ${text.slice(0, 120)}`, ms: Date.now() - started };
    try {
      return { ok: true, json: JSON.parse(text.slice(start, end + 1)), usage, ms: Date.now() - started };
    } catch {
      return { ok: false, usage, error: `bad json: ${text.slice(0, 120)}`, ms: Date.now() - started };
    }
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    return { ok: false, usage, error: aborted ? (signal?.aborted ? "cancelled" : "timeout") : "unreachable", ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Runs the model chain; `null` when every model failed (or the caller cancelled). */
export async function sortCamperNotes(
  input: CamperNotesInput,
  opts: { signal?: AbortSignal; models?: typeof NOTES_MODELS; onAttempt?: (model: string, r: RawNotesCall) => void } = {},
): Promise<CamperNotesResult | null> {
  const lists = await optionLists();
  const system = notesSystemPrompt({ allergies: lists.allergies.labels, drugAllergies: lists.drugAllergies.labels, healthIssues: lists.healthIssues.labels });
  const user = userMessage(input, lists);
  const failed: string[] = [];
  for (const m of opts.models ?? NOTES_MODELS) {
    if (opts.signal?.aborted) return null;
    const r = await callNotesModel(m.id, system, user, opts.signal);
    opts.onAttempt?.(m.id, r);
    if (r.ok) return { fields: normalizeNotesAnswer(r.json, input, lists), model: m.id, vendor: m.vendor, usage: r.usage, failed };
    if (r.error === "cancelled") return null;
    failed.push(m.id);
  }
  return null;
}
