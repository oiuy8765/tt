'use strict';

/**
 * 生成多语言词典：
 *   data/i18n/ui.json       界面文案 { en:{中文:译文}, ja:{...}, ko:{...}, 'zh-TW':{...} }
 *   data/i18n/topics-<l>.json  话题关键词与简介 { 英文: 译文 }
 *
 * 英语界面文案用 ui-source.js 里手写的英文，话题内容英语就是原文（不翻译）。
 * 其余语言走腾讯翻译，按 (from,to) 增量缓存，重跑只翻新增。
 *
 * 用法：node build-i18n.js            全量
 *      node build-i18n.js ja ko      指定语言
 */

const fs = require('fs');
const path = require('path');
const { UI } = require('./i18n/ui-source');
const { translate } = require('./i18n/translate');
const { OVERRIDES } = require('./i18n/overrides');

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, 'data', 'i18n');
const TARGETS = ['zh-TW', 'ja', 'ko'];

function readJSON(p, dflt) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return dflt;
  }
}

async function buildUI(langs) {
  const zhKeys = Object.keys(UI);
  const out = readJSON(path.join(OUT_DIR, 'ui.json'), {});

  // 英语：用词表里手写的英文，缺失的走接口
  if (langs.includes('en')) {
    const map = {};
    const missing = [];
    for (const k of zhKeys) {
      const en = UI[k];
      if (en && en !== k) map[k] = en;
      else missing.push(k);
    }
    if (missing.length) {
      const r = await translate(missing, { from: 'zh', to: 'en', onProgress: prog('界面 en') });
      Object.assign(map, r.map);
    }
    // 语言名不翻译，直接用自身写法
    map['简体中文'] = '简体中文';
    map['繁體中文'] = '繁體中文';
    map['英語'] = 'English';
    map['日本語'] = '日本語';
    map['한국어'] = '한국어';
    out.en = map;
    console.log('  界面 en：' + Object.keys(map).length + ' 条');
  }

  for (const l of langs.filter((x) => x !== 'en')) {
    // 日/韩从英文翻：中文的「做站 / 建站分」有歧义，机翻会译成「车站」
    const fromEn = l === 'ja' || l === 'ko';
    const srcTexts = fromEn ? zhKeys.map((k) => out.en[k] || k) : zhKeys;
    const r = await translate(srcTexts, { from: fromEn ? 'en' : 'zh', to: l, onProgress: prog('界面 ' + l) });
    // 回填成「中文 key → 译文」
    const map = {};
    zhKeys.forEach((k, i) => {
      const v = r.map[srcTexts[i]];
      if (v) map[k] = v;
    });
    // 英文与中文相同的键（语言名），直接用
    for (const k of zhKeys) if (!map[k] && out.en[k]) map[k] = out.en[k];
    // 语言名各语言都显示原文
    map['简体中文'] = l === 'ja' ? '簡体字中国語' : l === 'ko' ? '중국어 간체' : '简体中文';
    map['繁體中文'] = '繁體中文';
    map['英語'] = 'English';
    map['日本語'] = '日本語';
    map['한국어'] = '한국어';
    out[l] = map;
    console.log('  界面 ' + l + '：' + Object.keys(map).length + ' 条（新译 ' + r.pending + '，失败 ' + r.failed + '）');
  }

  // 人工修正优先于机翻
  for (const l of Object.keys(OVERRIDES)) {
    out[l] = Object.assign({}, out[l] || {}, OVERRIDES[l]);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'ui.json'), JSON.stringify(out), 'utf8');
  return out;
}

function prog(label) {
  let last = 0;
  return (done, total) => {
    if (done - last >= 100 || done === total) {
      last = done;
      console.log('    ' + label + ' ' + done + '/' + total);
    }
  };
}

function collectContent(topics) {
  const out = [];
  for (const t of topics || []) {
    if (t.keyword) out.push(t.keyword);
    if (t.descShort) out.push(t.descShort);
  }
  return out;
}

async function buildTopics(langs, topics) {
  const texts = collectContent(topics);
  for (const l of langs) {
    if (l === 'en') continue;
    const file = path.join(OUT_DIR, 'topics-' + l + '.json');
    const rm = await translate(texts, {
      from: 'en',
      to: l,
      onProgress: prog('内容 ' + l),
    });
    const prev = readJSON(file, {});
    const merged = Object.assign({}, prev, rm.map);
    fs.writeFileSync(file, JSON.stringify(merged), 'utf8');
    console.log('  内容 ' + l + '：' + Object.keys(merged).length + ' 条（本轮新译 ' + rm.pending + '，失败 ' + rm.failed + '）');
  }
}

(async () => {
  const argLangs = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const langs = argLangs.length ? argLangs : ['en'].concat(TARGETS);

  console.log('[i18n 1/2] 界面文案…');
  await buildUI(langs);

  console.log('[i18n 2/2] 话题关键词与简介…');
  const site = readJSON(path.join(ROOT, 'data', 'site-data.json'), null);
  if (!site || !site.topics) {
    console.error('缺少 data/site-data.json，先跑一次构建');
    process.exit(1);
  }
  await buildTopics(langs, site.topics);

  console.log('完成 → data/i18n/');
})();
