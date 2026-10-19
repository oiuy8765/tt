'use strict';

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

const REGIONS = [
  { code: 'US', label: '美国' },
  { code: 'GB', label: '英国' },
  { code: 'JP', label: '日本' },
  { code: 'KR', label: '韩国' },
  { code: 'HK', label: '中国香港' },
  { code: 'TW', label: '中国台湾' },
  { code: 'SG', label: '新加坡' },
  { code: 'MY', label: '马来西亚' },
  { code: 'IN', label: '印度' },
  { code: 'ID', label: '印尼' },
  { code: 'PH', label: '菲律宾' },
  { code: 'TH', label: '泰国' },
  { code: 'VN', label: '越南' },
  { code: 'AU', label: '澳大利亚' },
  { code: 'CA', label: '加拿大' },
  { code: 'DE', label: '德国' },
  { code: 'FR', label: '法国' },
  { code: 'IT', label: '意大利' },
  { code: 'ES', label: '西班牙' },
  { code: 'NL', label: '荷兰' },
  { code: 'PL', label: '波兰' },
  { code: 'TR', label: '土耳其' },
  { code: 'AE', label: '阿联酋' },
  { code: 'SA', label: '沙特' },
  { code: 'IL', label: '以色列' },
  { code: 'ZA', label: '南非' },
  { code: 'NG', label: '尼日利亚' },
  { code: 'EG', label: '埃及' },
  { code: 'BR', label: '巴西' },
  { code: 'MX', label: '墨西哥' },
];

const GEO_LABEL = { GLOBAL: '全球', HISTORY: '历史累积' };
REGIONS.forEach((r) => (GEO_LABEL[r.code] = r.label));

/* UI 文案：构建时注入各语言词典（window.__T__），缺省回退中文 */
const T = window.__T__ || {};
function t(s) {
  return T[s] || s;
}

const state = {
  geos: ['US', 'GB', 'JP', 'HK', 'TW', 'SG'],
  data: {},          // { US: { items:[], source, error } }
  demo: false,
  mode: 'none',      // google | aggregator | snapshot | demo | none
  note: '',
  sort: 'traffic',
  filter: '',
  zh: localStorage.getItem('gt_zh') === '1',
  loadedAt: null,
  kw: null,
  currentTab: 'lib',

  // 机会库（原「机会雷达 + 数字机会 + 赛道地图」三合一）
  lib: {
    topics: [],       // 全量话题
    view: [],         // 当前筛选后的
    loadedAt: 0,
    counts: {},
    cached: false,
    limit: 40,        // 当前渲染条数，滚动加载更多
    carrier: 'all',   // all | web | goods（init 里会被 URL / localStorage 覆盖）
    viewMode: 'list', // list | tracks
    form: 'all',
    kind: 'all',
    stage: 'all',
    vol: 'all',
    sort: 'auto',
    span: 0,          // 观察窗口（月）：0=不限，1/3/6/12/24
    qf: {},           // 快速筛选：evergreen / seasonal / window / growing / noflash / rise90 / nobrand
    cat: 'all',
    q: '',
    hideBrand: true,
    zh: localStorage.getItem('gt_zh') === '1',
    zhMap: {},        // 英文 → 中文
    enriching: false,
    trackSort: 'rising',
  },

  // 我的清单：只存 slug，浏览器本地
  saved: JSON.parse(localStorage.getItem('gt_saved') || '[]'),
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function toast(msg, ms) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms || 2200);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtNum(n) {
  if (!n && n !== 0) return '—';
  if (n >= 1e8) return (n / 1e8).toFixed(1) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(n >= 1e5 ? 0 : 1) + ' 万';
  return String(n);
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  return Math.round(s / 3600) + ' 小时前';
}

/* 静态部署（Cloudflare Pages）没有后端，数据从构建好的 JSON 读。
   首次请求 /api/* 失败时自动切到这里，所以同一份前端既能配本地服务也能纯静态跑。 */
const STATIC = { on: false, data: null, zh: null };

function staticJson(file) {
  return fetch('./data/' + file + '?v=' + (window.__BUILD__ || '1')).then((r) => {
    if (!r.ok) throw new Error('静态数据缺失：' + file);
    return r.json();
  });
}

async function api(path, opts) {
  if (STATIC.on) {
    if (path.indexOf('/api/radar') === 0) {
      const j = STATIC.data || (STATIC.data = await staticJson('site.json'));
      return { ok: true, cached: true, at: j.at, total: j.total, counts: j.counts, topics: j.topics, static: true };
    }
    if (path.indexOf('/api/daily') === 0) {
      try {
        const j = await staticJson('daily.json');
        return Object.assign({ ok: true, cached: true }, j);
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    if (path.indexOf('/api/status') === 0) return { ok: true, static: true };
    if (path.indexOf('/api/translate') === 0) {
      // 静态站没有后端：翻译词典在构建时预生成好，这里查表即可
      let dict = STATIC.zh;
      if (!dict) {
        try {
          dict = await staticJson('zh.json');
        } catch (e) {
          dict = {};
        }
        STATIC.zh = dict;
      }
      let texts = [];
      try {
        texts = (JSON.parse((opts && opts.body) || '{}').texts) || [];
      } catch (e) {
        texts = [];
      }
      const map = {};
      texts.forEach((t) => {
        if (dict[t]) map[t] = dict[t];
      });
      return { ok: true, map: map, static: true, provider: 'static' };
    }
    if (path.indexOf('/api/keyword') === 0) {
      // 关键词分析由 Cloudflare Pages Function 实时提供，静态模式下也直接请求
    } else {
      throw new Error('这是静态站点，该操作需要在本地运行服务');
    }
  }

  const res = await fetch(path, opts);
  const ctype = String(res.headers.get('content-type') || '');
  // 后端出错时偶尔会回一段 HTML（比如端口被别的程序占着，或者服务版本过旧），
  // 这时候只说「无法解析」用户没法处理，得把真实原因讲清楚
  if (!res.ok && ctype.indexOf('json') < 0) {
    if (res.status === 404) {
      throw new Error('本地服务找不到这个接口（404）——服务可能是旧版本，请关掉启动窗口后重新双击「启动.bat」');
    }
    throw new Error('本地服务返回了 ' + res.status + ' 状态（' + (ctype || '未知内容类型') + '），请重启服务后再试');
  }
  let text = '';
  try {
    text = await res.text();
  } catch (e) {
    throw new Error('数据在传输中断了，请再试一次');
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const head = text.trim().slice(0, 1);
    if (head === '<') {
      throw new Error('本地服务返回的是网页而不是数据——可能服务版本过旧，或端口被其他程序占用。请关掉黑窗口后重新双击「启动.bat」');
    }
    throw new Error('返回的数据不完整（收到 ' + Math.max(1, Math.round(text.length / 1024)) + ' KB），请再点一次刷新');
  }
}

/* ------------------------------------------------------------------ */
/* 状态徽标                                                            */
/* ------------------------------------------------------------------ */

function setPill(kind, text) {
  const el = $('#connPill');
  el.className = 'pill pill-' + kind;
  el.textContent = text;
}

async function refreshStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('no-backend');
    await res.json();
    setPill('ok', 'Google Trends · 已更新');
  } catch (e) {
    // 先探测静态数据是否可得（线上部署、dist 本地预览都带 data/site.json），
    // 可得就走静态模式；不可得说明是本地目录但服务没启动，明确提示，别假装成静态站
    let staticOk = false;
    try {
      const probe = await fetch('./data/site.json?v=' + Date.now(), { method: 'HEAD' });
      staticOk = probe.ok;
    } catch (e2) {
      staticOk = false;
    }
    if (staticOk) {
      STATIC.on = true;
      setPill('ok', 'Google Trends · 已更新');
      applyPublicMode();
    } else {
      setPill('bad', '数据未加载');
      toast('数据加载失败，请刷新页面重试');
    }
  }
}

/**
 * 线上（静态）版要做减法：把只有本地服务才跑得动的入口藏掉，
 * 别让用户点了才发现「这里用不了」。
 */
function applyPublicMode() {
  const kwTab = $$('.tab').find((x) => x.dataset.tab === 'keyword');
  const kwPanel = $('#panel-keyword');
  if (kwTab) kwTab.hidden = true;
  if (kwPanel) kwPanel.hidden = true;
  if (state.currentTab === 'keyword') {
    const libTab = $$('.tab').find((x) => x.dataset.tab === 'lib');
    if (libTab) libTab.click();
  }
  const btn = $('#btnRefresh');
  if (btn) btn.textContent = '重新加载';
  const demo = $('#btnDemo');
  if (demo) demo.hidden = true;
  // 静态站的数据是构建时打包好的，逐条补详情没有意义
  state.lib.static = true;
}

/* ------------------------------------------------------------------ */
/* 地区选择                                                            */
/* ------------------------------------------------------------------ */

function renderGeoChips() {
  $('#geoList').innerHTML = REGIONS.map(
    (r) =>
      `<button class="chip${state.geos.includes(r.code) ? ' on' : ''}" data-geo="${r.code}">${r.label}</button>`
  ).join('') +
    `<button class="chip chip-mini" data-act="all">全选</button>
     <button class="chip chip-mini" data-act="clear">清空</button>`;

  $('#geoList').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const act = chip.dataset.act;
    if (act === 'all') {
      state.geos = REGIONS.map((r) => r.code);
    } else if (act === 'clear') {
      state.geos = [];
    } else {
      const g = chip.dataset.geo;
      if (state.geos.includes(g)) state.geos = state.geos.filter((x) => x !== g);
      else state.geos.push(g);
    }
    renderGeoChips();
    if (Object.keys(state.data).length) {
      // 已有数据时只重绘（避免重复消耗请求）
      renderDaily();
    }
  });
}

/* ------------------------------------------------------------------ */
/* 翻译                                                                */
/* ------------------------------------------------------------------ */

async function fillTranslations(root) {
  if (!state.zh || !root) return;
  const nodes = Array.from(root.querySelectorAll('[data-en]'));
  if (!nodes.length) return;

  root.classList.add('zh-loading');
  const uniq = Array.from(new Set(nodes.map((n) => n.dataset.en).filter(Boolean)));
  const map = {};
  let apiErr = null;
  for (let i = 0; i < uniq.length; i += 25) {
    const chunk = uniq.slice(i, i + 25);
    try {
      const r = await api('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: chunk }),
      });
      if (r && r.ok && r.map) Object.assign(map, r.map);
      else if (r && r.ok === false) apiErr = r.error || '翻译失败';
    } catch (e) {
      apiErr = e.message;
    }
  }
  root.classList.remove('zh-loading');

  let miss = 0;
  nodes.forEach((n) => {
    const zh = map[n.dataset.en];
    const slot = n.querySelector('.zh-slot');
    if (!zh) {
      miss++;
      n.classList.add('zh-none');
      return;
    }
    n.classList.remove('zh-none');
    if (slot) slot.textContent = zh;
    n.setAttribute('title', zh);
  });

  // 给了「中文」却一个字都没出现，必须明确告诉用户原因，不能静默
  if (!Object.keys(map).length && uniq.length) {
    const dictEmpty = STATIC.on && (!STATIC.zh || !Object.keys(STATIC.zh).length);
    if (STATIC.on && dictEmpty) {
      toast('中文词典未加载：请刷新页面重试');
    } else if (STATIC.on) {
      toast('这一屏多是品牌名 / 专有名词，保持英文更准确');
    } else if (apiErr) {
      toast('翻译接口不可用：' + apiErr);
    } else {
      toast('这批内容还没有译文，稍后重试或点刷新');
    }
  } else if (miss >= 5 && miss > uniq.length * 0.5) {
    // 部分命中：说清楚是「专有名词保留英文」，别让人以为功能坏了
    toast('部分词条是品牌名 / 专有名词，保留英文显示');
  }
}

/* ------------------------------------------------------------------ */
/* 每日飙升榜                                                          */
/* ------------------------------------------------------------------ */

async function loadDaily() {
  if (!state.geos.length) {
    toast('请至少选择一个地区');
    return;
  }

  const grid = $('#dailyGrid');
  grid.innerHTML = `<div class="loading"><span class="spinner"></span>正在加载今日热榜…</div>`;
  $('#dailyEmpty').style.display = 'none';
  $('#btnRefresh').disabled = true;

  try {
    const r = await api('/api/daily?geos=' + encodeURIComponent(state.geos.join(',')));
    if (!r.ok) {
      grid.innerHTML = '';
      showError(r.error || '获取失败', r.hint || '');
      setPill('bad', '数据未加载');
      await loadDemo(true); // 全都失败时用示例数据撑住界面
      setPill('bad', '示例数据');
      return;
    }
    state.data = r.data || {};
    state.demo = false;
    state.mode = r.mode || 'google';
    state.note = '';
    state.loadedAt = Date.now();
    clearError();
    renderDaily();

    const okGeos = Object.keys(state.data).filter((g) => !state.data[g].error);
    if (state.mode === 'google') {
      const failed = Object.keys(state.data).filter((g) => state.data[g].error);
      setPill('ok', '今日热榜 · ' + okGeos.length + ' 个地区');
      if (failed.length) toast(failed.length + ' 个地区暂无数据（' + failed.join(', ') + '）');
    } else if (state.mode === 'aggregator') {
      setPill('ok', 'Google Trends · 今日热搜');
    } else {
      setPill('warn', '今日热榜 · 快照');
    }
  } catch (e) {
    grid.innerHTML = '';
    showError(e.message, '');
    setPill('bad', '数据未加载');
  } finally {
    $('#btnRefresh').disabled = false;
  }
}

function renderBanner() {
  const el = $('#srcBanner');
  if (state.mode === 'google' || state.mode === 'none') {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  let cls = 'warn';
  let icon = 'ℹ️';
  let title = '';
  let body = '';
  if (state.mode === 'aggregator') {
    cls = 'info';
    icon = '📊';
    title = '数据来自 Google Trends 的当日热搜';
    body = '这是本站在构建站点时抓取的快照，与此刻的实时榜可能略有差异；热搜热度通常一两天就过去，别当成长期趋势。';
  } else if (state.mode === 'snapshot') {
    cls = 'info';
    icon = '🗂️';
    title = '当前展示的是上一次抓取的 Google Trends 热搜快照';
    body = '抓取时的数据，不是此刻的榜单。';
  } else if (state.mode === 'demo') {
    cls = 'info';
    icon = '🧪';
    title = '当前展示的是示例数据';
    body = '仅用于展示界面效果，不代表任何真实搜索趋势。';
  }
  el.className = 'src-banner ' + cls;
  el.style.display = 'block';
  el.innerHTML = `<b>${icon} ${esc(title)}</b>${body ? '<br/>' + esc(body) : ''}`;
}

function showError(msg, hint) {
  clearError();
  const box = document.createElement('div');
  box.className = 'err-box';
  box.id = 'errBox';
  box.innerHTML =
    '⚠️ ' + esc(msg) +
    (hint ? '\n\n' + esc(hint) : '') +
    '\n\n👉 可稍后点右上角「重新加载」再试一次。';
  $('#panel-daily').insertBefore(box, $('#dailyMeta'));
}
function clearError() {
  const b = $('#errBox');
  if (b) b.remove();
}

function flattenItems() {
  const out = [];
  Object.keys(state.data).forEach((geo) => {
    const block = state.data[geo];
    if (!block || !block.items) return;
    block.items.forEach((it) => out.push(Object.assign({}, it, { geo, viaRss: block.source === 'rss' })));
  });
  return out;
}

function renderDaily() {
  const grid = $('#dailyGrid');
  let items = flattenItems();

  if (state.filter) {
    const f = state.filter.toLowerCase();
    items = items.filter(
      (it) =>
        (it.query || '').toLowerCase().includes(f) ||
        (it.related || []).some((x) => x.toLowerCase().includes(f)) ||
        GEO_LABEL[it.geo] === state.filter
    );
  }

  if (state.sort === 'traffic') items.sort((a, b) => b.trafficValue - a.trafficValue);
  else if (state.sort === 'alpha') items.sort((a, b) => (a.query || '').localeCompare(b.query || ''));
  else items.sort((a, b) => (a.geo === b.geo ? b.trafficValue - a.trafficValue : a.geo.localeCompare(b.geo)));

  const total = items.length;
  const geos = Object.keys(state.data).filter((g) => !state.data[g].error);
  const SRC_LABEL = {
    google: 'Google Trends 官方',
    aggregator: 'Google Trends 热搜',
    snapshot: 'Google Trends 热搜快照',
    demo: '示例数据（非真实）',
  };
  const src = SRC_LABEL[state.mode] || '未知来源';
  renderBanner();
  $('#dailyMeta').innerHTML = [
    `<span>共 <b>${total}</b> 条</span>`,
    `<span>地区 <b>${geos.length}</b> 个</span>`,
    `<span>来源 <b>${esc(src)}</b></span>`,
    state.loadedAt ? `<span>更新于 <b>${timeAgo(state.loadedAt)}</b></span>` : '',
  ]
    .filter(Boolean)
    .join('');

  if (!total) {
    grid.innerHTML = '';
    $('#dailyEmpty').style.display = state.geos.length ? 'block' : 'none';
    $('#dailyEmpty').textContent = state.filter
      ? '没有匹配「' + state.filter + '」的词条。'
      : '还没有数据，点右上角按钮重新加载。';
    return;
  }
  $('#dailyEmpty').style.display = 'none';

  grid.innerHTML = items
    .map((it, i) => {
      const zh = state.zh;
      // 不把访客导去外部数据源：词条本身不挂跳转，想深究看页面底部的数据说明
      const title = esc(it.query);
      const zhTitle = zh
        ? `<div class="zh-line" data-en="${esc(it.query)}"><span class="zh-slot"></span></div>`
        : '';
      const art = (it.articles || [])[0];
      const artHtml = art
        ? `<div class="news">
            ${
              zh
                ? `<div class="zh-line" data-en="${esc(art.title || '')}"><span class="zh-slot"></span></div>`
                : ''
            }
            <div class="en-line">${
              art.url
                ? `<a href="${esc(art.url)}" target="_blank" rel="noreferrer">${esc(art.title || '')}</a>`
                : esc(art.title || '')
            }</div>
            <div class="src">${esc(art.source || '')}${art.timeAgo ? ' · ' + esc(art.timeAgo) : ''}</div>
          </div>`
        : '';
      return `<article class="tcard">
        <div class="tcard-top">
          <span class="rank">${i + 1}</span>
          <div class="tcard-title">${title}${zhTitle}</div>
        </div>
        <div class="badges">
          ${it.trafficValue ? `<span class="badge badge-traffic">🔥 ${esc(it.traffic || fmtNum(it.trafficValue) + '+')}</span>` : ''}
          <span class="badge badge-geo">${esc(GEO_LABEL[it.geo] || it.geo)}</span>
          ${it.category ? `<span class="badge badge-cat">${esc(it.category)}</span>` : ''}
          ${it.date ? `<span class="badge">${esc(it.date)}</span>` : ''}
          ${it.demo ? '<span class="badge badge-demo">示例</span>' : ''}
        </div>
        ${
          it.related && it.related.length
            ? `<div class="rel">${it.related
                .slice(0, 5)
                .map((q) =>
                  zh
                    ? `<span class="rel-tag" data-en="${esc(q)}"><span class="zh-slot"></span><span class="en-small">${esc(
                        q
                      )}</span></span>`
                    : `<span class="rel-tag">${esc(q)}</span>`
                )
                .join('')}</div>`
            : ''
        }
        ${artHtml}
      </article>`;
    })
    .join('');

  fillTranslations(grid);
}

function exportCsv() {
  const items = flattenItems();
  if (!items.length) return toast('暂无数据可导出');
  const rows = [['地区', '排名', '词条', '搜索量', '相关查询', '首条资讯', '资讯链接', '链接']];
  items.forEach((it, i) => {
    const base = [GEO_LABEL[it.geo] || it.geo, i + 1, it.query, it.traffic || it.trafficValue];
    base.push(
      (it.related || []).join(' / '),
      (it.articles && it.articles[0] && it.articles[0].title) || '',
      (it.articles && it.articles[0] && it.articles[0].url) || '',
      it.exploreLink || ''
    );
    rows.push(base);
  });
  const csv = rows
    .map((r) => r.map((c) => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(','))
    .join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download =
    'google-trends-' +
    d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0') +
    '-' +
    String(d.getHours()).padStart(2, '0') +
    String(d.getMinutes()).padStart(2, '0') +
    '.csv';
  a.click();
  toast('已导出 ' + items.length + ' 条');
}

async function loadDemo(silent) {
  $('#dailyGrid').innerHTML = `<div class="loading"><span class="spinner"></span>加载示例数据…</div>`;
  const r = await api('/api/demo?geos=' + encodeURIComponent(state.geos.join(',') || 'US'));
  state.data = r.data || {};
  state.demo = true;
  state.mode = 'demo';
  state.note = '示例数据仅用于展示界面效果，不代表任何真实搜索趋势。';
  state.loadedAt = Date.now();
  if (!silent) {
    clearError();
    setPill('warn', '示例数据');
    toast('这是界面示例数据，不是真实数据');
  }
  renderDaily();
}

/* ------------------------------------------------------------------ */
/* 关键词分析                                                          */
/* ------------------------------------------------------------------ */

function svgChart(points) {
  const w = 640;
  const h = 170;
  const padL = 34;
  const padR = 10;
  const padT = 12;
  const padB = 22;
  if (!points || points.length < 2) {
    return `<div class="skeleton" style="padding:18px">暂无关注度曲线数据</div>`;
  }
  const vals = points.map((p) => (typeof p.v === 'number' ? p.v : 0));
  const max = Math.max.apply(null, vals.concat([1]));
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const x = (i) => padL + (innerW * i) / (points.length - 1);
  const y = (v) => padT + innerH - (innerH * v) / max;

  let line = '';
  points.forEach((p, i) => {
    line += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(vals[i]).toFixed(1) + ' ';
  });
  const area =
    `M${padL} ${(padT + innerH).toFixed(1)} ` +
    points.map((p, i) => `L${x(i).toFixed(1)} ${y(vals[i]).toFixed(1)}`).join(' ') +
    ` L${(w - padR).toFixed(1)} ${(padT + innerH).toFixed(1)} Z`;

  const grid = [0, 0.5, 1]
    .map((r) => {
      const gy = padT + innerH * r;
      return `<line x1="${padL}" x2="${w - padR}" y1="${gy}" y2="${gy}" stroke="#eef0f5" stroke-width="1"/>
      <text x="${padL - 6}" y="${gy + 4}" text-anchor="end" font-size="10" fill="#a2a8b8">${Math.round(max * (1 - r))}</text>`;
    })
    .join('');

  const step = Math.max(1, Math.ceil(points.length / 6));
  const xlabels = points
    .map((p, i) =>
      i % step === 0 || i === points.length - 1
        ? `<text x="${x(i).toFixed(1)}" y="${h - 6}" text-anchor="middle" font-size="10" fill="#a2a8b8">${esc(
            p.tAxis || p.t || ''
          )}</text>`
        : ''
    )
    .join('');

  const last = points[points.length - 1];
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs>
      <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#4f46e5" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="#4f46e5" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${grid}
    <path d="${area}" fill="url(#g1)"/>
    <path d="${line}" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(vals[vals.length - 1]).toFixed(1)}" r="3.5" fill="#4f46e5"/>
    ${xlabels}
    <text x="${(w - padR - 4).toFixed(1)}" y="${(y(vals[vals.length - 1]) - 8).toFixed(
    1
  )}" text-anchor="end" font-size="10" fill="#4f46e5">${esc(String(last.v != null ? last.v : ''))}</text>
  </svg>`;
}

function renderKeyword(data) {
  const box = $('#kwResult');
  if (!data) {
    box.innerHTML = '';
    return;
  }
  const maxGain = Math.max.apply(null, data.rising.map((r) => Number(r.value) || 0).concat([1]));
  const maxTop = Math.max.apply(null, data.top.map((r) => Number(r.value) || 0).concat([1]));

  const zhLine = (q) =>
    state.zh ? `<div class="zh-line" data-en="${esc(q)}"><span class="zh-slot"></span></div>` : '';

  const risingRows = data.rising.length
    ? data.rising
        .map(
          (r) => `<tr>
        <td>${
          r.link ? `<a class="q-link" href="${esc(r.link)}" target="_blank" rel="noreferrer">${esc(r.query)}</a>` : esc(r.query)
        }${zhLine(r.query)}</td>
        <td class="num"><span class="gain">${esc(r.formattedValue || r.value)}</span></td>
        <td style="width:90px"><div class="bar rise"><i style="width:${Math.min(
          100,
          ((Number(r.value) || 0) / maxGain) * 100
        ).toFixed(1)}%"></i></div></td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="3" class="skeleton">${esc(t('该关键词在所选时间范围内没有飙升相关查询。'))}</td></tr>`;

  const topRows = data.top.length
    ? data.top
        .map(
          (r) => `<tr>
        <td>${
          r.link ? `<a class="q-link" href="${esc(r.link)}" target="_blank" rel="noreferrer">${esc(r.query)}</a>` : esc(r.query)
        }${zhLine(r.query)}</td>
        <td class="num">${esc(String(r.value != null ? r.value : ''))}</td>
        <td style="width:90px"><div class="bar"><i style="width:${Math.min(
          100,
          ((Number(r.value) || 0) / maxTop) * 100
        ).toFixed(1)}%"></i></div></td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="3" class="skeleton">${esc(t('没有热门相关查询。'))}</td></tr>`;

  const m = data.metrics || {};
  const metricChips = [];
  if (typeof m.g90 === 'number')
    metricChips.push(
      `<div class="num"><b class="${m.g90 > 0 ? 'up' : 'down'}">${esc(pctText(m.g90))}</b><span>${esc(t('90 天增长'))}</span></div>`
    );
  if (typeof m.g12 === 'number')
    metricChips.push(
      `<div class="num"><b class="${m.g12 > 0 ? 'up' : 'down'}">${esc(pctText(m.g12))}</b><span>${esc(t('12 个月增长'))}</span></div>`
    );
  if (m.peakMonth != null)
    metricChips.push(
      `<div class="num"><b>${esc(String(m.peakMonth + 1))}</b><span>${esc(t('季节峰值月'))}</span></div>`
    );
  if (typeof m.latest === 'number')
    metricChips.push(`<div class="num"><b>${m.latest}</b><span>${esc(t('当前热度'))}</span></div>`);

  box.innerHTML = `
    <div class="card">
      <div class="kw-head">
        <h2>「${esc(data.keyword)}」</h2>
        <span class="badge badge-geo">${esc(GEO_LABEL[data.geo] || data.geo)}</span>
        <span class="badge">${esc(data.time)}</span>
        <span class="badge">${esc(t('飙升词'))} ${data.rising.length}</span>
      </div>
      ${
        metricChips.length
          ? `<div class="opp-nums" style="margin-top:10px">${metricChips.join('')}</div>`
          : ''
      }
    </div>
    <div class="chart-wrap">
      ${svgChart(data.timeline)}
      <div class="chart-cap">${esc(t('关注度指数（0–100）随时间变化，仅供趋势参考'))}</div>
    </div>
    <div class="kw-cols">
      <div class="card">
        <h2 class="card-title" style="color:var(--rise)">📈 ${esc(t('飙升相关查询（RISING）'))}</h2>
        <p class="hint" style="margin-bottom:8px">${esc(t('搜索量在所选时间范围内增幅最大，最容易是新出现的词。'))}</p>
        <table class="tbl">
          <thead><tr><th>${esc(t('查询词'))}</th><th class="num">${esc(t('涨幅'))}</th><th></th></tr></thead>
          <tbody>${risingRows}</tbody>
        </table>
      </div>
      <div class="card">
        <h2 class="card-title">🔍 ${esc(t('热门相关查询（TOP）'))}</h2>
        <p class="hint" style="margin-bottom:8px">${esc(t('该关键词下搜索量最高的相关词。'))}</p>
        <table class="tbl">
          <thead><tr><th>${esc(t('查询词'))}</th><th class="num">${esc(t('热度'))}</th><th></th></tr></thead>
          <tbody>${topRows}</tbody>
        </table>
      </div>
    </div>`;

  fillTranslations(box);
}

async function runKeyword() {
  const q = $('#kwInput').value.trim();
  if (!q) return toast(t('请输入关键词'));
  const geo = $('#kwGeo').value;
  const time = $('#kwTime').value;
  const box = $('#kwResult');
  box.innerHTML = `<div class="loading"><span class="spinner"></span>${esc(t('正在分析'))}「${esc(q)}」…</div>`;
  const fetchKw = () =>
    api('/api/keyword?q=' + encodeURIComponent(q) + '&geo=' + geo + '&time=' + encodeURIComponent(time));
  try {
    let r = await fetchKw();

    // 云端排队：GitHub Actions 分析中，每 12 秒轮询一次，最多 ~2.5 分钟
    if (!r.ok && r.error === 'QUEUED') {
      box.innerHTML = `<div class="loading"><span class="spinner"></span>${esc(t('云端计算中，约需 1 分钟，请稍候…'))}</div>`;
      for (let i = 0; i < 12; i++) {
        await new Promise((res) => setTimeout(res, (r.retryAfter || 12) * 1000));
        r = await fetchKw();
        if (r.ok || (r.error !== 'QUEUED' && r.error !== 'UPSTREAM')) break;
        if (r.error === 'UPSTREAM') break;
      }
    }

    if (!r.ok) {
      const ERR_TEXT = {
        NO_DATA: '没有找到相关数据，这个词的搜索量可能太低，换个词试试。',
        RATE_LIMITED: 'Google Trends 暂时限流，请过一两分钟再试。',
        UPSTREAM: '云端分析暂时不可用，请稍后再试。',
        QUEUED: '云端分析超时了，请再点一次「分析」（结果通常已缓存好，第二次会很快）。',
        'missing q': '请输入关键词',
      };
      const errText = ERR_TEXT[r.error] ? t(ERR_TEXT[r.error]) : r.hint || r.error || t('分析失败');
      const matches = r.localMatches || [];
      box.innerHTML =
        `<div class="err-box">⚠️ ${esc(errText)}</div>` +
        (matches.length
          ? `<div class="card"><h2 class="card-title">${esc(t('相关话题'))}</h2>
             <table class="tbl"><thead><tr><th>${esc(t('话题'))}</th><th class="num">${esc(t('热度'))}</th><th>${esc(t('类别'))}</th></tr></thead><tbody>
             ${matches
               .map(
                 (m) => `<tr><td>${
                   m.exploreLink
                     ? `<a class="q-link" href="${esc(m.exploreLink)}" target="_blank" rel="noreferrer">${esc(m.query)}</a>`
                     : esc(m.query)
                 }</td><td class="num">${esc(m.traffic || '')}</td><td style="color:var(--text-3)">${esc(
                   m.category || ''
                 )}</td></tr>`
               )
               .join('')}
             </tbody></table></div>`
          : '');
      return;
    }
    state.kw = r.data;
    renderKeyword(r.data);
  } catch (e) {
    box.innerHTML = `<div class="err-box">⚠️ ${esc(e.message)}</div>`;
  }
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

function initTabs() {
  const activate = (name) => {
    const tab = $$('.tab').find((x) => x.dataset.tab === name);
    if (!tab) return;
    $$('.tab').forEach((x) => x.classList.remove('active'));
    $$('.panel').forEach((x) => x.classList.remove('active'));
    tab.classList.add('active');
    const panel = $('#panel-' + tab.dataset.tab);
    if (panel) panel.classList.add('active');
    state.currentTab = name;
  };
  window.__activateTab = (name) => {
    activate(name);
    history.replaceState(null, '', '#' + name);
  };
  $$('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      window.__activateTab(t.dataset.tab);
      const n = t.dataset.tab;
      if (n === 'saved') renderSaved();
      if (n === 'daily' && !Object.keys(state.data).length) loadDaily();
    });
  });
  const initial = (location.hash || '').replace('#', '');
  if (initial) activate(initial);
}

function init() {
  // URL 参数：?carrier=web / goods 直接定位载体，?view=tracks 直接开赛道视图——方便把筛选状态分享给别人
  const q = location.search;
  const cm = q.match(/[?&]carrier=(all|web|goods)\b/);
  if (cm) state.lib.carrier = cm[1];
  else {
    const saved = localStorage.getItem('gt_carrier');
    if (saved === 'web' || saved === 'goods' || saved === 'all') state.lib.carrier = saved;
  }
  const vm = q.match(/[?&]view=tracks\b/);
  if (vm) {
    state.lib.viewMode = 'tracks';
    $$('#viewSwitch .vs').forEach((x) => x.classList.toggle('active', x.dataset.view === 'tracks'));
    const tb = $('#trackBar');
    if (tb) tb.hidden = false;
  }
  const sm = q.match(/[?&]span=(0|1|3|6|12|24)\b/);
  if (sm) {
    state.lib.span = Number(sm[1]);
    const el = $('#libSpan');
    if (el) el.value = String(state.lib.span);
    if (state.lib.span && state.lib.sort === 'auto') {
      state.lib.sort = 'span';
      const so = $('#libSort');
      if (so) so.value = 'span';
    }
  }

  initTabs();
  renderGeoChips();

  $('#kwGeo').innerHTML = REGIONS.map(
    (r) => `<option value="${r.code}"${r.code === 'US' ? ' selected' : ''}>${r.label}</option>`
  ).join('');

  $('#btnRefresh').addEventListener('click', () => {
    if (state.currentTab === 'daily') loadDaily();
    else loadLib(true);
  });
  $('#btnDemo').addEventListener('click', loadDemo);
  $('#btnExport').addEventListener('click', exportCsv);
  $('#filterInput').addEventListener('input', (e) => {
    state.filter = e.target.value.trim();
    renderDaily();
  });
  $('#sortSelect').addEventListener('change', (e) => {
    state.sort = e.target.value;
    renderDaily();
  });

  $('#btnKw').addEventListener('click', runKeyword);
  $('#kwInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runKeyword();
  });

  const zhT = $('#zhToggle');
  if (/[?&]zh=1\b/.test(location.search)) state.zh = true;
  if (/[?&]zh=0\b/.test(location.search)) state.zh = false;
  const syncZh = () => {
    zhT.checked = state.zh;
    zhT.closest('.toggle').classList.toggle('on', state.zh);
    document.body.classList.toggle('zh-on', state.zh);
    const lzh = $('#libZh');
    if (lzh) {
      lzh.checked = state.zh;
      lzh.closest('.toggle').classList.toggle('on', state.zh);
    }
  };
  syncZh();
  zhT.addEventListener('change', () => {
    state.zh = zhT.checked;
    localStorage.setItem('gt_zh', state.zh ? '1' : '0');
    syncZh();
    renderDaily();
    renderLib();
    if (state.kw) renderKeyword(state.kw);
    if (state.zh) toast('正在翻译为中文…');
  });

  bindLibEvents();
  bindSavedEvents();

  refreshStatus().then(() => {
    // 首屏：机会库（公开站直接读打包好的数据）
    const initial = (location.hash || '').replace('#', '');
    if (initial === 'daily') setTimeout(loadDaily, 150);
    else setTimeout(() => loadLib(false), 120);
  });
}

/* ------------------------------------------------------------------ */
/* 机会雷达                                                            */
/* ------------------------------------------------------------------ */

const CAT_LABEL = {
  software: '软件',
  technology: '科技',
  business: '商业',
  marketing: '营销',
  finance: '金融',
  investing: '投资',
  insurance: '保险',
  legal: '法律',
  health: '健康',
  medical: '医疗',
  supplements: '保健品',
  nutrition: '营养',
  fitness: '健身',
  'personal-care': '个护',
  beauty: '美妆',
  'makeup-cosmetics': '彩妆',
  skincare: '护肤',
  fashion: '时尚',
  clothing: '服饰',
  shoes: '鞋类',
  jewelry: '珠宝',
  home: '家居',
  'home-decor': '家居装饰',
  furniture: '家具',
  kitchen: '厨房',
  'home-improvement': '家装',
  garden: '园艺',
  'gardening-agriculture': '园艺农业',
  'food-beverage': '食品饮料',
  food: '食品',
  beverage: '饮料',
  cooking: '烹饪',
  cpg: '快消品',
  retail: '零售',
  ecommerce: '电商',
  product: '产品',
  travel: '旅行',
  hospitality: '酒店旅游',
  'sports-outdoors': '运动户外',
  entertainment: '娱乐',
  gaming: '游戏',
  streaming: '流媒体',
  media: '媒体',
  music: '音乐',
  pets: '宠物',
  automotive: '汽车',
  construction: '建筑',
  manufacturing: '制造',
  industry: '工业',
  'supply-chain': '供应链',
  cybersecurity: '网络安全',
  productivity: '效率工具',
  education: '教育',
  lifestyle: '生活方式',
  sleep: '睡眠',
  'real-estate': '房地产',
  social: '社交',
  workplace: '职场',
  luxury: '奢侈品',
  science: '科学',
  hr: '人力资源',
  'artificial-intelligence': '人工智能',
  'developer-tools': '开发者工具',
  'consumer-electronics': '消费电子',
  'social-media': '社交媒体',
  media: '媒体',
  unclassified: '未分类',
};

function catLabel(c) {
  return CAT_LABEL[c] || c;
}

/* ---- 迷你趋势曲线 ---- */
function sparkSvg(vals) {
  if (!vals || vals.length < 3) return '<span class="spark-none">—</span>';
  const w = 120;
  const h = 34;
  const max = Math.max.apply(null, vals.concat([1]));
  const n = vals.length;
  const pts = vals.map((v, i) => [(i / (n - 1)) * w, h - (v / max) * (h - 4) - 2]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = d + ' L' + w + ' ' + h + ' L0 ' + h + ' Z';
  const rising = vals[n - 1] >= vals[Math.max(0, n - 4)];
  return (
    '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
    '<path class="spark-area' + (rising ? ' up' : '') + '" d="' + area + '"/>' +
    '<path class="spark-line' + (rising ? ' up' : '') + '" d="' + d + '"/>' +
    '</svg>'
  );
}

function pctText(v) {
  if (!isFinite(v)) return '—';
  const n = Math.round(v);
  return (n >= 0 ? '+' : '') + n + '%';
}

function pctClass(v) {
  if (!isFinite(v)) return '';
  if (v >= 100) return 'up-strong';
  if (v > 10) return 'up';
  if (v < -10) return 'down';
  return 'flat';
}

/* ---- 季节条：12 个月的相对强弱 ---- */
function seasonBar(t) {
  if (!t.season || !t.season.months) return '';
  const ms = t.season.months;
  const strong = t.season.strength >= 0.4;
  const bars = ms
    .map((v, i) => {
      const h = v == null ? 8 : Math.max(10, Math.round(v * 100));
      const pk = t.season.peakMonth === i + 1 ? ' pk' : '';
      return (
        '<i class="sb' + pk + '" style="height:' + h + '%" title="' +
        (i + 1) + ' 月 ' + (v == null ? '无数据' : Math.round(v * 100) + '%') + '"></i>'
      );
    })
    .join('');
  let note;
  if (!strong) note = '全年平坦';
  else {
    note = '峰 ' + t.season.peakMonth + ' 月';
    if (t.seasonLead) note += ' · ' + t.seasonPrepMonth + ' 月前准备';
  }
  return (
    '<div class="season' + (strong ? ' strong' : '') + '" title="最近 36 个月按日历月归一化后的平均相对热度">' +
    '<span class="season-lbl">季节</span>' +
    '<div class="season-bars">' + bars + '</div>' +
    '<span class="season-note">' + esc(note) + '</span>' +
    '</div>'
  );
}

/* ---- 单条机会卡片 ---- */
/* ---- 统一卡片：载体不同只影响主分数与徽章，其余字段共用 ---- */
function mainScoreOf(t) {
  const s = state.lib.sort;
  if (s === 'build')
    return { v: t.buildScore, label: '建站分', cls: '', tip: '12 个月增速 30% + 规模 30% + 稳定性 18% + 新鲜度 12% + 内容可覆盖 10%' };
  if (s === 'ads')
    return { v: t.adsScore, label: '投放分', cls: '', tip: '90 天增长 40% + 搜索规模 35% + 搜索意图 15% + 季节性 10%' };
  if (t.carrier === 'web')
    return { v: t.digitalScore, label: '数字机会', cls: ' dig-score', tip: '90 天增长 38% + 规模 24% + 变现 18% + 线上可行度 20%' };
  return { v: t.score, label: '机会分', cls: '', tip: '增长 35% + 规模 25% + 变现 20% + 社媒 20%' };
}

function isSaved(slug) {
  return state.saved.indexOf(slug) >= 0;
}

function cardHtml(t, i) {
  const zh = state.zh;
  const isWeb = t.carrier === 'web';
  // 简介统一用 descShort：英文展示和中文字典的 key 必须是同一段文本，否则翻译对不上
  const brief = t.descShort || (t.desc ? t.desc.slice(0, 240) : '');
  const kwZh = zh ? '<div class="opp-zh" data-en="' + esc(t.keyword) + '"><span class="zh-slot"></span></div>' : '';
  const descZh = zh && brief ? '<div class="opp-desc-zh" data-en="' + esc(brief) + '"><span class="zh-slot"></span></div>' : '';

  const cats = (t.categories || [])
    .slice(0, 3)
    .map((c) => '<span class="cat-tag">' + esc(catLabel(c)) + '</span>')
    .join('');

  const social = t.socialTotal > 0 ? '<div class="num"><b>' + fmtNum(t.socialTotal) + '</b><span>社媒提及</span></div>' : '';

  const chips = [];
  // 数字产品：形态 + 性质。这两项是「做网站的人」最先想知道的
  if (isWeb && t.formLabel) {
    chips.push('<span class="form-badge ' + (FORM_CLASS[t.form] || '') + '">' + esc(t.formLabel) + '</span>');
  }
  if (isWeb && (t.digitalKind === 'need' || t.digitalKind === 'company')) {
    const need = t.digitalKind === 'need';
    chips.push(
      '<span class="kind-badge ' + (need ? 'k-need' : 'k-comp') + '" title="' +
        (need ? '通用需求词，搜这个词的人就是潜在用户' : '已有公司/产品名，说明这条赛道有人在做且在涨——找它的缺口') + '">' +
        (need ? '可直接做' : '已有玩家') + '</span>'
    );
  }
  if (t.stageLabel) {
    chips.push('<span class="mchip stag s-' + esc(t.stage) + '" title="' + esc(t.stageHint || '') + '">' + esc(t.stageLabel) + '</span>');
  }
  if (t.burstLabel && t.burstWindows) {
    chips.push(
      '<span class="mchip bst b-' + esc(t.burst) + '" title="' + esc(t.burstHint || '') + '">' + esc(t.burstLabel) + ' ' + t.burstWindows + '/4</span>'
    );
  }
  if (t.windowLabel) {
    chips.push(
      '<span class="mchip win w-' + esc(t.windowKey) + '" title="' + esc(t.windowHint || '') + '">' + esc(t.windowLabel) + ' · ' + t.ageMonths + ' 月前</span>'
    );
  }
  if (t.platformLabel) {
    chips.push('<span class="mchip plat" title="' + esc(t.platformAdvice || '') + '">' + esc(t.platformLabel) + ' 主战场</span>');
  }
  if (t.evergreen) chips.push('<span class="mchip evg" title="10 年以上历史、12 个月温和上涨、波动低，适合做常青内容">长青词</span>');

  // 用户选了观察窗口时，把「这段时间的涨幅」直接标在卡片上，不用回头对数字
  if (state.lib.span) {
    const g = spanGrowth(t);
    if (g != null) {
      // 300 是「之前区间几乎为 0」的封顶值，直接写 +300% 会误导，改成「新起量」
      const capped = g >= 300;
      chips.push(
        '<span class="mchip span-g ' + (g > 0 ? 'sg-up' : 'sg-down') + '" title="' +
          (capped
            ? '之前同样长度的时间里几乎没有搜索量，是刚从零起量的词'
            : '最近 ' + spanLabel(state.lib.span) + ' 的平均热度，对比之前同样长度的时间段') +
          '">近' + spanLabel(state.lib.span) + ' ' + (capped ? '新起量' : pctText(g)) + '</span>'
      );
    }
  }

  const ms = mainScoreOf(t);
  const advice = isWeb && t.digitalAdvice ? t.digitalAdvice : t.advice;

  return (
    '<article class="opp' + (isWeb ? ' is-web' : '') + '" data-slug="' + esc(t.slug) + '">' +
    '<div class="opp-rank">' + (i + 1) + '</div>' +
    '<div class="opp-body">' +
    '<div class="opp-head">' +
    '<span class="opp-kw">' + esc(t.keyword) + '</span>' +
    (state.lib.carrier === 'all' || state.currentTab === 'saved'
      ? '<span class="carrier-tag ct-' + esc(t.carrier) + '">' + (isWeb ? '线上' : '实物') + '</span>'
      : '') +
    '<span class="opp-type t-' + esc(t.type) + '" title="' + esc(t.typeHint || '') + '">' + esc(t.typeLabel) + '</span>' +
    '<button class="fav' + (isSaved(t.slug) ? ' on' : '') + '" data-slug="' + esc(t.slug) + '" title="' +
      (isSaved(t.slug) ? '从我的清单移除' : '加入我的清单') + '">' + (isSaved(t.slug) ? '★' : '☆') + '</button>' +
    '</div>' +
    kwZh +
    (brief ? '<p class="opp-desc">' + esc(brief) + '</p>' : '') +
    descZh +
    (cats || chips.length ? '<div class="opp-cats">' + chips.join('') + cats + '</div>' : '') +
    '<div class="opp-advice">💡 ' + esc(advice) + '</div>' +
    (!isWeb && t.platformAdvice ? '<div class="opp-plat-advice">📣 ' + esc(t.platformAdvice) + '</div>' : '') +
    seasonBar(t) +
    '</div>' +
    '<div class="opp-nums">' +
    '<div class="num"><b>' + (t.vol ? fmtNum(t.vol) : '<span class="dim">未知</span>') + '</b><span>月搜索</span></div>' +
    '<div class="num"><b class="' + pctClass(t.g90) + '">' + pctText(t.g90) + '</b><span>90 天</span></div>' +
    '<div class="num"><b class="' + pctClass(t.g12) + '">' + pctText(t.g12) + '</b><span>12 个月</span></div>' +
    social +
    '</div>' +
    '<div class="opp-right">' +
    '<div class="opp-score' + ms.cls + '" title="' + esc(ms.tip) + '"><b>' + Math.round(ms.v || 0) + '</b><span>' + ms.label + '</span></div>' +
    sparkSvg(t.spark) +
    '<div class="opp-spark-cap">近 24 个月</div>' +
    '</div>' +
    '</article>'
  );
}

/* ---- 渲染 ---- */
function renderLib() {
  const st = state.lib;
  const total = st.view.length;
  const show = st.view.slice(0, st.limit);

  const enriched = st.topics.filter((t) => t.enriched).length;

  $('#libMeta').innerHTML = [
    '<span>符合条件 <b>' + total + '</b> 个</span>',
    '<span>全站 <b>' + st.topics.length + '</b> 个上升话题</span>',
    st.span
      ? '<span class="live">观察窗口：近 ' + spanLabel(st.span) + '（只看这段在涨的）</span>'
      : '<span class="dim">观察窗口：全部历史</span>',
    '<span class="dim" title="搜索热度来自 Google Trends，月搜索量与历史曲线依据其相对热度换算">基于 Google Trends 搜索热度</span>',
    st.loadedAt ? '<span>数据更新于 <b>' + timeAgo(st.loadedAt) + '</b></span>' : '',
    st.cached ? '<span class="dim">缓存</span>' : '<span class="live">实时</span>',
    enriched && enriched < st.topics.length
      ? '<span class="dim">已补全详情 ' + enriched + '/' + st.topics.length + '</span>'
      : '',
  ]
    .filter(Boolean)
    .join(' <i class="sep">·</i> ');

  // 赛道视图
  if (st.viewMode === 'tracks') {
    $('#libList').hidden = true;
    $('#libMore').innerHTML = '';
    $('#trackBar').hidden = false;
    $('#trackWrap').hidden = false;
    renderTracks();
    return;
  }
  $('#libList').hidden = false;
  $('#trackBar').hidden = true;
  $('#trackWrap').hidden = true;

  if (!show.length) {
    $('#libList').innerHTML = '<div class="empty">没有符合条件的话题，试试放宽筛选条件。</div>';
    $('#libMore').innerHTML = '';
    return;
  }

  $('#libList').innerHTML = show.map(cardHtml).join('');

  if (total > st.limit) {
    $('#libMore').innerHTML =
      '<button class="btn btn-ghost" id="btnMore">再显示 40 个（还有 ' + (total - st.limit) + ' 个）</button>';
    $('#btnMore').onclick = () => {
      st.limit += 40;
      renderLib();
      enrichVisible();
    };
  } else {
    $('#libMore').innerHTML = total > 20 ? '<div class="dim more-end">已显示全部 ' + total + ' 个</div>' : '';
  }

  if (state.zh) fillTranslations($('#libList'));
}

/* 类别下拉按当前载体动态生成，避免出现「选了数字产品却看到马桶类目」 */
function fillLibCatOptions(pool) {
  const counts = {};
  pool.forEach((t) => (t.categories || []).forEach((c) => (counts[c] = (counts[c] || 0) + 1)));
  const keys = Object.keys(counts)
    .filter((k) => counts[k] >= 2)
    .sort((a, b) => counts[b] - counts[a])
    .slice(0, 30);
  const sel = $('#libCat');
  const cur = sel.value;
  sel.innerHTML =
    '<option value="all">全部类别</option>' +
    keys.map((k) => '<option value="' + esc(k) + '">' + esc(catLabel(k)) + '（' + counts[k] + '）</option>').join('');
  sel.value = keys.includes(cur) ? cur : 'all';
  state.lib.cat = sel.value;
}

function carrierPool() {
  const st = state.lib;
  const all = st.topics.filter((t) => t.type !== 'brand');
  if (st.carrier === 'web') return all.filter((t) => t.carrier === 'web');
  if (st.carrier === 'goods') return all.filter((t) => t.carrier === 'goods');
  return all;
}

/* ---- 观察窗口：用户自己选「多长时间内算在涨」 ----
   数据层已经按 1/3/6/12/24 个月算好了增长率（trend.m1 … m24），
   这里只做筛选和排序，不在前端重复计算。 */
const SPAN_KEY = { 1: 'm1', 3: 'm3', 6: 'm6', 12: 'm12', 24: 'm24' };

function spanGrowth(t) {
  const key = SPAN_KEY[state.lib.span];
  if (!key || !t.trend) return null;
  const v = t.trend[key];
  return typeof v === 'number' ? v : null;
}

function spanLabel(n) {
  return n >= 12 ? n / 12 + ' 年' : n + ' 个月';
}

function applyLibFilters() {
  const st = state.lib;
  const pool = st.topics.length ? carrierPool() : [];
  let list = pool.slice();

  if (st.hideBrand) list = list.filter((t) => t.type !== 'brand');

  // 时间窗口：只看这段时间里确实在涨的（历史不足的会被排除，避免拿半段数据下结论）
  if (st.span) list = list.filter((t) => { const g = spanGrowth(t); return g != null && g > 0; });

  // 形态 / 性质只在「数字产品」下才有意义
  if (st.carrier === 'web') {
    if (st.form !== 'all') list = list.filter((t) => t.form === st.form);
    if (st.kind !== 'all') list = list.filter((t) => t.digitalKind === st.kind);
  }

  if (st.stage !== 'all') list = list.filter((t) => t.stage === st.stage);

  if (st.vol !== 'all') {
    const ranges = { a: [1000, 10000], b: [10000, 100000], c: [100000, 500000], d: [500000, Infinity] };
    const r = ranges[st.vol];
    if (r) list = list.filter((t) => t.vol >= r[0] && t.vol < r[1]);
  }

  if (st.cat !== 'all') list = list.filter((t) => (t.categories || []).indexOf(st.cat) >= 0);

  if (st.q) {
    const q = st.q.toLowerCase();
    list = list.filter(
      (t) =>
        t.keyword.toLowerCase().indexOf(q) >= 0 ||
        (t.desc || '').toLowerCase().indexOf(q) >= 0 ||
        (t.categories || []).some((c) => c.toLowerCase().indexOf(q) >= 0 || catLabel(c).indexOf(st.q) >= 0)
    );
  }

  // 快速筛选
  const qf = st.qf || {};
  if (qf.evergreen) list = list.filter((t) => t.evergreen);
  if (qf.seasonal) list = list.filter((t) => t.season && t.season.strength >= 0.4);
  if (qf.window) list = list.filter((t) => t.ageMonths != null && t.ageMonths <= 12);
  if (qf.growing) list = list.filter((t) => t.stage === 'growing' || t.stage === 'emerging');
  if (qf.nofalsh) list = list.filter((t) => t.burst !== 'flash');
  if (qf.rise90) list = list.filter((t) => (t.g90 || 0) > 0);
  if (qf.nobrand) list = list.filter((t) => (t.vol || 0) >= 1000);

  // 「按季节准备月」：算出从本月到该准备的月份还剩几个月，最紧急的排前面
  const nowM = new Date().getMonth() + 1;
  const distTo = (m) => {
    if (!m) return 99;
    let d = m - nowM;
    if (d < 0) d += 12;
    return d;
  };

  const sorters = {
    // 推荐排序随载体变化：做数字产品看数字机会分，卖货看实体机会分
    score: (a, b) => b.score - a.score,
    dscore: (a, b) => (b.digitalScore || 0) - (a.digitalScore || 0),
    build: (a, b) => (b.buildScore || 0) - (a.buildScore || 0),
    ads: (a, b) => (b.adsScore || 0) - (a.adsScore || 0),
    g90: (a, b) => b.g90 - a.g90,
    g12: (a, b) => b.g12 - a.g12,
    vol: (a, b) => b.vol - a.vol,
    social: (a, b) => (b.socialTotal || 0) - (a.socialTotal || 0),
    window: (a, b) => (a.ageMonths == null ? 999 : a.ageMonths) - (b.ageMonths == null ? 999 : b.ageMonths),
    season: (a, b) => distTo(a.seasonPrepMonth) - distTo(b.seasonPrepMonth),
    span: (a, b) => {
      const ga = spanGrowth(a);
      const gb = spanGrowth(b);
      return (gb == null ? -1e9 : gb) - (ga == null ? -1e9 : ga);
    },
  };

  let key = st.sort;
  if (key === 'auto') key = st.carrier === 'web' ? 'dscore' : 'score';
  // 选了时间窗口但还在按推荐排序：默认改成按这段时间的涨幅排，这才符合用户的选择
  if (st.span && key === 'auto') key = 'span';

  list.sort(sorters[key] || sorters.score);

  st.view = list;
  fillLibCatOptions(pool);
  renderLib();
}

/* ---- 赛道分布（聚合当前筛选结果） ---- */
function renderTracks() {
  const st = state.lib;
  const groups = {};
  st.view.forEach((t) => {
    (t.categories || []).forEach((c) => {
      const g = (groups[c] = groups[c] || { cat: c, count: 0, rising: 0, sumG: 0, nG: 0, sumV: 0 });
      g.count++;
      if (t.type === 'rising') g.rising++;
      if (isFinite(t.g90)) {
        g.sumG += t.g90;
        g.nG++;
      }
      g.sumV += t.vol || 0;
    });
  });

  let rows = Object.keys(groups).map((k) => {
    const g = groups[k];
    return { cat: k, count: g.count, rising: g.rising, avgGrowth: g.nG ? g.sumG / g.nG : 0, avgVol: g.count ? g.sumV / g.count : 0 };
  });

  if (!rows.length) {
    $('#trackWrap').innerHTML = '<div class="empty">当前筛选下没有可聚合的类别。</div>';
    return;
  }

  const sorters = {
    rising: (a, b) => b.rising - a.rising,
    growth: (a, b) => b.avgGrowth - a.avgGrowth,
    count: (a, b) => b.count - a.count,
    vol: (a, b) => b.avgVol - a.avgVol,
  };
  rows.sort(sorters[st.trackSort] || sorters.rising);
  rows = rows.slice(0, 40);

  const pick = (r) =>
    st.trackSort === 'growth' ? Math.max(0, r.avgGrowth) : st.trackSort === 'count' ? r.count : st.trackSort === 'vol' ? r.avgVol : r.rising;
  const maxVal = Math.max.apply(null, rows.map(pick).concat([1]));

  $('#trackWrap').innerHTML = rows
    .map((r) => {
      const w = Math.max(2, (pick(r) / maxVal) * 100);
      return (
        '<div class="track">' +
        '<div class="track-head"><b>' + esc(catLabel(r.cat)) + '</b><span class="track-count">' + r.count + ' 个话题</span></div>' +
        '<div class="track-bar"><i style="width:' + w.toFixed(1) + '%"></i></div>' +
        '<div class="track-nums">' +
        '<span>★ 快速增长 <b>' + r.rising + '</b></span>' +
        '<span>平均 90 天 <b class="' + pctClass(r.avgGrowth) + '">' + pctText(r.avgGrowth) + '</b></span>' +
        '<span>平均月搜索 <b>' + fmtNum(r.avgVol) + '</b></span>' +
        '</div>' +
        '</div>'
      );
    })
    .join('');
}

/* 载体切换：更新三张大卡的数字、顶部统计、提示语，以及只对数字产品有意义的筛选器 */
function renderCarrierStats() {
  const st = state.lib;
  const pool = st.topics.filter((t) => t.type !== 'brand');
  const web = pool.filter((t) => t.carrier === 'web');
  const goods = pool.filter((t) => t.carrier === 'goods');
  const n = (arr, fn) => arr.filter(fn).length;

  $('#cNumAll').textContent = pool.length;
  $('#cNumWeb').textContent = web.length;
  $('#cNumGoods').textContent = goods.length;

  const stats =
    st.carrier === 'web'
      ? [
          ['可做线上产品', web.length, ''],
          ['可直接做（需求词）', n(web, (t) => t.digitalKind === 'need'), 'a-good'],
          ['数字机会分 70+', n(web, (t) => (t.digitalScore || 0) >= 70), 'a-good'],
          ['仍在窗口期', n(web, (t) => t.ageMonths != null && t.ageMonths <= 12), 'a-good'],
        ]
      : st.carrier === 'goods'
      ? [
          ['实物品类', goods.length, ''],
          ['季节明显', n(goods, (t) => t.season && t.season.strength >= 0.4), 'a-good'],
          ['12 个月涨 50%+', n(goods, (t) => t.g12 >= 50), 'a-good'],
          ['月搜 20 万+', n(goods, (t) => t.vol >= 200000), ''],
        ]
      : [
          ['全站话题', pool.length, ''],
          ['可做线上产品', web.length, 'a-good'],
          ['实物品类', goods.length, ''],
          ['仍在窗口期', n(pool, (t) => t.ageMonths != null && t.ageMonths <= 12), ''],
        ];

  $('#heroStats').innerHTML = stats
    .map(([label, val, cls]) => '<div class="hstat"><b class="' + cls + '">' + val + '</b><span>' + label + '</span></div>')
    .join('');

  const HINT = {
    all:
      '不确定做什么？<b>大多数人应该先点「网站 / APP / SaaS」</b>——不用碰供应链，一个人就能上线，试错成本最低。' +
      '「实体产品」适合已经有货源或做跨境的人，那边的分数按备货和季节另算。',
    web:
      '<b>这里只看不用碰货的机会。</b>「<b>可直接做</b>」= 搜这个词的人就是你的用户，比如 <code>metadata remover</code>，直接做个工具站就有人用；' +
      '「<b>已有玩家</b>」= 已经在做、搜索量还在涨的产品，别把它当机会本身，它的价值是证明这条赛道有人付费——你要找的是它的缺口（更细的人群、更轻的版本、它没做好的环节）。',
    goods:
      '<b>这里只看要碰货的机会。</b>看「季节」决定备货时点（峰值在 5 月就 3 月前下单），' +
      '看「主战场」决定内容投哪个平台（TikTok 高就拍短视频、Pinterest 高就做图集）。分数高的通常需求稳定、又还没到红海。',
  };
  $('#carrierHint').innerHTML = '<div class="chint ch-' + esc(st.carrier) + '">' + HINT[st.carrier] + '</div>';

  // 形态 / 性质筛选只对数字产品有意义
  const showWeb = st.carrier === 'web';
  $('#libForm').hidden = !showWeb;
  $('#libKind').hidden = !showWeb;

  $$('#carrierPick .carrier').forEach((b) => b.classList.toggle('active', b.dataset.carrier === st.carrier));
}


/* ---- 抓取 ---- */
/**
 * 榜单响应有两三兆，弱网或代理抖动时偶发被截断。
 * 这里自动重试一次（第一次强制刷新失败就退回读缓存），比让用户面对一个报错强。
 */
async function fetchRadar(force) {
  let lastErr = null;
  for (let i = 0; i < 2; i++) {
    try {
      return await api('/api/radar' + (force && i === 0 ? '?force=1' : ''));
    } catch (e) {
      lastErr = e;
      if (i === 0) await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr;
}

async function loadLib(force) {
  const st = state.lib;
  $('#libLoading').style.display = 'flex';
  $('#libLoadingText').textContent = force ? '正在重新加载数据…' : '正在加载趋势数据…';
  $('#libErr').innerHTML = '';
  $('#btnRefresh').disabled = true;

  try {
    const r = await fetchRadar(force);
    if (!r.ok) throw new Error(r.error || '获取失败');
    st.topics = r.topics || [];
    st.counts = r.counts || {};
    st.loadedAt = r.at || Date.now();
    st.cached = !!r.cached;
    st.limit = 40;
    $('#libLoading').style.display = 'none';
    if (r.error) $('#libErr').innerHTML = '<div class="err-box">' + esc(r.error) + '</div>';
    renderCarrierStats();
    applyLibFilters();
    if (state.currentTab === 'saved') renderSaved();
    setPill('ok', 'Google Trends · ' + st.topics.length + ' 个话题');
    enrichVisible();
  } catch (e) {
    $('#libLoading').style.display = 'none';
    $('#libErr').innerHTML =
      '<div class="err-box">⚠️ ' + esc(e.message) + '<br/><br/>数据没有加载成功，请刷新页面或稍后重试。</div>';
    setPill('bad', '数据未加载');
  } finally {
    $('#btnRefresh').disabled = false;
  }
}

/* ---- 补全详情（分类 / 简介 / 社媒） ---- */
async function enrichVisible() {
  const st = state.lib;
  if (st.enriching || STATIC.on) return;

  const need = st.view
    .slice(0, Math.max(st.limit, 60))
    .filter((t) => !t.enriched && t.slug)
    .map((t) => t.slug)
    .slice(0, 120);

  if (!need.length) return;

  st.enriching = true;
  try {
    const r = await api('/api/radar/enrich', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slugs: need }),
    });
    if (r && r.ok) {
      // 重新拉一次（后端已回填并重算机会分），本地服务 + 缓存，很快
      const r2 = await api('/api/radar');
      if (r2 && r2.ok) {
        st.topics = r2.topics || st.topics;
        st.counts = r2.counts || st.counts;
        const keep = st.limit;
        st.limit = keep;
        renderCarrierStats();
        applyLibFilters();
      }
    }
  } catch (e) {
    /* 静默失败：分类补不上不影响主流程 */
  } finally {
    st.enriching = false;
  }
}

const FORM_CLASS = { saas: 'f-saas', app: 'f-app', tool: 'f-tool', content: 'f-content' };

/* ------------------------------------------------------------------ */
/* 我的清单（浏览器本地）                                              */
/* ------------------------------------------------------------------ */

function saveSaved() {
  try {
    localStorage.setItem('gt_saved', JSON.stringify(state.saved));
  } catch (e) {
    /* 隐私模式下可能写不进去，不影响浏览 */
  }
  updateSavedBadge();
}

function updateSavedBadge() {
  const b = $('#savedBadge');
  if (!b) return;
  b.textContent = state.saved.length;
  b.hidden = state.saved.length === 0;
}

function syncFavButtons(slug) {
  $$('.fav').forEach((b) => {
    if (b.dataset.slug !== slug) return;
    const on = isSaved(slug);
    b.classList.toggle('on', on);
    b.textContent = on ? '★' : '☆';
    b.title = on ? '从我的清单移除' : '加入我的清单';
  });
}

function toggleSaved(slug) {
  if (!slug) return;
  const i = state.saved.indexOf(slug);
  if (i >= 0) {
    state.saved.splice(i, 1);
    toast('已从清单移除');
  } else {
    state.saved.unshift(slug);
    toast('已加入我的清单（顶部「我的清单」查看）');
  }
  saveSaved();
  syncFavButtons(slug);
  if (state.currentTab === 'saved') renderSaved();
}

function renderSaved() {
  const st = state.lib;
  const byslug = {};
  st.topics.forEach((t) => (byslug[t.slug] = t));
  const items = state.saved.map((s) => byslug[s]).filter(Boolean);
  const web = items.filter((t) => t.carrier === 'web').length;

  $('#savedStats').innerHTML = [
    ['已收藏', state.saved.length, ''],
    ['可做线上', web, web ? 'a-good' : ''],
    ['要碰货', items.length - web, ''],
  ]
    .map(([label, val, cls]) => '<div class="hstat"><b class="' + cls + '">' + val + '</b><span>' + label + '</span></div>')
    .join('');

  if (!state.saved.length) {
    $('#savedList').innerHTML =
      '<div class="empty">清单还是空的。回「机会库」浏览，点卡片右上角的 ☆ 就能存下来。</div>';
    return;
  }
  if (!items.length) {
    $('#savedList').innerHTML = '<div class="empty">正在加载数据，稍等…</div>';
    return;
  }

  $('#savedList').innerHTML = items.map((t, i) => cardHtml(t, i)).join('');
  if (state.zh) fillTranslations($('#savedList'));
}

function exportSaved() {
  const byslug = {};
  state.lib.topics.forEach((t) => (byslug[t.slug] = t));
  const rows = [['关键词', '载体', '形态', '性质', '月搜索量', '90天增长%', '12个月增长%', '机会分', '数字机会分', '阶段', '窗口期', '链接']];
  state.saved.forEach((s) => {
    const t = byslug[s];
    if (!t) return;
    rows.push([
      t.keyword,
      t.carrierLabel || '',
      t.formLabel || '',
      t.digitalKind === 'need' ? '可直接做' : t.digitalKind === 'company' ? '已有玩家' : '',
      t.vol || '',
      t.g90,
      t.g12,
      Math.round(t.score || 0),
      Math.round(t.digitalScore || 0),
      t.stageLabel || '',
      t.windowLabel || '',
      t.url || '',
    ]);
  });
  const csv = rows
    .map((r) => r.map((c) => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(','))
    .join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '机会清单_' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出 ' + state.saved.length + ' 条');
}

function bindSavedEvents() {
  updateSavedBadge();

  $('#btnSavedExport').addEventListener('click', exportSaved);
  $('#btnSavedClear').addEventListener('click', () => {
    if (!state.saved.length) return toast('清单已经是空的');
    if (!confirm('确定清空全部 ' + state.saved.length + ' 条收藏？此操作无法撤销。')) return;
    state.saved = [];
    saveSaved();
    renderSaved();
    toast('已清空');
  });
}

/* ---- 事件 ---- */
function bindLibEvents() {
  const st = state.lib;

  const onFilter = (fn) => {
    const h = (e) => {
      fn(e);
      st.limit = 40;
      applyLibFilters();
    };
    return h;
  };

  $('#libSearch').addEventListener('input', onFilter((e) => (st.q = e.target.value.trim())));
  $('#libForm').addEventListener('change', onFilter((e) => (st.form = e.target.value)));
  $('#libKind').addEventListener('change', onFilter((e) => (st.kind = e.target.value)));
  $('#libVol').addEventListener('change', onFilter((e) => (st.vol = e.target.value)));
  $('#libStage').addEventListener('change', onFilter((e) => (st.stage = e.target.value)));
  $('#libSort').addEventListener('change', onFilter((e) => (st.sort = e.target.value)));
  $('#libSpan').addEventListener('change', (e) => {
    st.span = Number(e.target.value) || 0;
    st.limit = 40;
    // 选了窗口就按这个窗口的涨幅排；取消窗口则回到推荐排序
    if (st.span && st.sort === 'auto') {
      st.sort = 'span';
      $('#libSort').value = 'span';
    } else if (!st.span && st.sort === 'span') {
      st.sort = 'auto';
      $('#libSort').value = 'auto';
    }
    applyLibFilters();
    enrichVisible();
  });
  $('#libCat').addEventListener('change', (e) => {
    st.cat = e.target.value;
    st.limit = 40;
    applyLibFilters();
    enrichVisible();
  });
  $('#libHideBrand').addEventListener('change', (e) => {
    st.hideBrand = e.target.checked;
    st.limit = 40;
    applyLibFilters();
  });

  // 载体切换：这是整个页面最重要的一个交互
  $('#carrierPick').addEventListener('click', (e) => {
    const b = e.target.closest('.carrier');
    if (!b) return;
    st.carrier = b.dataset.carrier;
    localStorage.setItem('gt_carrier', st.carrier);
    st.limit = 40;
    st.cat = 'all';
    st.form = 'all';
    st.kind = 'all';
    $('#libCat').value = 'all';
    $('#libForm').value = 'all';
    $('#libKind').value = 'all';
    renderCarrierStats();
    applyLibFilters();
  });

  // 快速筛选
  $('#quickFilters').addEventListener('click', (e) => {
    const b = e.target.closest('.qchip');
    if (!b) return;
    const k = b.dataset.qf;
    st.qf[k] = !st.qf[k];
    b.classList.toggle('on', !!st.qf[k]);
    st.limit = 40;
    applyLibFilters();
    enrichVisible();
  });

  // 列表 / 赛道分布
  $('#viewSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('.vs');
    if (!b) return;
    st.viewMode = b.dataset.view;
    $$('#viewSwitch .vs').forEach((x) => x.classList.toggle('active', x === b));
    $('#trackBar').hidden = st.viewMode !== 'tracks';
    renderLib();
  });

  $('#trackSort').addEventListener('change', (e) => {
    st.trackSort = e.target.value;
    renderTracks();
  });

  // 收藏（事件委托，列表和清单页共用）
  const favHandler = (e) => {
    const b = e.target.closest('.fav');
    if (!b) return;
    e.preventDefault();
    toggleSaved(b.dataset.slug);
  };
  $('#libList').addEventListener('click', favHandler);
  $('#savedList').addEventListener('click', favHandler);

  // 中文开关
  const lzh = $('#libZh');
  lzh.checked = state.zh;
  lzh.closest('.toggle').classList.toggle('on', state.zh);
  lzh.addEventListener('change', () => {
    state.zh = lzh.checked;
    localStorage.setItem('gt_zh', state.zh ? '1' : '0');
    const zt = $('#zhToggle');
    zt.checked = state.zh;
    zt.closest('.toggle').classList.toggle('on', state.zh);
    document.body.classList.toggle('zh-on', state.zh);
    renderLib();
    if (state.zh) toast('正在翻译为中文…');
  });

  // 搜索框回车不刷新页面
  $('#libSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();
  });
}

document.addEventListener('DOMContentLoaded', init);
