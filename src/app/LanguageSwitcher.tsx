"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useChangeLocale } from "../i18n/LocaleProvider";
import type { AppLocale } from "../i18n/config";
import "./language-switcher.css";

export default function LanguageSwitcher() {
  const locale = useLocale();
  const t = useTranslations("languageSwitcher");
  const changeLocale = useChangeLocale();
  const [saveFailed, setSaveFailed] = useState(false);

  function selectLocale(nextLocale: AppLocale) {
    setSaveFailed(!changeLocale(nextLocale));
  }

  return <div className="language-switcher-wrap">
    <div className="language-switcher" role="group" aria-label={t("label")}>
      <button type="button" lang="en" aria-label={t("english")} aria-pressed={locale === "en"} onClick={() => selectLocale("en")}>EN</button>
      <span aria-hidden="true">/</span>
      <button type="button" lang="zh-CN" aria-label={t("chinese")} aria-pressed={locale === "zh-CN"} onClick={() => selectLocale("zh-CN")}>中文</button>
    </div>
    {saveFailed && <p className="language-switcher-error" role="alert">{t("saveFailed")}</p>}
  </div>;
}
