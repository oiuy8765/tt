'use strict';

/**
 * 独立的热榜翻译任务（不构建页面，只刷新翻译缓存）。
 *
 * 背景：翻译接口按 IP 限频，一次构建大约只能翻 450 条，而每天新词条有
 * 4 种语言 × 270 条 ≈ 1100 次，永远追不上。把它拆成每 2 小时一次的小任务，
 * 缓存逐步累积，构建时直接命中，页面就是全译状态。
 *
 * 数据来源优先用线上快照（与页面一致），失败再读本地 data/daily.json。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

async function loadDaily() {
  try {
    const r = await fetch('https://trendsift.site/data/daily.json?t=' + Date.now(), {
      signal: AbortSignal.timeout(20000),
    });
    if (r.ok) {
      const j = await r.json();
      if (j && j.data) return j;
    }
  } catch (e) {
    console.log('线上快照不可用：' + e.message);
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'daily.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

(async () => {
  const daily = await loadDaily();
  if (!daily || !daily.data) {
    console.log('没有可用的热榜数据，跳过');
    return;
  }
  fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });
  fs.writeFileSync(path.join(DIST, 'data', 'daily.json'), JSON.stringify(daily), 'utf8');

  // 每轮每种语言翻多少条：跑得越勤可以越小，避免撞限频
  process.env.DAILY_TR_LIMIT = process.env.DAILY_TR_LIMIT || '120';
  console.log('本轮每语言上限 ' + process.env.DAILY_TR_LIMIT + ' 条');
  const { buildDailyTranslations } = require(path.join(ROOT, 'build-multi.js'));
  await buildDailyTranslations();
  fs.rmSync(path.join(DIST, 'data', 'daily.json'), { force: true });
})();
