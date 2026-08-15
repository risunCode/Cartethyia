import { useCallback, useEffect, useRef, useState } from "react";

export type SidebarPage = 0 | 1;

export interface SidebarNavigationState {
  readonly page: SidebarPage;
  readonly switchPage: (page: SidebarPage) => void;
  readonly onPointerDown: (clientX: number) => void;
  readonly onPointerMove: (clientX: number) => void;
  readonly onPointerUp: () => void;
  readonly onPointerLeave: () => void;
}

const STORAGE_KEY = "cartethyia.sidebarPage";
const SWIPE_THRESHOLD = 60;

export function useSidebarNavigation(pathname: string, advancedPaths: ReadonlySet<string>): SidebarNavigationState {
  const [page, setPage] = useState<SidebarPage>(() => localStorage.getItem(STORAGE_KEY) === "1" ? 1 : 0);
  const swipeStartX = useRef<number | null>(null);
  const swipeDelta = useRef<number | null>(null);
  const swipeActive = useRef(false);
  const firstRun = useRef(true);

  const switchPage = useCallback((nextPage: SidebarPage) => {
    setPage(nextPage);
    localStorage.setItem(STORAGE_KEY, String(nextPage));
  }, []);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const pathKey = `/${pathname.split("/").filter(Boolean)[0] ?? "overview"}`;
    if (advancedPaths.has(pathKey)) switchPage(1);
  }, [advancedPaths, pathname, switchPage]);

  const onPointerDown = useCallback((clientX: number) => {
    swipeStartX.current = clientX;
    swipeActive.current = true;
  }, []);

  const onPointerMove = useCallback((clientX: number) => {
    if (!swipeActive.current || swipeStartX.current === null) return;
    swipeDelta.current = clientX - swipeStartX.current;
  }, []);

  const resetSwipe = useCallback(() => {
    swipeStartX.current = null;
    swipeDelta.current = null;
    swipeActive.current = false;
  }, []);

  const onPointerUp = useCallback(() => {
    if (!swipeActive.current || swipeDelta.current === null) {
      resetSwipe();
      return;
    }
    if (swipeDelta.current <= -SWIPE_THRESHOLD && page === 0) switchPage(1);
    if (swipeDelta.current >= SWIPE_THRESHOLD && page === 1) switchPage(0);
    resetSwipe();
  }, [page, resetSwipe, switchPage]);

  return { page, switchPage, onPointerDown, onPointerMove, onPointerUp, onPointerLeave: resetSwipe };
}
