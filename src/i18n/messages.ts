import en from "../../messages/en.json";
import zhCN from "../../messages/zh-CN.json";
import type { AppLocale } from "./config";

// Only interface messages belong here. Never add user records or AI responses.
export const messagesByLocale = {
  en,
  "zh-CN": zhCN,
} satisfies Record<AppLocale, typeof en>;
