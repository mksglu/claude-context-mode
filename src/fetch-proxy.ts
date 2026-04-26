type ProxyEnv = Record<string, string | undefined>;

const HTTPS_PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;
const HTTP_PROXY_KEYS = ["HTTP_PROXY", "http_proxy"] as const;
const UNSUPPORTED_SOCKS_PROXY_MESSAGE = "SOCKS proxies are not supported — only HTTP/HTTPS";

export function getProxyUrlForRequest(rawUrl: string, env: ProxyEnv = process.env) {
  const requestUrl = new URL(rawUrl);
  const protocol = requestUrl.protocol;

  if (protocol !== "http:" && protocol !== "https:") return undefined;
  if (shouldBypassProxy(requestUrl, getNoProxyValue(env))) return undefined;

  const keys = protocol === "https:" ? HTTPS_PROXY_KEYS : HTTP_PROXY_KEYS;
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return validateProxyUrl(value);
  }

  return undefined;
}

export function buildFetchProxyRuntimeCode(undiciPath: string) {
  return `
const undiciPath = ${JSON.stringify(undiciPath)};
const HTTPS_PROXY_KEYS = ${JSON.stringify(HTTPS_PROXY_KEYS)};
const HTTP_PROXY_KEYS = ${JSON.stringify(HTTP_PROXY_KEYS)};
const UNSUPPORTED_SOCKS_PROXY_MESSAGE = ${JSON.stringify(UNSUPPORTED_SOCKS_PROXY_MESSAGE)};

function getNoProxyValue(env) {
  return env.NO_PROXY || env.no_proxy || "";
}

function normalizeHost(host) {
  return host.replace(/^\\[/, "").replace(/\\]$/, "").replace(/\\.$/, "").toLowerCase();
}

function defaultPort(protocol) {
  return protocol === "https:" ? "443" : "80";
}

function splitNoProxyToken(token) {
  const trimmed = token.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1) return { host: normalizeHost(trimmed) };
    const host = normalizeHost(trimmed.slice(0, end + 1));
    const portPart = trimmed.slice(end + 1);
    return portPart.startsWith(":") && portPart.slice(1) ? { host, port: portPart.slice(1) } : { host };
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon > -1 && trimmed.indexOf(":") === colon && /^\\d+$/.test(trimmed.slice(colon + 1))) {
    return { host: normalizeHost(trimmed.slice(0, colon)), port: trimmed.slice(colon + 1) };
  }
  return { host: normalizeHost(trimmed) };
}

function ipv4ToNumber(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\\d+$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return undefined;
    value = ((value << 8) + octet) >>> 0;
  }
  return value >>> 0;
}

function matchesIpv4Cidr(host, cidr) {
  const pieces = cidr.split("/");
  if (pieces.length !== 2) return false;
  const base = ipv4ToNumber(pieces[0]);
  const target = ipv4ToNumber(host);
  const prefix = Number(pieces[1]);
  if (base === undefined || target === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (base & mask) === (target & mask);
}

function shouldBypassProxy(requestUrl, noProxy) {
  if (!noProxy.trim()) return false;
  const hostname = normalizeHost(requestUrl.hostname);
  const port = requestUrl.port || defaultPort(requestUrl.protocol);
  for (const rawToken of noProxy.split(",")) {
    const token = splitNoProxyToken(rawToken);
    if (!token) continue;
    if (token.host === "*") return true;
    if (token.port && token.port !== port) continue;
    if (token.host.includes("/") && matchesIpv4Cidr(hostname, token.host)) return true;
    if (token.host.startsWith(".") && (hostname === token.host.slice(1) || hostname.endsWith(token.host))) return true;
    if (hostname === token.host || hostname.endsWith("." + token.host)) return true;
  }
  return false;
}

function getProxyUrlForRequest(rawUrl, env) {
  const requestUrl = new URL(rawUrl);
  const protocol = requestUrl.protocol;
  if (protocol !== "http:" && protocol !== "https:") return undefined;
  if (shouldBypassProxy(requestUrl, getNoProxyValue(env))) return undefined;
  const keys = protocol === "https:" ? HTTPS_PROXY_KEYS : HTTP_PROXY_KEYS;
  for (const key of keys) {
    const value = env[key] && env[key].trim();
    if (value) return validateProxyUrl(value);
  }
  return undefined;
}

function validateProxyUrl(proxyUrl) {
  const protocol = new URL(proxyUrl).protocol;
  if (protocol === "http:" || protocol === "https:") return proxyUrl;
  if (protocol.startsWith("socks")) throw new Error(UNSUPPORTED_SOCKS_PROXY_MESSAGE);
  throw new Error("Unsupported proxy protocol: " + protocol + " — only HTTP/HTTPS");
}

async function fetchWithProxy(targetUrl) {
  const proxyUrl = getProxyUrlForRequest(targetUrl, process.env);
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

function validateProxyUrl(proxyUrl: string) {
  const protocol = new URL(proxyUrl).protocol;
  if (protocol === "http:" || protocol === "https:") return proxyUrl;
  if (protocol.startsWith("socks")) throw new Error(UNSUPPORTED_SOCKS_PROXY_MESSAGE);
  throw new Error(`Unsupported proxy protocol: ${protocol} — only HTTP/HTTPS`);
}

function shouldBypassProxy(requestUrl: URL, noProxy: string) {
  if (!noProxy.trim()) return false;

  const hostname = normalizeHost(requestUrl.hostname);
  const port = requestUrl.port || defaultPort(requestUrl.protocol);

  for (const rawToken of noProxy.split(",")) {
    const token = splitNoProxyToken(rawToken);
    if (!token) continue;
    if (token.host === "*") return true;
    if (token.port && token.port !== port) continue;
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
