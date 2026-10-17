'use strict';

/**
 * 相似词计算
 *
 * 一开始按「曲线形状相关」做，结果不能用：871 条词几乎都在涨，任意两条的
 * 皮尔逊系数都在 0.9 以上，Cordless Vacuum 会推荐 Smart bidet、Label printer
 * 会推荐 Ube —— 数值相似，语义无关。
 *
 * 现在的做法是把「类目」当主信号，「曲线」只做组内排序：
 *   1. 类目按 IDF 加权 —— 共享 shoes 比共享 product 有信息量得多
 *   2. 高频泛标签（product / home / business…）再乘 0.35，它们描述的是行业层
 *      而不是品类，不加权会把整个站连成一张大网
 *   3. 标准 Jaccard 归一化 —— 用 min 归一化会让类目少的词互相过度匹配
 *   4. 曲线：log 后去掉线性趋势再算相关，只比较「节奏」（什么时候加速、回落），
 *      不比较绝对值
 *   5. 载体 / 形态 / 阶段 相同各加一点分
 *   6. 第二轮抑制枢纽：同一个词被几十条话题推荐时降权，避免推荐位同质化
 */

/** 行业层标签，不是品类：它们出现在几百条话题上，对判断相似没有帮助 */
const GENERIC = new Set([
  'product', 'home', 'lifestyle', 'business', 'technology', 'industry', 'retail',
  'health', 'cpg', 'concept', 'media', 'design', 'manufacturing', 'ecommerce',
  'workplace', 'supply-chain', 'automation', 'social', 'social-media', 'fashion',
  'personal-care',
]);

const DIM = 36; // 22 年压成 36 段，长短不一的词也能互相比
const CAND = 12; // 先留 12 个候选，做枢纽抑制后再取前 5
const K = 5;

function downsample(v, dim) {
  const n = v.length;
  if (!n) return null;
  const out = new Array(dim);
  if (n <= dim) {
    for (let i = 0; i < dim; i++) out[i] = i < n ? Number(v[i]) || 0 : 0;
    return out;
  }
  const w = n / dim;
  for (let i = 0; i < dim; i++) {
    const a = Math.floor(i * w);
    const b = Math.max(a + 1, Math.floor((i + 1) * w));
    let s = 0;
    for (let j = a; j < b && j < n; j++) s += Number(v[j]) || 0;
    out[i] = s / (b - a);
  }
  return out;
}

function zscore(v) {
  const n = v.length;
  let m = 0;
  for (let i = 0; i < n; i++) m += v[i];
  m /= n;
  let s = 0;
  for (let i = 0; i < n; i++) s += (v[i] - m) * (v[i] - m);
  const sd = Math.sqrt(s / n) || 1;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = (v[i] - m) / sd;
  return out;
}

function corrOf(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s / a.length;
}

/** log 之后用最小二乘去掉直线趋势，剩下的才是「节奏」 */
function detrend(values, dim) {
  const d = downsample(values, dim);
  if (!d) return null;
  const lg = d.map((x) => Math.log1p(x));
  const n = lg.length;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += lg[i];
    sxy += i * lg[i];
    sxx += i * i;
  }
  const den = n * sxx - sx * sx;
  const b = den ? (n * sxy - sx * sy) / den : 0;
  const a = (sy - b * sx) / n;
  return zscore(lg.map((y, i) => y - (a + b * i)));
}

/**
 * @param {Array} topics 需要 slug / hist.v / categories
 * @param {{k?:number}} opts
 * @returns {Array} 同一个数组，每条加上 similar: [{slug, r}]
 */
function buildSimilar(topics, opts) {
  opts = opts || {};
  const K2 = opts.k || K;

  const items = [];
  for (const t of topics || []) {
    if (!t || !t.slug) continue;
    const raw = t.hist && t.hist.v;
    items.push({
      t,
      curve: raw && raw.length >= 12 ? detrend(raw, DIM) : null,
      cats: new Set(t.categories || []),
    });
  }

  // 类目 IDF：出现得越少，越能说明两条词是同一门生意
  const df = {};
  const N = items.length || 1;
  for (const it of items) for (const c of it.cats) df[c] = (df[c] || 0) + 1;
  const weight = (c) => (Math.log((N + 1) / ((df[c] || 0) + 1)) + 1) * (GENERIC.has(c) ? 0.35 : 1);

  const jaccard = (a, b) => {
    let shared = 0;
    let ta = 0;
    let tb = 0;
    for (const x of a) {
      const w = weight(x);
      ta += w;
      if (b.has(x)) shared += w;
    }
    for (const x of b) tb += weight(x);
    const uni = ta + tb - shared;
    return uni > 0 ? shared / uni : 0;
  };

  const cands = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    const row = [];
    for (let j = 0; j < items.length; j++) {
      if (j === i) continue;
      const b = items[j];
      const jac = jaccard(a.cats, b.cats);
      if (jac < 0.18) continue; // 类目几乎不沾边，直接跳过
      const c = a.curve && b.curve ? corrOf(a.curve, b.curve) : 0;
      const same =
        (a.t.carrier === b.t.carrier ? 0.5 : 0) +
        (a.t.form === b.t.form ? 0.3 : 0) +
        (a.t.stage === b.t.stage ? 0.2 : 0);
      row.push({ j, score: 0.62 * jac + 0.18 * c + 0.2 * same });
    }
    row.sort((x, y) => y.score - x.score);
    cands.push(row.slice(0, CAND));
  }

  // 枢纽抑制：被推荐得越多，越要往下压，否则每个页面都是同样那几个词
  const hits = {};
  for (const row of cands) for (const x of row) hits[x.j] = (hits[x.j] || 0) + 1;

  cands.forEach((row, i) => {
    const ranked = row
      .slice()
      .sort((x, y) => y.score / (1 + 0.02 * (hits[y.j] || 0)) - x.score / (1 + 0.02 * (hits[x.j] || 0)))
      .slice(0, K2);
    items[i].t.similar = ranked.map((x) => ({
      slug: items[x.j].t.slug,
      r: Math.round(Math.min(1, x.score) * 100) / 100,
    }));
  });

  for (const t of topics || []) if (!t.similar) t.similar = [];
  return topics;
}

module.exports = { buildSimilar, downsample, zscore, corrOf, detrend, GENERIC };
