'use strict';

/**
 * 构建期翻译：把页面会用到的英文（关键词 + 简介 + 每日热榜标题）批量翻成中文，
 * 生成词典供静态站直接查表。这样线上版点「中文」是本地查表，零延迟、不依赖后端。
 *
 * 词典落两份：
 *   data/zh-dict.json   本地累积缓存（增量翻译，只翻新增的）
 *   dist/data/zh.json   随站点一起发布
 */

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'data', 'zh-dict.json');
const BATCH = 20;
const CONCURRENCY = 3;

function hasCJK(s) {
  return /[\u4e00-\u9fa5]/.test(s);
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveCache(c) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c), 'utf8');
  } catch (e) {
    /* 忽略 */
  }
}

/** 腾讯交互翻译（免费公开接口，支持批量，国内直连） */
async function tencentTranslate(texts) {
  const body = JSON.stringify({
    header: { fn: 'auto_translation', client_key: 'browser-chrome-110.0.0' },
    type: 'plain',
    model_category: 'normal',
    source: { lang: 'en', text_list: texts },
    target: { lang: 'zh' },
  });
  const r = await fetch('https://transmart.qq.com/api/imt', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://transmart.qq.com',
      Referer: 'https://transmart.qq.com/',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    body,
    signal: AbortSignal.timeout(25000),
  });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const arr = j && j.auto_translation;
  if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error('返回格式异常');
  return arr;
}

async function withRetry(fn, times) {
  let lastErr = null;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 700 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * 关键词单翻质量差（Cordless Vacuum → “无绳真空”），
 * 给它套一句商品语境再翻，模型能正确识别成“无线吸尘器”。
 */
const KW_TPL = 'product: ';
const KW_PREFIX = /^\s*(产品名称|商品名称|产品|商品|product|Product|PRODUCT)\s*[：:]\s*/;

function stripKwPrefix(s) {
  if (!s) return '';
  const t = String(s)
    .replace(/^[\s"'“”]+|[\s"'“”。.]+$/g, '')
    .replace(KW_PREFIX, '')
    .replace(/^[\s：:]+/, '')
    .trim();
  return t;
}

function isKeyword(s) {
  // 短语：单词数少、没有句末标点
  const words = s.trim().split(/\s+/);
  return words.length <= 4 && !/[.!?]$/.test(s.trim());
}

/**
 * @param {string[]} texts 待翻译文本（已去重的话更快）
 * @param {{onProgress?: (done:number,total:number)=>void, kwPlain?: Set<string>}} opts
 *   kwPlain：这些文本即使是短语也不走「商品语境」模板（热榜里的短查询多是新闻，不是商品名）
 * @returns {Promise<{map:Object, hit:number, added:number, failed:number}>}
 */
async function translateAll(texts, opts) {
  opts = opts || {};
  const cache = loadCache();
  const plain = opts.kwPlain || null;
  const useTpl = (s) => isKeyword(s) && !(plain && plain.has(s));

  const uniq = [];
  const seen = new Set();
  for (const raw of texts || []) {
    const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (!s || s.length > 900 || hasCJK(s) || seen.has(s)) continue;
    seen.add(s);
    uniq.push(s);
  }

  // 短语走「商品语境」通道：缓存 key 加前缀，避免和直译结果混
  const ck = (s) => (useTpl(s) ? '@kw@' + s : s);

  const hit = uniq.filter((s) => cache[ck(s)]).length;
  const todo = uniq.filter((s) => !cache[ck(s)]);
  let failed = 0;

  if (!todo.length) {
    const map = {};
    uniq.forEach((s) => (map[s] = cache[ck(s)]));
    return { map, hit, added: 0, failed: 0 };
  }

  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));

  let done = 0;
  let idx = 0;

  async function worker() {
    while (idx < batches.length) {
      const my = batches[idx++];
      const payload = my.map((s) => (useTpl(s) ? KW_TPL + s : s));
      try {
        const got = await withRetry(() => tencentTranslate(payload), 3);
        my.forEach((src, i) => {
          let zh = String(got[i] == null ? '' : got[i]).trim();
          if (useTpl(src)) zh = stripKwPrefix(zh);
          if (zh && zh !== src) cache[ck(src)] = zh;
          else failed++;
        });
      } catch (e) {
        failed += my.length;
      }
      done += my.length;
      if (opts.onProgress) opts.onProgress(Math.min(done, todo.length), todo.length);
      saveCache(cache);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));

  const map = {};
  uniq.forEach((s) => {
    if (cache[ck(s)]) map[s] = cache[ck(s)];
  });
  return { map, hit, added: Object.keys(map).length - hit, failed };
}

/** 从榜单数据 + 每日快照里收集所有需要翻译的文本 */
function collectTexts(topics, daily) {
  const out = [];
  for (const t of topics || []) {
    if (t.keyword) out.push(t.keyword);
    const d = t.descShort || '';
    if (d) out.push(d);
  }
  if (daily) {
    // 每日快照是 { data: { US: { items:[...] }, GLOBAL: {...} } } 结构，
    // 之前按 daily.articles / daily.items 取，永远取不到 → 热榜整屏没有译文。
    const blocks = [];
    if (daily.data && typeof daily.data === 'object') {
      for (const g of Object.keys(daily.data)) {
        const b = daily.data[g];
        if (b && Array.isArray(b.items)) blocks.push(b);
      }
    }
    // 兼容旧结构 / 单地区返回
    if (!blocks.length) blocks.push(daily);

    for (const b of blocks) {
      for (const it of b.items || []) {
        if (it.query) out.push(it.query);
        for (const r of it.related || []) if (r) out.push(r);
        for (const a of it.articles || []) {
          if (a && a.title) out.push(a.title);
        }
        if (it.category) out.push(it.category);
      }
    }
  }
  return out;
}

/** 热榜文本：短语多是新闻标题/人名，不该套商品语境模板 */
function collectDailyTexts(daily) {
  const out = [];
  if (!daily) return out;
  const blocks = [];
  if (daily.data && typeof daily.data === 'object') {
    for (const g of Object.keys(daily.data)) {
      const b = daily.data[g];
      if (b && Array.isArray(b.items)) blocks.push(b);
    }
  }
  if (!blocks.length) blocks.push(daily);
  for (const b of blocks) {
    for (const it of b.items || []) {
      if (it.query) out.push(it.query);
      for (const r of it.related || []) if (r) out.push(r);
    }
  }
  return out;
}

/** 构建入口：返回完整词典（只保留本次用到的 key，控制体积） */
async function buildDict(topics, daily, opts) {
  const texts = collectTexts(topics, daily);
  const kwPlain = new Set(
    collectDailyTexts(daily).map((s) => String(s).replace(/\s+/g, ' ').trim())
  );
  const r = await translateAll(texts, Object.assign({}, opts, { kwPlain }));
  return r;
}

module.exports = { buildDict, translateAll, collectTexts, collectDailyTexts, tencentTranslate };
