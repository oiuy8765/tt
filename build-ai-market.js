'use strict';

/**
 * AI 市场分析板块 · 多语言词典生成器
 *
 * 读取 data/ai-market.json（AI 每周撰写的中文源），把需要翻译的分析正文
 * 批量翻译成 en / ja / ko / zh-TW，写入 data/i18n/ai-market.json：
 *   { en: {中文原文: 译文}, ja: {...}, ko: {...}, 'zh-TW': {...} }
 *
 * 数字、slug、关键词原文、增长数据等不进词典，构建时直接取源数据。
 * 翻译走 i18n/translate.js 的三级降级 + 按语言缓存，重复运行只翻新增段落。
 *
 * 用法：node build-ai-market.js
 */

const fs = require('fs');
const path = require('path');
const { translate } = require('./i18n/translate');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'data', 'ai-market.json');
const OUT = path.join(ROOT, 'data', 'i18n', 'ai-market.json');
const LANGS = ['en', 'ja', 'ko', 'zh-TW'];

// 需要翻译的字段（纯展示文本）。slug / keyword / grade / trend / related / firstSeen / platform 不翻。
const TEXT_KEYS = [
  'intro',
  'title', 'cat', 'form', 'window',
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
    for (const f of it.faq || []) {
      add(f.q);
      add(f.a);
    }
  }
  return Array.from(new Set(out));
}

async function build() {
  if (!fs.existsSync(SRC)) {
    console.error('找不到源数据：' + SRC);
    process.exitCode = 1;
    return;
  }
  const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const texts = collectTexts(src);
  console.log('AI 市场分析：待译文本 ' + texts.length + ' 段 / ' + (src.items || []).length + ' 个机会');

  let store = {};
  try {
    store = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch (e) {
    /* 首次生成 */
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  for (const code of LANGS) {
    const r = await translate(texts, {
      from: 'zh',
      to: code,
      onProgress: (d, t) => {
        if (d % 50 === 0 || d === t) console.log('    ' + code + ' ' + d + '/' + t);
      },
    });
    store[code] = Object.assign({}, store[code] || {}, r.map);
    console.log('  ' + code + '：' + Object.keys(store[code]).length + ' 段（新译 ' + r.pending + ' · 缓存 ' + r.cached + ' · 失败 ' + r.failed + '）');
    // 每完成一种语言立即写盘，避免中途中断导致全部进度丢失
    fs.writeFileSync(OUT, JSON.stringify(store), 'utf8');
  }
  console.log('已写入 ' + OUT);
}

if (require.main === module) {
  build().catch((e) => {
    console.error('翻译失败：' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  });
}

module.exports = { build, collectTexts };
