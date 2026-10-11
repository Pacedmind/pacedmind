"use client";
import { useTranslation } from "@/components/language";
import { createTranslator, type Translator } from "@/lib/i18n";

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { parseLocal, type PlanStep } from "@/lib/dates";
import {
  AGENT_LABEL, ANSWERS_HEADING, OUTCOME_LABEL, isAnswers, VERDICT_LABEL, type AgentId, type Attachment, type DiffFileStatus, type Report,
  type ReportCriterion, type ReportDiff,
} from "@/lib/types";
import { Icon, StatusIcon, VerdictIcon } from "./icons";
import { InlineMarkdown, Markdown } from "./markdown";
import { Button, cx } from "./ui";

/* What an agent handed back: the report card body, its images and the full-size viewer. */

/** Compares "Done when" texts the way the server matches them. */
export const sameText = (a: string, b: string) => norm(a) === norm(b);
const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();

export const imageUrl = (a: Attachment) => `/api/attachments/${a.id}`;

export function criteriaCount(criteria: ReportCriterion[], tx: Translator = createTranslator("en")): string {
  const met = criteria.filter((c) => c.verdict === "met").length;
  return tx("{0} of {1} met", [met, criteria.length]);
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[12px] font-medium text-fg3">
        {title}
        {aside && <span className="font-normal text-mut2">{aside}</span>}
      </div>
      {children}
    </div>
  );
}

/** The plan an agent reported while it works (report_progress), with the steps it finished ticked off. */
export function SessionPlan({ plan }: { plan: { steps: PlanStep[]; at: string } }) {
  const tx = useTranslation();
  const done = plan.steps.filter((s) => s.done).length;
  return (
    <Section title={tx("Plan")} aside={tx("{0} of {1} done · {2}", [done, plan.steps.length, tx.date(parseLocal(plan.at), "HH:mm")])}>
      <div className="flex flex-col">
        {plan.steps.map((s, i) => (
          <div key={i} className="flex items-start gap-2.5 py-[3px]">
            <span className="mt-[2px] shrink-0"><StatusIcon status={s.done ? "done" : "todo"} /></span>
            <span className={cx("min-w-0 text-[12.5px] leading-[1.5]", s.done ? "text-mut2 line-through" : "text-fg2")}>{s.text}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

/** One "Done when" item with the agent's answer and note. */
export function CriterionRow({ c }: { c: ReportCriterion }) {
  const tx = useTranslation();
  return (
    <div className="flex items-start gap-2.5 py-[3px]">
      <span className="mt-[3px] shrink-0" title={c.verdict ? tx(VERDICT_LABEL[c.verdict]) : tx("Not answered")}>
        <VerdictIcon verdict={c.verdict ?? "unanswered"} />
      </span>
      <div className="min-w-0 flex-1">
        <div className={cx("text-[12.5px] leading-[1.5]", c.verdict === "met" ? "text-fg2" : "text-fg3")}>{c.text}</div>
        {(c.note || !c.verdict) && (
          <div className="text-[12px] leading-[1.5] text-mut2">{c.note ? <InlineMarkdown text={c.note} /> : tx("Not answered")}</div>
        )}
      </div>
    </div>
  );
}

/** What the user asked to change after reading a report, or their answers to its questions. */
export function ChangesNote({ report }: { report: Report }) {
  const tx = useTranslation();
  if (!report.changes) return null;
  const answers = isAnswers(report.changes);
  return (
    <div className="flex flex-col gap-1 border-l-2 border-line-strong pl-3 max-md:wrap-break-word">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-fg3">
        <Icon name="user" size={12} className="text-mut2" />
        {answers ? tx("You answered its questions") : tx("You asked for changes")}
        {report.changesAt && <span className="font-normal text-mut2">· {tx.date(parseLocal(report.changesAt), "d MMM HH:mm")}</span>}
      </div>
      <p className="whitespace-pre-wrap text-[12.5px] leading-[1.55] text-fg2">{answers ? report.changes.slice(ANSWERS_HEADING.length).trim() : report.changes}</p>
    </div>
  );
}

/**
 * A report in a session's card. While the agent works on changes the user asked for (`working`), the
 * changes come first and the report they answer folds away.
 */
export function SessionReport({ report, criteria, working }: { report: Report; criteria: ReportCriterion[]; working: boolean }) {
  const tx = useTranslation();
  const [open, setOpen] = useState(false);
  if (!working) return <ReportBody report={report} criteria={criteria} />;
  return (
    <div className="flex flex-col gap-3">
      <ChangesNote report={report} />
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 self-start text-[12px] text-mut2 hover:text-fg2">
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} strokeWidth={2.2} />
        {tx("The report from")}{tx.date(parseLocal(report.createdAt), "d MMM HH:mm")}
      </button>
      {open && <ReportBody report={report} criteria={criteria} hideChanges />}
    </div>
  );
}

/**
 * Asks for changes to a hand-back. The agent goes back to work in a new terminal, in a new conversation that starts
 * with its last report and the changes.
 */
export function RequestChangesForm({ agent, pending, onSend, onCancel }: {
  agent: AgentId;
  pending: boolean;
  onSend: (changes: string) => void;
  onCancel: () => void;
}) {
  const tx = useTranslation();
  const [text, setText] = useState("");
  const send = () => { if (text.trim() && !pending) onSend(text.trim()); };
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line2 bg-raised p-2.5">
      <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} aria-label={tx("What should change")}
        placeholder={tx("What should change? Be as specific as you'd be with a colleague.")}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        className="field-sizing-content min-h-[76px] w-full resize-none bg-transparent text-[12.5px] leading-[1.55] text-fg2 outline-none placeholder:text-mut2" />
      <div className="text-[11.5px] leading-[1.45] text-mut2">
        {tx(AGENT_LABEL[agent])} {tx("starts again in a new terminal, with its last report and your changes.")}</div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>{tx("Cancel")}</Button>
        <Button variant="primary" disabled={!text.trim() || pending} onClick={send}>
          {tx("Send to")}{tx(AGENT_LABEL[agent])} <span className="rounded bg-ink/15 px-1.5 font-mono text-[10.5px] max-md:hidden">Ctrl ↵</span>
        </Button>
      </div>
    </div>
  );
}

/** Your answers to an agent's questions as one message, the way they go back to it (requestChanges in ops.ts). */
export function answersText(questions: string[], answers: string[], more: string): string {
  const parts = questions.flatMap((q, i) => (answers[i]?.trim() ? [`${i + 1}. ${q}\n${answers[i].trim()}`] : []));
  return [ANSWERS_HEADING, ...parts, more.trim()].filter(Boolean).join("\n\n");
}

/**
 * Answers to the questions in an agent's report, one field each, sent back to it like changes. `onSend` gets the
 * message (answersText); the questions left empty stay out of it.
 */
export function AnswerForm({ agent, questions, pending, onSend, onCancel }: {
  agent: AgentId;
  questions: string[];
  pending: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const tx = useTranslation();
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ""));
  const [more, setMore] = useState("");
  const ready = answers.some((a) => a.trim()) && !pending;
  const send = () => { if (ready) onSend(answersText(questions, answers, more)); };
  const keys = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  };
  const field = "field-sizing-content min-h-[40px] w-full resize-none rounded-md border border-line2 bg-input px-2 py-1.5 text-[12.5px] leading-[1.55] text-fg2 outline-none placeholder:text-mut2 focus:border-line-strong";
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line2 bg-raised p-2.5">
      {questions.map((q, i) => (
        <label key={i} className="flex flex-col gap-1.5">
          <span className="text-[12px] leading-[1.45] text-fg3"><InlineMarkdown text={q} /></span>
          <textarea autoFocus={i === 0} value={answers[i]} aria-label={tx("Answer to question {0}", [i + 1])} placeholder={tx("Your answer")}
            onChange={(e) => setAnswers((a) => a.map((x, k) => (k === i ? e.target.value : x)))} onKeyDown={keys} className={field} />
        </label>
      ))}
      <textarea value={more} aria-label={tx("Anything else")} placeholder={tx("Anything else it should know (optional)")}
        onChange={(e) => setMore(e.target.value)} onKeyDown={keys} className={field} />
      <div className="text-[11.5px] leading-[1.45] text-mut2">
        {tx(AGENT_LABEL[agent])} {tx("starts again in a new terminal, with its last report and your answers.")}</div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>{tx("Cancel")}</Button>
        <Button variant="primary" disabled={!ready} onClick={send}>
          {tx("Send to")}{tx(AGENT_LABEL[agent])} <span className="rounded bg-ink/15 px-1.5 font-mono text-[10.5px] max-md:hidden">Ctrl ↵</span>
        </Button>
      </div>
    </div>
  );
}

/**
 * The body of a report: summary, the answered "Done when" items passed in `criteria` (the task panel shows
 * the rest on its own list), images, how to check, questions, details, links, follow-ups and the changes
 * the user asked for after reading it.
 */
export function ReportBody({ report, criteria, hideChanges }: { report: Report; criteria: ReportCriterion[]; hideChanges?: boolean }) {
  const tx = useTranslation();
  const long = report.details.length > 600 || report.details.split("\n").length > 10;
  const [open, setOpen] = useState(false);
  const clipped = long && !open;
  const web = (url: string) => /^https?:\/\//i.test(url);
  return (
    // On a phone, a word longer than the line (a path, an address) breaks instead of widening the sheet.
    <div className="flex flex-col gap-4 max-md:wrap-break-word">
      <p className="text-[13px] leading-[1.6] text-fg2">
        {report.outcome !== "done" && (
          <span className="mr-2 inline-flex h-5 translate-y-[-1px] items-center rounded-full border border-line-strong px-2 align-middle text-[11.5px] font-medium text-fg3">
            {tx(OUTCOME_LABEL[report.outcome])}
          </span>
        )}
        {report.summary}
      </p>

      {criteria.length > 0 && (
        <Section title={tx("Done when")} aside={criteriaCount(criteria, tx)}>
          <div className="flex flex-col">{criteria.map((c, i) => <CriterionRow key={i} c={c} />)}</div>
        </Section>
      )}

      {report.images.length > 0 && <Gallery images={report.images} />}

      {report.questions.length > 0 && (
        <Section title={report.questions.length === 1 ? tx("Question for you") : tx("Questions for you")}>
          <ul className="flex flex-col gap-1.5">
            {report.questions.map((q, i) => (
              <li key={i} className="flex items-start gap-2.5 text-[12.5px] leading-[1.5] text-fg2">
                <Icon name="help" size={14} className="mt-[2px] shrink-0 text-mut" />
                <span className="min-w-0"><InlineMarkdown text={q} /></span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {report.verify.length > 0 && (
        <Section title={tx("How to check it")}>
          <ol className="flex flex-col gap-1">
            {report.verify.map((v, i) => (
              <li key={i} className="flex items-baseline gap-2.5 text-[12.5px] leading-[1.5] text-mut">
                <span className="w-3 shrink-0 text-right font-mono text-[11px] text-dim">{i + 1}</span>
                <span className="min-w-0"><InlineMarkdown text={v} /></span>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {report.diff && <DiffSection diff={report.diff} />}

      {report.details && (
        <Section title={tx("Details")}>
          <div className={cx("relative", clipped && "max-h-[150px] overflow-hidden")}>
            <Markdown text={report.details} />
            {clipped && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-panel to-transparent" />}
          </div>
          {long && (
            <button type="button" onClick={() => setOpen((o) => !o)} className="self-start text-[12px] text-mut2 hover:text-fg2">
              {open ? tx("Show less") : tx("Show all")}
            </button>
          )}
        </Section>
      )}

      {(report.links.length > 0 || report.followUps.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {report.links.map((l, i) => web(l.url) ? (
            <a key={i} href={l.url} target="_blank" rel="noreferrer" title={l.url}
              className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-ctl px-2 text-[12px] text-fg3 hover:bg-hover">
              <Icon name="external" size={12} className="shrink-0 text-mut2" /><span className="truncate">{l.label}</span>
            </a>
          ) : (
            <span key={i} title={l.url} className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-line px-2 text-[12px] text-mut">
              <Icon name="link" size={12} className="shrink-0 text-mut2" /><span className="truncate">{l.label === l.url ? l.url : `${l.label} · ${l.url}`}</span>
            </span>
          ))}
          {report.followUps.map((f) => f.href ? (
            <Link key={f.key} href={f.href} title={tx("Follow-up task")}
              className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-ctl px-2 text-[12px] text-fg3 hover:bg-hover">
              <Icon name="plus" size={12} className="shrink-0 text-mut2" />
              <span className="font-mono text-[11px] text-mut2">{f.key}</span><span className="truncate">{f.title}</span>
            </Link>
          ) : (
            <span key={f.key} className="inline-flex h-6 items-center rounded-md border border-line px-2 font-mono text-[11px] text-mut2">{f.key}</span>
          ))}
        </div>
      )}

      {!hideChanges && <ChangesNote report={report} />}
    </div>
  );
}

const FILE_MARK: Record<DiffFileStatus, string> = { added: "A", modified: "M", deleted: "D", renamed: "R", untracked: "N" };
const FILE_STATUS = (tx: Translator): Record<DiffFileStatus, string> => ({
  added: tx("Added"), modified: tx("Changed"), deleted: tx("Deleted"), renamed: tx("Renamed"), untracked: tx("New, not tracked by git"),
});

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/** "3 files · +120 −14 · 2 commits". */
export function diffCount(d: ReportDiff): string {
  const files = d.files.length + d.moreFiles;
  const commits = d.commits.length + d.moreCommits;
  return [
    plural(files, "file"), files ? `+${d.added.toLocaleString("en")} −${d.removed.toLocaleString("en")}` : null, commits ? plural(commits, "commit") : null,
  ].filter(Boolean).join(" · ");
}

/** The lines of a diff: file headers stand out, added lines are raised, removed ones dimmed. Grayscale, like all state. */
function DiffView({ text }: { text: string }) {
  const tx = useTranslation();
  const MAX = 5000;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const kind = (l: string) =>
    l.startsWith("diff --git ") ? "mt-2 first:mt-0 font-medium text-fg2"
      : /^(\+\+\+|---|index |new file|deleted file|similarity |rename |old mode|new mode|Binary)/.test(l) ? "text-dim"
        : l.startsWith("@@") ? "text-mut2"
          : l.startsWith("+") ? "bg-sel text-fg"
            : l.startsWith("-") ? "bg-hover text-dim"
              : "text-mut";
  return (
    <div className="flex flex-col gap-1">
      <pre className="max-h-[420px] overflow-auto rounded-md border border-line bg-raised px-2.5 py-2 font-mono text-[11px] leading-[17px]">
        {lines.slice(0, MAX).map((l, i) => <div key={i} className={cx("whitespace-pre px-1", kind(l))}>{l || " "}</div>)}
      </pre>
      {lines.length > MAX && <p className="text-[11.5px] text-mut2">{tx("Showing the first")}{" "}{MAX.toLocaleString("en")} {" "}{tx("of")}{" "}{lines.length.toLocaleString("en")} {" "}{tx("lines.")}</p>}
    </div>
  );
}

/**
 * What changed in git in the session's folder since it started, as PacedMind saw it when the agent handed the task
 * back: the commits, the files with their lines added and removed, and the full diff, which stays on the computer
 * the session ran on.
 */
export function DiffSection({ diff }: { diff: ReportDiff }) {
  const tx = useTranslation();
  const [all, setAll] = useState(false);
  const [patch, setPatch] = useState<{ state: "closed" | "loading" | "elsewhere" } | { state: "open"; text: string }>({ state: "closed" });
  if (diff.skipped) {
    return (
      <Section title={tx("Files changed")}>
        <p className="text-[12.5px] leading-[1.5] text-mut2">
          {diff.skipped === "asks"
            ? tx("No diff: PacedMind doesn't read folders in Desktop, Documents, Downloads or a cloud drive, where macOS asks first.")
            : tx("No diff: git wasn't there to compare the folder with.")}
        </p>
      </Section>
    );
  }
  const nothing = !diff.files.length && !diff.commits.length;
  const shown = all ? diff.files : diff.files.slice(0, 8);
  const open = async () => {
    if (!diff.patchId) return;
    setPatch({ state: "loading" });
    const res = await fetch(`/api/diffs/${diff.patchId}`).catch(() => null);
    setPatch(res?.ok ? { state: "open", text: await res.text() } : { state: "elsewhere" });
  };
  return (
    <Section title={tx("Files changed")} aside={nothing ? undefined : tx("since the session started · {0}", [diffCount(diff)])}>
      {nothing && <p className="text-[12.5px] leading-[1.5] text-mut2">{tx("Nothing changed in git since the session started.")}</p>}
      {diff.dirtyAtStart && (
        <p className="text-[12px] leading-[1.5] text-mut2">{tx("The folder already had changes that weren't committed when the session started: they count here too.")}</p>
      )}
      {diff.commits.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {diff.commits.map((c) => (
            <li key={c.sha} className="flex items-baseline gap-2.5 text-[12.5px] leading-[1.5]">
              <span className="shrink-0 font-mono text-[11px] text-dim">{c.sha}</span>
              <span className="min-w-0 truncate text-fg2" title={c.subject}>{c.subject}</span>
            </li>
          ))}
          {diff.moreCommits > 0 && <li className="text-[12px] text-mut2">{tx("and")}{" "}{plural(diff.moreCommits, tx("older commit"))}</li>}
        </ul>
      )}
      {diff.files.length > 0 && (
        <ul className="flex flex-col">
          {shown.map((f) => (
            <li key={f.path} className="flex h-6 items-center gap-2.5 text-[12px]">
              <span title={FILE_STATUS(tx)[f.status]} className="w-3 shrink-0 text-center font-mono text-[11px] text-dim">{FILE_MARK[f.status]}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg2" title={f.from ? `${f.from} → ${f.path}` : f.path}>
                {f.from ? `${f.from} → ${f.path}` : f.path}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-mut2">
                {f.added === null ? "binary" : `+${f.added} −${f.removed ?? 0}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {diff.files.length > 8 && (
          <button type="button" onClick={() => setAll((a) => !a)} className="text-[12px] text-mut2 hover:text-fg2">
            {all ? tx("Show fewer") : tx("Show all {0} files", [diff.files.length])}
          </button>
        )}
        {diff.moreFiles > 0 && all && <span className="text-[12px] text-mut2">{tx("and")}{" "}{plural(diff.moreFiles, tx("more file"))}</span>}
        {diff.patchId && (patch.state === "open"
          ? <button type="button" onClick={() => setPatch({ state: "closed" })} className="text-[12px] text-mut2 hover:text-fg2">{tx("Hide the diff")}</button>
          : patch.state !== "elsewhere" && (
            <button type="button" disabled={patch.state === "loading"} onClick={() => void open()} className="text-[12px] text-mut2 hover:text-fg2">
              {patch.state === "loading" ? tx("Loading the diff…") : tx("Show the diff")}
            </button>
          ))}
      </div>
      {patch.state === "elsewhere" && <p className="text-[12px] leading-[1.5] text-mut2">{tx("The diff itself stays on the computer the session ran on. Open PacedMind there to see it.")}</p>}
      {patch.state === "open" && (
        <>
          <DiffView text={patch.text} />
          {diff.truncated && <p className="text-[11.5px] text-mut2">{tx("The diff was longer than PacedMind keeps (1 MB), so it's cut short.")}</p>}
        </>
      )}
    </Section>
  );
}

/** Thumbnails; an odd count gives the first image the full width. Clicking one opens the viewer. */
export function Gallery({ images }: { images: Attachment[] }) {
  const tx = useTranslation();
  const [shown, setShown] = useState<number | null>(null);
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        {images.map((a, i) => (
          <button key={a.id} type="button" onClick={() => setShown(i)} title={a.caption || tx("Open image")}
            className={cx("group flex min-w-0 flex-col gap-1 text-left", images.length % 2 === 1 && i === 0 && "col-span-2")}>
            <span className="block aspect-[16/10] w-full overflow-hidden rounded-md border border-line2 bg-raised group-hover:border-line-strong">
              {/* eslint-disable-next-line @next/next/no-img-element -- served from disk by /api/attachments, nothing to optimize */}
              <img src={imageUrl(a)} alt={a.caption || tx("Screenshot")} loading="lazy" decoding="async" className="h-full w-full object-cover object-top" />
            </span>
            {a.caption && <span className="line-clamp-2 text-[11.5px] leading-[1.45] text-mut2">{a.caption}</span>}
          </button>
        ))}
      </div>
      {shown !== null && <Lightbox images={images} start={shown} onClose={() => setShown(null)} />}
    </>
  );
}

/** Full-size images, one at a time. ← and → move, Escape closes, a click on the image shows it at its own size. */
export function Lightbox({ images, start, onClose }: { images: Attachment[]; start: number; onClose: () => void }) {
  const tx = useTranslation();
  const [i, setI] = useState(start);
  const [actual, setActual] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const a = images[i];
  const go = (d: number) => { setI((x) => (x + d + images.length) % images.length); setActual(false); };

  useEffect(() => { box.current?.focus(); }, []);

  return createPortal(
    <div ref={box} role="dialog" aria-modal="true" aria-label={tx("Image viewer")} tabIndex={-1}
      className="fixed inset-0 z-[80] flex flex-col bg-bg/95 outline-none"
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.stopPropagation(); onClose(); }
        if (e.key === "ArrowRight" && images.length > 1) go(1);
        if (e.key === "ArrowLeft" && images.length > 1) go(-1);
      }}>
      <div className="flex h-12 shrink-0 items-center gap-3 px-4 text-[12.5px] text-mut">
        {images.length > 1 && <span className="font-mono text-[11.5px] text-mut2">{i + 1} / {images.length}</span>}
        <span className="min-w-0 flex-1 truncate text-fg2">{a.caption}</span>
        <span className="hidden font-mono text-[11px] text-dim sm:inline">
          {a.width && a.height ? `${a.width}×${a.height} · ` : ""}{tx.date(parseLocal(a.createdAt), "d MMM HH:mm")}
        </span>
        {/* Saved, not opened: only PacedMind's own window may load it (proxy.ts), so a browser would be refused. */}
        <a href={imageUrl(a)} download className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-mut hover:bg-hover hover:text-fg2">
          <Icon name="download" size={13} />{tx("Save")}</a>
        <button type="button" aria-label={tx("Close (Esc)")} title={tx("Close (Esc)")} onClick={onClose}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-mut hover:bg-hover hover:text-fg2">
          <Icon name="x" size={16} />
        </button>
      </div>
      {/* On a phone the image takes the width; the arrows sit over its edges. */}
      <div className={cx("relative flex min-h-0 flex-1", actual ? "overflow-auto" : "items-center justify-center px-14 pb-8 max-md:px-3 max-md:pb-3")}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- served from disk by /api/attachments, nothing to optimize */}
        <img key={a.id} src={imageUrl(a)} alt={a.caption || tx("Screenshot")} onClick={() => setActual((x) => !x)}
          className={cx("rounded-md border border-line2", actual ? "m-auto max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain")} />
        {images.length > 1 && !actual && (
          <>
            <button type="button" aria-label={tx("Previous image")} onClick={() => go(-1)}
              className="absolute left-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-line2 bg-raised text-mut hover:text-fg2">
              <Icon name="chevronLeft" size={16} />
            </button>
            <button type="button" aria-label={tx("Next image")} onClick={() => go(1)}
              className="absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-line2 bg-raised text-mut hover:text-fg2">
              <Icon name="chevronRight" size={16} />
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
