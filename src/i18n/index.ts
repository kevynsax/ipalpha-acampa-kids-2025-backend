import { findByPhone } from "../models/users";
import { DEFAULT_LOCALE, resolveLocale, type Locale } from "./locales";

export { DEFAULT_LOCALE, LOCALES, format, resolveLocale, type Locale } from "./locales";
export { sms, smsPrefix, appLink, parentFieldLabel, type SmsKey } from "./sms";

/** Locale stored on the user who owns this phone — falls back to Portuguese. */
export async function localeForPhone(phone: string | null | undefined): Promise<Locale> {
  if (!phone) return DEFAULT_LOCALE;
  const user = await findByPhone(phone);
  return resolveLocale(user?.locale);
}
