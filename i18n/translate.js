'use strict';

/**
 * 通用批量翻译（腾讯交互翻译公开接口），带按语言维度的增量缓存。
 * 缓存文件：data/i18n/cache-<from>-<to>.json  { 原文: 译文 }
 */

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'i18n');
const BATCH = 20;
const CONCURRENCY = 1;
const GAP_MS = 350;

const LANG_NAME = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
};

function ensureDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cachePath(from, to) {
  return path.join(CACHE_DIR, 'cache-' + from + '-' + to + '.json');
}

function loadCache(from, to) {
  ensureDir();
  try {
    return JSON.parse(fs.readFileSync(cachePath(from, to), 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveCache(from, to, c) {
  try {
    fs.writeFileSync(cachePath(from, to), JSON.stringify(c), 'utf8');
  } catch (e) {
    /* 忽略 */
  }
}

async function tencentTranslate(texts, from, to) {
  const body = JSON.stringify({
    header: { fn: 'auto_translation', client_key: 'browser-chrome-110.0.0' },
    type: 'plain',
    model_category: 'normal',
    source: { lang: from, text_list: texts },
    target: { lang: to },
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
  if (!Array.isArray(arr) || arr.length !== texts.length) {
    const msg = (j && (j.message || (j.header && j.header.ret_code))) || '返回格式异常';
    throw new Error(String(msg));
  }
  return arr;
}

async function withRetry(fn, times) {
  let lastErr = null;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 600 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * @param {string[]} texts
 * @param {{from?:string,to:string,onProgress?:Function,force?:boolean}} opts
 */
async function translate(texts, opts) {
  const from = opts.from || 'en';
  const to = opts.to;
  const cache = loadCache(from, to);

  const uniq = [];
  const seen = new Set();
  for (const raw of texts || []) {
    const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (!s || s.length > 900 || seen.has(s)) continue;
    seen.add(s);
    uniq.push(s);
  }

  const pending = uniq.filter((s) => !cache[s]);
  let failed = 0;

  if (pending.length) {
    const batches = [];
    for (let i = 0; i < pending.length; i += BATCH) batches.push(pending.slice(i, i + BATCH));
    let idx = 0;
    let done = 0;
    let dirty = 0;

    async function worker() {
      while (idx < batches.length) {
        const my = batches[idx++];
        if (GAP_MS) await new Promise((r) => setTimeout(r, GAP_MS));
        try {
          const got = await withRetry(() => tencentTranslate(my, from, to), 3);
          my.forEach((src, i) => {
            const v = String(got[i] == null ? '' : got[i]).trim();
            if (v) {
              // 译文与原文完全相同（品牌名、专有名词）也存下来，避免下次重复请求
              cache[src] = v;
            } else failed++;
          });
        } catch (e) {
          // 整批失败时退回逐条翻，避免一条坏数据连坐 19 条
          for (const one of my) {
            try {
              await new Promise((r) => setTimeout(r, 250));
              const g = await withRetry(() => tencentTranslate([one], from, to), 3);
              const v = String(g[0] == null ? '' : g[0]).trim();
              if (v) cache[one] = v;
              else failed++;
            } catch (e2) {
              failed++;
            }
          }
        }
        done += my.length;
        dirty += my.length;
        if (opts.onProgress) opts.onProgress(Math.min(done, pending.length), pending.length);
        if (dirty >= 200) {
          saveCache(from, to, cache);
          dirty = 0;
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    saveCache(from, to, cache);
  }

  const map = {};
  for (const s of uniq) if (cache[s]) map[s] = cache[s];
  return { map, cached: uniq.length - pending.length, pending: pending.length, failed };
}

module.exports = { translate, tencentTranslate, LANG_NAME, cachePath };
