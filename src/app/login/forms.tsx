"use client";
import { useTranslation } from "@/components/language";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type FormEvent, type ReactNode } from "react";
import {
  confirmEnrollAction, recoveryCodeAction, sendResetAction, setNewPasswordAction, signInAction, signInWithGoogleAction, signOutAction,
  signUpAction, startEnrollAction, verifyAction, type Enrollment,
} from "../auth/actions";
import { Picker } from "@/components/picker";
import { Button, cx } from "@/components/ui";

type Result = { ok: boolean; error?: string; message?: string } | undefined;
type Note = { text: string; error: boolean } | null;

export const field =
  "h-9 w-full rounded-md border border-line2 bg-input px-3 text-[13px] text-fg outline-none placeholder:text-dim focus:border-line-strong";
const codeField = cx(field, "text-center font-mono text-[18px] tracking-[0.4em]");

function Card({ title, children, onSubmit }: { title: string; children: ReactNode; onSubmit: (e: FormEvent) => void }) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-6">
      <h1 className="text-[15px] font-semibold text-strong">{title}</h1>
      {children}
    </form>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] text-mut">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] leading-relaxed text-mut2">{hint}</span>}
    </label>
  );
}

function Message({ note }: { note: Note }) {
  const tx = useTranslation();
  if (!note) return null;
  return (
    <p role={note.error ? "alert" : "status"}
      className={cx("rounded-md border px-3 py-2 text-[12.5px] leading-relaxed", note.error ? "border-line-strong text-fg" : "border-line2 text-fg3")}>
      {tx.generated(note.text)}
    </p>
  );
}

/** Runs an action and shows its error or message; a successful sign-in step redirects and returns nothing. */
function useRun(initial: Note = null) {
  const tx = useTranslation();
  const [note, setNote] = useState<Note>(initial);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<Result>, after?: (r: NonNullable<Result>) => void) =>
    start(async () => {
      const r = await fn();
      if (!r) return;
      if (!r.ok) setNote({ text: r.error ?? tx("Something went wrong."), error: true });
      else {
        if (r.message) setNote({ text: r.message, error: false });
        after?.(r);
      }
    });
  return { note, setNote, pending, run };
}

/* ---------- email and password ---------- */

/** Google's "G", as its sign-in branding guidelines have it for sign-in buttons (THIRD_PARTY_NOTICES.md). */
function GoogleMark() {
  return (
    <svg aria-hidden viewBox="0 0 48 48" width="16" height="16">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

type Mode = "signin" | "signup" | "reset";

/**
 * `confirmed`: an email link confirmed the address but couldn't sign in here (opened in another browser). `create`:
 * opens on creating an account (the site's Cloud button links to /login?create=1). `next`: the hosted app's page to
 * continue to once signed in (approving an agent's sign-in).
 */
export function LoginForm({ initialError, confirmed, create, next, google }: {
  initialError: string | null; confirmed?: boolean; create?: boolean; next?: string | null;
  /** Whether Google sign-in is switched on in Supabase (googleSignIn() in auth-flow.ts). */
  google?: boolean;
}) {
  const tx = useTranslation();
  const [mode, setMode] = useState<Mode>(create ? "signup" : "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const { note, setNote, pending, run } = useRun(initialError ? { text: initialError, error: true }
    : confirmed ? { text: tx("Your email is confirmed. Sign in to continue."), error: false } : null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === "signin") return run(() => signInAction(email, password, next));
    if (mode === "reset") return run(() => sendResetAction(email));
    if (password !== confirm) return setNote({ text: tx("The two passwords don't match."), error: true });
    run(() => signUpAction(email, password, next));
  };
  const switchTo = (m: Mode) => {
    setMode(m);
    setNote(null);
    setPassword("");
    setConfirm("");
  };
  const title = mode === "signin" ? tx("Sign in") : mode === "signup" ? tx("Create your account") : tx("Reset your password");
  // Google's page opens in this tab, or in the browser from the desktop app, which says so and waits here.
  const withGoogle = () => run(async () => {
    const r = await signInWithGoogleAction(next);
    if (r.ok && r.url) window.location.assign(r.url);
    return r;
  });

  return (
    <Card title={title} onSubmit={submit}>
      {google && mode !== "reset" && (
        <>
          <Button type="button" disabled={pending} onClick={withGoogle} className="h-9 justify-center gap-2 text-[13px]">
            <GoogleMark />{tx("Continue with Google")}</Button>
          <div className="flex items-center gap-3 text-[12px] text-mut2" aria-hidden>
            <span className="h-px flex-1 bg-line2" />{tx("or with your email")}<span className="h-px flex-1 bg-line2" />
          </div>
        </>
      )}
      <Field label={tx("Email")}>
        <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={field}
          placeholder={tx("you@example.com")} maxLength={254} />
      </Field>
      {mode !== "reset" && (
        <Field label={tx("Password")} hint={mode === "signup" ? tx("At least 12 characters. A passphrase of a few words works well.") : undefined}>
          <input type="password" required autoComplete={mode === "signin" ? "current-password" : "new-password"} value={password}
            onChange={(e) => setPassword(e.target.value)} className={field} maxLength={72} minLength={mode === "signup" ? 12 : undefined} />
        </Field>
      )}
      {mode === "signup" && (
        <Field label={tx("Password again")}>
          <input type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} maxLength={72} />
        </Field>
      )}
      {mode === "signup" && (
        <p className="text-[12px] leading-relaxed text-mut2">
          {tx("Confirm your email to start planning and connect MCP. Two-factor sign-in can be set up later in Settings; it is needed before starting sessions on your computers.")}</p>
      )}
      <Message note={note} />
      <Button type="submit" variant="primary" disabled={pending} className="h-9 justify-center text-[13px]">
        {mode === "signin" ? tx("Sign in") : mode === "signup" ? tx("Create account") : tx("Email me a link")}
      </Button>
      <div className="flex flex-col items-center gap-2 border-t border-line pt-4 text-[12.5px] text-mut2">
        {mode === "signin" && (
          <>
            <button type="button" onClick={() => switchTo("reset")} className="text-mut hover:text-fg2">{tx("Forgot your password?")}</button>
            <span>{tx("New to PacedMind?")}{" "}<button type="button" onClick={() => switchTo("signup")} className="font-medium text-fg2 hover:text-strong">{tx("Create an account")}</button></span>
          </>
        )}
        {mode !== "signin" && (
          <button type="button" onClick={() => switchTo("signin")} className="font-medium text-fg2 hover:text-strong">{tx("Back to sign in")}</button>
        )}
      </div>
    </Card>
  );
}

/* ---------- the code from the authenticator ---------- */

export function VerifyForm({ factors, backupCodes, next }: { factors: { id: string; name: string }[]; backupCodes: boolean; next: string | null }) {
  const tx = useTranslation();
  const [factorId, setFactorId] = useState(factors[0]?.id ?? "");
  const [code, setCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);
  const { note, pending, run } = useRun();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(() => (useBackup ? recoveryCodeAction(code, next) : verifyAction(code, factorId, next)));
  };

  return (
    <Card title={tx("Two-factor code")} onSubmit={submit}>
      {factors.length > 1 && !useBackup && (
        <Field label={tx("Authenticator")}>
          <Picker label={tx("Authenticator")} values={[factorId]} options={factors.map((f) => ({ value: f.id, label: f.name }))}
            onChange={([id]) => setFactorId(id)} className="h-9" />
        </Field>
      )}
      <Field label={useBackup ? tx("Backup code") : tx("Code from your authenticator app")}>
        <input autoFocus required value={code} onChange={(e) => setCode(useBackup ? e.target.value : e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode={useBackup ? "text" : "numeric"} autoComplete="one-time-code" className={useBackup ? field : codeField}
          placeholder={useBackup ? "xxxx-xxxx-xxxx-xxxx" : "000000"} maxLength={useBackup ? 40 : 6} />
      </Field>
      <Message note={note} />
      <Button type="submit" variant="primary" disabled={pending} className="h-9 justify-center text-[13px]">{tx("Continue")}</Button>
      <div className="flex flex-col items-center gap-2 border-t border-line pt-4 text-[12.5px] text-mut2">
        {backupCodes && (
          <button type="button" onClick={() => { setUseBackup(!useBackup); setCode(""); }} className="text-mut hover:text-fg2">
            {useBackup ? tx("Use the authenticator app") : tx("Use a backup code")}
          </button>
        )}
        <button type="button" onClick={() => run(() => signOutAction().then(() => undefined))} className="text-mut hover:text-fg2">{tx("Sign out")}</button>
      </div>
    </Card>
  );
}

/* ---------- setting up an authenticator ---------- */

export function SetupForm({ first, email, next }: { first: boolean; email: string; next?: string | null }) {
  const tx = useTranslation();
  const router = useRouter();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [current, setCurrent] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [copied, setCopied] = useState(false);
  const [done, setDone] = useState(false);
  const { note, setNote, pending, run } = useRun();

  // The first authenticator starts right away; another one after a code from one you already have.
  useEffect(() => {
    if (!first) return;
    let live = true;
    startEnrollAction().then((r) => {
      if (!live) return;
      if (r.ok && r.enrollment) setEnrollment(r.enrollment);
      else setNote({ text: r.error ?? tx("Couldn't start setting up the app."), error: true });
    });
    return () => {
      live = false;
    };
  }, [first, setNote, tx]);

  if (!first && !enrollment) {
    const begin = (e: FormEvent) => {
      e.preventDefault();
      run(() => startEnrollAction(current), (r) => {
        const withEnrollment = r as typeof r & { enrollment?: Enrollment };
        if (withEnrollment.enrollment) setEnrollment(withEnrollment.enrollment);
      });
    };
    return (
      <Card title={tx("Add another authenticator")} onSubmit={begin}>
        <Field label={tx("Code from an authenticator you already have")}>
          <input autoFocus required value={current} onChange={(e) => setCurrent(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric"
            autoComplete="one-time-code" className={codeField} placeholder="000000" maxLength={6} />
        </Field>
        <Message note={note} />
        <Button type="submit" variant="primary" disabled={pending || current.length !== 6} className="h-9 justify-center text-[13px]">{tx("Continue")}</Button>
      </Card>
    );
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-6">
        <h1 className="text-[15px] font-semibold text-strong">{tx("Two-factor sign-in is on")}</h1>
        <p className="text-[12.5px] leading-relaxed text-fg3">
          {tx("If you lose this phone you lose access to your account, so add a second authenticator now: another phone, a tablet or a password manager that makes codes. You can also do it later in Settings.")}</p>
        {first && <p className="text-[12.5px] leading-relaxed text-fg3">{tx("To activate computer access, sign out and sign in again with your code. Reconnect any MCP connection you want to use for computer access.")}</p>}
        <div className="flex gap-2">
          <Button type="button" onClick={() => router.push("/login/setup?add=1")} className="h-9 flex-1 justify-center">{tx("Add a second one")}</Button>
          <Button type="button" variant="primary" onClick={() => router.push(next ?? "/today")} className="h-9 flex-1 justify-center">{tx("Continue")}</Button>
        </div>
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!enrollment) return;
    run(() => confirmEnrollAction(enrollment.factorId, code), () => (first ? setDone(true) : router.push("/settings/security")));
  };

  return (
    <Card title={first ? tx("Set up two-factor sign-in") : tx("Add another authenticator")} onSubmit={submit}>
      <ol className="flex list-decimal flex-col gap-2 pl-4 text-[12.5px] leading-relaxed text-fg3">
        <li>{tx("Open an authenticator app: Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden or similar.")}</li>
        <li>{tx("Scan this code, or type the key by hand.")}</li>
        <li>{tx("Enter the 6-digit code the app shows.")}</li>
      </ol>
      <div className="flex flex-col items-center gap-3">
        <div className="flex h-[184px] w-[184px] items-center justify-center rounded-lg bg-white p-2">
          {enrollment
            ? /* eslint-disable-next-line @next/next/no-img-element -- a data: URI SVG made by Supabase */
              <img src={enrollment.qr} alt={tx("QR code for PacedMind ({0})", [email])} width={168} height={168} />
            : <span className="text-[12px] text-neutral-500">{tx("Preparing…")}</span>}
        </div>
        {enrollment && (
          // A phone can't scan its own screen: this hands the key to the authenticator app on it.
          <a href={enrollment.uri}
            className="hidden h-9 w-full items-center justify-center rounded-md border border-line2 text-[12.5px] text-fg2 pointer-coarse:flex">
            {tx("Add to an authenticator app on this device")}</a>
        )}
        {enrollment && (
          <button type="button" onClick={() => setShowSecret(!showSecret)} className="text-[12px] text-mut hover:text-fg2">
            {showSecret ? tx("Hide the key") : tx("Can't scan it? Show the key")}
          </button>
        )}
        {enrollment && showSecret && (
          <div className="flex w-full items-center gap-2">
            <code className="flex-1 select-all break-all rounded-md border border-line2 bg-input px-3 py-2 text-center font-mono text-[12.5px] text-fg2">
              {enrollment.secret.replace(/(.{4})/g, "$1 ").trim()}
            </code>
            <Button type="button" className="h-9 shrink-0" onClick={() => navigator.clipboard.writeText(enrollment.secret).then(
              () => setCopied(true),
              () => setNote({ text: tx("Couldn't copy the key. Type it into the app by hand."), error: true }),
            )}>{copied ? tx("Copied") : tx("Copy")}</Button>
          </div>
        )}
      </div>
      <Field label={tx("Code from the app")}>
        <input required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric"
          autoComplete="one-time-code" className={codeField} placeholder="000000" maxLength={6} />
      </Field>
      <Message note={note} />
      <Button type="submit" variant="primary" disabled={pending || !enrollment} className="h-9 justify-center text-[13px]">{tx("Turn on")}</Button>
      {first && (
        <div className="flex justify-between border-t border-line pt-4">
          <button type="button" disabled={pending} onClick={() => router.push(next ?? "/today")} className="text-[12.5px] text-fg2 hover:text-strong">{tx("Set up later")}</button>
          <button type="button" onClick={() => run(() => signOutAction().then(() => undefined))} className="text-[12.5px] text-mut hover:text-fg2">{tx("Sign out")}</button>
        </div>
      )}
    </Card>
  );
}

/* ---------- a new password after an email link ---------- */

export function NewPasswordForm() {
  const tx = useTranslation();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const { note, setNote, pending, run } = useRun();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setNote({ text: tx("The two passwords don't match."), error: true });
    run(() => setNewPasswordAction(password));
  };
  return (
    <Card title={tx("Choose a new password")} onSubmit={submit}>
      <Field label={tx("New password")} hint={tx("At least 12 characters. Other devices are signed out when it changes.")}>
        <input type="password" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={field}
          minLength={12} maxLength={72} autoFocus />
      </Field>
      <Field label={tx("New password again")}>
        <input type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} maxLength={72} />
      </Field>
      <Message note={note} />
      <Button type="submit" variant="primary" disabled={pending} className="h-9 justify-center text-[13px]">{tx("Save password")}</Button>
    </Card>
  );
}
