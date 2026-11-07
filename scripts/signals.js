'use strict';
/**
 * 信号聚合：把两份不同粒度的数据合成一份「每天真的不一样」的发现清单。
 *
 * 输入
 *   data/daily.json            当日 Google Trends 热搜（13 个地区，每条带搜索量与新闻）
 *   data/daily-snapshots/*.json 历史快照（算「首次出现 / 连续在榜」）
 *   data/radar.json            872 个品类 + 24 期热度曲线（算「谁在升温」）
 *   data/radar-enrich.json     品类类目与描述
 *
 * 输出 data/signals.json
 *   demand   —— 热榜里被判定为「需求」的查询（游戏 / AI / 工具 / 消费 / 应用），带热度、地区、
 *               连续在榜天数、首次出现日期、相关新闻标题；这是「发现了什么新东西」
 *   momentum —— 品类热度曲线最近 3 期 vs 之前 4 期的加速度，按 vol 过滤掉长尾噪音
 *   pulse    —— 顶部统计（总数、各地区条数、数据时间）
 *
 * 纯计算，不联网：CI 每次构建跑一次，同一天多次构建结果一致。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const D = (p) => path.join(ROOT, 'data', p);

const readJSON = (p, dft) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return dft;
  }
};

/* ------------------------------ 分类 ------------------------------
   热榜词混杂新闻、体育、娱乐。这里只做一件事：判断一个查询是不是「需求」
   （有人想买 / 想用 / 想玩 / 想学），而不是「发生了什么事」。
   优先级：游戏 > AI > 应用/工具 > 消费 > 娱乐，命中即返回，避免 zelda 被算成娱乐。 */

const CATS = [
  {
    key: 'game',
    weight: 100,
    re: /\b(pok[eé]mon|pokemon|zelda|gta|mario|fortnite|minecraft|roblox|steam|ps5|playstation|xbox|nintendo|switch 2|esports|speedrun|game pass|dlc|gameplay|walkthrough|game|gaming)\b|ゲーム|ゲーム|게임|游戏|遊戲/i,
  },
  {
    key: 'ai',
    weight: 98,
    re: /\b(ai|a\.i\.|chatgpt|openai|gpt-?\d|claude|gemini|llama|llm|midjourney|sora|copilot|deepseek|perplexity|grok|agent|agents|diffusion|text-to-(image|video)|machine learning)\b|人工智能|人工知能|인공지능|大模型|智能体/i,
  },
  {
    key: 'app',
    weight: 88,
    re: /\b(app store|google play|apk|ios|android app|download (the )?app|app)\b|アプリ|앱|下载|下載/i,
  },
  {
    key: 'tool',
    weight: 84,
    re: /\b(tool|software|editor|generator|converter|template|plugin|extension|saas|api|crm|nocode|no-code|dashboard|automation)\b|工具|ツール|도구/i,
  },
  {
    key: 'shop',
    weight: 78,
    re: /\b(buy|price|cost|cheap|sale|discount|amazon|walmart|etsy|shopify|outfit|dress|shoes|sneakers|jacket|hoodie|perfume|skincare|serum|mattress|sofa|chair|lamp|bag|stroller|supplement|protein|treadmill)\b|通販|購入|価格|구매|가격|购买|价格/i,
  },
  {
    key: 'media',
    weight: 40,
    re: /\b(movie|film|series|netflix|hulu|disney\+|anime|episode|season \d|trailer|soundtrack|album|lyrics|tour|concert)\b|映画|ドラマ|영화|드라마|电视剧|電影/i,
  },
  {
    key: 'sport',
    weight: 20,
    re: /\b(vs\.?|match|score|league|nba|nfl|nhl|mlb|premier league|la liga|serie a|formula 1|f1|grand prix|ufc|boxing|playoff|fixture)\b|試合|경기|比赛/i,
  },
];

// 纯新闻口吻：出现这些基本是事件报道，不是需求
const NEWSY =
  /\b(dies|died|dead|killed|arrest|arrested|impeach|elected|election|verdict|sentenced|lawsuit|resign|resigns|resigned|earthquake|storm|hurricane|flood|wildfire|weather|forecast|outage|explosion|shooting|ceasefire|summit|poll|polls|senate|congress|parliament|minister|president (trump|biden)|white house|supreme court)\b/i;

function classify(q) {
  const s = String(q || '');
  const words = s.split(/\s+/).filter(Boolean).length;
  // 真实搜索词偏短；长句 + 问号/引号基本都是新闻标题
  const sentenceLike = words > 7 || /[?？]/.test(s) || /[''"]/.test(s);
  // 先判「新闻事件」：这类句子即使含 tour/shop 等词也不是需求
  if (NEWSY.test(s) && words >= 5) return { key: 'news', weight: 0 };
  if (sentenceLike) return { key: 'news', weight: 0 };
  for (const c of CATS) {
    if (c.re.test(s)) return { key: c.key, weight: c.weight };
  }
  if (NEWSY.test(s)) return { key: 'news', weight: 0 };
  return { key: 'other', weight: 30 };
}

const norm = (s) => String(s || '').toLowerCase().replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

/* 搜索量：热榜给的是 "800K+"/"2000+" 这类字符串，也有 trafficValue 数值 */
function trafficVal(it) {
  if (typeof it.trafficValue === 'number' && it.trafficValue > 0) return it.trafficValue;
  const m = String(it.traffic || '').match(/([\d.]+)\s*([KMB])?/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = (m[2] || '').toUpperCase();
  return Math.round(n * (unit === 'B' ? 1e9 : unit === 'M' ? 1e6 : unit === 'K' ? 1e3 : 1));
}

function fmtTraffic(n) {
  if (!n) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M+';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K+';
  return String(n) + '+';
}

/* ------------------------------ 历史 ------------------------------ */

function loadHistory() {
  const dir = D('daily-snapshots');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-21);
  } catch (e) {
    return [];
  }
  const days = [];
  for (const f of files) {
    const j = readJSON(path.join(dir, f), null);
    if (!j) continue;
    const blocks = (j.daily && j.daily.data) || j.data || {};
    const map = new Map();
    for (const g of Object.keys(blocks)) {
      for (const it of blocks[g].items || []) {
        const k = norm(it.query);
        if (!k) continue;
        const prev = map.get(k);
        const tv = trafficVal(it);
        if (!prev || tv > prev.trafficValue) map.set(k, { query: it.query, trafficValue: tv, geo: g, articles: it.articles || [] });
      }
    }
    days.push({ date: f.replace('.json', ''), map });
  }
  return days;
}

/* ------------------------------ 品类动量 ------------------------------
   radar 的 spark 是 24 期搜索热度（月度）。取最近 3 期均值 vs 之前 4 期均值，
   得到「最近三个月相对前期的加速度」。长尾词（vol < 1500）噪声大，直接丢掉。 */

function momentumOf(spark) {
  const s = (spark || []).filter((v) => typeof v === 'number');
  if (s.length < 8) return null;
  const recent = s.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const base = s.slice(-8, -4).reduce((a, b) => a + b, 0) / 4;
  if (base <= 0) return null;
  return Math.round(((recent - base) / base) * 100);
}

function buildMomentum() {
  const radar = readJSON(D('radar.json'), { topics: [] });
  const enrich = (readJSON(D('radar-enrich.json'), { items: {} }).items) || {};
  const out = [];
  for (const tp of radar.topics || []) {
    const vol = tp.vol || 0;
    if (vol < 1500) continue;
    const mom = momentumOf(tp.spark);
    if (mom === null || mom < 15) continue; // 只留明显在升温的
    const e = enrich[tp.slug] || {};
    out.push({
      slug: tp.slug,
      keyword: tp.keyword,
      vol,
      g90: Math.round(tp.g90 || 0),
      mom,
      spark: (tp.spark || []).slice(-12),
      cats: (e.categories || []).slice(0, 2),
    });
  }
  // 分数：动量 × 体量权重，避免只有几十搜索量的小词靠百分比冲上来
  out.sort((a, b) => b.mom * Math.log10(b.vol + 10) - a.mom * Math.log10(a.vol + 10));
  return out.slice(0, 24);
}

/* ------------------------------ 新进品类 ------------------------------
   品类库每天重抓一次。用一个持久化的「首次见到日期」表判断哪些品类是新出现的：
   第一次运行只做种（全部记为今天，不产出），之后每天新增的就是真正的新面孔。 */

const SEEN_FILE = 'topics-seen.json';

function diffNewTopics(radarTopics, today) {
  const seenPath = D(SEEN_FILE);
  const existed = fs.existsSync(seenPath);
  const seen = readJSON(seenPath, {}) || {};
  const fresh = [];
  let changed = false;
  for (const tp of radarTopics) {
    if (!seen[tp.slug]) {
      seen[tp.slug] = today;
      changed = true;
      if (existed) fresh.push(tp);
    }
  }
  if (changed) {
    try {
      fs.writeFileSync(seenPath, JSON.stringify(seen, null, 1), 'utf8');
    } catch (e) {
      /* 写不进去不影响页面，只是明天还会当成新的 */
    }
  }
  const cutoff = new Date(Date.parse(today) - 6 * 86400e3).toISOString().slice(0, 10);
  // 种子日（表里最早的一天）不能算「新」——那天是全量写入，否则首周会把整库当成新增
  const allDates = Object.values(seen).filter(Boolean).sort();
  const seedDay = allDates.length ? allDates[0] : today;
  // 表里 6 天内首次见到的品类都算「新」，即使本次没有新增
  const newer = [];
  for (const tp of radarTopics) {
    const d = seen[tp.slug];
    if (d && d > seedDay && d >= cutoff) newer.push(Object.assign({ firstDay: d }, tp));
  }
  newer.sort((a, b) => (b.vol || 0) - (a.vol || 0));
  return newer.slice(0, 12).map((tp) => ({
    slug: tp.slug,
    keyword: tp.keyword,
    vol: tp.vol || 0,
    g90: Math.round(tp.g90 || 0),
    firstDay: tp.firstDay,
  }));
}

/* ------------------------------ 主流程 ------------------------------ */

function buildSignals(opts) {
  opts = opts || {};
  // 本地调试可用 SIGNALS_DAILY 指向副本（Windows 下 data/daily.json 有时被占用）
  const dailyPath = process.env.SIGNALS_DAILY ? path.resolve(ROOT, process.env.SIGNALS_DAILY) : D('daily.json');
  const daily = opts.daily || readJSON(dailyPath, null) || readJSON(path.join(ROOT, 'dist', 'data', 'daily.json'), null);
  const blocks = (daily && ((daily.daily && daily.daily.data) || daily.data)) || {};
  const geos = Object.keys(blocks).filter((g) => (blocks[g].items || []).length);
  const history = loadHistory();

  // 每个查询：收集它出现过的所有地区与最高热度
  const geoSeen = new Map();
  for (const g of geos) {
    for (const it of blocks[g].items || []) {
      const k = norm(it.query);
      if (!k) continue;
      const rec = geoSeen.get(k) || { q: it.query, trafficValue: 0, geos: [], articles: [] };
      rec.trafficValue = Math.max(rec.trafficValue, trafficVal(it));
      if (!rec.geos.includes(g)) rec.geos.push(g);
      if (!rec.articles.length && it.articles && it.articles.length) rec.articles = it.articles.slice(0, 2);
      geoSeen.set(k, rec);
    }
  }

  const today = (daily && (daily.date || (daily.data && daily.data.US && new Date(daily.data.US.fetchedAt).toISOString().slice(0, 10)))) || new Date().toISOString().slice(0, 10);
  const histDays = history.map((h) => h.date).filter((d) => d < today);

  const demand = [];
  const news = [];
  const buckets = { game: [], ai: [], app: [], tool: [], shop: [], media: [], news: [], other: [] };
  let newToday = 0;
  for (const [k, rec] of geoSeen) {
    const cat = classify(rec.q);
    let streak = 0;
    let firstDay = '';
    // 连续在榜：从最近一天往回数
    for (let i = histDays.length - 1; i >= 0; i--) {
      if (history.find((h) => h.date === histDays[i]).map.has(k)) streak++;
      else break;
    }
    for (let i = 0; i < histDays.length; i++) {
      if (history.find((h) => h.date === histDays[i]).map.has(k)) {
        firstDay = histDays[i];
        break;
      }
    }
    if (!firstDay) {
      newToday++;
      firstDay = today;
    }
    const item = {
      q: rec.q,
      cat: cat.key,
      traffic: fmtTraffic(rec.trafficValue),
      trafficValue: rec.trafficValue,
      geos: rec.geos,
      streak,
      firstDay,
      fresh: firstDay === today,
      articles: rec.articles,
    };
    // 需求类：有分类 + 有热度；新闻/体育只进 news
    if (cat.weight >= 70) {
      let score = cat.weight + Math.log10((rec.trafficValue || 1) + 10) * 12 + rec.geos.length * 6 + (item.fresh ? 18 : 0) + streak * 4;
      if (item.q.length > 90) score -= 25; // 长句基本都是新闻标题
      if (NEWSY.test(item.q)) score -= 40;
      item.score = Math.round(score);
      demand.push(item);
    } else if (cat.key === 'news' || cat.key === 'sport') {
      news.push(item);
    }
    // 全量分类桶（页面上按类分组展示「今天大家在搜什么」）
    if (buckets[cat.key]) buckets[cat.key].push(item);
  }

  demand.sort((a, b) => b.score - a.score);
  news.sort((a, b) => b.trafficValue - a.trafficValue);
  for (const k of Object.keys(buckets)) {
    buckets[k].sort((a, b) => b.trafficValue - a.trafficValue);
    buckets[k] = buckets[k].slice(0, 12);
  }

  const momentum = buildMomentum();
  const newTopics = diffNewTopics((readJSON(D('radar.json'), { topics: [] }).topics) || [], today);

  const signals = {
    at: (daily && daily.data && daily.data.US && daily.data.US.fetchedAt) || Date.now(),
    date: today,
    stats: {
      queries: geoSeen.size,
      geos: geos.length,
      demand: demand.length,
      fresh: newToday,
      historyDays: histDays.length,
    },
    demand: demand.slice(0, 60),
    buckets,
    newTopics,
    news: news.slice(0, 12),
    momentum,
  };
  return signals;
}

function writeSignals(opts) {
  const s = buildSignals(opts);
  fs.writeFileSync(path.join(ROOT, 'data', 'signals.json'), JSON.stringify(s, null, 1), 'utf8');
  return s;
}

if (require.main === module) {
  const s = writeSignals({});
  console.log('信号生成完成 @ ' + s.date);
  console.log('  热榜查询 ' + s.stats.queries + ' 条 / 地区 ' + s.stats.geos + ' / 其中需求类 ' + s.stats.demand + ' / 今日首次出现 ' + s.stats.fresh);
  console.log('  历史天数 ' + s.stats.historyDays);
  console.log('  --- 需求信号 top 8');
  s.demand.slice(0, 8).forEach((d, i) => console.log('   ' + (i + 1) + '. [' + d.cat + '] ' + d.q.slice(0, 60) + ' | ' + d.traffic + ' | ' + d.geos.join('/')));
  console.log('  --- 品类升温 top 6');
  s.momentum.slice(0, 6).forEach((m, i) => console.log('   ' + (i + 1) + '. ' + m.keyword + ' | 动量 +' + m.mom + '% | vol ' + m.vol + ' | g90 ' + m.g90 + '%'));
}

module.exports = { buildSignals, writeSignals, classify };
