/* ===========================================================
   jev-protocol.js — 官方 JEV 协议层（对齐 TypeSafe /v1/systemone）
   依据（GitHub 开源实现与调研，见 README「关于 JEV」）：
     · 请求：POST /v1/systemone  { state, model, questions }
       - 一个问题集里的所有问题对同一 state 并行评估，key 不发给模型
       - noul  → { statement, instructions }
       - score → { instructions, levels:[...] }（有序档位）
       - choice→ { instructions, criteria:{key: 描述} }
     · 响应：{ model, answers:{ 同名key: {...} }, usage }
       - noul   → { noul: 0~1 }            （注意：官方 noul 不带 confidence）
       - score  → { score, probabilities, confidence }（分值可落在档位之间）
       - choice → { choice, probabilities, confidence }（≤255 选项）
   本文件只做「把业务问题编译成 JEV 问题」与「把答案归一成界面要用的结构」，
   不关心后端是本地启发式 / 浏览器 ONNX / 本地开源服务 / 官方 API。
   =========================================================== */
(function (global) {
  'use strict';

  var C = global.Core;

  /* 相关性评分：5 个有序档位，值域 2-10（与官方 score 一致，分值可取期望落在档位之间） */
  var LEVELS = [
    { key: 'l2', value: 2, label: '2 分：完全不相关，只是字面重合' },
    { key: 'l4', value: 4, label: '4 分：弱相关，主题沾边但解决不了需求' },
    { key: 'l6', value: 6, label: '6 分：基本相关，能部分回答需求' },
    { key: 'l8', value: 8, label: '8 分：高度相关，直接覆盖需求要点' },
    { key: 'l10', value: 10, label: '10 分：完全匹配，可作为首选' }
  ];

  var CATEGORIES = {
    教程: '系统的教程、指南、课程、实战手册，教人怎么上手',
    代码库: '可运行的代码仓库、框架、SDK、工具源码',
    百科词条: '百科、词条、概念解释、官方文档与规格说明',
    资源合集: '打包的网盘资源、资料合集、下载包',
    商业产品: '商业软件、商业服务、付费平台的产品页'
  };

  /* 默认问题集：真伪（noul）+ 相关性（score）+ 分类（choice） */
  function buildQuestions(opts) {
    opts = opts || {};
    return {
      veracity: {
        type: 'noul',
        instructions: opts.veracityInstructions ||
          '这条检索结果是否指向一个真实存在、可访问的公开项目或资料？',
        statement: opts.veracityStatement ||
          '这条检索结果指向一个真实存在、可访问的公开项目或资料'
      },
      relevance: {
        type: 'score',
        instructions: opts.relevanceInstructions ||
          '这条结果与用户需求的相关程度（按档位给分）',
        levels: LEVELS.map(function (l) { return l.label; })
      },
      category: {
        type: 'choice',
        instructions: opts.categoryInstructions || '这条信息属于哪一类内容？',
        criteria: CATEGORIES
      }
    };
  }

  /* 把一条候选信息编译成 state 文本：官方 state 可以是字符串或 JSON */
  function stateFromItem(item, demand) {
    var meta = item.meta || {};
    var metaBits = [];
    if (meta.stars != null) metaBits.push('star ' + C.fmtNum(meta.stars));
    if (meta.lang) metaBits.push(meta.lang);
    if (meta.updated) metaBits.push('更新 ' + meta.updated);
    if (meta.site) metaBits.push(meta.site);
    if (meta.size) metaBits.push(meta.size);
    if (item.fromKB) metaBits.push('知识库 ' + item.fromKB);

    var lines = [];
    if (demand) lines.push('用户需求：' + String(demand).slice(0, 300));
    lines.push('候选标题：' + String(item.title || ''));
    lines.push('来源：' + String(item.source || ''));
    if (item.url) lines.push('链接：' + String(item.url).slice(0, 200));
    lines.push('摘要：' + String(item.snippet || '').slice(0, 600));
    if (metaBits.length) lines.push('元数据：' + metaBits.join(' · '));
    if (item.alive === false) lines.push('注意：该链接存活核验未通过');
    return lines.join('\n');
  }

  /* ---------------- 答案归一 ---------------- */
  var EPS = 1e-6;

  function pctMapKeys(probabilities, mapping) {
    /* 把上游返回的 probabilities 统一成 {业务key: 概率} */
    var out = {};
    if (!probabilities) return out;
    if (Array.isArray(probabilities)) {
      mapping.forEach(function (m, i) {
        out[m.key] = Number(probabilities[i]) || 0;
      });
      return out;
    }
    Object.keys(probabilities).forEach(function (rawKey) {
      var target = rawKey;
      for (var i = 0; i < mapping.length; i++) {
        if (rawKey === mapping[i].key || rawKey === mapping[i].label || rawKey === mapping[i].value + '' ||
            rawKey.indexOf(mapping[i].key) > -1 || rawKey.indexOf(mapping[i].label) > -1) {
          target = mapping[i].key;
          break;
        }
      }
      out[target] = Number(probabilities[rawKey]) || 0;
    });
    return out;
  }

  /* score：在有序档位上求期望（官方语义：分值可落在档位之间） */
  function expectedScore(probs) {
    var sum = 0, total = 0;
    LEVELS.forEach(function (l) {
      var p = Number(probs[l.key] || 0);
      sum += l.value * p;
      total += p;
    });
    if (total <= EPS) return null;
    return C.r1(C.clamp(sum / total, 2, 10));
  }

  function maxProb(probs) {
    var max = 0;
    Object.keys(probs || {}).forEach(function (k) {
      var v = Number(probs[k]) || 0;
      if (v > max) max = v;
    });
    return max;
  }

  /* 官方 score 返回的是「档位期望（0 基）」，本界面统一成 2-10 分。
     优先用 probabilities 反算（最准）；只有 score 时才按 0 基档位插值。 */
  function scoreFromLevelIndex(raw) {
    var n = LEVELS.length;
    var v = Number(raw);
    if (!isFinite(v)) return null;
    if (v > n - 1) return C.clamp(v, 2, 10);      /* 看起来已经是分值 */
    var idx = C.clamp(v, 0, n - 1);
    var lo = Math.floor(idx);
    var hi = Math.min(n - 1, lo + 1);
    var frac = idx - lo;
    return C.clamp(LEVELS[lo].value + (LEVELS[hi].value - LEVELS[lo].value) * frac, 2, 10);
  }

  /* 把某后端的原始 answers 归一成界面/流水线要用的结构 */
  function normalize(answers) {
    answers = answers || {};
    var out = { raw: answers };

    /* noul：真伪概率（官方无 confidence 字段，别自己编） */
    if (answers.veracity) {
      var p = answers.veracity.noul != null ? answers.veracity.noul : answers.veracity.p;
      p = Number(p);
      out.p = isFinite(p) ? C.clamp(p > 1 ? p / 100 : p, 0, 1) : 0.5;
    }

    /* score：优先用档位分布反算期望，其次按 0 基档位插值 */
    if (answers.relevance) {
      var rawProbs = answers.relevance.probabilities;
      var probs = pctMapKeys(rawProbs, LEVELS);
      var hasProbs = Object.keys(probs).some(function (k) { return probs[k] > 0; });
      var score = hasProbs ? expectedScore(probs) : scoreFromLevelIndex(answers.relevance.score);
      out.score = score == null ? 5 : C.r1(C.clamp(score, 2, 10));
      out.levelProbs = probs;
      out.levelProbMax = maxProb(probs);
    }

    /* choice：分类 + 分布 */
    if (answers.category) {
      var mapping = Object.keys(CATEGORIES).map(function (k) { return { key: k, label: k }; });
      var cprobs = pctMapKeys(answers.category.probabilities, mapping);
      out.choice = String(answers.category.choice || '') || null;
      out.choiceProbs = cprobs;
      out.choiceProbMax = maxProb(cprobs);
    }

    /* 校准：按第三方实测建议，用 max(probabilities) 而不是官方 confidence */
    var conf = Math.max(out.levelProbMax || 0, out.choiceProbMax || 0);
    out.confidence = conf > 0 ? C.r2(conf) : null;
    out.lowConfidence = conf > 0 && conf < 0.55;

    /* 弃权/不确定：所有分布都很平，说明模型在猜 */
    out.uncertain = out.lowConfidence === true;
    return out;
  }

  /* 供本地启发式使用：把 2-10 分倒推成档位分布（三角权重，期望≈给定分） */
  function distributeLevels(score) {
    var probs = {};
    var total = 0;
    LEVELS.forEach(function (l) {
      var w = 1 / (1 + Math.pow(Math.abs(l.value - score) / 2.2, 2));
      probs[l.key] = w;
      total += w;
    });
    Object.keys(probs).forEach(function (k) { probs[k] = C.r4(probs[k] / total); });
    return probs;
  }

  /* 供本地启发式使用：把分类得分数组转成分布（温度 softmax） */
  function softmax(scores, temperature) {
    var t = temperature || 1.6;
    var keys = Object.keys(scores);
    var max = Math.max.apply(null, keys.map(function (k) { return scores[k]; }));
    var exps = {}, total = 0;
    keys.forEach(function (k) {
      var v = Math.exp((scores[k] - max) / t);
      exps[k] = v;
      total += v;
    });
    var probs = {};
    keys.forEach(function (k) { probs[k] = C.r4(exps[k] / total); });
    return probs;
  }

  global.JEVProtocol = {
    LEVELS: LEVELS,
    CATEGORIES: CATEGORIES,
    buildQuestions: buildQuestions,
    stateFromItem: stateFromItem,
    normalize: normalize,
    expectedScore: expectedScore,
    scoreFromLevelIndex: scoreFromLevelIndex,
    distributeLevels: distributeLevels,
    softmax: softmax,
    maxProb: maxProb
  };
})(window);
