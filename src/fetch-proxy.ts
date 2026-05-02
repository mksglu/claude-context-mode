type ProxyEnv = Record<string, string | undefined>;
type RuntimeSerializableFunction = {
  name: string;
  toString(): string;
};

export function getProxyUrlForRequest(rawUrl: string, env: ProxyEnv = process.env) {
  const requestUrl = new URL(rawUrl);
  const protocol = requestUrl.protocol;

  if (protocol !== "http:" && protocol !== "https:") return undefined;
  if (shouldBypassProxy(requestUrl, getNoProxyValue(env))) return undefined;

  const keys = protocol === "https:"
    ? ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
    : ["HTTP_PROXY", "http_proxy"];
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return validateProxyUrl(value, key);
  }

  return undefined;
}

export function buildFetchProxyRuntimeCode(undiciPath: string) {
  const runtimeFunctionCode = FETCH_PROXY_RUNTIME_FUNCTIONS
    .map((fn) => fn.toString())
    .join("\n\n");
  const getProxyUrlForRequestRuntimeName = getRuntimeFunctionName(getProxyUrlForRequest);

  return `
const undiciPath = ${JSON.stringify(undiciPath)};

${runtimeFunctionCode}

const getProxyUrlForRequestRuntime = ${getProxyUrlForRequestRuntimeName};

async function fetchWithProxy(targetUrl) {
  const proxyUrl = getProxyUrlForRequestRuntime(targetUrl, process.env);
  if (!proxyUrl) return fetch(targetUrl);
  if (typeof Bun !== "undefined") return fetch(targetUrl, { proxy: proxyUrl });
  const { ProxyAgent } = require(undiciPath);
  return fetch(targetUrl, { dispatcher: new ProxyAgent(proxyUrl) });
}
`;
}

function getNoProxyValue(env: ProxyEnv) {
  return env.NO_PROXY || env.no_proxy || "";
}

function validateProxyUrl(proxyUrl: string, envKey: string) {
  const protocol = parseProxyProtocol(proxyUrl, envKey);
  if (protocol === "http:" || protocol === "https:") return proxyUrl;
  if (protocol.startsWith("socks")) throw new Error("SOCKS proxies are not supported — only HTTP/HTTPS");
  throw new Error(`Unsupported proxy protocol in ${envKey}: ${protocol} — only HTTP/HTTPS`);
}

function parseProxyProtocol(proxyUrl: string, envKey: string) {
  let protocol: string;
  try {
    protocol = new URL(proxyUrl).protocol;
  } catch {
    throw invalidProxyUrlError(proxyUrl, envKey);
  }

  if (!proxyUrl.includes("://") && protocol !== "http:" && protocol !== "https:" && !protocol.startsWith("socks")) {
    throw invalidProxyUrlError(proxyUrl, envKey);
  }

  return protocol;
}

function invalidProxyUrlError(proxyUrl: string, envKey: string) {
  return new Error(`Invalid proxy URL in ${envKey}: ${proxyUrl} — include http:// or https://`);
}

function shouldBypassProxy(requestUrl: URL, noProxy: string) {
  if (!noProxy.trim()) return false;

  const hostname = normalizeHost(requestUrl.hostname);
  const port = requestUrl.port || defaultPort(requestUrl.protocol);

  for (const rawToken of noProxy.split(",")) {
    const token = splitNoProxyToken(rawToken);
    if (!token) continue;
    if (token.port && token.port !== port) continue;
    if (token.host === "*") return true;
    if (token.host.includes("/") && matchesIpv4Cidr(hostname, token.host)) return true;
    if (token.host.startsWith(".") && (hostname === token.host.slice(1) || hostname.endsWith(token.host))) return true;
    if (hostname === token.host || hostname.endsWith("." + token.host)) return true;
  }

  return false;
}

function splitNoProxyToken(token: string) {
  const trimmed = token.trim().toLowerCase();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1) return { host: normalizeHost(trimmed) };

    const host = normalizeHost(trimmed.slice(0, end + 1));
    const portPart = trimmed.slice(end + 1);
    return portPart.startsWith(":") && portPart.slice(1) ? { host, port: portPart.slice(1) } : { host };
  }

  const colon = trimmed.lastIndexOf(":");
  if (colon > -1 && trimmed.indexOf(":") === colon && /^\d+$/.test(trimmed.slice(colon + 1))) {
    return { host: normalizeHost(trimmed.slice(0, colon)), port: trimmed.slice(colon + 1) };
  }

  return { host: normalizeHost(trimmed) };
}

function normalizeHost(host: string) {
  return host.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
}

function defaultPort(protocol: string) {
  return protocol === "https:" ? "443" : "80";
}

function matchesIpv4Cidr(host: string, cidr: string) {
  const pieces = cidr.split("/");
  if (pieces.length !== 2) return false;

  const base = ipv4ToNumber(pieces[0] ?? "");
  const target = ipv4ToNumber(host);
  const prefix = Number(pieces[1]);
  if (base === undefined || target === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (base & mask) === (target & mask);
}

function ipv4ToNumber(ip: string) {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;

  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return undefined;
    value = ((value << 8) + octet) >>> 0;
  }

  return value >>> 0;
}

function getRuntimeFunctionName(fn: RuntimeSerializableFunction) {
  if (/^[A-Za-z_$][\w$]*$/.test(fn.name)) return fn.name;
  throw new Error("Fetch proxy runtime function is not serializable");
}

// Keep subprocess proxy behavior serialized from typed functions so TS and runtime paths cannot drift.
const FETCH_PROXY_RUNTIME_FUNCTIONS: readonly RuntimeSerializableFunction[] = [
  getNoProxyValue,
  validateProxyUrl,
  parseProxyProtocol,
  invalidProxyUrlError,
  shouldBypassProxy,
  splitNoProxyToken,
  normalizeHost,
  defaultPort,
  matchesIpv4Cidr,
  ipv4ToNumber,
  getProxyUrlForRequest,
];
