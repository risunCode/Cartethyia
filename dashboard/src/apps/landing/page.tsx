import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { Activity, ArrowRight, ArrowUpRight, Home, Menu, MessageCircle, Network, ShieldCheck, Sparkles, Terminal, X } from "lucide-react";
import { GITHUB_REPO_URL, GithubBadge } from "../../components/patterns/github-badge";
import { useReducedMotion } from "../../hooks/use-reduced-motion";

type SignalIconName = "activity" | "network" | "shield" | "sparkles" | "terminal";
type StoryTheme = "night" | "core" | "blossom" | "voices" | "red" | "denial" | "shore";
type StoryStyle = CSSProperties & {
  readonly "--story-accent": string;
};

interface Signal {
  readonly label: string;
  readonly value: string;
  readonly icon: SignalIconName;
}

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
const CONSOLE_PATH = "/console";
const STORY_THEME_STYLES: Record<StoryTheme, StoryStyle> = {
  night: { "--story-accent": "var(--color-story-night)" },
  core: { "--story-accent": "var(--color-story-core)" },
  blossom: { "--story-accent": "var(--color-story-blossom)" },
  voices: { "--story-accent": "var(--color-story-voices)" },
  red: { "--story-accent": "var(--color-story-red)" },
  denial: { "--story-accent": "var(--color-story-denial)" },
  shore: { "--story-accent": "var(--color-story-shore)" },
};

const storyImage = (name: string): string => `${ASSET_BASE}assets/story/${name}`;
const titleCase = (value: string): string => value.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
const nextChapterLabel = (index: number): string => {
  const next = CHAPTERS[index + 1];
  if (next === undefined) return `Back to ${CHAPTERS[0]?.label ?? "the beginning"}`;
  return `Go to ${titleCase(next.location)}`;
};

const CHAPTERS: readonly StoryChapter[] = [
  {
    id: "blessed-maiden",
    number: "01",
    label: "The Blessed Maiden",
    location: "THE FIRST CROSSING",
    theme: "night",
    title: "A single signal enters the unknown.",
    description:
      "Every client begins with one request and a question: where should it go? Cartethyia gives that signal a reliable gateway — self-hosted, authenticated, and ready for the crossing.",
    image: storyImage("fleurdelys_plus.webp"),
    imageAlt: "The Blessed Maiden beneath a luminous blue sky",
    signals: [
      { label: "The first crossing", value: "OPEN", icon: "network" },
      { label: "The chosen vessel", value: "YOURS", icon: "shield" },
      { label: "The gate", value: "ALIGNED", icon: "sparkles" },
    ],
  },
  {
    id: "resonant-core",
    number: "02",
    label: "The Resonant Core",
    location: "THE ROUTING SANCTUM",
    theme: "core",
    title: "The route becomes the power.",
    description:
      "One surface can speak to many providers. Cartethyia translates protocols, balances targets, and keeps each request moving through the right vessel — even when the first path goes quiet.",
    image: storyImage("cartethyia-god.webp"),
    imageAlt: "Cartethyia surrounded by a celestial blue routing field",
    signals: [
      { label: "The many voices", value: "30+", icon: "network" },
      { label: "The bridge", value: "ALIGNED", icon: "terminal" },
      { label: "The fallback", value: "AWARE", icon: "activity" },
    ],
  },
  {
    id: "pink-blossom",
    number: "03",
    label: "The Pink Blossom Calm",
    location: "THE QUIET CONTROL",
    theme: "blossom",
    title: "Behind every powerful system, there is a quiet place to govern.",
    description:
      "Observe the flow, tune the balance, and let the models answer. Provider accounts, credentials, usage, and health stay in one calm console built for the person operating the route.",
    image: storyImage("jinhsi-blossom.webp"),
    imageAlt: "Jinhsi beneath soft pink blossoms",
    signals: [
      { label: "The quiet engine", value: "AWAKE", icon: "activity" },
      { label: "The studio", value: "READY", icon: "sparkles" },
      { label: "The balance", value: "HELD", icon: "shield" },
    ],
  },
  {
    id: "many-voices",
    number: "04",
    label: "The Many Voices",
    location: "THE LIVING NETWORK",
    theme: "voices",
    title: "Every route carries a living world.",
    description:
      "Providers, clients, and models bring different voices to the crossing. Cartethyia gives them one dependable gateway without silencing what makes each path unique.",
    image: storyImage("wuthering-waves-hiyuki-aemeath-hiyuki-rover.webp"),
    imageAlt: "A bright celebration of characters and connected voices",
    signals: [
      { label: "The many voices", value: "CONNECTED", icon: "network" },
      { label: "The shared world", value: "OPEN", icon: "sparkles" },
      { label: "The crossing", value: "ALIGNED", icon: "terminal" },
    ],
  },
  {
    id: "red-thread",
    number: "05",
    label: "The Red Thread",
    location: "THE FRACTURED PATH",
    theme: "red",
    title: "A beautiful signal can still be dangerous.",
    description:
      "Every powerful route attracts pressure. Cartethyia watches the boundary, rejects hostile paths, and keeps a single failure from tearing through the whole network.",
    image: storyImage("phrolova-a.webp"),
    imageAlt: "A figure surrounded by dark red threads and fractured signals",
    signals: [
      { label: "The threat", value: "SEEN", icon: "activity" },
      { label: "The boundary", value: "HELD", icon: "shield" },
      { label: "The fallback", value: "READY", icon: "network" },
    ],
  },
  {
    id: "request-denial",
    number: "06",
    label: "The Gate of Discernment",
    location: "THE GATE OF DISCERNMENT",
    theme: "denial",
    title: "Not every signal should pass.",
    description:
      "Every game needs a gatekeeper. Cartethyia verifies intent, protects the route, and denies the requests that would fracture the system.",
    image: storyImage("requestdeniawokkjpg.webp"),
    imageAlt: "A radiant gatekeeper surrounded by cascading signals",
    signals: [
      { label: "The verdict", value: "CLEAR", icon: "shield" },
      { label: "The boundary", value: "GUARDED", icon: "network" },
      { label: "The route", value: "TRUSTED", icon: "sparkles" },
    ],
  },
  {
    id: "shorekeeper",
    number: "07",
    label: "The Open Shore",
    location: "THE SHOREKEEPER",
    theme: "shore",
    title: "The gateway is yours to shape.",
    description:
      "Find your way back to the source, share your route, and join the people building a dependable gateway across a changing AI landscape.",
    image: storyImage("Shorekeeper.webp"),
    imageAlt: "Shorekeeper watching over a luminous open shore",
    signals: [
      { label: "The source", value: "OPEN", icon: "terminal" },
      { label: "The shore", value: "AWAITS", icon: "network" },
      { label: "The next step", value: "YOURS", icon: "sparkles" },
    ],
  },
];

const signalIcons: Record<SignalIconName, typeof Activity> = {
  activity: Activity,
  network: Network,
  shield: ShieldCheck,
  sparkles: Sparkles,
  terminal: Terminal,
};

function SignalRow({ signal }: { readonly signal: Signal }): ReactElement {
  const Icon = signalIcons[signal.icon];
  return (
    <div className="flex min-w-0 items-center gap-2 font-mono text-micro font-medium leading-relaxed tracking-label text-story-white/60 uppercase max-compact:text-micro">
      <Icon size={14} aria-hidden={true} className="shrink-0 text-story-accent" />
      <span className="min-w-0 truncate">{signal.label}</span>
      <strong className="ml-auto text-story-white font-medium">{signal.value}</strong>
    </div>
  );
}

export function LandingPage(): ReactElement {
  const reducedMotion = useReducedMotion();
  const scrollBehavior = reducedMotion ? "auto" : "smooth";
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set([0]));
  const [showAll, setShowAll] = useState(false);
  const sectionRefs = useRef<Array<HTMLElement | null>>([]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [menuOpen]);


  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) {
          const idx = Number((visible.target as HTMLElement).dataset.chapterIndex);
          setActiveIndex(idx);
          setRevealed((current) => (current.has(idx) ? current : new Set([...current, idx])));
        }
      },
      { threshold: [0.35, 0.6, 0.85] },
    );
    sectionRefs.current.forEach((section) => {
      if (section) observer.observe(section);
    });
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === "ArrowDown" || event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        const next = Math.min(CHAPTERS.length - 1, activeIndex + 1);
        sectionRefs.current[next]?.scrollIntoView({ behavior: scrollBehavior, block: "start" });
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        const previous = Math.max(0, activeIndex - 1);
        sectionRefs.current[previous]?.scrollIntoView({ behavior: scrollBehavior, block: "start" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      observer.disconnect();
      window.removeEventListener("keydown", onKey);
    };
  }, [activeIndex, scrollBehavior]);

  const scrollToChapter = (index: number): void => {
    setMenuOpen(false);
    sectionRefs.current[index]?.scrollIntoView({ behavior: scrollBehavior, block: "start" });
  };

  const activeTheme = CHAPTERS[activeIndex]?.theme ?? "night";
  // Chapter copy fades up as it enters the viewport. Reduced-motion readers get
  // the settled state immediately, and a chapter that has not been revealed yet
  // stays transparent so the transition never flashes unanimated content.
  const revealClass = (index: number, delayClass = ""): string => {
    if (!revealed.has(index)) return "opacity-0";
    return reducedMotion ? "" : `animate-story-reveal-up ${delayClass}`.trim();
  };

  return (
    <div className="relative min-h-screen overflow-x-clip bg-story-deep font-sans text-story-ink" id="top" style={STORY_THEME_STYLES[activeTheme]}>
      <header className="fixed inset-x-0 top-0 z-header border-b border-story-white/10 bg-story-deep/78 px-12 transition-colors duration-200 max-compact:px-8">
        <div className="mx-auto flex h-36 w-full max-w-640 items-center justify-between gap-4 max-compact:h-16">
          <a
            className="inline-flex items-center gap-2.5 text-story-white no-underline"
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              scrollToChapter(0);
            }}
          >
            <span className="flex size-9 items-center justify-center rounded-xl border border-story-white/25 bg-story-white p-0.5">
              <img className="size-full rounded-lg object-cover" src={`${ASSET_BASE}assets/brand/favicon.jpg`} alt="" />
            </span>
            <span>
              <strong className="block font-heading text-lead leading-none">Cartethyia</strong>
              <small className="mt-1 block font-mono text-micro font-medium leading-none tracking-code text-story-white/50">AI PROXY ROUTER</small>
            </span>
          </a>
          <nav className="hidden items-center gap-1 min-desktop:flex [&_a]:inline-flex [&_a]:h-9 [&_a]:items-center [&_a]:gap-2 [&_a]:rounded-lg [&_a]:px-3.5 [&_a]:text-badge [&_a]:font-semibold [&_a]:text-story-white/60 [&_a]:no-underline [&_a]:transition-colors [&_a:hover]:bg-story-white/10 [&_a:hover]:text-story-white [&_button]:inline-flex [&_button]:h-9 [&_button]:items-center [&_button]:gap-2 [&_button]:rounded-lg [&_button]:border-0 [&_button]:bg-transparent [&_button]:px-3.5 [&_button]:text-badge [&_button]:font-semibold [&_button]:text-story-white/60 [&_button]:transition-colors [&_button:hover]:bg-story-white/10 [&_button:hover]:text-story-white" aria-label="Primary navigation">
            <button type="button" onClick={() => scrollToChapter(0)}>
              <Home size={14} aria-hidden={true} />
              Home
            </button>
            <a href={CONSOLE_PATH}>
              <Terminal size={14} aria-hidden={true} />
              Console
            </a>
            <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">
              <MessageCircle size={14} aria-hidden={true} />
              Community
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <GithubBadge className="h-19 border-story-white/25 bg-story-white/9 text-story-white hover:border-story-white hover:bg-story-white hover:text-story-deep" />
            <button
              type="button"
              aria-label={showAll ? "Show story" : "Show all"}
              aria-pressed={showAll}
              onClick={() => setShowAll((v) => !v)}
              className={`hidden h-19 items-center gap-1.75 whitespace-nowrap rounded-control border border-story-white/25 bg-story-white/9 px-3 text-badge font-bold text-story-white transition-colors hover:border-story-white hover:bg-story-white hover:text-story-deep sm:inline-flex${showAll ? " border-story-white bg-story-white text-story-deep" : ""}`}
            >
              <span className="size-3.5 shrink-0 rounded-full bg-current" aria-hidden={true} />
              {showAll ? "Story" : "All view"}
            </button>
            <a className="inline-flex h-19 items-center gap-2 rounded-control border border-story-white/25 bg-story-white/9 px-3.5 text-badge font-bold text-story-white no-underline transition-colors hover:border-story-white hover:bg-story-white hover:text-story-deep max-compact:hidden" href={CONSOLE_PATH}>
              Enter console
              <ArrowUpRight size={14} aria-hidden={true} />
            </a>
            <button
              className="hidden size-19 items-center justify-center rounded-control border border-story-white/25 bg-story-white/8 text-story-white min-desktop:hidden max-compact:inline-flex"
              type="button"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              {menuOpen ? <X size={17} aria-hidden={true} /> : <Menu size={17} aria-hidden={true} />}
            </button>
          </div>
        </div>
        <div className={`fixed inset-0 z-mobile-overlay bg-story-black/60 transition-opacity duration-150 min-desktop:hidden ${menuOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`} aria-hidden={true} onClick={() => setMenuOpen(false)} />
        <nav className={`fixed inset-x-0 top-16 z-mobile-panel hidden grid-cols-1 gap-1 border-t border-story-white/10 bg-story-deep/95 p-2.5 opacity-0 transition duration-150 min-desktop:hidden max-compact:grid ${menuOpen ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none -translate-y-2"}`} aria-label="Mobile navigation" aria-hidden={!menuOpen}>
          <div className="flex items-center justify-between px-2 py-1.5 font-mono text-micro font-bold uppercase tracking-label text-story-white/50">
            <span>Navigation</span>
            <button className="grid place-items-center border-0 bg-transparent text-story-white" type="button" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
              <X size={17} aria-hidden={true} />
            </button>
          </div>
          {CHAPTERS.map((entry, idx) => (
            <button className="flex items-center gap-2.5 border-0 bg-transparent px-2 py-3 text-left text-body font-semibold text-story-white/75" key={entry.id} type="button" onClick={() => scrollToChapter(idx)}>
              <span className="font-mono text-micro font-medium text-story-accent">{entry.number}</span>
              {entry.label}
              <ArrowUpRight size={13} aria-hidden={true} className="ml-auto" />
            </button>
          ))}
          <a className="mt-1 inline-flex h-11 items-center justify-center gap-2 rounded-control border border-story-white/25 bg-story-white/9 px-3.5 text-badge font-bold text-story-white no-underline" href={CONSOLE_PATH}>
            Enter console
            <ArrowUpRight size={14} aria-hidden={true} />
          </a>
        </nav>
      </header>

      {showAll ? (
        <main className="px-12 pb-17.5 pt-44 max-compact:px-8">
          <div className="mx-auto w-full max-w-640">
          <div className="mb-10.5 flex flex-wrap items-end justify-between gap-5.25">
            <div>
              <p className="text-badge font-bold uppercase tracking-code text-story-white/50">All chapters · 7 stories</p>
              <h2 className="mt-3.5 font-serif text-hero font-normal leading-none tracking-tight text-story-white">Everything at a glance</h2>
              <p className="mt-3.5 max-w-60ch text-body leading-5 text-story-white/65">Hover a card to lift it — click to jump to its story. All 7 visuals, captions and signals visible without scrolling forever.</p>
            </div>
            <div className="flex items-center gap-3.5 text-badge text-story-white/50">
              <span className="h-3 w-3 rounded-full bg-story-success shadow-glow-success" aria-hidden={true} /> Stylish overview
            </div>
          </div>
          <div className="grid gap-7 sm:grid-cols-2 lg:grid-cols-3">
            {CHAPTERS.map((entry, idx) => (
              <article
                key={entry.id}
                onClick={() => {
                  setShowAll(false);
                  requestAnimationFrame(() => scrollToChapter(idx));
                }}
                className="group relative flex cursor-pointer flex-col overflow-hidden rounded-hero border bg-story-surface text-left transition hover:-translate-y-1 hover:shadow-window focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-story-white/30"
                style={STORY_THEME_STYLES[entry.theme]}
                tabIndex={0}
                role="button"
                aria-label={`Open ${entry.label}`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setShowAll(false);
                    requestAnimationFrame(() => scrollToChapter(idx));
                  }
                }}
              >
                <div className="relative h-95 overflow-hidden">
                  <img src={entry.image} alt={entry.imageAlt} className="h-full w-full object-cover transition duration-500 group-hover:scale-104" loading="lazy" decoding="async" />
                  <div className="absolute inset-0 bg-gradient-to-t from-story-deep/85 via-story-deep/10 to-transparent" />
                  <div className="absolute left-3 top-3 flex items-center gap-3">
                    <span className="rounded-full bg-story-white px-3 py-1 font-mono text-micro font-bold tracking-label text-story-deep">{entry.number}</span>
                    <span className="rounded-full border border-story-white/20 bg-story-black/25 px-3.5 py-1 text-micro font-bold uppercase tracking-label text-story-white backdrop-blur">{entry.theme}</span>
                  </div>
                  <div className="absolute bottom-2 left-3 right-3 flex items-center justify-between text-micro font-bold uppercase tracking-label text-story-white/75">
                    <span className="truncate">{entry.location}</span>
                    <ArrowUpRight size={13} aria-hidden={true} className="opacity-60 group-hover:opacity-100" />
                  </div>
                </div>
                <div className="flex flex-1 flex-col gap-3.5 p-7">
                  <h3 className="font-serif text-title font-normal leading-tight tracking-tight text-story-white">{entry.title}</h3>
                  <p className="line-clamp-2 text-caption leading-5 text-story-white/65">{entry.description}</p>
                  <div className="mt-1.75 flex flex-wrap gap-3">
                    {entry.signals.map((s) => {
                      const Icon = signalIcons[s.icon];
                      return (
                        <span key={`${entry.id}-${s.label}`} className="inline-flex items-center gap-1.75 rounded-full border border-story-white/10 bg-story-white/6 px-3.5 py-1.75 text-micro font-semibold uppercase tracking-label text-story-white/75">
                          <Icon size={12} aria-hidden={true} className="text-story-accent" />
                          {s.label}
                          <strong className="font-bold text-story-white">{s.value}</strong>
                        </span>
                      );
                    })}
                  </div>
                </div>
              </article>
            ))}
          </div>
          </div>
        </main>
      ) : (
        <main className="relative z-1">
          {CHAPTERS.map((entry, idx) => (
            <article
              key={entry.id}
              id={`chapter-${idx}`}
              data-chapter-index={idx}
              ref={(node) => {
                sectionRefs.current[idx] = node;
              }}
              className="relative flex min-h-screen items-center overflow-hidden bg-story-deep bg-[linear-gradient(to_right,color-mix(in_srgb,var(--story-accent)_2.2%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_srgb,var(--story-accent)_2.2%,transparent)_1px,transparent_1px)] bg-[length:44px_100%,100%_40px] px-12 py-28 max-compact:min-h-0 max-compact:px-8 max-compact:py-52 max-compact:pb-16"
              style={STORY_THEME_STYLES[entry.theme]}
              aria-labelledby={`chapter-title-${idx}`}
            >
              <div className="absolute inset-0 z-0 scale-108 bg-cover bg-center opacity-25 mix-blend-screen blur-13.5 saturate-114" style={{ backgroundImage: `url(${entry.image})` }} aria-hidden={true} />
              <div className="relative z-1 mx-auto grid w-full max-w-640 grid-cols-2 items-center gap-20 max-compact:flex max-compact:flex-col max-compact:items-stretch max-compact:gap-9">
                <div className={`min-w-0 py-8 max-compact:py-0 ${idx % 2 === 0 ? "col-start-2 row-start-1" : "col-start-1 row-start-1"}`}>
                  <p className={`mt-14.5 font-mono text-micro font-medium leading-none tracking-code text-story-white/55 ${revealClass(idx)}`}>{entry.location}</p>
                  <h1 className={`mt-3 max-w-12ch font-head text-story-hero font-normal leading-[0.98] tracking-[-0.045em] text-balance max-compact:max-w-13ch max-compact:text-story-hero-compact ${revealClass(idx, "delay-100")}`} id={`chapter-title-${idx}`}>{entry.title}</h1>
                  <p className={`mt-5 min-h-0 max-w-54ch text-body-lg leading-7 text-story-white/70 max-compact:max-w-full max-compact:text-body max-compact:leading-6 ${revealClass(idx, "delay-150")}`}>{entry.description}</p>
                  <div className={`mt-8 grid max-w-325 grid-cols-3 gap-3 border-t border-story-white/20 pt-3 max-compact:mt-5 max-compact:max-w-145 max-compact:grid-cols-1 max-compact:gap-2 max-compact:pt-2 ${revealClass(idx, "delay-200")}`}>
                    {entry.signals.map((s) => (
                      <SignalRow key={`${entry.id}-${s.label}`} signal={s} />
                    ))}
                  </div>
                  <div className={`mt-7 flex flex-wrap gap-3.5 max-compact:mt-5 ${revealClass(idx, "delay-300")}`}>
                    <button className="inline-flex h-11 items-center gap-2 rounded-control border border-story-white/25 bg-story-white/8 px-4.5 text-body font-bold text-story-white transition-transform active:scale-97 hover:bg-story-white/18 max-compact:h-21 max-compact:px-3.5 max-compact:text-badge" type="button" onClick={() => scrollToChapter(idx === CHAPTERS.length - 1 ? 0 : idx + 1)}>
                      {nextChapterLabel(idx)}
                      <ArrowRight size={15} aria-hidden={true} />
                    </button>
                  </div>
                </div>
                <figure className={`relative row-start-1 h-270 min-w-0 w-full self-center overflow-hidden border border-story-white/20 bg-story-panel shadow-popout after:absolute after:inset-0 after:bg-gradient-to-b after:from-story-deep/4 after:via-story-deep/30 after:to-story-deep/60 after:content-[''] max-compact:order-[-1] max-compact:h-auto max-compact:aspect-story max-compact:col-auto max-compact:row-auto ${idx % 2 === 0 ? "col-start-1" : "col-start-2"}`}>
                  <img className="block size-full object-cover object-center" src={entry.image} alt={entry.imageAlt} loading={idx === 0 ? "eager" : "lazy"} fetchPriority={idx === 0 ? "high" : "low"} decoding="async" />
                  <figcaption className="absolute inset-x-4 bottom-4 z-1 flex justify-between font-mono text-micro font-medium leading-none tracking-label text-story-white/70 uppercase">
                    {entry.location} <span className="text-story-accent">{entry.number}</span>
                  </figcaption>
                </figure>
              </div>
            </article>
          ))}
        </main>
      )}
    </div>
  );
}

export default LandingPage;
