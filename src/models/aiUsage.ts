import { getDb } from "../db";

const COLLECTION = "ai_usage";

export interface AiUsageEntry {
  at: Date;
  vendor: string;
  model: string;
  /** "edit" (assistant panel), "suggest" (title/emoji), "image" (generated illustration), "camper_notes" (sorting a kid's observations) or "dedup_field" (background repeat clean-up) */
  kind: "edit" | "suggest" | "image" | "camper_notes" | "dedup_field";
  userId: string;
  promptTokens: number;
  completionTokens: number;
  ok: boolean;
}

export interface AiVendorUsage {
  vendor: string;
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  lastAt: string | null;
  models: { model: string; calls: number; promptTokens: number; completionTokens: number }[];
}

export async function recordAiUsage(entry: AiUsageEntry): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).insertOne(entry).catch((e) => console.error("ai usage: insert failed", e));
}

/** Totals per vendor (and per model inside it), most used first. */
export async function aiUsageByVendor(): Promise<AiVendorUsage[]> {
  const db = await getDb();
  const rows = (await db
    .collection(COLLECTION)
    .aggregate([
      {
        $group: {
          _id: { vendor: "$vendor", model: "$model" },
          calls: { $sum: 1 },
          errors: { $sum: { $cond: ["$ok", 0, 1] } },
          promptTokens: { $sum: "$promptTokens" },
          completionTokens: { $sum: "$completionTokens" },
          lastAt: { $max: "$at" },
        },
      },
    ])
    .toArray()) as { _id: { vendor: string; model: string }; calls: number; errors: number; promptTokens: number; completionTokens: number; lastAt: Date | null }[];

  const byVendor = new Map<string, AiVendorUsage>();
  for (const r of rows) {
    const v = byVendor.get(r._id.vendor) ?? { vendor: r._id.vendor, calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, lastAt: null, models: [] };
    v.calls += r.calls;
    v.errors += r.errors;
    v.promptTokens += r.promptTokens;
    v.completionTokens += r.completionTokens;
    const last = r.lastAt ? r.lastAt.toISOString() : null;
    if (last && (!v.lastAt || last > v.lastAt)) v.lastAt = last;
    v.models.push({ model: r._id.model, calls: r.calls, promptTokens: r.promptTokens, completionTokens: r.completionTokens });
    byVendor.set(r._id.vendor, v);
  }
  return [...byVendor.values()]
    .map((v) => ({ ...v, models: v.models.sort((a, b) => b.calls - a.calls) }))
    .sort((a, b) => b.calls - a.calls);
}
