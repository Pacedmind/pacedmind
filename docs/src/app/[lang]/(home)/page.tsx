import Link from 'next/link';
import type { Metadata } from 'next';
import { AppIcon, type AppIconName } from '@/components/AppIcon';
import { i18n } from '@/lib/i18n';
import { publicUrl } from '@/lib/source';
import { organizationRef, schemaIds, siteUrl } from '@/lib/shared';

type Lang = 'en';

const copy = {
  en: {
    title: 'PacedMind user guide',
    metaTitle: 'PacedMind Docs',
    lead: 'PacedMind is a personal planner for tasks, time blocks, a calendar and deadlines. It also starts Claude Code and Codex sessions in your own terminals and tracks them until the work is ready for review. This guide explains every part of the app, end to end.',
    primary: 'Start with the installation',
    primaryHref: '/getting-started',
    secondary: 'Connect an agent over MCP',
    secondaryHref: '/mcp',
    available: 'Guides',
    feedback:
      'Every page can be copied as Markdown, or opened in an AI assistant, from the buttons under its title. AI tools can read the whole guide from /docs/llms.txt and /docs/llms-full.txt.',
  },
} satisfies Record<Lang, Record<string, string>>;

type Tile = { title: string; description: string; href: string; icon: AppIconName };

const sections: Record<Lang, Tile[]> = {
  en: [
    {
      title: 'Getting started',
      description: 'Install the desktop app, open it for the first time, and find where PacedMind keeps its data.',
      href: '/getting-started',
      icon: 'play',
    },
    {
      title: 'Concepts',
      description: 'Areas, projects and tasks; statuses, priorities and labels; due and planned dates; who does each task; and how you like to work.',
      href: '/concepts',
      icon: 'layers',
    },
    {
      title: 'Working with tasks',
      description: 'Add tasks with quick add, edit them in the details panel, and find anything with the command menu.',
      href: '/tasks',
      icon: 'pen',
    },
    {
      title: 'Views',
      description: 'Inbox, Today, Upcoming, Calendar, Timeline, Projects, Roadmap and Sessions, one page each.',
      href: '/views',
      icon: 'calendar',
    },
    {
      title: 'Agent sessions',
      description: 'How PacedMind starts Claude Code and Codex in your terminals, tracks them, and hands finished work back for review.',
      href: '/agents',
      icon: 'terminal',
    },
    {
      title: 'Planning and work hours',
      description: 'How the auto-planner fills free focus time with your tasks, and how work hours and work days shape it.',
      href: '/planning',
      icon: 'clock',
    },
    {
      title: 'Team workspaces',
      description: 'Share areas with your team in PacedMind Cloud, invite people, assign tasks to each other, and follow them with webhooks.',
      href: '/team-workspaces',
      icon: 'users',
    },
    {
      title: 'MCP server',
      description: 'Connect Claude Code and Codex to PacedMind, and a reference for all 56 MCP tools.',
      href: '/mcp',
      icon: 'link',
    },
    {
      title: 'Agent skills',
      description: 'Six skills that teach Claude Code and Codex to add work your way, plan, review and run projects in PacedMind.',
      href: '/skills',
      icon: 'box',
    },
    {
      title: 'Desktop app',
      description: 'The window and the tray, notifications for finished sessions, starting with Windows, updating and uninstalling.',
      href: '/desktop-app',
      icon: 'bell',
    },
    {
      title: 'Settings',
      description: 'The account and data, the theme, work hours and how you work, and this computer: its agents, how sessions start, project folders and the MCP server.',
      href: '/settings',
      icon: 'settings',
    },
    {
      title: 'Keyboard shortcuts',
      description: 'Every shortcut in the app, in its dialogs and editors, and in the desktop window.',
      href: '/keyboard-shortcuts',
      icon: 'keyboard',
    },
    {
      title: 'Troubleshooting',
      description: 'Sessions that do not start or do not report back, connection errors, the app not starting, and data questions.',
      href: '/troubleshooting',
      icon: 'flag',
    },
    {
      title: 'Accounts and Cloud',
      description: 'The One device and Cloud plans, the free trial, subscribing, and what happens when Cloud ends.',
      href: '/accounts-and-cloud',
      icon: 'user',
    },
  ],
};

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

export async function generateMetadata(): Promise<Metadata> {
  const lang: Lang = 'en';
  const t = copy[lang];
  const url = publicUrl(lang, []);

  return {
    title: { absolute: t.metaTitle },
    description: t.lead,
    alternates: {
      canonical: url,
      languages: Object.fromEntries(
        i18n.languages
          .map<[string, string]>((l) => [l, publicUrl(l, [])])
          .concat([['x-default', publicUrl(i18n.defaultLanguage, [])]]),
      ),
    },
    openGraph: {
      type: 'website',
      url,
      siteName: 'PacedMind Docs',
      title: t.metaTitle,
      description: t.lead,
      locale: 'en_US',
      // The home page's link preview: the wordmark and "Find your pace." (../site/app/opengraph-image.png).
      images: [{ url: `${siteUrl}/opengraph-image.png`, width: 1200, height: 630, alt: 'PacedMind' }],
    },
    twitter: {
      card: 'summary_large_image',
      title: t.metaTitle,
      description: t.lead,
    },
  };
}

export default async function HomePage() {
  const lang: Lang = 'en';
  const t = copy[lang];

  // A page of pacedmind.com, not a website of its own: the WebSite, the app and the
  // Organization are described on the home page (../site/lib/seo.ts) and referenced here.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: t.metaTitle,
    description: t.lead,
    url: publicUrl(lang, []),
    inLanguage: lang,
    isPartOf: { '@id': schemaIds.website },
    about: { '@id': schemaIds.software },
    publisher: organizationRef,
  };

  return (
    <main className="flex flex-1 flex-col">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <section className="border-b border-fd-border">
        <div className="mx-auto w-full max-w-5xl px-6 py-20 md:py-28">
          <h1 className="font-display text-5xl font-light tracking-tight text-fd-foreground md:text-6xl">
            {t.title}
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-fd-muted-foreground md:text-lg">
            {t.lead}
          </p>
          <div className="mt-8 flex flex-col items-stretch gap-4 sm:flex-row sm:items-center">
            <Link
              href={t.primaryHref}
              className="flex items-center justify-center gap-2 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand/90"
            >
              {t.primary}
              <AppIcon name="arrowRight" size={14} />
            </Link>
            <Link
              href={t.secondaryHref}
              className="flex items-center justify-center gap-2 rounded-md border border-fd-border px-4 py-2 text-sm text-fd-foreground transition-colors hover:bg-fd-accent"
            >
              {t.secondary}
            </Link>
          </div>
        </div>
      </section>

      <section className="border-b border-fd-border">
        <div className="mx-auto w-full max-w-5xl px-6 py-16">
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-fd-muted-foreground">{t.available}</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sections[lang].map(({ title, description, href, icon }) => (
              <Link
                key={href}
                href={href}
                className="group flex h-full flex-col rounded-xl border border-fd-border bg-fd-card p-4 transition-colors hover:bg-fd-accent"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-fd-border bg-fd-background text-tile-icon">
                  <AppIcon name={icon} size={19} />
                </div>
                <h3 className="mt-4 text-base font-medium text-fd-foreground">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">{description}</p>
                <span className="mt-5 inline-flex items-center gap-1.5 text-xs font-medium text-fd-muted-foreground transition-colors group-hover:text-fd-foreground">
                  <AppIcon name="arrowRight" size={14} />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="mx-auto w-full max-w-5xl px-6 py-16">
          <p className="max-w-3xl text-sm leading-relaxed text-fd-muted-foreground">{t.feedback}</p>
        </div>
      </section>
    </main>
  );
}
