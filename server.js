#!/usr/bin/env node
'use strict';

/**
 * Google Trends 飙升词探测器 —— 本地服务端
 *
 * 作用：把对 trends.google.com 的请求放到本地 Node 进程里发出（浏览器直连会被
 * CORS 和网络封锁双重拦住），并支持通过本机 HTTP / SOCKS5 代理转发。
 *
 * 依赖：仅 Node.js 内置模块，无需 npm install。
 */

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

const ROOT = __dirname;
// 本地工作台：服务 public/ 的原型界面（机会库 / 今日热榜 / 关键词分析 / 我的清单）
// 线上正式站是 dist/ 静态多语言版，由 一键部署到Cloudflare.bat 部署，两边定位不同
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshot.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');

const radar = require('./radar');

const DEFAULT_CONFIG = {
  proxy: '',            // '' = 直连；'http://127.0.0.1:7890' / 'socks5://127.0.0.1:10808'
  timeout: 15000,
  autoDetect: true,
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let config = loadConfig();

function loadConfig() {
  try {
    return Object.assign({}, DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch (e) {
    return Object.assign({}, DEFAULT_CONFIG);
  }
}

function saveConfig(next) {
  config = Object.assign({}, config, next);
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    /* 忽略写入失败 */
  }
  return config;
}

/* ------------------------------------------------------------------ */
/* 代理隧道                                                            */
/* ------------------------------------------------------------------ */

function parseProxy(proxy) {
  if (!proxy) return null;
  let raw = String(proxy).trim();
  if (!raw) return null;
  if (!/^[a-z0-9]+:\/\//i.test(raw)) raw = 'http://' + raw;
  try {
    const u = new URL(raw);
    const proto = (u.protocol || '').replace(':', '').toLowerCase();
    const port = Number(u.port) || (proto.startsWith('socks') ? 1080 : 80);
    const auth = u.username
      ? decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password || '')
      : '';
    return { proto, host: u.hostname, port, auth };
  } catch (e) {
    return null;
  }
}

// 通过 HTTP 代理建立 CONNECT 隧道
function httpTunnel(px, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host + ':' + port };
    if (px.auth) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(px.auth).toString('base64');
    const req = http.request({
      host: px.host,
      port: px.port,
      method: 'CONNECT',
      path: host + ':' + port,
      headers,
    });
    req.setTimeout(timeout, () => req.destroy(new Error('代理连接超时')));
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error('代理拒绝 CONNECT，状态码 ' + res.statusCode));
        return;
      }
      resolve(socket);
    });
    req.on('error', (e) => reject(new Error('代理不可用：' + e.message)));
    req.end();
  });
}

// 通过 SOCKS5 代理建立隧道（无认证 / 用户名密码均支持）
function socksTunnel(px, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: px.host, port: px.port });
    sock.setTimeout(timeout, () => sock.destroy(new Error('SOCKS5 连接超时')));

    let buf = Buffer.alloc(0);
    let step = 'greeting';
    let settled = false;

    const fail = (msg) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(msg));
    };

    sock.on('error', (e) => fail('SOCKS5 代理不可用：' + e.message));

    sock.on('connect', () => {
      if (px.auth) {
        const [u, p] = px.auth.split(':');
        sock.write(Buffer.concat([Buffer.from([0x05, 0x02, 0x00, 0x02])]));
        step = 'auth-methods';
        pendingAuth = { u: Buffer.from(u || ''), p: Buffer.from(p || '') };
      } else {
        sock.write(Buffer.from([0x05, 0x01, 0x00]));
        step = 'greeting';
      }
    });

    let pendingAuth = null;

    const sendConnect = () => {
      const hb = Buffer.from(host, 'utf8');
      sock.write(
        Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]),
          hb,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ])
      );
      step = 'connect';
    };

    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);

      if (step === 'auth-methods') {
        if (buf.length < 2) return;
        const method = buf[1];
        buf = buf.slice(2);
        if (method === 0x02 && pendingAuth) {
          const { u, p } = pendingAuth;
          const payload = Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]);
          sock.write(payload);
          step = 'auth';
          return;
        }
        if (method === 0x00) {
          sendConnect();
          return;
        }
        fail('SOCKS5 认证方式不被支持（code ' + method + '）');
        return;
      }

      if (step === 'auth') {
        if (buf.length < 2) return;
        if (buf[1] !== 0x00) {
          fail('SOCKS5 用户名密码校验失败');
          return;
        }
        buf = buf.slice(2);
        sendConnect();
        return;
      }

      if (step === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) {
          fail('SOCKS5 握手失败');
          return;
        }
        buf = buf.slice(2);
        sendConnect();
        return;
      }

      if (step === 'connect') {
        if (buf.length < 5) return;
        const rep = buf[1];
        if (rep !== 0x00) {
          fail('SOCKS5 连接目标被拒绝（code ' + rep + '）');
          return;
        }
        const atyp = buf[3];
        let need;
        if (atyp === 0x01) need = 4 + 4 + 2;
        else if (atyp === 0x03) need = 4 + 1 + buf[4] + 2;
        else if (atyp === 0x04) need = 4 + 16 + 2;
        else {
          fail('SOCKS5 返回了未知地址类型');
          return;
        }
        if (buf.length < need) return;
        settled = true;
        sock.removeAllListeners('data');
        resolve(sock);
      }
    });
  });
}

function openTunnel(px, host, port, timeout) {
  const t = timeout || 20000;
  if (px.proto.startsWith('socks')) return socksTunnel(px, host, port, t);
  return httpTunnel(px, host, port, t);
}

// 自定义 Agent：把已经建好（含 TLS 握手）的 socket 交给 http 模块去复用
class TunnelAgent extends https.Agent {
  constructor(socket) {
    super({ keepAlive: false, maxSockets: 1 });
    this._tunnelSocket = socket;
    this._used = false;
  }
  createConnection() {
    this._used = true;
    return this._tunnelSocket;
  }
}

function tlsWrap(socket, host) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket, servername: host, servername_host: host });
    s.setTimeout(20000, () => s.destroy(new Error('TLS 握手超时')));
    s.once('secureConnect', () => {
      s.setTimeout(0);
      s.setNoDelay(true);
      resolve(s);
    });
    s.once('error', (e) => reject(new Error('TLS 握手失败：' + e.message)));
  });
}

/* ------------------------------------------------------------------ */
/* 通用请求                                                            */
/* ------------------------------------------------------------------ */

async function fetchUrl(targetUrl, opts) {
  opts = opts || {};
  const u = new URL(targetUrl);
  const timeout = opts.timeout || config.timeout || 25000;
  const px = parseProxy(config.proxy);

  const headers = Object.assign(
    {
      'User-Agent': UA,
      Accept: opts.accept || '*/*',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
    opts.headers || {}
  );
  if (opts.body != null) {
    headers['Content-Length'] = Buffer.byteLength(opts.body);
  }

  let agent;
  if (px) {
    const rawSocket = await openTunnel(px, u.hostname, Number(u.port) || 443, Math.min(timeout, 15000));
    const secure = await tlsWrap(rawSocket, u.hostname);
    agent = new TunnelAgent(secure);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: u.hostname,
        port: Number(u.port) || 443,
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers,
        agent,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            viaProxy: !!px,
          });
        });
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时（' + timeout + 'ms），目标站点无响应')));
    req.on('error', (e) => reject(e));
    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}

function stripXssi(text) {
  return String(text || '').replace(/^\)\]\}'[^\n]*\n?/, '');
}

function tzOffset() {
  // Google Trends 用「相对 UTC 的分钟偏移」，东八区为 -480
  return new Date().getTimezoneOffset();
}

async function trendsJson(pathAndQuery) {
  const url = 'https://trends.google.com' + pathAndQuery;
  const r = await fetchUrl(url, {
    accept: 'application/json, text/plain, */*',
    headers: { Referer: 'https://trends.google.com/trends/explore', 'X-Requested-With': 'XMLHttpRequest' },
  });
  if (r.status === 429) throw new Error('Google 限流（HTTP 429），请稍后再试或更换代理出口');
  if (r.status !== 200) throw new Error('Google Trends 返回 HTTP ' + r.status);
  const body = stripXssi(r.body);
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error('返回内容不是 JSON，可能被中间网络拦截了');
  }
}

/* ------------------------------------------------------------------ */
/* Google Trends 业务                                                  */
/* ------------------------------------------------------------------ */

function parseTraffic(s) {
  if (!s) return 0;
  const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([KMB]?)/i);
  if (!m) return 0;
  let n = parseFloat(m[1]);
  const unit = (m[2] || '').toUpperCase();
  if (unit === 'K') n *= 1e3;
  else if (unit === 'M') n *= 1e6;
  else if (unit === 'B') n *= 1e9;
  return Math.round(n);
}

function normalizeDaily(json, geo) {
  const days = (json && json.default && json.default.trendingSearchesDays) || [];
  const out = [];
  for (const day of days) {
    for (const t of day.trendingSearches || []) {
      const title = t.title || {};
      const articles = (t.articles || []).map((a) => ({
        title: a.title,
        url: a.url,
        source: a.source,
        timeAgo: a.timeAgo,
        snippet: a.snippet,
      }));
      out.push({
        query: title.query || '',
        traffic: t.formattedTraffic || '',
        trafficValue: parseTraffic(t.formattedTraffic),
        exploreLink: title.exploreLink ? 'https://trends.google.com' + title.exploreLink : '',
        related: (t.relatedQueries || []).map((q) => q.query).filter(Boolean),
        articles,
        image: (t.image && t.image.imageUrl) || '',
        date: day.formattedDate || '',
        dateKey: day.date || '',
        geo,
      });
    }
  }
  return out;
}

// RSS 兜底：dailytrends 接口对部分地区不可用时使用
async function dailyFromRss(geo) {
  const r = await fetchUrl('https://trends.google.com/trends/trendingsearches/daily/rss?geo=' + encodeURIComponent(geo), {
    accept: 'application/rss+xml, application/xml, text/xml, */*',
  });
  if (r.status !== 200) throw new Error('RSS 返回 HTTP ' + r.status);
  const xml = r.body || '';
  const items = [];
  const blocks = xml.split(/<item>/i).slice(1);
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'i'));
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
    };
    const title = pick('title');
    if (!title) continue;
    items.push({
      query: title,
      traffic: pick('ht:approx_traffic'),
      trafficValue: parseTraffic(pick('ht:approx_traffic')),
      exploreLink: 'https://trends.google.com/trends/explore?q=' + encodeURIComponent(title) + '&geo=' + geo,
      related: [],
      articles: (() => {
        const list = [];
        const re = /<ht:news_item>([\s\S]*?)<\/ht:news_item>/gi;
        let m;
        while ((m = re.exec(b))) {
          const nb = m[1];
          const nt = nb.match(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/i);
          const nu = nb.match(/<ht:news_item_url>([\s\S]*?)<\/ht:news_item_url>/i);
          const ns = nb.match(/<ht:news_item_source>([\s\S]*?)<\/ht:news_item_source>/i);
          const clean = (v) => (v ? v.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').trim() : '');
          if (nt) list.push({ title: clean(nt[1]), url: clean(nu && nu[1]), source: clean(ns && ns[1]) });
        }
        return list;
      })(),
      image: '',
      date: '',
      dateKey: '',
      geo,
      viaRss: true,
    });
  }
  return items;
}

const cache = new Map();
const CACHE_TTL = 90 * 1000;

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
  return null;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function getDailyTrends(geo) {
  const key = 'daily:' + geo;
  const cached = cacheGet(key);
  if (cached) return cached;

  let items;
  let source = 'api';
  try {
    const json = await trendsJson(`/trends/api/dailytrends?hl=en-US&tz=${tzOffset()}&geo=${encodeURIComponent(geo)}&ns=15`);
    items = normalizeDaily(json, geo);
    if (!items.length) throw new Error('该地区暂无数据');
  } catch (e) {
    // 部分小地区 dailytrends 不返回内容，退回 RSS
    const rss = await dailyFromRss(geo);
    if (!rss.length) throw e;
    items = rss;
    source = 'rss';
  }
  items.sort((a, b) => b.trafficValue - a.trafficValue);
  return cacheSet(key, { geo, source, items, fetchedAt: Date.now() });
}

async function getExploreWidgets(keyword, geo, time) {
  const reqObj = {
    comparisonItem: [{ keyword, geo, time, category: 0 }],
    category: 0,
    property: '',
  };
  const json = await trendsJson(
    `/trends/api/explore?hl=en-US&tz=${tzOffset()}&req=${encodeURIComponent(JSON.stringify(reqObj))}`
  );
  return (json && json.widgets) || [];
}

function fmtGain(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return '+' + v + '%';
}

async function getKeywordInsight(keyword, geo, time) {
  const widgets = await getExploreWidgets(keyword, geo, time);

  const result = {
    keyword,
    geo,
    time,
    rising: [],
    top: [],
    timeline: [],
    source: 'api',
  };

  const relWidget = widgets.find((w) => w.id === 'RELATED_QUERIES');
  if (relWidget) {
    const url =
      `/trends/api/widgetdata/relatedsearches?hl=en-US&tz=${tzOffset()}` +
      `&req=${encodeURIComponent(JSON.stringify(relWidget.request))}` +
      `&token=${encodeURIComponent(relWidget.token)}`;
    const json = await trendsJson(url);
    const list = (json && json.default && json.default.rankedList) || [];
    const metrics = (relWidget.request && relWidget.request.metric) || ['TOP', 'RISING'];
    list.forEach((group, i) => {
      const metric = metrics[i] || (i === 0 ? 'TOP' : 'RISING');
      const rows = (group.rankedKeyword || [])
        .filter((r) => r.query)
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

  const tsWidget = widgets.find((w) => w.id === 'TIMESERIES');
  if (tsWidget) {
    try {
      const url =
        `/trends/api/widgetdata/multiline?hl=en-US&tz=${tzOffset()}` +
        `&req=${encodeURIComponent(JSON.stringify(tsWidget.request))}` +
        `&token=${encodeURIComponent(tsWidget.token)}`;
      const json = await trendsJson(url);
      const tl = (json && json.default && json.default.timelineData) || [];
      result.timeline = tl.map((p) => ({
        t: p.formattedTime || p.formattedAxisTime || '',
        tAxis: p.formattedAxisTime || p.formattedTime || '',
        v: Array.isArray(p.value) ? p.value[0] : p.value,
      }));
    } catch (e) {
      /* 时间线失败不影响主结果 */
    }
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* 免代理数据源（第三方聚合） + 本地快照                                */
/* ------------------------------------------------------------------ */

const AGGREGATOR_URL = 'https://hottrends.ai/api/topics';
const AGGREGATOR_NAME = 'hottrends.ai（聚合 Google Trends 实时热搜）';

function fmtScore(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M+';
  if (v >= 1e3) return Math.round(v / 1e3) + 'K+';
  return String(v);
}

function parseRelated(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.filter(Boolean) : [];
  } catch (e) {
    return String(v)
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&apos;/g, "'")
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// 免代理通道：hottrends.ai 的公开接口，国内可直连，无需任何密钥
async function getAggregatorTrends() {
  const key = 'agg';
  const cached = cacheGet(key);
  if (cached) return cached;

  const r = await fetchUrl(AGGREGATOR_URL, {
    accept: 'application/json',
    headers: { Referer: 'https://hottrends.ai/' },
    timeout: 15000,
  });
  if (r.status !== 200) throw new Error('聚合源返回 HTTP ' + r.status);
  let arr;
  try {
    arr = JSON.parse(r.body);
  } catch (e) {
    throw new Error('聚合源返回内容无法解析');
  }
  if (!Array.isArray(arr) || !arr.length) throw new Error('聚合源暂无数据');

  const items = arr
    .map((t) => {
      const title = decodeEntities(String(t.title || '').trim());
      if (!title) return null;
      const score = Number(t.trend_score) || 0;
      const src = typeof t.source === 'string' ? t.source : '';
      return {
        query: title,
        traffic: fmtScore(score),
        trafficValue: score,
        exploreLink:
          'https://trends.google.com/trends/explore?q=' + encodeURIComponent(title.slice(0, 60)) + '&geo=US',
        related: parseRelated(t.related_queries).slice(0, 5).map(decodeEntities),
        articles: [
          {
            title: decodeEntities(String(t.summary || t.details || '').replace(/<[^>]+>/g, '')).slice(0, 160),
            url: t.search_url || '',
            source: decodeEntities(src),
            timeAgo: '',
          },
        ],
        image: t.image_url || '',
        category: t.category || '',
        date: '',
        dateKey: '',
        geo: 'GLOBAL',
        aggregator: true,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.trafficValue - a.trafficValue);

  const out = {
    geo: 'GLOBAL',
    source: 'hottrends',
    sourceName: AGGREGATOR_NAME,
    items,
    fetchedAt: Date.now(),
  };
  return cacheSet(key, out);
}

function readSnapshot() {
  try {
    const j = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    if (j && j.geos) return j;
  } catch (e) {
    /* 没有快照 */
  }
  return { savedAt: 0, geos: {} };
}

function writeSnapshot(geo, block) {
  try {
    const snap = readSnapshot();
    snap.geos[geo] = {
      geo,
      source: block.source || 'google',
      sourceName: block.sourceName || '',
      items: block.items || [],
      fetchedAt: block.fetchedAt || Date.now(),
    };
    snap.savedAt = Date.now();
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap, null, 1), 'utf8');
  } catch (e) {
    /* 快照写入失败不影响主流程 */
  }
}

/* ------------------------------------------------------------------ */
/* 翻译（免费接口 + 本地缓存）                                          */
/* ------------------------------------------------------------------ */

const T_CACHE_FILE = path.join(DATA_DIR, 'translate-cache.json');
const T_CACHE_MAX = 20000;
let tCache = null;
let tDirty = false;
let tTimer = null;

function tLoad() {
  if (tCache) return tCache;
  try {
    tCache = JSON.parse(fs.readFileSync(T_CACHE_FILE, 'utf8')) || {};
  } catch (e) {
    tCache = {};
  }
  return tCache;
}

function tFlush() {
  if (!tDirty) return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const c = tLoad();
    const keys = Object.keys(c);
    if (keys.length > T_CACHE_MAX) {
      // 简单淘汰：删掉前 20% 的老条目
      for (const k of keys.slice(0, Math.floor(keys.length * 0.2))) delete c[k];
    }
    fs.writeFileSync(T_CACHE_FILE, JSON.stringify(c), 'utf8');
    tDirty = false;
  } catch (e) {
    /* 忽略 */
  }
}

function tSet(k, v) {
  const c = tLoad();
  if (c[k] === v) return;
  c[k] = v;
  tDirty = true;
  clearTimeout(tTimer);
  tTimer = setTimeout(tFlush, 3000);
  if (tTimer.unref) tTimer.unref();
}

process.on('exit', tFlush);

function hasCJK(s) {
  return /[\u4e00-\u9fa5]/.test(s);
}

/* 短关键词直接翻质量差（Cordless Vacuum → “无绳真空”），
   套一层商品语境再翻，模型才会给出“无绳吸尘器”。 */
const KW_PREFIX = /^\s*(产品名称|商品名称|产品|商品|product|Product|PRODUCT)\s*[：:]\s*/;

function isPhrase(s) {
  return s.trim().split(/\s+/).length <= 4 && !/[.!?]$/.test(s.trim());
}

function ckey(s) {
  return isPhrase(s) ? '@kw@' + s : s;
}

function stripKw(s) {
  return String(s || '')
    .replace(/^[\s"'“”]+|[\s"'“”。.]+$/g, '')
    .replace(KW_PREFIX, '')
    .replace(/^[\s：:]+/, '')
    .trim();
}

// 腾讯交互翻译（免费公开接口，支持批量，国内可直连）
async function tencentTranslate(texts) {
  const body = JSON.stringify({
    header: { fn: 'auto_translation', client_key: 'browser-chrome-110.0.0' },
    type: 'plain',
    model_category: 'normal',
    source: { lang: 'en', text_list: texts },
    target: { lang: 'zh' },
  });
  const r = await fetchUrl('https://transmart.qq.com/api/imt', {
    method: 'POST',
    accept: 'application/json',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://transmart.qq.com',
      Referer: 'https://transmart.qq.com/',
    },
    body,
    timeout: 15000,
  });
  if (r.status !== 200) throw new Error('腾讯翻译 HTTP ' + r.status);
  const j = JSON.parse(r.body);
  const arr = j && j.auto_translation;
  if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error('腾讯翻译返回格式异常');
  return arr;
}

// 有道（免费 demo 接口，单条）
async function youdaoTranslate(text) {
  const url =
    'https://aidemo.youdao.com/trans?q=' +
    encodeURIComponent(text.slice(0, 1000)) +
    '&from=en&to=zh-CHS';
  const r = await fetchUrl(url, { accept: 'application/json', timeout: 12000 });
  if (r.status !== 200) throw new Error('有道翻译 HTTP ' + r.status);
  const j = JSON.parse(r.body);
  let t = j && j.translation;
  if (Array.isArray(t)) t = t.join('');
  if (!t) throw new Error('有道翻译无结果');
  return t;
}

// MyMemory（兜底）
async function myMemoryTranslate(text) {
  const url =
    'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text.slice(0, 500)) + '&langpair=en|zh-CN';
  const r = await fetchUrl(url, { accept: 'application/json', timeout: 12000 });
  if (r.status !== 200) throw new Error('MyMemory HTTP ' + r.status);
  const j = JSON.parse(r.body);
  const t = j && j.responseData && j.responseData.translatedText;
  if (!t) throw new Error('MyMemory 无结果');
  return t;
}

async function translateTexts(texts) {
  const uniq = [];
  const seen = new Set();
  for (const raw of texts) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s || s.length > 600 || hasCJK(s) || seen.has(s)) continue;
    seen.add(s);
    uniq.push(s);
  }

  const c = tLoad();
  const out = {};
  const need = [];
  for (const s of uniq) {
    if (c[ckey(s)]) out[s] = c[ckey(s)];
    else need.push(s);
  }
  if (!need.length) return { map: out, provider: 'cache', translated: 0 };

  let provider = 'none';
  let rest = need.slice();

  // 一级：腾讯批量（短语套商品语境）
  try {
    for (let i = 0; i < rest.length; i += 20) {
      const chunk = rest.slice(i, i + 20);
      const payload = chunk.map((s) => (isPhrase(s) ? 'product: ' + s : s));
      const got = await tencentTranslate(payload);
      chunk.forEach((src, idx) => {
        let zh = String(got[idx] == null ? '' : got[idx]).trim();
        if (isPhrase(src)) zh = stripKw(zh);
        if (zh) {
          out[src] = zh;
          tSet(ckey(src), zh);
        }
      });
      provider = 'tencent';
    }
    rest = rest.filter((s) => !out[s]);
  } catch (e) {
    provider = 'tencent-failed';
  }

  // 二级：有道（单条，限流宽松处理）
  if (rest.length) {
    const limit = rest.slice(0, 20);
    for (const s of limit) {
      try {
        let zh = await youdaoTranslate(s);
        if (isPhrase(s)) zh = stripKw(zh);
        out[s] = zh;
        tSet(ckey(s), zh);
        provider = 'youdao';
      } catch (e) {
        /* 换下一条 */
      }
    }
    rest = rest.filter((s) => !out[s]);
  }

  // 三级：MyMemory
  if (rest.length) {
    for (const s of rest.slice(0, 10)) {
      try {
        let zh = await myMemoryTranslate(s);
        if (isPhrase(s)) zh = stripKw(zh);
        out[s] = zh;
        tSet(ckey(s), zh);
        provider = 'mymemory';
      } catch (e) {
        /* 放弃 */
      }
    }
    rest = rest.filter((s) => !out[s]);
  }

  tFlush();
  return { map: out, provider, translated: Object.keys(out).length, missing: rest.length };
}

/* ------------------------------------------------------------------ */
/* 代理探测                                                            */
/* ------------------------------------------------------------------ */

const CANDIDATE_PROXIES = [
  { proto: 'http', host: '127.0.0.1', port: 7890, label: 'Clash / Mihomo 混合端口' },
  { proto: 'http', host: '127.0.0.1', port: 7897, label: 'Clash Verge' },
  { proto: 'http', host: '127.0.0.1', port: 10809, label: 'v2rayN HTTP' },
  { proto: 'http', host: '127.0.0.1', port: 10808, label: 'v2rayN SOCKS' },
  { proto: 'http', host: '127.0.0.1', port: 1080, label: '通用 SOCKS' },
  { proto: 'http', host: '127.0.0.1', port: 8080, label: '通用 HTTP' },
  { proto: 'http', host: '127.0.0.1', port: 8888, label: '通用 HTTP' },
  { proto: 'http', host: '127.0.0.1', port: 8118, label: 'Privoxy' },
  { proto: 'http', host: '127.0.0.1', port: 33210, label: 'Surge / 其他' },
  { proto: 'http', host: '127.0.0.1', port: 4780, label: 'Clash 备用' },
];

async function probeDirect() {
  try {
    const r = await fetchUrl('https://trends.google.com/trends/api/dailytrends?hl=en-US&tz=0&geo=US&ns=15', {
      timeout: 10000,
    });
    return { ok: r.status === 200, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function probeProxyUrl(proxyUrl, timeout) {
  const saved = config.proxy;
  config.proxy = proxyUrl;
  try {
    const r = await fetchUrl('https://trends.google.com/trends/api/dailytrends?hl=en-US&tz=0&geo=US&ns=15', {
      timeout: timeout || 12000,
    });
    return r.status === 200 ? { ok: true } : { ok: false, error: 'HTTP ' + r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    config.proxy = saved;
  }
}

async function autoDetect() {
  const checks = CANDIDATE_PROXIES.map(async (c) => {
    const url = c.proto + '://' + c.host + ':' + c.port;
    const r = await probeProxyUrl(url, 12000);
    return Object.assign({ url }, c, r);
  });
  const results = await Promise.all(checks);
  const good = results.filter((r) => r.ok);
  return { picked: good.length ? good[0].url : '', results };
}

/* ------------------------------------------------------------------ */
/* HTTP 服务                                                           */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const raw = Buffer.from(JSON.stringify(obj), 'utf8');
  const accept = String((res.req && res.req.headers['accept-encoding']) || '');
  // 榜单响应 2.6MB 左右，走 gzip 后约 400KB：传输更快，也不容易在弱网下被截断
  if (raw.length > 20000 && /gzip/i.test(accept)) {
    zlib.gzip(raw, (err, gz) => {
      if (err) {
        res.writeHead(code, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': raw.length,
          'Cache-Control': 'no-store',
        });
        res.end(raw);
        return;
      }
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': gz.length,
        'Content-Encoding': 'gzip',
        Vary: 'Accept-Encoding',
        'Cache-Control': 'no-store',
      });
      res.end(gz);
    });
    return;
  }
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': raw.length,
    'Cache-Control': 'no-store',
  });
  res.end(raw);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).split('?')[0];
  if (rel === '/' || rel === '') rel = '/index.html';
  const safe = path.normalize(rel).replace(/^([\\/])+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  // 与线上 Cloudflare Pages 行为对齐：/topics/ → index.html；/topics/xxx → xxx.html
  const candidates = [file];
  if (!path.extname(safe)) {
    candidates.push(path.join(PUBLIC_DIR, safe, 'index.html'));
    candidates.push(file + '.html');
  }
  const tryRead = (i) => {
    if (i >= candidates.length) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 文件不存在');
      return;
    }
    fs.readFile(candidates[i], (err, buf) => {
      if (err) return tryRead(i + 1);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(candidates[i]).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
    });
  };
  tryRead(0);
}

const REGION_DEMO = {
  US: ['openai sora 2', 'iphone 18 release', 'nba trade rumors', 'hurricane tracker', 'wordle hint'],
  GB: ['premier league results', 'storm warning uk', 'bake off winner', 'rail strike'],
  JP: ['新型 iphone 発売日', '台風 進路', '大谷翔平 ホームラン', '衆院選 速報'],
  KR: ['아이폰 신제품', '프로야구 순위', '환율 전망'],
  HK: ['颱風 路徑', '新股 認購', '樓市 減息'],
  TW: ['颱風 停班停課', '台股 收盤', '棒球 冠軍'],
  SG: ['coe price', 'mrt disruption', 'ndp 2026'],
  IN: ['ipl schedule', 'upi limit change', 'neet result'],
  DE: ['bundesliga ergebnisse', 'wetter warnung', 'strompreis'],
  FR: ['resultat ligue 1', 'greve sncf', 'meteo alerte'],
};

// 热榜垃圾条目过滤：聚合源会返回大量 Bluesky 模板刷屏（"#btc trending on Bluesky"）
function isDailySpam(it) {
  const q = String((it && it.query) || '').trim();
  const arts = ((it && it.articles) || []).map((a) => ({
    source: String((a && a.source) || ''),
    title: String((a && a.title) || ''),
  }));
  if (/#\s*trending on bluesky/i.test(q)) return true;
  if (q.startsWith('#') && arts.some((a) => a.source === 'Bluesky')) return true;
  if (
    arts.length &&
    arts.every((a) => a.source === 'Bluesky' && /gaining momentum on bluesky/i.test(a.title))
  ) {
    return true;
  }
  return false;
}

function cleanDailyBlock(v) {
  if (v && Array.isArray(v.items)) v.items = v.items.filter((it) => !isDailySpam(it));
  return v;
}

function demoData(geo) {  const base = REGION_DEMO[geo] || ['sample rising query one', 'sample rising query two', 'trending topic demo'];
  const items = base.map((q, i) => ({
    query: q,
    traffic: ['500K+', '200K+', '100K+', '50K+', '20K+'][i % 5],
    trafficValue: [500000, 200000, 100000, 50000, 20000][i % 5],
    exploreLink: 'https://trends.google.com/trends/explore?q=' + encodeURIComponent(q) + '&geo=' + geo,
    related: ['related term A', 'related term B'].slice(0, (i % 2) + 1),
    articles: [
      {
        title: '（示例数据，非真实抓取）' + q + ' 的相关报道',
        url: '',
        source: 'demo',
        timeAgo: '1 小时前',
      },
    ],
    image: '',
    date: '',
    dateKey: '',
    geo,
    demo: true,
  }));
  return { geo, source: 'demo', items, fetchedAt: Date.now(), demo: true };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  if (!p.startsWith('/api/')) {
    serveStatic(req, res, p);
    return;
  }

  try {
    if (p === '/api/status') {
      const snap = readSnapshot();
      return sendJson(res, 200, {
        ok: true,
        proxy: config.proxy || '',
        timeout: config.timeout,
        node: process.version,
        snapshotAt: snap.savedAt || 0,
        snapshotGeos: Object.keys(snap.geos).length,
        radar: radar.cacheInfo(),
      });
    }

    /* ---- 机会雷达：商业化趋势（免代理，替代每日新闻向榜单） ---- */

    if (p === '/api/radar') {
      const force = u.searchParams.get('force') === '1';
      try {
        const r = await radar.getRadar({ force });
        return sendJson(res, 200, Object.assign({ ok: true }, r));
      } catch (e) {
        return sendJson(res, 200, {
          ok: false,
          error: '这次没能取到最新榜单：' + e.message,
          hint: '页面会自动改用上一次缓存的数据。想强制重取，可以稍等几分钟再点一次「刷新数据」。',
        });
      }
    }

    if (p === '/api/radar/enrich' && req.method === 'POST') {
      const body = await readBody(req);
      const slugs = Array.isArray(body.slugs) ? body.slugs.filter((s) => typeof s === 'string').slice(0, 200) : [];
      if (!slugs.length) return sendJson(res, 400, { ok: false, error: 'slugs 不能为空' });
      try {
        const r = await radar.enrichSlugs(slugs);
        return sendJson(res, 200, Object.assign({ ok: true }, r));
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: '补全详情失败：' + e.message });
      }
    }

    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const next = {};
      if (typeof body.proxy === 'string') next.proxy = body.proxy.trim();
      if (body.timeout) next.timeout = Math.max(5000, Math.min(60000, Number(body.timeout)));
      saveConfig(next);
      return sendJson(res, 200, { ok: true, proxy: config.proxy, timeout: config.timeout });
    }

    if (p === '/api/test') {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const target = typeof body.proxy === 'string' ? body.proxy.trim() : config.proxy;
      if (target) {
        const r = await probeProxyUrl(target, 15000);
        return sendJson(res, 200, Object.assign({ mode: 'proxy', proxy: target }, r));
      }
      const r = await probeDirect();
      return sendJson(res, 200, Object.assign({ mode: 'direct' }, r));
    }

    if (p === '/api/detect') {
      const r = await autoDetect();
      if (r.picked) saveConfig({ proxy: r.picked });
      return sendJson(res, 200, { ok: !!r.picked, picked: r.picked, results: r.results });
    }

    if (p === '/api/demo') {
      const geos = (u.searchParams.get('geos') || 'US').split(',').filter(Boolean);
      const data = {};
      for (const g of geos) data[g] = demoData(g);
      return sendJson(res, 200, { ok: true, data, demo: true });
    }

    if (p === '/api/daily') {
      const geos = (u.searchParams.get('geos') || 'US')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 12);
      if (!geos.length) return sendJson(res, 400, { ok: false, error: '请至少选择一个地区' });

      // ── 一级：Google Trends 官方内部接口（需本机可访问 Google）
      const entries = await Promise.all(
        geos.map(async (g) => {
          try {
            return [g, await getDailyTrends(g)];
          } catch (e) {
            return [g, { geo: g, error: e.message, items: [] }];
          }
        })
      );
      const data = {};
      let okCount = 0;
      for (const [g, v] of entries) {
        data[g] = v;
        if (!v.error) {
          okCount++;
          writeSnapshot(g, v);
        }
      }
      if (okCount > 0) {
        for (const g of Object.keys(data)) {
          cleanDailyBlock(data[g]);
        }
        return sendJson(res, 200, { ok: true, mode: 'google', data, proxy: config.proxy || 'direct' });
      }

      const firstError = (entries[0] && entries[0][1] && entries[0][1].error) || '未知错误';

      // ── 二级：免代理聚合源（国内可直连）
      try {
        const agg = await getAggregatorTrends();
        cleanDailyBlock(agg);
        writeSnapshot('GLOBAL', agg);
        const out = {};
        out.GLOBAL = agg;
        return sendJson(res, 200, {
          ok: true,
          mode: 'aggregator',
          data: out,
          proxy: config.proxy || 'direct',
          error: firstError,
          note:
            'Google 官方接口当前不可达（' + firstError + '），已自动切换到免代理聚合源：' +
            AGGREGATOR_NAME +
            '。这里展示的是实时热搜话题与相关搜索词，形式为新闻标题，与 Trends 原始搜索词列表略有差异。',
        });
      } catch (e2) {
        // ── 三级：本地快照
        const snap = readSnapshot();
        const picked = {};
        for (const g of geos) if (snap.geos[g]) picked[g] = snap.geos[g];
        if (!Object.keys(picked).length && snap.geos.GLOBAL) picked.GLOBAL = snap.geos.GLOBAL;
        if (Object.keys(picked).length) {
          return sendJson(res, 200, {
            ok: true,
            mode: 'snapshot',
            data: picked,
            savedAt: snap.savedAt,
            error: firstError,
            note:
              '实时接口与免代理聚合源都不可用，当前展示本地缓存快照（保存于 ' +
              new Date(snap.savedAt).toLocaleString('zh-CN') +
              '），仅供参照。',
          });
        }
        // ── 四级：彻底失败
        return sendJson(res, 200, {
          ok: false,
          error: firstError + '；聚合源也不可用（' + e2.message + '）；本地没有可用快照。',
          proxy: config.proxy || 'direct',
          hint:
            '如果所有渠道都失败，通常说明网络被完全限制。可先配置本机代理再抓取；' +
            '抓取成功后会自动保存本地快照，之后断网也能看最后一次的数据。',
        });
      }
    }

    if (p === '/api/keyword') {
      const q = (u.searchParams.get('q') || '').trim();
      const geo = (u.searchParams.get('geo') || 'US').toUpperCase();
      const time = u.searchParams.get('time') || 'now 7-d';
      if (!q) return sendJson(res, 400, { ok: false, error: '请输入关键词' });
      try {
        const data = await getKeywordInsight(q, geo, time);
        return sendJson(res, 200, { ok: true, mode: 'google', data, proxy: config.proxy || 'direct' });
      } catch (e) {
        // 官方接口不可用时，退到免代理聚合源里做一次本地匹配
        let localMatches = [];
        try {
          const agg = await getAggregatorTrends();
          const kw = q.toLowerCase();
          localMatches = agg.items
            .filter(
              (it) =>
                it.query.toLowerCase().includes(kw) ||
                (it.related || []).some((r) => String(r).toLowerCase().includes(kw)) ||
                (it.category || '').toLowerCase().includes(kw)
            )
            .slice(0, 12);
        } catch (e3) {
          /* 聚合源也不行 */
        }
        return sendJson(res, 200, {
          ok: false,
          mode: localMatches.length ? 'aggregator' : 'none',
          error: 'Google Trends 接口不可达：' + e.message,
          localMatches,
          hint:
            '权威的 RISING 涨幅数据必须由 Google 官方接口提供，需要配置本机代理。' +
            (localMatches.length ? '下面是从免代理聚合源中匹配到的相关热搜话题。' : ''),
        });
      }
    }

    if (p === '/api/translate' && req.method === 'POST') {
      const body = await readBody(req);
      const texts = Array.isArray(body.texts) ? body.texts.slice(0, 80) : [];
      if (!texts.length) return sendJson(res, 400, { ok: false, error: 'texts 不能为空' });
      const r = await translateTexts(texts);
      return sendJson(res, 200, Object.assign({ ok: true }, r));
    }

    if (p === '/api/aggregator') {
      try {
        const agg = await getAggregatorTrends();
        cleanDailyBlock(agg);
        writeSnapshot('GLOBAL', agg);
        return sendJson(res, 200, { ok: true, data: agg });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: e.message });
      }
    }

    if (p === '/api/snapshot') {
      const snap = readSnapshot();
      return sendJson(res, 200, {
        ok: Object.keys(snap.geos).length > 0,
        savedAt: snap.savedAt,
        geos: Object.keys(snap.geos),
        data: snap.geos,
      });
    }

    if (p === '/api/raw') {
      // 调试用：直接把 Google Trends 的原始返回吐出来，便于排查接口结构变化
      const target = u.searchParams.get('path') || '';
      if (!target.startsWith('/trends/')) return sendJson(res, 400, { ok: false, error: 'path 必须以 /trends/ 开头' });
      const r = await fetchUrl('https://trends.google.com' + target, {
        accept: 'application/json, text/plain, */*',
        headers: { Referer: 'https://trends.google.com/trends/explore' },
      });
      return sendJson(res, 200, { ok: r.status === 200, status: r.status, body: r.body.slice(0, 20000) });
    }

    return sendJson(res, 404, { ok: false, error: '接口不存在: ' + p });
  } catch (e) {
    return sendJson(res, 200, {
      ok: false,
      error: e.message || String(e),
      proxy: config.proxy || 'direct',
      hint:
        '如果是连接类错误（ECONNRESET / ETIMEDOUT / 超时），说明当前出口访问不了 trends.google.com，' +
        '请在「连接设置」里填写本机代理端口，或开启代理软件的 TUN / 全局模式。',
    });
  }
});

function findPort(start, tries) {
  return new Promise((resolve) => {
    let port = start;
    let left = tries == null ? 20 : tries;
    const attempt = () => {
      const s = net.createServer();
      s.once('error', () => {
        s.close();
        port++;
        left--;
        if (left <= 0) resolve(port);
        else attempt();
      });
      s.once('listening', () => s.close(() => resolve(port)));
      s.listen(port, '127.0.0.1');
    };
    attempt();
  });
}

function start() {
  return findPort(Number(process.env.PORT || 8787), 20).then((port) => {
    const url = 'http://127.0.0.1:' + port;
    server.listen(port, '127.0.0.1', () => {
      console.log('');
      console.log('  Google Trends 飙升词探测器已启动');
      console.log('  ────────────────────────────────────────');
      console.log('  请用浏览器打开：' + url);
      console.log('  当前代理设置：' + (config.proxy || '直连（未设置代理）'));
      console.log('  关闭本窗口即停止服务');
      console.log('');
      if (process.platform === 'win32' && !process.env.NO_OPEN) {
        try {
          require('child_process').exec('start "" "' + url + '"');
        } catch (e) {
          /* 打不开就让用户手动复制 */
        }
      }
    });
    return port;
  });
}

if (require.main === module) {
  start();
}

module.exports = {
  start,
  config,
  saveConfig,
  fetchUrl,
  parseProxy,
  openTunnel,
  getDailyTrends,
  getKeywordInsight,
  getAggregatorTrends,
  translateTexts,
  readSnapshot,
  writeSnapshot,
  normalizeDaily,
  dailyFromRss,
  parseTraffic,
  probeProxyUrl,
  autoDetect,
};
