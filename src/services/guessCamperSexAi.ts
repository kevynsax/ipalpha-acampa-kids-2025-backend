import { config } from "../config";
import type { AiVendor } from "../routes/ai";
import type { CamperSex } from "../types";

/**
 * Infers a kid's sex from the first name. Used when the form no longer asks
 * and the room is still unknown (or is a staff room — sleeping with parents).
 * A girls/boys room always wins over this guess (see camperSex.ts).
 *
 * Cheap fast model (GLM 5.3 flash), non-streaming, JSON in/out. Best-effort:
 * any failure returns `sex: null`.
 */

export const GUESS_SEX_MODELS = [
  { id: "glm-5.3-flash", label: "GLM 5.3 Flash", vendor: "zhipu" as AiVendor },
  { id: "muse-spark-1.3", label: "Muse Spark 1.3", vendor: "meta" as AiVendor },
] as const;
export const GUESS_SEX_MODEL = GUESS_SEX_MODELS[0];
const TIMEOUT_MS = 15_000;
const NAME_MAX = 100;

const SYSTEM_PROMPT = `Você classifica o sexo de uma pessoa pelo NOME, para a ficha de um acampamento infantil no Brasil (crianças e equipe).

Os nomes são quase sempre brasileiros (português do Brasil). Use isso como referência: João, Pedro, Lucas, Guilherme, Enzo, Miguel, Gabriel, Rafael, Thiago, Henrique, Bernardo, Heitor, Davi; Ana, Maria, Helena, Valentina, Alice, Laura, Sofia, Isabella, Manuela, Júlia, Larissa, Beatriz, Gabriela, etc. Nome composto ("Ana Clara", "João Pedro", "Maria Eduarda") segue o PRIMEIRO nome.

Responda SOMENTE um objeto JSON, sem markdown, sem comentários:
{"sex":"F"}  → menina
{"sex":"M"}  → menino
{"sex":null} → só se o nome for realmente ambíguo no Brasil (unissex sem uso dominante) ou não for um nome de pessoa.

Não explique.`;

export interface GuessCamperSexResult {
  sex: CamperSex | null;
  model?: string;
  vendor?: AiVendor;
  usage?: { promptTokens: number; completionTokens: number };
}

function parseSex(v: unknown): CamperSex | null {
  if (v === "F" || v === "M") return v;
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  if (s === "F" || s === "FEMININO" || s === "GIRL" || s === "MENINA" || s === "FEMALE") return "F";
  if (s === "M" || s === "MASCULINO" || s === "BOY" || s === "MENINO" || s === "MALE") return "M";
  return null;
}

/** Best-effort: `sex: null` on empty input, disabled AI, or any model/parse failure. */
export async function guessCamperSex(name: string, signal?: AbortSignal): Promise<GuessCamperSexResult> {
  const input = name.trim().slice(0, NAME_MAX);
  if (!input || !config.ai.apiKey) return { sex: null };

  for (const model of GUESS_SEX_MODELS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort);
    try {
      const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.ai.apiKey}` },
        body: JSON.stringify({
          model: model.id,
          temperature: 0,
          reasoning_effort: "low",
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: input },
          ],
        }),
        signal: ctrl.signal,
      });
      if (res.status === 429) {
        console.warn(`guess-sex ${model.id} HTTP 429, trying next model`);
        continue;
      }
      if (!res.ok) {
        console.warn(`guess-sex ${model.id} HTTP ${res.status}`);
        continue;
      }
      const data = (await res.json().catch(() => null)) as
        | { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }
        | null;
      const content = (data?.choices?.[0]?.message?.content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      const start = content.indexOf("{");
      const end = content.lastIndexOf("}");
      if (start < 0 || end < start) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(content.slice(start, end + 1));
      } catch {
        continue;
      }
      const sex = parsed && typeof parsed === "object" ? parseSex((parsed as Record<string, unknown>).sex) : null;
      if (!sex) continue;
      const usage = { promptTokens: data?.usage?.prompt_tokens ?? 0, completionTokens: data?.usage?.completion_tokens ?? 0 };
      return { sex, model: model.id, vendor: model.vendor, usage };
    } catch (error) {
      console.warn(`guess-sex ${model.id} failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  return { sex: null };
}
