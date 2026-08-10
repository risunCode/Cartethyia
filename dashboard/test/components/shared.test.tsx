import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog, PasswordModal } from "../../src/components/shared";

describe("ConfirmDialog", () => {
  test("renders nothing in the DOM when closed", () => {
    render(<ConfirmDialog open={false} onClose={vi.fn()} onConfirm={vi.fn()} title="Delete key" message="Are you sure?" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("shows the title and message when open", () => {
    render(<ConfirmDialog open onClose={vi.fn()} onConfirm={vi.fn()} title="Delete key" message="Are you sure?" />);
    expect(screen.getByRole("dialog", { name: "Delete key" })).toBeInTheDocument();
    expect(screen.getByText("Are you sure?")).toBeInTheDocument();
  });

  test("clicking Cancel closes without confirming", async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(<ConfirmDialog open onClose={onClose} onConfirm={onConfirm} title="Delete key" message="Are you sure?" />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("clicking the confirm button calls onConfirm then onClose", async () => {
    const calls: string[] = [];
    const onClose = vi.fn(() => calls.push("close"));
    const onConfirm = vi.fn(() => calls.push("confirm"));
    render(<ConfirmDialog open onClose={onClose} onConfirm={onConfirm} title="Delete key" message="Are you sure?" />);
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(calls).toEqual(["confirm", "close"]);
  });

  test("uses the custom confirmLabel when provided", () => {
    render(<ConfirmDialog open onClose={vi.fn()} onConfirm={vi.fn()} title="Delete key" message="Are you sure?" confirmLabel="Delete forever" />);
    expect(screen.getByRole("button", { name: "Delete forever" })).toBeInTheDocument();
  });
});

describe("PasswordModal", () => {
  test("the confirm button is disabled until a password is typed", async () => {
    render(<PasswordModal open onClose={vi.fn()} onSubmit={vi.fn()} title="Confirm identity" description="Enter your password" />);
    const button = screen.getByRole("button", { name: "Confirm" });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Password"), "secret");
    expect(button).toBeEnabled();
  });

  test("clicking Confirm submits the typed password", async () => {
    const onSubmit = vi.fn();
    render(<PasswordModal open onClose={vi.fn()} onSubmit={onSubmit} title="Confirm identity" description="Enter your password" />);
    await userEvent.type(screen.getByLabelText("Password"), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onSubmit).toHaveBeenCalledWith("hunter2");
  });

  test("pressing Enter in the password field submits it", async () => {
    const onSubmit = vi.fn();
    render(<PasswordModal open onClose={vi.fn()} onSubmit={onSubmit} title="Confirm identity" description="Enter your password" />);
    const input = screen.getByLabelText("Password");
    await userEvent.type(input, "hunter2{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("hunter2");
  });

  test("shows 'Working…' and disables the button while busy", () => {
    render(<PasswordModal open onClose={vi.fn()} onSubmit={vi.fn()} title="Confirm identity" description="Enter your password" busy />);
    const button = screen.getByRole("button", { name: "Working…" });
    expect(button).toBeDisabled();
  });

  test("displays the error message when provided", () => {
    render(<PasswordModal open onClose={vi.fn()} onSubmit={vi.fn()} title="Confirm identity" description="Enter your password" error="Wrong password" />);
    expect(screen.getByText("Wrong password")).toBeInTheDocument();
  });

  test("renders nothing in the DOM when closed", () => {
    render(<PasswordModal open={false} onClose={vi.fn()} onSubmit={vi.fn()} title="Confirm identity" description="Enter your password" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
