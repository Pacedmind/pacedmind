import "server-only";
import { cookies } from "next/headers";
import { createTranslator, languageOf, LANGUAGE_COOKIE } from "@/lib/i18n";

export async function getTranslation() {
  return createTranslator(languageOf((await cookies()).get(LANGUAGE_COOKIE)?.value));
}
