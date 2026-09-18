import { config } from "../config";

/** SendGrid HTTP is active when an API key and a from-address are set; otherwise we log. */
export function mailEnabled(): boolean {
  return config.mail.apiKey.length > 0 && config.mail.from.length > 0;
}

/**
 * Sends one HTML email via SendGrid's REST API.
 * Empty `to` is a no-op. Without a key it is printed (same voice as the SMS mock).
 */
export async function sendMail(to: string, subject: string, html: string, text?: string): Promise<{ ok: boolean; mocked?: boolean; message?: string }> {
  const address = to.trim().toLowerCase();
  if (!address) return { ok: false, message: "no-address" };
  if (!mailEnabled()) {
    console.log(`\n✉️  [NOTIFY · DEV MOCK] ${address} — ${subject}\n`);
    return { ok: true, mocked: true };
  }
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.mail.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: address }] }],
        from: { email: config.mail.from, name: config.mail.fromName || undefined },
        subject,
        content: [
          ...(text ? [{ type: "text/plain", value: text }] : []),
          { type: "text/html", value: html },
        ],
      }),
    });
    if (res.ok || res.status === 202) return { ok: true };
    const body = await res.text().catch(() => "");
    const message = body || `SendGrid HTTP ${res.status}`;
    console.error("[mail] send failed:", message);
    return { ok: false, message };
  } catch (err) {
    const message = err instanceof Error ? err.message : "mail failed";
    console.error("[mail] send failed:", message);
    return { ok: false, message };
  }
}
