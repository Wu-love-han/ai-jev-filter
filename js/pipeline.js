/* ===========================================================
   pipeline.js — 后台工作流（对话里"思考过程"的真实来源）
   用户需求 → 主动追问 → 多源检索 → 脱敏 & 硬规则 → JEV 判定
            → 打分排序 → 摘要生成 → 结果卡片
   JEV 判定对齐官方 /v1/systemone：每条信息 1 次调用、3 个问题并行返回
   每一步都通过 onStep 回调上报，界面据此渲染进度；每一步都可失败降级
   =========================================================== */
(function (global) {
  'use strict';

  var C = global.Core;
  var DATA = global.DATA;
  var S = global.Sources;
  var JEV = global.JEV;
  var r1 = C.r1;

  /* ---------------- 需求追问判定 ---------------- */
  var VAGUE_RE = /(帮我找|找点|搜一下|看看|推荐|有什么|来点)/;
  var CONCRETE_RE = /(教程|项目|代码|开源|文档|网盘|资源|论文|框架|工具|库|课程|视频|仓库|版本|对比|区别|是否|为什么|怎么)/;

  function needsClarify(demand, settings) {
    if (settings && settings.skipClarify) return { need: false };
    var text = String(demand || '').trim();
    if (text.length < 6) {
      return {
        need: true,
        question: '信息太少了，我不敢乱猜。你想要的更接近下面哪一种？',
        options: defaultOptions()
      };
    }
    if (text.length < 16 && VAGUE_RE.test(text) && !CONCRETE_RE.test(text)) {
      return {
        need: true,
        question: '需求还比较开放，先确认一下方向，能省掉一轮无效检索：',
        options: defaultOptions()
      };
    }
    return { need: false };
  }

  function defaultOptions() {
    return [
      { label: '找开源项目 / 代码', append: '重点是找真实存在的开源仓库，关注是否可运行、是否还在维护。', sources: { github: true, web: false, pan: false, kb: true } },
      { label: '找教程 / 学习资料', append: '重点是找适合新手的教程、文档与学习路径。', sources: { github: true, web: true, pan: true, kb: true } },
      { label: '核实一个说法是真是假', append: '重点判断这个说法是否可信，需要给出采信建议与依据。', sources: { github: false, web: true, pan: false, kb: true } },
      { label: '找网盘资源', append: '重点是找可用的网盘资源，需要存活核验并避开诱导加微信的条目。', sources: { github: false, web: false, pan: true, kb: false } },
      { label: '直接检索，不用追问', append: '', sources: null, primary: true }
    ];
  }

  /* ---------------- 步骤上报 ---------------- */
  function makeEmitter(onEvent) {
    return function emit(type, payload) {
      try { if (typeof onEvent === 'function') onEvent(type, payload); } catch (e) { /* 界面异常不影响流程 */ }
    };
  }

  function step(emit, id, label) {
    var t0 = Date.now();
    emit('step', { id: id, label: label, state: 'running' });
    return {
      done: function (detail, meta, msOverride) {
        var ms = msOverride != null ? msOverride : (Date.now() - t0);
        emit('step', { id: id, label: label, state: 'done', detail: detail, meta: meta, ms: ms });
        return ms;
      },
      fail: function (msg) {
        emit('step', { id: id, label: label, state: 'error', detail: msg, ms: Date.now() - t0 });
      }
    };
  }

  var BACKEND_LABELS = {
    local: '本地启发式模拟',
    heuristic: '本地启发式模拟',
    onnx: '浏览器本地 ONNX 模型',
    remote: '本地开源服务 / 官方 API',
    'heuristic-fallback': '真实后端不可用，已回落启发式'
  };

  function backendLabel(b) { return BACKEND_LABELS[b] || ('未知后端（' + b + '）'); }

  /* ---------------- 排序 ---------------- */
  function rankItems(items) {
    items.forEach(function (it) {
      var p = it.p == null ? 0.5 : it.p;
      var s = it.score == null ? 5 : it.score;
      /* 综合分：匹配度占七成，真伪概率占三成（都可解释，不含黑箱） */
      it.composite = r1(s * 0.7 + p * 10 * 0.3);
    });
    items.sort(function (a, b) {
      if (b.composite !== a.composite) return b.composite - a.composite;
      return b.score - a.score;
    });
    items.forEach(function (it, i) { it.rank = i + 1; });
    return items;
  }

  /* ---------------- 摘要（本地模板合成，不编造事实） ---------------- */
  function buildSummary(ctx) {
    var items = ctx.items;
    var demand = ctx.demand;
    var top = items.slice(0, 3);
    var st = ctx.stats;
    var avgScore = items.length ? r1(items.reduce(function (s, it) { return s + (it.score || 0); }, 0) / items.length) : 0;
    var avgP = items.length ? r1(items.reduce(function (s, it) { return s + (it.p || 0); }, 0) / items.length) : 0;

    var lead = '围绕「' + C.brief(demand, 40) + '」，本次拿到 ' + st.fetched +
      ' 条候选，脱敏 ' + st.masked + ' 处、硬规则淘汰 ' + st.blocked +
      ' 条；JEV 用 ' + (st.jevRequests || 0) + ' 次调用完成 ' + (st.jevQuestions || 0) +
      ' 个判定（每条 1 次调用问 3 个问题），保留 ' + items.length + ' 条，平均匹配度 ' + avgScore + '/10。';

    var recommends = top.map(function (it, i) {
      return {
        rank: i + 1,
        title: it.title,
        score: it.score,
        p: it.p,
        source: it.source,
        reason: (it.lowConfidence ? '置信度偏低，建议人工复核' : '') ||
          (it.score >= 7 ? '匹配度高' : it.score >= 5.5 ? '基本匹配' : '匹配度偏低，可作参考')
      };
    });

    var risks = [];
    if (st.blocked > 0) risks.push(st.blocked + ' 条信息被硬规则淘汰（黑名单词 / 非 HTTPS / 链接失效），未进入 JEV 判定。');
    if (st.fallback) risks.push('实时接口不可用（' + st.fallback + '），本次 GitHub 结果已回落到演示数据。');
    if (st.jevFallback) risks.push('JEV 真实后端不可用（' + st.jevFallback + '），本次判定已回落为本地启发式。');
    if (st.jevBackend && (st.jevBackend === 'local' || st.jevBackend === 'heuristic')) {
      risks.push('本次 JEV 判定为本地启发式模拟（离线、确定性），用于教学演示；接真实模型见 INSTALL.md。');
    }
    if (st.lowConfidence > 0) risks.push('其中 ' + st.lowConfidence + ' 条判定的置信度低于 0.55（依据不足，模型基本在猜），已标注「建议人工复核」，不要直接采信。');
    if (ctx.simulatedSources.length) risks.push('以下数据源为演示数据，仅用于课堂演示：' + ctx.simulatedSources.join('、') + '。');
    if (items.some(function (it) { return it.source === 'pan'; })) risks.push('网盘条目均为第三方转载，采信前请自行核对内容与授权。');
    if (!risks.length) risks.push('来源均为公开可访问页面，仍建议对关键结论做一次交叉验证。');

    return {
      lead: lead,
      recommends: recommends,
      risks: risks,
      avgScore: avgScore,
      avgP: avgP
    };
  }

  /* ---------------- 主流程 ---------------- */
  function run(opts) {
    var settings = opts.settings || C.Settings.get();
    var demand = String(opts.demand || '').trim();
    var emit = makeEmitter(opts.onEvent);
    var t0 = Date.now();
    var ctx = {
      demand: demand,
      settings: settings,
      items: [],
      stats: {
        fetched: 0, blocked: 0, masked: 0, filtered: 0,
        jevRequests: 0, jevQuestions: 0, jevBackend: 'local',
        lowConfidence: 0, fallback: null, jevFallback: null
      },
      simulatedSources: [],
      sourceStatus: [],
      maskedDetail: []
    };

    if (!demand) return Promise.reject(new Error('需求不能为空'));

    /* ---- 步骤 1：理解需求 ---- */
    var s1 = step(emit, 'parse', '理解需求 · 抽取关键词');
    var keywords = S.extractKeywords(demand, 5);
    s1.done('关键词：' + keywords.join(' · '), { keywords: keywords.length + ' 个' });
    ctx.keywords = keywords;

    /* ---- 步骤 2：多源检索 ---- */
    var s2 = step(emit, 'retrieve', '多源检索');
    var retrieveStart = Date.now();

    return S.retrieve(demand, keywords, settings).then(function (res) {
      ctx.stats.fetched = res.items.length;
      ctx.sourceStatus = res.status;
      ctx.simulatedSources = res.status.filter(function (x) { return x.mode === 'demo'; }).map(function (x) { return x.label; });
      var fb = res.status.filter(function (x) { return x.fallbackReason; })[0];
      if (fb) ctx.stats.fallback = fb.fallbackReason;

      var perSource = res.status.map(function (x) {
        var modeText = x.mode === 'live' ? '实时' : x.mode === 'local' ? '本地' : '演示';
        return x.label + ' ' + x.count + ' 条（' + modeText + '）';
      }).join(' · ');
      s2.done(perSource || '没有启用数据源', { ms: Date.now() - retrieveStart });

      /* ---- 步骤 3：脱敏 & 硬规则 ---- */
      var s3 = step(emit, 'precheck', '脱敏 & 硬规则预检查');
      var pre = S.precheck(res.items, settings);
      ctx.stats.blocked = pre.stats.blocked;
      ctx.stats.masked = pre.stats.masked;
      ctx.maskedDetail = pre.maskedDetail;
      ctx.blockedDetail = pre.blocked.slice(0, 6).map(function (b) {
        return { title: C.brief(b.item.title, 24), reason: b.reason };
      });
      s3.done('进入判断 ' + pre.stats.kept + ' 条 · 淘汰 ' + pre.stats.blocked + ' 条 · 脱敏 ' + pre.stats.masked + ' 处',
        { kept: pre.stats.kept });

      var pool = pre.items;
      if (!pool.length) {
        ctx.items = [];
        ctx.summary = buildSummary(ctx);
        return finish(ctx, emit, t0, { empty: true, reason: '所有候选都被硬规则淘汰了（黑名单 / 非 HTTPS / 链接失效）。可以换个说法或关闭部分限制再试。' });
      }

      /* ---- 步骤 4~6：JEV 判定（一次调用问 3 个问题） ----
         官方语义：同一 state 的一组类型化问题并行评估，按同名 key 返回。
         所以这里是「每条信息 1 次请求」，而不是每个原语各发一次请求。 */
      var threshold = Number(settings.threshold);
      if (isNaN(threshold)) threshold = 0.55;
      var questions = opts.questions || JEV.PROTOCOL.buildQuestions(opts.questionSet || {});
      var questionCount = Object.keys(questions).length;

      var s4 = step(emit, 'jev_noul', 'JEV · 真伪判断（noul）');

      return JEV.batch(pool, function (it) {
        return JEV.systemone(it, demand, { keywords: keywords, questions: questions, onProgress: opts.onProgress });
      }, 4).then(function (judged) {
        /* 统一写入判定结果 */
        var backendVotes = {};
        pool.forEach(function (it, i) {
          var j = judged[i] || {};
          var n = j.normalized || {};
          it.p = n.p == null ? 0.5 : n.p;
          it.score = n.score == null ? 5 : n.score;
          it.choice = n.choice;
          it.confidence = n.confidence;
          it.lowConfidence = !!n.lowConfidence;
          it.probabilities = { levels: n.levelProbs || {}, categories: n.choiceProbs || {} };
          it.jevBackend = j.backend || 'local';
          it.jevMs = j.ms || 0;
          backendVotes[it.jevBackend] = (backendVotes[it.jevBackend] || 0) + 1;

          var sig = (j.meta && j.meta.signals) || {};
          it.judgements = [
            {
              proto: 'noul', value: it.p, pass: it.p >= threshold,
              question: (questions.veracity || {}).instructions,
              signals: sig.veracity || [], backend: it.jevBackend, simulated: !!j.simulated
            },
            {
              proto: 'score', value: it.score, pass: it.score >= (settings.minScore || 5.5),
              criteria: (questions.relevance || {}).instructions,
              probabilities: n.levelProbs || {}, signals: sig.relevance || [],
              backend: it.jevBackend, simulated: !!j.simulated
            },
            {
              proto: 'choice', value: it.choice || '未分类', confidence: n.choiceProbMax || 0,
              probabilities: n.choiceProbs || {},
              options: Object.keys(JEV.PROTOCOL.CATEGORIES),
              signals: sig.category || [], backend: it.jevBackend, simulated: !!j.simulated
            }
          ];
          if (n.hitKeywords) it.hitKeywords = n.hitKeywords;
          if (j.fallbackReason) it.jevFallbackReason = j.fallbackReason;
        });

        var votes = Object.keys(backendVotes).sort(function (a, b) { return backendVotes[b] - backendVotes[a]; });
        var backend = votes[0] || 'local';
        var fallbackItem = pool.filter(function (it) { return it.jevFallbackReason; })[0];
        ctx.stats.jevBackend = backend;
        ctx.stats.jevRequests = pool.length;
        ctx.stats.jevQuestions = pool.length * questionCount;
        ctx.stats.jevFallback = fallbackItem ? fallbackItem.jevFallbackReason : null;
        ctx.stats.lowConfidence = pool.filter(function (it) { return it.lowConfidence; }).length;

        var passed = pool.filter(function (it) { return it.p >= threshold; });
        ctx.stats.filtered = pool.length - passed.length;
        /* 三个问题来自同一次 /v1/systemone 调用，所以三个步骤共用同一耗时 */
        var batchMs = s4.done('p ≥ ' + threshold.toFixed(2) + ' 保留 ' + passed.length + ' 条，过滤 ' + ctx.stats.filtered +
          ' 条 · ' + pool.length + ' 次调用完成 ' + (pool.length * questionCount) + ' 个判定 · 后端：' + backendLabel(backend),
          { kept: passed.length, filtered: ctx.stats.filtered });

        /* 容错：阈值过严导致全灭时，保留概率最高的 3 条并明确告知 */
        var relaxed = false;
        if (!passed.length) {
          relaxed = true;
          passed = pool.slice().sort(function (a, b) { return b.p - a.p; }).slice(0, 3);
          passed.forEach(function (it) { it.passRelaxed = true; });
        }

        /* ---- 步骤 5：score 打分（与 noul 同一次调用返回） ---- */
        var s5 = step(emit, 'jev_score', 'JEV · 匹配打分（score · 同批返回）');
        var avg = r1(passed.reduce(function (s, it) { return s + it.score; }, 0) / passed.length);
        var lowScore = passed.filter(function (it) { return it.score < (settings.minScore || 5.5); }).length;
        s5.done('平均 ' + avg + '/10（' + JEV.PROTOCOL.LEVELS.length + ' 个有序档位取期望），' +
          lowScore + ' 条低于建议线 ' + (settings.minScore || 5.5) + ' 分（保留但降权展示）', { avg: avg }, batchMs);

        /* ---- 步骤 6：choice 分类（同样来自同一次调用） ---- */
        var s6 = step(emit, 'jev_choice', 'JEV · 内容分类（choice · 同批返回）');
        var dist = {};
        passed.forEach(function (it) { dist[it.choice || '未分类'] = (dist[it.choice || '未分类'] || 0) + 1; });
        var distText = Object.keys(dist).map(function (k) { return k + ' ' + dist[k]; }).join(' · ');
        s6.done((distText || '完成分类') + ' · 低置信 ' + ctx.stats.lowConfidence + ' 条已标注「建议人工复核」', { dist: dist }, batchMs);

        /* ---- 步骤 7：排序 ---- */
        var s7 = step(emit, 'rank', '综合打分与排序');
        var sorted = rankItems(passed);
        ctx.items = sorted;
        ctx.summary = buildSummary(ctx);
        s7.done('综合分 = 匹配度 × 0.7 + 真伪概率 × 3，取前 ' + Math.min(sorted.length, 6) + ' 条推送', { total: sorted.length });

        return finish(ctx, emit, t0, { relaxed: relaxed });
      });
    }).catch(function (e) {
      if (!ctx.items.length) {
        try { s2.fail(e.message || String(e)); } catch (err) { /* 已失败过 */ }
      }
      throw e;
    });
  }

  function finish(ctx, emit, t0, flags) {
    var ms = Date.now() - t0;
    var anySimulated = ctx.items.some(function (it) { return it.simulated; }) || ctx.simulatedSources.length > 0;
    var result = {
      kind: 'result',
      demand: ctx.demand,
      keywords: ctx.keywords,
      items: ctx.items,
      summary: ctx.summary,
      sourceStatus: ctx.sourceStatus,
      maskedDetail: ctx.maskedDetail,
      blockedDetail: ctx.blockedDetail || [],
      stats: {
        fetched: ctx.stats.fetched,
        kept: ctx.items.length,
        blocked: ctx.stats.blocked,
        masked: ctx.stats.masked,
        filtered: ctx.stats.filtered,
        jevRequests: ctx.stats.jevRequests,
        jevQuestions: ctx.stats.jevQuestions,
        lowConfidence: ctx.stats.lowConfidence,
        avgScore: ctx.summary.avgScore,
        avgP: ctx.summary.avgP,
        ms: ms
      },
      simulated: anySimulated,
      relaxed: !!flags.relaxed,
      empty: !!flags.empty,
      emptyReason: flags.reason || '',
      jevBackend: ctx.stats.jevBackend,
      jevBackendLabel: backendLabel(ctx.stats.jevBackend)
    };
    emit('done', result);
    return result;
  }

  global.Pipeline = {
    run: run,
    needsClarify: needsClarify,
    buildSummary: buildSummary,
    rankItems: rankItems,
    defaultOptions: defaultOptions,
    backendLabel: backendLabel
  };
})(window);
