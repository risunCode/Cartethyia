import { describe, expect, test } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import { VirtualTable, type VirtualTableColumn } from "../../../src/components/shared/VirtualTable";

interface Row {
  id: string;
  name: string;
}

const columns: VirtualTableColumn<Row>[] = [
  { key: "name", label: "Name", render: (row) => <span>{row.name}</span> },
];

describe("VirtualTable", () => {
  test("applies the sticky header and zebra striping classes to the table element", () => {
    const items: Row[] = [{ id: "1", name: "Alpha" }, { id: "2", name: "Beta" }];
    const { container } = render(() => (
      <VirtualTable<Row> items={items} columns={columns} rowKey={(row) => row.id} />
    ));

    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(table?.className).toContain("vtable-sticky");
    expect(table?.className).toContain("vtable-zebra");
  });

  test("renders column headers", () => {
    const items: Row[] = [{ id: "1", name: "Alpha" }];
    render(() => (
      <VirtualTable<Row> items={items} columns={columns} rowKey={(row) => row.id} />
    ));

    expect(screen.getByText("Name")).toBeInTheDocument();
  });

  test("shows the empty message when there are no rows", () => {
    const { container } = render(() => (
      <VirtualTable<Row> items={[]} columns={columns} rowKey={(row) => row.id} emptyMessage="Nothing here yet" />
    ));

    // The table should not be present in the empty state.
    expect(container.querySelector("table")).toBeNull();
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
  });

  test("exposes a labelled scroll region", () => {
    const items: Row[] = [{ id: "1", name: "Alpha" }];
    render(() => (
      <VirtualTable<Row> items={items} columns={columns} rowKey={(row) => row.id} ariaLabel="Accounts with quota windows" />
    ));

    expect(screen.getByRole("region", { name: "Accounts with quota windows" })).toBeInTheDocument();
  });
});
