import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import "./globals.css";
import "./login/login.css";
import "./account-state.css";
import "./theme.css";
import "./planner-ai.css";

/**
 * Inter 由 next/font 在构建时下载并随网站一起托管。
 * 运行时浏览器不会连接 fonts.googleapis.com：
 * - 访客的 IP 地址不会发给 Google（德国的 GDPR 风险）
 * - 中国大陆用户也能正常加载
 * 不指定 weight 时加载 Inter 的可变字体，所有字重都可用。
 * latin-ext 子集包含德语的 ä ö ü ß 和其他欧洲语言字符。
 * 中文使用系统字体（见 theme.css 里的 --font-cjk），不在这里加载。
 */
const inter = Inter({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-inter",
});

/** 应用内部的语言代码 → HTML lang 属性（BCP 47）。 */
const HTML_LANG: Record<string, string> = {
  en: "en",
  de: "de",
  zh: "zh-CN",
};

export const metadata: Metadata = {
  title: "AIASK — Make your next move",
  description: "A proactive AI team to help you capture ideas, plan your days, and follow through on what matters.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#7364ed",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // 跟随 next-intl 当前的语言，浏览器才会选对中文字形、为德语正确断行。
  const locale = await getLocale();
  const lang = HTML_LANG[locale] ?? locale;

  return (
    <html lang={lang} className={inter.variable} data-scroll-behavior="smooth">
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
