/* ===========================================================
   sources.js — 关键词抽取 / 多源检索 / 脱敏与硬规则预检查
   数据源：GitHub（实时 API 或演示池）、网页、网盘、本地知识库
   诚实原则：每条结果都带 simulated 标记，界面必须告知用户数据来源
   =========================================================== */
(function (global) {
  'use strict';

  var C = global.Core;
  var DATA = global.DATA;
  var seed = C.seed;

  var CN_RE = /[\u4e00-\u9fa5]{2,}/g;
  var EN_RE = /[A-Za-z][A-Za-z0-9+#.-]{1,}/g;

  /* ---------------- 关键词抽取 ---------------- */
  function extractKeywords(text, max) {
    var t = String(text || '');
    max = max || 5;
    var out = [];

    function push(w) {
      w = String(w || '').trim();
      if (!w || w.length < 2) return;
      var exists = out.some(function (x) { return x.toLowerCase() === w.toLowerCase(); });
      if (!exists) out.push(w);
    }

    /* 1) 领域词表优先（保证 GitHub 能搜出相关结果） */
    Object.keys(DATA.EN_MAP).forEach(function (k) { if (t.indexOf(k) > -1) push(k); });
    /* 2) 英文技术词 */
    (t.match(EN_RE) || []).forEach(function (w) { if (w.length > 2) push(w); });
    /* 3) 中文词块（按标点切开后取 2-6 字的片段） */
    (t.match(CN_RE) || []).forEach(function (chunk) {
      if (chunk.length <= 6) push(chunk);
      else {
        for (var i = 0; i + 4 <= chunk.length && out.length < max + 4; i += 4) push(chunk.slice(i, i + 4));
      }
    });

    if (!out.length) push('AI Agent');
    return out.slice(0, max);
  }

  /* GitHub 只吃英文关键词：把中文领域词映射成英文，避免搜出一堆无关仓库 */
  function githubQuery(keywords) {
    var kws = keywords || [];
    var ascii = [];
    kws.forEach(function (kw) {
      var m = String(kw).match(/[A-Za-z][A-Za-z0-9+#.-]*/g) || [];
      m.forEach(function (w) { if (w.length > 1 && ascii.indexOf(w) < 0) ascii.push(w); });
    });
    if (ascii.length >= 2) return ascii.slice(0, 3).join(' ');
    var mapped = [];
    kws.forEach(function (kw) {
      Object.keys(DATA.EN_MAP).forEach(function (k) {
        if (String(kw).indexOf(k) > -1) {
          var en = DATA.EN_MAP[k];
          if (mapped.indexOf(en) < 0) mapped.push(en);
        }
      });
    });
    var parts = mapped.length ? mapped : ascii;
    return parts.slice(0, 3).join(' ') || 'ai agent workflow';
  }

  /* ---------------- 条目归一化 ---------------- */
  function toItem(raw) {
    var id = C.stableId((raw.u || raw.t || '') + '|' + (raw.s || ''));
    return {
      id: id,
      title: String(raw.t || ''),
      url: String(raw.u || ''),
      source: String(raw.s || 'web'),
      snippet: String(raw.d || ''),
      meta: raw.m || {},
      alive: typeof raw.alive === 'boolean' ? raw.alive : undefined,
      simulated: raw.simulated !== false,
      maskedHits: [],
      judgements: [],
      score: null,
      p: null,
      choice: null
    };
  }

  /* 网盘类链接的存活核验（演示环境按来源确定性推算，可复现） */
  function aliveStatus(item) {
    if (typeof item.alive === 'boolean') return item.alive;
    if (item.source === 'pan') return seed(item.id + '|alive') > 0.34;
    return true;
  }

  /* ---------------- GitHub ---------------- */
  function fetchGithub(keywords, limit, live) {
    var q = githubQuery(keywords);
    if (!live) return Promise.resolve(demoPool('github', keywords, limit, q, true));

    var url = 'https://api.github.com/search/repositories?q=' + encodeURIComponent(q) +
      '&sort=stars&order=desc&per_page=' + Math.min(30, Math.max(6, limit * 3));
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 7000);
    var opts = { headers: { Accept: 'application/vnd.github+json' } };
    if (ctrl) opts.signal = ctrl.signal;

    return fetch(url, opts).then(function (r) {
      if (r.status === 403) throw new Error('GitHub 接口限流（未登录每小时 60 次），请稍后再试');
      if (!r.ok) throw new Error('GitHub 返回 HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var rows = (j && j.items) || [];
      if (!rows.length) throw new Error('没有匹配到仓库');
      /* 低星仓库噪音大，先过一道质量门槛；不够就用原始结果 */
      var good = rows.filter(function (x) { return (x.stargazers_count || 0) >= 100; });
      var use = (good.length >= Math.min(3, limit) ? good : rows).slice(0, limit);
      var items = use.map(function (repo) {
        return toItem({
          t: repo.full_name,
          u: repo.html_url,
          s: 'github',
          d: repo.description || '（该仓库没有填写简介）',
          m: {
            stars: repo.stargazers_count || 0,
            lang: repo.language || '—',
            updated: (repo.pushed_at || '').slice(0, 10),
            license: repo.license && repo.license.spdx_id ? repo.license.spdx_id : '—',
            forks: repo.forks_count || 0,
            issues: repo.open_issues_count || 0
          },
          simulated: false
        });
      });
      return { items: items, simulated: false, query: q, note: '实时检索 q=' + q };
    }).catch(function (e) {
      /* 回落数据必须继续标成演示数据，不能因为接口失败就冒充实时结果 */
      var fb = demoPool('github', keywords, limit, q, true);
      fb.fallbackReason = e && e.name === 'AbortError' ? '请求超时' : (e.message || String(e));
      return fb;
    }).finally(function () { clearTimeout(timer); });
  }

  /* ---------------- 演示数据池 ---------------- */
  function demoPool(kind, keywords, limit, query, markSimulated) {
    var pool = (DATA.DEMO[kind] || []).slice();
    var kws = (keywords || []).map(function (w) { return String(w).toLowerCase(); });

    pool.sort(function (a, b) {
      var sa = kws.filter(function (w) { return (a.t + ' ' + a.d).toLowerCase().indexOf(w) > -1; }).length;
      var sb = kws.filter(function (w) { return (b.t + ' ' + b.d).toLowerCase().indexOf(w) > -1; }).length;
      return sb - sa;
    });

    var items = pool.slice(0, limit).map(function (raw) {
      var it = toItem(raw);
      it.simulated = markSimulated !== false;
      if (it.source === 'pan') it.alive = aliveStatus(it);
      return it;
    });

    return { items: items, simulated: true, query: query, note: '演示数据（不联网）' };
  }

  /* ---------------- 知识库 ---------------- */
  function fetchKB(keywords, topK) {
    var hits = global.KB.search(keywords, topK || 4);
    var items = hits.map(function (h) {
      var it = toItem({
        t: h.doc.t,
        u: '',
        s: 'kb',
        d: h.doc.d,
        m: { kb: h.kb.name, doc: (h.doc.m && h.doc.m.doc) || h.kb.name }
      });
      it.simulated = false;
      it.fromKB = h.kb.name;
      return it;
    });
    return { items: items, simulated: false, note: '命中 ' + items.length + ' 条自建条目' };
  }

  /* ---------------- 脱敏 & 硬规则预检查 ---------------- */
  /* 顺序很重要：先跑代码规则（零成本、确定性），剩下的才交给 JEV */
  function precheck(items, settings) {
    var blocked = [];
    var maskedCount = 0;
    var hitMap = {};
    var kept = [];

    var onlyHttps = settings.onlyHttps !== false;
    var enabledMask = settings.mask || {};

    items.forEach(function (it) {
      var hay = it.title + ' ' + it.snippet;

      /* 1) 黑名单硬规则 */
      var badWord = DATA.BLOCK_WORDS.filter(function (w) { return hay.indexOf(w) > -1; })[0];
      if (badWord) {
        blocked.push({ item: it, reason: '命中黑名单词「' + badWord + '」' });
        return;
      }

      /* 2) 链接协议 */
      if (onlyHttps && it.url && !/^https:\/\//i.test(it.url)) {
        blocked.push({ item: it, reason: '非 HTTPS 链接' });
        return;
      }

      /* 3) 失效链接：网盘类沉底但不直接丢弃（用户可能想看到） */
      if (it.source === 'pan') {
        it.alive = aliveStatus(it);
        if (it.alive === false) {
          blocked.push({ item: it, reason: '链接存活核验未通过（已沉底）' });
          return;
        }
      }

      /* 4) 脱敏 */
      var t = C.mask.text(it.title, enabledMask);
      var d = C.mask.text(it.snippet, enabledMask);
      it.title = t.text;
      it.snippet = d.text;
      var hits = {};
      Object.keys(t.hits).forEach(function (k) { hits[k] = (hits[k] || 0) + t.hits[k]; });
      Object.keys(d.hits).forEach(function (k) { hits[k] = (hits[k] || 0) + d.hits[k]; });
      var n = t.total + d.total;
      if (n > 0) {
        it.maskedHits = C.mask.summary(hits);
        it.maskedCount = n;
        maskedCount += n;
        it.maskedHits.forEach(function (m) { hitMap[m.name] = (hitMap[m.name] || 0) + m.count; });
      }

      kept.push(it);
    });

    return {
      items: kept,
      blocked: blocked,
      maskedCount: maskedCount,
      maskedDetail: C.mask.summary(hitMap),
      stats: {
        in: items.length,
        kept: kept.length,
        blocked: blocked.length,
        masked: maskedCount
      }
    };
  }

  /* ---------------- 编排：按开关并发取数 ---------------- */
  function retrieve(demand, keywords, settings) {
    var src = settings.sources || {};
    var live = settings.mode === 'live';
    var limit = 6;
    var tasks = [];
    var status = [];

    if (src.github) {
      tasks.push(fetchGithub(keywords, limit, live).then(function (r) {
        status.push({ key: 'github', label: 'GitHub', mode: r.simulated ? 'demo' : 'live', count: r.items.length, note: r.note, fallbackReason: r.fallbackReason });
        return r.items;
      }));
    }
    if (src.web) {
      var webP = Promise.resolve(demoPool('web', keywords, 4, null, true));
      tasks.push(webP.then(function (r) {
        var items = r.items.map(function (it) { it.simulated = true; return it; });
        status.push({ key: 'web', label: '百科 / 网页', mode: 'demo', count: items.length, note: r.note });
        return items;
      }));
    }
    if (src.pan) {
      var panP = Promise.resolve(demoPool('pan', keywords, 4, null, true));
      tasks.push(panP.then(function (r) {
        status.push({ key: 'pan', label: '网盘', mode: 'demo', count: r.items.length, note: r.note });
        return r.items;
      }));
    }
    if (src.kb) {
      tasks.push(Promise.resolve(fetchKB(keywords, 4)).then(function (r) {
        status.push({ key: 'kb', label: '知识库', mode: 'local', count: r.items.length, note: r.note });
        return r.items;
      }));
    }

    if (!tasks.length) return Promise.resolve({ items: [], status: [], notes: ['没有启用任何数据源'] });

    return Promise.all(tasks).then(function (groups) {
      var all = [];
      var seen = {};
      groups.forEach(function (group) {
        group.forEach(function (it) {
          var key = it.url || (it.source + '|' + it.title);
          if (seen[key]) return;
          seen[key] = true;
          all.push(it);
        });
      });
      return { items: all, status: status, notes: [] };
    });
  }

  global.Sources = {
    extractKeywords: extractKeywords,
    githubQuery: githubQuery,
    fetchGithub: fetchGithub,
    demoPool: demoPool,
    fetchKB: fetchKB,
    precheck: precheck,
    retrieve: retrieve,
    toItem: toItem,
    aliveStatus: aliveStatus
  };
})(window);
