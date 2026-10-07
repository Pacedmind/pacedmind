import { execFileSync } from "node:child_process";
import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/site";

// Written to out/sitemap.xml at build time.
export const dynamic = "force-static";

/**
 * The date of the newest commit that `git log` finds with these arguments (paths are relative to
 * site/). Commit dates, not file times, because a fresh checkout stamps every file with the checkout
 * time; and never `new Date()`, which tells crawlers the page changes on every build until they stop
 * trusting the date. Without git the date is left out rather than guessed. A shallow clone (CI's
 * default) knows only its tip commit, so every date becomes that commit's: fetch the full history.
 */
function lastCommit(...args: string[]): Date | undefined {
  try {
    const iso = execFileSync("git", ["log", "-1", "--format=%cI", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const date = new Date(iso);
    return iso && !Number.isNaN(date.getTime()) ? date : undefined;
  } catch {
    return undefined;
  }
}

const newest = (...dates: (Date | undefined)[]) =>
  dates.filter((date) => date !== undefined).sort((a, b) => b.getTime() - a.getTime())[0];

/** This site's pages. The docs at /docs publish their own sitemap, and robots.txt lists both. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: absoluteUrl("/"),
      lastModified: newest(
        // The page's words, screens and metadata.
        lastCommit("--", "app/page.tsx", "app/layout.tsx", "lib/content.ts", "components", "screens"),
        // A price that changed, but not the date of a routine price check.
        lastCommit("-G", '"amount"', "--", "prices.json"),
      ),
      changeFrequency: "monthly",
      priority: 1,
    },
    // Connecting an agent: the home page's Connect section on a page of its own.
    {
      url: absoluteUrl("/connect"),
      lastModified: lastCommit("--", "app/connect", "components/connect.tsx", "lib/content.ts"),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    // The terms, privacy policy and refund policy, and the help pages.
    ...["/terms", "/privacy", "/refunds", "/delete-account", "/support"].map((path) => ({
      url: absoluteUrl(path),
      lastModified: lastCommit("--", `app${path}`, "components/legal.tsx"),
      changeFrequency: "yearly" as const,
      priority: 0.3,
    })),
  ];
}
