import { FlaskConical } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Placeholder for the retired Studio playground.
 *
 * The playground and its saved sessions are gone; the route stays so an
 * existing bookmark or an in-flight navigation lands on a real page instead of
 * a 404.
 */
export function StudioPage(): ReactNode {
  return (
    <div
      style={{
        minHeight: "60dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "12px",
        color: "var(--text-tertiary)",
        textAlign: "center",
        padding: "0 16px",
      }}
    >
      <FlaskConical size={26} aria-hidden="true" />
      <h1 style={{ fontSize: "15px", color: "var(--text-primary)", margin: 0 }}>Model Lab</h1>
      <p style={{ fontSize: "12.5px", margin: 0 }}>Coming soon.</p>
    </div>
  );
}

export default StudioPage;
