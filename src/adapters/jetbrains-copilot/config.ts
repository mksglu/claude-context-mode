/**
 * adapters/jetbrains-copilot/config — Thin re-exports from JetBrainsCopilotAdapter.
 *
 * This module exists for backward compatibility. All logic lives in the
 * adapter class (index.ts). New code should use getAdapter() from detect.ts.
 */

export { JetBrainsCopilotAdapter } from "./index.js";
export { HOOK_TYPES, HOOK_SCRIPTS, REQUIRED_HOOKS, OPTIONAL_HOOKS } from "./hooks.js";
