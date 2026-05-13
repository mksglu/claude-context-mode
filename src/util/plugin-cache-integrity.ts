/**
 * TypeScript surface for the start.mjs plugin-cache integrity helper.
 *
 * The actual logic lives in `scripts/plugin-cache-integrity.mjs` (raw
 * `.mjs` so start.mjs can import it without a TS toolchain at boot —
 * #550 fail-fast happens BEFORE any bundle is loaded). This module is
 * the bridge that lets TS consumers (claude-code adapter's
 * getHealthChecks for Algo-D5, the cli doctor surface) call the same
 * function without duplicating the implementation.
 *
 * Single source of truth: scripts/plugin-cache-integrity.mjs. Boot
 * fail-fast (Algo-D4) and doctor diagnostic (Algo-D5) agree
 * byte-for-byte because they call the same exported function.
 *
 * Top-level dynamic import is used (not a static `import` from `.mjs`)
 * because the project is ESM and `import` of a sibling `.mjs` from a
 * `.ts` file relies on the bundler / loader resolving `.mjs`
 * extensions, which esbuild can do but tsc-only typecheck cannot. The
 * dynamic import is resolved by the runtime (Node ESM) regardless of
 * how the consumer was bundled. Errors are caught and surfaced as a
 * FAIL detail — the helper is required to ship in the npm tarball
 * (package.json files[]); a missing helper means the install is
 * fundamentally broken.
 */

interface IntegrityResult {
  readonly ok: boolean;
  readonly missing: readonly string[];
}

interface IntegrityModule {
  assertPluginCacheIntegrity(args: { pluginRoot: string }): IntegrityResult;
  formatPartialInstallReport(args: {
    pluginRoot: string;
    missing: readonly string[];
  }): string;
}

let cached: IntegrityModule | null = null;
let cachedError: string | null = null;

async function loadHelper(): Promise<IntegrityModule | null> {
  if (cached) return cached;
  if (cachedError) return null;
  try {
    // Resolve relative to this compiled file. After tsc emits to
    // build/util/plugin-cache-integrity.js, the helper sits at
    // ../../scripts/plugin-cache-integrity.mjs. After esbuild bundles
    // src/cli.ts to cli.bundle.mjs at the repo root, the same relative
    // path resolves to ./scripts/plugin-cache-integrity.mjs. Both
    // shapes are walked here.
    const candidates = [
      new URL("../../scripts/plugin-cache-integrity.mjs", import.meta.url),
      new URL("./scripts/plugin-cache-integrity.mjs", import.meta.url),
    ];
    let lastErr: unknown = null;
    for (const url of candidates) {
      try {
        const mod = (await import(url.href)) as IntegrityModule;
        if (typeof mod?.assertPluginCacheIntegrity === "function") {
          cached = mod;
          return cached;
        }
      } catch (err) {
        lastErr = err;
      }
    }
    cachedError =
      lastErr instanceof Error ? lastErr.message : String(lastErr ?? "not found");
    return null;
  } catch (err) {
    cachedError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

// Eagerly start the load on module init so the first synchronous
// check() call can hit the cache. The promise is unawaited
// intentionally — by the time any HealthCheck.check() runs (doctor
// command, well after MCP server boot), the import has resolved.
void loadHelper();

/**
 * Run the integrity check synchronously. If the helper module is
 * still loading (not yet cached) returns a FAIL with detail
 * "integrity helper not yet loaded" — caller should retry once the
 * doctor command's IO is complete. In practice the doctor is invoked
 * many MS after module load so this fallback is defensive only.
 */
export function checkPluginCacheIntegritySync(
  pluginRoot: string,
): { status: "OK" | "FAIL"; detail: string } {
  if (cached) {
    const result = cached.assertPluginCacheIntegrity({ pluginRoot });
    if (result.ok) {
      return {
        status: "OK",
        detail: `${pluginRoot} (all required runtime siblings present)`,
      };
    }
    return {
      status: "FAIL",
      detail: `missing: ${result.missing.join(", ")}`,
    };
  }
  if (cachedError) {
    return {
      status: "FAIL",
      detail: `integrity helper unavailable: ${cachedError}`,
    };
  }
  return {
    status: "FAIL",
    detail: "integrity helper not yet loaded",
  };
}

/** Force-await the helper load. Tests use this to deflake the eager fire-and-forget. */
export async function ensurePluginCacheIntegrityLoaded(): Promise<void> {
  await loadHelper();
}
