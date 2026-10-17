(function () {
  'use strict';

  var LANG = window.__LANG__ || 'zh-CN';
  var T = window.__T__ || {};
  var t = function (s) {
    return T[s] || s;
  };

  var MAX = 4;
  var COLORS = ['#5145e5', '#dc3f3b', '#0f9d58', '#f59e0b'];

  var site = null;
  var hist = null;
  var dict = {};
  var bySlug = {};
  var picked = [];
  var months = 60;

  var $q = document.getElementById('cmp-q');
  var $sug = document.getElementById('cmp-sug');
  var $chips = document.getElementById('cmp-chips');
  var $chart = document.getElementById('cmp-chart');
  var $table = document.getElementById('cmp-table');
  var $range = document.getElementById('cmp-range');

  function fmtNum(n) {
    if (n == null) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(Math.round(n));
  }
  function pct(v) {
    if (v == null || !isFinite(v)) return '—';
    return (v > 0 ? '+' : '') + Math.round(v) + '%';
  }
  function nameOf(tp) {
    return dict[tp.keyword] || tp.keyword;
  }

  function loadDict() {
    if (LANG === 'en') return Promise.resolve({});
    if (LANG === 'zh-CN') {
      return fetch('/data/zh.json')
        .then(function (r) { return r.ok ? r.json() : {}; })
        .then(function (d) { return d.map || d || {}; })
        .catch(function () { return {}; });
    }
    return fetch('/data/i18n/topics-' + LANG + '.json')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; });
  }

  function init() {
    Promise.all([
      fetch('/data/site.json').then(function (r) { return r.json(); }),
      fetch('/data/hist.json')
        .then(function (r) { return r.ok ? r.json() : {}; })
        .catch(function () { return {}; }),
      loadDict(),
    ])
      .then(function (res) {
        site = res[0];
        hist = res[1] || {};
        dict = res[2] || {};
        (site.topics || []).forEach(function (tp) {
          bySlug[tp.slug] = tp;
        });
        readUrl();
        render();
      })
      .catch(function () {
        $chart.innerHTML = '<p class="cmp-empty">' + t('还没有选择关键词') + '</p>';
      });
  }

  function readUrl() {
    var m = /[?&]k=([^&]+)/.exec(location.search);
    if (!m) return;
    var slugs = decodeURIComponent(m[1]).split(',').slice(0, MAX);
    slugs.forEach(function (s) {
      if (bySlug[s] && picked.indexOf(s) < 0) picked.push(s);
    });
  }

  function writeUrl() {
    var q = picked.length ? '?k=' + encodeURIComponent(picked.join(',')) : '';
    try {
      history.replaceState(null, '', location.pathname + q);
    } catch (e) {}
  }

  function search(q) {
    q = q.trim().toLowerCase();
    if (q.length < 1) return [];
    var out = [];
    var topics = site.topics || [];
    for (var i = 0; i < topics.length && out.length < 8; i++) {
      var tp = topics[i];
      if (picked.indexOf(tp.slug) >= 0) continue;
      var kw = tp.keyword.toLowerCase();
      var nm = (dict[tp.keyword] || '').toLowerCase();
      if (kw.indexOf(q) >= 0 || (nm && nm.indexOf(q) >= 0)) out.push(tp);
    }
    return out;
  }

  function renderSug(list) {
    if (!list.length) {
      $sug.hidden = true;
      $sug.innerHTML = '';
      return;
    }
    $sug.innerHTML = list
      .map(function (tp) {
        return (
          '<button type="button" class="cmp-sug-i" data-slug="' + tp.slug + '">' +
          '<span class="cs-n">' + esc(nameOf(tp)) + '</span>' +
          '<span class="cs-v">' + fmtNum(tp.vol) + ' · ' + pct(tp.g12) + '</span>' +
          '</button>'
        );
      })
      .join('');
    $sug.hidden = false;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function add(slug) {
    if (picked.length >= MAX || picked.indexOf(slug) >= 0) return;
    picked.push(slug);
    $q.value = '';
    renderSug([]);
    render();
  }

  function remove(slug) {
    picked = picked.filter(function (s) {
      return s !== slug;
    });
    render();
  }

  function renderChips() {
    if (!picked.length) {
      $chips.innerHTML = '';
      return;
    }
    $chips.innerHTML = picked
      .map(function (slug, i) {
        var tp = bySlug[slug];
        return (
          '<span class="cmp-chip" style="--c:' + COLORS[i % COLORS.length] + '">' +
          '<i></i>' + esc(nameOf(tp)) +
          '<button type="button" data-rm="' + slug + '" aria-label="remove">×</button>' +
          '</span>'
        );
      })
      .join('');
  }

  function series() {
    return picked
      .map(function (slug, i) {
        var tp = bySlug[slug];
        var h = hist[slug];
        if (!tp || !h || !h.v || !h.v.length) return null;
        var v = months ? h.v.slice(-months) : h.v;
        var off = months ? Math.max(0, h.v.length - months) : 0;
        var t0 = Number(h.t0);
        var step = Number(h.step) || 2592000;
        var pts = v.map(function (val, k) {
          return { ts: t0 + (off + k) * step, val: Number(val) || 0 };
        });
        var max = 0;
        pts.forEach(function (p) {
          if (p.val > max) max = p.val;
        });
        return { slug: slug, tp: tp, color: COLORS[i % COLORS.length], pts: pts, max: max || 1 };
      })
      .filter(Boolean);
  }

  function drawChart() {
    var list = series();
    if (!list.length) {
      $chart.innerHTML =
        '<div class="cmp-empty">' + t('还没有选择关键词') +
        '<span>' + t('先在上面搜索并添加要对比的词') + '</span></div>';
      return;
    }

    var W = 760;
    var H = 300;
    var PL = 40;
    var PR = 14;
    var PT = 14;
    var PB = 26;

    var minTs = Infinity;
    var maxTs = -Infinity;
    list.forEach(function (s) {
      minTs = Math.min(minTs, s.pts[0].ts);
      maxTs = Math.max(maxTs, s.pts[s.pts.length - 1].ts);
    });
    var span = maxTs - minTs || 1;

    var xOf = function (ts) {
      return PL + ((ts - minTs) / span) * (W - PL - PR);
    };
    var yOf = function (pctVal) {
      return PT + (1 - pctVal / 100) * (H - PT - PB);
    };

    var grid = '';
    [0, 25, 50, 75, 100].forEach(function (g) {
      var y = yOf(g);
      grid +=
        '<line x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + y.toFixed(1) +
        '" stroke="currentColor" stroke-opacity="' + (g === 0 ? '.22' : '.1') + '" stroke-width="1"/>' +
        '<text x="' + (PL - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" font-size="10.5" fill="currentColor" fill-opacity=".45">' + g + '</text>';
    });

    // x 轴：首、中、尾三年份
    var years = [];
    var d0 = new Date(minTs * 1000);
    var d1 = new Date(maxTs * 1000);
    var y0 = d0.getFullYear();
    var y1 = d1.getFullYear();
    if (y1 > y0) {
      var midY = Math.round((y0 + y1) / 2);
      [y0 + 1, midY, y1].forEach(function (yy) {
        if (yy <= y0 || yy > y1) return;
        var ts = Date.UTC(yy, 0, 1) / 1000;
        if (ts < minTs || ts > maxTs) return;
        var x = xOf(ts);
        grid +=
          '<line x1="' + x.toFixed(1) + '" y1="' + PT + '" x2="' + x.toFixed(1) + '" y2="' + (H - PB) +
          '" stroke="currentColor" stroke-opacity=".07" stroke-width="1"/>' +
          '<text x="' + x.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10.5" fill="currentColor" fill-opacity=".45">' + yy + '</text>';
      });
    }

    var lines = list
      .map(function (s) {
        var pts = s.pts
          .map(function (p) {
            return xOf(p.ts).toFixed(1) + ',' + yOf((p.val / s.max) * 100).toFixed(1);
          })
          .join(' ');
        return (
          '<polyline points="' + pts + '" fill="none" stroke="' + s.color +
          '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>'
        );
      })
      .join('');

    var legend = list
      .map(function (s) {
        return (
          '<span class="lg-i"><i style="background:' + s.color + '"></i>' + esc(nameOf(s.tp)) +
          '<b>' + fmtNum(s.tp.vol) + '</b></span>'
        );
      })
      .join('');

    $chart.innerHTML =
      '<svg class="cmp-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="keyword comparison">' +
      grid + lines + '</svg>' +
      '<div class="cmp-legend">' + legend + '</div>';
  }

  function drawTable() {
    if (!picked.length) {
      $table.innerHTML = '';
      return;
    }
    var head =
      '<thead><tr><th>' + t('搜索关键词') + '</th><th>' + t('月搜索量') + '</th><th>' + t('90 天增长') +
      '</th><th>' + t('12 个月增长') + '</th><th>' + t('本轮起量') + '</th><th>' + t('波动率') + '</th></tr></thead>';
    var body = picked
      .map(function (slug, i) {
        var tp = bySlug[slug];
        if (!tp) return '';
        var inf = tp.inflection;
        var infTxt = inf ? inf.at + ' · ' + inf.months + ' ' + t('个月') : '—';
        return (
          '<tr><th><span class="cmp-dot" style="background:' + COLORS[i % COLORS.length] + '"></span>' +
          esc(nameOf(tp)) + '</th>' +
          '<td>' + fmtNum(tp.vol) + '</td>' +
          '<td class="' + (tp.g90 > 0 ? 'up' : 'down') + '">' + pct(tp.g90) + '</td>' +
          '<td class="' + (tp.g12 > 0 ? 'up' : 'down') + '">' + pct(tp.g12) + '</td>' +
          '<td>' + esc(infTxt) + '</td>' +
          '<td>' + (tp.volatility != null ? Math.round(tp.volatility * 100) + '%' : '—') + '</td></tr>'
        );
      })
      .join('');
    $table.innerHTML = '<table class="kv-table cmp-tbl">' + head + '<tbody>' + body + '</tbody></table>';
  }

  function render() {
    renderChips();
    drawChart();
    drawTable();
    writeUrl();
  }

  $q.addEventListener('input', function () {
    renderSug(search($q.value));
  });
  $q.addEventListener('focus', function () {
    if ($q.value.trim()) renderSug(search($q.value));
  });
  $q.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') renderSug([]);
    if (e.key === 'Enter') {
      var first = search($q.value)[0];
      if (first) add(first.slug);
    }
  });

  $sug.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-slug]');
    if (btn) add(btn.getAttribute('data-slug'));
  });

  $chips.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-rm]');
    if (btn) remove(btn.getAttribute('data-rm'));
  });

  $range.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-r]');
    if (!btn) return;
    months = Number(btn.getAttribute('data-r'));
    Array.prototype.forEach.call($range.querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b === btn);
    });
    drawChart();
  });

  document.getElementById('cmp-clear').addEventListener('click', function () {
    picked = [];
    render();
  });

  document.addEventListener('click', function (e) {
    if (!$sug.contains(e.target) && e.target !== $q) renderSug([]);
  });

  init();
})();
