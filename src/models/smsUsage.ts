import { getDb } from "../db";

const COLLECTION = "sms_usage";

/** what one text costs on Comtele, in reais — ≈ 9,5 centavos per SMS sent */
export const SMS_COST_BRL = 0.095;

export interface SmsUsageEntry {
  at: Date;
  /** E.164 phone the text went to */
  phone: string;
  /** message length — Comtele bills long texts per 160-char segment */
  chars: number;
}

export interface SmsUsageTotal {
  sent: number;
  /** sent × SMS_COST_BRL */
  costBrl: number;
  lastAt: string | null;
}

export async function recordSms(entry: SmsUsageEntry): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).insertOne(entry).catch((e) => console.error("sms usage: insert failed", e));
}

/** Totals for the settings "Sobre" page: how many texts went out and what they cost. */
export async function smsUsageTotal(): Promise<SmsUsageTotal> {
  const db = await getDb();
  const rows = (await db
    .collection(COLLECTION)
    .aggregate([{ $group: { _id: null, sent: { $sum: 1 }, lastAt: { $max: "$at" } } }])
    .toArray()) as { sent: number; lastAt: Date | null }[];
  const r = rows[0];
  return { sent: r?.sent ?? 0, costBrl: (r?.sent ?? 0) * SMS_COST_BRL, lastAt: r?.lastAt ? r.lastAt.toISOString() : null };
}

export async function ensureSmsUsageIndex(): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).createIndex({ at: -1 });
}
