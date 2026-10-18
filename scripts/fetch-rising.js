'use strict';
/**
 * 增量抓取话题词的「飙升相关查询」（Google Trends 官方口径）。
 *
 * 在 CI（deploy.yml）里、构建之前运行：
 *   node scripts/fetch-rising.js --limit 100 --budget 12
 *
 * - 按搜索量排序全量轮换：每天抓 limit 个词，871 话题约 9 天轮完一遍，
 *   之后每天刷新最热的一批
 * - 结果写 data/rising-cache.json，构建时 topicPage 直接读，
 *   「Commit refreshed caches」步骤会把它提交回仓库
 * - 无 npm 依赖；先访问 Trends 页面预热 Cookie（绕 429），单词失败跳过
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CACHE_FILE = path.join(ROOT, 'data', 'rising-cache.json');
const CURSOR_FILE = path.join(ROOT, 'data', 'rising-cursor.json');

const args = process.argv.slice(2);
function argOf(name, dft) {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) || dft : dft;
}
const LIMIT = argOf('--limit', 100);
const BUDGET_MIN = argOf('--budget', 12);

const cookieJar = {};

function request(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = Object.assign(
      {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      extraHeaders || {}
    );
    if (Object.keys(cookieJar).length) {
      headers.Cookie = Object.entries(cookieJar)
        .map(([k, v]) => k + '=' + v)
        .join('; ');
    }
    const req = https.get(
      { hostname: u.hostname, path: u.pathname + u.search, headers },
      (r) => {
        (r.headers['set-cookie'] || []).forEach((c) => {
          const m = c.match(/^([^=]+)=([^;]*)/);
          if (m) cookieJar[m[1]] = m[2];
        });
        let b = '';
        r.on('data', (d) => (b += d));
        r.on('end', () => resolve({ status: r.statusCode, body: b }));
      }
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function trendsJson(p) {
  for (let i = 0; i < 2; i++) {
    const r = await request('https://trends.google.com' + p, {
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://trends.google.com/trends/explore',
    });
    if (r.status === 200) {
      return JSON.parse(r.body.replace(/^\)\]\}'[,\n]?\s*/, ''));
    }
    if (i < 1) await sleep(r.status === 429 ? 10000 : 5000);
  }
  const e = new Error('HTTP 429/failed after retries');
  e.status = 429;
  throw e;
}

async function fetchRising(keyword, geo) {
  const reqObj = {
    comparisonItem: [{ keyword: keyword, geo: geo, time: 'today 12-m', category: 0 }],
    category: 0,
    property: '',
  };
  const w = await trendsJson(
    '/trends/api/explore?hl=en-US&tz=480&req=' + encodeURIComponent(JSON.stringify(reqObj))
  );
  const rel = ((w.widgets || []).find((x) => x.id === 'RELATED_QUERIES') || {});
  if (!rel.token) return [];
  const rj = await trendsJson(
    '/trends/api/widgetdata/relatedsearches?hl=en-US&tz=480' +
      '&req=' + encodeURIComponent(JSON.stringify(rel.request)) +
      '&token=' + encodeURIComponent(rel.token)
  );
  const groups = (rj && rj.default && rj.default.rankedList) || [];
  const metrics = (rel.request && rel.request.metric) || ['TOP', 'RISING'];
  let rising = [];
  groups.forEach((group, i) => {
    const metric = metrics[i] || (i === 0 ? 'TOP' : 'RISING');
    if (metric !== 'RISING') return;
    rising = ((group && group.rankedKeyword) || [])
      .filter((r) => r && r.query)
      .slice(0, 12)
      .map((r) => ({
        query: r.query,
        formattedValue: r.formattedValue || (typeof r.value === 'number' ? '+' + r.value + '%' : ''),
        link: r.link ? 'https://trends.google.com' + r.link : '',
      }));
  });
  return rising;
}

/** SerpApi 兜底：Google 直连被 429 时，用第三方（1 次请求 = 1 credit）
 *  https://serpapi.com — 免费 250 次/月，付费 $25/1000 次 */
let serpApiUsed = 0;
const SERPAPI_CAP = 25; // 单次运行最多消耗的 credit（保护免费额度）

async function serpApiRising(keyword, geo) {
  const key = process.env.SERPAPI_KEY;
  if (!key || serpApiUsed >= SERPAPI_CAP) return null;
  const u =
    'https://serpapi.com/search?engine=google_trends&data_type=RELATED_QUERIES' +
    '&q=' + encodeURIComponent(keyword) +
    '&geo=' + encodeURIComponent(geo) +
    '&date=' + encodeURIComponent('today 12-m') +
    '&api_key=' + encodeURIComponent(key);
  const r = await new Promise((resolve, reject) => {
    const req = https.get(u, { headers: { 'User-Agent': UA } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.setTimeout(25000, () => req.destroy(new Error('timeout')));
  });
  if (r.status !== 200) throw new Error('serpapi HTTP ' + r.status);
  serpApiUsed += 1;
  const j = JSON.parse(r.body);
  if (j.error) throw new Error('serpapi: ' + String(j.error).slice(0, 80));
  const rq = j.related_queries || {};
  return (rq.rising || []).slice(0, 12).map((x) => ({
    query: x.query,
    formattedValue: x.formatted_value || (x.extracted_value != null ? '+' + x.extracted_value + '%' : ''),
    link: x.link ? (String(x.link).startsWith('http') ? x.link : 'https://trends.google.com' + x.link) : '',
  }));
}

async function main() {
  const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'site-data.json'), 'utf8'));
  const topics = (site.topics || [])
    .filter((t) => t.keyword)
    .sort((a, b) => (b.vol || 0) - (a.vol || 0));

  let cache = { updatedAt: 0, items: {} };
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!cache.items) cache.items = {};
  } catch (e) {
    /* 首次运行 */
  }
  let cursor = 0;
  try {
    cursor = JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')).offset || 0;
  } catch (e) {
    /* 首次运行 */
  }

  // 预热：建立 Cookie 会话
  await request('https://trends.google.com/trends/explore?geo=US', { 'Upgrade-Insecure-Requests': '1' }).catch(
    () => {}
  );

  const started = Date.now();
  const budgetMs = BUDGET_MIN * 60 * 1000;
  let done = 0;
  let failed = 0;
  let consecutive429 = 0;
  const picked = [];

  for (let i = 0; i < LIMIT && done < LIMIT; i++) {
    if (Date.now() - started > budgetMs) {
      console.log('时间预算用完，提前收工');
      break;
    }
    // 连续被限流说明当前出口 IP 已被 Google 拉黑：快速放弃，明天换新 IP 再来
    if (consecutive429 >= 20) {
      console.log('连续 20 次限流，当前 IP 已被封，本次放弃（数据明天继续累积）');
      break;
    }
    if (consecutive429 >= 8 && consecutive429 % 4 === 0) {
      console.log('连续限流，冷却 90 秒再试…');
      await sleep(90000);
    }
    const tp = topics[(cursor + i) % topics.length];
    if (!tp) break;
    picked.push(tp.keyword);
    try {
      let rising;
      try {
        rising = await fetchRising(tp.keyword, tp.reg || 'US');
      } catch (e) {
        // Google 直连被限流 → SerpApi 兜底（有 key 且没超预算时）
        const viaSerp = await serpApiRising(tp.keyword, tp.reg || 'US').catch(() => null);
        if (viaSerp == null) throw e;
        rising = viaSerp;
        console.log('     （经 SerpApi 兜底，已用 ' + serpApiUsed + '/' + SERPAPI_CAP + '）');
      }
      cache.items[tp.keyword] = { rising: rising, fetchedAt: Date.now() };
      done += 1;
      consecutive429 = 0;
      console.log('[' + (done + '').padStart(3) + '] ' + tp.keyword + ' → ' + rising.length + ' 条飙升词');
    } catch (e) {
      failed += 1;
      if (e.status === 429) consecutive429 += 1;
      console.log('[skip] ' + tp.keyword + ' → ' + e.message);
    }
    await sleep(8000);
  }

  cursor = (cursor + done + failed) % Math.max(1, topics.length);
  cache.updatedAt = Date.now();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
  fs.writeFileSync(CURSOR_FILE, JSON.stringify({ offset: cursor }), 'utf8');
  console.log(
    '完成：新增 ' + done + ' 词（失败 ' + failed + '），缓存累计 ' + Object.keys(cache.items).length + ' / ' + topics.length + ' 词，游标 ' + cursor
  );
}

main().catch((e) => {
  console.error('fatal:', e.message);
  // 失败不阻塞构建：旧缓存仍在，页面按「无数据」渲染
  process.exit(0);
});
