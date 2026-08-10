import { useEffect, useRef, useState, type ComponentType, type MouseEvent, type ReactElement } from "react";
import { motion } from "framer-motion";
import { Activity, ArrowDown, ArrowUpRight, Check, GithubIcon, Home, MessageCircle, Network, ShieldCheck, Sparkles, Terminal } from "lucide-react";

import { Button } from "../components/ui/button";
import { useMotionProfile } from "../lib/motion";

interface Signal {
  readonly label: string;
  readonly value: string;
  readonly icon: SignalIconName;
}

type SignalIconName = "activity" | "network" | "shield" | "sparkles" | "terminal";
type SceneTheme = "night" | "god" | "blossom" | "shore";

interface Chapter {
  readonly id: string;
  readonly number: string;
  readonly label: string;
  readonly title: string;
  readonly description: string;
  readonly image: string;
  readonly imageAlt: string;
  readonly theme: SceneTheme;
  readonly location: string;
  readonly signals: readonly Signal[];
  readonly primaryLabel: string;
  readonly secondaryLabel: string;
}

const GITHUB_URL = "https://github.com/risunCode/Cartethyia";
const DISCORD_ANCHOR = "#chapter-3";

const CHAPTERS: readonly Chapter[] = [
  {
    id: "blessed-maiden",
    number: "01",
    label: "The Blessed Maiden",
    title: "A single signal enters the unknown.",
    description: "Cartethyia gives every client one reliable gateway to the models beyond it — self-hosted, authenticated, and ready for the crossing.",
    image: "/when_yah/fleurdelys_plus.jpg",
    imageAlt: "The Blessed Maiden beneath a luminous blue sky",
    theme: "night",
    location: "THE FIRST CROSSING",
    signals: [
      { label: "The first crossing", value: "OPEN", icon: "network" },
      { label: "The chosen vessel", value: "YOURS", icon: "shield" },
      { label: "The gate", value: "ALIGNED", icon: "sparkles" },
    ],
    primaryLabel: "Enter the console",
    secondaryLabel: "Read the route",
  },
  {
    id: "the-god",
    number: "02",
    label: "The God",
    title: "The route becomes the power.",
    description: "One surface can speak to many providers. Cartethyia translates protocols, balances targets, and keeps each request moving through the right vessel.",
    image: "/when_yah/cartethyia-god.jpg",
    imageAlt: "Cartethyia surrounded by a celestial blue routing field",
    theme: "god",
    location: "THE ROUTING SANCTUM",
    signals: [
      { label: "The many voices", value: "30+", icon: "network" },
      { label: "The bridge", value: "ALIGNED", icon: "terminal" },
      { label: "The fallback", value: "AWARE", icon: "activity" },
    ],
    primaryLabel: "Open the console",
    secondaryLabel: "Continue the chronicle",
  },
  {
    id: "pink-blossom",
    number: "03",
    label: "The Pink Blossom Calm",
    title: "Behind every powerful system, there is a quiet place to govern.",
    description: "Observe the flow, tune the balance, and let the models answer. Provider accounts, quotas, routing rules, API keys, and request logs stay in one calm console.",
    image: "/when_yah/jinhsi-blossom.jpg",
    imageAlt: "Jinhsi beneath soft pink blossoms",
    theme: "blossom",
    location: "THE QUIET CONTROL",
    signals: [
      { label: "The quiet engine", value: "AWAKE", icon: "activity" },
      { label: "The studio", value: "READY", icon: "sparkles" },
      { label: "The balance", value: "HELD", icon: "shield" },
    ],
    primaryLabel: "Enter the console",
    secondaryLabel: "See the controls",
  },
  {
    id: "shorekeeper",
    number: "04",
    label: "The Open Shore",
    title: "The gateway is yours to shape.",
    description: "Find your way back to the source, share your route, and join the people building a dependable gateway across a changing AI landscape.",
    image: "/when_yah/Shorekeeper.png",
    imageAlt: "Shorekeeper watching over a luminous open shore",
    theme: "shore",
    location: "THE SHOREKEEPER",
    signals: [
      { label: "The source", value: "OPEN", icon: "terminal" },
      { label: "The shore", value: "AWAITS", icon: "network" },
      { label: "The next step", value: "YOURS", icon: "sparkles" },
    ],
    primaryLabel: "Get in touch",
    secondaryLabel: "Return to the beginning",
  },
];

const signalIcons: Record<SignalIconName, ComponentType<{ size?: number; "aria-hidden"?: boolean }>> = {
  activity: Activity,
  network: Network,
  shield: ShieldCheck,
  sparkles: Sparkles,
  terminal: Terminal,
};

function handleAnchorClick(event: MouseEvent<HTMLAnchorElement>, target: string): void {
  if (!target.startsWith("#")) return;
  const element = document.querySelector<HTMLElement>(target);
  if (element === null) return;
  event.preventDefault();
  element.scrollIntoView({ behavior: "smooth", block: "start" });
  window.history.replaceState(null, "", target);
}

function SignalRow({ signal }: { readonly signal: Signal }): ReactElement {
  const Icon = signalIcons[signal.icon];
  return (
    <div className="flex min-w-0 items-baseline gap-2 py-1.5 sm:gap-3">
      <Icon size={13} aria-hidden={true} />
      <span className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-[0.12em] text-white/65">{signal.label}</span>
      <strong className="ml-auto text-right text-[10px] font-bold uppercase tracking-[0.12em] text-white">{signal.value}</strong>
    </div>
  );
}

export function LandingPage(): ReactElement {
  const [scrollState, setScrollState] = useState({ activeIndex: 0, imageIndex: 0, sceneProgress: 0, totalProgress: 0 });
  const motionProfile = useMotionProfile();
  const reduceMotion = motionProfile === "reduced";
  const isMobile = motionProfile === "mobile";
  const { activeIndex, imageIndex, sceneProgress, totalProgress } = scrollState;
  const chapter = CHAPTERS[activeIndex] ?? CHAPTERS[0];
  const visualChapter = CHAPTERS[imageIndex] ?? CHAPTERS[0];
  const nextVisualChapter = CHAPTERS[imageIndex + 1];
  const chapterRefs = useRef<Array<HTMLElement | null>>([]);

  useEffect(() => {
    document.title = "Cartethyia — The One-Stop AI Proxy Router";
    const updateScrollState = (): void => {
      const viewportHeight = Math.max(window.innerHeight, 1);
      const rawScene = Math.max(0, window.scrollY / viewportHeight);
      const nextImageIndex = Math.min(CHAPTERS.length - 1, Math.floor(rawScene));
      const nextActiveIndex = Math.min(CHAPTERS.length - 1, Math.max(0, Math.round(rawScene)));
      const nextSceneProgress = nextImageIndex === CHAPTERS.length - 1 ? 1 : Math.min(1, Math.max(0, rawScene - nextImageIndex));
      const maxScroll = Math.max(document.documentElement.scrollHeight - viewportHeight, 1);
      const nextTotalProgress = Math.min(1, Math.max(0, window.scrollY / maxScroll));
      setScrollState((current) => current.activeIndex === nextActiveIndex && current.imageIndex === nextImageIndex && Math.abs(current.sceneProgress - nextSceneProgress) < 0.005 && Math.abs(current.totalProgress - nextTotalProgress) < 0.005
        ? current
        : { activeIndex: nextActiveIndex, imageIndex: nextImageIndex, sceneProgress: nextSceneProgress, totalProgress: nextTotalProgress });
    };
    updateScrollState();
    window.addEventListener("scroll", updateScrollState, { passive: true });
    document.addEventListener("scroll", updateScrollState, { passive: true });
    window.addEventListener("resize", updateScrollState);
    const interval = window.setInterval(updateScrollState, 32);
    return () => {
      window.removeEventListener("scroll", updateScrollState);
      document.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
      window.clearInterval(interval);
    };
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    const previousSnap = root.style.scrollSnapType;
    root.style.scrollSnapType = reduceMotion ? "none" : "y proximity";
    return () => {
      root.style.scrollSnapType = previousSnap;
    };
  }, [reduceMotion]);

  useEffect(() => {
    const next = CHAPTERS[imageIndex + 1];
    if (next === undefined) return undefined;
    const timer = window.setTimeout(() => {
      const image = new Image();
      image.decoding = "async";
      image.src = next.image;
    }, 120);
    return () => window.clearTimeout(timer);
  }, [imageIndex]);

  function scrollToChapter(index: number): void {
    chapterRefs.current[index]?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }

  function handlePrimaryAction(): void {
    if (activeIndex === 0 || activeIndex === 2) {
      window.location.assign("/console/login");
      return;
    }
    scrollToChapter(activeIndex === CHAPTERS.length - 1 ? 3 : activeIndex + 1);
  }

  function handleSecondaryAction(): void {
    scrollToChapter(activeIndex === CHAPTERS.length - 1 ? 0 : activeIndex + 1);
  }

  return (
    <div className="relative isolate min-h-screen overflow-x-hidden bg-[#070b13] text-white" id="top">
      <div className="fixed inset-0 -z-20 bg-[#070b13]" aria-hidden="true" />
      <div className="fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
        <motion.img
          key={visualChapter.image}
          src={visualChapter.image}
          alt=""
          className="absolute inset-0 h-full w-full object-cover object-center"
          fetchPriority={imageIndex === 0 ? "high" : "auto"}
          style={{ opacity: nextVisualChapter === undefined ? 1 : 1 - sceneProgress }}
          initial={{ scale: reduceMotion || isMobile ? 1 : 1.025 }}
          animate={{ scale: 1 }}
          transition={{ duration: reduceMotion ? 0.1 : isMobile ? 0.2 : 0.45, ease: [0.22, 1, 0.36, 1] }}
        />
        {nextVisualChapter !== undefined ? <motion.img key={nextVisualChapter.image} src={nextVisualChapter.image} alt="" className="absolute inset-0 h-full w-full object-cover object-center" style={{ opacity: sceneProgress }} initial={{ scale: reduceMotion || isMobile ? 1 : 1.025 }} animate={{ scale: 1 }} transition={{ duration: reduceMotion ? 0.1 : isMobile ? 0.2 : 0.45, ease: [0.22, 1, 0.36, 1] }} /> : null}
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(3,7,15,.48)_0%,rgba(3,7,15,.25)_34%,rgba(3,7,15,.08)_75%,rgba(3,7,15,.22)_100%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(3,7,15,.36)_0%,transparent_34%,rgba(3,7,15,.48)_100%)]" />
      </div>

      <header className="fixed inset-x-0 top-0 z-30">
        <div className="mx-auto flex h-16 w-[min(100%-2rem,1280px)] items-center justify-between gap-4 sm:h-[72px] sm:w-[min(100%-3rem,1280px)]">
          <a className="inline-flex items-center gap-2.5 text-white no-underline" href="#top" onClick={(event) => handleAnchorClick(event, "#top")}>
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/25 bg-white p-0.5 shadow-lg"><img className="h-full w-full rounded-[9px] object-cover" src="/favicon.png" alt="" /></span>
            <span className="grid gap-0.5"><strong className="font-serif text-lg font-normal leading-none sm:text-xl">Cartethyia</strong><small className="text-[8px] font-bold tracking-[0.18em] text-white/55">AI PROXY ROUTER</small></span>
          </a>
          <nav className="hidden items-center gap-1 md:flex" aria-label="Primary navigation">
            <a className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold text-white/65 transition hover:bg-white/10 hover:text-white" href="#top" onClick={(event) => handleAnchorClick(event, "#top")}><Home size={14} aria-hidden="true" />Home</a>
            <a className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold text-white/65 transition hover:bg-white/10 hover:text-white" href="/console/login"><Terminal size={14} aria-hidden="true" />Console</a>
            <a className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold text-white/65 transition hover:bg-white/10 hover:text-white" href={GITHUB_URL} target="_blank" rel="noreferrer"><GithubIcon size={14} aria-hidden="true" />GitHub</a>
            <a className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold text-white/65 transition hover:bg-white/10 hover:text-white" href={DISCORD_ANCHOR} onClick={(event) => handleAnchorClick(event, DISCORD_ANCHOR)}><MessageCircle size={14} aria-hidden="true" />Discord</a>
          </nav>
          <a className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/25 bg-white/10 px-3 text-xs font-semibold text-white transition hover:bg-white hover:text-[#070b13]" href="/console/login">Enter console<ArrowUpRight size={14} aria-hidden="true" /></a>
        </div>
      </header>

      <main className="relative">
        <div className="pointer-events-none fixed inset-x-0 top-0 z-10 flex min-h-screen items-center">
          <div className="mx-auto w-[min(100%-2rem,1280px)] pt-16 sm:w-[min(100%-3rem,1280px)] sm:pt-[72px]">
              <motion.section
                key={chapter.id}
                className="pointer-events-auto w-full max-w-2xl"
                initial={{ opacity: 0, y: reduceMotion ? 0 : 18 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: reduceMotion ? 0 : -12 }}
                transition={{ duration: reduceMotion ? 0.1 : 0.45, ease: [0.2, 0.8, 0.2, 1] }}
                aria-label={chapter.label}
              >
                <div className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-200"><span>{chapter.number} / 04</span><span className="h-px w-10 bg-current opacity-70" /><span>{chapter.label}</span></div>
                <p className="mt-5 text-[10px] font-bold uppercase tracking-[0.2em] text-white/55">{chapter.location}</p>
                <h1 className="mt-3 max-w-xl font-serif text-[clamp(38px,6vw,78px)] font-normal leading-[.98] tracking-[-.045em] text-white drop-shadow-2xl">{chapter.title}</h1>
                <p className="mt-5 max-w-xl text-sm leading-7 text-white/80 sm:text-base">{chapter.description}</p>
                <div className="mt-7 flex flex-wrap gap-2.5">
                  <Button type="button" variant="default" size="md" className="!rounded-lg !bg-white !text-[#070b13] hover:!bg-cyan-100" onClick={handlePrimaryAction}>{chapter.primaryLabel}<ArrowUpRight size={15} aria-hidden="true" /></Button>
                  <Button type="button" variant="outline" size="md" className="!rounded-lg !border-white/25 !bg-white/10 !text-white hover:!bg-white hover:!text-[#070b13]" onClick={handleSecondaryAction}>{chapter.secondaryLabel}<ArrowDown size={15} aria-hidden="true" /></Button>
                </div>
                <div className="mt-7 grid sm:grid-cols-3 sm:gap-5">
                  {chapter.signals.map((signal) => <SignalRow key={`${chapter.id}-${signal.label}`} signal={signal} />)}
                </div>
                {activeIndex === CHAPTERS.length - 1 ? <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-xs font-semibold text-white/75"><a className="inline-flex items-center gap-2 transition hover:text-white" href={GITHUB_URL} target="_blank" rel="noreferrer"><GithubIcon size={15} aria-hidden="true" />Source on GitHub<ArrowUpRight size={14} aria-hidden="true" /></a><a className="inline-flex items-center gap-2 transition hover:text-white" href={DISCORD_ANCHOR} onClick={(event) => handleAnchorClick(event, DISCORD_ANCHOR)}><MessageCircle size={15} aria-hidden="true" />Join the Discord<ArrowUpRight size={14} aria-hidden="true" /></a></div> : null}
              </motion.section>
          </div>
        </div>

        <div className="relative">
          {CHAPTERS.map((entry, index) => <section key={entry.id} id={`chapter-${index}`} data-chapter-index={index} ref={(node) => { chapterRefs.current[index] = node; }} className="min-h-screen snap-start" aria-label={entry.label} />)}
        </div>
      </main>

      <div className="fixed right-32 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-3 text-[9px] font-bold uppercase tracking-[0.16em] text-white/60 max-md:bottom-14 max-md:left-4 max-md:right-4 max-md:top-auto max-md:translate-y-0 max-md:flex-row" aria-label={`Scene ${chapter.number} progress, overall ${Math.round(totalProgress * 100)} percent`}>
        <span className="whitespace-nowrap">{chapter.number} / 04</span>
        <div className="hidden h-20 w-px bg-white/25 md:block" role="progressbar" aria-label={`Progress through ${chapter.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(sceneProgress * 100)}>
          <span className="block w-full bg-cyan-200 transition-[height] duration-75" style={{ height: `${sceneProgress * 100}%` }} />
        </div>
        <div className="h-px flex-1 bg-white/25 md:hidden" role="progressbar" aria-label={`Progress through ${chapter.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(sceneProgress * 100)}>
          <span className="block h-full bg-cyan-200 transition-[width] duration-75" style={{ width: `${sceneProgress * 100}%` }} />
        </div>
        <span className="w-8 text-right tabular-nums">{Math.round(sceneProgress * 100)}%</span>
      </div>

      <nav className="fixed right-8 top-1/2 z-20 flex -translate-y-1/2 flex-col items-end gap-5 max-md:bottom-5 max-md:left-1/2 max-md:right-auto max-md:top-auto max-md:w-[calc(100%-2rem)] max-md:-translate-x-1/2 max-md:translate-y-0 max-md:flex-row max-md:items-center max-md:justify-between max-md:gap-2" aria-label="Chapter navigation">
        {CHAPTERS.map((entry, index) => <button key={entry.id} type="button" className={`text-right transition max-md:flex-1 ${index === activeIndex ? "text-cyan-200" : "text-white/55 hover:text-white"}`} onClick={() => scrollToChapter(index)} aria-label={`Go to chapter ${entry.number}`} aria-current={index === activeIndex ? "step" : undefined}><span className="block text-[10px] font-bold tracking-[0.12em]">{entry.number}</span><span className="mt-1 block whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.08em] max-md:hidden">{entry.label}</span></button>)}
      </nav>

      <footer className="fixed bottom-6 right-6 z-20 hidden items-center gap-2 text-[9px] font-bold uppercase tracking-[0.16em] text-white/45 lg:flex"><span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_10px_#65f1b5]" />Gateway online<Check size={13} aria-hidden="true" /></footer>
    </div>
  );
}
