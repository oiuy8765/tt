// 探测 YouTube trending：页面提取 INNERTUBE key → browse API 拿 trending 列表
(async () => {
  try {
    const r = await fetch('https://www.youtube.com/feed/trending?gl=US&hl=en', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: 'CONSENT=YES+cb; SOCS=CAI',
      },
      signal: AbortSignal.timeout(20000),
    });
    const body = await r.text();
    const key = (body.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
    const ver = (body.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1];
    console.log('page HTTP ' + r.status + ' | key=' + (key ? key.slice(0, 12) + '…' : 'none') + ' | ver=' + (ver || 'none'));
    if (!key) return;
    const b = await fetch('https://www.youtube.com/youtubei/v1/browse?key=' + key, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: ver || '2.20240101.00.00', gl: 'US', hl: 'en' } },
        browseId: 'FEtrending',
      }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await b.text();
    let vids = [];
    try {
      const collect = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return void node.forEach(collect);
        const vr = node.videoRenderer || node.lockupViewModel;
        if (vr) vids.push(vr);
        for (const k of Object.keys(node)) collect(node[k]);
      };
      collect(JSON.parse(j));
    } catch (e) {}
    console.log('browse HTTP ' + b.status + ' (' + j.length + ' bytes) | videoRenderer+lockup: ' + vids.length);
    const vr = vids.find((v) => v.videoRenderer) || vids[0];
    if (vr) console.log(JSON.stringify(vr).slice(0, 600));
  } catch (e) {
    console.log('ERROR ' + e.message);
  }
})();

