'use strict';
/**
 * 用法：node scripts/analyze-keyword.js "<关键词>" <GEO> "<time>" --out kw
 *
 * 在 GitHub Actions 里运行（runner 可直连 trends.google.com），
 * 抓取该关键词的关注度时间线 + 相关查询，连同派生指标一起
 * 写到 kw/<hash>.json，供 Cloudflare Pages Function 读取。
 * 无任何 npm 依赖。
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function trendsJson(p) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: 'trends.google.com',
        path: p,
        headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9' },
      },
      (r) => {
        let b = '';
        r.on('data', (d) => (b += d));
        r.on('end', () => {
          if (r.statusCode !== 200) {
            reject(new Error('HTTP ' + r.statusCode + ' ' + b.slice(0, 100)));
            return;
          }
          try {
            resolve(JSON.parse(b.replace(/^\)\]\}',\s*/, '')));
          } catch (e) {
            reject(new Error('parse failed: ' + b.slice(0, 80)));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}

function fmtGain(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return '+' + v + '%';
}

function computeMetrics(timeline) {
  const pts = (timeline || [])
    .filter((p) => typeof p.v === 'number' && p.time)
    .map((p) => ({ t: Number(p.time), v: p.v }));
  if (pts.length < 5) return null;
  const spanDays = (pts[pts.length - 1].t - pts[0].t) / 86400;
  const monthly = spanDays > 300;
  const n = pts.length;
  const last = pts[n - 1];
  const growth = (back) => {
    const i = n - 1 - back;
    if (i < 1) return null;
    const base = pts[i].v;
    if (!base) return null;
    return Math.round(((last.v - base) / base) * 100);
  };
  const out = { granularity: monthly ? 'monthly' : 'daily', latest: last.v, g90: null, g12: null, peakMonth: null, seasonStrength: null };
  if (monthly) {
    out.g90 = growth(3);
    out.g12 = growth(12);
    if (n >= 24) {
      const sum = new Array(12).fill(0);
      const cnt = new Array(12).fill(0);
      pts.forEach((p) => {
        const m = new Date(p.t * 1000).getUTCMonth();
        sum[m] += p.v;
        cnt[m] += 1;
      });
      const avg = sum.map((s, i) => (cnt[i] ? s / cnt[i] : 0));
      const maxAvg = Math.max.apply(null, avg);
      const minAvg = Math.min.apply(null, avg.filter((v) => v > 0).concat([0]));
      if (maxAvg > 0) {
        out.peakMonth = avg.indexOf(maxAvg);
        out.seasonStrength = Math.round(((maxAvg - (minAvg || 0)) / maxAvg) * 100);
      }
    }
  }
  return out;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function analyze(q, geo, time) {
  const reqObj = {
    comparisonItem: [{ keyword: q, geo: geo, time: time, category: 0 }],
    category: 0,
    property: '',
  };
  let widgets = null;
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      widgets = await trendsJson(
        '/trends/api/explore?hl=en-US&tz=480&req=' + encodeURIComponent(JSON.stringify(reqObj))
      );
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      await sleep(3000 * (i + 1));
    }
  }
  if (lastErr) throw lastErr;

  const list = (widgets && widgets.widgets) || [];
  const result = { ok: true, keyword: q, geo: geo, time: time, rising: [], top: [], timeline: [] };

  const relWidget = list.find((w) => w.id === 'RELATED_QUERIES');
  if (relWidget) {
    const rj = await trendsJson(
      '/trends/api/widgetdata/relatedsearches?hl=en-US&tz=480' +
        '&req=' + encodeURIComponent(JSON.stringify(relWidget.request)) +
        '&token=' + encodeURIComponent(relWidget.token)
    );
    const groups = (rj && rj.default && rj.default.rankedList) || [];
    const metrics = (relWidget.request && relWidget.request.metric) || ['TOP', 'RISING'];
    groups.forEach((group, i) => {
      const metric = metrics[i] || (i === 0 ? 'TOP' : 'RISING');
      const rows = ((group && group.rankedKeyword) || [])
        .filter((r) => r && r.query)
        .slice(0, 25)
        .map((r) => ({
          query: r.query,
          value: r.value,
          formattedValue: r.formattedValue || (metric === 'RISING' ? fmtGain(r.value) : String(r.value)),
          link: r.link ? 'https://trends.google.com' + r.link : '',
          hasData: r.hasData !== false,
        }));
      if (metric === 'RISING') result.rising = rows;
      else result.top = rows;
    });
  }

  const tsWidget = list.find((w) => w.id === 'TIMESERIES');
  if (tsWidget) {
    try {
      const tj = await trendsJson(
        '/trends/api/widgetdata/multiline?hl=en-US&tz=480' +
          '&req=' + encodeURIComponent(JSON.stringify(tsWidget.request)) +
          '&token=' + encodeURIComponent(tsWidget.token)
      );
      const tl = (tj && tj.default && tj.default.timelineData) || [];
      result.timeline = tl.map((p) => ({
        t: p.formattedTime || '',
        tAxis: p.formattedAxisTime || p.formattedTime || '',
        v: Array.isArray(p.value) ? p.value[0] : p.value,
        time: p.time,
      }));
    } catch (e) {
      /* 时间线失败不影响相关查询 */
    }
  }

  result.metrics = computeMetrics(result.timeline);
  result.fetchedAt = Date.now();

  if (!result.rising.length && !result.top.length && !result.timeline.length) {
    result.ok = false;
    result.error = 'NO_DATA';
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const q = args[0];
  const geo = (args[1] || 'US').toUpperCase();
  const time = args[2] || 'today 5-y';
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : null;
  if (!q) {
    console.error('usage: node analyze-keyword.js "<kw>" <GEO> <time> [--out dir]');
    process.exit(2);
  }

  const result = await analyze(q, geo, time);
  const body = JSON.stringify(result);

  if (outDir) {
    const hash = crypto
      .createHash('sha1')
      .update(q + '|' + geo + '|' + time)
      .digest('hex')
      .slice(0, 16);
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, hash + '.json');
    fs.writeFileSync(file, body, 'utf8');
    console.log(hash);
  } else {
    console.log(body);
  }
}

main().catch((e) => {
  // 失败也要写一个明确的错误结果，避免 Function 一直轮询等不到文件
  try {
    const args = process.argv.slice(2);
    const outIdx = args.indexOf('--out');
    if (outIdx >= 0) {
      const q = args[0] || '';
      const geo = (args[1] || 'US').toUpperCase();
      const time = args[2] || 'today 5-y';
      const hash = crypto.createHash('sha1').update(q + '|' + geo + '|' + time).digest('hex').slice(0, 16);
      fs.mkdirSync(args[outIdx + 1], { recursive: true });
      fs.writeFileSync(
        path.join(args[outIdx + 1], hash + '.json'),
        JSON.stringify({ ok: false, error: 'ANALYZE_FAILED', hint: String(e.message || e).slice(0, 200) }),
        'utf8'
      );
      console.log(hash);
      process.exit(0);
    }
  } catch (e2) {
    /* ignore */
  }
  console.error(e);
  process.exit(1);
});
