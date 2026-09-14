import { config } from "../config";
import type { AiVendor } from "../routes/ai";

/**
 * "Limpar repetições": a single free-text form field (emergency contact, food
 * restrictions, room preference, medical/general notes) may end up with the
 * SAME fact written twice after the observations sorter — once as the value the
 * form already had, once as the model's reworded echo of it. This is a tiny,
 * background clean-up pass that removes those duplicates from ONE field.
 *
 * It is deliberately narrow and safe:
 *   - one field in, the cleaned field out; nothing is moved between fields;
 *   - only whole repeated entries are dropped — no rewriting, summarising,
 *     translating or adding; the surviving text keeps its original wording;
 *   - best-effort: any failure (model down, bad JSON, timeout) returns the
 *     input unchanged, so it can run in the background without ever blocking
 *     or corrupting a save.
 *
 * Runs on the cheap fast model (GLM 5.3 flash), non-streaming, JSON in/out.
 */

export const FIELD_DEDUP_MODEL = { id: "glm-5.3-flash", label: "GLM 5.3 Flash", vendor: "zhipu" as AiVendor };
const TIMEOUT_MS = 15_000;
const MAX_CHARS = 2_000;

/** the fields this pass may clean, each with a one-line description of what an "entry" is */
export const DEDUP_FIELDS = {
  emergencyContact: 'contatos de emergência, cada um "Nome (vínculo) 11 99999-4999", vários separados por " / "',
  bedroomPreference: "nomes de quem dividir o quarto e pedidos de cama, separados por vírgula",
  foodRestrictions: "restrições e preferências alimentares",
  healthNotes: "observações para a equipe médica, uma por linha",
  generalNotes: "observações para os monitores, uma por linha ou frase",
} as const;

export type DedupField = keyof typeof DEDUP_FIELDS;

export function isDedupField(v: unknown): v is DedupField {
  return typeof v === "string" && v in DEDUP_FIELDS;
}

export interface FieldDedupResult {
  value: string;
  changed: boolean;
  model?: string;
  vendor?: AiVendor;
  usage?: { promptTokens: number; completionTokens: number };
}

function systemPrompt(field: DedupField): string {
  return `Você limpa UM campo de texto da ficha de um acampamento infantil (Brasil). O campo contém ${DEDUP_FIELDS[field]}.

Sua ÚNICA tarefa: remover entradas DUPLICADAS — a mesma informação escrita duas vezes, ainda que com palavras, acentos, ordem ou formato diferentes (ex.: o mesmo telefone escrito de dois jeitos, o mesmo nome repetido, a mesma frase reformulada). Mantenha a PRIMEIRA ocorrência de cada informação, com a redação original dela.

REGRAS:
1. NÃO reescreva, resuma, traduza, complete nem reordene o que sobra. NÃO invente nada. NÃO junte informações diferentes.
2. Só remova o que é de fato a MESMA informação. Na dúvida, mantenha as duas.
3. Preserve a estrutura do campo (as mesmas quebras de linha ou separadores " / " / vírgulas entre as entradas que sobraram).
4. Responda SOMENTE um objeto JSON {"value": "<texto limpo>"}. Sem markdown, sem comentários, sem cercas de código.`;
}

/**
 * Removes duplicate entries from one field's text. Best-effort: returns the
 * input unchanged (`changed:false`) on empty input, a field with nothing to
 * dedupe, or any model/parse failure.
 */
export async function dedupField(field: DedupField, value: string, signal?: AbortSignal): Promise<FieldDedupResult> {
  const input = value.trim();
  // nothing to compare when there's at most one line and one " / " segment
  if (!input || input.length > MAX_CHARS) return { value, changed: false };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.ai.apiKey}` },
      body: JSON.stringify({
        model: FIELD_DEDUP_MODEL.id,
        temperature: 0,
        reasoning_effort: "low",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt(field) },
          { role: "user", content: input },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { value, changed: false };
    const data = (await res.json().catch(() => null)) as
      | { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }
      | null;
    const content = (data?.choices?.[0]?.message?.content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end < start) return { value, changed: false };
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.slice(start, end + 1));
    } catch {
      return { value, changed: false };
    }
    const next = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).value : undefined;
    if (typeof next !== "string") return { value, changed: false };
    const cleaned = next.trim().slice(0, MAX_CHARS);
    // never let the pass ADD content: the result must be no longer than the input
    if (!cleaned || cleaned.length > input.length) return { value, changed: false };
    const usage = { promptTokens: data?.usage?.prompt_tokens ?? 0, completionTokens: data?.usage?.completion_tokens ?? 0 };
    return { value: cleaned, changed: cleaned !== input, model: FIELD_DEDUP_MODEL.id, vendor: FIELD_DEDUP_MODEL.vendor, usage };
  } catch {
    return { value, changed: false };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
