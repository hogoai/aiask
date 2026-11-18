export const defaultLocale = "en";
export type AppLocale = typeof defaultLocale;
// Translation-layer default only; existing Calendar/Reminder date logic is unchanged.
export const translationTimeZone = "UTC";

export function isAppLocale(value: unknown): value is AppLocale {
  return value === defaultLocale;
}
