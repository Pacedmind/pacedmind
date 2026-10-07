import type { Metadata } from "next";
import Link from "next/link";
import { H2, LegalPage, List, Mail } from "@/components/legal";
import { pageMetadata } from "@/lib/seo";
import { SITE } from "@/lib/site";

export const metadata: Metadata = pageMetadata("/support", {
  title: "Help and support",
  description: "Get help with PacedMind: the documentation, connecting ChatGPT, Claude and other agents, your account, and how to reach us.",
});

const link = "underline underline-offset-2 hover:text-ink";

export default function Support() {
  return (
    <LegalPage title="Help and support" updated={false}>
      <p>
        Write to <Mail /> with what you did, what you expected and what happened instead. From your account&rsquo;s email address
        we can find your account; never send us a password, a two-factor code or a token.
      </p>

      <H2>Documentation</H2>
      <List items={[
        <><a href={`${SITE.docs}/getting-started`} className={link}>Getting started</a>: installing the desktop app, your first areas, projects and tasks.</>,
        <><a href={`${SITE.docs}/mcp/claude-and-chatgpt`} className={link}>PacedMind in Claude and ChatGPT</a>: adding PacedMind to Claude, ChatGPT, Claude Code and Codex, and what they can do with it.</>,
        <><a href={`${SITE.docs}/mcp/connect-cloud`} className={link}>Connect to PacedMind Cloud</a>: every agent and MCP client, step by step.</>,
        <><a href={`${SITE.docs}/troubleshooting`} className={link}>Troubleshooting</a>: what to check when something doesn&rsquo;t work.</>,
      ]} />

      <H2>ChatGPT, Claude and other agents</H2>
      <p>
        An agent you connect signs in with your PacedMind Cloud account, and you allow it on PacedMind&rsquo;s own page. If
        connecting fails, start again from the agent and sign in to the same account; with two-factor sign-in enabled, finish its
        code step first. To end an agent&rsquo;s access, open PacedMind and select <strong>Disconnect</strong> next to it in{" "}
        <strong>Settings → Connected agents</strong>. What a connected service keeps of your conversations is managed in that service.
      </p>

      <H2>Your account and subscription</H2>
      <List items={[
        <><a href={`${SITE.app}/login`} className={link}>Sign in</a>, or reset your password with <strong>Forgot your password?</strong> there.</>,
        <>Your subscription and invoices: <strong>Settings → Plan → Manage billing</strong>. The <Link href="/refunds" className={link}>refund policy</Link> says when you get money back.</>,
        <><Link href="/delete-account" className={link}>Delete your account</Link> from any browser.</>,
        <>What we keep about you and why: the <Link href="/privacy" className={link}>privacy policy</Link>.</>,
      ]} />

      <H2>Bugs and ideas</H2>
      <p>
        PacedMind is open source. You can report a bug or suggest a change in the{" "}
        <a href={`${SITE.source}/issues`} className={link}>issues on GitHub</a>; leave your tasks and personal details out of it.
      </p>

      <H2>Security</H2>
      <p>
        Report a security problem privately, not in a public issue: select <strong>Report a vulnerability</strong> on the
        repository&rsquo;s <a href={`${SITE.source}/security`} className={link}>Security tab</a>, or write to <Mail />.
      </p>
    </LegalPage>
  );
}
