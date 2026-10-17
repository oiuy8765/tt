'use strict';

/**
 * 多语言静态站的交互层。
 *
 * 页面内容在构建时就写进了 HTML（爬虫读得到），这里只做三件事：
 *   1. 接管筛选 / 排序 / 搜索（不改变页面的语义结构）
 *   2. 收藏（localStorage，跨语言共用）
 *   3. 语言菜单
 * 没有这段 JS，页面依然完整可读 —— 这是和纯前端渲染最大的区别。
 */

(function () {
  var LANG = window.__LANG__ || 'zh-CN';
  var BASE = window.__BASE__ || '';
  var DICT = window.__T__ || {};
  var SAVED_KEY = 'gt_saved';
  var PAGE = 60;

  function t(k) {
    if (LANG === 'zh-CN') return k;
    return DICT[k] || k;
  }

  function $(s, r) {
    return (r || document).querySelector(s);
  }
  function $$(s, r) {
    return Array.prototype.slice.call((r || document).querySelectorAll(s));
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtNum(n) {
    if (n == null || isNaN(n)) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'K';
    return String(Math.round(n));
  }

  function pct(v) {
    if (v == null || isNaN(v)) return '—';
    return (v > 0 ? '+' : '') + Math.round(v * 10) / 10 + '%';
  }

  // 系统生成文案（建议/渠道）：直接给译文
  function sysText(s) {
    if (!s) return '';
    var k = String(s).replace(/\s+/g, ' ').trim();
    if (LANG === 'zh-CN') return k;
    return CONTENT[k] || k;
  }

  // 分类标签：slug → 中文 → 译文
  var CAT_LABEL = {
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
  function catText(c) {
    var zh = CAT_LABEL[c] || c;
    if (LANG === 'zh-CN') return zh;
    return CONTENT[zh] || zh;
  }

  // 简介：原文/译文各自查整段词典后再截断（避免截断后查不到词典）
  function dualDesc(s, max) {
    var full = String(s || '');
    if (!full) return '';
    var tr = CONTENT[full];
    var o = full.length > max ? full.slice(0, max) + '…' : full;
    var t2 = tr && tr !== full ? (tr.length > max ? tr.slice(0, max) + '…' : tr) : '';
    if (!t2) return esc(o);
    return '<span class="tr-o">' + esc(o) + '</span><span class="tr-t">' + esc(t2) + '</span>';
  }

  // 季节柱状图（12 个月相对强弱）
  function seasonBar(x) {
    if (!x.season || !x.season.months) return '';
    var ms = x.season.months;
    var strong = x.season.strength >= 0.4;
    var bars = ms
      .map(function (v, i) {
        var h = v == null ? 8 : Math.max(10, Math.round(v * 100));
        var pk = x.season.peakMonth === i + 1 ? ' pk' : '';
        return '<i class="sb' + pk + '" style="height:' + h + '%"></i>';
      })
      .join('');
    var note;
    if (!strong) note = t('全年平坦');
    else {
      note = t('峰 [[M]] 月 · [[P]] 月前准备')
        .replace('[[M]]', x.season.peakMonth)
        .replace('[[P]]', x.seasonPrepMonth || x.season.peakMonth);
    }
    return (
      '<div class="season' + (strong ? ' strong' : '') + '">' +
      '<span class="season-lbl">' + esc(t('季节')) + '</span>' +
      '<div class="season-bars">' + bars + '</div>' +
      '<span class="season-note">' + esc(note) + '</span></div>'
    );
  }

  function spark(values, w, h) {
    var arr = (values || []).filter(function (v) {
      return typeof v === 'number';
    });
    if (arr.length < 2) return '';
    var max = Math.max.apply(null, arr);
    var min = Math.min.apply(null, arr);
    var span = max - min || 1;
    var step = w / (arr.length - 1);
    var pts = arr
      .map(function (v, i) {
        return (i * step).toFixed(1) + ',' + (h - ((v - min) / span) * (h - 4) - 2).toFixed(1);
      })
      .join(' ');
    return (
      '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<polyline points="' + pts + '" fill="none" stroke="#5145e5" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline></svg>'
    );
  }

  /* ---------------------------- 内容词典 ---------------------------- */

  var CONTENT = {};

  function dictUrl() {
    // 数据文件永远在站点根目录，不能拼 BASE（/ja/ 等子目录页会 404）
    return '/data/i18n/topics-' + LANG + '.json';
  }

  function loadDict() {
    if (LANG === 'zh-CN') return Promise.resolve();
    return fetch(dictUrl())
      .then(function (r) {
        return r.ok ? r.json() : {};
      })
      .catch(function () {
        return {};
      })
      .then(function (j) {
        CONTENT = j || {};
      });
  }

  function tx(s) {
    if (!s) return '';
    if (LANG === 'zh-CN') return s;
    return CONTENT[s] || s;
  }

  // 双视图：原文为主、译文可选（body.tr-on 时显示译文），与详情页保持一致
  function dualHtml(s) {
    s = String(s == null ? '' : s);
    if (!s) return '';
    var t = CONTENT[s];
    if (!t || t === s) return esc(s);
    return '<span class="tr-o">' + esc(s) + '</span><span class="tr-t">' + esc(t) + '</span>';
  }

  /* ---------------------------- 收藏 ---------------------------- */

  function saved() {
    try {
      return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }
  function isSaved(slug) {
    return saved().indexOf(slug) >= 0;
  }
  function toggleSave(slug) {
    var arr = saved();
    var i = arr.indexOf(slug);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(slug);
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(arr));
    } catch (e) {}
    return i < 0;
  }

  /* ---------------------------- 状态 ---------------------------- */

  var S = {
    topics: [],
    carrier: 'all',
    q: '',
    span: '',
    sort: 'auto',
    rise: false,
    nobrand: false,
    shown: PAGE,
  };

  var FORM_CLASS = { content: 'f-content', app: 'f-app', saas: 'f-saas', tool: 'f-tool' };

  function pool() {
    var list = S.topics.slice();
    if (S.carrier !== 'all') {
      list = list.filter(function (x) {
        return x.carrier === S.carrier;
      });
    }
    return list;
  }

  function spanVal(x) {
    if (!S.span) return null;
    var v = x.trend && x.trend['m' + S.span];
    return typeof v === 'number' ? v : null;
  }

  function filtered() {
    var list = pool();
    if (S.nobrand)
      list = list.filter(function (x) {
        return x.type !== 'brand';
      });
    if (S.rise)
      list = list.filter(function (x) {
        return (x.g90 || 0) > 0;
      });
    if (S.span) {
      list = list.filter(function (x) {
        var v = spanVal(x);
        return v != null && v > 0;
      });
    }
    if (S.q) {
      var q = S.q.toLowerCase();
      list = list.filter(function (x) {
        return (
          (x.keyword || '').toLowerCase().indexOf(q) >= 0 ||
          tx(x.keyword).toLowerCase().indexOf(q) >= 0 ||
          (x.categories || []).some(function (c) {
            return c.indexOf(q) >= 0;
          })
        );
      });
    }

    var distTo = function (m) {
      if (m == null) return 99;
      var now = new Date().getMonth();
      var d = m - now;
      return d < 0 ? d + 12 : d;
    };

    var sorters = {
      build: function (a, b) {
        return (b.buildScore || 0) - (a.buildScore || 0);
      },
      ads: function (a, b) {
        return (b.adsScore || 0) - (a.adsScore || 0);
      },
      g90: function (a, b) {
        return (b.g90 || -999) - (a.g90 || -999);
      },
      g12: function (a, b) {
        return (b.g12 || -999) - (a.g12 || -999);
      },
      vol: function (a, b) {
        return (b.vol || 0) - (a.vol || 0);
      },
      social: function (a, b) {
        return (b.socialTotal || 0) - (a.socialTotal || 0);
      },
      window: function (a, b) {
        return (a.ageMonths == null ? 999 : a.ageMonths) - (b.ageMonths == null ? 999 : b.ageMonths);
      },
      season: function (a, b) {
        return distTo(a.seasonPrepMonth) - distTo(b.seasonPrepMonth);
      },
    };

    var key = S.sort;
    if (key === 'auto') key = S.carrier === 'web' ? 'build' : S.carrier === 'goods' ? 'score' : 'build';
    if (S.span) {
      list.sort(function (a, b) {
        return (spanVal(b) || -999) - (spanVal(a) || -999);
      });
    } else if (sorters[key]) {
      list.sort(sorters[key]);
    } else {
      list.sort(function (a, b) {
        return (b.buildScore || b.score || 0) - (a.buildScore || a.score || 0);
      });
    }
    return list;
  }

  /* ---------------------------- 渲染 ---------------------------- */

  function card(x, i) {
    var kw = dualHtml(x.keyword);
    var desc = dualDesc(x.descShort, 210);
    var chips = [];
    if (x.carrier === 'web' && (x.digitalKind === 'need' || x.digitalKind === 'company'))
      chips.push('<span class="kind-badge ' + (x.digitalKind === 'need' ? 'k-need' : 'k-comp') + '">' +
        esc(t(x.digitalKind === 'need' ? '可直接做' : '已有玩家')) + '</span>');
    if (x.stageLabel) chips.push('<span class="mchip stag s-' + esc(x.stage) + '">' + esc(t(x.stageLabel)) + '</span>');
    if (x.burstLabel && x.burstWindows)
      chips.push('<span class="mchip bst b-' + esc(x.burst) + '">' + esc(t(x.burstLabel)) + ' ' + x.burstWindows + '/4</span>');
    if (x.windowLabel) chips.push('<span class="mchip win w-' + esc(x.windowKey) + '">' + esc(t(x.windowLabel)) + '</span>');
    if (x.platform) chips.push('<span class="mchip plat">' + esc(x.platform) + '</span>');
    if (x.evergreen) chips.push('<span class="mchip evg">' + esc(t('长青词')) + '</span>');
    var cats = (x.categories || [])
      .slice(0, 3)
      .map(function (c) { return '<span class="cat-tag">' + esc(catText(c)) + '</span>'; })
      .join('');

    var form =
      x.carrier === 'web' && x.formLabel
        ? '<span class="form-badge ' + (FORM_CLASS[x.form] || '') + '">' + esc(t(x.formLabel)) + '</span>'
        : '';
    var score = Math.round(x.carrier === 'web' ? x.buildScore || 0 : x.score || 0);
    var on = isSaved(x.slug);
    var advice = x.carrier === 'web' && x.digitalAdvice ? x.digitalAdvice : x.advice;
    var platAdvice = x.carrier !== 'web' && x.platformAdvice ? x.platformAdvice : '';

    return (
      '<article class="opp" data-slug="' + esc(x.slug) + '">' +
      '<div class="opp-rank">' + (i + 1) + '</div>' +
      '<div class="opp-body">' +
      '<div class="opp-head">' +
      '<a class="opp-kw" href="' + BASE + '/topics/' + esc(x.slug) + '.html">' + kw + '</a>' +
      '<span class="opp-type t-' + esc(x.type) + '">' + esc(t(x.typeLabel || '')) + '</span>' +
      form +
      '<button class="fav' + (on ? ' on' : '') + '" data-slug="' + esc(x.slug) + '" aria-label="' + esc(t('收藏')) + '">' +
      '<svg viewBox="0 0 16 16" fill="none"><path d="M8 2.2 9.9 6l4.2.6-3 3 .7 4.2L8 11.9 4.2 13.8 4.9 9.6l-3-3L6.1 6 8 2.2Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' +
      '</button>' +
      '</div>' +
      (desc ? '<p class="opp-desc">' + desc + '</p>' : '') +
      (cats || chips.length ? '<div class="opp-cats">' + chips.join('') + cats + '</div>' : '') +
      (advice ? '<div class="opp-advice">💡 ' + esc(sysText(advice)) + '</div>' : '') +
      (platAdvice ? '<div class="opp-plat-advice">📣 ' + esc(sysText(platAdvice)) + '</div>' : '') +
      seasonBar(x) +
      '</div>' +
      '<div class="opp-nums">' +
      '<div class="num"><b>' + fmtNum(x.vol) + '</b><span>' + esc(t('月搜索量')) + '</span></div>' +
      '<div class="num"><b class="' + (x.g90 > 0 ? 'up' : 'down') + '">' + pct(x.g90) + '</b><span>' + esc(t('90 天增长')) + '</span></div>' +
      '<div class="num"><b class="' + (x.g12 > 0 ? 'up' : 'down') + '">' + pct(x.g12) + '</b><span>' + esc(t('12 个月增长')) + '</span></div>' +
      (x.socialTotal > 0 ? '<div class="num"><b>' + fmtNum(x.socialTotal) + '</b><span>' + esc(t('社媒提及')) + '</span></div>' : '') +
      '</div>' +
      '<div class="opp-score"><b>' + score + '</b><span>' + esc(t(x.carrier === 'web' ? '建站分' : '选品分')) + '</span>' + spark(x.spark, 96, 34) +
      '<span class="opp-spark-cap">' + esc(t('近 24 个月')) + '</span>' + '</div>' +
      '</article>'
    );
  }

  function render() {
    var list = filtered();
    var box = $('#libList');
    if (!box) return;
    var shown = list.slice(0, S.shown);
    box.innerHTML = shown.length
      ? shown.map(card).join('')
      : '<div class="empty">' + esc(t('没有符合条件的话题，试试放宽筛选')) + '</div>';

    var meta = $('#libMeta');
    if (meta) {
      meta.innerHTML =
        '<span>' + esc(t('符合条件')) + ' <b>' + list.length + '</b> ' + esc(t('个话题')) + '</span>' +
        '<i class="sep">·</i><span class="dim">' +
        (S.span ? esc(t('观察窗口')) + '：' + esc(t('近 ' + S.span + ' 个月')) : esc(t('不限'))) +
        '</span><i class="sep">·</i><span class="dim">' + esc(t('基于 Google Trends 搜索热度')) + '</span>';
    }

    var more = $('#libMore');
    if (more) {
      if (list.length > S.shown) {
        more.hidden = false;
        more.textContent = t('加载中') === 'Loading' ? 'Load more' : '加载更多';
      } else more.hidden = true;
    }
  }

  /* ---------------------------- 事件 ---------------------------- */

  function bind() {
    $$('#carrierPick .carrier').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('#carrierPick .carrier').forEach(function (x) {
          x.classList.toggle('active', x === b);
        });
        S.carrier = b.dataset.carrier;
        S.shown = PAGE;
        render();
      });
    });

    var q = $('#libSearch');
    if (q)
      q.addEventListener('input', function (e) {
        S.q = e.target.value.trim();
        S.shown = PAGE;
        render();
      });

    var sp = $('#libSpan');
    if (sp)
      sp.addEventListener('change', function (e) {
        S.span = e.target.value;
        S.shown = PAGE;
        render();
      });

    var so = $('#libSort');
    if (so)
      so.addEventListener('change', function (e) {
        S.sort = e.target.value;
        render();
      });

    var ri = $('#libRise');
    if (ri)
      ri.addEventListener('change', function (e) {
        S.rise = e.target.checked;
        render();
      });

    var nb = $('#libNoBrand');
    if (nb)
      nb.addEventListener('change', function (e) {
        S.nobrand = e.target.checked;
        render();
      });

    var more = $('#libMore');
    if (more)
      more.addEventListener('click', function () {
        S.shown += PAGE;
        render();
      });

    document.addEventListener('click', function (e) {
      var fav = e.target.closest && e.target.closest('.fav');
      if (fav) {
        e.preventDefault();
        var on = toggleSave(fav.dataset.slug);
        fav.classList.toggle('on', on);
        return;
      }
      var btn = e.target.closest && e.target.closest('.lang-btn');
      var menu = $('.lang-switch');
      if (menu) menu.classList.toggle('open', !!btn && !menu.classList.contains('open'));
    });

    // 内容「原文 / 译文」切换（机会库 / 详情页 / 索引 / 品类）
    var tt = $('#trToggle');
    if (tt) {
      var applyTr = function (on) {
        document.body.classList.toggle('tr-on', !!on);
        $$('#trToggle .seg').forEach(function (x) {
          x.classList.toggle('on', (x.dataset.mode === 'tr') === !!on);
        });
      };
      $$('#trToggle .seg').forEach(function (b) {
        b.addEventListener('click', function () {
          var on = b.dataset.mode === 'tr';
          applyTr(on);
          try { localStorage.setItem('gt_tr', on ? '1' : '0'); } catch (e) {}
        });
      });
      var trOn = false;
      try { trOn = localStorage.getItem('gt_tr') === '1'; } catch (e) {}
      applyTr(trOn);
    }

    // 热榜「译文 / 原文」切换
    var dt = $('#dailyTrToggle');
    if (dt) {
      var lists = $$('ul.daily-list');
      var applyMode = function (mode) {
        $$('#dailyTrToggle .seg').forEach(function (x) {
          x.classList.toggle('on', x.dataset.mode === mode);
        });
        lists.forEach(function (ul) {
          ul.classList.toggle('show-tr', mode === 'tr');
        });
      };
      $$('#dailyTrToggle .seg').forEach(function (b) {
        b.addEventListener('click', function () {
          applyMode(b.dataset.mode);
          try { localStorage.setItem('gt_daily_tr', b.dataset.mode); } catch (e) {}
        });
      });
      var savedMode = null;
      try { savedMode = localStorage.getItem('gt_daily_tr'); } catch (e) {}
      applyMode(savedMode === 'tr' ? 'tr' : 'orig');
    }

    // 热榜地区切换 Tab（多地区时出现）
    var gt = $('#dailyGeoTabs');
    if (gt) {
      var secs = $$('.daily-block[data-geo]');
      var applyGeo = function (geo) {
        $$('#dailyGeoTabs .seg').forEach(function (x) {
          x.classList.toggle('on', x.dataset.geo === geo);
        });
        secs.forEach(function (s) {
          s.style.display = s.dataset.geo === geo ? '' : 'none';
        });
      };
      $$('#dailyGeoTabs .seg').forEach(function (b) {
        b.addEventListener('click', function () {
          applyGeo(b.dataset.geo);
          try { localStorage.setItem('gt_daily_geo', b.dataset.geo); } catch (e) {}
        });
      });
      var savedGeo = null;
      try { savedGeo = localStorage.getItem('gt_daily_geo'); } catch (e) {}
      var hasSaved = savedGeo && secs.some(function (s) { return s.dataset.geo === savedGeo; });
      applyGeo(hasSaved ? savedGeo : (secs[0] && secs[0].dataset.geo));
    }

    // URL 词语直达：/?q=xxx
    var m = location.search.match(/[?&]q=([^&]+)/);
    if (m && q) {
      S.q = decodeURIComponent(m[1].replace(/\+/g, ' '));
      q.value = S.q;
    }
  }

  /* ---------------------------- 启动 ---------------------------- */

  function renderSaved() {
    var box = $('#savedList');
    if (!box) return;
    var arr = saved();
    var items = S.topics.filter(function (x) { return arr.indexOf(x.slug) >= 0; });
    box.innerHTML = items.length
      ? items.map(function (x, i) { return card(x, i); }).join('')
      : '<div class="empty">' + esc(t('没有符合条件的话题，试试放宽筛选')) + '</div>';

    var ex = $('#btnSavedExport');
    var cl = $('#btnSavedClear');
    if (ex)
      ex.onclick = function () {
        var rows = [['keyword', 'volume', 'g90', 'g12', 'carrier', 'slug']];
        items.forEach(function (x) {
          rows.push([x.keyword, x.vol, x.g90, x.g12, x.carrier, x.slug]);
        });
        var csv = rows.map(function (r) { return r.join(','); }).join('\n');
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
        a.download = 'trendsift-saved.csv';
        a.click();
      };
    if (cl)
      cl.onclick = function () {
        if (!confirm(t('清空清单') + '?')) return;
        try { localStorage.setItem(SAVED_KEY, '[]'); } catch (e) {}
        renderSaved();
      };
  }

  function start() {
    bind(); // 语言菜单、收藏等点击事件必须先绑上（热榜/关于等页没有列表也要绑）
    if (!$('#libList') && !$('#savedList')) return;
    Promise.all([
      fetch('/data/site.json')
        .then(function (r) {
          return r.json();
        })
        .catch(function () {
          return { topics: [] };
        }),
      loadDict(),
    ]).then(function (res) {
      S.topics = (res[0] && res[0].topics) || [];
      if (!S.topics.length) return;
      if ($('#savedList')) renderSaved();
      else render();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
