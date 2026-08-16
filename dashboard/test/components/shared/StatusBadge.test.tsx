import { describe, expect, test } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import { Activity } from "lucide-solid";
import { StatusBadge, mapHealthToStatus } from "../../../src/components/shared/StatusBadge";

function badgeTone(): string {
  const badge = screen.getByRole("status").firstElementChild;
  expect(badge).toBeInstanceOf(HTMLElement);
  return (badge as HTMLElement).className;
}

describe("StatusBadge", () => {
  test("renders healthy states with the success tone and default label", () => {
    render(() => <StatusBadge status="active" />);
    expect(screen.getByRole("status")).toHaveTextContent("Active");
    expect(badgeTone()).toContain("bg-[var(--green-soft)]");
    expect(badgeTone()).toContain("text-[var(--status-success)]");
  });

  test("maps degraded states onto the warning tone", () => {
    render(() => <StatusBadge status="degraded" />);
    expect(screen.getByRole("status")).toHaveTextContent("Degraded");
    expect(badgeTone()).toContain("bg-[var(--orange-soft)]");
    expect(badgeTone()).toContain("text-[var(--status-warning)]");
  });

  test("maps down states onto the danger tone", () => {
    render(() => <StatusBadge status="down" />);
    expect(screen.getByRole("status")).toHaveTextContent("Down");
    expect(badgeTone()).toContain("bg-[var(--red-soft)]");
    expect(badgeTone()).toContain("text-[var(--status-danger)]");
  });

  test("renders offline and pending states with neutral and info tones", () => {
    const { unmount } = render(() => <StatusBadge status="offline" />);
    expect(screen.getByRole("status")).toHaveTextContent("Offline");
    expect(badgeTone()).toContain("bg-[var(--hover)]");
    unmount();

    render(() => <StatusBadge status="pending" />);
    expect(screen.getByRole("status")).toHaveTextContent("Pending");
    expect(badgeTone()).toContain("bg-[var(--teal-soft)]");
  });

  test("prefers a custom label over the default one", () => {
    render(() => <StatusBadge status="error" label="Crash loop" />);

    expect(screen.getByRole("status")).toHaveTextContent("Crash loop");
    expect(screen.queryByText("Error")).not.toBeInTheDocument();
  });

  test("appends a detail sub-label next to the badge", () => {
    render(() => <StatusBadge status="warning" detail="3 of 5 replicas" />);

    expect(screen.getByRole("status")).toHaveTextContent("Warning");
    expect(screen.getByRole("status")).toHaveTextContent("3 of 5 replicas");
  });

  test("hides the leading status dot when showDot is false", () => {
    const { container } = render(() => <StatusBadge status="healthy" showDot={false} />);

    expect(screen.getByRole("status")).toHaveTextContent("Healthy");
    expect(container.querySelector("span.inline-block")).toBeNull();
  });

  test("pulses the indicator only for non-offline statuses", () => {
    const offline = render(() => <StatusBadge status="offline" pulse />);
    expect(offline.container.querySelector(".animate-pulse")).toBeNull();
    offline.unmount();

    const pending = render(() => <StatusBadge status="pending" pulse />);
    expect(pending.container.querySelector(".animate-pulse")).not.toBeNull();
  });

  test("renders a custom leading icon in place of the default one", () => {
    const { container } = render(() => <StatusBadge status="degraded" icon={Activity} />);

    const icons = container.querySelectorAll("svg");
    expect(icons.length).toBeGreaterThan(0);
    expect(screen.getByRole("status")).toHaveTextContent("Degraded");
  });
});

describe("mapHealthToStatus", () => {
  test("maps healthy API enums to active", () => {
    for (const health of ["active", "healthy", "ok", "up"]) {
      expect(mapHealthToStatus(health)).toBe("active");
    }
  });

  test("maps slow or partially failing enums to degraded", () => {
    for (const health of ["degraded", "warn", "warning", "slow"]) {
      expect(mapHealthToStatus(health)).toBe("degraded");
    }
  });

  test("maps hard failures to down", () => {
    for (const health of ["down", "offline", "error", "failed"]) {
      expect(mapHealthToStatus(health)).toBe("down");
    }
  });

  test("maps starting states to pending and everything else to offline", () => {
    expect(mapHealthToStatus("pending")).toBe("pending");
    expect(mapHealthToStatus("starting")).toBe("pending");
    expect(mapHealthToStatus("")).toBe("offline");
    expect(mapHealthToStatus(null)).toBe("offline");
    expect(mapHealthToStatus(undefined)).toBe("offline");
    expect(mapHealthToStatus("some-unknown-state")).toBe("offline");
  });
});

