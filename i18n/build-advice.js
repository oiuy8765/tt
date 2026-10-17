'use strict';

/**
 * 生成多语言「建议模板」词典：data/i18n/advice.json
 *
 * 结构：{ 'zh-CN': { id: 模板 }, en: {...}, 'zh-TW': {...}, ja: {...}, ko: {...} }
 *
 * 为什么按模板 id 翻而不是整句翻：871 条话题的建议是「动作 + 时机」拼出来的，
 * 整句翻要 871×4 条，而且变量（关键词、百分比、月份）会被翻坏。
 * 按 id 只需 86 条 × 4 语言，页面渲染时再填 [[KW]] 之类的变量。
 *
 * 用法：node i18n/build-advice.js [--force]
 */

const fs = require('fs');
const path = require('path');
const { translate } = require('./translate');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'i18n', 'advice.json');
const EN = require('./advice-en');

const PH = /\[\[(\w+)\]\]/g;

/** 把占位符换成 [[0]] [[1]]，翻译后再换回来，避免被翻译器改写大小写 */
function mask(s) {
  const keys = [];
  const text = String(s).replace(PH, (m, k) => {
    keys.push(k);
    return '[[' + (keys.length - 1) + ']]';
  });
  return { text, keys };
}
function unmask(s, keys) {
  // 翻译接口经常把 [[0]] 弄成 [0]、[[[0]]] 或 [[ 0 ]]：放宽到 1~3 个括号都能还原
  return String(s).replace(/\[{1,3}\s*(\d{1,2})\s*\]{1,3}/g, (m, i) => (keys[Number(i)] != null ? '[[' + keys[Number(i)] + ']]' : m));
}
function phSet(s) {
  const out = [];
  String(s).replace(PH, (m, k) => {
    out.push(k);
    return m;
  });
  return out.sort().join(',');
}

async function translateMap(src, from, to) {
  const ids = Object.keys(src);
  const masked = ids.map((id) => mask(src[id]));
  const texts = masked.map((x) => x.text);
  const r = await translate(texts, {
    from,
    to,
    onProgress: (d, t) => {
      if (d === t || d % 20 === 0) process.stdout.write('    ' + to + ' ' + d + '/' + t + '\n');
    },
  });
  const out = {};
  let fallback = 0;
  ids.forEach((id, i) => {
    const raw = r.map[masked[i].text];
    const back = raw ? unmask(raw, masked[i].keys) : '';
    // 占位符数量/名字必须和原文一致，否则整条回退（宁可英文，也不要坏变量）
    if (!back || phSet(back) !== phSet(src[id])) {
      out[id] = src[id];
      fallback++;
      return;
    }
    out[id] = back;
  });
  if (fallback) console.log('    ' + to + '：' + fallback + ' 条占位符不匹配，已回退源语言');
  return out;
}

(async () => {
  const R = require(path.join(ROOT, 'radar.js'));
  const zh = R.ADVICE_TPL;
  const zhIds = Object.keys(zh).sort();
  const enIds = Object.keys(EN).sort();

  const missEn = zhIds.filter((k) => !EN[k]);
  const extraEn = enIds.filter((k) => !zh[k]);
  if (missEn.length) throw new Error('英文缺模板：' + missEn.join(', '));
  if (extraEn.length) console.log('英文多出（忽略）：' + extraEn.join(', '));

  console.log('模板 ' + zhIds.length + ' 条，开始翻译…');
  const out = { 'zh-CN': {}, en: {} };
  for (const id of zhIds) {
    out['zh-CN'][id] = zh[id];
    out.en[id] = EN[id] || zh[id];
  }

  out['zh-TW'] = await translateMap(out['zh-CN'], 'zh', 'zh-TW');
  out.ja = await translateMap(out.en, 'en', 'ja');
  out.ko = await translateMap(out.en, 'en', 'ko');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out), 'utf8');
  const size = fs.statSync(OUT).size;
  console.log('写入 ' + path.relative(ROOT, OUT) + '（' + Math.round(size / 1024) + ' KB）');
  for (const l of Object.keys(out)) console.log('  ' + l + '：' + Object.keys(out[l]).length + ' 条');
})().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});
