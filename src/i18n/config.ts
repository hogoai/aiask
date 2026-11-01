export const locales = ["en", "zh-CN"] as const;
export type AppLocale = typeof locales[number];

export const defaultLocale: AppLocale = "en";
export const localeCookieName = "aiask_locale";
export const localeCookieMaxAge = 60 * 60 * 24 * 365;
// Translation-layer default only; existing Calendar/Reminder date logic is unchanged.
export const translationTimeZone = "UTC";

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

export function resolveLocale(value: unknown): AppLocale {
  return isAppLocale(value) ? value : defaultLocale;
}
