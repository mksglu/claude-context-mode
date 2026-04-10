#!/usr/bin/env node
/**
 * topic-fence Phase 2 drift scoring — empirical validation harness.
 *
 * Self-contained ESM. Runnable with plain `node eval-drift.mjs`.
 * No dependencies, no build step, no TypeScript compiler required.
 *
 * Purpose: measure whether plain Jaccard (Phase 2's proposed default) is
 * "good enough" at catching topic drift in realistic LLM coding sessions.
 * Compares three variants:
 *
 *   Plain   — baseline Jaccard over keyword sets
 *   PathA   — extended stopword list + lightweight stemming
 *   PathB   — PathA enhancements + session-local IDF weighting
 *
 * Against a hand-written ground-truth corpus of 15 scenarios covering
 * clean shift, no-drift (stable topic), gradual drift, generic-vocabulary
 * masking, synonymy, and tangent-return patterns. Reports per-variant
 * precision/recall/F1 and lists per-scenario outcomes for failure analysis.
 *
 * This file exists under .claude/skills/topic-fence/ because it is a
 * design-validation artifact, not a production source file. It does not
 * ship to users. Its only consumer is the Phase 2 design decision.
 */

// ─────────────────────────────────────────────────────────────────────────
// Stopwords — copied verbatim from src/session/topic-fence.ts (Phase 1)
// so that the "Plain" variant exactly matches the shipped tokenizer.
// ─────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────
// Path A extensions — generic coding-domain "filler" terms that tend to
// poison Jaccard comparisons because they appear in almost every topic.
// These are added on top of the base stopword list.
// ─────────────────────────────────────────────────────────────────────────

const GENERIC_TECH_STOPWORDS = new Set([
  // generic verbs
  "use","using","used","make","makes","made","run","runs","running","ran",
  "check","checks","checking","checked","try","tries","trying","tried",
  "add","adds","adding","added","remove","removes","removing","removed",
  "update","updates","updating","updated","get","gets","getting","got",
  "set","sets","setting","need","needs","needed","want","wants","wanted",
  "show","shows","showing","showed","see","sees","seeing","saw",
  "look","looks","looking","looked","think","thinks","thinking","thought",
  "work","works","working","worked","fix","fixes","fixing","fixed",
  "build","builds","building","built","test","tests","testing","tested",
  "start","starts","starting","started","found","find","finds",
  "call","calls","calling","called","pass","passes","passing","passed",
  "return","returns","returning","returned","handle","handles","handling",
  "write","writes","writing","wrote","read","reads","reading",
  "change","changes","changing","changed","help","helps","helping",
  "create","creates","creating","created","delete","deletes","deleting",
  "let","lets","letting","move","moves","moving","moved",
  "now","next","first","then","actually","really","maybe","probably",
  "right","okay","good","great","nice","here","there","back","again",
  "new","old","big","small","old","same","different","many","much",
  "like","way","ways","thing","things","part","parts","side","sides",
  "case","cases","time","times","turn","turns","step","steps",
  // generic tech nouns
  "code","file","files","function","functions","method","methods",
  "class","classes","type","types","value","values","name","names",
  "data","item","items","list","lists","bug","bugs","error","errors",
  "issue","issues","problem","problems","thing","stuff",
  // generic modals
  "still","already","yet","even","also","too","either","neither",
  // filler from LLM prompts
  "implement","implementing","implementation","implemented",
]);

const STOPWORDS_EN_PATH_A = new Set([...STOPWORDS_EN, ...GENERIC_TECH_STOPWORDS]);

// ─────────────────────────────────────────────────────────────────────────
// Lightweight Porter-inspired stemmer — not a full Porter implementation,
// just the most common English suffix rules. Pure function, no deps.
// ─────────────────────────────────────────────────────────────────────────

function stem(word) {
  if (word.length <= 4) return word;
  // Order matters: longer suffixes first
  const suffixes = [
    "ational", "tional", "ization", "izing", "ized",
    "ingly", "edly", "ingly",
    "ments", "ment",
    "tions", "sions", "tion", "sion",
    "ness", "able", "ible",
    "ing", "ers", "ed", "er",
    "ly", "es", "s",
  ];
  for (const suf of suffixes) {
    if (word.length - suf.length >= 3 && word.endsWith(suf)) {
      return word.slice(0, word.length - suf.length);
    }
  }
  return word;
}

// ─────────────────────────────────────────────────────────────────────────
// Tokenizers — Plain matches Phase 1 exactly. PathA applies extended
// stopwords and stemming. PathB reuses PathA's tokenizer.
// ─────────────────────────────────────────────────────────────────────────

const TOPIC_MAX_KEYWORDS = 8;

function extractKeywordsPlain(message) {
  const normalized = message.toLowerCase().replace(/[^\w\sㄱ-ㅎ가-힣]/g, " ");
  const tokens = normalized.split(/\s+/);
  const freq = new Map();
  for (const token of tokens) {
    if (token.length < 2) continue;
    if (STOPWORDS_EN.has(token)) continue;
    if (STOPWORDS_KO.has(token)) continue;
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }
  if (freq.size === 0) return [];
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOPIC_MAX_KEYWORDS)
    .map(([w]) => w);
}

function extractKeywordsPathA(message) {
  const normalized = message.toLowerCase().replace(/[^\w\sㄱ-ㅎ가-힣]/g, " ");
  const tokens = normalized.split(/\s+/);
  const freq = new Map();
  for (const rawToken of tokens) {
    if (rawToken.length < 2) continue;
    if (STOPWORDS_EN_PATH_A.has(rawToken)) continue;
    if (STOPWORDS_KO.has(rawToken)) continue;
    // Apply stemming before frequency counting so "tested"/"tests"/"testing"
    // converge. Only stem ASCII tokens to preserve Hangul as-is.
    const token = /^[a-z]+$/.test(rawToken) ? stem(rawToken) : rawToken;
    if (token.length < 2) continue;
    // Re-check stopwords after stemming (some stems may collapse to stopwords)
    if (STOPWORDS_EN_PATH_A.has(token)) continue;
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }
  if (freq.size === 0) return [];
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOPIC_MAX_KEYWORDS)
    .map(([w]) => w);
}

// ─────────────────────────────────────────────────────────────────────────
// Scoring variants. Signature: (history, current, opts?) → {fired, score}
// where history is a keyword-array-of-arrays and current is a keyword-array.
// Returns null for cold-start (insufficient history).
// ─────────────────────────────────────────────────────────────────────────

const DEFAULTS = { N: 3, M: 3, threshold: 0.3 };

function scoreDriftPlain(history, current, opts = {}) {
  const { N, M, threshold } = { ...DEFAULTS, ...opts };
  const combined = [...history, current];
  if (combined.length < N + M) return null;
  const oldWindow = combined.slice(0, N);
  const newWindow = combined.slice(-M);
  const oldSet = new Set(oldWindow.flat());
  const newSet = new Set(newWindow.flat());
  if (oldSet.size === 0 && newSet.size === 0) return { fired: false, score: 1.0 };
  const inter = [...oldSet].filter((w) => newSet.has(w)).length;
  const uni = new Set([...oldSet, ...newSet]).size;
  const j = uni === 0 ? 1.0 : inter / uni;
  return { fired: j < threshold, score: j };
}

// Path A scoring is identical to Plain in shape, but callers feed it the
// Path A tokenizer output instead of the Plain tokenizer output.
const scoreDriftPathA = scoreDriftPlain;

// Path B uses session-local IDF weighting. It needs the full session's
// topic history (not just the last N+M-1 events) to compute IDF.
function scoreDriftPathB(history, current, allTopicEvents, opts = {}) {
  const { N, M, threshold } = { ...DEFAULTS, ...opts };
  const combined = [...history, current];
  if (combined.length < N + M) return null;

  // Session-local IDF: how many topic events does each keyword appear in?
  const corpus = allTopicEvents.length > 0 ? allTopicEvents : combined;
  const docCount = corpus.length;
  const df = new Map();
  for (const doc of corpus) {
    const unique = new Set(doc);
    for (const kw of unique) {
      df.set(kw, (df.get(kw) ?? 0) + 1);
    }
  }
  const idf = new Map();
  for (const [kw, count] of df) {
    // Smoothed IDF: log((N+1)/(df+1)) + 1, so that extremely common
    // terms get ~1 and rare terms get larger weights.
    idf.set(kw, Math.log((docCount + 1) / (count + 1)) + 1);
  }

  const oldSet = new Set(combined.slice(0, N).flat());
  const newSet = new Set(combined.slice(-M).flat());
  const allKeywords = new Set([...oldSet, ...newSet]);

  let numer = 0;
  let denom = 0;
  for (const kw of allKeywords) {
    const w = idf.get(kw) ?? 1.0;
    const inOld = oldSet.has(kw) ? 1 : 0;
    const inNew = newSet.has(kw) ? 1 : 0;
    numer += w * Math.min(inOld, inNew);
    denom += w * Math.max(inOld, inNew);
  }
  const j = denom === 0 ? 1.0 : numer / denom;
  return { fired: j < threshold, score: j };
}

// ─────────────────────────────────────────────────────────────────────────
// Ground-truth corpus. Each scenario is a list of user messages in order.
// `driftAt` is the 0-based index of the FIRST message that introduces a
// meaningfully different topic. null means "no drift should fire anywhere".
// Note: we do NOT label turn-by-turn — we label the scenario as "drift
// expected" or "drift not expected" and measure whether the scorer fires
// at any point after cold-start.
// ─────────────────────────────────────────────────────────────────────────

const CORPUS = [
  // ── Category: clean_shift — should detect drift ────────────────────────
  {
    id: "S01",
    category: "clean_shift",
    description: "React UI → PostgreSQL schema design",
    driftAt: 5,
    messages: [
      "I want to build a React component for displaying a list of users",
      "How do I use useState to manage the selected user in the component",
      "The list is not updating when I add a new user to the state array",
      "Let me refactor this to use useEffect for the fetch call on mount",
      "Actually the component renders correctly now, moving on to the next task",
      "I need to design a PostgreSQL schema for storing user activity logs",
      "What is the best way to index a timestamp column for range queries on large tables",
      "Should I use a BRIN index or a btree index for this kind of append-only table",
      "Let me run EXPLAIN ANALYZE on the query to see the execution plan",
    ],
  },
  {
    id: "S02",
    category: "clean_shift",
    description: "Auth bug debugging → README documentation",
    driftAt: 5,
    messages: [
      "There is a bug in the authentication middleware, it is rejecting valid tokens",
      "Let me check how the JWT verification library is configured with its options",
      "Found it, the clock skew tolerance was set too low for distributed nodes",
      "Fixing the middleware to allow 30 seconds of clock skew between services",
      "Added the unit test for this specific fix with a mocked clock",
      "Now I need to update the project README with the deployment instructions",
      "Can you help me draft a section explaining the authentication request flow",
      "Add an architecture diagram showing how tokens propagate through the services",
    ],
  },
  {
    id: "S03",
    category: "clean_shift",
    description: "Login endpoint → GitHub Actions CI",
    driftAt: 5,
    messages: [
      "Building a login endpoint with bcrypt password hashing for the backend",
      "How should I rate limit failed login attempts to prevent brute force attacks",
      "Let me use express-rate-limit middleware with a Redis backing store for distributed rate limiting",
      "Need to add refresh token rotation for improved security against token theft",
      "Authentication flow is ready and passing all the tests",
      "Setting up GitHub Actions workflow for this repository from scratch",
      "I want the pipeline to run tests on every push to any branch",
      "Configure the workflow to deploy to staging environment on merge to main branch",
      "Set up GitHub secrets for the deployment credentials and API keys",
    ],
  },

  // ── Category: no_drift — stable single topic ──────────────────────────
  {
    id: "S04",
    category: "no_drift",
    description: "React shopping cart — extended single-topic session",
    driftAt: null,
    messages: [
      "Working on a React shopping cart component with item management",
      "Need to track cart items in component state with useState hook",
      "How do I update the quantity of an existing item in the cart state",
      "The re-render is not triggering when I mutate the state array directly",
      "Right, I need to create a new array with the updated item for React to re-render",
      "Let me use map to return a new array containing the updated item with new quantity",
      "How do I remove an item from the cart when the user clicks the remove button",
      "Use filter to create a new array without the item matching the removed id",
      "I need to persist the cart contents to localStorage so they survive page reload",
      "useEffect hook can handle the localStorage sync on every cart state change",
    ],
  },
  {
    id: "S05",
    category: "no_drift",
    description: "SQL query performance debugging — single table, single problem",
    driftAt: null,
    messages: [
      "My SQL query is really slow on the orders table in production",
      "The orders table has about 10 million rows and the query takes 30 seconds to return",
      "I am filtering by customer_id and a date range on the order_date column",
      "Let me check if there is an index on the customer_id column already",
      "There is an index on customer_id but no index on the order_date column",
      "Should I create a composite index on customer_id and order_date together",
      "The query planner is still doing a sequential scan despite the new index being present",
      "Maybe the table statistics are out of date, let me run ANALYZE on the orders table",
      "After running ANALYZE the query planner picks the composite index scan correctly",
    ],
  },
  {
    id: "S06",
    category: "no_drift",
    description: "REST API endpoints — related but varying within one feature",
    driftAt: null,
    messages: [
      "Implementing a REST API for a blog platform in Express with TypeScript",
      "Started with GET /posts endpoint that returns all posts with pagination",
      "Added pagination with limit and offset query parameters to the posts route",
      "Next I need POST /posts to create a new post with title and body fields",
      "Validate the incoming request body with a Joi schema before inserting",
      "Return 201 Created with the new post ID in the response body",
      "Now PUT /posts/:id for updating an existing post by its identifier",
      "Authorization check so only the original author can update their own post",
      "DELETE /posts/:id with soft delete using a deleted_at timestamp column",
    ],
  },

  // ── Category: gradual — drift builds up over many turns ───────────────
  {
    id: "S07",
    category: "gradual",
    description: "React → backend → database (full-stack drift)",
    driftAt: 6,
    messages: [
      "I have a React component that fetches user data from my API endpoint",
      "The fetch is slow so let me add proper loading states to the component",
      "Using useState to track loading flag and error message in the component",
      "The API endpoint at /api/users is really slow to respond with data",
      "Let me look at the backend Express route handler for the users endpoint",
      "The route queries the database with findMany including all nested relations",
      "That is fetching too much data, let me select only the fields the frontend needs",
      "The Prisma query is generating a complex SQL statement with multiple joins",
      "Actually the database itself is missing a critical index on user.team_id column",
      "Adding the index on team_id, now the database query is 10x faster than before",
    ],
  },
  {
    id: "S08",
    category: "gradual",
    description: "Unit tests → integration → E2E → deployment → monitoring",
    driftAt: 7,
    messages: [
      "Writing unit tests for my utility functions with vitest",
      "Testing the date formatting helpers with various input formats",
      "Adding integration tests that hit a real test database via docker",
      "Docker compose spins up postgres and redis for the integration test suite",
      "E2E tests with playwright for the checkout flow in the browser",
      "Playwright needs the app server to be running, let me add a startup hook",
      "The E2E tests need to run in CI as well, configuring GitHub Actions for that",
      "Docker image build for the app to use in production kubernetes deployment",
      "Kubernetes deployment manifest for the staging cluster with proper resources",
      "Setting up Prometheus monitoring and Grafana dashboards for the new service",
    ],
  },
  {
    id: "S09",
    category: "gradual",
    description: "Type error → tsconfig → build system → dependency → new feature",
    driftAt: 8,
    messages: [
      "Getting a TypeScript error in my Express route handler about request types",
      "It says the Request object is not compatible with my custom middleware type extension",
      "Let me fix the type extension file for the Express Request interface",
      "Update tsconfig.json to include the custom types directory in compilation",
      "The strict mode is catching a lot of implicit any types in older code",
      "Upgrading typescript to the latest major version to get better type inference",
      "The build is failing now due to breaking changes in the new TypeScript version",
      "Rolling back typescript and pinning it to the previous working version in package.json",
      "Now let me start on the user profile feature that was requested last week",
      "Add a profile page with avatar upload and bio editing for authenticated users",
    ],
  },

  // ── Category: generic_masking — drift despite generic vocabulary ─────
  {
    id: "S10",
    category: "generic_masking",
    description: "Bug fix in auth → bug fix in database (same filler words)",
    driftAt: 5,
    messages: [
      "There is a bug in the authentication function that is returning the wrong user",
      "Let me test the function with a known input and check the output carefully",
      "The function is calling getUserById but the test is failing with null",
      "Fix the bug by handling the null case inside the authentication function",
      "Running the test suite again to verify the fix works for all cases",
      "Now there is another bug in the database connection pool function",
      "The test for the database connection function is failing intermittently in CI",
      "The pool function has a race condition when acquiring a connection",
      "Fix the race by using a mutex inside the database connection function",
      "Run the tests to verify the database pool fix works under load",
    ],
  },
  {
    id: "S11",
    category: "generic_masking",
    description: "Refactor UserService → refactor OrderProcessor (same refactor vocabulary)",
    driftAt: 5,
    messages: [
      "Refactoring the UserService class to use dependency injection properly",
      "The user class has too many responsibilities and needs to be split up",
      "Extract the email sending logic into a separate EmailService class",
      "The refactoring is making the user class much more testable in isolation",
      "User class methods are now smaller and easier to understand at a glance",
      "Next refactoring target is the OrderProcessor class in the checkout module",
      "This order class has validation and processing methods tangled together",
      "Split the order class into OrderValidator and OrderExecutor separate classes",
      "The order refactoring improves the separation of concerns significantly",
      "Order class methods now each do exactly one thing well",
    ],
  },

  // ── Category: synonymy — same topic with varied vocabulary ────────────
  {
    id: "S12",
    category: "synonymy",
    description: "Authentication topic with auth/login/signin/credentials used interchangeably",
    driftAt: null,
    messages: [
      "Building an authentication system for my web application",
      "Users need to login with email and password credentials",
      "The sign-in form should validate credentials before submission",
      "Authentication should issue a JWT token on successful login attempt",
      "The login endpoint verifies the password hash against bcrypt",
      "Auth middleware validates the bearer token on protected routes",
      "Sign-out should invalidate the refresh token on the server side",
      "Storing user credentials securely with bcrypt hashing and salt",
    ],
  },
  {
    id: "S13",
    category: "synonymy",
    description: "Tax calculation logic — function/method/procedure used interchangeably",
    driftAt: null,
    messages: [
      "Adding a new function to calculate the tax rate for checkout orders",
      "The method should take a price value and return the tax amount",
      "Need to handle different tax rates per geographic region correctly",
      "The procedure uses a lookup table keyed by region code for rates",
      "Writing tests for the tax function with various input price values",
      "The tax method should throw an error for invalid or unknown regions",
      "Refactoring the tax procedure to use a switch statement for clarity",
      "The function now has proper error handling for all edge cases",
    ],
  },

  // ── Category: tangent_return — brief digression then back to main ────
  {
    id: "S14",
    category: "tangent_return",
    description: "Profile form work → brief HMR debug → back to profile form",
    driftAt: null,
    messages: [
      "Working on the user profile feature for my React application",
      "Adding a form to edit the user name and email address fields",
      "Wait, my dev server is not hot reloading components anymore",
      "Let me check my webpack config for the HMR plugin setup",
      "Found it, the HMR plugin was accidentally commented out in the config",
      "OK HMR works again, back to the profile form implementation",
      "Need to add validation for the email field with regex pattern",
      "Using react-hook-form with yup schema for the profile form validation",
    ],
  },

  // ── Category: Korean clean_shift — verify cross-language tokenizer ──
  {
    id: "S15",
    category: "clean_shift",
    description: "Korean: React state → PostgreSQL schema",
    driftAt: 5,
    messages: [
      "리액트 컴포넌트에서 사용자 목록 상태를 관리하는 방법을 찾고 있습니다",
      "useState 로 사용자 배열을 관리하려고 하는데 리렌더가 안 됩니다",
      "setState 할 때 배열을 새로 만들어야 한다는 것을 알게 되었습니다",
      "map 을 사용해서 새로운 배열을 반환하도록 수정했습니다",
      "컴포넌트가 정상적으로 동작합니다 이제 다음 작업으로 넘어가겠습니다",
      "이번엔 PostgreSQL 데이터베이스 스키마를 설계하고 싶습니다",
      "사용자 활동 로그를 저장할 테이블이 필요하고 수백만 행이 예상됩니다",
      "시간 범위 쿼리를 위한 BRIN 인덱스가 적합한지 btree 가 나은지 궁금합니다",
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────
// Evaluation harness
// ─────────────────────────────────────────────────────────────────────────

const TOPIC_MIN_KEYWORDS = 2;

function simulateScenarioPlain(scenario) {
  // Returns { scores: number[], topicCount, minScore }
  const topicEvents = [];
  const scores = [];

  for (let i = 0; i < scenario.messages.length; i++) {
    const kws = extractKeywordsPlain(scenario.messages[i]);
    if (kws.length < TOPIC_MIN_KEYWORDS) continue;
    const history = topicEvents.slice(-5);
    const result = scoreDriftPlain(history, kws, { threshold: -1 }); // disable firing
    topicEvents.push(kws);
    if (result) scores.push({ turn: i, score: result.score });
  }
  const minScore = scores.length > 0 ? Math.min(...scores.map((s) => s.score)) : 1.0;
  return { scores, topicCount: topicEvents.length, minScore };
}

function simulateScenarioPathA(scenario) {
  const topicEvents = [];
  const scores = [];

  for (let i = 0; i < scenario.messages.length; i++) {
    const kws = extractKeywordsPathA(scenario.messages[i]);
    if (kws.length < TOPIC_MIN_KEYWORDS) continue;
    const history = topicEvents.slice(-5);
    const result = scoreDriftPathA(history, kws, { threshold: -1 });
    topicEvents.push(kws);
    if (result) scores.push({ turn: i, score: result.score });
  }
  const minScore = scores.length > 0 ? Math.min(...scores.map((s) => s.score)) : 1.0;
  return { scores, topicCount: topicEvents.length, minScore };
}

function simulateScenarioPathB(scenario) {
  const topicEvents = [];
  const scores = [];

  for (let i = 0; i < scenario.messages.length; i++) {
    const kws = extractKeywordsPathA(scenario.messages[i]);
    if (kws.length < TOPIC_MIN_KEYWORDS) continue;
    const history = topicEvents.slice(-5);
    const result = scoreDriftPathB(history, kws, topicEvents, { threshold: -1 });
    topicEvents.push(kws);
    if (result) scores.push({ turn: i, score: result.score });
  }
  const minScore = scores.length > 0 ? Math.min(...scores.map((s) => s.score)) : 1.0;
  return { scores, topicCount: topicEvents.length, minScore };
}

function classifyAtThreshold(scenario, simResult, threshold) {
  const expected = scenario.driftAt !== null;
  const fired = simResult.minScore < threshold;
  if (expected && fired) return "TP";
  if (expected && !fired) return "FN";
  if (!expected && fired) return "FP";
  return "TN";
}

// Path C: Firing requires TWO consecutive turns below threshold.
// Simulates the same tokenizer as Path A but uses a different decision rule.
function decisionPathC(scores, threshold) {
  for (let i = 1; i < scores.length; i++) {
    if (scores[i - 1].score < threshold && scores[i].score < threshold) {
      return { fired: true, firedAt: scores[i].turn };
    }
  }
  return { fired: false, firedAt: null };
}

// Path D: Firing requires the rolling mean of the last K=2 scores to drop
// below threshold. Smoother alternative to Path C.
function decisionPathD(scores, threshold, window = 2) {
  if (scores.length < window) return { fired: false, firedAt: null };
  for (let i = window - 1; i < scores.length; i++) {
    let sum = 0;
    for (let j = 0; j < window; j++) sum += scores[i - j].score;
    const mean = sum / window;
    if (mean < threshold) return { fired: true, firedAt: scores[i].turn };
  }
  return { fired: false, firedAt: null };
}

// Classification under alternative decision rules.
function classifyAtThresholdWithRule(scenario, simResult, threshold, rule) {
  const expected = scenario.driftAt !== null;
  const decision = rule(simResult.scores, threshold);
  if (expected && decision.fired) return "TP";
  if (expected && !decision.fired) return "FN";
  if (!expected && decision.fired) return "FP";
  return "TN";
}

function metrics(counts) {
  const { TP, FP, FN } = counts;
  const precision = TP + FP === 0 ? 0 : TP / (TP + FP);
  const recall = TP + FN === 0 ? 0 : TP / (TP + FN);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

function pad(s, n) {
  s = String(s);
  return s + " ".repeat(Math.max(0, n - s.length));
}

function padLeft(s, n) {
  s = String(s);
  return " ".repeat(Math.max(0, n - s.length)) + s;
}

// Simulate all scenarios once per variant and collect minScores.
function simulateAll(simulate) {
  return CORPUS.map((scenario) => {
    const sim = simulate(scenario);
    return { scenario, sim };
  });
}

// Evaluate a variant across a sweep of thresholds; return best F1 point.
// Uses a decision rule that maps scores + threshold → {fired, firedAt}.
function sweepThresholds(variantName, simResults, thresholds, rule) {
  const decide = rule ?? ((scores, threshold) => {
    const min = Math.min(...scores.map((s) => s.score));
    return { fired: min < threshold, firedAt: null };
  });
  const sweep = thresholds.map((threshold) => {
    const counts = { TP: 0, FP: 0, FN: 0, TN: 0 };
    for (const { scenario, sim } of simResults) {
      const outcome = classifyAtThresholdWithRule(scenario, sim, threshold, decide);
      counts[outcome]++;
    }
    const m = metrics(counts);
    return { threshold, counts, ...m };
  });
  // Best F1 (ties broken by higher precision then higher recall)
  const best = sweep.reduce((a, b) => {
    if (b.f1 > a.f1) return b;
    if (b.f1 < a.f1) return a;
    if (b.precision > a.precision) return b;
    if (b.precision < a.precision) return a;
    return b.recall > a.recall ? b : a;
  });
  return { variantName, sweep, best };
}

function printMinScoreDistribution(variantName, simResults) {
  console.log("\n" + "═".repeat(78));
  console.log("Variant: " + variantName);
  console.log("Per-scenario minimum Jaccard score across all turns");
  console.log("═".repeat(78));
  console.log(
    pad("id", 5) +
      pad("category", 18) +
      pad("driftExp", 10) +
      pad("minScore", 11) +
      "messages/topics",
  );
  console.log("─".repeat(78));
  // Group by drift-expected vs not, to visualize separation
  const driftExpected = simResults.filter((r) => r.scenario.driftAt !== null);
  const noDrift = simResults.filter((r) => r.scenario.driftAt === null);
  for (const { scenario, sim } of driftExpected) {
    console.log(
      pad(scenario.id, 5) +
        pad(scenario.category, 18) +
        pad("yes", 10) +
        pad(sim.minScore.toFixed(3), 11) +
        `${scenario.messages.length}/${sim.topicCount}`,
    );
  }
  console.log("  ── (expected-no-drift scenarios below) ──");
  for (const { scenario, sim } of noDrift) {
    console.log(
      pad(scenario.id, 5) +
        pad(scenario.category, 18) +
        pad("no", 10) +
        pad(sim.minScore.toFixed(3), 11) +
        `${scenario.messages.length}/${sim.topicCount}`,
    );
  }
  console.log("─".repeat(78));
  const driftScores = driftExpected.map((r) => r.sim.minScore);
  const noDriftScores = noDrift.map((r) => r.sim.minScore);
  const driftMax = Math.max(...driftScores).toFixed(3);
  const driftMean = (driftScores.reduce((a, b) => a + b, 0) / driftScores.length).toFixed(3);
  const noDriftMin = Math.min(...noDriftScores).toFixed(3);
  const noDriftMean = (noDriftScores.reduce((a, b) => a + b, 0) / noDriftScores.length).toFixed(3);
  console.log(
    `drift scenarios:    min=${Math.min(...driftScores).toFixed(3)}  mean=${driftMean}  max=${driftMax}`,
  );
  console.log(
    `no-drift scenarios: min=${noDriftMin}  mean=${noDriftMean}  max=${Math.max(...noDriftScores).toFixed(3)}`,
  );
  const gap = parseFloat(noDriftMin) - parseFloat(driftMax);
  console.log(
    `separation gap (no-drift min − drift max): ${gap.toFixed(3)} ` +
      (gap > 0 ? "✓ separable" : "✗ overlap — threshold cannot perfectly separate"),
  );
}

function printThresholdSweep(result) {
  console.log("\n" + "═".repeat(78));
  console.log("Variant: " + result.variantName);
  console.log("Threshold sweep");
  console.log("═".repeat(78));
  console.log(
    pad("threshold", 12) +
      pad("TP", 5) +
      pad("FP", 5) +
      pad("FN", 5) +
      pad("TN", 5) +
      pad("P", 8) +
      pad("R", 8) +
      "F1",
  );
  console.log("─".repeat(78));
  for (const row of result.sweep) {
    const marker = row === result.best ? "★ " : "  ";
    console.log(
      marker +
        pad(row.threshold.toFixed(2), 10) +
        pad(row.counts.TP, 5) +
        pad(row.counts.FP, 5) +
        pad(row.counts.FN, 5) +
        pad(row.counts.TN, 5) +
        pad(row.precision.toFixed(3), 8) +
        pad(row.recall.toFixed(3), 8) +
        row.f1.toFixed(3),
    );
  }
  console.log("─".repeat(78));
  console.log(
    `best threshold: ${result.best.threshold.toFixed(2)}  ` +
      `F1=${result.best.f1.toFixed(3)}  ` +
      `P=${result.best.precision.toFixed(3)}  ` +
      `R=${result.best.recall.toFixed(3)}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

console.log("topic-fence Phase 2 drift scoring — empirical validation");
console.log("Corpus: " + CORPUS.length + " scenarios");
console.log(
  "Categories: " +
    [...new Set(CORPUS.map((s) => s.category))].join(", "),
);

const THRESHOLDS = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80];

const plainSim = simulateAll(simulateScenarioPlain);
const pathASim = simulateAll(simulateScenarioPathA);
const pathBSim = simulateAll(simulateScenarioPathB);

printMinScoreDistribution("Plain Jaccard (Phase 1 stopwords only)", plainSim);
printMinScoreDistribution("Path A (extended stopwords + stemming)", pathASim);
printMinScoreDistribution("Path B (Path A + session-local IDF)", pathBSim);

const plainSweep = sweepThresholds("Plain Jaccard", plainSim, THRESHOLDS);
const pathASweep = sweepThresholds("Path A", pathASim, THRESHOLDS);
const pathBSweep = sweepThresholds("Path B", pathBSim, THRESHOLDS);

// Path C: Path A tokenizer + 2-consecutive-turn rule
const pathCSweep = sweepThresholds("Path C (Path A + 2-consec rule)", pathASim, THRESHOLDS, decisionPathC);

// Path D: Path A tokenizer + 2-turn rolling mean rule
const pathDSweep = sweepThresholds("Path D (Path A + rolling mean)", pathASim, THRESHOLDS, (scores, threshold) =>
  decisionPathD(scores, threshold, 2),
);

// Path E: Path A tokenizer + 3-turn rolling mean rule
const pathESweep = sweepThresholds("Path E (Path A + 3-turn rolling)", pathASim, THRESHOLDS, (scores, threshold) =>
  decisionPathD(scores, threshold, 3),
);

printThresholdSweep(plainSweep);
printThresholdSweep(pathASweep);
printThresholdSweep(pathBSweep);
printThresholdSweep(pathCSweep);
printThresholdSweep(pathDSweep);
printThresholdSweep(pathESweep);

console.log("\n" + "═".repeat(78));
console.log("Summary — best achievable F1 per variant");
console.log("═".repeat(78));
console.log(pad("Variant", 45) + pad("best thr", 10) + pad("P", 8) + pad("R", 8) + "F1");
console.log("─".repeat(78));
for (const v of [plainSweep, pathASweep, pathBSweep, pathCSweep, pathDSweep, pathESweep]) {
  console.log(
    pad(v.variantName, 45) +
      pad(v.best.threshold.toFixed(2), 10) +
      pad(v.best.precision.toFixed(3), 8) +
      pad(v.best.recall.toFixed(3), 8) +
      v.best.f1.toFixed(3),
  );
}
console.log("─".repeat(78));

// ─────────────────────────────────────────────────────────────────────────
// Per-turn score dump for false-positive diagnosis
// ─────────────────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(78));
console.log("Per-turn Path A scores for ambiguous scenarios (debug)");
console.log("═".repeat(78));
for (const { scenario, sim } of pathASim) {
  const driftExp = scenario.driftAt !== null;
  // Show only scenarios whose min score is in the ambiguous zone
  if (sim.minScore > 0.15) continue;
  console.log(
    `\n${scenario.id} [${scenario.category}] (drift expected: ${driftExp ? "yes" : "no"}) — ${scenario.description}`,
  );
  const scoreStr = sim.scores.map((s) => `t${s.turn}=${s.score.toFixed(2)}`).join("  ");
  console.log("  " + scoreStr);
}
