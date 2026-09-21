import { config } from "../config";
import type { AiVendor } from "../routes/ai";

/**
 * Shared client for Jev (TypeSafe System One) over the OpenRouter decisions
 * API. Jev never generates text: it answers typed questions about a state and
 * returns calibrated probabilities. Every closed decision in the app (column
 * mapping, health bucketing, option matching, name sex, health structuring)
 * goes through here; generative models are reserved for producing text.
 */
export const JEV_MODEL = { id: "typesafe/jev-1.13", label: "Jev 1.13", vendor: "typesafe" as AiVendor };
export const JEV_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const JEV_QUESTIONS_PER_REQUEST = 48;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_PARALLEL_BATCHES = 3;

export type JevUsage = { promptTokens: number; completionTokens: number };
export type NoulAnswer = { type?: unknown; noul?: unknown };
export type ChoiceAnswer = { type?: unknown; choice?: unknown; confidence?: unknown; probabilities?: unknown };

export interface JevResult<A = Record<string, unknown>> {
  answers: Record<string, A>;
  usage: JevUsage;
  /** HTTP requests made (one per batch) */
  requests: number;
  ok: boolean;
  error?: string;
}

export interface JevOptions {
  /** X-Title header, for OpenRouter's dashboard */
  title: string;
  signal?: AbortSignal;
  batch?: number;
  timeoutMs?: number;
}

export const jevEnabled = (): boolean => !!config.ai.openRouterApiKey;

/** 0..1 probability of a `noul` answer; 0 when missing/malformed */
export function noulProbability(answer: NoulAnswer | undefined): number {
  const value = Number(answer?.noul);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function clampConfidence(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

/** the picked key and its confidence from a `choice` answer; null choice when missing/malformed */
export function choiceOf(answer: ChoiceAnswer | undefined): { choice: string | null; confidence: number } {
  if (answer?.type !== "choice" || typeof answer.choice !== "string") return { choice: null, confidence: 0 };
  const probabilities = answer.probabilities && typeof answer.probabilities === "object" ? (answer.probabilities as Record<string, unknown>) : {};
  return { choice: answer.choice, confidence: clampConfidence(answer.confidence ?? probabilities[answer.choice]) };
}

async function askBatch<A>(state: unknown, questions: Record<string, unknown>, opts: JevOptions): Promise<JevResult<A>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort);
  const usage: JevUsage = { promptTokens: 0, completionTokens: 0 };
  try {
    const response = await fetch(JEV_DECISIONS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.ai.openRouterApiKey}`,
        "HTTP-Referer": config.appUrl || "https://acampakids.app",
        "X-Title": opts.title,
      },
      body: JSON.stringify({ model: JEV_MODEL.id, state, questions }),
      signal: ctrl.signal,
    });
    const body = (await response.json().catch(() => null)) as { answers?: Record<string, A>; usage?: { input_tokens?: number; output_tokens?: number }; error?: { message?: string } } | null;
    usage.promptTokens += body?.usage?.input_tokens ?? 0;
    usage.completionTokens += body?.usage?.output_tokens ?? 0;
    if (!response.ok) return { answers: {}, usage, requests: 1, ok: false, error: `HTTP ${response.status}: ${body?.error?.message ?? "Falha no Jev"}` };
    return { answers: body?.answers ?? {}, usage, requests: 1, ok: true };
  } catch (error) {
    return { answers: {}, usage, requests: 1, ok: false, error: error instanceof Error ? error.message : "Falha no Jev" };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Asks a bank of questions about one state. Questions are split into batches
 * (default 48) sent a few at a time in parallel; answers are merged. `ok` is
 * false when any batch failed — the answers of the batches that did succeed
 * are still returned so callers can fall back only for what is missing.
 */
export async function askJev<A = Record<string, unknown>>(state: unknown, questions: Record<string, unknown>, opts: JevOptions): Promise<JevResult<A>> {
  const usage: JevUsage = { promptTokens: 0, completionTokens: 0 };
  const answers: Record<string, A> = {};
  if (!jevEnabled()) return { answers, usage, requests: 0, ok: false, error: "OPENROUTER_API_KEY ausente" };
  const keys = Object.keys(questions);
  if (!keys.length) return { answers, usage, requests: 0, ok: true };
  const size = opts.batch ?? JEV_QUESTIONS_PER_REQUEST;
  const batches: Record<string, unknown>[] = [];
  for (let from = 0; from < keys.length; from += size) batches.push(Object.fromEntries(keys.slice(from, from + size).map((key) => [key, questions[key]])));

  let requests = 0;
  let error: string | undefined;
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++]!;
      if (opts.signal?.aborted) { error ??= "abortado"; return; }
      const r = await askBatch<A>(state, batch, opts);
      requests += r.requests;
      usage.promptTokens += r.usage.promptTokens;
      usage.completionTokens += r.usage.completionTokens;
      Object.assign(answers, r.answers);
      if (!r.ok) error ??= r.error;
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_BATCHES, batches.length) }, worker));
  return error ? { answers, usage, requests, ok: false, error } : { answers, usage, requests, ok: true };
}

/** accent-insensitive, lowercase, single-spaced */
export function foldText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function bigrams(value: string): Set<string> {
  const text = foldText(value).replace(/ /g, "");
  const out = new Set<string>();
  for (let i = 0; i + 1 < text.length; i++) out.add(text.slice(i, i + 2));
  return out;
}

/** Dice similarity on character bigrams — cheap, typo-tolerant, 0..1 */
export function textSimilarity(a: string, b: string): number {
  const x = bigrams(a), y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const gram of x) if (y.has(gram)) shared++;
  return (2 * shared) / (x.size + y.size);
}

/**
 * Keeps a choice question small when a category has hundreds of options:
 * the `max` most similar candidates (by bigram overlap) are offered to Jev.
 * Lists at or under `max` are returned untouched.
 */
export function shortlistCandidates<T extends { label: string }>(raw: string, candidates: T[], max: number): T[] {
  if (candidates.length <= max) return candidates;
  return candidates
    .map((candidate, index) => ({ candidate, index, score: textSimilarity(raw, candidate.label) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, max)
    .map((entry) => entry.candidate);
}
