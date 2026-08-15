/**
 * Injector barrel — re-exports all ToolInjector implementations.
 *
 * The injector map is the single dispatch point for CliToolService:
 * given a toolId, look up the injector and call getStatus/apply/reset/download.
 */

import type { ToolInjector } from "../types";
import type { ToolId } from "../registry";

import { claudeInjector } from "./claude";
import { codexInjector } from "./codex";
import { clineInjector } from "./cline";
import { opencodeInjector } from "./opencode";
import { droidInjector } from "./droid";
import { hermesInjector } from "./hermes";
import { grokBuildInjector } from "./grok-build";
import { copilotInjector } from "./copilot";
import { deepseekTuiInjector } from "./deepseek-tui";
import { jcodeInjector } from "./jcode";
import { kiloInjector } from "./kilo";
import { openclawInjector } from "./openclaw";
import { coworkInjector } from "./cowork";
import { cursorInjector, rooInjector, continueInjector, ampInjector, qwenInjector } from "./guide";

export const INJECTORS: Record<ToolId, ToolInjector> = {
  claude: claudeInjector,
  codex: codexInjector,
  cline: clineInjector,
  opencode: opencodeInjector,
  droid: droidInjector,
  hermes: hermesInjector,
  "grok-build": grokBuildInjector,
  copilot: copilotInjector,
  "deepseek-tui": deepseekTuiInjector,
  jcode: jcodeInjector,
  kilo: kiloInjector,
  openclaw: openclawInjector,
  cowork: coworkInjector,
  cursor: cursorInjector,
  roo: rooInjector,
  continue: continueInjector,
  amp: ampInjector,
  qwen: qwenInjector,
};
