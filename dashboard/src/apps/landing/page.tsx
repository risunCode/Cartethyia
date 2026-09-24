import { useEffect, useRef, useState, type ReactElement } from "react";
import { Activity, ArrowRight, ArrowUpRight, GitFork, Home, Menu, MessageCircle, Network, ShieldCheck, Sparkles, Terminal, X } from "lucide-react";
import { useReducedMotion } from "../../lib/use-reduced-motion";

type SignalIconName = "activity" | "network" | "shield" | "sparkles" | "terminal";
type StoryTheme = "night" | "core" | "blossom" | "voices" | "red" | "denial" | "shore";

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
  readonly sectionClass?: string;
}

const ASSET_BASE = import.meta.env.BASE_URL;
const GITHUB_URL = "https://github.com/risunCode/Cartethyia";
const CONSOLE_LOGIN_PATH = "/console/login";

const storyImage = (name: string): string => `${ASSET_BASE}when_yah/${name}`;
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
    sectionClass: "story-page-section--first",
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
    sectionClass: "story-page-section--blossom",
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
    <div className="story-signal">
      <Icon size={13} aria-hidden={true} />
      <span>{signal.label}</span>
      <strong>{signal.value}</strong>
    </div>
  );
}

export function LandingPage(): ReactElement {
  const reducedMotion = useReducedMotion();
  const scrollBehavior = reducedMotion ? "auto" : "smooth";
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set([0]));
  const [autoScroll, setAutoScroll] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const sectionRefs = useRef<Array<HTMLElement | null>>([]);
  const autoPausedRef = useRef<number | null>(null);
  const activeIndexRef = useRef(activeIndex);
  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [menuOpen]);

  // Autoscroll — advances section every 4.5s, pauses on user interaction
  useEffect(() => {
    if (!autoScroll || showAll) return;
    const pause = (): void => {
      if (autoPausedRef.current !== null) window.clearTimeout(autoPausedRef.current);
      autoPausedRef.current = window.setTimeout(() => {
        autoPausedRef.current = null;
      }, 8000);
    };
    const onInteract = (): void => pause();
    window.addEventListener("wheel", onInteract, { passive: true });
    window.addEventListener("touchstart", onInteract, { passive: true });
    window.addEventListener("keydown", onInteract);
    window.addEventListener("mousedown", onInteract);
    const id = window.setInterval(() => {
      if (autoPausedRef.current !== null || document.hidden) return;
      const next = (activeIndexRef.current + 1) % CHAPTERS.length;
      sectionRefs.current[next]?.scrollIntoView({ behavior: scrollBehavior, block: "start" });
    }, 4500);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("wheel", onInteract);
      window.removeEventListener("touchstart", onInteract);
      window.removeEventListener("keydown", onInteract);
      window.removeEventListener("mousedown", onInteract);
      if (autoPausedRef.current !== null) window.clearTimeout(autoPausedRef.current);
    };
  }, [autoScroll, showAll, scrollBehavior]);

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

  return (
    <div className={`story story-simple story-theme-${activeTheme}`} id="top">
      <header className="story-header">
        <div className="story-shell story-header-inner">
          <a
            className="story-brand"
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              scrollToChapter(0);
            }}
          >
            <span className="story-brand-mark">
              <img src={`${ASSET_BASE}favicon.webp`} alt="" />
            </span>
            <span>
              <strong>Cartethyia</strong>
              <small>AI PROXY ROUTER</small>
            </span>
          </a>
          <nav className="story-desktop-nav" aria-label="Primary navigation">
            <button type="button" onClick={() => scrollToChapter(0)}>
              <Home size={14} aria-hidden={true} />
              Home
            </button>
            <a href={CONSOLE_LOGIN_PATH}>
              <Terminal size={14} aria-hidden={true} />
              Console
            </a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              <GitFork size={14} aria-hidden={true} />
              Source
            </a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              <MessageCircle size={14} aria-hidden={true} />
              Community
            </a>
          </nav>
          <div className="story-header-actions">
            <button
              type="button"
              aria-label={showAll ? "Show story" : "Show all"}
              aria-pressed={showAll}
              onClick={() => setShowAll((v) => !v)}
              className={`hidden h-[38px] items-center gap-1.5 rounded-[10px] border px-2.5 text-[11px] font-bold transition sm:inline-flex ${showAll ? "border-white bg-white text-[#05070d]" : "border-white/25 bg-white/5 text-white hover:bg-white hover:text-[#05070d]"}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${showAll ? "bg-violet-500" : "bg-white/60"}`} aria-hidden={true} />
              {showAll ? "Story" : "All view"}
            </button>
            {!showAll && (
              <button
                type="button"
                aria-label={autoScroll ? "Pause autoscroll" : "Play autoscroll"}
                aria-pressed={autoScroll}
                onClick={() => setAutoScroll((v) => !v)}
                className={`hidden h-[38px] items-center gap-1.5 rounded-[10px] border px-2.5 text-[11px] font-bold transition sm:inline-flex ${autoScroll ? "border-white/25 bg-white/10 text-white hover:bg-white hover:text-[#05070d]" : "border-white/15 bg-transparent text-white/60 hover:bg-white/10 hover:text-white"}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${autoScroll ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" : "bg-white/40"}`} aria-hidden={true} />
                {autoScroll ? "Auto" : "Paused"}
              </button>
            )}
            <a className="story-console-link" href={CONSOLE_LOGIN_PATH}>
              Enter console
              <ArrowUpRight size={14} aria-hidden={true} />
            </a>
            <button
              className="story-menu-button"
              type="button"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              {menuOpen ? <X size={17} aria-hidden={true} /> : <Menu size={17} aria-hidden={true} />}
            </button>
          </div>
        </div>
        <div className={`story-mobile-overlay ${menuOpen ? "is-open" : ""}`} aria-hidden={true} onClick={() => setMenuOpen(false)} />
        <nav className={`story-mobile-nav ${menuOpen ? "is-open" : ""}`} aria-label="Mobile navigation" aria-hidden={!menuOpen}>
          <div className="story-mobile-nav-head">
            <span>Navigation</span>
            <button type="button" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
              <X size={17} aria-hidden={true} />
            </button>
          </div>
          {CHAPTERS.map((entry, idx) => (
            <button key={entry.id} type="button" onClick={() => scrollToChapter(idx)}>
              <span>{entry.number}</span>
              {entry.label}
              <ArrowUpRight size={13} aria-hidden={true} />
            </button>
          ))}
          <a href={CONSOLE_LOGIN_PATH}>
            Enter console
            <ArrowUpRight size={14} aria-hidden={true} />
          </a>
        </nav>
      </header>

      {showAll ? (
        <main className="mx-auto w-[min(100%-2rem,1280px)] pb-10 pt-[88px] sm:w-[min(100%-3rem,1280px)]">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/50">All chapters · 7 stories</p>
              <h2 className="mt-2 font-serif text-[28px] font-normal leading-none tracking-tight text-white">Everything at a glance</h2>
              <p className="mt-2 max-w-[60ch] text-[13px] leading-5 text-white/65">Hover a card to lift it — click to jump to its story. All 7 visuals, captions and signals visible without scrolling forever.</p>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-white/50">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]" aria-hidden={true} /> Stylish overview
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {CHAPTERS.map((entry, idx) => (
              <article
                key={entry.id}
                onClick={() => {
                  setShowAll(false);
                  requestAnimationFrame(() => scrollToChapter(idx));
                }}
                className={`group relative flex cursor-pointer flex-col overflow-hidden rounded-[18px] border bg-[#0b1220] text-left transition hover:-translate-y-1 hover:shadow-[0_20px_60px_rgba(0,0,0,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 story-theme-${entry.theme}`}
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
                <div className="relative h-[190px] overflow-hidden">
                  <img src={entry.image} alt={entry.imageAlt} className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]" loading="lazy" decoding="async" />
                  <div className="absolute inset-0 bg-gradient-to-t from-[#05070d]/85 via-[#05070d]/10 to-transparent" />
                  <div className="absolute left-3 top-3 flex items-center gap-1.5">
                    <span className="rounded-full bg-white px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-[0.08em] text-[#05070d]">{entry.number}</span>
                    <span className="rounded-full border border-white/20 bg-black/25 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-white backdrop-blur">{entry.theme}</span>
                  </div>
                  <div className="absolute bottom-2 left-3 right-3 flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.14em] text-white/75">
                    <span className="truncate">{entry.location}</span>
                    <ArrowUpRight size={12} aria-hidden={true} className="opacity-60 group-hover:opacity-100" />
                  </div>
                </div>
                <div className="flex flex-1 flex-col gap-2 p-4">
                  <h3 className="font-serif text-[18px] font-normal leading-tight tracking-tight text-white">{entry.title}</h3>
                  <p className="line-clamp-2 text-[12.5px] leading-5 text-white/65">{entry.description}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {entry.signals.map((s) => {
                      const Icon = signalIcons[s.icon];
                      return (
                        <span key={`${entry.id}-${s.label}`} className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.06] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-white/75">
                          <Icon size={11} aria-hidden={true} className="text-[var(--story-accent)]" />
                          {s.label}
                          <strong className="font-bold text-white">{s.value}</strong>
                        </span>
                      );
                    })}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </main>
      ) : (
        <main className="story-simple-main">
          {CHAPTERS.map((entry, idx) => (
            <article
              key={entry.id}
              id={`chapter-${idx}`}
              data-chapter-index={idx}
              ref={(node) => {
                sectionRefs.current[idx] = node;
              }}
              className={`story-page-section story-theme-${entry.theme} ${entry.sectionClass ?? ""} ${revealed.has(idx) ? "is-revealed" : ""}`}
              aria-labelledby={`chapter-title-${idx}`}
            >
              <div className="story-page-ambient" style={{ backgroundImage: `url(${entry.image})` }} aria-hidden={true} />
              <div className="story-page-shell story-shell">
                <div className="story-page-copy">
                  <p className="story-location">{entry.location}</p>
                  <h1 id={`chapter-title-${idx}`}>{entry.title}</h1>
                  <p className="story-description">{entry.description}</p>
                  <div className="story-signals">
                    {entry.signals.map((s) => (
                      <SignalRow key={`${entry.id}-${s.label}`} signal={s} />
                    ))}
                  </div>
                  <div className="story-page-actions">
                    <button className="story-button story-button-secondary" type="button" onClick={() => scrollToChapter(idx === CHAPTERS.length - 1 ? 0 : idx + 1)}>
                      {nextChapterLabel(idx)}
                      <ArrowRight size={15} aria-hidden={true} />
                    </button>
                  </div>
                </div>
                <figure className="story-page-visual">
                  <img src={entry.image} alt={entry.imageAlt} loading={idx === 0 ? "eager" : "lazy"} fetchPriority={idx === 0 ? "high" : "low"} decoding="async" />
                  <figcaption>
                    {entry.location} <span>{entry.number}</span>
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
