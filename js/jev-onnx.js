/* ===========================================================
   jev-onnx.js — 浏览器内真实推理（移植自开源 local-jev）
   出处：https://github.com/zhuanqianfish/local-jev （MIT）
   原理：JEV 的三原语本质上是「对同一 state 做若干 NLI 判断」——
        noul  = 陈述句 vs 其否定，取蕴含概率
        choice= 若干候选描述，取 softmax 后 argmax
        score = 有序档位描述，取概率期望
        底层用 @huggingface/transformers 在浏览器里跑 NLI 零样本分类
        （ONNX Runtime Web，优先 WebGPU，失败回退 WASM；q8 量化）。
   特点：零 API Key、数据不出本机；首次需下载模型（约 200-300MB）。
   说明：本文件只负责「跑模型」，问题怎么编译、答案怎么归一由 jev-protocol.js 负责。
   =========================================================== */
(function (global) {
  'use strict';

  var C = global.Core;

  /* 默认与 local-jev 一致：多语言（含中文）NLI 模型，自带 onnx 权重 */
  var DEFAULTS = {
    model: 'MoritzLaurer/mDeBERTa-v3-base-mnli-xnli',
    dtype: 'q8',
    /* 'huggingface' | 'hf-mirror' | 自定义 base URL */
    modelSource: 'huggingface',
    cdn: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm'
  };

  var STATE = {
    loaded: false,
    loading: false,
    failed: false,
    device: null,
    deviceFallback: false,
    model: null,
    dtype: null,
    source: null,
    progress: null,
    error: null,
    classifier: null,
    lib: null
  };

  var round4 = function (n) { return Math.round(n * 10000) / 10000; };

  function resolvedSource(cfg) {
    var s = String(cfg.modelSource || 'huggingface');
    if (s === 'hf-mirror') return 'https://hf-mirror.com';
    if (/^https?:\/\//.test(s)) return s;
    return 'https://huggingface.co';
  }

  /* 动态加载 transformers.js：先 jsDelivr，失败换官方 CDN */
  function loadLib(cfg) {
    if (STATE.lib) return Promise.resolve(STATE.lib);
    var urls = [
      cfg.cdn || DEFAULTS.cdn,
      'https://esm.sh/@huggingface/transformers@3'
    ];
    var i = 0;
    function tryNext() {
      if (i >= urls.length) return Promise.reject(new Error('transformers.js 加载失败（CDN 不可达或被拦截）'));
      var url = urls[i++];
      return import(url).then(function (mod) {
        STATE.lib = mod;
        return mod;
      }).catch(function (e) {
        STATE.lib = null;
        return tryNext();
      });
    }
    return tryNext();
  }

  function normalizeProgress(p) {
    if (!p) return null;
    var out = { status: p.status || '', file: p.file || '', progress: null };
    if (typeof p.progress === 'number') out.progress = Math.round(p.progress * 100);
    else if (p.loaded && p.total) out.progress = Math.round(p.loaded / p.total * 100);
    return out;
  }

  function isBackendError(e) {
    var msg = String((e && e.message) || e);
    return /webgpu|no available backend|failed to get gpu adapter|adapter|gpu/i.test(msg);
  }

  /**
   * 加载模型（幂等）。cfg: {model, dtype, modelSource, cdn, threads}
   * onProgress({status, file, progress})
   */
  function load(cfg, onProgress) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    if (STATE.loaded && STATE.model === cfg.model && STATE.dtype === cfg.dtype) {
      return Promise.resolve(status());
    }
    if (STATE.loading) return STATE.loadingPromise;
    STATE.loading = true;
    STATE.failed = false;
    STATE.error = null;

    var report = function (p) {
      var n = normalizeProgress(p);
      STATE.progress = n;
      if (typeof onProgress === 'function' && n) {
        try { onProgress(n); } catch (e) { /* 界面异常不影响加载 */ }
      }
    };

    var promise = loadLib(cfg).then(function (mod) {
      var env = mod.env;
      var host = resolvedSource(cfg);
      if (env) {
        try {
          env.allowLocalModels = false;
          env.remoteHost = host;
          if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
            /* 没有 COOP/COEP 跨域隔离时只能用单线程 wasm */
            env.backends.onnx.wasm.numThreads = 1;
          }
        } catch (e) { /* 不同小版本 env 字段略有差异，忽略 */ }
      }

      var candidates = ['webgpu', 'wasm'];
      var lastErr = null;

      function tryDevice(idx) {
        if (idx >= candidates.length) return Promise.reject(lastErr || new Error('没有可用推理后端'));
        var device = candidates[idx];
        report({ status: '正在初始化 ' + device + ' 后端', file: cfg.model, progress: null });
        return mod.pipeline('zero-shot-classification', cfg.model, {
          device: device,
          dtype: cfg.dtype,
          progress_callback: report
        }).then(function (classifier) {
          STATE.classifier = classifier;
          STATE.device = device;
          STATE.deviceFallback = idx > 0;
          return status();
        }).catch(function (e) {
          lastErr = e;
          if (idx + 1 < candidates.length && isBackendError(e)) {
            report({ status: 'WebGPU 不可用，回退 WASM', file: cfg.model, progress: null });
            return tryDevice(idx + 1);
          }
          throw e;
        });
      }

      return tryDevice(0);
    }).then(function () {
      STATE.loaded = true;
      STATE.loading = false;
      STATE.model = cfg.model;
      STATE.dtype = cfg.dtype;
      STATE.source = resolvedSource(cfg);
      STATE.error = null;
      return status();
    }).catch(function (e) {
      STATE.loaded = false;
      STATE.loading = false;
      STATE.failed = true;
      STATE.error = (e && e.message) || String(e);
      STATE.classifier = null;
      throw e;
    });

    STATE.loadingPromise = promise;
    return promise;
  }

  function status() {
    return {
      loaded: STATE.loaded,
      loading: STATE.loading,
      failed: STATE.failed,
      device: STATE.device,
      deviceFallback: STATE.deviceFallback,
      model: STATE.model,
      dtype: STATE.dtype,
      source: STATE.source,
      progress: STATE.progress,
      error: STATE.error
    };
  }

  /* 测试用：注入假分类器，避免下载模型即可验证数学与协议 */
  function setClassifier(fake) {
    STATE.classifier = fake;
    STATE.loaded = !!fake;
    STATE.model = 'stub';
    STATE.device = 'stub';
    STATE.error = null;
    STATE.failed = false;
  }

  function dispose() {
    try { if (STATE.classifier && STATE.classifier.dispose) STATE.classifier.dispose(); } catch (e) { /* 忽略 */ }
    STATE.classifier = null;
    STATE.loaded = false;
    STATE.model = null;
    STATE.progress = null;
  }

  /* ---------- 底层：零样本分类 → { label: 概率 } ---------- */
  function classifyProbs(text, candidateLabels) {
    if (!STATE.classifier) return Promise.reject(new Error('模型未加载'));
    return Promise.resolve(STATE.classifier(text, candidateLabels, {
      multi_label: false,
      hypothesis_template: '{}'
    })).then(function (raw) {
      var labels, scores;
      if (raw && Array.isArray(raw.labels) && Array.isArray(raw.scores)) {
        labels = raw.labels;
        scores = raw.scores;
      } else {
        var items = Array.isArray(raw) ? raw : [raw];
        labels = items.map(function (it) { return it.label; });
        scores = items.map(function (it) { return it.score; });
      }
      var total = scores.reduce(function (s, x) { return s + (Number(x) || 0); }, 0) || 1;
      var probs = {};
      labels.forEach(function (l, i) { probs[l] = (Number(scores[i]) || 0) / total; });
      return probs;
    });
  }

  function noul(text, q) {
    if (!q || !q.statement) return Promise.reject(new Error('noul 需要 statement'));
    var neg = q.negation || ('并非：' + q.statement);
    return classifyProbs(text, [q.statement, neg]).then(function (probs) {
      return { noul: round4(probs[q.statement] != null ? probs[q.statement] : 0) };
    });
  }

  function choice(text, q) {
    var criteria = q.criteria || {};
    var keys = Array.isArray(criteria) ? criteria.slice() : Object.keys(criteria);
    if (keys.length < 2) return Promise.reject(new Error('choice 至少需要 2 个选项'));
    var labels = keys.map(function (k) { return Array.isArray(criteria) ? k : (criteria[k] || k); });
    if (keys.length > 255) keys = keys.slice(0, 255);
    return classifyProbs(text, labels).then(function (probs) {
      var best = 0;
      labels.forEach(function (l, i) { if ((probs[l] || 0) > (probs[labels[best]] || 0)) best = i; });
      var probabilities = {};
      keys.forEach(function (k, i) { probabilities[k] = round4(probs[labels[i]] || 0); });
      return {
        choice: keys[best],
        probabilities: probabilities,
        confidence: round4(probs[labels[best]] || 0)
      };
    });
  }

  function score(text, q) {
    var levels = Array.isArray(q.levels) ? q.levels : Object.keys(q.levels || {});
    if (levels.length < 2) return Promise.reject(new Error('score 需要至少 2 个档位'));
    return classifyProbs(text, levels).then(function (probs) {
      var e = 0, probabilities = {};
      levels.forEach(function (lv, i) {
        var p = probs[lv] || 0;
        probabilities[lv] = round4(p);
        e += (i + 1) * p; /* 1-based 档位期望，与 local-jev 一致 */
      });
      var max = 0;
      levels.forEach(function (lv) { if ((probs[lv] || 0) > max) max = probs[lv] || 0; });
      return { score: Math.round(e * 100) / 100, probabilities: probabilities, confidence: round4(max) };
    });
  }

  /** 一次 journal：对同一 state 依次跑完所有问题（对齐官方 systemone 的语义） */
  function systemone(state, questions) {
    var text = typeof state === 'string' ? state : JSON.stringify(state);
    var answers = {};
    var names = Object.keys(questions || {});
    var chain = Promise.resolve();
    names.forEach(function (name) {
      chain = chain.then(function () {
        var q = questions[name];
        if (q.type === 'noul') return noul(text, q).then(function (r) { answers[name] = r; });
        if (q.type === 'choice') return choice(text, q).then(function (r) { answers[name] = r; });
        if (q.type === 'score') return score(text, q).then(function (r) { answers[name] = r; });
        throw new Error('未知问题类型：' + q.type);
      });
    });
    return chain.then(function () { return answers; });
  }

  global.JevOnnx = {
    DEFAULTS: DEFAULTS,
    load: load,
    status: status,
    setClassifier: setClassifier,
    dispose: dispose,
    systemone: systemone,
    _internal: { classifyProbs: classifyProbs, noul: noul, choice: choice, score: score }
  };
})(window);
