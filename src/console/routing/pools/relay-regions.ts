/**
 * Deploy regions for hosted relays.
 *
 * Only Vercel takes a region: it runs a Function in one chosen region, and
 * which region decides which country outbound traffic leaves from. Cloudflare
 * Workers and Deno Deploy are not offered here — Workers runs at the edge
 * nearest the caller rather than in a region an operator picks, and offering a
 * control that silently does nothing is worse than offering none.
 *
 * Pure and dependency-free so the dashboard can import the list as a value and
 * render exactly what the backend accepts, instead of keeping a second copy
 * that would let the form offer a region the deployer rejects.
 */

/** Vercel region ids, grouped by the country they egress from. */
export const RELAY_REGIONS = [
  "iad1",
  "sfo1",
  "pdx1",
  "cle1",
  "yul1",
  "cdg1",
  "arn1",
  "dub1",
  "lhr1",
  "fra1",
  "gru1",
  "hkg1",
  "hnd1",
  "icn1",
  "sin1",
  "bom1",
  "syd1",
  "kix1",
  "cpt1",
  "dxb1",
] as const;

export type RelayRegion = (typeof RELAY_REGIONS)[number];

/** The region a relay deploys to when the operator does not choose one. */
export const DEFAULT_RELAY_REGION: RelayRegion = "sin1";

/**
 * Grouped for the picker, so the list reads as countries an operator
 * recognizes rather than as datacenter codes.
 */
export const RELAY_REGION_GROUPS: readonly {
  readonly label: string;
  readonly regions: readonly { readonly id: RelayRegion; readonly label: string }[];
}[] = [
  {
    label: "Asia Pacific",
    regions: [
      { id: "sin1", label: "Singapore" },
      { id: "hkg1", label: "Hong Kong" },
      { id: "icn1", label: "Seoul" },
      { id: "hnd1", label: "Tokyo" },
      { id: "kix1", label: "Osaka" },
      { id: "bom1", label: "Mumbai" },
      { id: "syd1", label: "Sydney" },
    ],
  },
  {
    label: "Europe",
    regions: [
      { id: "fra1", label: "Frankfurt" },
      { id: "cdg1", label: "Paris" },
      { id: "lhr1", label: "London" },
      { id: "arn1", label: "Stockholm" },
      { id: "dub1", label: "Dublin" },
    ],
  },
  {
    label: "North America",
    regions: [
      { id: "iad1", label: "Washington, D.C." },
      { id: "sfo1", label: "San Francisco" },
      { id: "pdx1", label: "Portland" },
      { id: "cle1", label: "Cleveland" },
      { id: "yul1", label: "Montréal" },
    ],
  },
  {
    label: "Other",
    regions: [
      { id: "gru1", label: "São Paulo" },
      { id: "cpt1", label: "Cape Town" },
      { id: "dxb1", label: "Dubai" },
    ],
  },
];

/** Whether `value` is a region the Vercel deployer accepts. */
export function isRelayRegion(value: unknown): value is RelayRegion {
  return typeof value === "string" && (RELAY_REGIONS as readonly string[]).includes(value);
}
