# TrendSift

> 从 Google Trends 里挑出「正在涨、而且现在还来得及做」的词，并给出可执行的判断依据。

线上站点：**https://trendsift.site**

TrendSift 是一个静态化的趋势分析站。它不卖"趋势榜单"，做的是把 Google Trends 的原始信号整理成**可直接决策的结构化结论**：这个词涨了多少、在哪个阶段、什么季节起量、适合放到哪个渠道、现在动手还来不来得及。

---

## 它解决什么问题

Google Trends 本身只回答"什么在涨"。真正要动手的人还需要回答另外四个问题：

1. 涨得够不够快？（90 天 / 12 个月双窗口，避免把长期缓涨误判成机会）
2. 在哪个阶段？（起量期 / 加速期 / 平台期 / 退潮期）
3. 什么时候备货、什么时候投放？（季节峰值月 + 提前期建议）
4. 这个方向还有没有别人没吃掉的细分入口？（飙升相关查询）

站点把这些问题固定成字段，所以可以排序、可以导出、可以批处理。

## 主要功能

| 功能 | 说明 |
|---|---|
| 机会库 | 按分数排序的上升词，含 90 天 / 12 个月增长、月度搜索量、阶段判断、类目归属 |
| 话题页 | 每个词一页，含趋势曲线、季节峰值、相关上升词、站内内链网络 |
| 实时查词 | 输入任意关键词，实时拉取时间线与相关查询（三级降级：边缘缓存 → 直连 → 队列计算） |
| CSV 导出 | 9 列结构化字段，可直接进 Excel / 数据库做二次筛选 |
| 双语阅读 | 英文原文 + 中文/日/韩译文对照，「显示原文 / 显示译文」一键切换 |
| 多语言 | English / 简体中文 / 繁體中文 / 日本語 / 한국어，含 hreflang 与独立 sitemap |

## 技术架构

```
Google Trends 公开接口
        │
        ├── GitHub Actions（每日定时）
        │     ├── fetch-rising.js    增量抓取「飙升相关查询」（自适应退避 + 游标轮换）
        │     ├── build-static.js    抓取榜单/详情 → 调 build-multi.js
        │     └── build-multi.js     生成 5 语言静态页（首页 / 话题页 / 查词页）
        │
        └── Cloudflare Pages
              ├── 静态资源（无限流量、全球边缘）
              └── Functions（functions/api/keyword.js）
                    ├── caches.default   边缘缓存 1h
                    ├── 直连 Google Trends
                    └── 未命中 → dispatch GitHub Actions → 结果回传 kw-cache 分支
```

关键设计取舍：

- **零依赖**：全部使用 Node 内置模块，没有 `node_modules`，CI 不需要 install 步骤。
- **计算结果外置**：Cloudflare Function 运行时不带持久存储，计算结果通过 `kw-cache` 分支回传，相当于用 Git 当 KV。
- **429 是常态**：Google 对数据中心出口 IP 限流严重，抓取层做了 Cookie 预热、指数退避、连续失败熔断、按日预算上限。
- **静态优先**：能构建期算完的绝不放运行时，页面首屏不依赖任何第三方 API。

## 本地运行

需要 Node.js 18+（无第三方依赖，不需要 `npm install`）。

```bash
# 启动本地服务（带关键词分析等动态能力）
node server.js

# 只构建静态站到 dist/
node build-static.js
```

Windows 用户可直接双击 `启动.bat`。

重新抓取全站数据并重建：双击 `更新数据.bat`（等价于 `node _enrich_all.js && node build-static.js`）。

## 部署

推送 `main` 分支后由 GitHub Actions 自动构建并发布到 Cloudflare Pages；也可本地 `wrangler pages deploy dist` 手动发布。

需要在仓库 Secrets 中配置：

| Secret | 用途 |
|---|---|
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | 发布到 Pages |
| `GH_TOKEN` | 查词队列回写 `kw-cache` 分支 |
| `SERPAPI_KEY` | 可选，Google 接口限流时的兜底数据源 |

详细配置步骤见 [`配置说明.md`](./配置说明.md)。

## 数据来源与免责

- 数据来自 Google Trends 对外公开的查询接口，TrendSift 与 Google 无隶属或合作关系。
- 增长、阶段、季节等指标为二次计算口径，不同口径不可直接对比。
- 所有内容为公开数据的整理与分析，**不构成投资、法律或商业建议**。据此决策的风险由使用者自行承担。
- 若权利人认为某处引用不当，可通过站点 `/contact` 联系处理。

## 许可

Copyright © 2026 TrendSift. All rights reserved.

本仓库公开用于**阅读与学习**。未经书面许可，不得将本项目的代码、数据管道或生成内容整体或实质性部分用于商业部署、二次分发或搭建同类站点。转载内容请注明来源并保留链接。
