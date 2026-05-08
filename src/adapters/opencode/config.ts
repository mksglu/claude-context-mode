/**
 * adapters/opencode/config — Thin re-exports from OpenCodeAdapter.
 *
 * This module exists for backward compatibility. All logic lives in the
 * adapter class (index.ts). New code should use getAdapter() from detect.ts.
 */

export { OpenCodeAdapter } from "./index.js";
export { HOOK_TYPES, REQUIRED_HOOKS, OPTIONAL_HOOKS } from "./hooks.js";
