import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

export type OverlayPhase = "closed" | "opening" | "open" | "closing";
type OverlayKind = "dialog" | "drawer" | "popover";

const TRANSITION_MS = 180;

interface OverlayElements {
  root: HTMLElement | undefined;
  panel: HTMLElement | undefined;
}

export interface OverlayLifecycle {
  phase: Accessor<OverlayPhase>;
  present: Accessor<boolean>;
  setElements: (root: HTMLElement | undefined, panel?: HTMLElement | undefined) => void;
  requestClose: () => void;
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function closeKeyframes(kind: OverlayKind, panel: boolean): Keyframe[] {
  if (!panel) return [{ opacity: 1 }, { opacity: 0 }];
  if (kind === "drawer") return [{ transform: "translateX(0)" }, { transform: "translateX(105%)" }];
  if (kind === "popover") return [{ opacity: 1, transform: "translateY(0) scale(1)" }, { opacity: 0, transform: "translateY(-6px) scale(0.97)" }];
  return [{ opacity: 1, transform: "translateY(0) scale(1)" }, { opacity: 0, transform: "translateY(8px) scale(0.97)" }];
}

/** Coordinates controlled overlays with the four-phase lifecycle used by the UI primitives. */
export function createOverlayLifecycle(
  open: Accessor<boolean>,
  onClose: () => void,
  onExited: () => void,
  kind: OverlayKind,
): OverlayLifecycle {
  const [phase, setPhase] = createSignal<OverlayPhase>("closed");
  const [present, setPresent] = createSignal(false);
  let currentPhase: OverlayPhase = "closed";
  let requestedClose = false;
  let transitionToken = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let elements: OverlayElements = { root: undefined, panel: undefined };
  let animations: Animation[] = [];

  const updatePhase = (next: OverlayPhase) => {
    currentPhase = next;
    setPhase(next);
  };

  const cancelTransition = () => {
    transitionToken += 1;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    for (const animation of animations) animation.cancel();
    animations = [];
  };

  const finishClose = (token: number) => {
    if (token !== transitionToken || currentPhase !== "closing") return;
    timer = undefined;
    animations = [];
    updatePhase("closed");
    setPresent(false);
    onExited();
  };

  const startClose = () => {
    if (currentPhase === "closed" || currentPhase === "closing") return;
    cancelTransition();
    updatePhase("closing");
    const token = transitionToken;
    if (reducedMotion() || (!elements.root && !elements.panel)) {
      finishClose(token);
      return;
    }

    const targets = [elements.root, elements.panel].filter((element, index, all): element is HTMLElement => element !== undefined && all.indexOf(element) === index);
    animations = targets.map((element) => element.animate(closeKeyframes(kind, elements.panel === element), { duration: TRANSITION_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "forwards" }));
    timer = setTimeout(() => finishClose(token), TRANSITION_MS + 40);
    Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))).then(() => finishClose(token));
  };

  const startOpen = () => {
    if (currentPhase === "opening" || currentPhase === "open") return;
    cancelTransition();
    requestedClose = false;
    setPresent(true);
    updatePhase("opening");
    const token = transitionToken;
    const reveal = () => {
      if (token === transitionToken && currentPhase === "opening") updatePhase("open");
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(reveal);
    else queueMicrotask(reveal);
  };

  const requestClose = () => {
    if (currentPhase === "closed" || currentPhase === "closing") return;
    requestedClose = true;
    onClose();
    startClose();
  };

  createEffect(() => {
    const isOpen = open();
    if (isOpen) {
      if (!requestedClose) startOpen();
      return;
    }
    requestedClose = false;
    startClose();
  });

  onCleanup(() => {
    cancelTransition();
  });

  return {
    phase,
    present,
    setElements: (root, panel) => {
      elements = { root, panel };
    },
    requestClose,
  };
}
