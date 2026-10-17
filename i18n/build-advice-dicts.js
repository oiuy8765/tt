'use strict';

/**
 * 翻译卡片「建议 / 渠道提示 / 分类标签」：
 *   data/site.json 里每个话题的 advice / digitalAdvice / platformAdvice（中文文案）
 *   + build-multi.js CAT_LABEL 的中文标签
 * → 合并进 data/i18n/topics-{en,zh-TW,ja,ko}.json（key = 中文原文）
 *
 * 用法：node i18n/build-advice-dicts.js
 */

const fs = require('fs');
const path = require('path');
const { translate } = require('./translate');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'i18n');
const TARGETS = ['en', 'zh-TW', 'ja', 'ko'];

// 与 build-multi.js / public/lang.js 的 CAT_LABEL 保持一致
const CAT_LABEL = {
  software: '软件', technology: '科技', business: '商业', marketing: '营销', finance: '金融',
  investing: '投资', insurance: '保险', legal: '法律', health: '健康', medical: '医疗',
  supplements: '保健品', nutrition: '营养', fitness: '健身', 'personal-care': '个护', beauty: '美妆',
  'makeup-cosmetics': '彩妆', skincare: '护肤', fashion: '时尚', clothing: '服饰', shoes: '鞋类',
  jewelry: '珠宝', home: '家居', 'home-decor': '家居装饰', furniture: '家具', kitchen: '厨房',
  'home-improvement': '家装', garden: '园艺', 'gardening-agriculture': '园艺农业',
  'food-beverage': '食品饮料', food: '食品', beverage: '饮料', cooking: '烹饪', cpg: '快消品',
  retail: '零售', ecommerce: '电商', product: '产品', travel: '旅行', hospitality: '酒店旅游',
  'sports-outdoors': '运动户外', entertainment: '娱乐', gaming: '游戏', pets: '宠物',
  education: '教育', automotive: '汽车', 'baby-kids': '母婴', wedding: '婚庆',
  'diy-crafts': '手工', sustainability: '环保', energy: '能源', real_estate: '房产',
  construction: '建筑', manufacturing: '制造', logistics: '物流', security: '安防',
  photography: '摄影', music: '音乐', art: '艺术', books: '图书', office: '办公',
  tools: '工具', hardware: '硬件', electronics: '电子', appliances: '家电',
  sleep: '睡眠', drink: '饮品', snacks: '零食', outdoor: '户外',
};

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

async function main() {
  const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'data', 'site.json'), 'utf8'));
  const topics = site.topics || [];

  const keys = new Set();
  for (const t of topics) {
    if (t.advice) keys.add(norm(t.advice));
    if (t.digitalAdvice) keys.add(norm(t.digitalAdvice));
    if (t.platformAdvice) keys.add(norm(t.platformAdvice));
  }
  for (const c of Object.keys(CAT_LABEL)) keys.add(CAT_LABEL[c]);

  const texts = Array.from(keys).filter((s) => s && s.length <= 900);
  console.log('待翻译文案：' + texts.length + ' 条（建议 ' +
    (function () {
      let n = 0;
      for (const t of topics) { if (t.advice) n++; if (t.digitalAdvice) n++; if (t.platformAdvice) n++; }
      return n;
    })() + ' / 分类 ' + Object.keys(CAT_LABEL).length + '）');

  for (const lang of TARGETS) {
    const dictPath = path.join(OUT_DIR, 'topics-' + lang + '.json');
    const dict = (() => {
      try { return JSON.parse(fs.readFileSync(dictPath, 'utf8')); } catch (e) { return {}; }
    })();
    const r = await translate(texts, {
      from: 'zh',
      to: lang,
      onProgress: (d, total) => {
        if (d === total || d % 200 === 0) console.log('  ' + lang + ' ' + d + '/' + total);
      },
    });
    let added = 0;
    for (const [k, v] of Object.entries(r.map)) {
      if (!dict[k]) added++;
      dict[k] = v;
    }
    fs.writeFileSync(dictPath, JSON.stringify(dict), 'utf8');
    console.log('topics-' + lang + '.json：+' + added + '（共 ' + Object.keys(dict).length + '，未译 ' + r.failed + '）');
  }
  console.log('完成');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
