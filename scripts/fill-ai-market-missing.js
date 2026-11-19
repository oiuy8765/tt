'use strict';

/**
 * 补齐 AI 市场分析词典里缺失的翻译段落。
 *
 * 特点（相比通用 translate.js 更抗卡死）：
 *  - 只处理缓存里没有的段落
 *  - 腾讯接口短超时（10s），单条失败立即跳过并在下轮重试，不搞 25s×3 重试风暴
 *  - 每成功若干条就写盘，进度永不丢失
 *  - 可反复运行，直到「缺 0 段」
 *
 * 用法：node scripts/fill-ai-market-missing.js [ko|zh-TW|all]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'ai-market.json');
const OUT = path.join(ROOT, 'data', 'i18n', 'ai-market.json');
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tencentOne(text, to) {
  const body = JSON.stringify({
    header: { fn: 'auto_translation', client_key: 'browser-chrome-110.0.0' },
    type: 'plain',
    model_category: 'normal',
    source: { lang: 'zh', text_list: [text] },
    target: { lang: to },
  });
  const r = await fetch('https://transmart.qq.com/api/imt', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://transmart.qq.com',
      Referer: 'https://transmart.qq.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const arr = j && j.auto_translation;
  if (!Array.isArray(arr) || !arr.length) throw new Error('bad response');
  return String(arr[0] || '').trim();
}

async function main() {
  const which = process.argv[2] || 'all';
  const langs = which === 'all' ? ['ko', 'zh-TW'] : [which];
  const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const texts = collectTexts(src);

  let dict = {};
  try {
    dict = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch (e) {
    /* 首次 */
  }

  for (const code of langs) {
    // 目标语言词典 = 已有词典 ∪ 该语言 cache
    let cache = {};
    const cacheFile = path.join(ROOT, 'data', 'i18n', 'cache-zh-' + code + '.json');
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (e) {
      /* 首次 */
    }
    const missing = texts.filter((s) => !dict[code] || !dict[code][s]);
    console.log(code + '：待补 ' + missing.length + ' 段');
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < missing.length; i++) {
      const s = missing[i];
      // 优先用 cache（之前跑过的进度）
      if (cache[s]) {
        dict[code] = dict[code] || {};
        dict[code][s] = cache[s];
        ok++;
      } else {
        try {
          const v = await tencentOne(s, code);
          if (v) {
            dict[code] = dict[code] || {};
            dict[code][s] = v;
            cache[s] = v;
            ok++;
          } else {
            fail++;
          }
        } catch (e) {
          fail++;
        }
        // 放慢节奏，规避腾讯接口短时限流（每成功/失败一条都间隔 2.5s）
        await sleep(2500);
      }
      // 每 8 段写盘（词典 + 缓存）
      if ((i + 1) % 8 === 0 || i === missing.length - 1) {
        fs.writeFileSync(OUT, JSON.stringify(dict), 'utf8');
        fs.writeFileSync(cacheFile, JSON.stringify(cache), 'utf8');
        console.log('  ' + code + ' ' + (i + 1) + '/' + missing.length + ' (ok ' + ok + ' fail ' + fail + ')');
      }
    }
    fs.writeFileSync(OUT, JSON.stringify(dict), 'utf8');
    fs.writeFileSync(cacheFile, JSON.stringify(cache), 'utf8');
    console.log(code + ' 完成：' + ok + ' 成功 / ' + fail + ' 失败 / 词典 ' + Object.keys(dict[code] || {}).length + ' 段');
  }
}

main().catch((e) => {
  console.error('失败：' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
