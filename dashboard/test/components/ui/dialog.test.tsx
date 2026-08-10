import { describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dialog } from "../../../src/components/ui/dialog";
import { Drawer } from "../../../src/components/ui/drawer";

describe("overlay keyboard contracts", () => {
  test("Dialog exposes its name and closes on Escape", async () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="Edit provider"><button type="button">Save</button></Dialog>);
    expect(screen.getByRole("dialog", { name: "Edit provider" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  test("Dialog provides macOS traffic-light controls", async () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="Provider"><p>Modal content</p></Dialog>);
    expect(screen.getAllByRole("button", { name: "Close dialog" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Minimize dialog" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand dialog" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Minimize dialog" }));
    expect(screen.queryByText("Modal content")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore dialog" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Restore dialog" }));
    expect(screen.getByText("Modal content")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Close dialog" })[1]!);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  test("Drawer exposes a modal name and closes on Escape", async () => {
    const onClose = vi.fn();
    render(<Drawer open onClose={onClose} title="Request detail"><p>Request body</p></Drawer>);
    expect(screen.getByRole("dialog", { name: "Request detail" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
