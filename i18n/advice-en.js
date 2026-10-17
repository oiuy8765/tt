'use strict';

/**
 * 「可以做什么」建议模板的英文版。
 * key 与 radar.js 里 ADVICE_TPL 的 id 一一对应，占位符（[[KW]] 等）保持原样。
 * 日/韩从这份英文再翻，繁体从简体中文翻。
 */
module.exports = {
  'who.beauty': 'beauty salons and skincare sellers',
  'who.fitness': 'personal trainers and boutique gyms',
  'who.clinic': 'clinics and independent practitioners',
  'who.food': 'restaurants and cafés',
  'who.auto': 'repair shops and used-car dealers',
  'who.realty': 'estate agents and landlords',
  'who.edu': 'tutoring businesses and independent teachers',
  'who.travel': 'guesthouses and local tour operators',
  'who.finance': 'bookkeeping firms and insurance brokers',
  'who.seller': 'cross-border sellers and DTC store owners',
  'who.hr': 'HR teams at small companies',
  'who.trades': 'local contractors and service companies',
  'who.tech': 'small engineering teams',
  'who.pet': 'pet shops and veterinary clinics',
  'who.users': 'its existing users',
  'who.smb': 'one specific type of small customer',

  'price.tool': '$9/month',
  'price.saas': '$19/seat/month',
  'price.app': '$4.99 one-off or subscription',
  'price.content': '$5/month membership',

  'act.tool.1':
    'Build a one-job online tool for "[[KW]]": one input, one result page, usable without signing up, shippable in a week.',
  'act.tool.2':
    'Launch a free "[[KW]]" tool with limits per run, then charge [[PRICE]] for the Pro tier — this kind of keyword pays for repeated use, not for more features.',
  'act.tool.3':
    'Ship "[[KW]]" as a browser extension so it runs inside the page people already use, skipping the hardest step: getting them to remember your site.',
  'act.tool.4':
    'Publish 30 long-tail answer pages around "[[KW]]" (how to, how much, which is best), win the search traffic first, then funnel it into the tool.',
  'act.tool.5':
    'Build a "[[KW]]" comparison table: list every option with its price and its flaws, then monetise the page with affiliate links — far faster than building anything.',
  'act.tool.6':
    'Wrap "[[KW]]" as an API or script and sell usage to [[WHO]]: no consumer traffic needed, higher contract value, no returns.',
  'act.tool.7':
    'Post a free "[[KW]]" mini-tool in the relevant communities and wait for 100 emails before deciding on a paid version.',

  'act.saas.1':
    'Serve one type of customer only: make "[[KW]]" the small tool [[WHO]] open every day, charge [[PRICE]], and sign 10 customers before writing code.',
  'act.saas.2':
    'Start from a "[[KW]]" spreadsheet template: give the template away for an email, then sell multi-user collaboration and automatic roll-ups on a team plan.',
  'act.saas.3':
    "Don't build the whole workflow — own the most annoying step in \"[[KW]]\" (import, reconciliation, export) and charge [[PRICE]] for doing it perfectly.",
  'act.saas.4':
    '"[[KW]]" is probably run on spreadsheets and group chats today: connect those two and you have a reason for [[WHO]] to pay.',
  'act.saas.5':
    'Take one "[[KW]]" core and skin it for three industries, sell annual licences, and triple the price per account.',
  'act.saas.6':
    'Do "[[KW]]" by hand first (concierge MVP): 20 paid jobs before you productise, so you do not build something nobody uses.',
  'act.saas.7':
    'Turn "[[KW]]" into a quoting and reconciliation tool for [[WHO]]: they do not need another system, they need the one page they can send to a client.',

  'act.app.1':
    'Pick one painful moment and build "[[KW]]" around it: launch on iOS only and seed it with short videos on [[PLATFORM]].',
  'act.app.2':
    'Make "[[KW]]" a lightweight log-and-remind app: skip heavy features and charge for cloud sync.',
  'act.app.3':
    'Ship "[[KW]]" as a mini app or web app first; if day-7 retention clears 20%, invest in native.',
  'act.app.4':
    'Build the single camera or photo feature behind "[[KW]]", win organic installs through ASO, and charge for advanced processing.',
  'act.app.5':
    'Build a companion tool for [[WHO]] around "[[KW]]"; grow it through content and community first, not paid installs.',
  'act.app.6':
    'Make "[[KW]]" work offline and open straight into a result; trade ratings and word of mouth for organic downloads.',

  'act.content.1':
    'Build a "[[KW]]" database site: structure the entries, give each one its own page, live off long-tail search, and monetise with membership or affiliates.',
  'act.content.2':
    'Run a "[[KW]]" comparison and review site that only answers "which one is worth it" — affiliate revenue, much lighter than building software.',
  'act.content.3':
    'Break "[[KW]]" into 50 concrete questions, publish an answer page for each, then add a calculator to keep people around.',
  'act.content.4':
    'Build a "[[KW]]" price tracker and update it weekly: people come back because it is always current, and ad rates are higher.',
  'act.content.5':
    'Turn "[[KW]]" into a downloadable checklist or template, trade it for an email, then sell the paid report behind it.',
  'act.content.6':
    'Build a city-by-category directory for "[[KW]]": [[WHO]] will pay monthly for exposure, which is steadier than traffic ads.',
  'act.content.7':
    'Publish an annual data report on "[[KW]]": get cited and reposted, then sell a custom cut to [[WHO]].',

  'act.goods.1':
    'Source the same product as "[[KW]]" from a factory and white-label it: test 3 SKUs first and validate with real footage on [[PLATFORM]].',
  'act.goods.2':
    'Build a focused store for "[[KW]]" that sells only this category, with comparison pages to catch long-tail search — not a general store.',
  'act.goods.3':
    'Test "[[KW]]" in small batches on Amazon, price in shipping and returns, and walk away if the margin is under 40%.',
  'act.goods.4':
    '"[[KW]]" is a physical product, so the moat is supply chain: sample from two factories and pre-sell before you stock up.',
  'act.goods.5':
    'Write the buying guide for "[[KW]]" with affiliate links: no inventory, and you will know if there is volume before you hold stock.',
  'act.goods.6':
    '"[[KW]]" works as a kit-and-refill business: the device brings people in, the consumables bring them back.',
  'act.goods.7':
    'Mine the negative reviews around "[[KW]]" first: fix the three biggest complaints and use them as your product-page selling points.',
  'act.goods.8':
    '"[[KW]]" looks like new hardware, so start with a crowdfunding or pre-order page and let real orders decide whether to tool up.',

  'act.company.1':
    '"[[KW]]" already has players, which proves the demand: do not clone it, build the alternatives comparison page and capture "[[KW]] alternative" searches.',
  'act.company.2':
    'Treat "[[KW]]" as a market signal: read its pricing page and bad reviews, find the scenario it ignores, and ship a cheaper or narrower version.',
  'act.company.3':
    'Build the migration tool for "[[KW]]" (export data, move to another option): low competition on the keyword, high intent.',
  'act.company.4':
    '"[[KW]]" is a product name, not a need — cloning it is pointless. Mine its complaints and pick one pain point for a small tool.',
  'act.company.5':
    'Sell the accessories around "[[KW]]": templates, plugins, tutorials, managed service. Borrow its search volume instead of creating demand.',
  'act.company.6':
    'Scrape the reviews of "[[KW]]" into a "what it is really like" report and use that content to catch its churned users.',

  'act.unknown.1':
    'Search "[[KW]]" and read the first ten pages: see who captures the traffic today, then decide between a tool and content.',
  'act.unknown.2':
    'The intent behind "[[KW]]" is unclear — put up a landing page, collect emails, and let the click-through rate decide.',

  'time.fading.1':
    "It is past peak, though, so a content page is the most this deserves — don't fund development.",
  'time.fading.2':
    'It now sits at [[P]]% of its peak; unless it spikes again, it is not worth building for.',
  'time.tiny.1': 'Under a thousand searches a month — put it on a watchlist and revisit when it doubles.',
  'time.tiny.2': 'The pool is still too small; park a content page on it and wait for volume.',
  'time.fresh.1':
    'It was listed less than three months ago, so claiming the keyword matters more than shipping features.',
  'time.fresh.2':
    'It is still new to the list and competitors have not moved — claim the pages and the keyword first.',
  'time.up.1': 'Up [[G]]% in 90 days; the window will not stay open, so ship the smallest version.',
  'time.up.2': 'Up [[G]]% in three months; a full product will land too late — release something half-finished.',
  'time.up.goods': 'Up [[G]]% in three months: move fast in and out, and do not commit to a large inventory.',
  'time.down.1': 'Down [[G]]% over 90 days — only worth lightweight content, not development.',
  'time.down.2':
    'The wave is receding ([[G]]% in 90 days); build content that keeps earning from search instead of betting on the spike.',
  'time.down.goods': 'Down [[G]]% in 90 days: do not stock up on this trend, test with a small batch.',
  'time.season.1': 'Search peaks around month [[M]], so launch about [[N]] months earlier.',
  'time.season.2':
    'This is seasonal demand that peaks in month [[M]]; a product launched later barely catches any volume.',
  'time.season.goods': 'Search peaks in month [[M]], so stock and launch about [[N]] months ahead.',
  'time.crowded.1':
    'Listed for over two years — head-on competition is a dead end; you need a narrow segment.',
  'time.crowded.2':
    'This keyword has been picked over for a while; only a narrow play (one audience, one workflow) has room.',
  'time.crowded.goods':
    'This keyword has been contested for two years and price wars have probably started; stay out without exclusive supply.',
  'time.plat.1': 'Discussion clusters on [[PLATFORM]], so release a free version there first — cheaper than ads.',
  'time.plat.2':
    'The audience lives on [[PLATFORM]]; start cold outreach from the real questions people ask there.',
  'time.plat.goods':
    'Discussion clusters on [[PLATFORM]]; seed unboxing and real-footage content there, cheaper than buying ads.',
  'time.default.1':
    'Ship the smallest version, validate with real search traffic, then decide whether to add features.',
  'time.default.2':
    'There is no obvious timing window, so you can take your time — but prove someone will pay first.',
};
