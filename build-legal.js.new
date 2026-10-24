'use strict';

/**
 * 法务/信息页的多语言生成。
 *
 * 做法：拿现有中文 HTML 作为结构母版，只把「标签之间的文字」抽出来翻译，
 * 标签结构、class、链接原样保留 —— 这样既有原版排版，又不会把 <a>/<b> 翻坏。
 *
 * 产出：/about.html /privacy.html /contact.html 及各自语言版本。
 */

const fs = require('fs');
const path = require('path');
const { translate } = require('./i18n/translate');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'data', 'i18n', 'legal.json');

const LANGS = {
  'zh-CN': '',
  'zh-TW': '/zh-tw',
  en: '/en',
  ja: '/ja',
  ko: '/ko',
};

const PAGES = [
  { file: 'about.html', key: 'about' },
  { file: 'privacy.html', key: 'privacy' },
  { file: 'contact.html', key: 'contact' },
];

function readJSON(p, d) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return d;
  }
}

function hasCJK(s) {
  return /[\u4e00-\u9fa5]/.test(s);
}

/** 抽出 main 里所有含中文的文本节点（标签之间的内容） */
function collectTexts(html) {
  const out = new Set();
  const re = />([^<>]+)</g;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1];
    const t = raw.trim();
    if (t && hasCJK(t) && t.length >= 2) out.add(t);
  }
  return Array.from(out);
}

/** 空白归一：母版里的换行/缩进经常和词典键对不上，比较前统一压成单空格 */
function norm(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 按文本节点替换。
 * 早先直接拿原始文本查词典，段落只要换行位置变过就整段漏译（页面上半英半中），
 * 这里改成「归一化后匹配，再回填原文的首尾空白」。
 */
function applyTexts(html, map) {
  const byNorm = {};
  for (const k of Object.keys(map || {})) {
    const n = norm(k);
    if (n) byNorm[n] = map[k];
  }
  const hit = (s) => {
    const n = norm(s);
    if (!n) return '';
    return byNorm[n] || map[s.trim()] || '';
  };
  return html.replace(/>([^<>]+)</g, function (m, raw) {
    const t = raw.trim();
    if (!t || !hasCJK(t)) return m;
    const tr = hit(t);
    if (!tr) return m;
    const lead = raw.match(/^\s*/)[0];
    const tail = raw.match(/\s*$/)[0];
    return '>' + lead + tr + tail + '<';
  });
}

/** 从母版里取出主内容与标题（用于生成新页面的 head） */
function parse(raw) {
  const main = raw.match(/<main[^>]*>([\s\S]*?)<\/main>/);
  const title = (raw.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1];
  const desc = (raw.match(/<meta name="description" content="([\s\S]*?)"\s*\/?>/) || [, ''])[1];
  return { inner: main ? main[1] : '', title, desc };
}

/** 把文本节点里的中文标点换成西文标点（只动标签之间的内容） */
function fixPunct(html) {
  return html.replace(/>([^<>]+)</g, function (m, raw) {
    if (!/[。，、；：（）！？]/.test(raw)) return m;
    const out = raw
      .replace(/。\s*/g, '. ')
      .replace(/、/g, ', ')
      .replace(/，/g, ', ')
      .replace(/；/g, '; ')
      .replace(/：/g, ': ')
      .replace(/（/g, ' (')
      .replace(/）/g, ') ')
      .replace(/！/g, '!')
      .replace(/？/g, '?')
      .replace(/\s+([.,;:!?)])/g, '$1')
      .replace(/\s{2,}/g, ' ');
    return '>' + out + '<';
  });
}

async function build() {
  const store = readJSON(OUT, {});
  const base = {};
  const texts = [];

  for (const p of PAGES) {
    const raw = fs.readFileSync(path.join(ROOT, 'public', p.file), 'utf8');
    base[p.key] = parse(raw);
    base[p.key].raw = raw;
    texts.push.apply(texts, collectTexts(base[p.key].inner));
  }
  const uniq = Array.from(new Set(texts));

  for (const code of Object.keys(LANGS)) {
    if (code === 'zh-CN') continue;
    const r = await translate(uniq, {
      from: 'zh',
      to: code,
      onProgress: function (d, t) {
        if (d % 40 === 0 || d === t) console.log('    ' + code + ' ' + d + '/' + t);
      },
    });
    store[code] = Object.assign({}, store[code] || {}, r.map);
    console.log('  法务页 ' + code + '：' + Object.keys(store[code]).length + ' 段（新译 ' + r.pending + '）');
  }

  // 人工英文文案：机翻在「站/载体/时效」这类词上错得很显眼，英文版按原文重写，
  // 放在 i18n/legal-en.json（键是归一化后的中文原文），合并时优先级最高。
  const manualPath = path.join(ROOT, 'i18n', 'legal-en.json');
  const manual = readJSON(manualPath, {});
  if (Object.keys(manual).length) {
    store.en = Object.assign({}, store.en || {}, manual);
    console.log('  法务页 en：人工文案覆盖 ' + Object.keys(manual).length + ' 段');
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(store), 'utf8');

  // 生成页面
  const M = require('./build-multi.js');
  for (const code of Object.keys(LANGS)) {
    const prefix = LANGS[code];
    const dict = code === 'zh-CN' ? null : store[code] || {};
    // 标题/描述这类短文本同样要过归一化，否则英文页会留下「关于我们 · TrendSift」
    const nrm = {};
    for (const k of Object.keys(dict || {})) nrm[norm(k)] = dict[k];
    const tx2 = (s) => {
      if (!dict || !s) return s;
      const clean = String(s).trim();
      const direct = dict[clean] || nrm[norm(clean)];
      if (direct) return direct;
      const parts = clean.split(' · ');
      if (parts.length > 1) {
        const head = dict[parts[0].trim()] || nrm[norm(parts[0])];
        if (head) return head + ' · ' + parts.slice(1).join(' · ');
      }
      return s;
    };
    // 品牌名归一：标题/正文里任何语言变体统一成当前语言的站点名
    const BRAND_VARIANTS = ['TrendSift', '趋势雷达', '趨勢雷達', 'トレンドレーダー', '트렌드 레이더'];
    const locBrand = (t) => (t ? String(t).replace(new RegExp(BRAND_VARIANTS.join('|'), 'g'), M.brandName(code)) : t);
    for (const p of PAGES) {
      let inner = dict ? applyTexts(base[p.key].inner, dict) : base[p.key].inner;
      // 中文句号/逗号常常写在标签外面，替换后会在英文/韩文页留下「。、，」
      if (code === 'en' || code === 'ko') inner = fixPunct(inner);
      inner = locBrand(inner);
      const title = locBrand(tx2(base[p.key].title));
      const desc = locBrand(tx2(base[p.key].desc));
      const html = M.renderDoc(
        code,
        {
          rel: '/' + p.key,
          title: title,
          desc: desc,
          body: '<main class="doc-main">' + inner + '</main>',
        }
      );
      const rel = path.join(prefix ? prefix.slice(1) : '', p.file);
      const target = path.join(DIST, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, html, 'utf8');
    }
  }
  console.log('  法务页：' + Object.keys(LANGS).length * PAGES.length + ' 个页面');
}

if (require.main === module) build();

module.exports = { build };
