const fs = require('fs');
const path = require('path');
const R = require('./radar.js');

const ENRICH = path.join(__dirname, 'data', 'radar-enrich.json');
if (fs.existsSync(ENRICH)) {
  fs.renameSync(ENRICH, ENRICH + '.old');
  console.log('已备份旧 enrich 缓存');
}

(async () => {
  console.log('[1/3] 抓取榜单全部页面…');
  const first = await R.getRadar({ force: true, onProgress: (d, t) => { if (d % 10 === 0 || d === t) console.log('  列表 ' + d + '/' + t); } });
  console.log('榜单条数 ' + first.topics.length);

  const slugs = first.topics.map((t) => t.slug).filter(Boolean);
  console.log('[2/3] 补详情，共 ' + slugs.length + ' 条…');
  let last = 0;
  const res = await R.enrichSlugs(slugs, {
    concurrency: 10,
    onProgress: (d, t) => {
      if (d - last >= 40 || d === t) { last = d; console.log('  详情 ' + d + '/' + t); }
    },
  });
  console.log('详情完成: fetched=' + res.fetched + ' cached=' + res.cached + ' failed=' + res.failed);

  console.log('[3/3] 重算并导出完整数据…');
  const full = await R.getRadar({ force: false });
  const out = path.join(__dirname, 'data', 'site-data.json');
  fs.writeFileSync(out, JSON.stringify({ at: full.at, total: full.total, counts: full.counts, topics: full.topics }), 'utf8');
  console.log('已写入 ' + out + ' (' + Math.round(fs.statSync(out).size / 1024) + ' KB)');

  const withCls = full.topics.filter((t) => t.cls && Object.keys(t.cls).length).length;
  const withSocial = full.topics.filter((t) => t.social && Object.keys(t.social).length).length;
  const withSeason = full.topics.filter((t) => t.season).length;
  console.log('覆盖率: cls=' + withCls + ' social=' + withSocial + ' season=' + withSeason + ' / ' + full.topics.length);
  const bs = full.topics.map((t) => t.buildScore).sort((a, b) => a - b);
  console.log('buildScore 分布 min/p25/中位/p75/max = ' + [bs[0], bs[Math.floor(bs.length * 0.25)], bs[Math.floor(bs.length / 2)], bs[Math.floor(bs.length * 0.75)], bs[bs.length - 1]].join(' / '));
})().catch((e) => { console.log('失败: ' + e.message); process.exit(1); });
