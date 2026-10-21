/* ===========================================================
   app.js — 界面主控：对话流 / 思考过程 / 结果卡片 / 设置 / 知识库
   纯前端经典脚本：双击 index.html 即可运行，无需构建、无需后端
   =========================================================== */
(function (global) {
  'use strict';

  var C = global.Core, DATA = global.DATA, S = global.Sources, P = global.Pipeline;
  var JEV = global.JEV, KB = global.KB, PromptLib = global.PromptLib;
  var esc = C.esc;

  /* ---------------- 状态 ---------------- */
  var State = {
    chats: [],
    currentId: null,
    running: false,
    settings: null,
    modalKb: null
  };

  var $ = function (id) { return document.getElementById(id); };
  var els = {};

  function chat() {
    for (var i = 0; i < State.chats.length; i++) if (State.chats[i].id === State.currentId) return State.chats[i];
    return null;
  }

  function svg(name, size) {
    var s = size || 14;
    return '<svg class="ic" width="' + s + '" height="' + s + '"><use href="#' + name + '"/></svg>';
  }

  function srcMeta(key) {
    return DATA.SOURCE_META[key] || { label: key, icon: 'i-globe', cls: 'src-web' };
  }

  function toast(msg, kind) {
    var el = document.createElement('div');
    el.className = 'toast toast-' + (kind || 'info');
    el.innerHTML = svg(kind === 'ok' ? 'i-check' : kind === 'err' ? 'i-alert' : 'i-bubble', 14) + '<span>' + esc(msg) + '</span>';
    els.toasts.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(function () { el.remove(); }, 260);
    }, 2600);
  }

  /* ---------------- 会话持久化 ---------------- */
  function loadChats() {
    var saved = C.Store.get('chats', []);
    State.chats = Array.isArray(saved) ? saved : [];
    if (State.chats.length) State.currentId = State.chats[0].id;
    else newChat(true);
  }

  function saveChats() {
    var slim = State.chats.slice(0, 10).map(function (c) {
      return {
        id: c.id, title: c.title, at: c.at,
        messages: c.messages.map(function (m) {
          if (m.type === 'result' && m.result) {
            var r = m.result;
            return {
              id: m.id, role: m.role, at: m.at, type: m.type, text: m.text,
              result: {
                demand: r.demand, keywords: r.keywords, summary: r.summary,
                items: (r.items || []).slice(0, 8),
                sourceStatus: r.sourceStatus, maskedDetail: r.maskedDetail,
                blockedDetail: r.blockedDetail, stats: r.stats,
                simulated: r.simulated, relaxed: r.relaxed, empty: r.empty,
                emptyReason: r.emptyReason, jevBackend: r.jevBackend
              }
            };
          }
          return m;
        })
      };
    });
    C.Store.set('chats', slim);
  }

  function newChat(silent) {
    var c = { id: C.uid('c'), title: '新对话', at: Date.now(), messages: [] };
    State.chats.unshift(c);
    if (State.chats.length > 10) State.chats = State.chats.slice(0, 10);
    State.currentId = c.id;
    saveChats();
    renderChatList();
    renderThread();
    if (!silent) {
      els.input.value = '';
      autoGrow();
      els.input.focus();
    }
    return c;
  }

  function ensureChat() {
    var c = chat();
    if (c) return c;
    return newChat(true);
  }

  function renderChatList() {
    els.chatList.innerHTML = State.chats.map(function (c) {
      return '<div class="chat-item' + (c.id === State.currentId ? ' is-active' : '') + '" data-cid="' + esc(c.id) + '" title="' + esc(c.title) + '">' +
        '<span class="ci-title">' + esc(c.title) + '</span>' +
        '<button class="ci-del" data-del-cid="' + esc(c.id) + '" title="删除会话">' + svg('i-trash', 12) + '</button>' +
        '</div>';
    }).join('') || '<div class="kb-empty" style="padding:12px 6px">还没有会话</div>';
  }

  /* ---------------- 消息渲染 ---------------- */
  function maskHtml(text) { return C.mask.html(esc(text)); }

  function thinkingHtml() {
    return '<div class="thinking is-open">' +
      '<button class="thinking-head" type="button">' +
        '<span class="spin"></span>' +
        '<span class="th-title">正在执行检索框架…</span>' +
        '<span class="th-status"></span>' +
        '<span class="th-chev">' + svg('i-chevron', 14) + '</span>' +
      '</button>' +
      '<ol class="thinking-steps"></ol>' +
      '</div>';
  }

  function messageEl(msg) {
    var el = document.createElement('div');
    el.className = 'msg ' + (msg.role === 'user' ? 'msg-user' : 'msg-ai');
    el.setAttribute('data-mid', msg.id);

    var avatar = msg.role === 'user' ? '我' : 'J';
    var inner = '';

    if (msg.type === 'clarify') {
      inner += '<div class="clarify">' +
        '<div class="clarify-q">' + svg('i-bubble', 15) + '<span>' + esc(msg.text) + '</span></div>' +
        '<div class="chips">' + (msg.clarify.options || []).map(function (o, i) {
          return '<button class="chip' + (o.primary ? ' chip-primary' : '') + '" type="button" data-clarify="' + i + '">' +
            esc(o.label) + '</button>';
        }).join('') + '</div>' +
        '</div>';
    } else {
      if (msg.steps) inner += thinkingHtml();
      if (msg.type === 'result') inner += '<div class="result-slot"></div>';
      else inner += '<div class="bubble">' + maskHtml(msg.text || '') + '</div>';
    }

    el.innerHTML = '<div class="msg-avatar">' + avatar + '</div>' +
      '<div class="msg-body">' + inner +
      '<div class="msg-time">' + (msg.at ? timeOf(msg.at) : '') + '</div></div>';

    if (msg.type === 'result') {
      var slot = el.querySelector('.result-slot');
      if (slot && msg.result) slot.innerHTML = resultHtml(msg.result, msg.id);
    }

    /* 恢复历史消息里的思考过程 */
    if (msg.steps && msg.steps.length) {
      var list = el.querySelector('.thinking-steps');
      msg.steps.forEach(function (st) { list.appendChild(stepEl(st)); });
      var th = el.querySelector('.thinking');
      var head = el.querySelector('.thinking-head');
      if (head) {
        head.querySelector('.spin').style.display = 'none';
        head.querySelector('.th-title').textContent = '框架执行记录';
        head.querySelector('.th-status').textContent = msg.steps.length + ' 步';
      }
      th.classList.remove('is-open');
    }

    return el;
  }

  function stepEl(st) {
    var li = document.createElement('li');
    li.className = 'step';
    li.setAttribute('data-step', st.id);
    li.setAttribute('data-state', st.state || 'running');
    li.innerHTML = '<span class="step-ic"></span>' +
      '<span><span class="step-label">' + esc(st.label) + '</span>' +
      (st.detail ? '<span class="step-detail">' + esc(st.detail) + '</span>' : '') + '</span>' +
      '<span class="step-meta">' + (st.ms != null ? fmtMs(st.ms) : '') + '</span>';
    return li;
  }

  function timeOf(ts) {
    var d = new Date(ts);
    function p(x) { return x < 10 ? '0' + x : '' + x; }
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* 本地判定很快，用毫秒显示才有意义 */
  function fmtMs(ms) {
    ms = Number(ms) || 0;
    if (ms < 1000) return Math.max(1, Math.round(ms)) + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  }

  function renderThread() {
    var c = chat();
    els.messages.innerHTML = '';
    els.threadInner.querySelector('.welcome').classList.toggle('is-hidden', !!(c && c.messages.length));
    if (!c) return;
    c.messages.forEach(function (m) { els.messages.appendChild(messageEl(m)); });
    /* 有消息时贴底；欢迎页必须回到顶部，否则小屏上标题会被顶出视口 */
    if (c.messages.length) scrollBottom(true);
    else els.thread.scrollTop = 0;
  }

  function scrollBottom(force) {
    if (!els.thread) return;
    var near = els.thread.scrollHeight - els.thread.scrollTop - els.thread.clientHeight < 220;
    if (force || near) els.thread.scrollTop = els.thread.scrollHeight;
  }

  /* ---------------- 结果卡片 ---------------- */
  function aliveBadge(it) {
    if (it.source !== 'pan') return '';
    if (it.alive === true) return '<span class="alive-badge alive-ok">链接有效</span>';
    if (it.alive === false) return '<span class="alive-badge">链接失效</span>';
    return '';
  }

  function metaHtml(it) {
    var m = it.meta || {};
    var parts = [];
    if (it.source === 'github') {
      if (m.stars != null) parts.push('<span class="cm">★ ' + C.fmtNum(m.stars) + '</span>');
      if (m.lang) parts.push('<span class="cm">' + esc(m.lang) + '</span>');
      if (m.license && m.license !== '—') parts.push('<span class="cm">' + esc(m.license) + '</span>');
      if (m.updated) parts.push('<span class="cm">更新于 ' + esc(m.updated) + '</span>');
    } else if (it.source === 'pan') {
      if (m.site) parts.push('<span class="cm">' + esc(m.site) + '</span>');
      if (m.size) parts.push('<span class="cm">' + esc(m.size) + '</span>');
      parts.push('<span class="cm">第三方转载</span>');
    } else if (it.source === 'web') {
      if (m.site) parts.push('<span class="cm">' + esc(m.site) + '</span>');
      parts.push('<span class="cm">公开网页</span>');
    } else if (it.source === 'kb') {
      parts.push('<span class="cm">来自知识库：' + esc(it.fromKB || m.kb || '—') + '</span>');
    }
    return parts.length ? '<div class="card-meta">' + parts.join('') + '</div>' : '';
  }

  function bar(label, val, max, cls, fmt) {
    var pct = C.clamp(val / max * 100, 0, 100);
    return '<div class="sitem"><span class="slabel">' + label + '</span>' +
      '<span class="sval' + (cls === 'judge' ? ' val-judge' : '') + '">' + (fmt ? fmt(val) : val) + '</span>' +
      '<span class="sbar' + (cls === 'judge' ? ' bar-judge' : '') + '"><i style="width:' + pct.toFixed(0) + '%"></i></span></div>';
  }

  function probBars(probs, order, labeller) {
    var keys = order || Object.keys(probs || {});
    var items = [];
    keys.forEach(function (k) {
      var p = Number((probs || {})[k] || 0);
      if (p <= 0.001) return;
      items.push('<span class="pbar"><span class="pbar-k">' + esc(labeller ? labeller(k) : k) + '</span>' +
        '<span class="pbar-track"><i style="width:' + Math.round(p * 100) + '%"></i></span>' +
        '<span class="pbar-v">' + p.toFixed(2) + '</span></span>');
    });
    return items.join('');
  }

  function whyHtml(it) {
    var P = global.JEVProtocol;
    var rows = (it.judgements || []).map(function (j) {
      var key, val;
      if (j.proto === 'noul') {
        key = 'noul · 真伪';
        val = 'p = <b>' + j.value.toFixed(2) + '</b>' + (j.pass ? ' → 通过' : ' → 未通过') +
          '<br><span class="why-q">问题：' + esc(j.question || '') + '（官方 noul 只给概率，不带 confidence）</span>';
      } else if (j.proto === 'score') {
        key = 'score · 匹配';
        val = '<b>' + j.value.toFixed(1) + '</b> / 10' + (j.pass ? '' : ' → 低于建议线') +
          '<div class="pbar-box">' + probBars(j.probabilities, (P ? P.LEVELS.map(function (l) { return l.key; }) : null),
            function (k) { return P ? (P.LEVELS.filter(function (l) { return l.key === k; })[0] || {}).value + ' 分' : k; }) + '</div>';
      } else if (j.proto === 'choice') {
        key = 'choice · 分类';
        val = '<b>' + esc(j.value) + '</b>（置信 ' + (j.confidence || 0).toFixed(2) + '）' +
          '<div class="pbar-box">' + probBars(j.probabilities) + '</div>';
      }
      return { key: key, val: val, j: j, proto: j.proto };
    });

    var headline = rows.map(function (r) {
      var bad = r.proto === 'noul' ? !r.j.pass : (r.proto === 'score' ? !r.j.pass : false);
      return '<span class="why-sig' + (bad ? ' sig-down' : ' sig-up') + '">' + r.key + '</span>';
    }).join('');
    if (it.confidence != null) {
      headline += '<span class="why-sig' + (it.lowConfidence ? ' sig-down' : ' sig-up') + '">置信 ' +
        it.confidence.toFixed(2) + (it.lowConfidence ? ' · 建议复核' : '') + '</span>';
    }

    var signalChips = [];
    (it.judgements || []).forEach(function (j) {
      (j.signals || []).forEach(function (s) {
        if (s.kind === 'flat' || Math.abs(s.delta) < 0.01) return;
        signalChips.push('<span class="why-sig ' + (s.kind === 'up' ? 'sig-up' : 'sig-down') + '" title="' +
          esc((s.delta > 0 ? '+' : '') + s.delta) + '">' + esc(s.label) + '</span>');
      });
    });

    var backendName = {
      local: '本地启发式模拟（离线、确定性）',
      heuristic: '本地启发式模拟（离线、确定性）',
      onnx: '浏览器 ONNX 推理（local-jev 方案）',
      remote: '本地开源服务 / 官方 API（经代理）',
      'heuristic-fallback': '真实后端不可用 → 已回落启发式'
    }[(it.jevBackend || (it.judgements[0] && it.judgements[0].backend) || 'local')] || (it.jevBackend || 'local');

    return '<details class="card-why"><summary>' + svg('i-scales', 12) + 'JEV 判定依据（1 次调用 · 3 个问题）</summary>' +
      '<div class="why-body">' +
        '<div class="why-signals">' + headline + '</div>' +
        rows.map(function (r) {
          return '<div class="why-row"><span class="why-key">' + r.key + '</span><span class="why-val">' + r.val + '</span></div>';
        }).join('') +
        (signalChips.length ? '<div class="why-row"><span class="why-key">影响信号</span><span class="why-val"><div class="why-signals">' +
          signalChips.join('') + '</div></span></div>' : '') +
        '<div class="why-row"><span class="why-key">后端</span><span class="why-val">' + esc(backendName) +
          '（模型只给概率，是否通过由阈值决定）</span></div>' +
        (it.jevFallbackReason ? '<div class="why-row"><span class="why-key">回落原因</span><span class="why-val">' +
          esc(it.jevFallbackReason) + '</span></div>' : '') +
      '</div></details>';
  }

  function cardHtml(it, mid) {
    var m = srcMeta(it.source);
    var titleInner = maskHtml(it.title);
    var titleHtml = it.url
      ? '<a href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer">' + titleInner + '</a>'
      : titleInner;

    var links = [];
    if (it.url) {
      links.push('<a class="mini-link" href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer">' + svg('i-link', 12) + '打开链接</a>');
      links.push('<button class="mini-link" type="button" data-act="copy" data-mid="' + esc(mid) + '" data-idx="' + it.rank + '">' + svg('i-copy', 12) + '复制</button>');
    }
    links.push('<button class="mini-link" type="button" data-act="kb" data-mid="' + esc(mid) + '" data-idx="' + it.rank + '">' + svg('i-book', 12) + '存入知识库</button>');

    return '<article class="card' + (it.rank === 1 ? ' is-top' : '') + '">' +
      '<div class="card-rank">' + it.rank + '</div>' +
      '<div class="card-main">' +
        '<div class="card-top"><span class="src-badge ' + m.cls + '">' + svg(m.icon, 11) + esc(m.label) + '</span>' +
          aliveBadge(it) +
          (it.passRelaxed ? '<span class="alive-badge">阈值放宽保留</span>' : '') +
          (it.lowConfidence ? '<span class="alive-badge">低置信 · 建议人工复核</span>' : '') +
          '<h3 class="card-title">' + titleHtml + '</h3></div>' +
        '<p class="card-desc">' + maskHtml(it.snippet || '（无摘要）') + '</p>' +
        metaHtml(it) +
        '<div class="card-scores">' +
          bar('匹配度', it.score, 10, 'score', function (v) { return (v == null ? '—' : v.toFixed(1)); }) +
          bar('真伪 p', it.p || 0, 1, 'judge', function (v) { return v.toFixed(2); }) +
          (it.choice ? '<span class="cat-chip">' + esc(it.choice) + '</span>' : '') +
        '</div>' +
        '<div class="card-links">' + links.join('') + '</div>' +
        whyHtml(it) +
      '</div></article>';
  }

  function maskNoticeHtml(result) {
    var detail = result.maskedDetail || [];
    var n = result.stats ? result.stats.masked : 0;
    if (n > 0) {
      return '<div class="mask-notice">' + svg('i-shield', 15) +
        '<span>展示前已自动屏蔽 <b>' + n + '</b> 处敏感信息（在进入判定与页面之前完成）：</span>' +
        '<span class="mask-items">' + detail.map(function (d) {
          return '<span class="mask-tag">' + esc(d.name) + ' × ' + d.count + '</span>';
        }).join('') + '</span></div>';
    }
    return '<div class="mask-notice" style="background:var(--surface-2);border-color:var(--border);color:var(--text-2)">' +
      svg('i-shield', 15) + '<span>已扫描手机号 / 身份证 / 邮箱 / 微信号 / QQ 号，本次未发现需要屏蔽的敏感信息。</span></div>';
  }

  function resultHtml(r, mid) {
    if (r.empty) {
      return '<div class="notice notice-warn">' + svg('i-alert', 15) +
        '<span>' + esc(r.emptyReason || '本次没有拿到可用结果。') + '</span></div>';
    }

    var stats = r.stats || {};
    var head = '<div class="result-head">' +
      '<h3>' + svg('i-cards', 15) + '检索结果 · ' + (r.items || []).length + ' 条通过判定</h3>' +
      '<div class="result-stats">' +
        '<span class="rstat"><b>' + (stats.fetched || 0) + '</b>条候选</span>' +
        '<span class="rstat judge"><b>' + (stats.jevRequests || 0) + '</b>次调用 / <b>' + (stats.jevQuestions || 0) + '</b>个判定</span>' +
        '<span class="rstat ok"><b>' + (stats.avgScore || 0) + '</b>平均匹配</span>' +
        '<span class="rstat"><b>' + fmtMs(stats.ms || 0) + '</b>耗时</span>' +
      '</div></div>' +
      (r.jevBackendLabel ? '<div class="jev-backend-note">' + svg('i-scales', 12) +
        '<span>判定引擎：' + esc(r.jevBackendLabel) + '</span>' +
        (stats.lowConfidence ? '<span class="low-conf">· ' + stats.lowConfidence + ' 条低置信已标注</span>' : '') + '</div>' : '');

    var sum = r.summary || {};
    var summary = '<div class="summary-text">' +
      '<div class="sum-tag">' + svg('i-check', 12) + 'JEV 判定后的摘要（本地模板合成，不编造事实）</div>' +
      '<p>' + esc(sum.lead || '') + '</p>' +
      ((sum.recommends || []).length ? '<ol>' + sum.recommends.map(function (x) {
        return '<li><b>' + esc(x.title) + '</b> — 匹配 ' + (x.score == null ? '—' : x.score.toFixed(1)) +
          ' · 真伪 ' + (x.p == null ? '—' : x.p.toFixed(2)) + ' · ' + esc(x.reason) + '</li>';
      }).join('') + '</ol>' : '') +
      '<p style="margin-top:8px"><b>注意：</b>' + esc((sum.risks || []).join(' ')) + '</p>' +
      '</div>';

    var relaxNote = r.relaxed
      ? '<div class="notice notice-warn">' + svg('i-alert', 15) +
        '<span>当前阈值下没有条目能通过 JEV 判定，已按概率从高到低放宽展示 3 条，并把阈值调低会更宽松。</span></div>'
      : '';

    var blockedNote = (r.blockedDetail && r.blockedDetail.length)
      ? '<div class="notice">' + svg('i-shield', 14) + '<span>硬规则淘汰 ' + (stats.blocked || 0) + ' 条：' +
        r.blockedDetail.map(function (b) { return esc(b.title) + '（' + esc(b.reason) + '）'; }).join('；') + '</span></div>'
      : '';

    var cards = (r.items || []).map(function (it) { return cardHtml(it, mid); }).join('');

    var actions = '<div class="result-actions">' +
      '<button class="mini-link" type="button" data-result-act="export" data-mid="' + esc(mid) + '">' + svg('i-download', 12) + '导出报告</button>' +
      '<button class="mini-link" type="button" data-result-act="copy" data-mid="' + esc(mid) + '">' + svg('i-copy', 12) + '复制摘要</button>' +
      '<button class="mini-link" type="button" data-result-act="retry" data-mid="' + esc(mid) + '">' + svg('i-refresh', 12) + '重新检索</button>' +
      '</div>';

    return '<div class="result-block">' + head + summary + relaxNote +
      maskNoticeHtml(r) + blockedNote +
      '<div class="card-list">' + cards + '</div>' + actions + '</div>';
  }

  /* ---------------- 执行流程 ---------------- */
  function setRunning(on) {
    State.running = on;
    els.btnSend.disabled = on;
    els.input.disabled = on;
  }

  function pushUser(text) {
    var c = ensureChat();
    var msg = { id: C.uid('m'), role: 'user', type: 'text', text: text, at: Date.now() };
    c.messages.push(msg);
    if (c.title === '新对话') { c.title = C.brief(text.replace(/\s+/g, ' '), 18); renderChatList(); }
    els.welcome.classList.add('is-hidden');
    els.messages.appendChild(messageEl(msg));
    saveChats();
    scrollBottom(true);
    return msg;
  }

  function pushAi() {
    var c = ensureChat();
    var msg = { id: C.uid('m'), role: 'ai', type: 'result', at: Date.now(), steps: [], result: null };
    c.messages.push(msg);
    var el = messageEl(msg);
    msg._el = el;
    els.messages.appendChild(el);
    saveChats();
    scrollBottom(true);
    return msg;
  }

  function upsertStep(msg, payload) {
    if (!msg._el) return;
    var list = msg._el.querySelector('.thinking-steps');
    var head = msg._el.querySelector('.thinking-head');
    if (!list) return;
    var st = null;
    for (var i = 0; i < msg.steps.length; i++) if (msg.steps[i].id === payload.id) st = msg.steps[i];
    if (!st) { st = { id: payload.id, label: payload.label, state: payload.state, detail: payload.detail, ms: payload.ms }; msg.steps.push(st); }
    else { st.state = payload.state; st.detail = payload.detail != null ? payload.detail : st.detail; st.ms = payload.ms != null ? payload.ms : st.ms; }

    var row = list.querySelector('[data-step="' + payload.id + '"]');
    if (!row) { row = stepEl(st); list.appendChild(row); }
    row.setAttribute('data-state', st.state);
    row.querySelector('.step-label').textContent = st.label || '';
    var detailEl = row.querySelector('.step-detail');
    if (st.detail) {
      if (!detailEl) {
        detailEl = document.createElement('span');
        detailEl.className = 'step-detail';
        row.children[1].appendChild(detailEl);
      }
      detailEl.textContent = st.detail;
    }
    var metaEl = row.querySelector('.step-meta');
    if (metaEl) metaEl.textContent = st.ms != null ? fmtMs(st.ms) : '';

    if (head) {
      var spin = head.querySelector('.spin');
      if (spin) {
        var pending = msg.steps.some(function (x) { return x.state === 'running'; });
        spin.style.display = pending ? '' : 'none';
      }
      var status = head.querySelector('.th-status');
      if (status) status.textContent = msg.steps.filter(function (x) { return x.state === 'done'; }).length + ' / ' + msg.steps.length + ' 步';
    }
    scrollBottom(false);
  }

  function finishThinking(msg, ok) {
    if (!msg._el) return;
    var head = msg._el.querySelector('.thinking-head');
    if (!head) return;
    var spin = head.querySelector('.spin');
    if (spin) spin.style.display = 'none';
    head.querySelector('.th-title').textContent = ok ? '检索框架执行完成' : '执行中断';
    var status = head.querySelector('.th-status');
    var total = msg.steps.reduce(function (s, x) { return s + (x.ms || 0); }, 0);
    if (status) status.textContent = msg.steps.length + ' 步 · ' + fmtMs(total);

    /* 失败时把还挂着的步骤标成中断，避免界面一直转圈 */
    if (!ok) {
      msg.steps.forEach(function (st) { if (st.state === 'running') st.state = 'error'; });
      Array.prototype.forEach.call(msg._el.querySelectorAll('[data-step]'), function (row) {
        if (row.getAttribute('data-state') === 'running') row.setAttribute('data-state', 'error');
      });
    }
  }

  function runPipeline(demand, opts) {
    opts = opts || {};
    setRunning(true);
    var msg = pushAi();
    var chatRef = ensureChat();

    var runSettings = JSON.parse(JSON.stringify(State.settings));
    if (opts.sources) runSettings.sources = opts.sources;
    if (opts.skipClarify) runSettings.skipClarify = true;

    var previewSources = opts.sources;
    if (previewSources) applySourceChips(previewSources);

    var pendingTimer = null;
    function onEvent(type, payload) {
      if (type === 'step') upsertStep(msg, payload);
      else if (type === 'done') {
        clearTimeout(pendingTimer);
        msg.result = payload;
        finishThinking(msg, true);
        var slot = msg._el.querySelector('.result-slot');
        if (slot) slot.innerHTML = resultHtml(payload, msg.id);
        saveChats();
        setRunning(false);
        if (previewSources) applySourceChips(State.settings.sources);
        scrollBottom(true);
      }
    }

    P.run({
      demand: demand,
      settings: runSettings,
      onEvent: onEvent,
      onProgress: function (p) {
        /* ONNX 模型首次下载时给出可见进度，否则用户会以为卡死 */
        if (!p) return;
        setHint(p.progress != null ? ('正在下载模型 ' + p.progress + '% · ' + (p.file || '')) : (p.status || '正在加载模型…'));
      }
    }).catch(function (err) {
      setHint(null);
      finishThinking(msg, false);
      msg.type = 'result';
      msg.result = { empty: true, emptyReason: '这次没跑通：' + (err && err.message ? err.message : String(err)) + '。可以换个说法或检查检索设置后重试。' };
      var slot = msg._el.querySelector('.result-slot');
      if (slot) slot.innerHTML = resultHtml(msg.result, msg.id);
      saveChats();
      setRunning(false);
      if (previewSources) applySourceChips(State.settings.sources);
      toast('检索失败：' + (err && err.message ? err.message : String(err)), 'err');
    });
  }

  /* 输入框下方的临时提示（模型加载进度 / 恢复默认文案） */
  function setHint(text) {
    if (!els.clarifyHint) return;
    if (text) {
      els.clarifyHint.textContent = text;
      els.clarifyHint.style.color = 'var(--judge)';
    } else {
      els.clarifyHint.textContent = '问得越具体，JEV 判定越准';
      els.clarifyHint.style.color = '';
    }
  }

  /* ---------------- 发送 / 追问 ---------------- */
  function handleSend(text, opts) {
    opts = opts || {};
    text = String(text || '').trim();
    if (!text) return;
    if (State.running) { toast('上一轮还在检索中，稍等一下', 'info'); return; }

    els.welcome.classList.add('is-hidden');
    pushUser(text);

    var need = opts.skipClarify ? { need: false } : P.needsClarify(text, State.settings);
    if (need.need) {
      var c = ensureChat();
      var msg = {
        id: C.uid('m'), role: 'ai', type: 'clarify', at: Date.now(),
        text: need.question,
        clarify: { baseDemand: text, options: need.options, answered: false }
      };
      c.messages.push(msg);
      var el = messageEl(msg);
      msg._el = el;
      els.messages.appendChild(el);
      saveChats();
      scrollBottom(true);
      return;
    }
    runPipeline(text, { sources: opts.sources });
  }

  function onClarifyClick(mid, idx) {
    var c = ensureChat();
    var msg = null;
    c.messages.forEach(function (m) { if (m.id === mid) msg = m; });
    if (!msg || !msg.clarify || msg.clarify.answered) return;
    var option = msg.clarify.options[idx];
    if (!option) return;
    msg.clarify.answered = true;
    var chips = msg._el ? msg._el.querySelector('.chips') : null;
    if (chips) chips.remove();

    var userText = option.label + (option.append ? '：' + option.append : '');
    pushUser(userText);
    var combined = option.append ? (msg.clarify.baseDemand + ' ' + option.append) : msg.clarify.baseDemand;
    runPipeline(combined, { sources: option.sources || null, skipClarify: true });
  }

  /* ---------------- 欢迎页 / 示例 ---------------- */
  function renderStarters() {
    els.starterGrid.innerHTML = DATA.STARTERS.map(function (s, i) {
      return '<button class="starter" type="button" data-starter="' + i + '">' +
        '<b>' + svg(s.icon, 14) + esc(s.title) + '</b>' +
        '<span>' + esc(s.desc) + '</span></button>';
    }).join('');
  }

  /* ---------------- 数据源 chips ---------------- */
  function applySourceChips(sources) {
    Array.prototype.forEach.call(els.sourceChips.querySelectorAll('[data-src]'), function (btn) {
      var key = btn.getAttribute('data-src');
      btn.classList.toggle('is-on', !!(sources && sources[key]));
    });
  }

  function bindSourceChips() {
    els.sourceChips.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-src]');
      if (!btn) return;
      var key = btn.getAttribute('data-src');
      var s = JSON.parse(JSON.stringify(State.settings.sources));
      s[key] = !s[key];
      if (!s.github && !s.web && !s.pan && !s.kb) { toast('至少要保留一个数据源', 'err'); return; }
      State.settings.sources = s;
      C.Settings.save({ sources: s });
      applySourceChips(s);
      syncSettingsUI();
    });
  }

  /* ---------------- 输入框 ---------------- */
  function autoGrow() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 148) + 'px';
  }

  function bindComposer() {
    els.input.addEventListener('input', function () {
      autoGrow();
      var n = els.input.value.length;
      els.charCount.textContent = n > 0 ? n + ' / 2000' : '';
    });
    els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submitInput();
      }
    });
    els.btnSend.addEventListener('click', submitInput);
  }

  function submitInput() {
    var text = els.input.value.trim();
    if (!text || State.running) return;
    els.input.value = '';
    autoGrow();
    els.charCount.textContent = '';
    handleSend(text, {});
  }

  /* ---------------- 设置面板 ---------------- */
  var BACKEND_HINTS = {
    local: '本地启发式：用可解释规则近似 JEV 三原语，离线、确定性、结果可复现。适合第一次上课与流程验证，但不是真实模型推理。',
    onnx: '浏览器 ONNX：把开源 local-jev 的实现搬进页面 —— 用 NLI 零样本模型在本地跑 noul/choice/score，零 API Key、数据不出浏览器。首次需下载模型。',
    remote: '经本地零依赖代理访问真实 JEV：可接 ollaya（本地开源守护进程，wire-identical 于 TypeSafe）、TypeSafe 官方 API，或任意 OpenAI 兼容 / passthrough 服务。Key 只在服务端。'
  };

  var BACKEND_BADGE = { local: 'JEV · 本地模拟', onnx: 'JEV · 浏览器 ONNX', remote: 'JEV · 本地服务/官方' };

  function syncSettingsUI() {
    var s = State.settings;
    setSegActive(els.setMode, 'mode', s.mode);
    $('srcGithub').checked = !!s.sources.github;
    $('srcWeb').checked = !!s.sources.web;
    $('srcPan').checked = !!s.sources.pan;
    $('srcKb').checked = !!s.sources.kb;
    $('setThreshold').value = s.threshold;
    $('thresholdVal').textContent = Number(s.threshold).toFixed(2);
    $('setJevBackend').value = s.jevBackend;
    $('jevBackendHint').textContent = BACKEND_HINTS[s.jevBackend] || BACKEND_HINTS.local;
    $('jevRemoteField').classList.toggle('is-hidden', s.jevBackend !== 'remote');
    $('jevOnnxField').classList.toggle('is-hidden', s.jevBackend !== 'onnx');
    $('setJevEndpoint').value = s.jevEndpoint || '';
    var oc = s.onnx || {};
    $('setOnnxModel').value = oc.model || '';
    $('setOnnxDtype').value = oc.dtype || 'q8';
    $('setOnnxSource').value = oc.modelSource || 'huggingface';
    renderOnnxStatus();
    $('maskPhone').checked = !!s.mask.phone;
    $('maskId').checked = !!s.mask.id;
    $('maskEmail').checked = !!s.mask.email;
    $('maskWechat').checked = !!s.mask.wechat;
    $('onlyHttps').checked = s.onlyHttps !== false;
    $('setSkipClarify').checked = !!s.skipClarify;
    setSegActive($('promptClickMode'), 'click', s.promptClick || 'send');
    applySourceChips(s.sources);
  }

  function renderOnnxStatus() {
    var out = $('onnxStatus');
    if (!out) return;
    var st = JEV.onnxStatus ? JEV.onnxStatus() : { loaded: false };
    if (st.loading) {
      out.className = 'test-result';
      out.textContent = '加载中 ' + (st.progress && st.progress.progress != null ? st.progress.progress + '%' : '…');
    } else if (st.loaded) {
      out.className = 'test-result ok';
      out.textContent = '已加载 · ' + st.device + (st.deviceFallback ? '（已回退）' : '') + ' · ' + st.model;
    } else if (st.failed) {
      out.className = 'test-result err';
      out.textContent = '加载失败：' + C.brief(st.error || '', 40);
    } else {
      out.className = 'test-result';
      out.textContent = '未加载';
    }
  }

  function setSegActive(container, key, value) {
    if (!container) return;
    Array.prototype.forEach.call(container.querySelectorAll('[data-' + key + ']'), function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-' + key) === value);
    });
  }

  function bindSettings() {
    els.setMode.addEventListener('click', function (e) {
      var b = e.target.closest('[data-mode]');
      if (!b) return;
      var mode = b.getAttribute('data-mode');
      State.settings.mode = mode;
      C.Settings.save({ mode: mode });
      setSegActive(els.setMode, 'mode', mode);
      updateBadges();
      toast(mode === 'live' ? '已切到实时检索：GitHub 会真的发请求' : '已切到演示数据：不联网、结果可控', 'ok');
    });

    ['srcGithub', 'srcWeb', 'srcPan', 'srcKb'].forEach(function (id) {
      var key = { srcGithub: 'github', srcWeb: 'web', srcPan: 'pan', srcKb: 'kb' }[id];
      $(id).addEventListener('change', function () {
        var s = JSON.parse(JSON.stringify(State.settings.sources));
        s[key] = $(id).checked;
        if (!s.github && !s.web && !s.pan && !s.kb) {
          $(id).checked = true;
          toast('至少要保留一个数据源', 'err');
          return;
        }
        State.settings.sources = s;
        C.Settings.save({ sources: s });
        applySourceChips(s);
      });
    });

    $('setThreshold').addEventListener('input', function () {
      var v = Number(this.value);
      $('thresholdVal').textContent = v.toFixed(2);
      State.settings.threshold = v;
      C.Settings.save({ threshold: v });
    });

    $('setJevBackend').addEventListener('change', function () {
      var v = this.value;
      State.settings.jevBackend = v;
      C.Settings.save({ jevBackend: v });
      $('jevRemoteField').classList.toggle('is-hidden', v !== 'remote');
      $('jevOnnxField').classList.toggle('is-hidden', v !== 'onnx');
      $('jevBackendHint').textContent = BACKEND_HINTS[v] || BACKEND_HINTS.local;
      updateBadges();
      if (v === 'onnx') toast('已切到浏览器 ONNX：首次检索会下载模型（约 200–300MB）', 'info');
      else if (v === 'remote') toast('已切到真实 JEV 服务：本地开源服务或官方 API，失败会自动回落', 'info');
      else toast('已切回本地启发式判定', 'ok');
    });

    $('setJevEndpoint').addEventListener('change', function () {
      var v = this.value.trim();
      State.settings.jevEndpoint = v;
      C.Settings.save({ jevEndpoint: v });
    });

    $('setOnnxModel').addEventListener('change', function () {
      var oc = JSON.parse(JSON.stringify(State.settings.onnx || {}));
      oc.model = this.value.trim();
      State.settings.onnx = oc;
      C.Settings.save({ onnx: oc });
    });
    $('setOnnxDtype').addEventListener('change', function () {
      var oc = JSON.parse(JSON.stringify(State.settings.onnx || {}));
      oc.dtype = this.value;
      State.settings.onnx = oc;
      C.Settings.save({ onnx: oc });
    });
    $('setOnnxSource').addEventListener('change', function () {
      var oc = JSON.parse(JSON.stringify(State.settings.onnx || {}));
      oc.modelSource = this.value;
      State.settings.onnx = oc;
      C.Settings.save({ onnx: oc });
    });

    $('btnLoadOnnx').addEventListener('click', function () {
      var out = $('onnxStatus');
      out.className = 'test-result';
      out.textContent = '准备加载…';
      JEV.loadOnnx(null, function (p) {
        out.className = 'test-result';
        out.textContent = p.progress != null ? ('下载 ' + p.progress + '% · ' + C.brief(p.file || '', 24)) : (p.status || '加载中…');
      }).then(function (st) {
        renderOnnxStatus();
        toast('模型已就绪：' + st.device + ' · ' + C.brief(st.model, 32), 'ok');
      }).catch(function (e) {
        renderOnnxStatus();
        out.className = 'test-result err';
        out.textContent = '加载失败：' + C.brief((e && e.message) || String(e), 50);
        toast('模型加载失败：' + ((e && e.message) || e) + '（可换 hf-mirror 源或检查网络）', 'err');
      });
    });

    $('btnTestJev').addEventListener('click', function () {
      var out = $('jevTestResult');
      out.className = 'test-result';
      out.textContent = '测试中…';
      State.settings.jevEndpoint = $('setJevEndpoint').value.trim();
      C.Settings.save({ jevEndpoint: State.settings.jevEndpoint });

      if (State.settings.jevBackend === 'onnx') {
        JEV.health().then(function (r) {
          out.className = 'test-result ' + (r.ok ? 'ok' : 'err');
          out.textContent = r.ok ? r.detail : ('模型未加载：' + (r.detail || ''));
        });
        return;
      }
      JEV.health().then(function (r) {
        if (r.ok) {
          out.className = 'test-result ok';
          out.textContent = '连接成功 · ' + (r.detail || 'JEV 服务');
        } else {
          out.className = 'test-result err';
          out.textContent = '连接失败：' + r.error;
        }
      });
    });

    [['maskPhone', 'phone'], ['maskId', 'id'], ['maskEmail', 'email'], ['maskWechat', 'wechat']].forEach(function (pair) {
      $(pair[0]).addEventListener('change', function () {
        var m = JSON.parse(JSON.stringify(State.settings.mask));
        m[pair[1]] = $(pair[0]).checked;
        State.settings.mask = m;
        C.Settings.save({ mask: m });
      });
    });

    $('onlyHttps').addEventListener('change', function () {
      State.settings.onlyHttps = this.checked;
      C.Settings.save({ onlyHttps: this.checked });
    });

    $('setSkipClarify').addEventListener('change', function () {
      State.settings.skipClarify = this.checked;
      C.Settings.save({ skipClarify: this.checked });
    });

    $('btnResetSettings').addEventListener('click', function () {
      State.settings = C.Settings.reset();
      syncSettingsUI();
      updateBadges();
      applyTheme();
      toast('已恢复默认设置', 'ok');
    });
  }

  /* ---------------- 顶栏 / 主题 ---------------- */
  function updateBadges() {
    var s = State.settings;
    $('badgeModeText').textContent = s.mode === 'live' ? '实时检索' : '演示数据';
    els.badgeMode.classList.toggle('is-live', s.mode === 'live');

    var remote = s.jevBackend === 'remote';
    $('badgeJevText').textContent = BACKEND_BADGE[s.jevBackend] || BACKEND_BADGE.local;
    els.badgeJev.classList.toggle('is-live', remote || s.jevBackend === 'onnx');

    var st = KB.stats();
    $('badgeKbText').textContent = '知识库 ' + st.count + ' 个 · ' + st.docs + ' 条';
  }

  function applyTheme() {
    var t = State.settings.theme || 'light';
    document.documentElement.setAttribute('data-theme', t);
  }

  function bindTopbar() {
    els.badgeMode.addEventListener('click', function () {
      var next = State.settings.mode === 'live' ? 'demo' : 'live';
      State.settings.mode = next;
      C.Settings.save({ mode: next });
      syncSettingsUI();
      updateBadges();
      toast(next === 'live' ? '已切到实时检索：GitHub 会真的发请求' : '已切到演示数据：不联网', 'ok');
    });

    els.badgeJev.addEventListener('click', function () {
      switchPanelTab('settings');
      openPanel();
    });

    els.badgeKb.addEventListener('click', openKbManager);

    $('btnTheme').addEventListener('click', function () {
      var next = State.settings.theme === 'dark' ? 'light' : 'dark';
      State.settings.theme = next;
      C.Settings.save({ theme: next });
      applyTheme();
    });

    $('btnHelp').addEventListener('click', openHelp);
    $('btnPanelToggle').addEventListener('click', function () { togglePanel(); });
    $('btnPanelClose').addEventListener('click', function () { closePanel(); });
    $('btnSidebarToggle').addEventListener('click', function () {
      els.sidebar.classList.toggle('is-open');
    });
  }

  function openPanel() {
    els.panel.classList.add('is-open');
  }
  function closePanel() {
    els.panel.classList.remove('is-open');
  }
  function togglePanel() {
    els.panel.classList.toggle('is-open');
  }

  function switchPanelTab(tab) {
    Array.prototype.forEach.call(els.panelTabs.querySelectorAll('[data-tab]'), function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-tab') === tab);
    });
    ['prompts', 'settings', 'learn'].forEach(function (k) {
      $('tab' + k.charAt(0).toUpperCase() + k.slice(1)).classList.toggle('is-hidden', k !== tab);
    });
  }

  /* ---------------- 右侧提示词 ---------------- */
  function renderPrompts() {
    PromptLib.render(els.promptGroups, {
      onUse: usePrompt,
      onCopy: function (item) { copyText(item.prompt); },
      onEdit: editPrompt,
      onDelete: function (item) {
        PromptLib.removeCustom(item.id);
        renderPrompts();
        toast('已删除自定义提示词', 'ok');
      }
    });
  }

  function usePrompt(item) {
    var mode = State.settings.promptClick || 'send';
    if (mode === 'fill') {
      els.input.value = item.prompt;
      autoGrow();
      els.charCount.textContent = els.input.value.length + ' / 2000';
      els.input.focus();
      toast('已填入输入框，可以改完再发送', 'ok');
      return;
    }
    handleSend(item.prompt, {});
    if (window.innerWidth <= 1240) closePanel();
  }

  function editPrompt(item) {
    openModal('编辑提示词', '' +
      '<div class="form-row"><label>标题</label><input type="text" id="ppTitle" value="' + esc(item.title) + '"></div>' +
      '<div class="form-row"><label>说明</label><input type="text" id="ppDesc" value="' + esc(item.desc || '') + '"></div>' +
      '<div class="form-row"><label>提示词内容</label><textarea id="ppPrompt" rows="5">' + esc(item.prompt) + '</textarea></div>' +
      '<div class="form-actions"><button class="btn btn-ghost" data-modal-close>取消</button>' +
      '<button class="btn btn-primary" id="ppSave">保存</button></div>');

    $('ppSave').addEventListener('click', function () {
      var title = $('ppTitle').value.trim();
      var prompt = $('ppPrompt').value.trim();
      if (!title || !prompt) { toast('标题和内容都要填', 'err'); return; }
      PromptLib.saveCustom({
        id: item.custom ? item.id : C.uid('p'),
        title: title, desc: $('ppDesc').value.trim(), prompt: prompt,
        tag: '自定义', custom: true
      });
      closeModal();
      renderPrompts();
      toast('提示词已保存', 'ok');
    });
  }

  function addPrompt() {
    openModal('新建自定义提示词', '' +
      '<div class="form-row"><label>标题</label><input type="text" id="ppTitle" placeholder="例如：找带中文文档的仓库"></div>' +
      '<div class="form-row"><label>说明</label><input type="text" id="ppDesc" placeholder="一句话说明它解决什么问题"></div>' +
      '<div class="form-row"><label>提示词内容</label><textarea id="ppPrompt" rows="5" placeholder="把要检索的需求写成一句明确的话"></textarea></div>' +
      '<div class="form-actions"><button class="btn btn-ghost" data-modal-close>取消</button>' +
      '<button class="btn btn-primary" id="ppSave">保存</button></div>');

    $('ppSave').addEventListener('click', function () {
      var title = $('ppTitle').value.trim();
      var prompt = $('ppPrompt').value.trim();
      if (!title || !prompt) { toast('标题和内容都要填', 'err'); return; }
      PromptLib.saveCustom({ title: title, desc: $('ppDesc').value.trim(), prompt: prompt, tag: '自定义', custom: true });
      closeModal();
      renderPrompts();
      toast('提示词已保存，点一下就能用', 'ok');
    });
  }

  /* ---------------- 知识库 ---------------- */
  function renderKbList() {
    var list = KB.list();
    els.kbList.innerHTML = list.map(function (kb) {
      return '<div class="kb-item" data-kbid="' + esc(kb.id) + '" title="' + esc(kb.desc || '') + '">' +
        '<span class="kb-dot"></span><span class="ci-title">' + esc(kb.name) + '</span>' +
        '<span class="kb-count">' + kb.docs.length + '</span></div>';
    }).join('') || '<div class="kb-empty" style="padding:8px 6px">还没有知识库</div>';
    updateBadges();
  }

  function openKbManager() {
    State.modalKb = null;
    renderKbModal();
    openModal('知识库管理', '');
    els.modalBody.innerHTML = kbManagerHtml();
  }

  function kbManagerHtml(openId) {
    var list = KB.list();
    var total = KB.stats();
    var html = '<div class="notice">' + svg('i-shield', 14) +
      '<span>知识库只存在你的浏览器本地（localStorage），不上传任何服务器。共 ' + total.count + ' 个库、' + total.docs + ' 条内容。</span></div>';

    html += '<div class="form-actions" style="justify-content:flex-start">' +
      '<button class="btn btn-primary btn-sm" id="kbCreateBtn">' + svg('i-plus', 14) + '新建知识库</button></div>';

    html += list.map(function (kb) {
      var open = openId === kb.id;
      var docs = '';
      if (open) {
        docs = '<div style="display:flex;flex-direction:column;gap:7px;margin-top:8px">' +
          (kb.docs.length ? kb.docs.map(function (doc, i) {
            return '<div class="kb-doc"><div class="kb-doc-main">' +
              '<div class="kb-doc-title">' + esc(doc.t) + '</div>' +
              '<div class="kb-doc-text">' + maskHtml(doc.d) + '</div>' +
              '<div class="kb-doc-meta">' + esc((doc.m && doc.m.doc) || kb.name) + '</div></div>' +
              '<button class="icon-btn icon-btn-sm" data-kb-del-doc="' + esc(kb.id) + '" data-doc-idx="' + i + '" title="删除条目">' + svg('i-trash', 14) + '</button></div>';
          }).join('') : '<div class="kb-empty">这个库还是空的，添加一条试试</div>') +
          '<div class="form-row"><label>新增条目</label>' +
          '<input type="text" id="kdTitle_' + esc(kb.id) + '" placeholder="标题，例如：第 6 课：阈值怎么调">' +
          '<textarea id="kdText_' + esc(kb.id) + '" rows="3" placeholder="内容：一段可以直接被检索到的话"></textarea>' +
          '</div><div class="form-actions" style="justify-content:flex-start">' +
          '<button class="btn btn-primary btn-sm" data-kb-add-doc="' + esc(kb.id) + '">保存条目</button></div></div>';
      }
      return '<div class="kb-row" style="flex-direction:column;align-items:stretch">' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<div class="kb-row-main"><div class="kb-row-name">' + esc(kb.name) +
            '<span class="mask-tag">' + kb.docs.length + ' 条</span></div>' +
            '<div class="kb-row-desc">' + esc(kb.desc || '') + '</div></div>' +
          '<div class="kb-row-act">' +
            '<button class="btn btn-ghost btn-sm" data-kb-toggle="' + esc(kb.id) + '">' + (open ? '收起' : '查看 / 编辑') + '</button>' +
            '<button class="icon-btn icon-btn-sm" data-kb-remove="' + esc(kb.id) + '" title="删除知识库">' + svg('i-trash', 15) + '</button>' +
          '</div>' +
        '</div>' + docs + '</div>';
    }).join('');

    return html;
  }

  function renderKbModal() {
    if (!els.modalBackdrop.classList.contains('is-hidden') && els.modalTitle.textContent === '知识库管理') {
      els.modalBody.innerHTML = kbManagerHtml(State.modalKb);
    }
  }

  function bindKbModalEvents() {
    els.modalBody.addEventListener('click', function (e) {
      var t = e.target;

      if (t.closest('#kbCreateBtn')) {
        openModal('新建知识库', '' +
          '<div class="form-row"><label>名称</label><input type="text" id="kbName" placeholder="例如：我的课程资料"></div>' +
          '<div class="form-row"><label>说明（可选）</label><input type="text" id="kbDesc" placeholder="这个库存什么"></div>' +
          '<div class="form-actions"><button class="btn btn-ghost" data-modal-close>取消</button>' +
          '<button class="btn btn-primary" id="kbCreateSave">创建</button></div>');
        $('kbCreateSave').addEventListener('click', function () {
          var r = KB.create($('kbName').value, $('kbDesc').value);
          if (!r.ok) { toast(r.error, 'err'); return; }
          renderKbList();
          openKbManager();
          toast('知识库已创建', 'ok');
        });
        return;
      }

      var toggle = t.closest('[data-kb-toggle]');
      if (toggle) {
        var id = toggle.getAttribute('data-kb-toggle');
        State.modalKb = State.modalKb === id ? null : id;
        els.modalBody.innerHTML = kbManagerHtml(State.modalKb);
        return;
      }

      var remove = t.closest('[data-kb-remove]');
      if (remove) {
        var rid = remove.getAttribute('data-kb-remove');
        var kb = KB.get(rid);
        if (!kb) return;
        if (!global.confirm('删除知识库「' + kb.name + '」？里面的 ' + kb.docs.length + ' 条内容会一起删除。')) return;
        KB.remove(rid);
        if (State.modalKb === rid) State.modalKb = null;
        els.modalBody.innerHTML = kbManagerHtml(State.modalKb);
        renderKbList();
        toast('已删除知识库', 'ok');
        return;
      }

      var addDocBtn = t.closest('[data-kb-add-doc]');
      if (addDocBtn) {
        var kid = addDocBtn.getAttribute('data-kb-add-doc');
        var titleEl = $('kdTitle_' + kid);
        var textEl = $('kdText_' + kid);
        var r2 = KB.addDoc(kid, { t: titleEl ? titleEl.value : '', d: textEl ? textEl.value : '' });
        if (!r2.ok) { toast(r2.error, 'err'); return; }
        els.modalBody.innerHTML = kbManagerHtml(kid);
        renderKbList();
        toast('条目已保存到「' + (KB.get(kid) || {}).name + '」', 'ok');
        return;
      }

      var delDoc = t.closest('[data-kb-del-doc]');
      if (delDoc) {
        var did = delDoc.getAttribute('data-kb-del-doc');
        var idx = Number(delDoc.getAttribute('data-doc-idx'));
        KB.removeDoc(did, idx);
        els.modalBody.innerHTML = kbManagerHtml(did);
        renderKbList();
        toast('条目已删除', 'ok');
        return;
      }

      if (t.closest('[data-modal-close]')) closeModal();

      var pick = t.closest('[data-kb-pick]');
      if (pick) { pickIntoKb(pick.getAttribute('data-kb-pick')); return; }
    });
  }

  /* 把检索结果存进知识库：只记录待入库条目，点击由 bindKbModalEvents 统一处理 */
  function openKbPicker(item) {
    State.kbPickItem = item;
    var list = KB.list();
    openModal('存入知识库', '' +
      '<div class="notice">' + svg('i-book', 14) + '<span>标题：' + esc(item.title) + '</span></div>' +
      list.map(function (kb) {
        return '<div class="kb-row"><div class="kb-row-main">' +
          '<div class="kb-row-name">' + esc(kb.name) + '</div>' +
          '<div class="kb-row-desc">' + kb.docs.length + ' 条 · ' + esc(kb.desc || '') + '</div></div>' +
          '<button class="btn btn-ghost btn-sm" data-kb-pick="' + esc(kb.id) + '">存到这里</button></div>';
      }).join('') +
      '<div class="form-actions"><button class="btn btn-ghost" data-modal-close>关闭</button></div>');
  }

  function pickIntoKb(kbId) {
    var item = State.kbPickItem;
    if (!item) return;
    var text = item.snippet || item.title;
    if (item.maskedCount) text += '（原条目含 ' + item.maskedCount + ' 处敏感信息，已脱敏后入库）';
    var r = KB.addDoc(kbId, {
      t: item.title,
      d: text,
      m: { doc: '来自' + ((DATA.SOURCE_META[item.source] || {}).label || '') + '检索 · ' + timeOf(Date.now()) }
    });
    if (r.ok) {
      State.kbPickItem = null;
      renderKbList();
      closeModal();
      toast('已存入「' + (KB.get(kbId) || {}).name + '」，下次检索会用到', 'ok');
    } else {
      toast(r.error, 'err');
    }
  }

  /* ---------------- 弹层 / 帮助 ---------------- */
  function openModal(title, bodyHtml) {
    els.modalTitle.textContent = title;
    els.modalBody.innerHTML = bodyHtml || '';
    els.modalBackdrop.classList.remove('is-hidden');
    els.modalBody.scrollTop = 0;
  }

  function closeModal() {
    els.modalBackdrop.classList.add('is-hidden');
    els.modalBody.innerHTML = '';
  }

  function openHelp() {
    openModal('怎么用这个工作台', '' +
      '<div class="help-block">' +
      '<h3>三步上手</h3>' +
      '<ol>' +
      '<li>在下方输入框写一句需求，或者点右侧「提示词」里的任意模板。</li>' +
      '<li>看左侧对话里的「思考过程」展开：每条信息被怎么判定、为什么留、为什么删。</li>' +
      '<li>点结果卡片下方的小链接直接跳转；觉得有用就「存入知识库」，下次检索会优先用上。</li>' +
      '</ol>' +
      '<h3>三种 JEV 判定分别在看什么</h3>' +
      '<ul>' +
      '<li><b>noul 真伪</b>：这条信息是否真实存在、可访问。低于阈值直接筛掉。</li>' +
      '<li><b>score 匹配</b>：和你的需求有多相关，2-10 分，决定排序。</li>' +
      '<li><b>choice 分类</b>：它属于教程 / 代码库 / 资源合集中的哪一类。</li>' +
      '</ul>' +
      '<h3>数据来源怎么说清楚</h3>' +
      '<p>顶栏徽章会写明当前是「演示数据」还是「实时检索」。演示数据不联网、结果可控，用于课堂演示；实时检索会真的请求 GitHub 公开接口，其它平台因没有公开可跨域的搜索接口，仍以演示数据呈现，并在结果摘要里明确标注。</p>' +
      '<h3>脱敏怎么工作</h3>' +
      '<p>手机号、身份证号、邮箱、微信号、QQ 号在<strong>本地规则</strong>里就被替换成「［已屏蔽］」，然后才参与判定与展示。每次结果都会告诉你屏蔽了几处。</p>' +
      '<h3>快捷键</h3>' +
      '<p><span class="help-kbd">Enter</span> 发送 · <span class="help-kbd">Shift</span> + <span class="help-kbd">Enter</span> 换行 · 点击右上角图标可收起右侧面板。</p>' +
      '</div>');
  }

  function bindModal() {
    $('btnModalClose').addEventListener('click', closeModal);
    els.modalBackdrop.addEventListener('click', function (e) {
      if (e.target === els.modalBackdrop) closeModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!els.modalBackdrop.classList.contains('is-hidden')) closeModal();
        else if (els.panel.classList.contains('is-open') && window.innerWidth <= 1240) closePanel();
      }
    });
  }

  /* ---------------- 线程内事件（委托） ---------------- */
  function findMessage(mid) {
    var c = chat();
    if (!c) return null;
    var found = null;
    c.messages.forEach(function (m) { if (m.id === mid) found = m; });
    return found;
  }

  function findItem(mid, rank) {
    var m = findMessage(mid);
    if (!m || !m.result || !m.result.items) return null;
    var found = null;
    m.result.items.forEach(function (it) { if (it.rank === Number(rank)) found = it; });
    return found;
  }

  function bindThread() {
    els.messages.addEventListener('click', function (e) {
      var head = e.target.closest('.thinking-head');
      if (head) {
        head.parentElement.classList.toggle('is-open');
        return;
      }

      var chip = e.target.closest('[data-clarify]');
      if (chip) {
        var cmid = chip.closest('.msg').getAttribute('data-mid');
        onClarifyClick(cmid, Number(chip.getAttribute('data-clarify')));
        return;
      }

      var act = e.target.closest('[data-act]');
      if (act) {
        var mid2 = act.getAttribute('data-mid');
        var idx = act.getAttribute('data-idx');
        var item = findItem(mid2, idx);
        if (!item) return;
        if (act.getAttribute('data-act') === 'copy') copyText(item.url);
        if (act.getAttribute('data-act') === 'kb') openKbPicker(item);
        return;
      }

      var ract = e.target.closest('[data-result-act]');
      if (ract) {
        var rmid = ract.getAttribute('data-mid');
        var msg = findMessage(rmid);
        if (!msg || !msg.result) return;
        var kind = ract.getAttribute('data-result-act');
        if (kind === 'copy') {
          var r = msg.result;
          var text = (r.summary ? r.summary.lead + '\n\n' : '') + (r.items || []).map(function (it, i) {
            return (i + 1) + '. ' + it.title + '（匹配 ' + (it.score || 0).toFixed(1) + '，真伪 ' + (it.p || 0).toFixed(2) + '）' + (it.url ? '\n   ' + it.url : '');
          }).join('\n');
          copyText(text);
        } else if (kind === 'export') {
          exportReport(msg.result);
        } else if (kind === 'retry') {
          runPipeline(msg.result.demand || '', {});
        }
        return;
      }

      var starter = e.target.closest('[data-starter]');
      if (starter) {
        var s = DATA.STARTERS[Number(starter.getAttribute('data-starter'))];
        if (!s) return;
        handleSend(s.demand, { sources: extendSources(s.sources) });
        return;
      }
    });

    els.starterGrid.addEventListener('click', function (e) {
      var starter = e.target.closest('[data-starter]');
      if (!starter) return;
      var s = DATA.STARTERS[Number(starter.getAttribute('data-starter'))];
      if (!s) return;
      handleSend(s.demand, { sources: extendSources(s.sources) });
    });
  }

  /* 示例卡片声明了自己的数据源偏好：未列出的保持用户原设置，避免"越点越少" */
  function extendSources(list) {
    var base = JSON.parse(JSON.stringify(State.settings.sources));
    var out = { github: false, web: false, pan: false, kb: false };
    (list || []).forEach(function (k) { out[k] = true; });
    /* 知识库默认参与（自建内容成本最低，也最能压幻觉） */
    if (base.kb) out.kb = true;
    if (!out.github && !out.web && !out.pan && !out.kb) return null;
    return out;
  }

  function bindSidebar() {
    els.btnNewChat.addEventListener('click', function () { newChat(); });
    els.btnNewKb.addEventListener('click', function () {
      openModal('新建知识库', '' +
        '<div class="form-row"><label>名称</label><input type="text" id="kbName" placeholder="例如：我的课程资料"></div>' +
        '<div class="form-row"><label>说明（可选）</label><input type="text" id="kbDesc" placeholder="这个库存什么"></div>' +
        '<div class="form-actions"><button class="btn btn-ghost" data-modal-close>取消</button>' +
        '<button class="btn btn-primary" id="kbCreateSave">创建</button></div>');
      $('kbCreateSave').addEventListener('click', function () {
        var r = KB.create($('kbName').value, $('kbDesc').value);
        if (!r.ok) { toast(r.error, 'err'); return; }
        closeModal();
        renderKbList();
        toast('知识库已创建', 'ok');
      });
    });
    els.btnKbManager.addEventListener('click', openKbManager);

    els.chatList.addEventListener('click', function (e) {
      var del = e.target.closest('[data-del-cid]');
      if (del) {
        var cid = del.getAttribute('data-del-cid');
        State.chats = State.chats.filter(function (c) { return c.id !== cid; });
        if (State.currentId === cid) {
          if (State.chats.length) State.currentId = State.chats[0].id;
          else newChat(true);
        }
        saveChats();
        renderChatList();
        renderThread();
        toast('会话已删除', 'ok');
        return;
      }
      var item = e.target.closest('[data-cid]');
      if (!item) return;
      State.currentId = item.getAttribute('data-cid');
      renderChatList();
      renderThread();
      if (window.innerWidth <= 980) els.sidebar.classList.remove('is-open');
    });

    els.kbList.addEventListener('click', function (e) {
      var item = e.target.closest('[data-kbid]');
      if (!item) return;
      var kb = KB.get(item.getAttribute('data-kbid'));
      if (!kb) return;
      els.input.value = '根据我的知识库「' + kb.name + '」，';
      autoGrow();
      els.input.focus();
      toast('已把知识库写进输入框，接着说完需求就好', 'ok');
    });
  }

  /* ---------------- 导出 / 复制 ---------------- */
  function copyText(text) {
    text = String(text || '');
    if (!text) return;
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('已复制到剪贴板', 'ok'); }
      catch (e) { toast('复制失败，请手动选择文本', 'err'); }
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制到剪贴板', 'ok'); }, fallback);
    } else fallback();
  }

  function exportReport(result) {
    var lines = [];
    lines.push('# 检索报告：' + result.demand);
    lines.push('');
    lines.push('生成时间：' + new Date().toLocaleString('zh-CN'));
    lines.push('数据模式：' + (result.simulated ? '含演示数据' : '实时数据') + ' · JEV 后端：' + (result.jevBackend || 'local'));
    lines.push('');
    lines.push('## 摘要');
    lines.push(result.summary ? result.summary.lead : '');
    if (result.summary && result.summary.recommends) {
      result.summary.recommends.forEach(function (x, i) {
        lines.push((i + 1) + '. ' + x.title + ' —— 匹配 ' + (x.score || 0).toFixed(1) + '，真伪 ' + (x.p || 0).toFixed(2) + '，' + x.reason);
      });
    }
    lines.push('');
    lines.push('## 注意事项');
    (result.summary && result.summary.risks ? result.summary.risks : []).forEach(function (r) { lines.push('- ' + r); });
    lines.push('');
    lines.push('## 结果明细');
    (result.items || []).forEach(function (it) {
      lines.push('### ' + it.rank + '. ' + it.title);
      lines.push('- 来源：' + ((DATA.SOURCE_META[it.source] || {}).label || it.source));
      if (it.url) lines.push('- 链接：' + it.url);
      lines.push('- 匹配度：' + (it.score == null ? '—' : it.score.toFixed(1)) + ' / 10 · 真伪 p：' + (it.p == null ? '—' : it.p.toFixed(2)) + ' · 分类：' + (it.choice || '—'));
      lines.push('- 摘要：' + (it.snippet || ''));
      lines.push('');
    });
    lines.push('---');
    lines.push('脱敏：本次共屏蔽 ' + ((result.stats && result.stats.masked) || 0) + ' 处敏感信息（手机号 / 身份证 / 邮箱 / 微信号 / QQ）。');
    lines.push('说明：JEV 只给概率与分数，是否通过由阈值决定；演示数据不代表真实平台结果。');

    var md = lines.join('\n');
    var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '检索报告_' + new Date().toISOString().slice(0, 10) + '.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    toast('报告已导出为 Markdown', 'ok');
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    els = {
      app: $('app'),
      thread: $('thread'), threadInner: $('threadInner'), welcome: $('welcome'),
      messages: $('messages'), input: $('input'), btnSend: $('btnSend'),
      charCount: $('charCount'), sourceChips: $('sourceChips'), starterGrid: $('starterGrid'),
      chatList: $('chatList'), kbList: $('kbList'),
      badgeMode: $('badgeMode'), badgeJev: $('badgeJev'), badgeKb: $('badgeKb'),
      panel: $('panel'), panelTabs: $('panelTabs'), promptGroups: $('promptGroups'),
      setMode: $('setMode'), promptClickMode: $('promptClickMode'),
      sidebar: $('sidebar'), modalBackdrop: $('modalBackdrop'), modalTitle: $('modalTitle'),
      modalBody: $('modalBody'), toasts: $('toasts'),
      btnNewChat: $('btnNewChat'), btnNewKb: $('btnNewKb'), btnKbManager: $('btnKbManager')
    };

    State.settings = C.Settings.load();

    /* 分享链接可带主题：index.html?theme=dark ；截图/演示可带 ?static=1 关闭动画 */
    try {
      var params = new URLSearchParams(global.location.search);
      var themeParam = params.get('theme');
      if (themeParam === 'dark' || themeParam === 'light') State.settings.theme = themeParam;
      if (params.get('static') === '1') document.documentElement.classList.add('no-anim');
    } catch (e) { /* 老浏览器忽略 */ }

    applyTheme();
    KB.ensureSeed();
    loadChats();

    renderStarters();
    renderChatList();
    renderKbList();
    renderThread();
    renderPrompts();
    syncSettingsUI();
    updateBadges();

    if (window.innerWidth > 1240) els.panel.classList.add('is-open');
    if (window.innerWidth <= 980) els.sidebar.classList.remove('is-open');

    bindTopbar();
    bindComposer();
    bindSettings();
    bindSidebar();
    bindThread();
    bindModal();
    bindKbModalEvents();
    bindSourceChips();

    els.panelTabs.addEventListener('click', function (e) {
      var b = e.target.closest('[data-tab]');
      if (!b) return;
      switchPanelTab(b.getAttribute('data-tab'));
    });

    els.promptClickMode.addEventListener('click', function (e) {
      var b = e.target.closest('[data-click]');
      if (!b) return;
      var mode = b.getAttribute('data-click');
      State.settings.promptClick = mode;
      C.Settings.save({ promptClick: mode });
      setSegActive(els.promptClickMode, 'click', mode);
      toast(mode === 'send' ? '点模板会直接检索' : '点模板只填入输入框', 'ok');
    });

    $('btnAddPrompt').addEventListener('click', addPrompt);

    global.addEventListener('kb:changed', function () {
      renderKbList();
      if (!els.modalBackdrop.classList.contains('is-hidden') && els.modalTitle.textContent === '知识库管理') {
        els.modalBody.innerHTML = kbManagerHtml(State.modalKb);
      }
    });

    els.input.focus();
    autoGrow();

    /* 课堂演示 / 自动化验证：index.html?q=你的需求 会直接发起一次检索 */
    try {
      var autoQ = new URLSearchParams(global.location.search).get('q');
      if (autoQ) setTimeout(function () { handleSend(autoQ, {}); }, 300);
    } catch (e) { /* 老浏览器忽略 */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* 供调试与教学观察使用（不影响运行） */
  global.JEVApp = { state: State, handleSend: handleSend, runPipeline: runPipeline };
})(window);
