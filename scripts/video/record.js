/**
 * TrendSift 宣传片录制脚本（字幕在页面内渲染，录进画面，不依赖 ffmpeg 滤镜）
 *
 * 用法：node scripts/video/record.js
 * 前置：dist 已构建；静态服务 127.0.0.1:8899
 */
const fs = require('fs');
const path = require('path');
const PW = 'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const { chromium } = require(PW);

const BASE = 'http://127.0.0.1:8899';
const OUT = path.join(__dirname, 'out');
const W = 1920;
const H = 1080;

const timeline = [];
let t0 = 0;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function smoothScroll(page, toY, ms) {
  await page.evaluate(
    ([toY, ms]) =>
      new Promise((resolve) => {
        const startY = window.scrollY;
        const delta = toY - startY;
        const start = performance.now();
        const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
        function step(now) {
          const p = Math.min(1, (now - start) / ms);
          window.scrollTo(0, startY + delta * ease(p));
          if (p < 1) requestAnimationFrame(step);
          else resolve();
        }
        requestAnimationFrame(step);
      }),
    [toY, ms]
  );
}

// 字幕层：固定底部居中，白字黑描边，淡入淡出
const SUB_INIT = () => {
  const CSS = `
    #__sub{position:fixed;left:0;right:0;bottom:80px;text-align:center;z-index:2147483647;
      pointer-events:none;font-family:"Microsoft YaHei","Segoe UI",system-ui,sans-serif;
      font-size:50px;font-weight:700;color:#fff;letter-spacing:1.5px;line-height:1.35;
      text-shadow:0 0 3px #000,0 0 10px rgba(0,0,0,.95),0 4px 18px rgba(0,0,0,.8);
      opacity:0;transition:opacity .2s ease;padding:0 90px}
    #__sub.on{opacity:1}
    #__sub.big{font-size:84px;bottom:250px;letter-spacing:3px}`;
  const mount = () => {
    if (!document.body) return;
    let st = document.getElementById('__subStyle');
    if (!st) {
      st = document.createElement('style');
      st.id = '__subStyle';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    let d = document.getElementById('__sub');
    if (!d) {
      d = document.createElement('div');
      d.id = '__sub';
      document.body.appendChild(d);
      if (window.__subText) {
        d.textContent = window.__subText;
        d.className = window.__subBig ? 'on big' : 'on';
      }
    }
  };
  window.__subSet = (text, big) => {
    window.__subText = text;
    window.__subBig = !!big;
    mount();
    const d = document.getElementById('__sub');
    if (!d) return;
    d.classList.remove('on');
    setTimeout(() => {
      d.textContent = text;
      d.className = (big ? 'big ' : '') + 'on';
    }, 190);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.webm')) fs.unlinkSync(path.join(OUT, f));

  const browser = await chromium.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--font-render-hinting=none'],
  });
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    recordVideo: { dir: OUT, size: { width: W, height: H } },
    locale: 'zh-CN',
    proxy: { server: 'direct://' },
  });
  await ctx.addInitScript(SUB_INIT);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);

  // 字幕改为后期 ffmpeg 烧录（页面内渲染会触发 screencast 增量编码残影），
  // 这里只记录时间轴：mark() 打点 → timeline.json → make-video.js 生成 ASS。
  let current = null;
  const sub = async () => {};
  const mark = (text) => {
    timeline.push({ t: +((Date.now() - t0) / 1000).toFixed(2), text });
  };
  const go = async (url) => {
    await page.goto(BASE + url, { waitUntil: 'networkidle', timeout: 40000 });
    if (current) await sub(current.text, current.big); // 导航后字幕层重建，补回当前文字
  };

  t0 = Date.now();
  await go('/');
  await sub('TrendSift', true);
  await wait(1500);
  await sub('Google Trends 只告诉你什么在涨', true);
  mark('Google Trends 只告诉你什么在涨');
  await wait(2100);
  await sub('没告诉你：现在还来不来得及');
  mark('没告诉你：现在还来不来得及');
  await wait(2100);

  await sub('TrendSift 把 800 多个上升词，排成一张可排序的表');
  mark('TrendSift 把 800 多个上升词，排成一张可排序的表');
  await smoothScroll(page, 620, 1400);
  await wait(2300);
  await smoothScroll(page, 1250, 1600);
  await wait(2300);

  await sub('每个词都有详情页：曲线、季节峰值、上升相关词');
  mark('每个词都有详情页：曲线、季节峰值、上升相关词');
  await go('/topics/shoe-bag');
  await wait(1900);
  await smoothScroll(page, 760, 1500);
  await wait(2100);
  await smoothScroll(page, 1450, 1500);
  await wait(1700);

  await sub('五种语言，原词和译文对照着看');
  mark('五种语言，原词和译文对照着看');
  await go('/en/');
  await wait(2300);

  await sub('输入任意关键词，实时分析');
  mark('输入任意关键词，实时分析');
  await go('/lookup/');
  await wait(1500);
  const input = page.locator('#kwInput');
  if (await input.count()) {
    await input.click();
    await input.type('camping gear', { delay: 120 });
    await wait(1300);
  }

  await sub('全球热榜，每天更新两次');
  mark('全球热榜，每天更新两次');
  await go('/daily.html');
  await wait(2400);
  await smoothScroll(page, 500, 1400);
  await wait(1900);

  await sub('trendsift.site', true);
  mark('trendsift.site  ·  免费，不用注册');
  await go('/');
  await wait(3000);

  const video = page.video();
  await ctx.close();
  await browser.close();

  const src = await video.path();
  fs.renameSync(src, path.join(OUT, 'raw.webm'));

  const dur = (Date.now() - t0) / 1000;
  fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify({ duration: +dur.toFixed(2), marks: timeline }, null, 2));
  console.log('录制完成：out/raw.webm');
  console.log('时长 ' + dur.toFixed(1) + ' 秒，字幕 ' + timeline.length + ' 条');
  timeline.forEach((m) => console.log('  ' + m.t + 's  ' + m.text));
})().catch((e) => {
  console.error('录制失败：', e.message);
  process.exit(1);
});
