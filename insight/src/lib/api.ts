const API = "/api";

export interface OverviewData {
  content: { databases: number; sources: number; chunks: number; totalSize: string; totalSizeBytes: number };
  sessions: { databases: number; sessions: number; events: number; totalSize: string; totalSizeBytes: number };
}

export interface Source { id: number; label: string; chunks: number; codeChunks: number; indexedAt: string; }
export interface ContentDB { hash: string; size: string; sizeBytes: number; sourceCount: number; chunkCount: number; sources: Source[]; }
export interface Chunk { title: string; content: string; content_type: string; label: string; highlighted?: string; dbHash?: string; rank?: number; }
export interface SessionMeta { id: string; projectDir: string; startedAt: string; lastEventAt: string; eventCount: number; compactCount: number; }
export interface SessionDB { hash: string; size: string; sizeBytes: number; sessions: SessionMeta[]; }
export interface SessionEvent { id: number; type: string; category: string; priority: number; data: string; source_hook: string; created_at: string; }
export interface SessionEventData { events: SessionEvent[]; resume: { snapshot: string; event_count: number; consumed: number } | null; }

export interface AnalyticsData {
  totals: {
    totalSessions: number; totalEvents: number; avgSessionMin: number;
    totalErrors: number; errorRate: number; totalCompacts: number;
    compactRate: number; reads: number; writes: number;
    readWriteRatio: number; totalFileOps: number;
    totalSubagents: number; totalTasks: number;
    totalPrompts: number; promptsPerSession: number;
    uniqueProjects: number;
    totalCommits: number; commitsPerSession: number; sandboxRate: number;
    totalRules: number; totalEditTestCycles: number;
  };
  sessionsByDate: { date: string; count: number; events: number; compacts: number }[];
  sessionDurations: { session_id: string; project_dir: string; started_at: string; last_event_at: string; duration_min: number; event_count: number; compact_count: number }[];
  toolUsage: { tool: string; count: number }[];
  mcpTools: { tool: string; count: number }[];
  errors: { detail: string; created_at: string; session_id: string }[];
  fileActivity: { file: string; op: string; count: number }[];
  workModes: { mode: string; count: number }[];
  timeToFirstCommit: { session_id: string; started_at: string; first_commit_at: string; minutes_to_commit: number }[];
  exploreExecRatio: { explore: number; execute: number; total: number };
  reworkData: { session_id: string; file: string; edit_count: number }[];
  gitActivity: { action: string; created_at: string; session_id: string; project_dir: string; session_start: string }[];
  subagents: {
    total: number; bursts: number; maxConcurrent: number;
    parallelCount: number; sequentialCount: number; timeSavedMin: number;
    burstDetails: { size: number; time: string }[];
  };
  projectActivity: { project_dir: string; sessions: number; events: number; compacts: number; avg_confidence?: number; high_conf_events?: number }[];
  attribution?: { totalEvents: number; attributedEvents: number; unknownEvents: number; unknownPct: number; avgConfidencePct: number; highConfidencePct: number; isFallbackOnly: boolean };
  hourlyPattern: { hour: number; count: number }[];
  weeklyTrend: { week: string; sessions: number; events: number }[];
  tasks: { task: string; created_at: string }[];
  prompts: { prompt: string; created_at: string; session_id: string }[];
  masteryTrend: { week: string; errors: number; total: number; error_rate: number }[];
  commitRate: { session_id: string; project_dir: string; commits: number }[];
  sandboxAdoption: { sandbox_calls: number; total_calls: number };
  rulesFreshness: { rule_path: string; last_seen: string; load_count: number }[];
  editTestCycles: { session_id: string; cycles: number }[];
}

export interface CategoryCount {
  category: string;
  count: number;
  types: Record<string, number>;
}

export interface CategoryAnalyticsData {
  categories: CategoryCount[];
  errorIntelligence: {
    totalErrors: number;
    resolvedErrors: number;
    resolutionRate: number;
    retryStorms: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    p95SampleCount: number;
    slowestTool: string | null;
    topErrorTools: { tool: string; count: number }[];
    latencyByTool: { tool: string; avg_ms: number; count: number; max_ms: number }[];
  };
  delegation: {
    launched: number;
    completed: number;
    completionRate: number;
    parallelBursts: number;
    maxConcurrent: number;
    timeSavedMin: number;
  };
  governance: {
    totalRejections: number;
    totalDecisions: number;
    totalConstraints: number;
    planApproved: number;
    planRejected: number;
    planApprovalRate: number;
    topRejected: { tool: string; count: number }[];
  };
  gitProductivity: {
    totalCommits: number;
    totalPushes: number;
    commitPushRatio: number;
    totalOperations: number;
    operationMix: { operation: string; count: number }[];
  };
  contextHealth: {
    uniqueRuleFiles: number;
    ruleLoadsPerSession: number;
    uniqueSkills: number;
    skillList: string[];
    modeDistribution: { mode: string; count: number; pct: number }[];
    compactRate: number;
    totalBlockers: number;
    resolvedBlockers: number;
    blockerResolutionRate: number;
  };
  fileIntelligence: {
    readWriteRatio: number;
    explorationDepth: number;
    hotFiles: { file: string; touches: number }[];
    fileChurnRate: number;
  };
  compositeScores: {
    productivity: number;
    quality: number;
    delegation: number;
    contextHealth: number;
  };
  insufficientData: boolean;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`);
  return r.json() as Promise<T>;
}

export const api = {
  overview: () => get<OverviewData>("/overview"),
  analytics: () => get<AnalyticsData>("/analytics"),
  categoryAnalytics: () => get<CategoryAnalyticsData>("/category-analytics"),
  content: () => get<ContentDB[]>("/content"),
  chunks: (dbHash: string, sourceId: number) => get<Chunk[]>(`/content/${dbHash}/chunks/${sourceId}`),
  search: (q: string) => get<Chunk[]>(`/search?q=${encodeURIComponent(q)}`),
  sessions: () => get<SessionDB[]>("/sessions"),
  events: (dbHash: string, sessionId: string) =>
    get<SessionEventData>(`/sessions/${dbHash}/events/${encodeURIComponent(sessionId)}`),
  deleteSource: (dbHash: string, sourceId: number) =>
    fetch(`${API}/content/${dbHash}/source/${sourceId}`, { method: "DELETE" }).then(r => r.json() as Promise<{ ok: boolean }>),
};
