#!/usr/bin/env node
/* ===========================================================
   proxy-test.js — JEV 代理的端到端测试（零依赖，Node 18+）
   自带一个「假 ollaya / 假 TypeSafe」上游，验证：
     1) /api/health 形状
     2) /api/systemone 转发的是官方形状（state + model + questions）
     3) 归一化后的答案能被前端协议层消费
     4) 校验：非法 protocol / 选项不足 / 问题过多 / state 过长 → 400
     5) 兼容接口 /api/jev 仍可用
   用法： node tools/proxy-test.js
   =========================================================== */

'use strict';

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UPSTREAM_PORT = 8798;
const PROXY_PORT = 8788;

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* ---------------- 假上游：实现官方 /v1/systemone 形状 ---------------- */
let lastRequest = null;
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method !== 'POST' || !/\/v1\/systemone$/.test(req.url)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    let parsed = {};
    try { parsed = JSON.parse(body); } catch (e) { /* ignore */ }
    lastRequest = { url: req.url, auth: req.headers.authorization || '', body: parsed };

    const answers = {};
    Object.keys(parsed.questions || {}).forEach((name) => {
      const q = parsed.questions[name];
      if (q.type === 'noul') answers[name] = { noul: 0.87 };
      else if (q.type === 'score') {
        const levels = q.levels || [];
        const probs = {};
        levels.forEach((lv, i) => { probs[lv] = i === levels.length - 2 ? 0.6 : (0.4 / Math.max(1, levels.length - 1)); });
        answers[name] = { score: levels.length - 2, probabilities: probs };
      } else {
        const keys = Object.keys(q.criteria || {});
        const probs = {};
        keys.forEach((k, i) => { probs[k] = i === 1 ? 0.7 : (0.3 / Math.max(1, keys.length - 1)); });
        answers[name] = { choice: keys[1], probabilities: probs, confidence: 0.7 };
      }
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'fake-jev-1.0.0', answers: answers, usage: { input_tokens: 123, output_tokens: 12 } }));
  });
});

function post(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: port, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* ignore */ }
        resolve({ status: res.statusCode, json: json, text: text });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: port, path: pathname }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* ignore */ }
        resolve({ status: res.statusCode, json: json });
      });
    }).on('error', reject);
  });
}

function waitHealth(retries) {
  return get(PROXY_PORT, '/api/health').then((r) => r).catch(() => {
    if (retries <= 0) throw new Error('代理启动超时');
    return new Promise((r) => setTimeout(r, 300)).then(() => waitHealth(retries - 1));
  });
}

const QUESTIONS = {
  veracity: { type: 'noul', instructions: '是否真实存在？', statement: '这条结果指向真实存在的公开项目' },
  relevance: {
    type: 'score', instructions: '与需求的相关程度',
    levels: ['2 分：完全不相关', '4 分：弱相关', '6 分：基本相关', '8 分：高度相关', '10 分：完全匹配']
  },
  category: { type: 'choice', instructions: '属于哪一类？', criteria: { 教程: '教程资料', 代码库: '代码仓库', 百科词条: '概念解释' } }
};

let proxy = null;

(async () => {
  await new Promise((resolve) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', resolve));

  proxy = spawn(process.execPath, [path.join(ROOT, 'server', 'jev-proxy.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      JEV_PROXY_HOST: '127.0.0.1',
      JEV_PROXY_PORT: String(PROXY_PORT),
      JEV_UPSTREAM_MODE: 'ollaya',
      JEV_BASE_URL: 'http://127.0.0.1:' + UPSTREAM_PORT,
      JEV_MODEL: 'laya:multilingual',
      JEV_API_KEY: ''
    }),
    stdio: 'ignore'
  });

  await waitHealth(40);

  console.log('\n[1] /api/health');
  const health = await get(PROXY_PORT, '/api/health');
  check('HTTP 200', health.status === 200);
  check('声明 wire 为 typesafe/v1/systemone', health.json && health.json.wire === 'typesafe/v1/systemone');
  check('上报上游模式与模型', health.json && health.json.upstream.mode === 'ollaya' && health.json.upstream.model === 'laya:multilingual');
  check('上报限制参数', health.json && health.json.limits && health.json.limits.maxQuestions === 20);

  console.log('\n[2] /api/systemone 官方形状转发');
  const ok = await post(PROXY_PORT, '/api/systemone', {
    state: '标题：dify\n链接：https://github.com/langgenius/dify',
    questions: QUESTIONS
  });
  check('HTTP 200', ok.status === 200, ok.text);
  check('返回 answers', !!(ok.json && ok.json.answers));
  check('上游收到 state', !!(lastRequest && lastRequest.body.state && lastRequest.body.state.indexOf('dify') > -1));
  check('上游收到 model', !!(lastRequest && lastRequest.body.model === 'laya:multilingual'));
  check('上游收到 3 个问题', !!(lastRequest && Object.keys(lastRequest.body.questions || {}).length === 3));
  check('问题 key 原样保留', !!(lastRequest && lastRequest.body.questions.veracity && lastRequest.body.questions.veracity.type === 'noul'));
  check('noul 答案透传', ok.json.answers.veracity.noul === 0.87);
  check('choice 答案透传', ok.json.answers.category.choice === '代码库');
  check('代理返回上游信息', !!(ok.json.upstream && ok.json.upstream.mode === 'ollaya'));

  console.log('\n[3] 校验与容错');
  const badProtocol = await post(PROXY_PORT, '/api/systemone', { state: 'x', questions: { a: { type: 'freeform' } } });
  check('非法 protocol → 400', badProtocol.status === 400, String(badProtocol.status));
  const tooFewOptions = await post(PROXY_PORT, '/api/systemone', { state: 'x', questions: { a: { type: 'choice', criteria: { only: 'one' } } } });
  check('choice 选项不足 → 400', tooFewOptions.status === 400);
  const tooMany = {};
  for (let i = 0; i < 25; i++) tooMany['q' + i] = { type: 'noul', statement: 's' };
  const manyRes = await post(PROXY_PORT, '/api/systemone', { state: 'x', questions: tooMany });
  check('问题数超上限 → 400', manyRes.status === 400);
  const bigState = await post(PROXY_PORT, '/api/systemone', { state: 'x'.repeat(33000), questions: { a: { type: 'noul', statement: 's' } } });
  check('state 超长 → 400', bigState.status === 400);
  const noQuestions = await post(PROXY_PORT, '/api/systemone', { state: 'x' });
  check('缺 questions → 400', noQuestions.status === 400);

  console.log('\n[4] 兼容接口 /api/jev');
  const compat = await post(PROXY_PORT, '/api/jev', {
    protocol: 'noul', question: '是否可信？',
    state: { title: 'dify', url: 'https://github.com/langgenius/dify', source: 'github', snippet: '平台' }
  });
  check('兼容接口 200', compat.status === 200, compat.text);
  check('兼容接口返回 p', !!(compat.json && compat.json.p === 0.87));
  const compatBad = await post(PROXY_PORT, '/api/jev', { protocol: 'unknown' });
  check('兼容接口非法 protocol → 400', compatBad.status === 400);

  console.log('\n[5] 上游不可用时的行为');
  proxy.kill();
  upstream.close();
  await new Promise((r) => setTimeout(r, 400));
  let downErr = null;
  try { await post(PROXY_PORT, '/api/systemone', { state: 'x', questions: { a: { type: 'noul', statement: 's' } } }); }
  catch (e) { downErr = e; }
  check('代理停止后连接失败（前端会回落启发式）', !!downErr);

  console.log('\n============================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('代理测试失败：', e);
  try { if (proxy) proxy.kill(); } catch (err) { /* ignore */ }
  try { upstream.close(); } catch (err) { /* ignore */ }
  process.exit(1);
});
