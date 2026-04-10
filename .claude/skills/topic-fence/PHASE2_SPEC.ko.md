# Phase 2 명세서: 드리프트 스코어링

> 상태: 설계 승인 완료, 구현 대기 중
> 선행 단계: Phase 1 (`extractTopicSignal` 이 `src/session/topic-fence.ts` 에 출하 완료)
> 작업 브랜치: `feature/topic-fence`
>
> 본 문서는 `PHASE2_SPEC.md` (영문 원본) 의 한글 번역본입니다. 두 문서는
> 기술적 결정에서 완전히 동일하며, 충돌이 발생할 경우 영문이 canonical 입니다.

## 목표 (Goal)

세션 내부에서 사용자의 토픽이 바뀌었을 때, 슬라이딩 윈도우 위의 Jaccard
유사도를 계산하여 이를 탐지하고, 유사도가 설정된 임계치 미만일 때
`topic_drift` 이벤트를 발행합니다. 발행된 이벤트는 **탐지기 신호에
국한**되며, Phase 3 에서 사용자에게 보이는 알림으로 렌더링될 뿐입니다.
Phase 2 자체는 어떠한 요약, compact 실행, 세션 분할 동작도 수행하지
않습니다.

## 비목표 (Non-Goals)

- LLM 호출, 요약, compact 실행, 세션 분할 — `topic_fence_scope.md` 및
  `.claude/skills/topic-fence/SKILL.md` 에 명시된 바와 같이 범위 외.
  이들은 향후 별도 스킬 `topic-handoff` 의 몫.
- 사용자 알림 UI 렌더링 — Phase 3 의 몫.
- 핸드오프 자동화 — topic-fence 로드맵 자체에 존재하지 않음.
- 세션 경계를 넘는 드리프트 탐지 — Phase 2 는 단일 `session_id` 내부에서만
  동작.

## Jaccard 를 선택한 이유 (그리고 "더 현대적인 것" 이 아닌 이유)

Jaccard 유사도(1912)는 한 세기가 넘은 측도입니다. 더 정교한 대안이
존재함에도 이 측도를 선택한 근거는 명시적 정당화가 필요합니다.

**제약 envelope.** 다음 제약들은 어떤 경험적 비교보다 먼저 대부분의
현대적 대안을 자동 탈락시킵니다.

- **핫패스 예산 <5 ms** — ML 모델 로딩, 네트워크 호출, 네이티브 바이너리
  의존성 모두 배제. Sentence-BERT, SimCSE, E5, WMD 등 임베딩 기반 방법
  탈락.
- **신규 npm 의존성 금지** — 12개 어댑터 플랫폼에 걸쳐 네이티브 바인딩을
  요구하는 라이브러리 배제.
- **세션 간 코퍼스 부재** — 각 세션은 격리됨. TF-IDF(코퍼스 전역 IDF
  통계 요구) 및 BM25 탈락.
- **입력이 이미 토큰화된 작은 키워드 집합** — 토픽 이벤트당 ≤8 키워드,
  윈도우당 ≤24 키워드. 이 규모에서 MinHash 와 SimHash(대규모 Jaccard
  *근사*) 는 속도 향상이 없음 — 정확한 Jaccard 도 sub-millisecond.
- **대칭 윈도우 (N=M)** — Tversky index 의 비대칭 측도 이점 소멸.
  Dice-Sørensen 은 Jaccard 의 단조 변환이며 동일한 판정을 생성 — 선호할
  이유 없음.

통과하는 후보는 plain Jaccard, Dice(등가), weighted Jaccard, Overlap
coefficient(구조적 편향으로 기각 — 한 집합이 다른 집합의 부분집합일 때
1.0 반환) 이며, 그 외에는 남지 않습니다.

**실증 검증.** Phase 2 는 이론적 논증에 의존하지 않고 6개의 실패 모드
카테고리(`clean_shift`, `no_drift`, `gradual`, `generic_masking`,
`synonymy`, `tangent_return`)를 포괄하는 15 시나리오 ground-truth
코퍼스에 대해 검증되었습니다. 임계치 스윕을 거쳐 6개의 변형을
평가했습니다.

| 변형 | Best F1 |
|---|---|
| Plain Jaccard (Phase 1 stopwords) | 0.800 |
| Path A (확장 stopwords + 어간 추출) | 0.818 |
| Path B (세션-지역 IDF) | 0.800 |
| **Path C (Path A + 연속 2턴 규칙)** | **0.900** |
| Path D (2턴 rolling mean) | 0.900 |
| Path E (3턴 rolling mean) | 0.900 |

**Path C 가 F1 = 0.900, recall = 1.000 으로 승리했습니다.** 전체
방법론, 시나리오별 trace, 코퍼스 크기에 대한 주의사항, Phase 4
후속 작업은 `VALIDATION_RESULTS.md` 에 기록되어 있습니다. 승리한
알고리즘은 다음과 같습니다.

1. **토크나이저** — Phase 1 stopwords 에 일반 코딩 도메인 filler 약
   80개 추가 + 경량 Porter 스타일 어간 추출기.
2. **측도** — plain Jaccard (원 설계 불변).
3. **결정 규칙** — 두 개의 인접 윈도우 쌍에 대한 Jaccard 점수가 *모두*
   임계치 미만일 것을 요구. 이는 안정 토픽 내의 일회성 어휘 회전을
   필터링하며, 경험적으로 false positive 의 주요 원인이었음.
4. **기본 임계치** — `0.10` (원래 제안된 `0.30` 이 아님).

**검증은 초기 이론적 주장 두 가지를 반증했습니다.** 첫째, 원래
임계치 `0.30` 은 실증적으로 잘못된 값이었습니다 — 그 값에서는
탐지기가 거의 모든 사용자 턴마다 발화하여 무용지물이 됩니다. 둘째,
세션-지역 IDF 가중(처음에는 가장 유망한 개선안으로 제시됨)은 본
코퍼스에서 plain Path A 대비 개선을 보이지 못했습니다. 두 교훈 모두
유사도 임계치 보정에 있어 측정 없이 이론적 추론에만 의존하지 말라는
경고로 여기 보존됩니다.

**구현 충실성 요구사항.** `src/session/topic-fence.ts` 의 프로덕션
토크나이저는 `eval-drift.mjs` 의 `extractKeywordsPathA` 와 **바이트
단위로 일치**해야 합니다. 구체적으로: (a) stopword 집합 (Phase 1
기본 + 동일한 `GENERIC_TECH_STOPWORDS` 엔트리), (b) 어간 추출기 규칙
목록과 순서, (c) 토큰 길이 임계값 (≥2 문자), (d) 어간 추출 이후의
확장 stopword 재검사, (e) 어간 추출기의 ASCII-only 가드(Hangul 은
변경 없이 통과해야 함). 어떤 편차든 F1=0.900 의 실증적 주장을
무효화합니다 — 어간 추출기를 "개선"하거나 stopword 목록을
"정리"하려는 구현자는 land 하기 전에 `eval-drift.mjs` 를 재실행하여
결과를 확인해야 합니다.

## 설계 결정 요약

아래 모든 알고리즘 계층의 결정은 15 시나리오의 ground-truth 코퍼스에
대한 실증 검증에 근거합니다. 전체 결과·방법론·주의사항은
`VALIDATION_RESULTS.md` 에 기록되어 있으며 `node eval-drift.mjs` 로
재현 가능합니다.

| 차원 | 결정 |
|---|---|
| 윈도우 모양 | 인접한 두 대칭 윈도우, `N = M = 3` |
| 최소 히스토리 | **7 개** 토픽 이벤트 (DB 6 + 현재 1) |
| 콜드 스타트 | 워밍업 모드 없이 `[]` 반환 |
| 쿨다운 | 없음 — 알고리즘 자기 안정화 + DB 계층 중복 제거 |
| **결정 규칙** | **두 개의 인접 윈도우 쌍이 모두 임계치 미만일 때만 발화** |
| **토큰화** | **Phase 1 + 확장 일반어 정지 + 경량 어간 추출** |
| 통합 지점 | `extractUserEvents()` 에 선택적 두 번째 매개변수 추가 |
| 스코어링 거주지 | `topic-fence.ts` 내 순수 함수 `scoreDrift()` |
| 훅 결합 | `userpromptsubmit.mjs` 에 신규 1줄 (DB 조회) |
| 설정 표면 | 환경변수 3개 + 킬 스위치 1개, 모듈 로드 시 1회 캐싱 |
| **기본 임계치** | **`0.10`** Jaccard 유사도 (이 미만이면 드리프트 후보) |
| 롤아웃 전략 | 기본 활성화, `CONTEXT_MODE_TOPIC_FENCE_DISABLED=1` 로 비활성화 |
| 페이로드 결정론성 | 정렬된 키워드, 2자리 문자열 점수, 고정된 `window` 키 |
| `topic_drift` 우선순위 | `2` (아래 §페이로드 우선순위 근거 참조) |
| DB 조회 정렬 | `SessionDB.getEvents` 에 `recent: true` 옵션 신설 |
| 실증 F1 (코퍼스) | 0.900 (recall 1.000, precision 0.818) |

각 결정의 상세 근거는 설계 브레인스토밍 스레드에 기록되어 있으며, 본
문서 곳곳의 inline 설명에서 요약 인용됩니다.

## 아키텍처

### 모듈 경계

```
hooks/userpromptsubmit.mjs
        │
        ├── db.ts            (getEvents, insertEvent — 변경 최소)
        └── extract.ts       (extractUserEvents — 시그니처 확장)
                │
                └── topic-fence.ts    (scoreDrift — 신규 순수 함수)
```

의존성 그래프는 엄격하게 단방향입니다. 훅은 `db.ts` 와 `extract.ts` 를
import 하며 (Phase 1 과 동일), `extract.ts` 는 `topic-fence.ts` 를 import
하고 (Phase 1 과 동일), `topic-fence.ts` 는 어떤 영속화 계층도 import 하지
않습니다. Phase 2 는 훅 계층에 신규 import 를 전혀 추가하지 않습니다.

### 왜 이런 모양인가

원저자의 기존 패턴(`snapshot.ts` 에서 관찰됨)은 "순수 함수가 이미 조회된
데이터를 받아 순수 결과를 반환하고, 훅이 모든 I/O 를 담당한다"는 것입니다.
Phase 2 는 이 패턴을 따르되, 동시에 Phase 1 에서 확립된 또 하나의 속성 —
**훅이 extract 계층에 대해 단 하나의 진입점만 알고 있다**는 속성 — 을
보존합니다. `topicHistory` 를 `extractUserEvents` 의 선택적 두 번째
매개변수로 전달하면 두 속성이 동시에 만족됩니다. 훅은 여전히 단일 호출만
수행하고, `topic-fence.ts` 는 순수성을 유지합니다. 두 거부된 대안(인터페이스
래퍼; DB 결합 래퍼)과의 비교는 브레인스토밍 스레드에 상세히 기록되어
있습니다.

## API 표면

### `src/session/topic-fence.ts` — 신규 export

```ts
// ── 모듈 수준 설정 (로드 시 1회 캐싱) ──
const TOPIC_WINDOW_OLD       = clampInt(process.env.CONTEXT_MODE_TOPIC_WINDOW_OLD,       3,    1, 50);
const TOPIC_WINDOW_NEW       = clampInt(process.env.CONTEXT_MODE_TOPIC_WINDOW_NEW,       3,    1, 50);
const TOPIC_DRIFT_THRESHOLD  = clampFloat(process.env.CONTEXT_MODE_TOPIC_DRIFT_THRESHOLD, 0.10, 0, 1);
const TOPIC_FENCE_DISABLED   = process.env.CONTEXT_MODE_TOPIC_FENCE_DISABLED === "1";

// 확장 stopwords: Phase 1 의 기본 리스트에 일반 코딩 도메인 filler 약 80개
// 추가. 실증 근거는 VALIDATION_RESULTS.md 참조. 전체 리스트는
// topic-fence.ts 최상단의 STOPWORDS_EN 근처에 inline 됩니다.
const STOPWORDS_EN_EXTENDED = new Set([...STOPWORDS_EN, ...GENERIC_TECH_STOPWORDS]);

/**
 * 저장된 토픽 행의 최소 구조적 형태. `extract.ts` 가 `extractUserEvents`
 * 시그니처에서 동일한 타입을 재선언 없이 재사용할 수 있도록 export 합니다.
 * `SessionDB.getEvents` 는 `StoredEvent[]` 를 반환하는데, 이는 구조적으로
 * 본 타입의 상위 집합이므로 훅은 DB 행을 캐스트 없이 그대로 전달합니다.
 */
export type TopicHistoryRow = { data: string };

/**
 * 두 개의 인접 슬라이딩 윈도우 쌍에 대해 토픽 드리프트를 탐지합니다.
 *
 * Phase 2 는 **두 개의 연속된 window-pair Jaccard 점수가 모두**
 * TOPIC_DRIFT_THRESHOLD 미만일 것을 요구한 뒤에야 드리프트 이벤트를
 * 발행합니다. 이 "persistence" 규칙은 안정 토픽 내에서 발생하는 일회성
 * 어휘 회전을 필터링합니다 — 실증적으로, 안정 토픽 세션은 단일 턴의
 * 고립된 Jaccard dip 을 나타내는 반면, 진짜 드리프트는 여러 연속 턴에
 * 걸쳐 낮은 점수를 지속합니다 (`VALIDATION_RESULTS.md` 참조).
 *
 * 알고리즘 (`TOPIC_WINDOW_OLD=N`, `TOPIC_WINDOW_NEW=M`, 기본값 모두 3):
 *
 *   combined   = [...history, currentTopic]   // 기본값 하의 길이: N + M + 1 = 7
 *   prevOld    = combined[0 .. N)
 *   prevNew    = combined[N .. N+M)
 *   currOld    = combined[1 .. N+1)
 *   currNew    = combined[N+1 .. N+M+1)
 *   prevScore  = jaccard(union(prevOld), union(prevNew))
 *   currScore  = jaccard(union(currOld), union(currNew))
 *
 *   if (prevScore < THRESHOLD && currScore < THRESHOLD)
 *       → topic_drift 이벤트 발행
 *   else
 *       → [] 반환
 *
 * 다음 모든 경우에 [] 을 반환합니다: 콜드 스타트(`history.length < N + M`),
 * 킬 스위치, 두 점수 중 하나라도 임계치 이상, 병리적 빈 집합 폴백.
 *
 * "병리적 빈 집합" 케이스: 윈도우 내 모든 키워드 집합이 비어 있으면
 * (예: 모든 행의 JSON 손상), Jaccard 분모가 0 이 됩니다. 구현은 이때
 * 유사도를 `1.0`(최대 유사)으로 간주하며, 이는 어떤 임계치보다도 반드시
 * 높으므로 [] 을 생성합니다. 아래 엣지 케이스 #5 가 동일한 안전 폴백
 * 경로를 가리킵니다.
 *
 * 순수 함수. 결코 throw 하지 않음. 기본값 하에서 호출당 <1ms.
 */
export function scoreDrift(
  history: ReadonlyArray<TopicHistoryRow>,
  currentTopic: SessionEvent,
): SessionEvent[];
```

### `src/session/extract.ts` — 시그니처 확장

```ts
import { extractTopicSignal, scoreDrift, type TopicHistoryRow } from "./topic-fence.js";

export function extractUserEvents(
  message: string,
  topicHistory: ReadonlyArray<TopicHistoryRow> = [],
): SessionEvent[] {
  try {
    const events: SessionEvent[] = [];
    events.push(...extractUserDecision(message));
    events.push(...extractRole(message));
    events.push(...extractIntent(message));
    events.push(...extractData(message));

    const topicEvents = extractTopicSignal(message);
    events.push(...topicEvents);

    // Phase 2: 드리프트 스코어링 — history 가 제공되고 현재 토픽이 발행된 경우에만
    if (topicHistory.length > 0 && topicEvents.length > 0) {
      events.push(...scoreDrift(topicHistory, topicEvents[0]));
    }
    return events;
  } catch {
    return [];
  }
}
```

후방 호환성: `topicHistory` 의 기본값이 `[]` 이므로, 기존에
`extractUserEvents(message)` 형태로 호출하던 모든 어댑터는 변경 없이
그대로 컴파일·실행되며 드리프트 탐지만 비활성화된 상태로 동작합니다.

### `src/session/db.ts` — `getEvents` 에 `recent` 옵션 추가

기존 `SessionDB.getEvents` 는 `ORDER BY id ASC LIMIT ?` 로 동작하여
(`db.ts:221-235`), 주어진 타입의 **가장 오래된** N개 행을 반환합니다.
이는 드리프트 스코어링이 필요로 하는 것과 정반대입니다. Phase 2 는
**가장 최근의** N개 토픽 이벤트를 시간순으로 받아야 합니다. 두 가지
대안을 검토했습니다.

1. 전체 토픽 이벤트(세션당 1000 상한)를 조회한 뒤 훅에서 `.slice(-N)`.
   기각: 긴 세션에서 낭비, 확장성 불량.
2. `recent: true` 옵션을 추가하여 SQL 정렬을 뒤집음. 채택: 구조적 변경이
   작고, `db.ts:209-235` 의 다중 prepared statement 변형 패턴과 일치.

`db.ts` 에 필요한 diff:

```ts
// S 상수에 추가
getRecentEventsByType: "getRecentEventsByType",

// prepareStatements() 에 추가
p(S.getRecentEventsByType,
  `SELECT id, session_id, type, category, priority, data, source_hook, created_at, data_hash
   FROM session_events WHERE session_id = ? AND type = ? ORDER BY id DESC LIMIT ?`);

// getEvents 시그니처와 dispatch 확장
getEvents(
  sessionId: string,
  opts?: { type?: string; minPriority?: number; limit?: number; recent?: boolean },
): StoredEvent[] {
  // ... 기존 분기들 ...
  if (type && opts?.recent) {
    const rows = this.stmt(S.getRecentEventsByType).all(sessionId, type, limit) as StoredEvent[];
    return rows.reverse(); // 다운스트림 소비자를 위해 시간순(id ASC) 복원
  }
  // ... 나머지 변경 없음 ...
}
```

조회 후 reverse 단계는 호출자가 `recent` 플래그와 무관하게 항상 시간순
이벤트를 받도록 보장합니다. 기존 호출자들(`recent` 를 생략)은 영향
받지 않습니다.

### `hooks/userpromptsubmit.mjs` — 최소 글루

```js
// Phase 2: 드리프트 스코어링을 위해 가장 최근 (N+M) 개의 토픽 이벤트 조회
// 주의: 연속 2-window 규칙은 N+M 개의 historical 이벤트를 필요로 합니다
// (N+M-1 이 아님). 두 개의 인접 window pair 를 모두 계산할 수 있어야 하기
// 때문입니다.
const historySize = 6; // = 기본 설정 하의 TOPIC_WINDOW_OLD + TOPIC_WINDOW_NEW
const recentTopics = db.getEvents(sessionId, {
  type: "topic",
  limit: historySize,
  recent: true,
});
const userEvents = extractUserEvents(trimmed, recentTopics);
for (const ev of userEvents) {
  db.insertEvent(sessionId, ev, "UserPromptSubmit");
}
```

Phase 1 대비 정확히 신규 변수 1개 + 옵션 키 1개(`recent: true`). 기존
insert 루프가 신규 `topic_drift` 이벤트를 특수 케이스 없이 처리합니다.
`historySize = 6` 상수는 기본값 `TOPIC_WINDOW_OLD + TOPIC_WINDOW_NEW = 6`
에 맞춘 것이며, 사용자가 환경변수로 윈도우 크기를 기본값 이상으로 키우면
충분한 히스토리가 축적될 때까지 드리프트 스코어링이 콜드 스타트 상태로
남습니다 (안전한 품위 저하, 크래시 없음).

## 데이터 흐름

### 정상 케이스 트레이스

SessionDB 에 6개의 이전 `topic` 이벤트(`t1..t6`)가 누적된 상태에서,
사용자가 7번째 토픽-함유 메시지를 제출하는 상황을 가정합니다.

1. 훅: `db.getEvents(sessionId, {type:"topic", limit:6, recent:true})`
   → `[t1, t2, t3, t4, t5, t6]` (시간순 정렬)
2. 훅: `extractUserEvents(message, [t1..t6])` 호출
3. `extract.ts`: Phase 1 추출자들이 실행되고, `extractTopicSignal(message)`
   가 `t7` 를 발행
4. `extract.ts`: 조건 충족 → `scoreDrift([t1..t6], t7)` 호출
5. `topic-fence.ts`: `combined = [t1..t6, t7]` (토픽 이벤트 7개)
6. `topic-fence.ts` 는 **두 개의** 인접 윈도우 쌍을 계산:
   - `prevOld = [t1, t2, t3]`, `prevNew = [t4, t5, t6]` → `prevScore`
   - `currOld = [t2, t3, t4]`, `currNew = [t5, t6, t7]` → `currScore`
7. 각 쌍마다 윈도우별 키워드 합집합, 이후 Jaccard `J = |A∩B| / |A∪B|`
8. `prevScore < THRESHOLD && currScore < THRESHOLD` 이면 `topic_drift`
   이벤트 1개 발행; 아니면 `[]`
9. `extract.ts`: `[..., t7, drift?]` 반환
10. 훅: 반환된 모든 이벤트를 `db.insertEvent` 로 영속화

핫패스 신규 작업량: DB 쿼리 1회(이미 `idx_session_events_type` 로
인덱싱됨), 각 최대 48개 키워드 범위의 Jaccard 계산 2회, JSON stringify
1회. 결합 비용도 5 ms 예산에 충분히 여유.

### 왜 두 개의 윈도우 쌍인가

연속된 두 sub-threshold 점수를 요구하는 것은 안정 토픽 내에서의 일회성
어휘 회전을 필터링합니다 — 실증적으로 false positive 의 주요 원인이었던
패턴입니다. `prev` 윈도우 쌍은 "직전 사용자 턴에서 계산되었을 드리프트
점수" 에 해당하고, `curr` 윈도우 쌍은 "현재 사용자 턴의 드리프트 점수"
입니다. 탐지기가 발화하려면 두 점수 모두 낮아야 합니다. 이는 매 호출
시점에 상태 없이 계산됩니다 — 턴 간 지속 상태가 필요 없습니다.

## `topic_drift` 이벤트 스키마

```json
{
  "type": "topic_drift",
  "category": "topic",
  "data": "{\"prev_score\":\"0.07\",\"curr_score\":\"0.03\",\"old\":[\"auth\",\"jwt\",\"login\"],\"new\":[\"hooks\",\"react\",\"state\"],\"window\":[3,3]}",
  "priority": 2
}
```

페이로드는 **두** 윈도우 쌍의 점수(`prev_score`, `curr_score`)를 모두
기록합니다. 이를 통해 Phase 3 가 "드리프트가 연속 두 턴에 걸쳐 지속되었다"
는 근거를 표시할 수 있으며, "드리프트가 한 턴의 단발성 spike 였다" 가
아님을 명확히 할 수 있습니다. `old` 와 `new` 키워드 배열은 CURRENT
윈도우 쌍(`currOld`, `currNew`)에 해당합니다.

### 페이로드 우선순위 근거

`topic_drift` 는 `priority: 2` 를 갖는데, 이는 그 파생 원본인 `topic`
이벤트(Phase 1 의 `priority: 3`, `topic-fence.ts:98`)보다 한 단계 높습니다.
이유는 다음과 같습니다. Raw 토픽 이벤트는 메모리 압박 시 FIFO 축출을
감내할 수 있는 세밀한 기록 데이터지만, `topic_drift` 이벤트는 Phase 3 가
사용자에게 표면화할 *실행 가능한* 신호입니다. 드리프트 이벤트가 축출로
유실되면 topic-fence 가 존재하는 이유 자체가 조용히 사라지게 됩니다.
`priority: 2` 는 다른 사용자 대면 결정 이벤트의 처리와 동일하며
(`extract.ts:526` 의 `decision` 카테고리), 정상적인 축출 압박 하에서의
생존을 보장합니다.

### 페이로드 결정론성 규칙

이 규칙들은 DB 계층 중복 제거 메커니즘(최근 5개 이벤트 범위의
`(type, data_hash)` — `db.ts:240-246` 참조)이 재시도나 재호출로 인해
발생할 수 있는 동일한 드리프트 이벤트를 흡수할 수 있도록 존재합니다.

- **점수** — `prev_score` 와 `curr_score` 모두 `value.toFixed(2)` 로
  포맷하여 **문자열**로 저장. 두 번째 자릿수에서 부동소수점 잡음이
  흡수됨.
- **키워드** — `old` 와 `new` 배열 모두 직렬화 전에 사전식으로 정렬.
- **윈도우** — 실제 계산에 사용된 값과 일치하는 리터럴 2-요소 배열
  `[N, M]` 로 저장 (환경변수 기본값이 아님).
- **타임스탬프, 랜덤 ID, 세션 식별자 금지** — 이들이 포함되면 dedup
  해시가 무력화됨.

## 설정

환경변수 4개이며, 모두 모듈 로드 시 1회 읽어 캐싱합니다. 기본값과
검증 규칙:

| 변수 | 기본값 | 범위 | 파서 |
| --- | --- | --- | --- |
| `CONTEXT_MODE_TOPIC_WINDOW_OLD` | `3` | `[1, 50]` | `clampInt` |
| `CONTEXT_MODE_TOPIC_WINDOW_NEW` | `3` | `[1, 50]` | `clampInt` |
| `CONTEXT_MODE_TOPIC_DRIFT_THRESHOLD` | **`0.10`** | `[0.0, 1.0]` | `clampFloat` |
| `CONTEXT_MODE_TOPIC_FENCE_DISABLED` | *unset* | `"1"` 또는 unset | strict equality |

`clampInt` / `clampFloat` 는 다음 경우 중 하나에 해당하면 기본값을
반환합니다: `undefined`, `NaN`, 비숫자 문자열, 범위 밖 값. 부정한 입력은
조용히 정규화되며 — 시작 시 경고도, 예외도 없습니다. 이는 훅 계층의
"세션을 절대 블로킹하지 않는다" 계약과 정합적입니다.

### 기본 임계치 정당화

기본 임계치 `0.10` 은 검증 코퍼스에 대한 임계치 스윕을 통해 실증적으로
선정되었습니다. 전체 스윕 테이블은 `VALIDATION_RESULTS.md` 참조. 핵심
발견: `0.30` 임계치(원 스펙의 이론적 선택)는 안정 토픽 내에서도 단일
턴의 Jaccard 점수가 자연스럽게 `[0.03, 0.25]` 범위를 갖기 때문에
거의 모든 사용자 턴에서 드리프트를 발화하는 무의미한 값이었습니다.
`0.10` 임계치를 연속 2턴 규칙과 결합했을 때 검증 코퍼스에서
F1 = 0.900 (recall 1.000, precision 0.818) 을 달성했습니다.

Jaccard `< 0.10` 은 단일 턴 내에서 키워드 합집합의 90% 이상이 어느
한 윈도우에만 존재하고 동일 조건이 직전 턴에도 성립함을 의미합니다 —
지속적이고 실질적인 어휘 전환. 본 값은 recall 을 1.0 으로 유지하면서
(누락된 드리프트 없음) 약 18% 의 false positive 율을 수용하는 쪽으로
보정되어 있으며, 이는 "fence, not wall" 관용 범위 내입니다. 이
기본값은 Phase 4 에서 더 큰 코퍼스에 대한 ROC 분석을 통해 재조정되어야
합니다.

## 엣지 케이스

1. **콜드 스타트** (`history.length < TOPIC_WINDOW_OLD + TOPIC_WINDOW_NEW`):
   `scoreDrift` 가 `[]` 반환. 별도 알림 없음; Phase 1 은 계속 토픽
   이벤트를 누적. 기본 설정(`N=M=3`)에서는 `history.length < 6` 에 해당하며,
   이는 첫 드리프트 발화 가능 시점이 7번째 토픽-함유 사용자 턴이라는
   의미입니다. 운영자가 환경변수로 두 윈도우 중 어느 하나라도 키우면
   콜드 스타트 임계치도 자동으로 따라감 — 코드 수정 불필요.

2. **현재 메시지에 토픽이 없음** (`extractTopicSignal` 가 `[]` 반환):
   `extract.ts` 가 `scoreDrift` 호출을 건너뜀. 토픽 신호가 없는 턴에서는
   드리프트 평가도 수행되지 않음. 이는 "콘텐츠 밀도"가 아닌 "콘텐츠
   변화"에 반응한다는 설계와 일관됨.

3. **드리프트 직후 재발화 방지**: 알고리즘의 자기 안정화 특성으로 방지됨
   (토픽-함유 턴당 윈도우 경계가 1 이동하므로, 3개의 토픽-함유 턴 이내에
   old 윈도우가 새 토픽의 어휘를 흡수하고 Jaccard 가 복구됨). 주의:
   토픽 신호를 발행하지 않는 턴(엣지 케이스 #2)은 윈도우를 전진시키지
   않으므로, 사용자가 드리프트 직후 다수의 짧은 메시지를 보내는 특이
   상황에서는 재발화가 3 wall-clock 턴을 넘겨 지연될 수 있음.
   **추가 유의사항**: "3턴 내 복구" 주장은 새 드리프트 토픽의 어휘가
   그 3턴 동안 *안정적*으로 유지된다는 전제를 갖음. 두 토픽 사이의
   급격한 진동(A → B → A → B)은 반복적인 드리프트 이벤트를 유발할 수
   있음. 각 "복귀"가 실제 분포 변화를 만들기 때문. 이 병리적 케이스에서
   DB 계층 dedup 은 정확히 동일한 드리프트 페이로드의 방어선 역할을
   하지만, 키워드 집합이 다른 별개의 드리프트 이벤트는 *발행될 것임* —
   이는 탐지기 관점에서는 오히려 올바른 동작. 쿨다운은 설계 Q3 에 따라
   Phase 2 범위 외로 명시됨.

4. **손상된 토픽 데이터** (`JSON.parse` 가 히스토리 행 또는
   `currentTopic.data` 에서 throw): `scoreDrift` 가 행 단위로 catch 하여
   손상된 항목을 **빈 키워드 집합**으로 취급. 이 처리는 히스토리 행과
   현재 토픽 모두에 균일하게 적용됨 — 두 윈도우가 모두 빈 집합으로
   축소되면 엣지 케이스 #5 가 인수인계. 어떤 예외도 전파되지 않으며
   다른 행들은 정상 기여.

5. **두 윈도우 모두 빈 키워드 집합** (모든 히스토리 행이 손상된 병리적
   케이스): Jaccard 분모가 0 이 됨. 가드: 유사도를 `1.0`(드리프트
   없음)으로 간주하고 `[]` 반환. 침묵 쪽으로의 안전 폴백.

6. **킬 스위치** (`CONTEXT_MODE_TOPIC_FENCE_DISABLED=1`): `scoreDrift` 가
   즉시 `[]` 반환. **Phase 1 의 토픽 추출은 계속 정상 동작.** 이 비대칭이
   의도적인 이유는, 킬 스위치를 다시 해제했을 때 히스토리가 이미
   채워져 있으므로 워밍업 구간이 필요 없기 때문.

7. **FIFO 축출로 인한 공백**: `session_events` 는 1000 이벤트 상한이며
   우선순위 3 토픽 이벤트는 축출 대상에 포함됨.
   `getEvents(..., {limit: 6, recent: true})` 는 실재하는 행만 반환하고
   시간 순서는 보존되므로, 알고리즘은 별도 로직 없이 공백을 자연스럽게
   처리함 (반환된 6개 행만으로도 두 개의 연속 윈도우 쌍을 구성 가능).

## 오류 처리 철학

- `scoreDrift` 는 결코 throw 하지 않음. 모든 내부 연산(JSON 파싱, Jaccard
  산술, 페이로드 stringify)은 예기치 못한 실패 시 예외가 아닌 `[]` 를
  반환하도록 감싸짐 또는 가드됨.
- `extractUserEvents` 는 Phase 1 과 동일하게 최외곽 `try/catch` 를 유지하며
  어떤 실패에서도 `[]` 를 반환.
- 훅(`userpromptsubmit.mjs`)도 최외곽 `try/catch` 를 유지하며 어떤 실패에도
  조용히 반환 (`userpromptsubmit.mjs:21, 59`).
- 종합 효과: Phase 2 는 임의의 방식으로 실패할 수 있으나 사용자 프롬프트를
  결코 블로킹하지 않음. 관찰 가능한 최악의 실패 모드는 "이 세션에
  드리프트 경고가 없음"이며, 백그라운드 신호로서 수용 가능함.

## 테스트 전략

### 파일 위치

| 파일 | 범위 |
| --- | --- |
| `tests/session/topic-fence-drift.test.ts` | `scoreDrift` 단위 테스트 (신규) |
| `tests/session/session-extract.test.ts` | `extractUserEvents(message, history)` 통합 (기존 확장) |

훅 수준 스모크 테스트는 추가하지 않습니다. 기존 훅 번들 의존 테스트들은
`npm run build` 없이 실패하는 사전 실패 모드가 있으며(`tooling.md`),
이런 테스트를 더 추가하면 노이즈를 가중시킵니다. Phase 2 의 핵심 로직은
순수 함수이므로 훅 번들 없이도 완전한 회귀 방지가 가능합니다.

### 단위 테스트 매트릭스 (`scoreDrift`)

통합 테스트(`I`) 와 구분하기 위해 번호 접두사 `U` 사용.

| # | 입력 | 기대 |
|---|---|---|
| U1 | `history.length < N + M` (기본 설정: `< 6`) | `[]` (콜드 스타트) |
| U2 | 명확한 토픽 전환, prev 및 curr 윈도우 모두 0.10 미만 | 1개 드리프트 이벤트, `prev_score` 와 `curr_score` 모두 `< 0.10` |
| U3 | 동일 토픽이 모든 윈도우에 반복 | `[]` (점수 임계치 초과) |
| U4 | 부분 겹침 (~50% 키워드 공유) | `[]` (임계치 초과) |
| U5 | **단일 턴 dip** — prev 는 임계치 이상, curr 는 미만 | `[]` (persistence 규칙이 일회성 dip 거부) |
| U6 | **역방향 단일 턴 dip** — prev 는 미만, curr 는 이상 | `[]` (persistence 규칙이 일회성 dip 거부) |
| U7 | 히스토리 1행 손상 (`"data":"not-json"`) | 정상 처리, 손상 행은 빈 집합 |
| U8 | 모든 히스토리 행 손상 | `[]` (빈 합집합 안전 폴백) |
| U9 | `CONTEXT_MODE_TOPIC_FENCE_DISABLED=1` (`vi.stubEnv` 경유) | `[]` 즉시 반환 |
| U10 | 결정론 — 동일 입력 2회 호출 | 바이트 단위로 동일한 페이로드 문자열 |
| U11 | 스키마 형태 assertion — 정렬된 키, 2자리 prev/curr, window | 페이로드 JSON 명시적 assertion |
| U12 | 확장 stopwords 효과 — `function`/`test`/`run` 이 많은 세션 | 해당 토큰들이 Jaccard 계산 전에 제거됨 |
| U13 | 어간 추출 효과 — `testing`, `tested`, `tests` 수렴 | 세 단어 모두 동일한 키워드에 기여 |

### 통합 테스트 매트릭스 (`extractUserEvents`)

| # | 입력 | 기대 |
|---|---|---|
| I1 | `extractUserEvents("implementing auth")` (히스토리 인자 생략) | Phase 1 출력과 동일 (후방 호환성) |
| I2 | 토픽 전환 메시지 + **6행 히스토리** (아래 구성 주석 참조) | 결과에 `topic` + `topic_drift` 둘 다 존재 |
| I3 | 짧은 메시지 `"yes"` + 6행 히스토리 | `topic_drift` 없음 (현재 토픽 없음) |
| I4 | 토픽 메시지 + 5행 이하 히스토리 | `topic` 만, `topic_drift` 없음 (콜드 스타트) |
| I5 | 토픽 메시지 + 빈 히스토리 `[]` | `topic` 만, `topic_drift` 없음 (기본 매개변수) |

**I2 구성 주석**: 연속 2-윈도우-쌍 규칙은 `prevScore` 와 `currScore`
가 **모두** 임계치 미만이어야 합니다. 6행 히스토리를 position 1-3 과
4-6 에 서로 다른 토픽 어휘로 채워서 `prevOld = [1,2,3]` 과
`prevNew = [4,5,6]` 의 Jaccard 가 near-zero 가 되도록 한 뒤, 7번째
메시지의 어휘는 position 4-6 과는 일치하되 position 2-4 와는 다르게
구성해서 `currOld = [2,3,4]` 와 `currNew = [5,6,7]` 도 낮은 Jaccard
가 되도록 합니다. 이 구성은 까다로우며, 잘못하면 조용히 I4 와 유사한
콜드 스타트 출력이 나옵니다.

### 환경변수 테스트 패턴

상수가 모듈 로드 시 캐싱되므로, 환경변수 테스트는 `vi.resetModules()` 로
모듈을 재로드해야 합니다. **중요**: 재import 는 `topic-fence.ts` 를
*직접* 타겟해야 하며, `extract.ts` 를 타겟해서는 안 됩니다. `extract.ts`
가 `topic-fence.ts` 를 정적 import 하므로, `vi.resetModules()` 후에
`extract.ts` 를 재import 하는 테스트는 여전히 원본 캐싱된 `topic-fence`
상수를 사용하게 됩니다 (그리고 `extract.ts` 도 재import 하더라도
정적 import 체인 때문에 여전히 불안정합니다). 따라서 환경변수 오버라이드를
검증하는 테스트는 `scoreDrift` 를 직접 타겟해야 합니다:

```ts
import { vi, afterEach } from "vitest";
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it("respects custom window sizes", async () => {
  vi.stubEnv("CONTEXT_MODE_TOPIC_WINDOW_OLD", "2");
  const { scoreDrift } = await import("../../src/session/topic-fence.js");
  // scoreDrift 에 대한 assertion 만
});
```

`extractUserEvents` 에 대한 통합 테스트는 **기본** 환경변수 구성을
사용하며 수작업 입력 데이터로 드리프트 동작을 검증해야 합니다 — 배선이
제대로 되었는지를 확인하는 것이지, 환경변수가 반영되는지를 확인하는
것이 아닙니다.

### 검증 명령

```bash
npx vitest run tests/session/topic-fence-drift.test.ts
npx vitest run tests/session/session-extract.test.ts
npm run typecheck
```

전체 `npx vitest run` 은 **회귀 판정의 근거로 사용하지 않습니다**.
훅 번들 의존 테스트들의 사전 실패가 Phase 2 와 무관한 노이즈를
발생시키기 때문입니다 (`tooling.md`).

### 커버리지 목표

`scoreDrift` 의 6개 분기 전체 커버: 콜드 스타트, 킬 스위치, 손상 데이터,
빈 합집합 안전 폴백, 임계치 초과 드리프트, 임계치 미만 드리프트.
환경변수 오버라이드 경로는 최소 1케이스로 검증.

## 다음 단계 (Phase 3 미리보기)

Phase 3 는 여기서 발행된 `topic_drift` 이벤트를 소비합니다. topic-fence
범위 메모리(`topic_fence_scope.md`) 및 `.claude/skills/topic-fence/SKILL.md`
의 Phase 3 설명에 따라, Phase 3 는 **사용자 알림 전용**입니다 — 어떤
형태의 요약, compact 실행, 세션 분할 자동화도 별도 스킬 `topic-handoff`
에 속하며 여기서는 명시적 범위 외입니다.

계획된 Phase 3 표면:

1. `hooks/userpromptsubmit.mjs` 가 최근의 미확인 드리프트 이벤트를
   확인하고, 훅의 stdout 에 `<topic_drift>` 알림을 prepend 합니다.
   Claude Code 가 이를 다음 턴의 추가 컨텍스트로 주입합니다. 이는 순수한
   read-and-display 동작이며 — 드리프트 이벤트를 "확인됨"으로 마킹하는
   것 외의 상태 변경은 없습니다.
2. `snapshot.ts` 에 `buildTopicDriftSection` 이 추가되어 compact resume
   snapshot 에 최근 드리프트 이벤트를 나열합니다. 이는 read-only 표면이며,
   snapshot 의 기존 이벤트 분류 로직을 수정하지 않습니다.
3. 메시지 형식: 사용자에게 새 세션 시작을 고려하라고 제안하는 한 줄
   (예: *"Topic has shifted. Consider starting a new session."*). 블로킹
   없음, compact 없음, LLM 요약 없음 — 범위 경계는 유지됨.

Phase 4 는 테스트와 문서화를 도입하고, 누적된 실제 topic/drift 이벤트
데이터를 ROC 분석에 돌려 세 설정 기본값을 재조정합니다.
