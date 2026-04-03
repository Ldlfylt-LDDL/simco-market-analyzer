// ==UserScript==
// @name         SimCo 航空市场分析器
// @namespace    simco-aero-market-analyzer
// @version      1.0
// @description  实时抓取并解析 SimCompanies 聊天室中 SOR/BFR/JUM/LUX/SEP/SAT 的买卖报价，按产品/等级汇总
// @author
// @match        https://www.simcompanies.com/*
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @updateURL    https://raw.githubusercontent.com/Ldlfylt-LDDL/simco-market-analyzer/main/simco_market_analyzer.user.js
// @downloadURL  https://raw.githubusercontent.com/Ldlfylt-LDDL/simco-market-analyzer/main/simco_market_analyzer.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ── Product definitions ───────────────────────────────────────────────
  const PRODUCT_CODES = {
    ':re-91:': 'SOR', ':re-94:': 'BFR', ':re-95:': 'JUM',
    ':re-96:': 'LUX', ':re-97:': 'SEP', ':re-99:': 'SAT',
  };
  const PROD_IMG = {
    ':re-91:': 'https://www.simcompanies.com/static/images/resources/sub-orbital-rocket2.9ad38bb476cb.png',
    ':re-94:': 'https://www.simcompanies.com/static/images/resources/BFR.4699395019e3.png',
    ':re-95:': 'https://www.simcompanies.com/static/images/resources/jumbojet2.b2c81bdaa38f.png',
    ':re-96:': 'https://www.simcompanies.com/static/images/resources/private-jet.431cbfd61ef0.png',
    ':re-97:': 'https://www.simcompanies.com/static/images/resources/single-engine.5397ae90012c.png',
    ':re-99:': 'https://www.simcompanies.com/static/images/resources/satellite.bf53b325497d.png',
  };
  const ALIASES = {
    SOR: 'SOR', SORS: 'SOR',
    BFR: 'BFR', BFRS: 'BFR',
    JUM: 'JUM', JUMS: 'JUM', JUMBO: 'JUM', JUMBOS: 'JUM', JUMBOJET: 'JUM',
    LUX: 'LUX', LUXS: 'LUX', LUXJET: 'LUX',
    SEP: 'SEP', SEPS: 'SEP',
    SAT: 'SAT', SATS: 'SAT', SATELLITE: 'SAT', SATELLITES: 'SAT',
  };
  const ALIAS_RE  = /\b(SOR|SORS|BFR|BFRS|JUM|JUMS|JUMBO|JUMBOS|JUMBOJET|LUX|LUXS|LUXJET|SEP|SEPS|SAT|SATS|SATELLITE|SATELLITES)\b/gi;
  const SELL_RE   = /\b(sell(?:ing)?|vend(?:ing|o)?|offer(?:ing)?|auction|verkauf)\b/i;
  const BUY_RE    = /\b(buy(?:i?n?g?)?|want(?:ing|ed)?|need(?:ing)?|spending|compra)\b/i;
  const RENT_RE   = /\brent(?:ing|al|s)?\b|for\s+rent/i;
  const VERSION    = '1.0';
  const CHATROOM   = 'X';
  const PROD_ORDER = ['SOR', 'BFR', 'JUM', 'LUX', 'SEP', 'SAT'];
  const PROD_CODE  = { SOR: 're-91', BFR: 're-94', JUM: 're-95', LUX: 're-96', SEP: 're-97', SAT: 're-99' };

  // ── State ─────────────────────────────────────────────────────────────
  let abortCtrl = null;
  let panelEl   = null;

  // ── Boot ─────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    injectToggleButton();
  }

  // ── Toggle button (bottom-right corner) ──────────────────────────────
  function injectToggleButton() {
    const btn = document.createElement('button');
    btn.id        = 'scma-toggle';
    btn.innerHTML = '✈ 市场';
    btn.title     = 'SimCo 航空市场分析器';
    btn.onclick   = () => panelEl ? destroyPanel() : createPanel();
    document.body.appendChild(btn);
  }

  // ── Panel ─────────────────────────────────────────────────────────────
  function createPanel() {
    panelEl = document.createElement('div');
    panelEl.id = 'scma-panel';
    panelEl.innerHTML = `
      <div id="scma-header">
        <span>✈ 航空市场分析器<span id="scma-title-note">格式不规范的报价可能遗漏</span></span>
        <div style="display:flex;gap:6px;align-items:center">
          <button id="scma-copy" title="复制 JSON 结果">📋</button>
          <button id="scma-close">✕</button>
        </div>
      </div>

      <div id="scma-controls">
        <label title="向前搜索几小时的消息">
          时 <input id="scma-hours" type="number" value="8" min="1" max="48">
        </label>
        <button id="scma-search">🔍 搜索</button>
        <button id="scma-stop" disabled>⏹</button>
      </div>

      <div id="scma-status">准备就绪</div>
      <div id="scma-results"></div>

      <details id="scma-about">
        <summary>关于</summary>
        <div id="scma-about-body">
          <span>作者：</span>
          <a href="https://www.simcompanies.com/zh-cn/company/0/LDDL-Corp./" target="_blank" rel="noopener">LDDL Corp.</a>
          <span class="scma-sep">·</span>
          <a href="https://github.com/Ldlfylt-LDDL/simco-market-analyzer" target="_blank" rel="noopener">GitHub</a>
        </div>
        <div id="scma-about-ver">
          <span>v${VERSION}</span>
          <span class="scma-sep">·</span>
          <a id="scma-update-btn" href="#">检查更新</a>
          <span id="scma-update-status"></span>
        </div>
      </details>
    `;
    document.body.appendChild(panelEl);

    panelEl.querySelector('#scma-close').onclick  = destroyPanel;
    panelEl.querySelector('#scma-search').onclick = startSearch;
    panelEl.querySelector('#scma-stop').onclick   = stopSearch;
    panelEl.querySelector('#scma-copy').onclick   = copyResults;
    panelEl.querySelector('#scma-update-btn').onclick = e => { e.preventDefault(); checkForUpdates(); };

    makeDraggable(panelEl, panelEl.querySelector('#scma-header'));

    panelEl.querySelector('#scma-results').addEventListener('click', e => {
      const span = e.target.closest('[data-ci]');
      if (!span) return;
      const entries = _ciMap.get(parseInt(span.dataset.ci));
      if (!entries) return;
      showQuotePopup(e.clientX, e.clientY, entries);
    });

    if (_lastSummary) {
      renderResults(panelEl.querySelector('#scma-results'), _lastSummary, _lastQuotes, _lastMsgs);
      panelEl.querySelector('#scma-status').textContent = _lastStatus;
    }
  }

  function destroyPanel() {
    stopSearch();
    if (panelEl) { panelEl.remove(); panelEl = null; }
  }

  // ── Drag support ──────────────────────────────────────────────────────
  function makeDraggable(el, handle) {
    let ox = 0, oy = 0, x0 = 0, y0 = 0;
    handle.style.cursor = 'move';
    handle.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      ox = el.offsetLeft; oy = el.offsetTop;
      x0 = e.clientX;     y0 = e.clientY;
      document.onmousemove = mv => {
        el.style.right  = 'auto';
        el.style.bottom = 'auto';
        el.style.left   = (ox + mv.clientX - x0) + 'px';
        el.style.top    = (oy + mv.clientY - y0) + 'px';
      };
      document.onmouseup = () => {
        document.onmousemove = null;
        document.onmouseup   = null;
      };
    });
  }

  // ── Search ────────────────────────────────────────────────────────────
  let _lastSummary  = null;
  let _lastQuotes   = 0;
  let _lastMsgs     = 0;
  let _lastStatus   = null;
  const _ciMap      = new Map(); // click-index → entries[]
  let   _ciNext     = 0;

  async function startSearch() {
    const room     = CHATROOM;
    const hours    = parseFloat(panelEl.querySelector('#scma-hours').value) || 8;
    const cutoff   = Date.now() - hours * 3600 * 1000;
    const statusEl = panelEl.querySelector('#scma-status');
    const resultsEl= panelEl.querySelector('#scma-results');
    const btnSearch= panelEl.querySelector('#scma-search');
    const btnStop  = panelEl.querySelector('#scma-stop');

    btnSearch.disabled = true;
    btnStop.disabled   = false;
    resultsEl.innerHTML = '';
    _lastSummary = null;

    abortCtrl = new AbortController();
    const { signal } = abortCtrl;

    const BASE_URL = `https://www.simcompanies.com/api/v2/chatroom/${encodeURIComponent(room)}/`;
    let url       = BASE_URL;
    let page      = 0;
    let done      = false;
    const allMsgs = [];

    try {
      while (!done) {
        if (signal.aborted) break;
        statusEl.textContent = `⏳ 加载第 ${++page} 页 (已收集 ${allMsgs.length} 条)…`;

        const resp = await fetch(url, { credentials: 'include', signal });
        if (!resp.ok) throw new Error(`API 错误 ${resp.status} — 请确认聊天室 ID`);

        const data = await resp.json();
        if (!Array.isArray(data) || data.length === 0) break;

        let minId = Infinity;
        for (const msg of data) {
          if (msg.id < minId) minId = msg.id;
          const ts = new Date(msg.datetime).getTime();
          if (ts < cutoff) { done = true; continue; }
          allMsgs.push(msg);
        }

        // Next page: from-id pagination
        url = `${BASE_URL}from-id/${minId}/`;
        if (page >= 50) break; // safety cap
      }

      statusEl.textContent = `🔄 解析 ${allMsgs.length} 条消息…`;

      const quotes  = allMsgs.flatMap(parseMessage).filter(q => q.price === null || q.price > 0);
      const summary = buildSummary(quotes);
      _lastSummary  = summary;
      _lastQuotes   = quotes.length;

      _lastMsgs   = allMsgs.length;
      _lastStatus = `✅ ${allMsgs.length} 条消息 · ${quotes.length} 条有效报价 · 最近 ${hours}h`;
      renderResults(resultsEl, summary, quotes.length, allMsgs.length);
      statusEl.textContent = _lastStatus;

    } catch (e) {
      if (e.name !== 'AbortError') {
        statusEl.textContent = `❌ ${e.message}`;
        console.error('[SCMA]', e);
      } else {
        statusEl.textContent = '⏹ 已停止';
      }
    }

    btnSearch.disabled = false;
    btnStop.disabled   = true;
  }

  function stopSearch() {
    if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
  }

  function copyResults() {
    if (!_lastSummary) return;
    const out = JSON.stringify({ total_quotes: _lastQuotes, summary: _lastSummary }, null, 2);
    navigator.clipboard.writeText(out).then(
      () => alert('已复制 JSON 到剪贴板'),
      () => prompt('复制以下 JSON：', out)
    );
  }

  // ── Parse a single API message ────────────────────────────────────────
  function parseMessage(msg) {
    const company   = msg.sender?.company || '?';
    const text      = msg.body || '';
    const retracted = !!msg.retracted;
    const lines     = text.split('\n').map(l => l.trim()).filter(l => l);

    // Try structured template first (Quality:/Price: labels on separate lines)
    const structured = tryStructuredParse(lines, company, text, retracted);
    if (structured.length > 0) return structured;

    // Normal line-by-line parsing
    const results  = [];
    let curDir     = null;
    let curQuality = null; // carries quality declared on a product-less line to the next product lines

    for (const line of lines) {
      if (RENT_RE.test(line)) continue;
      const lineDir = detectDir(line);
      if (lineDir) curDir = lineDir;
      const dir = lineDir || curDir;
      if (!dir) continue;

      // If the line has no product mentions, check if it carries a quality forward
      const mentions = findAllMentions(line);
      if (!mentions.length) {
        const quals = extractQualities(line);
        if (quals.length > 0) curQuality = quals[0];
        continue;
      }

      results.push(...parseLineProducts(line, company, dir, curQuality, text, retracted));
    }
    return results;
  }

  // Handle structured listing format:
  //   :re-97: ... (product codes)
  //   Product : SEP
  //   Quality : Q6⭐️...
  //   Price   : $37.6k
  function tryStructuredParse(lines, company, body = '', retracted = false) {
    const qualLine  = lines.find(l => /[Qq]uality\s*[:：]\s*[Qq]\d+/.test(l));
    const priceLine = lines.find(l => /[Pp]rice\s*[:：]\s*[\$\$]?\s*\d/.test(l));
    if (!qualLine || !priceLine) return [];

    // Direction: scan all lines, default to 'sell' (structured posts are almost always sellers)
    const dir = detectDir(lines.join(' ')) || 'sell';

    // Quality
    const qm      = qualLine.match(/[Qq]uality\s*[:：]\s*([Qq]\d+)/);
    const quality  = qm ? `Q${parseInt(qm[1].slice(1))}` : null;

    // Price
    const pm    = priceLine.match(/[Pp]rice\s*[:：]\s*\$?\s*(\d+[\.,]?\d*)\s*[kK]/);
    const price = pm ? Math.round(parseFloat(pm[1].replace(',', '.')) * 1000) : null;

    // Products: scan all lines
    const seen = new Set();
    for (const line of lines)
      for (const m of findAllMentions(line)) seen.add(m.product);
    if (!seen.size) return [];

    return [...seen].map(p => ({ company, direction: dir, product: p, quality, price, from_delta: false, body, retracted }));
  }

  // ── Direction detection ───────────────────────────────────────────────
  function detectDir(line) {
    const s = SELL_RE.test(line), b = BUY_RE.test(line);
    if (s && !b) return 'sell';
    if (b && !s) return 'buy';
    if (s && b) {
      return line.toLowerCase().search(SELL_RE) < line.toLowerCase().search(BUY_RE)
        ? 'sell' : 'buy';
    }
    return null;
  }

  // ── Find all product mentions in a line ───────────────────────────────
  function findAllMentions(line) {
    const mentions = [];
    for (const [code, prod] of Object.entries(PRODUCT_CODES)) {
      let idx = line.indexOf(code);
      while (idx !== -1) {
        mentions.push({ product: prod, start: idx, end: idx + code.length });
        idx = line.indexOf(code, idx + 1);
      }
    }
    let m;
    const re = new RegExp(ALIAS_RE.source, 'gi');
    while ((m = re.exec(line)) !== null) {
      const prod = ALIASES[m[0].toUpperCase()];
      if (!mentions.some(x => x.start <= m.index && m.index < x.end))
        mentions.push({ product: prod, start: m.index, end: m.index + m[0].length });
    }
    return mentions.sort((a, b) => a.start - b.start);
  }

  // ── Group consecutive mentions of the same product ────────────────────
  function groupMentions(mentions) {
    if (!mentions.length) return [];
    const groups = [];
    let cur = { product: mentions[0].product, spans: [{ start: mentions[0].start, end: mentions[0].end }] };
    for (let i = 1; i < mentions.length; i++) {
      const m   = mentions[i];
      const gap = m.start - cur.spans[cur.spans.length - 1].end;
      if (m.product === cur.product && gap <= 12) {
        cur.spans.push({ start: m.start, end: m.end });
      } else {
        groups.push(cur);
        cur = { product: m.product, spans: [{ start: m.start, end: m.end }] };
      }
    }
    groups.push(cur);
    return groups;
  }

  // ── Extract quotes for each product group in a line ───────────────────
  function parseLineProducts(line, company, dir, fallbackQuality = null, body = '', retracted = false) {
    const mentions = findAllMentions(line);
    if (!mentions.length) return [];

    const groups  = groupMentions(mentions);
    const bounds  = groups.map(g => ({ start: g.spans[0].start, end: g.spans[g.spans.length - 1].end }));
    const results = [];

    for (let i = 0; i < groups.length; i++) {
      const { product } = groups[i];
      const gStart   = bounds[i].start;
      const gEnd     = bounds[i].end;
      const preText  = line.slice(i === 0 ? 0 : bounds[i - 1].end, gStart);
      const postText = line.slice(gEnd, i < groups.length - 1 ? bounds[i + 1].start : line.length);
      const intra    = line.slice(gStart, gEnd);

      // Trim postText at any new direction keyword — qualities/prices after it belong to a different product
      const dirBoundary = postText.search(/\b(sell(?:ing)?|buy(?:i?n?g?)?|want(?:ing|ed)?|need(?:ing)?|offer(?:ing)?)\b/i);
      const safePost = dirBoundary > 0 ? postText.slice(0, dirBoundary) : postText;

      const lineQualities            = extractQualities(preText + ' ' + intra + ' ' + safePost);
      const { price, prices, delta } = extractPriceAndDelta(safePost);
      // Use qualities found on this line; fall back to inherited quality if none
      const qualities = lineQualities.length ? lineQualities
                      : (fallbackQuality     ? [fallbackQuality] : []);

      if (!qualities.length) {
        results.push({ company, direction: dir, product, quality: null, price, from_delta: false, body, retracted });
      } else if (prices && prices.length === qualities.length) {
        // Slash-paired notation: Q6/8 @935/965k → pair each quality with its price
        for (let qi = 0; qi < qualities.length; qi++)
          results.push({ company, direction: dir, product, quality: qualities[qi], price: prices[qi], from_delta: false, body, retracted });
      } else {
        for (const q of qualities) {
          if (delta !== null && price !== null) {
            const base = parseInt(q.slice(1));
            for (let qn = 0; qn <= 9; qn++) {
              results.push({
                company, direction: dir, product,
                quality: `Q${qn}`,
                price: Math.round(price + delta * (qn - base)),
                from_delta: true, base_quality: q, delta_per_q: delta, body, retracted,
              });
            }
          } else {
            results.push({ company, direction: dir, product, quality: q, price, from_delta: false, body, retracted });
          }
        }
      }
    }
    return results;
  }

  // ── Extract quality levels ────────────────────────────────────────────
  function extractQualities(text) {
    const seen = new Set();
    let m;
    // Capture Q6 and slash-separated extras: Q6/8 → Q6, Q8
    const re = /[Qq](\d{1,2})((?:\/\d{1,2})*)/g;
    while ((m = re.exec(text)) !== null) {
      seen.add(`Q${parseInt(m[1])}`);
      if (m[2]) for (const n of m[2].slice(1).split('/')) if (n) seen.add(`Q${parseInt(n)}`);
    }
    return [...seen].sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
  }

  // ── Extract price + delta ─────────────────────────────────────────────
  function extractPriceAndDelta(text) {
    const t = text.replace(/(\d),(\d)/g, '$1.$2');

    // Delta: +1.5k/Q, -2k/Q, +/-2k
    let delta = null;
    const dm = /([+-])\/?\-?\s*(\d+(?:\.\d+)?)\s*[kK]?\s*(?:\/\s*[qQ])?(?=$|[^a-zA-Z\d])/.exec(t);
    if (dm) {
      const raw = parseFloat(dm[2]);
      const val = raw < 100 ? raw * 1000 : raw;
      delta = dm[1] === '-' ? -val : val;
    }

    // Slash-paired prices: @935/965k → [935000, 965000]
    let prices = null;
    const sp = /[@$]\s*(\d{1,4}(?:\.\d+)?)\/(\d{1,4}(?:\.\d+)?)\s*[kK]/.exec(t);
    if (sp) prices = [Math.round(parseFloat(sp[1]) * 1000), Math.round(parseFloat(sp[2]) * 1000)];

    // Single price
    let price = null, m;
    m = /\bat\s+(\d{1,4}(?:\.\d+)?)\s*[kK]/i.exec(t);
    if (m) { price = Math.round(parseFloat(m[1]) * 1000); }
    if (!price) {
      m = /[@$]\s*(\d{1,4}(?:\.\d+)?)\s*[kK](?![a-zA-Z/])/.exec(t);
      if (m) price = Math.round(parseFloat(m[1]) * 1000);
    }
    if (!price) {
      const tc = delta !== null
        ? t.replace(/([+-])\/?\-?\s*(\d+(?:\.\d+)?)\s*[kK]?\s*(?:\/\s*[qQ])?/, '')
        : t;
      m = /(?<![/\d])(\d{2,4}(?:\.\d+)?)\s*[kK](?![a-zA-Z/])/.exec(tc);
      if (m) price = Math.round(parseFloat(m[1]) * 1000);
    }
    if (!price && prices) price = prices[0];
    return { price, prices, delta };
  }

  // ── Build summary ─────────────────────────────────────────────────────
  function buildSummary(quotes) {
    const tree = {};
    for (const q of quotes) {
      const prod = q.product, qual = q.quality || 'unspecified', dir = q.direction;
      if (!tree[prod])       tree[prod] = {};
      if (!tree[prod][qual]) tree[prod][qual] = { buy: {}, sell: {} };
      const key = q.price !== null ? String(q.price) : 'no_price';
      if (!tree[prod][qual][dir][key]) tree[prod][qual][dir][key] = [];
      // deduplicate by company+body
      const sig = q.company + '\x00' + (q.body || '');
      if (!tree[prod][qual][dir][key].some(e => e.sig === sig))
        tree[prod][qual][dir][key].push({ name: q.company, body: q.body || '', retracted: !!q.retracted, sig });
    }
    const result = {};
    for (const [prod, quals] of Object.entries(tree)) {
      result[prod] = {};
      const qkeys = Object.keys(quals).sort((a, b) => {
        if (a === 'unspecified') return 1;
        if (b === 'unspecified') return -1;
        return parseInt(a.slice(1)) - parseInt(b.slice(1));
      });
      for (const qk of qkeys) {
        result[prod][qk] = {};
        for (const dir of ['buy', 'sell']) {
          result[prod][qk][dir] = Object.entries(quals[qk][dir] || {})
            .map(([p, arr]) => ({
              price: p === 'no_price' ? null : parseInt(p),
              count: arr.length,
              companies: [...new Set(arr.map(e => e.name))].sort(),
              entries: arr.map(({ name, body, retracted }) => ({ name, body, retracted })),
            }))
            .sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
        }
      }
    }
    return result;
  }

  // ── Render results ────────────────────────────────────────────────────
  function renderResults(el, summary, totalQuotes, totalMsgs) {
    _ciMap.clear();
    _ciNext = 0;
    let html = `<div class="scma-meta">${totalMsgs} 条消息 → ${totalQuotes} 条报价</div>`;

    for (const prod of PROD_ORDER) {
      const qualMap = summary[prod];
      if (!qualMap) continue;

      // Collect rows with at least one priced entry
      const rows = [];
      for (const [qual, dirs] of Object.entries(qualMap)) {
        const buys  = (dirs.buy  || []).filter(e => e.price !== null);
        const sells = (dirs.sell || []).filter(e => e.price !== null);
        if (buys.length || sells.length) rows.push({ qual, buys, sells });
      }
      if (!rows.length) continue;

      html += `<div class="scma-prod">`;
      html += `<div class="scma-prod-title">${prod} <span class="scma-code">${PROD_CODE[prod]}</span></div>`;
      html += `<table class="scma-table"><thead><tr>
        <th>等级</th><th class="scma-th-buy">BUY</th><th class="scma-th-sell">SELL</th>
      </tr></thead><tbody>`;

      for (const { qual, buys, sells } of rows) {
        const fmtEntries = (arr) => arr.map(e => {
          const p          = (e.price / 1000).toFixed(e.price % 1000 === 0 ? 0 : 1) + 'k';
          const tip        = e.companies.join('\n');
          const ci         = _ciNext++;
          const allRetract = e.entries.every(en => en.retracted);
          _ciMap.set(ci, e.entries);
          return `<span class="scma-price${allRetract ? ' scma-price--retracted' : ''}" title="${tip}" data-ci="${ci}">${p}<sup>×${e.count}</sup></span>`;
        }).join(' ');

        html += `<tr>
          <td class="scma-q">${qual === 'unspecified' ? '未明确等级' : qual}</td>
          <td class="scma-buy">${buys.length  ? fmtEntries(buys)  : ''}</td>
          <td class="scma-sell">${sells.length ? fmtEntries(sells) : ''}</td>
        </tr>`;
      }

      // Unpriced (no_price) summary line
      const anyBuyNp  = (qualMap['unspecified']?.buy  || []).find(e => e.price === null);
      const anySellNp = (qualMap['unspecified']?.sell || []).find(e => e.price === null);
      if (anyBuyNp || anySellNp) {
        const mkNpSpan = (e) => {
          const ci = _ciNext++;
          _ciMap.set(ci, e.entries);
          return `<span class="scma-price" title="${e.companies.join('\n')}" data-ci="${ci}">×${e.count}</span>`;
        };
        html += `<tr class="scma-np">
          <td class="scma-q" style="color:#94a3b8;font-size:9px">无明确等级和报价</td>
          <td class="scma-buy">${anyBuyNp  ? mkNpSpan(anyBuyNp)  : ''}</td>
          <td class="scma-sell">${anySellNp ? mkNpSpan(anySellNp) : ''}</td>
        </tr>`;
      }

      html += `</tbody></table></div>`;
    }

    el.innerHTML = html;
  }

  // ── Quote popup ───────────────────────────────────────────────────────
  let _popupEl = null;

  function showQuotePopup(x, y, entries) {
    if (!_popupEl) {
      _popupEl = document.createElement('div');
      _popupEl.id = 'scma-popup';
      document.body.appendChild(_popupEl);
      document.addEventListener('click', ev => {
        if (_popupEl && !_popupEl.contains(ev.target) && !ev.target.closest('[data-ci]'))
          hideQuotePopup();
      });
      document.addEventListener('keydown', ev => { if (ev.key === 'Escape') hideQuotePopup(); });
    }

    const rows = entries.map(en => `
      <div class="scma-pe${en.retracted ? ' scma-pe--retracted' : ''}">
        <div class="scma-pe-name">
          <span>${escHtml(en.name)}</span>
          ${en.retracted ? '<span class="scma-pe-retract-badge">已撤回</span>' : ''}
          <button class="scma-pe-copybtn" data-name="${escHtml(en.name)}">复制名字</button>
        </div>
        <div class="scma-pe-body">${renderMsgBody(en.body)}</div>
      </div>`).join('');
    _popupEl.innerHTML = rows;

    _popupEl.querySelectorAll('.scma-pe-copybtn').forEach(btn => {
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        navigator.clipboard.writeText(btn.dataset.name).catch(() => {});
        btn.textContent = '✓ 已复制';
        btn.classList.add('scma-pe-copybtn--done');
        setTimeout(() => { btn.textContent = '复制名字'; btn.classList.remove('scma-pe-copybtn--done'); }, 1500);
      });
    });

    // Position near click, keep within viewport
    const pw = 320, ph = 240;
    const vw = window.innerWidth, vh = window.innerHeight;
    _popupEl.style.left = Math.min(x + 8, vw - pw - 8) + 'px';
    _popupEl.style.top  = Math.min(y + 8, vh - ph - 8) + 'px';
    _popupEl.style.display = 'block';
  }

  function hideQuotePopup() {
    if (_popupEl) _popupEl.style.display = 'none';
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function renderMsgBody(text) {
    let html = escHtml(text);
    for (const [code, url] of Object.entries(PROD_IMG)) {
      const name = PRODUCT_CODES[code];
      html = html.replaceAll(code, `<img src="${url}" class="scma-prod-icon" title="${name}" alt="${name}">`);
    }
    return html;
  }

  // ── Update check ─────────────────────────────────────────────────────
  function checkForUpdates() {
    const RAW_URL  = 'https://raw.githubusercontent.com/Ldlfylt-LDDL/simco-market-analyzer/main/simco_market_analyzer.user.js';
    const DL_URL   = 'https://github.com/Ldlfylt-LDDL/simco-market-analyzer/raw/main/simco_market_analyzer.user.js';
    const statusEl = panelEl && panelEl.querySelector('#scma-update-status');
    if (statusEl) statusEl.textContent = '检查中…';

    GM_xmlhttpRequest({
      method: 'GET',
      url: RAW_URL,
      onload(res) {
        const m = res.responseText.match(/\/\/\s*@version\s+(\S+)/);
        if (!m) { if (statusEl) statusEl.textContent = '检查失败'; return; }
        const remote = m[1];
        if (remote === VERSION) {
          if (statusEl) statusEl.textContent = '已是最新 ✓';
        } else {
          if (statusEl) statusEl.innerHTML =
            `→ <a href="${DL_URL}" target="_blank" rel="noopener">v${remote} 可用，点击更新</a>`;
        }
      },
      onerror()  { if (statusEl) statusEl.textContent = '网络错误'; },
      ontimeout() { if (statusEl) statusEl.textContent = '超时'; },
      timeout: 10000,
    });
  }

  // ── Styles ────────────────────────────────────────────────────────────
  function injectStyles() {
    const css = `
      /* ── Toggle button ── */
      #scma-toggle {
        position: fixed; bottom: 18px; right: 18px; z-index: 2147483640;
        background: #1e3a5f; color: #7dd3fc;
        border: 1px solid #3b82f6; border-radius: 8px;
        padding: 7px 13px; font-size: 13px; font-weight: 700;
        cursor: pointer; box-shadow: 0 2px 10px #0006;
        transition: background .15s;
      }
      #scma-toggle:hover { background: #2a4f7a; }

      /* ── Panel ── */
      #scma-panel {
        position: fixed; bottom: 58px; right: 18px; z-index: 2147483639;
        width: 430px; max-height: 82vh;
        display: flex; flex-direction: column;
        background: #0f172a; color: #e2e8f0;
        border: 1px solid #334155; border-radius: 12px;
        font-family: 'Consolas', 'Courier New', monospace; font-size: 12px;
        box-shadow: 0 8px 30px #0009;
        overflow: hidden;
      }

      /* ── Header ── */
      #scma-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 9px 13px; background: #1e293b;
        border-bottom: 1px solid #334155;
        font-weight: 700; color: #7dd3fc; font-size: 13px;
        border-radius: 12px 12px 0 0; flex-shrink: 0;
        user-select: none;
      }
      #scma-header button {
        background: none; border: none; cursor: pointer;
        color: #64748b; font-size: 14px; padding: 0 2px;
        line-height: 1;
      }
      #scma-header button:hover { color: #f87171; }
      #scma-copy { font-size: 13px !important; }

      #scma-title-note {
        display: block; font-size: 9px; color: #94a3b8;
        font-weight: normal; margin-top: 1px; letter-spacing: 0;
      }

      /* ── Controls ── */
      #scma-controls {
        display: flex; gap: 6px; align-items: center;
        padding: 7px 12px; background: #1e293b;
        border-bottom: 1px solid #334155; flex-shrink: 0;
        flex-wrap: wrap;
      }
      #scma-controls label {
        font-size: 11px; color: #94a3b8;
        display: flex; align-items: center; gap: 4px;
      }
      #scma-controls input {
        background: #0f172a; color: #e2e8f0;
        border: 1px solid #334155; border-radius: 4px;
        padding: 2px 5px; width: 44px; font-size: 11px;
      }
      #scma-search {
        background: #1d4ed8; color: #fff; border: none;
        border-radius: 6px; padding: 4px 10px; font-size: 11px;
        font-weight: 700; cursor: pointer; transition: background .15s;
      }
      #scma-search:hover:not(:disabled) { background: #2563eb; }
      #scma-search:disabled { opacity: .4; cursor: default; }
      #scma-stop {
        background: #7f1d1d; color: #fca5a5; border: none;
        border-radius: 6px; padding: 4px 8px; font-size: 11px;
        cursor: pointer;
      }
      #scma-stop:disabled { opacity: .4; cursor: default; }

      /* ── Status ── */
      #scma-status {
        padding: 5px 13px; font-size: 10px; color: #64748b;
        border-bottom: 1px solid #1e293b; flex-shrink: 0;
        min-height: 22px;
      }

      /* ── Results ── */
      #scma-results {
        padding: 10px 12px; overflow-y: auto; flex: 1;
      }
      .scma-meta { color: #475569; font-size: 10px; margin-bottom: 8px; }

      .scma-prod { margin-bottom: 10px; }
      .scma-prod-title {
        color: #7dd3fc; font-weight: 700; font-size: 12px;
        margin-bottom: 4px;
      }
      .scma-code { color: #475569; font-size: 10px; margin-left: 4px; }

      /* ── Table ── */
      .scma-table {
        width: 100%; border-collapse: collapse; font-size: 11px;
      }
      .scma-table thead th {
        color: #475569; font-weight: 600; font-size: 10px;
        text-align: left; padding: 1px 4px;
        border-bottom: 1px solid #1e293b;
      }
      .scma-th-buy  { color: #4ade80 !important; }
      .scma-th-sell { color: #f87171 !important; }
      .scma-table tbody tr:hover { background: #1e293b40; }
      .scma-q    { color: #64748b; padding: 2px 6px 2px 0; width: 32px; }
      .scma-buy  { color: #86efac; padding: 2px 4px; }
      .scma-sell { color: #fca5a5; padding: 2px 4px; }
      .scma-np td { opacity: .55; }

      .scma-price {
        display: inline-block; margin-right: 6px;
        cursor: help;
      }
      .scma-price:hover { color: #fff; }
      .scma-price--retracted { text-decoration: line-through; opacity: .5; }
      .scma-price sup {
        font-size: 8px; color: #94a3b8; margin-left: 1px;
      }

      /* ── About ── */
      #scma-about {
        border-top: 1px solid #1e293b; flex-shrink: 0;
      }
      #scma-about summary {
        padding: 5px 13px; font-size: 10px; color: #475569;
        cursor: pointer; list-style: none; user-select: none;
      }
      #scma-about summary::-webkit-details-marker { display: none; }
      #scma-about summary::before { content: '▶ '; font-size: 8px; }
      #scma-about[open] summary::before { content: '▼ '; }
      #scma-about summary:hover { color: #94a3b8; }
      #scma-about-body {
        padding: 5px 13px 8px; font-size: 11px; color: #64748b;
        display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
      }
      #scma-about-body a, #scma-about-ver a {
        color: #7dd3fc; text-decoration: none;
      }
      #scma-about-body a:hover, #scma-about-ver a:hover { text-decoration: underline; }
      .scma-sep { color: #334155; }
      #scma-about-ver {
        padding: 0 13px 8px; font-size: 11px; color: #64748b;
        display: flex; align-items: center; gap: 5px;
      }
      #scma-update-status { color: #86efac; }

      /* ── Quote popup ── */
      #scma-popup {
        display: none; position: fixed; z-index: 2147483641;
        width: 320px; max-height: 260px; overflow-y: auto;
        background: #0f172a; border: 1px solid #334155;
        border-radius: 8px; box-shadow: 0 6px 24px #0009;
        font-family: 'Consolas', 'Courier New', monospace; font-size: 11px;
        color: #e2e8f0;
      }
      .scma-pe { padding: 8px 11px; border-bottom: 1px solid #1e293b; }
      .scma-pe:last-child { border-bottom: none; }
      .scma-pe-name {
        font-weight: 700; color: #7dd3fc; margin-bottom: 4px;
        display: flex; align-items: center; gap: 6px;
      }
      .scma-pe-copybtn {
        font-size: 9px; padding: 1px 6px; border-radius: 4px;
        background: #1e3a5f; color: #7dd3fc;
        border: 1px solid #3b82f6; cursor: pointer;
        font-family: inherit; font-weight: normal;
        transition: background .1s;
      }
      .scma-pe-copybtn:hover { background: #2a4f7a; }
      .scma-pe-copybtn--done { background: #14532d; color: #86efac; border-color: #22c55e; }
      .scma-pe--retracted { opacity: .7; }
      .scma-pe--retracted .scma-pe-name > span { text-decoration: line-through; text-decoration-color: #f87171; }
      .scma-pe--retracted .scma-pe-body { text-decoration: line-through; text-decoration-color: #f87171; }
      .scma-pe-retract-badge {
        font-size: 9px; color: #f87171; border: 1px solid #7f1d1d;
        border-radius: 3px; padding: 0 4px; font-weight: normal;
      }
      .scma-pe-body {
        color: #94a3b8; white-space: pre-wrap; word-break: break-word;
        line-height: 1.5;
      }
      .scma-prod-icon {
        width: 20px; height: 20px; vertical-align: middle;
        display: inline-block; margin: 0 1px;
      }
    `;
    const s = document.createElement('style');
    s.id          = 'scma-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ── Boot ─────────────────────────────────────────────────────────────
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else
    init();

})();
