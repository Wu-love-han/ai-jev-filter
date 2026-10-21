/* ===========================================================
   kb.js — 本地知识库：新建 / 删除 / 增删条目 / 检索 / 持久化
   数据全部存在浏览器 localStorage，不上传任何服务器
   =========================================================== */
(function (global) {
  'use strict';

  var C = global.Core;
  var DATA = global.DATA;
  var KEY = 'kbs';

  function emit() {
    try { global.dispatchEvent(new CustomEvent('kb:changed')); } catch (e) { /* 老浏览器忽略 */ }
  }

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function read() {
    var list = C.Store.get(KEY, null);
    if (!Array.isArray(list)) return null;
    return list;
  }

  function write(list) {
    C.Store.set(KEY, list);
    emit();
  }

  function ensureSeed() {
    var list = read();
    if (list && list.length) return list;
    list = clone(DATA.KB_SEED);
    write(list);
    return list;
  }

  function list() { return ensureSeed(); }

  function get(id) {
    var found = list().filter(function (k) { return k.id === id; });
    return found.length ? found[0] : null;
  }

  function create(name, desc) {
    name = String(name || '').trim();
    if (!name) return { ok: false, error: '知识库名称不能为空' };
    var exists = list().some(function (k) { return k.name === name; });
    if (exists) return { ok: false, error: '已存在同名知识库' };
    var kb = { id: C.uid('kb'), name: name, desc: String(desc || '').trim() || '自建知识库', docs: [] };
    var all = list();
    all.push(kb);
    write(all);
    return { ok: true, kb: kb };
  }

  function remove(id) {
    var all = list().filter(function (k) { return k.id !== id; });
    write(all);
    return { ok: true };
  }

  function rename(id, name, desc) {
    var all = list();
    var kb = all.filter(function (k) { return k.id === id; })[0];
    if (!kb) return { ok: false, error: '知识库不存在' };
    if (name) kb.name = String(name).trim();
    if (desc != null) kb.desc = String(desc).trim();
    write(all);
    return { ok: true, kb: kb };
  }

  function addDoc(id, doc) {
    doc = doc || {};
    var title = String(doc.t || doc.title || '').trim();
    var text = String(doc.d || doc.text || '').trim();
    if (!title) return { ok: false, error: '请填写标题' };
    if (!text) return { ok: false, error: '请填写内容' };
    var all = list();
    var kb = all.filter(function (k) { return k.id === id; })[0];
    if (!kb) return { ok: false, error: '知识库不存在' };
    kb.docs.push({ t: title, d: text, m: doc.m || { doc: kb.name + ' · 手动录入' }, at: Date.now() });
    write(all);
    return { ok: true, doc: kb.docs[kb.docs.length - 1] };
  }

  function removeDoc(id, index) {
    var all = list();
    var kb = all.filter(function (k) { return k.id === id; })[0];
    if (!kb || !kb.docs[index]) return { ok: false, error: '条目不存在' };
    kb.docs.splice(index, 1);
    write(all);
    return { ok: true };
  }

  function stats() {
    var all = list();
    return {
      count: all.length,
      docs: all.reduce(function (s, k) { return s + k.docs.length; }, 0)
    };
  }

  /* 关键词命中排序检索；未命中时回退到最近条目，保证有内容可用 */
  function search(keywords, topK, onlyId) {
    var kws = (keywords || []).filter(Boolean).map(function (w) { return String(w).toLowerCase(); });
    var docs = [];
    list().forEach(function (kb) {
      if (onlyId && kb.id !== onlyId) return;
      kb.docs.forEach(function (doc, idx) {
        var hay = (doc.t + ' ' + doc.d).toLowerCase();
        var hit = kws.filter(function (w) { return hay.indexOf(w) > -1; });
        docs.push({ kb: kb, doc: doc, index: idx, hit: hit.length });
      });
    });
    docs.sort(function (a, b) {
      if (b.hit !== a.hit) return b.hit - a.hit;
      return (b.doc.at || 0) - (a.doc.at || 0);
    });
    var use = docs.filter(function (x) { return x.hit > 0; });
    if (!use.length) use = docs;
    return use.slice(0, topK || 4);
  }

  global.KB = {
    list: list,
    get: get,
    create: create,
    remove: remove,
    rename: rename,
    addDoc: addDoc,
    removeDoc: removeDoc,
    stats: stats,
    search: search,
    ensureSeed: ensureSeed
  };
})(window);
