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

const GEO_LABEL = { GLOBAL: '全球（聚合源）', HISTORY: '历史累积' };
REGIONS.forEach((r) => (GEO_LABEL[r.code] = r.label));

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

  // 机会雷达
  radar: {
    topics: [],       // 全量话题
    view: [],         // 当前筛选后的
    loadedAt: 0,
    counts: {},
    cached: false,
    limit: 40,        // 当前渲染条数，滚动加载更多
    type: 'all',
    vol: 'all',
    sort: 'score',
    cat: 'all',
    q: '',
    hideBrand: true,
    zh: localStorage.getItem('gt_zh') === '1',
    zhMap: {},        // 英文 → 中文
    enriching: false,
    trackSort: 'rising',
  },
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

async function api(path, opts) {
  const res = await fetch(path, opts);
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error('本地服务返回了无法解析的内容');
  }
  return json;
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
    const s = await api('/api/status');
    if (s.proxy) setPill('idle', '代理：' + s.proxy.replace(/^https?:\/\//, ''));
    else setPill('idle', '直连模式');
    $('#proxyInput').value = s.proxy || '';
    $('#footerInfo').textContent =
      '本地服务 · Node ' + s.node + ' · 出口：' + (s.proxy || '直连');
  } catch (e) {
    setPill('bad', '本地服务未连接');
  }
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

  const uniq = Array.from(new Set(nodes.map((n) => n.dataset.en).filter(Boolean)));
  const map = {};
  for (let i = 0; i < uniq.length; i += 25) {
    const chunk = uniq.slice(i, i + 25);
    try {
      const r = await api('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: chunk }),
      });
      if (r && r.ok && r.map) Object.assign(map, r.map);
    } catch (e) {
      /* 单批失败不影响其它批次 */
    }
  }

  nodes.forEach((n) => {
    const zh = map[n.dataset.en];
    const slot = n.querySelector('.zh-slot');
    if (!zh) {
      n.classList.add('zh-none');
      return;
    }
    if (slot) slot.textContent = zh;
    n.setAttribute('title', zh);
  });
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
  grid.innerHTML = `<div class="loading"><span class="spinner"></span>正在抓取（官方接口 → 免代理聚合源 → 本地快照 依次尝试）…</div>`;
  $('#dailyEmpty').style.display = 'none';
  $('#btnRefresh').disabled = true;

  try {
    const r = await api('/api/daily?geos=' + encodeURIComponent(state.geos.join(',')));
    if (!r.ok) {
      grid.innerHTML = '';
      showError(r.error || '获取失败', r.hint || '');
      setPill('bad', '抓取失败');
      await loadDemo(true); // 全都失败时用示例数据撑住界面
      setPill('bad', '抓取失败 · 当前为示例数据');
      return;
    }
    state.data = r.data || {};
    state.demo = false;
    state.mode = r.mode || 'google';
    state.note = r.note || '';
    state.loadedAt = Date.now();
    clearError();
    renderDaily();

    const okGeos = Object.keys(state.data).filter((g) => !state.data[g].error);
    if (state.mode === 'google') {
      const failed = Object.keys(state.data).filter((g) => state.data[g].error);
      setPill('ok', '官方接口 · ' + okGeos.length + ' 个地区');
      if (failed.length) toast(failed.length + ' 个地区无数据（' + failed.join(', ') + '）');
    } else if (state.mode === 'aggregator') {
      setPill('warn', '免代理聚合源');
    } else {
      setPill('warn', '本地快照');
    }
  } catch (e) {
    grid.innerHTML = '';
    showError(e.message, '');
    setPill('bad', '抓取失败');
  } finally {
    $('#btnRefresh').disabled = false;
  }
}

async function loadHistory() {
  const grid = $('#dailyGrid');
  const days = state.range;
  grid.innerHTML = `<div class="loading"><span class="spinner"></span>正在汇总最近 ${days} 天的本地记录…</div>`;
  $('#btnRefresh').disabled = true;
  try {
    const r = await api('/api/history?days=' + days);
    if (!r.ok) {
      grid.innerHTML = '';
      showError(r.error || '读取失败', '');
      setPill('bad', '读取失败');
      return;
    }
    // 让地区筛选在历史视图里失效更直观：只放一个汇总块
    state.data = {
      HISTORY: { geo: 'HISTORY', source: 'history', items: r.items || [], fetchedAt: Date.now() },
    };
    state.demo = false;
    state.mode = 'history';
    state.loadedAt = Date.now();
    state.sort = 'persist';
    const sel = $('#sortSelect');
    if (sel) sel.value = 'persist';
    state.note =
      r.daysAvailable > 0
        ? `在最近 ${days} 天的窗口里，本工具实际记录了 ${r.daysAvailable} 天（${r.from} 至 ${r.to}），共 ${r.items.length} 个不重复词条，按「上榜天数」从多到少排序。这是本地累积统计，不含你开始使用之前的历史。`
        : `最近 ${days} 天还没有任何本地记录。这个视图依靠每天打开一次工具自动累积（当前已记录 ${r.allDaysCount} 天），从今天起用几天就会越来越准；想看 Google 官方的 90 天飙升数据，请用「关键词飙升分析」并配置代理。`;
    clearError();
    renderDaily();
    setPill(r.daysAvailable > 0 ? 'ok' : 'warn', r.daysAvailable > 0 ? `历史 · ${r.daysAvailable} 天记录` : '历史暂无数据');
  } catch (e) {
    grid.innerHTML = '';
    showError(e.message, '');
  } finally {
    $('#btnRefresh').disabled = false;
  }
}

function renderBanner() {
  const el = $('#srcBanner');
  if (state.mode === 'google') {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  let cls = 'warn';
  let icon = 'ℹ️';
  let title = '';
  if (state.mode === 'aggregator') {
    cls = 'warn';
    icon = '🛰️';
    title = '已自动切换到免代理数据源';
  } else if (state.mode === 'history') {
    cls = 'info';
    icon = '📅';
    title = '最近 ' + state.range + ' 天 · 本地累积统计';
  } else if (state.mode === 'snapshot') {
    cls = 'info';
    icon = '🗂️';
    title = '当前展示的是本地缓存快照';
  } else if (state.mode === 'demo') {
    cls = 'info';
    icon = '🧪';
    title = '当前展示的是示例数据';
  }
  el.className = 'src-banner ' + cls;
  el.style.display = 'block';
  el.innerHTML = `<b>${icon} ${esc(title)}</b>${state.note ? '<br/>' + esc(state.note) : ''}`;
}

function showError(msg, hint) {
  clearError();
  const box = document.createElement('div');
  box.className = 'err-box';
  box.id = 'errBox';
  box.innerHTML =
    '⚠️ ' + esc(msg) +
    (hint ? '\n\n' + esc(hint) : '') +
    '\n\n👉 若提示连接失败/超时，请到「连接设置」填写本机代理端口（Clash 常见 127.0.0.1:7890，v2rayN 常见 127.0.0.1:10809），或开启代理软件的 TUN/全局模式。';
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
  else if (state.sort === 'persist')
    items.sort(
      (a, b) => (b.appearances || 0) - (a.appearances || 0) || b.trafficValue - a.trafficValue
    );
  else items.sort((a, b) => (a.geo === b.geo ? b.trafficValue - a.trafficValue : a.geo.localeCompare(b.geo)));

  const total = items.length;
  const geos = Object.keys(state.data).filter((g) => !state.data[g].error);
  const SRC_LABEL = {
    google: 'Google Trends 官方接口',
    aggregator: 'hottrends.ai 聚合源（免代理）',
    snapshot: '本地快照',
    history: '本地累积历史（最近 ' + state.range + ' 天）',
    demo: '示例数据（非真实）',
  };
  const src = SRC_LABEL[state.mode] || '未知来源';
  renderBanner();
  $('#dailyMeta').innerHTML = [
    `<span>共 <b>${total}</b> 条</span>`,
    state.mode === 'history' ? '' : `<span>地区 <b>${geos.length}</b> 个</span>`,
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
      : '还没有数据，点右上角「刷新数据」开始抓取。';
    return;
  }
  $('#dailyEmpty').style.display = 'none';

  grid.innerHTML = items
    .map((it, i) => {
      const zh = state.zh;
      const title = it.exploreLink
        ? `<a href="${esc(it.exploreLink)}" target="_blank" rel="noreferrer">${esc(it.query)}</a>`
        : esc(it.query);
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
          ${
            it.appearances
              ? `<span class="badge badge-persist">上榜 ${it.appearances} 天${
                  it.firstSeen ? ' · 首见 ' + esc(String(it.firstSeen).slice(5)) : ''
                }</span>`
              : ''
          }
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
  const hasPersist = items.some((it) => it.appearances);
  const rows = [
    ['地区', '排名', '词条', '搜索量'].concat(hasPersist ? ['上榜天数', '首次出现'] : [], ['相关查询', '首条资讯', '资讯链接', '链接']),
  ];
  items.forEach((it, i) => {
    const base = [GEO_LABEL[it.geo] || it.geo, i + 1, it.query, it.traffic || it.trafficValue];
    if (hasPersist) base.push(it.appearances || 1, it.firstSeen || '');
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
    toast('这是界面示例数据，不是真实抓取结果');
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
    : `<tr><td colspan="3" class="skeleton">该关键词在所选时间范围内没有飙升相关查询。</td></tr>`;

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
    : `<tr><td colspan="3" class="skeleton">没有热门相关查询。</td></tr>`;

  box.innerHTML = `
    <div class="card">
      <div class="kw-head">
        <h2>「${esc(data.keyword)}」</h2>
        <span class="badge badge-geo">${esc(GEO_LABEL[data.geo] || data.geo)}</span>
        <span class="badge">${esc(data.time)}</span>
        <span class="badge">飙升词 ${data.rising.length} 个</span>
      </div>
    </div>
    <div class="chart-wrap">
      ${svgChart(data.timeline)}
      <div class="chart-cap">关注度指数（0–100）随时间变化，仅供趋势参考</div>
    </div>
    <div class="kw-cols">
      <div class="card">
        <h2 class="card-title" style="color:var(--rise)">📈 飙升相关查询（RISING）</h2>
        <p class="hint" style="margin-bottom:8px">搜索量在所选时间范围内增幅最大，最容易是新出现的词。</p>
        <table class="tbl">
          <thead><tr><th>查询词</th><th class="num">涨幅</th><th></th></tr></thead>
          <tbody>${risingRows}</tbody>
        </table>
      </div>
      <div class="card">
        <h2 class="card-title">🔍 热门相关查询（TOP）</h2>
        <p class="hint" style="margin-bottom:8px">该关键词下搜索量最高的相关词。</p>
        <table class="tbl">
          <thead><tr><th>查询词</th><th class="num">热度</th><th></th></tr></thead>
          <tbody>${topRows}</tbody>
        </table>
      </div>
    </div>`;

  fillTranslations(box);
}

async function runKeyword() {
  const q = $('#kwInput').value.trim();
  if (!q) return toast('请输入关键词');
  const geo = $('#kwGeo').value;
  const time = $('#kwTime').value;
  const box = $('#kwResult');
  box.innerHTML = `<div class="loading"><span class="spinner"></span>正在分析「${esc(q)}」…</div>`;
  try {
    const r = await api(
      '/api/keyword?q=' + encodeURIComponent(q) + '&geo=' + geo + '&time=' + encodeURIComponent(time)
    );
    if (!r.ok) {
      const matches = r.localMatches || [];
      box.innerHTML =
        `<div class="err-box">⚠️ ${esc(r.error || '分析失败')}${r.hint ? '\n\n' + esc(r.hint) : ''}</div>` +
        (matches.length
          ? `<div class="card"><h2 class="card-title">免代理聚合源中匹配到的话题</h2>
             <table class="tbl"><thead><tr><th>话题</th><th class="num">热度</th><th>类别</th></tr></thead><tbody>
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
/* 连接设置                                                            */
/* ------------------------------------------------------------------ */

async function saveProxy() {
  const proxy = $('#proxyInput').value.trim();
  const r = await api('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proxy }),
  });
  if (r.ok) {
    toast(proxy ? '已保存代理：' + proxy : '已切换到直连模式');
    refreshStatus();
  } else toast('保存失败');
}

async function testConn() {
  const out = $('#testOut');
  out.innerHTML = `<span class="skeleton">正在测试…</span>`;
  const proxy = $('#proxyInput').value.trim();
  const r = await api('/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proxy }),
  });
  if (r.ok) {
    out.innerHTML = `<span class="ok">✓ 连通成功</span>（${
      r.mode === 'proxy' ? '经代理 ' + esc(r.proxy) : '直连'
    }）可以直接抓取 Google Trends 数据。`;
    setPill('ok', '已连接');
  } else {
    out.innerHTML = `<span class="bad">✗ 连通失败</span>（${
      r.mode === 'proxy' ? '经代理 ' + esc(r.proxy) : '直连'
    }）：${esc(r.error || '未知错误')}<br/>请确认代理软件正在运行，并填写正确的本地端口。`;
    setPill('bad', '连接失败');
  }
}

async function detectProxy() {
  const out = $('#detectOut');
  out.innerHTML = `<span class="skeleton">正在扫描常见代理端口（可能需要十几秒）…</span>`;
  const r = await api('/api/detect');
  const list = (r.results || [])
    .map(
      (x) =>
        `<span class="det${x.ok ? ' ok' : ''}">${esc(x.url.replace(/^http:\/\//, ''))} ${
          x.ok ? '✓' : '✗'
        }</span>`
    )
    .join('');
  if (r.picked) {
    out.innerHTML = `<div><b style="color:var(--ok)">已自动选中：${esc(r.picked)}</b></div><div>${list}</div>`;
    $('#proxyInput').value = r.picked;
    toast('已自动配置代理：' + r.picked);
    refreshStatus();
  } else {
    out.innerHTML = `<div><b style="color:var(--rise)">没有探测到可用代理</b></div><div>${list}</div>
      <div class="hint">请手动确认代理软件的本地端口，或开启 TUN/全局模式后使用直连。</div>`;
  }
}

async function showSnapshotInfo() {
  const out = $('#snapOut');
  out.innerHTML = `<span class="skeleton">读取中…</span>`;
  const r = await api('/api/snapshot');
  if (!r.ok) {
    out.innerHTML = '暂无本地快照。抓取成功一次后会自动生成。';
    return;
  }
  out.innerHTML = `快照保存于 <b>${new Date(r.savedAt).toLocaleString('zh-CN')}</b>，包含地区：${r.geos
    .map((g) => esc(GEO_LABEL[g] || g))
    .join('、')}。文件位置：<code>data/snapshot.json</code>`;
}

async function fetchAggregatorOnly() {
  const out = $('#snapOut');
  out.innerHTML = `<span class="skeleton">正在从免代理聚合源抓取…</span>`;
  const r = await api('/api/aggregator');
  if (!r.ok) {
    out.innerHTML = `<span class="bad">抓取失败</span>：${esc(r.error || '')}`;
    return;
  }
  state.data = { GLOBAL: r.data };
  state.demo = false;
  state.mode = 'aggregator';
  state.note = '已手动使用免代理聚合源 hottrends.ai 抓取，内容为实时热搜话题与相关搜索词。';
  state.loadedAt = Date.now();
  clearError();
  renderDaily();
  setPill('warn', '免代理聚合源');
  out.innerHTML = `<span class="ok">✓ 已更新</span>：共 ${r.data.items.length} 条，抓取于 ${new Date(
    r.data.fetchedAt
  ).toLocaleTimeString('zh-CN')}。已切换到「每日飙升榜」查看。`;
  $$('.tab').forEach((x) => x.classList.remove('active'));
  $$('.panel').forEach((x) => x.classList.remove('active'));
  $$('.tab').find((x) => x.dataset.tab === 'daily').classList.add('active');
  $('#panel-daily').classList.add('active');
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
    $('#panel-' + tab.dataset.tab).classList.add('active');
  };
  $$('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      activate(t.dataset.tab);
      history.replaceState(null, '', '#' + t.dataset.tab);
    });
  });
  const initial = (location.hash || '').replace('#', '');
  if (initial) activate(initial);
}

function init() {
  initTabs();
  renderGeoChips();

  $('#kwGeo').innerHTML = REGIONS.map(
    (r) => `<option value="${r.code}"${r.code === 'US' ? ' selected' : ''}>${r.label}</option>`
  ).join('');

  const urlRange = Number(new URLSearchParams(location.search).get('range') || 0);
  if ([7, 30, 90].includes(urlRange)) {
    state.range = urlRange;
    $('#rangeSelect').value = String(urlRange);
  }

  $('#btnRefresh').addEventListener('click', loadDaily);
  $('#btnDemo').addEventListener('click', loadDemo);
  $('#btnExport').addEventListener('click', exportCsv);
  $('#rangeSelect').addEventListener('change', (e) => {
    state.range = Number(e.target.value) || 0;
    if (state.range === 0) {
      loadDaily();
    } else {
      loadHistory();
    }
  });
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
  };
  syncZh();
  zhT.addEventListener('change', () => {
    state.zh = zhT.checked;
    localStorage.setItem('gt_zh', state.zh ? '1' : '0');
    syncZh();
    renderDaily();
    if (state.kw) renderKeyword(state.kw);
    if (state.zh) toast('正在翻译为中文…');
  });

  $('#btnSave').addEventListener('click', saveProxy);
  $('#btnTest').addEventListener('click', testConn);
  $('#btnDetect').addEventListener('click', detectProxy);
  $('#btnSnap').addEventListener('click', showSnapshotInfo);
  $('#btnAgg').addEventListener('click', fetchAggregatorOnly);

  refreshStatus().then(() => {
    // 首屏自动尝试抓取一次
    setTimeout(loadDaily, 150);
  });
}

document.addEventListener('DOMContentLoaded', init);
