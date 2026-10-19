#!/usr/bin/env node
/* IndexNow 推送：把站点 URL 主动推给 Bing / Yandex / Seznam 等（Google 不支持该协议）。
 *
 * 用法：node scripts/indexnow.js
 * 在 CI 的「部署完成后」执行（见 .github/workflows/deploy.yml）。
 *
 * 策略（避免每次构建全量骚扰）：
 *   - 常驻页每次都推：各语言首页、/daily/ 归档索引、当天归档页、一级分类页
 *     —— 这类页面数量少（~90 个）但内容每天变；
 *   - 话题页只推一次：记录在 data/indexnow-seen.json（随 CI 的缓存提交持久化），
 *     只有新词上线才会增量推送。首次运行只推热度最高的 800 条，其余随构建逐步补齐。
 *
 * 协议：https://www.indexnow.org/documentation
 * 密钥文件由 build-static 生成：https://trendsift.site/<key>.txt
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITE = 'https://trendsift.site';
const PREFIXES = ['', '/en', '/ja', '/ko', '/zh-tw'];
const TOPICS_FIRST_RUN_CAP = 800;

function baseUrl(p) {
  return SITE + p; // p 为 '' 时即首页
}

async function main() {
  const keyPath = path.join(ROOT, 'data', 'indexnow-key.txt');
  if (!fs.existsSync(keyPath)) return console.log('indexnow: 无密钥文件，跳过');
  const key = fs.readFileSync(keyPath, 'utf8').trim();
  if (!/^[0-9a-f]{8,64}$/.test(key)) return console.log('indexnow: 密钥格式不对，跳过');

  const sitePath = path.join(ROOT, 'dist', 'data', 'site.json');
  if (!fs.existsSync(sitePath)) return console.log('indexnow: 找不到 dist/data/site.json，跳过');
  const site = JSON.parse(fs.readFileSync(sitePath, 'utf8'));

  // —— 常驻页：数量少、变化频繁，每次构建都推 ——
  const always = [];
  for (const p of PREFIXES) {
    always.push(baseUrl(p) + '/');
    always.push(baseUrl(p) + '/daily/');
    // 当天归档页（北京时间日期，与 build-static 快照一致）
    const bj = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    always.push(baseUrl(p) + '/daily/' + bj);
  }
  const pcats = new Set(site.topics.map((t) => t.primaryCat || 'other'));
  for (const p of PREFIXES) {
    for (const c of pcats) always.push(baseUrl(p) + '/categories/' + c);
  }

  // —— 话题页：只推一次 ——
  const seenPath = path.join(ROOT, 'data', 'indexnow-seen.json');
  let seen = new Set();
  try {
    seen = new Set(JSON.parse(fs.readFileSync(seenPath, 'utf8')));
  } catch (e) {}

  const isFirstRun = seen.size === 0;
  let newTopics = site.topics
    .filter((t) => t.slug && !seen.has(t.slug))
    .sort((a, b) => (b.vol || 0) - (a.vol || 0));
  if (isFirstRun) newTopics = newTopics.slice(0, TOPICS_FIRST_RUN_CAP);

  const topicUrls = [];
  for (const t of newTopics) {
    for (const p of PREFIXES) topicUrls.push(baseUrl(p) + '/topics/' + t.slug);
  }

  const urlList = [...always, ...topicUrls];
  if (!urlList.length) return console.log('indexnow: 没有新 URL，跳过');

  const body = JSON.stringify({
    host: 'trendsift.site',
    key,
    keyLocation: SITE + '/' + key + '.txt',
    urlList,
  });

  // api.indexnow.org 是聚合端点，会分发给所有支持 IndexNow 的搜索引擎
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body,
    signal: AbortSignal.timeout(30000),
  });
  console.log('indexnow: POST ' + urlList.length + ' URLs → HTTP ' + res.status);
  if (!res.ok) {
    console.log('indexnow: 推送未成功（200=已受理，400/403=密钥或参数问题，429=限频）');
    return; // 不标记 seen，下次构建重试
  }

  // 推送成功后才记录，失败下次重试
  for (const t of newTopics) seen.add(t.slug);
  fs.writeFileSync(seenPath, JSON.stringify([...seen]), 'utf8');
  console.log('indexnow: 已推送 常驻页 ' + always.length + ' + 新话题 ' + newTopics.length + '（累计标记 ' + seen.size + '）');
}

main().catch((e) => {
  console.log('indexnow: 失败 ' + (e && e.message));
  process.exitCode = 0; // 不阻塞部署流水线
});
