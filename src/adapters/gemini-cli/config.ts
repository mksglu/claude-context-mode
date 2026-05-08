/**
 * adapters/gemini-cli/config — Thin re-exports from GeminiCLIAdapter.
 *
 * This module exists for backward compatibility. All logic lives in the
 * adapter class (index.ts). New code should use getAdapter() from detect.ts.
 */

export { GeminiCLIAdapter } from "./index.js";
export { HOOK_TYPES, HOOK_SCRIPTS, REQUIRED_HOOKS, OPTIONAL_HOOKS } from "./hooks.js";
