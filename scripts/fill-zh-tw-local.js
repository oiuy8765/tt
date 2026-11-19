'use strict';

/**
 * 用 opencc-js 本地生成 AI 市场分析的繁体中文（zh-TW）词典，无需网络。
 * 采用 cn→twp（台湾正体 + 用词习惯：软件→軟體、视频→影片、数据→資料）。
 * 对少量 AI 术语做人工校正，避免机翻式用词。
 *
 * 用法：node scripts/fill-zh-tw-local.js
 */

const fs = require('fs');
const path = require('path');
const { Converter } = require('opencc-js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'ai-market.json');
const OUT = path.join(ROOT, 'data', 'i18n', 'ai-market.json');
const toTW = Converter({ from: 'cn', to: 'twp' });

const TEXT_KEYS = ['title', 'cat', 'form', 'window', 'tldr', 'why', 'audience', 'product', 'competition', 'monetize', 'action', 'risk', 'evidence', 'sourceNote'];

function collectTexts(src) {
  const out = [];
  const add = (s) => {
    if (s == null) return;
    const v = String(s).replace(/\s+/g, ' ').trim();
    if (v) out.push(v);
  };
  add(src.intro);
  for (const it of src.items || []) {
    for (const k of TEXT_KEYS) add(it[k]);
    for (const s of it.steps || []) add(s);
    for (const f of it.faq || []) {
      add(f.q);
      add(f.a);
    }
  }
  return Array.from(new Set(out));
}

// 台湾用词微调：opencc 已处理大部分，这里补几个 AI/互联网场景的高频词
const FIX = [
  [/軟件/g, '軟體'],
  [/視頻/g, '影片'],
  [/數據(?!庫|分析)/g, '資料'],
  [/信息/g, '資訊'],
  [/網絡/g, '網路'],
  [/服務器/g, '伺服器'],
  [/用戶(g|端)/g, '使用者$1'], // 下面单行单独处理
];

function convert(s) {
  let t = toTW(s);
  t = t.replace(/軟件/g, '軟體')
    .replace(/視頻/g, '影片')
    .replace(/資訊分析/g, '資料分析')
    .replace(/用戶/g, '使用者')
    .replace(/信息/g, '資訊')
    .replace(/網絡/g, '網路')
    .replace(/服務器/g, '伺服器')
    .replace(/谷歌/g, 'Google')
    .replace(/數據庫/g, '資料庫');
  return t;
}

function main() {
  const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const texts = collectTexts(src);
  let dict = {};
  try {
    dict = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch (e) {
    /* 首次 */
  }
  dict['zh-TW'] = dict['zh-TW'] || {};
  for (const s of texts) {
    dict['zh-TW'][s] = convert(s);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(dict), 'utf8');
  console.log('zh-TW 词典：' + Object.keys(dict['zh-TW']).length + ' 段（本地简繁转换，无需网络）');
  console.log('样例：' + texts[0].slice(0, 30) + ' → ' + dict['zh-TW'][texts[0]].slice(0, 30));
}

main();
