/* @jsxImportSource solid-js */

import { Activity, ArrowRight, ArrowUpRight, GitFork, Home, Menu, MessageCircle, Network, ShieldCheck, Sparkles, Terminal, X } from "lucide-solid";
import { createSignal, For, onCleanup, onMount, type JSX } from "solid-js";

import { ROUTES } from "../routes";

interface Signal {
  readonly label: string;
  readonly value: string;
  readonly icon: "activity" | "network" | "shield" | "sparkles" | "terminal";
}

type StoryTheme = "night" | "core" | "blossom" | "voices" | "red" | "denial" | "shore";

interface StoryChapter {
  readonly id: string;
  readonly number: string;
  readonly label: string;
  readonly location: string;
  readonly title: string;
  readonly description: string;
  readonly image: string;
  readonly imageAlt: string;
  readonly theme: StoryTheme;
  readonly signals: readonly Signal[];
}

const ASSET_BASE = import.meta.env.BASE_URL;
const GITHUB_URL = "https://github.com/risunCode/Cartethyia";
const CONSOLE_LOGIN_PATH = ROUTES.consoleLogin;

const storyImage = (name: string): string => `${ASSET_BASE}when_yah/${name}`;
const titleCase = (value: string): string => value.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
const nextChapterLabel = (index: number): string => index === CHAPTERS.length - 1 ? `Back to ${CHAPTERS[0].label}` : `Go to ${titleCase(CHAPTERS[index + 1].location)}`;

const CHAPTERS: readonly StoryChapter[] = [
  {
    id: "blessed-maiden", number: "01", label: "The Blessed Maiden", location: "THE FIRST CROSSING", theme: "night",
    title: "A single signal enters the unknown.",
    description: "Every client begins with one request and a question: where should it go? Cartethyia gives that signal a reliable gateway — self-hosted, authenticated, and ready for the crossing.",
    image: storyImage("fleurdelys_plus.webp"), imageAlt: "The Blessed Maiden beneath a luminous blue sky",
    signals: [{ label: "The first crossing", value: "OPEN", icon: "network" }, { label: "The chosen vessel", value: "YOURS", icon: "shield" }, { label: "The gate", value: "ALIGNED", icon: "sparkles" }],
  },
  {
    id: "resonant-core", number: "02", label: "The Resonant Core", location: "THE ROUTING SANCTUM", theme: "core",
    title: "The route becomes the power.",
    description: "One surface can speak to many providers. Cartethyia translates protocols, balances targets, and keeps each request moving through the right vessel — even when the first path goes quiet.",
    image: storyImage("cartethyia-god.webp"), imageAlt: "Cartethyia surrounded by a celestial blue routing field",
    signals: [{ label: "The many voices", value: "30+", icon: "network" }, { label: "The bridge", value: "ALIGNED", icon: "terminal" }, { label: "The fallback", value: "AWARE", icon: "activity" }],
  },
  {
    id: "pink-blossom", number: "03", label: "The Pink Blossom Calm", location: "THE QUIET CONTROL", theme: "blossom",
    title: "Behind every powerful system, there is a quiet place to govern.",
    description: "Observe the flow, tune the balance, and let the models answer. Provider accounts, credentials, usage, and health stay in one calm console built for the person operating the route.",
    image: storyImage("jinhsi-blossom.webp"), imageAlt: "Jinhsi beneath soft pink blossoms",
    signals: [{ label: "The quiet engine", value: "AWAKE", icon: "activity" }, { label: "The studio", value: "READY", icon: "sparkles" }, { label: "The balance", value: "HELD", icon: "shield" }],
  },
  {
    id: "many-voices", number: "04", label: "The Many Voices", location: "THE LIVING NETWORK", theme: "voices",
    title: "Every route carries a living world.",
    description: "Providers, clients, and models bring different voices to the crossing. Cartethyia gives them one dependable gateway without silencing what makes each path unique.",
    image: storyImage("wuthering-waves-hiyuki-aemeath-hiyuki-rover.webp"), imageAlt: "A bright celebration of characters and connected voices",
    signals: [{ label: "The many voices", value: "CONNECTED", icon: "network" }, { label: "The shared world", value: "OPEN", icon: "sparkles" }, { label: "The crossing", value: "ALIGNED", icon: "terminal" }],
  },
  {
    id: "red-thread", number: "05", label: "The Red Thread", location: "THE FRACTURED PATH", theme: "red",
    title: "A beautiful signal can still be dangerous.",
    description: "Every powerful route attracts pressure. Cartethyia watches the boundary, rejects hostile paths, and keeps a single failure from tearing through the whole network.",
    image: storyImage("phrolova-a.webp"), imageAlt: "A figure surrounded by dark red threads and fractured signals",
    signals: [{ label: "The threat", value: "SEEN", icon: "activity" }, { label: "The boundary", value: "HELD", icon: "shield" }, { label: "The fallback", value: "READY", icon: "network" }],
  },
  {
    id: "request-denial", number: "06", label: "The Gate of Discernment", location: "THE GATE OF DISCERNMENT", theme: "denial",
    title: "Not every signal should pass.",
    description: "Every game needs a gatekeeper. Cartethyia verifies intent, protects the route, and denies the requests that would fracture the system.",
    image: storyImage("requestdeniawokkjpg.webp"), imageAlt: "A radiant gatekeeper surrounded by cascading signals",
    signals: [{ label: "The verdict", value: "CLEAR", icon: "shield" }, { label: "The boundary", value: "GUARDED", icon: "network" }, { label: "The route", value: "TRUSTED", icon: "sparkles" }],
  },
  {
    id: "shorekeeper", number: "07", label: "The Open Shore", location: "THE SHOREKEEPER", theme: "shore",
    title: "The gateway is yours to shape.",
    description: "Find your way back to the source, share your route, and join the people building a dependable gateway across a changing AI landscape.",
    image: storyImage("Shorekeeper.webp"), imageAlt: "Shorekeeper watching over a luminous open shore",
    signals: [{ label: "The source", value: "OPEN", icon: "terminal" }, { label: "The shore", value: "AWAITS", icon: "network" }, { label: "The next step", value: "YOURS", icon: "sparkles" }],
  },
];

const signalIcons = { activity: Activity, network: Network, shield: ShieldCheck, sparkles: Sparkles, terminal: Terminal };

function SignalRow(props: { readonly signal: Signal }): JSX.Element {
  const Icon = signalIcons[props.signal.icon];
  return <div class="story-signal"><Icon size={13} aria-hidden={true} /><span>{props.signal.label}</span><strong>{props.signal.value}</strong></div>;
}

export function LandingPage(): JSX.Element {
  const [activeIndex, setActiveIndex] = createSignal(0);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [revealedChapters, setRevealedChapters] = createSignal<ReadonlySet<number>>(new Set([0]));
  const sectionRefs: Array<HTMLElement | undefined> = [];

  onMount(() => {
    document.title = "Cartethyia — The One-Stop AI Proxy Router";
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      if (visible !== undefined) {
        const index = Number((visible.target as HTMLElement).dataset.chapterIndex);
        setActiveIndex(index);
        setRevealedChapters((current) => current.has(index) ? current : new Set([...current, index]));
      }
    }, { threshold: [0.35, 0.6, 0.85] });
    sectionRefs.forEach((section) => { if (section !== undefined) observer.observe(section); });
    const handleKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=\"true\"]")) return;
      if (event.key === "ArrowDown" || event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        scrollToChapter(Math.min(CHAPTERS.length - 1, activeIndex() + 1));
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        scrollToChapter(Math.max(0, activeIndex() - 1));
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener("keydown", handleKeyDown);
    });
  });

  const scrollToChapter = (index: number): void => {
    setMenuOpen(false);
    sectionRefs[index]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div class={`story story-simple story-theme-${CHAPTERS[activeIndex()]?.theme ?? "night"}`} id="top">
      <header class="story-header">
        <div class="story-shell story-header-inner">
          <a class="story-brand" href="#top" onClick={(event) => { event.preventDefault(); scrollToChapter(0); }}>
            <span class="story-brand-mark"><img src={`${ASSET_BASE}favicon.webp`} alt="" /></span>
            <span><strong>Cartethyia</strong><small>AI PROXY ROUTER</small></span>
          </a>
          <nav class="story-desktop-nav" aria-label="Primary navigation">
            <button type="button" onClick={() => scrollToChapter(0)}><Home size={14} aria-hidden={true} />Home</button>
            <a href={CONSOLE_LOGIN_PATH}><Terminal size={14} aria-hidden={true} />Console</a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer"><GitFork size={14} aria-hidden={true} />Source</a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer"><MessageCircle size={14} aria-hidden={true} />Community</a>
          </nav>
          <div class="story-header-actions">
            <a class="story-console-link" href={CONSOLE_LOGIN_PATH}>Enter console<ArrowUpRight size={14} aria-hidden={true} /></a>
            <button class="story-menu-button" type="button" aria-label={menuOpen() ? "Close menu" : "Open menu"} aria-expanded={menuOpen()} onClick={() => setMenuOpen((open) => !open)}>{menuOpen() ? <X size={17} aria-hidden={true} /> : <Menu size={17} aria-hidden={true} />}</button>
          </div>
        </div>
        {menuOpen() && <nav class="story-mobile-nav" aria-label="Mobile navigation"><For each={CHAPTERS}>{(entry, index) => <button type="button" onClick={() => scrollToChapter(index())}><span>{entry.number}</span>{entry.label}<ArrowUpRight size={13} aria-hidden={true} /></button>}</For><a href={CONSOLE_LOGIN_PATH}>Enter console<ArrowUpRight size={14} aria-hidden={true} /></a></nav>}
      </header>

      <main class="story-simple-main">
        <For each={CHAPTERS}>
          {(entry, index) => (
            <article id={`chapter-${index()}`} data-chapter-index={index()} ref={(node) => { sectionRefs[index()] = node; }} class={`story-page-section story-theme-${entry.theme} ${revealedChapters().has(index()) ? "is-revealed" : ""}`} aria-labelledby={`chapter-title-${index()}`}>
              <div class="story-page-ambient" style={{ "background-image": `url(${entry.image})` }} aria-hidden={true} />
              <div class="story-page-shell story-shell">
                <div class="story-page-copy">
                  <p class="story-location">{entry.location}</p>
                  <h1 id={`chapter-title-${index()}`}>{entry.title}</h1>
                  <p class="story-description">{entry.description}</p>
                  <div class="story-signals"><For each={entry.signals}>{(signal) => <SignalRow signal={signal} />}</For></div>
                  <div class="story-page-actions">
                    <button class="story-button story-button-secondary" type="button" onClick={() => scrollToChapter(index() === CHAPTERS.length - 1 ? 0 : index() + 1)}>{nextChapterLabel(index())}<ArrowRight size={15} aria-hidden={true} /></button>
                  </div>
                </div>
                <figure class="story-page-visual">
                  <img src={entry.image} alt={entry.imageAlt} loading={index() === 0 ? "eager" : "lazy"} fetchpriority={index() === 0 ? "high" : "low"} decoding="async" />
                  <figcaption>{entry.location} <span>{entry.number}</span></figcaption>
                </figure>
              </div>
            </article>
          )}
        </For>
      </main>

    </div>
  );
}
