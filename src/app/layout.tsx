import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { defaultLocale } from "../i18n/config";
import "./globals.css";
import "./login/login.css";
import "./account-state.css";

export const metadata: Metadata = {
  title: "AIASK — Make your next move",
  description: "A proactive AI team to help you capture ideas, plan your days, and follow through on what matters.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang={defaultLocale}>
      <body><NextIntlClientProvider>{children}</NextIntlClientProvider></body>
    </html>
  );
}
