/**
 * /api/keyword?q=<关键词>&geo=US&time=today 5-y
 *
 * 三级架构（Cloudflare Pages Function）：
 * 1. 边缘缓存命中（1 小时）→ 直接返回
 * 2. 直连 Google Trends（Cloudflare IP 偶尔能通，被限流则走下一级）
 * 3. 派发 GitHub Actions（runner 可直连 Google）分析，
 *    结果提交到仓库 kw-cache 分支，本函数轮询读取（GitHub Contents API）。
 *
 * 前端收到 { error: 'QUEUED' } 后每 ~12 秒轮询本接口。
 */

const REPO = 'oiuy8765/tt';
const BRANCH = 'kw-cache';
const UA_CF = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function jsonResp(data, status, ttl) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=' + (ttl || 3600),
      'Access-Control-Allow-Origin': '*',
    },
  });
}

async function sha1hex(s) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

async function trendsJson(path) {
  const r = await fetch('https://trends.google.com' + path, {
    headers: { 'User-Agent': UA_CF, Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9' },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  const text = await r.text();
  if (!r.ok) {
    const e = new Error('HTTP ' + r.status);
    e.status = r.status;
    throw e;
  }
  return JSON.parse(text.replace(/^\)\]\}'[,\n]?\s*/, ''));
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

/* 从 kw-cache 分支读结果（Contents API，PAT 认证，5000 req/h） */
async function readResult(hash, token) {
  const r = await fetch(
    'https://api.github.com/repos/' + REPO + '/contents/kw/' + hash + '.json?ref=' + BRANCH,
    {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'trendsift-worker',
      },
      cf: { cacheTtl: 15, cacheEverything: false },
    }
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('github ' + r.status);
  const j = await r.json();
  const content = j && j.content ? j.content.replace(/\n/g, '') : '';
  return JSON.parse(atob(content));
}

/* 派发 GitHub Actions 分析任务 */
async function dispatch(q, geo, time, token) {
  const r = await fetch('https://api.github.com/repos/' + REPO + '/dispatches', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'trendsift-worker',
    },
    body: JSON.stringify({ event_type: 'keyword-analyze', client_payload: { q: q, geo: geo, time: time } }),
  });
  if (r.status !== 204 && !r.ok) {
    const t = await r.text();
    throw new Error('dispatch ' + r.status + ' ' + t.slice(0, 120));
  }
}

/* 直连 Google（成功率取决于 Cloudflare 出口 IP 是否被限流） */
async function tryDirect(q, geo, time) {
  const reqObj = {
    comparisonItem: [{ keyword: q, geo: geo, time: time, category: 0 }],
    category: 0,
    property: '',
  };
  const widgets = await trendsJson(
    '/trends/api/explore?hl=en-US&tz=480&req=' + encodeURIComponent(JSON.stringify(reqObj))
  );
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
  if (!result.rising.length && !result.top.length && !result.timeline.length) {
    return { ok: false, error: 'NO_DATA' };
  }
  return result;
}

export async function onRequestGet(context) {
  const { request, env, ctx } = context;
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  const geo = ((url.searchParams.get('geo') || 'US').toUpperCase().match(/^[A-Z]{2}$/) || ['US'])[0];
  const time = (url.searchParams.get('time') || 'today 5-y').slice(0, 32);

  if (!q) return jsonResp({ ok: false, error: 'missing q' }, 400, 60);

  const hash = await sha1hex(q + '|' + geo + '|' + time);

  // 1. 边缘缓存
  const cache = caches.default;
  const cKey = new Request('https://kwcache.trendsift.site/?h=' + hash);
  try {
    const hit = await cache.match(cKey);
    if (hit) return hit;
  } catch (e) {
    /* ignore */
  }

  // 2. 直连 Google（快速路径，429 则转 GitHub Actions）
  try {
    const direct = await tryDirect(q, geo, time);
    const resp = jsonResp(direct, 200, 3600);
    if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cKey, resp.clone()).catch(() => {}));
    return resp;
  } catch (e) {
    if (e && e.status && e.status !== 429) {
      return jsonResp(
        { ok: false, error: 'UPSTREAM', hint: 'Google Trends query failed (' + e.message + ').' },
        502,
        60
      );
    }
    /* 429 或其它 → 落到 GitHub Actions 路径 */
  }

  const token = env && env.GH_TOKEN;
  if (!token) {
    return jsonResp(
      { ok: false, error: 'UPSTREAM', hint: 'GH_TOKEN not configured for keyword analysis.' },
      500,
      60
    );
  }

  // 3. 先看 kw-cache 分支里有没有现成结果（可能已被别的请求触发过）
  let saved = null;
  try {
    saved = await readResult(hash, token);
  } catch (e) {
    /* 读失败当作没有 */
  }
  if (saved) {
    // 失败结果只保留 10 分钟，之后允许重新派发分析
    const failed = saved && saved.ok === false && saved.error && saved.error !== 'NO_DATA';
    if (!failed || !saved.fetchedAt || Date.now() - saved.fetchedAt > 10 * 60 * 1000) {
      saved = null;
    }
  }
  if (saved) {
    const resp = jsonResp(saved, 200, saved.ok ? 3600 : 600);
    if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cKey, resp.clone()).catch(() => {}));
    return resp;
  }

  // 4. 派发任务，让前端轮询
  let dispatched = true;
  try {
    await dispatch(q, geo, time, token);
  } catch (e) {
    dispatched = false;
  }
  if (!dispatched) {
    return jsonResp({ ok: false, error: 'UPSTREAM', hint: 'Failed to queue analysis job.' }, 502, 60);
  }

  const queued = jsonResp({ ok: false, error: 'QUEUED', job: hash, retryAfter: 12 }, 202, 10);
  if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cKey, queued.clone()).catch(() => {}));
  return queued;
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  return new Response('Method Not Allowed', { status: 405 });
}
