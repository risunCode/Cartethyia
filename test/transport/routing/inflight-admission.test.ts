import { test, expect } from "bun:test";
import { RoutingEngine, InMemoryAdmissionController } from "../../../src/transport/routing/router";
import type { RouteCandidate, RouteSnapshot } from "../../../src/transport/routing/route-model";

const acct = (id: string, max?: number): RouteCandidate => ({
  provider_id: "cb", model_id: "m", wire_family: "chat", endpoint: "/e",
  capability_profile: { tools: true, reasoning: true, vision: false, streaming: true,
    input_modalities: ["text"], output_modalities: ["text"],
    generation_controls: new Set(), context_window: 1000, max_output_tokens: 1000 } as never,
  provider_account_id: id,
  ...(max === undefined ? {} : { max_inflight: max }),
});

const snap = (): RouteSnapshot => ({
  revision: 1, candidates: [acct("A",2), acct("B",2), acct("C",2)],
  combos: {}, aliases: {},
} as never);

test("3 accounts x max_inflight 2 => 6 concurrent, not 2", async () => {
  const e = new RoutingEngine(new InMemoryAdmissionController());
  const plan = await e.plan("cb/m", snap(), null, []);
  const held = [];
  for (let i = 0; i < 6; i++) {
    try { held.push(await e.reserve(plan)); } catch { /* rejected */ }
  }
  expect(held.length).toBe(6);
  expect(held.filter((reservation) => reservation.candidate.provider_account_id === "A")).toHaveLength(2);
  expect(held.filter((reservation) => reservation.candidate.provider_account_id === "B")).toHaveLength(2);
  expect(held.filter((reservation) => reservation.candidate.provider_account_id === "C")).toHaveLength(2);
});

test("different account ceilings are enforced independently", async () => {
  const engine = new RoutingEngine(new InMemoryAdmissionController());
  const mixed = {
    revision: 1,
    candidates: [acct("A", 1), acct("B", 2)],
    combos: {},
    aliases: {},
  } as never as RouteSnapshot;
  const plan = await engine.plan("cb/m", mixed, null, []);
  const held = [];
  for (let i = 0; i < 4; i++) {
    try { held.push(await engine.reserve(plan)); } catch { /* rejected at capacity */ }
  }

  expect(held).toHaveLength(3);
  expect(held.filter((reservation) => reservation.candidate.provider_account_id === "A")).toHaveLength(1);
  expect(held.filter((reservation) => reservation.candidate.provider_account_id === "B")).toHaveLength(2);
});

test("7th is rejected (all 3 buckets full at 2)", async () => {
  const e = new RoutingEngine(new InMemoryAdmissionController());
  const plan = await e.plan("cb/m", snap(), null, []);
  const held = [];
  for (let i = 0; i < 7; i++) {
    try { held.push(await e.reserve(plan)); } catch { /* rejected */ }
  }
  expect(held.length).toBe(6);
});

test("no max_inflight configured => unlimited, never rejected", async () => {
  const e = new RoutingEngine(new InMemoryAdmissionController());
  const unlimited = {
    revision: 1,
    candidates: [acct("A"), acct("B"), acct("C")],
    combos: {}, aliases: {},
  } as never as RouteSnapshot;
  const plan = await e.plan("cb/m", unlimited, null, []);
  const held = [];
  // An empty field means unlimited, so every one of these must be admitted.
  for (let i = 0; i < 30; i++) {
    try { held.push(await e.reserve(plan)); } catch { /* must not happen */ }
  }
  expect(held.length).toBe(30);
});
