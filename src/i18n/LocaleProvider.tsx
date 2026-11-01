"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { isAppLocale, localeCookieMaxAge, localeCookieName, translationTimeZone, type AppLocale } from "./config";
import { messagesByLocale } from "./messages";

const LocaleContext = createContext<((locale: AppLocale) => boolean) | null>(null);

export function useChangeLocale() {
  const changeLocale = useContext(LocaleContext);
  if (!changeLocale) throw new Error("LanguageSwitcher requires LocaleProvider.");
  return changeLocale;
}

export default function LocaleProvider({ initialLocale, children }: { initialLocale: AppLocale; children: ReactNode }) {
  const [locale, setLocale] = useState(initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  function changeLocale(nextLocale: AppLocale) {
    if (!isAppLocale(nextLocale)) return false;
    try {
      const secure = window.location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${localeCookieName}=${nextLocale}; Path=/; Max-Age=${localeCookieMaxAge}; SameSite=Lax${secure}`;
      const saved = document.cookie.split(";").some(cookie => cookie.trim() === `${localeCookieName}=${nextLocale}`);
      if (!saved) return false;
    } catch {
      return false;
    }
    // No navigation, refresh, keyed subtree, or business-data writes: drafts stay mounted.
    setLocale(nextLocale);
    return true;
  }

  return <LocaleContext.Provider value={changeLocale}>
    <NextIntlClientProvider locale={locale} messages={messagesByLocale[locale]} timeZone={translationTimeZone}>
      {children}
    </NextIntlClientProvider>
  </LocaleContext.Provider>;
}
