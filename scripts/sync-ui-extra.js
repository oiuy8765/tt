'use strict';

/**
 * 把 i18n/ui-source.js 里的界面文案同步到 data/i18n/ui.json。
 * 英文直接用源表手写值（质量最高），zh-TW / ja / ko 走翻译引擎（带缓存，只翻新增）。
 * 增量：已有译文不覆盖，只补缺失的 key。
 *
 * 用法：node scripts/sync-ui-extra.js
 */

const fs = require('fs');
const path = require('path');
const { UI } = require('../i18n/ui-source');
const { translate } = require('../i18n/translate');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'i18n', 'ui.json');
const TARGETS = ['en', 'zh-TW', 'ja', 'ko'];

async function main() {
  const ui = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const keys = Object.keys(UI);

  // 英文：源表手写，直接补齐
  ui.en = ui.en || {};
  let enAdded = 0;
  for (const k of keys) {
    if (!ui.en[k]) {
      ui.en[k] = UI[k];
      enAdded++;
    }
  }

  // 缺失的 key（各语言）
  const missing = {};
  for (const l of TARGETS) {
    ui[l] = ui[l] || {};
    missing[l] = keys.filter((k) => !ui[l][k]);
  }
  // zh-TW 用繁体：先尝试从 cache-zh-zh-TW 拿，其余翻译
  const toTranslate = [];
  const seen = new Set();
  for (const l of TARGETS) {
    if (l === 'en') continue;
    for (const k of missing[l]) {
      if (!seen.has(k)) {
        seen.add(k);
        toTranslate.push(k);
      }
    }
  }

  if (toTranslate.length) {
    console.log('待译界面文案：' + toTranslate.length + ' 条');
    for (const l of TARGETS) {
      if (l === 'en') continue;
      if (!missing[l].length) {
        console.log('  ' + l + '：无需补齐');
        continue;
      }
      const from = l === 'zh-TW' ? 'zh' : 'zh';
      const r = await translate(toTranslate, {
        from,
        to: l,
        onProgress: (d, t) => {
          if (d % 40 === 0 || d === t) console.log('    ' + l + ' ' + d + '/' + t);
        },
      });
      for (const k of missing[l]) {
        if (r.map[k]) ui[l][k] = r.map[k];
      }
      console.log('  ' + l + '：补齐 ' + missing[l].filter((k) => ui[l][k]).length + ' 条（失败 ' + r.failed + '）');
    }
  } else {
    console.log('界面文案已齐全');
  }

  fs.writeFileSync(OUT, JSON.stringify(ui), 'utf8');
  console.log('已写入 ' + OUT + '（英文新增 ' + enAdded + ' 条）');
}

main().catch((e) => {
  console.error('同步失败：' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
