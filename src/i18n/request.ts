import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { localeCookieName, resolveLocale, translationTimeZone } from "./config";
import { messagesByLocale } from "./messages";

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(localeCookieName)?.value);
  return { locale, messages: messagesByLocale[locale], timeZone: translationTimeZone };
});
