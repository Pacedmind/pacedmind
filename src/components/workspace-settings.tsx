"use client";

import { useState, type ReactNode } from "react";
import {
  acceptInviteAction, addWorkspaceDomainAction, confirmWorkEmailAction, createWorkspaceAction, renameWorkspaceAction, createWorkspaceAreaAction, deleteWebhookAction, dismissJoinPromptAction, inviteMemberAction,
  joinWorkspaceAction, removeMemberAction, removeWorkspaceDomainAction, revokeInviteAction, setMemberRoleAction, setWebhookAction,
  removeWorkEmailAction, requestWorkEmailAction, shareAreaAction,
} from "@/app/actions";
import {
  WEBHOOK_EVENTS, manages, type Area, type JoinableWorkspace, type MemberWebhook, type WebhookEvent, type WorkspaceDetails, type WorkspaceRole,
} from "@/lib/types";
import type { WorkEmailState } from "@/server/work-email";
import { useTranslation } from "./language";
import { AreaMark } from "./icons";
import { PersonMark } from "./people";
import { Button, Menu, Segmented, Switch, cx, toast, useAction } from "./ui";

const input = "h-7 min-w-0 flex-1 rounded-md border border-line2 bg-input px-2 text-[12.5px] text-fg2 outline-none focus:border-line-strong";

const ROLE_LABEL: Record<WorkspaceRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const EVENT_LABEL: Record<WebhookEvent, string> = {
  "task.assigned": "A task is assigned to me",
  "task.status_changed": "A task of mine changes status",
  "task.created": "A task is created",
};

function Box({ title, action, note, children }: { title?: string; action?: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      {(title || action) && <div className="flex min-h-6 items-center gap-2">
        <h3 className="flex-1 text-[13px] font-semibold text-fg2">{title}</h3>
        {action}
      </div>}
      <div className="overflow-hidden rounded-lg border border-line2">{children}</div>
      {note && <p className="text-[12px] leading-relaxed text-mut2">{note}</p>}
    </section>
  );
}

function Line({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("flex min-h-11 items-center gap-2.5 border-b border-line px-3.5 py-2 last:border-b-0 max-sm:flex-wrap", className)}>{children}</div>;
}

function useCopy() {
  const tx = useTranslation();
  return (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(() => toast(tx("{0} copied", [what])), () => toast(tx("Couldn't copy"), "error"));
}

export function WorkEmailSettings({ state, invitedEmail }: { state: WorkEmailState; invitedEmail?: string }) {
  const tx = useTranslation();
  const { run, pending } = useAction();
  const [email, setEmail] = useState(state.pendingEmail ?? "");
  const [code, setCode] = useState("");
  const target = invitedEmail ?? email;
  const pendingEmail = !invitedEmail || state.pendingEmail === invitedEmail ? state.pendingEmail : null;

  return <Box title={tx("Work email")} note={tx("Use a confirmed work email for teams and invitations while signing in to this account as usual.")}>
    {state.email && !invitedEmail && <Line>
      <span className="min-w-0 flex-1 break-all text-[13px] text-fg">{state.email}</span>
      <span className="text-[12px] text-mut2">{tx("Confirmed")}</span>
      <Button size="sm" disabled={pending} onClick={() => {
        if (confirm(tx("Remove {0} as your work email?", [state.email]))) run(removeWorkEmailAction);
      }}>{tx("Remove")}</Button>
    </Line>}
    <form className="flex flex-wrap items-center gap-2 px-3.5 py-2.5" onSubmit={(event) => {
      event.preventDefault();
      run(async () => {
        const result = await requestWorkEmailAction(target);
        if (result.ok) setCode("");
        return result;
      });
    }}>
      <input className={input} type="email" autoComplete="email" aria-label={tx("Work email")} placeholder={tx("Work email")}
        maxLength={254} value={target} readOnly={!!invitedEmail} onChange={(event) => setEmail(event.target.value)} required />
      <Button size="sm" type="submit" disabled={pending || !target.trim()}>{tx("Send verification code")}</Button>
    </form>
    {pendingEmail && <form className="border-t border-line px-3.5 py-2.5" onSubmit={(event) => {
      event.preventDefault();
      run(async () => {
        const result = await confirmWorkEmailAction(pendingEmail, code);
        if (result.ok) {
          setCode("");
          setEmail("");
        }
        return result;
      });
    }}>
      <p className="mb-2 break-all text-[12px] text-mut">{tx("Enter the code sent to {0}.", [pendingEmail])}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input className={input} autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false}
          placeholder={tx("Verification code")} aria-label={tx("Verification code")} maxLength={20}
          value={code} onChange={(event) => setCode(event.target.value)} required />
        <Button variant="primary" size="sm" type="submit" disabled={pending || !code.trim()}>{tx("Confirm work email")}</Button>
      </div>
    </form>}
  </Box>;
}

/** Settings → Team workspaces: the teams you're in, their people, invitations, domains, shared areas and your webhooks. */
export function WorkspaceSettings({ cloud, workspaces, me, areas, hooks, joinable, emailDomain, workEmail }: {
  cloud: boolean; workspaces: WorkspaceDetails[]; me: string | null; areas: Area[]; hooks: MemberWebhook[]; joinable: JoinableWorkspace[];
  emailDomain: string | null; workEmail: WorkEmailState | null;
}) {
  const ownAreas = areas.filter((a) => !a.workspaceId);
  const tx = useTranslation();
  const { run, pending } = useAction();
  const [name, setName] = useState("");
  if (!cloud) {
    return <Box><p className="px-3.5 py-3 text-[12.5px] leading-relaxed text-mut">
      {tx("Team workspaces need PacedMind Cloud: sign in to share areas with your team and assign tasks to each other.")}
    </p></Box>;
  }
  return <div className="flex flex-col gap-7">
    {workEmail && <WorkEmailSettings state={workEmail} />}
    {joinable.length > 0 && <Box title={tx("Join your team")}>
      {joinable.map((w) => <Line key={w.id}>
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{w.name}</span>
        <span className="text-[12px] text-mut2">{tx("for {0} addresses", [`@${w.domain}`])}</span>
        <Button size="sm" variant="primary" disabled={pending} onClick={() => run(() => joinWorkspaceAction(w.id))}>{tx("Join")}</Button>
      </Line>)}
    </Box>}
    {workspaces.map((w) => <Workspace key={w.id} workspace={w} me={me} ownAreas={ownAreas} shared={areas.filter((a) => a.workspaceId === w.id)} hooks={hooks.filter((h) => h.workspaceId === w.id)} emailDomain={emailDomain} />)}
    <Box title={tx("New team workspace")} note={tx("You own it, and your PacedMind Cloud plan covers everyone in it. Invite people, then share an area or create one for the team.")}>
      <form className="flex items-center gap-2 px-3.5 py-2.5" onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const r = await createWorkspaceAction(name);
          if (r.ok) setName("");
          return r;
        });
      }}>
        <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder={tx("Team name, like your company's")} aria-label={tx("Team name")} maxLength={80} />
        <Button size="sm" type="submit" disabled={pending || !name.trim()}>{tx("Create")}</Button>
      </form>
    </Box>
  </div>;
}

function Workspace({ workspace: w, me, ownAreas, shared, hooks, emailDomain }: {
  workspace: WorkspaceDetails; me: string | null; ownAreas: Area[]; shared: Area[]; hooks: MemberWebhook[]; emailDomain: string | null;
}) {
  const tx = useTranslation();
  const { run, pending } = useAction();
  const copy = useCopy();
  const admin = manages(w.role);
  const owner = w.role === "owner";
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [domain, setDomain] = useState("");
  const [areaName, setAreaName] = useState("");
  const alone = w.members.length === 1;
  return <div className="flex flex-col gap-5">
    <Box title={`${w.name} · ${tx(ROLE_LABEL[w.role])}`} action={<span className="flex items-center gap-2">
      {admin && <Button size="sm" disabled={pending} onClick={() => {
        const name = prompt(tx("New name for {0}", [w.name]), w.name)?.trim();
        if (name && name !== w.name) run(() => renameWorkspaceAction(w.id, name));
      }}>{tx("Rename")}</Button>}
      <Button size="sm" disabled={pending} onClick={() => confirm(alone
        ? tx("Leave {0}? You're its last member: the workspace and everything shared in it are deleted.", [w.name])
        : tx("Leave {0}? You lose access to its shared areas at once.", [w.name])) && run(() => removeMemberAction(w.id, me ?? ""))}>
        {tx("Leave")}
      </Button>
    </span>}>
      {w.members.map((m) => <Line key={m.userId}>
        <PersonMark userId={m.userId} name={m.name} email={m.email} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] text-fg">{m.name}{m.userId === me ? ` · ${tx("you")}` : ""}</p>
          <p className="truncate text-[12px] text-mut2">{m.email}</p>
        </div>
        {admin && m.userId !== me && (owner || m.role !== "owner") ? <Menu align="right" width={160}
          trigger={<button type="button" disabled={pending} aria-label={tx("Change {0}'s role", [m.name])} className="h-7 rounded-md border border-ctl px-2 text-[12px] text-fg2 hover:bg-hover">{tx(ROLE_LABEL[m.role])}</button>}
          items={(owner ? ["owner", "admin", "member"] as const : ["admin", "member"] as const).map((r) => ({ value: r as WorkspaceRole, label: tx(ROLE_LABEL[r]) }))}
          onSelect={(r) => run(() => setMemberRoleAction(w.id, m.userId, r))} />
          : <span className="text-[12px] text-mut">{tx(ROLE_LABEL[m.role])}</span>}
        {admin && m.userId !== me && (owner || m.role !== "owner") && <Button size="sm" disabled={pending}
          onClick={() => confirm(tx("Remove {0} from {1}? Their assignments there are cleared; what they wrote stays.", [m.name, w.name])) && run(() => removeMemberAction(w.id, m.userId))}>
          {tx("Remove")}
        </Button>}
      </Line>)}
    </Box>

    {admin && <Box title={tx("Invite people")} note={tx("PacedMind sends no email: copy the link and send it yourself. Only an account with that confirmed email address can use it, within 14 days.")}>
      <form className="flex flex-wrap items-center gap-2 px-3.5 py-2.5" onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const r = await inviteMemberAction(w.id, email, role);
          if (r.ok && r.link) {
            setLink({ email: email.trim().toLowerCase(), url: r.link });
            setEmail("");
          }
          return r;
        });
      }}>
        <input className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={tx("Their email address")} aria-label={tx("Email address to invite")} />
        <Segmented value={role} onChange={setRole} options={[{ value: "member", label: tx("Member") }, { value: "admin", label: tx("Admin") }]} />
        <Button size="sm" type="submit" disabled={pending || !email.trim()}>{tx("Invite")}</Button>
      </form>
      {link && <Line className="bg-sel">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg2" title={link.url}>{link.url}</span>
        <Button size="sm" variant="primary" onClick={() => copy(link.url, tx("Invitation link"))}>{tx("Copy link")}</Button>
      </Line>}
      {w.invites.map((i) => <Line key={i.id}>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg2">{i.email}</span>
        <span className="text-[12px] text-mut2">{tx(ROLE_LABEL[i.role])} · {tx("until {0}", [i.expiresAt.slice(0, 10)])}</span>
        <Button size="sm" disabled={pending} onClick={() => run(() => revokeInviteAction(i.id))}>{tx("Withdraw")}</Button>
      </Line>)}
    </Box>}

    <Box title={tx("Domains")} note={tx("Everyone whose confirmed email address is at one of these domains can join as a member without an invitation. Only your own address's domain, never a public mail provider's.")}>
      {w.domains.map((d) => <Line key={d}>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg2">@{d}</span>
        {admin && <Button size="sm" disabled={pending} onClick={() => run(() => removeWorkspaceDomainAction(w.id, d))}>{tx("Remove")}</Button>}
      </Line>)}
      {!w.domains.length && !admin && <Line><span className="text-[12.5px] text-mut2">{tx("None")}</span></Line>}
      {admin && <form className="flex items-center gap-2 px-3.5 py-2.5" onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const r = await addWorkspaceDomainAction(w.id, domain || emailDomain || "");
          if (r.ok) setDomain("");
          return r;
        });
      }}>
        <input className={input} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder={emailDomain ?? "example.com"} aria-label={tx("Domain")} />
        <Button size="sm" type="submit" disabled={pending || !(domain.trim() || emailDomain)}>{tx("Add domain")}</Button>
      </form>}
    </Box>

    <Box title={tx("Shared areas")} note={tx("Everyone in the workspace sees these areas and their work. Moving an area to the team is permanent.")}>
      {shared.map((a) => <Line key={a.id}>
        <AreaMark area={a} dot={7} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{a.name}</span>
        <span className="font-mono text-[11.5px] text-mut2">{a.key}</span>
      </Line>)}
      {!shared.length && <Line><span className="text-[12.5px] text-mut2">{tx("No shared areas yet")}</span></Line>}
      {admin && <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
        <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const r = await createWorkspaceAreaAction(w.id, areaName);
            if (r.ok) setAreaName("");
            return r;
          });
        }}>
          <input className={input} value={areaName} onChange={(e) => setAreaName(e.target.value)} placeholder={tx("New area for the team")} aria-label={tx("New shared area")} maxLength={80} />
          <Button size="sm" type="submit" disabled={pending || !areaName.trim()}>{tx("Create area")}</Button>
        </form>
        {ownAreas.length > 0 && <Menu align="right" width={240}
          trigger={<Button size="sm" disabled={pending}>{tx("Move an area to the team")}</Button>}
          items={ownAreas.map((a) => ({ value: a.id, label: a.name, icon: <AreaMark area={a} dot={7} /> }))}
          onSelect={(id) => {
            const a = ownAreas.find((x) => x.id === id);
            if (a && confirm(tx("Move {0} to {1}? Everyone on the team will see its projects, tasks, reports and attachments. Links to work outside the area are removed. This move is permanent.", [a.name, w.name]))) {
              run(() => shareAreaAction(a.id, w.id));
            }
          }} />}
      </div>}
    </Box>

    <Webhooks workspaceId={w.id} hooks={hooks} />
  </div>;
}

function Webhooks({ workspaceId, hooks }: { workspaceId: string; hooks: MemberWebhook[] }) {
  const tx = useTranslation();
  const { run, pending } = useAction();
  const copy = useCopy();
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>(["task.assigned", "task.status_changed"]);
  const [secret, setSecret] = useState<string | null>(null);
  const toggle = (e: WebhookEvent) => setEvents((list) => (list.includes(e) ? list.filter((x) => x !== e) : [...list, e]));
  return <Box title={tx("My webhooks")} note={tx("PacedMind posts JSON to your address when these happen: the task's key, title, status, dates and people, never its description. Each call carries X-PacedMind-Signature: sha256= and the HMAC-SHA256 of the body with the webhook's secret.")}>
    {hooks.map((h) => <Line key={h.id}>
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-[11.5px] text-fg2" title={h.url}>{h.url}</p>
        <p className="truncate text-[12px] text-mut2">{h.events.map((e) => tx(EVENT_LABEL[e])).join(" · ")}</p>
      </div>
      <Switch on={h.enabled} label={tx("Webhook on")} onChange={(on) => run(() => setWebhookAction({ workspaceId, url: h.url, events: h.events, id: h.id, enabled: on }))} />
      <Button size="sm" disabled={pending} onClick={() => confirm(tx("Delete this webhook?")) && run(() => deleteWebhookAction(h.id))}>{tx("Delete")}</Button>
    </Line>)}
    {secret && <Line className="bg-sel">
      <div className="min-w-0 flex-1">
        <p className="text-[12px] text-fg2">{tx("The webhook's secret, shown only now:")}</p>
        <p className="truncate font-mono text-[11.5px] text-fg2">{secret}</p>
      </div>
      <Button size="sm" variant="primary" onClick={() => copy(secret, tx("Secret"))}>{tx("Copy secret")}</Button>
    </Line>}
    <form className="flex flex-col gap-2 px-3.5 py-2.5" onSubmit={(e) => {
      e.preventDefault();
      run(async () => {
        const r = await setWebhookAction({ workspaceId, url, events });
        if (r.ok) {
          setSecret(r.secret ?? null);
          setUrl("");
        }
        return r;
      });
    }}>
      <div className="flex items-center gap-2">
        <input className={input} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={"https://"} aria-label={tx("Webhook address")} />
        <Button size="sm" type="submit" disabled={pending || !url.trim() || !events.length}>{tx("Add webhook")}</Button>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {WEBHOOK_EVENTS.map((e) => <label key={e} className="flex items-center gap-1.5 text-[12px] text-fg3">
          <input type="checkbox" checked={events.includes(e)} onChange={() => toggle(e)} />{tx(EVENT_LABEL[e])}
        </label>)}
      </div>
    </form>
  </Box>;
}

/** Under the header, for an account whose confirmed email domain lets it join a team workspace. */
export function JoinPrompt({ workspaces }: { workspaces: JoinableWorkspace[] }) {
  const tx = useTranslation();
  const { run, pending } = useAction();
  const first = workspaces[0];
  return <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-panel px-4 py-2 text-[12px] text-fg3">
    <span>{tx("Your team works in PacedMind: join {0} to see its shared areas.", [first.name])}</span>
    <span className="flex shrink-0 items-center gap-2">
      <Button size="sm" variant="primary" disabled={pending} onClick={() => run(() => joinWorkspaceAction(first.id))}>{tx("Join {0}", [first.name])}</Button>
      <Button size="sm" disabled={pending} onClick={() => run(() => dismissJoinPromptAction())}>{tx("Not now")}</Button>
    </span>
  </div>;
}

/** The /join page's button: accepts the invitation with the signed-in account, then opens Today. */
export function AcceptInvite({ token }: { token: string }) {
  const tx = useTranslation();
  const { run, pending } = useAction();
  return <Button variant="primary" disabled={pending} onClick={() => run(() => acceptInviteAction(token))} className="self-start">{tx("Accept invitation")}</Button>;
}
