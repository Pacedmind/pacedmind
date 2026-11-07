import type { CSSProperties } from "react";
import type { AgentId, Area, Priority, Status, Surface, Verdict } from "@/lib/types";
import type { AreaIcon } from "@/lib/area-icons";
import { AREA_ICON_PATHS } from "./area-icon-paths";

type IconProps = { size?: number; className?: string; strokeWidth?: number };

/** Many of these shapes are adapted from Feather (MIT) and Lucide (ISC): see THIRD_PARTY_NOTICES.md. */
const P = {
  inbox: "M22 12h-6l-2 3h-4l-2-3H2 M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z",
  sun: "M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0 M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  clock: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M12 7v5l3 2",
  calendar: "M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M3 9h18M8 2v4M16 2v4",
  calendarCheck: "M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M3 9h18 M9 15l2 2 4-4",
  timeline: "M4 6h9M9 12h11M6 18h8",
  roadmap: "M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z M9 3v15 M15 6v15",
  terminal: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M7 10l3 2-3 2 M12 15h5",
  settings: "M9.7 3.1l.5-1.1h3.6l.5 1.1.4 1.8 1.6.9 1.8-.5 1.2.2 1.8 3.1-.7 1-1.4 1.3v1.8l1.4 1.3.7 1-1.8 3.1-1.2.2-1.8-.5-1.6.9-.4 1.8-.5 1.1h-3.6l-.5-1.1-.4-1.8-1.6-.9-1.8.5-1.2-.2-1.8-3.1.7-1 1.4-1.3v-1.8L3.1 9.6l-.7-1 1.8-3.1 1.2-.2 1.8.5 1.6-.9z M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
  moon: "M20.9 13.1A9 9 0 0 1 10.9 3.1 9 9 0 1 0 20.9 13.1z",
  search: "M4 11a7 7 0 1 0 14 0a7 7 0 1 0 -14 0 M20 20l-3.5-3.5",
  pen: "M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  chevronDown: "M6 9l6 6 6-6",
  chevronRight: "M9 6l6 6-6 6",
  chevronLeft: "M15 18l-6-6 6-6",
  flag: "M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z M4 22v-7",
  bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.9 1.9 0 0 0 3.4 0",
  tag: "M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z M7.5 7.5h.01",
  layers: "M12 2L2 7l10 5 10-5-10-5z M2 17l10 5 10-5M2 12l10 5 10-5",
  x: "M18 6L6 18M6 6l12 12",
  check: "M5 12l5 5 9-10",
  trash: "M3 6h18 M8 6V4h8v2 M6 6l1 14h10l1-14",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7 M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  repeat: "M17 2l4 4-4 4 M3 11V10a4 4 0 0 1 4-4h14 M7 22l-4-4 4-4 M21 13v1a4 4 0 0 1-4 4H3",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  hourglass: "M6 2h12 M6 22h12 M7 2c0 5 10 7 10 10s-10 5-10 10 M17 2c0 5-10 7-10 10s10 5 10 10",
  folder: "M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  play: "M7 4l12 8-12 8z",
  refresh: "M21 12a9 9 0 1 1-3-6.7L21 8 M21 3v5h-5",
  more: "M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0 M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0 M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
  menu: "M4 6h16M4 12h16M4 18h16",
  box: "M21 8l-9-5-9 5v8l9 5 9-5z M3 8l9 5 9-5 M12 13v8",
  user: "M8 8a4 4 0 1 0 8 0a4 4 0 1 0 -8 0 M4.5 20a7.5 7.5 0 0 1 15 0",
  users: "M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0 M1.5 20a7.5 7.5 0 0 1 15 0 M16 3.5a4 4 0 0 1 0 7.5 M19 14.5a7.5 7.5 0 0 1 3.5 5.5",
  cloud: "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z",
  appWindow: "M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M3 9h18 M6.5 6.5h.01 M9.5 6.5h.01",
  laptop: "M5 5h14a1 1 0 0 1 1 1v9H4V6a1 1 0 0 1 1-1z M2 18.5h20",
  download: "M12 4v11 M7 10l5 5 5-5 M5 20h14",
  image: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M7.5 9a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0 M21 15l-5-5L5 20",
  external: "M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  help: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M9.1 9a3 3 0 0 1 5.8 1c0 2-2.9 2.6-2.9 4 M12 17.5h.01",
  alert: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M12 8v4.5 M12 16h.01",
  target: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M7.5 12a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0 M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
  shield: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
  database: "M3 5a9 3 0 1 0 18 0a9 3 0 1 0 -18 0 M3 5V19A9 3 0 0 0 21 19V5 M3 12A9 3 0 0 0 21 12",
  palette: "M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z M13 6.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0 M17 10.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0 M6 12.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0 M8 7.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0",
  cpu: "M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M10 9h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z M9 2v2 M15 2v2 M9 20v2 M15 20v2 M2 9h2 M2 15h2 M20 9h2 M20 15h2",
  plug: "M12 22v-5 M15 8V2 M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z M9 8V2",
  creditCard: "M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2z M2 10L22 10 M6 14h2",
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 16, className, strokeWidth = 1.8 }: IconProps & { name: IconName }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={P[name]} />
    </svg>
  );
}

/*
 * The agents' marks, drawn in the current text color like the other icons: Claude's from Simple Icons (CC0),
 * Codex's from LobeHub Icons (MIT, notice in THIRD_PARTY_NOTICES.md). The names are their owners' trademarks and
 * only say which agent runs a session.
 */
const AGENT_MARK: Record<AgentId, string> = {
  claude:
    "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  codex:
    "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z",
};

/** The mark of the agent that runs a session: Claude's spark or Codex's prompt. */
export function AgentIcon({ agent, size = 14, className, style }: { agent: AgentId; size?: number; className?: string; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true" style={{ flex: "none", ...style }}>
      <path d={AGENT_MARK[agent]} fillRule="evenodd" clipRule="evenodd" />
    </svg>
  );
}

const SURFACE_ICON: Record<Surface, IconName> = { terminal: "terminal", desktop: "appWindow", cloud: "cloud" };

/** Where a session runs: a terminal, a desktop app or the cloud. */
export function SurfaceIcon({ surface, size = 14, className, strokeWidth = 1.9 }: IconProps & { surface: Surface }) {
  return <Icon name={SURFACE_ICON[surface]} size={size} className={className} strokeWidth={strokeWidth} />;
}

const STATUS_SHAPE: Record<Status, { ring: string; dash?: string; fill?: string; fillD?: string; mark?: string }> = {
  backlog: { ring: "var(--color-mut2)", dash: "2 2" },
  todo: { ring: "var(--color-fg3)" },
  progress: { ring: "var(--color-mut)", fill: "var(--color-mut)", fillD: "M7 3 A4 4 0 0 1 7 11 Z" },
  review: { ring: "var(--color-fg3)", fill: "var(--color-fg3)", fillD: "M7 7 L7 3 A4 4 0 1 1 3 7 Z" },
  done: { ring: "var(--color-accent)", fill: "var(--color-accent)", fillD: "M1 7 A6 6 0 1 0 13 7 A6 6 0 1 0 1 7 Z", mark: "M4.4 7.2 L6.2 9 L9.7 5.3" },
  canceled: { ring: "var(--color-dim)", fill: "var(--color-dim)", fillD: "M1 7 A6 6 0 1 0 13 7 A6 6 0 1 0 1 7 Z", mark: "M5 5 L9 9 M9 5 L5 9" },
};

export function StatusIcon({ status, size = 14 }: { status: Status; size?: number }) {
  const s = STATUS_SHAPE[status];
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="6" fill="none" stroke={s.ring} strokeWidth="1.5" strokeDasharray={s.dash} />
      {s.fillD && <path d={s.fillD} fill={s.fill} />}
      {s.mark && <path d={s.mark} fill="none" stroke="var(--color-panel)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

/**
 * An agent's answer to a "Done when" item, in grayscale like every state: a filled check (met), half a
 * circle (partly), a cross (not met), a dashed ring (not answered). "none" is an item nobody answered yet.
 */
export function VerdictIcon({ verdict, size = 14 }: { verdict: Verdict | "unanswered" | "none"; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
      {verdict === "met" && (
        <>
          <circle cx="7" cy="7" r="6.25" fill="var(--color-fg3)" />
          <path d="M4.4 7.2 L6.2 9 L9.7 5.3" fill="none" stroke="var(--color-panel)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {verdict === "partly" && (
        <>
          <circle cx="7" cy="7" r="6" fill="none" stroke="var(--color-fg3)" strokeWidth="1.5" />
          <path d="M7 3 A4 4 0 0 1 7 11 Z" fill="var(--color-fg3)" />
        </>
      )}
      {verdict === "not_met" && (
        <>
          <circle cx="7" cy="7" r="6" fill="none" stroke="var(--color-mut2)" strokeWidth="1.5" />
          <path d="M5 5 L9 9 M9 5 L5 9" fill="none" stroke="var(--color-mut2)" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
      {verdict === "unanswered" && <circle cx="7" cy="7" r="6" fill="none" stroke="var(--color-dim)" strokeWidth="1.5" strokeDasharray="2 2" />}
      {verdict === "none" && <circle cx="7" cy="7" r="2.5" fill="var(--color-faint)" />}
    </svg>
  );
}

export function PriorityIcon({ priority, size = 14 }: { priority: Priority; size?: number }) {
  if (priority === 1) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
        <rect x="0.5" y="0.5" width="13" height="13" rx="3" fill="var(--color-fg3)" />
        <rect x="6.1" y="3" width="1.8" height="5" rx="0.9" fill="var(--color-panel)" />
        <rect x="6.1" y="9.2" width="1.8" height="1.8" rx="0.9" fill="var(--color-panel)" />
      </svg>
    );
  }
  const on = "var(--color-fg3)";
  const off = "var(--color-ctl)";
  const lit = priority === 2 ? 3 : priority === 3 ? 2 : priority === 4 ? 1 : 0;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
      <rect x="1" y="8" width="3" height="5" rx="1" fill={lit >= 1 ? on : off} />
      <rect x="5.5" y="5" width="3" height="8" rx="1" fill={lit >= 2 ? on : off} />
      <rect x="10" y="2" width="3" height="11" rx="1" fill={lit >= 3 ? on : off} />
    </svg>
  );
}

export function ProgressRing({ pct, color, size = 14 }: { pct: number; color: string; size?: number }) {
  const c = 34.56;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="var(--color-track)" strokeWidth="2" />
      <circle cx="8" cy="8" r="5.5" fill="none" stroke={color} strokeWidth="2" strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 8 8)" />
    </svg>
  );
}

export function Diamond({ color, size = 11, hollow = false }: { color: string; size?: number; hollow?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1l5 5-5 5-5-5z" fill={hollow ? "var(--color-panel)" : color} stroke={color} strokeWidth={hollow ? 1.6 : 0} />
    </svg>
  );
}

/* ---------- areas ---------- */

export function AreaIconSvg({ icon, color, size = 14, strokeWidth = 1.8 }: { icon: AreaIcon; color?: string; size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? "currentColor"} strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
      <path d={AREA_ICON_PATHS[icon]} />
    </svg>
  );
}

/** An area's own picture (area-picture.ts), as big as its icon would be. */
export function AreaPicture({ area, size = 14 }: { area: Pick<Area, "id" | "picture">; size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a small PNG from /api/areas, nothing to optimize
    <img src={`/api/areas/${encodeURIComponent(area.id)}/picture?v=${area.picture}`} alt="" width={size} height={size} draggable={false}
      className="shrink-0 rounded-[3px] object-contain" />
  );
}

/** An area's picture, else its icon in its color, else its dot. */
export function AreaMark({ area, size = 14, dot = 7 }: { area: Pick<Area, "id" | "color" | "icon" | "picture">; size?: number; dot?: number }) {
  if (area.picture) return <AreaPicture area={area} size={size} />;
  if (area.icon) return <AreaIconSvg icon={area.icon} color={area.color} size={size} />;
  return <span className="inline-block shrink-0 rounded-full" style={{ width: dot, height: dot, background: area.color }} />;
}
