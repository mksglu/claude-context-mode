/**
 * Search Relevance Eval — ranking quality under competitive conditions.
 *
 * Existing search tests verify individual layers (porter, trigram, fuzzy,
 * RRF, proximity, title boost) with 2-3 doc scenarios. This suite indexes
 * a realistic heterogeneous corpus (12 markdown sources) into a single
 * ContentStore and asserts that the RIGHT result wins when ALL documents
 * compete for the same queries.
 *
 * What this guards against silent regression:
 *   - BM25 field weights (5.0, 1.0 for title vs content)
 *   - RRF K constant (60)
 *   - Proximity boost formula
 *   - Title boost weights (0.6 code, 0.3 prose)
 *   - Content-type filtering
 *   - Cascade layer selection (porter → trigram → fuzzy)
 *
 * Run: npx vitest run tests/core/search-relevance.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentStore } from "../../src/store.js";

// ─────────────────────────────────────────────────────────
// Corpus — 12 markdown sources that compete against each other.
// Using index() (markdown chunking) so headings become the title
// field in FTS5, exercising the full BM25 title-boost pipeline.
// ─────────────────────────────────────────────────────────

const CORPUS: Array<{ source: string; markdown: string }> = [
  {
    source: "api-auth-handler",
    markdown: `# Authentication middleware

## verifyToken

\`\`\`typescript
export async function verifyToken(req: Request): Promise<User> {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new AuthenticationError("Missing or malformed Authorization header");
  }
  const token = header.slice(7);
  const payload = jwt.verify(token, process.env.JWT_SECRET!);
  return payload;
}
\`\`\`

The middleware validates JWT tokens from the Authorization header and returns the decoded user payload.`,
  },
  {
    source: "nginx-access-log",
    markdown: `# Nginx access log

## Recent requests

\`\`\`
192.168.1.42 "GET /api/auth/callback HTTP/1.1" 200 1234
192.168.1.43 "GET /static/bundle.js HTTP/1.1" 200 450321
192.168.1.44 "POST /api/users HTTP/1.1" 201 89
192.168.1.45 "GET /health HTTP/1.1" 200 2
10.0.0.1 "DELETE /api/sessions HTTP/1.1" 204 0
\`\`\``,
  },
  {
    source: "react-useeffect-docs",
    markdown: `# React useEffect

## Cleanup and dependencies

useEffect lets you synchronize a component with an external system.

\`\`\`jsx
useEffect(() => {
  const connection = createConnection(serverUrl, roomId);
  connection.connect();
  return () => connection.disconnect();
}, [serverUrl, roomId]);
\`\`\`

## When cleanup runs

The cleanup function runs before every re-render with changed dependencies,
and once more when the component unmounts. If your effect subscribes to
something, the cleanup function should unsubscribe.`,
  },
  {
    source: "vitest-output",
    markdown: `# Test results

## Summary

Test Suites: 1 failed, 29 passed, 30 total
Tests: 1 failed, 219 passed, 220 total

## Failed test

\`\`\`
FAIL tests/hooks/integration.test.ts
  PostToolUse hook session capture
    AssertionError: expected "ok" to equal "captured"
    at tests/hooks/integration.test.ts:142:5
\`\`\`

## Passed suites

- store.test.ts (34 tests) 1200ms
- executor.test.ts (55 tests) 3400ms
- security.test.ts (12 tests) 800ms`,
  },
  {
    source: "database-migration",
    markdown: `# Database migration 0042

## Add tenant_id column

\`\`\`sql
ALTER TABLE orders ADD COLUMN tenant_id UUID NOT NULL DEFAULT '00000000';
CREATE INDEX idx_orders_tenant ON orders(tenant_id);
ALTER TABLE products ADD COLUMN tenant_id UUID NOT NULL DEFAULT '00000000';
CREATE INDEX idx_products_tenant ON products(tenant_id);
\`\`\`

## Backfill

\`\`\`sql
UPDATE orders SET tenant_id = (SELECT org_id FROM users WHERE users.id = orders.user_id);
\`\`\``,
  },
  {
    source: "nextjs-build-output",
    markdown: `# Next.js build output

## Warnings

- You have enabled experimental feature (serverActions) in next.config.js
- Duplicate page detected. pages/api/auth and app/api/auth both resolve to /api/auth
- Image with src "/hero.png" was detected as the Largest Contentful Paint (LCP)

## Routes

| Route | Size | First Load |
|-------|------|------------|
| / | 5.2 kB | 89.1 kB |
| /dashboard | 12.3 kB | 96.2 kB |
| /login | 3.4 kB | 87.3 kB |`,
  },
  {
    source: "python-traceback",
    markdown: `# Python error traceback

## Database connection timeout

\`\`\`
Traceback (most recent call last):
  File "/app/services/sync.py", line 234, in sync_orders
    conn = await asyncpg.connect(DATABASE_URL, timeout=30)
asyncio.TimeoutError

DatabaseConnectionError: Failed to connect after 3 retries
\`\`\`

The sync service could not reach the PostgreSQL database within the 30-second timeout.`,
  },
  {
    source: "git-log-recent",
    markdown: `# Git log

## Recent commits

- eb36c2e perf: enable mmap_size pragma for FTS5 search
- 766de41 ci: update server.bundle.mjs
- 01470ec fix(store): wrap indexPlainText with withRetry
- f3b9e21 fix: strip UTF-8 BOM from stdin
- c445a12 feat(kiro): add full hook support for Kiro IDE`,
  },
  {
    source: "tailwind-config",
    markdown: `# Tailwind CSS configuration

## Custom theme colors

\`\`\`javascript
module.exports = {
  theme: {
    extend: {
      colors: {
        brand: { 50: '#f0f9ff', 500: '#0ea5e9', 900: '#0c4a6e' },
        surface: { light: '#ffffff', dark: '#1e293b' },
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
    },
  },
  plugins: [require('@tailwindcss/forms'), require('@tailwindcss/typography')],
};
\`\`\``,
  },
  {
    source: "dockerfile-prod",
    markdown: `# Dockerfile

## Multi-stage production build

\`\`\`dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production=false
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
ENV NODE_ENV=production
COPY --from=builder /app/build ./build
CMD ["node", "build/server.js"]
\`\`\``,
  },
  {
    source: "k8s-deployment",
    markdown: `# Kubernetes deployment

## api-server

\`\`\`yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: api
          image: registry.example.com/api:v2.3.1
          resources:
            requests: { cpu: "250m", memory: "512Mi" }
          readinessProbe:
            httpGet: { path: /health, port: 3000 }
\`\`\``,
  },
  {
    source: "package-json-deps",
    markdown: `# Package dependencies

## Production

- next 14.2.3
- react 18.3.1
- @prisma/client 5.14.0
- zod 3.23.8
- next-auth 4.24.7

## Dev dependencies

- typescript 5.4.5
- vitest 1.6.0
- tailwindcss 3.4.3
- eslint 8.57.0`,
  },
];

// ─────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────

let store: ContentStore;

beforeAll(() => {
  const path = join(tmpdir(), `ctx-relevance-eval-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  store = new ContentStore(path);
  for (const doc of CORPUS) {
    store.index({ content: doc.markdown, source: doc.source });
  }
});

afterAll(() => {
  store.cleanup();
});

type RankingOpts = {
  query: string;
  expectTop: string | string[];
  expectAbsent?: string[];
  limit?: number;
  contentType?: "code" | "prose";
  layer?: "rrf" | "rrf-fuzzy";
};

function assertRanking(opts: RankingOpts) {
  const { query, limit = 5, contentType, layer } = opts;
  const results = store.searchWithFallback(query, limit, undefined, contentType);
  const sources = results.map((r) => r.source);

  const expectTop = Array.isArray(opts.expectTop) ? opts.expectTop : [opts.expectTop];
  for (const expected of expectTop) {
    expect(sources, `"${query}" should find "${expected}" in top ${limit}, got [${sources}]`).toContain(expected);
  }

  if (opts.expectAbsent) {
    for (const absent of opts.expectAbsent) {
      expect(sources, `"${query}" should NOT return "${absent}"`).not.toContain(absent);
    }
  }

  if (layer) {
    expect(results[0]?.matchLayer, `"${query}" should hit ${layer} layer`).toBe(layer);
  }
}

function assertTopOne(query: string, expectedSource: string, contentType?: "code" | "prose") {
  const results = store.searchWithFallback(query, 3, undefined, contentType);
  expect(results.length, `"${query}" should return results`).toBeGreaterThan(0);
  expect(results[0].source, `"${query}" #1 should be "${expectedSource}", got "${results[0]?.source}"`).toBe(expectedSource);
}

// ═══════════════════════════════════════════════════════════
// Precision@1 — correct doc ranked first in competitive corpus
// ═══════════════════════════════════════════════════════════

describe("Search relevance — precision@1", () => {
  test("'authentication middleware JWT' → api-auth-handler", () => {
    assertTopOne("authentication middleware JWT", "api-auth-handler");
  });

  test("'database connection timeout' → python-traceback", () => {
    assertTopOne("database connection timeout", "python-traceback");
  });

  test("'useEffect cleanup' → react-useeffect-docs", () => {
    assertTopOne("useEffect cleanup", "react-useeffect-docs");
  });

  test("'tenant_id migration ALTER TABLE' → database-migration", () => {
    assertTopOne("tenant_id migration ALTER TABLE", "database-migration");
  });

  test("'Dockerfile multi-stage build' → dockerfile-prod", () => {
    assertTopOne("Dockerfile multi-stage build", "dockerfile-prod");
  });

  test("'Kubernetes deployment replicas' → k8s-deployment", () => {
    assertTopOne("Kubernetes deployment replicas", "k8s-deployment");
  });

  test("'tailwind theme colors brand' → tailwind-config", () => {
    assertTopOne("tailwind theme colors brand", "tailwind-config");
  });

  test("'test failed assertion FAIL' → vitest-output", () => {
    assertTopOne("test failed assertion FAIL", "vitest-output");
  });
});

// ═══════════════════════════════════════════════════════════
// Recall@K — correct doc appears in top K despite competition
// ═══════════════════════════════════════════════════════════

describe("Search relevance — recall@5", () => {
  test("'error timeout' finds python traceback among 12 sources", () => {
    assertRanking({
      query: "error timeout",
      expectTop: "python-traceback",
      expectAbsent: ["tailwind-config", "git-log-recent"],
    });
  });

  test("'build warning experimental serverActions' finds nextjs output", () => {
    assertRanking({
      query: "build warning experimental serverActions",
      expectTop: "nextjs-build-output",
    });
  });

  test("'react dependencies vitest typescript' finds package.json", () => {
    assertRanking({
      query: "react dependencies vitest typescript",
      expectTop: "package-json-deps",
    });
  });

  test("'mmap pragma perf FTS5' finds git log", () => {
    assertRanking({
      query: "mmap pragma perf FTS5",
      expectTop: "git-log-recent",
    });
  });
});

// ═══════════════════════════════════════════════════════════
// Title-boost signal — title match beats body-only match
// ═══════════════════════════════════════════════════════════

describe("Search relevance — title boost", () => {
  test("'Kubernetes deployment' leverages title match for #1 ranking", () => {
    const results = store.searchWithFallback("Kubernetes deployment", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("k8s-deployment");
    expect(results[0].title.toLowerCase()).toContain("kubernetes");
  });

  test("'Dockerfile' title match outranks body-only mention", () => {
    const results = store.searchWithFallback("Dockerfile", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("dockerfile-prod");
  });
});

// ═══════════════════════════════════════════════════════════
// Cascade layer selection
// ═══════════════════════════════════════════════════════════

describe("Search relevance — cascade layers", () => {
  test("exact terms hit RRF layer (not fuzzy)", () => {
    assertRanking({
      query: "useEffect cleanup",
      expectTop: "react-useeffect-docs",
      layer: "rrf",
    });
  });

  test("typo still finds the right doc (via fuzzy or RRF tolerance)", () => {
    assertRanking({
      query: "authenticaton middlewar",
      expectTop: "api-auth-handler",
    });
  });
});

// ═══════════════════════════════════════════════════════════
// Negative assertions — irrelevant docs stay out
// ═══════════════════════════════════════════════════════════

describe("Search relevance — negative assertions", () => {
  test("'tailwind colors' excludes unrelated sources", () => {
    assertRanking({
      query: "tailwind colors",
      expectTop: "tailwind-config",
      expectAbsent: ["database-migration", "python-traceback", "k8s-deployment"],
    });
  });

  test("'SQL ALTER TABLE' excludes non-DB sources", () => {
    assertRanking({
      query: "SQL ALTER TABLE",
      expectTop: "database-migration",
      expectAbsent: ["nginx-access-log", "react-useeffect-docs"],
    });
  });
});
