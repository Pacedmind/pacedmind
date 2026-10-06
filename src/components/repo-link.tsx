import { getTranslation } from "@/server/i18n";
import { repoLink } from "@/lib/types";
import { Icon } from "./icons";

/**
 * A project's or area's repository, as a link to its page (github.com/owner/name); nothing until a computer with its
 * folder saw which repository it is. In a narrow list header, the icon only. Used by server pages, so no client helpers.
 */
export async function RepoLink({ repo, className }: { repo: string | null | undefined; className?: string }) {
  const tx = await getTranslation();
  const link = repoLink(repo);
  if (!link) return null;
  return (
    <a href={link.url} target="_blank" rel="noreferrer" title={tx("Open {0}", [link.label])} aria-label={tx("Repository {0}", [link.label])}
      className={`inline-flex h-7 max-w-[260px] items-center gap-1.5 rounded-md border border-ctl px-2.5 text-[12.5px] text-fg2 hover:bg-hover ${className ?? ""}`}>
      <Icon name="external" size={13} className="shrink-0" /><span className="truncate @max-2xl:hidden">{link.label}</span>
    </a>
  );
}
