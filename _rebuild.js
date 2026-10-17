const fs = require('fs');
const R = require('./radar.js');
(async () => {
  const full = await R.getRadar({ force: true });
  fs.writeFileSync('data/site-data.json', JSON.stringify({ at: full.at, total: full.total, counts: full.counts, topics: full.topics }), 'utf8');
  const T = full.topics;
  console.log('重算完成', T.length, '条');
  console.log('长青:', T.filter((t) => t.evergreen).length, '季节明显:', T.filter((t) => t.season && t.season.strength >= 0.4).length);
  console.log('阶段:', JSON.stringify(T.reduce((a, t) => { a[t.stageLabel] = (a[t.stageLabel] || 0) + 1; return a; }, {})));
  const bs = T.map((t) => t.buildScore).sort((a, b) => a - b);
  console.log('buildScore 中位', bs[Math.floor(bs.length / 2)], 'p75', bs[Math.floor(bs.length * 0.75)], '90+:', T.filter(t=>t.buildScore>=90).length, '80+:', T.filter(t=>t.buildScore>=80).length);
  console.log('窗口期(≤12月):', T.filter((t) => t.ageMonths != null && t.ageMonths <= 12).length);
  console.log('90天在涨:', T.filter((t) => t.g90 > 0).length);
  console.log('长期结构性:', T.filter((t) => t.burst === 'structural').length, '新兴起势:', T.filter((t) => t.stage === 'emerging').length);
  console.log('文件大小', Math.round(fs.statSync('data/site-data.json').size / 1024), 'KB');
})().catch((e) => { console.log('失败', e.message); process.exit(1); });
