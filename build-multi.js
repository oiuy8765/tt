'use strict';

/**
 * 多语言静态站生成器。
 *
 * 每种语言一套独立 URL、独立 HTML、独立 hreflang，内容在构建时就写进 HTML，
 * 不依赖 JS —— 这是能被搜索引擎收录的前提。
 *
 *   /                     zh-CN
 *   /zh-tw/  /en/  /ja/  /ko/
 *        index.html            机会库首页（静态渲染前 60 条 + 筛选交互）
 *        topics/<slug>.html    关键词详情页（871 条 × 5 语言）
 *        topics/index.html     全量索引页（分页，保证内链可达）
 *        daily.html            今日热榜快照
 *        about/privacy/contact.html
 *
 * 用法：node build-multi.js（build-static.js 会自动调用）
 */

const fs = require('fs');
const path = require('path');
const { translate, loadCache } = require('./i18n/translate');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const SITE = 'https://trendsift.site';
const PER_PAGE = 200;
// 静态资源缓存破坏：每次构建都变，浏览器绝不再用旧脚本/样式
const CACHE_VER = 'b' + Date.now().toString(36);

const LANGS = [
  { code: 'zh-CN', prefix: '', htmlLang: 'zh-CN', label: '简体中文', hreflang: 'zh-Hans' },
  { code: 'zh-TW', prefix: '/zh-tw', htmlLang: 'zh-Hant-TW', label: '繁體中文', hreflang: 'zh-Hant' },
  { code: 'en', prefix: '/en', htmlLang: 'en', label: 'English', hreflang: 'en' },
  { code: 'ja', prefix: '/ja', htmlLang: 'ja', label: '日本語', hreflang: 'ja' },
  { code: 'ko', prefix: '/ko', htmlLang: 'ko', label: '한국어', hreflang: 'ko' },
];

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Cloudflare Web Analytics：data/analytics.json 里配 {"cfToken":"..."} 才会输出统计脚本，
// 没配就完全不注入（不拖慢页面，也不留死代码）
function analyticsTag() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'analytics.json'), 'utf8'));
    if (cfg && cfg.cfToken && /^[\w-]{16,}$/.test(cfg.cfToken)) {
      return '<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon=\'{"token": "' + cfg.cfToken + '"}\'></script>';
    }
  } catch (e) {}
  return '';
}

const MONTHS = {
  'zh-CN': ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
  'zh-TW': ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  ja: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
  ko: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
};

/* ------------------------------ 工具 ------------------------------ */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readJSON(p, dflt) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return dflt;
  }
}

function fmtNum(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(Math.round(n));
}

function fmtFull(n) {
  if (n == null || isNaN(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

function pct(v) {
  if (v == null || isNaN(v)) return '—';
  return (v > 0 ? '+' : '') + Math.round(v * 10) / 10 + '%';
}

function sparkSvg(values, w, h, cls) {
  const arr = (values || []).filter((v) => typeof v === 'number');
  if (arr.length < 2) return '';
  const max = Math.max.apply(null, arr);
  const min = Math.min.apply(null, arr);
  const span = max - min || 1;
  const step = w / (arr.length - 1);
  const pts = arr
    .map((v, i) => (i * step).toFixed(1) + ',' + (h - ((v - min) / span) * (h - 4) - 2).toFixed(1))
    .join(' ');
  const area = '0,' + h + ' ' + pts + ' ' + w + ',' + h;
  return (
    '<svg class="' + cls + '" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img" aria-label="trend">' +
    '<polygon points="' + area + '" fill="rgba(81,69,229,.10)"></polygon>' +
    '<polyline points="' + pts + '" fill="none" stroke="#5145e5" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>' +
    '</svg>'
  );
}

/**
 * 完整历史折线（最长 269 个月）。
 * 原来只画最近 24 个月，等于把 22 年的数据白扔了：看不出「这是新词还是二十年的老品类」。
 * 带年份刻度 + 峰值点 + 起量点。
 */
function histChart(hist, inflection) {
  if (!hist || !hist.v || hist.v.length < 6) return '';
  const W = 760;
  const H = 190;
  const PB = 22;
  const PT = 10;
  const v = hist.v;
  const n = v.length;
  let max = 0;
  for (const x of v) if (x > max) max = x;
  if (max <= 0) max = 1;
  const step = W / (n - 1);
  const yOf = (val) => H - PB - (val / max) * (H - PB - PT);

  const pts = v.map((val, i) => (i * step).toFixed(1) + ',' + yOf(val).toFixed(1)).join(' ');
  const area = '0,' + (H - PB) + ' ' + pts + ' ' + W + ',' + (H - PB);

  const d0 = new Date(hist.t0 * 1000);
  const y0 = d0.getUTCFullYear();
  const m0 = d0.getUTCMonth() + 1;
  const idxOfYm = (ym) => {
    const parts = String(ym || '').split('-');
    const yy = Number(parts[0]);
    const mm = Number(parts[1]);
    if (!yy || !mm) return -1;
    const k = (yy - y0) * 12 + (mm - m0);
    return k >= 0 && k < n ? k : -1;
  };

  let ticks = '';
  for (let yr = Math.ceil(y0 / 5) * 5; yr <= y0 + n / 12 + 1; yr += 5) {
    const idx = (yr - y0) * 12 + (1 - m0);
    if (idx < 0 || idx >= n) continue;
    const x = idx * step;
    ticks +=
      '<line x1="' + x.toFixed(0) + '" y1="' + PT + '" x2="' + x.toFixed(0) + '" y2="' + (H - PB) +
      '" stroke="currentColor" stroke-opacity=".1" stroke-width="1"/>' +
      '<text x="' + x.toFixed(0) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity=".5">' + yr + '</text>';
  }

  let peakIdx = 0;
  for (let i = 1; i < n; i++) if (v[i] > v[peakIdx]) peakIdx = i;
  const peakMark =
    '<circle cx="' + (peakIdx * step).toFixed(1) + '" cy="' + yOf(v[peakIdx]).toFixed(1) +
    '" r="3" fill="currentColor" fill-opacity=".35"/>';

  let startMark = '';
  if (inflection && inflection.at) {
    const k = idxOfYm(inflection.at);
    if (k > 0) {
      const x = (k * step).toFixed(1);
      const yy = yOf(v[k]).toFixed(1);
      startMark =
        '<line x1="' + x + '" y1="' + yy + '" x2="' + x + '" y2="' + (H - PB) +
        '" stroke="#5145e5" stroke-width="1" stroke-dasharray="3 3" opacity=".5"/>' +
        '<circle cx="' + x + '" cy="' + yy + '" r="4" fill="#fff" stroke="#5145e5" stroke-width="2.5"/>';
    }
  }

  return (
    '<svg class="hist-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="monthly search interest history">' +
    '<polygon points="' + area + '" fill="rgba(81,69,229,.09)"></polygon>' +
    '<polyline points="' + pts + '" fill="none" stroke="#5145e5" stroke-width="1.6" stroke-linejoin="round"></polyline>' +
    ticks +
    peakMark +
    startMark +
    '</svg>'
  );
}

/** 详情页 FAQ 的两问两答，按语言手写（避免翻译接口改坏占位符） */
const FAQ_L = {
  'zh-CN': {
    q1: '{KW} 现在月搜索量是多少',
    a1: '月搜索量约 {VOL}（估算值），近 90 天增长 {G90}。',
    q2: '{KW} 适合做网站还是选品',
    a2: '主要看载体与形态。{REASON}',
  },
  'zh-TW': {
    q1: '{KW} 現在月搜尋量是多少',
    a1: '月搜尋量約 {VOL}（估算值），近 90 天成長 {G90}。',
    q2: '{KW} 適合做網站還是選品',
    a2: '主要看載體與形態。{REASON}',
  },
  en: {
    q1: 'What is the monthly search volume for {KW}',
    a1: 'About {VOL} searches per month (estimate); {G90} over the last 90 days.',
    q2: 'Is {KW} better for a website or a product',
    a2: 'It mainly comes down to the carrier and the form. {REASON}',
  },
  ja: {
    q1: '{KW}の月間検索数は？',
    a1: '月間検索数は約 {VOL}（推定値）、過去90日間の増加率は {G90} です。',
    q2: '{KW}はウェブサイト向け？物販向け？',
    a2: '判断の軸は提供形態と形です。{REASON}',
  },
  ko: {
    q1: '{KW}의 월간 검색량은 얼마인가요?',
    a1: '월간 검색량은 약 {VOL}(추정치)이며, 최근 90일 증가율은 {G90}입니다.',
    q2: '{KW}는 웹사이트에 적합한가요, 상품에 적합한가요?',
    a2: '판단 기준은 제공 형태와 유형입니다. {REASON}',
  },
};

/** 对比页说明：曲线按各自峰值归一，必须写清楚，否则会把「高度」误读成绝对量 */
const CMP_NOTE = {
  'zh-CN': '每条曲线按自身 22 年峰值缩放到 100，比的是走势形状与起量节奏；绝对量级看图例和下方表格。',
  'zh-TW': '每條曲線按自身 22 年峰值縮放到 100，比的是走勢形狀與起量節奏；絕對量級看圖例和下方表格。',
  en: 'Each line is scaled to its own 22-year peak (=100), so you are comparing shape and timing, not absolute volume. Use the legend and the table below for magnitude.',
  ja: '各曲線は自身の22年間ピークを100として正規化しています。比べられるのは推移の形と立ち上がりの時期で、絶対量は凡例と下の表を参照してください。',
  ko: '각 곡선은 자체 22년 최고점을 100으로 정규화했습니다. 비교되는 것은 추세의 모양과 상승 시점이며, 절대 규모는 범례와 아래 표를 보세요.',
};

const CHANNEL_NAME = {  facebook: 'Facebook',
  instagram: 'Instagram',
  reddit: 'Reddit',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  pinterest: 'Pinterest',
  twitter: 'X',
  linkedin: 'LinkedIn',
};

/** 八个社媒渠道各自的提及量：主战场是哪个平台，冷启动就该从哪开始 */
function channelBars(social) {
  if (!social) return '';
  const rows = Object.keys(social)
    .map((c) => [c, Number(social[c]) || 0])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!rows.length) return '';
  const max = rows[0][1];
  return (
    '<div class="ch-list">' +
    rows
      .map(
        ([c, n]) =>
          '<div class="ch-row"><span class="ch-name">' + esc(CHANNEL_NAME[c] || c) + '</span>' +
          '<span class="ch-bar"><i style="width:' + Math.max(3, Math.round((n / max) * 100)) + '%"></i></span>' +
          '<span class="ch-val">' + fmtNum(n) + '</span></div>'
      )
      .join('') +
    '</div>'
  );
}

/** 机会分拆解：让用户看到 87 分是「增长 24 + 规模 30 + …」加出来的，不是黑盒 */
function scoreBars(parts, t) {
  if (!parts) return '';
  const rows = [
    ['增长', 'growth', 30],
    ['规模', 'scale', 30],
    ['稳定', 'stable', 18],
    ['新鲜度', 'fresh', 12],
    ['可覆盖度', 'cover', 10],
  ];
  return (
    '<div class="score-box">' +
    rows
      .map(([k, key, w]) => {
        const val = parts[key] == null ? 0 : parts[key];
        return (
          '<div class="sc-row"><span class="sc-k">' + esc(t(k)) + '</span>' +
          '<span class="sc-bar"><i style="width:' + Math.max(2, val) + '%"></i></span>' +
          '<span class="sc-v">' + val + '</span>' +
          '<span class="sc-w">' + w + '%</span></div>'
        );
      })
      .join('') +
    '</div>'
  );
}

function seasonBars(season, lang) {
  if (!season || !season.months) return '';
  const ms = MONTHS[lang] || MONTHS.en;
  return (
    '<div class="season-bars">' +
    season.months
      .map((v, i) => {
        const hh = Math.max(6, Math.round((v / (Math.max.apply(null, season.months) || 1)) * 56));
        const hot = i === season.peakMonth;
        return (
          '<div class="sb' + (hot ? ' hot' : '') + '">' +
          '<i style="height:' + hh + 'px"></i><span>' + ms[i] + '</span></div>'
        );
      })
      .join('') +
    '</div>'
  );
}

/* ------------------------------ 词典 ------------------------------ */

let UI_RAW = {};
let SITE_DATA = null;
let ZH_DICT = {};
let ADVICE = {};

function loadDicts() {
  UI_RAW = readJSON(path.join(ROOT, 'data', 'i18n', 'ui.json'), {});
  ADVICE = readJSON(path.join(ROOT, 'data', 'i18n', 'advice.json'), {});
  SITE_DATA = readJSON(path.join(ROOT, 'data', 'site-data.json'), { topics: [] });
  const raw = readJSON(path.join(ROOT, 'data', 'zh-dict.json'), {});
  // 简中词典：短词有 @kw@ 版本（商品语境），优先用
  for (const k of Object.keys(raw)) {
    if (k.startsWith('@kw@')) ZH_DICT[k.slice(4)] = raw[k];
  }
  for (const k of Object.keys(raw)) {
    if (!k.startsWith('@kw@') && !ZH_DICT[k]) ZH_DICT[k] = raw[k];
  }
}

const CONTENT = {};

// 「飙升相关查询」缓存：scripts/fetch-rising.js 在 CI 里增量抓取（data/rising-cache.json）
const RISING = readJSON(path.join(ROOT, 'data', 'rising-cache.json'), { items: {} }).items || {};
// 关键词规范化索引（norm → topic），在构建循环里赋值，topicPage 用于站内链接匹配
let KW_INDEX = {};

function loadContentDicts() {
  for (const l of LANGS) {
    if (l.code === 'zh-CN') {
      CONTENT[l.code] = ZH_DICT;
    } else {
      CONTENT[l.code] = readJSON(path.join(ROOT, 'data', 'i18n', 'topics-' + l.code + '.json'), {});
    }
  }
}

function ui(lang) {
  // 返回 t 函数
  const dict = lang === 'zh-CN' ? null : UI_RAW[lang] || {};
  return function t(key) {
    if (lang === 'zh-CN') return key;
    const v = dict && dict[key];
    return v || key;
  };
}

function tx(lang, text) {
  if (!text) return '';
  const d = CONTENT[lang] || {};
  return d[text] || text;
}

// 「原文为主、译文可选」：同一位置同时输出原文与译文，body.tr-on 时显示译文
function dualSpan(lang, text) {
  if (!text) return '';
  const tr = tx(lang, text);
  if (!tr || tr === text) return esc(text);
  if (lang === 'en') return esc(tr);
  return '<span class="tr-o">' + esc(text) + '</span><span class="tr-t">' + esc(tr) + '</span>';
}

// 简介双语：原文/译文各自查整段词典后再截断，避免「先截断再查词典查不到译文」
// 英文页直接显示英文（访客不需要中文对照），其余语言用原文/译文双视图
function dualDescSpan(lang, text, max) {
  if (!text) return '';
  const full = String(text);
  const tr = tx(lang, full);
  const o = full.length > max ? full.slice(0, max) + '…' : full;
  const t2 = tr && tr !== full ? (tr.length > max ? tr.slice(0, max) + '…' : tr) : '';
  if (!t2) return esc(o);
  if (lang === 'en') return esc(t2);
  return '<span class="tr-o">' + esc(o) + '</span><span class="tr-t">' + esc(t2) + '</span>';
}

// 系统生成文案（建议 / 渠道提示）：直接给译文，不做原文对照
function sysText(lang, text) {
  if (!text) return '';
  return tx(lang, String(text).replace(/\s+/g, ' ').trim());
}

// 分类标签：slug → 中文标签 → 译文
const CAT_LABEL = {
  software: '软件', technology: '科技', business: '商业', marketing: '营销', finance: '金融',
  investing: '投资', insurance: '保险', legal: '法律', health: '健康', medical: '医疗',
  supplements: '保健品', nutrition: '营养', fitness: '健身', 'personal-care': '个护', beauty: '美妆',
  'makeup-cosmetics': '彩妆', skincare: '护肤', fashion: '时尚', clothing: '服饰', shoes: '鞋类',
  jewelry: '珠宝', home: '家居', 'home-decor': '家居装饰', furniture: '家具', kitchen: '厨房',
  'home-improvement': '家装', garden: '园艺', 'gardening-agriculture': '园艺农业',
  'food-beverage': '食品饮料', food: '食品', beverage: '饮料', cooking: '烹饪', cpg: '快消品',
  retail: '零售', ecommerce: '电商', product: '产品', travel: '旅行', hospitality: '酒店旅游',
  'sports-outdoors': '运动户外', entertainment: '娱乐', gaming: '游戏', pets: '宠物',
  education: '教育', automotive: '汽车', 'baby-kids': '母婴', wedding: '婚庆',
  'diy-crafts': '手工', sustainability: '环保', energy: '能源', real_estate: '房产',
  construction: '建筑', manufacturing: '制造', logistics: '物流', security: '安防',
  photography: '摄影', music: '音乐', art: '艺术', books: '图书', office: '办公',
  tools: '工具', hardware: '硬件', electronics: '电子', appliances: '家电',
  sleep: '睡眠', drink: '饮品', snacks: '零食', outdoor: '户外',
};
function catText(lang, c) {
  const zh = CAT_LABEL[c] || c;
  if (lang === 'zh-CN') return zh;
  return tx(lang, zh) || zh;
}

// 季节柱状图（12 个月相对强弱）
function seasonBarHtml(lang, tp) {
  if (!tp.season || !tp.season.months) return '';
  const t = ui(lang);
  const ms = tp.season.months;
  const strong = tp.season.strength >= 0.4;
  const bars = ms
    .map((v, i) => {
      const h = v == null ? 8 : Math.max(10, Math.round(v * 100));
      const pk = tp.season.peakMonth === i + 1 ? ' pk' : '';
      return '<i class="sb' + pk + '" style="height:' + h + '%"></i>';
    })
    .join('');
  let note;
  if (!strong) note = t('全年平坦');
  else {
    note = t('峰 [[M]] 月 · [[P]] 月前准备')
      .replace('[[M]]', tp.season.peakMonth)
      .replace('[[P]]', tp.seasonPrepMonth || tp.season.peakMonth);
  }
  return (
    '<div class="season' + (strong ? ' strong' : '') + '">' +
    '<span class="season-lbl">' + esc(t('季节')) + '</span>' +
    '<div class="season-bars">' + bars + '</div>' +
    '<span class="season-note">' + esc(note) + '</span></div>'
  );
}

// 原文/译文切换按钮（英文页直接显示英文，无需切换；其余语言包括简中都有双语内容）
function trToggleHtml(lang) {
  if (lang === 'en') return '';
  const t = ui(lang);
  return (
    '<div class="daily-ctl tr-ctl" id="trToggle" role="group" aria-label="' + esc(t('显示译文')) + '">' +
    '<button type="button" class="seg on" data-mode="orig">' + esc(t('显示原文')) + '</button>' +
    '<button type="button" class="seg" data-mode="tr">' + esc(t('显示译文')) + '</button></div>'
  );
}

/**
 * 详情页的「可以做什么」：按模板 id 取当前语言的文案，再填变量。
 * 每条话题的动作模板和时机句不同，871 个页面不会共用同一句话。
 */
function adviceLines(lang, tp) {
  const p = tp && tp.adviceParts;
  const D = ADVICE[lang] || ADVICE['zh-CN'] || {};
  const ZH = ADVICE['zh-CN'] || {};
  if (!p || !p.a) return [];
  const tpl = (id) => D[id] || ZH[id] || '';
  const fill = (s, map) => {
    const up = {};
    for (const k of Object.keys(map)) up[k.toUpperCase()] = map[k];
    return String(s || '').replace(/\[\[(\w+)\]\]/g, (m, k) => (up[k.toUpperCase()] == null ? m : String(up[k.toUpperCase()])));
  };
  // 英文用月份名，中日韩用数字（模板里已经带「月」）
  const vars = Object.assign({}, (p.b && p.b.vars) || {});
  if (lang === 'en' && vars.M != null) {
    const idx = Number(vars.M) - 1;
    vars.M = EN_MONTHS[idx] || vars.M;
  }

  const kw = tx(lang, p.a.kw) || p.a.kw;
  const act = fill(tpl(p.a.id), {
    KW: kw,
    WHO: tpl(p.a.who),
    PRICE: tpl(p.a.price),
    PLATFORM: p.a.platform,
  });
  const time = p.b ? fill(tpl(p.b.id), vars) : '';
  return [act, time].filter(Boolean);
}

/* ------------------------------ 布局 ------------------------------ */

function altLinks(relPath) {
  // relPath 形如 '/topics/shoe-bag' 或 '/'（不带语言前缀）
  const out = [];
  for (const l of LANGS) {
    const href = SITE + l.prefix + (relPath === '/' ? '/' : relPath);
    out.push('<link rel="alternate" hreflang="' + l.hreflang + '" href="' + href + '" />');
  }
  out.push('<link rel="alternate" hreflang="x-default" href="' + SITE + (relPath === '/' ? '/' : relPath) + '" />');
  return out.join('\n');
}

function langSwitch(lang, relPath) {
  const cur = LANGS.find((l) => l.code === lang);
  const items = LANGS.map((l) => {
    const href = l.prefix + (relPath === '/' ? '/' : relPath) + (relPath.endsWith('/') ? '' : '');
    const on = l.code === lang ? ' class="on"' : '';
    return '<a href="' + href + '" hreflang="' + l.hreflang + '" lang="' + l.htmlLang + '"' + on + '>' + l.label + '</a>';
  }).join('');
  return (
    '<div class="lang-switch">' +
    '<button class="lang-btn" aria-haspopup="true" aria-expanded="false" title="' + esc(cur.label) + '">' +
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.4"/><path d="M1.8 8h12.4M8 1.8c1.7 1.7 2.6 3.9 2.6 6.2S9.7 12.5 8 14.2C6.3 12.5 5.4 10.3 5.4 8S6.3 3.5 8 1.8Z" stroke="currentColor" stroke-width="1.2"/></svg>' +
    '<span>' + esc(cur.label) + '</span></button>' +
    '<div class="lang-menu">' + items + '</div>' +
    '</div>'
  );
}

function layout(lang, opts) {
  const t = ui(lang);
  const L = LANGS.find((x) => x.code === lang);
  const rel = opts.rel || '/';
  const canonical = SITE + L.prefix + (rel === '/' ? '/' : rel);
  const title = opts.title;
  const desc = opts.desc;
  const jsonld = opts.jsonld ? '<script type="application/ld+json">' + JSON.stringify(opts.jsonld) + '</script>' : '';
  const isHome = rel === '/';
  // 当前语言的界面词表内嵌进页面，JS 接管筛选时不必再请求
  const uiDict = {};
  if (lang !== 'zh-CN') {
    const d = UI_RAW[lang] || {};
    for (const k of Object.keys(d)) uiDict[k] = d[k];
  }

  return `<!DOCTYPE html>
<html lang="${L.htmlLang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#5145e5" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<meta name="robots" content="index,follow,max-image-preview:large" />
<link rel="canonical" href="${canonical}" />
${altLinks(rel)}
<meta property="og:type" content="website" />
<meta property="og:site_name" content="TrendSift" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:url" content="${canonical}" />
<meta property="og:locale" content="${L.htmlLang.replace('-', '_')}" />
<meta property="og:image" content="${SITE}/og.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="TrendSift — Google Trends rising searches" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(desc)}" />
<meta name="twitter:image" content="${SITE}/og.png" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="icon" type="image/x-icon" href="/favicon.ico" sizes="32x32" />
<link rel="apple-touch-icon" href="/logo.svg" />
<link rel="stylesheet" href="/styles.css?v=${CACHE_VER}" />
${jsonld}
${analyticsTag()}
</head>
<body data-lang="${lang}" data-base="${L.prefix}">
<header class="topbar">
  <a class="brand" href="${L.prefix}/" aria-label="TrendSift">
    <img class="logo" src="/logo.svg" width="38" height="38" alt="" />
    <span class="brand-text">
      <span class="wordmark">Trend<span class="wm-b">Sift</span></span>
      <span class="tagline">${esc(t('Google Trends 上升词 · 选品 / 建站 / 投放'))}</span>
    </span>
  </a>
  <nav class="mainnav" aria-label="main">
    <a href="${L.prefix}/"${isHome ? ' class="on"' : ''}>${esc(t('机会库'))}</a>
    <a href="${L.prefix}/daily.html"${rel === '/daily' ? ' class="on"' : ''}>${esc(t('今日热榜'))}</a>
    <a href="${L.prefix}/lookup/"${rel.startsWith('/lookup') ? ' class="on"' : ''}>${esc(t('关键词分析'))}</a>
    <a href="${L.prefix}/topics/"${rel.startsWith('/topics') ? ' class="on"' : ''}>${esc(t('关键词详情'))}</a>
    <a href="${L.prefix}/compare/"${rel.startsWith('/compare') ? ' class="on"' : ''}>${esc(t('对比'))}</a>
    <a href="${L.prefix}/saved.html"${rel === '/saved' ? ' class="on"' : ''}>${esc(t('我的清单'))}</a>
    <a href="${L.prefix}/about.html"${rel === '/about' ? ' class="on"' : ''}>${esc(t('关于'))}</a>
  </nav>
  <div class="topbar-right">
    ${langSwitch(lang, rel)}
  </div>
</header>
${opts.body}
<footer class="footer">
  <div class="foot-inner">
    <div class="foot-brand">
      <img class="foot-logo" src="/logo.svg" width="30" height="30" alt="" />
      <div>
        <div class="foot-name">TrendSift</div>
        <div class="foot-tag">${esc(t('数据来自 Google Trends 的搜索热度，只收搜索量持续上升的产品、品类、服务与工具，每条都带 22 年月度历史曲线。'))}</div>
      </div>
    </div>
    <nav class="foot-links" aria-label="site">
      <a href="${L.prefix}/about.html">${esc(t('关于我们'))}</a><span class="foot-sep">·</span>
      <a href="${L.prefix}/privacy.html">${esc(t('隐私政策'))}</a><span class="foot-sep">·</span>
      <a href="${L.prefix}/contact.html">${esc(t('联系我们'))}</a>
    </nav>
  </div>
  <div class="foot-note">© 2026 TrendSift · ${esc(t('数据每日更新'))} · ${esc(t('无需注册'))} · ${esc(t('不构成投资建议'))}</div>
</footer>
<script>window.__LANG__=${JSON.stringify(lang)};window.__BASE__=${JSON.stringify(L.prefix)};window.__T__=${JSON.stringify(uiDict)};</script>
${opts.script ? '<script src="' + opts.script + '" defer></script>' : ''}
<script src="/lang.js?v=${CACHE_VER}"></script>
</body>
</html>`;
}

/* ------------------------------ 卡片 ------------------------------ */

const FORM_CLASS = {
  content: 'f-content',
  app: 'f-app',
  saas: 'f-saas',
  tool: 'f-tool',
};

function cardHtml(lang, tp, i) {
  const t = ui(lang);
  const kw = dualSpan(lang, tp.keyword);
  const desc = dualDescSpan(lang, tp.descShort || '', 210);
  const href = LANGS.find((l) => l.code === lang).prefix + '/topics/' + tp.slug + '.html';

  const chips = [];
  if (tp.carrier === 'web' && (tp.digitalKind === 'need' || tp.digitalKind === 'company'))
    chips.push('<span class="kind-badge ' + (tp.digitalKind === 'need' ? 'k-need' : 'k-comp') + '">' +
      esc(t(tp.digitalKind === 'need' ? '可直接做' : '已有玩家')) + '</span>');
  if (tp.stageLabel) chips.push('<span class="mchip stag s-' + esc(tp.stage) + '">' + esc(t(tp.stageLabel)) + '</span>');
  if (tp.burstLabel && tp.burstWindows)
    chips.push('<span class="mchip bst b-' + esc(tp.burst) + '">' + esc(t(tp.burstLabel)) + ' ' + tp.burstWindows + '/4</span>');
  if (tp.windowLabel) chips.push('<span class="mchip win w-' + esc(tp.windowKey) + '">' + esc(t(tp.windowLabel)) + '</span>');
  if (tp.platformLabel) chips.push('<span class="mchip plat">' + esc(tp.platform) + '</span>');
  if (tp.evergreen) chips.push('<span class="mchip evg">' + esc(t('长青词')) + '</span>');
  const cats = (tp.categories || [])
    .slice(0, 3)
    .map((c) => '<span class="cat-tag">' + esc(catText(lang, c)) + '</span>')
    .join('');

  const formBadge =
    tp.carrier === 'web' && tp.formLabel
      ? '<span class="form-badge ' + (FORM_CLASS[tp.form] || '') + '">' + esc(t(tp.formLabel)) + '</span>'
      : '';

  const advice = tp.carrier === 'web' && tp.digitalAdvice ? tp.digitalAdvice : tp.advice;
  const platAdvice = tp.carrier !== 'web' && tp.platformAdvice ? tp.platformAdvice : '';

  return (
    '<article class="opp" data-slug="' + esc(tp.slug) + '">' +
    '<div class="opp-rank">' + (i + 1) + '</div>' +
    '<div class="opp-body">' +
    '<div class="opp-head">' +
    '<a class="opp-kw" href="' + href + '">' + kw + '</a>' +
    '<span class="opp-type t-' + esc(tp.type) + '">' + esc(t(tp.typeLabel)) + '</span>' +
    formBadge +
    '</div>' +
    (desc ? '<p class="opp-desc">' + desc + '</p>' : '') +
    (cats || chips.length ? '<div class="opp-cats">' + chips.join('') + cats + '</div>' : '') +
    (advice ? '<div class="opp-advice">💡 ' + esc(sysText(lang, advice)) + '</div>' : '') +
    (platAdvice ? '<div class="opp-plat-advice">📣 ' + esc(sysText(lang, platAdvice)) + '</div>' : '') +
    seasonBarHtml(lang, tp) +
    '</div>' +
    '<div class="opp-nums">' +
    '<div class="num"><b>' + fmtNum(tp.vol) + '</b><span>' + esc(t('月搜索量')) + '</span></div>' +
    '<div class="num"><b class="' + (tp.g90 > 0 ? 'up' : 'down') + '">' + pct(tp.g90) + '</b><span>' + esc(t('90 天增长')) + '</span></div>' +
    '<div class="num"><b class="' + (tp.g12 > 0 ? 'up' : 'down') + '">' + pct(tp.g12) + '</b><span>' + esc(t('12 个月增长')) + '</span></div>' +
    (tp.socialTotal > 0 ? '<div class="num"><b>' + fmtNum(tp.socialTotal) + '</b><span>' + esc(t('社媒提及')) + '</span></div>' : '') +
    '</div>' +
    '<div class="opp-score">' +
    '<b>' + Math.round(tp.carrier === 'web' ? tp.buildScore || 0 : tp.score || 0) + '</b>' +
    '<span>' + esc(t(tp.carrier === 'web' ? '建站分' : '选品分')) + '</span>' +
    sparkSvg(tp.spark, 96, 34, 'spark') +
    '<span class="opp-spark-cap">' + esc(t('近 24 个月')) + '</span>' +
    '</div>' +
    '</article>'
  );
}

/* ------------------------------ 首页 ------------------------------ */

function homePage(lang) {
  const t = ui(lang);
  const L = LANGS.find((x) => x.code === lang);
  const topics = (SITE_DATA.topics || []).slice();
  const scored = topics.slice().sort((a, b) => (b.buildScore || b.score || 0) - (a.buildScore || a.score || 0));
  const top = scored.slice(0, 60);
  const counts = SITE_DATA.counts || {};

  const stats = [
    { n: topics.length, k: '全站话题' },
    { n: topics.filter((x) => x.carrier === 'web').length, k: '可做线上' },
    { n: topics.filter((x) => x.carrier === 'goods').length, k: '实物品类' },
    { n: topics.filter((x) => x.windowKey === 'open' || x.windowKey === 'fresh').length, k: '窗口期' },
  ];

  const faq = [
    ['这些数据是 Google 官方数据吗', '不是精确值。搜索热度来自 Google Trends 的公开指数，月搜索量是按关键词工具通用口径换算的估算值。'],
    ['这些词是怎么选出来的', '从 Google Trends 中筛选出搜索量持续上升的产品、品类、服务与工具，剔除纯新闻事件，再按历史曲线计算增速、季节性与波动。'],
    ['数据多久更新一次', '榜单每日更新，历史曲线每月新增一个数据点。'],
    ['可以免费用吗', '可以，无需注册。站内内容仅供初筛参考，不构成商业或投资建议。'],
  ];

  const faqHtml = faq
    .map(
      ([q, a]) =>
        '<details class="faq-item"><summary>' + esc(t(q)) + '</summary><p>' + esc(t(a)) + '</p></details>'
    )
    .join('');

  const body = `<main class="wrap">
  <section class="hero">
    <div class="hero-main">
      <div class="eyebrow"><span class="dot"></span>${esc(t('数据每日更新'))} · ${topics.length} ${esc(t('个上升话题'))}</div>
      <h1 class="hero-title">${esc(t('什么在涨，而且现在还来得及'))}</h1>
      <p>${esc(t('数据来自 Google Trends 的搜索热度，只收搜索量持续上升的产品、品类、服务与工具，每条都带 22 年月度历史曲线。'))}</p>
      <p class="hero-sub">${esc(t('不是新闻热搜，而是未来半年什么会更好卖。'))}</p>
    </div>
    <div class="hero-stats">
      ${stats
        .map(
          (s) =>
            '<div class="hstat"><b>' + s.n + '</b><span>' + esc(t(s.k)) + '</span></div>'
        )
        .join('')}
    </div>
  </section>

  <div class="step-label"><b>1</b> ${esc(t('你想做什么'))}</div>
  <div class="carrier-pick" id="carrierPick">
    <button class="carrier active" data-carrier="all">
      <span class="c-ico">${ICO.all}</span><span class="c-name">${esc(t('全部机会'))}</span>
      <span class="c-num" id="cNumAll">${topics.length}</span>
      <span class="c-desc">${esc(t('先看整体，再决定方向'))}</span>
    </button>
    <button class="carrier" data-carrier="web">
      <span class="c-ico">${ICO.web}</span><span class="c-name">${esc(t('网站 / APP / SaaS'))}</span>
      <span class="c-num" id="cNumWeb">${stats[1].n}</span>
      <span class="c-desc">${esc(t('纯线上交付，不用碰供应链'))}</span>
    </button>
    <button class="carrier" data-carrier="goods">
      <span class="c-ico">${ICO.goods}</span><span class="c-name">${esc(t('实体产品'))}</span>
      <span class="c-num" id="cNumGoods">${stats[2].n}</span>
      <span class="c-desc">${esc(t('选品、备货、带货'))}</span>
    </button>
  </div>

  <div class="step-label"><b>2</b> ${esc(t('在结果里挑'))}</div>
  <div class="card card-tight">
    <div class="row row-wrap toolbar">
      <input id="libSearch" class="input" type="search" placeholder="${esc(t('搜索关键词 / 类别'))}" />
      <button type="button" id="libCsv" class="btn btn-ghost" title="${esc(t('导出当前筛选结果'))}">${esc(t('导出 CSV'))}</button>
      <a class="btn btn-ghost" href="${L.prefix}/lookup/">${esc(t('实时查词'))}</a>
      <select id="libSpan" class="input input-sm" title="${esc(t('观察窗口'))}">
        <option value="">${esc(t('不限'))}</option>
        <option value="1">${esc(t('近 1 个月'))}</option>
        <option value="3">${esc(t('近 3 个月'))}</option>
        <option value="6">${esc(t('近 6 个月'))}</option>
        <option value="12">${esc(t('近 12 个月'))}</option>
        <option value="24">${esc(t('近 24 个月'))}</option>
      </select>
      <select id="libSort" class="input input-sm" title="${esc(t('排序'))}">
        <option value="auto">${esc(t('按推荐排序'))}</option>
        <option value="build">${esc(t('按建站适配度'))}</option>
        <option value="ads">${esc(t('按投放价值'))}</option>
        <option value="g90">${esc(t('按 90 天增长'))}</option>
        <option value="g12">${esc(t('按 12 个月增长'))}</option>
        <option value="vol">${esc(t('按搜索量'))}</option>
        <option value="social">${esc(t('按社媒热度'))}</option>
        <option value="window">${esc(t('按最新收录'))}</option>
        <option value="season">${esc(t('按季节紧迫度'))}</option>
      </select>
      <label class="toggle"><input type="checkbox" id="libRise" /><span>${esc(t('只看在涨'))}</span></label>
      <label class="toggle"><input type="checkbox" id="libNoBrand" /><span>${esc(t('排除品牌词'))}</span></label>
      ${trToggleHtml(lang)}
    </div>
  </div>

  <div class="lib-bar">
    <div id="libMeta" class="meta-line">
      <span>${esc(t('符合条件'))} <b>${topics.length}</b> ${esc(t('个话题'))}</span>
      <i class="sep">·</i><span class="dim">${esc(t('基于 Google Trends 搜索热度'))}</span>
    </div>
    <a class="btn btn-ghost btn-sm" href="${L.prefix}/topics/">${esc(t('浏览全部 [[N]] 个上升话题').replace(/\[\[n\]\]/i, topics.length))}</a>
  </div>

  <div id="libList" class="opp-list">
${top.map((x, i) => cardHtml(lang, x, i)).join('\n')}
  </div>

  <section class="home-faq">
    <h2>${esc(t('常见问题'))}</h2>
    ${faqHtml}
  </section>
</main>`;

  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        name: 'TrendSift',
        url: SITE + L.prefix + '/',
        inLanguage: L.htmlLang,
        potentialAction: {
          '@type': 'SearchAction',
          target: SITE + L.prefix + '/?q={search_term_string}',
          'query-input': 'required name=search_term_string',
        },
      },
      {
        '@type': 'Organization',
        name: 'TrendSift',
        url: SITE + '/',
        email: 'id_02081918@foxmail.com',
      },
      {
        '@type': 'Dataset',
        name: t('机会库') + ' · TrendSift',
        description: t('数据来自 Google Trends 的搜索热度，只收搜索量持续上升的产品、品类、服务与工具，每条都带 22 年月度历史曲线。'),
        url: SITE + L.prefix + '/',
        creator: { '@type': 'Organization', name: 'TrendSift' },
        variableMeasured: ['monthly search volume', '90-day growth', '12-month growth', 'seasonality', 'social mentions'],
        temporalCoverage: '2004/2026',
      },
      {
        '@type': 'FAQPage',
        mainEntity: faq.map(([q, a]) => ({
          '@type': 'Question',
          name: t(q),
          acceptedAnswer: { '@type': 'Answer', text: t(a) },
        })),
      },
    ],
  };

  return layout(lang, {
    rel: '/',
    title: 'TrendSift · ' + t('Google Trends 上升词 · 选品 / 建站 / 投放趋势分析'),
    desc: t('数据来自 Google Trends 的搜索热度，只收搜索量持续上升的产品、品类、服务与工具，每条都带 22 年月度历史曲线。') + ' ' + t('不是新闻热搜，而是未来半年什么会更好卖。'),
    body,
    jsonld,
  });
}

const ICO = {
  all: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.7" y="2.7" width="6" height="6" rx="1.7" stroke="currentColor" stroke-width="1.5"/><rect x="11.3" y="2.7" width="6" height="6" rx="1.7" stroke="currentColor" stroke-width="1.5"/><rect x="2.7" y="11.3" width="6" height="6" rx="1.7" stroke="currentColor" stroke-width="1.5"/><rect x="11.3" y="11.3" width="6" height="6" rx="1.7" stroke="currentColor" stroke-width="1.5"/></svg>',
  web: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.4" y="3.4" width="15.2" height="10.6" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M2.4 6.6h15.2" stroke="currentColor" stroke-width="1.5"/><path d="M7 17h6M10 14v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  goods: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2.8 17 6.6v6.8L10 17.2 3 13.4V6.6l7-3.8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M3.2 6.7 10 10.4l6.8-3.7M10 10.4v6.6" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
};

/* ------------------------------ 详情页 ------------------------------ */

function topicPage(lang, tp, related) {
  const t = ui(lang);
  const L = LANGS.find((x) => x.code === lang);
  const kw = tx(lang, tp.keyword) || tp.keyword;
  const desc = tx(lang, tp.descShort || '');
  const monthName = (MONTHS[lang] || MONTHS.en)[(tp.season && tp.season.peakMonth) || 0];
  const peakPct = tp.peak ? Math.round((tp.current / tp.peak) * 100) : null;
  const isWeb = tp.carrier === 'web';
  const formText = tp.formLabel ? t(tp.formLabel) : '';

  // 飙升相关查询（官方口径，CI 每日增量抓取）：
  // 相关词若命中站内话题 → 站内链接（内链网络）；否则外链 Google Trends explore
  const risingData = RISING[tp.keyword];
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const risingHtml = (() => {
    const rows = risingData && risingData.rising ? risingData.rising : [];
    if (!rows.length) {
      // 还没轮到抓取的词：引导去实时分析页（预填当前词）
      return (
        '<p class="chart-note">' + esc(t('该词的飙升相关查询还没有被轮询抓取，可以实时查询：')) + '</p>' +
        '<p><a class="btn btn-ghost" href="' + L.prefix + '/lookup/?q=' + encodeURIComponent(tp.keyword) + '">' +
        esc(t('实时查这个词的飙升相关查询')) + '</a></p>'
      );
    }
    const lis = rows
      .map((r) => {
        const hit = KW_INDEX[norm(r.query)];
        const inner = dualSpan(lang, r.query);
        const href = hit
          ? L.prefix + '/topics/' + hit.slug + '.html'
          : r.link || 'https://trends.google.com/trends/explore?q=' + encodeURIComponent(r.query);
        const ext = hit ? '' : ' target="_blank" rel="nofollow noopener"';
        return (
          '<li><a href="' + href + '"' + ext + '>' + inner + '</a>' +
          '<span class="rise-gain">' + esc(r.formattedValue || '') + '</span></li>'
        );
      })
      .join('');
    return (
      '<ul class="rel-list rise-list">' + lis + '</ul>' +
      '<p class="chart-note">' + esc(t('数据来自 Google Trends 官方「相关查询」口径，每日轮询更新。')) + ' ' +
      '<a href="' + L.prefix + '/lookup/?q=' + encodeURIComponent(tp.keyword) + '">' + esc(t('实时查词')) + '</a></p>'
    );
  })();
  const risingSection =
    '<h2>' + esc(t('飙升相关查询')) + '</h2>' + risingHtml;

  // 占位符大小写不敏感：翻译接口会把 [[MONTHS]] 改成 [[months]]
  const fill = (s, map) => {
    const up = {};
    for (const k of Object.keys(map)) up[k.toUpperCase()] = map[k];
    return String(s || '').replace(/\[\[(\w+)\]\]/g, (m, k) => {
      const v = up[k.toUpperCase()];
      return v == null ? m : String(v);
    });
  };

  const colon = lang === 'en' ? ': ' : '：';
  const line1 =
    t('月搜索量') + colon + fmtFull(tp.vol) + ' · ' +
    t('90 天增长') + colon + pct(tp.g90) + ' · ' +
    t('12 个月增长') + colon + pct(tp.g12);
  const line2 =
    tp.months && peakPct != null
      ? fill(t('历史曲线覆盖 [[MONTHS]] 个月，当前热度为历史峰值的 [[PEAK]]%。'), {
          MONTHS: tp.months,
          PEAK: peakPct,
        })
      : '';
  // 「可以做什么」用这条话题自己的动作 + 时机句，不再是全站同一个模板
  const advLines = adviceLines(lang, tp);
  const seasonal = tp.season && tp.season.strength > 0.35;

  // 历史图的 x 轴起点与峰值月份：从完整序列现算，不额外存字段
  // 历史序列是逐月点（每月一个），不能按 t0 + i*step 秒数加：step 是 31 天，
  // 22 年会累积出大半年的漂移，峰值月份和区间末月都会错位。按「月」加。
  const hT0 = tp.hist ? Number(tp.hist.t0) : NaN;
  const ymAt = (ts) => {
    const d = new Date(ts * 1000);
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 7);
  };
  const addMonths = (ym, k) => {
    const p = String(ym || '').split('-');
    const yy = Number(p[0]);
    const mm = Number(p[1]);
    if (!yy || !mm) return '';
    return new Date(Date.UTC(yy, mm - 1 + k, 1)).toISOString().slice(0, 7);
  };
  const histFrom = isFinite(hT0) ? ymAt(hT0) : '';
  const histTo = tp.hist && tp.hist.v && tp.hist.v.length ? addMonths(histFrom, tp.hist.v.length - 1) : '';
  let peakAt = '';
  if (tp.hist && tp.hist.v && tp.hist.v.length && histFrom) {
    let mi = 0;
    for (let i = 1; i < tp.hist.v.length; i++) if (tp.hist.v[i] > tp.hist.v[mi]) mi = i;
    peakAt = addMonths(histFrom, mi);
  }
  const peakNote =
    peakAt && peakPct != null
      ? ' · ' + fill(t('峰值出现在 [[AT]]，当前为峰值的 [[P]]%'), { AT: peakAt, P: peakPct })
      : '';

  // 拐点：这波从哪个月开始涨、涨了多少；老词还要单独说「近两年又加速了」
  const inf = tp.inflection;
  const rb = tp.recentBreak;
  const insRows = [];
  if (inf) {
    let v = fill(t('[[AT]] 起量，已持续 [[N]] 个月'), { AT: inf.at, N: inf.months });
    if (inf.gain != null) v += ' · ' + fill(t('从 [[FROM]] 涨到 [[TO]]，涨幅 [[GAIN]]'), {
      FROM: inf.from,
      TO: inf.to,
      GAIN: '+' + inf.gain + '%',
    });
    insRows.push(
      '<div class="ins-row"><span class="ins-k">' + esc(t('本轮起量')) + '</span><span class="ins-v">' + esc(v) + '</span></div>'
    );
  }
  if (rb && (!inf || rb.at !== inf.at)) {
    insRows.push(
      '<div class="ins-row"><span class="ins-k">' + esc(t('近期加速')) + '</span><span class="ins-v">' +
        esc(fill(t('近 24 个月低点在 [[AT]]，之后上涨 [[GAIN]]'), { AT: rb.at, GAIN: '+' + rb.gain + '%' })) +
        '</span></div>'
    );
  }
  const insightHtml = insRows.length ? '<div class="insight-box">' + insRows.join('') + '</div>' : '';

  const kpis = [
    { v: fmtNum(tp.vol), k: '月搜索量' },
    { v: pct(tp.g90), k: '90 天增长' },
    { v: pct(tp.g12), k: '12 个月增长' },
    { v: tp.platformLabel || '—', k: '主战场平台' },
  ];

  const rows = [
    ['月搜索量估算', fmtFull(tp.vol), ''],
    ['90 天增长', pct(tp.g90), ''],
    ['12 个月增长', pct(tp.g12), ''],
    ['收录时长', (tp.ageMonths || 0) + ' ' + t('个月'), ''],
    ['载体', isWeb ? t('网站 / APP / SaaS') : t('实体产品'), ''],
    ['形态', formText || '—', ''],
    ['机会类型', t(tp.typeLabel || ''), ''],
    ['阶段', t(tp.stageLabel || ''), ''],
    ['窗口', t(tp.windowLabel || ''), ''],
    ['季节强度', tp.season ? Math.round(tp.season.strength * 100) + '%' : '—', ''],
    ['波动率', tp.volatility != null ? Math.round(tp.volatility * 100) + '%' : '—', ''],
  ];

  const relHtml = related
    .map((r) => {
      return '<li><a href="' + L.prefix + '/topics/' + r.slug + '.html">' + dualSpan(lang, r.keyword) + '</a>' +
        '<span>' + fmtNum(r.vol) + ' · ' + pct(r.g12) + '</span></li>';
    })
    .join('');

  // FAQ 两句直接按语言写：走翻译接口时 [[G90]] / [[REASON]] 会被改成 [[G 90]]、[[理由]]、[KW] 之类，
  // 填不回去就会在页面上留下方括号。文案短，手写 5 语言更可靠。
  const F = FAQ_L[lang] || FAQ_L['zh-CN'];
  const reason = isWeb
    ? t('数字产品：纯线上交付，重点看获客成本与变现方式。')
    : t('实体产品：重点看供应链、季节性与物流成本。');
  const faq = [
    [F.q1.replace('{KW}', kw), F.a1.replace('{VOL}', fmtFull(tp.vol)).replace('{G90}', pct(tp.g90))],
    [F.q2.replace('{KW}', kw), F.a2.replace('{REASON}', reason)],
  ];

  const body = `<main class="wrap doc-main">
  <nav class="crumbs" aria-label="breadcrumb">
    <a href="${L.prefix}/">${esc(t('机会库'))}</a>
    <span>›</span>
    <a href="${L.prefix}/topics/">${esc(t('关键词详情'))}</a>
    <span>›</span>
    <span class="cur">${dualSpan(lang, tp.keyword)}</span>
  </nav>

  <article class="topic">
    <header class="topic-head">
      <div class="doc-eyebrow">${esc(t('关键词详情'))}</div>
      <h1>${dualSpan(lang, tp.keyword)}</h1>
      ${desc ? '<p class="doc-lead">' + dualSpan(lang, tp.descShort || '') + '</p>' : ''}
      ${trToggleHtml(lang)}
      <div class="opp-cats">
        <span class="mchip stag s-${esc(tp.stage)}">${esc(t(tp.stageLabel || ''))}</span>
        <span class="mchip win w-${esc(tp.windowKey || '')}">${esc(t(tp.windowLabel || ''))}</span>
        ${tp.evergreen ? '<span class="mchip evg">' + esc(t('长青词')) + '</span>' : ''}
      </div>
    </header>

    <div class="kpi-grid">
      ${kpis.map((k) => '<div class="kpi"><b>' + esc(k.v) + '</b><span>' + esc(t(k.k)) + '</span></div>').join('')}
    </div>

    <h2>${esc(t('历史走势'))}</h2>
    ${histChart(tp.hist, tp.inflection)}
    <p class="chart-note">${esc(
      fill(t('覆盖 [[N]] 个月，[[FROM]] 至 [[TO]]'), { N: tp.months, FROM: histFrom, TO: histTo || tp.lastMonth })
    )}${peakNote}</p>
    ${insightHtml}

    <h2>${esc(t('近 24 个月'))}</h2>
    ${sparkSvg(tp.spark, 720, 90, 'spark-lg')}

    <h2>${esc(t('适合做什么'))}</h2>
    <p>${esc(line1)}</p>
    ${line2 ? '<p>' + esc(line2) + '</p>' : ''}
    ${advLines.map((x) => '<p class="advice-line">' + esc(x) + '</p>').join('')}

    <h2>${esc(t('指标'))}</h2>
    <table class="kv-table">
      <thead><tr><th>${esc(t('指标'))}</th><th>${esc(t('数值'))}</th></tr></thead>
      <tbody>
      ${rows
        .map((r) => '<tr><th>' + esc(t(r[0])) + '</th><td>' + esc(r[1]) + '</td></tr>')
        .join('\n      ')}
      </tbody>
    </table>

    ${seasonal ? '<h2>' + esc(t('季节性')) + '</h2>' + seasonBars(tp.season, lang) : ''}

    ${tp.social && Object.keys(tp.social).length
      ? '<h2>' + esc(t('渠道分布')) + '</h2>' + channelBars(tp.social) +
        '<p class="chart-note">' + esc(t('各社媒提及量，占比最高的渠道通常也是冷启动最省钱的渠道')) + '</p>'
      : ''}

    ${tp.buildParts
      ? '<h2>' + esc(t('评分构成')) + '</h2>' + scoreBars(tp.buildParts, t) +
        '<p class="chart-note">' + esc(t('机会分')) + '：<b>' + (tp.buildScore || 0) + '</b> / 100</p>'
      : ''}

    <h2>${esc(t('同类机会'))}</h2>
    <ul class="rel-list">${relHtml}</ul>

    ${risingSection}

    <h2>${esc(t('常见问题'))}</h2>
    ${faq
      .map(([q, a]) => '<details class="faq-item"><summary>' + esc(q) + '</summary><p>' + esc(a) + '</p></details>')
      .join('')}

    <p class="data-note">${esc(t('搜索热度来自 Google Trends，月搜索量按关键词工具通用口径换算为估算值，增速与评分由本站按历史曲线计算。'))}
      <a href="${L.prefix}/about.html">${esc(t('数据口径'))}</a></p>
  </article>
</main>`;

  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Dataset',
        name: kw + ' · ' + t('关键词详情'),
        description: desc || line1,
        url: SITE + L.prefix + '/topics/' + tp.slug,
        creator: { '@type': 'Organization', name: 'TrendSift' },
        temporalCoverage: '2004/2026',
        variableMeasured: ['monthly search volume', '90-day growth', '12-month growth', 'seasonality'],
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: t('机会库'), item: SITE + L.prefix + '/' },
          { '@type': 'ListItem', position: 2, name: t('关键词详情'), item: SITE + L.prefix + '/topics/' },
          { '@type': 'ListItem', position: 3, name: kw, item: SITE + L.prefix + '/topics/' + tp.slug },
        ],
      },
      {
        '@type': 'FAQPage',
        mainEntity: faq.map(([q, a]) => ({
          '@type': 'Question',
          name: q,
          acceptedAnswer: { '@type': 'Answer', text: a },
        })),
      },
    ],
  };

  const title = kw + ' · ' + pct(tp.g12) + ' / 12M · ' + fmtNum(tp.vol) + ' ' + t('月搜索量') + ' | TrendSift';
  const d = (desc ? desc.slice(0, 110) + ' ' : '') + line1;

  return layout(lang, {
    rel: '/topics/' + tp.slug,
    title,
    desc: d,
    body,
    jsonld,
  });
}

/* ------------------------------ 品类页 ------------------------------ */

/** 类目名到 URL slug：「home-decor」保持，中文「未分类」转 uncategorized */
function catSlug(c) {
  const s = String(c || '').trim();
  if (!s) return '';
  if (/[^\x00-\x7F]/.test(s)) {
    return s === '未分类' ? 'uncategorized' : 'cat-' + Buffer.from(s, 'utf8').toString('hex').slice(0, 12);
  }
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** 一个类目所有词的季节曲线取平均，看这个品类整体什么时候是旺季 */
function catSeason(list) {
  const acc = new Array(12).fill(0);
  const cnt = new Array(12).fill(0);
  for (const t of list) {
    const ms = t.season && t.season.months;
    if (!ms) continue;
    for (let i = 0; i < 12; i++) {
      if (ms[i] != null) {
        acc[i] += ms[i];
        cnt[i]++;
      }
    }
  }
  const months = acc.map((a, i) => (cnt[i] ? Math.round((a / cnt[i]) * 100) / 100 : null));
  const valid = months.filter((x) => x != null);
  if (valid.length < 10) return null;
  const mx = Math.max.apply(null, valid);
  const mn = Math.min.apply(null, valid);
  return {
    months,
    peakMonth: months.indexOf(mx) + 1,
    lowMonth: months.indexOf(mn) + 1,
    strength: Math.round(((mx - mn) / (mx || 1)) * 100) / 100,
  };
}

function catStats(list) {
  const n = list.length;
  const vols = list.map((t) => t.vol || 0).sort((a, b) => a - b);
  const median = vols[Math.floor(n / 2)] || 0;
  const avg = n ? list.reduce((s, t) => s + (t.g12 || 0), 0) / n : 0;
  const rising = list.filter((t) => (t.g12 || 0) > 20).length;
  return { n, median, avg, rising };
}

function categoryPage(lang, cat, list, relatedCats) {
  const t = ui(lang);
  const L = LANGS.find((x) => x.code === lang);
  const slug = catSlug(cat);
  const st = catStats(list);
  const season = catSeason(list);
  const catName = cat === '未分类' ? t('未分类') : cat;

  const rows = list
    .slice()
    .sort((a, b) => (b.vol || 0) - (a.vol || 0))
    .map((tp) => {
      return (
        '<li><a href="' + L.prefix + '/topics/' + tp.slug + '.html">' + dualSpan(lang, tp.keyword) + '</a>' +
        '<span class="ix-num">' + fmtNum(tp.vol) + '</span>' +
        '<span class="ix-g ' + (tp.g12 > 0 ? 'up' : 'down') + '">' + pct(tp.g12) + '</span></li>'
      );
    })
    .join('\n');

  const relCats = relatedCats
    .map((c) => {
      const nm = c.cat === '未分类' ? t('未分类') : c.cat;
      return '<li><a href="' + L.prefix + '/categories/' + catSlug(c.cat) + '.html">' + esc(nm) + '</a>' +
        '<span>' + c.n + ' ' + esc(t('个词')) + ' · ' + pct(c.avg) + '</span></li>';
    })
    .join('');

  const kpis = [
    { v: String(st.n), k: '上升词数' },
    { v: pct(st.avg), k: '平均 12 个月涨幅' },
    { v: fmtNum(st.median), k: '搜索量中位数' },
    { v: season ? (MONTHS[lang] || MONTHS.en)[season.peakMonth - 1] : '—', k: '峰值' },
  ];

  const body = `<main class="wrap doc-main">
  <nav class="crumbs" aria-label="breadcrumb">
    <a href="${L.prefix}/">${esc(t('机会库'))}</a><span>›</span>
    <a href="${L.prefix}/categories/">${esc(t('品类'))}</a><span>›</span>
    <span class="cur">${esc(catName)}</span>
  </nav>

  <article class="topic">
    <header class="topic-head">
      <div class="doc-eyebrow">${esc(t('品类分析'))}</div>
      <h1>${esc(catName)}</h1>
      <p class="doc-lead">${esc(
        t('该类目下的上升词') + '：' + st.n + ' · ' + t('平均 12 个月涨幅') + ' ' + pct(st.avg)
      )}</p>
      ${trToggleHtml(lang)}
    </header>

    <div class="kpi-grid">
      ${kpis.map((k) => '<div class="kpi"><b>' + esc(k.v) + '</b><span>' + esc(t(k.k)) + '</span></div>').join('')}
    </div>

    ${season && season.strength > 0.25 ? '<h2>' + esc(t('季节性')) + '</h2>' + seasonBars(season, lang) : ''}

    <h2>${esc(t('该类目下的上升词'))}</h2>
    <ul class="ix-list">${rows}</ul>

    ${relatedCats.length ? '<h2>' + esc(t('相关品类')) + '</h2><ul class="rel-list">' + relCats + '</ul>' : ''}

    <p class="data-note">${esc(t('搜索热度来自 Google Trends，月搜索量按关键词工具通用口径换算为估算值，增速与评分由本站按历史曲线计算。'))}
      <a href="${L.prefix}/about.html">${esc(t('数据口径'))}</a></p>
  </article>
</main>`;

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: catName + ' · ' + t('品类分析'),
    url: SITE + L.prefix + '/categories/' + slug,
    isPartOf: { '@type': 'WebSite', name: 'TrendSift', url: SITE },
    about: catName,
  };

  return layout(lang, {
    rel: '/categories/' + slug,
    title: catName + ' · ' + t('品类分析') + ' · ' + st.n + ' ' + t('个词') + ' | TrendSift',
    desc:
      catName + ' · ' + t('该类目下的上升词') + '：' + st.n + '，' +
      t('平均 12 个月涨幅') + ' ' + pct(st.avg) + '，' + t('搜索量中位数') + ' ' + fmtNum(st.median),
    body,
    jsonld,
  });
}

function categoryIndexPage(lang, cats) {
  const t = ui(lang);
  const L = LANGS.find((x) => x.code === lang);
  const rows = cats
    .map((c) => {
      const nm = c.cat === '未分类' ? t('未分类') : c.cat;
      return (
        '<li><a href="' + L.prefix + '/categories/' + catSlug(c.cat) + '.html">' + esc(nm) + '</a>' +
        '<span class="ix-num">' + c.n + ' ' + esc(t('个词')) + '</span>' +
        '<span class="ix-g ' + (c.avg > 0 ? 'up' : 'down') + '">' + pct(c.avg) + '</span></li>'
      );
    })
    .join('\n');

  const body = `<main class="wrap doc-main">
  <nav class="crumbs" aria-label="breadcrumb">
    <a href="${L.prefix}/">${esc(t('机会库'))}</a><span>›</span><span class="cur">${esc(t('品类'))}</span>
  </nav>
  <article class="topic">
    <header class="topic-head">
      <div class="doc-eyebrow">${esc(t('品类分析'))}</div>
      <h1>${esc(t('品类'))}</h1>
      <p class="doc-lead">${esc(t('该类目下的上升词') + ' · ' + cats.length)}</p>
    </header>
    <ul class="ix-list">${rows}</ul>
  </article>
</main>`;

  return layout(lang, {
    rel: '/categories/',
    title: t('品类') + ' · ' + t('品类分析') + ' | TrendSift',
    desc: t('品类分析') + ' · ' + t('该类目下的上升词'),
    body,
  });
}

/* ------------------------------ 对比页 ------------------------------ */

/**
 * 词对比页：静态壳 + 前端读 site.json 画图。
 * 一个词看不出「这个涨幅算快还是慢」，并排放在同一张图上才有判断力。
 */
function comparePage(lang) {
  const t = ui(lang);
  const L = LANGS.find((x) => x.code === lang);
  const title = t('关键词对比');
  const lead = t('最多选 4 个词，看它们过去的走势有什么不同');

  const body = `<main class="wrap doc-main">
  <nav class="crumbs" aria-label="breadcrumb">
    <a href="${L.prefix}/">${esc(t('机会库'))}</a><span>›</span><span class="cur">${esc(title)}</span>
  </nav>

  <section class="cmp">
    <div class="doc-eyebrow">${esc(t('关键词对比'))}</div>
    <h1>${esc(title)}</h1>
    <p class="doc-lead">${esc(lead)}</p>

    <div class="cmp-picker">
      <div class="cmp-search">
        <input id="cmp-q" type="search" autocomplete="off" spellcheck="false"
               placeholder="${esc(t('搜索关键词'))}" aria-label="${esc(t('搜索关键词'))}" />
        <div id="cmp-sug" class="cmp-sug" hidden></div>
      </div>
      <div id="cmp-chips" class="cmp-chips"></div>
    </div>

    <div class="cmp-toolbar">
      <div class="cmp-range" id="cmp-range" role="group" aria-label="${esc(t('时间范围'))}">
        <button type="button" data-r="12">${esc(t('1 年'))}</button>
        <button type="button" data-r="60" class="on">${esc(t('5 年'))}</button>
        <button type="button" data-r="120">${esc(t('10 年'))}</button>
        <button type="button" data-r="0">${esc(t('全部'))}</button>
      </div>
      <button type="button" id="cmp-clear" class="cmp-clear">${esc(t('清空'))}</button>
    </div>

    <div id="cmp-chart" class="cmp-chart">
      <div class="cmp-empty">${esc(t('还没有选择关键词'))}<span>${esc(t('先在上面搜索并添加要对比的词'))}</span></div>
    </div>
    <div id="cmp-table" class="cmp-table"></div>

    <p class="chart-note">${esc(CMP_NOTE[lang] || CMP_NOTE['zh-CN'])}</p>
    <p class="chart-note">${esc(t('搜索热度来自 Google Trends，月搜索量按关键词工具通用口径换算为估算值，增速与评分由本站按历史曲线计算。'))}</p>
  </section>
</main>`;

  return layout(lang, {
    rel: '/compare/',
    title: title + ' · TrendSift',
    desc: lead,
    body,
    script: '/compare.js?v=20261017a',
  });
}

/* ------------------------------ 实时关键词分析页 ------------------------------ */

function lookupPage(lang) {
  const t = ui(lang);
  const L = LANGS.find((x) => x.code === lang);
  const title = t('关键词分析');
  const lead = t('输入任意关键词，实时查它的关注度曲线、飙升相关查询与增速指标。');

  const times = [
    ['now 1-d', '过去 24 小时'],
    ['now 7-d', '过去 7 天'],
    ['now 30-d', '过去 30 天'],
    ['now 3-m', '过去 90 天'],
    ['now 12-m', '近 12 个月'],
    ['today 5-y', '近 5 年（含今天）'],
  ];
  const timeOpts = times
    .map(
      (x) =>
        '<option value="' + x[0] + '"' + (x[0] === 'today 5-y' ? ' selected' : '') + '>' +
        esc(t(x[1])) + '</option>'
    )
    .join('');

  const body = `<main class="wrap doc-main">
  <nav class="crumbs" aria-label="breadcrumb">
    <a href="${L.prefix}/">${esc(t('机会库'))}</a><span>›</span><span class="cur">${esc(title)}</span>
  </nav>

  <section>
    <div class="doc-eyebrow">${esc(t('实时查词'))}</div>
    <h1>${esc(title)}</h1>
    <p class="doc-lead">${esc(lead)}</p>

    <div class="notice">${esc(t('数据由云端实时查询 Google Trends（首次约 1 分钟内出结果），结果缓存 1 小时。'))}</div>

    <div class="card card-tight">
      <div class="row row-wrap">
        <input id="kwInput" class="input input-grow" type="text" autocomplete="off" spellcheck="false"
               placeholder="${esc(t('输入关键词，例如：ai agent / 露营装备 / 宠物推车'))}" />
        <select id="kwGeo" class="input input-sm" aria-label="${esc(t('地区'))}"></select>
        <select id="kwTime" class="input input-sm">${timeOpts}</select>
        <button id="btnKw" class="btn btn-primary">${esc(t('分析'))}</button>
      </div>
      <p class="hint">
        ${esc(t('「飙升相关查询」给的是官方口径的涨幅百分比——最容易捕捉到刚出现的词；「热门相关查询」用来判断市场规模。先用「近 5 年」看长期趋势，再用「过去 90 天」看短期波动。'))}
      </p>
    </div>
    <div id="kwResult" class="kw-result"></div>
  </section>
</main>`;

  return layout(lang, {
    rel: '/lookup/',
    title: title + ' · TrendSift',
    desc: lead,
    body,
    script: '/lookup.js?v=' + CACHE_VER,
  });
}

/* ------------------------------ 索引页 ------------------------------ */

function indexPage(lang, pageNo, pages, list) {  const t = ui(lang);
  const L = LANGS.find((x) => x.code === lang);
  const total = SITE_DATA.topics.length;
  const rows = list
    .map((tp) => {
      return (
        '<li><a href="' + L.prefix + '/topics/' + tp.slug + '.html">' + dualSpan(lang, tp.keyword) + '</a>' +
        '<span class="ix-num">' + fmtNum(tp.vol) + '</span>' +
        '<span class="ix-g ' + (tp.g12 > 0 ? 'up' : 'down') + '">' + pct(tp.g12) + '</span></li>'
      );
    })
    .join('\n');

  const pager = [];
  for (let i = 1; i <= pages; i++) {
    const href = L.prefix + '/topics/' + (i === 1 ? '' : 'page-' + i + '.html');
    pager.push(
      i === pageNo
        ? '<span class="pg on">' + i + '</span>'
        : '<a class="pg" href="' + href + '">' + i + '</a>'
    );
  }

  const body = `<main class="wrap doc-main">
  <nav class="crumbs" aria-label="breadcrumb">
    <a href="${L.prefix}/">${esc(t('机会库'))}</a><span>›</span><span class="cur">${esc(t('关键词详情'))}</span>
  </nav>
  <header class="doc-hero">
    <h1>${esc(t('按热度排序的话题索引'))}</h1>
    <p class="doc-lead">${esc(t('浏览全部 [[N]] 个上升话题').replace(/\[\[n\]\]/i, total))} · ${pageNo} / ${pages}</p>
    ${trToggleHtml(lang)}
  </header>
  <ul class="ix-list">${rows}</ul>
  <div class="pager">${pager.join('')}</div>
</main>`;

  return layout(lang, {
    rel: '/topics/',
    title: t('按热度排序的话题索引') + ' · TrendSift',
    desc: t('浏览全部 [[N]] 个上升话题').replace(/\[\[n\]\]/i, total) + ' — ' + t('数据来自 Google Trends 的搜索热度，只收搜索量持续上升的产品、品类、服务与工具，每条都带 22 年月度历史曲线。'),
    body,
    jsonld: {
      '@type': 'CollectionPage',
      name: t('按热度排序的话题索引'),
      url: SITE + L.prefix + '/topics/',
      isPartOf: { '@type': 'WebSite', name: 'TrendSift', url: SITE },
    },
  });
}


/* ------------------------------ 今日热榜 ------------------------------ */

const LOCALE = { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', en: 'en', ja: 'ja', ko: 'ko' };

function regionName(code, lang) {
  if (code === 'GLOBAL') return ui(lang)('全球');
  if (code === 'HISTORY') return ui(lang)('数据说明');
  try {
    const dn = new Intl.DisplayNames([LOCALE[lang] || 'en'], { type: 'region' });
    return dn.of(code) || code;
  } catch (e) {
    return code;
  }
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 热榜摘要：数据源很多条以「"query" is generating significant online interest.」开头，砍掉这层套话 */
function dailySnippet(query, title) {
  let s = String(title || '').trim();
  const q = String(query || '').trim();
  if (q) {
    const re = new RegExp('^["“「]? ?' + escapeRegExp(q) + '["”」]? ?is generating significant online interest\\. ?', 'i');
    s = s.replace(re, '').trim();
  }
  if (!s) s = String(title || '');
  // 有的摘要直接带裸链接，展示很难看（数据源里 / 已转义成 &#x2F;，一并处理）
  s = s
    .replace(/https?:(?:\/\/|&#x2F;&#x2F;|&\/&)\S*/g, '')
    .replace(/[\s,，.。·\-–—]+$/, '')
    .trim();
  // 全部被剥掉（标题只剩套话+链接）就宁可为空，调用方会整段隐藏；不要回头用原始标题
  return s.slice(0, 160);
}

/* ------------------------------ 今日热榜 ------------------------------ */

// 热榜是英文新闻词，非中文页面看不懂 —— 构建时把标题/摘要翻成各语言（带增量缓存）
const DAILY_TR = {};

let DAILY_TR_DONE = false;

async function buildDailyTranslations() {
  if (DAILY_TR_DONE) return;
  DAILY_TR_DONE = true;
  const raw = readJSON(path.join(DIST, 'data', 'daily.json'), null);
  const blocks = (raw && raw.data) || {};
  const texts = [];
  const bySrc = { en: [], ja: [], ko: [] };
  const seen = new Set();
  // 各地区原始词条语言不同：日本是日文、韩国是韩文，其余按英文处理。
  // 用错源语言会把「harga emas antam hari ini」翻成「最后一天」，所以先分组。
  const detectSrc = (v) => {
    if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(v)) return 'ko';
    if (/[\u3040-\u30FF]/.test(v)) return 'ja';
    return 'en';
  };
  const push = (s) => {
    const v = String(s || '').replace(/\s+/g, ' ').trim();
    // 太长、纯中文、话题标签、HTML 转义残留的都不翻
    if (!v || v.length > 280 || seen.has(v)) return;
    if (/^#/.test(v) || /[\u4e00-\u9fa5]/.test(v)) return;
    seen.add(v);
    texts.push(v);
    bySrc[detectSrc(v)].push(v);
  };
  for (const g of Object.keys(blocks)) {
    for (const it of (blocks[g] && blocks[g].items) || []) {
      push(it.query);
      // 页面实际显示的是 dailySnippet() 处理后的摘要，不是原始文章标题；
      // 只翻「会显示的那一条」，既省额度又保证键能命中
      const one = (it.articles || [])[0];
      if (one && one.title) push(dailySnippet(it.query, one.title));
    }
  }
  // YouTube 热门视频标题也走同一套翻译（键必须与渲染时一致：slice(0,140)）
  const ytRaw = readJSON(path.join(DIST, 'data', 'yt.json'), null);
  for (const g of Object.keys((ytRaw && ytRaw.data) || {})) {
    for (const v of (ytRaw.data[g].items || []).slice(0, 10)) {
      push(String(v.title || '').replace(/\s+/g, ' ').trim().slice(0, 140));
    }
  }
  if (!texts.length) return;
  // transmart 的简中代码是 zh（zh-CN 会报 Unrecognized target language）
  // 接口按 IP 限频：一次构建大约只够翻 400–500 条，4 种语言全量（~1100 条）翻不完。
  // 策略：每次构建按「当前覆盖率最低的语言优先」排队，并给每种语言设新译上限，
  // 未被翻到的下次构建继续（缓存累积），几轮之后所有语言追平。
  const DAILY_LANGS = ['zh', 'zh-TW', 'ja', 'ko'];
  // 手动补译时可放开：DAILY_TR_LIMIT=9999 node -e "require('./build-multi').buildDailyTranslations()"
  const PER_LANG_LIMIT = Number(process.env.DAILY_TR_LIMIT) || 150;
  const hitOf = (src, l) => {
    const c = loadCache(src, l);
    return bySrc[src].filter((s) => c[s]).length;
  };
  const cacheHit = (l) => ['en', 'ja', 'ko'].reduce((n, src) => n + hitOf(src, l), 0);
  const order = DAILY_LANGS.slice().sort((a, b) => cacheHit(a) / texts.length - cacheHit(b) / texts.length);
  for (let li = 0; li < order.length; li++) {
    const l = order[li];
    if (li) await new Promise((r) => setTimeout(r, 12000));
    const merged = {};
    let budget = PER_LANG_LIMIT;
    let newCount = 0;
    let deferred = 0;
    let failed = 0;
    for (const src of ['en', 'ja', 'ko']) {
      const list = bySrc[src];
      if (!list.length || budget <= 0 || src === l) continue; // 同语言不翻
      try {
        const r = await translate(list, { from: src, to: l, batch: 40, limit: budget });
        Object.assign(merged, r.map || {});
        newCount += r.pending;
        deferred += r.deferred || 0;
        failed += r.failed || 0;
        budget -= r.pending;
      } catch (e) {
        console.log('  热榜翻译 ' + src + '→' + l + ' 失败：' + e.message);
      }
      if (src === 'en' && bySrc.ja.length + bySrc.ko.length) await new Promise((r) => setTimeout(r, 3000));
    }
    DAILY_TR[l === 'zh' ? 'zh-CN' : l] = merged;
    console.log(
      '  热榜翻译 ' + l + '：' + Object.keys(merged).length + '/' + texts.length +
      '（本轮新译 ' + newCount + (deferred ? '，顺延 ' + deferred : '') +
      (failed ? '，失败 ' + failed : '') + '）'
    );
  }
}

function trDaily(lang, s) {
  if (!s) return '';
  if (lang === 'en') return '';
  const m = DAILY_TR[lang];
  if (!m) return '';
  const v = m[String(s).replace(/\s+/g, ' ').trim()];
  return v && v !== s ? v : '';
}

function dailyPage(lang) {  const t = ui(lang);
  const L = LANGS.find((x) => x.code === lang);
  const raw = readJSON(path.join(DIST, 'data', 'daily.json'), null);
  const blocks = (raw && raw.data) || {};
  const geos = Object.keys(blocks).filter((g) => blocks[g] && (blocks[g].items || []).length);
  const ytraw = readJSON(path.join(DIST, 'data', 'yt.json'), null);
  const ytBlocks = (ytraw && ytraw.data) || {};

  // 每个地区区块底部的 YouTube 热门视频子区块（免 Key 抓 youtube.com/feed/trending）
  const ytBlockHtml = (g) => {
    const b = ytBlocks[g];
    if (!b || !(b.items || []).length) return '';
    const lis = b.items
      .slice(0, 10)
      .map((v) => {
        const title = String(v.title || '').slice(0, 140);
        const tTr = trDaily(lang, title);
        const url = 'https://www.youtube.com/watch?v=' + encodeURIComponent(v.videoId || '');
        return (
          '<li class="yt-item">' +
          '<a class="yt-title" href="' + url + '" target="_blank" rel="noopener nofollow">' + esc(title) + '</a>' +
          (tTr ? '<p class="dtr">' + esc(tTr) + '</p>' : '') +
          '<p class="yt-meta">' + esc(v.channel || '') +
          (v.views ? ' · ' + esc(v.views) : '') +
          (v.published ? ' · ' + esc(v.published) : '') + '</p>' +
          '</li>'
        );
      })
      .join('');
    return (
      '<div class="yt-block"><h3>▶ ' + esc(t('YouTube 热门视频')) +
      (b.stale && b.savedAt ? ' <span class="dstale">' + esc(t('数据截至')) + ' ' + esc(b.savedAt) + '</span>' : '') +
      '</h3><ul class="yt-list">' + lis + '</ul></div>'
    );
  };

  const sections = geos
    .map((g) => {
      const items = blocks[g].items || [];
      const lis = items
        .map((it, i) => {
          const one = (it.articles || [])[0];
          const src = one && one.source ? String(one.source) : '';
          // related 里一半是 query 的截断、一半是「BBC News news」这种来源重复，过滤掉再展示
          const rels = (it.related || [])
            .map((x) => String(x || '').trim())
            .filter((x) => {
              const a = x.toLowerCase();
              const b = String(it.query || '').trim().toLowerCase();
              if (!a || a === b) return false;
              if (b.includes(a) || a.includes(b)) return false;
              if (src && (a === src.toLowerCase() || a === src.toLowerCase() + ' news')) return false;
              return true;
            })
            .slice(0, 3);
          const snip = one ? dailySnippet(it.query, one.title) : '';
          const qTr = trDaily(lang, it.query);
          const snipTr = trDaily(lang, snip);
          const link = L.prefix + '/?q=' + encodeURIComponent(it.query);
          const topHtml = (mainText) =>
            '<div class="dl-top"><span class="dk">' + (i + 1) + '</span>' +
            '<a class="dq" href="' + link + '">' + esc(mainText) + '</a>' +
            (it.traffic ? '<span class="dt">' + esc(it.traffic) + '</span>' : '') +
            '</div>';
          const snipHtml = (txt) =>
            snip ? '<p class="dn">' + (src ? '<span class="ds">' + esc(src) + '</span>' : '') + esc(txt) + '</p>' : '';
          // 原文为主行，译文以 .dtr 显示在下面（双语对照）
          let inner =
            topHtml(it.query) +
            (qTr ? '<p class="dtr">' + esc(qTr) + '</p>' : '') +
            (snip ? snipHtml(snip) + (snipTr ? '<p class="dtr">' + esc(snipTr) + '</p>' : '') : '');
          return (
            '<li>' + inner +
            (rels.length ? '<p class="dr">' + rels.map((x) => esc(x)).join(' · ') + '</p>' : '') +
            '</li>'
          );
        })
        .join('');
      return (
        '<section class="daily-block" data-geo="' + esc(g) + '"' + (blocks[g].stale ? ' data-stale="1"' : '') +
        '><h2>' + esc(regionName(g, lang)) +
        (blocks[g].stale && blocks[g].savedAt
          ? ' <span class="dstale">' + esc(t('数据截至')) + ' ' + esc(blocks[g].savedAt) + '</span>'
          : '') +
        ' <span>' + items.length + ' ' + esc(t('条')) + '</span></h2>' +
        '<ul class="daily-list">' + lis + '</ul>' +
        ytBlockHtml(g) +
        '</section>'
      );
    })
    .join('');

  // 多地区时显示地区切换 Tab（默认选中第一个，点击切换显示对应地区）
  var tabs = '';
  if (geos.length > 1) {
    tabs =
      '<div class="daily-ctl daily-tabs" id="dailyGeoTabs" role="group">' +
      geos
        .map(function (g, i) {
          return (
            '<button type="button" class="seg' + (i === 0 ? ' on' : '') + '" data-geo="' + esc(g) + '">' +
            esc(regionName(g, lang)) + '</button>'
          );
        })
        .join('') +
      '</div>';
  }

  const body = '<main class="wrap">' +
    '<header class="doc-hero"><div class="doc-eyebrow">' + esc(t('今日热榜')) + '</div>' +
    '<h1>' + esc(t('今天什么词被搜爆了')) + '</h1>' +
    '<p class="doc-lead">' + esc(t('各地区此刻搜索量突增的词与相关资讯，偏新闻，热度往往一两天就过去。')) + '</p>' +
    (lang !== 'en'
      ? '<div class="daily-ctl" id="dailyTrToggle" role="group" aria-label="' + esc(t('显示译文')) + '">' +
        '<button type="button" class="seg on" data-mode="orig">' + esc(t('显示原文')) + '</button>' +
        '<button type="button" class="seg" data-mode="tr">' + esc(t('显示译文')) + '</button></div>'
      : '') +
    '</header>' +
    tabs +
    (sections || '<p class="empty">' + esc(t('没有数据')) + '</p>') +
    '</main>';

  return layout(lang, {
    rel: '/daily',
    title: t('今天什么词被搜爆了') + ' · Google Trends | TrendSift',
    desc: t('各地区此刻搜索量突增的词与相关资讯，偏新闻，热度往往一两天就过去。'),
    body,
  });
}


/* ------------------------------ 我的清单 ------------------------------ */

function savedPage(lang) {
  const t = ui(lang);
  const toolbar =
    '<div class="row row-wrap toolbar">' +
    '<button id="btnSavedExport" class="btn btn-ghost">Export CSV</button>' +
    '<button id="btnSavedClear" class="btn btn-ghost">' + esc(t('排序')) + '</button>' +
    '<span class="hint-inline">localStorage</span></div>';
  const body =
    '<main class="wrap doc-main">' +
    '<header class="doc-hero"><div class="doc-eyebrow">' + esc(t('收藏')) + '</div>' +
    '<h1>' + esc(t('我的清单')) + '</h1>' +
    '<p class="doc-lead">' + esc(t('把这条趋势放进你的清单，等动手时再回来核对数据。')) + '</p></header>' +
    toolbar +
    '<div id="savedList" class="opp-list"></div>' +
    '</main>';
  return layout(lang, {
    rel: '/saved',
    title: t('我的清单') + ' | TrendSift',
    desc: t('把这条趋势放进你的清单，等动手时再回来核对数据。'),
    body: body,
  });
}

/* ------------------------------ 输出 ------------------------------ */


function copyDicts() {
  const src = path.join(ROOT, 'data', 'i18n');
  const dst = path.join(DIST, 'data', 'i18n');
  fs.mkdirSync(dst, { recursive: true });
  for (const l of LANGS) {
    if (l.code === 'zh-CN') {
      // 简中内容词典来自 zh-dict.json（@kw@ 前缀的关键词条优先），供前端「译文」开关使用
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'zh-dict.json'), 'utf8'));
        const clean = {};
        for (const k of Object.keys(raw)) {
          if (k.startsWith('@kw@')) clean[k.slice(4)] = raw[k];
        }
        for (const k of Object.keys(raw)) {
          if (!k.startsWith('@kw@') && !clean[k]) clean[k] = raw[k];
        }
        fs.writeFileSync(path.join(dst, 'topics-zh-CN.json'), JSON.stringify(clean), 'utf8');
      } catch (e) {
        console.log('  简中内容词典生成失败：' + e.message);
      }
      continue;
    }
    const f = 'topics-' + l.code + '.json';
    try {
      fs.copyFileSync(path.join(src, f), path.join(dst, f));
    } catch (e) {
      console.log('  缺少词典 ' + f);
    }
  }
}

function write(rel, html) {
  const p = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, html, 'utf8');
}

function buildSitemaps() {
  const urls = [];
  for (const l of LANGS) {
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ];
    const push = (rel) => {
      const loc = SITE + l.prefix + (rel === '/' ? '/' : rel);
      const alts = LANGS.map(
        (x) => '    <xhtml:link rel="alternate" hreflang="' + x.hreflang + '" href="' + SITE + x.prefix + (rel === '/' ? '/' : rel) + '"/>'
      ).join('\n');
      lines.push('  <url>', '    <loc>' + loc + '</loc>', alts, '  </url>');
    };
    push('/');
    push('/topics/');
    push('/daily');
    push('/compare/');
    push('/categories/');
    push('/about');
    push('/privacy');
    push('/contact');
    // 品类页：与页面生成同一条阈值（≥6 个词才建页），否则会写进不存在的 URL
    const catCount = {};
    for (const tp of SITE_DATA.topics) {
      for (const c of tp.categories || []) catCount[c] = (catCount[c] || 0) + 1;
    }
    for (const c of Object.keys(catCount)) {
      if (catCount[c] >= 6) {
        const sl = catSlug(c);
        if (sl) push('/categories/' + sl);
      }
    }
    for (const tp of SITE_DATA.topics) push('/topics/' + tp.slug);
    lines.push('</urlset>');
    const name = 'sitemap-' + (l.prefix ? l.prefix.slice(1) : 'zh-cn') + '.xml';
    fs.writeFileSync(path.join(DIST, name), lines.join('\n'), 'utf8');
    urls.push(name);
  }
  const idx = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const u of urls) idx.push('  <sitemap><loc>' + SITE + '/' + u + '</loc></sitemap>');
  idx.push('</sitemapindex>');
  fs.writeFileSync(path.join(DIST, 'sitemap.xml'), idx.join('\n'), 'utf8');
  return urls;
}

function buildLlms() {
  const txt = `# TrendSift

> TrendSift (trendsift.site) tracks products, categories, services and tools whose Google Trends search interest is still rising, and turns the 22-year monthly history into build/product/ad decisions. Every topic page states estimated monthly searches, 90-day and 12-month growth, seasonality, main social platform and an early-window judgement.

## What this site is for
- Finding rising search demand before it becomes crowded
- Deciding whether a keyword suits a website/app/SaaS or a physical product
- Checking seasonality and lead times before stocking

## Key pages
- ${SITE}/ — opportunity library (simplified Chinese)
- ${SITE}/en/ — English version
- ${SITE}/ja/ — 日本語版
- ${SITE}/ko/ — 한국어판
- ${SITE}/zh-tw/ — 繁體中文版
- ${SITE}/topics/ — full topic index

## Data
Search interest: Google Trends (public relative index, 0-100). Monthly volume: estimated with standard keyword-tool methodology. Growth, seasonality, volatility and scores: computed by TrendSift from the historical curve. Data is not official Google data and is not investment advice.

## Languages
Simplified Chinese (default), Traditional Chinese, English, Japanese, Korean — each with its own URL and hreflang annotations.
`;
  fs.writeFileSync(path.join(DIST, 'llms.txt'), txt, 'utf8');
}

function buildRobots() {
  const txt = `User-agent: *
Allow: /

Sitemap: ${SITE}/sitemap.xml
`;
  fs.writeFileSync(path.join(DIST, 'robots.txt'), txt, 'utf8');
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  loadDicts();
  loadContentDicts();
  copyDicts();

  // 热榜标题/摘要先翻好（带缓存，构建不联网也能用旧缓存）
  try {
    await buildDailyTranslations();
  } catch (e) {
    console.log('  热榜翻译跳过：' + e.message);
  }

  const topics = SITE_DATA.topics || [];
  if (!topics.length) {
    console.error('没有话题数据，跳过多语言构建');
    return;
  }

  // 同类目索引
  const byCat = {};
  const slugMap = {};
  const kwIndex = {};
  const normKw = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const tp of topics) {
    slugMap[tp.slug] = tp;
    kwIndex[normKw(tp.keyword)] = tp;
    for (const c of tp.categories || []) {
      (byCat[c] = byCat[c] || []).push(tp);
    }
    KW_INDEX = kwIndex;
  }

  const sorted = topics.slice().sort((a, b) => (b.vol || 0) - (a.vol || 0));
  const pages = Math.ceil(sorted.length / PER_PAGE);

  let count = 0;
  for (const l of LANGS) {
    const dir = l.prefix ? l.prefix.slice(1) : '';
    write(path.join(dir, 'index.html'), homePage(l.code));
    count++;
    write(path.join(dir, 'daily.html'), dailyPage(l.code));
    count++;
    write(path.join(dir, 'saved.html'), savedPage(l.code));
    count++;

    for (let i = 1; i <= pages; i++) {
      const slice = sorted.slice((i - 1) * PER_PAGE, i * PER_PAGE);
      const rel = i === 1 ? path.join(dir, 'topics', 'index.html') : path.join(dir, 'topics', 'page-' + i + '.html');
      write(rel, indexPage(l.code, i, pages, slice));
      count++;
    }

    for (const tp of topics) {
      // 相似机会：先用构建阶段算好的「类目 IDF + 曲线节奏」，不够再用同类目热度兜底
      let pool = (tp.similar || [])
        .map((x) => slugMap[x.slug])
        .filter((x) => x && x.slug !== tp.slug);

      if (pool.length < 6) {
        const seen = new Set(pool.map((x) => x.slug));
        const extra = [];
        for (const c of tp.categories || []) {
          for (const x of byCat[c] || []) {
            if (x.slug !== tp.slug && !seen.has(x.slug)) {
              seen.add(x.slug);
              extra.push(x);
            }
          }
        }
        extra.sort((a, b) => (b.vol || 0) - (a.vol || 0));
        pool = pool.concat(extra);
      }
      write(path.join(dir, 'topics', tp.slug + '.html'), topicPage(l.code, tp, pool.slice(0, 8)));
      count++;
    }

    // 品类页：只给词数够的类目建页。太薄的页面（2~3 个词）对 SEO 是负担，也撑不起广告展示
    const catList = [];
    for (const c of Object.keys(byCat)) {
      const arr = byCat[c];
      if (arr.length < 6) continue;
      catList.push({
        cat: c,
        n: arr.length,
        avg: arr.reduce((a, x) => a + (x.g12 || 0), 0) / arr.length,
        set: new Set(arr.map((x) => x.slug)),
      });
    }
    catList.sort((a, b) => b.n - a.n);

    for (const c of catList) {
      // 相关品类：共享词最多的那几个
      const rel = catList
        .filter((x) => x.cat !== c.cat)
        .map((x) => {
          let shared = 0;
          for (const sl of c.set) if (x.set.has(sl)) shared++;
          return { cat: x.cat, n: x.n, avg: x.avg, shared };
        })
        .filter((o) => o.shared > 0)
        .sort((a, b) => b.shared - a.shared)
        .slice(0, 6);
      write(path.join(dir, 'categories', catSlug(c.cat) + '.html'), categoryPage(l.code, c.cat, byCat[c.cat], rel));
      count++;
    }
    write(path.join(dir, 'categories', 'index.html'), categoryIndexPage(l.code, catList));
    count++;

    // 词对比页：每个语言一份，前端读 data/hist.json 画图
    write(path.join(dir, 'compare', 'index.html'), comparePage(l.code));
    count++;

    // 实时关键词分析页：前端调 /api/keyword（Pages Function + GitHub Actions）
    write(path.join(dir, 'lookup', 'index.html'), lookupPage(l.code));
    count++;
  }

  // 法务与热榜页由 build-static 生成中文版；其他语言先复用英文版的占位链接
  buildSitemaps();
  buildLlms();
  buildRobots();

  console.log('  多语言页面：' + count + ' 个（' + LANGS.length + ' 语言 × ' + topics.length + ' 话题 + 索引）');
  console.log('  sitemap：5 个语言 sitemap + sitemap.xml 索引 · llms.txt 已生成');

  try {
    await require('./build-legal').build();
  } catch (e) {
    console.log('  法务页生成失败：' + e.message);
  }
}

if (require.main === module) main();

module.exports = { main, renderDoc: layout, buildDailyTranslations };
