/**
 * Grok's per-installation agent id.
 *
 * The persistence and failure handling live in the shared install-id module;
 * this file only names the id. Previously each provider carried its own copy of
 * the read/mkdir/open dance, and a failure to write it escaped into dispatch and
 * failed the request.
 */
import { getOrCreateInstallId } from "../install-id";

export function getGrokInstallId(path?: string): Promise<string> {
  return getOrCreateInstallId("grok", path);
}
