// 探测 YouTube trending 的多种获取方案，找出 CI 可用的路径
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function countVids(obj) {
  let n = 0;
  const c = (node) => {
    if (!node || typeof node !== 'object' || n > 500) return;
    if (Array.isArray(node)) return void node.forEach(c);
    if (node.videoRenderer || node.lockupViewModel || node.richItemRenderer) n++;
    for (const k of Object.keys(node)) c(node[k]);
  };
  c(obj);
  return n;
}

(async () => {
  // 0. 拿 innertube key/version
  let key = '', ver = '';
  try {
    const r = await fetch('https://www.youtube.com/feed/trending?gl=US&hl=en', {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+cb; SOCS=CAI' },
      signal: AbortSignal.timeout(20000),
    });
    const body = await r.text();
    key = (body.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1] || '';
    ver = (body.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] || '';
    console.log('page OK, key=' + (key ? 'yes' : 'no') + ' ver=' + ver);
  } catch (e) {
    console.log('page ERROR ' + e.message);
  }

  const variants = [
    ['A: no-key+prettyPrint', 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', null],
    ['B: key+prettyPrint', 'https://www.youtube.com/youtubei/v1/browse?key=' + key + '&prettyPrint=false', null],
    ['C: ANDROID client', 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', 'ANDROID'],
  ];
  for (const [name, url, client] of variants) {
    try {
      const ctx =
        client === 'ANDROID'
          ? { clientName: 'ANDROID', clientVersion: '19.09.37', gl: 'US', hl: 'en', androidSdkVersion: 30 }
          : { clientName: 'WEB', clientVersion: ver || '2.20261016.01.00', gl: 'US', hl: 'en' };
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ context: { client: ctx }, browseId: 'FEtrending' }),
        signal: AbortSignal.timeout(20000),
      });
      const t = await r.text();
      let n = 0;
      try { n = countVids(JSON.parse(t)); } catch (e) {}
      console.log('== ' + name + ' == HTTP ' + r.status + ' (' + t.length + 'b) renderers=' + n);
      if (r.status !== 200) console.log(t.slice(0, 160).replace(/\s+/g, ' '));
    } catch (e) {
      console.log('== ' + name + ' == ERROR ' + e.message);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Invidious / Piped 公共实例
  const alt = [
    ['invidious-nadeko', 'https://inv.nadeko.net/api/v1/trending?region=US'],
    ['invidious-yewtu', 'https://yewtu.be/api/v1/trending?region=US'],
    ['piped-kavin', 'https://pipedapi.kavin.rocks/trending?region=US'],
    ['piped-adminforge', 'https://pipedapi.adminforge.de/trending?region=US'],
  ];
  for (const [name, url] of alt) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      const t = await r.text();
      let n = 0, sample = '';
      try {
        const j = JSON.parse(t);
        if (Array.isArray(j)) {
          n = j.length;
          sample = JSON.stringify(j[0]).slice(0, 220);
        }
      } catch (e) {}
      console.log('== ' + name + ' == HTTP ' + r.status + ' items=' + n);
      if (n) console.log('  sample: ' + sample);
    } catch (e) {
      console.log('== ' + name + ' == ERROR ' + e.message);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
})();
