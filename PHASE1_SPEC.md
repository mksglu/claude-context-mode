# Phase 1 설계 스펙: extractTopicSignal()

## 목표
사용자 메시지에서 주제 시그널(키워드)을 추출하여 SessionDB에 저장.
이후 Phase 2에서 drift 판정의 입력으로 사용.

## 위치
`src/session/extract.ts` — 기존 `extractUserEvents()` 내에서 호출

## 함수 시그니처
```typescript
function extractTopicSignal(message: string): SessionEvent[] {
  // Returns 0 or 1 event of type "topic", category "topic"
}
```

## 키워드 추출 전략

### 1단계: 불용어 제거 + 명사/동사 추출 (경량)
- LLM이나 외부 라이브러리 없이, 정규식 기반
- 불용어 리스트 (영어 + 한국어 기본)
- 2글자 이상, 특수문자 제외
- 메시지에서 상위 N개 키워드를 JSON 배열로 저장

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
  "좀","좀","네","예","아니","뭐","어떻게","왜","어디",
]);

function extractKeywords(message: string, maxKeywords = 8): string[] {
  const words = message
    .toLowerCase()
    .replace(/[^\w\sㄱ-ㅎ가-힣]/g, " ")  // 특수문자 → 공백
    .split(/\s+/)
    .filter(w => w.length >= 2)
    .filter(w => !STOPWORDS_EN.has(w) && !STOPWORDS_KO.has(w));

  // 빈도 기반 상위 N개
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

## SessionEvent 출력 형식
```typescript
{
  type: "topic",
  category: "topic",
  data: JSON.stringify({
    keywords: ["context", "drift", "session", "detection"],
    timestamp: new Date().toISOString(),
    messageLength: message.length,
  }),
  priority: 3,  // NORMAL — drift 판정에 필요하지만 eviction 시 양보 가능
}
```

## 통합 지점
```typescript
// extract.ts — extractUserEvents() 수정
export function extractUserEvents(message: string): SessionEvent[] {
  try {
    const events: SessionEvent[] = [];
    events.push(...extractUserDecision(message));
    events.push(...extractRole(message));
    events.push(...extractIntent(message));
    events.push(...extractData(message));
    events.push(...extractTopicSignal(message));  // ← 추가
    return events;
  } catch {
    return [];
  }
}
```

## 성능 제약
- 전체 실행 시간 <5ms (UserPromptSubmit 전체가 <10ms)
- 메모리 할당 최소화 (Set/Map 재사용)
- 네트워크 호출 금지
- 외부 라이브러리 금지 (순수 TypeScript)

## 테스트 케이스 (Phase 4에서 구현)
```typescript
// 1. 기본 키워드 추출
extractTopicSignal("context-mode에서 drift detection을 구현하려고 합니다")
// → keywords: ["context", "mode", "drift", "detection", "구현하려고"]

// 2. 짧은 메시지 → 빈 배열 (키워드 부족)
extractTopicSignal("네")
// → [] (이벤트 없음)

// 3. 불용어만 있는 메시지
extractTopicSignal("the is a an")
// → [] (이벤트 없음)

// 4. 한국어 메시지
extractTopicSignal("세션을 나눠서 진행할 수 있도록 감지해서 알려주는 기능")
// → keywords: ["세션", "나눠서", "진행할", "감지해서", "알려주는", "기능"]
```

## 다음 단계 (Phase 2 미리보기)
Phase 1이 완료되면, SessionDB에 연속된 topic 이벤트들이 쌓임.
Phase 2에서는:
1. 최근 N개 topic 이벤트의 키워드를 가져옴
2. 슬라이딩 윈도우로 인접 구간 간 Jaccard 유사도 계산
3. 유사도 < threshold → topic_drift 이벤트 생성
