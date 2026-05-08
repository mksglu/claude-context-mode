import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  resolveProjectAttribution,
  resolveProjectAttributions,
  confidenceToPercent,
  isHighConfidenceAttribution,
  normalizeProjectDir,
  type AttributionContext,
  type ProjectAttribution,
} from "../../src/session/project-attribution.js";
import type { SessionEvent } from "../../src/types.js";

// Use resolved path for cross-platform tests (Windows adds drive letter)
const TEST_BASE = resolve("/tmp/test-projects");

function makeEvent(type: string, data: string, ts = Date.now()): SessionEvent {
  return { type, data, ts } as SessionEvent;
}

describe("resolveProjectAttribution", () => {
  describe("cwd events", () => {
    test("absolute path gets cwd_event source with high confidence", () => {
      const event = makeEvent("cwd", "/Users/dev/project-a");
      const result = resolveProjectAttribution(event, {});

      assert.equal(result.projectDir, "/Users/dev/project-a");
      assert.equal(result.source, "cwd_event");
      assert.equal(result.confidence, 0.9);
    });

    test("Windows absolute path normalizes separators", () => {
      const event = makeEvent("cwd", "C:\\Users\\dev\\project-a");
      const result = resolveProjectAttribution(event, {});

      assert.equal(result.projectDir, "C:/Users/dev/project-a");
      assert.equal(result.source, "cwd_event");
    });

    test("matches workspace root over cwd_event when applicable", () => {
      const event = makeEvent("cwd", "/workspace/repo/subdir");
      const result = resolveProjectAttribution(event, {
        workspaceRoots: ["/workspace/repo"],
      });

      assert.equal(result.projectDir, "/workspace/repo");
      assert.equal(result.source, "workspace_root");
      assert.equal(result.confidence, 0.98);
    });
  });

  describe("file_read events", () => {
    test("absolute file path uses parent dir as projectDir", () => {
      const event = makeEvent("file_read", "/Users/dev/project-b/src/main.ts");
      const result = resolveProjectAttribution(event, {});

      assert.equal(result.projectDir, "/Users/dev/project-b/src");
      assert.equal(result.source, "event_path");
      assert.equal(result.confidence, 0.7);
    });

    test("relative path resolved against lastKnownProjectDir", () => {
      const projectDir = `${TEST_BASE}/project-c`.replace(/\\/g, "/");
      const event = makeEvent("file_read", "src/utils.ts");
      const result = resolveProjectAttribution(event, {
        lastKnownProjectDir: projectDir,
      });

      // Relative path resolves to {projectDir}/src/utils.ts
      // Then matches last_seen since it's under lastKnownProjectDir
      assert.equal(result.projectDir, projectDir);
      assert.equal(result.source, "last_seen");
      assert.equal(result.confidence, 0.76);
    });

    test("matches input_cwd when file within that directory", () => {
      const event = makeEvent("file_read", "/home/user/myproject/lib/foo.ts");
      const result = resolveProjectAttribution(event, {
        inputProjectDir: "/home/user/myproject",
      });

      assert.equal(result.projectDir, "/home/user/myproject");
      assert.equal(result.source, "input_cwd");
      assert.equal(result.confidence, 0.88);
    });
  });

  describe("file_write events", () => {
    test("absolute path attribution", () => {
      const event = makeEvent("file_write", "/projects/app/config.json");
      const result = resolveProjectAttribution(event, {});

      assert.equal(result.projectDir, "/projects/app");
      assert.equal(result.source, "event_path");
    });
  });

  describe("file_edit events", () => {
    test("session_origin match", () => {
      const event = makeEvent("file_edit", "/origin/project/file.py");
      const result = resolveProjectAttribution(event, {
        sessionOriginDir: "/origin/project",
      });

      assert.equal(result.projectDir, "/origin/project");
      assert.equal(result.source, "session_origin");
      assert.equal(result.confidence, 0.82);
    });
  });

  describe("file_search events", () => {
    test("parses path from 'pattern in /path' format", () => {
      const event = makeEvent("file_search", "TODO in /Users/dev/search-project");
      const result = resolveProjectAttribution(event, {});

      assert.equal(result.projectDir, "/Users/dev/search-project");
      assert.equal(result.source, "event_path");
    });

    test("handles multiple 'in' occurrences", () => {
      const event = makeEvent("file_search", "login in admin in /app/src");
      const result = resolveProjectAttribution(event, {});

      assert.equal(result.projectDir, "/app/src");
    });
  });

  describe("file_glob events", () => {
    test("absolute glob path keeps full pattern", () => {
      const event = makeEvent("file_glob", "/projects/mono/**/*.ts");
      const result = resolveProjectAttribution(event, {});

      // Glob patterns are kept as-is for event_path
      assert.equal(result.projectDir, "/projects/mono/**/*.ts");
      assert.equal(result.source, "event_path");
    });

    test("relative glob ignored without anchor", () => {
      const event = makeEvent("file_glob", "src/**/*.ts");
      const result = resolveProjectAttribution(event, {});

      assert.equal(result.source, "unknown");
      assert.equal(result.confidence, 0);
    });

    test("glob matches workspace root when applicable", () => {
      const event = makeEvent("file_glob", "/mono/packages/frontend/**/*.tsx");
      const result = resolveProjectAttribution(event, {
        workspaceRoots: ["/mono/packages/frontend"],
      });

      assert.equal(result.projectDir, "/mono/packages/frontend");
      assert.equal(result.source, "workspace_root");
      assert.equal(result.confidence, 0.98);
    });
  });

  describe("rule events", () => {
    test("rule file path uses parent dir", () => {
      const event = makeEvent("rule", "/config/rules/eslint.json");
      const result = resolveProjectAttribution(event, {});

      assert.equal(result.projectDir, "/config/rules");
      assert.equal(result.source, "event_path");
    });
  });

  describe("non-path events", () => {
    test("message event falls back", () => {
      const event = makeEvent("message", "Hello world");
      const result = resolveProjectAttribution(event, {
        inputProjectDir: "/fallback/project",
      });

      assert.equal(result.projectDir, "/fallback/project");
      assert.equal(result.source, "input_cwd");
      assert.equal(result.confidence, 0.45);
    });

    test("tool_call without path falls back", () => {
      const event = makeEvent("tool_call", "search_web");
      const result = resolveProjectAttribution(event, {
        sessionOriginDir: "/session/origin",
      });

      assert.equal(result.projectDir, "/session/origin");
      assert.equal(result.source, "session_origin");
      assert.equal(result.confidence, 0.35);
    });

    test("no context returns unknown", () => {
      const event = makeEvent("message", "test");
      const result = resolveProjectAttribution(event, {});

      assert.equal(result.projectDir, "");
      assert.equal(result.source, "unknown");
      assert.equal(result.confidence, 0);
    });
  });

  describe("workspace root matching", () => {
    test("longest matching root wins", () => {
      const event = makeEvent("file_read", "/workspace/team/project/deep/file.ts");
      const result = resolveProjectAttribution(event, {
        workspaceRoots: ["/workspace", "/workspace/team/project"],
      });

      assert.equal(result.projectDir, "/workspace/team/project");
      assert.equal(result.source, "workspace_root");
    });

    test("deduplicates roots", () => {
      const event = makeEvent("file_read", "/repo/src/file.ts");
      const result = resolveProjectAttribution(event, {
        workspaceRoots: ["/repo", "/repo", "/repo/"],
      });

      assert.equal(result.projectDir, "/repo");
      assert.equal(result.source, "workspace_root");
    });

    test("empty roots array handled", () => {
      const event = makeEvent("file_read", "/some/path/file.ts");
      const result = resolveProjectAttribution(event, {
        workspaceRoots: [],
      });

      assert.equal(result.source, "event_path");
    });
  });

  describe("priority chain", () => {
    test("workspace_root > input_cwd > session_origin > last_seen", () => {
      const basePath = "/shared/base/project/file.ts";

      const wsResult = resolveProjectAttribution(makeEvent("file_read", basePath), {
        workspaceRoots: ["/shared/base/project"],
        inputProjectDir: "/shared/base/project",
        sessionOriginDir: "/shared/base/project",
        lastKnownProjectDir: "/shared/base/project",
      });
      assert.equal(wsResult.source, "workspace_root");
      assert.equal(wsResult.confidence, 0.98);

      const inputResult = resolveProjectAttribution(makeEvent("file_read", basePath), {
        inputProjectDir: "/shared/base/project",
        sessionOriginDir: "/shared/base/project",
        lastKnownProjectDir: "/shared/base/project",
      });
      assert.equal(inputResult.source, "input_cwd");
      assert.equal(inputResult.confidence, 0.88);

      const originResult = resolveProjectAttribution(makeEvent("file_read", basePath), {
        sessionOriginDir: "/shared/base/project",
        lastKnownProjectDir: "/shared/base/project",
      });
      assert.equal(originResult.source, "session_origin");
      assert.equal(originResult.confidence, 0.82);

      const lastResult = resolveProjectAttribution(makeEvent("file_read", basePath), {
        lastKnownProjectDir: "/shared/base/project",
      });
      assert.equal(lastResult.source, "last_seen");
      assert.equal(lastResult.confidence, 0.76);
    });
  });

  describe("path normalization", () => {
    test("trailing slashes removed", () => {
      const event = makeEvent("cwd", "/path/to/project/");
      const result = resolveProjectAttribution(event, {});

      assert.equal(result.projectDir, "/path/to/project");
    });

    test("backslashes converted to forward slashes", () => {
      const event = makeEvent("file_read", "C:\\code\\repo\\src\\file.ts");
      const result = resolveProjectAttribution(event, {});

      expect(result.projectDir).toMatch(/^C:\/code\/repo\/src$/);
    });

    test("double slashes collapsed", () => {
      const event = makeEvent("cwd", "/path//to///project");
      const result = resolveProjectAttribution(event, {});

      assert.equal(result.projectDir, "/path/to/project");
    });
  });
});

describe("resolveProjectAttributions (batch)", () => {
  test("carries forward lastKnownProjectDir across events", () => {
    const events = [
      makeEvent("cwd", "/project-a"),
      makeEvent("file_read", "/project-a/src/a.ts"),
      makeEvent("file_read", "/project-a/src/b.ts"),
    ];

    const results = resolveProjectAttributions(events, {});

    assert.equal(results[0].projectDir, "/project-a");
    assert.equal(results[1].projectDir, "/project-a");
    assert.equal(results[2].projectDir, "/project-a");
  });

  test("project switch mid-session detected", () => {
    const events = [
      makeEvent("cwd", "/project-a"),
      makeEvent("file_read", "/project-a/main.ts"),
      makeEvent("cwd", "/project-b"),
      makeEvent("file_read", "/project-b/index.ts"),
    ];

    const results = resolveProjectAttributions(events, {});

    assert.equal(results[0].projectDir, "/project-a");
    assert.equal(results[1].projectDir, "/project-a");
    assert.equal(results[2].projectDir, "/project-b");
    assert.equal(results[3].projectDir, "/project-b");
  });

  test("low confidence attribution does not update lastKnown (threshold 0.55)", () => {
    const events = [
      makeEvent("message", "hello"),
      makeEvent("file_read", "/fallback/relative/path.ts"),
    ];

    const results = resolveProjectAttributions(events, {
      inputProjectDir: "/fallback",
    });

    assert.equal(results[0].confidence, 0.45);
    assert.equal(results[1].projectDir, "/fallback");
    assert.equal(results[1].source, "input_cwd");
  });

  test("high confidence updates lastKnown for subsequent events", () => {
    const events = [
      makeEvent("cwd", "/new-project"),
      makeEvent("file_read", "/new-project/lib/util.ts"),
    ];

    const results = resolveProjectAttributions(events, {
      lastKnownProjectDir: "/old-project",
    });

    assert.equal(results[0].projectDir, "/new-project");
    assert.equal(results[0].confidence, 0.9);
    assert.equal(results[1].projectDir, "/new-project");
  });

  test("empty events array returns empty results", () => {
    const results = resolveProjectAttributions([], {});
    assert.deepEqual(results, []);
  });

  test("preserves order correspondence with input events", () => {
    const events = [
      makeEvent("cwd", "/a", 1000),
      makeEvent("cwd", "/b", 2000),
      makeEvent("cwd", "/c", 3000),
    ];

    const results = resolveProjectAttributions(events, {});

    assert.equal(results.length, 3);
    assert.equal(results[0].projectDir, "/a");
    assert.equal(results[1].projectDir, "/b");
    assert.equal(results[2].projectDir, "/c");
  });
});

describe("confidenceToPercent", () => {
  test("converts 0..1 to 0..100", () => {
    assert.equal(confidenceToPercent(0), 0);
    assert.equal(confidenceToPercent(0.5), 50);
    assert.equal(confidenceToPercent(1), 100);
    assert.equal(confidenceToPercent(0.98), 98);
    assert.equal(confidenceToPercent(0.76), 76);
  });

  test("clamps out of range values", () => {
    assert.equal(confidenceToPercent(-0.5), 0);
    assert.equal(confidenceToPercent(1.5), 100);
  });

  test("rounds to nearest integer", () => {
    assert.equal(confidenceToPercent(0.333), 33);
    assert.equal(confidenceToPercent(0.666), 67);
    assert.equal(confidenceToPercent(0.995), 100);
  });
});

describe("isHighConfidenceAttribution", () => {
  test("returns true for >= 0.8", () => {
    assert.equal(isHighConfidenceAttribution(0.8), true);
    assert.equal(isHighConfidenceAttribution(0.9), true);
    assert.equal(isHighConfidenceAttribution(0.98), true);
    assert.equal(isHighConfidenceAttribution(1.0), true);
  });

  test("returns false for < 0.8", () => {
    assert.equal(isHighConfidenceAttribution(0.79), false);
    assert.equal(isHighConfidenceAttribution(0.5), false);
    assert.equal(isHighConfidenceAttribution(0), false);
  });
});

describe("normalizeProjectDir", () => {
  test("normalizes path separators", () => {
    assert.equal(normalizeProjectDir("C:\\Users\\dev"), "C:/Users/dev");
    assert.equal(normalizeProjectDir("/path/to/project/"), "/path/to/project");
    assert.equal(normalizeProjectDir("/a//b///c"), "/a/b/c");
  });

  test("handles edge cases", () => {
    assert.equal(normalizeProjectDir("/"), "/");
    assert.equal(normalizeProjectDir(""), ".");
    assert.equal(normalizeProjectDir("."), ".");
  });
});

describe("edge cases and error handling", () => {
  test("handles null/undefined in context gracefully", () => {
    const event = makeEvent("file_read", "/path/file.ts");

    const result1 = resolveProjectAttribution(event, {
      workspaceRoots: null as unknown as string[],
    });
    assert.equal(result1.source, "event_path");

    const result2 = resolveProjectAttribution(event, {
      sessionOriginDir: undefined,
      inputProjectDir: undefined,
    });
    assert.equal(result2.source, "event_path");
  });

  test("handles empty string paths", () => {
    const event = makeEvent("cwd", "");
    const result = resolveProjectAttribution(event, {});

    assert.equal(result.source, "unknown");
    assert.equal(result.confidence, 0);
  });

  test("handles whitespace-only workspace roots", () => {
    const event = makeEvent("file_read", "/project/file.ts");
    const result = resolveProjectAttribution(event, {
      workspaceRoots: ["", "   ", "/project"],
    });

    assert.equal(result.projectDir, "/project");
    assert.equal(result.source, "workspace_root");
  });
});

describe("real-world scenarios", () => {
  test("manager scenario: credits claimed for wrong project detected", () => {
    const events = [
      makeEvent("cwd", "/company/project-a"),
      makeEvent("file_read", "/company/project-a/README.md"),
      makeEvent("cwd", "/company/project-b"),
      makeEvent("file_write", "/company/project-b/src/feature.ts"),
      makeEvent("file_edit", "/company/project-b/src/feature.ts"),
    ];

    const results = resolveProjectAttributions(events, {});

    const projectAEvents = results.filter(r => r.projectDir.includes("project-a"));
    const projectBEvents = results.filter(r => r.projectDir.includes("project-b"));

    assert.equal(projectAEvents.length, 2);
    assert.equal(projectBEvents.length, 3);
  });

  test("monorepo with multiple workspace roots", () => {
    const events = [
      makeEvent("file_read", "/mono/packages/frontend/src/App.tsx"),
      makeEvent("file_read", "/mono/packages/backend/src/server.ts"),
      makeEvent("file_read", "/mono/packages/shared/utils.ts"),
    ];

    const results = resolveProjectAttributions(events, {
      workspaceRoots: [
        "/mono/packages/frontend",
        "/mono/packages/backend",
        "/mono/packages/shared",
      ],
    });

    assert.equal(results[0].projectDir, "/mono/packages/frontend");
    assert.equal(results[1].projectDir, "/mono/packages/backend");
    assert.equal(results[2].projectDir, "/mono/packages/shared");
    results.forEach(r => assert.equal(r.confidence, 0.98));
  });

  test("IDE session with frequent project switches", () => {
    const events = [
      makeEvent("cwd", "/work/client-app"),
      makeEvent("file_read", "/work/client-app/package.json"),
      makeEvent("cwd", "/work/api-server"),
      makeEvent("file_write", "/work/api-server/routes.ts"),
      makeEvent("cwd", "/work/client-app"),
      makeEvent("file_edit", "/work/client-app/src/api.ts"),
    ];

    const results = resolveProjectAttributions(events, {});

    assert.equal(results[0].projectDir, "/work/client-app");
    assert.equal(results[1].projectDir, "/work/client-app");
    assert.equal(results[2].projectDir, "/work/api-server");
    assert.equal(results[3].projectDir, "/work/api-server");
    assert.equal(results[4].projectDir, "/work/client-app");
    assert.equal(results[5].projectDir, "/work/client-app");
  });
});
