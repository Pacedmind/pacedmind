import Link from "next/link";
import type { ReactNode } from "react";
import { Emblem } from "@/components/emblem";
import { SITE } from "@/lib/site";

/**
 * The terms, the privacy policy, the refund policy and the help pages: one column of plain text, with the others linked
 * below. `updated` shows when the policies last changed; the help pages leave it out.
 */
export function LegalPage({ title, updated = true, children }: { title: string; updated?: boolean; children: ReactNode }) {
  return (
    <>
      <header className="mx-auto flex h-[76px] max-w-[1120px] items-center px-5 sm:px-8">
        <Link href="/" aria-label="PacedMind" className="rounded-[7px]"><Emblem size={30} /></Link>
      </header>
      <main className="mx-auto max-w-[760px] px-5 pb-24 pt-10 sm:px-8 sm:pt-16">
        <h1 className="text-[clamp(32px,4.2vw,48px)] leading-[1.1] font-light tracking-[-0.01em] text-ink">{title}</h1>
        {updated && <p className="mt-4 text-[15px] text-mut">Last updated {SITE.legalUpdated}</p>}
        <div className="legal mt-10 space-y-5 text-[16px] leading-[1.65] text-text">{children}</div>
        <nav className="mt-16 flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-6 text-[15px] text-mut">
          <Link href="/terms" className="hover:text-ink">Terms</Link>
          <Link href="/privacy" className="hover:text-ink">Privacy</Link>
          <Link href="/refunds" className="hover:text-ink">Refunds</Link>
          <Link href="/delete-account" className="hover:text-ink">Delete account</Link>
          <Link href="/support" className="hover:text-ink">Support</Link>
          <Link href="/" className="hover:text-ink">Home</Link>
        </nav>
      </main>
    </>
  );
}

export function H2({ children }: { children: ReactNode }) {
  return <h2 className="!mt-12 text-[22px] font-medium text-ink">{children}</h2>;
}

export function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-2 pl-6">
      {items.map((item, i) => <li key={i}>{item}</li>)}
    </ul>
  );
}

/** Who runs PacedMind, as the register has it. */
export function Operator() {
  const o = SITE.operator;
  return (
    <p>
      {o.name}, {o.address}. NIP (tax ID) {o.nip}, REGON {o.regon}. Email{" "}
      <a href={`mailto:${o.email}`} className="underline underline-offset-2 hover:text-ink">{o.email}</a>.
    </p>
  );
}

export function Mail() {
  return <a href={`mailto:${SITE.operator.email}`} className="underline underline-offset-2 hover:text-ink">{SITE.operator.email}</a>;
}
