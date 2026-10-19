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

// ── Google gtx 兜底：腾讯接口被限流/封 IP 时（CI 数据中心 IP 常见）逐条兜底。
//    gtx 是 Google 翻译的公开接口，海外服务器可直连、无需密钥。
const GTX_LANG = { zh: 'zh-CN' };
const GTX_HOSTS = ['translate.googleapis.com', 'clients5.google.com', 'translate.google.com'];
let gtxHostIdx = 0;
let gtxBroken = false; // 限流严重时本次进程不再尝试，避免拖慢构建
let tencentBroken = false; // 腾讯接口不可用（如 CI 海外 IP 被封）时直接跳过，避免每条词都等 25s 超时
let tencentFailStreak = 0;
let gtx429Streak = 0;
let gtxLastAt = 0;

// ── MyMemory 第三层兜底（免费无 key，单条 500 字内）
const MM_LANG = { zh: 'zh-CN' };

async function mmOne(text, from, to) {
  const pair = 'en|' + (MM_LANG[to] || to);
  const url =
    'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text.slice(0, 480)) + '&langpair=' + pair;
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (r.status !== 200) throw new Error('mm HTTP ' + r.status);
  const j = await r.json();
  const v = j && j.responseData && j.responseData.translatedText;
  if (!v || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(v)) throw new Error('mm 限额或空');
  return String(v).trim();
}

async function gtxOne(text, from, to) {
  if (gtxBroken) throw new Error('gtx 已限流');
  const tl = GTX_LANG[to] || to;
  const path =
    '/translate_a/single?client=gtx&dt=t' +
    '&sl=' +
    encodeURIComponent(from === 'auto' ? 'auto' : from) +
    '&tl=' +
    encodeURIComponent(tl) +
    '&q=' +
    encodeURIComponent(text);
  // 限速：gtx 调用间隔至少 1.1s，避免爆发 429
  const wait = gtxLastAt + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  let lastErr;
  // 429 退避重试并轮换域名：2s → 5s → 12s → 30s → 60s → 60s…；连续 14 次被限才放弃
  const BACKOFFS = [2000, 5000, 12000, 30000, 60000, 60000];
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      gtxLastAt = Date.now();
      const r = await fetch('https://' + GTX_HOSTS[gtxHostIdx % GTX_HOSTS.length] + path, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (r.status !== 200) throw new Error('gtx HTTP ' + r.status);
      const j = await r.json();
      const segs = j && j[0];
      if (!Array.isArray(segs) || !segs.length) throw new Error('gtx 返回格式异常');
      const out = segs
        .map((s) => (s && s[0]) || '')
        .join('')
        .trim();
      gtx429Streak = 0;
      return out;
    } catch (e) {
      lastErr = e;
      if (/429/.test(e.message)) {
        gtx429Streak++;
        gtxHostIdx++; // 429 时换下一个域名
        if (gtx429Streak >= 14) {
          gtxBroken = true;
          break;
        }
        await new Promise((res) => setTimeout(res, BACKOFFS[Math.min(attempt, BACKOFFS.length - 1)]));
      } else {
        break; // 非 429（格式/网络）没有重试价值
      }
    }
  }
  throw lastErr || new Error('gtx 失败');
}

// 统一兜底入口：gtx → MyMemory
async function fallbackOne(text, from, to) {
  if (!gtxBroken) {
    try {
      const v = await gtxOne(text, from, to);
      if (v) return v;
    } catch (e) {
      /* 落入 MyMemory */
    }
  }
  try {
    return await mmOne(text, from, to);
  } catch (e) {
    throw new Error('全部兜底失败');
  }
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
    const batchSize = Math.min(50, Math.max(1, Number(opts.batch) || BATCH));
    const batches = [];
    for (let i = 0; i < pending.length; i += batchSize) batches.push(pending.slice(i, i + batchSize));
    let idx = 0;
    let done = 0;
    let dirty = 0;

    async function worker() {
      while (idx < batches.length) {
        const my = batches[idx++];
        if (GAP_MS) await new Promise((r) => setTimeout(r, GAP_MS));
        if (!tencentBroken) {
          try {
            const got = await withRetry(() => tencentTranslate(my, from, to), 3);
            my.forEach((src, i) => {
              const v = String(got[i] == null ? '' : got[i]).trim();
              if (v) {
                // 译文与原文完全相同（品牌名、专有名词）也存下来，避免下次重复请求
                cache[src] = v;
              } else failed++;
            });
            tencentFailStreak = 0;
          } catch (e) {
            tencentFailStreak++;
            // 整批失败时退回逐条翻，避免一条坏数据连坐 19 条；腾讯失败再走 Google gtx 兜底
            for (const one of my) {
              let ok = false;
              try {
                await new Promise((r) => setTimeout(r, 250));
                const g = await withRetry(() => tencentTranslate([one], from, to), 3);
                const v = String(g[0] == null ? '' : g[0]).trim();
                if (v) {
                  cache[one] = v;
                  ok = true;
                }
              } catch (e2) {
                /* 落入 gtx 兜底 */
              }
              if (!ok) {
                try {
                  const v = await fallbackOne(one, from, to);
                  if (v) {
                    cache[one] = v;
                    ok = true;
                  }
                } catch (e3) {
                  /* 兜底也不行，记失败 */
                }
              }
              if (!ok) failed++;
            }
            // 连续 2 批全失败基本可断定腾讯接口不可用（CI 数据中心 IP 被封），
            // 剩下的直接走 gtx，省掉每条 25 秒 × 3 次重试的等待
            if (tencentFailStreak >= 2) tencentBroken = true;
          }
        } else {
          // 腾讯已判定不可用：直接走兜底（gtx → MyMemory）
          for (const one of my) {
            try {
              const v = await fallbackOne(one, from, to);
              if (v) cache[one] = v;
              else failed++;
            } catch (e) {
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
