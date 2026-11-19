# AI 市场分析板块 · 每周更新说明

这个板块与其他页面的关键区别：**它不随每日数据自动更新**，而是每周由 AI 手动精选一批新词、逐条撰写市场分析，再生成多语言静态页。内容全部预渲染进 HTML（不依赖 JS），可被搜索引擎与 AI 引擎收录。

---

## 每周更新流程（4 步）

### 第 1 步：选词并写分析

编辑 `data/ai-market.json`：

- 更新顶层 `updated`（日期，如 `2026-11-24`）和 `batch`（如 `2026-W48`）
- 在 `items` 数组里增删词条。每条结构如下：

```jsonc
{
  "slug": "english-slug",          // 唯一，决定详情页 URL /ai-market/<slug>.html
  "keyword": "English Keyword",    // 真实搜索词，保留原文不翻译
  "title": "做一个……的网站",       // AI 撰写的机会标题
  "cat": "工具 / SaaS",            // 分类（会自动翻译/转换）
  "form": "工具站",                // 产品形态
  "grade": "A",                    // A/B/C 机会评级
  "trend": {                       // 真实趋势数据，从 data/site-data.json 取
    "vol": 49500, "g90": 24, "g12": 74,
    "build": 88, "firstSeen": "2011-09",
    "platform": "Reddit", "window": "充分竞争"
  },
  "tldr": "一句话结论",
  "why": "为什么是机会",
  "audience": "谁在搜索",
  "product": "做什么产品",
  "competition": "竞争格局",
  "monetize": "怎么变现",
  "steps": ["落地步骤1", "落地步骤2"],
  "risk": "风险提示",
  "faq": [{ "q": "问题", "a": "回答" }],
  "action": "本周行动建议",
  "related": "metadata-remover"    // 站内 topic slug，用于内链
}
```

选词数据来源：`data/site-data.json`（`carrier=web`、`digitalKind=need`、建站分/增长高的词优先）与 `data/daily.json`（当日热榜里的新品类）。**数字务必来自真实数据，不要编造。**

**选词三原则（踩过坑，务必遵守）：**
1. **只要具体词，不要品类词**：写「GTA 6」而不是「类魂游戏」，写「Fraud detection」而不是「风控」。判断标准：这个词用户会不会原样搜？「游戏攻略站」没人搜，「GTA 6 任务」有人搜。
2. **游戏类只占少数**：每批游戏词控制在 1-2 条，其余给 SaaS / 工具 / 数据 / 效率等互联网产品词——这是一个面向建站选品的平台，不是游戏攻略站集合。
3. **产品形态要具体多样，拒绝过时形态**：不要「提示词库 / 提示词站」（已淘汰）、不要千篇一律的「教程站 / 模板站」。优先 SaaS、对比站、评测站、生成器、数据库、审计工具、追踪平台等能真正落地的形态。每条的产品建议要针对该词的特点写，不要套同一个模板，尤其不要每条都写「面向全球 / 多语言 / 英文优先」这类口号——多语言是平台能力，不是每条建议的卖点。

### 第 2 步：生成多语言词典

```bash
node scripts/prepare-ai-market-dict.js       # ① 清理旧词残留 + 本地生成繁中并预填缓存
node build-ai-market.js                      # ② 翻译 en / ja / ko（繁中命中缓存会跳过）
node scripts/fill-ai-market-missing.js ko    # ③ 补韩文，反复跑到"缺 0 段"（限流时多轮收敛）
node scripts/sync-ui-extra.js                # ④ 新增 UI 文案若改动，同步到 ui.json
```

> 翻译走腾讯接口，带按语言缓存（`data/i18n/cache-zh-*.json`）。只有新增段落会联网翻译，重复段命中缓存。繁中用 `prepare` 脚本本地简繁转换（比机翻准、且免限流），并预填缓存让主脚本跳过。韩语最容易被限流，`fill-ai-market-missing.js` 每轮把成功段写盘、可反复运行收敛；若最后几段始终失败，可人工在 `data/i18n/ai-market.json` 与对应 `cache-zh-ko.json` 里补上。

> **机翻校正**：腾讯对几个中文词有稳定误译，构建后需检查并修正译文（词典 + 缓存同改）：「站」→ station（应 site / サイト / 사이트）、「引流」→ drainage（应 traffic）、「攻略」→ raiders（应 guides）、「落地」→ 着陸 / 착륙（应 導入 / 도입）、「联盟」→ alliance（应 affiliate）、「看板」→ Kanban（应 dashboard）。这些词几乎每周都会出现。

### 第 3 步：构建

```bash
node build-static.js
```

会生成 5 语言 × (列表页 + 每词详情页)，并自动更新 sitemap、llms.txt、JSON-LD。

### 第 4 步：同步到仓库并部署（关键！别漏）

生产域名 `trendsift.site` 由 GitHub Actions 每天两次（北京时间 6:00 / 18:00）**从 GitHub 仓库 main 分支自动构建部署**。所以改完代码/词库后，**必须让改动进仓库**，否则下次 CI 会用旧代码覆盖，板块会"消失"。

**把改动送进仓库**（按网络情况二选一）：

```bash
# 正常：直接 push
git add -A && git commit -m "update ai market" && git push origin main

# github.com 连不上时：用 Contents API 同步（api.github.com 通常仍可达）
node scripts/push-via-api.js --dry-run   # 先看要同步哪些文件
node scripts/push-via-api.js             # 执行（白名单文件，跳过 CI 会重生成的大数据缓存）
```

**立即上线**（不必等定时任务）：

```bash
# 本地直传生产别名（自定义域名绑定在这条别名上）—— 注意 --branch=main 不能省
npx wrangler pages deploy dist --project-name=trends-radar --branch=main --commit-dirty=true

# 或触发 CI 重建（推荐，走完整流程）
#   POST https://api.github.com/repos/oiuy8765/tt/actions/workflows/deploy.yml/dispatches  {"ref":"main"}
```

> ⚠️ 血泪教训：`wrangler pages deploy dist`（不带 `--branch=main`）只会生成 preview 别名，不会更新 `trendsift.site`。昨天板块"消失"就是因为代码只改在本地、没进仓库，CI 用旧代码重建所致。

---

## 数据缓存与代码解耦（R2 方案）

CI 里已改造：构建前从 Cloudflare R2 拉取上次的翻译缓存/数据快照，构建部署后把新缓存推回 R2，**不再 commit 回仓库**。这样数据更新不污染 git 历史。

- 同步脚本：`scripts/r2-sync.js`（`push` / `pull`），同步清单见脚本内 `FILES` 数组。
- 依赖 secrets：`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`（需含 R2 对象读写权限）。
- **R2 需先在 Cloudflare Dashboard 手动开通一次**（R2 → 创建 bucket `trendsift-data`），CLI 无法开通。
- 两个 R2 步骤都是 `continue-on-error`，即使 R2 未开通也不影响站点正常部署。
- 页面数据本身仍是构建时抓取生成的（`build-static.js` 的 `getRadar`），R2 只缓存跨构建复用的中间产物，不改变"数据烘进静态 HTML、利于 SEO"的本质。

---

## 关键文件

| 文件 | 作用 |
|---|---|
| `data/ai-market.json` | 中文源数据（每周编辑这里） |
| `build-ai-market.js` | 主翻译生成器（en / ja / ko） |
| `scripts/prepare-ai-market-dict.js` | 清理旧词 + 本地生成繁中并预填缓存（翻译前先跑） |
| `scripts/fill-ai-market-missing.js` | 补齐缺失翻译（抗限流，可反复跑） |
| `scripts/sync-ui-extra.js` | UI 文案同步到 ui.json |
| `build-multi.js` | 页面渲染（`aiMarketIndexPage` / `aiMarketDetailPage`） |
| `public/styles.css` | 第 13 节 `AI 市场分析` 样式 |

## SEO / GEO 已内置（无需每周维护）

- 每页 canonical + 6 条 hreflang + OG + Twitter Card
- JSON-LD：列表页 `CollectionPage`+`ItemList`；详情页 `Article`+`BreadcrumbList`+`FAQPage`
- 5 语言 sitemap 收录所有详情页
- `llms.txt` 列出板块说明与全部词条（便于 ChatGPT / Perplexity / Google AI 引用）
- 语义化 H1/H2、FAQ 问答结构、可引用的事实型数据
