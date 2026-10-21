/* ===========================================================
   promptlib.js — 右侧「提示词工作台」：模板库 + 自定义提示词
   设计意图：把提示词工程变成可点击的教学资产。
     · 内置模板覆盖：新手入门 / 信息筛选 / 提示词工程 / 知识库
     · 点击 = 直接检索（或仅填入输入框，可切换）
     · 自定义模板存在本地，可编辑、可删除
   =========================================================== */
(function (global) {
  'use strict';

  var C = global.Core;
  var esc = C.esc;

  /* 内置模板：prompt 里的 {{需求}} 是给人看的占位符 */
  var GROUPS = [
    {
      id: 'starter', title: '新手入门', icon: 'i-bubble',
      items: [
        {
          id: 'p_newbie_repo', title: '找新手友好的开源项目', tag: '检索',
          desc: '有中文文档、最近还在更新、能本地跑',
          prompt: '找几个适合新手学习 AI Agent 工作流编排的开源项目。要求：有中文文档、最近半年有更新、能本地跑起来，每个项目说明上手难度。'
        },
        {
          id: 'p_learning_path', title: '规划一条学习路线', tag: '规划',
          desc: '从零到能改流程，分阶段给资源',
          prompt: '帮我规划一条从零开始学 AI Agent 的学习路线，按阶段列出每一阶段该看的开源项目或教程，并说明每阶段能做出什么。'
        },
        {
          id: 'p_template_repo', title: '找可直接改的工作流模板', tag: '检索',
          desc: '要示例配置，不要只给框架',
          prompt: '找可以直接拿来改的 AI 工作流模板仓库，要求有中文说明和示例配置文件，方便课堂演示。'
        },
        {
          id: 'p_concept', title: '解释一个概念', tag: '理解',
          desc: 'JEV 是什么，和普通大模型差在哪',
          prompt: '用新手能听懂的话解释「JEV 判定模型」是什么、和普通大模型的区别，并给出 3 个实际用途。'
        }
      ]
    },
    {
      id: 'filter', title: '信息筛选', icon: 'i-shield',
      items: [
        {
          id: 'p_verify_claim', title: '核实一个说法', tag: 'JEV · noul',
          desc: '找出支持与反对的资料，再下结论',
          prompt: '核实「AI Agent 能完全替代人工客服」这个说法。请找出支持与反对的公开资料，判断可信度，最后给出采信建议。'
        },
        {
          id: 'p_compare', title: '三选一对比选型', tag: 'JEV · score',
          desc: '同一套维度打分，不让模型自由发挥',
          prompt: '对比 Dify、Flowise、n8n 这三个开源工作流编排项目，从上手难度、扩展性、部署成本三个维度打分并给结论。'
        },
        {
          id: 'p_fresh', title: '只看最近更新的', tag: '时效',
          desc: '过滤掉一年没维护的仓库',
          prompt: '找 AI 工作流编排相关的开源项目，只要最近 3 个月有更新的，并把更新时间列出来。'
        },
        {
          id: 'p_pan_safe', title: '网盘资源避坑', tag: '存活核验',
          desc: '要能打开的链接，避开诱导加微信',
          prompt: '找 AI Agent 教程的网盘资源，要求链接能正常打开，避开需要加微信才能用的那种。'
        }
      ]
    },
    {
      id: 'prompteng', title: '提示词工程', icon: 'i-spark',
      items: [
        {
          id: 'p_kw_template', title: '模板：抽检索关键词', tag: '模板',
          desc: '把需求压成 3-6 个关键词',
          prompt: '从下面的需求中提取 3-6 个检索关键词，用空格连接，不要解释：{{需求}}'
        },
        {
          id: 'p_jev_question', title: '模板：改写 JEV 类型化问题', tag: '模板',
          desc: '把「可不可信」变成可判定的问题',
          prompt: '把「这段资料可不可信」改写成 JEV noul 原语能回答的类型化问题。只输出一个句子，不要解释。'
        },
        {
          id: 'p_jev_criteria', title: '模板：写评分标准', tag: '模板',
          desc: '3 个维度，写清 2-10 分怎么给',
          prompt: '为「开源项目是否适合新手」写一套 JEV score 评分标准，共 3 个维度，每个维度说明 2-10 分分别怎么给。'
        }
      ]
    },
    {
      id: 'kb', title: '知识库', icon: 'i-book',
      items: [
        {
          id: 'p_kb_only', title: '只用我的知识库', tag: '约束',
          desc: '不许引入库外内容，压住幻觉',
          prompt: '根据我的知识库，总结 JEV 三种原语分别适合什么场景。不要引入知识库以外的内容，答不了就直说。'
        },
        {
          id: 'p_kb_check', title: '入库前先核验', tag: '质检',
          desc: '逐条标出可能过时的内容',
          prompt: '把「JEV 使用手册」知识库里的条目逐条核验一遍，标出可能过时或需要补充的地方。'
        }
      ]
    }
  ];

  var CUSTOM_KEY = 'customPrompts';

  function customList() {
    var list = C.Store.get(CUSTOM_KEY, []);
    return Array.isArray(list) ? list : [];
  }

  function saveCustom(item) {
    var list = customList();
    item.id = item.id || C.uid('p');
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === item.id) idx = i;
    if (idx > -1) list[idx] = item; else list.push(item);
    C.Store.set(CUSTOM_KEY, list);
    return item;
  }

  function removeCustom(id) {
    var list = customList().filter(function (x) { return x.id !== id; });
    C.Store.set(CUSTOM_KEY, list);
  }

  function findById(id) {
    var found = null;
    GROUPS.forEach(function (g) {
      g.items.forEach(function (it) { if (it.id === id) found = it; });
    });
    if (found) return found;
    return customList().filter(function (x) { return x.id === id; })[0] || null;
  }

  /* ---------------- 渲染 ---------------- */
  function promptItemHtml(item) {
    return '' +
      '<div class="prompt-item" data-pid="' + esc(item.id) + '" role="button" tabindex="0">' +
        '<div class="pi-act">' +
          (item.custom ? '<button class="pi-mini" data-act="edit" title="编辑"><svg class="ic"><use href="#i-settings"/></svg></button>' +
            '<button class="pi-mini" data-act="del" title="删除"><svg class="ic"><use href="#i-trash"/></svg></button>' : '') +
          '<button class="pi-mini" data-act="copy" title="复制"><svg class="ic"><use href="#i-copy"/></svg></button>' +
        '</div>' +
        '<div class="pi-top"><span class="pi-title">' + esc(item.title) + '</span>' +
          (item.tag ? '<span class="pi-tag">' + esc(item.tag) + '</span>' : '') + '</div>' +
        '<div class="pi-desc">' + esc(item.desc || '') + '</div>' +
        '<div class="pi-prompt">' + esc(item.prompt) + '</div>' +
      '</div>';
  }

  function render(container, ctx) {
    if (!container) return;
    var html = '';
    GROUPS.forEach(function (g) {
      html += '<div class="pgroup">' +
        '<div class="pgroup-title"><svg class="ic"><use href="#' + g.icon + '"/></svg>' + esc(g.title) +
        '<span class="pcount">' + g.items.length + '</span></div>' +
        g.items.map(promptItemHtml).join('') +
        '</div>';
    });

    var custom = customList();
    if (custom.length) {
      html += '<div class="pgroup">' +
        '<div class="pgroup-title"><svg class="ic"><use href="#i-settings"/></svg>我的提示词' +
        '<span class="pcount">' + custom.length + '</span></div>' +
        custom.map(function (it) { it.custom = true; return promptItemHtml(it); }).join('') +
        '</div>';
    }

    container.innerHTML = html;

    container.addEventListener('click', function (e) {
      var itemEl = e.target.closest ? e.target.closest('.prompt-item') : null;
      if (!itemEl) return;
      var pid = itemEl.getAttribute('data-pid');
      var actBtn = e.target.closest ? e.target.closest('[data-act]') : null;

      if (actBtn) {
        e.stopPropagation();
        var act = actBtn.getAttribute('data-act');
        var item = findById(pid);
        if (!item) return;
        if (act === 'copy' && ctx.onCopy) ctx.onCopy(item);
        if (act === 'edit' && ctx.onEdit) ctx.onEdit(item);
        if (act === 'del' && ctx.onDelete) ctx.onDelete(item);
        return;
      }
      var target = findById(pid);
      if (target && ctx.onUse) ctx.onUse(target);
    });

    container.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var itemEl = e.target.closest ? e.target.closest('.prompt-item') : null;
      if (!itemEl) return;
      e.preventDefault();
      var target = findById(itemEl.getAttribute('data-pid'));
      if (target && ctx.onUse) ctx.onUse(target);
    });
  }

  global.PromptLib = {
    GROUPS: GROUPS,
    render: render,
    findById: findById,
    customList: customList,
    saveCustom: saveCustom,
    removeCustom: removeCustom
  };
})(window);
