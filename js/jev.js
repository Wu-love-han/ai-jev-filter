/* ===========================================================
   jev.js — JEV 判定调度器（对齐官方 /v1/systemone 语义）
   一次调用 = 同一个 state + 一组类型化问题（noul / score / choice），
   所有问题并行评估、按同名 key 返回答案。

   三条后端（同一套问题协议，可随时切换）：
     local  → 本地启发式：离线、确定性、可解释（默认，用于演示与教学）
     onnx   → 浏览器内真实推理：移植 local-jev（@huggingface/transformers + NLI 模型）
     remote → 本地开源服务 / 官方 API：经零依赖代理访问
              · ollaya（本地守护进程，wire-identical 于 TypeSafe /v1/systemone）
              · TypeSafe 官方云端 API（需 Key，Key 只在服务端）
              · 任意 OpenAI 兼容 / passthrough 形态

   设计原则（来自官方与第三方实测）：
     · 模型只给概率/分数，"过不过"由 pipeline 按阈值决定；
     · noul 没有 confidence 字段，不要编；
     · 用 max(probabilities) 判断置信度，而不是官方 confidence；
     · 后端失败一律显式标注并回落启发式，绝不冒充真实模型。
   =========================================================== */
(function (global) {
  'use strict';

  var C = global.Core;
  var DATA = global.DATA;
  var Protocol = global.JEVProtocol;
  var Onnx = global.JevOnnx;

  var seed = C.seed, clamp = C.clamp, r1 = C.r1, r2 = C.r2, r4 = C.r4;

  var RISK_RE = /(破解|代下|加微信|免费领取|内部资料|私聊|刷单|外挂|解压密码|代购)/;
  var TRUST_RE = /(^|\.)(github\.com|wikipedia\.org|baike\.baidu\.com|arxiv\.org|docs\.|\.edu(\.|$)|\.gov(\.|$))/i;
  var TUTORIAL_RE = /(教程|入门|指南|tutorial|guide|handbook|cookbook|从零|快速上手)/i;
  var DOC_RE = /(wiki|baike|百科|文档|手册|docs?|说明)/i;

  /* ---------------- 信号与来源评估（启发式专用） ---------------- */
  function sourceTier(st) {
    var url = st.url;
    if (st.source === 'kb') return { tier: 0.92, label: '自建知识库' };
    if (/github\.com/i.test(url)) return { tier: 0.88, label: 'GitHub 仓库' };
    if (TRUST_RE.test(url) && !/github\.com/i.test(url)) return { tier: 0.85, label: '权威站点' };
    if (/pan\.|alipan|quark|weiyun|cloud\.189/i.test(url)) return { tier: 0.34, label: '网盘转载' };
    if (/^https:\/\//i.test(url)) return { tier: 0.62, label: '普通网页' };
    if (!url) return { tier: 0.5, label: '无外链' };
    return { tier: 0.42, label: '非 HTTPS 链接' };
  }

  function freshness(st) {
    var u = st.meta && st.meta.updated;
    if (!u) return 0.5;
    var t = Date.parse(String(u));
    if (!t) return 0.5;
    var days = (Date.now() - t) / 86400000;
    if (days < 0) return 0.5;
    if (days <= 90) return 1;
    if (days <= 180) return 0.78;
    if (days <= 365) return 0.5;
    return 0.24;
  }

  function signal(list, kind, label, delta) {
    list.push({ kind: kind, label: label, delta: r2(delta) });
  }

  function toSt(item) {
    return {
      title: String(item.title || ''),
      url: String(item.url || ''),
      source: String(item.source || ''),
      snippet: String(item.snippet || ''),
      meta: item.meta || {},
      alive: typeof item.alive === 'boolean' ? item.alive : undefined
    };
  }

  /* ---------------- 启发式：noul ---------------- */
  function hNoul(st, question) {
    var signals = [];
    var p = 0.44;
    var tier = sourceTier(st);
    signal(signals, tier.tier >= 0.8 ? 'up' : tier.tier < 0.5 ? 'down' : 'flat',
      '来源：' + tier.label, (tier.tier - 0.6) * 0.42);
    p += (tier.tier - 0.6) * 0.42;

    if (/^https:\/\//i.test(st.url)) { signal(signals, 'up', 'HTTPS 加密链接', 0.06); p += 0.06; }
    else if (st.url) { signal(signals, 'down', '非 HTTPS 链接', -0.1); p -= 0.1; }

    if (st.snippet.length >= 40) { signal(signals, 'up', '描述足够具体', 0.06); p += 0.06; }
    else if (st.snippet.length < 14) { signal(signals, 'down', '描述过短', -0.08); p -= 0.08; }

    if (RISK_RE.test(st.title + ' ' + st.snippet)) { signal(signals, 'down', '命中高风险特征词', -0.3); p -= 0.3; }
    if (st.alive === false) { signal(signals, 'down', '链接存活核验未通过', -0.26); p -= 0.26; }
    else if (st.alive === true) { signal(signals, 'up', '链接存活核验通过', 0.08); p += 0.08; }

    if (st.source === 'github') {
      var stars = Number(st.meta.stars) || 0;
      if (stars >= 10000) { signal(signals, 'up', '社区关注度很高（' + C.fmtNum(stars) + ' star）', 0.1); p += 0.1; }
      else if (stars >= 1000) { signal(signals, 'up', '社区有一定关注（' + C.fmtNum(stars) + ' star）', 0.06); p += 0.06; }
      else if (stars > 0 && stars < 100) { signal(signals, 'down', '仓库关注度很低', -0.05); p -= 0.05; }
    }

    var fresh = freshness(st);
    if (fresh >= 1) { signal(signals, 'up', '近期仍在更新', 0.07); p += 0.07; }
    else if (fresh <= 0.24) { signal(signals, 'down', '超过一年未更新', -0.09); p -= 0.09; }

    if (/风险|危险|欺诈|诱导/.test(question || '')) p = 1 - p;
    else if (/完整|充分|足以/.test(question || '') && st.snippet.length >= 60) { signal(signals, 'up', '问题要求信息完整，本文较长', 0.05); p += 0.05; }

    var jit = (seed(st.url + '|' + (question || '') + '|noul') - 0.5) * 0.12;
    signal(signals, 'flat', '判定噪声（可复现）', jit);
    p += jit;
    return { p: clamp(p, 0.03, 0.97), signals: signals };
  }

  /* ---------------- 启发式：score ---------------- */
  function hScore(st, criteria, keywords) {
    var signals = [];
    var kws = (keywords && keywords.length) ? keywords : [];
    var hay = (st.title + ' ' + st.snippet + ' ' + st.url).toLowerCase();
    var hit = kws.filter(function (w) { return hay.indexOf(String(w).toLowerCase()) > -1; });
    var overlap = kws.length ? hit.length / kws.length : 0.4;
    var tier = sourceTier(st);
    var fresh = freshness(st);
    var stars = Number(st.meta.stars) || 0;
    var starFactor = stars >= 50000 ? 1 : stars >= 10000 ? 0.86 : stars >= 1000 ? 0.7 : stars > 0 ? 0.5 : 0.55;

    var s = 2;
    var c1 = overlap * 3.6; s += c1;
    var c2 = tier.tier * 1.9; s += c2;
    var c3 = starFactor * 1.3; s += c3;
    var c4 = fresh * 0.9; s += c4;

    signal(signals, hit.length ? 'up' : 'down',
      hit.length ? '命中需求关键词 ' + hit.length + '/' + (kws.length || 1) : '未命中需求关键词', c1);
    signal(signals, tier.tier >= 0.8 ? 'up' : tier.tier < 0.5 ? 'down' : 'flat', '来源权威度：' + tier.label, c2);
    if (st.source === 'github') signal(signals, starFactor >= 0.7 ? 'up' : 'flat', '社区活跃度', c3);
    signal(signals, fresh >= 1 ? 'up' : fresh <= 0.24 ? 'down' : 'flat', '时效性', c4);

    if (RISK_RE.test(st.title + ' ' + st.snippet)) { signal(signals, 'down', '含高风险特征词', -1.6); s -= 1.6; }
    if (st.alive === false) { signal(signals, 'down', '链接失效', -1.1); s -= 1.1; }
    if (/新手|入门|beginner|中文/i.test(st.title + ' ' + st.snippet)) {
      signal(signals, 'up', '对新手友好（命中「新手 / 中文」）', 0.5); s += 0.5;
    }

    var jit = (seed(st.url + '|' + (criteria || '') + '|score') - 0.5) * 0.9;
    signal(signals, 'flat', '评分噪声（可复现）', jit);
    s += jit;
    return { score: r1(clamp(s, 2, 10)), signals: signals, hitKeywords: hit };
  }

  /* ---------------- 启发式：choice ---------------- */
  function categoryScores(st) {
    var hay = (st.title + ' ' + st.snippet + ' ' + st.url).toLowerCase();
    var s = { '教程': 0.18, '代码库': 0.18, '百科词条': 0.18, '资源合集': 0.14, '商业产品': 0.1 };
    if (st.source === 'kb') { s['教程'] += 0.55; s['百科词条'] += 0.2; }
    if (/github|gitlab|gitee/.test(st.url)) s['代码库'] += 0.85;
    if (/pan\.|alipan|quark|wei?yun|cloud\.189/.test(st.url)) s['资源合集'] += 0.8;
    if (TUTORIAL_RE.test(hay)) s['教程'] += 0.45;
    if (DOC_RE.test(hay)) s['百科词条'] += 0.4;
    if (/定价|套餐|购买|enterprise|pricing/i.test(hay)) s['商业产品'] += 0.4;
    return s;
  }

  function hChoice(st) {
    var signals = [];
    var scores = categoryScores(st);
    var probs = Protocol.softmax(scores, 1.6);
    var choice = Object.keys(probs).sort(function (a, b) { return probs[b] - probs[a]; })[0];
    signal(signals, 'flat', '按来源与标题特征归类为「' + choice + '」', 0);
    signal(signals, 'flat', '分类置信度（max probability）', r4(probs[choice]));
    return { choice: choice, probabilities: probs, confidence: r4(probs[choice]), signals: signals };
  }

  /* ---------------- 组装启发式答案（一次给出全部问题） ---------------- */
  function heuristicAnswers(item, questions, keywords) {
    var st = toSt(item);
    var answers = {};
    var meta = { signals: {} };

    if (questions.veracity) {
      var p = hNoul(st, questions.veracity.instructions);
      answers.veracity = { noul: r2(p.p) };
      meta.signals.veracity = p.signals;
    }
    if (questions.relevance) {
      var sc = hScore(st, questions.relevance.instructions, keywords);
      answers.relevance = {
        score: sc.score,
        probabilities: Protocol.distributeLevels(sc.score),
        confidence: 0.78
      };
      meta.signals.relevance = sc.signals;
      meta.hitKeywords = sc.hitKeywords;
    }
    if (questions.category) {
      var ch = hChoice(st);
      answers.category = {
        choice: ch.choice,
        probabilities: ch.probabilities,
        confidence: ch.confidence
      };
      meta.signals.category = ch.signals;
    }

    /* 启发式的「置信度」不是真实后验：用关键词命中率 + 来源权威度估一个
       可解释的确定性，避免把合成的平坦分布误判成「模型在猜」。 */
    var kws = keywords || [];
    var hay = (st.title + ' ' + st.snippet + ' ' + st.url).toLowerCase();
    var hitCount = kws.filter(function (w) { return hay.indexOf(String(w).toLowerCase()) > -1; }).length;
    var hitRatio = kws.length ? hitCount / kws.length : 0.5;
    var tier = sourceTier(st);
    meta.confidence = r2(clamp(0.44 + 0.36 * hitRatio + (tier.tier >= 0.8 ? 0.1 : 0) + (st.source === 'kb' ? 0.06 : 0), 0.32, 0.93));
    meta.confidenceSource = 'heuristic';

    return { answers: answers, meta: meta };
  }

  /* ---------------- 后端：浏览器 ONNX（local-jev 方案） ---------------- */
  function viaOnnx(item, demand, questions, opts) {
    var cfg = (C.Settings.get().onnx) || {};
    var state = Protocol.stateFromItem(item, demand);
    var ready = Onnx.status().loaded
      ? Promise.resolve()
      : Onnx.load(cfg, opts && opts.onProgress);

    return ready.then(function () {
      return Onnx.systemone(state, questions);
    }).then(function (answers) {
      return {
        answers: answers,
        meta: { signals: {} },
        backend: 'onnx',
        simulated: false,
        usage: { questions: Object.keys(questions).length }
      };
    });
  }

  /* ---------------- 后端：远程（本地开源服务 / 官方 API） ---------------- */
  function endpoint() { return String(C.Settings.get().jevEndpoint || '').trim(); }

  function deriveHealthUrl(ep) {
    if (/\/api\/systemone\/?$/.test(ep)) return ep.replace(/\/api\/systemone\/?$/, '/api/health');
    try {
      var u = new URL(ep);
      return u.origin + '/api/health';
    } catch (e) { return ''; }
  }

  function viaRemote(item, demand, questions, opts) {
    var ep = endpoint();
    if (!ep) return Promise.reject(new Error('未配置 JEV 服务地址'));
    var state = Protocol.stateFromItem(item, demand);
    var model = String(C.Settings.get().jevModel || '').trim();
    var body = { state: state, questions: questions };
    if (model) body.model = model;

    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timeout = (opts && opts.timeoutMs) || 45000;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeout);
    var init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    if (ctrl) init.signal = ctrl.signal;

    return fetch(ep, init).then(function (res) {
      return res.text().then(function (text) {
        var json;
        try { json = JSON.parse(text); }
        catch (e) { throw new Error('服务返回的不是 JSON（HTTP ' + res.status + '）'); }
        if (!res.ok) throw new Error((json && json.error) || ('HTTP ' + res.status));
        if (json && json.ok === false) throw new Error(json.error || '服务返回失败');
        return json;
      });
    }).then(function (json) {
      var answers = json.answers || (json.result && json.result.answers);
      if (!answers) throw new Error('服务响应里没有 answers 字段');
      return {
        answers: answers,
        meta: { signals: {}, upstream: json.upstream || json.model || '' },
        backend: 'remote',
        simulated: false,
        usage: json.usage || { questions: Object.keys(questions).length }
      };
    }).finally(function () { clearTimeout(timer); });
  }

  /* ---------------- 统一入口 ---------------- */
  function backend() {
    var b = C.Settings.get().jevBackend;
    return b === 'onnx' || b === 'remote' ? b : 'local';
  }

  function systemone(item, demand, opts) {
    opts = opts || {};
    var t0 = Date.now();
    var questions = opts.questions || Protocol.buildQuestions();
    var b = backend();
    var keywords = opts.keywords || [];

    var run;
    if (b === 'onnx') run = viaOnnx(item, demand, questions, opts);
    else if (b === 'remote') run = viaRemote(item, demand, questions, opts);
    else run = Promise.resolve(heuristicAnswers(item, questions, keywords));

    return run.then(function (res) {
      res.answers = res.answers || {};
      res.normalized = Protocol.normalize(res.answers);
      /* 启发式提供的是可解释的确定性估计，而不是合成的后验概率：
         这时用它自己的 confidence，避免平坦分布被误判为「模型在猜」 */
      if (res.meta && res.meta.confidence != null) {
        res.normalized.confidence = res.meta.confidence;
        res.normalized.confidenceSource = res.meta.confidenceSource || 'provided';
        res.normalized.lowConfidence = res.normalized.confidence < 0.55;
        res.normalized.uncertain = res.normalized.lowConfidence;
      }
      res.backend = res.backend || 'local';
      res.simulated = res.backend === 'local' || res.backend === 'heuristic';
      res.usage = res.usage || { questions: Object.keys(questions).length };
      res.ms = Date.now() - t0;
      res.questions = questions;
      return res;
    }).catch(function (e) {
      /* 真实后端不可用 → 回落启发式，并明确记录原因（界面会显示） */
      var h = heuristicAnswers(item, questions, keywords);
      var n = Protocol.normalize(h.answers);
      if (h.meta && h.meta.confidence != null) {
        n.confidence = h.meta.confidence;
        n.confidenceSource = 'heuristic';
        n.lowConfidence = n.confidence < 0.55;
        n.uncertain = n.lowConfidence;
      }
      return {
        answers: h.answers,
        meta: h.meta,
        normalized: n,
        backend: 'heuristic-fallback',
        simulated: true,
        usage: { questions: Object.keys(questions).length },
        ms: Date.now() - t0,
        questions: questions,
        fallbackReason: (e && e.message) || String(e)
      };
    });
  }

  function batch(items, runner, concurrency) {
    var list = items.slice();
    var limit = Math.max(1, concurrency || 4);
    var results = new Array(list.length);
    var cursor = 0;

    function next() {
      if (cursor >= list.length) return Promise.resolve();
      var i = cursor++;
      return Promise.resolve(runner(list[i], i)).then(function (r) {
        results[i] = r;
        return next();
      });
    }

    var workers = [];
    for (var w = 0; w < Math.min(limit, list.length); w++) workers.push(next());
    return Promise.all(workers).then(function () { return results; });
  }

  /* ---------------- 健康检查 / ONNX 管理 ---------------- */
  function health() {
    if (backend() === 'onnx') {
      var st = Onnx.status();
      return Promise.resolve({
        ok: !!st.loaded,
        kind: 'onnx',
        detail: st.loaded ? ('浏览器本地推理 · ' + st.device + (st.deviceFallback ? '（已回退）' : '')) : '模型未加载',
        status: st
      });
    }
    var ep = endpoint();
    if (!ep) return Promise.resolve({ ok: false, kind: 'remote', error: '未配置服务地址' });
    var url = deriveHealthUrl(ep);
    if (!url) return Promise.resolve({ ok: false, kind: 'remote', error: '服务地址格式不正确' });
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 5000);
    var init = { headers: { Accept: 'application/json' } };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(url, init).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      return {
        ok: true,
        kind: 'remote',
        upstream: j.upstream || null,
        wire: j.wire || 'typesafe',
        detail: j.upstream ? ('上游：' + (j.upstream.mode || '?') + ' · ' + (j.upstream.base || '') + (j.upstream.model ? ' · ' + j.upstream.model : '')) : '代理已就绪'
      };
    }).catch(function (e) {
      return { ok: false, kind: 'remote', error: e && e.name === 'AbortError' ? '连接超时' : ((e && e.message) || String(e)) };
    }).finally(function () { clearTimeout(timer); });
  }

  function loadOnnx(cfg, onProgress) {
    var merged = Object.assign({}, C.Settings.get().onnx || {}, cfg || {});
    return Onnx.load(merged, onProgress);
  }

  function onnxStatus() { return Onnx.status(); }
  function disposeOnnx() { Onnx.dispose(); }

  global.JEV = {
    systemone: systemone,
    batch: batch,
    health: health,
    backend: backend,
    loadOnnx: loadOnnx,
    onnxStatus: onnxStatus,
    disposeOnnx: disposeOnnx,
    PROTOCOL: Protocol,
    _heuristic: { noul: hNoul, score: hScore, choice: hChoice, sourceTier: sourceTier, answers: heuristicAnswers }
  };
})(window);
