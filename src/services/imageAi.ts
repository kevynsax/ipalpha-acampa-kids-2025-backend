import { config } from "../config";

/**
 * Picture generation for the editor: the AI assistant (or the admin, through
 * the 🎨 toolbar button) describes an illustration and the gateway renders it.
 *
 * The bytes are handed back to the browser as a data url: the app then shrinks
 * the picture on the device (the gateway always answers with a ~1.2 MB PNG) and
 * uploads it through `POST /api/files` like any other editor image, so the
 * document ends up with a plain `/api/files/<id>` url and one storage path.
 *
 * Two shapes exist on the gateway:
 *   images API  (gpt-image-2, grok-imagine)  → { data: [{ b64_json }] }
 *   chat API    (gemini flash image)         → choices[0].message.images[].image_url.url (data url)
 */

export type ImageVendor = "openai" | "xai" | "google";

export interface ImageModel {
  id: string;
  label: string;
  vendor: ImageVendor;
  /** the gateway endpoint this model answers on */
  api: "images" | "chat";
}

/** first = default; a fallback is tried when the first one fails */
export const IMAGE_MODELS: ImageModel[] = [
  { id: "gpt-image-2", label: "GPT Image", vendor: "openai", api: "images" },
  { id: "gemini-3.1-flash-image", label: "Nano Banana", vendor: "google", api: "chat" },
  { id: "grok-imagine-image-2.0", label: "Grok Imagine", vendor: "xai", api: "images" },
];

/** shapes offered in the app (the gateway's images API accepts these three) */
export const IMAGE_SIZES = { square: "1024x1024", wide: "1536x1024", tall: "1024x1536" } as const;
export type ImageShape = keyof typeof IMAGE_SIZES;

export function isImageShape(v: unknown): v is ImageShape {
  return typeof v === "string" && v in IMAGE_SIZES;
}

const TIMEOUT_MS = 180_000;

/**
 * The gateway doesn't always say what it returned (Grok answers JPEG bytes with
 * no `output_format`, and ignores the one we ask for), so the type comes from
 * the bytes themselves — the browser has to store the picture with the right
 * content-type.
 */
function sniffType(b64: string, fallback: string): string {
  const head = b64.slice(0, 16);
  if (head.startsWith("iVBORw0KGgo")) return "image/png";
  if (head.startsWith("/9j/")) return "image/jpeg";
  if (head.startsWith("UklGR")) return "image/webp";
  if (head.startsWith("R0lGOD")) return "image/gif";
  return fallback;
}

export interface GeneratedImage {
  /** `data:image/png;base64,…` ready for an <img> */
  dataUrl: string;
  bytes: number;
  model: string;
  label: string;
  vendor: ImageVendor;
  ms: number;
}

/**
 * House style for camp illustrations: the documents are read on phones by
 * volunteers, so the picture has to survive being 300 px wide — flat shapes,
 * few colours, no text (models spell Portuguese badly and the sanitizer can't
 * fix a typo baked into a JPEG).
 */
const STYLE =
  "Ilustração vetorial chapada (flat vector), formas grandes e simples, contornos limpos, sem texto nem letras, sem marca d'água, sem sombras realistas, sem gradientes complexos. Paleta: verde pinho #1f6b52, verde sálvia #cfe0d5, areia #f7f1e3, laranja #e8833a, amarelo sol #f4c430. Fundo claro e limpo. Tema: acampamento infantil cristão ao ar livre, acolhedor e alegre, apropriado para crianças.";

function prompt(description: string, style: boolean): string {
  return style ? `${description.trim()}\n\n${STYLE}` : description.trim();
}

async function callImagesApi(model: ImageModel, description: string, shape: ImageShape, style: boolean, signal: AbortSignal): Promise<{ b64: string; type: string } | null> {
  const res = await fetch(`${config.ai.baseUrl}/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.ai.apiKey}` },
    body: JSON.stringify({ model: model.id, prompt: prompt(description, style), size: IMAGE_SIZES[shape], n: 1 }),
    signal,
  });
  if (!res.ok) {
    console.error("AI image error", model.id, res.status, (await res.text().catch(() => "")).slice(0, 300));
    return null;
  }
  const data = (await res.json().catch(() => null)) as { data?: { b64_json?: string; url?: string }[]; output_format?: string } | null;
  const first = data?.data?.[0];
  if (first?.b64_json) return { b64: first.b64_json, type: sniffType(first.b64_json, "image/png") };
  // some backends answer with a url instead of the bytes
  if (first?.url) {
    const img = await fetch(first.url, { signal }).catch(() => null);
    if (!img?.ok) return null;
    const buf = new Uint8Array(await img.arrayBuffer());
    return { b64: Buffer.from(buf).toString("base64"), type: img.headers.get("content-type") ?? "image/png" };
  }
  console.error("AI image: no image in response", model.id, JSON.stringify(data).slice(0, 200));
  return null;
}

async function callChatApi(model: ImageModel, description: string, shape: ImageShape, style: boolean, signal: AbortSignal): Promise<{ b64: string; type: string } | null> {
  const ratio = shape === "wide" ? "paisagem 3:2" : shape === "tall" ? "retrato 2:3" : "quadrada 1:1";
  const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.ai.apiKey}` },
    body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: `Gere uma imagem ${ratio}.\n\n${prompt(description, style)}` }] }),
    signal,
  });
  if (!res.ok) {
    console.error("AI image error", model.id, res.status, (await res.text().catch(() => "")).slice(0, 300));
    return null;
  }
  const data = (await res.json().catch(() => null)) as
    | { choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[] }
    | null;
  const url = data?.choices?.[0]?.message?.images?.[0]?.image_url?.url ?? "";
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/is.exec(url);
  if (!m) {
    console.error("AI image: no data url in chat response", model.id, JSON.stringify(data).slice(0, 200));
    return null;
  }
  return { b64: m[2], type: sniffType(m[2], m[1]) };
}

/**
 * Renders one picture. Tries the requested model, then the remaining ones in
 * order, so a model on cooldown doesn't break the feature. Returns null when
 * every candidate failed.
 */
export async function generateImage(input: { description: string; shape?: ImageShape; model?: string; style?: boolean }, signal?: AbortSignal): Promise<GeneratedImage | null> {
  const shape = input.shape ?? "wide";
  const style = input.style !== false;
  const first = IMAGE_MODELS.find((m) => m.id === input.model);
  const order = first ? [first, ...IMAGE_MODELS.filter((m) => m !== first)] : IMAGE_MODELS;
  for (const model of order) {
    const started = Date.now();
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const out = model.api === "images"
        ? await callImagesApi(model, input.description, shape, style, ctrl.signal)
        : await callChatApi(model, input.description, shape, style, ctrl.signal);
      if (out) {
        const ms = Date.now() - started;
        const bytes = Math.round((out.b64.length * 3) / 4);
        console.log(`AI image ${model.id} ${shape} → ${(bytes / 1024).toFixed(0)} kB in ${ms}ms`);
        return { dataUrl: `data:${out.type};base64,${out.b64}`, bytes, model: model.id, label: model.label, vendor: model.vendor, ms };
      }
    } catch (err) {
      if (signal?.aborted) return null;
      console.error("AI image failed", model.id, (err as Error)?.name === "AbortError" ? "timeout" : err);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  return null;
}
