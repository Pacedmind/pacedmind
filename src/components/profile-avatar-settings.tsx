"use client";

import { useRef, useState } from "react";
import { setProfileAvatarAction } from "@/app/actions";
import { PICTURE_FILE_TYPES, pictureFromFile } from "@/lib/picture-file";
import type { ProfileAvatarSource } from "@/lib/types";
import { useTranslation } from "./language";
import { PersonMark } from "./people";
import { Button, toast, useAction } from "./ui";

export interface ProfileAvatarView {
  userId: string;
  source: ProfileAvatarSource;
  version: string | null;
}

export function ProfileAvatarSettings({ userId, source, version, email }: ProfileAvatarView & { email: string | null }) {
  const tx = useTranslation();
  const { pending, run } = useAction();
  const [reading, setReading] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setReading(true);
    try {
      const png = await pictureFromFile(file, tx);
      run(() => setProfileAvatarAction("custom", png));
    } catch (error) {
      toast(error instanceof Error ? error.message : tx("That picture couldn't be read."), "error");
    } finally {
      if (input.current) input.current.value = "";
      setReading(false);
    }
  }

  const busy = pending || reading;
  const label = source === "custom" && version ? tx("Custom picture") : source === "google" && version ? tx("Google profile photo") : tx("Initials");
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <PersonMark userId={version ? userId : null} name="" email={email} version={version} size={36} />
      <span className="min-w-28 flex-1 text-[12.5px] text-fg3">{label}</span>
      <Button size="sm" disabled={busy} onClick={() => input.current?.click()}>
        {reading ? tx("Reading the picture…") : tx("Upload picture")}
      </Button>
      {source !== "google" && <Button size="sm" disabled={busy} onClick={() => run(() => setProfileAvatarAction("google"))}>{tx("Use Google photo")}</Button>}
      {source !== "initials" && <Button size="sm" disabled={busy} onClick={() => run(() => setProfileAvatarAction("initials"))}>{tx("Use initials")}</Button>}
      <input ref={input} type="file" accept={PICTURE_FILE_TYPES} hidden aria-label={tx("Picture file")} onChange={(event) => pick(event.target.files?.[0])} />
    </div>
  );
}
