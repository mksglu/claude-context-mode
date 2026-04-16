export type CapabilityState = "unsupported" | "degraded" | "full";
export type CapabilityEvidenceLevel = "none" | "metadata" | "prompt_hook" | "typed_tool_hook" | "persistence_hook" | "db_persisted";
export type CapabilityReasonCode =
  | "no_runtime_evidence"
  | "session_metadata_only"
  | "prompt_hooks_only"
  | "typed_tool_hooks_observed"
  | "persistence_hooks_observed"
  | "db_persistence_observed";
export type CapabilitySignal =
  | "session_metadata_observed"
  | "prompt_hook_observed"
  | "typed_tool_hook_observed"
  | "persistence_hook_observed"
  | "db_persisted";

export interface SessionCapabilitySignals {
  sessionKey: string;
  metadataObserved: boolean;
  promptHookObserved: boolean;
  typedToolHookObserved: boolean;
  persistenceHookObserved: boolean;
  dbPersisted: boolean;
}

export interface SessionCapabilityReport {
  state: CapabilityState;
  reason: CapabilityReasonCode;
  evidence: CapabilityEvidenceLevel;
  tokenSavingsActive: boolean;
}

export function createCapabilitySignals(sessionKey: string): SessionCapabilitySignals {
  return {
    sessionKey,
    metadataObserved: false,
    promptHookObserved: false,
    typedToolHookObserved: false,
    persistenceHookObserved: false,
    dbPersisted: false,
  };
}

export function observeCapabilitySignal(
  current: SessionCapabilitySignals,
  signal: CapabilitySignal,
): SessionCapabilitySignals {
  return {
    ...current,
    metadataObserved: current.metadataObserved || signal === "session_metadata_observed",
    promptHookObserved: current.promptHookObserved || signal === "prompt_hook_observed",
    typedToolHookObserved: current.typedToolHookObserved || signal === "typed_tool_hook_observed",
    persistenceHookObserved: current.persistenceHookObserved || signal === "persistence_hook_observed",
    dbPersisted: current.dbPersisted || signal === "db_persisted",
  };
}

export function classifySessionCapability(current: SessionCapabilitySignals): SessionCapabilityReport {
  if (current.dbPersisted) {
    return {
      state: "full",
      reason: "db_persistence_observed",
      evidence: "db_persisted",
      tokenSavingsActive: true,
    };
  }

  if (current.typedToolHookObserved) {
    return {
      state: "degraded",
      reason: "typed_tool_hooks_observed",
      evidence: "typed_tool_hook",
      tokenSavingsActive: false,
    };
  }

  if (current.persistenceHookObserved) {
    return {
      state: "degraded",
      reason: "persistence_hooks_observed",
      evidence: "persistence_hook",
      tokenSavingsActive: false,
    };
  }

  if (current.promptHookObserved) {
    return {
      state: "unsupported",
      reason: "prompt_hooks_only",
      evidence: "prompt_hook",
      tokenSavingsActive: false,
    };
  }

  if (current.metadataObserved) {
    return {
      state: "unsupported",
      reason: "session_metadata_only",
      evidence: "metadata",
      tokenSavingsActive: false,
    };
  }

  return {
    state: "unsupported",
    reason: "no_runtime_evidence",
    evidence: "none",
    tokenSavingsActive: false,
  };
}
