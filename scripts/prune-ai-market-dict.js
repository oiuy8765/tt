'use strict';
/**
 * 清理 AI 市场分析词典：只保留当前 data/ai-market.json 里出现的中文文本 key，
 * 移除上一批词条的旧译文（含「中文站」等过时文案），避免残留。
 * 用法：node scripts/prune-ai-market-dict.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'ai-market.json');
const DICT = path.join(ROOT, 'data', 'i18n', 'ai-market.json');

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const dict = JSON.parse(fs.readFileSync(DICT, 'utf8'));

// 收集所有需要翻译的中文原文（与 build-ai-market.js 的 collectTexts 一致）
const TEXT_KEYS = ['intro', 'title', 'cat', 'form', 'window', 'tldr', 'why', 'audience',
  'product', 'competition', 'monetize', 'action', 'risk', 'evidence', 'sourceNote'];
const keep = new Set();
const add = (s) => { if (s != null) { const v = String(s).replace(/\s+/g, ' ').trim(); if (v) keep.add(v); } };
add(src.intro);
for (const it of src.items || []) {
  for (const k of TEXT_KEYS) if (k !== 'intro') add(it[k]);
  for (const s of it.steps || []) add(s);
  for (const f of it.faq || []) { add(f.q); add(f.a); }
}

let removed = 0;
for (const lang of Object.keys(dict)) {
  const before = Object.keys(dict[lang]).length;
  const cleaned = {};
  for (const k of Object.keys(dict[lang])) if (keep.has(k)) cleaned[k] = dict[lang][k];
  dict[lang] = cleaned;
  removed += before - Object.keys(cleaned).length;
  console.log('  ' + lang + ': ' + before + ' -> ' + Object.keys(cleaned).length);
}
fs.writeFileSync(DICT, JSON.stringify(dict), 'utf8');
console.log('已清理旧译文 ' + removed + ' 条');
