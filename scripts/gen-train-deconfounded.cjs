#!/usr/bin/env node
/**
 * gen-train-deconfounded.cjs — Generate diverse, natural training data.
 *
 * ROOT CAUSE OF PREVIOUS FAILURES (diagnosed 2026-07-14):
 *   v1: Length-confounded data (all label=0 < 100 chars, label=1 > 100 chars).
 *       Model learned "long → turn" instead of the pivot pattern.
 *   v2: Both classes shared the same 25-sentence context banks, differing only
 *       in a connector word (turn vs flow). Identical texts appeared in both
 *       classes with opposite labels. Loss stuck at ln(2)=0.693 = zero learning.
 *
 * FIX (v3): Generate data that mimics real LLM responses:
 *   - POSITIVE: LLM commits to direction A (2-3 sentences of analysis/advice),
 *     then pivots with a turning word (However, Wait, But, 然而) to a DIFFERENT
 *     or contradictory direction B. The context before and after the turn is
 *     genuinely different — the model must detect the pivot, not memorize templates.
 *   - NEGATIVE: A straightforward multi-sentence response that develops ONE
 *     direction without any pivot. Same length distribution (deconfounded).
 *   - Large, diverse topic banks ensure pos/neg texts are textually distinct.
 *   - No identical texts across classes.
 *
 * Output: ~/.mycc-store/crossroad-trainer/data/
 *   - seed-positive.jsonl  (label=1, with turnIndex)
 *   - seed-negative.jsonl  (label=0)
 *
 * Format per line: {"text": "...", "label": 1, "turnIndex": <int>}
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.mycc-store', 'crossroad-trainer', 'data');

// ---------------------------------------------------------------------------
// Topic banks — DIVERSE, covering many software engineering domains.
// Each topic is a short scenario. We combine topic + stance to build sentences.
// ---------------------------------------------------------------------------

const EN_TOPICS = [
  'the authentication system needs to support both OAuth and SAML',
  'the database migration from MySQL to PostgreSQL is underway',
  'the microservices architecture has grown to forty-seven services',
  'the CI pipeline takes twenty minutes for a full build',
  'the frontend uses React with a custom state management layer',
  'the API rate limiting strategy needs a complete overhaul',
  'the logging infrastructure runs on ELK stack with daily rotation',
  'the deployment uses Kubernetes with Helm charts for each service',
  'the test coverage sits at sixty-two percent across the codebase',
  'the caching layer uses Redis with a five minute TTL for hot keys',
  'the message queue handles about fifty thousand events per second',
  'the search feature relies on Elasticsearch with custom analyzers',
  'the monitoring stack includes Prometheus Grafana and AlertManager',
  'the codebase has accumulated three years of technical debt',
  'the team follows a two week sprint cycle with Kanban boards',
  'the security audit found seventeen dependencies with vulnerabilities',
  'the feature flag system supports percentage based rollouts',
  'the GraphQL gateway aggregates data from twelve backend services',
  'the event sourcing pattern is used for the order management domain',
  'the container images are built with multi stage Dockerfiles',
  'the API documentation is generated from OpenAPI specifications',
  'the user session management uses JWT tokens with refresh rotation',
  'the batch processing job runs nightly on a Hadoop cluster',
  'the real-time notifications use WebSocket connections with pub-sub',
  'the data warehouse stores five years of customer transaction history',
  'the mobile app supports offline mode with local SQLite storage',
  'the infrastructure as code uses Terraform for all cloud resources',
  'the secrets management relies on HashiCorp Vault with auto-rotation',
  'the code review process requires two approvals before merge',
  'the incident response runbook defines severity levels from one to four',
  'the feature delivery uses trunk based development with short-lived branches',
  'the observability strategy combines metrics logs and distributed traces',
  'the data pipeline ingests streaming data from IoT sensors',
  'the access control model uses role-based permissions with inheritance',
  'the error handling strategy distinguishes between retryable and fatal errors',
  'the configuration management uses a combination of env vars and config files',
  'the API versioning strategy employs URL based version segments',
  'the load testing framework simulates ten thousand concurrent users',
  'the database connection pool is sized at fifty connections per instance',
  'the webhook delivery system retries failed payloads with exponential backoff',
  'the image processing service handles uploads up to fifty megabytes',
  'the recommendation engine uses collaborative filtering with matrix factorization',
  'the audit log captures every state-changing operation with timestamps',
  'the multi-tenant isolation uses row-level security policies',
  'the background job scheduler supports cron expressions and delayed execution',
  'the API gateway implements request validation and response transformation',
  'the data export feature generates CSV and JSON files on demand',
  'the user onboarding flow includes email verification and profile setup',
  'the changelog is maintained manually in a Markdown file at the repo root',
];

const EN_STANCES = [
  'we should prioritize a phased rollout to minimize disruption',
  'the best approach is to refactor incrementally while maintaining backwards compatibility',
  'I recommend starting with the highest-risk areas and working outward',
  'the team ought to invest in automated testing before adding more features',
  'we need to establish clear ownership boundaries for each service',
  'the right move is to consolidate duplicate logic into a shared library',
  'I suggest adopting a strangler-fig pattern to replace the legacy module gradually',
  'we should document the current architecture before making any changes',
  'the priority should be reducing the blast radius of deployments',
  'I believe we can achieve this by introducing a thin abstraction layer',
  'the most pragmatic path is to wrap the old API behind a new facade',
  'we ought to measure baseline performance before optimizing anything',
  'I think the cleanest solution is to extract the shared logic into a package',
  'the team should define explicit contracts between services before refactoring',
  'we need to introduce circuit breakers to prevent cascading failures',
  'I recommend setting up canary deployments to catch issues early',
  'the correct strategy is to isolate the noisy-neighbor problem at the infrastructure level',
  'we should centralize the error handling into a middleware layer',
  'I propose we tackle the technical debt in the billing module first',
  'the sensible thing is to add integration tests around the critical paths',
  'we ought to migrate the configuration to a centralized store',
  'I suggest we break the monolith along domain boundaries',
  'the team would benefit from adopting a feature-flag-driven release process',
  'we should move the long-running tasks into a dedicated worker pool',
  'I think we need to revisit our data partitioning strategy',
];

const EN_ALT_STANCES = [
  'we should actually hold off and gather more data before committing to a direction',
  'the real issue is that we are solving the wrong problem entirely',
  'I want to reconsider whether this is even the right thing to build right now',
  'the deeper question is whether our current architecture can support this at all',
  'let me step back and question the assumptions that led us here',
  'I realize the approach I just described has a fundamental flaw',
  'on reflection, the simpler solution would be to not change anything yet',
  'the truth is we have been overcomplicating this from the start',
  'I am now wondering if the cost of this migration is actually justified',
  'the key insight I missed is that the bottleneck is elsewhere',
  'we might be better served by addressing the root cause instead of the symptom',
  'I need to walk back my earlier recommendation',
  'the pragmatic answer might be to just increase the timeout and move on',
  'I think I was wrong to prioritize speed over correctness here',
  'the more I think about it, the more I suspect we need a completely different strategy',
  'let us reconsider whether the existing solution can be patched instead of replaced',
  'actually, the team may not have the bandwidth for this right now',
  'I should acknowledge that the risk of this approach is higher than I initially stated',
  'the better move is probably to defer this decision until next quarter',
  'I want to challenge my own assumption that a rewrite is necessary',
  'we might be over-engineering this when a simple fix would suffice',
  'let me reconsider the tradeoffs I outlined a moment ago',
  'I think the right call is to prototype both approaches before deciding',
  'actually, maybe we should just talk to the users first before building anything',
  'I realize I have been focusing on the implementation rather than the problem',
];

// Chinese topic banks
const ZH_TOPICS = [
  '认证系统需要同时支持 OAuth 和 SAML 两种协议',
  '从 MySQL 迁移到 PostgreSQL 的数据库改造正在进行中',
  '微服务架构已经扩展到四十七个服务',
  '持续集成流水线完成一次完整构建需要二十分钟',
  '前端使用 React 配合自定义的状态管理方案',
  '接口限流策略需要彻底重新设计',
  '日志基础设施运行在 ELK 技术栈上并按天轮转',
  '部署使用 Kubernetes 配合每个服务的 Helm 图表',
  '测试覆盖率在整个代码库中停留在百分之六十二',
  '缓存层使用 Redis 对热点数据设置五分钟过期',
  '消息队列每秒处理大约五万条事件',
  '搜索功能依赖 Elasticsearch 并配置了自定义分析器',
  '监控体系包含 Prometheus Grafana 和告警管理器',
  '代码库积累了三年的技术债务',
  '团队采用两周一个迭代的敏捷开发模式',
  '安全审计发现十七个依赖存在已知漏洞',
  '特性开关系统支持按百分比的灰度发布',
  '网关聚合了十二个后端服务的数据',
  '订单管理领域采用了事件溯源模式',
  '容器镜像使用多阶段 Dockerfile 构建',
  '接口文档从 OpenAPI 规范自动生成',
  '用户会话管理使用 JWT 令牌配合刷新轮换',
  '批处理作业每天夜间在 Hadoop 集群上运行',
  '实时通知使用 WebSocket 连接配合发布订阅',
  '数据仓库存储了五年的客户交易历史',
  '移动端应用支持离线模式并使用本地数据库',
  '基础设施即代码使用 Terraform 管理所有云资源',
  '密钥管理依赖 Vault 并支持自动轮换',
  '代码评审流程要求合并前获得两个批准',
  '故障响应手册定义了从一级到四级的严重程度',
  '特性交付采用主干开发配合短生命周期分支',
  '可观测性策略整合了指标日志和分布式追踪',
  '数据管道从物联网传感器接入流式数据',
  '访问控制模型使用基于角色的权限并支持继承',
  '错误处理策略区分了可重试错误和致命错误',
  '配置管理使用环境变量和配置文件的组合',
  '接口版本管理采用基于 URL 的版本号段',
  '压力测试框架模拟一万个并发用户',
  '数据库连接池每个实例配置了五十个连接',
  '网络钩子投递系统对失败的载荷使用指数退避重试',
  '图像处理服务支持最大五十兆字节的上传',
  '推荐引擎使用协同过滤配合矩阵分解',
  '审计日志记录每次状态变更操作并附带时间戳',
  '多租户隔离使用行级安全策略',
  '后台任务调度器支持定时表达式和延迟执行',
  '接口网关实现了请求校验和响应转换',
  '数据导出功能按需生成 CSV 和 JSON 文件',
  '用户引导流程包含邮箱验证和个人资料设置',
  '变更日志手动维护在仓库根目录的 Markdown 文件中',
];

const ZH_STANCES = [
  '我们应该优先采用分阶段上线来减少影响',
  '最好的方式是逐步重构同时保持向后兼容',
  '我建议从风险最高的区域开始逐步向外推进',
  '团队应该在添加更多功能之前投入自动化测试',
  '我们需要为每个服务建立清晰的所有权边界',
  '正确的做法是将重复逻辑整合到一个共享库中',
  '我建议采用绞杀者模式逐步替换遗留模块',
  '我们应该在做任何改动之前先记录当前架构',
  '优先事项应该是缩小部署的影响范围',
  '我相信通过引入一个薄抽象层就能实现这个目标',
  '最务实的路径是把旧接口包装在一个新的门面后面',
  '我们应该在优化之前先测量基线性能',
  '我认为最干净的方案是把共享逻辑抽取成一个包',
  '团队应该在重构之前先定义服务之间的显式契约',
  '我们需要引入熔断器来防止级联故障',
  '我建议设置金丝雀部署来尽早发现问题',
  '正确的策略是在基础设施层面隔离吵闹的邻居问题',
  '我们应该把错误处理集中到中间件层',
  '我提议先处理计费模块的技术债务',
  '合理的做法是在关键路径上增加集成测试',
  '我们应该把配置迁移到集中式存储',
  '我建议按领域边界拆分单体应用',
  '团队会从特性开关驱动的发布流程中受益',
  '我们应该把长时间运行的任务移到专用的工作线程池',
  '我认为我们需要重新审视数据分区策略',
];

const ZH_ALT_STANCES = [
  '不过我们应该先收集更多数据再决定方向',
  '但真正的问题在于我们解决的根本就不是对的问题',
  '等一下我想重新考虑这是否是现在该做的事',
  '话说回来更深层次的问题是当前架构能否支撑这个需求',
  '让我退一步质疑引导我们走到这里的那些假设',
  '不过我刚才描述的方案有一个根本性的缺陷',
  '反过来看更简单的方案是什么都不改',
  '话说回来我们从一开始就把这件事搞复杂了',
  '然而我越来越怀疑这个迁移的成本是否真的值得',
  '但关键是我之前忽略的那个瓶颈其实在别处',
  '不过我们也许应该治本而不是治标',
  '话说回来我需要撤回我之前的建议',
  '然而务实的答案可能只是把超时调大然后继续',
  '但我觉得这里把速度置于正确性之上是错误的',
  '不过越想越觉得我们需要一个完全不同的策略',
  '话说回来也许应该先打补丁而不是替换整个方案',
  '但团队现在可能没有足够的带宽来做这件事',
  '然而我应该承认这个方案的风险比我最初说的要高',
  '不过也许正确的做法是把这个决定推迟到下个季度',
  '话说回来让我质疑一下自己关于必须重写的假设',
  '但也许一个简单的修复就够了我们可能过度设计了',
  '然而让我重新考虑一下刚才列出的那些权衡',
  '不过正确的做法可能是在决定之前先做两个原型',
  '话说回来也许我们应该先跟用户聊聊再动手',
  '但我意识到我一直在关注实现而不是问题本身',
];

// ---------------------------------------------------------------------------
// Turning words (same as production crossroad.ts)
// ---------------------------------------------------------------------------

const EN_TURNS = [
  'However', 'But', 'Wait', 'Actually', 'That said',
  'On the other hand', 'Having said that', 'Nevertheless', 'Then again',
  'On second thought', 'That being said', 'Mind you',
];

const ZH_TURNS = [
  '然而', '不过', '但是', '话说回来', '等一下',
  '不对', '其实', '另一方面', '反过来看', '转念一想',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }
function pickN(arr, n, rng) {
  // Pick n distinct elements
  const idxs = new Set();
  const result = [];
  let guard = 0;
  while (result.length < n && guard < arr.length * 3) {
    guard++;
    const i = Math.floor(rng() * arr.length);
    if (!idxs.has(i)) {
      idxs.add(i);
      result.push(arr[i]);
    }
  }
  // If not enough unique, fill with random (may repeat)
  while (result.length < n) result.push(pick(arr, rng));
  return result;
}

function makeRng(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sentence templates — build natural-looking LLM response sentences
function enSentence(topic, stance, rng) {
  const templates = [
    `Regarding ${topic}, ${stance}.`,
    `For ${topic}, ${stance}.`,
    `Looking at ${topic}, ${stance}.`,
    `When it comes to ${topic}, ${stance}.`,
    `In the context of ${topic}, ${stance}.`,
    `On the matter of ${topic}, ${stance}.`,
    `Considering ${topic}, ${stance}.`,
  ];
  return pick(templates, rng);
}

function enFollowUp(topic, rng) {
  const templates = [
    `This means we can ship the first phase within two weeks.`,
    `The main benefit is reduced coupling between the affected components.`,
    `We should expect some short-term friction during the transition period.`,
    `The tradeoff is a bit more upfront work but lower maintenance cost later.`,
    `This aligns with our goal of improving system reliability.`,
    `The team already has experience with this pattern from previous projects.`,
    `I estimate roughly three sprints to complete the full migration.`,
    `We will need to coordinate closely with the platform team on this.`,
    `The risk is manageable if we keep the rollback path open.`,
    `This should give us a solid foundation for future scaling.`,
    `Let me know if you see any gaps in this reasoning.`,
    `The implementation details can be worked out in the design doc.`,
  ];
  return pick(templates, rng);
}

function zhSentence(topic, stance, rng) {
  const templates = [
    `关于${topic}，${stance}。`,
    `对于${topic}，${stance}。`,
    `就${topic}而言，${stance}。`,
    `考虑到${topic}，${stance}。`,
    `在${topic}这个问题上，${stance}。`,
    `从${topic}的角度来看，${stance}。`,
  ];
  return pick(templates, rng);
}

function zhFollowUp(topic, rng) {
  const templates = [
    `这意味着我们可以在两周内交付第一阶段。`,
    `主要好处是降低了受影响组件之间的耦合。`,
    `过渡期间会有一些短期的摩擦。`,
    `代价是前期工作多一些但后期维护成本更低。`,
    `这与我们提升系统可靠性的目标一致。`,
    `团队在之前的项目中已经有过类似经验。`,
    `我估计大概三个迭代可以完成全部迁移。`,
    `我们需要和平台团队密切协调这件事。`,
    `只要保持回滚路径可用风险就是可控的。`,
    `这应该能为未来的扩展打下坚实的基础。`,
    `如果你觉得这个思路有遗漏请告诉我。`,
    `具体的实现细节可以在设计文档中再细化。`,
  ];
  return pick(templates, rng);
}

// ---------------------------------------------------------------------------
// Build a POSITIVE case: commit → pivot
//   1-2 sentences committing to direction A (topic + stance A)
//   turning word at sentence boundary
//   1-2 sentences pivoting to direction B (alt-stance)
// ---------------------------------------------------------------------------

function buildPositive(lang, targetLen, rng) {
  const isEn = lang === 'en';
  const topics = isEn ? EN_TOPICS : ZH_TOPICS;
  const stances = isEn ? EN_STANCES : ZH_STANCES;
  const altStances = isEn ? EN_ALT_STANCES : ZH_ALT_STANCES;
  const turns = isEn ? EN_TURNS : ZH_TURNS;
  const sep = isEn ? ' ' : '';

  const topic = pick(topics, rng);
  const stanceA = pick(stances, rng);
  const stanceB = pick(altStances, rng);
  const turn = pick(turns, rng);

  // Build commit (direction A) and pivot (direction B) as sentence arrays
  // so we can scale the number of sentences to the target length.
  // For EN: lowercase first letter of stanceB unless it's "I" (pronoun).
  let stanceBLower;
  if (isEn) {
    if (stanceB.startsWith('I ')) {
      stanceBLower = stanceB; // keep "I" capital — it's a pronoun
    } else {
      stanceBLower = stanceB.charAt(0).toLowerCase() + stanceB.slice(1);
    }
  } else {
    stanceBLower = stanceB;
  }
  // Avoid double turn-word: if stanceB already starts with a turn-like word,
  // capitalize it and use directly (no prepended turn word).
  const turnLikeStart = /^(but|however|wait|actually|though|yet|still|nevertheless)\b/i;
  let pivot1;
  if (isEn && turnLikeStart.test(stanceBLower.trim())) {
    pivot1 = `${stanceBLower.charAt(0).toUpperCase() + stanceBLower.slice(1)}.`;
  } else {
    pivot1 = isEn ? `${turn}, ${stanceBLower}.` : `${turn}，${stanceB}。`;
  }

  // Start with minimal: 1 commit + 1 pivot
  const commit1 = isEn ? enSentence(topic, stanceA, rng) : zhSentence(topic, stanceA, rng);
  const commitSentences = [commit1];
  const pivotSentences = [pivot1];

  // Add follow-ups to approach target length
  // Alternate adding to commit (before turn) and pivot (after turn)
  let guard = 0;
  let text = buildText(commitSentences, pivotSentences, turn, sep, isEn);
  while (text.length < targetLen - 30 && guard < 10) {
    guard++;
    const extra = isEn ? enFollowUp(topic, rng) : zhFollowUp(topic, rng);
    // Add to whichever side is shorter, or alternate
    if (commitSentences.length <= pivotSentences.length) {
      commitSentences.push(extra);
    } else {
      pivotSentences.push(isEn ? enFollowUp(topic, rng) : zhFollowUp(topic, rng));
    }
    text = buildText(commitSentences, pivotSentences, turn, sep, isEn);
  }

  // Trim if too long — remove trailing pivot sentences (never cut the turn word)
  while (text.length > targetLen + 40 && pivotSentences.length > 1) {
    pivotSentences.pop();
    text = buildText(commitSentences, pivotSentences, turn, sep, isEn);
  }
  // If still too long, remove trailing commit sentences
  while (text.length > targetLen + 40 && commitSentences.length > 1) {
    commitSentences.pop();
    text = buildText(commitSentences, pivotSentences, turn, sep, isEn);
  }

  const turnIndex = text.indexOf(turn);
  return { text, turnIndex };
}

/** Assemble commit sentences + turn + pivot sentences into full text. */
function buildText(commitSents, pivotSents, turn, sep, isEn) {
  const commit = commitSents.join(sep);
  const pivot = pivotSents.join(sep);
  return `${commit}${sep}${pivot}`;
}

// ---------------------------------------------------------------------------
// Build a NEGATIVE case: straightforward multi-sentence response, NO pivot
//   2-4 sentences all developing ONE direction (topic + stance + follow-ups)
//   No turning words. Same length distribution as positives.
// ---------------------------------------------------------------------------

function buildNegative(lang, targetLen, rng) {
  const isEn = lang === 'en';
  const topics = isEn ? EN_TOPICS : ZH_TOPICS;
  const stances = isEn ? EN_STANCES : ZH_STANCES;
  const sep = isEn ? ' ' : '';

  const topic = pick(topics, rng);
  const stance = pick(stances, rng);

  const s1 = isEn ? enSentence(topic, stance, rng) : zhSentence(topic, stance, rng);
  const sentences = [s1];

  // Pad with follow-ups to reach target length (all same direction, no turn)
  let guard = 0;
  let text = sentences.join(sep);
  while (text.length < targetLen - 30 && guard < 10) {
    guard++;
    const extra = isEn ? enFollowUp(topic, rng) : zhFollowUp(topic, rng);
    sentences.push(extra);
    text = sentences.join(sep);
  }
  // Trim by removing trailing sentences (never cut mid-sentence)
  while (text.length > targetLen + 40 && sentences.length > 1) {
    sentences.pop();
    text = sentences.join(sep);
  }

  return { text, turnIndex: -1 };
}

// ---------------------------------------------------------------------------
// Length distribution — SAME for both positive and negative (deconfounding)
// ---------------------------------------------------------------------------

const BUCKETS = [
  [50, 99, 0.15],
  [100, 199, 0.30],
  [200, 299, 0.30],
  [300, 399, 0.15],
  [400, 500, 0.10],
];

function genTargetLengths(n, rng) {
  const counts = BUCKETS.map(b => Math.round(n * b[2]));
  const drift = n - counts.reduce((a, b) => a + b, 0);
  counts[counts.length - 1] += drift;
  const targets = [];
  for (let i = 0; i < BUCKETS.length; i++) {
    const [lo, hi] = BUCKETS[i];
    for (let j = 0; j < counts[i]; j++) {
      targets.push(Math.floor(lo + rng() * (hi - lo + 1)));
    }
  }
  return targets;
}

function writeJsonlNoBom(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n') + '\n', { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// Main — generate 250 EN + 250 ZH per class = 500 pos + 500 neg = 1000 total
// ---------------------------------------------------------------------------

function main() {
  const PER_LANG = 250;
  const posLines = [];
  const negLines = [];
  const seenTexts = new Set();

  for (const [lang, seed] of [['en', 20260701], ['zh', 20260702]]) {
    const rng = makeRng(seed);
    const targets = genTargetLengths(PER_LANG, rng);
    for (let i = 0; i < PER_LANG; i++) {
      // Positive
      let pos = buildPositive(lang, targets[i], rng);
      let guard = 0;
      while (seenTexts.has(pos.text) && guard < 10) {
        pos = buildPositive(lang, targets[i], rng);
        guard++;
      }
      seenTexts.add(pos.text);
      posLines.push(JSON.stringify({ text: pos.text, label: 1, turnIndex: pos.turnIndex }));

      // Negative
      let neg = buildNegative(lang, targets[i], rng);
      guard = 0;
      while (seenTexts.has(neg.text) && guard < 10) {
        neg = buildNegative(lang, targets[i], rng);
        guard++;
      }
      seenTexts.add(neg.text);
      negLines.push(JSON.stringify({ text: neg.text, label: 0 }));
    }
  }

  writeJsonlNoBom(path.join(DATA_DIR, 'seed-positive.jsonl'), posLines);
  writeJsonlNoBom(path.join(DATA_DIR, 'seed-negative.jsonl'), negLines);

  // Remove old files
  for (const f of ['positive.jsonl', 'negative.jsonl']) {
    const p = path.join(DATA_DIR, f);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`Removed old file: ${f}`);
    }
  }

  // Summary
  const sumLines = (lines, name) => {
    let lo = Infinity, hi = 0, sum = 0;
    for (const l of lines) {
      const o = JSON.parse(l);
      lo = Math.min(lo, o.text.length);
      hi = Math.max(hi, o.text.length);
      sum += o.text.length;
    }
    console.log(`${name}: ${lines.length} samples | len min=${lo} max=${hi} avg=${(sum/lines.length).toFixed(0)}`);
  };
  sumLines(posLines, 'Positives');
  sumLines(negLines, 'Negatives');

  const posAvg = posLines.reduce((a, l) => a + JSON.parse(l).text.length, 0) / posLines.length;
  const negAvg = negLines.reduce((a, l) => a + JSON.parse(l).text.length, 0) / negLines.length;
  console.log(`\nLength deconfounding: posAvg=${posAvg.toFixed(1)} negAvg=${negAvg.toFixed(1)}`);

  // Verify no duplicate texts across classes
  const posTexts = new Set(posLines.map(l => JSON.parse(l).text));
  const negTexts = new Set(negLines.map(l => JSON.parse(l).text));
  let overlap = 0;
  for (const t of posTexts) if (negTexts.has(t)) overlap++;
  console.log(`Cross-class duplicate texts: ${overlap} (must be 0)`);

  // Verify all positives have a valid turnIndex
  let badTurn = 0;
  for (const l of posLines) {
    const o = JSON.parse(l);
    if (o.turnIndex < 0 || o.turnIndex >= o.text.length) badTurn++;
  }
  console.log(`Positives with invalid turnIndex: ${badTurn} (must be 0)`);

  // Sample preview
  console.log(`\n=== Sample POSITIVE (EN) ===`);
  const samplePos = JSON.parse(posLines[0]);
  console.log(`text: ${samplePos.text}`);
  console.log(`turnIndex: ${samplePos.turnIndex}`);
  console.log(`turn word context: ...${samplePos.text.substring(Math.max(0, samplePos.turnIndex - 20), samplePos.turnIndex + 40)}...`);
  console.log(`\n=== Sample NEGATIVE (EN) ===`);
  console.log(`text: ${JSON.parse(negLines[0]).text}`);

  // BOM check
  const checkBom = (f) => {
    const b = fs.readFileSync(f);
    const hasBom = b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF;
    console.log(`BOM check ${path.basename(f)}: ${hasBom ? 'HAS BOM (BAD)' : 'no BOM (OK)'}`);
  };
  checkBom(path.join(DATA_DIR, 'seed-positive.jsonl'));
  checkBom(path.join(DATA_DIR, 'seed-negative.jsonl'));

  console.log(`\nDone. ${posLines.length + negLines.length} total training samples written to ${DATA_DIR}`);
}

main();