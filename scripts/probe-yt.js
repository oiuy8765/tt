// 探测 YouTube trending 页面（诊断 ytInitialData 提取失败原因）
(async () => {
  const tries = [
    ['feed-trending-US', 'https://www.youtube.com/feed/trending?gl=US&hl=en'],
    ['feed-trending-US-consent', 'https://www.youtube.com/feed/trending?gl=US&hl=en'],
  ];
  for (const [name, url] of tries) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          Accept: 'text/html,*/*',
          Cookie: name.endsWith('consent') ? 'CONSENT=YES+cb.20210328-17-p0.en+FX+419; SOCS=CAI' : 'CONSENT=YES+cb',
        },
        signal: AbortSignal.timeout(20000),
      });
      const body = await r.text();
      const has = body.includes('ytInitialData');
      const vid = (body.match(/"videoId":"([a-zA-Z0-9_-]{11})"/) || [])[1];
      console.log('== ' + name + ' == HTTP ' + r.status + ' (' + body.length + ' bytes) ytInitialData=' + has + ' videoId=' + (vid || 'none'));
      const t = body.replace(/\s+/g, ' ');
      const m = t.match(/<title>([^<]{0,120})/);
      if (m) console.log('title: ' + m[1]);
      if (!has) console.log(t.slice(0, 400));
    } catch (e) {
      console.log('== ' + name + ' == ERROR ' + e.message);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
})();
