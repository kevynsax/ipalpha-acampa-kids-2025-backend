import { config } from "../config";
import { recordSms } from "../models/smsUsage";
import { getSettings } from "../models/settings";
import { toComtelePhone } from "../utils";

/** Comtele is active only when an API key is configured; otherwise we run in mock mode. */
export function comteleEnabled(): boolean {
  return config.comtele.apiKey.length > 0;
}

/** Who a text is meant for — decides which redirect number (Settings → Testes) catches it. */
export type SmsAudience = "staff" | "parent";

/**
 * The number a text for `audience` must actually go to: the person's own
 * phone, or — while the SMS redirect (Settings → Testes) is on — the admin's
 * test phone for that audience. `null` = redirect on but no test phone for
 * this audience: drop the text.
 */
export async function resolveSmsTarget(phoneE164: string, audience: SmsAudience): Promise<{ phone: string; redirected: boolean } | null> {
  const { smsRedirect } = await getSettings();
  if (!smsRedirect.enabled) return { phone: phoneE164, redirected: false };
  const to = audience === "staff" ? smsRedirect.staffPhone : smsRedirect.parentPhone;
  return to ? { phone: to, redirected: true } : null;
}

/**
 * Sends a plain SMS through Comtele.
 * POST https://sms.comtele.com.br/api/v2/send
 * Docs: https://docs.comtele.com.br
 *
 * We generate the OTP code ourselves (so the server knows it and can log /
 * verify it) instead of using Comtele's token manager, which never returns
 * the code it generated.
 */
export async function comteleSendSms(
  phoneE164: string,
  content: string,
): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(`${config.comtele.baseUrl}/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "auth-key": config.comtele.apiKey,
      },
      body: JSON.stringify({
        Sender: config.comtele.prefix,
        Receivers: toComtelePhone(phoneE164),
        Content: content,
      }),
    });

    const data = (await res.json().catch(() => null)) as
      | { Success?: boolean; Message?: string }
      | null;

    if (res.ok && data?.Success) {
      // every real send is billed ≈ R$ 0,095 — the counter on the "Sobre" page
      void recordSms({ at: new Date(), phone: phoneE164, chars: content.length });
      return { ok: true };
    }
    return { ok: false, message: data?.Message ?? `Comtele HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Comtele request failed" };
  }
}
