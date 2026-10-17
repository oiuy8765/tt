// 探测 Google Trends 各候选接口（只读 GET，找出 YouTube 口径可用端点）
const CANDIDATES = [
  // 新版 Trending Now 内部接口（可能支持 search_type=youtube）
  ['stories-yt', 'https://trends.google.com/trending/api/stories?geo=US&hl=en&tz=-420&search_type=youtube'],
  ['stories-web', 'https://trends.google.com/trending/api/stories?geo=US&hl=en&tz=-420'],
  ['stories-yt-tabbed', 'https://trends.google.com/trending/api/stories?geo=US&hl=en&tz=-420&search_type=youtube&tabbed_search_request=1'],
  // RSS 带 search_type 参数（试错成本低）
  ['rss-yt', 'https://trends.google.com/trending/rss?geo=US&search_type=youtube'],
  // 旧 dailytrends 内部接口带 search_type
  ['dailytrends-yt', 'https://trends.google.com/trends/api/dailytrends?hl=en-US&tz=-420&geo=US&ns=15&search_type=youtube'],
  // explore 接口 gprop=youtube（关键词口径，验证是否可匿名访问）
  ['explore-yt', 'https://trends.google.com/trends/api/explore?hl=en-US&tz=-420&req=' + encodeURIComponent(JSON.stringify({ comparisonItem: [{ keyword: 'music', geo: 'US', time: 'today 1-m', property: 'youtube' }], category: 0, property: 'youtube' }))],
  // 官方 Alpha API 的接入探测（不需要 key 的根路径，看返回什么）
  ['alpha-api', 'https://trends.googleapis.com/trends/api/daily_trends?geo=US'],
];

(async () => {
  for (const [name, url] of CANDIDATES) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'application/json, text/plain, */*',
        },
        signal: AbortSignal.timeout(15000),
      });
      const body = await r.text();
      console.log('== ' + name + ' == HTTP ' + r.status + ' (' + body.length + ' bytes)');
      console.log(body.slice(0, 300).replace(/\s+/g, ' '));
    } catch (e) {
      console.log('== ' + name + ' == ERROR ' + e.message);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
})();
