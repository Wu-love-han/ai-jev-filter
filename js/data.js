/* ===========================================================
   data.js — 演示数据集 / 知识库种子 / JEV 问题模板 / 启动物料
   说明：演示数据用于「演示模式」与实时检索失败时的回落，
        全部条目标注 simulated，界面会明确告知用户。
   =========================================================== */
(function (global) {
  'use strict';

  var SOURCE_META = {
    github: { label: 'GitHub', icon: 'i-github', cls: 'src-github', kind: 'code' },
    web:    { label: '网页',   icon: 'i-globe',  cls: 'src-web',    kind: 'doc'  },
    pan:    { label: '网盘',   icon: 'i-cloud',  cls: 'src-pan',    kind: 'file' },
    kb:     { label: '知识库', icon: 'i-book',   cls: 'src-kb',     kind: 'kb'   }
  };

  /* ---------------- 演示数据池 ---------------- */
  /* GitHub 演示条目全部为真实存在的公开仓库，链接可点开核对 */
  var DEMO = {
    github: [
      {
        t: 'langgenius/dify', u: 'https://github.com/langgenius/dify', s: 'github',
        d: '生产级 LLM 应用开发平台：可视化 Workflow / Chatflow 编排，内置 RAG、Agent 与插件体系，中文文档完整。',
        m: { stars: 68000, lang: 'TypeScript', updated: '2026-09-27', license: 'Apache-2.0' }
      },
      {
        t: 'FlowiseAI/Flowise', u: 'https://github.com/FlowiseAI/Flowise', s: 'github',
        d: '拖拽式 LLM 流程编排工具，节点即插即用，适合快速验证想法与课堂演示。',
        m: { stars: 41000, lang: 'TypeScript', updated: '2026-09-25', license: 'Apache-2.0' }
      },
      {
        t: 'n8n-io/n8n', u: 'https://github.com/n8n-io/n8n', s: 'github',
        d: '开源工作流自动化平台，400+ 集成，常被当作 Agent 的调度底座使用。',
        m: { stars: 128000, lang: 'TypeScript', updated: '2026-09-26', license: 'Sustainable Use' }
      },
      {
        t: 'langflow-ai/langflow', u: 'https://github.com/langflow-ai/langflow', s: 'github',
        d: '低代码构建与部署 AI Agent 与工作流的可视化工具，支持导出为 API 直接调用。',
        m: { stars: 62000, lang: 'Python', updated: '2026-09-24', license: 'MIT' }
      },
      {
        t: 'datawhalechina/jev-cookbook', u: 'https://github.com/datawhalechina/jev-cookbook', s: 'github',
        d: 'Jev（TypeSafe System One 判断模型）中文入门教程：三种问题原语、18 篇实战配方、模型评测与本地微调。',
        m: { stars: 3200, lang: 'Jupyter Notebook', updated: '2026-09-18', license: 'CC BY-NC-SA 4.0' }
      },
      {
        t: 'zhuanqianfish/local-jev', u: 'https://github.com/zhuanqianfish/local-jev', s: 'github',
        d: '浏览器端 Jev：纯本地 ONNX 推理，noul / choice / score 三原语，零 token 费用。',
        m: { stars: 860, lang: 'JavaScript', updated: '2026-09-12', license: 'MIT' }
      }
    ],

    web: [
      {
        t: '智能体（Agent）— 维基百科', u: 'https://zh.wikipedia.org/wiki/%E6%99%BA%E8%83%BD%E4%BD%93', s: 'web',
        d: '智能体是能够感知环境、自主决策并采取行动以达成目标的系统；条目梳理了反应式与规划式两类范式。',
        m: { site: 'zh.wikipedia.org' }
      },
      {
        t: 'AI Agent — 百度百科', u: 'https://baike.baidu.com/item/AI%20Agent', s: 'web',
        d: 'AI Agent 指以大型语言模型为推理核心、可调用工具完成多步任务的软件实体。',
        m: { site: 'baike.baidu.com' }
      },
      {
        t: 'ReAct: Synergizing Reasoning and Acting in Language Models', u: 'https://arxiv.org/abs/2210.03629', s: 'web',
        d: '把推理与行动交替生成：Thought → Action → Observation 循环，是当前多数 Agent 框架的骨架。',
        m: { site: 'arxiv.org', year: 2023 }
      },
      {
        t: '阮一峰的网络日志 — 开发者周刊', u: 'https://www.ruanyifeng.com/blog/', s: 'web',
        d: '中文技术博客，长期跟踪开源工具与前端生态，适合新手建立技术视野。',
        m: { site: 'ruanyifeng.com' }
      },
      {
        t: 'TypeSafe AI 官方文档', u: 'https://docs.typesafe.ai', s: 'web',
        d: 'Jev（System One 判断模型）的官方文档：三种原语、状态输入、置信度与接入方式。',
        m: { site: 'docs.typesafe.ai' }
      }
    ],

    /* 演示用网盘条目：含失效链接、含敏感信息的条目，用于展示存活核验与脱敏。
       注意：下面所有网盘分享链接、微信号、手机号均为**虚构的演示数据**
       （格式合法但资源不存在、号码不对应真实个人），仅用于验证脱敏与核验逻辑。 */
    pan: [
      {
        t: 'AI Agent 工作流编排实战（全套视频 + 源码）', u: 'https://pan.baidu.com/s/1AbCdEfGhIjK', s: 'pan',
        d: '12 章，含 Dify / Flowise 实操，附赠流程图模板与提示词卡片。整理者微信 wx_demo2026，解压密码见群公告。',
        m: { size: '18.6 GB', site: '百度网盘' }, alive: true
      },
      {
        t: 'Jev 判断模型论文合集与复现代码', u: 'https://pan.quark.cn/s/9f8e7d6c5b4a', s: 'pan',
        d: '论文 PDF + 复现 notebook，含 noul / score 原语的对比实验数据。',
        m: { size: '2.1 GB', site: '夸克网盘' }, alive: true
      },
      {
        t: '内部资料：Agent 平台商业版源码（破解）', u: 'https://pan.baidu.com/s/1deadbeef00', s: 'pan',
        d: '免费领取 内部资料，加微信领取解压密码，代下不限速。',
        m: { size: '—', site: '百度网盘' }, alive: false
      },
      {
        t: '新手友好 AI 工具清单 2026 版', u: 'https://www.alipan.com/s/demoXyz123', s: 'pan',
        d: '按学习路径整理的工具清单，含入门成本与替代方案。联系电话 13800138000。',
        m: { size: '86 MB', site: '阿里云盘' }, alive: false
      },
      {
        t: '提示词工程模板库（含脱敏样例）', u: 'https://pan.quark.cn/s/prompt2026', s: 'pan',
        d: '60 个可直接套用的提示词模板，其中 8 个涉及数据脱敏与合规检查。',
        m: { size: '340 MB', site: '夸克网盘' }, alive: true
      }
    ]
  };

  /* ---------------- 知识库种子（首次打开时写入本地存储） ---------------- */
  var KB_SEED = [
    {
      id: 'kb_starter',
      name: '新手课程资料',
      desc: '产教融合课程讲义：框架意识、判断与生成的边界',
      docs: [
        { t: '第 1 课：什么是信息筛选工作流', d: '工作流是把多个能力步骤按依赖关系串起来：需求 → 检索 → 判断 → 排序 → 摘要。每一步只做一件事，串起来才可解释、可替换。' },
        { t: '第 2 课：判断与生成的边界', d: '生成模型擅长写与理解，判断模型擅长在岔路口给出一个概率。把两者混在一个提示词里，会同时失去可控性和可解释性。' },
        { t: '第 3 课：阈值必须写在代码里', d: '模型只输出概率或分数，最终「通过还是拒绝」由代码按阈值决定，这样每次判定都可复现、可审计。' },
        { t: '第 4 课：批量判定摊薄延迟', d: '把一批候选信息放进同一次判断调用，延迟从 N 次累加变成 1 次，成本几乎不变。' },
        { t: '第 5 课：先硬规则，后模型', d: '链接格式、黑名单这类可计算的检查放在代码里，命中即淘汰，一次模型调用都不用花。' }
      ]
    },
    {
      id: 'kb_jev',
      name: 'JEV 使用手册',
      desc: 'TypeSafe System One：三种问题原语与写法要点',
      docs: [
        { t: '原语一：noul（是 / 否）', d: '问一个能用概率回答的问题，比如「这条结果是否指向真实存在的开源项目」。返回 0-1 概率，配合阈值做路由。' },
        { t: '原语二：score（打分）', d: '给出评分维度后返回 2-10 分。维度要写清，例如「主题一致性 / 是否覆盖关键能力 / 对新手是否友好」。' },
        { t: '原语三：choice（单选）', d: '给一组互斥选项，返回其中一个分类。适合做路由：教程 / 代码库 / 资源合集 / 商业产品。' },
        { t: '写法要点：类型化问题', d: '不要写「帮我分析一下这条信息」，要写「这条信息是否满足 X」。JEV 不做自由生成，问题越类型化，判定越稳。' },
        { t: '接入形态', d: '官方走 TypeSafe API（需 API Key）；也可用 Laya 等开源同族模型做本地微调，通过本地代理暴露 HTTP 接口，浏览器端只调用代理。' }
      ]
    },
    {
      id: 'kb_compliance',
      name: '合规与脱敏条款',
      desc: '个人信息保护：脱敏、最小必要、来源可追溯',
      docs: [
        { t: '第 3.1 条：敏感信息前置过滤', d: '手机号、身份证号、邮箱等个人标识信息必须在进入模型之前脱敏，禁止以原文形式发送给外部接口。' },
        { t: '第 3.2 条：最小必要原则', d: '只提交完成当前判断所必需的字段，检索到的原始页面不得整体透传给模型。' },
        { t: '第 4 条：来源可追溯', d: '每一条对外展示的信息都必须保留来源与核验状态，失效链接应沉底或标注，不得伪装为有效来源。' }
      ]
    }
  ];

  /* ---------------- JEV 问题模板（右侧提示词面板与判定默认值共用） ---------------- */
  var JEV_QUESTIONS = {
    noul: [
      { name: '真伪判断', question: '这条检索结果是否指向一个真实存在、可访问的开源项目或公开资料？', threshold: 0.55 },
      { name: '内容完整性', question: '这条信息的描述是否足以支撑一个明确结论，而不只是重复标题？', threshold: 0.5 },
      { name: '风险信号', question: '这条信息是否具有破解、代下、诱导加微信等高风险特征？', threshold: 0.45 }
    ],
    score: [
      { name: '相关性评分', criteria: '评分维度：与用户需求的主题一致性；是否覆盖需求里点名的关键能力；是否解决了需求中的痛点。' },
      { name: '可信度评分', criteria: '评分维度：来源权威度——官方仓库 / 权威百科 8-10 分，技术博客 5-7 分，网盘转载 2-4 分。' },
      { name: '时效性评分', criteria: '评分维度：最近 3 个月有更新 9-10 分；半年内 7-8 分；1 年以上 2-4 分。' }
    ],
    choice: [
      { name: '内容类型', options: ['教程', '代码库', '百科词条', '资源合集', '商业产品'] },
      { name: '采信建议', options: ['可直接采信', '需交叉验证', '不建议采信'] },
      { name: '学习阶段', options: ['入门了解', '动手实践', '对比选型', '找资源下载'] }
    ]
  };

  var DEFAULT_NLOUL = JEV_QUESTIONS.noul[0].question;
  var DEFAULT_CRITERIA = JEV_QUESTIONS.score[0].criteria;
  var DEFAULT_CHOICE = JEV_QUESTIONS.choice[0].options;

  /* ---------------- 首屏示例（点击即用） ---------------- */
  var STARTERS = [
    {
      icon: 'i-github',
      title: '找一套能上手的工作流框架',
      desc: '适合新手、有中文文档、最近还在更新',
      demand: '找几个适合新手学习 AI Agent 工作流编排的开源项目，最好支持可视化拖拽、有中文文档，最近半年还在更新。',
      sources: ['github', 'web', 'kb']
    },
    {
      icon: 'i-scales',
      title: '这条信息到底可不可信',
      desc: '让 JEV 先验真，再给采信建议',
      demand: '帮我核实「AI Agent 可以完全替代人工客服」这个说法，找公开资料判断它的可信度，并给出采信建议。',
      sources: ['web', 'github']
    },
    {
      icon: 'i-cloud',
      title: '网盘资源值不值得下',
      desc: '带存活核验 + 敏感信息脱敏',
      demand: '找 AI Agent 教程的网盘资源，要求链接能正常打开，避开那种需要加微信才能用的。',
      sources: ['pan', 'web']
    },
    {
      icon: 'i-book',
      title: '只用我自己的知识库',
      desc: '先把自建内容讲清楚，再补外部信息',
      demand: '根据我的知识库，总结一下 JEV 三种原语分别适合用在什么场景，再补充外部资料。',
      sources: ['kb', 'github']
    }
  ];

  /* ---------------- 关键词映射（中文需求 → GitHub 可检索的英文词） ---------------- */
  var EN_MAP = {
    '工作流': 'workflow', '可视化': 'visualization', '拖拽': 'drag drop', '开源': 'open source',
    '智能体': 'agent', '新手': 'beginner', '教程': 'tutorial', '框架': 'framework',
    '判断': 'judgement', '检索': 'search', '网盘': 'cloud drive', '知识库': 'knowledge base',
    '脱敏': 'privacy', '编排': 'orchestration', '提示词': 'prompt', '评分': 'scoring',
    '模型': 'llm', '数字人': 'digital human', '爬虫': 'crawler', '知识图谱': 'knowledge graph'
  };

  var BLOCK_WORDS = ['破解', '代下', '加微信', '免费领取', '内部资料', '私聊', '刷单', '外挂'];

  global.DATA = {
    SOURCE_META: SOURCE_META,
    DEMO: DEMO,
    KB_SEED: KB_SEED,
    JEV_QUESTIONS: JEV_QUESTIONS,
    DEFAULT_NLOUL: DEFAULT_NLOUL,
    DEFAULT_CRITERIA: DEFAULT_CRITERIA,
    DEFAULT_CHOICE: DEFAULT_CHOICE,
    STARTERS: STARTERS,
    EN_MAP: EN_MAP,
    BLOCK_WORDS: BLOCK_WORDS
  };
})(window);
