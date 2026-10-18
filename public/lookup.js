'use strict';
/* 实时关键词分析页：调 /api/keyword（Cloudflare Pages Function，
   复杂查询自动派发 GitHub Actions，前端轮询直到出结果）。 */

(function () {
  var LANG = window.__LANG__ || 'zh-CN';
  var T = window.__T__ || {};

  function t(s) {
    return T[s] || s;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(sel) {
    return document.querySelector(sel);
  }

  /* ---------------------------- 地区下拉 ---------------------------- */

  var GEOS = ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'JP', 'KR', 'IN', 'ID', 'BR', 'MX', 'ES', 'IT', 'VN', 'TH', 'SG', 'MY', 'PH'];
  function fillGeo() {
    var sel = $('#kwGeo');
    if (!sel) return;
    var names = {};
    try {
      var dn = new Intl.DisplayNames([LANG], { type: 'region' });
      GEOS.forEach(function (g) {
        names[g] = dn.of(g) || g;
      });
    } catch (e) {
      GEOS.forEach(function (g) {
        names[g] = g;
      });
    }
    sel.innerHTML = GEOS.map(function (g) {
      return '<option value="' + g + '"' + (g === 'US' ? ' selected' : '') + '>' + esc(names[g]) + ' · ' + g + '</option>';
    }).join('');
  }

  /* ---------------------------- 图表 ---------------------------- */

  function svgChart(points) {
    var w = 640;
    var h = 170;
    var padL = 34;
    var padR = 10;
    var padT = 12;
    var padB = 22;
    if (!points || points.length < 2) {
      return '<div class="skeleton" style="padding:18px">' + esc(t('暂无关注度曲线数据')) + '</div>';
    }
    var vals = points.map(function (p) { return typeof p.v === 'number' ? p.v : 0; });
    var max = Math.max.apply(null, vals.concat([1]));
    var innerW = w - padL - padR;
    var innerH = h - padT - padB;
    var x = function (i) { return padL + (innerW * i) / (points.length - 1); };
    var y = function (v) { return padT + innerH - (innerH * v) / max; };

    var line = '';
    points.forEach(function (p, i) {
      line += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(vals[i]).toFixed(1) + ' ';
    });
    var area =
      'M' + padL + ' ' + (padT + innerH).toFixed(1) + ' ' +
      points.map(function (p, i) { return 'L' + x(i).toFixed(1) + ' ' + y(vals[i]).toFixed(1); }).join(' ') +
      ' L' + (w - padR).toFixed(1) + ' ' + (padT + innerH).toFixed(1) + ' Z';

    var grid = [0, 0.5, 1]
      .map(function (r) {
        var gy = padT + innerH * r;
        return '<line x1="' + padL + '" x2="' + (w - padR) + '" y1="' + gy + '" y2="' + gy + '" stroke="#eef0f5" stroke-width="1"/>' +
          '<text x="' + (padL - 6) + '" y="' + (gy + 4) + '" text-anchor="end" font-size="10" fill="#a2a8b8">' + Math.round(max * (1 - r)) + '</text>';
      })
      .join('');

    var step = Math.max(1, Math.ceil(points.length / 6));
    var xlabels = points
      .map(function (p, i) {
        return i % step === 0 || i === points.length - 1
          ? '<text x="' + x(i).toFixed(1) + '" y="' + (h - 6) + '" text-anchor="middle" font-size="10" fill="#a2a8b8">' + esc(p.tAxis || p.t || '') + '</text>'
          : '';
      })
      .join('');

    var last = points[points.length - 1];
    return '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
      '<defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#4f46e5" stop-opacity="0.18"/>' +
      '<stop offset="100%" stop-color="#4f46e5" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      grid +
      '<path d="' + area + '" fill="url(#g1)"/>' +
      '<path d="' + line + '" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' + x(points.length - 1).toFixed(1) + '" cy="' + y(vals[vals.length - 1]).toFixed(1) + '" r="3.5" fill="#4f46e5"/>' +
      xlabels +
      '<text x="' + (w - padR - 4).toFixed(1) + '" y="' + (y(vals[vals.length - 1]) - 8).toFixed(1) + '" text-anchor="end" font-size="10" fill="#4f46e5">' + esc(String(last.v != null ? last.v : '')) + '</text>' +
      '</svg>';
  }

  function pctText(v) {
    if (!isFinite(v)) return '—';
    var n = Math.round(v);
    return (n >= 0 ? '+' : '') + n + '%';
  }

  /* ---------------------------- 结果渲染 ---------------------------- */

  function renderKeyword(data) {
    var box = $('#kwResult');
    if (!data) {
      box.innerHTML = '';
      return;
    }
    var maxGain = Math.max.apply(null, data.rising.map(function (r) { return Number(r.value) || 0; }).concat([1]));
    var maxTop = Math.max.apply(null, data.top.map(function (r) { return Number(r.value) || 0; }).concat([1]));

    var risingRows = data.rising.length
      ? data.rising
          .map(function (r) {
            return '<tr><td>' +
              (r.link ? '<a class="q-link" href="' + esc(r.link) + '" target="_blank" rel="noreferrer">' + esc(r.query) + '</a>' : esc(r.query)) +
              '</td><td class="num"><span class="gain">' + esc(r.formattedValue || r.value) + '</span></td>' +
              '<td style="width:90px"><div class="bar rise"><i style="width:' + Math.min(100, ((Number(r.value) || 0) / maxGain) * 100).toFixed(1) + '%"></i></div></td></tr>';
          })
          .join('')
      : '<tr><td colspan="3" class="skeleton">' + esc(t('该关键词在所选时间范围内没有飙升相关查询。')) + '</td></tr>';

    var topRows = data.top.length
      ? data.top
          .map(function (r) {
            return '<tr><td>' +
              (r.link ? '<a class="q-link" href="' + esc(r.link) + '" target="_blank" rel="noreferrer">' + esc(r.query) + '</a>' : esc(r.query)) +
              '</td><td class="num">' + esc(String(r.value != null ? r.value : '')) + '</td>' +
              '<td style="width:90px"><div class="bar"><i style="width:' + Math.min(100, ((Number(r.value) || 0) / maxTop) * 100).toFixed(1) + '%"></i></div></td></tr>';
          })
          .join('')
      : '<tr><td colspan="3" class="skeleton">' + esc(t('没有热门相关查询。')) + '</td></tr>';

    var m = data.metrics || {};
    var metricChips = [];
    if (typeof m.g90 === 'number')
      metricChips.push('<div class="num"><b class="' + (m.g90 > 0 ? 'up' : 'down') + '">' + esc(pctText(m.g90)) + '</b><span>' + esc(t('90 天增长')) + '</span></div>');
    if (typeof m.g12 === 'number')
      metricChips.push('<div class="num"><b class="' + (m.g12 > 0 ? 'up' : 'down') + '">' + esc(pctText(m.g12)) + '</b><span>' + esc(t('12 个月增长')) + '</span></div>');
    if (m.peakMonth != null)
      metricChips.push('<div class="num"><b>' + esc(String(m.peakMonth + 1)) + '</b><span>' + esc(t('季节峰值月')) + '</span></div>');
    if (typeof m.latest === 'number')
      metricChips.push('<div class="num"><b>' + m.latest + '</b><span>' + esc(t('当前热度')) + '</span></div>');

    box.innerHTML =
      '<div class="card">' +
      '<div class="kw-head">' +
      '<h2>「' + esc(data.keyword) + '」</h2>' +
      '<span class="badge badge-geo">' + esc(data.geo) + '</span>' +
      '<span class="badge">' + esc(data.time) + '</span>' +
      '<span class="badge">' + esc(t('飙升词')) + ' ' + data.rising.length + '</span>' +
      '</div>' +
      (metricChips.length ? '<div class="opp-nums" style="margin-top:10px">' + metricChips.join('') + '</div>' : '') +
      '</div>' +
      '<div class="chart-wrap">' + svgChart(data.timeline) +
      '<div class="chart-cap">' + esc(t('关注度指数（0–100）随时间变化，仅供趋势参考')) + '</div></div>' +
      '<div class="kw-cols">' +
      '<div class="card"><h2 class="card-title" style="color:var(--rise)">📈 ' + esc(t('飙升相关查询（RISING）')) + '</h2>' +
      '<p class="hint" style="margin-bottom:8px">' + esc(t('搜索量在所选时间范围内增幅最大，最容易是新出现的词。')) + '</p>' +
      '<table class="tbl"><thead><tr><th>' + esc(t('查询词')) + '</th><th class="num">' + esc(t('涨幅')) + '</th><th></th></tr></thead><tbody>' + risingRows + '</tbody></table></div>' +
      '<div class="card"><h2 class="card-title">🔍 ' + esc(t('热门相关查询（TOP）')) + '</h2>' +
      '<p class="hint" style="margin-bottom:8px">' + esc(t('该关键词下搜索量最高的相关词。')) + '</p>' +
      '<table class="tbl"><thead><tr><th>' + esc(t('查询词')) + '</th><th class="num">' + esc(t('热度')) + '</th><th></th></tr></thead><tbody>' + topRows + '</tbody></table></div>' +
      '</div>';
  }

  /* ---------------------------- 查询与轮询 ---------------------------- */

  var ERR_TEXT = {
    NO_DATA: '没有找到相关数据，这个词的搜索量可能太低，换个词试试。',
    RATE_LIMITED: 'Google Trends 暂时限流，请过一两分钟再试。',
    UPSTREAM: '云端分析暂时不可用，请稍后再试。',
    QUEUED: '云端分析超时了，请再点一次「分析」（结果通常已缓存好，第二次会很快）。',
    'missing q': '请输入关键词',
  };

  function runKeyword() {
    var q = $('#kwInput').value.trim();
    if (!q) return alert(t('请输入关键词'));
    var geo = $('#kwGeo').value;
    var time = $('#kwTime').value;
    var box = $('#kwResult');
    var fetchKw = function () {
      return fetch('/api/keyword?q=' + encodeURIComponent(q) + '&geo=' + encodeURIComponent(geo) + '&time=' + encodeURIComponent(time)).then(function (r) {
        return r.json();
      });
    };
    box.innerHTML = '<div class="loading"><span class="spinner"></span>' + esc(t('正在分析')) + '「' + esc(q) + '」…</div>';
    var r = null;
    fetchKw()
      .then(function (r1) {
        r = r1;
        if (!r.ok && r.error === 'QUEUED') {
          box.innerHTML = '<div class="loading"><span class="spinner"></span>' + esc(t('云端计算中，约需 1 分钟，请稍候…')) + '</div>';
          var tries = 0;
          var poll = function () {
            tries += 1;
            return fetchKw().then(function (r2) {
              r = r2;
              if (r.ok || (r.error !== 'QUEUED' && r.error !== 'UPSTREAM') || tries >= 12) return null;
              return new Promise(function (res) {
                setTimeout(res, (r.retryAfter || 12) * 1000);
              }).then(poll);
            });
          };
          return poll();
        }
        return null;
      })
      .then(function () {
        if (r && r.ok) {
          renderKeyword(r);
          return;
        }
        var err = r || { error: 'UPSTREAM' };
        var errText = ERR_TEXT[err.error] ? t(ERR_TEXT[err.error]) : err.hint || err.error || t('分析失败');
        box.innerHTML = '<div class="err-box">⚠️ ' + esc(errText) + '</div>';
      })
      .catch(function (e) {
        box.innerHTML = '<div class="err-box">⚠️ ' + esc((e && e.message) || t('分析失败')) + '</div>';
      });
  }

  /* ---------------------------- 启动 ---------------------------- */

  fillGeo();
  // 支持 /lookup/?q=<词> 预填（话题页「实时查词」入口跳转过来）
  try {
    var qp = new URLSearchParams(location.search).get('q');
    if (qp && $('#kwInput')) $('#kwInput').value = qp;
  } catch (e) {}
  if ($('#btnKw')) $('#btnKw').addEventListener('click', runKeyword);
  if ($('#kwInput'))
    $('#kwInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') runKeyword();
    });
})();
