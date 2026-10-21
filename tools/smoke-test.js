#!/usr/bin/env node
/* ===========================================================
   smoke-test.js — 无浏览器冒烟测试（零依赖，Node 18+）
   把浏览器端脚本加载到 vm 沙箱里，验证：
     1) 脱敏规则
     2) JEV 官方协议层（问题编译 / 答案归一 / 置信度校准）
     3) 三条判定后端：本地启发式 / ONNX（注入 stub 分类器）/ 远程（不可用回落）
     4) 完整流水线（演示模式）能跑完且排序正确
     5) 需求追问判定
     6) 知识库增删查
     7) 提示词库完整性
   用法： node tools/smoke-test.js
   =========================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* ---------------- 沙箱 ---------------- */
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Promise,
  AbortController,
  Date,
  Math,
  JSON,
  Number,
  String,
  Array,
  Object,
  RegExp,
  Error,
  isFinite,
  URL,
  URLSearchParams,
  CustomEvent: class CustomEvent {
    constructor(type, opts) { this.type = type; this.detail = (opts || {}).detail; }
  },
  dispatchEvent: function () { return true; },
  fetch: function () { return Promise.reject(new Error('冒烟测试不联网')); }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.location = { search: '' };

const context = vm.createContext(sandbox);

['core.js', 'data.js', 'kb.js', 'jev-protocol.js', 'jev-onnx.js', 'jev.js', 'sources.js', 'pipeline.js', 'promptlib.js'].forEach((file) => {
  const code = fs.readFileSync(path.join(ROOT, 'js', file), 'utf8');
  vm.runInContext(code, context, { filename: file });
});

const { Core, DATA, KB, JEVProtocol, JevOnnx, JEV, Sources, Pipeline, PromptLib } = sandbox;

/* ---------------- 1. 脱敏 ---------------- */
console.log('\n[1] 脱敏规则');
const masked = Core.mask.text('联系人 13800138000，身份证 110101199001011234，邮箱 a.b@example.com，微信 wx_abc123456');
check('手机号被屏蔽', masked.text.indexOf('13800138000') === -1);
check('身份证被屏蔽', masked.text.indexOf('110101199001011234') === -1);
check('邮箱被屏蔽', masked.text.indexOf('a.b@example.com') === -1);
check('总计命中 4 类', masked.total >= 4, '实际 ' + masked.total);
check('脱敏后仍保留可读文本', /联系人/.test(masked.text));
check('正常数字不被误伤', Core.mask.text('共 18 条候选，2026 年 9 月').total === 0);

/* ---------------- 2. JEV 协议层 ---------------- */
console.log('\n[2] JEV 官方协议层');
const sample = Sources.toItem({
  t: 'langgenius/dify', u: 'https://github.com/langgenius/dify', s: 'github',
  d: '生产级 LLM 应用开发平台，可视化工作流编排，中文文档完整，适合新手。',
  m: { stars: 68000, lang: 'TypeScript', updated: '2026-09-27' }
});

const questions = JEVProtocol.buildQuestions();
check('默认问题集含 3 个问题', Object.keys(questions).length === 3);
check('veracity 是 noul', questions.veracity.type === 'noul');
check('relevance 是 score 且 5 档', questions.relevance.type === 'score' && questions.relevance.levels.length === 5);
check('category 是 choice 且 5 分类', questions.category.type === 'choice' && Object.keys(questions.category.criteria).length === 5);

const stateText = JEVProtocol.stateFromItem(sample, '找新手友好的工作流框架');
check('state 含需求与标题', stateText.indexOf('需求') > -1 && stateText.indexOf('dify') > -1);
check('state 含元数据', stateText.indexOf('star') > -1);

const officialStyle = {
  veracity: { noul: 0.86 },
  relevance: {
    score: 3.2,
    probabilities: {
      '2 分：完全不相关，只是字面重合': 0.02,
      '4 分：弱相关，主题沾边但解决不了需求': 0.08,
      '6 分：基本相关，能部分回答需求': 0.2,
      '8 分：高度相关，直接覆盖需求要点': 0.5,
      '10 分：完全匹配，可作为首选': 0.2
    }
  },
  category: { choice: '代码库', probabilities: { 教程: 0.08, 代码库: 0.74, 百科词条: 0.08, 资源合集: 0.05, 商业产品: 0.05 } }
};
const norm = JEVProtocol.normalize(officialStyle);
check('官方形状答案归一出 p', Math.abs(norm.p - 0.86) < 1e-6);
check('score 由档位分布反算（≈7.5）', Math.abs(norm.score - 7.52) < 0.6, 'score=' + norm.score);
check('choice 归一', norm.choice === '代码库');
check('置信度取 max(probabilities) 而非官方 confidence', Math.abs(norm.confidence - 0.74) < 1e-6, 'conf=' + norm.confidence);
check('分布足够集中时不算低置信', norm.lowConfidence === false);

const flat = JEVProtocol.normalize({
  veracity: { noul: 0.5 },
  relevance: { probabilities: { l2: 0.2, l4: 0.2, l6: 0.2, l8: 0.2, l10: 0.2 } },
  category: { choice: '教程', probabilities: { 教程: 0.22, 代码库: 0.2, 百科词条: 0.2, 资源合集: 0.19, 商业产品: 0.19 } }
});
check('分布很平时判定为低置信', flat.lowConfidence === true, 'conf=' + flat.confidence);
check('0 基档位期望可换算成 2-10', JEVProtocol.scoreFromLevelIndex(1.24) > 4 && JEVProtocol.scoreFromLevelIndex(1.24) < 6, JEVProtocol.scoreFromLevelIndex(1.24));

const dist = JEVProtocol.distributeLevels(7);
const distSum = Object.keys(dist).reduce((s, k) => s + dist[k], 0);
const distExpected = JEVProtocol.expectedScore(dist);
check('启发式档位分布和为 1', Math.abs(distSum - 1) < 0.01, 'sum=' + distSum);
check('启发式档位期望≈给定分', Math.abs(distExpected - 7) < 0.6, 'expected=' + distExpected);

/* ---------------- 3. 三条判定后端 ---------------- */
console.log('\n[3] 判定后端');
const settings = Core.Settings.load();
settings.mode = 'demo';
settings.sources = { github: true, web: true, pan: true, kb: true };
settings.threshold = 0.55;
settings.skipClarify = true;

const st1 = { title: 'x', url: 'https://github.com/a/b', source: 'github', snippet: '很详细的描述'.repeat(8), meta: { stars: 20000, updated: '2026-09-01' } };
const p1 = JEV._heuristic.noul(st1, questions.veracity.instructions).p;
const p2 = JEV._heuristic.noul(st1, questions.veracity.instructions).p;
check('启发式 noul 同输入恒定', p1 === p2);
check('启发式 noul 在 [0,1]', p1 >= 0 && p1 <= 1);
check('高风险条目概率更低', JEV._heuristic.noul({ title: '内部资料 破解', url: 'https://pan.baidu.com/s/x', source: 'pan', snippet: '加微信 免费领取', alive: false }, '').p < 0.4);
check('启发式 score 在 [2,10]', JEV._heuristic.score(sample, '', ['工作流', '开源', '新手']).score >= 2);
check('启发式 choice 落在候选分类', Object.keys(JEVProtocol.CATEGORIES).indexOf(JEV._heuristic.choice(sample).choice) > -1);

(async () => {
  /* 本地启发式走 systemone */
  settings.jevBackend = 'local';
  const localRes = await JEV.systemone(sample, '找新手友好的工作流框架', { keywords: ['工作流', '新手'], questions: questions });
  check('systemone 返回 3 个答案', Object.keys(localRes.answers).length === 3);
  check('systemone 标注后端 local', localRes.backend === 'local');
  check('systemone 归一后有 p/score/choice',
    localRes.normalized.p > 0 && localRes.normalized.score >= 2 && !!localRes.normalized.choice);

  /* ONNX 后端：注入 stub 分类器，验证协议与数学（不下载模型） */
  JevOnnx.setClassifier(function (text, labels) {
    const n = labels.length;
    const scores = labels.map((l, i) => (i === n - 2 ? 0.62 : i === n - 1 ? 0.3 : 0.02));
    return { labels: labels, scores: scores };
  });
  settings.jevBackend = 'onnx';
  const onnxRes = await JEV.systemone(sample, '找新手友好的工作流框架', { questions: questions });
  check('ONNX 后端返回 3 个答案', Object.keys(onnxRes.answers).length === 3);
  check('ONNX 路径被标记为 onnx', onnxRes.backend === 'onnx', onnxRes.backend);
  check('ONNX noul 在 [0,1]', onnxRes.normalized.p >= 0 && onnxRes.normalized.p <= 1);
  check('ONNX score 落在 2-10', onnxRes.normalized.score >= 2 && onnxRes.normalized.score <= 10, 'score=' + onnxRes.normalized.score);
  check('ONNX choice 落在候选分类', Object.keys(JEVProtocol.CATEGORIES).indexOf(onnxRes.normalized.choice) > -1, onnxRes.normalized.choice);

  /* 远程不可用 → 必须回落并记录原因 */
  settings.jevBackend = 'remote';
  settings.jevEndpoint = 'http://127.0.0.1:9/api/systemone';
  const remoteRes = await JEV.systemone(sample, '找新手友好的工作流框架', { questions: questions });
  check('远程不可用自动回落启发式', remoteRes.backend === 'heuristic-fallback', remoteRes.backend);
  check('回落原因被记录', !!remoteRes.fallbackReason);
  check('回落结果仍然完整', !!remoteRes.normalized.choice && remoteRes.normalized.score >= 2);
  settings.jevBackend = 'local';

  /* ---------------- 4. 完整流水线 ---------------- */
  console.log('\n[4] 完整流水线（演示模式 · 一次调用问 3 个问题）');
  const events = [];
  const result = await Pipeline.run({
    demand: '找几个适合新手学习 AI Agent 工作流编排的开源项目，最好支持可视化拖拽、有中文文档，最近半年还在更新。',
    settings: settings,
    onEvent: function (type, payload) { events.push({ type, payload }); }
  });

  const steps = events.filter((e) => e.type === 'step');
  const doneSteps = steps.filter((e) => e.payload.state === 'done');
  check('产出 7 个可观测步骤', doneSteps.length === 7, '实际 ' + doneSteps.length);
  check('步骤全部完成无报错', steps.every((e) => e.payload.state !== 'error'));
  check('拿到候选条目', result.items.length > 0, result.items.length + ' 条');
  check('每条都有 3 个判定', result.items.every((it) => it.judgements.length === 3));
  check('排序按综合分降序', result.items.every((it, i, arr) => i === 0 || arr[i - 1].composite >= it.composite));
  check('判定调用次数 = 候选条数（不是 ×3）',
    result.stats.jevRequests > 0 && result.stats.jevQuestions === result.stats.jevRequests * 3,
    result.stats.jevRequests + ' 次 / ' + result.stats.jevQuestions + ' 判');
  check('低置信计数存在', typeof result.stats.lowConfidence === 'number');
  check('摘要含推荐顺序', result.summary.recommends.length > 0);
  check('摘要含风险提示', result.summary.risks.length > 0);
  check('摘要写明判定引擎', /启发式|ONNX|官方|服务/.test(result.jevBackendLabel || ''), result.jevBackendLabel);
  check('脱敏统计串起', result.stats.masked >= 1);
  check('演示数据被明确标注', result.simulated === true);
  check('每条判定都带后端名', result.items.every((it) => !!it.jevBackend));

  /* ---------------- 5. 追问 ---------------- */
  console.log('\n[5] 需求追问');
  check('含糊需求会追问', Pipeline.needsClarify('帮我找点东西', { skipClarify: false }).need === true);
  check('具体需求不追问', Pipeline.needsClarify('找几个适合新手学习 AI Agent 工作流编排的开源项目，要有中文文档', { skipClarify: false }).need === false);
  check('可关闭追问', Pipeline.needsClarify('帮我找点东西', { skipClarify: true }).need === false);

  /* ---------------- 6. 知识库 ---------------- */
  console.log('\n[6] 知识库');
  const created = KB.create('冒烟测试库', '临时');
  check('新建知识库成功', created.ok === true);
  check('新增条目成功', KB.addDoc(created.kb.id, { t: '测试条目', d: '包含关键词 JEV 判定的内容。' }).ok === true);
  check('拒绝空标题', KB.addDoc(created.kb.id, { t: '', d: 'x' }).ok === false);
  check('知识库检索有结果', KB.search(['JEV', '判定'], 3).length > 0);
  KB.remove(created.kb.id);
  check('删除知识库生效', !KB.get(created.kb.id));

  /* ---------------- 7. 提示词库 ---------------- */
  console.log('\n[7] 提示词库');
  check('至少 4 个分组', PromptLib.GROUPS.length >= 4);
  const total = PromptLib.GROUPS.reduce((s, g) => s + g.items.length, 0);
  check('内置模板 >= 12 条', total >= 12, total + ' 条');
  check('每条模板都有内容', PromptLib.GROUPS.every((g) => g.items.every((it) => it.prompt && it.title)));

  /* ---------------- 汇总 ---------------- */
  console.log('\n============================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (result.items.length) {
    console.log('\n前 3 条结果预览：');
    result.items.slice(0, 3).forEach((it) => {
      console.log('  ' + it.rank + '. ' + it.title + '  匹配 ' + it.score + ' / 真伪 ' + it.p.toFixed(2) +
        ' / 置信 ' + (it.confidence == null ? '—' : it.confidence));
    });
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\n测试执行失败：', err);
  process.exit(1);
});
