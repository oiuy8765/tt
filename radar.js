'use strict';

/**
 * 机会雷达（Opportunity Radar）
 *
 * 数据来源：explodingtopics.com —— 该站用 Google Trends 的搜索量数据做了
 * 绝对量估算（vol），并保留每个话题的完整月度历史曲线（180~265 个点，最长
 * 可回溯到 2004 年）。国内可直连，无需代理。
 *
 * 与「每日热搜」的区别：这里给的不是新闻，而是**持续有人在搜的产品/品类/服务**，
 * 所以更适合回答「我能做什么网站 / APP / 产品」。
 *
 * 本模块负责：
 *   1. 抓取全站话题榜单（分页聚合，约 30 页 / 870+ 条）
 *   2. 从历史曲线自行计算 90 天 / 12 个月 / 24 个月增长率、峰值偏离、首次出现
 *   3. 补充话题详情：多级分类、英文简介、各社交平台提及量
 *   4. 计算可解释的「机会分」，并给出可做什么的方向建议
 *
 * 依赖：仅 Node 内置模块。
 */

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'radar.json');
const ENRICH_FILE = path.join(DATA_DIR, 'radar-enrich.json');

const CACHE_TTL = 6 * 3600 * 1000; // 榜单缓存 6 小时
const ENRICH_TTL = 30 * 86400 * 1000; // 详情缓存 30 天
const ENRICH_RETRY = 6 * 3600 * 1000; // 失败后 6 小时可重试

const SITE = 'https://explodingtopics.com';
const LIST_PATH = '/exploding-topics';

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function httpGet(url, opts) {
  opts = opts || {};
  const timeout = opts.timeout || 25000;
  const redirects = opts.redirects == null ? 3 : opts.redirects;

  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).href;
          return resolve(httpGet(next, Object.assign({}, opts, { redirects: redirects - 1 })));
        }
        let stream = res;
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
          else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
          else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        } catch (e) {
          /* 解压流创建失败时退回原始流 */
        }
        let body = '';
        stream.setEncoding('utf8');
        stream.on('data', (d) => (body += d));
        stream.on('end', () => resolve({ status: code, body }));
        stream.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时：' + url)));
  });
}

/** 从 Next.js 页面里抠出 `__NEXT_DATA__ = {...}`（用括号计数，避免正则截断） */
function extractNextData(html) {
  const marker = '__NEXT_DATA__ = ';
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const s = i + marker.length;

  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;

  for (let k = s; k < html.length; k++) {
    const c = html[k];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\' && inStr) {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        end = k + 1;
        break;
      }
    }
  }
  if (end < 0) return null;
  try {
    return JSON.parse(html.slice(s, end));
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 指标计算                                                            */
/* ------------------------------------------------------------------ */

function clamp01(v) {
  if (!isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v, a, b) {
  if (!isFinite(v)) return a;
  return v < a ? a : v > b ? b : v;
}

function avgOf(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function ymOf(ts) {
  const d = new Date(ts * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

/**
 * 任意窗口增长率：最近 w 个月均值 vs 之前 w 个月均值。
 * 历史长度不足 2w 时返回 null（宁可不给结论，也不拿半段数据硬算）。
 */
function growthOver(values, w) {
  const n = values.length;
  if (n < 2 * w) return null;
  const cur = avgOf(values.slice(n - w, n));
  const prev = avgOf(values.slice(n - 2 * w, n - w));
  if (prev > 0) return Math.round(((cur - prev) / prev) * 1000) / 10;
  return cur > 0 ? 300 : 0;
}

/**
 * 起量拐点：这条词是「什么时候开始涨的」。
 *
 * 做法是从最新一个月往回走，用 3 月滑动均值消除单月噪音，只要前一个月不比
 * 当前高太多（容忍 15% 回撤）就继续往回，直到遇到明显的下跌平台。停下来那
 * 一点就是本轮上升的起点。
 *
 * 这比「90 天涨了 199%」有用得多：涨 199% 可能是一路涨了五年，也可能是三个
 * 月前一根直线——后者才是还能进场的机会。
 */
function inflectionOf(values, pts) {
  const n = values.length;
  if (n < 12) return null;

  const ma = [];
  for (let i = 0; i + 2 < n; i++) ma.push((values[i] + values[i + 1] + values[i + 2]) / 3);
  const m = ma.length;
  if (m < 6) return null;

  let j = m - 1;
  while (j > 0 && ma[j - 1] <= ma[j] * 1.15) j--;

  const to = ma[m - 1];
  const from = ma[j];
  if (to < 5) return null; // 现在都没量，谈不上起势
  if (j === 0 && m > 120) return null; // 二十年一路在涨，没有明确拐点
  if (from > 0 && to / from < 1.3) return null; // 涨不到 30%，只是正常波动

  const startIdx = Math.min(j + 2, n - 1);
  const months = n - 1 - startIdx;
  // 十年以上一路在涨，那是长期品类，不叫「起量」，说了也没用
  if (months > 120) return null;
  return {
    at: ymOf(pts[startIdx].time),
    months,
    from: Math.round(from * 10) / 10,
    to: Math.round(to * 10) / 10,
    gain: from > 0 ? Math.round((to / from - 1) * 100) : null,
    // 五年以上算「长期爬坡」，跟「新起量」在文案上要分开说
    long: months >= 60,
  };
}

/**
 * 近 24 个月里的二次加速点。
 *
 * 有些词 2020 年就起量了，最近又涨了一波（比如 Shoe bag 近 90 天 +198%）。
 * 只看「本轮起量」会漏掉这种「老词新机会」，所以再单独找一次近两年的低点。
 */
function recentBreakOf(values, pts) {
  const n = values.length;
  if (n < 18) return null;
  const ma = [];
  for (let i = 0; i + 2 < n; i++) ma.push((values[i] + values[i + 1] + values[i + 2]) / 3);
  const m = ma.length;
  const span = Math.min(24, m);
  let k = m - span;
  let low = ma[k];
  for (let i = k; i < m; i++) {
    if (ma[i] < low) {
      low = ma[i];
      k = i;
    }
  }
  const to = ma[m - 1];
  // 低点正好落在窗口起点，说明是「一路在涨」，不是二次加速，这种情况留给 inflection 说
  if (k <= m - span + 2) return null;
  if (low <= 0 || to / low < 1.6) return null; // 涨不到 60%，不算二次起势
  const startIdx = Math.min(k + 2, n - 1);
  const months = n - 1 - startIdx;
  if (months < 2) return null; // 这个月刚开始涨，样本太短
  return {
    at: ymOf(pts[startIdx].time),
    months,
    from: Math.round(low * 10) / 10,
    to: Math.round(to * 10) / 10,
    gain: Math.round((to / low - 1) * 100),
  };
}

/**
 * 从月度序列里算出各周期增长率。
 * 用「区间均值」比较，而不是首末两点，避免单月异常值和季节性造成误判。
 */
function analyzeHistory(sh) {
  if (!Array.isArray(sh) || sh.length < 6) return null;
  const pts = sh
    .filter((p) => p && isFinite(p.value) && isFinite(p.time))
    .slice()
    .sort((a, b) => a.time - b.time);
  if (pts.length < 6) return null;

  const n = pts.length;
  const values = pts.map((p) => Number(p.value) || 0);
  const last = values[n - 1];
  const peak = Math.max.apply(null, values);

  const seg = (from, to) => values.slice(Math.max(0, from), Math.max(0, to));

  // 近 3 个月 vs 之前 3 个月 —— 这就是「过去 90 天」
  const cur3 = avgOf(seg(n - 3, n));
  const prev3 = avgOf(seg(n - 6, n - 3));

  // 近 12 个月 vs 之前 12 个月
  const cur12 = avgOf(seg(n - 12, n));
  const prev12 = avgOf(seg(n - 24, n - 12));

  // 近 24 个月 vs 之前 24 个月
  const cur24 = avgOf(seg(n - 24, n));
  const prev24 = n >= 48 ? avgOf(seg(n - 48, n - 24)) : 0;

  let g90 = prev3 > 0 ? ((cur3 - prev3) / prev3) * 100 : cur3 > 0 ? 300 : 0;
  let g12 = prev12 > 0 ? ((cur12 - prev12) / prev12) * 100 : cur12 > 0 ? 300 : 0;
  let g24 = prev24 > 0 ? ((cur24 - prev24) / prev24) * 100 : 0;

  // 从零起量的新词，增长率会除零，统一封顶到 300% 并打标记
  const isNew = prev3 <= 0 && cur3 > 0;
  if (isNew) g90 = 300;
  if (!isFinite(g90)) g90 = 0;
  if (!isFinite(g12)) g12 = 0;
  if (!isFinite(g24)) g24 = 0;

  // 首次出现（第一个有效搜索量的月份）
  let firstIdx = values.findIndex((v) => v >= 1);
  if (firstIdx < 0) firstIdx = 0;

  const fromPeak = peak > 0 ? Math.round((last / peak) * 100) / 100 : 0;

  /* ---- 季节性：最近 36 个月，按日历月聚合 ----
     每年先各自归一化再平均，避免整体增长趋势把「越靠后的月份越强」伪装成季节。 */
  const byYear = {};
  pts.slice(-36).forEach((p) => {
    const d = new Date(p.time * 1000);
    const y = d.getUTCFullYear();
    (byYear[y] = byYear[y] || []).push({ m: d.getUTCMonth() + 1, v: Number(p.value) || 0 });
  });
  const monthAcc = {};
  Object.keys(byYear).forEach((y) => {
    const arr = byYear[y];
    if (arr.length < 10) return; // 只取基本完整的年份
    const mx = Math.max.apply(null, arr.map((a) => a.v)) || 1;
    arr.forEach((a) => {
      (monthAcc[a.m] = monthAcc[a.m] || []).push(a.v / mx);
    });
  });

  let season = null;
  const monthVals = [];
  for (let m = 1; m <= 12; m++) {
    const vs = monthAcc[m];
    monthVals.push(vs && vs.length ? avgOf(vs) : null);
  }
  const validMs = monthVals.filter((x) => x != null);
  if (validMs.length >= 10) {
    const mx = Math.max.apply(null, validMs);
    const mn = Math.min.apply(null, validMs);
    season = {
      months: monthVals.map((x) => (x == null ? null : Math.round(x * 100) / 100)),
      peakMonth: monthVals.indexOf(mx) + 1,
      lowMonth: monthVals.indexOf(mn) + 1,
      // 0 = 全年平坦，1 = 高峰月是低谷月的 2 倍以上
      strength: Math.round(((mx - mn) / (mx || 1)) * 100) / 100,
    };
  }

  /* ---- 波动率：近 24 个月环比绝对变化的均值 / 均值。高波动=事件驱动而非稳定需求 ---- */
  let volatility = 0;
  const last24v = values.slice(-24);
  if (last24v.length >= 12) {
    const mean = avgOf(last24v) || 1;
    const diffs = [];
    for (let i = 1; i < last24v.length; i++) diffs.push(Math.abs(last24v[i] - last24v[i - 1]));
    volatility = Math.round((avgOf(diffs) / mean) * 100) / 100;
  }

  /* ---- 连续下滑月数：比 fromPeak 更早预警衰退 ---- */
  let declineMonths = 0;
  for (let i = values.length - 1; i > 0; i--) {
    if (values[i] < values[i - 1]) declineMonths++;
    else break;
  }

  /* ---- 可选的观察窗口：让用户自己选「多长时间内算在涨」 ----
     月粒度数据，窗口就按自然月给：1 / 3 / 6 / 12 / 24 个月。 */
  const trend = {
    m1: growthOver(values, 1),
    m3: growthOver(values, 3),
    m6: growthOver(values, 6),
    m12: growthOver(values, 12),
    m24: growthOver(values, 24),
  };

  return {
    g90: Math.round(g90 * 10) / 10,
    g12: Math.round(g12 * 10) / 10,
    g24: Math.round(g24 * 10) / 10,
    peak,
    current: last,
    fromPeak,
    firstSeen: ymOf(pts[firstIdx].time),
    lastMonth: ymOf(pts[n - 1].time),
    months: n,
    isNew,
    spark: values.slice(-24),
    // 完整月度序列（最长 269 点，回溯到 2004 年）。
    // 之前只存末 24 点，长周期图和拐点检测都做不了，等于把数据源给的历史白扔了。
    hist: {
      // 上游有些词的 time 是字符串，不转数字会变成字符串拼接（→ Invalid time value）
      t0: Number(pts[0].time),
      step: pts.length > 1 ? Number(pts[1].time) - Number(pts[0].time) : 2592000,
      v: values.map((v) => Math.round(v * 10) / 10),
    },
    inflection: inflectionOf(values, pts),
    recentBreak: recentBreakOf(values, pts),
    longTrend: { m60: growthOver(values, 60), m120: growthOver(values, 120) },
    season,
    volatility,
    declineMonths,
    trend,
    // 长青词：10 年以上历史 + 12 个月温和上涨 + 波动很低 + 仍在峰值附近
    evergreen: n >= 120 && g12 > 10 && g12 < 100 && volatility > 0 && volatility < 0.13 && fromPeak >= 0.75,
  };
}

/* ---- 变现潜力：按类目推断（不是实测 CPC，界面上会注明） ---- */

const CAT_VALUE = {
  finance: 0.95,
  insurance: 0.95,
  investing: 0.92,
  legal: 0.9,
  'cybersecurity': 0.9,
  software: 0.9,
  technology: 0.85,
  business: 0.85,
  marketing: 0.85,
  medical: 0.85,
  supplements: 0.8,
  health: 0.75,
  productivity: 0.78,
  'artificial-intelligence': 0.85,
  education: 0.6,
  travel: 0.6,
  ecommerce: 0.7,
  retail: 0.6,
  product: 0.68,
  cpg: 0.6,
  beauty: 0.6,
  'personal-care': 0.58,
  fashion: 0.55,
  'home': 0.55,
  'home-improvement': 0.6,
  'food-beverage': 0.45,
  food: 0.45,
  nutrition: 0.55,
  fitness: 0.55,
  'sports-outdoors': 0.45,
  entertainment: 0.35,
  gaming: 0.4,
  'social-media': 0.3,
  music: 0.3,
  streaming: 0.35,
  art: 0.35,
  pets: 0.55,
  automotive: 0.6,
  realestate: 0.8,
};

function valueOfCategories(cats) {
  if (!cats || !cats.length) return 0.5; // 未知时取中性值
  let best = 0;
  for (const c of cats) {
    const k = String(c).toLowerCase();
    if (CAT_VALUE[k] != null) best = Math.max(best, CAT_VALUE[k]);
  }
  if (best > 0) return best;
  // 部分匹配
  for (const c of cats) {
    const k = String(c).toLowerCase();
    for (const key of Object.keys(CAT_VALUE)) {
      if (k.includes(key) || key.includes(k)) best = Math.max(best, CAT_VALUE[key]);
    }
  }
  return best || 0.5;
}

/* ---- 品牌词识别：这类词搜的是「已有公司」，不是可切入的机会 ---- */

const BRAND_PATTERNS = [
  /\bbrand\b.*\bknown for\b/i,
  /\bis (a|an) [a-z ]*(company|brand|retailer|chain|corporation|manufacturer)\b/i,
  /\b(company|corporation|provider|platform|service) (providing|offering|that provides|specializing|known for)\b/i,
  /\b(online )?marketplace (where|that|and app)\b/i,
  /^online marketplace\b/i,
  /\b(app|platform|website|service|tool) (where|that allows|that lets|used to)\b/i,
  /\b(subscription|streaming) (service|platform)\b/i,
  /\bfounded in \d{4}\b/i,
  /\bheadquartered\b/i,
  /\bsubsidiary of\b/i,
];

function looksLikeBrand(t, desc) {
  const d = String(desc || '');
  if (d) {
    for (const re of BRAND_PATTERNS) if (re.test(d)) return true;
  }
  // 搜索量极大且是单个专有名词（首字母大写），基本是品牌/巨头
  const words = String(t.keyword || '').trim().split(/\s+/);
  const proper = /^[A-Z]/.test(t.keyword || '');
  if (t.vol >= 5000000 && words.length <= 2) return true;
  if (proper && words.length === 1 && t.vol >= 1000000 && !d) return true;
  return false;
}

/* ---- 机会分 ---- */

/**
 * 规模「甜点区」：2 万~20 万/月最理想。
 * 太小赚不到钱，太大是红海或巨头地盘。
 */
function scaleSweet(vol) {
  if (!vol || vol <= 0) return 0.1;
  const lv = Math.log10(vol);
  if (lv >= 4.3 && lv <= 5.3) return 1; // 20k ~ 200k
  if (lv < 4.3) return clamp(0.35 + ((lv - 3) / 1.3) * 0.65, 0.12, 1); // 1k→0.35, 20k→1
  return clamp(1 - ((lv - 5.3) / 1.3) * 0.7, 0.18, 1); // 200k→1, 2M→0.3, 20M→0.18
}

/** 机会分：0~100，四项加权，公式在界面上原样展示，可自行核对 */
function scoreOf(t) {
  const growth = clamp01(Math.log10(1 + Math.max(0, t.g90)) / Math.log10(201)); // 90 天 +200% 满分
  const scale = scaleSweet(t.vol);
  const money = clamp01(t.value == null ? 0.5 : t.value);
  const social = t.socialTotal > 0 ? clamp01(Math.log10(1 + t.socialTotal) / Math.log10(2001)) : 0.4;

  let raw = 0.35 * growth + 0.25 * scale + 0.2 * money + 0.2 * social;

  // 已过峰 / 品牌词 / 量太小：直接压分
  if (t.fromPeak > 0 && t.fromPeak < 0.4) raw *= 0.55;
  if (t.brand) raw *= 0.4;
  if (t.vol > 0 && t.vol < 1000) raw *= 0.6;

  return {
    score: Math.round(clamp(raw, 0, 1) * 1000) / 10,
    parts: {
      growth: Math.round(growth * 100),
      scale: Math.round(scale * 100),
      money: Math.round(money * 100),
      social: Math.round(social * 100),
    },
  };
}

/** 机会类型：把「能不能做、值不值得做」翻译成一个短标签 */
function typeOf(t) {
  if (t.brand) return { key: 'brand', label: '品牌词', hint: '搜的是已有公司/产品，不是你我能切入的机会' };
  if (t.fromPeak > 0 && t.fromPeak < 0.4) return { key: 'fading', label: '已过峰', hint: '当前热度不足峰值四成，谨慎进入' };
  if (t.vol > 0 && t.vol < 1000) return { key: 'tiny', label: '量太小', hint: '月搜索量不足千次，短期内难变现' };
  if (t.vol < 10000 && t.g90 >= 80) return { key: 'seed', label: '早期蓝海', hint: '盘子还小但在快速起量，适合先用内容或小工具占位' };
  if (t.vol >= 10000 && t.vol <= 200000 && t.g90 >= 40) return { key: 'rising', label: '快速增长', hint: '需求明确在涨、规模适中，是最适合小团队切入的区间' };
  if (t.vol > 500000) return { key: 'red', label: '红海', hint: '需求巨大但竞争激烈，需要极强差异化' };
  if (t.vol >= 100000) return { key: 'scale', label: '有规模', hint: '市场够大，可以做成正经生意' };
  return { key: 'steady', label: '平缓', hint: '趋势不明显，适合先观察' };
}

const TYPE_RANK = { rising: 0, seed: 1, scale: 2, steady: 3, red: 4, tiny: 5, fading: 6, brand: 7 };

/* ---- 可做什么：按类目给方向 ---- */

/* ------------------------------------------------------------------ */
/* 数字产品机会判定                                                    */
/*                                                                     */
/* 榜单里既有「需求词」（如 metadata remover），也有「公司/产品名」      */
/* （如 Fleetio）。前者可以直接做，后者代表赛道已被验证。两者必须分开。  */
/* ------------------------------------------------------------------ */

/* 实物品类：需要供应链，不适合纯线上团队 */
const PHY_CAT =
  /product\b|cpg|fashion|apparel|clothing|shoes|jewelry|beauty|personal-care|skincare|hair\b|nailcare|kitchen|furniture|home-decor|garden|food\b|food-beverage|beverage|supplement|nutrition|automotive|manufacturing|construction|energy\b|solar|agriculture|textile|packaging|hardware/i;

/* 实物名词（出现在关键词里基本就是卖货的） */
const PHY_KW =
  /\b(chair|mattress|powder|gum|strip|printer|camera|monitor|pan|cooker|racket|shoes|dress|cream|serum|toner|bottle|bag|mug|blanket|pillow|lamp|sofa|table|knife|blender|vacuum|stroller|panel|battery|charger|cable|watch|bracelet|jacket|hoodie|jeans|sneaker|perfume|shampoo|vitamin|protein|snack|coffee|wine|beer|meat|cheese|file)\b/i;

/* 数字/线上品类 */
const DIG_CAT =
  /software|technology|artificial|cybersecurity|productivity|developer|saas|internet|automation|fintech|\bdata\b|marketing|ecommerce|hr\b|education|media|entertainment|finance|insurance|gaming|social-media|telecommunication|startup|business|workplace|lifestyle|healthcare|mental-health|travel/i;

/* 关键词里的「线上产品」意图词 */
const DIG_KW =
  /\b(ai|app|apps|application|tool|tools|software|saas|bot|gpt|chatbot|generator|calculator|converter|downloader|editor|detector|remover|tracker|planner|builder|maker|creator|automation|automate|dashboard|analytics|crm|erp|platform|api|extension|plugin|website|site|online|digital|cloud|cyber|data|agent|agentic|no-?code|low-?code|automated|stream|streaming|social|subscription|remote|virtual|management|system)\b/i;

/* 描述里的线上产品特征 */
const DIG_DESC =
  /\b(app|application|software|platform|online|digital|tool|website|web|subscription|users|download|cloud|ai|algorithm|dashboard|browser|extension|mobile|saas|api|server|data)\b/i;

/* 公司自我定义（"X is a company/startup..."）。注意不能用裸的 organization/company，
   否则 "within an organization by providing..." 这类正常描述会被误伤。 */
const COMPANY_DESC =
  /\b(is|are|was)\s+(a|an)\s+[a-z ,-]{0,44}\b(company|startup|corporation|firm|organization|platform company)\b|\b(company|startup|corporation|firm)\s+(that|which|based|founded|providing|offering|specializing|dedicated)\b|\b(organization|organisation|agency)\s+(that|which|dedicated|focused|providing)\b|\bfounded in \d{4}\b|\bestablished in \d{4}\b|\b(headquartered|based) in [A-Z][a-z]+|\b(inc\.|ltd\.?|gmbh|corp\.)\b|\bprovider of\b|\b(leading )?(developer|manufacturer) of\b/i;

/* 服务型需求（线上只能承接获客，交付靠人） */
const SERVICE_KW =
  /\b(service|services|cleaning|repair|installation|installer|moving|movers|delivery|consulting|consultant|coaching|therapy|therapist|treatment|dentist|dental|lawyer|attorney|legal|clinic|salon|spa|contractor|plumber|electrician|landscaping|roofing|hvac|agency|outsourcing|staffing|recruiting|training|course|bootcamp|degree|school|university|certification|insurance|loan|mortgage|refinanc\w*)\b/i;

/* 强实物后缀：即使命中通用品类词，也几乎确定是卖货 */
const PHY_STRONG =
  /\b(mattress|stroller|vacuum|printer|sprayer|blender|cooker|kettle|toaster|air ?fryer|purifier|humidifier|dehumidifier|heater|fan|heater|sofa|recliner|dresser|wardrobe|headboard|curtain|rug|mug|tumbler|bottle|flask|backpack|handbag|purse|wallet|luggage|suitcase|jeans|blazer|dress|skirt|hoodie|sweater|jacket|leggings|sneaker|boot|sandal|slipper|watch|necklace|earring|ring|bracelet|perfume|cologne|shampoo|conditioner|serum|cream|lotion|sunscreen|toothpaste|razor|trimmer|dryer|straightener|curler|treadmill|dumbbell|kettlebell|yoga mat|tent|sleeping bag|cooler|grill|smoker|planter|hose|sprinkler|generator|chainsaw|drill|saw|toolbox|ladder|tile|flooring|paint|caulk|insulation)\b/i;

/* 消费电子 / 硬件：这类词即使挂在 technology 类目下、描述里满是 digital，
   最终也是卖货（USB-C DAC、扩展坞、监听耳机）。单独一张表，
   是因为它还要用来打「消费电子」标签——混进 PHY_KW 会把护肤品 toner 也打上电子标签。 */
const HARDWARE_KW =
  /\b(dac|dongle|docking station|usb hub|ssd|hdd|nas|router|modem|webcam|microphone|soundbar|projector|headphones?|headset|earbuds?|earphones?|keyboard|power bank|power strip|surge protector|smartwatch|dash ?cam|action camera|security camera|cctv camera|graphics card|motherboard|hdmi|ethernet|phone case|laptop stand|monitor stand|tripod|gimbal|ring light|desk lamp|flip phone|e-?reader|kindle)\b/i;

/* 描述里的实物特征：套装清单、配件、材质、「是一台设备」。
   软件描述不会出现「kit includes a brick/sensors」这类句子。 */
const PHY_DESC =
  /\b(kit includes|includes [^.]{0,40}(brick|sensors?|cables?|charger|controller)|offering a range of [^.]{0,40}(equipment|rackets?|accessories|products)|(?:is|are) (?:a|an) [^.]{0,60}\b(?:device|gadget|hardware|accessory)\b(?=\s*(?:that|which|with|for|used|designed|built|featuring|made)\b|[.,;])|accessories for (?:laptops?|tablets?|smartphones?|phones?|cameras?|mobile devices?)|made (?:of|from) (?:steel|aluminum|aluminium|leather|cotton|fabric|silicone|wood|bamboo|ceramic))\b/i;

const B2B_HINT =
  /\b(business|businesses|companies|teams|organizations|enterprise|workflow|employee|payroll|invoice|billing|compliance|hr|sales|supply chain|logistics|inventory|clients|agencies)\b/i;

const MOBILE_HINT = /\b(app|mobile|ios|android|iphone|smartphone)\b/i;

const TOOL_SUFFIX =
  /\b(generator|calculator|converter|remover|downloader|editor|checker|maker|builder|template|tracker|formatter|compressor|transcriber|summarizer|translator|extractor|parser|validator|detector|scanner|remover)\b/i;

const FORM_LABEL = {
  saas: 'SaaS / B 端工具',
  app: '消费级 APP',
  tool: '工具站',
  content: '内容站 / 数据库',
  goods: '实物商品',
};

/* ------------------------------------------------------------------ */
/* 「可以做什么」建议：组合式生成                                       */
/*                                                                     */
/* 老做法是一个形态一句话：871 条话题只有 18 种文案，翻两页就全是复读。   */
/* 现在拆成三段——动作（吃关键词）× 对象（来自品类）× 时机（来自这条词    */
/* 自己的收录时长 / 涨幅 / 季节 / 主战场）。每条模板带 id，多语言站点可以  */
/* 按 id 取各语言的模板再填变量，不用把整句重新翻一遍。                   */
/* ------------------------------------------------------------------ */

/** id → 中文模板。构建多语言词典时以它为源 */
const ADVICE_TPL = {};

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
/** 同一个词 + 同一个位置，永远取到同一条，重建不会跳 */
function pick(arr, seed) {
  return arr[hashStr(seed) % arr.length];
}
function fillTpl(s, map) {
  return s.replace(/\[\[(\w+)\]\]/g, (m, k) => (map[k] == null ? m : map[k]));
}

/** 给模板池编号：字符串 / {t,re} 两种写法都收 */
function regPool(prefix, arr) {
  return arr.map((x, i) => {
    const id = prefix + '.' + (i + 1);
    const tpl = typeof x === 'string' ? x : x.t;
    ADVICE_TPL[id] = tpl;
    return { id, t: tpl, re: typeof x === 'string' ? null : x.re || null };
  });
}

/** 模板可带 re 限定：只用在语义对得上的品类上，配不上就整池回退 */
function pickAct(pool, ctx, seed) {
  const ok = pool.filter((x) => !x.re || x.re.test(ctx));
  const list = ok.length ? ok : pool;
  return list[hashStr(seed) % list.length];
}

/** 这条词最终服务的「谁」。空泛的「中小企业」不如一个具体角色有信息量 */
const SCENES = [
  { key: 'who.beauty', re: /beauty|skincare|hair|nail|makeup|personal-care|spa\b/i, who: '美妆店和个护卖家' },
  { key: 'who.fitness', re: /fitness|wellness|nutrition|supplement|yoga|gym/i, who: '私教和健身工作室' },
  { key: 'who.clinic', re: /health|medical|dental|clinic|therapy|mental|pharma/i, who: '诊所和私人医生' },
  { key: 'who.food', re: /food|beverage|restaurant|recipe|cafe|coffee|bakery/i, who: '餐厅和咖啡馆' },
  { key: 'who.auto', re: /automotive|car\b|cars\b|vehicle|motorcycle|tire/i, who: '修理厂和二手车商' },
  { key: 'who.realty', re: /realestate|real-estate|property|rental|landlord/i, who: '中介门店和房东' },
  { key: 'who.edu', re: /education|course|learning|student|school|training|tutor/i, who: '培训机构和独立老师' },
  { key: 'who.travel', re: /travel|tourism|hospitality|hotel|airbnb|flight/i, who: '民宿和地接社' },
  { key: 'who.finance', re: /finance|accounting|invoice|tax\b|insurance|legal|law\b|loan/i, who: '代账公司和保险经纪' },
  { key: 'who.seller', re: /ecommerce|retail|shopify|amazon|seller|dropship/i, who: '跨境卖家和独立站店主' },
  { key: 'who.hr', re: /hr\b|recruit|staffing|payroll|workforce/i, who: '中小企业的 HR' },
  { key: 'who.trades', re: /construction|contractor|plumbing|roofing|hvac|landscaping|cleaning|repair|electric/i, who: '本地施工和服务商' },
  { key: 'who.tech', re: /software|developer|technology|\bdata\b|artificial|\bai\b|cybersecurity|productivity|saas/i, who: '中小技术团队' },
  { key: 'who.pet', re: /pet|animal|dog|cat\b/i, who: '宠物店和宠物医院' },
];
for (const x of SCENES) ADVICE_TPL[x.key] = x.who;
ADVICE_TPL['who.users'] = '它的现有用户';
ADVICE_TPL['who.smb'] = '一类具体的小客户';

function sceneOf(t) {
  const kw = String(t.keyword || '').toLowerCase();
  const primary = (t.categories || []).slice(0, 2).join(' ').toLowerCase();
  const all = (t.categories || []).join(' ').toLowerCase();
  const test = (s) => {
    if (!s) return null;
    for (const x of SCENES) if (x.re.test(s)) return x;
    return null;
  };
  return (
    test(kw) ||
    test(primary) ||
    test(all) || { key: t.digitalKind === 'company' ? 'who.users' : 'who.smb', who: ADVICE_TPL[t.digitalKind === 'company' ? 'who.users' : 'who.smb'] }
  );
}

const FORM_PRICE = {
  tool: { id: 'price.tool', t: '$9/月' },
  saas: { id: 'price.saas', t: '$19/席位/月' },
  app: { id: 'price.app', t: '$4.99 买断或订阅' },
  content: { id: 'price.content', t: '会员 $5/月' },
};
for (const k of Object.keys(FORM_PRICE)) ADVICE_TPL[FORM_PRICE[k].id] = FORM_PRICE[k].t;

/** 动作池：按载体 / 形态 / 性质分叉，每条都是能当天开始做的一步 */
const ACT_WEB = {
  tool: regPool('act.tool', [
    '把「[[KW]]」做成只干一件事的在线工具：一个输入框、一个结果页，不登录也能用，一周能上线。',
    '先出免费版「[[KW]]」工具，单次限量，Pro 解锁批量，[[PRICE]]；这类词的付费来自反复用，不是功能多。',
    '把「[[KW]]」做成浏览器插件，用户在原来的页面里就能调用，省掉「让人记住你的站」这一步。',
    '围绕「[[KW]]」铺 30 个长尾问答页（怎么做、多少钱、哪个好），先用内容吃词，再把流量导进工具页。',
    '做一张「[[KW]]」对比表：把市面方案列全、标价、标缺点，靠这张表接联盟佣金，比自研快得多。',
    '把「[[KW]]」包成 API 或脚本，不抢 C 端流量，按调用量卖给[[WHO]]，客单价高、没有退货。',
    '先在相关社群发一个免费的「[[KW]]」小工具，收满 100 个邮箱再决定要不要做付费版。',
  ]),
  saas: regPool('act.saas', [
    '只服务一类客户：把「[[KW]]」做成[[WHO]]每天都要打开的那个小工具，[[PRICE]]，先签 10 家再写代码。',
    '从「[[KW]]」的表格模板切入：免费模板换邮箱，再卖多人协作和自动汇总，按团队收年费。',
    '不要做全流程，只做「[[KW]]」里最烦的那一步（导入、对账、导出），单点做到最好，[[PRICE]]。',
    '「[[KW]]」现在多半是靠表格加微信群在撑：把这两样接上，就是[[WHO]]愿意付钱的理由。',
    '同一套「[[KW]]」内核，给 3 个行业各做一层皮，按年费卖，单价能翻三倍。',
    '先人工代做「[[KW]]」这件事（concierge MVP），跑通 20 单再产品化，别做出来没人用。',
    { t: '把「[[KW]]」做成[[WHO]]的对账/报价单工具：他们不缺系统，缺的是能直接发给客户的那张纸。', re: /financ|account|invoice|tax|legal|insurance|construct|contractor|retail|shop|clinic|service/i },
  ]),
  app: regPool('act.app', [
    '切一类人的单一痛点做「[[KW]]」：先上 iOS 单端，用 [[PLATFORM]] 的短视频做冷启动。',
    '把「[[KW]]」做成「记录 + 提醒」型轻应用，不碰重功能，靠订阅解锁云同步。',
    '「[[KW]]」先做小程序或网页版验证留存，7 日留存过 20% 再投入做原生 App。',
    { t: '做「[[KW]]」的相机/相册类单点功能，靠 ASO 吃自然量，内购解锁高级处理。', re: /photo|image|camera|video|scan|edit|filter|selfie|screenshot|ocr|pdf/i },
    '围绕[[WHO]]做「[[KW]]」的陪伴型工具，前期靠内容社区养用户，别一上来买量。',
    '把「[[KW]]」做成可离线用的小工具，主打「打开就有结果」，用评分和口碑换自然下载。',
  ]),
  content: regPool('act.content', [
    '建一个「[[KW]]」数据库站：条目结构化，一条一个页面，靠长尾搜索吃流量，会员或联盟变现。',
    '做「[[KW]]」的对比与评测站，只回答「哪个更值」，靠联盟佣金变现，比做工具轻。',
    '把「[[KW]]」拆成 50 个具体问题做问答页，先占长尾，再补一个计算器把人留下来。',
    { t: '做一个「[[KW]]」价格追踪页，每周更新一次，用户会为「随时能查」反复回来，广告单价也高。', re: /product|price|deal|buy|shop|retail|ecommerce|ticket|flight|hotel|rent|insurance|loan/i },
    '用「[[KW]]」做一份可下载的清单或模板，换邮箱建名单，再卖后续的付费报告。',
    { t: '把「[[KW]]」做成城市/品类目录站，[[WHO]]愿意为曝光付月费，比流量广告稳定。', re: /local|service|restaurant|clinic|contractor|realestate|property|travel|rental|repair|salon|gym|dentist|lawyer/i },
    '给「[[KW]]」做一份年度数据报告，靠被引用和转载获客，再卖定制版给[[WHO]]。',
  ]),
};

const ACT_GOODS = regPool('act.goods', [
  '找「[[KW]]」的 1688 同款做贴牌，先测 3 个 SKU，用 [[PLATFORM]] 的实拍短视频投流验证转化。',
  '做「[[KW]]」的垂类独立站，只卖这一品类，配一组对比测评页吃长尾，别做杂货铺。',
  '先在亚马逊小批量试「[[KW]]」，把物流和退货算进去，毛利不到 40% 就别做。',
  '「[[KW]]」是实物，门槛在供应链：先找两家工厂打样，用预售测需求再备货。',
  '做「[[KW]]」的选购指南加联盟链接，不压货，验证有量再考虑自营。',
  { t: '「[[KW]]」适合做套装和耗材生意：单件引流，靠复购的配件赚钱。', re: /razor|blade|refill|cartridge|filter|pod|pad|sheet|ink|toner|brush|replacement|consumable|coffee|tea|supplement|vitamin|skincare|serum|cream|cleaner/i },
  '先给「[[KW]]」做一轮差评分析，把用户最烦的三点改掉，再拿这三点当详情页卖点。',
  { t: '「[[KW]]」这种新硬件适合先做众筹或预售页：用真实订单判断要不要开模。', re: /device|gadget|hardware|tool|equipment|machine|furniture|light|speaker|robot|printer|bike|scooter|drone|3d/i },
]);

const ACT_COMPANY = regPool('act.company', [
  '「[[KW]]」已经有人在做，说明需求被验证：别做同款，去做它的替代方案对比页，抢 “[[KW]] alternative” 这类搜索。',
  '把「[[KW]]」当赛道信号：扒它的定价页和差评，找没覆盖的场景，做更便宜或更垂直的一版。',
  '做「[[KW]]」的迁移工具（从它导出数据、换到别的方案），词竞争小、转化高。',
  '「[[KW]]」是产品名不是需求词，做同名产品没意义；用它反查用户抱怨，挑一个痛点做小工具。',
  '给「[[KW]]」做配套：模板、插件、教程、代运营，蹭它的搜索量，比自己造需求便宜。',
  '把「[[KW]]」的用户评价爬下来做一份「真实体验报告」，靠这份内容接它的流失用户。',
]);

const ACT_UNKNOWN = regPool('act.unknown', [
  '先把「[[KW]]」搜一遍前十页，看现在是谁在接这些流量，再决定做工具还是做内容。',
  '「[[KW]]」的需求还不清楚，先挂一页落地页收集邮箱，用点击率判断值不值得投入。',
]);

const MONTH_CN = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

/** 时机句模板表。集中定义，翻译词典一次覆盖全部，不依赖当天数据命中哪些 */
const TIME_TPL = {
  'time.fading.1': '不过热度已经过了峰值，现在最多挂一个内容页，别投开发。',
  'time.fading.2': '它当前只剩峰值的 [[P]]%，除非出现二次爆发，否则不值得做产品。',
  'time.tiny.1': '月搜索不到一千次，先放进观察清单，等它翻倍再动手。',
  'time.tiny.2': '盘子还太小，先用一页内容占位，量起来再说。',
  'time.fresh.1': '刚被收录不到三个月，现在占词比做功能更重要。',
  'time.fresh.2': '榜单上还是新面孔，竞争对手没进场，先把页面和词占住。',
  'time.up.1': '90 天涨了 [[G]]%，窗口不会开太久，先上最小版本。',
  'time.up.2': '近三个月涨 [[G]]%，等做完完整产品大概率已经晚了，先发半成品。',
  'time.up.goods': '近三个月涨 [[G]]%，要快进快出，别一次性压大货。',
  'time.down.1': '近 90 天已经在回落 [[G]]%，只适合做轻量内容，不适合压开发。',
  'time.down.2': '这波正在退潮（90 天 [[G]]%），要做就做能长期吃搜索的内容，不要赌短期。',
  'time.down.goods': '近 90 天回落 [[G]]%，这时候别按热度备货，先小批量试单。',
  'time.season.1': '搜索高峰在 [[M]] 月，最好提前 [[N]] 个月上线。',
  'time.season.2': '这是季节性需求，[[M]] 月见顶，晚于这个月上线的产品基本吃不到量。',
  'time.season.goods': '搜索高峰在 [[M]] 月，备货和上新要提前 [[N]] 个月。',
  'time.crowded.1': '已被收录两年以上，正面做没机会，必须切一个细分场景。',
  'time.crowded.2': '这条词早就被盯上了，只有做窄（一类人、一个流程）才有空间。',
  'time.crowded.goods': '这条词被盯上两年以上，价格战多半已经打起来了，没有独家供应链就别进场。',
  'time.plat.1': '讨论集中在 [[PLATFORM]]，先去那里发免费版，比投广告便宜。',
  'time.plat.2': '活跃人群在 [[PLATFORM]]，冷启动就从那里的真实提问开始。',
  'time.plat.goods': '讨论集中在 [[PLATFORM]]，先在那里做开箱和实拍内容种草，比直接投广告便宜。',
  'time.default.1': '先把最小版本放出去，用真实搜索流量验证，再决定加不加功能。',
  'time.default.2': '没有明显的时间窗口，可以慢慢做，但先验证有没有人愿意付钱。',
};
for (const k of Object.keys(TIME_TPL)) ADVICE_TPL[k] = TIME_TPL[k];

/** 时机句：这条词自己的数据说什么，就说什么，不复用同一句套话 */
function timingOf(t, seed) {
  const pool = [];
  const g90 = Math.round(t.g90 || 0);
  const T = (id, vars) => pool.push({ id, t: TIME_TPL[id], vars: vars || {} });

  if (t.type === 'fading') {
    T('time.fading.1');
    T('time.fading.2', { P: Math.round((t.fromPeak || 0) * 100) });
  } else if (t.type === 'tiny') {
    T('time.tiny.1');
    T('time.tiny.2');
  } else {
    if (t.windowKey === 'fresh') {
      T('time.fresh.1');
      T('time.fresh.2');
    }
    const isGoods = t.carrier === 'goods';
    if (g90 >= 60) {
      if (isGoods) T('time.up.goods', { G: g90 });
      else {
        T('time.up.1', { G: g90 });
        T('time.up.2', { G: g90 });
      }
    } else if (g90 <= -15) {
      if (isGoods) T('time.down.goods', { G: Math.abs(g90) });
      else {
        T('time.down.1', { G: Math.abs(g90) });
        T('time.down.2', { G: g90 });
      }
    }
    if (t.season && t.season.strength >= 0.4) {
      const m = MONTH_CN[(t.season.peakMonth || 1) - 1];
      if (isGoods) T('time.season.goods', { M: m, N: t.seasonLead || 2 });
      else {
        T('time.season.1', { M: m, N: t.seasonLead || 2 });
        T('time.season.2', { M: m });
      }
    }
    if (t.windowKey === 'crowded') {
      if (isGoods) T('time.crowded.goods');
      else {
        T('time.crowded.1');
        T('time.crowded.2');
      }
    }
    if (t.platformLabel) {
      if (isGoods) T('time.plat.goods', { PLATFORM: t.platformLabel });
      else {
        T('time.plat.1', { PLATFORM: t.platformLabel });
        T('time.plat.2', { PLATFORM: t.platformLabel });
      }
    }
    if (!pool.length) {
      T('time.default.1');
      T('time.default.2');
    }
  }
  return pick(pool, seed + '|timing');
}

/**
 * 生成一条建议：动作 + 时机。
 * 同时把「用了哪条模板、填了什么变量」记到 t.adviceParts，
 * 多语言站点按 id 取对应语言的模板重新拼，不用整句翻译。
 */
function adviceOf(t) {
  const kw = String(t.keyword || '');
  const kind = t.digitalKind || kindOf(t);
  const carrier = t.carrier || carrierOf(t);
  const form = t.form || 'content';
  const seed = kw + '|' + (t.vol || 0);

  let pool;
  if (kind === 'company' || t.brand) pool = ACT_COMPANY;
  else if (kind === 'goods' || carrier === 'goods') pool = ACT_GOODS;
  else if (ACT_WEB[form]) pool = ACT_WEB[form];
  else pool = ACT_UNKNOWN;

  const ctx = (kw + ' ' + (t.categories || []).slice(0, 3).join(' ')).toLowerCase();
  const act = pickAct(pool, ctx, seed + '|act');
  const time = timingOf(t, seed);
  const who = sceneOf(t);
  const price = FORM_PRICE[form] || FORM_PRICE.tool;
  const platform = t.platformLabel || pick(['TikTok', 'Instagram', 'YouTube', 'Reddit'], seed + '|pf');

  const map = { KW: kw, WHO: who.who, PRICE: price.t, PLATFORM: platform };
  t.adviceParts = {
    a: { id: act.id, kw, who: who.key, price: price.id, platform },
    b: { id: time.id, vars: time.vars },
  };
  return fillTpl(act.t, map) + fillTpl(time.t, time.vars);
}

/** 关键词末词是「通用品类词」，说明这是需求词而不是品牌名 */
const GENERIC_TAIL =
  /\b(remover|generator|calculator|converter|downloader|editor|checker|tracker|planner|builder|maker|software|apps?|tools?|platform|management|system|transformation|analytics|marketing|automation|design|insurance|security|computing|governance|visualization|monitoring|detection|compliance|detox|therapy|coaching|training|services?|consulting|outsourcing|development|engineering|intelligence|learning|commerce|banking|payments?|lending|logistics|recruiting|staffing|scheduling|booking|storage|hosting|streaming|gambling|betting|dating|fitness|nutrition|wellness|skincare|supplements?|monitor|blocker|cleaner|finder|scanner|summarizer|transcriber|assistant|companion|screentime|screen time|remote work|side hustle|outsourcing|arbitrage)$/i;

/**
 * 区分「需求词」和「公司/产品名」。
 * need    = 通用需求（可以直接做产品）
 * company = 已有公司/产品（代表赛道已被验证，但名字本身不是机会）
 * noise   = 缩写/歧义词，没有商业含义
 *
 * 判定原则：只有以「通用品类词」结尾的，才算需求词。
 * 这是准确率最高的一条规则（lenme / chatit / fyp 这类都会被归到 company 或 noise）。
 */
function kindOf(t) {
  const kw = String(t.keyword || '').trim();
  const desc = String(t.desc || '');
  if (!desc) return 'unknown';

  const tokens = kw.split(/\s+/);
  const single = tokens.length === 1;

  // 纯缩写：UPI / FYP / USBC / MIS，既不是需求也不是可对标的公司
  if (/^[A-Z]{2,6}$/.test(kw) && !/^(AI|CRM|ERP|API|SEO|VPN|SaaS|GPT|UI|UX|AR|VR)$/.test(kw)) return 'noise';
  if (single && /^[a-z]{2,5}$/.test(kw) && !GENERIC_TAIL.test(kw) && !/\b(app|tool|software|platform)\b/i.test(desc))
    return 'noise';

  const tailGeneric = GENERIC_TAIL.test(kw);

  // 描述里直说是公司 / 机构 / 成立于某年 / 被谁创建
  if (COMPANY_DESC.test(desc)) return 'company';
  if (/\bcreated by\b/i.test(desc)) return 'company';

  // 实物商品：需要供应链，既不是能直接做的软件需求，也不是可对标的软件公司。
  // 注意要排除同时带线上意图词的（如 "employee monitoring software" 里的 monitor）。
  const kwPhy = PHY_KW.test(kw) || PHY_STRONG.test(kw) || HARDWARE_KW.test(kw);
  const catPhy = PHY_CAT.test((t.categories || []).join(' '));
  const descPhy = PHY_DESC.test(desc);
  if ((kwPhy || catPhy || descPhy) && !DIG_KW.test(kw)) return 'goods';

  // 描述以「产品名词 + designed to / that ...」开头（不带冠词），是在介绍某个具体产品
  if (
    /^(mobile |standalone |intuitive |simple |easy |powerful )?(platform|software|application|app|tool|service|website|marketplace|network|system)\b[^.]{0,70}\b(designed|that|which|built|created|connecting|connects|allows|enables|helps|lets)\b/i.test(
      desc
    )
  )
    return 'company';

  // 「X is a ...」自我定义
  const firstSeg = desc.split(/[.;]/)[0] || '';
  if (firstSeg && new RegExp('^' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+(is|was)\\s+(a|an)\\b', 'i').test(firstSeg))
    return 'company';

  // 描述首词是专有名词且「is a ...」（Amazon GuardDuty is a ...）
  if (/^[A-Z][A-Za-z0-9 .'-]{0,30}\s+is\s+(a|an)\b/.test(firstSeg) && !tailGeneric) return 'company';

  // 核心规则：末词是通用品类词 → 需求词
  if (tailGeneric) return 'need';

  // 小写开头 + 明确的产品意图词 → 需求词（如 "employee monitoring software"）
  if (/^[a-z]/.test(kw) && /\b(software|apps?|tools?|platform|generator|calculator|tracker|dashboard|automation|saas|analytics|api|extension|plugin|bot|system|management)\b/.test(kw))
    return 'need';

  return 'company';
}

/**
 * 判断一条话题是不是「可以做线上产品」的机会。
 * @returns {{digital:number, form:string, kind:string, reasons:string[]}}
 *   digital 0~1 数字化可行度；form 建议形态；kind: need=直接可做 / company=赛道已验证 / unknown
 */
function digitalOf(t) {
  const cats = (t.categories || []).join(' ');
  const desc = String(t.desc || '');
  const kw = String(t.keyword || '');

  const digK = DIG_KW.test(kw);
  const digC = DIG_CAT.test(cats);
  const digD = DIG_DESC.test(desc);
  const hwK = HARDWARE_KW.test(kw);
  const phyC = PHY_CAT.test(cats);
  const phyK = PHY_KW.test(kw) || hwK;
  const phyD = PHY_DESC.test(desc);

  let digital = 0.15;
  if (digK) digital += 0.4;
  if (digC) digital += 0.22;
  if (digD) digital += 0.18;
  // 非实物品类：本身就可以用内容/社区/工具去承接，给一个及格基线
  if (!phyC && !phyK && !phyD) digital += 0.12;
  if (phyC) digital -= 0.34;
  if (phyK || phyD) digital -= 0.42;
  digital = Math.max(0, Math.min(1, digital));
  // 实物品类且没有一丁点线上意图 → 直接排除出「数字机会」
  if ((phyC || phyK || phyD) && !digK) digital = Math.min(digital, 0.3);
  digital = Math.round(digital * 100) / 100;

  /* 形态 */
  const lc = cats.toLowerCase();
  const ld = desc.toLowerCase();
  const lk = kw.toLowerCase();
  let form = 'tool';
  if (MOBILE_HINT.test(lk) || MOBILE_HINT.test(ld)) form = 'app';
  else if (B2B_HINT.test(ld) && /business|software|productivity|workplace|industry|supply-chain|cybersecurity|marketing|finance|hr\b/.test(lc))
    form = 'saas';
  else if (TOOL_SUFFIX.test(lk)) form = 'tool';
  else if (/media|entertainment|art|education|lifestyle/.test(lc) && !digK) form = 'content';
  else if (/health|fitness|mental|sleep|nutrition|social|gaming|travel|pets/.test(lc)) form = 'app';
  else if (/software|technology|data|programming|automation|ai\b/.test(lc)) form = 'tool';
  else form = 'content';

  const kind = kindOf(t);
  // 实物商品没有「线上形态」：否则会出现 载体=实体产品、形态=内容站 的矛盾标签
  if (kind === 'goods') form = 'goods';

  const reasons = [];
  if (digK) reasons.push('关键词本身就是线上产品意图');
  if (digC) reasons.push('所属品类可纯线上交付');
  if (phyC) reasons.push('品类偏向实物，需要供应链');
  if (hwK) reasons.push('关键词指向硬件 / 消费电子，要靠卖货承接');
  else if (phyK) reasons.push('关键词指向实物商品');
  if (phyD && !hwK && !phyK) reasons.push('简介描述的是实体产品');

  return { digital, form, kind, reasons };
}

/** 数字机会分：针对线上产品调参（B 端词搜索量天然偏小，甜点区下调） */
function digitalScore(t, d) {
  const growth = clamp01(Math.log10(1 + Math.max(0, t.g90)) / Math.log10(201));
  // 3k ~ 10 万/月 是线上产品的舒适区
  const lv = Math.log10(Math.max(1, t.vol));
  let scale;
  if (lv >= 3.48 && lv <= 5) scale = 1;
  else if (lv < 3.48) scale = clamp(0.45 + ((lv - 2.7) / 0.78) * 0.55, 0.15, 1);
  else scale = clamp(1 - ((lv - 5) / 1.5) * 0.65, 0.2, 1);
  const money = clamp01(t.value == null ? 0.5 : t.value);
  const digital = clamp01(d.digital);

  let raw = 0.38 * growth + 0.24 * scale + 0.18 * money + 0.2 * digital;
  if (t.fromPeak > 0 && t.fromPeak < 0.4) raw *= 0.7;
  if (t.vol > 0 && t.vol < 500) raw *= 0.7;
  if (d.kind === 'company') raw *= 0.88; // 公司名只作赛道参考，轻微降权
  if (d.kind === 'noise') raw *= 0.3;

  return Math.round(clamp(raw, 0, 1) * 1000) / 10;
}

/* ------------------------------------------------------------------ */
/* 组装话题对象                                                        */
/* ------------------------------------------------------------------ */

function toTopic(raw) {
  const kw = String(raw.keyword || '').trim();
  if (!kw) return null;
  const hist = analyzeHistory(raw.searchHistory);
  const kdg = raw.keywordDataGlobal || {};
  const vol = Number(kdg.vol) || 0;

  const t = {
    id: raw._id || raw.path || kw,
    keyword: kw,
    slug: raw.path || '',
    url: raw.path ? SITE + '/topic/' + raw.path : '',
    vol,
    cpc: Number(kdg.cpc) || 0,
    g90: hist ? hist.g90 : 0,
    g12: hist ? hist.g12 : 0,
    g24: hist ? hist.g24 : 0,
    peak: hist ? hist.peak : 0,
    current: hist ? hist.current : 0,
    fromPeak: hist ? hist.fromPeak : 0,
    firstSeen: hist ? hist.firstSeen : '',
    lastMonth: hist ? hist.lastMonth : '',
    isNew: hist ? hist.isNew : false,
    spark: hist ? hist.spark : [],
    hist: hist ? hist.hist : null,
    inflection: hist ? hist.inflection : null,
    recentBreak: hist ? hist.recentBreak : null,
    longTrend: hist ? hist.longTrend : null,
    months: hist ? hist.months : 0,
    season: hist ? hist.season : null,
    volatility: hist ? hist.volatility : 0,
    declineMonths: hist ? hist.declineMonths : 0,
    trend: hist ? hist.trend : null,
    evergreen: hist ? hist.evergreen : false,
    cls: null,
    reg: null,
    created: 0,
    social: null,
    platform: '',
    platformTop: [],
    categories: [],
    desc: '',
    socialTotal: 0,
    classification: '',
    value: 0.5,
    brand: false,
    enriched: false,
    source: 'explodingtopics',
  };

  const sc = scoreOf(t);
  t.score = sc.score;
  t.parts = sc.parts;
  const ty = typeOf(t);
  t.type = ty.key;
  t.typeLabel = ty.label;
  t.typeHint = ty.hint;
  applyDigital(t);
  applyLifecycle(t);
  return t;
}

/** 详情补充后重算所有派生字段 */
function recompute(t) {
  t.value = valueOfCategories(t.categories);
  t.brand = looksLikeBrand(t, t.desc);
  const sc = scoreOf(t);
  t.score = sc.score;
  t.parts = sc.parts;
  const ty = typeOf(t);
  t.type = ty.key;
  t.typeLabel = ty.label;
  t.typeHint = ty.hint;
  t.typeRank = TYPE_RANK[t.type] == null ? 9 : TYPE_RANK[t.type];
  applyDigital(t);
  applyLifecycle(t);
  return t;
}

/* ------------------------------------------------------------------ */
/* 生命周期 / 真伪爆发 / 竞争窗口 / 平台策略                            */
/*                                                                     */
/* 这四个维度全部来自详情页里原本被丢弃的字段：                          */
/*   classifications 24/60/120/180 → 多少个时间尺度上都在爆发            */
/*   regressions 24/180 斜率       → 是近期加速还是长期趋势              */
/*   createdAt                     → 这条趋势被公开发现了多久             */
/*   socialChannelResults ×8       → 该在哪个平台做                     */
/* ------------------------------------------------------------------ */

/** 增长质量：几个时间尺度上都算「爆发」 */
function burstOf(t) {
  const cls = t.cls || {};
  const n = ['24', '60', '120', '180'].filter((k) => cls[k] === 'exploding').length;
  const r24 = t.reg && t.reg['24'];
  const r180 = t.reg && t.reg['180'];
  const accel = r24 && r180 && r180 > 0 ? Math.round((r24 / r180) * 10) / 10 : 0;

  if (n >= 4) return { key: 'structural', n, accel, label: '长期结构性', hint: '四个时间尺度都在爆发，是真实的需求迁移，不是一阵风' };
  if (n === 3) return { key: 'solid', n, accel, label: '已被验证', hint: '三个尺度都在爆发，趋势站得住，可以放心投入' };
  if (n === 2) return { key: 'young', n, accel, label: '新兴起势', hint: '只有近 1~2 年在爆发，方向对但还没走完一个周期' };
  if (n === 1) return { key: 'flash', n, accel, label: '短期爆发', hint: '只有最近 24 个月在爆发，长期看只是普通波动，容易踩坑' };
  return { key: 'unknown', n: 0, accel, label: '未判定', hint: '暂无足够的历史窗口数据' };
}

/** 生命周期阶段 */
function stageOf(t) {
  const decline = t.declineMonths || 0;
  const g24 = t.g24 || 0;
  const g90 = t.g90 || 0;
  const b = burstOf(t);

  if (t.fromPeak > 0 && t.fromPeak < 0.35 && g24 < 10) {
    return { key: 'declining', label: '已过峰', hint: '当前热度不足峰值的 35%，且 24 个月没有起色，不建议现在进入' };
  }
  if (decline >= 4 && g90 < 0) {
    return { key: 'cooling', label: '连续回落', hint: '已连续 ' + decline + ' 个月环比下滑，是衰退早期信号' };
  }
  if (b.key === 'structural' || b.key === 'solid') {
    return { key: 'growing', label: '长期增长', hint: '多个时间尺度同步向上，适合做常青内容或长期产品' };
  }
  if (b.key === 'young' && g24 > 40) {
    return { key: 'emerging', label: '新兴起势', hint: '近一两年才开始起量，现在是卡位窗口，但要盯住能否持续' };
  }
  if (t.fromPeak >= 0.8 && Math.abs(g90) < 15 && (t.g12 || 0) < 25) {
    return { key: 'plateau', label: '高位平台', hint: '需求稳定在高位，不涨不跌，适合做存量优化而不是抢新流量' };
  }
  return { key: 'steady', label: '平稳', hint: '趋势不显著，先观察或用于补充选题' };
}

/** 竞争窗口期：这条趋势被公开收录了多久 */
function windowOf(t) {
  if (!t.created) return null;
  const months = Math.max(0, Math.round((Date.now() / 1000 - t.created) / (86400 * 30.44)));
  if (months <= 3) return { months, key: 'fresh', label: '刚收录', hint: '刚被榜单收录，绝大多数人还没看到，是最好的卡位期' };
  if (months <= 9) return { months, key: 'open', label: '窗口期', hint: '被收录不到一年，竞争者开始进场，还有空间' };
  if (months <= 24) return { months, key: 'warming', label: '竞争升温', hint: '已被收录 1~2 年，头部玩家多半已经出现，需要差异化' };
  return { months, key: 'crowded', label: '充分竞争', hint: '收录超过 2 年，市场已被充分开发，除非有明确的新切入点' };
}

/** 平台策略：主战场渠道 → 该怎么做 */
const PLATFORM_ADVICE = {
  facebook: 'Facebook 是主战场：适合做社群 + 信息流广告，受众偏大众消费，用测评/对比内容切入',
  instagram: 'Instagram 是主战场：视觉驱动，适合做图文模板、审美类产品、红人种草',
  reddit: 'Reddit 是主战场：说明有真实社区在讨论，适合做工具型产品、免费小工具引流，硬广会被反感',
  youtube: 'YouTube 是主战场：适合做长视频教程/测评，搜索型内容能长期吃流量',
  tiktok: 'TikTok 是主战场：短视频爆发型，适合做爆款单品和挑战类内容，生命周期短、要快',
  pinterest: 'Pinterest 是主战场：设计/家居/穿搭类，适合做素材站、模板站，图片能长期带来搜索流量',
  twitter: 'X 是主战场：话题讨论型，适合做资讯、观点类内容，商业化偏弱',
  linkedin: 'LinkedIn 是主战场：B2B 信号，说明企业端在关注，适合做 SaaS 和行业服务',
};

function platformOf(t) {
  if (t.platform) return { key: t.platform, label: CHANNEL_CN[t.platform] || t.platform, advice: PLATFORM_ADVICE[t.platform] || '' };
  return { key: '', label: '', advice: '' };
}

/** 建站/内容站适配度：0~100，面向 SEO 站长与独立站 */
function buildScoreOf(t) {
  if (t.brand || t.digitalKind === 'noise') {
    t.buildParts = null;
    return 0;
  }

  // 12 个月增速，温和上涨最理想（爆涨往往已经晚了）
  const g = clamp01(Math.log10(1 + Math.max(0, t.g12)) / Math.log10(101));
  const v = t.vol || 0;
  const lv = v > 0 ? Math.log10(v) : 0;
  // 建站甜点区比产品低一档：5k~100k 的长尾词才是站长的菜
  const scale =
    v <= 0
      ? 0.1
      : lv >= 3.7 && lv <= 5
        ? 1
        : lv < 3.7
          ? clamp(0.25 + ((lv - 3) / 0.7) * 0.75, 0.08, 1)
          : clamp(1 - ((lv - 5) / 1.2) * 0.95, 0.05, 1);
  // 稳定性：波动低说明是稳定需求，不是事件驱动
  const stable = t.volatility ? clamp01(1 - (t.volatility - 0.15) / 0.6) : 0.5;
  // 新鲜度：收录越久，抢的人越多
  const monthsOld = t.created ? (Date.now() / 1000 - t.created) / (86400 * 30.44) : 12;
  const fresh = clamp01(1 - Math.max(0, monthsOld - 6) / 36);
  // 内容可覆盖度：有明确分类的更容易做结构化内容
  const cover = (t.categories || []).length ? 0.85 : 0.6;

  let raw = 0.3 * g + 0.3 * scale + 0.18 * stable + 0.12 * fresh + 0.1 * cover;
  if (t.type === 'red') raw *= 0.75;
  if (t.type === 'fading') raw *= 0.55;
  // 近 90 天在跌：说明这一波已经过了，建站最怕扑在下跌趋势上
  if (t.g90 < -15) raw *= 0.8;
  // 只有最近一个尺度在爆发：短期热点，不适合做常青站
  if (t.burst === 'flash') raw *= 0.85;
  if (v > 0 && v < 500) raw *= 0.7;

  // 分项留档：详情页要把 87 分拆成「增长 24 / 规模 30 / 稳定 12 …」，不能只给一个黑盒数字
  t.buildParts = {
    growth: Math.round(g * 100),
    scale: Math.round(scale * 100),
    stable: Math.round(stable * 100),
    fresh: Math.round(fresh * 100),
    cover: Math.round(cover * 100),
  };
  return Math.round(clamp(raw, 0, 1) * 1000) / 10;
}

/** 广告投放价值：0~100，要的是量大、涨、意图明确 */
function adsScoreOf(t) {
  const g = clamp01(Math.log10(1 + Math.max(0, t.g90)) / Math.log10(101));
  const scale = clamp01(Math.log10(1 + (t.vol || 0)) / Math.log10(200001));
  const intent = /\b(software|tool|apps?|service|buy|price|cost|best|vs|near me|insurance|loan|hosting|agency|course)\b/i.test(t.keyword) ? 1 : 0.55;
  const season = t.season ? clamp01(t.season.strength * 1.5) : 0.3;
  let raw = 0.4 * g + 0.35 * scale + 0.15 * intent + 0.1 * season;
  if (t.brand) raw *= 0.5;
  if (t.digitalKind === 'noise') raw *= 0.3;
  return Math.round(clamp(raw, 0, 1) * 1000) / 10;
}

function applyLifecycle(t) {
  const st = stageOf(t);
  t.stage = st.key;
  t.stageLabel = st.label;
  t.stageHint = st.hint;

  const bu = burstOf(t);
  t.burst = bu.key;
  t.burstLabel = bu.label;
  t.burstHint = bu.hint;
  t.burstWindows = bu.n;
  t.accel = bu.accel;

  const wn = windowOf(t);
  t.ageMonths = wn ? wn.months : null;
  t.windowKey = wn ? wn.key : '';
  t.windowLabel = wn ? wn.label : '';
  t.windowHint = wn ? wn.hint : '';

  const pf = platformOf(t);
  t.platformLabel = pf.label;
  t.platformAdvice = pf.advice;

  t.buildScore = buildScoreOf(t);
  t.adsScore = adsScoreOf(t);

  // 季节提醒：强度足够大才提「提前准备」（0.4 ≈ 高峰月是低谷月的 1.7 倍）
  if (t.season && t.season.strength >= 0.4) {
    const lead = t.season.strength >= 0.5 ? 3 : 2;
    let m = t.season.peakMonth - lead;
    if (m <= 0) m += 12;
    t.seasonLead = lead;
    t.seasonPrepMonth = m;
  } else {
    t.seasonLead = 0;
    t.seasonPrepMonth = 0;
  }
  return t;
}

/** 写入数字产品机会相关字段 */
const CARRIER_LABEL = {
  web: '网站 / APP / SaaS',
  goods: '实体产品',
};

/**
 * 载体：这条机会最终靠什么去承接。这是「我要做什么」的第一层分岔，
 * 取代原来「机会雷达 vs 数字机会」两个并列页面——用户先想清楚自己做什么，再在里面挑词。
 * 只留两类，因为服务型需求（保险/清洁/贷款）在线上同样是做站获客，归到 web 更准确。
 */
function carrierOf(t) {
  const kw = String(t.keyword || '');
  const cats = (t.categories || []).join(' ');
  const kind = t.digitalKind || kindOf(t);
  const digital = t.digital == null ? 0.15 : t.digital;

  if (kind === 'goods') return 'goods';
  if (digital >= 0.4) return 'web';
  const physical = PHY_KW.test(kw) || PHY_STRONG.test(kw) || HARDWARE_KW.test(kw) || PHY_DESC.test(String(t.desc || '')) || PHY_CAT.test(cats);
  return physical ? 'goods' : 'web';
}

function applyDigital(t) {
  const d = digitalOf(t);
  t.digital = d.digital;
  t.form = d.form;
  t.formLabel = FORM_LABEL[d.form] || '';
  t.digitalKind = d.kind;
  t.digitalReasons = d.reasons;
  t.digitalScore = digitalScore(t, d);
  t.carrier = carrierOf(t);
  t.carrierLabel = CARRIER_LABEL[t.carrier] || '';

  // 硬件词补一个「消费电子」品类：Google Trends 给的 technology/art/media 说明不了这是一台设备。
  // 只补标签、不改判定，同时把 art/media 这类对硬件毫无意义的噪音标签去掉。
  if (t.carrier === 'goods' && HARDWARE_KW.test(String(t.keyword || ''))) {
    const NOISE = ['art', 'media', 'social-media', 'entertainment', 'lifestyle', 'dating-relationships', 'luxury'];
    const kept = (t.categories || []).filter((c) => NOISE.indexOf(c) < 0);
    t.categories = ['consumer-electronics'].concat(kept.filter((c) => c !== 'consumer-electronics')).slice(0, 5);
  }

  // 建议文案：动作 + 时机，由这条词自己的关键词与数据生成
  t.advice = adviceOf(t);
  t.digitalAdvice = t.carrier === 'web' ? t.advice : '';

  // 强监管领域：普通建议不适用
  const SENSITIVE =
    /\b(gambling|betting|casino|poker|adult|porn|escort|tobacco|vaping|weapon|firearm|payday loan)\b/i;
  if (SENSITIVE.test(t.keyword) || SENSITIVE.test((t.categories || []).join(' '))) {
    t.advice = '⚠️ 强监管领域（博彩/成人/武器/高利贷类），先确认目标市场的法律合规与支付通道，门槛远高于普通产品。';
    t.digitalAdvice = t.advice;
  }
  return t;
}

function socialSum(s) {
  if (!s || typeof s !== 'object') return 0;
  let n = 0;
  for (const k of ['linkedin', 'tiktok', 'youtube', 'instagram', 'twitter', 'facebook', 'reddit', 'pinterest', 'x']) {
    n += Number(s[k]) || 0;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* 抓取                                                                */
/* ------------------------------------------------------------------ */

async function fetchListPage(page) {
  const url = SITE + LIST_PATH + (page > 1 ? '?page=' + page : '');
  const r = await httpGet(url);
  if (r.status !== 200) throw new Error('榜单第 ' + page + ' 页返回 HTTP ' + r.status);
  const d = extractNextData(r.body);
  const pp = d && d.props && d.props.pageProps;
  const data = (pp && pp.data) || {};
  return {
    trends: data.trends || [],
    total: Number(data.total) || 0,
    size: Number(data.size) || (data.trends ? data.trends.length : 0),
  };
}

/** 并发受限的批量执行 */
async function mapLimit(list, limit, worker, onTick) {
  const out = new Array(list.length);
  let cursor = 0;
  let done = 0;

  async function run() {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      try {
        out[i] = await worker(list[i], i);
      } catch (e) {
        out[i] = { __error: e.message };
      }
      done++;
      if (onTick) onTick(done, list.length);
    }
  }

  const workers = [];
  for (let k = 0; k < Math.min(limit, list.length); k++) workers.push(run());
  await Promise.all(workers);
  return out;
}

/** 抓取全站榜单，翻页直到取满 total */
async function fetchAllTopics(opts) {
  opts = opts || {};
  const concurrency = opts.concurrency || 6;
  const maxPages = opts.maxPages || 40;

  const first = await fetchListPage(1);
  const size = first.size || 30;
  const total = first.total || first.trends.length;
  const pages = Math.min(maxPages, Math.max(1, Math.ceil(total / size)));

  const rest = [];
  for (let p = 2; p <= pages; p++) rest.push(p);

  if (opts.onProgress) opts.onProgress(1, pages);

  const restRes = await mapLimit(
    rest,
    concurrency,
    async (p) => fetchListPage(p),
    (d) => {
      if (opts.onProgress) opts.onProgress(d + 1, pages);
    }
  );

  const raws = [].concat(first.trends);
  for (const r of restRes) {
    if (r && r.trends) raws.push.apply(raws, r.trends);
  }

  // 去重（同一条可能在多页重复出现）
  const seen = new Map();
  for (const raw of raws) {
    const key = raw.path || raw.keyword;
    if (!key) continue;
    if (!seen.has(key)) seen.set(key, raw);
  }

  const topics = [];
  for (const raw of seen.values()) {
    const t = toTopic(raw);
    if (t) topics.push(recompute(t));
  }
  topics.sort((a, b) => b.score - a.score);
  return { topics, total, pages, fetched: raws.length, unique: topics.length };
}

/* ------------------------------------------------------------------ */
/* 详情补充（分类 + 简介 + 社媒热度）                                   */
/* ------------------------------------------------------------------ */

function readJson(file, fallback) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j || fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, obj) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
  } catch (e) {
    /* 忽略写入失败 */
  }
}

function loadEnrichMap() {
  const j = readJson(ENRICH_FILE, { items: {} });
  return j && j.items ? j : { items: {} };
}

const SOCIAL_CHANNELS = ['facebook', 'instagram', 'reddit', 'youtube', 'tiktok', 'pinterest', 'twitter', 'linkedin'];

const CHANNEL_CN = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  reddit: 'Reddit',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  pinterest: 'Pinterest',
  twitter: 'X / Twitter',
  linkedin: 'LinkedIn',
};

async function fetchTopicDetail(slug) {
  const r = await httpGet(SITE + '/topic/' + slug);
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  const d = extractNextData(r.body);
  const tr = d && d.props && d.props.pageProps && d.props.pageProps.data && d.props.pageProps.data.trend;
  if (!tr) throw new Error('页面结构变化，未取到话题数据');

  // 四档窗口（24/60/120/180 个月）的生命周期标签与回归斜率
  const clsRaw = tr.classifications || {};
  const cls = {};
  for (const k of ['24', '60', '120', '180']) {
    if (clsRaw[k]) cls[k] = String(clsRaw[k]);
  }
  const regRaw = tr.regressions || {};
  const reg = {};
  for (const k of ['24', '60', '120', '180']) {
    const v = regRaw[k];
    if (v && isFinite(v.gradient)) reg[k] = Math.round(v.gradient * 1e11) / 1e11;
  }

  // 八个社媒渠道各自的提及量（之前只取了总和，白扔了渠道结构）
  const sr = tr.socialChannelResults || {};
  const social = {};
  for (const c of SOCIAL_CHANNELS) {
    const n = Number(sr[c]);
    if (isFinite(n) && n > 0) social[c] = Math.round(n);
  }
  const ranked = Object.keys(social)
    .map((c) => [c, social[c]])
    .sort((a, b) => b[1] - a[1]);

  return {
    categories: Array.isArray(tr.categories) ? tr.categories : [],
    desc: String(tr.briefDescription || '').replace(/\s+/g, ' ').trim(),
    classification: String(clsRaw['24'] || ''),
    socialTotal: socialSum(sr),
    cls,
    reg,
    created: Number(tr.createdAt) || 0,
    social,
    platform: ranked.length ? ranked[0][0] : '',
    platformTop: ranked.slice(0, 3).map(([c, n]) => [c, n]),
  };
}

/**
 * 给指定 slug 补类别/简介/社媒热度。已缓存且未过期的直接返回。
 * @returns {Promise<{map:Object, fetched:number, cached:number, failed:number}>}
 */
async function enrichSlugs(slugs, opts) {
  opts = opts || {};
  const concurrency = clamp(opts.concurrency || 8, 1, 12);
  const store = loadEnrichMap();
  const now = Date.now();

  const list = [];
  for (const s of slugs) {
    if (s && !list.includes(s)) list.push(s);
  }

  const need = [];
  let cached = 0;
  for (const s of list) {
    const hit = store.items[s];
    const age = hit ? now - (hit.at || 0) : Infinity;
    if (hit && age < ENRICH_TTL && !hit.error) cached++;
    else if (!hit || age > (hit.error ? ENRICH_RETRY : ENRICH_TTL)) need.push(s);
  }

  let fetched = 0;
  let failed = 0;

  if (need.length) {
    await mapLimit(
      need,
      concurrency,
      async (slug) => {
        try {
          const d = await fetchTopicDetail(slug);
          store.items[slug] = Object.assign({ at: Date.now() }, d);
          fetched++;
        } catch (e) {
          failed++;
          const prev = store.items[slug] || {};
          store.items[slug] = Object.assign({}, prev, { at: Date.now(), error: e.message });
        }
      },
      opts.onProgress
    );
    writeJson(ENRICH_FILE, store);
  }

  const map = {};
  for (const s of list) {
    const hit = store.items[s];
    if (hit && !hit.error) {
      map[s] = {
        categories: hit.categories || [],
        desc: hit.desc || '',
        classification: hit.classification || '',
        socialTotal: hit.socialTotal || 0,
        cls: hit.cls || null,
        reg: hit.reg || null,
        created: hit.created || 0,
        social: hit.social || null,
        platform: hit.platform || '',
        platformTop: hit.platformTop || [],
      };
    }
  }
  return { map, fetched, cached, failed };
}

/* ------------------------------------------------------------------ */
/* 缓存                                                                */
/* ------------------------------------------------------------------ */

let memory = null; // { at, payload }

function readCache() {
  if (memory) return memory;
  const j = readJson(CACHE_FILE, null);
  if (j && Array.isArray(j.topics) && j.at) {
    memory = { at: j.at, payload: j };
    return memory;
  }
  return null;
}

function writeCache(payload) {
  memory = { at: payload.at, payload };
  writeJson(CACHE_FILE, payload);
}

/** 把缓存里的类别/简介回填到话题列表并重算分数 */
/**
 * 卡片上展示的简介：按句子边界截到 ~240 字符。
 * 英文展示、中文翻译的 key 都用它，避免两边截断位置不一致导致翻译对不上。
 */
function shortDesc(desc) {
  const s = String(desc || '').replace(/\s+/g, ' ').trim();
  if (s.length <= 240) return s;
  const cut = s.slice(0, 240);
  // 优先在句号 / 问号 / 感叹号处断开，其次逗号分号，最后空格
  let at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  if (at < 120) at = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('; '));
  if (at < 120) at = cut.lastIndexOf(' ');
  if (at < 100) return cut.trim() + '…';
  return cut.slice(0, at + 1).trim();
}

function applyEnrich(topics) {
  const store = loadEnrichMap();
  for (const t of topics) {
    const hit = t.slug && store.items[t.slug];
    if (hit && !hit.error) {
      t.categories = hit.categories || [];
      t.desc = hit.desc || '';
      t.descShort = shortDesc(t.desc);
      t.classification = hit.classification || '';
      t.socialTotal = hit.socialTotal || 0;
      t.cls = hit.cls || null;
      t.reg = hit.reg || null;
      t.created = hit.created || 0;
      t.social = hit.social || null;
      t.platform = hit.platform || '';
      t.platformTop = hit.platformTop || [];
      t.enriched = true;
    }
    recompute(t);
  }
  return topics;
}

function summarize(topics) {
  const cats = {};
  for (const t of topics) {
    if (t.brand) continue;
    const list = t.categories && t.categories.length ? t.categories : ['未分类'];
    for (const c of list) {
      const e = cats[c] || (cats[c] = { count: 0, growthSum: 0, volSum: 0, rising: 0 });
      e.count++;
      e.growthSum += clamp(t.g90 || 0, -100, 500);
      e.volSum += t.vol || 0;
      if (t.type === 'rising' || t.type === 'seed') e.rising++;
    }
  }
  const out = {};
  for (const c of Object.keys(cats)) {
    const e = cats[c];
    out[c] = {
      count: e.count,
      avgGrowth: Math.round((e.growthSum / e.count) * 10) / 10,
      avgVol: Math.round(e.volSum / e.count),
      rising: e.rising,
    };
  }
  return out;
}

/**
 * 获取机会雷达数据（优先缓存）
 * @param {{force?:boolean, onProgress?:Function}} opts
 */
async function getRadar(opts) {
  opts = opts || {};
  const hit = readCache();
  const fresh = hit && Date.now() - hit.at < CACHE_TTL;

  if (hit && fresh && !opts.force) {
    const topics = applyEnrich(hit.payload.topics.map((t) => Object.assign({}, t)));
    return {
      ok: true,
      cached: true,
      at: hit.at,
      total: hit.payload.total,
      counts: summarize(topics),
      topics,
    };
  }

  try {
    const res = await fetchAllTopics({ onProgress: opts.onProgress });
    const payload = {
      at: Date.now(),
      total: res.total,
      fetched: res.fetched,
      unique: res.unique,
      topics: res.topics,
    };
    payload.counts = summarize(res.topics);
    writeCache(payload);
    const topics = applyEnrich(res.topics);
    return { ok: true, cached: false, at: payload.at, total: res.total, counts: summarize(topics), topics };
  } catch (e) {
    if (hit) {
      const topics = applyEnrich(hit.payload.topics.map((t) => Object.assign({}, t)));
      return {
        ok: true,
        cached: true,
        stale: true,
        at: hit.at,
        total: hit.payload.total,
        counts: summarize(topics),
        topics,
        error: '本次实时抓取失败（' + e.message + '），展示的是 ' + new Date(hit.at).toLocaleString('zh-CN') + ' 的缓存。',
      };
    }
    throw e;
  }
}

function cacheInfo() {
  const hit = readCache();
  return hit ? { at: hit.at, total: hit.payload.total, fresh: Date.now() - hit.at < CACHE_TTL } : null;
}

module.exports = {
  getRadar,
  enrichSlugs,
  cacheInfo,
  analyzeHistory,
  scoreOf,
  typeOf,
  adviceOf,
  ADVICE_TPL,
  valueOfCategories,
  digitalOf,
  digitalScore,
  applyDigital,
  FORM_LABEL,
  shortDesc,
  // 便于自测
  extractNextData,
  fetchAllTopics,
  fetchListPage,
  fetchTopicDetail,
  __test: { toTopic, recompute, applyLifecycle, burstOf, stageOf, windowOf, buildScoreOf, adsScoreOf },
};
