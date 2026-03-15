/**
 * OpenClaw plugin entry point for context-mode.
 *
 * This thin wrapper delegates to the compiled plugin logic.
 * OpenClaw loads this file via jiti (TypeScript runtime) when
 * discovering plugins from the .openclaw-plugin/ directory.
 *
 * The actual plugin definition (object form with id, name, configSchema,
 * register) lives in src/openclaw-plugin.ts, compiled to build/openclaw-plugin.js.
 */
export { default } from "../build/openclaw-plugin.js";
