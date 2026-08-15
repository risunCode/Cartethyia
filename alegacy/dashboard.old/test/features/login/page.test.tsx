import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { LoginPage } from "../../../src/features/login/page";
import { DaemonContractError, daemonPost } from "../../../src/lib/daemon-api";

vi.mock("../../../src/lib/daemon-api", async () => {
  const actual = await vi.importActual("../../../src/lib/daemon-api");
  return { ...actual, daemonPost: vi.fn() };
});

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <LoginPage />
    </MemoryRouter>,
  );
}

describe("LoginPage", () => {
  beforeEach(() => {
    vi.mocked(daemonPost).mockReset();
    mockNavigate.mockReset();
  });

  test("uses the provided artwork and Cartethyia logo without a public-page link", () => {
    renderLogin();

    expect(document.querySelector("[data-login-backdrop]")?.getAttribute("style")).toContain("default-backgrounds.webp");
    expect(document.querySelector("img[src*='favicon.webp']")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /back to public page/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/single admin/i)).not.toBeInTheDocument();
  });

  test("the submit button stays disabled until a password is typed", async () => {
    renderLogin();
    const button = screen.getByRole("button", { name: /sign in/i });
    expect(button).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/password/i), "hunter2");
    expect(button).toBeEnabled();
  });

  test("toggles password visibility inline", async () => {
    renderLogin();
    const password = screen.getByLabelText(/password/i);

    expect(password).toHaveAttribute("type", "password");
    await userEvent.type(password, "secret");
    await userEvent.click(screen.getByRole("button", { name: /show secret/i }));
    expect(password).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: /hide secret/i })).toBeInTheDocument();
  });

  test("a rejected login (wrong password) surfaces the server's error message instead of failing silently", async () => {
    vi.mocked(daemonPost).mockRejectedValueOnce(new DaemonContractError("admin.authentication", "Incorrect password", 401));
    renderLogin();

    await userEvent.type(screen.getByLabelText(/password/i), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText("Incorrect password")).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test("a 429 rate-limit response shows a retry-after hint, not just the raw error", async () => {
    vi.mocked(daemonPost).mockRejectedValueOnce(new DaemonContractError("admin.rate_limited", "Too many attempts", 429));
    renderLogin();

    await userEvent.type(screen.getByLabelText(/password/i), "some-password");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText(/retry in ~30s/)).toBeInTheDocument();
  });

  test("a successful login navigates to the ?next= destination when it's a same-origin path", async () => {
    vi.mocked(daemonPost).mockResolvedValueOnce({});
    render(
      <MemoryRouter initialEntries={["/login?next=/providers"]}>
        <LoginPage />
      </MemoryRouter>,
    );

    await userEvent.type(screen.getByLabelText(/password/i), "correct-password");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/providers", { replace: true }));
  });

  test("an unrecognized ?next= value (not starting with /) falls back to /overview instead of following it", async () => {
    vi.mocked(daemonPost).mockResolvedValueOnce({});
    render(
      <MemoryRouter initialEntries={[`/login?next=${encodeURIComponent("https://evil.example.com")}`]}>
        <LoginPage />
      </MemoryRouter>,
    );

    await userEvent.type(screen.getByLabelText(/password/i), "correct-password");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/overview", { replace: true }));
  });
});
