import { getRequestConfig } from "next-intl/server";
import messages from "../../messages/en.json";
import { defaultLocale, translationTimeZone } from "./config";

export default getRequestConfig(async () => ({
  locale: defaultLocale,
  messages,
  timeZone: translationTimeZone,
}));
