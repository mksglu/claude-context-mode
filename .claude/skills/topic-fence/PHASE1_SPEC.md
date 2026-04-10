# Phase 1 Specification: extractTopicSignal()

## Goal

Extract topic signal (keywords) from each user message and store in SessionDB.
These signals become the input for Phase 2 drift scoring.

## Location

`src/session/extract.ts` — called within `extractUserEvents()`

## Function Signature

```typescript
function extractTopicSignal(message: string): SessionEvent[]
// Returns 0 or 1 event with type: "topic", category: "topic"
```

## Keyword Extraction Strategy

Lightweight, regex-based approach. No LLM, no external libraries, no network.

### Step 1: Tokenize and Filter

```typescript
const STOPWORDS_EN = new Set([
  "the","a","an","is","are","was","were","be","been","being",
  "have","has","had","do","does","did","will","would","could",
  "should","may","might","shall","can","need","dare","ought",
  "i","you","he","she","it","we","they","me","him","her","us",
  "my","your","his","its","our","their","this","that","these",
  "those","what","which","who","whom","whose","when","where",
  "how","why","not","no","nor","as","at","by","for","from",
  "in","into","of","on","or","to","with","and","but","if",
  "then","than","too","very","just","about","above","after",
  "before","between","both","each","few","more","most","other",
  "some","such","only","own","same","so","also","any","all",
  "please","thanks","thank","hello","hi","hey","ok","okay",
]);

const STOPWORDS_KO = new Set([
  "은","는","이","가","을","를","의","에","에서","로","으로",
  "와","과","도","만","부터","까지","에게","한테","께",
  "그","저","이것","그것","저것","여기","거기","저기",
  "하다","있다","없다","되다","않다","수","것","등","및",
  "좀","네","예","아니","뭐","어떻게","왜","어디",
]);

function extractKeywords(message: string, maxKeywords = 8): string[] {
  const words = message
    .toLowerCase()
    .replace(/[^\w\sㄱ-ㅎ가-힣]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 2)
    .filter(w => !STOPWORDS_EN.has(w) && !STOPWORDS_KO.has(w));

  // Frequency-based top N
  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([word]) => word);
}
```

### Step 2: Emit SessionEvent

```typescript
function extractTopicSignal(message: string): SessionEvent[] {
  const keywords = extractKeywords(message);
  if (keywords.length < 2) return []; // Too few keywords to be meaningful

  return [{
    type: "topic",
    category: "topic",
    data: safeString(JSON.stringify({ keywords })),
    priority: 3, // NORMAL — needed for drift scoring but can yield on eviction
  }];
}
```

> **Note**: `extract.ts`'s local `SessionEvent` interface is a 4-field shape
> (`type`, `category`, `data`, `priority`) — `data_hash` is computed inside
> `SessionDB.insertEvent()` at persistence time and must NOT be emitted here.
> See `src/opencode-plugin.ts` for the cast at the extract→db boundary.

## Integration Point

```typescript
// In extract.ts — modify extractUserEvents()
export function extractUserEvents(message: string): SessionEvent[] {
  try {
    const events: SessionEvent[] = [];
    events.push(...extractUserDecision(message));
    events.push(...extractRole(message));
    events.push(...extractIntent(message));
    events.push(...extractData(message));
    events.push(...extractTopicSignal(message));  // ← ADD THIS
    return events;
  } catch {
    return [];
  }
}
```

## Performance Budget

- Total execution: <5ms (UserPromptSubmit total budget is <10ms)
- Minimize allocations (reuse Set/Map)
- No network calls
- No external libraries

## Test Cases

> **Why expected values carry Korean particles like `"세션을"` instead of `"세션"`**:
> Phase 2 drift scoring uses Jaccard similarity, which is a *relative*
> comparison. As long as the same tokenizer is applied to both the current
> message and the history window, particle leakage is symmetric and does not
> distort drift scores. A morphological analyzer would cost >5ms, violate
> the zero-dependency constraint, and add native-binding burden to 12
> adapter platforms — all for no measurable signal improvement. The
> expected values below are **implementation-anchored snapshots**; a
> principled upgrade to particle stripping would require Phase 2 data
> showing real drift-detection degradation.

```typescript
// 1. Basic English — English stopwords ("in") filtered
extractTopicSignal("Implementing drift detection in context-mode")
// → { keywords: ["implementing", "drift", "detection", "context", "mode"] }

// 2. Short message — no event (single keyword after filtering)
extractTopicSignal("yes")
// → [] (no event emitted)

// 3. Stopwords only — no event
extractTopicSignal("the is a an")
// → [] (no event emitted)

// 4. Korean message — particles remain attached (see note above)
extractTopicSignal("세션을 나눠서 진행할 수 있도록 감지해서 알려주는 기능")
// → { keywords: ["세션을", "나눠서", "진행할", "있도록", "감지해서", "알려주는", "기능"] }

// 5. Mixed language — hyphen splits "context-mode" into "context" + "mode에서"
extractTopicSignal("context-mode에서 topic drift를 감지하려고 합니다")
// → { keywords: ["context", "mode에서", "topic", "drift를", "감지하려고", "합니다"] }

// 6. Repeated keywords get ranked higher
extractTopicSignal("auth auth auth login login database")
// → { keywords: ["auth", "login", "database"] }
```

## Output Schema

```json
{
  "type": "topic",
  "category": "topic",
  "data": "{\"keywords\":[\"drift\",\"detection\",\"session\",\"context\"]}",
  "priority": 3
}
```

## What Comes Next (Phase 2 Preview)

Once Phase 1 is complete, SessionDB accumulates sequential topic events.
Phase 2 will:
1. Query last N topic events from SessionDB
2. Compute Jaccard similarity across sliding windows
3. When similarity < threshold → emit topic_drift event

The threshold can be tuned by observing real topic event data from Phase 1.
