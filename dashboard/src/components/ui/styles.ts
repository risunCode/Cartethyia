
/** Shared keyboard focus treatment for interactive dashboard controls. */
export const focusRingClasses = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]";

/** Shared disabled treatment for controls that should remain in the layout. */
export const disabledControlClasses = "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50";

/** Shared structural treatment for floating panels; callers provide their surface and spacing. */
export const floatingSurfaceClasses = "max-h-[min(70vh,28rem)] overflow-y-auto rounded-2xl border border-[var(--inner-border)] text-[var(--text-1)] shadow-2xl";
