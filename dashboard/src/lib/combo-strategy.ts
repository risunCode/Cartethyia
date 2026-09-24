import type { SelectOption } from "../components/ui/select";
import type { ComboStrategy } from "./contracts";

/**
 * Shared combo-strategy option list for the Combos UI.
 *
 * Kept deliberately separate from the provider routing toggle in
 * `./use-routing-strategy`: providers use a Round robin on/off switch while
 * combos pick from a strategy list.
 * `ComboStrategy` typing keeps the list exhaustive — adding a combo strategy to
 * the canonical union fails typecheck here until an option is provided.
 */
export const COMBO_STRATEGY_OPTIONS: ReadonlyArray<SelectOption & { value: ComboStrategy }> = [
  { value: "fallback", label: "Fallback (try in order)" },
  { value: "round_robin", label: "Round Robin (rotate)" },
];
