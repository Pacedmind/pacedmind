import Link from "next/link";
import type { StaticImageData } from "next/image";
import prices from "@/prices.json";
import { SITE, downloadEvent, signInEvent, sourceEvent } from "@/lib/site";
import type { Market } from "@/lib/markets";
import { CLOUD, CONNECT, DAY, DOWNLOAD_NOTE, FAQ, ONE_DEVICE, OPEN_SOURCE, PLACES, PRICING, SUMMARY, TAGLINE, TRY, VIEWS as VIEW_COPY } from "@/lib/content";
import { faqPage, graph, pageMetadata, softwareApplication, softwareSourceCode } from "@/lib/seo";
import { starsAtBuild } from "@/lib/github";
import { JsonLd } from "@/components/json-ld";
import { Emblem } from "@/components/emblem";
import { GitHubMark } from "@/components/github-mark";
import { StarCount } from "@/components/star-count";
import { Wordmark } from "@/components/wordmark";
import { ScreenDeck, type DeckItem } from "@/components/screen-deck";
import { Icon, SCREEN } from "@/components/screens/parts";
import { Connect, ConnectAnchors } from "@/components/connect";
import { DeparturesBoard } from "@/components/departures-board";
import { DayStrip } from "@/components/day-strip";
import { CommandPalette } from "@/components/command-palette";
import { CountryPicker, PlanPrice } from "@/components/plan-price";
import todayLight from "@/screens/today-light.webp";
import todayDark from "@/screens/today-dark.webp";
import weekLight from "@/screens/week-light.webp";
import weekDark from "@/screens/week-dark.webp";
import timelineLight from "@/screens/timeline-light.webp";
import timelineDark from "@/screens/timeline-dark.webp";

export const metadata = pageMetadata("/");

// Only what the price needs reaches the browser.
const markets: Market[] = Object.entries(prices.markets)
  .map(([code, { name, currency, locale, amount }]) => ({ code, name, currency, locale, amount }))
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * A screenshot of the app (site/screens, taken by `npm run screenshots` in the app from its sample data), in the page's
 * theme. All of them show in the first view, the first one in front, which the browser fetches first.
 */
function Shot({ light, dark, alt, first = false }: { light: StaticImageData; dark: StaticImageData; alt: string; first?: boolean }) {
  return (
    <picture>
      <source media="(prefers-color-scheme: dark)" srcSet={dark.src} />
      <img src={light.src} width={SCREEN.w} height={SCREEN.h} alt={alt} fetchPriority={first ? "high" : "low"} decoding="async"
        className="block h-full w-full rounded-[14px] border border-app-line2 bg-app-bg" />
    </picture>
  );
}

// The screens render here, on the server; the deck only moves them.
const SCREENS = {
  Today: <Shot first light={todayLight} dark={todayDark}
    alt="PacedMind's Today view: the day's events, then the tasks that are overdue, due today and planned for today, one with an agent's session finished." />,
  Week: <Shot light={weekLight} dark={weekDark}
    alt="PacedMind's week calendar: events, planned tasks and agent sessions by the hour, beside the tasks still to plan." />,
  Timeline: <Shot light={timelineLight} dark={timelineDark}
    alt="PacedMind's Timeline: a project's tasks over the coming weeks, with the tasks each one waits for, an agent's finished session and the deadlines." />,
};
const VIEWS: DeckItem[] = VIEW_COPY.map((view) => ({ ...view, screen: SCREENS[view.tab] }));

// Beside the text, the screens take the column's width. In a short window they give up to 120 px of it, so the
// header, the padding and the tabs and caption (372 px together) fit around a 990 × 666 deck; narrower still,
// the caption goes below the fold. They keep to the column's right edge, under the menu.
const DECK_WIDTH = "lg:justify-self-end lg:w-[min(100%,max(100%_-_120px,calc((100svh_-_372px)*1.4865)))]";

/** A section's heading: a line in ink and one in grey, like the pricing's, and the paragraph under them. */
function Heading({ title, subtitle, intro }: { title: string; subtitle: string; intro?: string }) {
  return (
    <>
      <h2 className="max-w-[24em] text-[clamp(30px,3.9vw,46px)] leading-[1.15] font-light tracking-[-0.01em] text-balance text-ink">
        {title}{" "}
        <span className="block text-mut">{subtitle}</span>
      </h2>
      {intro && <p className="mt-6 max-w-[640px] text-[16px] leading-[1.6] text-balance text-text sm:mt-8 sm:text-[18px]">{intro}</p>}
    </>
  );
}

export default async function Home() {
  // The stars as the page is built; in the browser, StarCount swaps in the count the server keeps current.
  const stars = await starsAtBuild();
  const [owner, repo] = SITE.repo.split("/");
  return (
    <>
      <JsonLd data={graph(softwareApplication(), softwareSourceCode(), faqPage(FAQ))} />
      <header className="mx-auto flex h-[76px] max-w-[1440px] items-center justify-between px-5 sm:px-8">
        <Link href="/" aria-label="PacedMind" className="rounded-[7px]"><Emblem size={30} /></Link>
        <nav className="flex items-center gap-[18px] text-[16px] text-mut sm:gap-[30px]">
          <a href="#connect" className="hover:text-ink max-md:hidden">Connect</a>
          <a href="#agents" className="hover:text-ink max-sm:hidden">Agents</a>
          <a href="#pricing" className="hover:text-ink">Pricing</a>
          <a href={SITE.docs} className="hover:text-ink">Docs</a>
          {/* On phones the mark stands for the word, and the narrowest have room for the mark alone. */}
          <a href={SITE.source} className="group flex items-center gap-2 hover:text-ink" {...sourceEvent("header")}>
            <GitHubMark size={18} />
            <span className="max-sm:sr-only">GitHub</span>
            <StarCount initial={stars}
              className="text-[14px] max-[359px]:hidden sm:h-6 sm:rounded-full sm:border sm:border-line sm:px-2 sm:group-hover:border-mut" />
          </a>
          <a href={SITE.app} className="rounded-[10px] border border-line px-4 py-2 font-medium whitespace-nowrap text-ink hover:border-mut" {...signInEvent("header")}>
            Sign in
          </a>
        </nav>
      </header>

      <main className="mx-auto max-w-[1440px] px-5 sm:px-8">
        {/*
          The first view: the promise on the left and the app on the right, centered on the same line, with the tabs
          and the caption under the screens. The screens end where the menu does. Narrower windows stack them.
        */}
        <section className="grid pt-[clamp(40px,8vh,88px)] lg:min-h-[calc(100svh-76px)] lg:grid-cols-[380px_minmax(0,1fr)] lg:content-center lg:items-center lg:gap-x-16 lg:py-12 xl:grid-cols-[440px_minmax(0,1fr)] xl:gap-x-24">
          <div className="mb-16 lg:mb-0">
            <h1><Wordmark id="hero-wordmark" unfold className="w-full max-w-[560px] text-ink lg:max-w-[380px] xl:max-w-[440px]" /></h1>
            <p className="mt-8 text-[clamp(32px,4vw,46px)] leading-[1.08] font-light tracking-[-0.01em] text-ink sm:mt-10">
              {TAGLINE}
            </p>
            <p className="mt-5 max-w-[520px] text-[18px] leading-[1.55] text-pretty text-mut">{SUMMARY}</p>
            <div className="mt-9 flex flex-wrap gap-3">
              <a className="download" data-os="windows" href={SITE.downloads.windows} {...downloadEvent("windows", "hero")}>Download for Windows</a>
              <a className="download" data-os="mac" href={SITE.downloads.mac} {...downloadEvent("mac", "hero")}>Download for macOS</a>
            </div>
            <p className="mt-4 text-[15px] text-mut">
              {DOWNLOAD_NOTE}{" "}
              <a href="#open-source" className="whitespace-nowrap underline decoration-line underline-offset-4 hover:text-ink hover:decoration-mut">{OPEN_SOURCE.hero}</a>
            </p>
            {/* The quick way to an agent: each link opens its steps in the Connect section. */}
            <nav aria-label="Connect your agent" className="mt-9 border-t border-line pt-6">
              <p className="text-[15px] text-mut">{CONNECT.hero}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {CONNECT.agents.filter((a) => a.id !== "other").map((a) => (
                  <a key={a.id} href={`#connect-${a.id}`}
                    className="flex h-9 items-center gap-2 rounded-[9px] border border-line px-3 text-[15px] text-text hover:border-mut hover:text-ink">
                    <Icon name={a.icon} size={14} className="text-mut" />
                    {a.name}
                  </a>
                ))}
              </div>
            </nav>
          </div>
          <ScreenDeck items={VIEWS} className={{ stage: `min-w-0 ${DECK_WIDTH}`, controls: `lg:col-start-2 ${DECK_WIDTH}` }} />
        </section>

        {/*
          Connecting the agent you use, right under the promise: pick it, run one command or add it with one click, then
          allow it in the browser. The hero's links to one agent land at the top and pick it.
        */}
        <section id="connect" className="relative mt-24 scroll-mt-8 sm:mt-[150px]">
          <ConnectAnchors />
          <Heading title={CONNECT.title} subtitle={CONNECT.subtitle} intro={CONNECT.intro} />
          <Connect className="mt-12 sm:mt-16" />
        </section>

        {/*
          Between the hero and the pricing, one day two ways: your day beside the agents' (the day strip) and where each
          session runs (the board). Their widgets, and the command palette's results, share the day's tasks and times.
        */}
        <section id="day" className="mt-24 scroll-mt-8 sm:mt-[150px]">
          <Heading title={DAY.title} subtitle={DAY.subtitle} intro={DAY.intro} />
          <DayStrip className="mt-12 sm:mt-16" />
        </section>

        {/* The day's sessions on a board, then the places they run in, and a place kept for the agents still to come. */}
        <section id="agents" className="mt-24 scroll-mt-8 sm:mt-[150px]">
          <Heading title={PLACES.title} subtitle={PLACES.subtitle} intro={PLACES.intro} />
          <DeparturesBoard className="mt-12 sm:mt-16" />
          <ul className="mt-16 grid gap-x-14 gap-y-10 border-t border-line pt-12 sm:mt-20 md:grid-cols-3 md:pt-14">
            {PLACES.items.map(({ icon, name, body }) => (
              <li key={name}>
                <Icon name={icon} size={22} strokeWidth={1.6} className="text-mut" />
                <p className="mt-4 text-[17px] text-ink sm:text-[18px]">{name}</p>
                <p className="mt-1.5 text-[16px] leading-[1.6] text-mut">{body}</p>
              </li>
            ))}
          </ul>
          <p className="mt-10 max-w-[720px] text-[16px] leading-[1.6] text-text">{PLACES.note}</p>
          <div className="mt-12 flex flex-wrap items-center gap-x-6 gap-y-4 border-t border-line pt-10">
            <div aria-hidden="true" className="flex items-center gap-2 text-[15px]">
              {["Claude Code", "Codex"].map((agent) => (
                <span key={agent} className="flex h-9 items-center gap-2 rounded-[9px] border border-line px-3 text-ink">
                  <Icon name="terminal" size={15} className="text-mut" />{agent}
                </span>
              ))}
              <span className="flex h-9 w-12 items-center justify-center rounded-[9px] border border-dashed border-mut/60 text-mut">
                <Icon name="plus" size={15} />
              </span>
            </div>
            <p className="text-[16px] text-text sm:text-[18px]">{PLACES.harnesses}</p>
          </div>
        </section>

        <section id="try" className="mt-24 scroll-mt-8 sm:mt-[150px]">
          <Heading title={TRY.title} subtitle={TRY.subtitle} />
          <CommandPalette className="mt-12 sm:mt-16" />
        </section>

        {/* The repository with the commands that build it, then what anyone can do with the code. */}
        <section id="open-source" className="mt-24 scroll-mt-8 sm:mt-[150px]">
          <Heading title={OPEN_SOURCE.title} subtitle={OPEN_SOURCE.subtitle} intro={OPEN_SOURCE.intro} />
          <div className="mt-12 overflow-hidden rounded-[14px] border border-line sm:mt-16">
            <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 border-b border-line px-5 py-4 sm:px-7">
              <a href={SITE.source} className="flex items-center gap-3 text-[17px] text-ink underline-offset-4 hover:underline sm:text-[18px]" {...sourceEvent("open-source")}>
                <GitHubMark size={22} />
                <span>{owner}<span className="mx-1.5 text-mut">/</span>{repo}</span>
              </a>
              <div className="flex items-center gap-5 text-[15px] text-mut">
                <a href={SITE.license} className="hover:text-ink">{OPEN_SOURCE.license}</a>
                <StarCount initial={stars} className="h-6 rounded-full border border-line px-2 text-[14px]" />
              </div>
            </div>
            <pre className="overflow-x-auto px-5 py-6 font-mono text-[14px] leading-[1.9] text-text sm:px-7 sm:py-7 sm:text-[15px]">
              <code>
                {OPEN_SOURCE.commands.map((command) => (
                  <span key={command} className="block"><span aria-hidden="true" className="text-mut select-none">$ </span>{command}</span>
                ))}
              </code>
            </pre>
          </div>
          <ul className="mt-16 grid gap-x-14 gap-y-10 border-t border-line pt-12 sm:mt-20 md:grid-cols-3 md:pt-14">
            {OPEN_SOURCE.items.map(({ icon, name, body, link, href }) => (
              <li key={name} className="flex flex-col items-start">
                <Icon name={icon} size={22} strokeWidth={1.6} className="text-mut" />
                <p className="mt-4 text-[17px] text-ink sm:text-[18px]">{name}</p>
                <p className="mt-1.5 mb-4 text-[16px] leading-[1.6] text-mut">{body}</p>
                {/* Side by side, the links line up at the bottom. */}
                <a href={href} className="mt-auto text-[16px] text-text underline decoration-line underline-offset-4 hover:text-ink hover:decoration-mut"
                  {...(href.startsWith(SITE.source) ? sourceEvent("open-source") : {})}>
                  {link}
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-10 max-w-[720px] text-[16px] leading-[1.6] text-text">{OPEN_SOURCE.note}</p>
        </section>

        <section id="pricing" className="mt-24 scroll-mt-8 sm:mt-[150px]">
          <h2 className="max-w-[20em] text-[clamp(30px,3.9vw,46px)] leading-[1.15] font-light tracking-[-0.01em] text-ink">
            {PRICING.title}{" "}
            <span className="block text-mut">{PRICING.subtitle}</span>
          </h2>
          <div className="mt-6 flex flex-wrap items-baseline gap-x-8 gap-y-3 sm:mt-8">
            <p className="text-[16px] text-text sm:text-[18px]">{PRICING.plans}</p>
            <CountryPicker markets={markets} fallback={prices.fallback} />
          </div>
          <div className="mt-10 grid border-t border-line sm:mt-12 md:grid-cols-2">
            <div className="pb-12 pt-10 md:pr-14">
              <h3 className="text-[22px] font-medium text-ink">One device</h3>
              <p className="mt-6 text-[46px] leading-none font-light text-ink">Free</p>
              <ul className="mt-8 space-y-3 text-[16px] text-text">
                {ONE_DEVICE.map((item) => <li key={item}>{item}</li>)}
              </ul>
              <a className="download for-windows mt-10" href={SITE.downloads.windows} {...downloadEvent("windows", "pricing")}>Download for Windows</a>
              <a className="download for-mac mt-10" href={SITE.downloads.mac} {...downloadEvent("mac", "pricing")}>Download for macOS</a>
            </div>
            <div className="border-t border-line pb-12 pt-10 md:border-l md:border-t-0 md:pl-14">
              <h3 className="text-[22px] font-medium text-ink">Cloud</h3>
              <div className="mt-6"><PlanPrice markets={markets} fallback={prices.fallback} yearlyMonths={prices.yearlyMonths} /></div>
              <ul className="mt-8 space-y-3 text-[16px] text-text">
                {CLOUD.map((item) => <li key={item}>{item}</li>)}
              </ul>
              {SITE.cloudOpen
                ? <a className="download mt-10" href={SITE.createAccount}>Start 7 days free</a>
                : <p className="mt-10 flex h-12 items-center text-[16px] text-mut">Coming soon</p>}
            </div>
          </div>
        </section>

        {/* The same questions and answers are in the page's FAQPage data and in /llms-full.txt. */}
        <section id="faq" className="mt-24 scroll-mt-8 sm:mt-[150px]">
          <h2 className="text-[clamp(30px,3.9vw,46px)] leading-[1.15] font-light tracking-[-0.01em] text-ink">
            Frequently asked questions
          </h2>
          <div className="mt-12 border-t border-line sm:mt-16">
            {FAQ.map(({ question, answer }) => (
              <div key={question} className="grid gap-3 border-b border-line py-8 md:grid-cols-2 md:gap-0 md:py-10">
                <h3 className="text-[19px] leading-[1.35] font-medium text-ink sm:text-[20px] md:pr-14">{question}</h3>
                <p className="text-[16px] leading-[1.6] text-mut sm:text-[18px] md:pl-14">{answer}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="mx-auto mt-24 max-w-[1440px] px-5 sm:mt-32 sm:px-8">
        <div className="flex items-center justify-between border-t border-line py-8 text-[15px] text-mut">
          <span className="flex items-center gap-3 text-text"><Emblem size={20} />PacedMind</span>
          <div className="flex flex-wrap justify-end gap-x-6 gap-y-2">
            <a href={SITE.docs} className="hover:text-ink">Docs</a>
            <a href={SITE.source} className="hover:text-ink" {...sourceEvent("footer")}>GitHub</a>
            <a href={SITE.app} className="hover:text-ink" {...signInEvent("footer")}>Sign in</a>
            <Link href="/terms" className="hover:text-ink">Terms</Link>
            <Link href="/privacy" className="hover:text-ink">Privacy</Link>
            <Link href="/refunds" className="hover:text-ink">Refunds</Link>
            <Link href="/support" className="hover:text-ink">Support</Link>
            <a href={`mailto:${SITE.operator.email}`} className="hover:text-ink">Contact</a>
            <span>© 2026 {SITE.operator.name}</span>
          </div>
        </div>
      </footer>
    </>
  );
}
