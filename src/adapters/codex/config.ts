/**
 * adapters/codex/config — Thin re-exports from CodexAdapter.
 *
 * This module exists for backward compatibility. All logic lives in the
 * adapter class (index.ts). New code should use getAdapter() from detect.ts.
 */

export { CodexAdapter } from "./index.js";
export { HOOK_TYPES, ROUTING_INSTRUCTIONS_PATH } from "./hooks.js";
