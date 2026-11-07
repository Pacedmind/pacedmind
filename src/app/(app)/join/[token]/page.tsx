import { getTranslation } from "@/server/i18n";
import * as repo from "@/server/repo";
import { usesCloud } from "@/server/scope";
import { authState } from "@/server/supabase";
import { AcceptInvite } from "@/components/workspace-settings";

/**
 * An invitation's link (/join/<token>): signed out, the hosted app sends you to sign in or create an account (with
 * Google too) and back here. Only an account whose confirmed address is the invited one can accept it.
 */
export default async function JoinPage(props: PageProps<"/join/[token]">) {
  const tx = await getTranslation();
  const { token } = await props.params;
  const cloud = await usesCloud();
  const info = cloud ? await repo.inviteDetails(token).catch(() => null) : null;
  const email = (await authState())?.user.email ?? null;
  const message = !cloud ? tx("Sign in to PacedMind Cloud with the invited email address to accept this invitation.")
    : !info || info.status === "unknown" ? tx("This invitation link isn't valid. Ask for a new one.")
    : info.member ? tx("You're a member of {0} already.", [info.workspace ?? ""])
    : info.status === "accepted" ? tx("This invitation was accepted already.")
    : info.status !== "open" ? tx("This invitation has expired or was withdrawn. Ask for a new one.")
    : !info.confirmed ? tx("Confirm your email address first: open the link PacedMind sent you, then this one again.")
    : !info.matches ? tx("This invitation is for {0}, and you're signed in as {1}. Sign in with the invited address to accept it.", [info.email ?? "", email ?? ""])
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
      </div>
    </div>
  );
}
