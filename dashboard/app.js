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
  verdict: '',
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

/** A net dollar figure with its sign always showing: +$111, -$42. */
function fmtNet(n) {
  return `${n < 0 ? '-' : '+'}${fmtUsd(Math.abs(n))}`;
}

/** A signed percent with one decimal, or a dash when the snapshot records none. */
function fmtPct(n) {
  if (n === null || n === undefined) return '-';
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
}

/** A share as a whole percent: 0.5073 becomes 51%. */
function fmtShare(n) {
  return `${Math.round(n * 100)}%`;
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
  const c = R.census;
  const excluded = c.excluded_product_category + c.excluded_versioned + c.excluded_wrapped + c.excluded_exchange_prefix;
  $('mast-meta').innerHTML =
    `snapshot <b>${esc(R.as_of)}</b><br>source <b>DefiLlama protocol index</b><br>model <b>${esc(R.model_version)}</b>`;
  const stats = [
    [R.watchlist_size, 'watchlist covered'],
    [R.board_size, 'pre-token ranked'],
    [R.fit.peers, 'traded peers fitted'],
    [c.already_trading, 'already trading'],
    [c.total, 'protocols in census'],
  ];
  $('stat-strip').innerHTML = stats.map(([v, k]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');
  $('model-strip').innerHTML =
    `<b>implied</b> <span class="op">=</span> <b>fitted value</b> <span class="op">x</span> <b>launch odds</b>` +
    ` &nbsp;·&nbsp; log(mcap) = <b>${R.fit.intercept.toFixed(2)}</b> + <b>${R.fit.slope.toFixed(2)}</b> x log(TVL) on ${R.fit.peers} peers` +
    ` &nbsp;·&nbsp; held-out <b>${R.fit.winner_error.toFixed(2)}</b> vs v1 flat <b>${R.fit.flat_error.toFixed(2)}</b>` +
    ` &nbsp;·&nbsp; census ${c.ranked} + ${c.already_trading} + ${excluded} = ${c.total}`;
  $('foot-note').textContent =
    `Launch Signal reads one sealed snapshot (${R.source}). Implied value is the model's claim about a launch that has not happened, ` +
    `derived only from the snapshot's own figures; it is not a prediction that a token will be issued. Farm plans are checklists, not financial advice.`;
}

/** Fill the filter selects from the dataset, keeping the reader's current choice. */
function renderControls() {
  const cats = [...new Set(R.rows.map((r) => r.category ?? 'Uncategorized'))].sort();
  $('cat').innerHTML = ['All categories', ...cats].map((c) => `<option ${c === state.cat ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
  $('chain').innerHTML = ['All chains', ...chains].map((c) => `<option ${c === state.chain ? 'selected' : ''}>${esc(c)}</option>`).join('');
  $('verdict').value = state.verdict;
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
    if (state.verdict && r.verdict !== state.verdict) return false;
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
  odds: (r) => r.odds,
  implied: (r) => r.implied_value_usd,
  verdict: (r) => r.net_usd,
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
        `<td class="num">${fmtShare(r.odds)}</td>` +
        `<td class="num implied">${fmtUsd(r.implied_value_usd)}</td>` +
        `<td><span class="verdict v-${r.verdict.toLowerCase()}">${r.verdict}</span><span class="net">${fmtNet(r.net_usd)} net</span></td></tr>`
      );
    })
    .join('');
  document.querySelectorAll('#board-body tr').forEach((tr) => {
    tr.addEventListener('click', () => openDetail(tr.dataset.slug));
  });
}

/** Open the detail drawer for one protocol: its record, the fit's arithmetic, the netting, its plan. */
function openDetail(slug) {
  const r = R.rows.find((row) => row.slug === slug);
  if (!r) return;
  state.selected = slug;
  const cat = R.categories.find((c) => c.category === (r.category ?? 'Uncategorized'));
  const offsetNote = cat && cat.offset !== 0 ? `, category offset ${cat.offset > 0 ? '+' : ''}${cat.offset.toFixed(2)}` : '';
  $('detail-body').innerHTML =
    `<h2>${esc(r.name)}</h2>` +
    `<div class="d-slug">${esc(r.slug)} · rank #${r.rank} of ${R.board_size}</div>` +
    `<div class="d-badges"><span class="badge pre">pre-token</span>` +
    (r.on_watchlist ? '<span class="badge wl">on the watchlist</span>' : '<span class="badge">found below the floor</span>') +
    `<span class="badge">${esc(r.category ?? 'Uncategorized')}</span>` +
    `<span class="badge v-${r.verdict.toLowerCase()}">verdict ${r.verdict}</span></div>` +
    `<div class="d-stats">` +
    `<div><div class="k">Implied launch value</div><div class="v big">${fmtUsd(r.implied_value_usd)}</div></div>` +
    `<div><div class="k">TVL</div><div class="v">${fmtUsd(r.tvl_usd)}</div></div>` +
    `<div><div class="k">7d TVL change</div><div class="v">${fmtPct(r.change_7d)}</div></div>` +
    `<div><div class="k">Tokenless for</div><div class="v">${fmtAge(r.age_days)}${r.listed_at ? ` (since ${esc(r.listed_at)})` : ''}</div></div>` +
    `<div><div class="k">Chains</div><div class="v">${esc(r.chains.join(', ') || '-')}</div></div>` +
    `<div><div class="k">Launch odds</div><div class="v">${fmtShare(r.odds)}</div></div>` +
    `</div>` +
    `<h3>How this value is made</h3>` +
    `<div class="breakdown">` +
    `<div class="row"><span>TVL</span><span>${fmtUsd(r.tvl_usd)}</span></div>` +
    `<div class="row"><span>fitted value <span class="note">(log-log fit ${R.fit.intercept.toFixed(2)} + ${R.fit.slope.toFixed(2)} x log TVL${offsetNote}; ${esc(r.multiple_basis)}, ${r.category_peers} peer${r.category_peers === 1 ? '' : 's'})</span></span><span>${fmtUsd(r.fitted_value_usd)}</span></div>` +
    `<div class="row"><span>x launch odds <span class="note">(age band ${fmtShare(r.odds_age_share)}, TVL band ${fmtShare(r.odds_tvl_share)})</span></span><span>${r.odds.toFixed(2)}x</span></div>` +
    `<div class="row total"><span>implied value</span><span>${fmtUsd(r.implied_value_usd)}</span></div>` +
    `</div>` +
    `<h3>Farm netting: verdict ${r.verdict}</h3>` +
    `<div class="breakdown">` +
    `<div class="row"><span>plan cost <span class="note">(gas, entry and exit, fees over ${r.weeks} weeks)</span></span><span>${fmtUsd(r.cost_usd)}</span></div>` +
    `<div class="row"><span>your time</span><span>${r.hours} hours</span></div>` +
    `<div class="row"><span>expected share <span class="note">(${Math.round(R.farm_accounting.drop_share * 100)}% of implied over ${R.farm_accounting.qualifying_wallets.toLocaleString('en-US')} wallets)</span></span><span>${fmtUsd(r.expected_usd)}</span></div>` +
    `<div class="row total"><span>net</span><span>${fmtNet(r.net_usd)}</span></div>` +
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

/** The model page: the fitted form, its blind test, the odds bands, the census, the accounting. */
function renderModel() {
  const f = R.fit;
  const a = R.farm_accounting;
  const c = R.census;
  $('model-body').innerHTML =
    `<p>The board prices a launch that has not happened, in two steps. First a <b>value model fitted on the ` +
    `snapshot's own traded protocols</b> says what a launch would be worth if it traded like them. Then ` +
    `<b>launch odds</b> measured from the snapshot's own record say how much of that value to book today. ` +
    `<b>No protocol is named anywhere in the model</b>: the same fitted line and the same odds score every row, ` +
    `and every factor is printed in each protocol's detail view.</p>` +
    `<div class="formula">fitted value = exp(${f.intercept.toFixed(2)} + ${f.slope.toFixed(2)} x log TVL) &nbsp;·&nbsp; implied = fitted value x launch odds</div>` +
    `<ul>` +
    `<li><b>The fit</b>: ordinary least squares of log market cap on log TVL over the ${f.peers} protocols that ` +
    `already trade. The slope under 1 says a TVL dollar inside a larger protocol prices lower than one inside a ` +
    `smaller protocol, which is what the market's own figures show.</li>` +
    `<li><b>Terms earn their place or they are dropped</b>: per-category offsets, a 7-day growth term and a ` +
    `tokenless-age term were each fitted and put through the held-out test below. On this snapshot none of them ` +
    `beat the plain line out of sample, so none of them prices a row. The v1 model's hand-set category medians ` +
    `are the baseline row of the same table.</li>` +
    `<li><b>Launch odds</b>: among all ${c.total} protocols in the snapshot, the share that already carry a token, ` +
    `grouped by tokenless-age band and by TVL band (tables below, Laplace-smoothed). A row's odds are the average ` +
    `of its two bands; a protocol with no listing date takes the global share for its age half.</li>` +
    `<li><b>Off the board</b>: wrapped, staked, bridged and versioned products of other protocols, and exchange ` +
    `products, are excluded at any size: their launch would be a parent's token, not their own. The ${R.watchlist_size} ` +
    `watchlist protocols are always carried, whatever the model says.</li>` +
    `</ul>`;
  $('valid-body').innerHTML = R.validation
    .map((v) => {
      const fate = v.id === f.winner ? 'ships' : v.id === 'flat' ? 'v1 baseline' : 'tested, dropped';
      return `<tr><td class="cat">${esc(v.label)}</td><td class="num">${v.median_log_error.toFixed(4)}</td><td class="cat">${fate}</td></tr>`;
    })
    .join('') +
    `<tr><td class="cat wrap" colspan="3">Each candidate is fitted on a seeded 80% of the ${f.peers} traded peers and scored on the held-out 20%, ` +
    `${f.validation_repeats} times over; the figure is the mean held-out median absolute log error. Lower is closer to the market's own prices.</td></tr>`;
  const bandTable = (title, bands) =>
    `<p><b>${title}</b></p><table class="board mult-table"><thead><tr><th>Band</th><th class="num">Protocols</th>` +
    `<th class="num">Carry a token</th><th class="num">Share</th></tr></thead><tbody>` +
    bands.map((b) => `<tr><td class="cat">${esc(b.label)}</td><td class="num">${b.n}</td><td class="num">${b.with_token}</td><td class="num">${fmtShare(b.share)}</td></tr>`).join('') +
    `</tbody></table>`;
  $('odds-body').innerHTML =
    `<p>Global base rate: <b>${fmtShare(R.odds.global_share)}</b> of the snapshot's ${c.total} protocols already carry a token.</p>` +
    bandTable('By tokenless age', R.odds.age_bands) +
    bandTable('By TVL', R.odds.tvl_bands);
  const excluded = c.excluded_product_category + c.excluded_versioned + c.excluded_wrapped + c.excluded_exchange_prefix;
  $('census-body').innerHTML =
    `<ul>` +
    `<li><b>${c.ranked} ranked</b> on the board (the ${R.watchlist_size} watchlist protocols among them).</li>` +
    `<li><b>${c.already_trading} already trading</b>: a token exists, so there is no launch to price.</li>` +
    `<li><b>${excluded} excluded as products of another protocol</b>: ${c.excluded_product_category} by product category ` +
    `(bridge, canonical bridge, liquid staking, liquid restaking, restaked BTC, exchange), ${c.excluded_versioned} by a versioned name, ` +
    `${c.excluded_wrapped} by a wrapped or staked name, ${c.excluded_exchange_prefix} by an exchange name.</li>` +
    `<li>Total: ${c.ranked} + ${c.already_trading} + ${excluded} = <b>${c.total}</b>, the whole snapshot.</li>` +
    `</ul>`;
  $('farm-body').innerHTML =
    `<p>Every plan is costed from its own steps: the chain's gas per touch times the plan's weekly touches plus entry and exit, ` +
    `plus swap and borrow fees of ${(a.fee_rate * 100).toFixed(1)}% of the capital the plan deploys. Against that cost stands the ` +
    `expected launch share: a launch is assumed to allocate ${Math.round(a.drop_share * 100)}% of its implied value to the community, ` +
    `spread over ${a.qualifying_wallets.toLocaleString('en-US')} qualifying wallets. <b>FARM</b> when the expected share covers the cost ` +
    `${a.farm_multiple} times over, <b>THIN</b> when it merely covers it, <b>SKIP</b> when it does not. The assumptions are the radar's own ` +
    `bookkeeping, printed so the arithmetic in every detail view can be checked; they are not a promise about any real launch.</p>`;
  $('mult-body').innerHTML = R.categories
    .map(
      (x) =>
        `<tr><td class="cat">${esc(x.category)}</td><td class="num">${x.peers}</td>` +
        `<td class="num">${x.offset > 0 ? '+' : ''}${x.offset.toFixed(2)}</td>` +
        `<td class="num">${x.multiple_at_ref.toFixed(2)}x</td><td class="cat">${esc(x.basis)}</td></tr>`,
    )
    .join('') +
    `<tr><td class="cat wrap" colspan="5">An offset is a category's median residual from the fitted line, shrunk toward zero; offsets were fitted ` +
    `for every category with enough peers and then dropped when the held-out test scored them worse than the plain line, so every category ` +
    `is currently priced by the global fit alone.</td></tr>`;
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
  $('verdict').addEventListener('change', (e) => { state.verdict = e.target.value; renderBoard(); });
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
