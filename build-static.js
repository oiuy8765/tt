'use strict';

/**
 * 构建静态站点（用于发布到 Cloudflare Pages）
 *
 * 产出 dist/ 目录：
 *   index.html / app.js / styles.css   —— 前端（自动探测：没有本地服务就读 ./data/*.json）
 *   data/site.json                     —— 机会雷达全量数据（先跑 _rebuild.js 或 _enrich_all.js 生成）
 *   data/daily.json                    —— 每日热榜快照（需要本地服务在跑，失败则跳过）
 *   robots.txt / sitemap.xml
 *
 * 用法：node build-static.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const PROJECT = process.env.DEPLOY_PROJECT || 'trends-radar';
const SITE_URL = process.env.DEPLOY_URL || 'https://trendsift.site';

function copy(src, dest) {
  fs.copyFileSync(src, dest);
  console.log('  复制 ' + path.basename(src));
}

/**
 * 发布前清洗：公开文件里不留上游数据服务商的名字与链接。
 * 数据本身（热度、曲线、分类、社媒量）原样保留，只去掉出处标记字段。
 */
function stripTopic(t) {
  if (!t || typeof t !== 'object') return t;
  const { url, source, ...keep } = t;
  return keep;
}

function isDailySpam(it) {
  const q = String(it.query || '').trim();
  const arts = (it.articles || []).map((a) => ({
    source: String(a.source || ''),
    title: String(a.title || ''),
  }));
  // 聚合器产生的 Bluesky 模板刷屏：query 形如 "#btc trending on Bluesky"
  if (/#\s*trending on bluesky/i.test(q)) return true;
  if (q.startsWith('#') && arts.some((a) => a.source === 'Bluesky')) return true;
  // 整条只有 Bluesky 模板文（"The hashtag #x is gaining momentum on Bluesky…"）
  if (
    arts.length &&
    arts.every((a) => a.source === 'Bluesky' && /gaining momentum on bluesky/i.test(a.title))
  ) {
    return true;
  }
  return false;
}

function scrubDaily(d) {
  const out = JSON.parse(JSON.stringify(d));
  delete out.note;
  delete out.proxy;
  delete out.error;
  const blocks = out.data || {};
  for (const g of Object.keys(blocks)) {
    const b = blocks[g];
    if (!b || typeof b !== 'object') continue;
    delete b.source;
    delete b.sourceName;
    if (Array.isArray(b.items)) {
      b.items = b.items.filter((it) => !isDailySpam(it));
    }
    for (const it of b.items || []) {
      delete it.exploreLink;
      delete it.aggregator;
    }
  }
  return out;
}

function fetchLocal(apiPath) {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:8787' + apiPath, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(b));
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(90000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

(async () => {
  console.log('[1/5] 准备目录…');
  // 先清掉上次构建因占用删不掉而改名的 .dist-trash-* 垃圾目录
  try {
    for (const f of fs.readdirSync(ROOT)) {
      if (f.startsWith('.dist-trash-')) {
        try {
          fs.rmSync(path.join(ROOT, f), { recursive: true, force: true });
          console.log('  已清理垃圾目录 ' + f);
        } catch (e) {
          /* 仍被占用就留着，下次再清 */
        }
      }
    }
  } catch (e) {}
  if (fs.existsSync(DIST)) {
    try {
      fs.rmSync(DIST, { recursive: true, force: true });
    } catch (e) {
      // 某些环境对大批量删除有保护：改成改名腾位置，旧目录留在项目根下待清理
      const bak = path.join(ROOT, '.dist-trash-' + Date.now());
      try {
        fs.renameSync(DIST, bak);
        console.log('  旧目录已改名：' + path.basename(bak) + '（可手动删除）');
      } catch (e2) {
        console.log('  无法清理旧目录：' + e2.message);
      }
    }
  }
  fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });

  console.log('[2/5] 复制前端…');
  const FILES = ['index.html', 'about.html', 'privacy.html', 'contact.html', 'app.js', 'lang.js', 'compare.js', 'styles.css', 'source.txt', 'logo.svg', 'favicon.svg'];
  for (const f of FILES) {
    const src = path.join(ROOT, 'public', f);
    if (!fs.existsSync(src)) {
      console.log('  跳过（不存在）' + f);
      continue;
    }
    copy(src, path.join(DIST, f));
  }

  console.log('[3/5] 生成数据…');
  // 直接用 radar.js 重算：enrich 缓存都在本地（data/radar-enrich.json），不用重新抓
  const R = require(path.join(ROOT, 'radar.js'));
  // CI 环境设 GT_FORCE_RADAR=1：每次构建都重新抓 explodingtopics 榜单，
  // 否则上次构建回写的新鲜缓存（6 小时内）会让榜单永远不刷新
  const FORCE_RADAR = process.env.GT_FORCE_RADAR === '1';
  let full = await R.getRadar({ force: FORCE_RADAR });
  // 旧缓存里没有「时间窗口 / 完整历史」字段时，强制重抓一次榜单（两者都只在列表接口里）
  if (full.topics && full.topics.length && (!full.topics[0].trend || !full.topics[0].hist)) {
    console.log('  缓存缺少时间窗口或完整历史字段，重新抓取榜单…');
    full = await R.getRadar({ force: true });
  }
  if (!full.topics || !full.topics.length) {
    console.error('榜单数据为空，无法构建');
    process.exit(1);
  }

  // 榜单里可能混进新话题，详情（分类/简介）还没补过：构建阶段补齐，别把空卡片发上线
  const missing = full.topics.filter((t) => !t.enriched && t.slug).map((t) => t.slug);
  if (missing.length) {
    console.log('  补全新话题详情：' + missing.length + ' 条');
    try {
      await R.enrichSlugs(missing, { concurrency: 8 });
      full = await R.getRadar({ force: false });
    } catch (e) {
      console.log('  详情补全失败：' + e.message + '（这些词会缺简介与分类）');
    }
  }

  const noTrend = full.topics.filter((t) => !t.trend).length;
  if (noTrend) console.log('  注意：' + noTrend + ' 条缺少时间窗口数据（历史太短或缓存过旧）');

  // 简介 overrides：数据源没抓到描述的话题，用人工撰写的介绍补上
  try {
    const overrides = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'desc-overrides.json'), 'utf8'));
    let filled = 0;
    for (const t of full.topics) {
      const o = overrides[t.slug];
      if (o && (!t.descShort || !String(t.descShort).trim())) {
        t.desc = o;
        t.descShort = String(o).trim();
        filled++;
      }
    }
    if (filled) console.log('  简介补齐：' + filled + ' 条（人工覆盖表）');
  } catch (e) {
    /* 没有 overrides 文件就跳过 */
  }

  // 相似词：类目 IDF + 曲线节奏 + 形态，构建时一次算完，页面直接读
  try {
    require(path.join(ROOT, 'similar.js')).buildSimilar(full.topics);
    const withSim = full.topics.filter((t) => t.similar && t.similar.length).length;
    console.log('  相似词：' + withSim + ' 条话题有推荐');
  } catch (e) {
    console.log('  相似词计算失败：' + e.message);
  }

  const site = { at: full.at, total: full.total, counts: full.counts, topics: full.topics };
  // 落盘一份完整数据，供直接构建时复用与排查
  fs.writeFileSync(path.join(ROOT, 'data', 'site-data.json'), JSON.stringify(site), 'utf8');
  // 首页只需要 24 点 spark，52 万条历史点没必要塞进首屏加载的 site.json。
  // 完整序列单独出 hist.json，只有「对比」页会按需拉。
  const histMap = {};
  for (const t of site.topics || []) if (t.hist && t.slug) histMap[t.slug] = t.hist;
  fs.writeFileSync(path.join(DIST, 'data', 'hist.json'), JSON.stringify(histMap), 'utf8');

  const leanTopics = (site.topics || []).map((t) => {
    const c = stripTopic(t);
    delete c.hist;
    delete c.similar;
    return c;
  });
  fs.writeFileSync(
    path.join(DIST, 'data', 'site.json'),
    JSON.stringify({ at: site.at, total: site.total, counts: site.counts, topics: leanTopics }),
    'utf8'
  );
  console.log(
    '  site.json：' + site.topics.length + ' 条话题；hist.json：' + Object.keys(histMap).length + ' 条完整历史'
  );

  // 每日热榜快照（本地服务在跑就抓最新的；否则复用上次构建留下的快照）
  const dailyBackup = path.join(ROOT, 'data', 'daily.json');
  // 12 个主要市场地区（Google 热榜 RSS 每地区每天固定 10 条）
  const DAILY_GEOS = 'US,GB,CA,AU,IN,DE,FR,JP,KR,BR,MX,ID';
  let daily = await fetchLocal('/api/daily?geos=' + encodeURIComponent(DAILY_GEOS));
  if (!daily || !daily.ok) {
    try {
      daily = JSON.parse(fs.readFileSync(dailyBackup, 'utf8'));
      console.log('  本地服务不可用，复用上次的热榜快照');
    } catch (e) {
      daily = null;
    }
  }
  if (daily && daily.ok) {
    // ── 地区数据持久化：Google 模式下每个地区的数据块存入 data/daily-best.json。
    //    之后某次构建时 Google 接口不可达（只剩 GLOBAL 聚合源），
    //    上次抓到的地区数据仍会合并进来渲染（带「数据截至」日期标注）。
    const bestPath = path.join(ROOT, 'data', 'daily-best.json');
    let best = { geos: {} };
    try { best = JSON.parse(fs.readFileSync(bestPath, 'utf8')); } catch (e) {}
    best.geos = best.geos || {};
    const today = new Date().toISOString().slice(0, 10);
    const blocks = daily.data || {};
    for (const g of Object.keys(blocks)) {
      const b = blocks[g];
      if (!b || !Array.isArray(b.items) || !b.items.length) continue;
      const src = String(b.source || 'google');
      if (g === 'GLOBAL' || src === 'demo' || src === 'hottrends') continue; // 聚合/演示数据不入库
      best.geos[g] = {
        geo: g,
        source: b.source || 'google',
        sourceName: b.sourceName || '',
        items: b.items,
        savedAt: today,
      };
    }
    let merged = 0;
    for (const g of Object.keys(best.geos)) {
      const cur = blocks[g];
      if (!cur || !Array.isArray(cur.items) || !cur.items.length) {
        blocks[g] = Object.assign({}, best.geos[g], { stale: true });
        merged++;
      }
    }
    try {
      fs.writeFileSync(bestPath, JSON.stringify(best), 'utf8');
    } catch (e) {}
    if (merged) console.log('  daily.json：Google 暂不可达，合并 ' + merged + ' 个历史地区数据（标注数据日期）');
    fs.writeFileSync(path.join(DIST, 'data', 'daily.json'), JSON.stringify(scrubDaily(daily)), 'utf8');
    fs.writeFileSync(dailyBackup, JSON.stringify(daily), 'utf8');
    console.log(
      '  daily.json：快照 OK（' + daily.mode + ' 模式，地区：' + Object.keys(blocks).join('/') + '）'
    );
    if (daily.mode === 'aggregator' && daily.error) {
      console.log('  Google 直连失败原因：' + daily.error);
    }
  } else {
    console.log('  daily.json：无可用数据，跳过（今日热榜会显示空）');
  }

  console.log('[4/5] 生成中文词典…');
  const ZH = require(path.join(ROOT, 'build-zh.js'));
  const dailyObj = daily && daily.ok ? daily : null;
  let zhR = { map: {}, hit: 0, added: 0, failed: 0 };
  try {
    zhR = await ZH.buildDict(site.topics, dailyObj, {
      onProgress: (d, t) => {
        if (d === t || d % 200 === 0) console.log('  翻译 ' + d + '/' + t);
      },
    });
  } catch (e) {
    console.log('  翻译失败：' + e.message + '（线上点「中文」将不可用）');
  }
  fs.writeFileSync(path.join(DIST, 'data', 'zh.json'), JSON.stringify(zhR.map), 'utf8');
  const zhKeys = Object.keys(zhR.map).length;
  // 品牌词翻译后等于原文，会被排除，不该算作未覆盖
  const needKw = site.topics.filter((t) => t.keyword && t.type !== 'brand').length;
  const needDesc = site.topics.filter((t) => t.descShort).length;
  console.log(
    '  zh.json：' + zhKeys + ' 条（命中缓存 ' + zhR.hit + '，新增 ' + zhR.added + '，未译 ' + zhR.failed + '）' +
      ' | 非品牌内容覆盖率 ' + Math.round((zhKeys / Math.max(1, needKw + needDesc)) * 100) + '%'
  );

  console.log('[5/5] 写 SEO 文件…');
  const buildAt = new Date(site.at || Date.now());
  const lastmod = buildAt.toISOString().slice(0, 10);

  fs.writeFileSync(
    path.join(DIST, 'robots.txt'),
    'User-agent: *\nAllow: /\n\nSitemap: ' + SITE_URL + '/sitemap.xml\n',
    'utf8'
  );

  fs.writeFileSync(
    path.join(DIST, 'sitemap.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      '  <url><loc>' + SITE_URL + '/</loc><lastmod>' + lastmod + '</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>\n' +
      '  <url><loc>' + SITE_URL + '/about.html</loc><lastmod>' + lastmod + '</lastmod><changefreq>monthly</changefreq><priority>0.5</priority></url>\n' +
      '  <url><loc>' + SITE_URL + '/contact.html</loc><lastmod>' + lastmod + '</lastmod><changefreq>monthly</changefreq><priority>0.5</priority></url>\n' +
      '  <url><loc>' + SITE_URL + '/privacy.html</loc><lastmod>' + lastmod + '</lastmod><changefreq>yearly</changefreq><priority>0.3</priority></url>\n' +
      '</urlset>\n',
    'utf8'
  );

  // 构建信息注入页脚（前端读取 __BUILD__ 做缓存破坏）
  let html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  html = html.replace(
    '</body>',
    '<script>window.__BUILD__="' + buildAt.getTime() + '";window.__BUILD_AT__="' + buildAt.toISOString() + '";</script>\n</body>'
  );
  fs.writeFileSync(path.join(DIST, 'index.html'), html, 'utf8');

  console.log('[6/6] 生成多语言页面…');
  try {
    await require(path.join(ROOT, 'build-multi.js')).main();
  } catch (e) {
    console.log('  多语言页面生成失败：' + e.message);
  }

  const size = (f) => Math.round(fs.statSync(path.join(DIST, f)).size / 1024) + ' KB';
  console.log('\n构建完成 → dist/');
  console.log('  index.html ' + size('index.html'));
  console.log('  app.js     ' + size('app.js'));
  console.log('  site.json  ' + size('data/site.json') + '（Cloudflare 会 gzip，实际传输约 1/5）');
  console.log('  数据时间   ' + buildAt.toLocaleString('zh-CN'));
})().catch((e) => {
  console.error('构建失败：', e.message);
  process.exit(1);
});
