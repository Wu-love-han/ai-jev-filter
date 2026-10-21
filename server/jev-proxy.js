#!/usr/bin/env node
/* ===========================================================
   jev-proxy.js — 本地 JEV 代理（零依赖，Node 18+）
   作用：浏览器只调用本机代理，真实上游与 API Key 永远在服务端。

   为什么是 /v1/systemone 形状：
     官方 TypeSafe 的接口是 POST /v1/systemone  { state, model, questions }
     → answers；开源 ollaya 守护进程 **wire-identical**（设
     TYPESAFE_BASE_URL=http://localhost:11435 即可用官方 SDK）。
     所以同一个代理同时支持「官方云端」和「本地开源」，只需换 .env。

   上游模式（JEV_UPSTREAM_MODE）：
     ollaya       本地 ollaya 守护进程（默认 http://127.0.0.1:11435），无需 Key
     typesafe     TypeSafe 官方云端 https://api.typesafe.ai，需要 API Key
     openai       任意 OpenAI 兼容接口（/v1/chat/completions），把问题编译成 JSON 输出
     passthrough  直接把 {state, model, questions} 透传给自定义 JEV 服务

   接口：
     GET  /api/health      状态与上游信息
     POST /api/systemone   官方形状：{ state, model?, questions } → { answers }
     POST /api/jev         兼容旧版单问题调用
   默认只监听 127.0.0.1:8787，不对公网暴露。
   =========================================================== */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

/* ---------------- 极简 .env 读取（不引依赖） ---------------- */
function loadEnv() {
  const candidates = [path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')];
  candidates.forEach((file) => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
    text.split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) return;
      const key = m[1];
      let val = m[2].trim();
      if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
      if (process.env[key] == null) process.env[key] = val;
    });
  });
}
loadEnv();

const RAW_MODE = (process.env.JEV_UPSTREAM_MODE || '').toLowerCase();
const API_KEY = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY || '';
const MODE = RAW_MODE || (API_KEY ? 'typesafe' : 'ollaya');

const DEFAULT_BASE = {
  ollaya: 'http://127.0.0.1:11435',
  typesafe: 'https://api.typesafe.ai',
  openai: '',
  passthrough: ''
};
const DEFAULT_MODEL = {
  ollaya: 'laya:multilingual',
  typesafe: 'jev-latest',
  openai: 'YOUR_JEV_MODEL_NAME_HERE',
  passthrough: 'jev-latest'
};

const CONFIG = {
  host: process.env.JEV_PROXY_HOST || '127.0.0.1',
  port: Number(process.env.JEV_PROXY_PORT || 8787),
  mode: DEFAULT_BASE[MODE] != null ? MODE : 'ollaya',
  base: (process.env.JEV_BASE_URL || DEFAULT_BASE[MODE] || '').replace(/\/+$/, ''),
  model: process.env.JEV_MODEL || DEFAULT_MODEL[MODE] || 'jev-latest',
  apiKey: API_KEY,
  upstreamUrl: process.env.JEV_UPSTREAM_URL || '',
  timeoutMs: Number(process.env.JEV_TIMEOUT_MS || 30000)
};

const LIMITS = { maxQuestions: 20, maxStateChars: 32000, maxBodyBytes: 524288 };
const ALLOWED_PROTOCOLS = new Set(['noul', 'score', 'choice']);
const RATE = { windowMs: 60000, max: 240, hits: new Map() };

/* ---------------- 工具 ---------------- */
function redact(msg) {
  let s = String(msg == null ? '' : msg);
  if (CONFIG.apiKey) s = s.split(CONFIG.apiKey).join('***');
  return s.slice(0, 400);
}

function corsHeaders(req) {
  const origin = req.headers.origin || '';
  const allow = origin === 'null' || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': allow ? origin : 'null',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin'
  };
}

function send(req, res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'X-Content-Type-Options': 'nosniff'
  }, corsHeaders(req)));
  res.end(payload);
}

function rateLimited(req) {
  const ip = req.socket.remoteAddress || 'local';
  const now = Date.now();
  const rec = RATE.hits.get(ip) || { start: now, count: 0 };
  if (now - rec.start > RATE.windowMs) { rec.start = now; rec.count = 0; }
  rec.count += 1;
  RATE.hits.set(ip, rec);
  return rec.count > RATE.max;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > LIMITS.maxBodyBytes) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function httpJson(urlStr, method, headers, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { reject(new Error('上游地址不合法：' + urlStr)); return; }
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const req = lib.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method: method || 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }, payload ? { 'Content-Length': payload.length } : {}, headers || {})
    }, (res) => {
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > 4 * 1024 * 1024) { req.destroy(new Error('上游响应过大')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(timeoutMs || CONFIG.timeoutMs, () => req.destroy(new Error('上游请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

function authHeaders() {
  const h = {};
  if (!CONFIG.apiKey) return h;
  h.Authorization = 'Bearer ' + CONFIG.apiKey;
  if (/typesafe\.ai$/i.test(hostOf(CONFIG.base))) h['X-API-Key'] = CONFIG.apiKey;
  return h;
}

/* ---------------- 校验 ---------------- */
function optionCount(opt) {
  if (!opt) return 0;
  return Array.isArray(opt) ? opt.length : Object.keys(opt).length;
}

function validateSystemone(body) {
  const errors = [];
  if (!body || typeof body !== 'object') errors.push('请求体必须是 JSON 对象');
  const questions = body && body.questions;
  if (!questions || typeof questions !== 'object') errors.push('缺少 questions 对象');
  const names = Object.keys(questions || {});
  if (names.length === 0) errors.push('questions 至少要有 1 个问题');
  if (names.length > LIMITS.maxQuestions) errors.push('questions 超过上限 ' + LIMITS.maxQuestions);
  names.forEach((name) => {
    const q = questions[name];
    if (!q || !ALLOWED_PROTOCOLS.has(q.type)) errors.push('问题 ' + name + ' 的 type 必须是 noul / score / choice');
    if (q && q.type === 'score' && optionCount(q.levels || q.options) < 2) errors.push('score 问题 ' + name + ' 需要至少 2 个 levels');
    if (q && q.type === 'choice') {
      const n = optionCount(q.criteria || q.options);
      if (n < 2) errors.push('choice 问题 ' + name + ' 需要至少 2 个选项');
      if (n > 255) errors.push('choice 问题 ' + name + ' 选项超过 255 上限');
    }
    if (q && q.type === 'noul' && !q.statement && !q.instructions) errors.push('noul 问题 ' + name + ' 需要 statement 或 instructions');
  });
  const state = body && body.state;
  if (state == null) errors.push('缺少 state');
  if (typeof state === 'string' && state.length > LIMITS.maxStateChars) errors.push('state 超过 ' + LIMITS.maxStateChars + ' 字符');
  return errors;
}

/* ---------------- OpenAI 兼容模式：把问题编译成一句 JSON 输出 ---------------- */
function buildMessages(body) {
  const stateText = typeof body.state === 'string' ? body.state : JSON.stringify(body.state);
  const schema = {};
  Object.keys(body.questions).forEach((name) => {
    const q = body.questions[name];
    if (q.type === 'noul') {
      schema[name] = { type: 'noul', statement: q.statement || q.instructions, answer: 0.0 };
    } else if (q.type === 'score') {
      schema[name] = { type: 'score', levels: q.levels || q.options || Object.keys(q.criteria || {}), answer: 0.0 };
    } else {
      schema[name] = { type: 'choice', criteria: q.criteria || q.options, answer: '<one key>' };
    }
  });

  const sys = '你是 JEV（TypeSafe System One）决策模型。你不生成文本，只对给定 state 回答类型化问题，' +
    '输出必须是一个 JSON 对象，不要解释、不要 markdown。概率要校准（0~1），choice 必须取候选 key 之一，' +
    'score 的 answer 是档位编号（从 1 开始，可带小数表示落在档位之间）。';

  const user = '待判断的 state：\n' + stateText + '\n\n' +
    '问题定义：\n' + JSON.stringify(schema, null, 2) + '\n\n' +
    '输出格式（严格同名 key，只输出这个 JSON）：\n' +
    JSON.stringify(Object.keys(schema).reduce((acc, name) => {
      acc[name] = schema[name].type === 'noul' ? { noul: 0.0 }
        : schema[name].type === 'score' ? { score: 0.0, probabilities: {} }
          : { choice: '', probabilities: {} };
      return acc;
    }, {}));

  return [
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ];
}

function extractJson(text) {
  if (!text) throw new Error('上游返回空内容');
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start > -1 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

/* ---------------- 上游调用：官方 / ollaya 形状 ---------------- */
async function callOfficial(body) {
  if (!CONFIG.base) throw new Error('未配置上游地址（JEV_BASE_URL）');
  const url = CONFIG.base + '/v1/systemone';
  const payload = {
    state: body.state,
    model: body.model || CONFIG.model,
    questions: body.questions
  };
  const res = await httpJson(url, 'POST', authHeaders(), payload);
  if (res.status < 200 || res.status >= 300) {
    throw new Error('上游 HTTP ' + res.status + '：' + redact(res.text));
  }
  let json;
  try { json = JSON.parse(res.text); } catch (e) { throw new Error('上游返回的不是 JSON'); }
  if (json && json.ok === false) throw new Error(redact(json.error || '上游返回失败'));
  if (!json.answers) throw new Error('上游响应里没有 answers 字段（对方是否不是 JEV 风格服务？）');
  return { answers: json.answers, model: json.model || payload.model, usage: json.usage || null };
}

/* ---------------- 上游调用：OpenAI 兼容 ---------------- */
async function callOpenAI(body) {
  const base = (CONFIG.upstreamUrl || CONFIG.base).replace(/\/+$/, '');
  if (!base) throw new Error('openai 模式需要设置 JEV_UPSTREAM_URL（如 http://127.0.0.1:11434）');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/v1/chat/completions';
  const payload = {
    model: body.model || CONFIG.model,
    temperature: 0,
    max_tokens: 600,
    messages: buildMessages(body),
    response_format: { type: 'json_object' }
  };
  let res = await httpJson(url, 'POST', authHeaders(), payload);
  if (res.status === 400 && /response_format|json_object/i.test(res.text || '')) {
    delete payload.response_format;
    res = await httpJson(url, 'POST', authHeaders(), payload);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error('上游 HTTP ' + res.status + '：' + redact(res.text));
  }
  const json = JSON.parse(res.text);
  const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  const raw = extractJson(content);
  return { answers: normalizeAnswers(body.questions, raw), model: payload.model, usage: json.usage || null };
}

/* 把自由形状的答案统一成官方形状 */
function normalizeAnswers(questions, raw) {
  const answers = {};
  Object.keys(questions).forEach((name) => {
    const q = questions[name];
    const a = raw[name] != null ? raw[name] : raw;
    if (q.type === 'noul') {
      let p = typeof a === 'number' ? a : (a && (a.noul != null ? a.noul : a.p));
      p = Number(p);
      answers[name] = { noul: isFinite(p) ? Math.max(0, Math.min(1, p > 1 ? p / 100 : p)) : 0.5 };
    } else if (q.type === 'score') {
      let s = typeof a === 'number' ? a : (a && a.score);
      s = Number(s);
      answers[name] = { score: isFinite(s) ? s : 1, probabilities: (a && a.probabilities) || {} };
    } else {
      const opt = q.criteria || q.options;
      const keys = Array.isArray(opt) ? opt.slice() : Object.keys(opt || {});
      let c = String((a && (a.choice || a.answer)) || a || '');
      if (keys.indexOf(c) === -1) {
        const hit = keys.filter((k) => k.indexOf(c) > -1 || c.indexOf(k) > -1)[0];
        c = hit || keys[0] || c;
      }
      answers[name] = { choice: c, probabilities: (a && a.probabilities) || {} };
    }
  });
  return answers;
}

/* ---------------- 路由 ---------------- */
async function handleSystemone(req, res) {
  if (rateLimited(req)) return send(req, res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });

  let body;
  try { body = await readBody(req); }
  catch (e) { return send(req, res, 400, { ok: false, error: redact(e.message) }); }

  const errors = validateSystemone(body);
  if (errors.length) return send(req, res, 400, { ok: false, error: errors.join('；') });

  const started = Date.now();
  try {
    let result;
    if (CONFIG.mode === 'openai') {
      result = await callOpenAI(body);
    } else if (CONFIG.mode === 'passthrough') {
      if (!CONFIG.upstreamUrl) throw new Error('passthrough 模式需要设置 JEV_UPSTREAM_URL');
      const r = await httpJson(CONFIG.upstreamUrl, 'POST', authHeaders(), body);
      if (r.status < 200 || r.status >= 300) throw new Error('上游 HTTP ' + r.status + '：' + redact(r.text));
      const j = JSON.parse(r.text);
      result = { answers: j.answers || j.result || j, model: j.model || body.model || CONFIG.model, usage: j.usage || null };
    } else {
      result = await callOfficial(body);
    }

    const ms = Date.now() - started;
    console.log('[systemone] ' + CONFIG.mode + ' · ' + Object.keys(body.questions).length + ' 问 · ' + ms + 'ms');
    return send(req, res, 200, {
      ok: true,
      model: result.model,
      answers: result.answers,
      usage: result.usage,
      ms: ms,
      upstream: { mode: CONFIG.mode, base: CONFIG.base || CONFIG.upstreamUrl, model: result.model }
    });
  } catch (e) {
    console.error('[systemone] 上游失败：' + redact(e.message));
    return send(req, res, 502, { ok: false, error: redact(e.message), upstream: { mode: CONFIG.mode, base: CONFIG.base || CONFIG.upstreamUrl } });
  }
}

/* 兼容旧版单问题接口：把 {protocol, question|criteria|options} 翻译成官方问题 */
const COMPAT_LEVELS = ['2 分：完全不相关', '4 分：弱相关', '6 分：基本相关', '8 分：高度相关', '10 分：完全匹配'];
const COMPAT_CATEGORIES = { 教程: '系统教程与指南', 代码库: '代码仓库与工具', 百科词条: '概念解释与文档', 资源合集: '资源合集', 商业产品: '商业产品' };

function compatQuestion(body) {
  const protocol = body.protocol;
  if (protocol === 'noul') {
    const text = body.statement || body.question || body.instructions || '这条信息是否真实存在、可信赖';
    return { type: 'noul', statement: body.statement || text, instructions: body.instructions || body.question || text };
  }
  if (protocol === 'score') {
    const levels = Array.isArray(body.levels) && body.levels.length >= 2 ? body.levels.slice(0, 10) : COMPAT_LEVELS;
    return { type: 'score', instructions: body.instructions || body.criteria || '与用户需求的相关程度', levels: levels };
  }
  let criteria;
  if (Array.isArray(body.options)) {
    criteria = {};
    body.options.forEach((o) => { criteria[String(o)] = String(o); });
  } else if (body.options && typeof body.options === 'object') {
    criteria = body.options;
  } else if (typeof body.options === 'string') {
    criteria = {};
    body.options.split(/[,，]/).map((s) => s.trim()).filter(Boolean).forEach((o) => { criteria[o] = o; });
  } else if (body.criteria && typeof body.criteria === 'object') {
    criteria = body.criteria;
  } else {
    criteria = COMPAT_CATEGORIES;
  }
  return { type: 'choice', instructions: body.instructions || '这条信息属于哪一类', criteria: criteria };
}

/* 兼容旧版单问题接口 */
async function handleCompat(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return send(req, res, 400, { ok: false, error: redact(e.message) }); }
  const protocol = body.protocol;
  if (!ALLOWED_PROTOCOLS.has(protocol)) {
    return send(req, res, 400, { ok: false, error: 'protocol 必须是 noul / score / choice' });
  }
  const questions = { q: compatQuestion(body) };
  const state = body.state != null ? body.state : (body.title ? body.title : '(empty)');
  const errors = validateSystemone({ state: state, questions: questions });
  if (errors.length) return send(req, res, 400, { ok: false, error: errors.join('；') });

  try {
    let result;
    if (CONFIG.mode === 'openai') result = await callOpenAI({ state: state, questions: questions, model: body.model });
    else result = await callOfficial({ state: state, questions: questions, model: body.model });
    const a = result.answers.q || {};
    const out = { ok: true, protocol: protocol, backend: 'jev-proxy', upstream: CONFIG.mode, signals: [] };
    if (protocol === 'noul') out.p = a.noul;
    if (protocol === 'score') { out.score = a.score; out.probabilities = a.probabilities || {}; }
    if (protocol === 'choice') { out.choice = a.choice; out.probabilities = a.probabilities || {}; }
    return send(req, res, 200, out);
  } catch (e) {
    return send(req, res, 502, { ok: false, error: redact(e.message) });
  }
}

function handleHealth(req, res) {
  return send(req, res, 200, {
    ok: true,
    backend: 'jev-proxy',
    wire: 'typesafe/v1/systemone',
    upstream: {
      mode: CONFIG.mode,
      base: CONFIG.base || CONFIG.upstreamUrl || '',
      model: CONFIG.model,
      keyConfigured: !!CONFIG.apiKey
    },
    limits: { maxQuestions: LIMITS.maxQuestions, maxStateChars: LIMITS.maxStateChars },
    note: CONFIG.mode === 'ollaya'
      ? '本地开源模式：需要先启动 ollaya 守护进程（默认 127.0.0.1:11435）'
      : CONFIG.mode === 'typesafe' ? '官方云端模式：请确认 Key 与服务地区' : '自定义上游模式'
  });
}

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }
  if (req.method === 'GET' && url === '/api/health') return handleHealth(req, res);
  if (req.method === 'POST' && url === '/api/systemone') return handleSystemone(req, res);
  if (req.method === 'POST' && (url === '/api/jev' || url === '/api/jev/')) return handleCompat(req, res);

  return send(req, res, 404, { ok: false, error: 'Not Found' });
});

server.headersTimeout = 15000;
server.requestTimeout = 60000;

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log('');
  console.log('JEV 代理已启动：http://' + CONFIG.host + ':' + CONFIG.port);
  console.log('  GET  /api/health      状态与上游信息');
  console.log('  POST /api/systemone   官方形状 { state, model?, questions } → { answers }');
  console.log('  POST /api/jev         兼容旧版单问题调用');
  console.log('  上游模式  ' + CONFIG.mode + ((CONFIG.base || CONFIG.upstreamUrl) ? ' → ' + (CONFIG.base || CONFIG.upstreamUrl) : '（未配置地址）'));
  console.log('  模型      ' + CONFIG.model);
  console.log('  API Key   ' + (CONFIG.apiKey ? '已从环境变量读取（不打印、不发给浏览器）' : '未设置（本地开源模式不需要）'));
  console.log('');
  if (CONFIG.mode === 'ollaya') {
    console.log('提示：ollaya 是「决策模型的 Ollama」，先启动守护进程再回来用：');
    console.log('  curl -fsSL https://ollaya.dev/install.sh | sh');
    console.log('  ollaya pull laya:multilingual && ollaya serve');
    console.log('');
  }
  console.log('按 Ctrl+C 停止。');
});

process.on('SIGINT', () => {
  console.log('\n已停止 JEV 代理。');
  try { process.exit(0); } catch (e) { /* 忽略 */ }
});
