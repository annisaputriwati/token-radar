// Launch Signal: a token-launch radar model over one sealed DefiLlama snapshot.
//
// The question the board answers: if a protocol that still records no token launched one
// today, what would that token plausibly be worth, and how likely is a launch at all?
// Version 2 of the model fits its prices to the snapshot's own traded protocols and tests
// every term out of sample before it is allowed to price a row:
//
//   fitted value   = exp(a + b x log TVL + category offset), fitted by least squares on
//                    the snapshot's traded peers (the protocols that carry a market cap).
//                    The offset is a category's median residual, shrunk toward zero by
//                    n / (n + 4), and is only fitted for categories with at least 4 peers.
//   launch odds    = the snapshot's own base rate: among all its protocols, the share
//                    that already carry a token in this protocol's tokenless-age band,
//                    averaged with the share in its TVL band (Laplace-smoothed).
//   implied value  = fitted value x launch odds: an expected value, stated whole dollars.
//
// Candidate terms (a seven-day-growth term, a tokenless-age term inside the value fit)
// were fitted and put through the same held-out validation as the rest; neither lowered
// the held-out error, so neither prices a row. Age still prices the odds, and growth is
// printed on every row. The validation table is computed at runtime from the snapshot,
// with a seeded shuffle, so the numbers the dashboard prints are the numbers this code
// measured. No protocol name is ever special-cased; the same functions score all rows.
//
// The board ranks every pre-token protocol that is not itself a wrapped, staked, bridged
// or versioned product of another protocol. The snapshot's watchlist is the floor: all of
// its slugs are always on the board. Protocols whose token already trades are never
// ranked; they are reported apart as the live comparison set the fit is measured on.

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

/** The fit's stated method choices: how much evidence a category needs, and how the validation runs. */
export interface FitConfig {
  /** A category's offset is fitted only when at least this many traded peers carry it. */
  min_category_peers: number;
  /** A category offset is its median residual scaled by n / (n + offset_shrinkage). */
  offset_shrinkage: number;
  /** The held-out validation: this many seeded shuffles, each scored on the held-out share. */
  validation_repeats: number;
  validation_train_share: number;
  validation_seed: number;
}

export const FIT: FitConfig = {
  min_category_peers: 4,
  offset_shrinkage: 4,
  validation_repeats: 5,
  validation_train_share: 0.8,
  validation_seed: 20261123,
};

/**
 * The farm accounting's stated assumptions: not fitted, printed on the dashboard as the
 * radar's own bookkeeping. A launch is assumed to allocate drop_share of its value to the
 * community, spread over qualifying_wallets wallets; a plan earns a FARM verdict when a
 * wallet's expected share covers its cost farm_multiple times over.
 */
export interface FarmAccounting {
  drop_share: number;
  qualifying_wallets: number;
  farm_multiple: number;
  /** Swap and borrow fees over a plan's life, as a share of the capital it deploys. */
  fee_rate: number;
}

export const FARM_ACCOUNTING: FarmAccounting = {
  drop_share: 0.05,
  qualifying_wallets: 20000,
  farm_multiple: 3,
  fee_rate: 0.005,
};

/** The model's version label, printed by the dashboard and quoted in the dossier. */
export const MODEL_VERSION = 'launch-signal-2';

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

/** The bucket a protocol is fitted under when it has no named category. */
const NO_CATEGORY = 'Uncategorized';

const clampN = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** mulberry32: a tiny seeded PRNG, so the validation's shuffles are the same on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ordinary least squares through the normal equations, solved by Gauss-Jordan elimination. */
function ols(xs: number[][], ys: number[]): number[] {
  const k = xs[0]!.length;
  const a = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < k; j++) {
      b[j]! += xs[i]![j]! * ys[i]!;
      for (let l = 0; l < k; l++) a[j]![l]! += xs[i]![j]! * xs[i]![l]!;
    }
  }
  for (let j = 0; j < k; j++) a[j]![j]! += 1e-9;
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[piv]![c]!)) piv = r;
    const ta = a[c]!; a[c] = a[piv]!; a[piv] = ta;
    const tb = b[c]!; b[c] = b[piv]!; b[piv] = tb;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = a[r]![c]! / a[c]![c]!;
      for (let l = c; l < k; l++) a[r]![l]! -= f * a[c]![l]!;
      b[r]! -= f * b[c]!;
    }
  }
  return a.map((row, j) => b[j]! / row[j]!);
}

const dot = (xs: number[], beta: number[]): number => xs.reduce((acc, x, i) => acc + x * beta[i]!, 0);

/** One traded peer as the fit sees it: the snapshot's figures, in the fit's units. */
export interface PeerRow {
  protocol: SnapshotProtocol;
  lt: number;
  /** The 7d TVL change, clamped to [-50, +100] and scaled to units of 100%. */
  g: number;
  /** log(1 + age in days); an undated peer is imputed at the dated peers' median, for the fit only. */
  la: number;
  age: number | null;
  cat: string;
  /** log market cap: what the fit predicts. */
  y: number;
}

/** The traded peers of a snapshot, as fit rows: the protocols that carry a market cap and a TVL. */
export function peerRows(snapshot: Snapshot): PeerRow[] {
  const datedAges: number[] = [];
  for (const p of snapshot.protocols) {
    if (!isTradedPeer(p)) continue;
    const age = ageDays(snapshot.as_of, p.listed_at);
    if (age !== null) datedAges.push(Math.log(1 + age));
  }
  datedAges.sort((x, y) => x - y);
  const medLogAge = datedAges.length > 0 ? median(datedAges) : 0;
  const rows: PeerRow[] = [];
  for (const p of snapshot.protocols) {
    if (!isTradedPeer(p)) continue;
    const age = ageDays(snapshot.as_of, p.listed_at);
    rows.push({
      protocol: p,
      lt: Math.log(p.tvl_usd),
      g: clampN(p.change_7d ?? 0, -50, 100) / 100,
      la: age === null ? medLogAge : Math.log(1 + age),
      age,
      cat: p.category ?? NO_CATEGORY,
      y: Math.log(p.mcap_usd!),
    });
  }
  return rows;
}

/** A traded protocol: one whose record carries a market cap for its token. */
function isTradedPeer(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0;
}

/** A candidate's shape: which regressors it carries, and whether categories earn offsets. */
export interface CandidateSpec {
  id: string;
  label: string;
  growth: boolean;
  age: boolean;
  offsets: boolean;
}

/** The candidates the validation scores: the v1 model, then the fitted family, term by term. */
export const CANDIDATES: CandidateSpec[] = [
  { id: 'flat', label: 'v1: flat category-median multiples', growth: true, age: true, offsets: false },
  { id: 'loglog', label: 'log-log fit on TVL', growth: false, age: false, offsets: false },
  { id: 'fitted', label: 'log-log + category offsets', growth: false, age: false, offsets: true },
  { id: 'fitted+growth', label: 'log-log + offsets + growth term', growth: true, age: false, offsets: true },
  { id: 'fitted+growth+age', label: 'log-log + offsets + growth + age terms', growth: true, age: true, offsets: true },
];

/** One row of a candidate's design matrix: an intercept, log TVL, then the terms it carries. */
function designRow(spec: CandidateSpec, r: PeerRow): number[] {
  const v = [1, r.lt];
  if (spec.growth) v.push(r.g);
  if (spec.age) v.push(r.la);
  return v;
}

/** A fitted candidate: its coefficients, and the category offsets its residuals earned. */
export interface FittedForm {
  spec: CandidateSpec;
  beta: number[];
  offsets: Map<string, { offset: number; peers: number }>;
}

/** Fit one candidate on training rows: least squares first, then shrunk median-residual offsets. */
export function fitForm(spec: CandidateSpec, rows: PeerRow[], fit: FitConfig = FIT): FittedForm {
  const beta = ols(rows.map((r) => designRow(spec, r)), rows.map((r) => r.y));
  const offsets = new Map<string, { offset: number; peers: number }>();
  if (spec.offsets) {
    const resid = new Map<string, number[]>();
    for (const r of rows) {
      const list = resid.get(r.cat);
      const e = r.y - dot(designRow(spec, r), beta);
      if (list === undefined) resid.set(r.cat, [e]);
      else list.push(e);
    }
    for (const [cat, es] of resid) {
      if (es.length < fit.min_category_peers) continue;
      es.sort((x, y) => x - y);
      offsets.set(cat, { offset: round4(median(es) * (es.length / (es.length + fit.offset_shrinkage))), peers: es.length });
    }
  }
  return { spec, beta, offsets };
}

/** A fitted candidate's prediction of one row's log market cap. */
export function predictForm(form: FittedForm, r: PeerRow): number {
  return dot(designRow(form.spec, r), form.beta) + (form.offsets.get(r.cat)?.offset ?? 0);
}

/**
 * The v1 model, frozen as the validation's baseline: per-category median multiples with a
 * global fallback, the stated growth factor and the stated age factor, fitted on the
 * training rows it is given, exactly as version 1 fitted them on the whole snapshot.
 */
function fitFlat(train: PeerRow[]): (r: PeerRow) => number {
  const ratiosByCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const r of train) {
    const ratio = Math.exp(r.y - r.lt);
    all.push(ratio);
    const list = ratiosByCategory.get(r.cat);
    if (list === undefined) ratiosByCategory.set(r.cat, [ratio]);
    else list.push(ratio);
  }
  all.sort((x, y) => x - y);
  const clampM = (m: number): number => clampN(m, 0.01, 3);
  const globalMultiple = clampM(median(all));
  const byCategory = new Map<string, number>();
  for (const [cat, ratios] of ratiosByCategory) {
    ratios.sort((x, y) => x - y);
    byCategory.set(cat, ratios.length >= 3 ? clampM(median(ratios)) : globalMultiple);
  }
  return (r) => {
    const m = byCategory.get(r.cat) ?? globalMultiple;
    const growthFactor = 1 + (clampN(r.g * 100, -50, 100) / 100) * 0.5;
    const ageFactor = r.age === null ? 1 : 0.7 + 0.6 * (Math.log(1 + r.age) / Math.log(1 + 1825));
    return r.lt + Math.log(m * growthFactor * ageFactor);
  };
}

/** One candidate's held-out score: the mean over repeats of the held-out median |log error|. */
export interface CandidateScore {
  id: string;
  label: string;
  median_log_error: number;
}

/** The validation's outcome: every candidate's held-out error, and the fitted family's winner. */
export interface Validation {
  repeats: number;
  train_share: number;
  peers: number;
  candidates: CandidateScore[];
  /** The winning fitted candidate's id: the one the board's model is fitted as. */
  winner: string;
  flat_error: number;
  winner_error: number;
}

/**
 * The held-out validation, run on the snapshot's traded peers: seeded shuffles split the
 * peers into a training share and a held-out share; every candidate is fitted on the
 * training rows alone and scored on the held-out rows by median absolute log error. The
 * winner is the fitted-family candidate with the lowest mean held-out error.
 */
export function validateModels(rows: PeerRow[], fit: FitConfig = FIT): { validation: Validation; winnerSpec: CandidateSpec } {
  const rand = mulberry32(fit.validation_seed);
  const perCandidate = new Map<string, number[]>();
  for (const spec of CANDIDATES) perCandidate.set(spec.id, []);
  for (let rep = 0; rep < fit.validation_repeats; rep++) {
    const idx = rows.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = idx[i]!; idx[i] = idx[j]!; idx[j] = t;
    }
    const cut = Math.floor(idx.length * fit.validation_train_share);
    const train = idx.slice(0, cut).map((i) => rows[i]!);
    const test = idx.slice(cut).map((i) => rows[i]!);
    for (const spec of CANDIDATES) {
      const predict = spec.id === 'flat' ? fitFlat(train) : (() => { const f = fitForm(spec, train, fit); return (r: PeerRow) => predictForm(f, r); })();
      const errs = test.map((r) => Math.abs(predict(r) - r.y)).sort((x, y) => x - y);
      perCandidate.get(spec.id)!.push(median(errs));
    }
  }
  const candidates = CANDIDATES.map((spec) => {
    const meds = perCandidate.get(spec.id)!;
    return { id: spec.id, label: spec.label, median_log_error: round4(meds.reduce((a, b) => a + b, 0) / meds.length) };
  });
  let winnerSpec = CANDIDATES[2]!;
  let winnerError = Infinity;
  for (const spec of CANDIDATES) {
    if (spec.id === 'flat') continue;
    const err = candidates.find((c) => c.id === spec.id)!.median_log_error;
    if (err < winnerError) { winnerError = err; winnerSpec = spec; }
  }
  const validation: Validation = {
    repeats: fit.validation_repeats,
    train_share: fit.validation_train_share,
    peers: rows.length,
    candidates,
    winner: winnerSpec.id,
    flat_error: candidates.find((c) => c.id === 'flat')!.median_log_error,
    winner_error: winnerError,
  };
  return { validation, winnerSpec };
}

/** One category's fitted offset, or its absence: the global fit prices the category alone. */
export interface CategoryOffset {
  category: string;
  peers: number;
  offset: number;
  basis: 'category offset' | 'global fit';
}

/** The board's value model: the winning candidate, fitted on every traded peer. */
export interface ValueModel {
  form: FittedForm;
  validation: Validation;
  peers: number;
  intercept: number;
  slope: number;
  growth_coef: number | null;
  age_coef: number | null;
  /** The dated peers' median log age: what an undated protocol is scored at, if the age term is in. */
  median_log_age: number;
  /** Every category the peers carry, with its fitted offset (0 when none was earned). */
  categories: CategoryOffset[];
}

/** Validate the candidates on the snapshot's peers, then fit the winner on all of them. */
export function fitValueModel(snapshot: Snapshot, fit: FitConfig = FIT): { model: ValueModel; rows: PeerRow[] } {
  const rows = peerRows(snapshot);
  const { validation, winnerSpec } = validateModels(rows, fit);
  const form = fitForm(winnerSpec, rows, fit);
  const byCategory = new Map<string, CategoryOffset>();
  for (const r of rows) {
    const found = form.offsets.get(r.cat);
    const peersInCat = rows.filter((x) => x.cat === r.cat).length;
    if (!byCategory.has(r.cat)) {
      byCategory.set(r.cat, {
        category: r.cat,
        peers: peersInCat,
        offset: found?.offset ?? 0,
        basis: found !== undefined ? 'category offset' : 'global fit',
      });
    }
  }
  const categories = [...byCategory.values()].sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  let gi = 2;
  const growthCoef = winnerSpec.growth ? form.beta[gi++]! : null;
  const ageCoef = winnerSpec.age ? form.beta[gi++]! : null;
  const datedLa = rows.filter((r) => r.age !== null).map((r) => r.la).sort((x, y) => x - y);
  const model: ValueModel = {
    form,
    validation,
    peers: rows.length,
    intercept: round4(form.beta[0]!),
    slope: round4(form.beta[1]!),
    growth_coef: growthCoef === null ? null : round4(growthCoef),
    age_coef: ageCoef === null ? null : round4(ageCoef),
    median_log_age: datedLa.length > 0 ? round4(median(datedLa)) : 0,
    categories,
  };
  return { model, rows };
}

/** One band of the launch-odds base rate: how many protocols sit in it, and how many carry a token. */
export interface OddsBand {
  label: string;
  n: number;
  with_token: number;
  /** The Laplace-smoothed share that carry a token: (with_token + 1) / (n + 2). */
  share: number;
}

/** The launch odds: the snapshot's own base rates, by tokenless-age band and by TVL band. */
export interface LaunchOdds {
  global_share: number;
  age_bands: OddsBand[];
  tvl_bands: OddsBand[];
}

const AGE_BANDS: Array<[number, number, string]> = [
  [0, 180, 'under 6 months'],
  [180, 365, '6-12 months'],
  [365, 730, '1-2 years'],
  [730, 1095, '2-3 years'],
  [1095, Number.POSITIVE_INFINITY, '3 years or more'],
];

const TVL_BANDS: Array<[number, number, string]> = [
  [0, 25_000_000, 'under $25M'],
  [25_000_000, 50_000_000, '$25M-$50M'],
  [50_000_000, 250_000_000, '$50M-$250M'],
  [250_000_000, 1_000_000_000, '$250M-$1B'],
  [1_000_000_000, Number.POSITIVE_INFINITY, '$1B and up'],
];

/** Measure the base rates from every protocol in the snapshot, traded and pre-token alike. */
export function launchOdds(snapshot: Snapshot): LaunchOdds {
  const band = (defs: Array<[number, number, string]>, value: (p: SnapshotProtocol) => number | null): OddsBand[] =>
    defs.map(([lo, hi, label]) => {
      let n = 0;
      let withToken = 0;
      for (const p of snapshot.protocols) {
        const v = value(p);
        if (v === null || v < lo || v >= hi) continue;
        n++;
        if (!isPreToken(p)) withToken++;
      }
      return { label, n, with_token: withToken, share: round4((withToken + 1) / (n + 2)) };
    });
  const withToken = snapshot.protocols.filter((p) => !isPreToken(p)).length;
  return {
    global_share: round4((withToken + 1) / (snapshot.protocols.length + 2)),
    age_bands: band(AGE_BANDS, (p) => ageDays(snapshot.as_of, p.listed_at)),
    tvl_bands: band(TVL_BANDS, (p) => p.tvl_usd),
  };
}

/** One protocol's launch odds: its age band's base rate averaged with its TVL band's. */
export function oddsFor(p: SnapshotProtocol, asOf: string, odds: LaunchOdds): { odds: number; age_share: number; tvl_share: number } {
  const age = ageDays(asOf, p.listed_at);
  const ageShare = age === null ? odds.global_share : odds.age_bands.find((b, i) => age >= AGE_BANDS[i]![0] && age < AGE_BANDS[i]![1])!.share;
  const tvlShare = odds.tvl_bands.find((b, i) => p.tvl_usd >= TVL_BANDS[i]![0] && p.tvl_usd < TVL_BANDS[i]![1])!.share;
  return { odds: round4((ageShare + tvlShare) / 2), age_share: ageShare, tvl_share: tvlShare };
}

/** The parts of one protocol's score, exactly as the dashboard's detail view shows them. */
export interface ScoreParts {
  /** What the fitted model says a launch would be worth, before the odds are applied. */
  fitted_value: number;
  /** The fitted value per TVL dollar: the multiple the fit implies at this protocol's size. */
  effective_multiple: number;
  multiple_basis: 'fitted category offset' | 'fitted global fit';
  category_peers: number;
  growth_pct: number;
  /** The winning fit's growth factor for this row: 1 when the growth term earned no place. */
  growth_factor: number;
  odds: number;
  odds_age_share: number;
  odds_tvl_share: number;
  age_days: number | null;
  implied: number;
}

/** One protocol's implied launch value and every factor that produced it. */
export function scoreProtocol(p: SnapshotProtocol, asOf: string, model: ValueModel, odds: LaunchOdds): ScoreParts {
  const age = ageDays(asOf, p.listed_at);
  const row: PeerRow = {
    protocol: p,
    lt: Math.log(Math.max(1, p.tvl_usd)),
    g: clampN(p.change_7d ?? 0, -50, 100) / 100,
    la: age === null ? model.median_log_age : Math.log(1 + age),
    age,
    cat: p.category ?? NO_CATEGORY,
    y: 0,
  };
  const fitted = Math.exp(predictForm(model.form, row));
  const cat = model.categories.find((c) => c.category === row.cat);
  const o = oddsFor(p, asOf, odds);
  const growthFactor = model.growth_coef === null ? 1 : round4(Math.exp(model.growth_coef * row.g));
  const implied = Math.max(1, Math.round(fitted * o.odds));
  return {
    fitted_value: fitted,
    effective_multiple: round4(fitted / Math.max(1, p.tvl_usd)),
    multiple_basis: cat?.basis === 'category offset' ? 'fitted category offset' : 'fitted global fit',
    category_peers: cat?.peers ?? 0,
    growth_pct: clampN(p.change_7d ?? 0, -50, 100),
    growth_factor: growthFactor,
    odds: o.odds,
    odds_age_share: o.age_share,
    odds_tvl_share: o.tvl_share,
    age_days: age,
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

/** One plan's farm economics: what it costs a wallet, in dollars and in time, and what it nets. */
export interface FarmEconomics {
  /** The plan's hold, in whole weeks. */
  weeks: number;
  /** Gas for the weekly touches plus entry and exit, and the fee drag on the capital. */
  cost_usd: number;
  /** The farmer's own hours across the plan's life. */
  hours: number;
  /** The expected launch share per wallet, under the radar's stated accounting. */
  expected_usd: number;
  expected_minus_cost: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
}

/**
 * The netting arithmetic behind one plan's verdict: the plan's gas per touch times its
 * weekly touches, entry and exit, plus a fee drag on its capital, set against the launch
 * share a qualifying wallet could expect — the accounting assumptions times the row's
 * implied value, spread over the assumed qualifying wallets.
 */
export function farmEconomics(p: SnapshotProtocol, age: number | null, implied: number, acc: FarmAccounting = FARM_ACCOUNTING): FarmEconomics {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'Ethereum';
  const gas = CHAIN_GAS[chain] ?? 1;
  const hold = holdDaysFor(age);
  const weeks = Math.max(1, Math.ceil(hold / 7));
  const cost = Math.round(gas * (weeks + 3) + capitalFor(p.tvl_usd) * acc.fee_rate);
  const hours = round4(0.5 + 0.25 * weeks);
  const expected = Math.round((implied * acc.drop_share) / acc.qualifying_wallets);
  const verdict: FarmEconomics['verdict'] = expected >= acc.farm_multiple * cost ? 'FARM' : expected > cost ? 'THIN' : 'SKIP';
  return { weeks, cost_usd: cost, hours, expected_usd: expected, expected_minus_cost: expected - cost, verdict };
}

/** The verdict as a farm step: the netting, printed inside the board's own plan. */
function verdictStep(e: FarmEconomics, acc: FarmAccounting = FARM_ACCOUNTING): string {
  const pct = Math.round(acc.drop_share * 100);
  const wallets = acc.qualifying_wallets.toLocaleString('en-US');
  return (
    `Verdict ${e.verdict}: the plan costs about $${e.cost_usd.toLocaleString('en-US')} all-in over ${e.weeks} weeks ` +
    `(${e.hours} hours of your time); a launch allocating ${pct}% of its implied value across ${wallets} qualifying wallets ` +
    `pays about $${e.expected_usd.toLocaleString('en-US')} per wallet, a net of ${e.expected_minus_cost >= 0 ? '+' : '-'}$${Math.abs(e.expected_minus_cost).toLocaleString('en-US')}.`
  );
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
    /** The fitted value per TVL dollar: the multiple the fit implies at this protocol's size. */
    category_multiple: number;
    multiple_basis: 'fitted category offset' | 'fitted global fit';
    category_peers: number;
    growth_pct: number;
    /** The winning fit's growth factor for this row: 1 when the growth term earned no place. */
    growth_factor: number;
    /** The launch-odds multiplier: the share of the fitted value the row is priced at. */
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
  fitted_value_usd: number;
  multiple: number;
  multiple_basis: 'fitted category offset' | 'fitted global fit';
  category_peers: number;
  growth_factor: number;
  odds: number;
  odds_age_share: number;
  odds_tvl_share: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  cost_usd: number;
  weeks: number;
  hours: number;
  expected_usd: number;
  net_usd: number;
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

/** One category on the model page: its fitted offset, and the multiple it implies at the reference size. */
export interface CategoryFit {
  category: string;
  peers: number;
  offset: number;
  basis: 'category offset' | 'global fit';
  /** The multiple the fit implies at $100M TVL: exp(intercept + offset) x $100M^(slope-1). */
  multiple_at_ref: number;
}

/** The census: every protocol in the snapshot, counted once, by where the radar puts it. */
export interface Census {
  total: number;
  ranked: number;
  already_trading: number;
  excluded_product_category: number;
  excluded_versioned: number;
  excluded_wrapped: number;
  excluded_exchange_prefix: number;
  /** Watchlist rows ranked even though a product rule flags them. */
  watchlist_ranked_despite_product: number;
}

/** Everything the dashboard renders: the board, the live set, the fit and the census. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  fit: {
    peers: number;
    intercept: number;
    slope: number;
    growth_coef: number | null;
    age_coef: number | null;
    winner: string;
    validation_repeats: number;
    validation_train_share: number;
    flat_error: number;
    winner_error: number;
  };
  validation: CandidateScore[];
  odds: LaunchOdds;
  farm_accounting: FarmAccounting;
  census: Census;
  categories: CategoryFit[];
  watchlist_size: number;
  board_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Which product rule flags a protocol, in the census's priority order; null when none does. */
function productReason(p: SnapshotProtocol): 'category' | 'versioned' | 'wrapped' | 'exchange' | null {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return 'category';
  if (VERSIONED.test(p.name)) return 'versioned';
  if (WRAPPED_WORDS.test(p.name)) return 'wrapped';
  if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(`${x} `))) return 'exchange';
  return null;
}

/**
 * The ranked board and the census that accounts for the whole snapshot: every watchlist
 * slug, plus every pre-token protocol that is not a wrapped, staked, bridged or versioned
 * product of another, strongest implied value first. Each plan carries its verdict step.
 */
export function buildBoard(snapshot: Snapshot, model: ValueModel, odds: LaunchOdds, acc: FarmAccounting = FARM_ACCOUNTING): { board: BoardRow[]; census: Census } {
  const watchlist = new Set(snapshot.watchlist);
  const chosen: SnapshotProtocol[] = [];
  const census: Census = {
    total: snapshot.protocols.length,
    ranked: 0,
    already_trading: 0,
    excluded_product_category: 0,
    excluded_versioned: 0,
    excluded_wrapped: 0,
    excluded_exchange_prefix: 0,
    watchlist_ranked_despite_product: 0,
  };
  for (const p of snapshot.protocols) {
    if (!isPreToken(p)) {
      census.already_trading++;
      continue;
    }
    const reason = productReason(p);
    if (watchlist.has(p.slug)) {
      chosen.push(p);
      if (reason !== null) census.watchlist_ranked_despite_product++;
      continue;
    }
    if (reason === null) {
      chosen.push(p);
      continue;
    }
    if (reason === 'category') census.excluded_product_category++;
    else if (reason === 'versioned') census.excluded_versioned++;
    else if (reason === 'wrapped') census.excluded_wrapped++;
    else census.excluded_exchange_prefix++;
  }
  const scored = chosen.map((p) => ({ p, score: scoreProtocol(p, snapshot.as_of, model, odds) }));
  scored.sort((a, b) => b.score.implied - a.score.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board = scored.map((s, i) => {
    const econ = farmEconomics(s.p, s.score.age_days, s.score.implied, acc);
    return {
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
        category_multiple: s.score.effective_multiple,
        multiple_basis: s.score.multiple_basis,
        category_peers: s.score.category_peers,
        growth_pct: s.score.growth_pct,
        growth_factor: s.score.growth_factor,
        age_factor: s.score.odds,
      },
      farm_steps: [...farmSteps(s.p, s.score.age_days), verdictStep(econ, acc)],
    };
  });
  census.ranked = board.length;
  return { board, census };
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

/** The board, the live set, the fitted model and the census, as one radar dataset. */
export function buildRadar(snapshot: Snapshot, fit: FitConfig = FIT, acc: FarmAccounting = FARM_ACCOUNTING): { board: BoardRow[]; radar: RadarData } {
  const { model } = fitValueModel(snapshot, fit);
  const odds = launchOdds(snapshot);
  const { board, census } = buildBoard(snapshot, model, odds, acc);
  const live = liveRows(snapshot);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const refTvl = 100_000_000;
  const categories: CategoryFit[] = model.categories.map((c) => ({
    category: c.category,
    peers: c.peers,
    offset: c.offset,
    basis: c.basis,
    multiple_at_ref: round4(Math.exp(model.intercept + c.offset) * refTvl ** (model.slope - 1)),
  }));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    fit: {
      peers: model.peers,
      intercept: model.intercept,
      slope: model.slope,
      growth_coef: model.growth_coef,
      age_coef: model.age_coef,
      winner: model.validation.winner,
      validation_repeats: model.validation.repeats,
      validation_train_share: model.validation.train_share,
      flat_error: model.validation.flat_error,
      winner_error: model.validation.winner_error,
    },
    validation: model.validation.candidates,
    odds,
    farm_accounting: acc,
    census,
    categories,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    live_size: live.length,
    rows: board.map((r) => {
      const p = bySlug.get(r.slug)!;
      const score = scoreProtocol(p, snapshot.as_of, model, odds);
      const econ = farmEconomics(p, r.age_days, r.implied_value_usd, acc);
      return {
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
        fitted_value_usd: Math.round(score.fitted_value),
        multiple: r.model.category_multiple,
        multiple_basis: r.model.multiple_basis,
        category_peers: r.model.category_peers,
        growth_factor: r.model.growth_factor,
        odds: score.odds,
        odds_age_share: score.odds_age_share,
        odds_tvl_share: score.odds_tvl_share,
        verdict: econ.verdict,
        cost_usd: econ.cost_usd,
        weeks: econ.weeks,
        hours: econ.hours,
        expected_usd: econ.expected_usd,
        net_usd: econ.expected_minus_cost,
        farm_steps: r.farm_steps,
      };
    }),
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
