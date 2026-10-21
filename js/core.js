/* ===========================================================
   core.js — 基础工具 / 脱敏规则 / 本地存储 / 设置中心
   无构建、无依赖；所有模块挂在 window.Core 上
   =========================================================== */
(function (global) {
  'use strict';

  /* ---------------- 通用工具 ---------------- */
  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
  }

  /* 稳定的伪随机：同一输入永远得到同一结果，保证判定可复现 */
  function seed(str) {
    var h = 2166136261;
    var s = String(str == null ? '' : str);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function r1(v) { return Math.round(v * 10) / 10; }
  function r2(v) { return Math.round(v * 100) / 100; }
  function r4(v) { return Math.round(v * 10000) / 10000; }

  function brief(s, n) {
    s = String(s == null ? '' : s);
    n = n || 20;
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function fmtNum(n) {
    n = Number(n) || 0;
    if (n >= 10000) return r1(n / 10000) + ' 万';
    return String(n);
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  function nowTime() {
    var d = new Date();
    function p(x) { return x < 10 ? '0' + x : '' + x; }
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var self = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms || 200);
    };
  }

  /* 按需降级的高亮：把关键词包成 <mark>，输入必须是已转义文本 */
  function highlight(escaped, words) {
    if (!words || !words.length) return escaped;
    var out = escaped;
    words.forEach(function (w) {
      if (!w || String(w).length < 2) return;
      var re = new RegExp('(' + String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      out = out.replace(re, '<mark>$1</mark>');
    });
    return out;
  }

  /* ---------------- 本地存储（带内存兜底，file:// 下也能用） ---------------- */
  var PREFIX = 'jev2.';
  var memStore = {};
  var hasLS = (function () {
    try {
      var k = PREFIX + '__probe';
      global.localStorage.setItem(k, '1');
      global.localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  })();

  var Store = {
    available: hasLS,
    get: function (key, fallback) {
      try {
        var raw = hasLS ? global.localStorage.getItem(PREFIX + key) : memStore[key];
        if (raw == null) return fallback;
        return JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try {
        var raw = JSON.stringify(value);
        if (hasLS) global.localStorage.setItem(PREFIX + key, raw);
        else memStore[key] = raw;
        return true;
      } catch (e) { return false; }
    },
    remove: function (key) {
      try {
        if (hasLS) global.localStorage.removeItem(PREFIX + key);
        else delete memStore[key];
      } catch (e) { /* 忽略 */ }
    }
  };

  /* ---------------- 脱敏规则 ---------------- */
  /* 原则：能在本地用规则拦掉的，绝不送进模型；命中即替换并记账 */
  var MASK_RULES = [
    {
      /* 用 \b 而不是 lookbehind：老浏览器不支持 (?<!...) 时整个脚本会解析失败 */
      key: 'phone', name: '手机号', token: '［已屏蔽：手机号］',
      re: /\b1[3-9]\d{9}\b/g
    },
    {
      key: 'id', name: '身份证号', token: '［已屏蔽：身份证号］',
      re: /\b\d{17}[\dXx]\b/g
    },
    {
      key: 'email', name: '邮箱', token: '［已屏蔽：邮箱］',
      re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
    },
    {
      key: 'wechat', name: '微信号', token: '［已屏蔽：微信号］',
      re: /(?:微信|weixin|wx|vx|V信|薇信)\s*[号：:]?\s*[A-Za-z][-_A-Za-z0-9]{5,19}/g
    },
    {
      key: 'qq', name: 'QQ 号', token: '［已屏蔽：QQ 号］',
      re: /(?:QQ|qq|扣扣)\s*[号：:]?\s*\d{5,12}(?!\d)/g
    }
  ];

  var MASK_TOKEN_RE = /［已屏蔽：[^］]*］/g;

  /* 对一段文本做脱敏；返回 {text, hits:{phone:n,...}, total} */
  function maskText(text, enabled) {
    var out = String(text == null ? '' : text);
    var hits = {};
    var total = 0;
    enabled = enabled || {};
    MASK_RULES.forEach(function (rule) {
      var on = enabled[rule.key] !== false;
      if (!on) return;
      var count = 0;
      out = out.replace(rule.re, function () { count++; return rule.token; });
      if (count) { hits[rule.key] = (hits[rule.key] || 0) + count; total += count; }
    });
    return { text: out, hits: hits, total: total };
  }

  /* 把已脱敏文本渲染成带红色标记的 HTML（先转义，再还原标记） */
  function maskHtml(escapedText) {
    return String(escapedText).replace(MASK_TOKEN_RE, function (m) {
      return '<span class="masked">' + m + '</span>';
    });
  }

  function maskSummary(hits) {
    var out = [];
    MASK_RULES.forEach(function (rule) {
      if (hits[rule.key]) out.push({ name: rule.name, count: hits[rule.key] });
    });
    return out;
  }

  /* 一致性哈希，给演示数据做稳定 id */
  function stableId(text) {
    return 'it_' + Math.abs(Math.round(seed(text) * 1e9)).toString(36);
  }

  /* ---------------- 设置中心 ---------------- */
  var DEFAULT_SETTINGS = {
    mode: 'demo',
    sources: { github: true, web: true, pan: true, kb: true },
    threshold: 0.55,
    minScore: 5.5,
    /* 判定后端：local 本地启发式 / onnx 浏览器 ONNX / remote 本地开源服务或官方 API（经代理） */
    jevBackend: 'local',
    jevEndpoint: 'http://127.0.0.1:8787/api/systemone',
    onnx: {
      model: 'MoritzLaurer/mDeBERTa-v3-base-mnli-xnli',
      dtype: 'q8',
      modelSource: 'huggingface'
    },
    mask: { phone: true, id: true, email: true, wechat: true, qq: true },
    onlyHttps: true,
    skipClarify: false,
    promptClick: 'send',
    theme: 'light',
    autoSaveKb: false
  };

  function deepMerge(base, patch) {
    var out = {};
    Object.keys(base).forEach(function (k) {
      var bv = base[k], pv = patch ? patch[k] : undefined;
      if (bv && typeof bv === 'object' && !Array.isArray(bv)) {
        out[k] = deepMerge(bv, pv && typeof pv === 'object' ? pv : {});
      } else {
        out[k] = patch && Object.prototype.hasOwnProperty.call(patch, k) && pv !== undefined ? pv : bv;
      }
    });
    return out;
  }

  var Settings = {
    DEFAULTS: DEFAULT_SETTINGS,
    current: null,
    load: function () {
      var saved = Store.get('settings', {});
      Settings.current = deepMerge(DEFAULT_SETTINGS, saved || {});
      return Settings.current;
    },
    save: function (patch) {
      Settings.current = deepMerge(Settings.current || DEFAULT_SETTINGS, patch || {});
      Store.set('settings', Settings.current);
      return Settings.current;
    },
    reset: function () {
      Settings.current = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
      Store.set('settings', Settings.current);
      return Settings.current;
    },
    get: function () { return Settings.current || (Settings.current = deepMerge(DEFAULT_SETTINGS, Store.get('settings', {}))); }
  };

  global.Core = {
    esc: esc, seed: seed, clamp: clamp, r1: r1, r2: r2, r4: r4, brief: brief,
    fmtNum: fmtNum, uid: uid, nowTime: nowTime, debounce: debounce, highlight: highlight,
    Store: Store, Settings: Settings,
    mask: { rules: MASK_RULES, text: maskText, html: maskHtml, summary: maskSummary, TOKEN_RE: MASK_TOKEN_RE },
    stableId: stableId, DEFAULT_SETTINGS: DEFAULT_SETTINGS
  };
})(window);
