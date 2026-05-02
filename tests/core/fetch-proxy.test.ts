import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  buildFetchProxyRuntimeCode,
  getProxyUrlForRequest,
} from "../../src/fetch-proxy.js";

describe("fetch proxy support", () => {
  test("selects HTTPS proxy before HTTP proxy for HTTPS URLs", () => {
    const proxyUrl = getProxyUrlForRequest("https://swr.vercel.app/docs/api", {
      HTTPS_PROXY: "http://127.0.0.1:7890",
      HTTP_PROXY: "http://127.0.0.1:8080",
    });

    expect(proxyUrl).toBe("http://127.0.0.1:7890");
  });

  test("falls back to HTTP_PROXY for HTTPS URLs when HTTPS_PROXY is absent", () => {
    const proxyUrl = getProxyUrlForRequest("https://swr.vercel.app/docs/api", {
      HTTP_PROXY: "http://127.0.0.1:8080",
    });

    expect(proxyUrl).toBe("http://127.0.0.1:8080");
  });

  test("selects HTTP proxy for HTTP URLs", () => {
    const proxyUrl = getProxyUrlForRequest("http://example.com/docs", {
      HTTP_PROXY: "http://127.0.0.1:8080",
    });

    expect(proxyUrl).toBe("http://127.0.0.1:8080");
  });

  test("ignores ALL_PROXY to avoid SOCKS ambiguity in Node", () => {
    const proxyUrl = getProxyUrlForRequest("https://example.com/docs", {
      ALL_PROXY: "socks5://127.0.0.1:7891",
      all_proxy: "http://127.0.0.1:7890",
    });

    expect(proxyUrl).toBeUndefined();
  });

  test("rejects SOCKS proxy URLs with a clear error", () => {
    expect(() => getProxyUrlForRequest("https://example.com/docs", {
      HTTPS_PROXY: "socks5://127.0.0.1:7891",
    })).toThrow("SOCKS proxies are not supported — only HTTP/HTTPS");
  });

  test("rejects malformed proxy URLs with the env var name", () => {
    expect(() => getProxyUrlForRequest("https://example.com/docs", {
      HTTPS_PROXY: "corp-proxy.local:8080",
    })).toThrow("Invalid proxy URL in HTTPS_PROXY: corp-proxy.local:8080");
  });

  test("uses lowercase proxy env vars when uppercase vars are absent", () => {
    const proxyUrl = getProxyUrlForRequest("https://example.com/docs", {
      https_proxy: "http://127.0.0.1:7890",
    });

    expect(proxyUrl).toBe("http://127.0.0.1:7890");
  });

  test("respects NO_PROXY exact host, suffix, wildcard, port, and IPv4 CIDR rules", () => {
    const env = {
      HTTPS_PROXY: "http://127.0.0.1:7890",
    };

    expect(getProxyUrlForRequest("https://example.com", { ...env, NO_PROXY: "example.com" })).toBeUndefined();
    expect(getProxyUrlForRequest("https://docs.example.com", { ...env, NO_PROXY: ".example.com" })).toBeUndefined();
    expect(getProxyUrlForRequest("https://anything.test", { ...env, NO_PROXY: "*" })).toBeUndefined();
    expect(getProxyUrlForRequest("https://example.com:8443", { ...env, NO_PROXY: "example.com:8443" })).toBeUndefined();
    expect(getProxyUrlForRequest("https://100.64.12.8", { ...env, NO_PROXY: "100.64.0.0/10" })).toBeUndefined();
    expect(getProxyUrlForRequest("https://100.128.12.8", { ...env, NO_PROXY: "100.64.0.0/10" })).toBe("http://127.0.0.1:7890");
  });

  test("respects wildcard NO_PROXY port constraints", () => {
    const env = {
      HTTPS_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "*:8443",
    };

    expect(getProxyUrlForRequest("https://example.com:8443/docs", env)).toBeUndefined();
    expect(getProxyUrlForRequest("https://example.com/docs", env)).toBe("http://127.0.0.1:7890");
  });

  test("generated runtime code supports Bun proxy option and Node undici dispatcher", () => {
    const code = buildFetchProxyRuntimeCode("/tmp/undici/index.js");

    expect(code).toContain("fetch(targetUrl, { proxy: proxyUrl })");
    expect(code).toContain("ProxyAgent");
    expect(code).toContain("dispatcher");
  });

  const nodeTest = isCommandAvailable("node") ? test : test.skip;
  const bunTest = isCommandAvailable("bun") ? test : test.skip;

  nodeTest("generated runtime code uses a Node dispatcher when a proxy env var is set", () => {
    const output = runRuntimeProbe("node");
    const calls = parseProbeCalls(output);

    expect(calls).toEqual([{
      targetUrl: "https://example.com/docs",
      hasDispatcher: true,
      dispatcherProxy: "http://127.0.0.1:7890",
    }]);
  });

  nodeTest("generated runtime code honors wildcard NO_PROXY port constraints", () => {
    const output = runRuntimeProbe("node", {
      env: {
        HTTPS_PROXY: "http://127.0.0.1:7890",
        NO_PROXY: "*:8443",
      },
      targetUrl: "https://example.com/docs",
    });
    const calls = parseProbeCalls(output);

    expect(calls).toEqual([{
      targetUrl: "https://example.com/docs",
      hasDispatcher: true,
      dispatcherProxy: "http://127.0.0.1:7890",
    }]);
  });

  bunTest("generated runtime code uses Bun's fetch proxy option when a proxy env var is set", () => {
    const output = runRuntimeProbe("bun");
    const calls = parseProbeCalls(output);

    expect(calls).toEqual([{
      targetUrl: "https://example.com/docs",
      proxy: "http://127.0.0.1:7890",
      hasDispatcher: false,
    }]);
  });
});

interface ProbeCall {
  targetUrl: string;
  proxy?: string;
  hasDispatcher: boolean;
  dispatcherProxy?: string;
}

interface RuntimeProbeOptions {
  env?: Record<string, string>;
  targetUrl?: string;
}

function isCommandAvailable(command: string) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  return result.status === 0;
}

function runRuntimeProbe(runtime: "node" | "bun", options: RuntimeProbeOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ctx-fetch-proxy-test-"));
  try {
    const undiciPath = join(dir, "fake-undici.cjs");
    const scriptPath = join(dir, "probe.cjs");
    const targetUrl = options.targetUrl ?? "https://example.com/docs";
    const proxyEnv = {
      HTTPS_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "",
      ...options.env,
    };

    writeFileSync(undiciPath, `
class ProxyAgent {
  constructor(proxyUrl) {
    this.proxyUrl = proxyUrl;
  }
}
module.exports = { ProxyAgent };
`);

    writeFileSync(scriptPath, `
const calls = [];
globalThis.fetch = async (targetUrl, options) => {
  calls.push({
    targetUrl,
    proxy: options && options.proxy,
    hasDispatcher: Boolean(options && options.dispatcher),
    dispatcherProxy: options && options.dispatcher && options.dispatcher.proxyUrl,
  });
  return { ok: true };
};
const proxyEnvKeys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy"];
for (const key of proxyEnvKeys) delete process.env[key];
Object.assign(process.env, ${JSON.stringify(proxyEnv)});
${buildFetchProxyRuntimeCode(undiciPath)}
(async () => {
  await fetchWithProxy(${JSON.stringify(targetUrl)});
  console.log(JSON.stringify(calls));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`);

    const result = spawnSync(runtime, [scriptPath], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseProbeCalls(output: string) {
  return JSON.parse(output) as ProbeCall[];
}
