// Launch Signal dashboard: renders window.RADAR (written by main.ts beside this page).
// No network, no framework: the board, its filters, the detail view, the live set and the
// model page are all drawn from that one dataset, so what the screenshots show is exactly
// what board.json claims.

const R = window.RADAR;
const $ = (id) => document.getElementById(id);

const state = {
  q: '',
  cat: 'All categories',
  chain: 'All chains',
  wl: false,
  sort: 'rank',
  dir: 1,
  selected: null,
};

/** $1.24B, $312M, $45.2K, $980: the one money format the whole page uses. */
function fmtUsd(n) {
  if (n === null || n === undefined) return '-';
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

/** A signed percent with one decimal, or a dash when the snapshot records none. */
function fmtPct(n) {
  if (n === null || n === undefined) return '-';
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
}

/** A tokenless age in days as the phrase the board sorts by: 3.2y, 214d, unknown. */
function fmtAge(days) {
  if (days === null || days === undefined) return 'unknown';
  if (days >= 730) return `${(days / 365.25).toFixed(1)}y`;
  if (days >= 60) return `${Math.round(days / 30.4)}mo`;
  return `${days}d`;
}

/** Escape a data string before it goes into markup. */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Read the opening view from the hash: #detail=<slug>, #cat=<category>, #chain=<chain>, #q=<text>. */
function readHash() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (h.get('detail')) state.selected = h.get('detail');
  if (h.get('cat')) state.cat = h.get('cat');
  if (h.get('chain')) state.chain = h.get('chain');
  if (h.get('q')) state.q = h.get('q');
  if (h.get('wl') === '1') state.wl = true;
}

function renderMasthead() {
  $('mast-meta').innerHTML =
    `snapshot <b>${esc(R.as_of)}</b><br>source <b>DefiLlama protocol index</b><br>model <b>${esc(R.model_version)}</b>`;
  const stats = [
    [R.watchlist_size, 'watchlist covered'],
    [R.board_size, 'pre-token ranked'],
    [R.global_peers, 'traded peers measured'],
    [R.multiples.length, 'categories priced'],
    [fmtUsd(R.floor_usd), 'watchlist floor'],
  ];
  $('stat-strip').innerHTML = stats.map(([v, k]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');
  $('model-strip').innerHTML =
    `<b>implied value</b> <span class="op">=</span> TVL <span class="op">x</span> <b>category peer multiple</b> ` +
    `<span class="op">x</span> growth factor <span class="op">x</span> age factor` +
    ` &nbsp;·&nbsp; global peer median <b>${R.global_multiple.toFixed(2)}x</b> from ${R.global_peers} traded protocols`;
  $('foot-note').textContent =
    `Launch Signal reads one sealed snapshot (${R.source}). Implied value is the model's claim about a launch that has not happened, ` +
    `derived only from the snapshot's own figures; it is not a prediction that a token will be issued. Farm plans are checklists, not financial advice.`;
}

/** Fill the two filter selects from the dataset, keeping the reader's current choice. */
function renderControls() {
  const cats = [...new Set(R.rows.map((r) => r.category ?? 'Uncategorized'))].sort();
  $('cat').innerHTML = ['All categories', ...cats].map((c) => `<option ${c === state.cat ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
  $('chain').innerHTML = ['All chains', ...chains].map((c) => `<option ${c === state.chain ? 'selected' : ''}>${esc(c)}</option>`).join('');
  $('q').value = state.q;
  $('wl').checked = state.wl;
}

/** The rows the current filters leave visible. */
function visibleRows() {
  const q = state.q.trim().toLowerCase();
  return R.rows.filter((r) => {
    if (state.wl && !r.on_watchlist) return false;
    if (state.cat !== 'All categories' && (r.category ?? 'Uncategorized') !== state.cat) return false;
    if (state.chain !== 'All chains' && !r.chains.includes(state.chain)) return false;
    if (q && !`${r.name} ${r.slug} ${r.chains.join(' ')}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

const SORT_KEYS = {
  rank: (r) => r.rank,
  name: (r) => r.name.toLowerCase(),
  category: (r) => (r.category ?? '').toLowerCase(),
  tvl: (r) => r.tvl_usd,
  change: (r) => r.change_7d ?? -Infinity,
  age: (r) => r.age_days ?? -1,
  implied: (r) => r.implied_value_usd,
  ratio: (r) => r.implied_value_usd / Math.max(1, r.tvl_usd),
};

/** Draw the board table for the current filter and sort state. */
function renderBoard() {
  const rows = visibleRows();
  const key = SORT_KEYS[state.sort] ?? SORT_KEYS.rank;
  rows.sort((a, b) => {
    const d = key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.rank - b.rank;
    return d * state.dir;
  });
  $('board-count').textContent = `- ${rows.length} of ${R.board_size} shown`;
  $('board-empty').hidden = rows.length > 0;
  document.querySelectorAll('#board th[data-sort]').forEach((th) => {
    const active = th.dataset.sort === state.sort;
    th.innerHTML = `${esc(th.textContent.replace(/ [v^]$/, ''))}${active ? ` <span class="dir">${state.dir === 1 ? 'v' : '^'}</span>` : ''}`;
  });
  $('board-body').innerHTML = rows
    .map((r) => {
      const chg = r.change_7d === null ? '-' : `<span class="${r.change_7d >= 0 ? 'chg-up' : 'chg-dn'}">${fmtPct(r.change_7d)}</span>`;
      const chains = r.chains.length <= 2 ? r.chains.join(', ') : `${r.chains.slice(0, 2).join(', ')} +${r.chains.length - 2}`;
      return (
        `<tr data-slug="${esc(r.slug)}" class="${state.selected === r.slug ? 'selected' : ''}">` +
        `<td class="rank num">${r.rank}</td>` +
        `<td class="name">${esc(r.name)}${r.on_watchlist ? '<span class="star">WATCHLIST</span>' : ''}<span class="slug">${esc(r.slug)}</span></td>` +
        `<td class="cat">${esc(r.category ?? 'Uncategorized')}</td>` +
        `<td class="chains">${esc(chains)}</td>` +
        `<td class="num">${fmtUsd(r.tvl_usd)}</td>` +
        `<td class="num">${chg}</td>` +
        `<td class="num">${fmtAge(r.age_days)}</td>` +
        `<td class="num implied">${fmtUsd(r.implied_value_usd)}</td>` +
        `<td class="num">${(r.implied_value_usd / Math.max(1, r.tvl_usd)).toFixed(2)}x</td></tr>`
      );
    })
    .join('');
  document.querySelectorAll('#board-body tr').forEach((tr) => {
    tr.addEventListener('click', () => openDetail(tr.dataset.slug));
  });
}

/** Open the detail drawer for one protocol: its record, its model's arithmetic, its plan. */
function openDetail(slug) {
  const r = R.rows.find((row) => row.slug === slug);
  if (!r) return;
  state.selected = slug;
  const base = Math.round(r.tvl_usd * r.multiple);
  const afterGrowth = Math.round(base * r.growth_factor);
  $('detail-body').innerHTML =
    `<h2>${esc(r.name)}</h2>` +
    `<div class="d-slug">${esc(r.slug)} · rank #${r.rank} of ${R.board_size}</div>` +
    `<div class="d-badges"><span class="badge pre">pre-token</span>` +
    (r.on_watchlist ? '<span class="badge wl">on the watchlist</span>' : '<span class="badge">found below the floor</span>') +
    `<span class="badge">${esc(r.category ?? 'Uncategorized')}</span></div>` +
    `<div class="d-stats">` +
    `<div><div class="k">Implied launch value</div><div class="v big">${fmtUsd(r.implied_value_usd)}</div></div>` +
    `<div><div class="k">TVL</div><div class="v">${fmtUsd(r.tvl_usd)}</div></div>` +
    `<div><div class="k">7d TVL change</div><div class="v">${fmtPct(r.change_7d)}</div></div>` +
    `<div><div class="k">Tokenless for</div><div class="v">${fmtAge(r.age_days)}${r.listed_at ? ` (since ${esc(r.listed_at)})` : ''}</div></div>` +
    `<div><div class="k">Chains</div><div class="v">${esc(r.chains.join(', ') || '-')}</div></div>` +
    `<div><div class="k">Implied / TVL</div><div class="v">${(r.implied_value_usd / Math.max(1, r.tvl_usd)).toFixed(2)}x</div></div>` +
    `</div>` +
    `<h3>How this value is made</h3>` +
    `<div class="breakdown">` +
    `<div class="row"><span>TVL</span><span>${fmtUsd(r.tvl_usd)}</span></div>` +
    `<div class="row"><span>x peer multiple <span class="note">(${esc(r.category ?? 'Uncategorized')}, ${r.multiple_basis}, ${r.category_peers} peer${r.category_peers === 1 ? '' : 's'})</span></span><span>${r.multiple.toFixed(2)}x</span></div>` +
    `<div class="row"><span>= base value</span><span>${fmtUsd(base)}</span></div>` +
    `<div class="row"><span>x growth factor <span class="note">(7d ${fmtPct(r.change_7d)})</span></span><span>${r.growth_factor.toFixed(2)}x</span></div>` +
    `<div class="row"><span>= after growth</span><span>${fmtUsd(afterGrowth)}</span></div>` +
    `<div class="row"><span>x age factor <span class="note">(${fmtAge(r.age_days)} tokenless)</span></span><span>${r.age_factor.toFixed(2)}x</span></div>` +
    `<div class="row total"><span>implied value</span><span>${fmtUsd(r.implied_value_usd)}</span></div>` +
    `</div>` +
    `<h3>Farm plan</h3>` +
    `<ol class="steps">${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`;
  $('detail').hidden = false;
  renderBoard();
}

function closeDetail() {
  state.selected = null;
  $('detail').hidden = true;
  renderBoard();
}

/** The live comparison set: traded protocols with the market's own numbers. */
function renderLive() {
  $('live-body').innerHTML = R.live
    .map(
      (p) =>
        `<tr><td class="name">${esc(p.name)}<span class="slug">${esc(p.slug)}</span></td>` +
        `<td class="sym">${esc(p.symbol ?? '-')}</td>` +
        `<td class="cat">${esc(p.category ?? 'Uncategorized')}</td>` +
        `<td class="num">${fmtUsd(p.tvl_usd)}</td>` +
        `<td class="num">${fmtUsd(p.mcap_usd)}</td>` +
        `<td class="num">${p.mcap_tvl.toFixed(2)}x</td>` +
        `<td class="num">${p.change_7d === null ? '-' : `<span class="${p.change_7d >= 0 ? 'chg-up' : 'chg-dn'}">${fmtPct(p.change_7d)}</span>`}</td></tr>`,
    )
    .join('');
}

/** The model page: the formula in words, the stated constants, the measured multiples. */
function renderModel() {
  const m = R.model;
  $('model-body').innerHTML =
    `<p>The board prices a launch that has not happened. For each pre-token protocol it asks what the market ` +
    `already pays for a TVL dollar in the same line of business, then adjusts for momentum and for how long ` +
    `the protocol has run without a token. <b>No protocol is named anywhere in the model</b>: the same three ` +
    `factors score every row, and every factor is printed in each protocol's detail view.</p>` +
    `<div class="formula">implied = TVL x peer multiple x growth factor x age factor</div>` +
    `<ul>` +
    `<li><b>Peer multiple</b>: the median market-cap-to-TVL ratio of the traded protocols in the same category ` +
    `(${R.global_peers} measured; a category with fewer than ${m.min_category_peers} traded peers uses the global median ` +
    `${R.global_multiple.toFixed(2)}x). Multiples are clamped to ${m.multiple_floor}x-${m.multiple_cap}x so one outlier cannot price a category.</li>` +
    `<li><b>Growth factor</b>: 1 + clamp(7d TVL change, ${m.growth_clamp_min}%, +${m.growth_clamp_max}%) x ${m.growth_weight}, ` +
    `so a hot week lifts a value by at most half, and a bad week cannot erase it.</li>` +
    `<li><b>Age factor</b>: ${m.age_floor} + ${m.age_range} x ln(1 + tokenless days) / ln(1 + ${m.age_horizon_days}), ` +
    `rising slowly toward ${m.age_floor + m.age_range} for protocols that have operated five years with no token; an unknown listing date scores the neutral 1.00.</li>` +
    `<li><b>Off the board</b>: wrapped, staked, bridged and versioned products of other protocols, and exchange ` +
    `products, are excluded at any size: their launch would be a parent's token, not their own. The ${R.watchlist_size} ` +
    `watchlist protocols are always carried, whatever the model says.</li>` +
    `</ul>`;
  $('mult-body').innerHTML = R.multiples
    .map(
      (c) =>
        `<tr><td class="cat">${esc(c.category)}</td><td class="num">${c.peers}</td>` +
        `<td class="num">${c.multiple.toFixed(2)}x</td><td class="cat">${esc(c.basis)}</td></tr>`,
    )
    .join('');
}

/** Wire the controls and draw everything once. */
function init() {
  readHash();
  renderMasthead();
  renderControls();
  renderBoard();
  renderLive();
  renderModel();
  if (state.selected) openDetail(state.selected);
  $('q').addEventListener('input', (e) => { state.q = e.target.value; renderBoard(); });
  $('cat').addEventListener('change', (e) => { state.cat = e.target.value; renderBoard(); });
  $('chain').addEventListener('change', (e) => { state.chain = e.target.value; renderBoard(); });
  $('wl').addEventListener('change', (e) => { state.wl = e.target.checked; renderBoard(); });
  document.querySelectorAll('#board th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (state.sort === k) state.dir = -state.dir;
      else { state.sort = k; state.dir = k === 'name' || k === 'category' ? 1 : -1; }
      renderBoard();
    });
  });
  $('detail-close').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
}

init();
