'use strict';
/**
 * 自测脚本：验证 HTTP / SOCKS5 隧道与 JSON 解析逻辑。
 * 用百度（国内可直连）作为隧道连通性靶点，不依赖 Google 可达性。
 *
 * 运行： node test-selftest.js
 */
const t = require('./server.js');

(async () => {
  const results = [];
  const check = (name, ok, extra) => {
    results.push({ name, ok, extra });
    console.log((ok ? '  [OK]  ' : '  [FAIL] ') + name + (extra ? '  -> ' + extra : ''));
  };

  // 1) 指标解析
  check('parseTraffic "500K+" = 500000', t.parseTraffic('500K+') === 500000, String(t.parseTraffic('500K+')));
  check('parseTraffic "2M+" = 2000000', t.parseTraffic('2M+') === 2000000);

  // 2) dailytrends 解析
  const sample = {
    default: {
      trendingSearchesDays: [
        {
          date: '20261016',
          formattedDate: '2026年10月16日',
          trendingSearches: [
            {
              title: { query: 'test query', exploreLink: '/trends/explore?q=test+query' },
              formattedTraffic: '200K+',
              relatedQueries: [{ query: 'rel a' }, { query: 'rel b' }],
              articles: [{ title: 'news 1', url: 'https://x.com/1', source: 'Src', timeAgo: '2h ago' }],
              image: { imageUrl: 'https://img/1.jpg' },
            },
          ],
        },
      ],
    },
  };
  const norm = t.normalizeDaily(sample, 'US');
  check(
    'normalizeDaily 解析条数与字段',
    norm.length === 1 && norm[0].query === 'test query' && norm[0].trafficValue === 200000 && norm[0].related.length === 2,
    JSON.stringify(norm[0] && { q: norm[0].query, tv: norm[0].trafficValue, rel: norm[0].related })
  );

  // 3) 直连（国内站点）
  try {
    const r = await t.fetchUrl('https://www.baidu.com', { timeout: 12000 });
    check('直连 https://www.baidu.com', r.status === 200, 'HTTP ' + r.status);
  } catch (e) {
    check('直连 https://www.baidu.com', false, e.message);
  }

  // 4) HTTP 代理隧道
  const proxyEnv = process.env.HTTP_PROXY || process.env.http_proxy || '';
  if (proxyEnv) {
    const saved = t.config.proxy;
    t.config.proxy = proxyEnv;
    try {
      const r = await t.fetchUrl('https://www.baidu.com', { timeout: 15000 });
      check('HTTP 代理隧道 ' + proxyEnv, r.status === 200, 'HTTP ' + r.status);
    } catch (e) {
      check('HTTP 代理隧道 ' + proxyEnv, false, e.message);
    }
    t.config.proxy = saved;
  } else {
    console.log('  [SKIP] 环境没有 HTTP_PROXY，跳过 HTTP 隧道测试');
  }

  // 5) SOCKS5 隧道：启动一个最小 SOCKS5 服务端，转发到真实目标
  const net = require('net');
  const socks = net.createServer((client) => {
    let stage = 0;
    let buf = Buffer.alloc(0);
    client.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        client.write(Buffer.from([0x05, 0x00]));
        buf = Buffer.alloc(0);
        stage = 1;
        return;
      }
      if (stage === 1) {
        if (buf.length < 5) return;
        const atyp = buf[3];
        let host;
        let port;
        if (atyp === 0x03) {
          const len = buf[4];
          if (buf.length < 5 + len + 2) return;
          host = buf.slice(5, 5 + len).toString();
          port = buf.readUInt16BE(5 + len);
        } else if (atyp === 0x01) {
          host = Array.from(buf.slice(4, 8)).join('.');
          port = buf.readUInt16BE(8);
        }
        buf = Buffer.alloc(0);
        stage = 2;
        const upstream = net.connect({ host, port }, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on('error', () => client.destroy());
      }
    });
    client.on('error', () => {});
  });

  await new Promise((res) => socks.listen(0, '127.0.0.1', res));
  const socksPort = socks.address().port;
  const saved2 = t.config.proxy;
  t.config.proxy = 'socks5://127.0.0.1:' + socksPort;
  try {
    const r = await t.fetchUrl('https://www.baidu.com', { timeout: 15000 });
    check('SOCKS5 隧道 socks5://127.0.0.1:' + socksPort, r.status === 200, 'HTTP ' + r.status);
  } catch (e) {
    check('SOCKS5 隧道', false, e.message);
  }
  t.config.proxy = saved2;
  socks.close();

  // 6) 免代理聚合源（hottrends.ai，国内可直连）
  try {
    const agg = await t.getAggregatorTrends();
    check('免代理聚合源 hottrends.ai', agg.items.length >= 5, 'items=' + agg.items.length);
  } catch (e) {
    check('免代理聚合源 hottrends.ai', false, e.message);
  }

  // 7) Google 可达性（预期国内直连失败，仅作信息输出）
  try {
    const r = await t.fetchUrl('https://trends.google.com/trends/api/dailytrends?hl=en-US&tz=0&geo=US&ns=15', {
      timeout: 8000,
    });
    console.log('  [INFO] Google Trends 直连返回 HTTP ' + r.status + '，可以直连抓取');
  } catch (e) {
    console.log('  [INFO] Google Trends 直连不可用（' + e.message + '），需要配置代理或使用聚合源');
  }

  // 8) 机会雷达（explodingtopics.com，国内可直连；命中缓存则秒回）
  try {
    const radar = require('./radar.js');
    const info = radar.cacheInfo();
    const r = await radar.getRadar({});
    check(
      '机会雷达 explodingtopics.com',
      r.ok && r.topics.length >= 100,
      'topics=' + r.topics.length + (info ? '（缓存 ' + new Date(info.at).toLocaleTimeString('zh-CN') + '）' : '（首次抓取）')
    );
    const withCat = r.topics.filter((x) => x.enriched).length;
    console.log('  [INFO] 已补全分类/简介的话题: ' + withCat + '/' + r.topics.length);
    const brands = r.topics.filter((x) => x.brand).length;
    console.log('  [INFO] 识别出品牌词: ' + brands + ' 个（默认已排除）');
  } catch (e) {
    check('机会雷达 explodingtopics.com', false, e.message);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n  合计 ' + results.length + ' 项，失败 ' + failed.length + ' 项');
  process.exit(failed.length ? 1 : 0);
})();
