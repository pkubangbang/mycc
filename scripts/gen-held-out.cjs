#!/usr/bin/env node
/**
 * gen-held-out.cjs — Generate 500 held-out test cases for crossroad model eval.
 *
 * KEY DESIGN PRINCIPLE (v3): The held-out data uses INDEPENDENT topic/stance
 * banks that do NOT overlap with the training data generator. This ensures a
 * genuine generalization test — the model must detect the pivot pattern in
 * unseen vocabulary and sentence structures, not memorize training templates.
 *
 * Structure matches training data:
 *   - POSITIVE (label=1): commit to direction A (1-2 sentences) → turning word
 *     → pivot to direction B (1-2 sentences). turnIndex = position of turn word.
 *   - NEGATIVE (label=0): straightforward multi-sentence response, no pivot.
 *   - Same length distribution as training (deconfounded).
 *
 * Output: ~/.mycc-store/crossroad-trainer/tests/held_out/{en,zh}/held_out_{en,zh}.jsonl
 * Each line: {"text": "...", "label": 0|1, "turnIndex": <int>}
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const OUT_BASE = path.join(os.homedir(), '.mycc-store', 'crossroad-trainer', 'tests', 'held_out');

// ---------------------------------------------------------------------------
// INDEPENDENT topic banks — different from training data generator.
// Covers different domains: DevOps, data science, security, product, infra.
// ---------------------------------------------------------------------------

const EN_TOPICS = [
  'the release process uses blue-green deployments with traffic shifting',
  'the data science team relies on Jupyter notebooks for exploratory analysis',
  'the zero-trust security model requires mTLS between all internal services',
  'the product roadmap includes a major redesign of the user dashboard',
  'the infrastructure provisioning takes about fifteen minutes per environment',
  'the anomaly detection pipeline processes streaming metrics in real time',
  'the content moderation system combines automated filters with human review',
  'the payment reconciliation job runs every hour and handles three currencies',
  'the geographic distribution of users spans twelve regions across five continents',
  'the A/B testing framework supports multivariate experiments with Bayesian analysis',
  'the data retention policy mandates seven years of audit trail storage',
  'the incident postmortem process follows a blameless retrospective format',
  'the service mesh provides traffic management and observability without code changes',
  'the feature rollout uses progressive delivery with automatic rollback on error spikes',
  'the knowledge base contains three thousand articles with varying quality levels',
  'the compliance framework requires SOC2 and ISO27001 certifications',
  'the customer feedback loop integrates survey data with product analytics',
  'the disaster recovery plan targets a four-hour RTO and fifteen-minute RPO',
  'the API contract testing validates schema compatibility across versions',
  'the team uses trunk-based development with feature flags for all new work',
  'the data catalog auto-discovers schemas from the lake and warehouse',
  'the access reviews run quarterly and cover both human and service accounts',
  'the latency budget allocates two hundred milliseconds for the critical path',
  'the codeowners file maps every directory to at least two responsible engineers',
  'the on-call rotation includes a primary and secondary with twelve-hour shifts',
  'the technical writing team maintains API docs and architecture decision records',
  'the platform engineering team provides golden paths for common service patterns',
  'the data governance council oversees classification and access policies',
  'the release notes are auto-generated from conventional commit messages',
  'the error budget policy halts feature deployments when SLO breaches accumulate',
  'the migration to event-driven architecture started with the notification service',
  'the observability dashboards are defined as code and version-controlled',
  'the capacity planning model forecasts resource needs based on growth trends',
  'the security scanning runs on every commit and blocks merges on critical findings',
  'the user research team conducts weekly interviews with five to ten participants',
  'the infrastructure cost optimization identified thirty percent waste in idle resources',
  'the API deprecation policy provides six months notice with migration guides',
  'the team adopted pair programming for all changes to the payment processing module',
  'the data quality checks run as a prerequisite before any pipeline promotion',
  'the chaos engineering exercises are scheduled monthly during business hours',
  'the mobile release train deploys to production every two weeks via the app stores',
  'the internal tooling portal aggregates links to all team-specific dashboards',
  'the accessibility audit identified forty-seven WCAG compliance issues',
  'the documentation site rebuilds automatically on every merge to main',
  'the telemetry sampling rate was reduced to manage storage costs',
  'the multi-region deployment uses active-active with conflict-free replicated data types',
  'the engineering ladder defines five levels with clear competency expectations',
  'the retrospective action items are tracked in a shared board with owners and due dates',
  'the data lineage graph maps dependencies across four hundred downstream consumers',
];

const EN_STANCES = [
  'we should standardize the tooling to reduce cognitive load on developers',
  'the right approach is to automate the repetitive parts and focus on edge cases',
  'I recommend establishing a baseline before introducing any new tooling',
  'the team needs to invest in documentation to make the system maintainable',
  'we should align the release cadence with the product planning cycle',
  'the best path forward is to simplify the architecture before scaling further',
  'I think we should treat this as a learning opportunity rather than a failure',
  'we need to define clear success criteria before starting the migration',
  'the priority should be improving developer experience and reducing friction',
  'I suggest we create a working group to evaluate the tradeoffs systematically',
  'we ought to revisit our decision-making process for technical investments',
  'the practical move is to start with a pilot before rolling out broadly',
  'I believe the key is to balance speed of delivery with long-term sustainability',
  'we should encode our best practices into reusable templates and libraries',
  'the team would benefit from clearer ownership of shared infrastructure',
  'I recommend setting up cross-functional reviews to catch blind spots early',
  'we need to make the feedback loops shorter to detect issues sooner',
  'the sensible approach is to delegate decision-making to the teams closest to the work',
  'I think we should measure the impact before committing to a permanent change',
  'we should treat reliability as a feature and budget for it explicitly',
  'the correct strategy is to reduce the surface area of the critical path',
  'I propose we run a time-boxed experiment to validate the hypothesis',
  'we ought to invest in training to upskill the team on the new stack',
  'the team should establish guardrails rather than gates for deployment',
  'I believe we need to shift quality verification to the earliest possible stage',
];

const EN_ALT_STANCES = [
  'we should actually pause and make sure we are solving the right problem',
  'but the real constraint here is not technical, it is organizational',
  'I want to reconsider whether the current approach is sustainable long-term',
  'the deeper issue is that we have not aligned on what success looks like',
  'let me step back and question whether we even need to change anything right now',
  'I realize I may be underestimating the complexity of this migration',
  'on reflection, the simplest solution might be the best one for now',
  'the truth is we might be optimizing for the wrong metric',
  'I am now wondering if we should defer this until we have more capacity',
  'the key thing I overlooked is that the team morale matters as much as the output',
  'we might be better off fixing the process before fixing the technology',
  'I need to walk back my enthusiasm and acknowledge the real risks involved',
  'the pragmatic answer is probably to do less but do it more reliably',
  'I think I was too quick to jump to a solution without understanding the root cause',
  'actually, maybe the existing system is good enough if we just maintain it properly',
  'let us reconsider whether the effort is proportional to the expected benefit',
  'I should be honest that the timeline I proposed is probably unrealistic',
  'the more I think about it, the more I believe we need input from other teams first',
  'perhaps the right move is to document what we have before changing it',
  'I want to challenge the assumption that a new tool will solve our problems',
];

// Chinese topic banks (independent from training)
const ZH_TOPICS = [
  '发布流程采用蓝绿部署配合流量切换',
  '数据科学团队依赖 Jupyter 笔记本进行探索性分析',
  '零信任安全模型要求所有内部服务之间使用双向认证',
  '产品路线图包含用户仪表板的重大重新设计',
  '基础设施开通每个环境大约需要十五分钟',
  '异常检测管道实时处理流式指标',
  '内容审核系统结合自动过滤和人工复核',
  '支付对账作业每小时运行并处理三种货币',
  '用户的地理分布横跨五大洲十二个区域',
  'A/B 测试框架支持贝叶斯分析的多变量实验',
  '数据留存政策要求审计日志保存七年',
  '故障复盘流程遵循无指责回顾的格式',
  '服务网格提供流量管理和可观测性而无需修改代码',
  '特性发布采用渐进式交付并在错误激增时自动回滚',
  '知识库包含三千篇质量参差不齐的文章',
  '合规框架要求通过 SOC2 和 ISO27001 认证',
  '客户反馈闭环将调研数据与产品分析整合',
  '灾难恢复计划的目标是四小时恢复和十五分钟数据丢失',
  '接口契约测试验证跨版本的模式兼容性',
  '团队采用主干开发配合特性开关管理所有新工作',
  '数据目录自动发现数据湖和数据仓库中的模式',
  '权限审查每季度运行覆盖人工账户和服务账户',
  '延迟预算为关键路径分配了两百毫秒',
  '代码归属文件将每个目录映射到至少两名负责工程师',
  '值班轮换包含主备两个角色每个班次十二小时',
  '技术写作团队维护接口文档和架构决策记录',
  '平台工程团队为常见服务模式提供标准化路径',
  '数据治理委员会负责分类和访问策略',
  '发布说明从约定式提交信息自动生成',
  '错误预算策略在服务水平目标违规累积时暂停部署',
  '向事件驱动架构的迁移从通知服务开始',
  '可观测性仪表板以代码形式定义并纳入版本控制',
  '容量规划模型根据增长趋势预测资源需求',
  '安全扫描在每次提交时运行并在发现严重问题时阻止合并',
  '用户研究团队每周访谈五到十名参与者',
  '基础设施成本优化发现了百分之三十的闲置资源浪费',
  '接口废弃政策提供六个月通知和迁移指南',
  '团队对支付处理模块的所有改动采用结对编程',
  '数据质量检查作为管道晋升的前置条件运行',
  '混沌工程演练每月在工作时间进行',
  '移动端发布列车每两周通过应用商店部署到生产环境',
  '内部工具门户聚合了所有团队专用仪表板的链接',
  '无障碍审计发现了四十七个 WCAG 合规问题',
  '文档站点在每次合并到主干时自动重新构建',
  '遥测采样率被调低以控制存储成本',
  '多区域部署采用双活模式和无冲突复制数据类型',
  '工程职级体系定义了五个层级和明确的能力要求',
  '回顾行动项在共享看板中跟踪并指定负责人和截止日期',
  '数据血缘图映射了四百个下游消费者的依赖关系',
];

const ZH_STANCES = [
  '我们应该标准化工具链来减轻开发者的认知负担',
  '正确的方式是自动化重复部分然后专注于边界情况',
  '我建议在引入任何新工具之前先建立基线',
  '团队需要投入文档建设来保证系统的可维护性',
  '我们应该让发布节奏与产品规划周期对齐',
  '最好的前进方向是在进一步扩展之前先简化架构',
  '我认为我们应该把这当作学习机会而不是失败',
  '我们需要在开始迁移之前定义清晰的成功标准',
  '优先事项应该是改善开发者体验并减少摩擦',
  '我建议成立一个工作组来系统地评估权衡',
  '我们应该重新审视技术投资的决策流程',
  '务实的做法是先做试点再大规模推广',
  '我相信关键在于平衡交付速度和长期可持续性',
  '我们应该把最佳实践编码为可复用的模板和库',
  '团队会从更清晰的共享基础设施所有权中受益',
  '我建议建立跨职能评审来尽早发现盲点',
  '我们需要缩短反馈回路以便更快发现问题',
  '合理的做法是将决策权下放给最接近工作的团队',
  '我认为我们应该在永久采用之前先衡量影响',
  '我们应该把可靠性当作特性来对待并明确为其分配预算',
  '正确的策略是缩小关键路径的影响范围',
  '我提议运行一个限时实验来验证假设',
  '我们应该投入培训来提升团队对新技术栈的能力',
  '团队应该为部署建立护栏而不是关卡',
  '我相信我们需要把质量验证尽可能提前',
];

const ZH_ALT_STANCES = [
  '不过我们应该先停下来确认我们解决的是正确的问题',
  '但真正的约束不是技术层面而是组织层面的',
  '我想重新考虑当前的方式是否长期可持续',
  '更深层次的问题是我们还没有对成功的定义达成一致',
  '让我退一步质疑我们现在是否真的需要改变',
  '我意识到我可能低估了这次迁移的复杂度',
  '反过来看最简单的方案可能现在就是最好的',
  '话说回来我们可能一直在优化错误的指标',
  '但我在想我们是否应该等到有更多资源时再做',
  '我忽略的关键是团队士气和产出同样重要',
  '不过也许我们应该先修流程再修技术',
  '我需要收回我的热情并承认其中真正的风险',
  '务实的答案可能是做少一点但做得更可靠',
  '我觉得我太快跳到方案而没有理解根本原因',
  '其实也许现有系统只要维护得当就够用了',
  '让我们重新考虑投入是否与预期收益相称',
  '我应该坦诚地承认我提的时间线可能不现实',
  '越想越觉得我们需要先听听其他团队的意见',
  '也许正确的做法是在改变之前先把现状记录下来',
  '我想质疑新工具能解决我们问题这个假设',
];

// ---------------------------------------------------------------------------
// Turning words (same as production + training)
// ---------------------------------------------------------------------------

const EN_TURNS = [
  'However', 'But', 'Wait', 'Actually', 'That said',
  'On the other hand', 'Having said that', 'Nevertheless', 'Then again',
  'On second thought', 'That being said', 'Mind you', 'Still', 'Yet',
];

const ZH_TURNS = [
  '然而', '不过', '但是', '话说回来', '等一下',
  '不对', '其实', '另一方面', '反过来看', '转念一想', '话虽如此', '尽管如此',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }

function makeRng(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sentence builders (independent phrasings from training)
function enSentence(topic, stance, rng) {
  const templates = [
    `Looking at ${topic}, ${stance}.`,
    `With ${topic}, ${stance}.`,
    `Given that ${topic}, ${stance}.`,
    `In the case of ${topic}, ${stance}.`,
    `For ${topic}, ${stance}.`,
    `Because ${topic}, ${stance}.`,
    `Since ${topic}, ${stance}.`,
  ];
  return pick(templates, rng);
}

function enFollowUp(rng) {
  const templates = [
    `This should translate to measurable improvements within a quarter.`,
    `The team can start with a small scope and expand from there.`,
    `We will need to align with stakeholders on the expected outcomes.`,
    `The implementation can be broken into independent work streams.`,
    `This approach has worked well for similar initiatives in the past.`,
    `Let us draft a one-pager to socialize the idea before committing.`,
    `The key is to keep the feedback loop tight during execution.`,
    `We should expect some resistance to change and plan for it.`,
    `I am confident this will reduce the operational burden over time.`,
    `The next step would be to estimate the effort and identify dependencies.`,
    `We can validate the approach with a quick spike before full commitment.`,
    `This gives us flexibility to course-correct if assumptions prove wrong.`,
  ];
  return pick(templates, rng);
}

function zhSentence(topic, stance, rng) {
  const templates = [
    `就${topic}而言，${stance}。`,
    `针对${topic}，${stance}。`,
    `鉴于${topic}，${stance}。`,
    `从${topic}来看，${stance}。`,
    `因为${topic}，${stance}。`,
  ];
  return pick(templates, rng);
}

function zhFollowUp(rng) {
  const templates = [
    `这应该在一个季度内转化为可衡量的改进。`,
    `团队可以从小范围开始然后逐步扩大。`,
    `我们需要与利益相关方对齐预期结果。`,
    `实现可以拆分为独立的工作流。`,
    `这种方法在过去的类似项目中效果不错。`,
    `让我们先起草一份简报来沟通想法。`,
    `关键是在执行过程中保持紧凑的反馈回路。`,
    `我们应该预期到一些变革阻力并提前规划。`,
    `我有信心这会随着时间减轻运维负担。`,
    `下一步是估算工作量并识别依赖关系。`,
    `我们可以在全面投入前用快速验证来确认方向。`,
    `这让我们在假设被证伪时有机会调整路线。`,
  ];
  return pick(templates, rng);
}

// ---------------------------------------------------------------------------
// Build POSITIVE: commit → pivot
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

  let stanceBLower;
  if (isEn) {
    if (stanceB.startsWith('I ')) stanceBLower = stanceB;
    else stanceBLower = stanceB.charAt(0).toLowerCase() + stanceB.slice(1);
  } else {
    stanceBLower = stanceB;
  }
  // Avoid double turn-word: if stanceB already starts with a turn-like word,
  // don't prepend another (e.g. "But, but the real constraint..." is bad).
  const turnLikeStart = /^(but|however|wait|actually|though|yet|still|nevertheless)\b/i;
  let pivot1;
  if (isEn && turnLikeStart.test(stanceBLower.trim())) {
    // Capitalize the existing word and use it directly (drop the prepended turn)
    pivot1 = `${stanceBLower.charAt(0).toUpperCase() + stanceBLower.slice(1)}.`;
  } else {
    pivot1 = isEn ? `${turn}, ${stanceBLower}.` : `${turn}，${stanceB}。`;
  }

  const commit1 = isEn ? enSentence(topic, stanceA, rng) : zhSentence(topic, stanceA, rng);
  const commitSentences = [commit1];
  const pivotSentences = [pivot1];

  let guard = 0;
  let text = `${commitSentences.join(sep)}${sep}${pivotSentences.join(sep)}`;
  while (text.length < targetLen - 30 && guard < 10) {
    guard++;
    const extra = isEn ? enFollowUp(rng) : zhFollowUp(rng);
    if (commitSentences.length <= pivotSentences.length) {
      commitSentences.push(extra);
    } else {
      pivotSentences.push(isEn ? enFollowUp(rng) : zhFollowUp(rng));
    }
    text = `${commitSentences.join(sep)}${sep}${pivotSentences.join(sep)}`;
  }
  while (text.length > targetLen + 40 && pivotSentences.length > 1) {
    pivotSentences.pop();
    text = `${commitSentences.join(sep)}${sep}${pivotSentences.join(sep)}`;
  }
  while (text.length > targetLen + 40 && commitSentences.length > 1) {
    commitSentences.pop();
    text = `${commitSentences.join(sep)}${sep}${pivotSentences.join(sep)}`;
  }

  const turnIndex = text.indexOf(turn);
  return { text, turnIndex };
}

// ---------------------------------------------------------------------------
// Build NEGATIVE: straightforward, no pivot
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

  let guard = 0;
  let text = sentences.join(sep);
  while (text.length < targetLen - 30 && guard < 10) {
    guard++;
    sentences.push(isEn ? enFollowUp(rng) : zhFollowUp(rng));
    text = sentences.join(sep);
  }
  while (text.length > targetLen + 40 && sentences.length > 1) {
    sentences.pop();
    text = sentences.join(sep);
  }

  return { text, turnIndex: -1 };
}

// ---------------------------------------------------------------------------
// Length distribution (same as training)
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
  // shuffle
  for (let i = targets.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [targets[i], targets[j]] = [targets[j], targets[i]];
  }
  return targets;
}

function writeJsonlNoBom(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n') + '\n', { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function generateLang(lang, n, seed) {
  const rng = makeRng(seed);
  const targets = genTargetLengths(n, rng);
  const out = [];
  const seenTexts = new Set();

  for (let i = 0; i < n; i++) {
    const label = i % 2 === 0 ? 1 : 0;
    let sample;
    let guard = 0;
    do {
      sample = label === 1
        ? buildPositive(lang, targets[i], rng)
        : buildNegative(lang, targets[i], rng);
      guard++;
    } while (seenTexts.has(sample.text) && guard < 10);
    seenTexts.add(sample.text);

    const obj = { text: sample.text, label };
    if (label === 1) obj.turnIndex = sample.turnIndex;
    out.push(JSON.stringify(obj));
  }

  // shuffle
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function main() {
  const enLines = generateLang('en', 250, 20260714);
  const zhLines = generateLang('zh', 250, 20260715);

  writeJsonlNoBom(path.join(OUT_BASE, 'en', 'held_out_en.jsonl'), enLines);
  writeJsonlNoBom(path.join(OUT_BASE, 'zh', 'held_out_zh.jsonl'), zhLines);

  for (const [name, lines] of [['EN', enLines], ['ZH', zhLines]]) {
    let pos = 0, neg = 0, badTurn = 0;
    const lens = [];
    for (const l of lines) {
      const o = JSON.parse(l);
      if (o.label === 1) { pos++; if (o.turnIndex < 0 || o.turnIndex >= o.text.length) badTurn++; }
      else neg++;
      lens.push(o.text.length);
    }
    const min = Math.min(...lens), max = Math.max(...lens);
    const avg = (lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(0);
    console.log(`${name}: ${lines.length} lines | label1=${pos} label0=${neg} | len min=${min} max=${max} avg=${avg} | badTurn=${badTurn}`);
  }

  // Sample preview
  const samplePos = JSON.parse(enLines.find(l => JSON.parse(l).label === 1));
  const sampleNeg = JSON.parse(enLines.find(l => JSON.parse(l).label === 0));
  console.log(`\n=== Sample POSITIVE (EN) ===`);
  console.log(`text: ${samplePos.text}`);
  console.log(`turnIndex: ${samplePos.turnIndex}`);
  console.log(`\n=== Sample NEGATIVE (EN) ===`);
  console.log(`text: ${sampleNeg.text}`);

  // BOM check
  for (const f of ['en/held_out_en.jsonl', 'zh/held_out_zh.jsonl']) {
    const b = fs.readFileSync(path.join(OUT_BASE, f));
    const hasBom = b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF;
    console.log(`BOM check ${f}: ${hasBom ? 'HAS BOM (BAD)' : 'no BOM (OK)'}`);
  }

  console.log(`\nDone. Files written to ${OUT_BASE}`);
}

main();