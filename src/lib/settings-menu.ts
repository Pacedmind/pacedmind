import { createTranslator, type Translator } from "./i18n";
/** Settings' pages, each at /settings/<id> (src/app/(app)/settings/[section]). */
export type SettingsSection =
  | "account" | "plan" | "security" | "computers" | "data"
  | "appearance" | "notifications" | "planning" | "preferences" | "hidden-projects"
  | "computer" | "sessions" | "projects" | "mcp";

export interface SettingsPage {
  id: SettingsSection;
  label: string;
  /** A line under the page's title. */
  hint: string;
}

/** A group in Settings' menu; the first has no label. */
export interface SettingsGroup {
  label: string | null;
  pages: SettingsPage[];
}

/**
 * What Settings has, in its menu's order: the account's pages when signed in (Plan once billing is on), this
 * computer's in the desktop app (the web app has no computer of its own: its agents run on the desktop app's).
 */
export function settingsMenu({ account, plan, desktop }: { account: boolean; plan: boolean; desktop: boolean }, tx: Translator = createTranslator("en")): SettingsGroup[] {
  const page = (id: SettingsSection, label: string, hint: string): SettingsPage => ({ id, label: tx(label), hint: tx(hint) });
  return [
    {
      label: null,
      pages: [
        account
          ? page("account", "Account", "Who you're signed in as, and the computers signed in to your account.")
          : page("account", "Account", "Use PacedMind on your other computers and in the browser too."),
        ...(account && plan ? [page("plan", "Plan", "Your PacedMind Cloud trial or subscription, and paying for it.")] : []),
        ...(account ? [page("security", "Security", "Two-factor sign-in and your password.")] : []),
        page("computers", "Computers", "Your computers, their agents and sessions."),
        page("data", "Data", account ? "What your account holds, moving it, and starting over." : "What this computer keeps, and starting over."),
      ],
    },
    {
      label: tx("Preferences"),
      pages: [
        page("appearance", "Appearance", "How PacedMind looks here."),
        ...(account ? [page("notifications", "Notifications", "When a session needs you, wherever you are.")] : []),
        page("planning", "Planning", "The time the auto-planner fills with focus blocks."),
        page("hidden-projects", "Hidden projects", "Restore projects and their tasks when you are ready to work on them again."),
        page("preferences", "How you work", "What agents follow when they plan your time and write tasks for you."),
      ],
    },
    desktop
      ? {
          label: tx("This computer"),
          pages: [
            page("computer", "General", "This computer's name, and what it does when asked from elsewhere."),
            page("sessions", "Sessions", "How agent sessions start on this computer."),
            page("projects", "Projects", "Area workspaces and each project's folder, agent and MCP servers on this computer."),
            page("mcp", "MCP server", account
              ? "How Claude Code, Codex and other agents reach PacedMind Cloud."
              : "How Claude Code and Codex reach PacedMind."),
          ],
        }
      : {
          label: tx("Agents"),
          pages: [
            page("sessions", "Sessions", "Where agent sessions run."),
            page("projects", "Projects", "Each project's default agent."),
            page("mcp", "MCP server", "How Claude Code, Codex and other agents reach PacedMind Cloud."),
          ],
        },
  ];
}

/**
 * The pages old links named by their anchor on the single Settings page (/settings#connect); the others' anchors
 * were their ids (#plan, #data).
 */
export const OLD_ANCHORS: Record<string, SettingsSection> = {
  devices: "computers",
  "this-computer": "computer",
  connect: "mcp",
  "projects-and-folders": "projects",
};
