import { getTranslation } from "@/server/i18n";
import { LanguageProvider } from "@/components/language";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { ThemeSync } from "@/components/theme";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin", "latin-ext"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin", "latin-ext"] });

export async function generateMetadata(): Promise<Metadata> {
  const tx = await getTranslation();
  return {
  title: "PacedMind",
  applicationName: "PacedMind",
  description: tx("Tasks, time blocks and agent sessions in one place."),
  referrer: "no-referrer",
  };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const tx = await getTranslation();
  // The Content Security Policy only runs scripts carrying this request's nonce (src/proxy.ts).
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang={tx.language} data-theme="dark" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <head><script id="pacedmind-theme" nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} /></head>
      <body className="h-full"><LanguageProvider language={tx.language}><ThemeSync />{children}</LanguageProvider></body>
    </html>
  );
}
