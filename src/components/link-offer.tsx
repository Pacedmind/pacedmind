"use client";
import { useTranslation } from "@/components/language";

import { useState } from "react";
import { dismissLinkOfferAction, linkFoundAction } from "@/app/actions";
import type { Area, FoundFolder } from "@/lib/types";
import { Icon } from "./icons";
import { ImportProjects } from "./import-projects";
import { Button, useAction } from "./ui";

export interface Linkable {
  kind: "project" | "area";
  id: string;
  name: string;
  folder: string;
  how: FoundFolder["how"];
}

const SHOWN = 4;

/**
 * Signed in on a computer, once the import was offered: the projects and area workspaces you have on your other
 * computers whose copy is here too, found for sure (by their pacedmind.md or their repository). Link gives each its
 * folder here in one go; Review opens the import to pick; Not now keeps the offer from coming back for these.
 */
export function LinkOffer({ items, areas }: { items: Linkable[]; areas: Area[] }) {
  const tx = useTranslation();
  const { run, pending } = useAction();
  const [open, setOpen] = useState(true);
  const [review, setReview] = useState(false);
  if (review) return <ImportProjects areas={areas} onClose={() => { setReview(false); setOpen(false); }} />;
  if (!open) return null;
  const projects = items.filter((i) => i.kind === "project").length;
  const spaces = items.length - projects;
  const what = [projects && tx("{0} project{1}", [projects, projects > 1 ? "s" : ""]), spaces && tx("{0} area workspace{1}", [spaces, spaces > 1 ? "s" : ""])]
    .filter(Boolean).join(tx(" and "));
  const link = () => {
    setOpen(false);
    run(() => linkFoundAction(items.map(({ kind, id, folder }) => ({ kind, id, folder }))));
  };
  const later = () => {
    setOpen(false);
    run(() => dismissLinkOfferAction(items.map((i) => `${i.id}>${i.folder}`)));
  };
  return (
    <div role="dialog" aria-labelledby="link-offer-title"
      className="fixed bottom-4 right-4 z-40 flex w-[380px] flex-col gap-2 rounded-xl border border-line bg-panel p-4 shadow-lg max-md:inset-x-3 max-md:w-auto">
      <p id="link-offer-title" className="text-[13px] font-semibold text-strong">{tx("Found on this computer")}</p>
      <p className="text-[12.5px] leading-relaxed text-fg3">
        {what} {" "}{tx("from your other computers")}{" "}{items.length > 1 ? "are" : "is"} {" "}{tx("here too. Linked,")}{" "}{items.length > 1 ? "their" : "its"} {tx("tasks run here as well.")}</p>
      <ul className="flex flex-col gap-1">
        {items.slice(0, SHOWN).map((i) => (
          <li key={`${i.kind}-${i.id}`} title={i.folder} className="flex min-w-0 items-center gap-2 text-[12.5px]">
            <Icon name={i.kind === "area" ? "folder" : "layers"} size={13} className="shrink-0 text-mut2" />
            <span className="shrink-0 text-fg2">{i.name}</span>
            <span className="min-w-0 truncate font-mono text-[11px] text-mut2">{i.folder}</span>
          </li>
        ))}
        {items.length > SHOWN && <li className="text-[12px] text-mut2">{tx("and")}{" "}{items.length - SHOWN} {" "}{tx("more")}</li>}
      </ul>
      <div className="mt-1 flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={pending} onClick={later}>{tx("Not now")}</Button>
        <Button size="sm" disabled={pending} onClick={() => setReview(true)}>{tx("Review")}</Button>
        <Button size="sm" variant="primary" disabled={pending} onClick={link}>{tx("Link")}</Button>
      </div>
    </div>
  );
}
