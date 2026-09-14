import { config } from "../config";

export interface FaceEmbedding {
  embedding: number[];
  detScore: number;
  bbox: [number, number, number, number];
}

interface EmbedResponse {
  model: string;
  provider: string;
  width: number;
  height: number;
  faces: FaceEmbedding[];
}

const TIMEOUT_MS = 90_000;

export function faceRecognitionEnabled(): boolean {
  return !!config.face.serviceUrl;
}

/** Sends image bytes only to the private face service. It never stores them. */
export async function extractFaceEmbeddings(data: Uint8Array, type: string, name = "photo.jpg"): Promise<EmbedResponse> {
  if (!faceRecognitionEnabled()) throw new Error("FACE_SERVICE_DISABLED");
  const form = new FormData();
  form.append("file", new File([data as BlobPart], name, { type }));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${config.face.serviceUrl}/embed`, { method: "POST", body: form, signal: ctrl.signal });
    if (!res.ok) throw new Error(`FACE_SERVICE_${res.status}`);
    const result = (await res.json()) as EmbedResponse;
    if (!Array.isArray(result.faces)) throw new Error("FACE_SERVICE_RESPONSE");
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return -1;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa > 0 && bb > 0 ? dot / Math.sqrt(aa * bb) : -1;
}
