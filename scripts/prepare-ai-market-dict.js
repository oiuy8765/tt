'use strict';

/**
 * 翻译前的词典准备工作（一次性）：
 * 1. 按新词库文本白名单清理 data/i18n/ai-market.json 的旧词条目
 * 2. 用 opencc 本地生成 zh-TW 词典，并预填 cache-zh-zh-TW.json，
 *    让 build-ai-market.js 跑 zh-TW 时全部命中缓存、跳过慢速机翻
 *
 * 用法：node scripts/prepare-ai-market-dict.js
 */
const fs = require('fs');
const path = require('path');
const { Converter } = require('opencc-js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'ai-market.json');
const DICT = path.join(ROOT, 'data', 'i18n', 'ai-market.json');
const TW_CACHE = path.join(ROOT, 'data', 'i18n', 'cache-zh-zh-TW.json');
const toTW = Converter({ from: 'cn', to: 'twp' });

const TEXT_KEYS = [
  'intro', 'title', 'cat', 'form', 'window',
  'tldr', 'why', 'audience', 'product', 'competition', 'monetize', 'action', 'risk',
  'evidence', 'sourceNote',
];

function collectTexts(src) {
  const out = [];
  const add = (s) => {
    if (s == null) return;
    const v = String(s).replace(/\s+/g, ' ').trim();
    if (v) out.push(v);
  };
  add(src.intro);
  for (const it of src.items || []) {
    for (const k of TEXT_KEYS) if (k !== 'intro') add(it[k]);
    for (const s of it.steps || []) add(s);
    for (const f of it.faq || []) add(f.q), add(f.a);
  }
  return Array.from(new Set(out));
}

function convert(s) {
  return toTW(s)
    .replace(/軟件/g, '軟體')
    .replace(/視頻/g, '影片')
    .replace(/資訊分析/g, '資料分析')
    .replace(/用戶/g, '使用者')
    .replace(/信息/g, '資訊')
    .replace(/網絡/g, '網路')
    .replace(/服務器/g, '伺服器')
    .replace(/谷歌/g, 'Google')
    .replace(/數據庫/g, '資料庫');
}

function main() {
  const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const texts = collectTexts(src);
  const white = new Set(texts);

  let dict = {};
  try { dict = JSON.parse(fs.readFileSync(DICT, 'utf8')); } catch (e) {}

  // 1. 清理旧词：每个语言只保留新词库白名单内的 key
  const pruned = {};
  for (const lang of Object.keys(dict)) {
    pruned[lang] = {};
    for (const k of Object.keys(dict[lang] || {})) {
      if (white.has(k)) pruned[lang][k] = dict[lang][k];
    }
    console.log('清理 ' + lang + '：' + Object.keys(dict[lang] || {}).length + ' → ' + Object.keys(pruned[lang]).length + ' 段');
  }

  // 2. 本地生成 zh-TW
  pruned['zh-TW'] = pruned['zh-TW'] || {};
  for (const s of texts) pruned['zh-TW'][s] = convert(s);
  fs.writeFileSync(DICT, JSON.stringify(pruned), 'utf8');
  console.log('zh-TW 词典写入 ' + Object.keys(pruned['zh-TW']).length + ' 段（本地简繁转换）');

  // 3. 预填 zh-TW 缓存，让主脚本命中
  let twCache = {};
  try { twCache = JSON.parse(fs.readFileSync(TW_CACHE, 'utf8')); } catch (e) {}
  for (const s of texts) twCache[s] = convert(s);
  fs.writeFileSync(TW_CACHE, JSON.stringify(twCache), 'utf8');
  console.log('zh-TW 缓存预填 ' + texts.length + ' 段');

  console.log('新词库待译文本：' + texts.length + ' 段');
}

main();
