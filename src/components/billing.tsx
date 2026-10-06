"use client";
import { useTranslation } from "@/components/language";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { manageBillingAction } from "@/app/actions";
import { daysLeft, type Plan } from "@/lib/billing";
import { Button, useAction } from "./ui";

type PageResult = { ok: boolean; error?: string; message?: string; url?: string };

/**
 * Runs a billing action and opens the Stripe page it answers. The desktop app's window sends pages from elsewhere to
 * the browser (desktop/main.mjs, will-navigate); the web app goes there itself and comes back to Settings.
 */
export function useOpenBilling() {
  const { run, pending } = useAction();
  const open = (fn: () => Promise<PageResult>) =>
    run(async () => {
      const r = await fn();
      if (!r.ok || !r.url) return r;
      window.location.assign(r.url);
      return { ok: true };
    });
  return { open, pending };
}

/**
 * Above every page once billing is on, only when the plan needs you: the trial's last days, a payment that didn't go
 * through, or Cloud that has ended and is read-only. Settings → Plan has the rest.
 */
export function BillingBanner({ plan, desktop, nativeCompanion = false }: { plan: Plan; desktop: boolean; nativeCompanion?: boolean }) {
  const tx = useTranslation();
  const { open, pending } = useOpenBilling();
  const router = useRouter();
  const days = daysLeft(plan.trialEndsAt);
  let text: ReactNode;
  let actions: ReactNode;
  // The native companion uses existing entitlements; it does not sell subscriptions or lead to a checkout.
  if (nativeCompanion) {
    return plan.state === "lapsed" ? (
      <div role="status" className="border-b border-line bg-panel px-3.5 py-2 text-[12.5px] text-fg2">
        {tx("PacedMind Cloud is read-only. You can still see and delete your data.")}</div>
    ) : null;
  }
  if (plan.state === "trial" && days <= 3) {
    text = <span suppressHydrationWarning>{tx("Your free trial of PacedMind Cloud ends")}{" "}{days === 0 ? tx("today") : days === 1 ? tx("tomorrow") : tx("in {0} days", [days])}{tx(". After that it")}{"'"}{tx("s read-only until you subscribe.")}</span>;
    actions = <Button size="sm" variant="primary" onClick={() => router.push("/settings/plan")}>{tx("Subscribe")}</Button>;
  } else if (plan.state === "past_due") {
    text = tx("The last payment for PacedMind Cloud didn't go through. Cloud keeps working while the card is tried again.");
    actions = <Button size="sm" disabled={pending} onClick={() => open(() => manageBillingAction())}>{tx("Update payment")}</Button>;
  } else if (plan.state === "lapsed") {
    text = desktop
      ? tx("PacedMind Cloud is read-only: you can see and delete what's in it, but not change it. Subscribe, or move it to this computer.")
      : tx("PacedMind Cloud is read-only: you can see and delete what's in it, but not change it.");
    actions = <>
      {desktop && <Button size="sm" onClick={() => router.push("/settings/data")}>{tx("Move to this computer")}</Button>}
      <Button size="sm" variant="primary" onClick={() => router.push("/settings/plan")}>{tx("Subscribe")}</Button>
    </>;
  } else {
    return null;
  }
  return (
    <div role="status" className="mx-2 mt-2 flex items-center gap-3 rounded-[10px] border border-line bg-panel px-3.5 py-2 text-[12.5px] text-fg2 max-md:mx-0 max-md:mt-0 max-md:flex-col max-md:items-stretch max-md:rounded-none max-md:border-x-0">
      <span className="flex-1">{text}</span>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  );
}
