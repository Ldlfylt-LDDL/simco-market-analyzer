// ==UserScript==
// @name         SimCo 市场报价分析器
// @namespace    simco-market-quote-analyzer
// @version      1.27
// @description  实时抓取并解析 SimCompanies 聊天室中的买卖报价；支持航天产品（SOR/BFR/JUM/LUX/SEP/SAT）专项分析与全品类关注列表查询
// @author
// @match        https://www.simcompanies.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
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
  const VERSION        = '1.26';
  const CHATROOM       = 'X';
  let   REALM          = '0'; // updated async from auth-data API
  const PAGE_DELAY_MS  = 800; // ~1.2 pages/sec，避免频繁请求被封
  const PROD_ORDER = ['SOR', 'BFR', 'JUM', 'LUX', 'SEP', 'SAT'];
  const PROD_CODE  = { SOR: 're-91', BFR: 're-94', JUM: 're-95', LUX: 're-96', SEP: 're-97', SAT: 're-99' };

  // ── State ─────────────────────────────────────────────────────────────
  let abortCtrl = null;
  let panelEl   = null;

  // ── Boot ─────────────────────────────────────────────────────────────
  async function fetchRealm() {
    try {
      const res = await fetch('https://www.simcompanies.com/api/v3/companies/auth-data/', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const rid = data?.authCompany?.realmId;
        if (rid != null) REALM = String(rid);
      }
    } catch (_) {}
  }

  function init() {
    fetchRealm();
    injectStyles();
    injectToggleButton();
  }

  // ── Price history (localStorage) ─────────────────────────────────────
  const PRICE_HISTORY_MAX  = 5000; // 最多保留条目数（每个 realm 独立）
  const PRICE_BODY_KEEP    = 2000; // 只有最新 N 条保留 body，旧条目清空节省空间
  const priceHistoryKey = () => `scma-price-history-r${REALM}`;

  function savePriceHistory(quotes) {
    const now = Date.now();
    const key = priceHistoryKey();
    // 只保存有明确价格、有产品代码的航天报价
    const newEntries = quotes
      .filter(q => q.price !== null && q.price > 0 && PROD_ORDER.includes(q.product))
      .map(q => ({
        prod:      q.product,
        quality:   q.quality || 'Q0',
        price:     q.price,
        direction: q.direction,
        company:   q.company,
        body:      (q.body || '').slice(0, 300),
        msgTime:   q.datetime ? new Date(q.datetime).getTime() : now,
        savedAt:   now,
      }));

    if (!newEntries.length) return;

    let history = [];
    try { history = JSON.parse(localStorage.getItem(key) || '[]'); } catch (_) {}

    // 去重：同一公司同一消息时间的同产品报价只存一次
    const existingKeys = new Set(history.map(e => `${e.company}|${e.msgTime}|${e.prod}|${e.quality}`));
    const toAdd = newEntries.filter(e => !existingKeys.has(`${e.company}|${e.msgTime}|${e.prod}|${e.quality}`));

    history = [...history, ...toAdd];
    // 超出上限时删最旧的
    if (history.length > PRICE_HISTORY_MAX) history = history.slice(history.length - PRICE_HISTORY_MAX);
    // 只保留最新 PRICE_BODY_KEEP 条的 body，旧条目清空
    const bodyStart = history.length - PRICE_BODY_KEEP;
    for (let i = 0; i < bodyStart; i++) {
      if (history[i].body) history[i] = { ...history[i], body: '' };
    }

    try { localStorage.setItem(key, JSON.stringify(history)); } catch (_) {}
    console.log(`[SCMA] Realm${REALM} 价格历史 +${toAdd.length} 条，共 ${history.length} 条`);
  }

  // ── Toggle buttons (bottom-right corner) ─────────────────────────────
  function injectToggleButton() {
    const wrap = document.createElement('div');
    wrap.id = 'scma-toggle-wrap';
    const b1 = document.createElement('button');
    b1.id = 'scma-toggle-aero'; b1.innerHTML = '✈';
    b1.onclick = () => panelEl ? destroyPanel() : createPanel();
    const b2 = document.createElement('button');
    b2.id = 'scma-toggle-mkt'; b2.innerHTML = '🌐';
    b2.onclick = () => mktPanelEl ? destroyMktPanel() : createMktPanel();
    const b3 = document.createElement('button');
    b3.id = 'scma-toggle-chart'; b3.innerHTML = '📈';
    b3.title = '航天价格走势图';
    b3.onclick = () => chartPanelEl ? destroyChartPanel() : createChartPanel();
    wrap.appendChild(b1); wrap.appendChild(b2); wrap.appendChild(b3);
    document.body.appendChild(wrap);
  }

  // ── Chart panel ───────────────────────────────────────────────────────
  let chartPanelEl  = null;
  let chartInstance = null;
  let chartJsReady  = false;

  function loadChartJs(cb) {
    if (chartJsReady) { cb(); return; }
    const s1 = document.createElement('script');
    s1.src = 'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js';
    s1.onload = () => {
      const s2 = document.createElement('script');
      s2.src = 'https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3/dist/chartjs-adapter-date-fns.bundle.min.js';
      s2.onload = () => { chartJsReady = true; cb(); };
      document.head.appendChild(s2);
    };
    document.head.appendChild(s1);
  }

  const CHART_COLORS = {
    sell: { border: '#f87171', bg: 'rgba(248,113,113,0.15)' },
    buy:  { border: '#4ade80', bg: 'rgba(74,222,128,0.15)'  },
  };

  function renderChartPanel() {
    if (!chartPanelEl) return;
    const prod  = chartPanelEl.querySelector('#scma-ch-prod').value;
    const qual  = chartPanelEl.querySelector('#scma-ch-qual').value;
    const dir   = chartPanelEl.querySelector('#scma-ch-dir').value;
    const days  = parseInt(chartPanelEl.querySelector('#scma-ch-range').value);
    const outlier = chartPanelEl.querySelector('#scma-ch-outlier').checked;
    const cutoff  = days ? Date.now() - days * 86400000 : 0;

    let raw = [];
    try { raw = JSON.parse(localStorage.getItem(priceHistoryKey()) || '[]'); } catch (_) {}

    let pts = raw.filter(e =>
      e.prod === prod &&
      (qual === 'all' || e.quality === qual) &&
      (dir  === 'all' || e.direction === dir) &&
      e.msgTime >= cutoff
    ).sort((a, b) => a.msgTime - b.msgTime);

    if (outlier) {
      pts = pts.filter(e => !e.outlier);
    }

    const infoEl  = chartPanelEl.querySelector('#scma-ch-info');
    const emptyEl = chartPanelEl.querySelector('#scma-ch-empty');
    const canvas  = chartPanelEl.querySelector('#scma-ch-canvas');
    infoEl.textContent = `${pts.length} 条数据点`;

    if (!pts.length) {
      emptyEl.style.display = 'flex'; canvas.style.display = 'none';
      if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
      return;
    }
    emptyEl.style.display = 'none'; canvas.style.display = 'block';

    const datasets = [];
    for (const d of (dir === 'all' ? ['sell', 'buy'] : [dir])) {
      const sub = pts.filter(e => e.direction === d);
      if (!sub.length) continue;
      datasets.push({
        label: d === 'sell' ? 'SELL' : 'BUY',
        data: sub.map(e => ({ x: e.msgTime, y: e.price, company: e.company, quality: e.quality })),
        borderColor: CHART_COLORS[d].border, backgroundColor: CHART_COLORS[d].bg,
        pointRadius: 4, pointHoverRadius: 6, tension: 0.2,
        fill: dir !== 'all',
      });
    }

    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    const body = chartPanelEl.querySelector('#scma-ch-body');
    canvas.width  = body.clientWidth  - 24;
    canvas.height = 296; // 320px body - 12px*2 padding
    const ChartCtor = unsafeWindow.Chart;
    console.log('[SCMA] Chart.js available:', typeof ChartCtor, 'canvas:', canvas.width, 'x', canvas.height, 'datasets:', datasets.length);
    setTimeout(() => {
      try {
      chartInstance = new ChartCtor(canvas, {
        type: 'line',
        data: { datasets },
        options: {
          responsive: false,
          animation: false,
          interaction: { mode: 'nearest', intersect: false },
          plugins: {
            legend: { labels: { color: '#94a3b8', font: { family: 'Consolas' } } },
            tooltip: {
              callbacks: {
                label: ctx => {
                  const p = ctx.raw;
                  return ` ${ctx.dataset.label}  ${(p.y/1000).toFixed(1)}k  Q:${p.quality}  @${p.company}`;
                }
              }
            }
          },
          scales: {
            x: {
              type: 'time',
              time: { tooltipFormat: 'yyyy-MM-dd HH:mm', displayFormats: { day: 'MM/dd', hour: 'MM/dd HH:mm' } },
              ticks: { color: '#64748b' }, grid: { color: '#1e293b' },
            },
            y: {
              ticks: { color: '#64748b', callback: v => (v/1000).toFixed(0)+'k' },
              grid: { color: '#1e293b' },
              title: { display: true, text: '价格', color: '#64748b' },
            }
          }
        }
      });
      } catch(e) {
        console.error('[SCMA Chart error]', e);
        const infoEl = chartPanelEl?.querySelector('#scma-ch-info');
        if (infoEl) infoEl.textContent += ' ❌' + e.message;
      }
    }, 0);
  }

  function createChartPanel() {
    chartPanelEl = document.createElement('div');
    chartPanelEl.id = 'scma-ch-panel';
    const qualOpts = ['<option value="all">全部</option>',
      ...[...Array(13)].map((_, i) => `<option value="Q${i}">Q${i}</option>`)].join('');
    chartPanelEl.innerHTML = `
      <div id="scma-ch-header">
        <span>📈 航天价格走势</span>
        <button id="scma-ch-close">✕</button>
      </div>
      <div id="scma-ch-controls">
        <label>产品<select id="scma-ch-prod">
          <option value="SOR">SOR</option><option value="BFR">BFR</option>
          <option value="JUM">JUM</option><option value="LUX">LUX</option>
          <option value="SEP">SEP</option><option value="SAT">SAT</option>
        </select></label>
        <label>品质<select id="scma-ch-qual">${qualOpts}</select></label>
        <label>方向<select id="scma-ch-dir">
          <option value="all">全部</option>
          <option value="sell">SELL</option>
          <option value="buy">BUY</option>
        </select></label>
        <label>时段<select id="scma-ch-range">
          <option value="7">近7天</option>
          <option value="30">近30天</option>
          <option value="90">近90天</option>
          <option value="0">全部</option>
        </select></label>
        <label><input type="checkbox" id="scma-ch-outlier" checked>去异常</label>
        <span id="scma-ch-info" style="color:#475569;font-size:10px;margin-left:auto"></span>
      </div>
      <div id="scma-ch-body">
        <canvas id="scma-ch-canvas"></canvas>
        <div id="scma-ch-empty">暂无数据 — 请先用✈航天分析器抓取报价</div>
      </div>`;
    document.body.appendChild(chartPanelEl);
    makeDraggable(chartPanelEl, chartPanelEl.querySelector('#scma-ch-header'));
    chartPanelEl.querySelector('#scma-ch-close').onclick = destroyChartPanel;
    ['#scma-ch-prod','#scma-ch-qual','#scma-ch-dir','#scma-ch-range','#scma-ch-outlier']
      .forEach(sel => chartPanelEl.querySelector(sel).onchange = renderChartPanel);
    updatePanelPositions();
    loadChartJs(renderChartPanel);
  }

  function destroyChartPanel() {
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    if (chartPanelEl) { chartPanelEl.remove(); chartPanelEl = null; }
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
          <button id="scma-help" title="使用帮助">?</button>
          <button id="scma-close">✕</button>
        </div>
      </div>

      <div id="scma-tabs">
        <button class="scma-tab scma-tab--on" data-tab="live">实时搜索</button>
        <button class="scma-tab" data-tab="hist" id="scma-tab-hist-btn">历史记录</button>
      </div>

      <div id="scma-tab-live">
        <div id="scma-controls">
          <label title="向前搜索几小时的消息">
            时 <input id="scma-hours" type="number" value="4" min="1" max="240">
          </label>
          <button id="scma-search">🔍 搜索</button>
          <button id="scma-stop" disabled>⏹</button>
        </div>
        <div id="scma-status">准备就绪</div>
        <div id="scma-results"></div>
      </div>

      <div id="scma-tab-hist" style="display:none">
        <div id="scma-hist-controls">
          <label>时段<select id="scma-hist-range">
            <option value="1">近1小时</option>
            <option value="4">近4小时</option>
            <option value="24" selected>近24小时</option>
            <option value="168">近7天</option>
            <option value="720">近30天</option>
            <option value="0">全部</option>
          </select></label>
          <label>截止<input type="datetime-local" id="scma-hist-end" title="留空 = 当前时间"></label>
          <button id="scma-hist-refresh">↺ 刷新</button>
          <span id="scma-hist-info"></span>
        </div>
        <div id="scma-hist-results"></div>
      </div>

      <details id="scma-about">
        <summary>关于</summary>
        <div id="scma-about-body">
          <span>作者：</span>
          <a href="https://www.simcompanies.com/zh-cn/company/0/LDDL-Corp./" target="_blank" rel="noopener">LDDL Corp.</a>
          <span class="scma-sep">(作者也是新手，有错误请多多指教)</span>
        </div>
        <div id="scma-about-body">
          <span>源码：</span>
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
    panelEl.querySelector('#scma-help').onclick   = showHelpPopup;
    panelEl.querySelector('#scma-update-btn').onclick = e => { e.preventDefault(); checkForUpdates(); };

    // ── Tab switching ──────────────────────────────────────────────────
    panelEl.querySelectorAll('.scma-tab').forEach(tab => {
      tab.onclick = () => {
        const mode = tab.dataset.tab;
        panelEl.querySelectorAll('.scma-tab').forEach(t => t.classList.remove('scma-tab--on'));
        tab.classList.add('scma-tab--on');
        panelEl.querySelector('#scma-tab-live').style.display = mode === 'live' ? '' : 'none';
        panelEl.querySelector('#scma-tab-hist').style.display = mode === 'hist' ? 'flex' : 'none';
        if (mode === 'hist') renderHistoryTab();
        else if (mode === 'live' && _lastSummary)
          renderResults(panelEl.querySelector('#scma-results'), _lastSummary, _lastQuotes, _lastMsgs);
      };
    });
    panelEl.querySelector('#scma-hist-refresh').onclick = renderHistoryTab;
    panelEl.querySelector('#scma-hist-range').onchange  = renderHistoryTab;
    panelEl.querySelector('#scma-hist-end').onchange    = renderHistoryTab;

    makeDraggable(panelEl, panelEl.querySelector('#scma-header'));

    const onPriceClick = e => {
      const span = e.target.closest('[data-ci]');
      if (!span) return;
      const ciData = _ciMap.get(parseInt(span.dataset.ci));
      if (!ciData) return;
      showQuotePopup(e.clientX, e.clientY, ciData);
    };
    panelEl.querySelector('#scma-results').addEventListener('click', onPriceClick);
    panelEl.querySelector('#scma-hist-results').addEventListener('click', onPriceClick);

    if (_lastSummary) {
      renderResults(panelEl.querySelector('#scma-results'), _lastSummary, _lastQuotes, _lastMsgs);
      panelEl.querySelector('#scma-status').textContent = _lastStatus;
    }
    updatePanelPositions();
  }

  function destroyPanel() {
    stopSearch();
    if (panelEl) { panelEl.remove(); panelEl = null; }
    updatePanelPositions();
  }

  // ── History tab ───────────────────────────────────────────────────────
  function renderHistoryTab() {
    if (!panelEl) return;
    const rangeH = parseInt(panelEl.querySelector('#scma-hist-range').value);
    const endVal = panelEl.querySelector('#scma-hist-end').value;
    const endMs  = endVal ? new Date(endVal).getTime() : Date.now();
    const startMs = rangeH ? endMs - rangeH * 3600000 : 0;

    let raw = [];
    try { raw = JSON.parse(localStorage.getItem(priceHistoryKey()) || '[]'); } catch (_) {}

    const pts = raw.filter(e => e.msgTime >= startMs && e.msgTime <= endMs);

    // Update tab label with latest data-point time in the current slice
    const histBtn = panelEl.querySelector('#scma-tab-hist-btn');
    if (pts.length) {
      const latest = Math.max(...pts.map(e => e.msgTime));
      const d = new Date(latest);
      const fmt = `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      histBtn.textContent = `历史 截至${fmt}`;
    } else {
      histBtn.textContent = '历史记录';
    }

    const resultsEl = panelEl.querySelector('#scma-hist-results');
    const infoEl    = panelEl.querySelector('#scma-hist-info');
    infoEl.textContent = `${pts.length} 条`;

    if (!pts.length) {
      resultsEl.innerHTML = '<div class="scma-meta">暂无数据 — 请先用「实时搜索」抓取报价</div>';
      return;
    }

    const quotes = pts.map(e => ({
      product: e.prod, quality: e.quality, price: e.price,
      direction: e.direction, company: e.company,
      datetime: new Date(e.msgTime).toISOString(),
      body: e.body || '', retracted: false,
      outlier: e.outlier || false,
    }));

    const summary = buildSummary(quotes);
    renderResults(resultsEl, summary, quotes.length, pts.length, `${pts.length} 条历史记录`);
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
        if (!done) await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
      }

      statusEl.textContent = `🔄 解析 ${allMsgs.length} 条消息…`;

      const quotes  = allMsgs.flatMap(parseMessage).filter(q => q.price === null || q.price > 0);
      savePriceHistory(quotes);
      // Merge outlier flags from storage so live results reflect manual marks
      try {
        const histMap = new Map();
        const raw = JSON.parse(localStorage.getItem(priceHistoryKey()) || '[]');
        for (const e of raw) histMap.set(`${e.company}|${e.msgTime}|${e.prod}|${e.quality}`, e.outlier || false);
        for (const q of quotes) {
          const mt = q.datetime ? new Date(q.datetime).getTime() : 0;
          q.outlier = histMap.get(`${q.company}|${mt}|${q.product}|${q.quality || 'Q0'}`) || false;
        }
      } catch (_) {}
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
    const datetime  = msg.datetime || null;
    const lines     = text.split('\n').map(l => l.trim()).filter(l => l);

    // Try structured template first (Quality:/Price: labels on separate lines)
    const structured = tryStructuredParse(lines, company, text, retracted, datetime);
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

      results.push(...parseLineProducts(line, company, dir, curQuality, text, retracted, datetime));
    }
    return results;
  }

  // Handle structured listing format:
  //   :re-97: ... (product codes)
  //   Product : SEP
  //   Quality : Q6⭐️...
  //   Price   : $37.6k
  function tryStructuredParse(lines, company, body = '', retracted = false, datetime = null) {
    // Collect indices of all Quality: and Price: lines
    const qualIdxs  = lines.reduce((a, l, i) => { if (/[Qq]uality\s*[:：]\s*[Qq]\d+/.test(l))       a.push(i); return a; }, []);
    const priceIdxs = lines.reduce((a, l, i) => { if (/[Pp]rice\s*[:：]\s*[\$\$]?\s*\d/.test(l)) a.push(i); return a; }, []);
    if (!qualIdxs.length || !priceIdxs.length) return [];

    // Direction: scan all lines, default to 'sell' (structured posts are almost always sellers)
    const dir = detectDir(lines.join(' ')) || 'sell';
    const results = [];

    // Each Quality line anchors one product block; find the Price line that follows it
    for (let bi = 0; bi < qualIdxs.length; bi++) {
      const qi    = qualIdxs[bi];
      const nextQi = qualIdxs[bi + 1] ?? lines.length;
      const pi    = priceIdxs.find(i => i > qi && i < nextQi);
      if (pi === undefined) continue;

      // Block spans from after the previous block's price line to the current price line
      const prevPi = bi > 0 ? (priceIdxs.find(i => i > qualIdxs[bi - 1]) ?? qualIdxs[bi - 1]) : -1;
      const blockLines = lines.slice(prevPi + 1, pi + 1);

      const qm      = lines[qi].match(/[Qq]uality\s*[:：]\s*([Qq]\d+)/);
      const quality = qm ? `Q${parseInt(qm[1].slice(1))}` : null;
      const pm      = lines[pi].match(/[Pp]rice\s*[:：]\s*\$?\s*(\d+[\.,]?\d*)\s*([kK])?/);
      const price   = pm ? (() => { const r = parseFloat(pm[1].replace(',', '.')); return Math.round(pm[2] || r <= 9999 ? r * 1000 : r); })() : null;

      const seen = new Set();
      for (const line of blockLines)
        for (const m of findAllMentions(line)) seen.add(m.product);
      if (!seen.size) continue;

      results.push(...[...seen].map(p => ({ company, direction: dir, product: p, quality, price, from_delta: false, body, retracted, datetime })));
    }
    return results;
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
  function parseLineProducts(line, company, dir, fallbackQuality = null, body = '', retracted = false, datetime = null) {
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
        results.push({ company, direction: dir, product, quality: null, price, from_delta: false, body, retracted, datetime });
      } else if (prices && prices.length === qualities.length) {
        // Slash-paired notation: Q6/8 @935/965k → pair each quality with its price
        for (let qi = 0; qi < qualities.length; qi++)
          results.push({ company, direction: dir, product, quality: qualities[qi], price: prices[qi], from_delta: false, body, retracted, datetime });
      } else {
        for (const q of qualities) {
          if (delta !== null && price !== null) {
            const base = parseInt(q.slice(1));
            for (let qn = 0; qn <= 9; qn++) {
              results.push({
                company, direction: dir, product,
                quality: `Q${qn}`,
                price: Math.round(price + delta * (qn - base)),
                from_delta: true, base_quality: q, delta_per_q: delta, body, retracted, datetime,
              });
            }
          } else {
            results.push({ company, direction: dir, product, quality: q, price, from_delta: false, body, retracted, datetime });
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
    // "at 34.5k" or "at 34.5" (k optional — aerospace prices always in thousands)
    m = /\bat\s+(\d{1,4}(?:\.\d+)?)\s*[kK]?/i.exec(t);
    if (m) { price = Math.round(parseFloat(m[1]) * 1000); }
    if (!price) {
      // "@34.5k" or "@34.5" or "$34.5k" or "$34.5"
      m = /[@$]\s*(\d{1,4}(?:\.\d+)?)\s*[kK]?(?![a-zA-Z/])/.exec(t);
      if (m) price = Math.round(parseFloat(m[1]) * 1000);
    }
    if (!price) {
      const tc = delta !== null
        ? t.replace(/([+-])\/?\-?\s*(\d+(?:\.\d+)?)\s*[kK]?\s*(?:\/\s*[qQ])?/, '')
        : t;
      // bare number with k: "34.5k", "920k"
      m = /(?<![/\d])(\d{2,4}(?:\.\d+)?)\s*[kK](?![a-zA-Z/])/.exec(tc);
      if (m) price = Math.round(parseFloat(m[1]) * 1000);
      // bare decimal without k: "34.5" → 34500 (integers are too ambiguous to auto-scale)
      if (!price) {
        m = /(?<![/\d.])(\d{1,4}\.\d{1,3})(?![kK\d])/.exec(tc);
        if (m) { const v = parseFloat(m[1]); if (v >= 1 && v <= 9999) price = Math.round(v * 1000); }
      }
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
        tree[prod][qual][dir][key].push({ name: q.company, body: q.body || '', retracted: !!q.retracted, datetime: q.datetime || null, msgTime: q.datetime ? new Date(q.datetime).getTime() : null, outlier: !!q.outlier, direction: dir, sig });
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
              entries: arr.map(({ name, body, retracted, datetime, msgTime, outlier, direction }) => ({ name, body, retracted, datetime, msgTime, outlier, direction })),
            }))
            .sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
        }
      }
    }
    return result;
  }

  // ── Render results ────────────────────────────────────────────────────
  function renderResults(el, summary, totalQuotes, totalMsgs, metaOverride) {
    _ciMap.clear();
    _ciNext = 0;
    const metaTxt = metaOverride !== undefined ? metaOverride : `${totalMsgs} 条消息 → ${totalQuotes} 条报价`;
    let html = `<div class="scma-meta">${metaTxt}</div>`;

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
          const allOutlier = e.entries.every(en => en.outlier);
          const anyOutlier = !allOutlier && e.entries.some(en => en.outlier);
          _ciMap.set(ci, { entries: e.entries, prod, qual });
          return `<span class="scma-price${allRetract ? ' scma-price--retracted' : ''}${allOutlier ? ' scma-price--outlier' : anyOutlier ? ' scma-price--has-outlier' : ''}" title="${tip}" data-ci="${ci}">${p}<sup>×${e.count}</sup></span>`;
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
          _ciMap.set(ci, { entries: e.entries, prod, qual: 'unspecified' });
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

  // ── Relative time ─────────────────────────────────────────────────────
  function timeAgo(isoStr) {
    if (!isoStr) return '';
    const diffMs = Date.now() - new Date(isoStr).getTime();
    if (isNaN(diffMs)) return '';
    const s = Math.floor(diffMs / 1000);
    if (s < 60)   return `${s}秒前`;
    const m = Math.floor(s / 60);
    if (m < 60)   return `${m}分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24)   return `${h}小时前`;
    const d = Math.floor(h / 24);
    return `${d}天前`;
  }

  // ── Quote popup ───────────────────────────────────────────────────────
  let _popupEl = null;

  function showQuotePopup(x, y, ciData) {
    // ciData = { entries, prod, qual } or legacy array
    const entries = Array.isArray(ciData) ? ciData : ciData.entries;
    const ctxProd = Array.isArray(ciData) ? null : ciData.prod;
    const ctxQual = Array.isArray(ciData) ? null : ciData.qual;

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

    const rows = entries.map((en, idx) => {
      const coUrl = `https://www.simcompanies.com/zh-cn/company/${REALM}/${encodeURIComponent(en.name)}/`;
      const dirBadge = en.direction === 'buy'
        ? '<span class="scma-dir-buy">BUY</span>'
        : en.direction === 'sell' ? '<span class="scma-dir-sell">SELL</span>' : '';
      const canMark = ctxProd && en.msgTime;
      const outlierBtn = canMark
        ? `<button class="scma-btn-outlier${en.outlier ? ' scma-btn-outlier--on' : ''}" data-idx="${idx}" title="${en.outlier ? '取消异常标记' : '标为异常值'}">${en.outlier ? '⚠ 异常' : '⚠'}</button>`
        : '';
      return `
      <div class="scma-pe${en.retracted ? ' scma-pe--retracted' : ''}${en.outlier ? ' scma-pe--outlier' : ''}">
        <div class="scma-pe-name">
          ${dirBadge}
          <a class="scma-co-link" href="${escHtml(coUrl)}" target="_blank" rel="noopener">${escHtml(en.name)}</a>
          ${en.retracted ? '<span class="scma-pe-retract-badge">已撤回</span>' : ''}
          ${en.datetime ? `<span class="scma-pe-time">${timeAgo(en.datetime)}</span>` : ''}
          ${outlierBtn}
        </div>
        <div class="scma-pe-body">${renderMsgBody(en.body)}</div>
      </div>`;
    }).join('');
    _popupEl.innerHTML = rows;

    // Outlier toggle button handler
    if (ctxProd) {
      _popupEl.querySelectorAll('.scma-btn-outlier').forEach(btn => {
        btn.onclick = (ev) => {
          ev.stopPropagation();
          const idx = parseInt(btn.dataset.idx);
          const en = entries[idx];
          if (!en.msgTime) return;
          const newState = toggleOutlier(en.name, en.msgTime, ctxProd, ctxQual);
          en.outlier = newState;
          // Update button & row
          btn.classList.toggle('scma-btn-outlier--on', newState);
          btn.title = newState ? '取消异常标记' : '标为异常值';
          btn.textContent = newState ? '⚠ 异常' : '⚠';
          btn.closest('.scma-pe').classList.toggle('scma-pe--outlier', newState);
          // Re-render current tab so price span style updates
          refreshCurrentTab();
        };
      });
    }

    // Position near click, keep within viewport
    const vw = window.innerWidth, vh = window.innerHeight;
    _popupEl.style.display = 'block';
    if (vw <= 600) {
      // On mobile: center horizontally, anchor to top of viewport
      _popupEl.style.left = '12px';
      _popupEl.style.top  = '12px';
    } else {
      const pw = _popupEl.offsetWidth || 320, ph = _popupEl.offsetHeight || 240;
      _popupEl.style.left = Math.min(x + 8, vw - pw - 8) + 'px';
      _popupEl.style.top  = Math.min(y + 8, vh - ph - 8) + 'px';
    }
  }

  function hideQuotePopup() {
    if (_popupEl) _popupEl.style.display = 'none';
  }

  // ── Outlier management ────────────────────────────────────────────────
  function toggleOutlier(company, msgTime, prod, quality) {
    const key = priceHistoryKey();
    let history = [];
    try { history = JSON.parse(localStorage.getItem(key) || '[]'); } catch (_) {}
    const idx = history.findIndex(e =>
      e.company === company && e.msgTime === msgTime && e.prod === prod && e.quality === quality
    );
    if (idx === -1) return false;
    history[idx] = { ...history[idx], outlier: !history[idx].outlier };
    try { localStorage.setItem(key, JSON.stringify(history)); } catch (_) {}
    return history[idx].outlier;
  }

  function refreshCurrentTab() {
    if (!panelEl) return;
    const activeTab = panelEl.querySelector('.scma-tab--on')?.dataset?.tab;
    if (activeTab === 'hist') {
      renderHistoryTab();
    } else if (_lastSummary) {
      // Merge updated outlier flags into _lastSummary entries from storage
      const histMap = new Map();
      try {
        const raw = JSON.parse(localStorage.getItem(priceHistoryKey()) || '[]');
        for (const e of raw) histMap.set(`${e.company}|${e.msgTime}|${e.prod}|${e.quality}`, e.outlier || false);
      } catch (_) {}
      for (const prod of Object.keys(_lastSummary)) {
        for (const qual of Object.keys(_lastSummary[prod])) {
          for (const dir of ['buy', 'sell']) {
            for (const priceEntry of (_lastSummary[prod][qual][dir] || [])) {
              for (const en of priceEntry.entries) {
                en.outlier = histMap.get(`${en.name}|${en.msgTime}|${prod}|${qual}`) || false;
              }
            }
          }
        }
      }
      renderResults(panelEl.querySelector('#scma-results'), _lastSummary, _lastQuotes, _lastMsgs);
    }
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function renderMsgBody(text) {
    let html = escHtml(text);
    html = html.replace(/:re-(\d+):/g, (_, idStr) => {
      const id  = parseInt(idStr);
      const en  = MKT_BY_ID[id] || PRODUCT_CODES[`:re-${idStr}:`] || `re-${idStr}`;
      const zh  = MKT_ZH[id] || '';
      const label = zh ? `${en} ${zh}` : en;
      return `<span class="scma-mkt-re" title="re-${idStr}">${escHtml(label)}</span>`;
    });
    return html;
  }

  // ── Update check ─────────────────────────────────────────────────────
  function checkForUpdates(statusEl) {
    if (!statusEl) statusEl = panelEl && panelEl.querySelector('#scma-update-status');
    const RAW_URL  = 'https://raw.githubusercontent.com/Ldlfylt-LDDL/simco-market-analyzer/main/simco_market_analyzer.user.js';
    const DL_URL   = 'https://github.com/Ldlfylt-LDDL/simco-market-analyzer/raw/main/simco_market_analyzer.user.js';
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

  // ── Help popup ────────────────────────────────────────────────────────
  function showHelpPopup() {
    let el = document.getElementById('scma-help-overlay');
    if (el) { el.style.display = 'flex'; return; }

    el = document.createElement('div');
    el.id = 'scma-help-overlay';
    el.innerHTML = `
      <div id="scma-help-box">
        <div id="scma-help-header">
          <span>航天市场分析器 — 使用说明</span>
          <button id="scma-help-close">✕</button>
        </div>
        <div id="scma-help-body">
          <h3>基本使用</h3>
          <p>点击右下角 <b>✈</b> 按钮打开面板。在<b>时</b>输入框中填写想往前追溯的小时数（范围1到12小时，默认 4 小时），点击 <b>🔍 搜索</b> 开始抓取聊天室 X 中的消息。</p>

          <h3>结果表格</h3>
          <p>结果按产品（SOR / BFR / JUM / LUX / SEP / SAT）分组，每个产品显示一张买卖汇总表：</p>
          <ul>
            <li><b>等级</b> — 报价对应的品质（Q0–Q12）；<span class="scma-help-tag buy">BUY</span> 列为求购，<span class="scma-help-tag sell">SELL</span> 列为出售。</li>
            <li>价格旁的 <b>×N</b> 表示有 N 条相同报价，可点击查看原始消息。</li>
            <li><span style="text-decoration:line-through;opacity:.6">划线价格</span> 表示对应消息已被撤回。</li>
            <li><b>无明确等级和报价</b> 行收录了未注明品质或价格的提及。</li>
          </ul>

          <h3>原始消息</h3>
          <p>点击任意价格标签或 ×N 按钮，弹出原始消息列表。每条消息显示：</p>
          <ul>
            <li>发送公司名（蓝色）+ 发送时间（如 <i>3分钟前</i>）</li>
            <li>完整原文（产品代码已替换为图标）</li>
            <li><b>复制名字</b> 按钮，可将公司名复制到剪贴板</li>
          </ul>
          <p>点击弹窗外任意位置或按 <b>Esc</b> 关闭弹窗。</p>

          <h3>识别范围</h3>
          <p>支持识别 <b>:re-91: (SOR)、:re-94: (BFR)、:re-95: (JUM)、:re-96: (LUX)、:re-97: (SEP)、:re-99: (SAT)</b> 及其常见英文缩写（如 JUMBO、LUXJET、SATELLITE 等）。</p>
          <p>价格格式支持 <b>@900k</b>、<b>at 900k</b>、<b>$900k</b> 等写法，以及 <b>Q6/8 @900/950k</b> 式的多等级/价格对，和 <b>±Xk/Q</b> 式的逐级差价展开。</p>
          <p>格式较为特殊的报价（如将价格写在下一行、使用非常规符号等）<b>可能无法识别</b>，结果仅供参考。</p>

          <h3>其他功能</h3>
          <ul>
            <li>📋 按钮：将当前结果导出为 JSON，方便进一步处理。</li>
            <li>搜索完成后关闭面板再重新打开，上一次的结果会自动保留。</li>
            <li>展开底部「关于」可检查是否有新版本。</li>
            <li>面板可拖动，抓住顶部标题栏即可移动。</li>
          </ul>
        </div>
      </div>`;
    document.body.appendChild(el);

    el.querySelector('#scma-help-close').onclick = () => { el.style.display = 'none'; };
    el.addEventListener('click', ev => { if (ev.target === el) el.style.display = 'none'; });
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && el.style.display !== 'none') el.style.display = 'none'; });
  }

  // ── Market help popup ────────────────────────────────────────────────
  function showMktHelpPopup() {
    let el = document.getElementById('scma-mkt-help-overlay');
    if (el) { el.style.display = 'flex'; return; }

    el = document.createElement('div');
    el.id = 'scma-mkt-help-overlay';
    el.innerHTML = `
      <div id="scma-help-box">
        <div id="scma-help-header">
          <span>全市场报价 — 使用说明</span>
          <button id="scma-mkt-help-close">✕</button>
        </div>
        <div id="scma-help-body">
          <h3>基本使用</h3>
          <p>点击右下角 <b>🌐</b> 按钮打开面板。在<b>时</b>输入框填写追溯小时数（范围1~8小时，默认 2 小时，请不要把时间设置太长，以免滥用api），在<b>聊天室</b>选择框选择对应聊天室，点击 <b>🔍 搜索</b> 开始抓取。</p>

          <h3>关注列表</h3>
          <p>搜索前须先添加关注物品：</p>
          <ul>
            <li>从下拉菜单选择物品（显示英文 / 中文），点击 <b>+ 关注</b> 加入列表。</li>
            <li>每个物品可点击 <b>Q0–Q12</b> 标签过滤等级；<b>任意</b> 表示不限等级。</li>
            <li>点击 <b>✕</b> 移除关注。关注列表自动持久化保存，刷新页面后仍然有效。</li>
          </ul>

          <h3>结果 — 汇总表</h3>
          <p>搜索完成后，每个关注物品显示一张买卖汇总表：</p>
          <ul>
            <li><b>等级</b> 列显示 Q0–Q12；<span class="scma-help-tag buy">BUY</span> 为求购，<span class="scma-help-tag sell">SELL</span> 为出售。</li>
            <li>每个价格标签旁的 <b>×N</b> 表示有 N 条消息报出此价格，可点击查看原始消息弹窗。</li>
            <li>价格格式：直接价（如 <b>34.5k</b>）、市场价百分比（如 <b>MP-3%</b>）、市场价差值（如 <b>MP-100</b>）。</li>
            <li><span style="text-decoration:line-through;opacity:.6">划线价格</span> 表示对应消息已被撤回。</li>
            <li>? 表示未提及价格</li>
          </ul>

          <h3>结果 — 原始消息</h3>
          <p>点击顶部 <b>原始消息</b> 标签，按时间从近到远罗列所有匹配消息：</p>
          <ul>
            <li>公司名（绿色）可点击直达玩家主页。</li>
            <li>消息中的产品代码自动替换为图标（若图标不可用则显示文字名称）。</li>
            <li>显示发送时间（如 <i>3分钟前</i>）。</li>
          </ul>

          <h3>价格识别范围</h3>
          <p>支持识别消息中的 <b>:re-N:</b> 产品代码（仅限关注的物品）。识别的价格格式：</p>
          <ul>
            <li>直接报价：<b>@34.5k</b>、<b>at 34.5k</b>、<b>$34.5k</b></li>
            <li>市场价百分比：<b>mp-3%</b>、<b>-3% market</b>、<b>3% below mp</b></li>
            <li>市场价差值：<b>mp-100</b>、<b>-100 mp</b>、<b>100 below market</b></li>
          </ul>
          <p>格式特殊的报价（价格写在下一行、使用非常规符号等）<b>可能无法识别</b>，结果仅供参考。</p>

          <h3>其他</h3>
          <ul>
            <li>搜索结束后关闭面板再重新打开，上一次结果会自动保留。</li>
            <li>面板可拖动，抓住顶部标题栏即可移动。</li>
            <li>展开底部「关于」可检查是否有新版本。</li>
          </ul>
        </div>
      </div>`;
    document.body.appendChild(el);

    el.querySelector('#scma-mkt-help-close').onclick = () => { el.style.display = 'none'; };
    el.addEventListener('click', ev => { if (ev.target === el) el.style.display = 'none'; });
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && el.style.display !== 'none') el.style.display = 'none'; });
  }

  // ══════════════════════════════════════════════════════════════════════
  // ── SECTION 2: All-market quote search ────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════

  // ── All products (sorted alphabetically) ─────────────────────────────
  const MKT_PRODUCTS = [
    {id:3,n:'Apples'},{id:123,n:'Apple Cider'},{id:123,n:'Apple Pie'},{id:82,n:'Attitude Control'},
    {id:15,n:'Bauxite'},{id:22,n:'Batteries'},{id:94,n:'BFR'},{id:121,n:'Bread'},{id:102,n:'Bricks'},
    {id:134,n:'Butter'},{id:112,n:'Bulldozer'},{id:75,n:'Carbon Fibers'},{id:76,n:'Carbon Composite'},
    {id:104,n:'Clay'},{id:140,n:'Chocolate'},{id:119,n:'Coffee Powder'},{id:118,n:'Coffee Beans'},
    {id:132,n:'Cocktails'},{id:103,n:'Cement'},{id:122,n:'Cheese'},{id:17,n:'Chemicals'},
    {id:81,n:'Cockpit'},{id:52,n:'Combustion Engine'},{id:111,n:'Construction Units'},
    {id:40,n:'Cotton'},{id:115,n:'Cows'},{id:10,n:'Crude Oil'},{id:23,n:'Displays'},
    {id:12,n:'Diesel'},{id:62,n:'Dress'},{id:137,n:'Dough'},{id:48,n:'Electric Motor'},
    {id:21,n:'Electronic Comps'},{id:9,n:'Eggs'},{id:73,n:'Ethanol'},{id:41,n:'Fabric'},
    {id:80,n:'Flight Computer'},{id:139,n:'Fodder'},{id:133,n:'Flour'},{id:127,n:'Frozen Pizza'},
    {id:77,n:'Fuselage'},{id:126,n:'Ginger Beer'},{id:45,n:'Glass'},{id:68,n:'Gold Ore'},
    {id:69,n:'Golden Bars'},{id:6,n:'Grain'},{id:64,n:'Handbags'},{id:87,n:'Heat Shield'},
    {id:79,n:'High Grade E-Comps'},{id:129,n:'Hamburger'},{id:88,n:'Ion Drive'},
    {id:89,n:'Jet Engine'},{id:95,n:'Jumbo Jet'},{id:26,n:'Laptops'},{id:130,n:'Lasagna'},
    {id:46,n:'Leather'},{id:105,n:'Limestone'},{id:96,n:'Luxury Jet'},{id:56,n:'Luxury Car'},
    {id:54,n:'Luxury E-Car'},{id:49,n:'Luxury Interior'},{id:70,n:'Luxury Watch'},
    {id:131,n:'Meat Balls'},{id:74,n:'Methane'},{id:14,n:'Minerals'},{id:117,n:'Milk'},
    {id:27,n:'Monitors'},{id:71,n:'Necklace'},{id:47,n:'On-board Computer'},
    {id:92,n:'Orbital Booster'},{id:4,n:'Oranges'},{id:124,n:'Orange Juice'},
    {id:128,n:'Pasta'},{id:11,n:'Petrol'},{id:116,n:'Pigs'},{id:108,n:'Planks'},
    {id:19,n:'Plastic'},{id:84,n:'Propellant Tank'},{id:1,n:'Power'},{id:20,n:'Processors'},
    {id:98,n:'Quadcopter'},{id:101,n:'Reinforced Concrete'},{id:114,n:'Robots'},
    {id:86,n:'Rocket Engine'},{id:83,n:'Rocket Fuel'},{id:142,n:'Salad'},{id:143,n:'Samosa'},
    {id:99,n:'Satellite'},{id:138,n:'Sauce'},{id:8,n:'Sausages'},{id:66,n:'Seeds'},
    {id:16,n:'Silicon'},{id:97,n:'Single Engine Plane'},{id:65,n:'Sneakers'},
    {id:35,n:'Software'},{id:85,n:'Solid Fuel Booster'},{id:43,n:'Steel'},
    {id:107,n:'Steel Beams'},{id:7,n:'Steak'},{id:93,n:'Starship'},{id:63,n:'Stiletto Heel'},
    {id:90,n:'Sub-orbital 2nd Stage'},{id:91,n:'Sub-orbital Rocket'},{id:135,n:'Sugar'},
    {id:72,n:'Sugarcane'},{id:28,n:'Televisions'},{id:25,n:'Tablets'},{id:110,n:'Tools'},
    {id:13,n:'Transport'},{id:57,n:'Truck'},{id:141,n:'Veg Oil'},{id:120,n:'Vegetables'},
    {id:2,n:'Water'},{id:78,n:'Wing'},{id:109,n:'Windows'},{id:106,n:'Wood'},
    {id:44,n:'Sand'},{id:24,n:'Smartphones'},{id:53,n:'Economy E-Car'},{id:55,n:'Economy Car'},
    {id:18,n:'Aluminium'},{id:42,n:'Iron Ore'},{id:51,n:'Car Body'},
    {id:60,n:'Underwear'},{id:61,n:'Gloves'},{id:125,n:'Apple Cider'},
    {id:29,n:'Crop Research'},{id:30,n:'Energy Research'},{id:31,n:'Mining Research'},
    {id:32,n:'Electronics Research'},{id:33,n:'Livestock Research'},{id:34,n:'Chemical Research'},
    {id:59,n:'Fashion Research'},{id:100,n:'Aerospace Research'},{id:113,n:'Materials Research'},
    {id:145,n:'Recipe'},{id:151,n:'Easter Bunny'},{id:155,n:'Creamy Eggs'},
  ].filter((p,i,a) => a.findIndex(x=>x.id===p.id)===i)
   .sort((a,b) => a.n.localeCompare(b.n));

  const MKT_BY_ID = {};
  MKT_PRODUCTS.forEach(p => MKT_BY_ID[p.id] = p.n);

  const MKT_ZH = {
    1:'电力',2:'水',3:'苹果',4:'橙子',5:'葡萄',6:'谷物',7:'牛排',8:'香肠',9:'鸡蛋',10:'原油',
    11:'汽油',12:'柴油',13:'运输',14:'矿石',15:'铝土矿',16:'硅',17:'化学品',18:'铝',19:'塑料',20:'处理器',
    21:'电子元件',22:'电池',23:'显示屏',24:'智能手机',25:'平板电脑',26:'笔记本电脑',27:'显示器',28:'电视',
    35:'软件',40:'棉花',41:'织物',42:'铁矿石',43:'钢铁',44:'沙子',45:'玻璃',46:'皮革',
    47:'车载电脑',48:'电动机',49:'豪华内饰',50:'基础内饰',51:'车身',52:'内燃机',
    53:'经济型电动车',54:'豪华电动车',55:'经济型汽车',56:'豪华汽车',57:'卡车',
    60:'内衣',61:'手套',62:'连衣裙',63:'细跟高跟鞋',64:'手提包',65:'运动鞋',
    66:'种子',68:'金矿石',69:'金条',70:'奢华手表',71:'项链',72:'甘蔗',73:'乙醇',74:'甲烷',
    75:'碳纤维',76:'碳复合材料',77:'机身',78:'机翼',79:'高级电子元件',80:'飞行电脑',
    81:'驾驶舱',82:'姿态控制系统',83:'火箭燃料',84:'推进剂罐',85:'固体燃料助推器',
    86:'火箭发动机',87:'隔热板',88:'离子驱动',89:'喷气发动机',90:'亚轨道二级',
    91:'亚轨道火箭',92:'轨道助推器',93:'星舰',94:'超重型火箭',95:'巨型客机',
    96:'豪华私人飞机',97:'单引擎飞机',98:'四旋翼无人机',99:'卫星',
    101:'钢筋混凝土',102:'砖块',103:'水泥',104:'黏土',105:'石灰石',106:'木材',
    107:'钢梁',108:'木板',109:'玻璃窗',110:'工具',111:'建筑单元',112:'推土机',
    114:'机器人',115:'奶牛',116:'猪',117:'牛奶',118:'咖啡豆',119:'咖啡粉',120:'蔬菜',
    121:'面包',122:'奶酪',123:'苹果派',124:'橙汁',125:'苹果酒',126:'姜汁啤酒',
    127:'冷冻披萨',128:'意大利面',129:'汉堡',130:'千层面',131:'肉丸',132:'鸡尾酒',
    133:'面粉',134:'黄油',135:'糖',136:'可可',137:'面团',138:'酱料',
    139:'饲料',140:'巧克力',141:'植物油',142:'沙拉',143:'炸三角',
    29:'作物研究',30:'能源研究',31:'采矿研究',32:'电器研究',33:'畜牧研究',34:'化学研究',
    59:'时装研究',100:'航空航天研究',113:'材料研究',145:'食谱',151:'复活节兔兔',155:'奶油鸡蛋',
  };

  // ── Image cache ───────────────────────────────────────────────────────
  const mktImgCache = {};  // id → URL
  let   mktImgsLoaded = false;
  async function initMktImages() {
    if (mktImgsLoaded) return;
    // Seed known aerospace images
    for (const [code, url] of Object.entries(PROD_IMG)) {
      const m = code.match(/:re-(\d+):/);
      if (m) mktImgCache[parseInt(m[1])] = url;
    }
    // Try collection endpoint
    try {
      const resp = await fetch('/api/v4/en/0/encyclopedia/resources/0/', { credentials: 'include' });
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data)) {
          for (const r of data) { if (r.id != null && r.image) mktImgCache[r.id] = r.image; }
        }
      }
    } catch {}
    mktImgsLoaded = true;
  }

  // ── Panel positioning ─────────────────────────────────────────────────
  function updatePanelPositions() {
    const AERO_W = 430, GAP = 10, BASE = 18;
    if (panelEl)    panelEl.style.right = BASE + 'px';
    if (mktPanelEl) mktPanelEl.style.right = (panelEl ? AERO_W + GAP + BASE : BASE) + 'px';
    // 图表面板固定在左下角，独立于右侧两个面板
    if (chartPanelEl) { chartPanelEl.style.left = BASE + 'px'; chartPanelEl.style.right = ''; }
  }

  // ── Watchlist persistence ─────────────────────────────────────────────
  const MKT_LS_KEY = 'scma_watchlist_v1';
  let mktWatchlist = [];
  function loadWatchlist() {
    try { mktWatchlist = JSON.parse(localStorage.getItem(MKT_LS_KEY)) || []; }
    catch { mktWatchlist = []; }
  }
  function saveWatchlist() { localStorage.setItem(MKT_LS_KEY, JSON.stringify(mktWatchlist)); }
  loadWatchlist();

  // ── Market panel state ────────────────────────────────────────────────
  let mktPanelEl    = null;
  let mktAbortCtrl2 = null;
  let mktLastQuotes2 = [];
  let mktLastMsgs2   = 0;
  let mktLastStatus2 = null;
  let mktViewMode   = 'table';

  // ── Create market panel ───────────────────────────────────────────────
  function createMktPanel() {
    mktPanelEl = document.createElement('div');
    mktPanelEl.id = 'scma-mkt-panel';
    mktPanelEl.innerHTML = `
      <div id="scma-mkt-header">
        <span>🌐 全市场报价</span>
        <div style="display:flex;gap:6px;align-items:center">
          <button id="scma-mkt-help" title="使用帮助">?</button>
          <button id="scma-mkt-close">✕</button>
        </div>
      </div>
      <div id="scma-mkt-controls">
        <label>时 <input id="scma-mkt-hours" type="number" value="2" min="1" max="24"></label>
        <label>聊天室 <select id="scma-mkt-room">
          <option value="S">Sales</option>
          <option value="X">Aerospace sales</option>
        </select></label>
        <button id="scma-mkt-search">🔍 搜索</button>
        <button id="scma-mkt-stop" disabled>⏹</button>
      </div>
      <div id="scma-mkt-wl">
        <div id="scma-mkt-wl-add">
          <select id="scma-mkt-wl-sel">
            ${MKT_PRODUCTS.map(p=>`<option value="${p.id}">${escHtml(p.n)}${MKT_ZH[p.id] ? ' / ' + MKT_ZH[p.id] : ''}</option>`).join('')}
          </select>
          <button id="scma-mkt-wl-addbtn">+ 关注</button>
        </div>
        <div id="scma-mkt-wl-list"></div>
      </div>
      <div id="scma-mkt-view">
        <button class="scma-mkt-vtab scma-mkt-vtab--on" data-mode="table">汇总表</button>
        <button class="scma-mkt-vtab" data-mode="messages">原始消息</button>
      </div>
      <div id="scma-mkt-status">准备就绪</div>
      <div id="scma-mkt-results"></div>
      <details id="scma-mkt-about">
        <summary>关于</summary>
        <div id="scma-about-body">
          <span>作者：</span>
          <a href="https://www.simcompanies.com/zh-cn/company/0/LDDL-Corp./" target="_blank" rel="noopener">LDDL Corp.</a>
          <span class="scma-sep">(作者也是新手，有错误请多多指教)</span>
        </div>
        <div id="scma-about-body">
          <span>源码：</span>
          <a href="https://github.com/Ldlfylt-LDDL/simco-market-analyzer" target="_blank" rel="noopener">GitHub</a>
        </div>
        <div id="scma-mkt-about-ver">
          <span>v${VERSION}</span>
          <span class="scma-sep">·</span>
          <a id="scma-mkt-update-btn" href="#">检查更新</a>
          <span id="scma-mkt-update-status"></span>
        </div>
      </details>
    `;
    document.body.appendChild(mktPanelEl);

    mktPanelEl.querySelector('#scma-mkt-close').onclick = destroyMktPanel;
    mktPanelEl.querySelector('#scma-mkt-help').onclick  = showMktHelpPopup;
    mktPanelEl.querySelector('#scma-mkt-update-btn').onclick = e => { e.preventDefault(); checkForUpdates(mktPanelEl.querySelector('#scma-mkt-update-status')); };
    mktPanelEl.querySelector('#scma-mkt-search').onclick = startMktSearch;
    mktPanelEl.querySelector('#scma-mkt-stop').onclick = () => {
      if (mktAbortCtrl2) { mktAbortCtrl2.abort(); mktAbortCtrl2 = null; }
    };
    initMktImages();

    mktPanelEl.querySelector('#scma-mkt-wl-addbtn').onclick = () => {
      const id = parseInt(mktPanelEl.querySelector('#scma-mkt-wl-sel').value);
      if (id && !mktWatchlist.some(w => w.id === id)) {
        mktWatchlist.push({ id, qualities: null });
        saveWatchlist(); renderWatchlist();
      }
    };
    mktPanelEl.querySelectorAll('.scma-mkt-vtab').forEach(btn => {
      btn.onclick = () => {
        mktViewMode = btn.dataset.mode;
        mktPanelEl.querySelectorAll('.scma-mkt-vtab').forEach(b => b.classList.remove('scma-mkt-vtab--on'));
        btn.classList.add('scma-mkt-vtab--on');
        if (mktLastQuotes2.length)
          renderMktResults(mktPanelEl.querySelector('#scma-mkt-results'), mktLastQuotes2, mktViewMode);
      };
    });

    mktPanelEl.querySelector('#scma-mkt-results').addEventListener('click', e => {
      const span = e.target.closest('[data-ci]');
      if (!span) return;
      const ciData = _ciMap.get(parseInt(span.dataset.ci));
      if (ciData) showQuotePopup(e.clientX, e.clientY, ciData);
    });

    makeDraggable(mktPanelEl, mktPanelEl.querySelector('#scma-mkt-header'));
    renderWatchlist();
    if (mktLastQuotes2.length) {
      renderMktResults(mktPanelEl.querySelector('#scma-mkt-results'), mktLastQuotes2, mktViewMode);
      if (mktLastStatus2) mktPanelEl.querySelector('#scma-mkt-status').textContent = mktLastStatus2;
    }
    updatePanelPositions();
  }

  function destroyMktPanel() {
    if (mktAbortCtrl2) { mktAbortCtrl2.abort(); mktAbortCtrl2 = null; }
    if (mktPanelEl) { mktPanelEl.remove(); mktPanelEl = null; }
    updatePanelPositions();
  }

  // ── Watchlist UI ──────────────────────────────────────────────────────
  function renderWatchlist() {
    if (!mktPanelEl) return;
    const el = mktPanelEl.querySelector('#scma-mkt-wl-list');
    if (!mktWatchlist.length) { el.innerHTML = '<div class="scma-wl-empty">暂无关注物品</div>'; return; }
    el.innerHTML = mktWatchlist.map(w => {
      const name = MKT_BY_ID[w.id] || `ID:${w.id}`;
      const anyOn = !w.qualities || !w.qualities.length;
      const qSpans = [0,1,2,3,4,5,6,7,8,9,10,11,12].map(q =>
        `<span class="scma-wl-q${(!anyOn && w.qualities.includes(q)) ? ' scma-wl-q--on' : ''}" data-wid="${w.id}" data-q="${q}">Q${q}</span>`
      ).join('');
      return `<div class="scma-wl-item">
        <span class="scma-wl-name">${escHtml(name)}</span>
        <div class="scma-wl-quals">
          <span class="scma-wl-q${anyOn ? ' scma-wl-q--on' : ''}" data-wid="${w.id}" data-q="any">任意</span>
          ${qSpans}
        </div>
        <button class="scma-wl-rm" data-wid="${w.id}">✕</button>
      </div>`;
    }).join('');
    el.querySelectorAll('.scma-wl-q').forEach(s => {
      s.onclick = () => {
        const id = parseInt(s.dataset.wid), q = s.dataset.q;
        const w = mktWatchlist.find(x => x.id === id);
        if (!w) return;
        if (q === 'any') { w.qualities = null; }
        else {
          const qn = parseInt(q);
          if (!w.qualities) w.qualities = [];
          const i = w.qualities.indexOf(qn);
          if (i >= 0) w.qualities.splice(i, 1); else w.qualities.push(qn);
          if (!w.qualities.length) w.qualities = null;
        }
        saveWatchlist(); renderWatchlist();
      };
    });
    el.querySelectorAll('.scma-wl-rm').forEach(btn => {
      btn.onclick = () => {
        mktWatchlist = mktWatchlist.filter(x => x.id !== parseInt(btn.dataset.wid));
        saveWatchlist(); renderWatchlist();
      };
    });
  }

  // ── Market search ─────────────────────────────────────────────────────
  async function startMktSearch() {
    if (!mktWatchlist.length) {
      mktPanelEl.querySelector('#scma-mkt-status').textContent = '请先添加关注物品';
      return;
    }
    const hours    = parseFloat(mktPanelEl.querySelector('#scma-mkt-hours').value) || 8;
    const room     = mktPanelEl.querySelector('#scma-mkt-room').value || 'S';
    const cutoff   = Date.now() - hours * 3600 * 1000;
    const statusEl = mktPanelEl.querySelector('#scma-mkt-status');
    const resultsEl= mktPanelEl.querySelector('#scma-mkt-results');
    const btnSearch= mktPanelEl.querySelector('#scma-mkt-search');
    const btnStop  = mktPanelEl.querySelector('#scma-mkt-stop');

    btnSearch.disabled = true; btnStop.disabled = false;
    resultsEl.innerHTML = ''; mktLastQuotes2 = [];

    mktAbortCtrl2 = new AbortController();
    const { signal } = mktAbortCtrl2;
    const BASE = `https://www.simcompanies.com/api/v2/chatroom/${encodeURIComponent(room)}/`;
    let url = BASE, page = 0, done = false;
    const allMsgs = [];
    const watchedIds = new Set(mktWatchlist.map(w => w.id));

    try {
      while (!done) {
        if (signal.aborted) break;
        statusEl.textContent = `⏳ 第 ${++page} 页 (已收集 ${allMsgs.length} 条)…`;
        const resp = await fetch(url, { credentials: 'include', signal });
        if (!resp.ok) throw new Error(`API ${resp.status}，请确认聊天室代码`);
        const data = await resp.json();
        if (!Array.isArray(data) || !data.length) break;
        let minId = Infinity;
        for (const msg of data) {
          if (msg.id < minId) minId = msg.id;
          if (new Date(msg.datetime).getTime() < cutoff) { done = true; continue; }
          allMsgs.push(msg);
        }
        url = `${BASE}from-id/${minId}/`;
        if (page >= 50) break;
        if (!done) await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
      }
      statusEl.textContent = `🔄 解析 ${allMsgs.length} 条消息…`;
      const quotes = allMsgs.flatMap(msg => parseMktMessage(msg, watchedIds));
      mktLastQuotes2 = quotes;
      mktLastMsgs2   = allMsgs.length;
      mktLastStatus2 = `✅ ${allMsgs.length} 条消息 · ${quotes.length} 条相关报价 · 最近 ${hours}h (聊天室 ${room})`;
      statusEl.textContent = mktLastStatus2;
      renderMktResults(resultsEl, quotes, mktViewMode);
    } catch(e) {
      if (e.name !== 'AbortError') { statusEl.textContent = `❌ ${e.message}`; console.error('[SCMA-MKT]', e); }
      else statusEl.textContent = '⏹ 已停止';
    }
    btnSearch.disabled = false; btnStop.disabled = true;
  }

  // ── Market message parsing ────────────────────────────────────────────
  function parseMktMessage(msg, watchedIds) {
    const company   = msg.sender?.company || '?';
    const text      = msg.body || '';
    const datetime  = msg.datetime || null;
    const retracted = !!msg.retracted;
    const results   = [];
    const lines     = text.split('\n').map(l => l.trim()).filter(l => l);
    let curDir = null;

    for (const line of lines) {
      if (RENT_RE.test(line)) continue;
      const lineDir = detectDir(line);
      if (lineDir) curDir = lineDir;
      const dir = lineDir || curDir;
      if (!dir) continue;

      // Find :re-N: codes for watched products on this line
      const codeRe = /:re-(\d+):/g;
      let m;
      const mentions = [];
      while ((m = codeRe.exec(line)) !== null) {
        const id = parseInt(m[1]);
        if (watchedIds.has(id)) mentions.push({ id, start: m.index, end: m.index + m[0].length });
      }
      if (!mentions.length) continue;

      for (const mention of mentions) {
        const w = mktWatchlist.find(x => x.id === mention.id);
        const pre  = line.slice(0, mention.start);
        const post = line.slice(mention.end);
        const dirBoundary = post.search(/\b(sell(?:ing)?|buy(?:i?n?g?)?|want(?:ing|ed)?|need(?:ing)?|offer(?:ing)?)\b/i);
        const safePost = dirBoundary > 0 ? post.slice(0, dirBoundary) : post;
        const quals = extractQualities(pre + ' ' + safePost);
        const price = extractMktPrice(pre + ' ' + safePost);

        const qualList = quals.length ? quals : [null];
        for (const q of qualList) {
          // Apply quality filter
          if (w && w.qualities && w.qualities.length && q !== null && !w.qualities.includes(parseInt(q.slice(1)))) continue;
          results.push({
            company, direction: dir,
            productId: mention.id,
            productName: MKT_BY_ID[mention.id] || `ID:${mention.id}`,
            quality: q, price,
            body: text, datetime, retracted,
          });
        }
      }
    }
    return results;
  }

  // ── Market price extraction ───────────────────────────────────────────
  function extractMktPrice(text) {
    const t = text.replace(/(\d),(\d)/g, '$1.$2');
    let m;

    // MP percentage: mp-3%, -3%mp, -4% market, 4% below mp, market-3%
    m = /(?:mp|market)\s*-\s*(\d+(?:\.\d+)?)\s*%/i.exec(t);
    if (m) return { type: 'mp_pct', val: -parseFloat(m[1]) };
    m = /-\s*(\d+(?:\.\d+)?)\s*%\s*(?:mp|market)/i.exec(t);
    if (m) return { type: 'mp_pct', val: -parseFloat(m[1]) };
    m = /\+\s*(\d+(?:\.\d+)?)\s*%\s*(?:mp|market)/i.exec(t);
    if (m) return { type: 'mp_pct', val: +parseFloat(m[1]) };
    m = /(\d+(?:\.\d+)?)\s*%\s*below\s*(?:mp|market)/i.exec(t);
    if (m) return { type: 'mp_pct', val: -parseFloat(m[1]) };
    m = /(\d+(?:\.\d+)?)\s*%\s*above\s*(?:mp|market)/i.exec(t);
    if (m) return { type: 'mp_pct', val: +parseFloat(m[1]) };

    // MP absolute: mp-100, -100 mp, N below mp
    m = /(?:mp|market)\s*-\s*(\d+(?:\.\d+)?)\s*([kK])?(?!\s*%)/i.exec(t);
    if (m) return { type: 'mp_abs', val: -(parseFloat(m[1]) * (m[2] ? 1000 : 1)) };
    m = /-\s*(\d+(?:\.\d+)?)\s*([kK])?\s*(?:mp|market)(?!\s*%)/i.exec(t);
    if (m) return { type: 'mp_abs', val: -(parseFloat(m[1]) * (m[2] ? 1000 : 1)) };
    m = /(\d+(?:\.\d+)?)\s*(?:below|under)\s*(?:mp|market)/i.exec(t);
    if (m) return { type: 'mp_abs', val: -parseFloat(m[1]) };

    // Direct price: @2750, $0.405, at 0.395, bare trailing number
    m = /[@$]\s*\$?\s*(\d+(?:\.\d+)?)\s*([kK])?/.exec(t);
    if (m) return { type: 'direct', val: parseFloat(m[1]) * (m[2] ? 1000 : 1) };
    m = /\bat\s+(\d+(?:\.\d+)?)\s*([kK])?/i.exec(t);
    if (m) return { type: 'direct', val: parseFloat(m[1]) * (m[2] ? 1000 : 1) };
    m = /(?:^|\s)(\d+(?:\.\d+)?)\s*$/.exec(t.trimEnd());
    if (m) { const v = parseFloat(m[1]); if (v > 0) return { type: 'direct', val: v }; }

    return null;
  }

  function formatMktPrice(price) {
    if (!price) return '';
    if (price.type === 'mp_pct') return `MP${price.val >= 0 ? '+' : ''}${price.val}%`;
    if (price.type === 'mp_abs') return `MP${price.val >= 0 ? '+' : ''}${price.val}`;
    const v = price.val;
    if (v >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k';
    if (v < 1) return v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return v % 1 === 0 ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }

  // ── Market results rendering ──────────────────────────────────────────
  function renderMktResults(el, quotes, mode) {
    if (mode === 'messages') { renderMktMessages(el, quotes); return; }
    renderMktTable(el, quotes);
  }

  function renderMktTable(el, quotes) {
    _ciMap.clear(); _ciNext = 0;
    // Group: productId → quality → direction → priceKey → entries[]
    const tree = {};
    for (const q of quotes) {
      const prod = q.productId;
      const qual = q.quality || 'unspecified';
      const dir  = q.direction;
      const pk   = q.price ? `${q.price.type}|${q.price.val}` : 'none';
      if (!tree[prod]) tree[prod] = {};
      if (!tree[prod][qual]) tree[prod][qual] = { buy: {}, sell: {} };
      if (!tree[prod][qual][dir][pk]) tree[prod][qual][dir][pk] = { price: q.price, entries: [] };
      const sig = q.company + '\x00' + (q.body || '');
      if (!tree[prod][qual][dir][pk].entries.some(e => e.sig === sig))
        tree[prod][qual][dir][pk].entries.push({ name: q.company, body: q.body, retracted: q.retracted, datetime: q.datetime, direction: dir, sig });
    }

    if (!Object.keys(tree).length) { el.innerHTML = '<div class="scma-meta">无匹配报价</div>'; return; }

    // Sort products by watchlist order
    const wlOrder = mktWatchlist.map(w => w.id);
    const prodIds = Object.keys(tree).map(Number).sort((a, b) => {
      const ia = wlOrder.indexOf(a), ib = wlOrder.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });

    let html = '';
    for (const pid of prodIds) {
      const qualMap = tree[pid];
      const name = MKT_BY_ID[pid] || `ID:${pid}`;
      html += `<div class="scma-prod"><div class="scma-prod-title">${escHtml(name)} <span class="scma-code">re-${pid}</span></div>`;
      html += `<table class="scma-table"><thead><tr>
        <th>等级</th><th class="scma-th-buy">BUY</th><th class="scma-th-sell">SELL</th>
      </tr></thead><tbody>`;

      const qkeys = Object.keys(qualMap).sort((a, b) => {
        if (a === 'unspecified') return 1; if (b === 'unspecified') return -1;
        return parseInt(a.slice(1)) - parseInt(b.slice(1));
      });
      for (const qk of qkeys) {
        const fmtDir = (dirMap) => Object.values(dirMap).map(grp => {
          const ci = _ciNext++; _ciMap.set(ci, { entries: grp.entries, prod: null, qual: null });
          const allR = grp.entries.every(e => e.retracted);
          const label = grp.price ? formatMktPrice(grp.price) : '?';
          return `<span class="scma-price${allR ? ' scma-price--retracted' : ''}" title="${grp.entries.map(e=>e.name).join('\n')}" data-ci="${ci}">${escHtml(label)}<sup>×${grp.entries.length}</sup></span>`;
        }).join(' ');
        html += `<tr>
          <td class="scma-q">${qk === 'unspecified' ? '未明确' : qk}</td>
          <td class="scma-buy">${fmtDir(qualMap[qk].buy || {})}</td>
          <td class="scma-sell">${fmtDir(qualMap[qk].sell || {})}</td>
        </tr>`;
      }
      html += '</tbody></table></div>';
    }
    el.innerHTML = html;
  }

  function renderMktMessages(el, quotes) {
    const watchedIds = new Set(mktWatchlist.map(w => w.id));
    // Deduplicate to unique messages by company+datetime, preserving directions
    const seen = new Map();
    for (const q of quotes) {
      const key = q.company + '\x00' + (q.datetime || '');
      if (!seen.has(key)) seen.set(key, { company: q.company, body: q.body, datetime: q.datetime, retracted: q.retracted, dirs: new Set() });
      seen.get(key).dirs.add(q.direction);
    }
    const msgs = [...seen.values()].sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
    if (!msgs.length) { el.innerHTML = '<div class="scma-meta">无匹配消息</div>'; return; }
    el.innerHTML = msgs.map(m => {
      const coUrl = `https://www.simcompanies.com/zh-cn/company/${REALM}/${encodeURIComponent(m.company)}/`;
      const dirBadges = [...m.dirs].map(d => d === 'buy'
        ? '<span class="scma-dir-buy">BUY</span>'
        : '<span class="scma-dir-sell">SELL</span>').join(' ');
      return `
      <div class="scma-mkt-msg${m.retracted ? ' scma-mkt-msg--retracted' : ''}">
        <div class="scma-mkt-msg-hd">
          ${dirBadges}
          <a class="scma-co-link scma-mkt-msg-co" href="${escHtml(coUrl)}" target="_blank" rel="noopener">${escHtml(m.company)}</a>
          ${m.retracted ? '<span class="scma-pe-retract-badge">已撤回</span>' : ''}
          <span class="scma-pe-time">${timeAgo(m.datetime)}</span>
        </div>
        <div class="scma-mkt-msg-body">${renderMktBody(m.body, watchedIds)}</div>
      </div>`;
    }).join('');
  }

  // Replace :re-N: with "English Chinese" spans; highlight watched products
  function renderMktBody(text, watchedIds) {
    let html = escHtml(text);
    html = html.replace(/:re-(\d+):/g, (_, idStr) => {
      const id    = parseInt(idStr);
      const en    = MKT_BY_ID[id] || `re-${idStr}`;
      const zh    = MKT_ZH[id] || '';
      const label = zh ? `${en} ${zh}` : en;
      const cls   = (watchedIds && watchedIds.has(id)) ? 'scma-mkt-re scma-mkt-re--watched' : 'scma-mkt-re';
      return `<span class="${cls}" title="re-${idStr}">${escHtml(label)}</span>`;
    });
    return html;
  }

  // ── Styles ────────────────────────────────────────────────────────────
  function injectStyles() {
    const css = `
      /* ── Toggle buttons ── */
      #scma-toggle-wrap {
        position: fixed; bottom: 18px; right: 18px; z-index: 2147483640;
        display: flex; border-radius: 8px; overflow: hidden;
        box-shadow: 0 2px 10px #0006;
      }
      #scma-toggle-aero, #scma-toggle-mkt {
        background: #1e3a5f; color: #7dd3fc;
        border: 1px solid #3b82f6;
        padding: 7px 13px; font-size: 13px; font-weight: 700;
        cursor: pointer; transition: background .15s;
      }
      #scma-toggle-aero { border-radius: 8px 0 0 8px; border-right-color: #2a5f8a; }
      #scma-toggle-mkt  { border-radius: 0 8px 8px 0; border-left: none; }
      #scma-toggle-aero:hover, #scma-toggle-mkt:hover { background: #2a4f7a; }

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
      .scma-price--outlier { text-decoration: line-through; color: #f97316 !important; opacity: .6; }
      .scma-price--has-outlier { color: #fb923c !important; }
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
      .scma-pe--retracted { opacity: .7; }
      .scma-pe--retracted .scma-pe-name > span { text-decoration: line-through; text-decoration-color: #f87171; }
      .scma-pe--retracted .scma-pe-body { text-decoration: line-through; text-decoration-color: #f87171; }
      .scma-pe--outlier { background: rgba(249,115,22,.08); }
      .scma-pe--outlier .scma-pe-name { color: #f97316; }
      .scma-btn-outlier {
        margin-left: auto; font-size: 9px; padding: 1px 5px; border-radius: 3px;
        border: 1px solid #475569; background: transparent; color: #94a3b8;
        cursor: pointer; white-space: nowrap;
      }
      .scma-btn-outlier:hover { border-color: #f97316; color: #f97316; }
      .scma-btn-outlier--on { border-color: #f97316; color: #f97316; background: rgba(249,115,22,.15); }
      .scma-pe-retract-badge {
        font-size: 9px; color: #f87171; border: 1px solid #7f1d1d;
        border-radius: 3px; padding: 0 4px; font-weight: normal;
      }
      .scma-pe-time {
        font-size: 9px; color: #64748b; font-weight: normal; margin-left: auto;
      }
      .scma-pe-body {
        color: #94a3b8; white-space: pre-wrap; word-break: break-word;
        line-height: 1.5;
      }
      .scma-prod-icon {
        width: 20px; height: 20px; vertical-align: middle;
        display: inline-block; margin: 0 1px;
      }

      /* ── Help button ── */
      #scma-help {
        font-size: 12px !important; font-weight: 700;
        border: 1px solid #334155 !important; border-radius: 50% !important;
        width: 18px; height: 18px; padding: 0 !important;
        display: flex; align-items: center; justify-content: center;
        color: #64748b !important;
      }
      #scma-help:hover { color: #7dd3fc !important; border-color: #7dd3fc !important; }

      /* ── Help overlay ── */
      #scma-help-overlay, #scma-mkt-help-overlay {
        display: flex; position: fixed; inset: 0; z-index: 2147483642;
        background: #00000080; align-items: center; justify-content: center;
      }
      #scma-help-box {
        background: #0f172a; border: 1px solid #334155; border-radius: 12px;
        width: 480px; max-height: 80vh; display: flex; flex-direction: column;
        font-family: 'Consolas', 'Courier New', monospace; font-size: 12px;
        color: #e2e8f0; box-shadow: 0 8px 40px #000a;
      }
      #scma-help-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 10px 14px; background: #1e293b;
        border-bottom: 1px solid #334155; border-radius: 12px 12px 0 0;
        font-weight: 700; color: #7dd3fc; font-size: 13px; flex-shrink: 0;
      }
      #scma-help-header button {
        background: none; border: none; cursor: pointer;
        color: #64748b; font-size: 14px; line-height: 1;
      }
      #scma-help-header button:hover { color: #f87171; }
      #scma-help-body {
        padding: 14px 16px; overflow-y: auto; line-height: 1.7;
        color: #cbd5e1;
      }
      #scma-help-body h3 {
        color: #7dd3fc; font-size: 11px; margin: 12px 0 4px;
        text-transform: uppercase; letter-spacing: .05em;
        border-bottom: 1px solid #1e293b; padding-bottom: 3px;
      }
      #scma-help-body h3:first-child { margin-top: 0; }
      #scma-help-body p { margin: 4px 0; }
      #scma-help-body ul { margin: 4px 0 4px 16px; padding: 0; }
      #scma-help-body li { margin-bottom: 3px; }
      #scma-help-body b { color: #e2e8f0; }
      #scma-help-body i { color: #94a3b8; }
      .scma-help-tag {
        display: inline-block; font-size: 10px; padding: 0 5px;
        border-radius: 3px; font-weight: 700;
      }
      .scma-help-tag.buy  { background: #14532d; color: #86efac; }
      .scma-help-tag.sell { background: #7f1d1d; color: #fca5a5; }

      /* ── Aero panel tab bar ── */
      #scma-tabs {
        display: flex; border-bottom: 1px solid #334155; flex-shrink: 0;
      }
      .scma-tab {
        flex: 1; background: none; border: none; border-bottom: 2px solid transparent;
        color: #475569; font-size: 11px; padding: 5px; cursor: pointer;
        font-family: inherit; transition: color .15s; user-select: none;
      }
      .scma-tab:hover { color: #94a3b8; }
      .scma-tab--on { color: #7dd3fc; border-bottom-color: #3b82f6; }

      /* ── Tab content wrappers ── */
      #scma-tab-live {
        flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0;
      }
      #scma-tab-hist {
        flex: 1; flex-direction: column; overflow: hidden; min-height: 0;
      }

      /* ── History tab controls ── */
      #scma-hist-controls {
        display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
        padding: 7px 12px; background: #1e293b;
        border-bottom: 1px solid #334155; flex-shrink: 0;
      }
      #scma-hist-controls label {
        font-size: 11px; color: #94a3b8;
        display: flex; align-items: center; gap: 4px;
      }
      #scma-hist-controls select, #scma-hist-controls input[type="datetime-local"] {
        background: #0f172a; color: #e2e8f0;
        border: 1px solid #334155; border-radius: 4px;
        padding: 2px 5px; font-size: 11px; font-family: inherit; cursor: pointer;
      }
      #scma-hist-controls input[type="datetime-local"]::-webkit-calendar-picker-indicator {
        filter: invert(0.6);
      }
      #scma-hist-refresh {
        background: #1e3a5f; color: #93c5fd; border: 1px solid #3b82f6;
        border-radius: 5px; padding: 3px 9px; font-size: 11px; cursor: pointer;
      }
      #scma-hist-refresh:hover { background: #2a4f7a; }
      #scma-hist-info { color: #475569; font-size: 10px; margin-left: auto; }
      #scma-hist-results { padding: 10px 12px; overflow-y: auto; flex: 1; }

      /* ── Market panel ── */
      #scma-mkt-panel {
        position: fixed; bottom: 58px; right: 18px; z-index: 2147483638;
        width: 460px; max-height: 82vh;
        display: flex; flex-direction: column;
        background: #0f172a; color: #e2e8f0;
        border: 1px solid #334155; border-radius: 12px;
        font-family: 'Consolas', 'Courier New', monospace; font-size: 12px;
        box-shadow: 0 8px 30px #0009; overflow: hidden;
      }
      #scma-mkt-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 9px 13px; background: #1e293b;
        border-bottom: 1px solid #334155;
        font-weight: 700; color: #7dd3fc; font-size: 13px;
        border-radius: 12px 12px 0 0; flex-shrink: 0; user-select: none;
      }
      #scma-mkt-header button {
        background: none; border: none; cursor: pointer;
        color: #64748b; font-size: 14px; line-height: 1;
      }
      #scma-mkt-header button:hover { color: #f87171; }
      #scma-mkt-controls {
        display: flex; gap: 6px; align-items: center;
        padding: 7px 12px; background: #1e293b;
        border-bottom: 1px solid #334155; flex-shrink: 0; flex-wrap: wrap;
      }
      #scma-mkt-controls label {
        font-size: 11px; color: #94a3b8;
        display: flex; align-items: center; gap: 4px;
      }
      #scma-mkt-controls input[type="number"] { width: 44px; }
      #scma-mkt-controls input {
        background: #0f172a; color: #e2e8f0;
        border: 1px solid #334155; border-radius: 4px;
        padding: 2px 5px; font-size: 11px; font-family: inherit;
      }
      #scma-mkt-search {
        background: #1d4ed8; color: #bfdbfe; border: none;
        border-radius: 6px; padding: 4px 10px; font-size: 11px;
        font-weight: 700; cursor: pointer; transition: background .15s;
      }
      #scma-mkt-search:hover:not(:disabled) { background: #2563eb; }
      #scma-mkt-search:disabled { opacity: .4; cursor: default; }
      #scma-mkt-stop {
        background: #7f1d1d; color: #fca5a5; border: none;
        border-radius: 6px; padding: 4px 8px; font-size: 11px; cursor: pointer;
      }
      #scma-mkt-stop:disabled { opacity: .4; cursor: default; }

      /* ── Watchlist ── */
      #scma-mkt-wl {
        border-bottom: 1px solid #334155; flex-shrink: 0;
        max-height: 200px; overflow-y: auto;
      }
      #scma-mkt-wl-add {
        display: flex; gap: 6px; padding: 7px 12px;
        border-bottom: 1px solid #1e293b; align-items: center;
      }
      /* ── Product select ── */
      #scma-mkt-wl-sel {
        flex: 1; background: #0f172a; color: #e2e8f0;
        border: 1px solid #334155; border-radius: 4px;
        padding: 3px 6px; font-size: 11px; font-family: inherit;
        cursor: pointer; min-height: 26px;
      }
      #scma-mkt-wl-sel:hover { border-color: #7dd3fc; }
      #scma-mkt-wl-sel:focus { outline: none; border-color: #7dd3fc; }
      #scma-mkt-room {
        background: #0f172a; color: #e2e8f0;
        border: 1px solid #334155; border-radius: 4px;
        padding: 2px 5px; font-size: 11px; font-family: inherit; cursor: pointer;
      }
      #scma-mkt-room:focus { outline: none; border-color: #7dd3fc; }

      /* ── Company link ── */
      .scma-co-link {
        color: #7dd3fc; text-decoration: none; font-weight: 700;
      }
      .scma-co-link:hover { text-decoration: underline; }
      #scma-mkt-wl-addbtn {
        background: #1e3a5f; color: #93c5fd; border: 1px solid #3b82f6;
        border-radius: 5px; padding: 3px 9px; font-size: 11px; cursor: pointer;
      }
      #scma-mkt-wl-addbtn:hover { background: #2a4f7a; }
      #scma-mkt-wl-list { padding: 4px 8px 6px; }
      .scma-wl-empty { color: #475569; font-size: 11px; padding: 4px 4px; }
      .scma-wl-item {
        display: flex; align-items: center; gap: 6px;
        padding: 4px 4px; border-bottom: 1px solid #1e293b17;
        flex-wrap: wrap;
      }
      .scma-wl-item:last-child { border-bottom: none; }
      .scma-wl-name { color: #93c5fd; font-weight: 700; font-size: 11px; min-width: 100px; }
      .scma-wl-quals { display: flex; flex-wrap: wrap; gap: 3px; flex: 1; }
      .scma-wl-q {
        font-size: 9px; padding: 1px 5px; border-radius: 3px; cursor: pointer;
        background: #1e293b; color: #64748b; border: 1px solid #334155;
        user-select: none;
      }
      .scma-wl-q:hover { border-color: #93c5fd; color: #93c5fd; }
      .scma-wl-q--on { background: #1e3a5f; color: #93c5fd; border-color: #3b82f6; }
      .scma-wl-rm {
        background: none; border: none; color: #475569; cursor: pointer;
        font-size: 11px; padding: 0 3px; flex-shrink: 0;
      }
      .scma-wl-rm:hover { color: #f87171; }

      /* ── View toggle ── */
      #scma-mkt-view {
        display: flex; border-bottom: 1px solid #334155; flex-shrink: 0;
      }
      .scma-mkt-vtab {
        flex: 1; background: none; border: none; border-bottom: 2px solid transparent;
        color: #475569; font-size: 11px; padding: 5px; cursor: pointer;
        font-family: inherit; transition: color .15s;
      }
      .scma-mkt-vtab:hover { color: #94a3b8; }
      .scma-mkt-vtab--on { color: #93c5fd; border-bottom-color: #3b82f6; }

      /* ── Market status + results ── */
      #scma-mkt-status {
        padding: 5px 13px; font-size: 10px; color: #64748b;
        border-bottom: 1px solid #1e293b; flex-shrink: 0; min-height: 22px;
      }
      #scma-mkt-results { padding: 10px 12px; overflow-y: auto; flex: 1; }

      /* ── Messages view ── */
      .scma-mkt-msg {
        padding: 7px 10px; border-bottom: 1px solid #1e293b;
        font-size: 11px;
      }
      .scma-mkt-msg:last-child { border-bottom: none; }
      .scma-mkt-msg--retracted { opacity: .6; }
      .scma-mkt-msg-hd {
        display: flex; align-items: center; gap: 6px; margin-bottom: 3px;
      }
      .scma-mkt-msg-co { color: #93c5fd; font-weight: 700; }
      .scma-mkt-msg-body {
        color: #94a3b8; white-space: pre-wrap; word-break: break-word;
        line-height: 1.5;
      }
      .scma-mkt-msg--retracted .scma-mkt-msg-body {
        text-decoration: line-through; text-decoration-color: #f87171;
      }
      .scma-mkt-re {
        display: inline-block; background: #1e293b; color: #94a3b8;
        border-radius: 3px; padding: 0 4px; font-size: 10px;
      }
      .scma-mkt-re--watched {
        background: #1e3a5f; color: #93c5fd;
        border: 1px solid #3b82f6; font-weight: 700;
      }

      /* ── Direction badges ── */
      .scma-dir-buy {
        display: inline-block; font-size: 9px; font-weight: 700;
        padding: 0 4px; border-radius: 3px;
        background: #14532d; color: #4ade80;
      }
      .scma-dir-sell {
        display: inline-block; font-size: 9px; font-weight: 700;
        padding: 0 4px; border-radius: 3px;
        background: #7f1d1d; color: #f87171;
      }

      /* ── Market help button ── */
      #scma-mkt-help {
        font-size: 12px !important; font-weight: 700;
        border: 1px solid #334155 !important; border-radius: 50% !important;
        width: 18px; height: 18px; padding: 0 !important;
        display: flex; align-items: center; justify-content: center;
        color: #64748b !important;
      }
      #scma-mkt-help:hover { color: #93c5fd !important; border-color: #3b82f6 !important; }

      /* ── Market about ── */
      #scma-mkt-about {
        border-top: 1px solid #1e293b; flex-shrink: 0;
      }
      #scma-mkt-about summary {
        padding: 5px 13px; font-size: 10px; color: #475569;
        cursor: pointer; list-style: none; user-select: none;
      }
      #scma-mkt-about summary::-webkit-details-marker { display: none; }
      #scma-mkt-about summary::before { content: '▶ '; font-size: 8px; }
      #scma-mkt-about[open] summary::before { content: '▼ '; }
      #scma-mkt-about summary:hover { color: #93c5fd; }
      #scma-mkt-about-body {
        padding: 5px 13px 4px; font-size: 11px; color: #64748b;
        display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
      }
      #scma-mkt-about-body a { color: #93c5fd; text-decoration: none; }
      #scma-mkt-about-body a:hover { text-decoration: underline; }
      #scma-mkt-about-ver {
        padding: 0 13px 8px; font-size: 11px; color: #64748b;
        display: flex; align-items: center; gap: 5px;
      }
      #scma-mkt-about-ver a { color: #93c5fd; text-decoration: none; }
      #scma-mkt-about-ver a:hover { text-decoration: underline; }
      #scma-mkt-update-status { color: #86efac; }

      /* ── Chart panel ── */
      #scma-ch-panel {
        position: fixed; bottom: 58px; left: 18px; z-index: 2147483637;
        width: 560px; max-height: 82vh;
        display: flex; flex-direction: column;
        background: #0f172a; color: #e2e8f0;
        border: 1px solid #334155; border-radius: 12px;
        font-family: 'Consolas', 'Courier New', monospace; font-size: 12px;
        box-shadow: 0 8px 30px #0009; overflow: hidden;
      }
      #scma-ch-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 9px 13px; background: #1e293b;
        border-bottom: 1px solid #334155;
        font-weight: 700; color: #7dd3fc; font-size: 13px;
        border-radius: 12px 12px 0 0; flex-shrink: 0; user-select: none;
        cursor: move;
      }
      #scma-ch-header button {
        background: none; border: none; cursor: pointer;
        color: #64748b; font-size: 14px; line-height: 1;
      }
      #scma-ch-header button:hover { color: #f87171; }
      #scma-ch-controls {
        display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
        padding: 7px 12px; background: #1e293b;
        border-bottom: 1px solid #334155; flex-shrink: 0;
      }
      #scma-ch-controls label {
        font-size: 11px; color: #94a3b8;
        display: flex; align-items: center; gap: 4px;
      }
      #scma-ch-controls select {
        background: #0f172a; color: #e2e8f0;
        border: 1px solid #334155; border-radius: 4px;
        padding: 2px 5px; font-size: 11px; font-family: inherit; cursor: pointer;
      }
      #scma-ch-controls input[type="checkbox"] { cursor: pointer; }
      #scma-ch-body {
        position: relative; padding: 12px;
        height: 320px; flex-shrink: 0;
      }
      #scma-ch-canvas { display: block; }
      #scma-ch-empty {
        display: none; position: absolute; inset: 0;
        align-items: center; justify-content: center;
        color: #475569; font-size: 13px;
      }

      /* ── Responsive: tablet (≤600px) ── */
      @media (max-width: 600px) {
        #scma-toggle-wrap {
          bottom: 10px; right: 10px;
        }
        #scma-toggle-aero, #scma-toggle-mkt {
          padding: 10px 16px; font-size: 15px;
        }
        #scma-panel, #scma-mkt-panel {
          width: calc(100vw - 16px);
          right: 8px; bottom: 62px;
          max-height: 78vh; font-size: 12px;
        }
        #scma-help-box {
          width: calc(100vw - 24px);
        }
        #scma-popup {
          width: calc(100vw - 24px);
          left: 12px !important; right: 12px !important;
          max-height: 55vh;
        }
      }

      /* ── Responsive: phone portrait (≤400px) ── */
      @media (max-width: 400px) {
        #scma-panel, #scma-mkt-panel {
          width: calc(100vw - 8px);
          right: 4px; bottom: 60px;
          max-height: 72vh;
          border-radius: 10px;
        }
        #scma-controls, #scma-mkt-controls {
          gap: 4px;
        }
        #scma-controls label, #scma-mkt-controls label {
          font-size: 12px;
        }
        #scma-controls input, #scma-mkt-controls input {
          font-size: 12px; padding: 4px 6px;
        }
        #scma-search, #scma-stop,
        #scma-mkt-search, #scma-mkt-stop {
          padding: 6px 12px; font-size: 12px;
        }
        .scma-table { font-size: 12px; }
        .scma-mkt-msg { font-size: 12px; }
        #scma-mkt-wl-sel { font-size: 12px; }
        .scma-wl-name { min-width: 0; }
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
