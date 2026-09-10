import { config } from "../config";
import { toComtelePhone } from "../utils";

/** Comtele is active only when an API key is configured; otherwise we run in mock mode. */
export function comteleEnabled(): boolean {
  return config.comtele.apiKey.length > 0;
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

    if (res.ok && data?.Success) return { ok: true };
    return { ok: false, message: data?.Message ?? `Comtele HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Comtele request failed" };
  }
}
