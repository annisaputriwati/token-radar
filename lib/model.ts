// Launch Signal: a token-launch radar model over one sealed DefiLlama snapshot.
//
// The question the board answers: if a protocol that still records no token launched one
// today, what would that token plausibly be worth? The model derives every figure from the
// snapshot itself. No protocol name is ever special-cased; the same functions score all rows.
//
//   peer multiple  = median(market cap / TVL) of the protocols in the same category that
//                    already trade a token (a category with fewer than 3 traded peers falls
//                    back to the global peer median), clamped to [0.01, 3]
//   base value     = TVL x peer multiple        (what the market pays per TVL dollar here)
//   growth factor  = 1 + clamp(change_7d, -50, +100) / 100 x 0.5     (range 0.75 .. 1.50)
//   age factor     = 0.7 + 0.6 x ln(1 + tokenless days) / ln(1 + 1825) (range 0.70 .. 1.30;
//                    a protocol with no listing date gets the neutral factor 1.0)
//   implied value  = max(1, round(base value x growth factor x age factor))
//
// The board ranks every pre-token protocol that is not itself a wrapped, staked, bridged or
// versioned product of another protocol. The snapshot's watchlist is the floor: all of its
// slugs are always on the board. Protocols whose token already trades are never ranked; they
// are reported apart as the live comparison set the peer multiples are measured from.

/** One protocol record: exactly the ten fields the sealed snapshot carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's stated constants: the dashboard prints them next to the board. */
export interface ModelConstants {
  min_category_peers: number;
  multiple_floor: number;
  multiple_cap: number;
  growth_clamp_min: number;
  growth_clamp_max: number;
  growth_weight: number;
  age_floor: number;
  age_range: number;
  age_horizon_days: number;
}

export const MODEL: ModelConstants = {
  min_category_peers: 3,
  multiple_floor: 0.01,
  multiple_cap: 3,
  growth_clamp_min: -50,
  growth_clamp_max: 100,
  growth_weight: 0.5,
  age_floor: 0.7,
  age_range: 0.6,
  age_horizon_days: 1825,
};

/** The model's version label, printed by the dashboard and quoted in the dossier. */
export const MODEL_VERSION = 'launch-signal-1';

/** How many already-trading protocols the dashboard's live comparison set carries. */
export const LIVE_ROWS = 30;

/** Why a snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either date is unusable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The middle value of an ascending list; the mean of the two middle values when it is even. */
function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The snapshot out of a file's text, refused unless it carries the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** The bucket a protocol's peer multiple is read from when it has no named category. */
const NO_CATEGORY = 'Uncategorized';

/** One category's peer multiple: how it was measured and from how many traded protocols. */
export interface CategoryMultiple {
  category: string;
  peers: number;
  multiple: number;
  basis: 'category median' | 'global fallback';
}

/** Every category's multiple, plus the global peer median they fall back to. */
export interface PeerMultiples {
  global_peers: number;
  global_multiple: number;
  by_category: Map<string, CategoryMultiple>;
}

/** A traded protocol: one whose record carries a market cap for its token. */
function isTradedPeer(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0;
}

/**
 * The peer multiples, measured from the snapshot alone: for each category, the median
 * market-cap-to-TVL ratio of its traded protocols. A category with fewer traded peers than
 * the model's minimum borrows the global median, so no thin category prices a launch off
 * one or two outliers. Every multiple is clamped to the model's stated band.
 */
export function peerMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): PeerMultiples {
  const clamp = (m: number): number => Math.min(model.multiple_cap, Math.max(model.multiple_floor, m));
  const ratiosByCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (!isTradedPeer(p)) continue;
    const ratio = p.mcap_usd! / p.tvl_usd;
    all.push(ratio);
    const key = p.category ?? NO_CATEGORY;
    const list = ratiosByCategory.get(key);
    if (list === undefined) ratiosByCategory.set(key, [ratio]);
    else list.push(ratio);
  }
  all.sort((a, b) => a - b);
  const globalMultiple = round4(clamp(median(all)));
  const byCategory = new Map<string, CategoryMultiple>();
  for (const [category, ratios] of ratiosByCategory) {
    ratios.sort((a, b) => a - b);
    if (ratios.length >= model.min_category_peers) {
      byCategory.set(category, { category, peers: ratios.length, multiple: round4(clamp(median(ratios))), basis: 'category median' });
    } else {
      byCategory.set(category, { category, peers: ratios.length, multiple: globalMultiple, basis: 'global fallback' });
    }
  }
  return { global_peers: all.length, global_multiple: globalMultiple, by_category: byCategory };
}

/** The multiple one protocol is priced with, and how that multiple was measured. */
function multipleFor(p: SnapshotProtocol, peers: PeerMultiples): CategoryMultiple {
  const found = peers.by_category.get(p.category ?? NO_CATEGORY);
  if (found !== undefined) return found;
  return { category: p.category ?? NO_CATEGORY, peers: 0, multiple: peers.global_multiple, basis: 'global fallback' };
}

/** The parts of one protocol's score, exactly as the dashboard's detail view shows them. */
export interface ScoreParts {
  multiple: number;
  multiple_basis: 'category median' | 'global fallback';
  category_peers: number;
  growth_pct: number;
  growth_factor: number;
  age_days: number | null;
  age_factor: number;
  implied: number;
}

/** One protocol's implied launch value and every factor that produced it. */
export function scoreProtocol(p: SnapshotProtocol, asOf: string, peers: PeerMultiples, model: ModelConstants = MODEL): ScoreParts {
  const m = multipleFor(p, peers);
  const rawGrowth = p.change_7d ?? 0;
  const growthPct = Math.min(model.growth_clamp_max, Math.max(model.growth_clamp_min, rawGrowth));
  const growthFactor = round4(1 + (growthPct / 100) * model.growth_weight);
  const age = ageDays(asOf, p.listed_at);
  const ageFactor =
    age === null ? 1 : round4(model.age_floor + model.age_range * (Math.log(1 + age) / Math.log(1 + model.age_horizon_days)));
  const implied = Math.max(1, Math.round(p.tvl_usd * m.multiple * growthFactor * ageFactor));
  return {
    multiple: m.multiple,
    multiple_basis: m.basis,
    category_peers: m.peers,
    growth_pct: growthPct,
    growth_factor: growthFactor,
    age_days: age,
    age_factor: ageFactor,
    implied,
  };
}

/** Whether a protocol records no token: no CoinGecko id and no symbol in its record. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is another protocol's pool. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whole words that mark a wrapped or staked product of a token that already trades. */
const WRAPPED_WORDS = /\b(wrapped|staked|staking)\b/i;

/** Exchange names a product may begin with when it is an exchange's own wrapper. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Categories that are wrapped, staked, bridged or exchange products by construction. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/**
 * Whether a protocol is a wrapped, staked, bridged or versioned product of another protocol
 * (or an exchange's own product): such a protocol's launch is its parent's token, not its own.
 */
export function isProductOfAnother(p: SnapshotProtocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return true;
  if (VERSIONED.test(p.name)) return true;
  if (WRAPPED_WORDS.test(p.name)) return true;
  return EXCHANGE_PREFIXES.some((name) => p.name.startsWith(name));
}

/** The working parts of one farm plan, all read off the protocol's own record. */
interface FarmContext {
  name: string;
  chain: string;
  chain2: string;
  capital: number;
  hold: number;
  gas: number;
}

/** Typical cost in dollars of one deposit-sized transaction on a chain, for plan estimates. */
const CHAIN_GAS: Record<string, number> = {
  Ethereum: 12, Arbitrum: 0.4, Base: 0.25, Optimism: 0.35, Polygon: 0.05, Solana: 0.05,
  Avalanche: 0.6, Binance: 0.3, Tron: 1.2, Bitcoin: 2.5, 'Hyperliquid L1': 0.05, Monad: 0.1,
};

/** How much capital one qualifying position needs, scaled to the protocol's own TVL. */
function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 250;
  if (tvl >= 250_000_000) return 150;
  if (tvl >= 50_000_000) return 100;
  return 50;
}

/** How long a position should run, from the protocol's tokenless age: younger, longer. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  if (age < 730) return 30;
  return 21;
}

/** The plan family a category belongs to: each family farms a different kind of protocol. */
function farmFamily(category: string | null): string {
  const c = (category ?? '').toLowerCase();
  if (c.includes('dex')) return 'dex';
  if (c.includes('cdp')) return 'cdp';
  if (c.includes('lend') || c.includes('collateral')) return 'lending';
  if (c.includes('deriv') || c.includes('option') || c.includes('synthetic')) return 'derivatives';
  if (c.includes('rwa') || c.includes('index') || c.includes('allocator') || c.includes('curator') || c.includes('stable') || c.includes('basis')) return 'allocator';
  if (c.includes('yield') || c.includes('farm') || c.includes('staking') || c.includes('restaking') || c.includes('liquidity')) return 'yield';
  if (c === 'chain') return 'chain';
  if (c.includes('launchpad')) return 'launchpad';
  if (c.includes('prediction')) return 'prediction';
  if (c.includes('privacy')) return 'privacy';
  if (c.includes('payment') || c.includes('card')) return 'payments';
  if (c.includes('insurance')) return 'insurance';
  if (c.includes('marketplace')) return 'marketplace';
  if (c.includes('ai')) return 'ai';
  return 'generic';
}

/** The five steps of one family's plan, each a function of the protocol's own record. */
const FARM_PLANS: Record<string, Array<(x: FarmContext) => string>> = {
  dex: [
    (x) => `Fund a fresh wallet on ${x.chain} with about $${x.capital + 20} in USDC and the chain's gas token. Cost: roughly $${x.gas} in gas plus any bridge fee. Time: about 15 minutes.`,
    (x) => `Open ${x.name} on ${x.chain} and add $${x.capital} to its deepest USDC pool; keep the LP position open rather than withdrawing after the first session. Cost: about $${x.gas} in gas. Time: 10 minutes.`,
    (x) => `Make two swaps a week inside ${x.name} (USDC to a major asset and back, $25 or more each) so the wallet shows real trading volume, not one deposit. Cost: pool fees plus about $${x.gas} gas a week. Time: 5 minutes a week.`,
    (x) => `Claim any fee or reward balance the pool accrues each week and restake it into the same position instead of cashing out. Cost: about $${x.gas} a claim. Time: 5 minutes a week.`,
    (x) => `Hold the LP position for at least ${x.hold} days and keep the wallet, dates and transaction hashes in a farm log. Cost: the $${x.capital} stays deployed. Time: ${x.hold} days.`,
  ],
  lending: [
    (x) => `Fund a fresh wallet on ${x.chain} with about $${x.capital + 20} in USDC and the chain's gas token. Cost: roughly $${x.gas} in gas plus any bridge fee. Time: about 15 minutes.`,
    (x) => `Supply $${x.capital} of USDC to ${x.name}'s main market on ${x.chain} and enable it as collateral. Cost: about $${x.gas} in gas. Time: 10 minutes.`,
    (x) => `Borrow about 30% of the supplied value in a second asset and repay it within the week, so the wallet records both sides of the market. Cost: a few days of borrow interest, usually under $1. Time: 10 minutes.`,
    (x) => `Add a small top-up deposit every week (about $${Math.max(10, Math.round(x.capital / 10))}) to keep the position active across snapshots. Cost: about $${x.gas} a week. Time: 5 minutes a week.`,
    (x) => `Hold the supplied position for at least ${x.hold} days, then check ${x.name}'s own rewards page before withdrawing anything. Cost: the $${x.capital} stays supplied. Time: ${x.hold} days.`,
  ],
  cdp: [
    (x) => `Fund a fresh wallet on ${x.chain} with about $${x.capital + 20} in ETH or a liquid staking token plus gas money. Cost: roughly $${x.gas} in gas plus any bridge fee. Time: about 15 minutes.`,
    (x) => `Open a vault in ${x.name} on ${x.chain} with $${x.capital} of collateral and mint about 40% of its value in the protocol's stablecoin. Cost: about $${x.gas} in gas. Time: 15 minutes.`,
    (x) => `Use the minted stablecoin inside the same ecosystem (a swap or a deposit on ${x.chain2}) so the debt is backed by visible activity, not idle minting. Cost: about $${x.gas}. Time: 10 minutes.`,
    (x) => `Top up the collateral whenever the vault's health factor drifts toward liquidation, checking it weekly. Cost: gas only, about $${x.gas} a check-in. Time: 5 minutes a week.`,
    (x) => `Keep the vault open for at least ${x.hold} days before repaying; a vault that survives several snapshots is the activity that counts. Cost: the stability fee on the minted amount. Time: ${x.hold} days.`,
  ],
  derivatives: [
    (x) => `Fund a fresh wallet on ${x.chain} with about $${x.capital + 20} in USDC margin plus the chain's gas token. Cost: roughly $${x.gas} in gas plus any bridge fee. Time: about 15 minutes.`,
    (x) => `Deposit $${x.capital} as margin on ${x.name} and open one small hedged position (long and short legs of about $50 each) to learn its liquidation rules. Cost: trading fees of roughly 0.1% a leg. Time: 20 minutes.`,
    (x) => `Trade two sessions a week with modest size, keeping total open interest under the deposited margin; consistency matters more than volume spikes. Cost: about $1-3 in fees a week. Time: 15 minutes a week.`,
    (x) => `Stake or lock any margin rebate, fee share or vault share ${x.name} offers depositors, if one is live, and leave it untouched. Cost: about $${x.gas}. Time: 5 minutes.`,
    (x) => `Keep the margin account active for at least ${x.hold} days and log every session; dormant margin earns nothing in most points designs. Cost: the $${x.capital} stays as margin. Time: ${x.hold} days.`,
  ],
  allocator: [
    (x) => `Fund a fresh wallet on ${x.chain} with about $${x.capital + 20} in USDC and the chain's gas token. Cost: roughly $${x.gas} in gas plus any bridge fee. Time: about 15 minutes.`,
    (x) => `Deposit $${x.capital} into ${x.name}'s flagship vault or index on ${x.chain} and keep the vault shares in the same wallet. Cost: about $${x.gas} in gas. Time: 10 minutes.`,
    (x) => `Split a second, smaller deposit (about $${Math.max(10, Math.round(x.capital / 5))}) into a different strategy of ${x.name} if one exists, so the wallet touches more than one product. Cost: about $${x.gas}. Time: 10 minutes.`,
    (x) => `Reinvest harvested yield monthly instead of withdrawing it, and screenshot the share balance for your farm log. Cost: about $${x.gas} a month. Time: 5 minutes a month.`,
    (x) => `Hold the vault shares for at least ${x.hold} days; allocator points designs reward time-weighted balances above quick in-and-out deposits. Cost: the $${x.capital} stays invested. Time: ${x.hold} days.`,
  ],
};

FARM_PLANS.yield = [
  (x) => `Fund a fresh wallet on ${x.chain} with about $${x.capital + 20} in the asset ${x.name} accepts, plus the chain's gas token. Cost: roughly $${x.gas} in gas plus any bridge fee. Time: about 15 minutes.`,
  (x) => `Deposit $${x.capital} into ${x.name}'s main vault or pool on ${x.chain} and keep the receipt or share token unstaked unless the protocol asks otherwise. Cost: about $${x.gas} in gas. Time: 10 minutes.`,
  (x) => `Compound the yield back into the same position once a week rather than selling it, so the balance grows on-chain. Cost: about $${x.gas} a week. Time: 5 minutes a week.`,
  (x) => `If ${x.name} runs on ${x.chain2} as well, open a dust position there too (about $15) so the wallet is visible on both deployments. Cost: about $${x.gas}. Time: 10 minutes.`,
  (x) => `Hold the position for at least ${x.hold} days and record the entry date; yield points almost always weight holding time. Cost: the $${x.capital} stays deposited. Time: ${x.hold} days.`,
];
FARM_PLANS.chain = [
  (x) => `Create a wallet native to ${x.name}'s chain and fund it with about $${x.capital} in the chain's gas asset from an exchange withdrawal. Cost: the exchange's withdrawal fee, usually $1-5. Time: about 20 minutes.`,
  (x) => `Bridge a second $${Math.max(25, Math.round(x.capital / 2))} onto the chain through its canonical route so the wallet has both a native and a bridged balance. Cost: bridge fee plus about $${x.gas} in gas. Time: 15 minutes.`,
  (x) => `Make three ordinary transactions a week on the chain (a swap, a transfer between your own wallets, a small contract call). Cost: about $${x.gas} a transaction. Time: 10 minutes a week.`,
  (x) => `Use one flagship application on the chain each week and keep the receipts; chain-level campaigns count distinct applications, not raw transaction count. Cost: the app's own fees. Time: 15 minutes a week.`,
  (x) => `Stay active for at least ${x.hold} days spread across several weeks; one busy day is filtered out of most chain snapshots. Cost: the $${x.capital} stays on the chain. Time: ${x.hold} days.`,
];
FARM_PLANS.launchpad = [
  (x) => `Fund a fresh wallet on ${x.chain} with about $${x.capital + 20} in the chain's gas token and a stablecoin. Cost: roughly $${x.gas} in gas plus any bridge fee. Time: about 15 minutes.`,
  (x) => `Complete ${x.name}'s own registration or allowlist steps from its official page only, and link the funded wallet. Cost: usually gas only, about $${x.gas}. Time: 15 minutes.`,
  (x) => `Commit about $${Math.round(x.capital / 2)} to the next suitable launch on ${x.name} rather than spreading dust across every sale. Cost: the committed amount until the sale settles. Time: 10 minutes.`,
  (x) => `Hold whatever the launch distributes for at least two weeks instead of flipping it on day one; holder snapshots are a common second filter. Cost: nothing but patience. Time: 14 days.`,
  (x) => `Repeat across at least ${x.hold} days of launches and keep a log of each commitment and refund. Cost: gas per launch, about $${x.gas} each. Time: ${x.hold} days.`,
];
FARM_PLANS.prediction = [
  (x) => `Fund a fresh wallet on ${x.chain} with about $${x.capital} in USDC and the chain's gas token. Cost: roughly $${x.gas} in gas plus any bridge fee. Time: about 15 minutes.`,
  (x) => `Open ${x.name} and take a first position of about $25 in a liquid, long-dated market you can actually follow. Cost: the $25 position plus the market's spread. Time: 15 minutes.`,
  (x) => `Provide liquidity to one market's order book or pool if ${x.name} supports it, with about $${Math.round(x.capital / 2)} split across both sides. Cost: the posted liquidity until you withdraw it. Time: 15 minutes.`,
  (x) => `Trade at least twice a week in different markets so the wallet's history is broad, not a single bet. Cost: spreads and fees of roughly $1 a week. Time: 10 minutes a week.`,
  (x) => `Keep the account active for at least ${x.hold} days and let positions settle naturally; settled history is what most reward designs count. Cost: the $${x.capital} stays in play. Time: ${x.hold} days.`,
];
FARM_PLANS.privacy = [
  (x) => `Fund a fresh wallet on ${x.chain} with about $${x.capital} in the chain's main asset, keeping a separate wallet for private activity. Cost: roughly $${x.gas} in gas. Time: about 15 minutes.`,
  (x) => `Make a first shielded deposit of about $${Math.round(x.capital / 2)} into ${x.name} from the funded wallet and store the viewing or note key offline. Cost: about $${x.gas} in gas. Time: 15 minutes.`,
  (x) => `Make one private transfer between two of your own wallets each week to build genuine usage history. Cost: about $${x.gas} a week. Time: 10 minutes a week.`,
  (x) => `Unshield a small amount back to the public side once, so the wallet shows a full deposit-transfer-withdraw cycle. Cost: about $${x.gas}. Time: 10 minutes.`,
  (x) => `Keep funds shielded for at least ${x.hold} days in total; privacy pools reward balances that stay, not pass-through volume. Cost: the deposited amount stays shielded. Time: ${x.hold} days.`,
];
FARM_PLANS.payments = [
  (x) => `Create an account with ${x.name} from its official app and complete its identity checks with your own documents. Cost: no fee. Time: about 20 minutes.`,
  (x) => `Load about $${x.capital} onto the account or card from your bank, keeping the funding source in your own name. Cost: the provider's top-up fee, if any. Time: 10 minutes.`,
  (x) => `Route two ordinary payments a week (bills, transfers or card spending) through ${x.name} instead of your usual rail. Cost: your normal spending, no extra. Time: 5 minutes a week.`,
  (x) => `Hold a standing balance of at least $${Math.round(x.capital / 2)} on the account rather than sweeping it to zero after each payment. Cost: the balance stays available. Time: ongoing.`,
  (x) => `Keep the account active for at least ${x.hold} days and save the statements; payment apps reward months of ordinary use. Cost: nothing extra. Time: ${x.hold} days.`,
];
FARM_PLANS.insurance = [
  (x) => `Fund a fresh wallet on ${x.chain} with about $${x.capital + 20} in USDC and the chain's gas token. Cost: roughly $${x.gas} in gas plus any bridge fee. Time: about 15 minutes.`,
  (x) => `Underwrite about $${x.capital} into ${x.name}'s main cover pool on ${x.chain}, choosing the pool with the longest track record. Cost: about $${x.gas} in gas; the capital is locked for the pool's notice period. Time: 15 minutes.`,
  (x) => `Buy one small cover policy (about $25 of cover value) for a position you actually hold, so the wallet is both underwriter and customer. Cost: the policy premium. Time: 10 minutes.`,
  (x) => `Restake or renew the underwriting position when its term rolls instead of withdrawing at the first unlock. Cost: about $${x.gas} a roll. Time: 5 minutes a roll.`,
  (x) => `Stay underwritten for at least ${x.hold} days in total; insurance rewards are usually paid on time-at-risk. Cost: the $${x.capital} stays at risk. Time: ${x.hold} days.`,
];
FARM_PLANS.marketplace = [
  (x) => `Fund a fresh wallet on ${x.chain} with about $${x.capital} in the chain's main asset and a stablecoin. Cost: roughly $${x.gas} in gas plus any bridge fee. Time: about 15 minutes.`,
  (x) => `Make a first purchase of about $25 on ${x.name} in a collection or market with steady volume, and keep the asset. Cost: the $25 purchase plus marketplace fees. Time: 15 minutes.`,
  (x) => `List one of your own assets for sale at a fair price and leave the listing live for at least a week. Cost: listing gas, about $${x.gas}. Time: 10 minutes.`,
  (x) => `Trade once a week (a small buy or a sale) so the wallet's history spans several snapshots. Cost: fees of roughly $1-2 a week. Time: 10 minutes a week.`,
  (x) => `Stay active for at least ${x.hold} days and keep a log of every trade; marketplaces weight account age and settled trades. Cost: the $${x.capital} stays in play. Time: ${x.hold} days.`,
];
FARM_PLANS.ai = [
  (x) => `Create an account or wallet for ${x.name} from its official page and fund it with about $${x.capital} in the asset it charges in. Cost: roughly $${x.gas} in gas or the first top-up fee. Time: about 15 minutes.`,
  (x) => `Use ${x.name}'s core feature for a real task of yours (a run, a query or a job) rather than idle clicking, at least twice a week. Cost: usage fees of roughly $2-5 a week. Time: 20 minutes a week.`,
  (x) => `If ${x.name} rewards operators or stakers, stake about $${Math.round(x.capital / 2)} in its staking contract and leave it untouched. Cost: about $${x.gas} in gas. Time: 10 minutes.`,
  (x) => `Connect the same wallet to any companion app ${x.name} lists, so your usage is visible in more than one place. Cost: gas only, about $${x.gas}. Time: 10 minutes.`,
  (x) => `Keep the routine going for at least ${x.hold} days; usage-based rewards count sustained weeks, not a single burst. Cost: the weekly usage fees. Time: ${x.hold} days.`,
];
FARM_PLANS.generic = [
  (x) => `Fund a fresh wallet on ${x.chain} with about $${x.capital + 20} in USDC and the chain's gas token, keeping its seed phrase offline. Cost: roughly $${x.gas} in gas plus any bridge fee. Time: about 15 minutes.`,
  (x) => `Deposit $${x.capital} into ${x.name}'s main product on ${x.chain} and keep the position open after the first session. Cost: about $${x.gas} in gas. Time: 10 minutes.`,
  (x) => `Make one more qualifying action each week inside ${x.name} (a deposit top-up, a claim, a vote or a swap) so the wallet stays active. Cost: about $${x.gas} a week. Time: 10 minutes a week.`,
  (x) => `Open ${x.name}'s own points or rewards page weekly and follow only the tasks it lists there, never third-party links. Cost: nothing to check. Time: 5 minutes a week.`,
  (x) => `Hold the position for at least ${x.hold} days and keep a farm log of the wallet, dates and transactions. Cost: the $${x.capital} stays deployed. Time: ${x.hold} days.`,
];

/** One protocol's farm plan: five concrete steps drawn from its category, chains, TVL and age. */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'Ethereum';
  const chain2 = p.chains.length > 1 ? p.chains[1]! : chain;
  const ctx: FarmContext = {
    name: p.name,
    chain,
    chain2,
    capital: capitalFor(p.tvl_usd),
    hold: holdDaysFor(age),
    gas: CHAIN_GAS[chain] ?? 1,
  };
  const plan = FARM_PLANS[farmFamily(p.category)] ?? FARM_PLANS.generic!;
  return plan.map((step) => step(ctx));
}

/** One row of board.json: the ranked claim, its model breakdown and its farm plan. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  token_status: 'pre-token';
  implied_value_usd: number;
  model: {
    category_multiple: number;
    multiple_basis: 'category median' | 'global fallback';
    category_peers: number;
    growth_pct: number;
    growth_factor: number;
    age_factor: number;
  };
  farm_steps: string[];
}

/** The dashboard's view of one board row: everything the page renders for it. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  multiple: number;
  multiple_basis: 'category median' | 'global fallback';
  category_peers: number;
  growth_factor: number;
  age_factor: number;
  farm_steps: string[];
}

/** An already-trading protocol: the market's own value, kept apart from the ranked board. */
export interface LiveRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  mcap_tvl: number;
}

/** Everything the dashboard renders: the board, the live set, and the model behind them. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: ModelConstants;
  global_peers: number;
  global_multiple: number;
  multiples: CategoryMultiple[];
  watchlist_size: number;
  board_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/**
 * The ranked board: every watchlist slug, plus every pre-token protocol that is not a
 * wrapped, staked, bridged or versioned product of another, strongest implied value first.
 */
export function buildBoard(snapshot: Snapshot, peers: PeerMultiples, model: ModelConstants = MODEL): BoardRow[] {
  const watchlist = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter((p) => watchlist.has(p.slug) || (isPreToken(p) && !isProductOfAnother(p)));
  const scored = chosen.map((p) => ({ p, score: scoreProtocol(p, snapshot.as_of, peers, model) }));
  scored.sort((a, b) => b.score.implied - a.score.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.score.age_days,
    on_watchlist: watchlist.has(s.p.slug),
    token_status: 'pre-token' as const,
    implied_value_usd: s.score.implied,
    model: {
      category_multiple: s.score.multiple,
      multiple_basis: s.score.multiple_basis,
      category_peers: s.score.category_peers,
      growth_pct: s.score.growth_pct,
      growth_factor: s.score.growth_factor,
      age_factor: s.score.age_factor,
    },
    farm_steps: farmSteps(s.p, s.score.age_days),
  }));
}

/** The already-trading comparison set, by market cap: the peers the multiples come from. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.category !== 'CEX')
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
      mcap_tvl: p.tvl_usd > 0 ? round4(p.mcap_usd! / p.tvl_usd) : 0,
    }));
}

/** The board, the live set and the measured multiples, as one radar dataset. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const peers = peerMultiples(snapshot, model);
  const board = buildBoard(snapshot, peers, model);
  const live = liveRows(snapshot);
  const multiples = [...peers.by_category.values()].sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model,
    global_peers: peers.global_peers,
    global_multiple: peers.global_multiple,
    multiples,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    live_size: live.length,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      on_watchlist: r.on_watchlist,
      implied_value_usd: r.implied_value_usd,
      multiple: r.model.category_multiple,
      multiple_basis: r.model.multiple_basis,
      category_peers: r.model.category_peers,
      growth_factor: r.model.growth_factor,
      age_factor: r.model.age_factor,
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** Why a board is not one the gate will take, or null: the gate's own rules, checked early. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const snapshotSlugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const r of board) {
    if (!snapshotSlugs.has(r.slug)) return `${r.slug} is not a protocol in the snapshot`;
    if (seen.has(r.slug)) return `${r.slug} appears twice`;
    seen.add(r.slug);
    if (typeof r.name !== 'string' || r.name.length === 0) return `${r.slug} has no name`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} trimmed characters`;
    }
  }
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `rank ${i + 1} outranks rank ${i} on implied value`;
  }
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) {
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
