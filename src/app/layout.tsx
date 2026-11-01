import type { Metadata } from "next";
import { getLocale } from "next-intl/server";
import LocaleProvider from "../i18n/LocaleProvider";
import { resolveLocale } from "../i18n/config";
import "./globals.css";
import "./login/login.css";
import "./account-state.css";

export const metadata: Metadata = {
  title: "AIASK — Make your next move",
  description: "A proactive AI team to help you capture ideas, plan your days, and follow through on what matters.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = resolveLocale(await getLocale());
  return <html lang={locale}><body><LocaleProvider initialLocale={locale}>{children}</LocaleProvider></body></html>;
}
