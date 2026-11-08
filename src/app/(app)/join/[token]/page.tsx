import { getTranslation } from "@/server/i18n";
import * as repo from "@/server/repo";
import { usesCloud } from "@/server/scope";
import { getWorkEmail } from "@/server/work-email";
import { AcceptInvite, WorkEmailSettings } from "@/components/workspace-settings";

/**
 * An invitation's link (/join/<token>): signed out, the hosted app sends you to sign in or create an account (with
 * Google too) and back here. The invited address can be confirmed on that account from this page.
 */
export default async function JoinPage(props: PageProps<"/join/[token]">) {
  const tx = await getTranslation();
  const { token } = await props.params;
  const cloud = await usesCloud();
  const info = cloud ? await repo.inviteDetails(token).catch(() => null) : null;
  const invitedEmail = info?.status === "open" && !info.member && !info.matches ? info.email : null;
  const workEmail = invitedEmail ? await getWorkEmail() : null;
  const message = !cloud ? tx("Sign in to PacedMind Cloud to accept this invitation.")
    : !info || info.status === "unknown" ? tx("This invitation link isn't valid. Ask for a new one.")
    : info.member ? tx("You're a member of {0} already.", [info.workspace ?? ""])
    : info.status === "accepted" ? tx("This invitation was accepted already.")
    : info.status !== "open" ? tx("This invitation has expired or was withdrawn. Ask for a new one.")
    : !info.matches ? tx("Confirm {0} as your work email to accept this invitation on this account.", [info.email ?? ""])
    : null;
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex w-full max-w-[420px] flex-col gap-4 rounded-lg border border-line2 p-5">
        <h1 className="text-[15px] font-semibold text-fg">{info?.workspace ? tx("Join {0}", [info.workspace]) : tx("Team invitation")}</h1>
        {message
          ? <p className="text-[13px] leading-relaxed text-fg3">{message}</p>
          : <>
            <p className="text-[13px] leading-relaxed text-fg3">
              {tx("{0} invited {1} to join {2} as {3}. Everyone in it sees and works on its shared areas.", [
                info!.invitedBy ?? tx("Someone"), info!.email ?? "", info!.workspace ?? "", tx(info!.role === "admin" ? "an admin" : "a member"),
              ])}
            </p>
            <AcceptInvite token={token} />
          </>}
        {invitedEmail && workEmail && <WorkEmailSettings key={invitedEmail} state={workEmail} invitedEmail={invitedEmail} />}
      </div>
    </div>
  );
}
