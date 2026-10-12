/**
 * The tinted inline banner: a short status message that belongs to the content
 * beside it rather than to the page.
 *
 * Eight call sites hand-rolled this box — a restore receipt in `BackupPanel`,
 * two model-test results in `Models`, an error detail in `UsagePage`, a CPU
 * warning in `SettingsPage` — each spelling its own `color-mix(in srgb, …)`
 * percentages. That is the styling contract's exact failure: a repeated visual
 * decided in eight places, so a tint change meant eight edits and any two of
 * them drifting apart silently.
 *
 * The tint is `.banner` in `styles/app.css`, keyed off `data-tone`, so it is one
 * rule per tone rather than one per call site. Two surface families exist
 * because two are in use:
 *
 * - `page` washes the tint over transparent, for a banner floating on whatever
 *   the page paints behind it (`usage`, `models`).
 * - `raised` composites the tint over `surface-2` and its line over
 *   `inner-border`, for a banner sitting on a card (`settings`, `backup`) where
 *   the translucent wash would otherwise show the card's own colour through.
 */
import type { ReactNode } from "react";
import { cn } from "../../lib/classnames";

/** Which status colour a banner speaks in. */
export type BannerTone = "success" | "danger" | "warning";

export interface BannerProps {
  readonly tone: BannerTone;
  /** Defaults to the translucent wash; pass `raised` on top of a card. */
  readonly surface?: "page" | "raised";
  /**
   * `alert` interrupts the screen reader (`role="alert"`), `status` announces
   * politely. Only an error the operator must act on should be an alert — a
   * restore receipt is a status, and a success receipt is neither.
   */
  readonly live?: "alert" | "status" | "none";
  readonly className?: string;
  readonly children: ReactNode;
}

export function Banner({
  tone,
  surface = "page",
  live = "none",
  className,
  children,
}: BannerProps): ReactNode {
  return (
    <div
      role={live === "none" ? undefined : live}
      aria-live={live === "status" ? "polite" : undefined}
      data-tone={tone}
      data-surface={surface}
      className={cn("banner rounded-control border px-5 py-4 text-caption", className)}
    >
      {children}
    </div>
  );
}