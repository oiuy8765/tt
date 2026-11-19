#!/usr/bin/env node
/**
 * R2 数据同步：让"会变的数据"脱离代码仓库。
 *
 *   node scripts/r2-sync.js push   # 把本地 data/ 下的数据文件上传到 R2
 *   node scripts/r2-sync.js pull   # 从 R2 拉取数据文件到 data/（CI 构建前调用）
 *
 * 环境变量：
 *   CLOUDFLARE_ACCOUNT_ID   CF 账户 ID
 *   CLOUDFLARE_API_TOKEN    需含 R2 编辑权限的 token
 *   R2_BUCKET               bucket 名（默认 trendsift-data）
 *
 * 设计：
 * - 只同步"会变的数据"（JSON 数据 / 缓存 / 词典），不含代码。
 * - 逐个对象上传，失败不中断其它文件，最后汇总。
 * - 带简单重试，抗网络抖动。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'data');
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const BUCKET = process.env.R2_BUCKET || 'trendsift-data';
const MODE = process.argv[2] || 'push';

// 会变的数据：CI 每次构建产出/更新，需要跨构建复用的文件。
// 代码型文件（build-*.js、public/、.github/）不在这里，仍需 git 管理。
const FILES = [
  'site-data.json', 'radar.json', 'radar-enrich.json', 'zh-dict.json',
  'snapshot.json', 'daily.json', 'daily-best.json', 'signals.json',
  'topics-seen.json', 'translate-cache.json', 'indexnow-seen.json',
  'desc-overrides.json', 'rising-cache.json', 'rising-cursor.json',
  'site.json', 'sitemap-cache.json',
  'i18n/ui.json', 'i18n/advice.json', 'i18n/legal.json',
  'i18n/ai-market.json', 'i18n/topics-en.json', 'i18n/topics-ja.json',
  'i18n/topics-ko.json', 'i18n/topics-zh-TW.json',
  'i18n/cache-zh-en.json', 'i18n/cache-zh-ja.json', 'i18n/cache-zh-ko.json',
  'i18n/cache-zh-zh-TW.json', 'i18n/cache-en-ja.json', 'i18n/cache-en-ko.json',
  'i18n/cache-en-zh-TW.json', 'i18n/cache-en-zh.json',
];

if (!ACCOUNT || !TOKEN) {
  console.error('缺少 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN 环境变量');
  process.exit(2);
}

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects`;
const headers = { Authorization: `Bearer ${TOKEN}` };

// 前置探测：bucket 未开通或 token 无 R2 权限时，整体优雅跳过（不阻断 CI）。
async function r2Available() {
  try {
    const res = await fetch(`${BASE}/__probe__`, { headers });
    // 200=存在, 404=对象不存在但 bucket 可用; 其它(10042 未开通/403 无权限)视为不可用
    return res.status === 200 || res.status === 404;
  } catch { return false; }
}

async function withRetry(fn, label, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) {
      if (i === tries) throw e;
      console.log(`  ${label} 第 ${i} 次失败：${e.message}，重试…`);
      await new Promise(r => setTimeout(r, 1000 * i));
    }
  }
}

async function push() {
  let ok = 0, skip = 0, fail = 0;
  for (const rel of FILES) {
    const fp = path.join(DIR, rel);
    if (!fs.existsSync(fp)) { skip++; continue; }
    const body = fs.readFileSync(fp);
    try {
      await withRetry(async () => {
        const res = await fetch(`${BASE}/${encodeURIComponent(rel)}`, {
          method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
      }, rel);
      ok++;
    } catch (e) { console.error(`  上传失败 ${rel}: ${e.message}`); fail++; }
  }
  console.log(`push 完成：成功 ${ok}，跳过 ${skip}，失败 ${fail}`);
  if (fail) process.exitCode = 1;
}

async function pull() {
  let ok = 0, skip = 0, fail = 0;
  for (const rel of FILES) {
    try {
      const buf = await withRetry(async () => {
        const res = await fetch(`${BASE}/${encodeURIComponent(rel)}`, { headers });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      }, rel);
      if (!buf) { skip++; continue; }
      const fp = path.join(DIR, rel);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, buf);
      ok++;
    } catch (e) { console.error(`  拉取失败 ${rel}: ${e.message}`); fail++; }
  }
  console.log(`pull 完成：成功 ${ok}，跳过 ${skip}，失败 ${fail}`);
  if (fail) process.exitCode = 1;
}

async function run() {
  if (MODE !== 'push' && MODE !== 'pull') {
    console.error('用法：node scripts/r2-sync.js push | pull');
    process.exit(2);
  }
  if (!(await r2Available())) {
    console.log(`R2 bucket「${BUCKET}」不可用（未开通或无权限），跳过同步。`);
    return; // 正常退出，不阻断构建
  }
  if (MODE === 'push') await push(); else await pull();
}
run().catch(e => { console.error(e); process.exit(1); });
