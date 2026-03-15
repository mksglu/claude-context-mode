/**
 * adapters/openclaw/config — Thin re-exports from OpenClawAdapter.
 *
 * This module exists for backward compatibility. All logic lives in the
 * adapter class (index.ts). New code should use getAdapter() from detect.ts.
 */

export { OpenClawAdapter } from "./index.js";
export { HOOK_EVENTS, LIFECYCLE_HOOKS, REQUIRED_HOOKS, OPTIONAL_HOOKS } from "./hooks.js";
