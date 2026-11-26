const https = require('https');

// ─── SOLANA / JUPITER (real trading) ──────────────────────────────────────────
let SolanaWeb3, bs58;
try {
  SolanaWeb3 = require('@solana/web3.js');
  bs58 = require('bs58');
} catch(e) {
  console.warn('[BOT] @solana/web3.js or bs58 not installed — real trading disabled:', e.message);
}

// Wrap firebase-admin requires so a missing module doesn't crash before main()
let initializeApp, cert, getFirestore, FieldValue;
let _requireError = null;
try {
  ({ initializeApp, cert } = require('firebase-admin/app'));
  ({ getFirestore, FieldValue } = require('firebase-admin/firestore'));
} catch(e) {
  _requireError = e.message;
  console.error('[BOT] firebase-admin require failed:', _requireError);
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
// Try both naming conventions (old code used TELEGRAM_TOKEN, new uses TELEGRAM_BOT_TOKEN)
// .trim() removes accidental whitespace/newlines from copy-pasted Fly.io secrets
const TELEGRAM_TOKEN  = (process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN  || '').trim();
const TELEGRAM_CHAT   = (process.env.TELEGRAM_CHAT_ID   || process.env.TELEGRAM_CHAT   || '').trim();
const POSITION_SIZE   = parseFloat(process.env.POSITION_SIZE || '100');
const MAX_POSITIONS   = 20;
const SURGE_RESERVED  = 0;   // Nov-11: removed slot reservation — all strategies compete freely for all 20 global slots
const MIN_SCORE       = 45;  // Nov-11: lowered from 55; GeckoTerminal trending pre-filters the pool so a 55 bar was double-filtering

// ── STRATEGY FILTER SWITCH ────────────────────────────────────────────────────
// true  = all per-strategy filters active (normal operation — Oct-27 baseline)
// false = filters suspended (use only during debugging when strategies don't appear)
// Use /skipstrats command at runtime to toggle — do not change this line manually
let strategyFiltersActive = true;
const DAILY_LOSS_LIMIT= -0.30;

// ── GRADUATION GRACE ──────────────────────────────────────────────────────────
// PumpSwap coins may migrate to Raydium after entry (secondary graduation), causing
// a temporary liq collapse that is NOT a rug. These Maps track the grace state.
const graduationGrace = new Map(); // pos.id → grace-expires timestamp (ms)
const posLastLiq      = new Map(); // pos.id → liquidity seen on the previous monitor tick

// ─── DIAGNOSTIC MODE ──────────────────────────────────────────────────────────
// When on: bypasses all filters (except DIAG_MIN_LIQ), raises slot cap to 100,
// uses 50%-from-ATH SL trail (Phase 2 jumps to 60% gap at +30% ATH gain), and
// logs every closed trade to Firestore 'diagnostic_trades'. Auto-disables +
// sends full analysis report after DIAGNOSTIC_TARGET trades.
let diagnosticMode       = false;
let diagnosticReal       = false;  // Nov-23: true = diagnostic mode uses real funds
let diagnosticTradeCount = 0;
const DIAGNOSTIC_TARGET  = 1000;
const DIAG_MIN_LIQ       = 8000;
const DIAG_MAX_POSITIONS = 100;

// ─── SESSION FILTERS ─────────────────────────────────────────────────────────
// User-set restrictions on what coins the bot auto-enters this session.
// All fields null = no restriction on that dimension.
let sessionFilters = { minAgeDays: null, maxAgeDays: null, minMcap: null, maxMcap: null, minVol: null, maxVol: null, minLiq: null, maxLiq: null };

function parseFilterAmount(str) {
  if (!str) return null;
  str = str.toLowerCase().trim();
  const num = parseFloat(str);
  if (isNaN(num)) return null;
  if (str.endsWith('b')) return num * 1e9;
  if (str.endsWith('m')) return num * 1e6;
  if (str.endsWith('k')) return num * 1e3;
  return num;
}
function parseFilterDays(str) {
  // Supports: 30m / 45min / 90mins  →  minutes (stored as fractional days)
  //           2h  / 12hr  / 24hrs   →  hours   (stored as fractional days)
  //           1d  / 7d    / 15d     →  days
  //           1mo / 2mo   / 3month  →  months  (×30 days)
  //           bare number           →  days (default)
  str = (str || '').toLowerCase().trim();
  const num = parseFloat(str);
  if (isNaN(num)) return null;
  if (str.match(/min(s?)?$/) || (str.endsWith('m') && !str.match(/mo(nth)?s?$/)))
                                                          return num / 1440;    // minutes → days
  if (str.match(/h(r?s?)?$/))                             return num / 24;     // hours → days
  if (str.match(/mo(nth)?s?$/))                           return num * 30;     // months → days
  // 'd' or bare number → days
  return num;
}
function parseFilterRange(str, isDays) {
  if (!str || str === 'any' || str === '0') return { min: null, max: null };
  str = str.toLowerCase().trim();
  const parse = isDays ? parseFilterDays : parseFilterAmount;
  if (str.includes('-')) {
    const [a, b] = str.split('-');
    return { min: parse(a), max: parse(b) };
  }
  if (str.endsWith('+')) return { min: parse(str.slice(0, -1)), max: null };
  const v = parse(str);
  return { min: v, max: v }; // exact value
}
function fmtSessionFilters() {
  const f = sessionFilters;
  const fmtAmt = v => v >= 1e9 ? `${(v/1e9).toFixed(1)}B` : v >= 1e6 ? `${(v/1e6).toFixed(1)}M` : v >= 1e3 ? `${(v/1e3).toFixed(0)}K` : `${v}`;
  const fmtDay = v => v >= 30 ? `${(v/30).toFixed(1)}mo` : v >= 1 ? `${v}d` : v >= 1/24 ? `${Math.round(v*24)}h` : `${Math.round(v*1440)}m`;
  const lines = [];
  if (f.minAgeDays !== null || f.maxAgeDays !== null) {
    const lo = f.minAgeDays != null ? fmtDay(f.minAgeDays) : '0';
    const hi = f.maxAgeDays != null ? fmtDay(f.maxAgeDays) : '∞';
    lines.push(`📅 Age: ${lo} – ${hi}`);
  }
  if (f.minMcap !== null || f.maxMcap !== null) {
    const lo = f.minMcap != null ? '$'+fmtAmt(f.minMcap) : '$0';
    const hi = f.maxMcap != null ? '$'+fmtAmt(f.maxMcap) : '∞';
    lines.push(`💰 MCap: ${lo} – ${hi}`);
  }
  if (f.minVol !== null || f.maxVol !== null) {
    const lo = f.minVol != null ? '$'+fmtAmt(f.minVol) : '$0';
    const hi = f.maxVol != null ? '$'+fmtAmt(f.maxVol) : '∞';
    lines.push(`📊 Vol24h: ${lo} – ${hi}`);
  }
  if (f.minLiq !== null || f.maxLiq !== null) {
    const lo = f.minLiq != null ? '$'+fmtAmt(f.minLiq) : '$0';
    const hi = f.maxLiq != null ? '$'+fmtAmt(f.maxLiq) : '∞';
    lines.push(`💧 Liq: ${lo} – ${hi}`);
  }
  return lines.length ? lines.join('\n') : 'None active';
}
function applySessionFilters(coins) {
  const f = sessionFilters;
  if (Object.values(f).every(v => v === null)) return coins;
  return coins.filter(coin => {
    if (f.minAgeDays !== null && (coin.ageDays || 0) < f.minAgeDays) return false;
    if (f.maxAgeDays !== null && (coin.ageDays || 0) > f.maxAgeDays) return false;
    if (f.minMcap    !== null && (coin.mcap    || 0) < f.minMcap)    return false;
    if (f.maxMcap    !== null && (coin.mcap    || 0) > f.maxMcap)    return false;
    if (f.minVol     !== null && (coin.vol24   || 0) < f.minVol)     return false;
    if (f.maxVol     !== null && (coin.vol24   || 0) > f.maxVol)     return false;
    if (f.minLiq     !== null && (coin.liq     || 0) < f.minLiq)     return false;
    if (f.maxLiq     !== null && (coin.liq     || 0) > f.maxLiq)     return false;
    return true;
  });
}
async function saveSessionFilters() {
  try {
    _tradingCfg = null;
    await db.collection('paper_config').doc('control').set({ sessionFilters }, { merge: true });
  } catch(e) { console.warn('[BOT] Could not save session filters:', e.message); }
}

// ── BACKGROUND SLOT TIMING ────────────────────────────────────────────────────
// AM / SC (fast-moving): background after 5h if gain < 25%
// BB / OR (patient):     background after 24h if gain < 10%
// A backgrounded coin regains a visible slot if it jumps +50% within 1 hour
const BG_AMSC_TIMEOUT_MS    = 5  * 60 * 60 * 1000;  // 5 hours
const BG_BBOR_TIMEOUT_MS    = 24 * 60 * 60 * 1000;  // 24 hours
const BG_AMSC_MIN_GAIN      = 0.25;  // 25% — AM/SC must sustain this to stay visible
const BG_BBOR_MIN_GAIN      = 0.10;  // 10% — BB/OR must reach this to stay visible
const BG_REACTIVATE_GAIN    = 0.50;  // +50% in 1h triggers pop-back to visible
const BG_REACTIVATE_WIN_MS  = 60 * 60 * 1000;       // 1-hour rolling window for reactivation

// ── PULLBACK WATCHLIST (Bottom Bounce id=0 + Old Recovery id=3) ───────────────
// BB and OR don't enter immediately — they wait for price to settle at support
// then confirm a 3% bounce before entering. SC and AM still enter immediately.
const PULLBACK_FLAT_MIN    = -0.5;         // m5Ch lower bound for "at support" flat zone
const PULLBACK_FLAT_MAX    =  0.5;         // m5Ch upper bound for "at support" flat zone
const PULLBACK_BOUNCE_PCT  =  0.03;        // 3% bounce from the low to confirm support held
const PULLBACK_EXPIRY_MS   = 25 * 60 * 1000; // 25 min — discard if no clean setup emerges
const PULLBACK_MAX_DROP    =  0.25;        // discard if price drops 25%+ from qualified price

// ── RESISTANCE EXIT ───────────────────────────────────────────────────────────
// At entry we estimate overhead resistance from h1/h6/h24 price changes.
// When live price reaches that level → 50% partial exit, rest rides with SL/trail.
const RESISTANCE_MIN_GAP   =  0.08;        // resistance must be ≥8% above entry to be meaningful
const RESISTANCE_EXIT_FRAC =  0.50;        // take 50% of remaining at resistance
const SCAN_INTERVAL   = 15000;  // 15s — entry scanner
const PRICE_CHECK     =  3000;  //  3s — position monitor (all hot-path reads cached; ~5,760 reads/day total)

// ─── SURGE MOMENTUM MODE ──────────────────────────────────────────────────────
// Fast-surging coins skip TP1/TP2, ride to 80%+ then full-exit.
// After exit: 80% of profit split as moon bag (50%) + normal TP position (50%).
const SURGE_M5_ENTRY_TRIGGER = 10;           // m5% ≥ 10 at scan → surge flag at entry
const SURGE_AUTO_GAIN_TRIGGER = 0.40;        // auto-switch if +40% in first 20 min
const SURGE_AUTO_TIME_LIMIT   = 20 * 60 * 1000;
const SURGE_EXIT_AT           = 0.80;        // 80% gain → full exit & reinvest
const SURGE_REINVEST_RATIO    = 0.80;        // reinvest 80% of total profit
const SURGE_MOON_BAG_RATIO    = 0.50;        // 50% of reinvest = moon bag
const MOON_BAG_INITIAL_SL     = 0.25;        // moon bag starts at 25% SL
const MOON_BAG_SL_FLOOR       = 0.05;        // 5% floor — never tighter
// [minGainFromMoonBagEntry, slLevel] — checked largest-gain first
const MOON_BAG_SL_SCHEDULE = [
  [2.50, 0.05],  // +250%+ from moon entry → 5% SL
  [1.50, 0.10],  // +150%+                 → 10% SL
  [1.00, 0.15],  // +100%+                 → 15% SL
  [0.50, 0.20],  //  +50%+                 → 20% SL
  [0.00, 0.25],  //    0%+                 → 25% SL (initial)
];

// ─── GOPLUS LP LOCK CHECK ─────────────────────────────────────────────────────
// GoPlus removed (Nov-11) — Solana security now handled entirely by RugCheck.
const lpLockCache = new Map();   // addr → { locked: bool, ts: number }
const LP_LOCK_TTL = 10 * 60 * 1000; // 10-min cache — recheck often; meme coins can change

// ─── RUGCHECK LP LOCK (Solana) ────────────────────────────────────────────────
// RugCheck API is free, Solana-native, and reliably returns lp_locked status —
// filling the gap GoPlus leaves for Solana pools.
// Rate limit: 1,080 calls/month (free tier) — cache 10 min, probation busts cache.
const rugCheckCache = new Map();      // addr → { lpLocked: bool, riskScore: number, ts: number }
const RUGCHECK_TTL  = 10 * 60 * 1000; // 10-min cache (same as GoPlus)

// ─── LP PROBATION ─────────────────────────────────────────────────────────────
// Solana coins that scored well but have an unlocked LP go here.
// Re-scanned every 5 min; if LP gets locked within 90 min they clear for entry.
const lpProbationCoins        = new Map(); // addr → { symbol, addedAt, lastChecked, rugScore, liq, mcLiqRatio, strategyId }
const LP_PROBATION_MAX_MS     = 90 * 60 * 1000;   // 90-min window
const LP_PROBATION_MAX        = 10;                // cap — oldest dropped when full
const LP_PROBATION_RECHECK_MS =  5 * 60 * 1000;   // recheck RugCheck every 5 min

// ─── WATCHING SNAPSHOT (for /watching command) ────────────────────────────────
let watchingCoinsSnapshot = []; // updated each scan; holds near-miss coins for on-demand reporting

// ─── PRICE HISTORY TRACKER ────────────────────────────────────────────────────
const priceHistory  = new Map(); // addr → [{price, score, ts}, ...]
// SC rug detection: 15s rolling price window per live position
const scPriceWindow = new Map(); // addr → [{price, ts}, ...]
const scRugSignals  = new Map(); // addr → number of rug signals fired this session
const PRICE_HIST_MAX    = 300;  // keep last 300 scan snapshots per coin (~75 min at 15s scans; needed for TA indicators)
const PRICE_HIST_TREND  = 3;    // consecutive rising points = confirmed uptrend
const PRICE_HIST_REBOUND_PCT = 0.05; // 5% recovery from dip = rebound confirmed

// ─── SURGE_CATCH PULLBACK WATCHLIST ──────────────────────────────────────────
// Instead of entering at the peak of a surge, the bot tracks each SURGE_CATCH
// candidate, waits for a pullback (≥5% below peak), then enters when the price
// bounces back ≥3% from its pullback low — catching the second wave.
const surgeWatchlist        = new Map(); // addr → { symbol, peakPrice, pullbackLow, pullbackDetected, watchedSince }
const SURGE_PULLBACK_MIN    = 0.05;     // ≥5% drop from peak = in pullback zone
const SURGE_PULLBACK_MAX    = 0.35;     // >35% drop = dump — abandon watchlist entry
const SURGE_BOUNCE_CONFIRM  = 0.03;     // 3% recovery from pullback low = entry signal
const SURGE_WATCH_EXPIRY_MS = 15 * 60 * 1000; // 15 min — pullback/bounce cycles need time; 5 min was too tight
const SURGE_BUY_RATE_MIN    = 8;        // ≥8 buys/min = confirmed real surge (m5Buys/5)
const SURGE_CONFIRM_MIN_MS  = 60000;    // must watch ≥1 min before buy-rate entry fires
const SURGE_AVG_TRADE_MIN   = 25;       // avg trade ≥$25 — young surging coins trade smaller; still above $20 anti-manip floor

// ─── SC RUG DETECTION ────────────────────────────────────────────────────────
// For Surge Catch (strategy 2) only: young coins can rug in seconds.
// If price drops ≥ 30% vs the price 15s ago (5 ticks at 3s):
//   1st signal → capital protection fires + SL tightened aggressively
//   2nd+ signal → exit ALL positions on this coin immediately
const SC_RUG_DROP_PCT  = 0.30;  // 30% drop in 15s = rug signal
const SC_RUG_WINDOW_MS = 15000; // 15-second rolling price window
const SC_RUG_EXIT_CNT  = 2;     // 2nd signal → emergency exit all positions on coin

// ─── CAPITAL FLOOR GRACE PERIOD ──────────────────────────────────────────────
const CAPITAL_FLOOR_GRACE_MS = 2 * 60 * 1000; // 2 min before SL floors at entryPrice
const SL_TIGHTEN_PCT         = 0.85;           // after grace, if still below entry → SL tightens to -15%

// ─── ANTI-MANIPULATION THRESHOLDS ────────────────────────────────────────────
// Applied globally in detectStrategy() before any strategy-specific scoring.
// Catches bot farms (micro-trade spam), thin-pool manipulation, and wash trading.
const ANTI_MANIP_AVG_TRADE_FLOOR  = 8;    // ≥$8 avg trade — filters micro-trade bot spam (restored Nov-14)
const ANTI_MANIP_M5_TXNS_MAX      = 200;  // ≤200 txns/5min — 40/min ceiling catches bot farms (restored Nov-14)
const ANTI_MANIP_MC_LIQ_RATIO_MAX        = 30;   // global: mc/liq > 30× = thin pool (unlocked LP — unchanged)
const ANTI_MANIP_MC_LIQ_RATIO_MAX_LOCKED = 40;   // global: mc/liq > 40× = thin pool (locked LP gate; unlocked LP tightens to 30× in filterByLpLock) (restored Nov-14)
const ANTI_MANIP_SC_AVG_TRADE     = 15;   // Surge Catch own gate: $15 filters micro-spam while allowing young coin activity; SC bypasses the global $20 gate
const ANTI_MANIP_SC_TXNS_MAX      = 150;  // Surge Catch only: 30/min ceiling
// ANTI_MANIP_SC_MC_LIQ_MAX removed Nov-10 — SC now uses ANTI_MANIP_MC_LIQ_RATIO_MAX_LOCKED (40×) same as other strategies

// ─── ALLOWED DEX GATE ────────────────────────────────────────────────────────
// Module-level so both detectStrategy() and scanForEntries() share one definition.
// Only trade coins on established AMMs; ungraduated pump.fun bonding-curve ('pump-fun')
// stays blocked.  PumpSwap variants cover likely DexScreener dexId spellings.
const ALLOWED_DEXES = new Set([
  'raydium',
  'pumpswap', 'pump_amm', 'pump-amm', 'pump_swap', 'pump-swap',
  'meteora',
  'orca',          // Solana AMM — confirmed blocked in logs (should be allowed)
]);
// PumpSwap variants — coins on these may still migrate to Raydium (secondary graduation),
// causing a temporary liq collapse that is NOT a rug. Positions entered via PumpSwap
// receive a 4-min grace window on sudden liq collapse before emergency exit fires.
// Raydium, Meteora, Orca: fully settled — no migration risk — exit immediately on liq drain.
const PUMPSWAP_DEXES = new Set(['pumpswap','pump_amm','pump-amm','pump_swap','pump-swap']);
// ─── DIAGNOSTIC GATE COUNTERS ────────────────────────────────────────────────
// gateStats: per-scan (console only); gatePeriodStats: 20-scan window (sent to Telegram on heartbeat)
const gateStats       = { total:0, chain:0, liqFloor:0, price:0, honey:0, txns:0, avgT:0, ratio:0, young:0, dead:0, noAct:0, dex:0, age:0, mom:0, live:0, noMatch:0 };
const gatePeriodStats = { total:0, chain:0, liqFloor:0, price:0, honey:0, txns:0, avgT:0, ratio:0, young:0, dead:0, noAct:0, dex:0, age:0, mom:0, live:0, noMatch:0 };
// LP gate stats — per 20-scan period
const lpPeriodStats   = { checked:0, passed:0, failRisk:0, failLiq:0, failRatio:0, rcFail:0 };
// Strategy distribution — how many matched each strategy per period
const stratPeriodStats = { bb:0, am:0, sc:0, or:0, ps:0 };
// Gate simulation accumulator — per-filter independent rejection counts.
// Runs on ALL coins regardless of bypass flags (pure diagnostic — no early return).
const gateSimStats = {
  total:0,
  // Global gate (independent checks)
  liqFloor:0, honey:0, txns:0, avgT:0, ratio:0,
  youngBuy:0, youngTxns:0, dead:0, noAct:0, dex:0, age:0, mom:0,
  // Strategy gates (per-filter, independent)
  bbAge:0, bbCh24:0, bbCh1:0, bbM5Ch:0, bbBuy:0, bbTxns:0, bbLiq:0,
  amM5Ch:0, amBuy:0, amTxns:0, amLiq:0, amCh1:0,
  scAge:0, scM5Ch:0, scBuy:0, scTxns:0, scLiq:0, scAvgT:0,
  orAge:0, orCh24:0, orCh1:0, orBuy:0, orLiq:0, orBuys24:0,
  psAge:0, psCh1:0, psM5Ch:0, psBuy:0, psTxns:0, psLiq:0,
  // LP gate simulation (liq-floor checks — RugCheck risk can't be simulated here)
  lpBB:0, lpAM:0, lpSC:0, lpOR:0, lpPS:0, lpRatio:0
};

// ─── DYNAMIC POSITION SIZING ─────────────────────────────────────────────────
// Position scales with liquidity (1% of pool ≈ <1% price impact) and market cap.
// POSITION_SIZE env var is now the MAXIMUM cap — not a fixed amount.
// MC sweet spot ($25k–$200k): fast-moving small caps where small traders make the most.
const POS_FLOOR = 1;    // $1 minimum — allows small trial trades for real-mode testing

// ─── RANGE-TRADE MODE (Bottom Bounce id 0, Active Momentum id 1, Old Recovery id 3) ──
// When a position gains <5% in 30 minutes (slow movement), the bot identifies the
// support/resistance range and cycles in/out for consistent small profits.
//   • At resistance + declining momentum → take profit, add to re-entry watchlist
//   • At resistance + still rising       → skip exit, tighten SL to protect gain
//   • TP1/TP2/TP3 remain as guardrails for fast-moving positions
// Surge Catch (id 2) is exempt — it has its own stale-exit logic.
const RANGE_SLOW_MIN_AGE    = 30 * 60 * 1000;  // 30 min minimum hold before range check
const RANGE_SLOW_GAIN_MAX   = 0.05;             // <5% gain in 30 min = slow movement
const RANGE_RESISTANCE_PCT  = 1.02;             // price ≥ 2% above recent high = at resistance
const RANGE_SUPPORT_PCT     = 1.03;             // re-entry when price ≤ support × 1.03 (within 3%)
const RANGE_MIN_EXIT_GAIN   = 0.01;             // need at least 1% gain before range-cycling
const RANGE_REENTRY_BOUNCE  = 0.03;             // 3% bounce from support = re-entry signal
const RANGE_REENTRY_WINDOW  = 2 * 60 * 60 * 1000; // 2h watchlist expiry

// addr → { symbol, strategyId, strategyLabel, supportLevel, exitPrice, exitTime, dexUrl }
const rangeReentryWatchlist = new Map();

// ── MOMENTUM RE-ENTRY (AM id=1, SC id=2, PS id=4) ───────────────────────────
// After an SL close where loss ≤ 10% (or any profit), watch for higher-low reversal.
// Higher low = postExitLow > snapshotLow (structural low recorded at time of exit).
// Entry trigger = 3% bounce from that postExitLow (curve reversing from the dip).
// Window = 30 minutes. Sizing = standard dynamic (1% liq).
const MOMENTUM_REENTRY_STRATEGIES  = new Set([0, 1, 2, 3, 4]); // all strategies; BB+OR have no time limit
const MOMENTUM_REENTRY_BOUNCE_PCT  = 0.03;               // 3% bounce from postExitLow
const MOMENTUM_REENTRY_WINDOW_MS   = 30 * 60 * 1000;     // 30-min watch window
const MOMENTUM_REENTRY_MAX_LOSS    = -0.10;               // ignore if loss > 10% of size

// addr → { symbol, strategyId, strategyLabel, dexUrl, chain, liq, mcap, score,
//           ageMinutes, snapshotLow, postExitLow, exitPrice, exitTime, pnlPct }
const momentumReentryWatch = new Map();

// ═════════════════════════════════════════════════════════════════════════════
// ─── CORE OPERATING PRINCIPLE ─────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
// This bot exists to make profit. Losses are permitted ONLY when unavoidable.
// Every feature — exit timing, entry gates, slot management, TP/SL placement,
// range cycling, trailing SL decisions — must serve this principle.
// Never hold a flat position hoping it recovers; extract value from the range.
// Never accept a loss when a smarter exit or hold could have avoided it.
// ═════════════════════════════════════════════════════════════════════════════

// ─── FIREBASE INIT ────────────────────────────────────────────────────────────
let db;
let firebaseError = null;
try {
  const projectId   = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawKey      = process.env.FIREBASE_PRIVATE_KEY || '';
  // Handle both literal \n (pasted from JSON) and actual newlines
  const privateKey  = rawKey.replace(/\\n/g, '\n');

  if (_requireError) throw new Error('firebase-admin module failed to load: ' + _requireError);
  if (!projectId)   throw new Error('FIREBASE_PROJECT_ID missing');
  if (!clientEmail) throw new Error('FIREBASE_CLIENT_EMAIL missing');
  if (!rawKey)      throw new Error('FIREBASE_PRIVATE_KEY missing');
  if (!privateKey.includes('BEGIN')) throw new Error('FIREBASE_PRIVATE_KEY looks wrong — does not contain BEGIN. Raw length: ' + rawKey.length + ', first 30 chars: ' + rawKey.slice(0,30));

  console.log('[BOT] Firebase init — project:', projectId);
  initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  db = getFirestore();
  console.log('[BOT] Firebase connected ✓');
} catch(e) {
  firebaseError = e.message;
  console.error('[BOT] Firebase init failed:', firebaseError);
  // Do NOT exit — bot stays alive, will report error via Telegram in main()
}

// ═════════════════════════════════════════════════════════════════════════════
// ─── 4-STRATEGY SYSTEM  (20 total slots) ─────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
const STRATEGIES = [
  {
    id: 0,
    label: '📉 BOTTOM BOUNCE',
    maxSlots: 20, // unlimited — competes openly for global slots with id 1 and id 3
    desc: '1h+ old token caught at the bottom going up',
    disabled: true, // Nov-18: disabled — diagnostic data shows 60min+ coins avg -4% return; re-enable after further testing
    // ── Entry criteria ──
    minAgeDays: 0.042,  // Nov-12: ≥ 1 hour — anything under 1h is PS territory, not BB
    maxCh24: -5,        // Nov-11: -20→-5 — open to any meaningful pullback, not just big crashes
    minCh24: -85,       // Nov-9: not a dead coin
    maxCh1: 12,         // Nov-9: h1 not already mooned
    minCh1: -8,         // Nov-9: h1 turning; not in freefall
    minM5Ch: 0,         // Nov-10: 1.5→0 — pullback watchlist confirms the bounce; scan detects stabilisation
    minBuyPct: 55,      // Nov-11: 60→55 — relaxed to accommodate pump.fun/PumpSwap ecosystem
    minLiq: 18000,      // Nov-13: 12k→18k — tighter LP liq floor; compensates for looser rug risk
    minLiqLocked: 12000,// Nov-13: 8k→12k — higher bar for LP-locked coins
    minM5Txns: 3,       // Nov-13: 5→3 — crashed coins have very thin volume; 3 is enough to confirm it's alive
    rugCheckMaxRisk: 65,         // Nov-13: BB crashed coins score higher on rug checks; slightly below standard 75
    rugCheckMaxUnlockedRisk: 50, // Nov-13: 40→50 — unlocked LP ceiling raised alongside liq floor increase
    // ── TP / SL (standard 3-step) ──
    tp1x: 1.20, tp2x: 1.45, tp3x: 2.00,
    slx: 0.90,          // –10% SL: if a bounce thesis fails –10%, thesis is wrong
    initialTrailPct: 12,
  },
  {
    id: 1,
    label: '⚡ ACTIVE MOMENTUM',
    maxSlots: 20, // unlimited — competes openly for global slots with id 0 and id 3
    desc: 'Any age trending upward — hours or days of live momentum',
    // ── Entry criteria ──
    // No age cap — AM applies to any coin with active momentum regardless of age
    // (from 1h all the way to multi-day trending coins).
    // SC (id=2) handles the aggressive surge for 1h–24h coins; AM and SC
    // compete on score when both criteria are met and the highest scorer wins.
    minM5Ch: 0,          // Nov-13: 0.5→0 — catch sideways coins about to move; any non-negative m5 is valid
    minM5Txns: 8,        // Nov-11: 15→8 — pump.fun coins have thinner activity
    minBuyPct: 52,       // Nov-11: 58→52 — marginal buyer edge is enough with RugCheck backing it
    minCh1: -2,          // Nov-11: 0→-2 — allow slight h1 dip as long as m5 is positive
    maxCh1: 35,          // Nov-18: cap — coin already up 35%+ in 1h has exhausted its move; we'd be buying the top
    maxMcap: 500000,     // Nov-18: diagnostic data shows $500k+ mcap coins avg -14.5%; cap at $500k
    minAgeMinutes: 5,    // Nov-18: same rug-at-birth floor as PS — no entries on coins under 5 min old
    minLiq: 8000,        // Nov-19: lowered to match $8k absolute floor (gates bypassed; liq is the only entry gate)
    minLiqLocked: 8000,  // Nov-19: same — LP filter uses minLiq as strict floor for unlocked LP
    // ── TP / SL (partial profit — sell in bits) ──
    tp1x: 1.28, tp2x: 1.70, tp3x: 3.00,  // Nov-9: TP1 at +28% — captures the common 20–40% pop
    slx: 0.86,           // Nov-9: –14% SL (was –20% — the single biggest loss driver)
    initialTrailPct: 12, // Nov-9: tighter trail locks in gains faster
    usePartialProfit: true,  // stage-based selling like old Alpha
  },
  {
    id: 2,
    label: '🚀 SURGE CATCH',
    maxSlots: 20, // competes for all global slots — last 5 reserved exclusively via SURGE_RESERVED logic
    desc: '1h to 24h old — surging hard mid-flight, catch it now',
    // ── Entry criteria — use m5 as primary signal, not h1 ──
    // h1 is a lagging indicator — the surge may already be over by then
    // m5 catches it while it's still happening
    minAgeDays: 0.042,  // Nov-12: ≥ 1 hour — anything under 1h is PS territory, not SC
    minM5Ch: 3,          // Nov-11: 5→3 — 5% was too rare; 3% is still a genuine surge
    minM5Txns: 10,       // Nov-11: 20→10 — allow thinner activity in pump ecosystem
    minCh1: 0,           // h1 not negative (newly graduated coins may lack h1 history)
    minBuyPct: 55,       // Nov-11: 62→55 — align with pump.fun ecosystem reality
    maxMcap: 500000,     // Nov-18: diagnostic data shows $500k+ mcap coins avg -14.5%; cap at $500k
    minLiq: 8000,        // Nov-19: lowered to match $8k absolute floor
    minLiqLocked: 8000,  // Nov-19: same — LP filter strict floor for unlocked LP
    maxAgeDays: 1,       // Nov-9: SC is for young graduated coins only; AM handles 1–3 days
    // ── TP / SL (quick first profit, trail the rest) ──
    tp1x: 1.30, tp2x: 2.00, tp3x: 4.00,  // Nov-9: genuine surges can run far
    slx: 0.85,           // Nov-9: –15% SL for young coin volatility room
    initialTrailPct: 18,
    usePartialProfit: true,  // take bits on the way up
  },
  {
    id: 3,
    label: '📈 OLD RECOVERY',
    maxSlots: 20, // unlimited — competes openly for global slots with id 0 and id 1
    desc: '1 day+ established coin recovering steadily',
    disabled: true, // Nov-18: disabled — diagnostic data shows old high-mcap coins cause heavy losses (SL+rug); re-enable after tuning
    // ── Entry criteria ──
    minAgeDays: 1,       // Nov-12: 3→1 — any coin ≥ 1 day old qualifies as "old recovery"
    minCh24: 0.5,        // Nov-13: 2→0.5 — catch early recovery before 24h fully green
    minCh1: 0.5,         // Nov-10: 1.5→0.5 — ch24≥2% already confirms recovery; 0.5% checks h1 trend intact
    maxCh1: 20,          // Nov-9: tighter spike guard — >20% in 1h on old coin is suspicious
    minBuyPct: 50,       // Nov-11: 58→50 — marginal buyer dominance allowed with RugCheck backing
    minLiq: 28000,       // Nov-13: 20k→28k — tighter LP liq floor; compensates for looser rug risk
    minLiqLocked: 18000, // Nov-13: 12k→18k — higher bar for LP-locked coins
    minBuys24: 15,       // Nov-11: 35→15 — lower activity floor for pump ecosystem
    // ── TP / SL (conservative) ──
    tp1x: 1.12, tp2x: 1.30, tp3x: 1.65,
    slx: 0.92,
    initialTrailPct: 8,
  },
  {
    id: 4,
    label: '🎯 PUMP SPEC',
    maxSlots: 20, // Nov-11: removed per-strategy cap — all strategies compete freely for the global 20 slots
    desc: 'pump.fun / PumpSwap < 1 hour old — speculative pullback entry',
    // ── Entry criteria ──
    maxAgeDays: 0.042,  // Nov-12: < 1 hour — strictly new coins; anything older routes to SC/AM
    minAgeMinutes: 5,    // Nov-18: skip coins under 5 min old — rug-at-birth profile (avg 2min, $23k mcap in losses)
    minLiq: 8000,        // Nov-13: 6k→8k — tighter LP liq floor; compensates for looser rug risk
    minLiqLocked: 6000,  // Nov-13: 5k→6k — higher bar for LP-locked
    minH1Ch: 2,          // Nov-11: 5→2 — h1 just needs to show positive trend, not strongly up
    minM5Ch: -5,         // allow pullback entry — not chasing the top
    maxM5Ch: 4,          // Nov-11: 2→4 — wider pullback window; allows more entry points
    minM5Sells: 1,       // at least one sell — confirms real 2-sided trading
    minBuyPct: 50,       // Nov-11: 55→50 — marginal buyer edge enough for speculative entries
    minM5Txns: 6,        // Nov-11: 10→6 — allow thinner activity
    maxMcLiqRatio: 60,   // more lenient ratio for thin pump pools
    rugCheckMaxRisk: 65, // Nov-13: 50→65 — +25% from prior 50; still below standard 75 (pump.fun is higher risk)
    // ── SL / TP (custom schedule — handled in monitor loop for id=4) ──
    slx: 0.60,           // initial SL = entry − 40%
    // Nov-12: removed maxPositionSize:50 — now respects /setsize ceiling like all other strategies
    // SL phases (see monitorPositions Strategy 5 block):
    //   0–19%:   flat −40% from entry
    //  20–59%:   break-even lock (SL = entry)
    //  60–79%:   −35% trail from ATH
    //  80–99%:   −30% trail from ATH
    // 100%+:     capital recovery (sell enough to recover invested amount)
    //  post-recovery: −25% → −20% → −15% → −10% floor trail
    //   at 4× (300% gain): profit halving — sell 50% of remaining
    initialTrailPct: 40,  // used for display only; actual trail managed in monitor
  },
];

// ── UNIVERSAL PROGRESSIVE TRAILING SL ────────────────────────────────────────
// All positions use one universal progressive trailing system:
//   • Activates at +25% gain from entry (Nov-9: was +50% — most trades never reached it)
//   • Trail starts at 50% below ATH, tightens 5% per +20% ATH move, floor 10%
//   • SL never within 10% of current price (buffer)
//   • SL never below entryPrice (zero-loss guarantee after +25%)
// See main position loop for the implementation.
// ─────────────────────────────────────────────────────────────────────────────

// Dynamic position size: 1% of pool liquidity × market cap multiplier, capped at ceiling.
// MC sweet spot ($25k–$200k) gets a 1.3× boost — these coins can 2x–5x fast for small traders.
// Large caps (>$2M) are reduced — a $100 position barely moves the needle there.
function calcDynamicPositionSize(liq, mcap, ceiling = POSITION_SIZE) {
  const base = liq * 0.01;  // 1% of pool — keeps price impact under ~1%
  const mcMult =
    mcap < 25000    ? 0.5 :   // ultra-micro — too risky, minimize
    mcap <= 200000  ? 1.3 :   // sweet spot $25k–$200k — size up for fast gains
    mcap <= 2000000 ? 1.0 :   // standard small cap
    mcap <= 20000000? 0.8 :   // mid cap — our $100 barely matters, pull back
                      0.6;    // large cap — we're dust here, don't overexpose
  return Math.max(POS_FLOOR, Math.min(base * mcMult, ceiling));
}

// Moon bag SL: returns the current SL fraction (e.g. 0.20 = 20%) based on
// how much the moon bag position has gained since its own entry price.
function getMoonBagSL(gainFromEntry) {
  for (const [minGain, sl] of MOON_BAG_SL_SCHEDULE) {
    if (gainFromEntry >= minGain) return sl;
  }
  return MOON_BAG_INITIAL_SL;
}

// ── TIER CONFIGURATION ─────────────────────────────────────────────────────
// Three tiers determined by dynamic position size at entry.
//   Tier 1 (Micro, $20–50):   10k–25k liq — volatile, wide SL, quick TP
//   Tier 2 (Small, $50–200):  25k–75k liq — moderate, balanced SL/TP
//   Tier 3 (Medium, $200+):   75k+ liq    — stable, tight SL, patient TP
//
// Milestones: each entry locks a floor at (gainPct × posSize × (1−trailPct)).
// notionalGain = gain × posSize ($ gain on FULL position from entry — used as
// the reference even after partial sells so milestones stay consistent).
// TP1 = capital recovery at tp1GainPct. TP2 = gain share at tp2GainPct.
// ─────────────────────────────────────────────────────────────────────────────
function getTierConfig(tier) {
  const cfgs = {
    1: { // Micro: $20–$50
      entrySLPct: 50, tp1GainPct: 50, tp2GainPct: 200,
      milestones: [
        { gainPct: 0.50, trailPct: 0.30 }, // TP1 trigger  → floor = 35% of posSize
        { gainPct: 0.80, trailPct: 0.25 }, //              → floor = 60% of posSize
        { gainPct: 1.10, trailPct: 0.20 }, //              → floor = 88% of posSize
        { gainPct: 1.40, trailPct: 0.15 }, //              → floor = 119% of posSize
        { gainPct: 1.70, trailPct: 0.10 }, //              → floor = 153% of posSize
      ],
    },
    2: { // Small: $50–$200
      entrySLPct: 40, tp1GainPct: 40, tp2GainPct: 150,
      milestones: [
        { gainPct: 0.40, trailPct: 0.30 }, // TP1 trigger  → floor = 28% of posSize
        { gainPct: 0.65, trailPct: 0.25 }, //              → floor = 48.75% of posSize
        { gainPct: 0.90, trailPct: 0.20 }, //              → floor = 72% of posSize
        { gainPct: 1.15, trailPct: 0.15 }, //              → floor = 97.75% of posSize
        { gainPct: 1.40, trailPct: 0.10 }, //              → floor = 126% of posSize
      ],
    },
    3: { // Medium: $200+
      entrySLPct: 30, tp1GainPct: 30, tp2GainPct: 100,
      milestones: [
        { gainPct: 0.30, trailPct: 0.30 }, // TP1 trigger  → floor = 21% of posSize
        { gainPct: 0.50, trailPct: 0.25 }, //              → floor = 37.5% of posSize
        { gainPct: 0.70, trailPct: 0.20 }, //              → floor = 56% of posSize
        { gainPct: 0.90, trailPct: 0.15 }, //              → floor = 76.5% of posSize
        { gainPct: 1.15, trailPct: 0.10 }, //              → floor = 103.5% of posSize
      ],
    },
  };
  return cfgs[tier] || cfgs[1];
}

// ═════════════════════════════════════════════════════════════════════════════
// ─── STRATEGY DETECTOR ───────────────────────────────────────────────────────
// Returns { strategy, score, ...coin data } or null
// ═════════════════════════════════════════════════════════════════════════════
function detectStrategy(pair, openStrategies) {
  const now     = Date.now();
  const created = pair.pairCreatedAt || (now - 86400000 * 30);
  const ageDays = (now - created) / 86400000;
  const liq     = pair.liquidity?.usd || 0;
  const vol24   = pair.volume?.h24 || 0;
  const m5Vol   = pair.volume?.m5  || 0;   // 5-min USD volume (anti-manipulation)
  const mcap    = pair.fdv || pair.marketCap || 1;
  const ch1Raw  = pair.priceChange?.h1;                                 // null = no data
  const ch1     = ch1Raw == null ? null : parseFloat(ch1Raw);
  const ch6     = parseFloat(pair.priceChange?.h6  || 0);  // 6h price change (DexScreener field)
  const ch24    = parseFloat(pair.priceChange?.h24 || 0);
  const m5Ch    = parseFloat(pair.priceChange?.m5  || 0);
  const buys24  = pair.txns?.h24?.buys  || 0;
  const sells24 = pair.txns?.h24?.sells || 0;
  const m5Buys  = pair.txns?.m5?.buys   || 0;
  const m5Sells = pair.txns?.m5?.sells  || 0;
  const m5Txns  = m5Buys + m5Sells;
  const total24 = buys24 + sells24;
  const buyPct  = total24 > 0 ? (buys24 / total24) * 100 : 50;
  const price   = parseFloat(pair.priceUsd || 0);
  const addr    = (pair.baseToken?.address || '').trim();
  const volMcap     = mcap > 0 ? vol24 / mcap : 0;
  // Anti-manipulation derived metrics
  const avgTrade    = m5Txns > 0 && m5Vol > 0 ? m5Vol / m5Txns : null; // null = data missing, skip filter
  const mcLiqRatio  = liq > 0 ? mcap / liq : 999;
  const mcSweetSpot = mcap >= 25000 && mcap <= 200000; // fast-doubling range for small traders
  const m5BuyRate   = m5Buys / 5; // buys per minute (direct from m5 txn data)

  // Universal hard filters
  const isSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
  const isEVM    = /^0x[0-9a-fA-F]{40}$/.test(addr);
  gateStats.total++;
  const rej = gate => { gateStats[gate]++; return null; };
  if (!isSolana && !isEVM) return rej('chain');

  // ── GATE SIMULATION ACCUMULATOR ──────────────────────────────────────────────
  // Runs on ALL coins regardless of bypass flags — no early returns.
  // Shows which individual filters block the most coins independently.
  // Uses same variable values as the real gate (liq, ch1, m5Ch, etc. already computed above).
  {
    const simAgeMin  = (now - created) / 60000;
    const simDexId   = pair.dexId || '';
    const simIsPSwap = ['pumpswap','pump_amm','pump-amm','pump_swap','pump-swap'].includes(simDexId);
    gateSimStats.total++;

    // — Global gate (independent checks — mirrors real gate logic) —
    if (liq < 500)                                                   gateSimStats.liqFloor++;
    if (sells24 === 0 && buys24 > 10)                                gateSimStats.honey++;
    if (m5Txns > ANTI_MANIP_M5_TXNS_MAX)                            gateSimStats.txns++;
    if (avgTrade !== null && avgTrade < ANTI_MANIP_AVG_TRADE_FLOOR)  gateSimStats.avgT++;
    if (mcLiqRatio > ANTI_MANIP_MC_LIQ_RATIO_MAX_LOCKED)            gateSimStats.ratio++;
    if (ageDays < 1) {
      if (buyPct < 10)  gateSimStats.youngBuy++;
      if (m5Txns < 1)   gateSimStats.youngTxns++;
    }
    // Dead coin simulation (mirrors the two branches of the real dead guard)
    {
      let simDeadFail = false;
      if (ch1 === null) {
        const pass = (simAgeMin >= 60 && simAgeMin < 240 && m5Ch >= -20)
                  || (m5Ch >= -20);
        if (!pass) simDeadFail = true;
      } else if (Math.abs(ch1) < 0.5) {
        const pass = (simAgeMin >= 60 && simAgeMin < 240 && m5Ch >= -20)
                  || (ch24 <= 0 && buyPct >= 10 && liq >= 500)
                  || (m5Ch >= -20);
        if (!pass) simDeadFail = true;
      }
      if (simDeadFail) gateSimStats.dead++;
    }
    if (!m5Txns || m5Txns < 1)             gateSimStats.noAct++;
    if (!ALLOWED_DEXES.has(simDexId))      gateSimStats.dex++;
    if (simAgeMin < 1)                     gateSimStats.age++;
    if (m5Ch !== null && m5Ch < -20)       gateSimStats.mom++;

    // — BB strategy gates (independent — reflects NEW thresholds) —
    if (!(ageDays >= 0.042))                           gateSimStats.bbAge++;
    if (!(ch24 <= -5 && ch24 >= -85))                  gateSimStats.bbCh24++;
    if (!(ch1 >= -8 && ch1 <= 12))                     gateSimStats.bbCh1++;
    if (!(m5Ch >= 0))                                  gateSimStats.bbM5Ch++;
    if (!(buyPct >= 55))                               gateSimStats.bbBuy++;
    if (!(m5Txns >= 3))                                gateSimStats.bbTxns++;  // NEW: 5→3
    if (!(liq >= 12000))                               gateSimStats.bbLiq++;   // minLiqLocked=12000 (Nov-13 raised)

    // — AM strategy gates (independent — reflects NEW thresholds) —
    if (!(m5Ch >= 0))                                  gateSimStats.amM5Ch++;  // NEW: 0.5→0
    if (!(buyPct >= 52))                               gateSimStats.amBuy++;
    if (!(m5Txns >= 8))                                gateSimStats.amTxns++;
    if (!(liq >= 12000))                               gateSimStats.amLiq++;   // minLiqLocked=12000 (Nov-13 raised)
    if (!(ch1 >= -2))                                  gateSimStats.amCh1++;

    // — SC strategy gates (independent) —
    if (!(ageDays >= 0.042 && ageDays <= 1))           gateSimStats.scAge++;
    if (!(m5Ch >= 3))                                  gateSimStats.scM5Ch++;
    if (!(buyPct >= 55))                               gateSimStats.scBuy++;
    if (!(m5Txns >= 10))                               gateSimStats.scTxns++;
    if (!(liq >= 8000))                                gateSimStats.scLiq++;   // minLiqLocked=8000 (Nov-13 raised)
    if (avgTrade !== null && !(avgTrade >= 15))        gateSimStats.scAvgT++;  // ANTI_MANIP_SC_AVG_TRADE

    // — OR strategy gates (independent — reflects NEW thresholds) —
    if (!(ageDays >= 1))                               gateSimStats.orAge++;
    if (!(ch24 >= 0.5))                                gateSimStats.orCh24++;  // NEW: 2→0.5
    if (!(ch1 >= 0.5 && ch1 <= 20))                    gateSimStats.orCh1++;
    if (!(buyPct >= 50))                               gateSimStats.orBuy++;
    if (!(liq >= 18000))                               gateSimStats.orLiq++;   // minLiqLocked=18000 (Nov-13 raised)
    if (!(buys24 >= 15))                               gateSimStats.orBuys24++;

    // — PS strategy gates (independent — pump.fun / PumpSwap only) —
    if (ageDays > 0.042)                               gateSimStats.psAge++;   // too old for PS
    if (!(ch1 >= 2))                                   gateSimStats.psCh1++;   // null >= 2 → false → counted
    if (!(m5Ch >= -5 && m5Ch <= 4))                    gateSimStats.psM5Ch++;
    if (!(buyPct >= 50))                               gateSimStats.psBuy++;
    if (!(m5Txns >= 6))                                gateSimStats.psTxns++;
    if (!(liq >= 6000))                                gateSimStats.psLiq++;   // minLiqLocked=6000 (Nov-13 raised)

    // — LP gate simulation (liq-floor checks — RugCheck risk can't be simulated here) —
    if (liq < 18000) gateSimStats.lpBB++;   // BB minLiq=18000 (Nov-13 raised)
    if (liq < 18000) gateSimStats.lpAM++;   // AM minLiq=18000 (Nov-13 raised)
    if (liq < 12000) gateSimStats.lpSC++;   // SC minLiq=12000 (Nov-13 raised)
    if (liq < 28000) gateSimStats.lpOR++;   // OR minLiq=28000 (Nov-13 raised)
    if (liq < 8000)  gateSimStats.lpPS++;   // PS minLiq=8000  (Nov-13 raised)
    if (mcLiqRatio > ANTI_MANIP_MC_LIQ_RATIO_MAX) gateSimStats.lpRatio++; // unlocked ratio gate
  }

  if (!globalGatesBypass) {
    if (liq < 3000) return rej('liqFloor'); // $3,000 absolute floor — below this, any position faces severe slippage (restored Nov-14)
  }
  if ((diagnosticMode || globalGatesBypass) && liq < DIAG_MIN_LIQ) return rej('liqFloor'); // Nov-19: when gates bypassed, still enforce $8k floor
  if (price <= 0)  return rej('price');  // always keep — zero price breaks arithmetic
  // Level 1 — Always-on honeypot guard (applies even in diagnostic/bypass mode).
  // ≥3 sell txns required: a real tradeable token will have had multiple sellers.
  // Stronger than the old "sells24===0 && buys24>10" — catches 1-2 sell honeypots too.
  if (sells24 < 3) return rej('honey'); // Nov-25: restored — <3 sells in 24h = likely honeypot; not the cause of zero-entry issue (age filter was)
  if (!globalGatesBypass) {
    // (old sells24===0 check superseded by always-on sells24<3 above)

    // ── ANTI-MANIPULATION GLOBAL FILTERS ───────────────────────────────────────
    // Reject bot farms and thin-pool manipulation before wasting scoring cycles.
    if (m5Txns > ANTI_MANIP_M5_TXNS_MAX) return rej('txns');                        // 40+ txns/min = bot spam
    if (avgTrade !== null && avgTrade < ANTI_MANIP_AVG_TRADE_FLOOR) return rej('avgT'); // micro-trade spam
    if (mcLiqRatio > ANTI_MANIP_MC_LIQ_RATIO_MAX_LOCKED) return rej('ratio');          // thin pool gate — 40× (LP lock check tightens to 30× for unlocked Solana coins)
  }

  // Calculate age before the dead coin guard — needed for the young-coin exemption
  const ageMinutes = (now - created) / 60000;

  // ── YOUNG COIN STRICTER ENTRY GATE (< 1 day old) ─────────────────────────────
  // Coins under 24 hours are prime rug-pull candidates.  Require stronger proof
  // of genuine trading activity before we commit capital to them.
  //
  // EXEMPTION: Surge Catch (id 2) bypasses the global $20 avgTrade gate.
  // SC has its own avgTrade gate (ANTI_MANIP_SC_AVG_TRADE = $15) applied below in
  // strategy scoring. The $20 global gate was killing SC candidates before SC's
  // own gate ever ran. buyPct and m5Txns gates still apply to ALL young coins.
  const dexId      = pair.dexId || '';
  const isPumpFun  = dexId === 'pump-fun';

  const scIsOpen = openStrategies.some(st => st.id === 2);
  const s5OpenForYoung = isPumpFun && openStrategies.some(st => st.id === 4);
  if (!globalGatesBypass && ageDays < 1) {
    // avgTrade gate: $20 for all strategies except SC and pump.fun→S5
    // SC has its own $15 gate; pump.fun coins for S5 use the global floor ($8) only.
    if (!scIsOpen && !s5OpenForYoung && avgTrade !== null && avgTrade < 12) return rej('young'); // $12 avg trade — young coin stricter gate (restored Nov-14)
    if (s5OpenForYoung) {
      if (buyPct < 50) return rej('young');  // ≥50% buy dominance — restored Nov-14
      if (m5Txns  <  6) return rej('young'); // ≥6 txns/5min — restored Nov-14
    } else {
      if (buyPct < 50)  return rej('young'); // ≥50% buy dominance — restored Nov-14
      if (m5Txns  <  6) return rej('young'); // ≥6 txns/5min — restored Nov-14
    }
  }

  // DEAD COIN GUARD: reject coins where the 1h price change is missing or effectively flat.
  //
  // ch1 === null       → DexScreener returned no h1 data (coin too new / data gap)
  // Math.abs(ch1) < 0.5 → displays as "0.0%" on the signal — price has not moved in the last hour.
  //
  // THREE EXEMPTIONS (flat h1 is NOT always a dead coin):
  //
  //   1. YOUNG COIN (60–240 min old) with strong m5:
  //      h1 covers the coin's entire life, so a coin pumping NOW can show ~0% h1.
  //      Allow if m5Ch ≥ 2%.
  //
  //   2. BOTTOM BOUNCE candidate (ch24 ≤ -10%) with stabilising h1:
  //      A coin that dropped -25% in 24h and is now flat in h1 has STOPPED falling.
  //      That stabilisation is the SIGNAL for a bounce — rejecting it misses BNB-type
  //      setups that MemeScan PRO rates 80+ (oversold + buyers coming in).
  //      Allow if buyPct ≥ 50% (buyers are still present) and liq ≥ 5000.
  //      Nov-11: liq floor lowered 10000→5000 to match BB's updated minLiq (5k).
  //
  //   3. Strong m5 on any coin:
  //      If m5Ch ≥ 3% regardless of h1, the coin is moving RIGHT NOW.
  //
  if (!globalGatesBypass) {
    if (ch1 === null) {
      const s5OpenDead = openStrategies.some(st => st.id === 4);
      const pass = (ageMinutes >= 60 && ageMinutes < 240 && m5Ch >= 0.5)  // young coin pumping NOW — h1 covers whole life
                || (m5Ch >= 3)                                            // strong m5 on any coin overrides flat h1
                || (s5OpenDead && ageMinutes < 60 && m5Ch >= -5);        // PS: very young, slight pullback ok
      if (!pass) return rej('dead');
    } else if (Math.abs(ch1) < 0.5) {
      const s5OpenDead = openStrategies.some(st => st.id === 4);
      const pass = (ageMinutes >= 60 && ageMinutes < 240 && m5Ch >= 0.5) // young coin pumping NOW
                || (ch24 <= -10 && buyPct >= 50 && liq >= 5000)          // BB: genuinely crashed, buyers present
                || (m5Ch >= 3)                                            // strong m5 overrides flat h1
                || (s5OpenDead && ageMinutes < 60 && m5Ch >= -5);        // PS: very young, slight pullback ok
      if (!pass) return rej('dead');
    }

    // ── ACTIVITY RECENCY GATE ──────────────────────────────────────────────────
    // The coin must be actively trading RIGHT NOW — not stale or sleeping.
    // m5Txns = number of transactions in the last 5 minutes (DexScreener).
    // Zero transactions in 5 minutes means the coin has gone quiet — skip it.
    // Even 1-2 transactions confirms the coin is live; scoring rewards higher activity.
    if (!m5Txns || m5Txns < 1) return rej('noAct');

    // ── GRADUATED-DEX GATE ─────────────────────────────────────────────────────
    // ALLOWED_DEXES defined at module level (shared with scanForEntries).
    // Bonding-curve pump.fun ('pump-fun') normally blocked; allowed through ONLY when
    // Strategy 5 (Pump Speculative) is open — it has its own entry criteria for them.
    if (!ALLOWED_DEXES.has(dexId)) {
      const s5Open = openStrategies.some(st => st.id === 4);
      if (!(isPumpFun && s5Open)) {
        // Log unknown dexIds so we can expand ALLOWED_DEXES — remove once confirmed
        if (dexId && dexId !== 'pump-fun' && dexId !== 'pumpfun') {
          console.log(`[DEX-GATE] Blocked: dexId="${dexId}" symbol=${pair.baseToken?.symbol}`);
        }
        return rej('dex');
      }
      // pump.fun + Strategy 5 open — fall through to Strategy 5 evaluation
    }

    // UNIVERSAL AGE RANGE: 1 minute minimum
    if (ageMinutes < 1) return rej('age');

    // ── RISING MOMENTUM GATE ────────────────────────────────────────────────
    // The bot must only enter when the coin is actively moving UP — not during a
    // pullback or nosedive. Two checks, both must agree:
    //
    //   1. m5Ch > 0  — DexScreener confirms positive 5-min momentum at scan time
    //   2. priceHistory rising — if we have live price readings for this coin,
    //      the most recent reading must be ≥ the reading 2 ticks ago (6 seconds).
    //      This catches coins that peaked between scans and are now coming down.
    //
    // Exception: Bottom Bounce (id=0) is designed to enter on oversold recovery —
    // it can have a slightly negative m5 as the coin is stabilising. Allow m5Ch ≥ -3%.
    // Strategy 5 (Pump Spec) enters on pullbacks — allow m5Ch down to -5% when s5 is open.
    // All other strategies require m5Ch ≥ -1% (no meaningful decline allowed).
    // MIN: -20% threshold (was -1%) — essentially disabled; raise incrementally
    if (m5Ch !== null && m5Ch < -1) {
      return rej('mom'); // −1% m5 floor — bot must not enter a falling coin (restored Nov-14)
    }

    const liveHist = priceHistory.get(addr) || [];
    if (liveHist.length >= 3) {
      const newest = liveHist[liveHist.length - 1]?.price;
      const older  = liveHist[liveHist.length - 3]?.price; // ~6 seconds ago
      if (newest && older && newest < older * 0.995) return rej('live'); // 0.5% live dip floor — price must not be falling between scans (restored Nov-14)
    }
  } // end globalGatesBypass check

  const base = {
    addr, price, liq, mcap, vol24, buyPct, buys24, ch1, ch6, ch24, m5Ch, m5Txns,
    m5Buys, m5Vol, m5BuyRate, avgTrade, mcLiqRatio, mcSweetSpot,
    ageDays, ageMinutes, volMcap,
    symbol: pair.baseToken?.symbol || '???',
    name:   pair.baseToken?.name   || '',
    chain:  pair.chainId || 'unknown',
    dexUrl: `https://dexscreener.com/${pair.chainId}/${addr}`,
    isPumpFun,
    dexId,          // Nov-12: propagate dexId so filterByLpLock gate 3.5 (PumpSwap pass-through) can read it
    pairAddress: pair.pairAddress || '', // pair/pool address — used by GeckoTerminal OHLCV fetch
  };

  // Try each open strategy, return first match with highest confidence
  const matches = [];

  for (const s of openStrategies) {
    if (s.disabled) continue; // Nov-18: skip strategies disabled in STRATEGIES definition
    let score = 50;
    let match = true;

    if (s.id === 0) {
      // ── BOTTOM BOUNCE — Path A only (Nov-9 overhaul) ────────────────────
      // Nov-11: pump.fun/PumpSwap coins now allowed — all strategies compete freely.
      // BB is ONLY for genuine oversold recovery: coin crashed 20–85%,
      // h1 turning up, m5 actively bouncing NOW with strong buyer conviction.
      if (strategyFiltersActive) {
        if (s.minAgeDays != null && ageDays < s.minAgeDays) { match = false; } // ≥ 1h — PS takes the sub-1h coins
        if (match) match = ch24 <= s.maxCh24           // genuinely crashed (ch24 ≤ –20%)
             && ch24 >= s.minCh24           // not a dead coin (≥ –85%)
             && ch1 >= s.minCh1             // h1 turning — not in freefall
             && ch1 <= s.maxCh1             // h1 not already mooned
             && (s.minCh6 == null || ch6 >= s.minCh6)
             && m5Ch >= s.minM5Ch           // ACTIVELY bouncing in last 5 min (≥+1.5%)
             && buyPct >= s.minBuyPct       // strong buyer dominance (≥65%)
             && liq >= s.minLiqLocked       // relaxed floor — filterByLpLock enforces strict floor for unlocked LP
             && m5Txns >= s.minM5Txns;
      }
      // Nov-18: scoring runs regardless of strategyFiltersActive (matches AM/SC/OR pattern)
      // so BB competes fairly in diagnostic mode instead of always scoring 0
      if (match) {
        // Classic oversold: score on depth of drop + reversal strength
        score += Math.min(20, Math.abs(ch24) / 4);
        if (m5Ch > 3)    score += 15; else if (m5Ch > 1.5) score += 8;
        if (buyPct > 70) score += 15; else if (buyPct > 65) score += 8;
        if (m5Txns > 25) score += 10; else if (m5Txns > 12) score += 5;
        if (liq > 50000) score += 8;  else if (liq > 25000) score += 4;
        if (ch1 > 2)     score += 10; // confirmed reversal underway
        if (volMcap > 0.3) score += 5;
        if (mcSweetSpot) score += 10;
        if (avgTrade !== null) {
          if (avgTrade > 80) score += 5;
          else if (avgTrade < 30) score -= 10;
        }
      }
    }

    else if (s.id === 1) {
      // ── ACTIVE MOMENTUM ────────────────────────────────────────────────────
      // Nov-11: pump.fun/PumpSwap coins now allowed — all strategies compete freely.
      // Nov-19: always-on guards — apply even when strategy filters bypassed
      if (s.minAgeMinutes != null && ageMinutes < s.minAgeMinutes) { match = false; } // 5-min rug-at-birth floor
      if (s.maxMcap       != null && mcap       > s.maxMcap)       { match = false; } // $500k mcap cap
      if (strategyFiltersActive) {
        if (s.minAgeDays    != null && ageDays    < s.minAgeDays)    { match = false; } // 2h+ only — SC covers 0–24h
        if (s.maxAgeDays    != null && ageDays    > s.maxAgeDays)    { match = false; } // age upper cap (AM has none)
        if (m5Txns < s.minM5Txns)  { match = false; }
        if (m5Ch < s.minM5Ch)      { match = false; } // POSITIVE direction required (was abs)
        if (ch1 < s.minCh1)        { match = false; }
        if (s.maxCh1 != null && ch1 > s.maxCh1) { match = false; } // already ran too hard — buying the top
        if (buyPct < s.minBuyPct)  { match = false; }
        if (liq < s.minLiqLocked)  { match = false; } // relaxed floor — strict floor enforced in filterByLpLock for unlocked LP
        // Anti-manipulation: require meaningful avg trade size (from strategy definition)
        if (s.minAvgTrade != null && avgTrade !== null && avgTrade < s.minAvgTrade) { match = false; }
      }
      if (match) {
        score += Math.min(20, m5Txns / 2);         // very active = more confidence
        if (m5Ch > 5)  score += 15; else if (m5Ch > 2) score += 8;
        if (buyPct > 65) score += 15; else if (buyPct > 58) score += 8;
        // Nov-18: ch1 scoring flipped — reward EARLY moves, penalise LATE ones.
        // A coin up 5–15% in the last hour is just starting; up 25%+ has likely peaked.
        if      (ch1 > 25) score -= 8;   // near exhaustion — penalise even though maxCh1=35 still allows it
        else if (ch1 > 15) score += 5;   // mid-move: moderate reward
        else if (ch1 >  5) score += 12;  // sweet spot — move just breaking out
        else if (ch1 >  2) score += 4;   // early stir
        // (ch1 ≤ 2 or negative: no bonus — wait for momentum confirmation)
        if (liq > 30000) score += 8; else if (liq > 15000) score += 4;
        if (volMcap > 1) score += 10; else if (volMcap > 0.4) score += 5;
        // MC sweet spot + avg trade quality
        if (mcSweetSpot) score += 10;
        if (avgTrade !== null) {
          if (avgTrade > 80) score += 5;
          else if (avgTrade < 30) score -= 10;
        }
      }
    }

    else if (s.id === 2) {
      // ── SURGE CATCH ────────────────────────────────────────────────────────
      // Nov-11: pump.fun/PumpSwap coins now allowed — all strategies compete freely.
      // Primary signal: m5 activity — catch it WHILE it's happening
      // Nov-19: always-on guard — apply even when strategy filters bypassed
      if (s.maxMcap != null && mcap > s.maxMcap) { match = false; } // $500k mcap cap
      if (strategyFiltersActive) {
        if (s.minAgeDays != null && ageDays < s.minAgeDays) { match = false; } // ≥ 1h — PS takes the sub-1h coins
        if (s.maxAgeDays != null && ageDays > s.maxAgeDays) { match = false; } // over 24h → AM
        if (m5Ch < s.minM5Ch)      { match = false; } // must be moving in last 5 min
        if (m5Txns < s.minM5Txns)  { match = false; } // must be very active
        if (ch1 < s.minCh1)        { match = false; } // h1 confirms uptrend
        if (buyPct < s.minBuyPct)  { match = false; }
        if (liq < s.minLiqLocked)  { match = false; } // relaxed floor — strict floor enforced in filterByLpLock for unlocked LP
        // Stricter anti-manipulation for Surge Catch (high-risk, bot-targeted strategy)
        if (avgTrade !== null && avgTrade < ANTI_MANIP_SC_AVG_TRADE) { match = false; }
        if (m5Txns > ANTI_MANIP_SC_TXNS_MAX)                         { match = false; }
        if (mcLiqRatio > ANTI_MANIP_MC_LIQ_RATIO_MAX_LOCKED)         { match = false; } // 40× gate — filterByLpLock tightens to 30× for unlocked LP
      }
      if (match) {
        score += Math.min(25, m5Ch * 3);             // bigger m5 move = higher score
        if (m5Txns > 50) score += 15; else if (m5Txns > 30) score += 10; else if (m5Txns > 20) score += 5;
        if (buyPct > 70) score += 15; else if (buyPct > 62) score += 8;
        if (m5Ch > 10)   score += 12; else if (m5Ch > 5) score += 7;   // speed of surge
        if (ch1 > 20)    score += 8;  else if (ch1 > 8)  score += 4;   // h1 momentum bonus
        if (liq > 20000) score += 6;  else if (liq > 8000) score += 3;
        // Penalty: volume/mcap ratio too extreme = possible wash trading
        if (volMcap > 10) score -= 10;
        // NOTE: No range-spike scoring penalty for Surge Catch.
        // A genuine surge WILL have high ch1 relative to ch24 — penalising that ratio
        // directly blocks the pattern this strategy is designed to catch.
        // Range-top protection is handled in the entry loop via priceHistory.
        // MC sweet spot + avg trade quality
        if (mcSweetSpot) score += 10;
        if (avgTrade !== null) {
          if (avgTrade > 80) score += 5;
          else if (avgTrade < 50) score -= 5; // SC requires cleaner signal
        }
      }
    }

    else if (s.id === 3) {
      // ── OLD RECOVERY ───────────────────────────────────────────────────────
      // Nov-11: pump.fun/PumpSwap coins now allowed — all strategies compete freely.
      // Nov-12: minAgeDays = 1 — any coin ≥ 1 day old qualifies for Old Recovery.
      if (strategyFiltersActive) {
        if (ageDays < s.minAgeDays)  { match = false; }
        if (ch24 < s.minCh24)        { match = false; }
        if (ch1 < s.minCh1)          { match = false; }
        if (ch1 > s.maxCh1)          { match = false; } // spike guard
        if (s.minCh6 != null && ch6 < s.minCh6) { match = false; } // 6h sustained momentum
        // Enter quickly when momentum is live — m5 must also be positive right now
        if (s.minM5Ch != null && m5Ch < s.minM5Ch) { match = false; }
        if (buyPct < s.minBuyPct)    { match = false; }
        if (liq < s.minLiqLocked)    { match = false; } // relaxed floor — strict floor enforced in filterByLpLock for unlocked LP
        if (buys24 < s.minBuys24)    { match = false; }
        if (s.minAvgTrade != null && avgTrade !== null && avgTrade < s.minAvgTrade) { match = false; } // real buyers only
      }
      if (match) {
        score += Math.min(15, ch24 / 3);
        if (ch1 > 8)  score += 12; else if (ch1 > 3) score += 6;
        if (buyPct > 55) score += 10; else if (buyPct > 50) score += 5;
        if (liq > 150000) score += 12; else if (liq > 40000) score += 7;
        if (buys24 > 100) score += 10; else if (buys24 > 50) score += 5;
        if (volMcap > 0.05) score += 5;
        // MC sweet spot + avg trade quality
        if (mcSweetSpot) score += 10;
        if (avgTrade !== null) {
          if (avgTrade > 80) score += 5;
          else if (avgTrade < 30) score -= 10;
        }
      }
    }

    else if (s.id === 4) {
      // ── PUMP SPECULATIVE (pump.fun + PumpSwap on pullback) ────────────────
      // pump.fun bonding-curve OR PumpSwap graduated coins only.
      const isPumpSwap = ['pumpswap','pump_amm','pump-amm','pump_swap','pump-swap'].includes(dexId);
      if (!isPumpFun && !isPumpSwap) {
        match = false;
      } else {
        // Nov-19: always-on guard — apply even when strategy filters bypassed
        if (s.minAgeMinutes != null && ageMinutes < s.minAgeMinutes) { match = false; } // 5-min rug-at-birth floor
        if (strategyFiltersActive) {
          // < 1 hour only — older coins route to SC/AM
          if (s.maxAgeDays    != null && ageDays    > s.maxAgeDays)    { match = false; }
          // h1 must be strongly up — confirms an uptrend is running
          if (ch1 === null || ch1 < s.minH1Ch)              { match = false; }
          // m5 in pullback zone — not at the peak, not in freefall
          if (m5Ch < s.minM5Ch || m5Ch > s.maxM5Ch)         { match = false; }
          // at least one sell — confirms real 2-sided trading (not 100% buy-only pump)
          if (m5Sells < (s.minM5Sells || 1))                 { match = false; }
          if (buyPct < s.minBuyPct)                          { match = false; }
          if (m5Txns < s.minM5Txns)                          { match = false; }
          if (liq < s.minLiq)                                { match = false; }
          if (mcLiqRatio > s.maxMcLiqRatio)                  { match = false; }
        }
      } // end else (isPumpFun || isPumpSwap)

      if (match) {
        score += Math.min(20, m5Txns * 2);           // activity confidence
        if (ch1 > 20)   score += 15; else if (ch1 > 10) score += 8;
        if (buyPct > 70) score += 10; else if (buyPct > 60) score += 5;
        // Shallow pullback is the ideal entry (-2% to 0% m5)
        if (m5Ch >= -2 && m5Ch <= 0) score += 10;
        else if (m5Ch > 0 && m5Ch <= 1) score += 6; // modest positive fine too
        if (mcSweetSpot) score += 10;
        if (liq > 10000) score += 5; else if (liq > 5000) score += 2;
        if (avgTrade !== null) {
          if (avgTrade > 50) score += 5;
          else if (avgTrade < 10) score -= 5;
        }
      }
    }

    if (match) {
      score = Math.max(0, Math.min(100, Math.round(score)));
      matches.push({ strategy: s, score, ...base });
    }
  }

  if (matches.length === 0) return rej('noMatch');
  // Return the highest-scoring match
  matches.sort((a, b) => b.score - a.score);
  return matches[0];
}

// ─── STATE ────────────────────────────────────────────────────────────────────
const enteredToday       = new Set();
const alertCooldown      = new Map(); // set only on actual entry — guards the 30-min re-entry window
const pausedAlertCooldown = new Map(); // set on pause-mode signals — separate so it never blocks auto-entry
// Manual-mode alert windows: addr → { count, windowStart, coin, s, skipped }
// Up to 3 alerts per 5-min window; re-opens after window expires.
const manualAlertState  = new Map();
const MANUAL_WINDOW_MS  = 5 * 60 * 1000;   // 5-min window per token
const MANUAL_MAX_ALERTS = 3;               // max alerts within that window
// Block re-entry for 6h after SL or rug — prevents the triple-entry bug
// (address → timestamp of SL/rug close)
const recentSLCoins = new Map();
// Jupiter quote failure cooldown — after 2 consecutive scan-level failures, skip token 30 min
// Prevents retrying tokens Jupiter persistently can't route (empty-body 500s)
const quoteFailCooldown      = new Map(); // addr → { count: number, until: number }
const QUOTE_FAIL_COOLDOWN_MS = 30 * 60 * 1000; // 30-min block
const QUOTE_FAIL_THRESHOLD   = 1;               // block after first failure — new coins rarely recover within minutes
// Jito bundle failure cooldown — after 2 consecutive bundle failures, skip token 30 min
// Prevents spamming tokens whose swap TX Jito consistently rejects
const jitoBundleCooldown      = new Map(); // addr → { count: number, until: number }
const JITO_FAIL_COOLDOWN_MS   = 30 * 60 * 1000;
const JITO_FAIL_THRESHOLD     = 2;
// Guards against concurrent-tick races: positions currently being closed
// (added before the async Firestore write; cleared when done)
const closingNow    = new Set();
// Pullback watchlist — BB (id=0) and OR (id=3) coins wait here for support→bounce
// before entering. Each entry: { qualifiedAt, qualifiedPrice, low, inFlatZone, coin, expiry }
const pullbackWatchlist = new Map();
const SL_BLOCK_MS   = 6 * 60 * 60 * 1000; // 6 hours
let scanCount = 0;
// Daily loss limit state — set true when limit hit, cleared on /restart
let dayHaltedToday      = false;
let globalGatesBypass   = false; // /skipgates toggle — bypasses all global filters for diagnostics
let tierGateBypass      = false; // /skiptiers toggle — bypasses tiered entry gates only (default ON)
let lpLockBypass        = false; // /skiplp toggle  — bypasses filterByLpLock() for diagnostics
let autoEntryPaused     = false; // /pauseentry toggle — signals alert but bot skips auto-entry
let slTrailMode         = '30';  // /slbase toggle — SL trail base: '30' = tight 6-phase | '50' = wide phase
let telegramOffset      = 0; // for Telegram command polling

// ─── TREND-CONFIRMED ADDRESSES (partial-auto mode) ───────────────────────────
// Coins that have been in a position (any exit — TP or SL) are added here.
// In manual mode, these coins bypass the manual gate and auto-enter if they
// re-qualify through normal scan filters ("partial auto" behaviour).
// Populated from today's history on startup; updated live on every close.
const trendConfirmedAddrs = new Set();

// ─── TRADING PERIODS ──────────────────────────────────────────────────────────
// 4 non-overlapping UTC windows. autoMode=true → bot switches to AUTO at boundary.
// autoMode=false → bot switches to MANUAL. User can override within a period;
// the next boundary always resets to the period's default.
const TRADING_PERIODS = [
  {
    key: 'noise', name: 'Noise Period', emoji: '🔴', color: 'red',
    startH: 0,  startM: 0,  endH: 8,  endM: 0,
    autoMode: false, recommendation: 'Manual',
    description: 'Asia-only hours. Low volume, pump-and-dump micro-caps, bonding curve traps common.',
    tip: 'Pick your own coins — bot stays alert.',
  },
  {
    key: 'moderate', name: 'Moderate Period', emoji: '🟡', color: 'yellow',
    startH: 8,  startM: 0,  endH: 13, endM: 30,
    autoMode: false, recommendation: 'Manual',
    description: 'EU morning. Moderate activity, inconsistent quality, caution advised.',
    tip: 'Watch signals closely before entering.',
  },
  {
    key: 'quality', name: 'Quality Window', emoji: '🟢', color: 'green',
    startH: 13, startM: 30, endH: 22, endM: 0,
    autoMode: true, recommendation: 'Auto',
    description: 'US market hours. Real momentum tokens, best volume and liquidity.',
    tip: 'Bot catches qualifying coins as they launch.',
  },
  {
    key: 'latenight', name: 'Late Night', emoji: '🟡', color: 'yellow',
    startH: 22, startM: 0,  endH: 24, endM: 0,
    autoMode: true, recommendation: 'Auto',
    description: 'US evening session. Second wave of activity.',
    tip: 'Bot watches while you sleep.',
  },
];
let lastAnnouncedPeriodKey = null; // restored from Firestore on startup

function getCurrentTradingPeriod() {
  const now  = new Date();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  for (const p of TRADING_PERIODS) {
    const start = p.startH * 60 + p.startM;
    const end   = p.endH === 24 ? 1440 : p.endH * 60 + p.endM;
    if (mins >= start && mins < end) return p;
  }
  return TRADING_PERIODS[0]; // fallback
}

function fmtUtcTime(h, m) {
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

async function checkTradingPeriod() {
  try {
    const period = getCurrentTradingPeriod();
    if (period.key === lastAnnouncedPeriodKey) return; // no change, nothing to do
    lastAnnouncedPeriodKey = period.key;

    // Auto-switch entry mode to this period's default
    autoEntryPaused = !period.autoMode;
    _tradingCfg = null; // bust config cache
    await db.collection('paper_config').doc('control').set({
      autoEntryPaused,
      currentPeriod: {
        key:            period.key,
        name:           period.name,
        emoji:          period.emoji,
        color:          period.color,
        recommendation: period.recommendation,
        description:    period.description,
        tip:            period.tip,
        autoMode:       period.autoMode,
        activeSince:    Date.now(),
      },
    }, { merge: true });

    const modeStr  = autoEntryPaused ? '🖐 MANUAL' : '🤖 AUTO';
    const override = period.autoMode ? '/manual to override' : '/auto to override';
    await sendTelegram(
      `${period.emoji} *${period.name.toUpperCase()}* — ${fmtUtcTime(period.startH, period.startM)} UTC\n\n` +
      `${period.description}\n\n` +
      `Bot switched to *${modeStr}*.\n` +
      `_${period.tip}_\n\n` +
      `Send /${period.autoMode ? 'manual' : 'auto'} to override.`
    );
  } catch(e) {
    console.error('[BOT] checkTradingPeriod error:', e.message);
  }
}

// ─── POSITION CACHE ───────────────────────────────────────────────────────────
// Reduces Firestore reads from ~250K/day to ~1.5K/day
// Full re-query every 60s; individual updates/closes patch in-place.
let _posCache   = null;
let _posCacheAt = 0;
const POS_TTL   = 60000; // 60 seconds between full re-queries

// ─── TRADING CONFIG CACHE ─────────────────────────────────────────────────────
// paper_config/control + paper_config/wallets cached for 30s
let _tradingCfg    = null;
let _tradingCfgAt  = 0;
let _walletsCache  = null;
let _walletsCacheAt = 0;
const CFG_TTL      = 30000; // 30s

// ─── DAILY STATS CACHE ───────────────────────────────────────────────────────
// getDailyStats() reads Firestore on every call — caching it for 60s means
// the monitor interval (PRICE_CHECK) no longer drives Firestore read volume.
// updateDailyStats() busts this cache so fresh P&L is always written correctly.
let _statsCache   = null;
let _statsCacheAt = 0;
const STATS_TTL   = 60000; // 60s

// ─── TRENDING CACHE ───────────────────────────────────────────────────────────
// addr (lowercase) → count of trending platforms it appears on (pump.fun + Birdeye)
// DexScreener boost addresses are merged in per-scan inside scanForEntries().
// Refreshed every 5 min; stale cache is used rather than blocking a scan.
let trendingAddrs     = new Map();
let trendingLastFetch = 0;
const TRENDING_TTL_MS = 5 * 60 * 1000; // refresh every 5 min

// ─── CANDIDATE POOL CACHE ────────────────────────────────────────────────────
// DexScreener fetching decoupled from evaluation:
//   refreshCandidatePool() — runs every 3 min, makes 100+ API calls
//   scanForEntries()       — runs every 15s, evaluates cached pool only
// Fixes rate-limiting (429 → silent 0 candidates) caused by 400+ req/min.
let _candidatePool    = [];      // cached DexScreener pairs
let _candidatePoolMap = new Map(); // cached trending map (addr → platform count)
let _candidatePoolAt  = 0;       // last refresh timestamp (ms)
const CANDIDATE_POOL_TTL = 3 * 60 * 1000; // refresh every 3 minutes

async function getTradingConfig() {
  const now = Date.now();
  if (_tradingCfg && now - _tradingCfgAt < CFG_TTL) return _tradingCfg;
  try {
    const doc = await db.collection('paper_config').doc('control').get();
    _tradingCfg   = doc.exists ? doc.data() : {};
    _tradingCfgAt = now;
  } catch { _tradingCfg = _tradingCfg || {}; }
  return _tradingCfg;
}

// Persist bypass flag state to Firestore so it survives restarts.
// Stored in paper_config/control as: gatesOpen, lpOpen, stratsSkipped
async function saveBypassFlags() {
  try {
    _tradingCfg = null; // bust config cache so next read picks up fresh values
    await db.collection('paper_config').doc('control').set({
      gatesOpen:        globalGatesBypass,
      tierGateOpen:     tierGateBypass,
      lpOpen:           lpLockBypass,
      stratsSkipped:    !strategyFiltersActive,
      autoEntryPaused:  autoEntryPaused,
      diagnosticMode:   diagnosticMode,
      diagnosticReal:   diagnosticReal,
      diagTradeCount:   diagnosticTradeCount,
      slTrailMode:      slTrailMode,
    }, { merge: true });
  } catch(e) {
    console.warn('[BOT] Could not persist bypass flags:', e.message);
  }
}

// Returns active wallets array, sorted by envKey (WALLET_1 first)
async function getWallets() {
  const now = Date.now();
  if (_walletsCache && now - _walletsCacheAt < CFG_TTL) return _walletsCache;
  try {
    const snap = await db.collection('paper_config').doc('wallets').collection('slots').get();
    _walletsCache = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(w => w.active !== false)
      .sort((a, b) => (a.envKey || '').localeCompare(b.envKey || ''));
    _walletsCacheAt = now;
  } catch { _walletsCache = _walletsCache || []; }
  return _walletsCache;
}

// Normalise DexScreener chainId → wallet chain key
function normaliseChain(chainId = '') {
  const c = chainId.toLowerCase();
  if (c === 'solana')                          return 'solana';
  if (c === 'ethereum' || c === 'eth')         return 'ethereum';
  if (c === 'bsc' || c === 'binance-smart-chain') return 'bsc';
  if (c === 'base')                            return 'base';
  if (c === 'arbitrum' || c === 'arbitrum-one') return 'arbitrum';
  return c; // passthrough for anything else
}

// Auto-select the best wallet for a given chain.
// Preference order: manually pinned override → first matching active wallet
async function selectWalletForChain(chain, cfg) {
  const wallets = await getWallets();
  const matching = wallets.filter(w => normaliseChain(w.chain) === chain && w.active !== false);
  if (!matching.length) return null;

  // Check manual override in config: cfg.activeWalletId[chain]
  const overrides = cfg.activeWalletId || {};
  if (overrides[chain]) {
    const pinned = matching.find(w => w.id === overrides[chain]);
    if (pinned) return pinned;
  }
  return matching[0]; // first active wallet for this chain
}

// Check if trader has queued an "add funds" request and apply it.
// Paper mode: credits virtual balance. Real mode: logs the deposit for records.
async function checkAddFunds(cfg) {
  const amount = parseFloat(cfg.addFunds || 0);
  if (!amount || amount <= 0) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const newBalance = (parseFloat(cfg.paperBalance || 0)) + amount;

    // Credit the virtual balance and update today's start balance
    await db.collection('paper_config').doc('control').update({
      paperBalance: newBalance,
      addFunds: 0,
      lastFundsAddedAt: Date.now(),
    });
    const { stats: _statsCol } = await getCollections();
    await db.collection(_statsCol).doc(today).set(
      { startBalance: newBalance, fundsAdded: FieldValue.increment(amount) },
      { merge: true }
    );
    _tradingCfg = null; // bust cache so new balance is picked up

    const modeLabel = (cfg.tradingMode || 'paper') === 'real' ? 'Real' : 'Paper';
    await sendTelegram(
      `💵 *FUNDS ADDED — ${modeLabel} Mode*\n\n` +
      `Added: *+$${amount.toFixed(2)}*\n` +
      `New balance: *$${newBalance.toFixed(2)}*`
    );
    console.log(`[BOT] Funds added: +$${amount} → balance $${newBalance}`);
  } catch(e) {
    console.error('[BOT] checkAddFunds error:', e.message);
  }
}

// ─── REAL TRADE EXECUTION — Solana via Jupiter ────────────────────────────────
// Private key in Fly.io secret: process.env[wallet.envKey + '_PRIVATE_KEY']
// Supports base58 string (Phantom export) or JSON uint8 array.
// EVM chains (ETH/BSC/Base) remain paper-only for now.

const SOL_MINT  = 'So11111111111111111111111111111111111111112'; // Wrapped SOL
const SOL_RPC   = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

// ─── JITO BUNDLE CONFIG ──────────────────────────────────────────────────────
// Jito bundles submit transactions directly to the block leader, bypassing the
// public mempool. This prevents front-running and sandwich attacks entirely —
// bots cannot see the transaction to attack it because it never enters the mempool.
//
// Tip is set dynamically: the bot queries Jito's live tip floor API every 30s
// and pays the 75th-percentile of recent winning bundles — enough to beat 75%
// of competing bots without overpaying during quiet periods.
// Hard floor: 10,000 lamports | Hard cap: 500,000 lamports (~$0.10 at $200/SOL)
const JITO_BLOCK_ENGINE   = 'mainnet.block-engine.jito.labs.io';
const JITO_TIP_FLOOR_HOST = 'bundles.jito.wtf';
const JITO_TIP_MIN        = 10_000;   // always pay at least this
const JITO_TIP_MAX        = 500_000;  // never pay more than this (~$0.10)
const JITO_TIP_TTL        = 30_000;   // refresh tip floor every 30s
let _jitoTip    = JITO_TIP_MIN;       // starts at floor; updated by fetchJitoTip()
let _jitoTipAt  = 0;

// Fetches Jito's live tip floor and sets _jitoTip to the 75th percentile.
// Called automatically before every bundle submission.
async function fetchJitoTip() {
  const now = Date.now();
  if (now - _jitoTipAt < JITO_TIP_TTL) return; // still fresh
  _jitoTipAt = now;
  try {
    const r = await httpGet(JITO_TIP_FLOOR_HOST, '/api/v1/bundles/tip_floor');
    const data = JSON.parse(r.body);
    // API returns an array; take the first (most recent) entry
    const entry = Array.isArray(data) ? data[0] : data;
    // Use 75th percentile — beats 75% of competing bots right now
    const p75 = entry?.landed_tips_75th_percentile || JITO_TIP_MIN;
    _jitoTip = Math.max(JITO_TIP_MIN, Math.min(JITO_TIP_MAX, Math.ceil(p75)));
    console.log(`[JITO] Tip floor updated: ${_jitoTip} lamports (p75=${p75})`);
  } catch(e) {
    console.log(`[JITO] Tip floor fetch failed — using ${_jitoTip}: ${e.message}`);
    // Keep last known value; don't reset to floor (avoids under-tipping during API hiccups)
  }
}

// 8 known Jito tip accounts — one is chosen at random per bundle
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvB6pMFUFbTYPMoqnsmjQVFgFGSJ5noTW5',
  'Cw8CFyM9FkoMi7K9DP1KMHJuq3A9SvivXoK8wL9K7T3e',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1sMaC9jNkiN',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

function parseSolanaKeypair(privKeyStr) {
  if (!SolanaWeb3 || !bs58) throw new Error('@solana/web3.js not installed');
  // Try base58 first (Phantom export)
  try {
    const decoded = bs58.decode(privKeyStr.trim());
    return SolanaWeb3.Keypair.fromSecretKey(decoded);
  } catch(_) {}
  // Try JSON uint8 array
  try {
    return SolanaWeb3.Keypair.fromSecretKey(new Uint8Array(JSON.parse(privKeyStr)));
  } catch(e) {
    throw new Error(`Cannot parse Solana private key: ${e.message}`);
  }
}

async function getSolPriceUsd() {
  try {
    const r = await httpGet('api.dexscreener.com', `/latest/dex/tokens/${SOL_MINT}`);
    const d = JSON.parse(r.body);
    const pairs = (d.pairs || []).filter(p => p.chainId === 'solana');
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const p = parseFloat(pairs[0]?.priceUsd || 0);
    return p > 0 ? p : 160; // sensible fallback
  } catch { return 160; }
}

async function jupiterQuote(inputMint, outputMint, amountLamports, slippageBps = 100) {
  // v1 endpoint covers newer tokens; API key doubles rate limit (1 req/s vs 0.5)
  const jupHost    = 'api.jup.ag';
  const jupHeaders = process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {};
  const path = `/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`;
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY  = 600; // ms between retries — covers transient 500s
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await httpGet(jupHost, path, jupHeaders);
      if (r.status === 200) return JSON.parse(r.body);
      const bodySnip = r.body ? String(r.body).slice(0, 300) : '(empty)';
      console.error(`[JUPITER] Quote HTTP ${r.status} (attempt ${attempt}/${MAX_ATTEMPTS}) | body: ${bodySnip}`);
      // Only retry on server-side errors (5xx) — 4xx errors won't resolve with a retry
      if (r.status < 500 || attempt === MAX_ATTEMPTS) return null;
      await sleep(RETRY_DELAY);
    } catch(e) {
      console.error(`[JUPITER] Quote error (attempt ${attempt}/${MAX_ATTEMPTS}):`, e.message);
      if (attempt === MAX_ATTEMPTS) return null;
      await sleep(RETRY_DELAY);
    }
  }
  return null;
}

async function jupiterGetSwapTx(quote, walletPublicKey) {
  try {
    const body = JSON.stringify({
      quoteResponse: quote,
      userPublicKey: walletPublicKey,
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: 'auto', // let Jupiter calculate the optimal priority fee
    });
    // v1 quote + v1 swap — consistent pair; transactions submitted via direct RPC (no Jito)
    const swapHeaders = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (process.env.JUPITER_API_KEY) swapHeaders['x-api-key'] = process.env.JUPITER_API_KEY;
    const r = await new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.jup.ag',
        path: '/swap/v1/swap',
        method: 'POST',
        headers: swapHeaders,
        timeout: 15000,
      }, (res) => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', (e) => { console.error('[JUPITER] Swap network error:', e.message); resolve({ status: 500, body: '{}' }); });
      req.on('timeout', () => { req.destroy(); console.error('[JUPITER] Swap timeout'); resolve({ status: 504, body: '{}' }); });
      req.write(body); req.end();
    });
    if (r.status !== 200) { console.error('[JUPITER] Swap HTTP', r.status, r.body.slice(0,200)); return null; }
    return JSON.parse(r.body).swapTransaction; // base64-encoded VersionedTransaction
  } catch(e) { console.error('[JUPITER] Swap error:', e.message); return null; }
}

// ─── JITO BUNDLE SENDER ──────────────────────────────────────────────────────
// Sends a Jupiter swap transaction as a 2-tx Jito bundle:
//   tx[0] — the Jupiter swap (provided as base64 from Jupiter API)
//   tx[1] — a SOL tip transfer to a random Jito tip account
//
// Both transactions are signed with the same keypair and submitted together to
// the Jito block engine. The bundle bypasses the public mempool entirely, which
// prevents front-running and sandwich attacks.
//
// On success, returns the base58 transaction signature of the swap tx.
// On failure, throws — caller should log and surface as paper trade fallback.
async function sendViaJitoBundle(swapTxBase64, keypair) {
  const { Connection, VersionedTransaction, Transaction, SystemProgram, PublicKey } = SolanaWeb3;
  const connection = new Connection(SOL_RPC, 'confirmed');

  // 0. Refresh the dynamic tip (no-op if still fresh within 30s)
  await fetchJitoTip();
  const tipLamports = _jitoTip;

  // 1. Sign the Jupiter swap transaction
  const swapBuf = Buffer.from(swapTxBase64, 'base64');
  const swapTx  = VersionedTransaction.deserialize(swapBuf);
  swapTx.sign([keypair]);

  // 2. Build tip transaction (legacy tx — plain SOL transfer to Jito tip account)
  const tipAcctPubkey = new PublicKey(
    JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
  );
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tipTx = new Transaction({ recentBlockhash: blockhash, feePayer: keypair.publicKey });
  tipTx.add(SystemProgram.transfer({
    fromPubkey: keypair.publicKey,
    toPubkey:   tipAcctPubkey,
    lamports:   tipLamports,
  }));
  tipTx.sign(keypair);

  // 3. Serialize both as base58 (Jito bundle API format)
  const swapSerialized = bs58.encode(Buffer.from(swapTx.serialize()));
  const tipSerialized  = bs58.encode(Buffer.from(tipTx.serialize()));

  // 4. Submit bundle to Jito block engine
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'sendBundle',
    params: [[swapSerialized, tipSerialized]],
  });

  const jitoResult = await new Promise((resolve) => {
    const req = https.request({
      hostname: JITO_BLOCK_ENGINE,
      path: '/api/v1/bundles',
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 15000,
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error',   (e) => { console.error('[JITO] Network error:', e.message); resolve({ status: 500, body: '{}' }); });
    req.on('timeout', () => { req.destroy(); console.error('[JITO] Timeout'); resolve({ status: 504, body: '{}' }); });
    req.write(body); req.end();
  });

  if (jitoResult.status !== 200) {
    throw new Error(`Jito bundle HTTP ${jitoResult.status}: ${jitoResult.body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(jitoResult.body);
  if (parsed.error) throw new Error(`Jito bundle rejected: ${parsed.error.message || JSON.stringify(parsed.error)}`);
  const bundleId = parsed.result;
  console.log(`[JITO] Bundle submitted: ${bundleId} | tip: ${tipLamports} lamports`);

  // 5. Derive the swap tx signature from the signed transaction
  const sig = bs58.encode(Buffer.from(swapTx.signatures[0]));

  // 6. Confirm the swap transaction (Jito bundles typically land in 1-3 slots ≈ 0.4–1.2s)
  const { value } = await connection.confirmTransaction(
    { signature: sig, ...(await connection.getLatestBlockhash('confirmed')) },
    'confirmed'
  );
  if (value.err) throw new Error(`Jito bundle landed but swap tx failed on-chain: ${JSON.stringify(value.err)}`);

  return sig;
}

// ─── DIRECT RPC SENDER ───────────────────────────────────────────────────────
// Sends a signed Jupiter swap transaction directly via the Solana RPC node.
// Simpler and more reliable than Jito for small trades ($10–$100) where MEV
// risk is negligible. Priority fee is set to 'auto' by Jupiter at quote time.
async function sendViaRpc(swapTxBase64, keypair) {
  const { Connection, VersionedTransaction } = SolanaWeb3;
  const connection = new Connection(SOL_RPC, 'confirmed');

  // Deserialize and sign the Jupiter swap transaction
  const swapBuf = Buffer.from(swapTxBase64, 'base64');
  const swapTx  = VersionedTransaction.deserialize(swapBuf);
  swapTx.sign([keypair]);

  // Submit — skipPreflight false so the RPC validates before forwarding
  const sig = await connection.sendRawTransaction(swapTx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  console.log(`[RPC] Tx sent: https://solscan.io/tx/${sig}`);

  // Wait for confirmation
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const { value } = await connection.confirmTransaction(
    { signature: sig, ...latestBlockhash },
    'confirmed'
  );
  if (value.err) throw new Error(`Tx landed but failed on-chain: ${JSON.stringify(value.err)}`);

  return sig;
}

async function executeRealEntry(coin, wallet, posSize) {
  if (coin.chain !== 'solana') {
    console.warn(`[REAL] Chain "${coin.chain}" not yet supported for real trading. Logging as paper.`);
    return { txHash: null, executedPrice: coin.price, simulated: true };
  }
  if (!SolanaWeb3 || !bs58) return { txHash: null, executedPrice: coin.price, error: 'Solana SDK not installed' };

  const privKeyStr = process.env[`${wallet.envKey}_PRIVATE_KEY`];
  if (!privKeyStr) {
    console.warn(`[REAL] ⚠️  No private key for ${wallet.label} (${wallet.envKey}_PRIVATE_KEY). Trade NOT executed.`);
    return { txHash: null, executedPrice: coin.price, error: 'Missing private key' };
  }

  let keypair;
  try { keypair = parseSolanaKeypair(privKeyStr); }
  catch(e) { return { txHash: null, executedPrice: coin.price, error: e.message }; }

  try {
    const solPrice    = await getSolPriceUsd();
    const solAmount   = posSize / solPrice;
    const lamports    = Math.floor(solAmount * 1e9);
    console.log(`[REAL] ENTRY ${coin.symbol} | $${posSize} = ${solAmount.toFixed(4)} SOL = ${lamports} lamports`);

    // ── PRE-FLIGHT: check wallet balance before attempting swap ───────────
    try {
      const { Connection } = SolanaWeb3;
      const conn = new Connection(SOL_RPC, 'confirmed');
      const walletBalance = await conn.getBalance(keypair.publicKey); // in lamports
      const JITO_TIP_BUFFER = 0.005 * 1e9; // 0.005 SOL reserved for Jito tip + fees
      if (walletBalance < lamports + JITO_TIP_BUFFER) {
        const balSol   = (walletBalance / 1e9).toFixed(4);
        const needSol  = ((lamports + JITO_TIP_BUFFER) / 1e9).toFixed(4);
        const balUsd   = ((walletBalance / 1e9) * solPrice).toFixed(2);
        console.warn(`[REAL] ⚠️  Insufficient balance: have ${balSol} SOL ($${balUsd}), need ${needSol} SOL for $${posSize} + fees`);
        return { txHash: null, executedPrice: coin.price, error: `Insufficient SOL: have $${balUsd}, need $${posSize} + fees` };
      }
    } catch(balErr) {
      console.warn(`[REAL] Balance check failed (proceeding): ${balErr.message}`);
    }

    // ── JUPITER QUOTE COOLDOWN CHECK ─────────────────────────────────────────
    // Skip tokens that have failed Jupiter quote repeatedly — prevents spamming
    // tokens Jupiter can't route (returns {} on 500) on every scan indefinitely.
    const _qfc = quoteFailCooldown.get(coin.addr);
    if (_qfc && Date.now() < _qfc.until) {
      const minsLeft = Math.ceil((_qfc.until - Date.now()) / 60000);
      console.log(`[REAL] ⏸ ${coin.symbol} — Jupiter cooldown active (${minsLeft}m left), skipping entry`);
      return { txHash: null, executedPrice: coin.price, error: 'Jupiter quote cooldown' };
    }

    const quote = await jupiterQuote(SOL_MINT, coin.addr, lamports, 150); // 1.5% slippage
    if (!quote) {
      // Track consecutive failures — block after QUOTE_FAIL_THRESHOLD
      const prev    = quoteFailCooldown.get(coin.addr);
      const prevOk  = !prev || Date.now() >= prev.until; // expired or never set
      const count   = prevOk ? 1 : (prev.count + 1);
      if (count >= QUOTE_FAIL_THRESHOLD) {
        quoteFailCooldown.set(coin.addr, { count, until: Date.now() + QUOTE_FAIL_COOLDOWN_MS });
        console.warn(`[REAL] ⛔ ${coin.symbol} — Jupiter failed ${count}x in a row, cooldown 30 min`);
      } else {
        quoteFailCooldown.set(coin.addr, { count, until: 0 });
        console.warn(`[REAL] ⚠️ ${coin.symbol} — Jupiter quote failed (${count}/${QUOTE_FAIL_THRESHOLD})`);
      }
      return { txHash: null, executedPrice: coin.price, error: 'Jupiter quote failed' };
    }
    quoteFailCooldown.delete(coin.addr); // quote succeeded — clear any failure history

    // ── PRICE IMPACT GUARD — protect capital from thin liquidity ──────────
    const MAX_ENTRY_IMPACT = 0.015; // 1.5% — abort if our buy moves price more than this
    const impactEntry = parseFloat(quote.priceImpactPct || 0);
    if (impactEntry > MAX_ENTRY_IMPACT) {
      const impactStr = (impactEntry * 100).toFixed(2);
      console.warn(`[REAL] ⛔ ENTRY BLOCKED — price impact ${impactStr}% > ${MAX_ENTRY_IMPACT * 100}% threshold for ${coin.symbol}`);
      await sendTelegram(
        `⛔ *ENTRY BLOCKED — High Price Impact*\n\n` +
        `*${coin.symbol}* — our $${posSize} buy would move price by *${impactStr}%*\n` +
        `Liquidity too thin. Skipping to protect capital.`
      );
      return { txHash: null, executedPrice: coin.price, error: `Price impact too high: ${impactStr}%` };
    }

    const tokensOutRaw = quote.outAmount || '0'; // raw units string from Jupiter
    const outDecimals = parseInt(quote.outputDecimals || quote.swapInfo?.outputMint?.decimals || 6, 10);
    const tokenAmountHuman = Number(tokensOutRaw) / (10 ** outDecimals); // human-readable for display only
    // Store raw units string so executeRealExit fallback can pass them directly to Jupiter
    const tokenAmount = tokensOutRaw; // string — Firestore-safe
    console.log(`[REAL] Jupiter: ${solAmount.toFixed(4)} SOL → ${tokenAmountHuman.toLocaleString()} ${coin.symbol} (${tokensOutRaw} raw)`);

    const swapTx = await jupiterGetSwapTx(quote, keypair.publicKey.toBase58());
    if (!swapTx) return { txHash: null, executedPrice: coin.price, error: 'Jupiter swap TX failed' };

    const sig = await sendViaRpc(swapTx, keypair);
    console.log(`[REAL] ✅ ENTRY TX confirmed: https://solscan.io/tx/${sig}`);
    const entryImpactPct = parseFloat(quote.priceImpactPct || 0) * 100;
    return { txHash: sig, executedPrice: coin.price, tokenAmount, tokenDecimals: outDecimals, entryImpactPct, jitoTipUsd: 0 };
  } catch(e) {
    console.error(`[REAL] ENTRY failed for ${coin.symbol}:`, e.message);
    return { txHash: null, executedPrice: coin.price, error: e.message };
  }
}

// Core Solana sell: query wallet balance, sell `sellFrac` of it via Jupiter.
// sellFrac = 1.0 for full exit, 0.5 for half of remaining, etc.
// Used by both full exits (executeRealExit) and partial profit-taking (realPartialSell).
async function executeRealSell(pos, wallet, sellFrac, exitPrice) {
  if (pos.chain !== 'solana') {
    console.warn(`[REAL] Chain "${pos.chain}" not yet supported. Sell logged as paper.`);
    return { txHash: null, executedPrice: exitPrice, simulated: true };
  }
  if (!SolanaWeb3 || !bs58) return { txHash: null, executedPrice: exitPrice, error: 'Solana SDK not installed' };

  const privKeyStr = process.env[`${wallet.envKey}_PRIVATE_KEY`];
  if (!privKeyStr) {
    console.warn(`[REAL] ⚠️  No private key for ${wallet.label}. Sell NOT executed.`);
    return { txHash: null, executedPrice: exitPrice, error: 'Missing private key' };
  }

  let keypair;
  try { keypair = parseSolanaKeypair(privKeyStr); }
  catch(e) { return { txHash: null, executedPrice: exitPrice, error: e.message }; }

  try {
    // ── Query actual wallet token balance (avoids stored wrong-unit amounts) ──
    const { Connection, PublicKey } = SolanaWeb3;
    const connection = new Connection(SOL_RPC, 'confirmed');
    let tokensToSell;
    try {
      const { value: tokenAccounts } = await connection.getParsedTokenAccountsByOwner(
        keypair.publicKey,
        { mint: new PublicKey(pos.address) }
      );
      let rawBalance = BigInt(0);
      for (const acct of tokenAccounts) {
        rawBalance += BigInt(acct.account.data.parsed.info.tokenAmount.amount);
      }
      if (rawBalance === BigInt(0)) {
        console.warn(`[REAL] SELL ${pos.symbol} — zero token balance in wallet (already sold or not received). Skipping.`);
        return { txHash: null, executedPrice: exitPrice, simulated: false, error: 'Zero token balance — already sold?' };
      }
      // Sell the requested fraction of real wallet balance
      tokensToSell = sellFrac >= 1.0
        ? rawBalance
        : rawBalance * BigInt(Math.round(sellFrac * 10000)) / BigInt(10000);
      console.log(`[REAL] SELL ${pos.symbol} | wallet: ${rawBalance} raw → ${(sellFrac*100).toFixed(1)}% = ${tokensToSell}`);
    } catch (balErr) {
      // Fallback: use stored realTokenAmount (string raw units for new positions)
      console.warn(`[REAL] Wallet balance query failed: ${balErr.message}. Falling back to stored realTokenAmount.`);
      const stored = pos.realTokenAmount;
      if (!stored) {
        return { txHash: null, executedPrice: exitPrice, simulated: true, error: `No token amount stored and wallet query failed: ${balErr.message}` };
      }
      try {
        const rawFallback = BigInt(stored); // works for both string "500000000000" and old numeric values
        tokensToSell = sellFrac >= 1.0
          ? rawFallback
          : rawFallback * BigInt(Math.round(sellFrac * 10000)) / BigInt(10000);
      } catch {
        tokensToSell = BigInt(Math.floor(Number(stored) * sellFrac));
      }
      console.log(`[REAL] SELL ${pos.symbol} | fallback stored: ${tokensToSell}`);
    }

    // ── Step 1: probe quote at min slippage to read priceImpactPct ──
    const probeQuote = await jupiterQuote(pos.address, SOL_MINT, tokensToSell.toString(), 200);
    if (!probeQuote) return { txHash: null, executedPrice: exitPrice, error: 'Jupiter quote failed' };

    // ── Step 2: dynamic slippage — 2× impact, min 2%, max 50% ──
    const impactSell = parseFloat(probeQuote.priceImpactPct || 0);
    const dynamicSlippageBps = Math.max(200, Math.min(5000, Math.ceil(impactSell * 20000)));
    const impactStr = (impactSell * 100).toFixed(2);

    let finalQuote = probeQuote;
    if (dynamicSlippageBps > 200) {
      console.log(`[REAL] 🔄 Dynamic slippage for ${pos.symbol}: impact ${impactStr}% → ${dynamicSlippageBps} bps`);
      await sendTelegram(
        `⚠️ *Thin liquidity — ${pos.symbol}*\n\n` +
        `Price impact *${impactStr}%* — adjusting slippage to *${(dynamicSlippageBps / 100).toFixed(1)}%* for sell.`
      ).catch(() => {});
      const reqote = await jupiterQuote(pos.address, SOL_MINT, tokensToSell.toString(), dynamicSlippageBps);
      if (reqote) finalQuote = reqote;
    }

    // ── Step 3: build and send swap TX ──
    const swapTx = await jupiterGetSwapTx(finalQuote, keypair.publicKey.toBase58());
    if (!swapTx) return { txHash: null, executedPrice: exitPrice, error: 'Jupiter swap TX failed' };

    let sig;
    try {
      sig = await sendViaRpc(swapTx, keypair);
    } catch (txErr) {
      // ── Step 4: one retry at 1.5× slippage (block height expired / RPC glitch) ──
      const retryBps = Math.min(5000, Math.ceil(dynamicSlippageBps * 1.5));
      console.warn(`[REAL] ⚠️ Sell TX failed for ${pos.symbol} (${txErr.message}) — retrying at ${retryBps} bps`);
      const retryQuote = await jupiterQuote(pos.address, SOL_MINT, tokensToSell.toString(), retryBps);
      if (!retryQuote) throw txErr;
      const retryTx = await jupiterGetSwapTx(retryQuote, keypair.publicKey.toBase58());
      if (!retryTx) throw txErr;
      sig = await sendViaRpc(retryTx, keypair);
      console.log(`[REAL] ✅ Retry SELL TX succeeded at ${retryBps} bps`);
    }

    console.log(`[REAL] ✅ SELL TX confirmed: https://solscan.io/tx/${sig}`);
    const exitImpactPct = impactSell * 100;
    return { txHash: sig, executedPrice: exitPrice, exitImpactPct, jitoTipUsd: 0 };
  } catch(e) {
    console.error(`[REAL] SELL failed for ${pos.symbol}:`, e.message);
    return { txHash: null, executedPrice: exitPrice, error: e.message };
  }
}

// Full exit wrapper: sells pos.remaining of wallet balance.
async function executeRealExit(pos, wallet, exitPrice) {
  return executeRealSell(pos, wallet, pos.remaining || 1.0, exitPrice);
}

async function getOpenPositions() {
  const now = Date.now();
  if (_posCache && now - _posCacheAt < POS_TTL) return _posCache;
  const { positions } = await getCollections();
  const snap  = await db.collection(positions).where('status','==','open').get();
  _posCache   = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  _posCacheAt = now;
  return _posCache;
}

// Returns only positions that occupy a visible dashboard slot (not backgrounded).
// Backgrounded positions still have SL/TP active but don't count toward MAX_POSITIONS.
async function getVisiblePositions() {
  const all = await getOpenPositions();
  return all.filter(p => !p.backgrounded);
}

// ─── FIREBASE HELPERS ─────────────────────────────────────────────────────────

// ─── PAPER TRADE COST SIMULATION ─────────────────────────────────────────────
// Returns a realistic simulated fill price after fees + slippage.
// Used in paper mode so P&L reflects what a real trade would cost.
//
// DEX fee (Solana): ~0.25% on Jupiter / Raydium (each leg)
// Slippage: estimated from position size vs pool liquidity.
//   positionSize / liquidity:
//     < 0.1%  → ~0.2% slippage   (deep pool)
//     0.1–1%  → ~1%   slippage   (moderate)
//     1–5%    → ~3%   slippage   (thin — price impact hurts)
//     > 5%    → ~3%   slippage   (capped — protects capital floor realism)
//
// Slippage is capped at 3% so that capital-floor exits (SL at entry or above)
// reflect a realistic secured-profit scenario. Max total exit cost: ~3.3%.
function simulateFillPrice(rawPrice, positionSize, liquidityUsd, isBuy) {
  const DEX_FEE    = 0.0030; // 0.30% each way (base 0.25% × 1.20 — worst-case stress test)
  const MAX_SLIP   = 0.0300; // 3.0% cap — prevents extreme thin-pool distortion in paper mode
  const ratio = liquidityUsd > 0 ? positionSize / liquidityUsd : 0.05;
  let slippage;
  if      (ratio < 0.001) slippage = 0.0024; // 0.24%  (base 0.2%  × 1.20)
  else if (ratio < 0.01)  slippage = 0.0120; // 1.2%   (base 1%    × 1.20)
  else if (ratio < 0.05)  slippage = 0.0360; // 3.6%   (base 3%    × 1.20)
  else                    slippage = 0.0720; // 7.2%   (base 6%    × 1.20) — capped below
  slippage = Math.min(slippage, MAX_SLIP);    // cap at 3% — max total exit cost ~3.3%

  // Buying: we pay MORE (price goes up against us, plus fee)
  // Selling: we receive LESS (price goes down against us, plus fee)
  const costFactor = isBuy
    ? (1 + DEX_FEE + slippage)
    : (1 - DEX_FEE - slippage);

  return rawPrice * costFactor;
}

// Returns the dollar cost of the fee/slippage haircut on an exit fill.
// For real mode, pass realImpactPct (from exitResult.exitImpactPct) for accurate tracking.
// Falls back to simulated fill-price haircut for paper mode or when realImpactPct is absent.
function calcExitFeeUsd(pos, rawPrice, fillPrice, fraction, realImpactPct) {
  if (!rawPrice || rawPrice <= 0) return 0;
  const frac = fraction != null ? fraction : (pos.remaining || 1);
  if (realImpactPct != null && realImpactPct >= 0) {
    // Real mode: cost = position_value × impact fraction
    return pos.size * frac * (realImpactPct / 100);
  }
  // Paper mode / fallback: Cost = dollars we lost vs fair value: position_value * (1 - fillPrice/rawPrice)
  return pos.size * frac * Math.max(0, 1 - fillPrice / rawPrice);
}

// ─── SWING DATA ANALYSIS (entry gate + SL) ────────────────────────────────────
// Single GeckoTerminal OHLCV call that serves two purposes:
//
// 1. RANGE-POSITION ENTRY GATE
//    Computes where the current price sits in the recent swing range:
//      rangePosition = (entryPrice − swingLow) / (swingHigh − swingLow)
//    If rangePosition > 0.70 → price is in the top 30% of its recent range
//    → we're likely buying near the peak → skipEntry = true → enterPosition returns null.
//
// 2. DYNAMIC SWING SL (when entry is allowed)
//    SL = swing_low − 0.25 × (swing_high − swing_low)
//    Gives 25% of the swing window as a buffer below support.
//    Clamped between entry×0.95 (widest −5%) and group floor (tightest).
//
// Lookback window ∝ coin age:
//   window = min(30, max(1, floor(ageMinutes × 0.15))) minutes
//
// Returns { swingSL, skipEntry }:
//   swingSL   — data-driven SL price, or null → use fixed group floor
//   skipEntry — true → abort entry (price at top of range)
//
// On any error → { swingSL: null, skipEntry: false } — fail open (use fixed SL, allow entry)
async function analyzeSwingData(pairAddress, ageMinutes, entryPrice, isGroupA) {
  try {
    if (!pairAddress) return { swingSL: null, skipEntry: false, lowerLow: false };
    const windowMinutes = Math.min(30, Math.max(1, Math.floor(ageMinutes * 0.15)));
    const limit = Math.max(2, windowMinutes);

    const result = await new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.geckoterminal.com',
        path: `/api/v2/networks/solana/pools/${pairAddress}/ohlcv/minute?aggregate=1&limit=${limit}&token=base&currency=usd`,
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        timeout: 5000,
      }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error',   () => resolve({ status: 500, body: '{}' }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 504, body: '{}' }); });
      req.end();
    });

    if (result.status !== 200) return { swingSL: null, skipEntry: false, lowerLow: false };
    const data = JSON.parse(result.body);
    const candles = data?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(candles) || candles.length < 2) return { swingSL: null, skipEntry: false, lowerLow: false };

    // ohlcv_list format: [timestamp, open, high, low, close, volume]
    const swingHigh  = Math.max(...candles.map(c => c[2]));
    const swingLow   = Math.min(...candles.map(c => c[3]));
    const swingRange = swingHigh - swingLow;
    if (swingRange <= 0 || swingLow <= 0) return { swingSL: null, skipEntry: false, lowerLow: false };

    // ── Swing structure check: detect lower-low (downtrend = reject entry) ────
    // Convert to candle objects for detectSwingPoints
    const ohlcvCandles = candles.map(c => ({ ts: c[0], open: c[1], high: c[2], low: c[3], close: c[4] }));
    let lowerLow = false;
    if (ohlcvCandles.length >= 5) {
      const { lows } = detectSwingPoints(ohlcvCandles, 2);
      if (lows.length >= 2) {
        // Compare last two swing lows: if the most recent is lower, downtrend is forming
        const lastLow = lows[lows.length - 1].price;
        const prevLow = lows[lows.length - 2].price;
        if (lastLow < prevLow) {
          lowerLow = true;
          console.log(`[SWING-GATE] ${pairAddress.slice(0,8)}… lower-low detected: prevLow=${prevLow.toExponential(3)} > lastLow=${lastLow.toExponential(3)} — block entry`);
        }
      }
    }

    // ── Gate 1: Range position — skip entry if price is in top 30% of range ──
    const rangePosition = (entryPrice - swingLow) / swingRange;
    if (rangePosition > 0.70) {
      console.log(`[RANGE-GATE] ${pairAddress.slice(0,8)}… rangePos=${(rangePosition*100).toFixed(0)}% (top 30%) — skip entry | window=${limit}min low=${swingLow.toExponential(3)} high=${swingHigh.toExponential(3)}`);
      return { swingSL: null, skipEntry: true, lowerLow };
    }

    // ── Gate 2: Swing SL — data-driven floor ──────────────────────────────────
    const candidateSL = swingLow - 0.25 * swingRange;
    const groupFloor  = entryPrice * (isGroupA ? 0.97 : 0.99);  // tightest allowed
    const maxWidthSL  = entryPrice * 0.95;                       // widest allowed (−5%)

    if (candidateSL < maxWidthSL) {
      // Swing is too wide to use — fall back to fixed floor
      console.log(`[SWING-SL] ${pairAddress.slice(0,8)}… rangePos=${(rangePosition*100).toFixed(0)}% | swing too wide (${((1-candidateSL/entryPrice)*100).toFixed(1)}%) — using fixed floor`);
      return { swingSL: null, skipEntry: false, lowerLow };
    }
    const finalSL = Math.max(groupFloor, candidateSL);  // never tighter than group floor
    console.log(`[SWING-SL] ${pairAddress.slice(0,8)}… rangePos=${(rangePosition*100).toFixed(0)}% window=${limit}min | low=${swingLow.toExponential(3)} high=${swingHigh.toExponential(3)} | finalSL=${finalSL.toExponential(3)}`);
    return { swingSL: finalSL, skipEntry: false, lowerLow };
  } catch (e) {
    return { swingSL: null, skipEntry: false, lowerLow: false }; // any error → fail open
  }
}

async function enterPosition(coin, overrides = {}) {
  const { positions } = await getCollections();
  const ref  = db.collection(positions).doc();
  const s    = coin.strategy;
  const usePartial = !!s.usePartialProfit;
  // ── Trading mode & wallet ──────────────────────────────────────────────────
  const cfg        = await getTradingConfig();
  // positionSize: dynamic sizing (liq × 1% × MC multiplier), capped at /setsize override or POSITION_SIZE env var
  const ceiling      = overrides.size || parseFloat(cfg.positionSize) || POSITION_SIZE;
  // stratCeiling: strategy-level cap (if set); all strategies currently use the global ceiling
  const stratCeiling = s.maxPositionSize ? Math.min(s.maxPositionSize, ceiling) : ceiling;
  // sizeFixed: for /track command — dollar value = price × token_qty, bypass dynamic sizing
  const posSize      = overrides.sizeFixed != null
    ? overrides.sizeFixed
    : calcDynamicPositionSize(coin.liq || 0, coin.mcap || 0, stratCeiling);
  const rawSize    = (coin.liq || 0) * 0.01;  // 1% of liq before MC multiplier & ceiling
  const posSizeNote = posSize >= ceiling
    ? `$${posSize.toFixed(2)} _(capped — liq 1% = $${rawSize.toFixed(0)})_`
    : `$${posSize.toFixed(2)} _(liq × 1%)_`;
  // ── Bidirectional size advisory (stored in position doc; dashboard shows as toast) ──
  // Compare user's set ceiling to what the bot would naturally recommend (no ceiling).
  const dynRec = calcDynamicPositionSize(coin.liq || 0, coin.mcap || 0, Infinity);
  let advisoryNote = null;
  if (ceiling > dynRec * 1.5 && dynRec > POS_FLOOR) {
    // User's ceiling is well above what the bot actually uses for this coin
    advisoryNote = `⚠️ Your ceiling ($${ceiling}) far exceeds what the bot calculated for this coin ($${dynRec}). Actual entry: $${posSize}. For larger trades, choose coins with higher liquidity.`;
  } else if (ceiling < dynRec * 0.5 && ceiling < 10) {
    // User's ceiling is very small — note that profits may not cover fees
    advisoryNote = `⚠️ Set size $${ceiling} is well below the bot's recommended $${dynRec} (liq × 1%). At this size, profits may not cover fees. This is fine for trial/testing.`;
  }
  // Surge momentum disabled — surge exit + reinvest removed; capital floor handles profit protection
  const isSurge = false;
  // Nov-23: diagnostic real mode — override cfg tradingMode to 'real' so the bot
  // executes live Jupiter swaps under the simplified diagnostic filter.
  const tradingMode = (diagnosticMode && diagnosticReal) ? 'real' : (cfg.tradingMode || 'paper');
  const coinChain  = normaliseChain(coin.chain);
  const wallet     = await selectWalletForChain(coinChain, cfg);

  // Real mode: execute swap (skipped for /track — user already holds the tokens)
  let realTx = null;
  if (tradingMode === 'real' && wallet && overrides.skipSwap) {
    // Tracked position: user already holds tokens — record qty for exit, no buy tx
    realTx = { txHash: 'tracked', tokenAmount: overrides.tokenAmount || null };
  } else if (tradingMode === 'real' && wallet) {
    realTx = await executeRealEntry(coin, wallet, posSize);
    // If the on-chain tx failed (no hash), abort entirely — do NOT create a ghost position
    if (!realTx || !realTx.txHash) {
      const reason = realTx?.error || 'Transaction not executed';
      // Cooldown skips are expected — log silently, no Telegram noise
      if (reason === 'Jupiter quote cooldown' || reason === 'Jito bundle cooldown') {
        console.log(`[REAL] ⏸ ${coin.symbol} skipped (${reason}) — no notification sent.`);
        return null;
      }
      console.warn(`[REAL] ⛔ Entry TX failed for ${coin.symbol}: ${reason}. No position created.`);
      await sendTelegram(
        `⛔ *REAL ENTRY FAILED — No Position Opened*\n\n` +
        `*${coin.symbol}*\n` +
        `Reason: ${reason}\n\n` +
        `_Your wallet balance is unchanged. Switch to /mode paper to paper-trade instead._`
      ).catch(() => {});
      return null;
    }
  } else if (tradingMode === 'real' && !wallet) {
    console.warn(`[REAL] No wallet configured for chain "${coinChain}" — skipping ${coin.symbol}`);
    return null; // can't enter a real trade without a wallet
  }

  // Paper mode: simulate realistic fill price (fees + slippage)
  const liquidityAtEntry = coin.liq || 0;
  const rawEntryPrice    = coin.price;
  const effectiveEntry   = tradingMode === 'paper'
    ? simulateFillPrice(rawEntryPrice, posSize, liquidityAtEntry, true)
    : rawEntryPrice;

  // ── RESISTANCE CALCULATION ───────────────────────────────────────────────────
  // Estimate the nearest overhead resistance from DexScreener percentage change data.
  // If a coin fell in h1/h6/h24, that prior price level is now resistance.
  // Only meaningful if at least 8% above entry — closer levels are noise.
  const ch1r  = coin.ch1  || 0;
  const ch6r  = coin.ch6  || 0;
  const ch24r = coin.ch24 || 0;
  const resistanceCandidates = [];
  if (ch1r  < 0) resistanceCandidates.push(effectiveEntry / (1 + ch1r  / 100));
  if (ch6r  < 0) resistanceCandidates.push(effectiveEntry / (1 + ch6r  / 100));
  if (ch24r < 0) resistanceCandidates.push(effectiveEntry / (1 + ch24r / 100));
  const meaningfulR = resistanceCandidates.filter(r => r > effectiveEntry * (1 + RESISTANCE_MIN_GAP));
  const resistancePrice = meaningfulR.length > 0 ? Math.min(...meaningfulR) : null;

  // ── SWING DATA: entry range gate + dynamic SL ────────────────────────────────
  // analyzeSwingData() makes one GeckoTerminal OHLCV call and returns two things:
  //   skipEntry — true if current price is in the top 30% of the recent range
  //               (we'd be buying near the peak — abort this entry)
  //   swingSL   — data-driven SL from swing_low − 25% of swing range, or null
  //
  //   Fixed group floors (also the trail's absolute floor):
  //     AM / SC / PS (ids 1, 2, 4): entry × 0.97  (−3%)
  //     BB / OR      (ids 0, 3):    entry × 0.99  (−1%)
  //
  // slFloor stored on pos = whichever value was used, so the gap trail
  // never ratchets below it even after the coin runs up.
  const _impact        = posSize / Math.max((coin.liq || posSize * 100) / 2, posSize);
  const _cappedImpact  = Math.min(_impact, 0.10);
  const preEntryPrice  = effectiveEntry / (1 + _cappedImpact);
  const isGroupA       = [1, 2, 4].includes(s.id);   // AM, SC, PS
  const fixedFloor     = isGroupA ? effectiveEntry * 0.97 : effectiveEntry * 0.99;

  // ── Tier assignment ──────────────────────────────────────────────────────────
  // Tier is determined by dynamic position size; governs SL, TP1, TP2 thresholds.
  const tier        = posSize < 50 ? 1 : posSize < 200 ? 2 : 3;
  const tierCfg     = getTierConfig(tier);
  const entrySLPct  = tierCfg.entrySLPct;  // 50/40/30 for Tier 1/2/3

  let swingSL = null, skipEntry = false, lowerLowDetected = false;
  if (diagnosticMode) {
    // Diagnostic mode: SL from entry based on tier (50/40/30%)
    swingSL = effectiveEntry * (1 - entrySLPct / 100);
  } else if (overrides.sl == null) {
    const swingResult = await analyzeSwingData(coin.pairAddress, coin.ageMinutes, effectiveEntry, isGroupA);
    skipEntry        = swingResult.skipEntry;      // skip if price at top of recent range
    lowerLowDetected = swingResult.lowerLow;       // skip if downtrend (lower-low detected)
    swingSL          = effectiveEntry * (slTrailMode === '50' ? 0.50 : 0.70);
  }

  if (skipEntry) {
    console.log(`[SKIP-ENTRY] ${coin.symbol} (${s.label}) — price at top of recent range, not entering`);
    return null;
  }
  if (lowerLowDetected) {
    console.log(`[SKIP-ENTRY] ${coin.symbol} (${s.label}) — lower-low swing detected (downtrend), not entering`);
    return null;
  }

  const slFloor        = swingSL ?? fixedFloor;
  const initialSLPrice = slFloor;

  const pos = {
    symbol: coin.symbol, name: coin.name, address: coin.addr,
    chain: coin.chain, strategyId: s.id, strategyLabel: s.label,
    score: coin.score,
    entryPrice: effectiveEntry,
    rawEntryPrice,    // keep the raw price for reference/display
    liquidityAtEntry, // store so exit slippage cap can use it
    // TP/SL: use user-supplied % overrides from /track if present, else strategy defaults
    tp1: overrides.tp1 != null ? effectiveEntry * (1 + overrides.tp1 / 100) : effectiveEntry * s.tp1x,
    tp2: overrides.tp2 != null ? effectiveEntry * (1 + overrides.tp2 / 100) : effectiveEntry * s.tp2x,
    tp3: overrides.tp3 != null ? effectiveEntry * (1 + overrides.tp3 / 100) : effectiveEntry * s.tp3x,
    sl:  overrides.sl  != null ? effectiveEntry * (1 - overrides.sl  / 100) : initialSLPrice,
    currentSL: overrides.sl != null ? effectiveEntry * (1 - overrides.sl / 100) : initialSLPrice,
    preEntryPrice,          // market price before our buy hit the pool
    slFloor,                // absolute SL floor: entry×0.97 for AM, preEntryPrice for others
    initialTrailPct: s.initialTrailPct,
    trailingActive: false,
    size: posSize,
    sizeNote: posSizeNote,
    remaining: 1.0,
    tp1Hit: false, tp2Hit: false,
    // Partial profit fields (Active Momentum + Surge)
    partialStage:    usePartial ? 0 : null,
    recoveredAmount: usePartial ? 0 : null,
    freeRide:        usePartial ? false : null,
    isManual:        overrides.isManual  || false,
    isTracked:       overrides.isTracked || false,
    advisoryNote:    advisoryNote,  // non-null = dashboard shows advisory toast on next refresh
    // Overhead resistance — 50% partial exit fires when price reaches this level
    resistancePrice: resistancePrice,
    resistanceHit:   false,
    // Young coin mode flag (kept for reference — no longer drives TP exits)
    youngCoin: (s.id === 1 && (coin.ageMinutes || 0) < 60),
    // Age at entry — reference only
    coinAgeDays: coin.ageDays || 0,
    // Universal progressive trail state — gap % of ATH gain given back (Phase 3)
    slTrailMode: slTrailMode,            // locked at entry — never changes after ('30' or '50')
    trailPct:    slTrailMode === '50' ? 50 : 30,  // current gap integer % (50→5 or 30→5)
    tightenBase: null,   // ATH at last tighten event
    // Progressive withdrawal tracking (Nov-12)
    originalPositionSize: posSize,  // dollar amount at entry — used for $20 withdrawal calc
    capitalWithdrawnAt:   null,     // price at capital withdrawal (+50%)
    withdrawalCount:      0,        // profit withdrawals completed so far (max 5)
    lastWithdrawalPrice:  null,     // price at last profit withdrawal (for +50% re-trigger)
    // Surge momentum: skip TP1/TP2, ride to 80%+ then full-exit & reinvest
    surgeMomentum: isSurge,
    // Strategy 5 (Pump Spec) profit-halving at 4× — false until triggered; false for all others
    // (undefined breaks Firestore writes — use false universally, logic only fires when strategyId===4)
    s5ProfitHalved: false,
    // Moon bag: funded from surge reinvestment — uses graduated SL, no TP exits
    isMoonBag: overrides.isMoonBag || false,
    isReinvest: overrides.isReinvest || false,
    // ── Tier-based SL/TP engine (Nov-25) ────────────────────────────────────
    // Tier 1=Micro ($<50), Tier 2=Small ($50–200), Tier 3=Medium ($200+)
    tier,                                           // 1 | 2 | 3
    tp1GainPct: tierCfg.tp1GainPct,                // TP1 trigger: 50/40/30%
    tp2GainPct: tierCfg.tp2GainPct,                // TP2 trigger: 200/150/100%
    entrySLPct,                                     // initial SL %: 50/40/30%
    // Progressive floor lock state
    floorMilestoneIdx: -1,     // index into getTierConfig milestones (-1 = none yet)
    activeFloor:       null,   // dollar gain floor (null until first milestone reached)
    // Moon bag trail — set when isMoonBag flips true via TP2
    moonBagTrailPct:   null,   // 0.10 (10%) → 0.05 (5%) on exhaustion
    moonBagEnteredAt:  null,   // timestamp when moon bag mode started
    moonBagPeakGain:   null,   // gainPct at the time moon bag was entered
    // ────────────────────────────────────────────────────────────────────────
    status: 'open',
    enteredAt: Date.now(),
    dexUrl: coin.dexUrl,
    pnl: 0,
    peakPrice: coin.price,
    // ── Trade mode & wallet ──
    tradingMode,
    walletId:        wallet ? wallet.id      : null,
    walletLabel:     wallet ? wallet.label   : null,
    walletAddress:   wallet ? wallet.address : null,
    walletChain:     wallet ? wallet.chain   : null,
    realTxEntry:     realTx ? realTx.txHash       : null,
    // Raw token units received from Jupiter swap — required for executeRealExit
    realTokenAmount: realTx ? (realTx.tokenAmount || null) : null,
    // Fee tracking
    entryImpactPct:  realTx?.entryImpactPct ?? null,
    entryJitoTipUsd: realTx?.jitoTipUsd ?? null,
    entryFeeUsd:     tradingMode === 'paper'
      ? (effectiveEntry - rawEntryPrice) / rawEntryPrice * posSize
      : (realTx?.jitoTipUsd || 0) + ((realTx?.entryImpactPct || 0) / 100 * posSize),
    // Graduation-aware rug protection: PumpSwap coins may still migrate to Raydium.
    // Those positions get a 4-min grace window on liq collapse; all others exit immediately.
    isUngraduated: PUMPSWAP_DEXES.has(coin.dexId || ''),
    // Diagnostic mode fields — entry signals stored for post-trade analysis
    isDiagnostic: diagnosticMode || false,
    diagEntry: diagnosticMode ? {
      m5Ch:       coin.m5Ch       ?? null,
      ch1:        coin.ch1        ?? null,
      ch24:       coin.ch24       ?? null,
      buyPct:     coin.buyPct     ?? null,
      m5Txns:     coin.m5Txns     ?? null,
      ageMinutes: coin.ageMinutes ?? null,
      liq:        coin.liq        ?? null,
      mcap:       coin.mcap       ?? null,
      score:      coin.score      ?? null,
      strategyId: s.id,
    } : null,
  };
  // Nov-20 safety: wrap Firestore write — if it fails after a real swap, sell
  // back immediately to prevent an orphan token with no monitoring record.
  try {
    await ref.set(pos);
  } catch (fsWriteErr) {
    console.error(`[ENTRY] ⚠️ FIRESTORE WRITE FAILED after swap for ${coin.symbol}: ${fsWriteErr.message}`);
    if (tradingMode === 'real' && realTx?.txHash && realTx.txHash !== 'tracked') {
      await sendTelegram(
        `🚨 *ENTRY RECORD FAILED — SELLING BACK*\n\n` +
        `*${coin.symbol}* — on-chain swap succeeded but position could not be saved to Firestore.\n\n` +
        `Selling tokens back now to protect funds.\n` +
        `Error: ${fsWriteErr.message}`
      ).catch(() => {});
      // Build minimal pos object for executeRealSell
      const tempPos = { ...pos, id: ref.id };
      try {
        const sellWallet = await selectWalletForChain('solana', cfg);
        await executeRealSell(tempPos, sellWallet, 1.0, coin.price);
        await sendTelegram(
          `✅ *Sell-back completed* — ${coin.symbol} tokens returned to SOL.\n` +
          `No position was opened. Capital is safe.`
        ).catch(() => {});
      } catch (sellBackErr) {
        console.error(`[ENTRY] ⚠️ SELL-BACK FAILED for ${coin.symbol}: ${sellBackErr.message}`);
        await sendTelegram(
          `🚨 *SELL-BACK FAILED — MANUAL ACTION NEEDED*\n\n` +
          `*${coin.symbol}* — could not sell back after record failure.\n` +
          `Check your wallet and sell manually!\n` +
          `Sell-back error: ${sellBackErr.message}`
        ).catch(() => {});
      }
    }
    return null; // abort — no position record was created
  }
  // Accumulate capital deployed + entry fee into daily stats (fire-and-forget)
  updateDailyStatsEntry(posSize, pos.entryFeeUsd).catch(e => console.warn('[FEE]', e.message));
  const newPos = { id: ref.id, ...pos };
  if (_posCache) _posCache.push(newPos);
  return newPos;
}

// ── Manual token queue ────────────────────────────────────────────────────────
// Dashboard writes to paper_manual_queue; bot picks them up each scan cycle.
const MANUAL_STRATEGY = {
  id: 99, label: '🎯 Manual',
  tp1x: 1.25, tp2x: 1.75, tp3x: 3.00, slx: 0.85, initialTrailPct: 15,
  usePartialProfit: false,
};

async function processManualQueue() {
  try {
    const snap = await db.collection('paper_manual_queue')
      .where('status', '==', 'pending')
      .get();
    if (snap.empty) return;

    const positions = await getVisiblePositions();
    for (const doc of snap.docs) {
      if (positions.length >= MAX_POSITIONS) break;

      const item = doc.data();
      try {
        // Fetch live price from DexScreener
        const r = await httpGet('api.dexscreener.com', `/latest/dex/tokens/${item.address}`);
        const d = JSON.parse(r.body);
        if (!d.pairs?.length) throw new Error('Token not found on DexScreener');
        d.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        const pair = d.pairs[0];
        const price = parseFloat(pair.priceUsd || 0);
        if (!price) throw new Error('No price available');

        // ── PRO Signal path: run bot's own scoring ──────────────────────────────
        // Source 'memscan_pro_signal': the CA came from a forwarded PRO signal.
        // Bot re-evaluates it with detectStrategy() — only enters if score ≥ MIN_SCORE.
        // Source 'manual_command' or undefined: direct manual override, enters immediately.
        if (item.source === 'memscan_pro_signal') {
          // Build current slot counts from open positions
          const slotCount = {};
          for (const s of STRATEGIES) slotCount[s.id] = 0;
          for (const p of positions) {
            if (p.strategyId != null) slotCount[p.strategyId] = (slotCount[p.strategyId] || 0) + 1;
          }
          const openStrategies = STRATEGIES.filter(s => slotCount[s.id] < s.maxSlots);

          // Skip: already in portfolio / on cooldown / no strategy slots
          if (enteredToday.has(item.address) || recentSLCoins.has(item.address)) {
            await doc.ref.update({ status: 'skipped', reason: 'cooldown', processedAt: Date.now() });
            console.log(`[PRO-BRIDGE] ${item.address.slice(0, 8)} skipped — cooldown`);
            continue;
          }
          if (!openStrategies.length) {
            await doc.ref.update({ status: 'skipped', reason: 'no_open_strategies', processedAt: Date.now() });
            console.log(`[PRO-BRIDGE] ${item.address.slice(0, 8)} skipped — all slots full`);
            continue;
          }

          // Run bot's scoring algorithm
          const result = detectStrategy(pair, openStrategies);
          const botScore = result?.score ?? 0;

          if (!result || botScore < MIN_SCORE) {
            const reason = result ? `score_${botScore}_below_${MIN_SCORE}` : 'no_strategy_match';
            await doc.ref.update({ status: 'rejected', reason, botScore, processedAt: Date.now() });
            // Nov-11: silent reject — no Telegram noise; entry fires only if score passes
            console.log(`[PRO-BRIDGE] ${item.address.slice(0, 8)} rejected — bot score ${botScore}`);
            continue;
          }

          // Bot approved — enter with bot-determined strategy
          const coin = {
            symbol:   pair.baseToken?.symbol || '?',
            name:     pair.baseToken?.name   || '',
            addr:     item.address,
            chain:    pair.chainId,
            price,
            score:    botScore,
            dexUrl:   `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`,
            strategy: result.strategy,
            m5Ch:     result.m5Ch,
            ageMinutes: result.ageMinutes,
          };

          const pos = await enterPosition(coin);
          if (!pos) {
            // Real mode with no matching wallet for this chain
            await doc.ref.update({ status: 'skipped', reason: 'no_wallet', processedAt: Date.now() });
            continue;
          }
          enteredToday.add(item.address);
          await doc.ref.update({ status: 'entered', enteredPositionId: pos.id, botScore, processedAt: Date.now() });
          positions.push(pos);
          await sendTelegram(
            `🤖 *PRO SIGNAL ENTRY*\n` +
            `PRO: ${item.proScore}/100 · Bot: ${botScore}/100\n` +
            `*${coin.symbol}* @ ${fmtPrice(price)}\n` +
            `Strategy: ${result.strategy.label}\n` +
            `💰 TP3: ${fmtPrice(pos.tp3)} · SL: ${fmtPrice(pos.sl)}`
          );
          console.log(`[PRO-BRIDGE] ${coin.symbol} entered — bot score ${botScore}, strategy ${result.strategy.label}`);
          continue; // ← PRO path fully handled; skip standard manual section
        }

        // ── Standard manual entry (dashboard / /queue command) ──────────────────
        // Nov-12: added liq + mcap so calcDynamicPositionSize works correctly
        //         (without them it falls back to POS_FLOOR=$10 every time)
        const liq  = pair.liquidity?.usd  || 0;
        const mcap = pair.fdv             || pair.marketCap || 0;
        const coin = {
          symbol: item.symbol || pair.baseToken?.symbol || '?',
          name:   pair.baseToken?.name || '',
          addr:   item.address,
          chain:  pair.chainId,
          price,
          liq,
          mcap,
          score:  100,
          dexUrl: `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`,
          strategy: MANUAL_STRATEGY,
        };

        // sizingMode 'bot': no size override → enterPosition uses dynamic sizing
        //   (calcDynamicPositionSize capped at /setsize or POSITION_SIZE env var)
        // sizingMode 'human': pass item.size directly → used as ceiling (human's choice)
        // Legacy items with no sizingMode default to bot-style dynamic sizing.
        const sizeOverride = item.sizingMode === 'human' && item.size > 0 ? item.size : undefined;
        const pos = await enterPosition(coin, {
          ...(sizeOverride != null ? { size: sizeOverride } : {}),
          isManual: true,
        });

        // null = real mode with no wallet configured for this chain
        if (!pos) {
          await doc.ref.update({ status: 'skipped', reason: 'no_wallet', processedAt: Date.now() });
          console.log(`[MANUAL] ${coin.symbol} skipped — no wallet for chain ${coin.chain}`);
          await sendTelegram(
            `⚠️ *MANUAL ENTRY SKIPPED*\n` +
            `*${coin.symbol}*\n` +
            `Reason: no wallet configured for chain \`${coin.chain}\`\n` +
            `_Switch to Paper mode or fund a wallet for this chain._`
          );
          continue;
        }

        await doc.ref.update({ status: 'entered', enteredPositionId: pos.id, processedAt: Date.now() });
        positions.push(pos);

        await sendTelegram(
          `🎯 *MANUAL ENTRY*\n` +
          `*${coin.symbol}* @ ${fmtPrice(price)}\n` +
          `💰 Size: $${pos.size?.toFixed(2) || POSITION_SIZE} · TP3: ${fmtPrice(pos.tp3)} · SL: ${fmtPrice(pos.sl)}`
        );
        console.log(`[MANUAL] Entered ${coin.symbol} @ ${price}, liq=$${liq.toFixed(0)}, mcap=$${mcap.toFixed(0)}`);
      } catch (e) {
        await doc.ref.update({ status: 'failed', error: e.message, processedAt: Date.now() });
        console.error(`[MANUAL] Failed for ${item.address}: ${e.message}`);
        // Always notify — user queued this manually and deserves to know it failed
        await sendTelegram(
          `❌ *MANUAL ENTRY FAILED*\n` +
          `\`${item.address.slice(0, 8)}…${item.address.slice(-6)}\`\n` +
          `Reason: ${e.message}`
        ).catch(() => {});
      }
    }
  } catch (e) { console.error('[MANUAL QUEUE]', e.message); }
}

// ─── MODE-AWARE COLLECTION NAMES ─────────────────────────────────────────────
// Returns the right Firestore collection names for the current trading mode.
// All position / history / stats writes go through these so Paper and Real
// data live in separate collections and the dashboard can switch between them.
async function getCollections() {
  const cfg  = await getTradingConfig();
  const real = (cfg.tradingMode || 'paper') === 'real';
  return {
    positions: real ? 'real_positions' : 'paper_positions',
    history:   real ? 'real_history'   : 'paper_history',
    stats:     real ? 'real_stats'     : 'paper_stats',
  };
}

async function updatePosition(id, data) {
  const { positions } = await getCollections();
  await db.collection(positions).doc(id).update(data);
  // Patch cache in-place so TP/SL logic sees current state without re-querying
  if (_posCache) {
    const p = _posCache.find(p => p.id === id);
    if (p) Object.assign(p, data);
  }
}

async function closePosition(id, data) {
  const { positions, history } = await getCollections();
  const closeData = { ...data, status: 'closed', closedAt: Date.now() };
  // Track address for partial-auto (trend-confirmed re-entry in manual mode)
  if (_posCache) {
    const closing = _posCache.find(p => p.id === id);
    const addr = ((closing?.address || data?.address) || '').toLowerCase();
    if (addr) trendConfirmedAddrs.add(addr);
  }
  // Remove from cache BEFORE the async Firestore write so a concurrent monitor
  // tick that starts during the await doesn't see this position as still open
  // and fire a second close / duplicate notification.
  if (_posCache) _posCache = _posCache.filter(p => p.id !== id);
  // Always update the position status — this is the critical write
  await db.collection(positions).doc(id).update(closeData);
  // Write history entry — wrapped so a failure doesn't revert the close.
  // Nov-12: added retry + Telegram alert so silent failures are visible.
  // Nov-19: skip in diagnostic mode — full exit data is in diagnostic_trades; no history duplication needed.
  if (!diagnosticMode) {
    let histOk = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const snap = await db.collection(positions).doc(id).get();
        await db.collection(history).add({ ...snap.data(), ...closeData });
        histOk = true;
        break;
      } catch(e) {
        console.warn(`[BOT] History write attempt ${attempt}/2 failed for ${id}:`, e.message);
        if (attempt < 2) await sleep(1500);
      }
    }
    if (!histOk) {
      console.error(`[BOT] ⚠️ History write FAILED for ${id} — position is closed in paper_positions but NOT in paper_history`);
      sendTelegram(`⚠️ *History write failed* — position closed in DB but history record missing. Check Firestore.`).catch(() => {});
    }
  }
}

// Wraps closePosition for real-trade positions: executes the on-chain sell FIRST.
// Returns { ok: true, txHash?, exitImpactPct? } on success,
//         { ok: false, error } when the sell failed (position stays open).
// Callers MUST check .ok and skip stats/notifications when false.
async function realClose(pos, exitPrice, exitReason, pnl, extraData = {}) {
  let txHash = null;
  let exitImpactPct = null;
  if (pos.tradingMode === 'real' && pos.walletId) {
    const wallets = await getWallets();
    const wallet  = wallets.find(w => w.id === pos.walletId);
    if (wallet) {
      const exitResult = await executeRealExit(pos, wallet, exitPrice);
      if (!exitResult || !exitResult.txHash) {
        const reason = exitResult?.error || 'Unknown error';
        console.error(`[REAL] ⛔ EXIT failed for ${pos.symbol} (${exitReason}): ${reason} — position NOT closed`);
        await sendTelegram(
          `⛔ *REAL EXIT FAILED — Position NOT Closed*\n\n` +
          `*${pos.symbol}* — ${exitReason}\n` +
          `Reason: ${reason}\n\n` +
          `_Position is still open. Tokens are in your wallet. Bot will retry on next trigger._`
        ).catch(() => {});
        return { ok: false, error: reason };
      }
      txHash = exitResult.txHash;
      exitImpactPct = exitResult.exitImpactPct ?? null;
      extraData.exitTxHash = txHash;
      if (exitImpactPct != null) extraData.exitImpactPct = exitImpactPct;
    }
  }
  await closePosition(pos.id, { exitPrice, exitReason, pnl, ...extraData });
  if (pos.isDiagnostic) {
    logDiagnosticTrade(pos, exitPrice, exitReason, pnl).catch(e => console.warn('[DIAG] log error:', e.message));
  }
  // Clean up graduation grace state for this position
  graduationGrace.delete(pos.id);
  posLastLiq.delete(pos.id);
  return { ok: true, txHash, exitImpactPct };
}

// ─── DIAGNOSTIC MODE HELPERS ─────────────────────────────────────────────────
function getLiqBucket(liq) {
  if (!liq || liq <= 0)  return 'unknown';
  if (liq < 10000)       return '5k–10k';
  if (liq < 25000)       return '10k–25k';
  if (liq < 50000)       return '25k–50k';
  if (liq < 100000)      return '50k–100k';
  if (liq < 250000)      return '100k–250k';
  return '250k+';
}
function getMcapBucket(mcap) {
  if (!mcap || mcap <= 0) return 'unknown';
  if (mcap < 100000)      return '<100k';
  if (mcap < 500000)      return '100k–500k';
  if (mcap < 1000000)     return '500k–1M';
  if (mcap < 5000000)     return '1M–5M';
  if (mcap < 20000000)    return '5M–20M';
  return '20M+';
}
function getActivityBucket(ageMinutes) {
  if (!ageMinutes || ageMinutes < 15) return 'per_minute';   // coin <15min — activity per minute
  if (ageMinutes < 60)                 return 'per_5min';    // 15–60min — activity per 5min
  return 'per_15min';                                        // 60min+ — activity per 15min
}
function getOutcomeBucket(gainPct) {
  if (gainPct > 50)   return 'most_profitable';   // >+50%
  if (gainPct > 20)   return 'good_profit';        // +20–50%
  if (gainPct > 5)    return 'moderate_profit';    // +5–20%
  if (gainPct >= -5)  return 'neutral';            // ±5%
  if (gainPct >= -20) return 'moderate_loss';      // -5 to -20%
  if (gainPct >= -50) return 'heavy_loss';         // -20 to -50%
  return 'worthless';                              // <-50%
}

async function logDiagnosticTrade(pos, exitPrice, exitReason, pnl) {
  try {
    const gainPct = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
    const de      = pos.diagEntry || {};

    // ── Fee tracking ─────────────────────────────────────────────────────────
    const diagEntryFeeUsd = pos.entryFeeUsd || 0;
    const diagLiq         = de.liq || 0;
    const diagPosSize     = pos.size || 50;
    // Simulate exit fill price (same slippage model as entry) to get exit cost
    const diagExitFillPx  = simulateFillPrice(exitPrice, diagPosSize, diagLiq || diagPosSize * 100, false /*sell*/);
    const diagExitFeeUsd  = calcExitFeeUsd({ size: diagPosSize }, exitPrice, diagExitFillPx, pos.remaining || 1);

    const record  = {
      symbol:       pos.symbol || '',
      address:      pos.address || '',
      exitReason:   exitReason || '',
      entryPrice:   pos.entryPrice,
      exitPrice,
      gainPct:      +gainPct.toFixed(2),
      pnl:          +(pnl || 0).toFixed(4),
      outcome:      getOutcomeBucket(gainPct),
      // Entry signals
      m5Ch:         de.m5Ch     ?? null,
      ch1:          de.ch1      ?? null,
      ch24:         de.ch24     ?? null,
      buyPct:       de.buyPct   ?? null,
      m5Txns:       de.m5Txns   ?? null,
      score:        de.score    ?? pos.score ?? null,
      strategyId:   de.strategyId ?? pos.strategyId ?? null,
      // Bucket classification for range analysis
      liqBucket:     getLiqBucket(de.liq || 0),
      mcapBucket:    getMcapBucket(de.mcap || 0),
      activityLevel: getActivityBucket(de.ageMinutes || 0),
      // Raw values
      liqAtEntry:   de.liq        ?? null,
      mcapAtEntry:  de.mcap       ?? null,
      ageMinutes:   de.ageMinutes ?? null,
      enteredAt:    pos.enteredAt || Date.now(),
      closedAt:     Date.now(),
      tradingMode:  pos.tradingMode || 'paper', // Nov-23: track paper vs real for hourly report filter
      // Fee tracking (entry + exit slippage cost in USD)
      entryFeeUsd:  +diagEntryFeeUsd.toFixed(4),
      exitFeeUsd:   +diagExitFeeUsd.toFixed(4),
    };
    await db.collection('diagnostic_trades').add(record);
    diagnosticTradeCount++;
    console.log(`[DIAG] Trade #${diagnosticTradeCount}/${DIAGNOSTIC_TARGET}: ${pos.symbol} ${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(1)}% → ${record.outcome}`);
    if (diagnosticTradeCount >= DIAGNOSTIC_TARGET) {
      console.log('[DIAG] Target reached — generating report and disabling diagnostic mode');
      diagnosticMode = false;
      diagnosticReal = false;
      await saveBypassFlags().catch(() => {});
      await generateDiagnosticReport(true); // isFinalReport=true — target reached, mode off
    }
  } catch(e) {
    console.warn('[DIAG] logDiagnosticTrade error:', e.message);
  }
}

async function generateDiagnosticReport(isFinalReport = false) {
  try {
    // ── 1. Closed trades from Firestore ──────────────────────────────────────
    const snap   = await db.collection('diagnostic_trades').get();
    const closed = snap.docs.map(d => d.data());

    // ── 2. Still-open diagnostic positions (unrealized) ──────────────────────
    let openDiag = [];
    try {
      const allOpen = await getOpenPositions();
      const diagOpen = allOpen.filter(p => p.isDiagnostic);
      openDiag = diagOpen.map(pos => {
        const currentPrice = pos.currentPrice || pos.peakPrice || pos.entryPrice;
        const gainPct      = (currentPrice - pos.entryPrice) / pos.entryPrice * 100;
        const de           = pos.diagEntry || {};
        return {
          symbol:        pos.symbol        || '',
          address:       pos.address       || '',
          exitReason:    'open_at_analysis',
          entryPrice:    pos.entryPrice,
          exitPrice:     currentPrice,
          gainPct:       +gainPct.toFixed(2),
          pnl:           0,                                      // unrealized — no realized P&L yet
          outcome:       getOutcomeBucket(gainPct),
          liqBucket:     getLiqBucket(de.liq        || 0),
          mcapBucket:    getMcapBucket(de.mcap       || 0),
          activityLevel: getActivityBucket(de.ageMinutes || 0),
          liqAtEntry:    de.liq        ?? null,
          mcapAtEntry:   de.mcap       ?? null,
          ageMinutes:    de.ageMinutes ?? null,
          strategyId:    de.strategyId ?? pos.strategyId ?? null,
          score:         de.score      ?? pos.score      ?? null,
          isOpen:        true,
        };
      });
    } catch(openErr) {
      console.warn('[DIAG] could not fetch open positions for report:', openErr.message);
    }

    // ── 3. Merge ──────────────────────────────────────────────────────────────
    const trades      = [...closed, ...openDiag];
    const totalClosed = closed.length;
    const totalOpen   = openDiag.length;
    const total       = trades.length;

    if (total === 0) {
      await sendTelegram('📊 *Diagnostic Report* — no trades recorded yet.');
      return;
    }

    const pct = (n, d) => d ? `${(n / d * 100).toFixed(1)}%` : '0%';
    const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : 'N/A';

    // ── 4. Outcome breakdown (closed + unrealized combined) ───────────────────
    const ob = { most_profitable:[], good_profit:[], moderate_profit:[], neutral:[], moderate_loss:[], heavy_loss:[], worthless:[] };
    trades.forEach(t => { if (ob[t.outcome]) ob[t.outcome].push(t.gainPct); });
    const profitableTotal = (ob.most_profitable.length + ob.good_profit.length + ob.moderate_profit.length);
    const outcomeSection = [
      `🏆 Most Profitable (>+50%): *${ob.most_profitable.length}* (${pct(ob.most_profitable.length,total)}) avg ${avg(ob.most_profitable)}%`,
      `✅ Good Profit (+20–50%): *${ob.good_profit.length}* (${pct(ob.good_profit.length,total)})`,
      `📈 Moderate Profit (+5–20%): *${ob.moderate_profit.length}* (${pct(ob.moderate_profit.length,total)})`,
      `➡️ Neutral (±5%): *${ob.neutral.length}* (${pct(ob.neutral.length,total)})`,
      `📉 Moderate Loss (-5–20%): *${ob.moderate_loss.length}* (${pct(ob.moderate_loss.length,total)})`,
      `🔻 Heavy Loss (-20–50%): *${ob.heavy_loss.length}* (${pct(ob.heavy_loss.length,total)})`,
      `💀 Worthless (<-50%): *${ob.worthless.length}* (${pct(ob.worthless.length,total)})`,
    ].join('\n');

    // ── 5. Liq bucket analysis ────────────────────────────────────────────────
    const liqG   = {};
    trades.forEach(t => { const b = t.liqBucket || 'unknown'; (liqG[b] = liqG[b] || []).push(t.gainPct); });
    const liqOrder = ['5k–10k','10k–25k','25k–50k','50k–100k','100k–250k','250k+'];
    const liqLines = liqOrder.filter(b => liqG[b]?.length)
      .map(b => `  ${b}: ${liqG[b].length} trades | ${pct(liqG[b].filter(g=>g>5).length,liqG[b].length)} profit | avg ${avg(liqG[b])}%`)
      .join('\n') || '  no data';

    // ── 6. Mcap bucket analysis ───────────────────────────────────────────────
    const mcG    = {};
    trades.forEach(t => { const b = t.mcapBucket || 'unknown'; (mcG[b] = mcG[b] || []).push(t.gainPct); });
    const mcapOrder = ['<100k','100k–500k','500k–1M','1M–5M','5M–20M','20M+'];
    const mcapLines = mcapOrder.filter(b => mcG[b]?.length)
      .map(b => `  ${b}: ${mcG[b].length} trades | ${pct(mcG[b].filter(g=>g>5).length,mcG[b].length)} profit | avg ${avg(mcG[b])}%`)
      .join('\n') || '  no data';

    // ── 7. Activity level analysis ────────────────────────────────────────────
    const actG   = {};
    trades.forEach(t => { const b = t.activityLevel || 'unknown'; (actG[b] = actG[b] || []).push(t.gainPct); });
    const actOrder = [['per_minute','<15min'],['per_5min','15–60min'],['per_15min','60min+']];
    const actLines = actOrder.filter(([b]) => actG[b]?.length)
      .map(([b, lbl]) => `  ${lbl}: ${actG[b].length} trades | ${pct(actG[b].filter(g=>g>5).length,actG[b].length)} profit | avg ${avg(actG[b])}%`)
      .join('\n') || '  no data';

    // ── 8. Open-position snapshot section (unrealized breakdown) ─────────────
    let openSection = '';
    if (totalOpen > 0) {
      const openGains   = openDiag.map(t => t.gainPct);
      const openPosGain = openGains.filter(g => g > 0).length;
      openSection = [
        ``,
        `🔓 *Open Positions at Analysis (${totalOpen} unrealized)*`,
        `  Currently positive: ${openPosGain} / ${totalOpen} | Avg unrealized: ${avg(openGains)}%`,
        `  _(These are still running — outcomes may improve or worsen)_`,
      ].join('\n');
    }

    // ── 9. Exit reason analysis ───────────────────────────────────────────────
    // Only closed trades have meaningful exit reasons (open ones are 'open_at_analysis')
    const closedOnly = trades.filter(t => !t.isOpen);
    const exitReasonG = {};
    closedOnly.forEach(t => {
      const r = t.exitReason || 'unknown';
      if (!exitReasonG[r]) exitReasonG[r] = [];
      exitReasonG[r].push(t.gainPct);
    });
    const exitReasonLines = Object.entries(exitReasonG)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([reason, gains]) => {
        const wins  = gains.filter(g => g > 5).length;
        const label = reason.replace(/_/g, ' ');
        return `  ${label}: *${gains.length}* trades | ${pct(wins, gains.length)} profit | avg ${avg(gains)}%`;
      })
      .join('\n') || '  no data';

    // ── 10. Loss cause analysis — heavy + worthless only ─────────────────────
    // "What caused the worst losses, and what were those coins like at entry?"
    const bigLosses   = closedOnly.filter(t => t.gainPct < -20);  // heavy + worthless
    const modLosses   = closedOnly.filter(t => t.gainPct < -5 && t.gainPct >= -20); // moderate loss only

    function lossProfile(lossSet, label) {
      if (!lossSet.length) return `  ${label}: none`;
      // Exit reason breakdown
      const byReason = {};
      lossSet.forEach(t => {
        const r = t.exitReason || 'unknown';
        (byReason[r] = byReason[r] || []).push(t);
      });
      const reasonSummary = Object.entries(byReason)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([r, trades]) => {
          const avgLiq  = trades.map(t => t.liqAtEntry).filter(v => v != null);
          const avgMcap = trades.map(t => t.mcapAtEntry).filter(v => v != null);
          const avgAge  = trades.map(t => t.ageMinutes).filter(v => v != null);
          const fmtAvg  = arr => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length).toLocaleString() : '?';
          const lbl     = r.replace(/_/g, ' ');
          return `    • ${lbl}: ${trades.length} trades | avg liq $${fmtAvg(avgLiq)} | avg mcap $${fmtAvg(avgMcap)} | avg age ${fmtAvg(avgAge)}min`;
        })
        .join('\n');
      // Entry bucket breakdown
      const byLiq = {}; lossSet.forEach(t => { const b = t.liqBucket||'?'; (byLiq[b]=byLiq[b]||[]).push(1); });
      const byAge = {}; lossSet.forEach(t => { const b = t.activityLevel||'?'; (byAge[b]=byAge[b]||[]).push(1); });
      const liqSummary = liqOrder.filter(b => byLiq[b]?.length)
        .map(b => `${b}:${byLiq[b].length}`).join(' · ') || '?';
      const ageMap = {'per_minute':'<15min','per_5min':'15–60min','per_15min':'60min+'};
      const ageSummary = ['per_minute','per_5min','per_15min'].filter(b => byAge[b]?.length)
        .map(b => `${ageMap[b]}:${byAge[b].length}`).join(' · ') || '?';
      return [
        `  ${label} — *${lossSet.length}* trades | avg ${avg(lossSet.map(t=>t.gainPct))}%`,
        reasonSummary,
        `    Entry liq: ${liqSummary}`,
        `    Entry age: ${ageSummary}`,
      ].join('\n');
    }

    const lossSection = [
      ``,
      `🩸 *Loss Cause Analysis*`,
      lossProfile(bigLosses,  '🔻 Heavy+Worthless (<-20%)'),
      ``,
      lossProfile(modLosses,  '📉 Moderate Loss (-5–20%)'),
    ].join('\n');

    const allGains = trades.map(t => t.gainPct);
    const headerLine = totalOpen > 0
      ? `📊 *DIAGNOSTIC REPORT — ${total} Total* _(${totalClosed} closed + ${totalOpen} open/unrealized)_`
      : `📊 *DIAGNOSTIC REPORT — ${total} Trades*`;

    // ── Dollar P&L summary (closed trades only — slippage baked into fill prices) ──
    const cfg_diag     = await getTradingConfig().catch(() => ({}));
    const diagPosSize  = parseFloat(cfg_diag.positionSize) || POSITION_SIZE;
    const closedWithPnl = closed.filter(t => typeof t.pnl === 'number');
    const diagGrossP   = closedWithPnl.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const diagGrossL   = Math.abs(closedWithPnl.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    const diagNetPnl   = diagGrossP - diagGrossL;
    const diagAvgPnl   = closedWithPnl.length > 0 ? diagNetPnl / closedWithPnl.length : 0;
    const diagNetStr   = diagNetPnl >= 0 ? `+$${diagNetPnl.toFixed(2)}` : `-$${Math.abs(diagNetPnl).toFixed(2)}`;
    const diagAvgStr   = diagAvgPnl >= 0 ? `+$${diagAvgPnl.toFixed(3)}` : `-$${Math.abs(diagAvgPnl).toFixed(3)}`;

    // ── Fee estimation (entry + exit slippage round-trip) ────────────────────
    // Uses stored entryFeeUsd/exitFeeUsd if the record has them (new trades),
    // otherwise estimates from liqAtEntry using the same simulateFillPrice model.
    const totalFees = closedWithPnl.reduce((sum, t) => {
      if (t.entryFeeUsd != null || t.exitFeeUsd != null) {
        return sum + (t.entryFeeUsd || 0) + (t.exitFeeUsd || 0);
      }
      // Legacy records: estimate both legs from liqAtEntry
      const liq     = t.liqAtEntry || 0;
      const pSz     = diagPosSize;
      const DEX_FEE = 0.003, MAX_SLIP = 0.03;
      const ratio   = liq > 0 ? pSz / liq : 0.05;
      let slip = ratio < 0.001 ? 0.0024 : ratio < 0.01 ? 0.012 : ratio < 0.05 ? 0.036 : 0.072;
      slip = Math.min(slip, MAX_SLIP);
      return sum + pSz * (DEX_FEE + slip) * 2; // entry + exit round-trip
    }, 0);
    const diagNetNoFees    = diagNetPnl + totalFees;
    const diagNetNoFeesStr = diagNetNoFees >= 0 ? `+$${diagNetNoFees.toFixed(2)}` : `-$${Math.abs(diagNetNoFees).toFixed(2)}`;

    const pnlSection   = [
      `💰 *P&L SUMMARY* (pos size: $${diagPosSize.toFixed(2)})`,
      `  Gross profit: *+$${diagGrossP.toFixed(2)}*  (${closedWithPnl.filter(t=>t.pnl>0).length} wins)`,
      `  Gross loss:   *-$${diagGrossL.toFixed(2)}*  (${closedWithPnl.filter(t=>t.pnl<0).length} losses)`,
      `  💸 Est. fees:  *-$${totalFees.toFixed(2)}* (entry + exit slippage, ${closedWithPnl.length} trades)`,
      `  ─────────────────────`,
      `  Net P&L: *${diagNetStr}*  |  Avg/trade: *${diagAvgStr}*`,
      `  Excl. fees:   *${diagNetNoFeesStr}* (market performance only)`,
      `  _(slippage already reflected in all P&L figures above)_`,
    ].join('\n');

    const msg = [
      headerLine,
      `Win Rate (>+5%): *${pct(profitableTotal,total)}* | Avg Gain: *${avg(allGains)}%*`,
      ``,
      pnlSection,
      ``,
      `📌 *Outcome Breakdown*`,
      outcomeSection,
      openSection,
      ``,
      `💧 *Liquidity Range Performance*`,
      liqLines,
      ``,
      `📦 *Market Cap Range Performance*`,
      mcapLines,
      ``,
      `⚡ *Activity Level Performance*`,
      actLines,
      ``,
      `🚪 *Exit Reason Breakdown*`,
      exitReasonLines,
      lossSection,
      ``,
      isFinalReport
        ? `_Diagnostic complete (${DIAGNOSTIC_TARGET} trades). Mode is now OFF — review data to refine strategy filters._`
        : `_Snapshot only — diagnostic still running (${diagnosticTradeCount}/${DIAGNOSTIC_TARGET} logged). /diagreport anytime for a fresh snapshot._`,
    ].join('\n');
    await sendTelegram(msg);
  } catch(e) {
    console.error('[DIAG] generateDiagnosticReport error:', e.message);
    await sendTelegram(`❌ *Diagnostic Report Failed*\n\`${e.message}\``).catch(() => {});
  }
}

// Convenience wrapper for partial exits: executes real on-chain sell of `sellFrac`
// of CURRENT wallet balance for real-mode trades. No-op for paper mode.
// Returns { ok: true, txHash?, exitImpactPct? } or { ok: false, error }.
// If the sell fails, Firestore is NOT updated — position stays at current remaining.
async function realPartialSell(pos, sellFrac, exitPrice) {
  if (pos.tradingMode !== 'real' || !pos.walletId) return { ok: true };
  const wallets = await getWallets();
  const wallet  = wallets.find(w => w.id === pos.walletId);
  if (!wallet) return { ok: false, error: 'Wallet not found' };
  const result = await executeRealSell(pos, wallet, sellFrac, exitPrice);
  if (!result?.txHash) {
    const error = result?.error || 'Partial sell failed';
    console.error(`[REAL] ⛔ PARTIAL SELL failed for ${pos.symbol}: ${error} — Firestore NOT updated`);

    // ── Zero-balance = tokens gone from wallet (sold externally / on-chain) ──
    // Alert ONCE and write off the position immediately — no retry makes sense.
    if (error === 'Zero token balance — already sold?') {
      const lastPrice = exitPrice || pos.entryPrice;
      const pnl = (lastPrice - pos.entryPrice) / pos.entryPrice * 100;
      await sendTelegram(
        `⚠️ *POSITION WRITTEN OFF* — ${pos.symbol}\n\n` +
        `Zero token balance detected — tokens no longer in wallet.\n` +
        `Position closed in records. Last known price: $${lastPrice.toFixed(6)}\n\n` +
        `_If this was an unintended external sale, check your wallet manually._`
      ).catch(() => {});
      await closePosition(pos.id, {
        exitPrice:  lastPrice,
        exitReason: 'zero-balance-writeoff',
        pnl,
      }).catch(e => console.error(`[REAL] closePosition write-off failed for ${pos.symbol}:`, e.message));
      return { ok: false, error, zeroClosed: true };
    }

    // ── Other failures (RPC, slippage, etc.) — alert every trigger until resolved ──
    await sendTelegram(
      `⛔ *REAL PARTIAL SELL FAILED*\n\n` +
      `*${pos.symbol}* — partial exit skipped\n` +
      `Reason: ${error}\n\n` +
      `_Position size unchanged. Bot will try again on next trigger.\nSend /close ${pos.symbol} to force-close manually._`
    ).catch(() => {});
    return { ok: false, error };
  }
  return { ok: true, txHash: result.txHash, exitImpactPct: result.exitImpactPct ?? 0 };
}

async function getDailyStats() {
  const now = Date.now();
  if (_statsCache && now - _statsCacheAt < STATS_TTL) return _statsCache;
  const today  = new Date().toISOString().slice(0, 10);
  const { stats } = await getCollections();
  const doc    = await db.collection(stats).doc(today).get();
  // Portfolio = positionSize × maxPositions (fixed formula — no manual topping up needed)
  // $100 × 20 = $2,000 every day, regardless of paperBalance or /addfunds history
  const cfg         = await getTradingConfig();
  const posSize     = parseFloat(cfg.positionSize) || POSITION_SIZE;
  const expectedBalance = posSize * MAX_POSITIONS;
  if (!doc.exists) {
    const init = {
      date: today, startBalance: expectedBalance,
      realizedPnL: 0, trades: 0, wins: 0, losses: 0,
      autoPnL: 0, autoTrades: 0, autoWins: 0,
      manualPnL: 0, manualTrades: 0, manualWins: 0,
      dailyFees: 0, grossProfit: 0, grossLoss: 0, capitalDeployed: 0,
    };
    await db.collection(stats).doc(today).set(init);
    _statsCache = init; _statsCacheAt = now;
    return init;
  }
  const data = doc.data();
  // Auto-correct startBalance if balance was topped up today
  if (data.startBalance !== expectedBalance) {
    await db.collection(stats).doc(today).update({ startBalance: expectedBalance });
    data.startBalance = expectedBalance;
    console.log(`[BOT] startBalance updated: $${data.startBalance} → $${expectedBalance}`);
  }
  _statsCache = data; _statsCacheAt = now;
  return data;
}

// strategyId: 0=BB, 1=AM, 2=SC, 3=OR, 4=PS  (null = unknown/legacy)
const STRATEGY_KEYS = ['bb', 'am', 'sc', 'or', 'ps'];
async function updateDailyStats(pnl, isWin, isManual = false, exitFeeUsd = 0, strategyId = null) {
  if (diagnosticMode && !diagnosticReal) return; // Nov-23: paper diag skips daily stats; real diag flows through
  const today = new Date().toISOString().slice(0,10);
  const { stats } = await getCollections();
  const base = {
    realizedPnL: FieldValue.increment(pnl),
    trades:      FieldValue.increment(1),
    wins:        FieldValue.increment(isWin ? 1 : 0),
    losses:      FieldValue.increment(isWin ? 0 : 1),
    dailyFees:   FieldValue.increment(exitFeeUsd),
    grossProfit: FieldValue.increment(pnl > 0 ? pnl : 0),
    grossLoss:   FieldValue.increment(pnl < 0 ? Math.abs(pnl) : 0),
  };
  if (isManual) {
    base.manualPnL    = FieldValue.increment(pnl);
    base.manualTrades = FieldValue.increment(1);
    base.manualWins   = FieldValue.increment(isWin ? 1 : 0);
  } else {
    base.autoPnL    = FieldValue.increment(pnl);
    base.autoTrades = FieldValue.increment(1);
    base.autoWins   = FieldValue.increment(isWin ? 1 : 0);
  }
  // Per-strategy breakdown: bb_pnl / bb_trades / bb_wins etc.
  const sk = (strategyId != null && strategyId >= 0 && strategyId < STRATEGY_KEYS.length)
    ? STRATEGY_KEYS[strategyId] : null;
  if (sk) {
    base[`${sk}_pnl`]    = FieldValue.increment(pnl);
    base[`${sk}_trades`] = FieldValue.increment(1);
    base[`${sk}_wins`]   = FieldValue.increment(isWin ? 1 : 0);
  }
  await db.collection(stats).doc(today).set(base, { merge: true });
  _statsCache = null; _statsCacheAt = 0; // bust cache so next read gets fresh P&L
}

async function updateDailyStatsEntry(posSize, entryFeeUsd) {
  if (diagnosticMode && !diagnosticReal) return; // Nov-23: paper diag skips; real diag tracks capital
  const today = new Date().toISOString().slice(0,10);
  const { stats } = await getCollections();
  await db.collection(stats).doc(today).set({
    capitalDeployed: FieldValue.increment(posSize),
    dailyFees:       FieldValue.increment(entryFeeUsd),
  }, { merge: true });
  _statsCache = null; _statsCacheAt = 0;
}

// ─── PRICE FETCHER ────────────────────────────────────────────────────────────
async function getCurrentPrice(address, chain) {
  try {
    const r = await httpGet('api.dexscreener.com', `/latest/dex/tokens/${address}`);
    const d = JSON.parse(r.body);
    const pairs = (d.pairs || []).filter(p => p.chainId === chain);
    if (!pairs.length) return null;
    pairs.sort((a,b) => (b.liquidity?.usd||0) - (a.liquidity?.usd||0));
    return parseFloat(pairs[0].priceUsd || 0);
  } catch(e) { return null; }
}

// Returns { price, liq } for the main monitor loop — liq needed for rug-drain exit.
// All other callers still use getCurrentPrice() above (price only).
async function getCurrentPriceAndLiq(address, chain) {
  try {
    const r = await httpGet('api.dexscreener.com', `/latest/dex/tokens/${address}`);
    const d = JSON.parse(r.body);
    const pairs = (d.pairs || []).filter(p => p.chainId === chain);
    if (!pairs.length) return { price: null, liq: null };
    pairs.sort((a,b) => (b.liquidity?.usd||0) - (a.liquidity?.usd||0));
    return {
      price: parseFloat(pairs[0].priceUsd || 0),
      liq:   pairs[0].liquidity?.usd ?? null,
    };
  } catch(e) { return { price: null, liq: null }; }
}

// ─── PULLBACK WATCHLIST PROCESSOR ────────────────────────────────────────────
// Called each scan cycle. Checks BB and OR coins sitting in the watchlist.
// When a coin hits the flat zone (-0.5% ≤ m5Ch ≤ +0.5%) and then bounces 3%
// from its low, it's confirmed at support and we enter.
async function processPullbackWatchlist(positions, slotCount, usedThisScan) {
  if (pullbackWatchlist.size === 0) return;
  const now = Date.now();

  for (const [addr, entry] of pullbackWatchlist) {
    // ── Expiry ───────────────────────────────────────────────────────────────
    if (now > entry.expiry) {
      console.log(`[PBW] ${entry.coin.symbol} expired — no clean support setup in 25min`);
      pullbackWatchlist.delete(addr);
      continue;
    }
    // ── Already entered / on cooldown ────────────────────────────────────────
    if (enteredToday.has(addr) || recentSLCoins.has(addr)) {
      pullbackWatchlist.delete(addr);
      continue;
    }
    // ── Already in an open position ──────────────────────────────────────────
    if (positions.find(p => p.address === addr)) {
      pullbackWatchlist.delete(addr);
      continue;
    }

    // ── Fetch fresh pair data ────────────────────────────────────────────────
    let price, m5Ch, freshLiq;
    try {
      const r = await httpGet('api.dexscreener.com', `/latest/dex/tokens/${addr}`);
      const d = JSON.parse(r.body);
      const pairs = (d.pairs || []).filter(p => p.chainId === entry.coin.chain);
      if (!pairs.length) continue;
      pairs.sort((a,b) => (b.liquidity?.usd||0) - (a.liquidity?.usd||0));
      const pair = pairs[0];
      price    = parseFloat(pair.priceUsd || 0);
      m5Ch     = parseFloat(pair.priceChange?.m5 || 0);
      freshLiq = pair.liquidity?.usd || entry.coin.liq;
    } catch(e) { continue; }
    if (!price || price <= 0) continue;

    // ── Collapse guard — if dropped 25%+ from qualified price, discard ───────
    if (price < entry.qualifiedPrice * (1 - PULLBACK_MAX_DROP)) {
      console.log(`[PBW] ${entry.coin.symbol} collapsed — discarding watchlist entry`);
      pullbackWatchlist.delete(addr);
      continue;
    }

    // ── Track the low ────────────────────────────────────────────────────────
    if (price < entry.low) entry.low = price;

    // ── Detect flat zone (at support) ────────────────────────────────────────
    if (m5Ch >= PULLBACK_FLAT_MIN && m5Ch <= PULLBACK_FLAT_MAX) {
      if (!entry.inFlatZone) {
        entry.inFlatZone = true;
        console.log(`[PBW] ${entry.coin.symbol} in flat zone (m5:${m5Ch.toFixed(2)}%) at $${fmtPrice(price)} — waiting for bounce`);
      }
    }

    // ── Confirm bounce (3% from low, only after flat zone detected) ──────────
    if (entry.inFlatZone && price >= entry.low * (1 + PULLBACK_BOUNCE_PCT)) {
      const pullPct   = ((1 - entry.low / entry.qualifiedPrice) * 100).toFixed(1);
      const bouncePct = ((price / entry.low - 1) * 100).toFixed(1);
      console.log(`[PBW] ${entry.coin.symbol} bounce confirmed: pulled ${pullPct}% → bounced ${bouncePct}% from $${fmtPrice(entry.low)} — entering`);
      pullbackWatchlist.delete(addr);

      // Check slots still available
      if (positions.length >= MAX_POSITIONS) continue;
      if (slotCount[entry.coin.strategy.id] >= entry.coin.strategy.maxSlots) continue;

      // Update coin with fresh price/liq/m5Ch and pullback badge data
      const coin = { ...entry.coin, price, liq: freshLiq, m5Ch };
      coin._pulledBackPct = pullPct;
      coin._bouncedPct    = bouncePct;

      enteredToday.add(addr);
      usedThisScan.add(addr);
      const pos = await enterPosition(coin);
      if (!pos) {
        enteredToday.delete(addr);
        continue;
      }
      alertCooldown.set(addr, Date.now());
      positions.push(pos);
      slotCount[entry.coin.strategy.id]++;

      // ── Telegram entry notification ───────────────────────────────────────
      const s       = coin.strategy;
      const ageLabel = coin.ageMinutes < 60
        ? `${Math.round(coin.ageMinutes)}min old`
        : `${(coin.ageDays * 24).toFixed(1)}h old`;
      const tpInfo = s.usePartialProfit
        ? `🎯 Stage 1 (+50%): sell 25%\n🎯 Stage 2 (+100%): sell 30%\n🎯 Stage 3 (+200%): sell 15% → free ride\n`
        : s.tp1x
          ? `🎯 TP1: $${fmtPrice(coin.price * s.tp1x)} (+${((s.tp1x-1)*100).toFixed(0)}%) → 50%\n` +
            `🎯 TP2: $${fmtPrice(coin.price * s.tp2x)} (+${((s.tp2x-1)*100).toFixed(0)}%) → 30%\n` +
            `🎯 TP3: $${fmtPrice(coin.price * s.tp3x)} (+${((s.tp3x-1)*100).toFixed(0)}%) → 20%\n`
          : `🎯 SL: 50% trail · capital out +50% · tightens 5%/+20% → 5% floor\n`;
      const modeHeader = (pos.isDiagnostic && pos.tradingMode === 'real')
        ? `🔴 *DIAGNOSTIC REAL — LIVE FUNDS*`
        : (pos.isDiagnostic && pos.tradingMode === 'paper')
        ? `🔬 *DIAGNOSTIC PAPER — TEST MODE*`
        : pos.tradingMode === 'real'
        ? `💰 *BOT ENTERED — REAL TRADE*`
        : `✅ *BOT ENTERED — PAPER TRADE*`;
      await sendTelegram(
        `${modeHeader}\n\n` +
        `*${coin.symbol}* — ${coin.name}\n` +
        `${s.label} · Score: *${coin.score}/100*\n` +
        `📉 Pullback entry: -${pullPct}% → +${bouncePct}% bounce confirmed at support\n` +
        `💡 ${s.desc}\n\n` +
        `💵 Entry: $${fmtPrice(coin.price)}\n` +
        `💰 Position: ${pos.sizeNote || '$'+pos.size}${pos.walletLabel ? ` · ${pos.walletLabel}` : ''}\n` +
        `📊 Buy%: ${coin.buyPct.toFixed(0)}% | Liq: $${(coin.liq/1000).toFixed(0)}k\n` +
        `📈 Age: ${ageLabel} | m5: ${m5Ch>0?'+':''}${m5Ch.toFixed(1)}% | h1: ${coin.ch1!=null?(coin.ch1>0?'+':'')+coin.ch1.toFixed(1)+'%':'<1h'}\n\n` +
        tpInfo +
        `🛑 SL: $${fmtPrice(coin.price * s.slx)} | Trail: ${s.initialTrailPct}% → floors at 5%\n\n` +
        `\`${coin.addr}\`\n🔗 [Chart](${coin.dexUrl})`
      );
      console.log(`[BOT] Entered ${coin.symbol} via ${s.label} (pullback) at $${coin.price}`);
    }
  }
}

// ─── MOMENTUM RE-ENTRY PROCESSOR ─────────────────────────────────────────────
// Called each scan. Watches AM/SC/PS coins after their SL close for a higher-low
// reversal signal: postExitLow > snapshotLow AND price bounces 3% from that low.
// That means the dip held above the previous structure — the curve is reversing.
async function processMomentumReentry(positions) {
  if (momentumReentryWatch.size === 0) return;
  const now = Date.now();

  for (const [addr, entry] of momentumReentryWatch) {
    // ── Expire (BB/OR have no expiry; AM/SC/PS expire after 30 min) ──────────
    if (now > entry.expiry) {
      console.log(`[MREENTRY] ${entry.symbol} — window expired, removing`);
      momentumReentryWatch.delete(addr);
      continue;
    }
    // ── Already re-entered or blocked ────────────────────────────────────────
    if (positions.find(p => p.address === addr)) {
      momentumReentryWatch.delete(addr);
      continue;
    }
    if (recentSLCoins.has(addr)) {
      momentumReentryWatch.delete(addr);
      continue;
    }
    if (positions.length >= MAX_POSITIONS) continue;

    // ── Fetch fresh price + momentum data ────────────────────────────────────
    let price, liq, m5Ch, buyPct;
    try {
      const r = await httpGet('api.dexscreener.com', `/latest/dex/tokens/${addr}`);
      const d = JSON.parse(r.body);
      const pairs = (d.pairs || []).filter(p => p.chainId === entry.chain);
      if (!pairs.length) continue;
      pairs.sort((a,b) => (b.liquidity?.usd||0) - (a.liquidity?.usd||0));
      const pair = pairs[0];
      price  = parseFloat(pair.priceUsd || 0);
      liq    = pair.liquidity?.usd   || entry.liq;
      m5Ch   = parseFloat(pair.priceChange?.m5 || 0);
      const buys  = pair.txns?.m5?.buys  || 0;
      const sells = pair.txns?.m5?.sells || 0;
      buyPct = (buys + sells) > 0 ? (buys / (buys + sells)) * 100 : 50;
    } catch(e) { continue; }
    if (!price || price <= 0) continue;

    // ── Track post-exit extremes (the dip/bounce after the SL close) ──────────
    if (price < entry.postExitLow)  entry.postExitLow  = price;
    if (price > entry.postExitHigh) entry.postExitHigh = price;

    // ── Higher-low check ─────────────────────────────────────────────────────
    // The dip after exit must hold ABOVE the structural low recorded at exit time.
    // If coin fell through that floor, the uptrend has broken — ignore.
    if (entry.postExitLow <= entry.snapshotLow) {
      console.log(`[MREENTRY] ${entry.symbol} — dip broke below snapshotLow ($${fmtPrice(entry.postExitLow)} ≤ $${fmtPrice(entry.snapshotLow)}) — removing`);
      momentumReentryWatch.delete(addr);
      continue;
    }

    // ── Bounce check: 3% recovery from the postExitLow ───────────────────────
    if (price < entry.postExitLow * (1 + MOMENTUM_REENTRY_BOUNCE_PCT)) continue;

    // ── Momentum filter: m5 must be positive (curve actively reversing) ───────
    if (m5Ch <= 0) continue;

    // ── Condition 4: Lower-high gate (AM/SC/PS only, within 30-min window) ────
    // If the bounce never cleared the pre-SL peak (snapshotHigh), momentum is
    // fading.  We wait until price breaks ABOVE that old high before re-entering
    // to avoid chasing a dead-cat bounce.
    // Case A: bounce reached/exceeded snapshotHigh → healthy pullback, enter now.
    // Case B: bounce still below snapshotHigh      → price must exceed it first.
    if (!entry.isPatient && isFinite(entry.expiry)) {
      // isPatient=false means AM/SC/PS; isFinite(expiry) rules out legacy entries
      if (entry.postExitHigh < entry.snapshotHigh) {
        // Case B — lower high detected; wait for price to clear the old peak
        if (price < entry.snapshotHigh) {
          console.log(`[MREENTRY] ${entry.symbol} — lower-high gate: postExitHigh $${fmtPrice(entry.postExitHigh)} < snapshotHigh $${fmtPrice(entry.snapshotHigh)}, price $${fmtPrice(price)} must clear $${fmtPrice(entry.snapshotHigh)}`);
          continue;
        }
        // price just cleared snapshotHigh — gate passed
        console.log(`[MREENTRY] ${entry.symbol} — lower-high gate CLEARED: price $${fmtPrice(price)} > snapshotHigh $${fmtPrice(entry.snapshotHigh)}`);
      }
      // Case A: postExitHigh >= snapshotHigh — healthy pullback, no extra gate
    }

    // ── All conditions met — enter ────────────────────────────────────────────
    const bouncePct = ((price / entry.postExitLow - 1) * 100).toFixed(1);
    const prevResult = entry.pnlPct >= 0
      ? `+${(entry.pnlPct * 100).toFixed(1)}%`
      : `${(entry.pnlPct * 100).toFixed(1)}%`;
    console.log(`[MREENTRY] ${entry.symbol} — higher low confirmed! postExitLow:$${fmtPrice(entry.postExitLow)} > snapshotLow:$${fmtPrice(entry.snapshotLow)}, +${bouncePct}% bounce — entering`);
    momentumReentryWatch.delete(addr);

    const strategy = STRATEGIES.find(s => s.id === entry.strategyId) || STRATEGIES[1];
    const coin = {
      addr,
      symbol:      entry.symbol,
      name:        entry.symbol,
      price,
      liq,
      mcap:        entry.mcap || 0,
      m5Ch,
      buyPct,
      chain:       entry.chain,
      strategy,
      dexUrl:      entry.dexUrl,
      ageMinutes:  entry.ageMinutes || 60,
      ageDays:     (entry.ageMinutes || 60) / (60 * 24),
      score:       entry.score || 60,
      ch1:         null,
      _momentumReentry:  true,
      _prevExitPrice:    entry.exitPrice,
      _prevResult:       prevResult,
      _bouncePct:        bouncePct,
      _snapshotLow:      entry.snapshotLow,
      _postExitLow:      entry.postExitLow,
    };

    enteredToday.delete(addr); // clear so enterPosition doesn't reject it
    enteredToday.add(addr);
    const pos = await enterPosition(coin);
    if (!pos) {
      enteredToday.delete(addr);
      continue;
    }
    alertCooldown.set(addr, Date.now());
    positions.push(pos);

    await sendTelegram(
      `🔄 *MOMENTUM RE-ENTRY*\n\n` +
      `*${entry.symbol}* ${entry.strategyLabel}\n` +
      `📉 Higher low held: $${fmtPrice(entry.postExitLow)} > structure $${fmtPrice(entry.snapshotLow)}\n` +
      `📈 Bounce: *+${bouncePct}%* from low — curve reversing\n` +
      `📥 Re-entry: $${fmtPrice(price)} (prev exit: $${fmtPrice(entry.exitPrice)}, ${prevResult})\n` +
      `💰 Position: ${pos.sizeNote || '$'+pos.size}${pos.walletLabel ? ` · ${pos.walletLabel}` : ''}\n` +
      `📊 m5: +${m5Ch.toFixed(1)}% | Buy%: ${buyPct.toFixed(0)}% | Liq: $${(liq/1000).toFixed(0)}k\n` +
      `🔗 [Chart](${entry.dexUrl})`
    ).catch(() => {});
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ─── TECHNICAL ANALYSIS SCORING ──────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
//
// Adds up to +20 bonus points to a coin's base score before the MIN_SCORE
// threshold check in scanForEntries.  Never a hard block — it only helps.
//
//   RSI(14)              +8 / +5 / +2 / 0
//   EMA(9) > EMA(21)     +5 / +2 / 0
//   Bollinger position   +4 / +2 / 0
//   Volume trend         +3 / +1 / 0
//   ──────────────────────────────────
//   Max bonus             +20
//
// Candle source (chosen per strategy / coin age):
//   PS (id=4)              raw 15-s ticks (1 tick = 1 virtual candle)
//   SC (id=2)              1-min virtual candles (4 ticks)
//   AM <1h (id=1)          1-min virtual candles
//   AM 1h–6h (id=1)        5-min virtual candles (20 ticks)
//   AM ≥6h, BB, OR         GeckoTerminal OHLCV (15-min or 1-h), cached 60 s
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build virtual OHLCV candles from priceHistory ticks.
 * resolution = number of 15-s ticks to aggregate into one candle.
 * Returns array of {ts, open, high, low, close, vol, buys, sells} oldest-first.
 */
function buildVirtualCandles(addr, resolution) {
  const hist = priceHistory.get(addr) || [];
  if (hist.length < 2) return [];
  const candles = [];
  for (let i = 0; i < hist.length; i += resolution) {
    const slice  = hist.slice(i, i + resolution);
    const prices = slice.map(h => h.price).filter(p => p > 0);
    if (prices.length === 0) continue;
    const vol   = slice.reduce((s, h) => s + (h.vol   || 0), 0);
    const buys  = slice.reduce((s, h) => s + (h.buys  || 0), 0);
    const sells = slice.reduce((s, h) => s + (h.sells || 0), 0);
    candles.push({
      ts:    slice[0].ts,
      open:  prices[0],
      high:  Math.max(...prices),
      low:   Math.min(...prices),
      close: prices[prices.length - 1],
      vol, buys, sells,
    });
  }
  return candles;
}

/**
 * Detect swing highs and swing lows in a candle array (oldest-first).
 * lookback = how many candles on each side must be lower/higher for a point
 * to be considered a local extreme.
 *
 * Returns:
 *   lows  — [{price, idx, ts}] oldest-first confirmed swing lows
 *   highs — [{price, idx, ts}] oldest-first confirmed swing highs
 *
 * "Confirmed" means the candle is NOT in the last `lookback` positions
 * (trailing candles haven't had a chance to show what comes after them yet).
 */
function detectSwingPoints(candles, lookback = 2) {
  const lows = [], highs = [];
  const end = candles.length - lookback; // only consider candles that have enough future candles
  for (let i = lookback; i < end; i++) {
    let isLow = true, isHigh = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].low  <= candles[i].low)  isLow  = false;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (!isLow && !isHigh) break;
    }
    if (isLow)  lows.push( { price: candles[i].low,  idx: i, ts: candles[i].ts });
    if (isHigh) highs.push({ price: candles[i].high, idx: i, ts: candles[i].ts });
  }
  return { lows, highs };
}

/**
 * Fetch OHLCV candles from GeckoTerminal (CoinGecko Onchain API).
 * timeframe : 'minute' | 'hour'
 * aggregate : e.g. 15 for 15-min candles
 * limit     : up to 1000, default 50
 * Returns array of {ts, open, high, low, close, vol} oldest-first, or [].
 */
async function fetchOHLCV(pairAddress, network, timeframe, aggregate, limit = 50) {
  if (!pairAddress) return [];
  try {
    const path = `/api/v3/onchain/networks/${network}/pools/${pairAddress}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}`;
    const r = await httpGet('api.coingecko.com', path);
    if (r.status !== 200) return [];
    const d    = JSON.parse(r.body);
    const list = d?.data?.attributes?.ohlcv_list || [];
    // API returns newest-first → reverse to oldest-first for indicator maths
    return list.slice().reverse().map(c => ({
      ts:    (c[0] || 0) * 1000,
      open:  parseFloat(c[1]) || 0,
      high:  parseFloat(c[2]) || 0,
      low:   parseFloat(c[3]) || 0,
      close: parseFloat(c[4]) || 0,
      vol:   parseFloat(c[5]) || 0,
    })).filter(c => c.close > 0);
  } catch(e) {
    return [];
  }
}

/**
 * Wilder-smoothed RSI (default period 14).
 * candles must be oldest-first with a .close field.
 * Returns the RSI value (0–100) or null if not enough data.
 */
function computeRSI(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const chg = candles[i].close - candles[i - 1].close;
    if (chg > 0) gains  += chg;
    else         losses -= chg;
  }
  let avgGain = gains  / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < candles.length; i++) {
    const chg  = candles[i].close - candles[i - 1].close;
    const gain = chg > 0 ? chg : 0;
    const loss = chg < 0 ? -chg : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Exponential Moving Average — returns final EMA value or null.
 */
function computeEMA(candles, period) {
  if (candles.length < period) return null;
  const k   = 2 / (period + 1);
  let   ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
  }
  return ema;
}

/**
 * Bollinger Bands (default 20,2).
 * Returns { upper, middle, lower } using last `period` candles, or null.
 */
function computeBollingerBands(candles, period = 20, stdDevMult = 2) {
  if (candles.length < period) return null;
  const slice    = candles.slice(-period);
  const mean     = slice.reduce((s, c) => s + c.close, 0) / period;
  const variance = slice.reduce((s, c) => s + Math.pow(c.close - mean, 2), 0) / period;
  const std      = Math.sqrt(variance);
  return { upper: mean + stdDevMult * std, middle: mean, lower: mean - stdDevMult * std };
}

/**
 * Volume trend: compares sum of last `periods` candles vs prior `periods` candles.
 * Returns 'up' | 'flat' | 'down'.
 */
function computeVolumeTrend(candles, periods = 5) {
  if (candles.length < periods * 2) return 'flat';
  const recent = candles.slice(-periods).reduce((s, c) => s + (c.vol || 0), 0);
  const prior  = candles.slice(-periods * 2, -periods).reduce((s, c) => s + (c.vol || 0), 0);
  if (prior === 0) return recent > 0 ? 'up' : 'flat';
  const ratio = recent / prior;
  if (ratio >= 1.2) return 'up';
  if (ratio <= 0.8) return 'down';
  return 'flat';
}

// Cache TA bonuses per token address — avoids re-fetching GeckoTerminal within 60 s
const taScoreCache = new Map(); // addr → { taBonus, ts }
const TA_CACHE_TTL = 60_000;   // 60 seconds

/**
 * Compute TA bonus (0–20 points) for a scan result.
 * Uses virtual candles (from priceHistory) for fast strategies,
 * and GeckoTerminal OHLCV for older/slower strategies (BB, OR, AM ≥6h).
 * Returns the integer bonus (0 when indicators are inconclusive or data is thin).
 */
async function computeTAScore(result) {
  const addr = result.addr;

  // Return cached value if fresh
  const cached = taScoreCache.get(addr);
  if (cached && (Date.now() - cached.ts) < TA_CACHE_TTL) return cached.taBonus;

  const stratId    = (result.strategy?.id ?? result.strategyId ?? -1);
  const ageMinutes = result.ageMinutes || (result.ageDays || 0) * 1440 || 60;
  const pairAddr   = result.pairAddress || '';
  const network    = (result.chain || 'solana').toLowerCase();

  let candles = [];
  try {
    if (stratId === 4) {
      // PS — raw 15-s ticks, 1 tick per candle
      candles = buildVirtualCandles(addr, 1);
    } else if (stratId === 2 || (stratId === 1 && ageMinutes < 60)) {
      // SC or AM new (<1h) — 1-min candles (4 ticks of 15s)
      candles = buildVirtualCandles(addr, 4);
    } else if (stratId === 1 && ageMinutes < 360) {
      // AM mid (1h–6h) — 5-min candles (20 ticks)
      candles = buildVirtualCandles(addr, 20);
    } else if (stratId === 1 || stratId === 0) {
      // AM ≥6h or BB — GeckoTerminal 15-min candles; fallback to virtual if sparse
      if (pairAddr) {
        candles = await fetchOHLCV(pairAddr, network, 'minute', 15, 50);
      }
      if (candles.length < 5) candles = buildVirtualCandles(addr, 20); // fallback
    } else if (stratId === 3) {
      // OR — GeckoTerminal 1-h candles; fallback to virtual
      if (pairAddr) {
        candles = await fetchOHLCV(pairAddr, network, 'hour', 1, 50);
      }
      if (candles.length < 5) candles = buildVirtualCandles(addr, 80); // ~20-min per candle
    } else {
      // Unknown strategy — 1-min virtual candles
      candles = buildVirtualCandles(addr, 4);
    }
  } catch(e) {
    candles = [];
  }

  // Need at least 5 candles to do anything meaningful
  if (candles.length < 5) {
    taScoreCache.set(addr, { taBonus: 0, ts: Date.now() });
    return 0;
  }

  let bonus = 0;
  const price = candles[candles.length - 1].close;

  // ── RSI (up to +8) ─────────────────────────────────────────────────────────
  const rsi = computeRSI(candles, 14);
  if (rsi !== null) {
    if      (rsi >= 50 && rsi <= 70) bonus += 8; // ideal momentum zone — trending up, not overbought
    else if (rsi >= 40 && rsi <  50) bonus += 5; // building momentum
    else if (rsi >= 70 && rsi <  80) bonus += 2; // strong but approaching overbought
    else if (rsi >= 30 && rsi <  40) bonus += 2; // oversold recovery potential (BB zone)
    // rsi < 30 (deeply oversold, may keep falling) or >= 80 (overbought): no bonus
  }

  // ── EMA alignment (up to +5) ───────────────────────────────────────────────
  const ema9  = computeEMA(candles, 9);
  const ema21 = computeEMA(candles, 21);
  if (ema9 !== null && ema21 !== null && price > 0) {
    if      (ema9 > ema21 && price > ema9)  bonus += 5; // bullish: price above fast EMA above slow EMA
    else if (price > ema21)                 bonus += 2; // price above at least the slow EMA
  } else if (ema9 !== null && price > 0) {
    if (price > ema9) bonus += 2; // only fast EMA available (not enough candles for ema21)
  }

  // ── Bollinger Bands position (up to +4) ────────────────────────────────────
  const bb = computeBollingerBands(candles, 20, 2);
  if (bb !== null && price > 0) {
    const bbRange = bb.upper - bb.lower;
    if (bbRange > 0) {
      const pctInBand = (price - bb.lower) / bbRange; // 0 = at lower band, 1 = at upper band
      if      (pctInBand >= 0.5 && pctInBand <= 0.8) bonus += 4; // upper half but not at extreme — healthy trend
      else if (pctInBand >= 0.2 && pctInBand <  0.5) bonus += 2; // lower half — potential bounce
      // near lower band (<0.2) or near upper band (>0.8): no bonus
    }
  }

  // ── Volume trend (up to +3) ─────────────────────────────────────────────────
  const volTrend = computeVolumeTrend(candles, 5);
  if      (volTrend === 'up')   bonus += 3;
  else if (volTrend === 'flat') bonus += 1;
  // volume declining: no bonus

  const taBonus = Math.min(20, bonus); // cap at +20

  if (taBonus > 0) {
    const bbPct = bb ? (((price - bb.lower) / (bb.upper - bb.lower)) * 100).toFixed(0) + '%' : 'n/a';
    console.log(`[TA] ${result.symbol} +${taBonus}pts | RSI:${rsi?.toFixed(0) ?? 'n/a'} EMA:${ema9 !== null ? (price > ema9 ? '▲' : '▼') : '-'}/${ema21 !== null ? (ema9 > ema21 ? '▲' : '▼') : '-'} BB:${bbPct} vol:${volTrend} candles:${candles.length} strat:${stratId} age:${Math.round(ageMinutes)}m`);
  }

  taScoreCache.set(addr, { taBonus, ts: Date.now() });
  return taBonus;
}

// ═════════════════════════════════════════════════════════════════════════════
// ─── POSITION MONITOR ────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
async function isBotRunning() {
  // Uses the cached getTradingConfig() — no extra Firestore read every 5s.
  // CFG_TTL (30s) means this reflects stop/start commands within 30 seconds.
  try {
    const cfg = await getTradingConfig();
    return cfg.running !== false;
  } catch { return true; } // on error, don't block trading
}

// ─── DAY RESTART ─────────────────────────────────────────────────────────────
// Called at the top of each scan/monitor cycle.
// If paper_config/control.restartDay == true → archive the closing session's
// P&L into a sessions[] array, zero out today's live counters, clear in-memory
// state, and resume trading.  Can be called multiple times per day — each call
// creates a new numbered session.  Open positions are carried over (not closed).
async function checkDayRestart() {
  try {
    // Use cached config first to avoid a Firestore read every monitor cycle.
    // The cache TTL is 30s, so restart commands are picked up within 30 seconds.
    const data = await getTradingConfig();
    if (!data.restartDay) return false;
    // Invalidate cache immediately so stale restartDay=true doesn't re-trigger
    _tradingCfg = null; _tradingCfgAt = 0;

    // ── Atomically claim the restart flag ──
    // Two instances can race here during rolling deploys.  Only the one that
    // successfully flips restartDay true→false inside the transaction may proceed;
    // the other finds it already false and exits cleanly.
    const ctrlRef = db.collection('paper_config').doc('control');
    let claimed = false;
    try {
      await db.runTransaction(async (txn) => {
        const ctrlDoc = await txn.get(ctrlRef);
        if (!ctrlDoc.data()?.restartDay) throw Object.assign(new Error('already_claimed'), { code: 'already_claimed' });
        txn.update(ctrlRef, { restartDay: false, lastRestartAt: Date.now() });
      });
      claimed = true;
    } catch(e) {
      if (e.code === 'already_claimed') return false; // other instance got here first
      throw e; // unexpected Firestore error — propagate
    }

    // ── Read today's current stats ──
    const today = new Date().toISOString().slice(0, 10);
    const { stats: _statsCol2 } = await getCollections();
    const statsSnap = await db.collection(_statsCol2).doc(today).get();
    const statsData  = statsSnap.exists ? statsSnap.data() : {};
    const prevPnL    = statsData.realizedPnL || 0;
    const prevCount  = statsData.restartCount || 0;        // sessions completed so far
    const sessionNum = prevCount + 1;                      // this closing session's number

    // ── Archive the closing session, then zero the live counters ──
    // sessions[] keeps every completed session's P&L + timestamp so the
    // day's history is never lost, even across multiple restarts.
    const closedSession = {
      session:   sessionNum,
      pnl:       prevPnL,
      closedAt:  Date.now(),
    };
    await db.collection(_statsCol2).doc(today).set({
      realizedPnL:  0,
      autoPnL:      0,
      manualPnL:    0,
      restartCount: FieldValue.increment(1),
      sessions:     FieldValue.arrayUnion(closedSession),
      lastRestartAt: Date.now(),
    }, { merge: true });

    // Clear in-memory state so old coins don't block fresh entries
    enteredToday.clear();
    recentSLCoins.clear();
    alertCooldown.clear();
    momentumReentryWatch.clear();
    taScoreCache.clear();
    dayHaltedToday = false;

    const pnlStr = prevPnL >= 0
      ? `+$${prevPnL.toFixed(2)}`
      : `-$${Math.abs(prevPnL).toFixed(2)}`;

    await sendTelegram(
      `🔄 *DAY RESTARTED*\n\n` +
      `Session ${sessionNum} P&L locked: *${pnlStr}*\n` +
      `Loss counter reset → $0. Bot scanning again.\n\n` +
      `_Send /restart any time to start a new session_`
    );
    console.log(`[BOT] Day restarted — session ${sessionNum} P&L locked: ${pnlStr}`);
    return true;
  } catch(e) {
    console.error('[BOT] checkDayRestart error:', e.message);
    return false;
  }
}

// ─── TELEGRAM COMMAND POLLING ─────────────────────────────────────────────────
// On startup: skip all queued messages so we don't replay old /help /start etc.
async function drainTelegramQueue() {
  if (!TELEGRAM_TOKEN) return;
  try {
    const r = await httpGet('api.telegram.org',
      `/bot${TELEGRAM_TOKEN}/getUpdates?offset=-1&timeout=0`);
    const d = JSON.parse(r.body);
    if (d.ok && d.result?.length) {
      telegramOffset = d.result[d.result.length - 1].update_id + 1;
      console.log('[BOT] Telegram queue drained — offset now', telegramOffset);
    }
  } catch(e) {
    console.error('[BOT] Telegram drain failed:', e.message);
  }
}

// Polls for commands from the authorized chat. Runs every 30 s.
async function pollTelegramCommands() {
  try {
    const path = `/bot${TELEGRAM_TOKEN}/getUpdates?offset=${telegramOffset}&timeout=5&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`;
    const r = await httpGet('api.telegram.org', path);

    // ── Diagnose poll failures visibly in Telegram, not just console ────────────
    if (r.status !== 200) {
      console.error(`[TELEGRAM-POLL] HTTP ${r.status} — ${r.body.slice(0, 200)}`);
      if (r.status === 401 || r.status === 403) {
        await sendTelegram(`⚠️ Telegram poll error: HTTP ${r.status} — bot token may be invalid. Check TELEGRAM_BOT_TOKEN secret.`).catch(() => {});
      }
      return;
    }

    let d;
    try { d = JSON.parse(r.body); }
    catch(parseErr) {
      console.error('[TELEGRAM-POLL] Non-JSON response:', r.body.slice(0, 200));
      return;
    }
    if (!d.ok) {
      console.error('[TELEGRAM-POLL] Telegram error:', d.description || JSON.stringify(d));
      // Only alert on auth errors — transient errors are normal
      if (d.error_code === 401 || d.error_code === 403) {
        await sendTelegram(`⚠️ Telegram API error ${d.error_code}: ${d.description}\nCheck TELEGRAM_BOT_TOKEN secret.`).catch(() => {});
      }
      return;
    }
    if (!d.result?.length) return;

    for (const update of d.result) {
      telegramOffset = update.update_id + 1;
      try { // ── per-message guard: one bad command won't kill the rest ─────────

      // ── Handle callback_query (inline button taps from /hidden) ──────────────
      if (update.callback_query) {
        const cbq      = update.callback_query;
        const cbChatId = String(cbq.message?.chat?.id || '');
        if (cbChatId !== TELEGRAM_CHAT) continue;
        await answerCallbackQuery(cbq.id);

        const data = cbq.data || '';
        // ── MANUAL ENTRY: user tapped "Enter Trade" on a signal alert ────────────
        if (data.startsWith('manual_enter:')) {
          const addr = data.slice('manual_enter:'.length);
          const ms   = manualAlertState.get(addr);

          if (!ms) {
            await sendTelegram(`⏰ Opportunity expired — the alert window for this coin has closed.`);
          } else if (enteredToday.has(addr)) {
            await sendTelegram(`ℹ️ *${ms.coin.symbol}* was already entered this session.`);
            manualAlertState.delete(addr);
          } else {
            manualAlertState.delete(addr); // consume immediately — prevent double-tap
            enteredToday.add(addr);
            await sendTelegram(`⏳ Entering *${ms.coin.symbol}*...`);
            try {
              const pos = await enterPosition(ms.coin);
              if (!pos) {
                enteredToday.delete(addr);
                // enterPosition already sent its own error message — don't add a duplicate
              } else {
                alertCooldown.set(addr, Date.now());
                positions.push(pos);
                slotCount[ms.coin.strategy.id]++;
                const modeHdr = pos.tradingMode === 'real' ? `💰 *ENTERED — REAL TRADE*` : `✅ *ENTERED — PAPER TRADE*`;
                await sendTelegram(
                  `${modeHdr}\n\n` +
                  `*${ms.coin.symbol}* — ${ms.coin.name}\n` +
                  `${ms.s.label} · Score: *${ms.coin.score}/100*\n\n` +
                  `📥 Entry: $${fmtPrice(ms.coin.price)}\n` +
                  `💰 Position: ${pos.sizeNote || '$' + pos.size}${pos.walletLabel ? ` · ${pos.walletLabel}` : ''}\n` +
                  `🛑 SL: $${fmtPrice(pos.currentSL || pos.sl)} (−30%)\n` +
                  `🔗 [Chart](${ms.coin.dexUrl})`
                );
              }
            } catch (enterErr) {
              enteredToday.delete(addr);
              await sendTelegram(`❌ *ENTRY ERROR — ${ms.coin.symbol}*\n${enterErr.message}`);
            }
          }
          continue;
        }

        // ── MANUAL SKIP: user tapped "Skip" on a signal alert ─────────────────
        if (data.startsWith('manual_skip:')) {
          const addr = data.slice('manual_skip:'.length);
          const ms   = manualAlertState.get(addr);
          if (ms && !ms.skipped) {
            ms.skipped = true;
            manualAlertState.set(addr, ms);
            await sendTelegram(`👋 *${ms.coin.symbol}* skipped — alerts for this coin will pause until the next window (~${Math.ceil(MANUAL_WINDOW_MS/60000)} min).`);
          } else {
            await sendTelegram(`ℹ️ This alert has already expired or been acted on.`);
          }
          continue;
        }

        if (data.startsWith('bg_view:')) {
          // User tapped a hidden coin row — show its full status
          const posId   = data.slice('bg_view:'.length);
          const allPos  = await getOpenPositions();
          const pos     = allPos.find(p => p.id === posId);
          if (!pos) {
            await sendTelegram(`ℹ️ Position not found — it may have already closed.`);
          } else {
            const price   = pos.currentPrice || pos.entryPrice;
            const gain    = (price - pos.entryPrice) / pos.entryPrice * 100;
            const holdH   = ((Date.now() - pos.enteredAt) / 3600000).toFixed(1);
            await sendTelegram(
              `📦 *HIDDEN — ${pos.symbol}* ${pos.strategyLabel}\n\n` +
              `💵 Entry: $${fmtPrice(pos.entryPrice)}\n` +
              `📈 Now: $${fmtPrice(price)} · Gain: ${gain >= 0 ? '+' : ''}${gain.toFixed(1)}%\n` +
              `⏱ Held: ${holdH}h\n` +
              `🛑 SL: $${fmtPrice(pos.currentSL || 0)}\n` +
              `📊 Remaining: ${(pos.remaining * 100).toFixed(0)}%\n` +
              `🔗 [Chart](${pos.dexUrl})\n\n` +
              `_Use /clearall or the dashboard to close manually._`
            );
          }
        }
        continue;
      }

      const text    = (update.message?.text || '').trim().toLowerCase();
      const rawText = (update.message?.text || '').trim();          // preserve case for PRO signal parser
      const chatId  = String(update.message?.chat?.id || '');

      // ── chatId mismatch guard — log once so Fly.io logs show the mismatch ────
      if (chatId !== TELEGRAM_CHAT) {
        if (chatId) console.log(`[CMD] Ignored msg from chatId=${chatId} (expected=${TELEGRAM_CHAT})`);
        continue;
      }

      // ── /ping — simplest possible command test ───────────────────────────────
      if (text === '/ping') {
        await sendTelegram(`🏓 *pong* — commands working ✅\nChat ID: \`${chatId}\`\nOffset: ${telegramOffset}`);
        continue;
      }

      if (text === '/restart' || text === '/restart_day') {
        if (dayHaltedToday) {
          // Directly perform restart — no Firestore round-trip needed
          await db.collection('paper_config').doc('control').set(
            { restartDay: true }, { merge: true }
          );
          await sendTelegram('⏳ Restart queued — will apply within 5 seconds.');
        } else {
          // Day is running fine — still allow restart (clears state / counters)
          await db.collection('paper_config').doc('control').set(
            { restartDay: true }, { merge: true }
          );
          await sendTelegram('✅ Day reset queued — loss counter & cooldowns will clear shortly.');
        }
      }

      if (text === '/status') {
        const stats      = await getDailyStats();
        const cfg        = await getTradingConfig();
        const mode       = (cfg.tradingMode || 'paper').toUpperCase();
        const botPaused  = cfg.running === false;
        const state      = botPaused      ? '⏸ PAUSED (running=false in DB)'
                         : dayHaltedToday ? '🚨 HALTED (daily limit)'
                         : '✅ Running';
        const posSize    = parseFloat(cfg.positionSize) || POSITION_SIZE;

        // ── Balance breakdown ────────────────────────────────────────────────────
        const startBal   = stats.startBalance || (POSITION_SIZE * MAX_POSITIONS);
        const grossProfit = stats.grossProfit  || 0;
        const grossLoss   = stats.grossLoss    || 0;
        const fees        = stats.dailyFees    || 0;
        const netPnL      = grossProfit - grossLoss;   // fees already baked into fill-price PnL
        const currentBal  = startBal + netPnL;
        const netPct      = ((netPnL / startBal) * 100).toFixed(1);
        const netStr      = netPnL >= 0
          ? `+$${netPnL.toFixed(2)} (+${netPct}%)`
          : `-$${Math.abs(netPnL).toFixed(2)} (${netPct}%)`;

        const pausedNote = botPaused
          ? `\n⚠️ _Bot is PAUSED — set running=true in Firebase to resume_`
          : '';
        const entryNote = autoEntryPaused
          ? `\n⏸ _Auto-entry PAUSED — signals alert only. /pauseentry off to resume._`
          : '';

        // Nov-24: Show diagnostic P&L when diagnostic mode is active
        let diagStatusLine = '';
        if (diagnosticMode) {
          try {
            const dSnap   = await db.collection('diagnostic_trades').get();
            const dTrades = dSnap.docs.map(d => d.data());
            const dNet    = dTrades.reduce((s, t) => s + (t.pnl || 0), 0);
            const dWins   = dTrades.filter(t => (t.pnl || 0) > 0).length;
            const dWinPct = dTrades.length > 0 ? Math.round(dWins / dTrades.length * 100) : 0;
            const dSign   = dNet >= 0 ? '+' : '-';
            const dMode   = diagnosticReal ? 'REAL' : 'PAPER';
            diagStatusLine = `\n─────────────────────\n` +
              `🔬 *Diagnostic (${dMode})*: ${dTrades.length} closed\n` +
              `Net P&L: *${dSign}$${Math.abs(dNet).toFixed(2)}* | Win rate: ${dWinPct}%`;
          } catch(e) {
            console.warn('[STATUS] diag P&L fetch error:', e.message);
          }
        }

        await sendTelegram(
          `📊 *STATUS*\n\n` +
          `${state} · *${mode} mode*\n\n` +
          `💰 Starting capital: *$${startBal.toFixed(2)}*\n` +
          `💵 Current balance:  *$${currentBal.toFixed(2)}*\n\n` +
          `📈 Gross profit:   +$${grossProfit.toFixed(2)}\n` +
          `📉 Gross loss:     -$${grossLoss.toFixed(2)}\n` +
          `─────────────────────\n` +
          `🏆 Net P&L: *${netStr}*\n` +
          `💸 Fees (in P&L):  $${fees.toFixed(2)}\n\n` +
          `Position size: *$${posSize.toFixed(2)}* · Limit: ${(DAILY_LOSS_LIMIT * 100).toFixed(0)}%\n` +
          `Scan #: ${scanCount}${pausedNote}${entryNote}${diagStatusLine}\n\n` +
          `_/stats · /ping · /setsize · /mode paper|real · /wallets_`
        );
      }

      // ── /recover — manually trigger orphan token scan ───────────────────────
      if (text === '/recover') {
        const rcfg = await getTradingConfig();
        if ((rcfg.tradingMode || 'paper') !== 'real') {
          await sendTelegram('⚠️ /recover only works in REAL mode. Currently in paper mode.');
          continue;
        }
        await sendTelegram('🔍 Scanning wallet for untracked tokens...');
        const rCount = await detectAndRecoverOrphans(true); // force = bypass rate limit
        if (rCount === 0) {
          await sendTelegram('✅ No orphan tokens found — all wallet tokens are tracked.');
        }
        // Individual alerts sent inside detectAndRecoverOrphans for each found token
        continue;
      }

      if (text === '/stats') {
        const stats       = await getDailyStats();
        const grossProfit = stats.grossProfit    || 0;
        const grossLoss   = stats.grossLoss      || 0;
        const fees        = stats.dailyFees      || 0;
        const netRevenue  = grossProfit - grossLoss;   // fees baked into fill-price PnL
        const capital     = stats.capitalDeployed || 0;
        const winRate     = stats.trades > 0 ? ((stats.wins/stats.trades)*100).toFixed(0) : '—';
        const tierBreakdown = buildTierBreakdown(stats);
        await sendTelegram(
          `📈 *DAILY REVENUE REPORT*\n\n` +
          `✅ Gross profit:  +$${grossProfit.toFixed(2)}\n` +
          `❌ Gross loss:    -$${grossLoss.toFixed(2)}\n` +
          `─────────────────────\n` +
          `🏆 Net revenue:   ${netRevenue>=0?'+':''}$${netRevenue.toFixed(2)}\n` +
          `💸 Fees (in P&L): $${fees.toFixed(2)}\n\n` +
          `💼 Capital deployed: $${capital.toFixed(2)}\n` +
          `📊 Trades: ${stats.trades} · Win rate: ${winRate}% (${stats.wins}W/${stats.losses}L)\n` +
          `💰 Running P&L: ${stats.realizedPnL>=0?'+':''}$${stats.realizedPnL.toFixed(2)}\n\n` +
          `*Tier P&L (best → worst):*\n${tierBreakdown}`
        );
      }

      // ── /mode paper  or  /mode real ──────────────────────────────────────────
      if (text.startsWith('/mode ')) {
        const newMode = text.split(' ')[1]?.trim();
        if (newMode === 'paper' || newMode === 'real') {
          await db.collection('paper_config').doc('control').set(
            { tradingMode: newMode }, { merge: true }
          );
          _tradingCfg = null; // bust cache
          const emoji = newMode === 'real' ? '💰' : '📄';
          await sendTelegram(
            `${emoji} *Mode switched to ${newMode.toUpperCase()}*\n\n` +
            (newMode === 'real'
              ? `Real trades will execute on connected wallets.\nSend /wallets to review wallet setup.`
              : `Paper (simulated) trading active. No real funds used.`)
          );
        } else {
          await sendTelegram('Usage: `/mode paper` or `/mode real`');
        }
      }

      // ── /wallets ─────────────────────────────────────────────────────────────
      if (text === '/wallets') {
        _walletsCache = null; // force fresh read
        const wallets = await getWallets();
        const cfg     = await getTradingConfig();
        const mode    = cfg.tradingMode || 'paper';
        if (!wallets.length) {
          await sendTelegram(
            `👛 *No wallets configured*\n\n` +
            `Add wallets in the dashboard or Firestore:\n` +
            `Collection: \`paper_config/wallets/slots\`\n` +
            `Fields: label, address, chain (solana/ethereum/bsc/base), active, receiveProceeds, envKey (WALLET\\_1…5)\n\n` +
            `Set private keys in Fly.io secrets:\n\`WALLET_1_PRIVATE_KEY\`, \`WALLET_2_PRIVATE_KEY\`, …`
          );
        } else {
          const lines = wallets.map(w => {
            const hasKey = !!process.env[`${w.envKey}_PRIVATE_KEY`];
            const keyIcon = mode === 'real' ? (hasKey ? '🔑' : '⚠️ no key') : '';
            const procIcon = w.receiveProceeds ? '💸' : '';
            return `• *${w.label}* (${w.chain}) ${keyIcon}${procIcon}\n  \`${w.address.slice(0, 8)}…${w.address.slice(-4)}\``;
          });
          await sendTelegram(
            `👛 *Wallets* — ${mode.toUpperCase()} mode\n\n` +
            lines.join('\n') + '\n\n' +
            `🔑 = key present · 💸 = receives proceeds\n` +
            `⚠️ = missing Fly.io secret`
          );
        }
      }

      // ── /addfunds <amount> ────────────────────────────────────────────────────
      if (text.startsWith('/addfunds')) {
        const parts  = text.split(' ');
        const amount = parseFloat(parts[1]);
        if (!amount || amount <= 0) {
          await sendTelegram('Usage: `/addfunds 500` — adds $500 to the trading balance');
        } else {
          await db.collection('paper_config').doc('control').set(
            { addFunds: amount }, { merge: true }
          );
          await sendTelegram(`⏳ Adding $${amount.toFixed(2)} to balance — will apply within 30 seconds.`);
        }
      }

      // ── /close SYMBOL|ADDRESS — sell one specific position ───────────────────
      // /close ONI          → closes by symbol (if unique)
      // /close <CA>         → closes by full token address (always precise)
      // If symbol matches multiple positions, bot lists them with short addresses
      // so the user can re-send with the full CA to pick the right one.
      if (text.startsWith('/close ')) {
        const closeArg = rawText.slice('/close '.length).trim(); // preserve case for CA
        if (!closeArg) {
          await sendTelegram('❌ Usage:\n`/close ONI` — close by symbol\n`/close <token address>` — close by contract address (precise)');
        } else {
          const allPos = await getOpenPositions();
          // Try exact address match first (CA provided)
          let matches = allPos.filter(p => (p.address || '').toLowerCase() === closeArg.toLowerCase());
          // Fall back to symbol match
          if (!matches.length) {
            matches = allPos.filter(p => (p.symbol || '').toUpperCase() === closeArg.toUpperCase());
          }
          if (!matches.length) {
            await sendTelegram(`❌ No open position found for *${closeArg}*.\nCheck spelling or use /clearall to close everything.`);
          } else if (matches.length > 1) {
            // Multiple positions with same symbol — list them so user can pick by CA
            const lines = matches.map((p, i) => {
              const gain = p.entryPrice ? ((( p.currentPrice || p.entryPrice) - p.entryPrice) / p.entryPrice * 100).toFixed(1) : '?';
              return `${i + 1}. *${p.symbol}* · ${gain}% · \`${p.address}\``;
            }).join('\n');
            await sendTelegram(
              `⚠️ *${matches.length} positions found for ${closeArg.toUpperCase()}*\n\n` +
              `${lines}\n\n` +
              `Re-send with the full address to close a specific one:\n` +
              `\`/close <address>\``
            );
          } else {
            // Exactly one match — close it
            const pos = matches[0];
            try {
              const price   = await getCurrentPrice(pos.address, pos.chain) || pos.entryPrice;
              const exitPnl = (price - pos.entryPrice) / pos.entryPrice * (pos.size || POSITION_SIZE) * (pos.remaining || 1);
              const pnl     = (pos.pnl || 0) + exitPnl;
              await sendTelegram(`⏳ Closing *${pos.symbol}* at $${fmtPrice(price)}…`);
              const _result = await realClose(pos, price, 'MANUAL_CLOSE_CMD', pnl);
              if (!_result?.ok) {
                await sendTelegram(`⛔ Close failed for *${pos.symbol}* — try again or use /clearall.`);
              } else {
                await updateDailyStats(exitPnl, exitPnl > 0, false, calcExitFeeUsd(pos, price, price, pos.remaining || 1, _result.exitImpactPct), pos.strategyId ?? null);
                enteredToday.delete(pos.address);
                const pnlStr = exitPnl >= 0
                  ? `+$${exitPnl.toFixed(2)} ✅`
                  : `-$${Math.abs(exitPnl).toFixed(2)} ❌`;
                await sendTelegram(
                  `🚫 *CLOSED — ${pos.symbol}*\n\n` +
                  `Exit price: $${fmtPrice(price)}\n` +
                  `P&L: *${pnlStr}*\n` +
                  `${_result.txHash ? `📡 [Tx](https://solscan.io/tx/${_result.txHash})` : ''}`
                );
              }
            } catch(e) {
              console.error(`[CLOSE CMD] Failed for ${pos.symbol}:`, e.message);
              await sendTelegram(`⛔ Error closing *${pos.symbol}*: ${e.message}`);
            }
          }
        }
        continue;
      }

      // ── /clearall — force-close every open position ───────────────────────────
      if (text === '/clearall') {
        const allPos = await getOpenPositions();
        if (!allPos.length) {
          await sendTelegram('✅ No open positions to clear.');
        } else {
          await sendTelegram(`🧹 *CLEARING ALL POSITIONS* (${allPos.length} open)…`);
          let cleared = 0;
          for (const pos of allPos) {
            try {
              const price   = await getCurrentPrice(pos.address, pos.chain) || pos.entryPrice;
              const exitPnl = (price - pos.entryPrice) / pos.entryPrice * (pos.size || POSITION_SIZE) * (pos.remaining || 1);
              const pnl     = (pos.pnl || 0) + exitPnl;
              const _result = await realClose(pos, price, 'MANUAL_CLEARALL', pnl);
              if (!_result?.ok) continue;
              await updateDailyStats(exitPnl, exitPnl > 0, !!pos.isManual, 0, pos.strategyId ?? null);
              enteredToday.delete(pos.address);
              cleared++;
            } catch(e) {
              console.error(`[CLEARALL] Failed to close ${pos.symbol} (${pos.id}):`, e.message);
            }
          }
          await sendTelegram(`✅ *Cleared ${cleared}/${allPos.length} positions.*`);
        }
      }

      // ── /clearreal — wipe ghost real-mode positions (no real tx behind them) ───
      if (text === '/clearreal') {
        const snap = await db.collection('real_positions').where('status', '==', 'open').get();
        if (snap.empty) {
          await sendTelegram('✅ No open real positions found — nothing to clear.');
        } else {
          const batch = db.batch();
          snap.docs.forEach(doc => batch.delete(doc.ref));
          await batch.commit();
          await sendTelegram(
            `🗑 *Cleared ${snap.size} ghost real position(s)*\n\n` +
            `These were positions with no confirmed on-chain transaction.\n` +
            `Your actual wallet balance is *unchanged*.\n\n` +
            `_Switch to real mode with /mode real and run /status to confirm._`
          );
        }
      }

      // ── /setsize — show current size or update it ─────────────────────────────
      if (text === '/setsize') {
        // No argument: show current size
        const cfg  = await getTradingConfig();
        const size = parseFloat(cfg.positionSize) || POSITION_SIZE;
        await sendTelegram(`📏 *Current position size:* $${size.toFixed(2)}\nUse \`/setsize 10\` to change.`);
      }
      if (text.startsWith('/setsize ')) {
        const parts   = text.split(' ');
        const newSize = parseFloat(parts[1]);
        if (!newSize || newSize < 1) {
          await sendTelegram('❌ Usage: `/setsize 10` (minimum $1)');
        } else {
          await db.collection('paper_config').doc('control').set(
            { positionSize: newSize }, { merge: true }
          );
          _tradingCfg = null; // bust cache so new size is picked up immediately
          await sendTelegram(`✅ *Position size set to $${newSize.toFixed(2)}*\n_New trades will use this size. Existing positions are unchanged._`);
        }
      }

      // ── /filter — set session-scoped age/mcap/vol restrictions ─────────────────
      if (text.startsWith('/filter')) {
        const args = text.slice(7).trim();
        if (!args || args === 'clear' || args === 'off') {
          sessionFilters = { minAgeDays: null, maxAgeDays: null, minMcap: null, maxMcap: null, minVol: null, maxVol: null, minLiq: null, maxLiq: null };
          await saveSessionFilters();
          await sendTelegram(`✅ *SESSION FILTERS CLEARED*\n\nBot will scan all coins matching its normal strategies.`);
          continue;
        }
        if (args === 'status' || args === 'show') {
          await sendTelegram(`🔍 *ACTIVE SESSION FILTERS*\n\n${fmtSessionFilters()}`);
          continue;
        }
        const newFilters = { ...sessionFilters };
        const errors = [];
        for (const part of args.split(/\s+/)) {
          const eqIdx = part.indexOf('=');
          if (eqIdx < 0) { errors.push(`Invalid: ${part}`); continue; }
          const k = part.slice(0, eqIdx).toLowerCase();
          const v = part.slice(eqIdx + 1);
          if (k === 'age') {
            const r = parseFilterRange(v, true);
            newFilters.minAgeDays = r.min; newFilters.maxAgeDays = r.max;
          } else if (k === 'mcap') {
            const r = parseFilterRange(v, false);
            newFilters.minMcap = r.min; newFilters.maxMcap = r.max;
          } else if (k === 'vol') {
            const r = parseFilterRange(v, false);
            newFilters.minVol = r.min; newFilters.maxVol = r.max;
          } else if (k === 'liq' || k === 'liquidity') {
            const r = parseFilterRange(v, false);
            newFilters.minLiq = r.min; newFilters.maxLiq = r.max;
          } else {
            errors.push(`Unknown filter: ${k} (use age, mcap, vol, liq)`);
          }
        }
        if (errors.length) {
          await sendTelegram(
            `⚠️ *FILTER ERROR*\n\n${errors.join('\n')}\n\n` +
            `*Usage:* /filter age=18m-4h mcap=10k-100k liq=8k-100k\n` +
            `Examples:\n· /filter liq=8k-100k (liquidity range)\n· /filter age=30m-2h liq=10k+ (young coins with liq)\n· /filter age=1-15d mcap=1m+ vol=50k+\n· /filter clear\n\n` +
            `_Age units: m/min (minutes), h/hr (hours), d (days), mo (months)_`
          );
          continue;
        }
        sessionFilters = newFilters;
        await saveSessionFilters();
        await sendTelegram(
          `✅ *SESSION FILTERS SET*\n\n${fmtSessionFilters()}\n\n` +
          `Bot will only auto-enter coins matching ALL active filters.\n` +
          `_Send /filter clear to remove restrictions._`
        );
        continue;
      }

      // ── /track — register an already-held position for bot monitoring ────────────
      // Usage: /track <address> <token_qty> [sl=10 tp1=25 tp2=75 tp3=200]
      if (text.startsWith('/track ')) {
        const parts = text.slice(7).trim().split(/\s+/);
        const addr  = parts[0];
        const qty   = parseFloat(parts[1]);
        if (!addr || isNaN(qty) || qty <= 0) {
          await sendTelegram(
            `⚠️ *TRACK USAGE*\n\n` +
            `/track <address> <token_qty>\n` +
            `Optional: sl=10 tp1=25 tp2=75 tp3=200\n\n` +
            `Example:\n/track 7xKX...abcd 1500000\n/track 7xKX...abcd 1500000 sl=12 tp1=30 tp2=80 tp3=250`
          );
          continue;
        }
        // Parse optional SL/TP overrides (percentages)
        const optOverrides = {};
        for (const p of parts.slice(2)) {
          const [k, v] = p.split('=');
          if (!k || !v) continue;
          const pct = parseFloat(v);
          if (isNaN(pct)) continue;
          if (k === 'sl')  optOverrides.sl  = pct;
          if (k === 'tp1') optOverrides.tp1 = pct;
          if (k === 'tp2') optOverrides.tp2 = pct;
          if (k === 'tp3') optOverrides.tp3 = pct;
        }
        await sendTelegram(`🔍 Fetching price for tracked position…`);
        try {
          const _trackR   = await httpGet('api.dexscreener.com', `/latest/dex/tokens/${addr}`);
          const _trackD   = JSON.parse(_trackR.body);
          const _pairs    = (_trackD.pairs || []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
          const pairData  = _pairs[0] || null;
          if (!pairData) {
            await sendTelegram(`⚠️ Could not find pair data for that address. Check the contract address and try again.`);
            continue;
          }
          const price = parseFloat(pairData.priceUsd || 0);
          if (!price) {
            await sendTelegram(`⚠️ Price not available for this token right now.`);
            continue;
          }
          const posSize = price * qty;
          const coin = {
            symbol:   pairData.baseToken?.symbol || '?',
            name:     pairData.baseToken?.name   || '',
            addr,
            chain:    pairData.chainId,
            price,
            liq:      pairData.liquidity?.usd || 0,
            mcap:     pairData.fdv || pairData.marketCap || 0,
            score:    100,
            dexUrl:   `https://dexscreener.com/${pairData.chainId}/${pairData.pairAddress}`,
            strategy: MANUAL_STRATEGY,
            ageDays:  pairData.pairCreatedAt ? (Date.now() - pairData.pairCreatedAt) / 86400000 : 0,
          };
          const pos = await enterPosition(coin, {
            sizeFixed:    posSize,       // lock dollar size = price × qty
            tokenAmount:  qty,           // actual tokens held (for real-mode exit)
            skipSwap:     true,          // already holding — no buy tx
            isManual:     true,
            isTracked:    true,
            ...optOverrides,             // sl, tp1, tp2, tp3 as % overrides
          });
          if (!pos) {
            await sendTelegram(`⚠️ Could not open tracked position (no wallet for chain ${coin.chain}?).`);
            continue;
          }
          const slPct  = ((pos.sl  - pos.entryPrice) / pos.entryPrice * 100).toFixed(1);
          const tp1Pct = ((pos.tp1 - pos.entryPrice) / pos.entryPrice * 100).toFixed(1);
          const tp3Pct = ((pos.tp3 - pos.entryPrice) / pos.entryPrice * 100).toFixed(1);
          await sendTelegram(
            `📌 *POSITION TRACKED*\n\n` +
            `*${coin.symbol}* @ ${fmtPrice(price)}\n` +
            `Holdings: ${qty.toLocaleString()} tokens ≈ $${posSize.toFixed(2)}\n\n` +
            `SL: ${fmtPrice(pos.sl)} (${slPct}%)\n` +
            `TP1: ${fmtPrice(pos.tp1)} (+${tp1Pct}%)\n` +
            `TP3: ${fmtPrice(pos.tp3)} (+${tp3Pct}%)\n\n` +
            `_Bot will monitor and execute exits automatically._`
          );
          enteredToday.add(addr);
        } catch(e) {
          console.error('[TRACK]', e.message);
          await sendTelegram(`⚠️ Track failed: ${e.message}`);
        }
        continue;
      }

      // ── /watching — show near-miss coins currently being monitored ──────────────
      if (text === '/watching') {
        if (!watchingCoinsSnapshot || watchingCoinsSnapshot.length === 0) {
          await sendTelegram(`👀 *WATCHING* — No near-miss coins right now\n\n_Bot is scanning; coins that score close to the entry threshold will appear here._`);
        } else {
          const seenSym = new Set();
          const top = watchingCoinsSnapshot
            .sort((a, b) => b.score - a.score)
            .filter(c => { if (seenSym.has(c.symbol)) return false; seenSym.add(c.symbol); return true; })
            .slice(0, 6);
          const ageStr = c => c.ageMinutes < 60
            ? `${Math.round(c.ageMinutes)}min`
            : `${(c.ageMinutes / 60).toFixed(1)}h`;
          const lines = top.map(c =>
            `• *${c.symbol}* — ${c.strategy.label} · Score: *${c.score}/100*\n` +
            `  Age: ${ageStr(c)} | m5: ${c.m5Ch>0?'+':''}${c.m5Ch.toFixed(1)}% | h1: ${c.ch1!=null?(c.ch1>0?'+':'')+c.ch1.toFixed(1)+'%':'—'} | Buy: ${c.buyPct.toFixed(0)}%`
          );
          await sendTelegram(
            `👀 *WATCHING — NOT ENTERING*\n\n` +
            lines.join('\n\n') +
            `\n\n_Needs score ≥ ${MIN_SCORE} to enter automatically_`
          );
        }
      }

      // ── /gates — on-demand gate diagnostic ──────────────────────────────────────
      if (text === '/gates') {
        const gp = gatePeriodStats;
        const lp = lpPeriodStats;
        const sp = stratPeriodStats;
        const total = gp.total;
        if (total === 0 && lp.checked === 0) {
          await sendTelegram(`📊 *GATE STATS* — No data yet\n\n_Stats accumulate between heartbeats (every 20 scans ≈ 5 min). Check back after the next scan cycle._`);
        } else {
          const allRej = Object.entries({
            dex:gp.dex, mom:gp.mom, dead:gp.dead, young:gp.young,
            noMatch:gp.noMatch, ratio:gp.ratio, avgT:gp.avgT,
            noAct:gp.noAct, age:gp.age, live:gp.live,
            honey:gp.honey, txns:gp.txns, liqFloor:gp.liqFloor,
            chain:gp.chain, price:gp.price
          }).filter(([,v]) => v > 0).sort(([,a],[,b]) => b-a)
            .map(([k,v]) => `  ${k}: ${v}`).join('\n');
          const lpStatus = lp.checked > 0
            ? `Checked: ${lp.checked} → Passed: ${lp.passed}\n  Fail risk: ${lp.failRisk} | Fail liq: ${lp.failLiq} | Fail ratio: ${lp.failRatio}` +
              (lp.rcFail > 0 ? `\n  ⚠️ RC API failures: ${lp.rcFail}` : '')
            : '  No coins checked yet this period';
          const stratLine = `BB:${sp.bb} AM:${sp.am} SC:${sp.sc} OR:${sp.or} PS:${sp.ps}`;
          const gs = gateSimStats;
          const simTopGlobal = Object.entries({
            liqFloor:gs.liqFloor, honey:gs.honey, txns:gs.txns, avgT:gs.avgT, ratio:gs.ratio,
            youngBuy:gs.youngBuy, youngTxns:gs.youngTxns, dead:gs.dead, noAct:gs.noAct,
            dex:gs.dex, age:gs.age, mom:gs.mom
          }).filter(([,v]) => v > 0).sort(([,a],[,b]) => b-a).slice(0,8)
            .map(([k,v]) => `  ${k}: ${v}`).join('\n');
          const simStratBlock = [
            `  BB: age:${gs.bbAge} ch24:${gs.bbCh24} ch1:${gs.bbCh1} m5:${gs.bbM5Ch} buy:${gs.bbBuy} txns:${gs.bbTxns} liq:${gs.bbLiq}`,
            `  AM: m5:${gs.amM5Ch} buy:${gs.amBuy} txns:${gs.amTxns} liq:${gs.amLiq} ch1:${gs.amCh1}`,
            `  SC: age:${gs.scAge} m5:${gs.scM5Ch} buy:${gs.scBuy} txns:${gs.scTxns} liq:${gs.scLiq} avgT:${gs.scAvgT}`,
            `  OR: age:${gs.orAge} ch24:${gs.orCh24} ch1:${gs.orCh1} buy:${gs.orBuy} liq:${gs.orLiq} b24:${gs.orBuys24}`,
            `  PS: age:${gs.psAge} ch1:${gs.psCh1} m5:${gs.psM5Ch} buy:${gs.psBuy} txns:${gs.psTxns} liq:${gs.psLiq}`,
          ].join('\n');
          const simLpBlock = `  BB:${gs.lpBB} AM:${gs.lpAM} SC:${gs.lpSC} OR:${gs.lpOR} PS:${gs.lpPS} ratio:${gs.lpRatio}`;
          await sendTelegram(
            `📊 *GATE STATS* (since last heartbeat)\n\n` +
            `*Global gate* — ${total} processed\n${allRej || '  (no rejections recorded)'}\n\n` +
            `*LP / RugCheck gate*\n${lpStatus}\n\n` +
            `*Strategies matched:* ${stratLine}\n\n` +
            `🔬 *Sim (${gs.total} coins — bypass-independent)*\n` +
            `*Global independent blocks:*\n${simTopGlobal || '  (none)'}\n\n` +
            `*LP liq simulation:*\n${simLpBlock}\n\n` +
            `*Strategy filter simulation:*\n${simStratBlock}`
          );
        }
      }

      // ── /skipgates — toggle global filter bypass ────────────────────────────────
      if (text === '/skipgates') {
        globalGatesBypass = !globalGatesBypass;
        await saveBypassFlags(); // ← persists across restarts
        const state = globalGatesBypass ? 'OFF 🚫' : 'ON ✅';
        const icon  = globalGatesBypass ? '⚠️' : '✅';
        await sendTelegram(
          `${icon} *GLOBAL GATES: ${state}*\n\n` +
          (globalGatesBypass
            ? `All global filters are now *bypassed* (saved — survives restarts).\n\n` +
              `Bypassed: liq floor, honeypot, anti-manip (avgTrade/txns/ratio), young coin gate, dead coin guard, activity gate, DEX gate, age gate, momentum gate, live price decline.\n\n` +
              `*Only price > 0 and valid chain/address checks remain.*\n\n` +
              `Coins now go straight to strategy-specific scoring.\n\n` +
              `⚠️ _Send /skipgates again to restore gates._`
            : `All global filters *restored* to normal (saved — survives restarts).\n\n` +
              `Run /status to confirm the bot is scanning correctly.`
          )
        );
        continue;
      }

      // ── /skiptiers — toggle tiered entry-gate bypass ────────────────────────────
      if (text === '/skiptiers') {
        tierGateBypass = !tierGateBypass;
        await saveBypassFlags();
        const state = tierGateBypass ? 'OFF 🚫' : 'ON ✅';
        const icon  = tierGateBypass ? '⚠️' : '✅';
        await sendTelegram(
          `${icon} *TIER GATES: ${state}*\n\n` +
          (tierGateBypass
            ? `Tiered entry gates are now *bypassed* (saved — survives restarts).\n\n` +
              `Bypassed: age and buy/sell minimums per position-size tier ($1–$4, $5–$9, $10–$19, $20–$49, $50+).\n\n` +
              `⚠️ _Send /skiptiers again to restore._`
            : `Tiered entry gates *restored* (saved — survives restarts).\n\n` +
              `Coins now must meet age/activity requirements for their position-size tier before entry.`
          )
        );
        continue;
      }

      // ── /skipstrats — toggle per-strategy filter bypass ─────────────────────────
      if (text === '/skipstrats') {
        strategyFiltersActive = !strategyFiltersActive;
        await saveBypassFlags(); // ← persists across restarts
        const state = strategyFiltersActive ? 'ON ✅' : 'OFF 🚫';
        const icon  = strategyFiltersActive ? '✅' : '⚠️';
        await sendTelegram(
          `${icon} *STRATEGY FILTERS: ${state}*\n\n` +
          (!strategyFiltersActive
            ? `All per-strategy filters are now *bypassed* (saved — survives restarts).\n\n` +
              `Bypassed: age gates, momentum thresholds, buy%, m5Txns, h1 requirements, liq floors, and all other strategy-specific scoring gates.\n\n` +
              `*Any coin that reaches strategy scoring will now match.*\n\n` +
              `⚠️ _Send /skipstrats again to restore filters._`
            : `Strategy filters *restored* to normal (saved — survives restarts).\n\n` +
              `Run /status to confirm.`
          )
        );
        continue;
      }

      // ── /skiplp — toggle LP lock bypass ─────────────────────────────────────────
      if (text === '/skiplp') {
        lpLockBypass = !lpLockBypass;
        await saveBypassFlags(); // ← persists across restarts
        const state = lpLockBypass ? 'BYPASSED ⚠️' : 'ACTIVE ✅';
        const icon  = lpLockBypass ? '⚠️' : '✅';
        await sendTelegram(
          `${icon} *LP LOCK CHECK: ${state}*\n\n` +
          (lpLockBypass
            ? `RugCheck security check is now *bypassed* (saved — survives restarts).\n\n` +
              `Bypassed: LP lock check, risk score gate, strict liq floor for unlocked LP.\n\n` +
              `*All coins that pass strategy scoring will now reach the quality gate.*\n\n` +
              `⚠️ _This skips rug protection. Send /skiplp again to restore._`
            : `LP lock check *restored* to normal (saved — survives restarts).\n\n` +
              `RugCheck security checks are active again.\n` +
              `Run /status to confirm.`
          )
        );
        continue;
      }

      // ── /openmode — master switch: open ALL filters at once ─────────────────────
      // Sets globalGatesBypass=true, lpLockBypass=true, strategyFiltersActive=false
      // and persists to Firestore. Toggle again to restore all filters.
      if (text === '/openmode') {
        const allOpen = globalGatesBypass && lpLockBypass && !strategyFiltersActive;
        if (allOpen) {
          // All already open — restore everything
          globalGatesBypass     = false;
          lpLockBypass          = false;
          strategyFiltersActive = true;
        } else {
          // Open everything
          globalGatesBypass     = true;
          lpLockBypass          = true;
          strategyFiltersActive = false;
        }
        await saveBypassFlags();
        if (!allOpen) {
          await sendTelegram(
            `🔓 *OPEN MODE — ALL FILTERS BYPASSED*\n\n` +
            `All entry gates are now *open* (saved — survives restarts).\n\n` +
            `✅ Global gates: OFF\n` +
            `✅ LP/RugCheck: BYPASSED\n` +
            `✅ Strategy filters: OFF\n\n` +
            `The bot will now enter any coin that scores ≥ 1 on any strategy.\n` +
            `Use this to observe the market and validate the pipeline.\n\n` +
            `⚠️ _Paper mode observation — no real capital at risk._\n` +
            `Send /openmode again to restore all filters.\n\n` +
            `Individual controls still work: /skipgates · /skiplp · /skipstrats`
          );
        } else {
          await sendTelegram(
            `🔒 *FILTERS RESTORED — NORMAL MODE*\n\n` +
            `All entry filters are back to normal (saved — survives restarts).\n\n` +
            `✅ Global gates: ON\n` +
            `✅ LP/RugCheck: ACTIVE\n` +
            `✅ Strategy filters: ON\n\n` +
            `Run /status to confirm scanning is active.`
          );
        }
        continue;
      }

      // ── /diagnostic paper|real|off|status ─────────────────────────────────────
      // Bypasses ALL filters (keeps liq ≥ $8k), raises slot cap to DIAG_MAX_POSITIONS.
      //   paper → diagnostic filter, paper trades (safe — no real funds)
      //   real  → diagnostic filter, REAL Jupiter swaps (live test with real SOL)
      //   off   → restore all filters and gates
      //   (no arg / status) → show current state
      // Also accepts legacy /diagnostic on → treated as /diagnostic paper
      if (text === '/diagnostic' || text === '/diagnostic status' ||
          text === '/diagnostic paper' || text === '/diagnostic real' ||
          text === '/diagnostic off' || text === '/diagnostic on') {

        const diagArg = text.split(' ')[1] || '';

        if (!diagArg || diagArg === 'status') {
          // ── Status ──────────────────────────────────────────────────────────
          const diagLabel = !diagnosticMode
            ? 'OFF'
            : diagnosticReal ? '🔴 REAL (live funds)' : '🔬 PAPER (safe)';
          await sendTelegram(
            `🔬 *DIAGNOSTIC MODE — ${diagnosticMode ? 'ACTIVE' : 'OFF'}*\n\n` +
            `Mode: *${diagLabel}*\n` +
            `Trades logged: *${diagnosticTradeCount}/${DIAGNOSTIC_TARGET}*\n` +
            (diagnosticMode
              ? `All filters bypassed (liq ≥ $${(DIAG_MIN_LIQ/1000).toFixed(0)}k only)\n` +
                `Slot cap: ${DIAG_MAX_POSITIONS}\n\n` +
                `Send /diagnostic off to stop. /diagreport for snapshot.`
              : `\nSend /diagnostic paper → safe test\nSend /diagnostic real → live funds test`)
          );

        } else if (diagArg === 'paper' || diagArg === 'on') {
          // ── Enable diagnostic PAPER ─────────────────────────────────────────
          diagnosticMode        = true;
          diagnosticReal        = false;
          globalGatesBypass     = true;
          lpLockBypass          = false; // Nov-25: security checks ACTIVE in diagnostic — RugCheck + holder concentration run normally
          strategyFiltersActive = false;
          autoEntryPaused       = false;
          dayHaltedToday        = false;
          diagnosticTradeCount  = 0;
          let _clearedCount = 0;
          try {
            const _oldSnap = await db.collection('diagnostic_trades').get();
            if (!_oldSnap.empty) {
              const _delBatch = db.batch();
              _oldSnap.docs.forEach(d => _delBatch.delete(d.ref));
              await _delBatch.commit();
              _clearedCount = _oldSnap.size;
            }
          } catch(_e) { console.warn('[DIAG] Could not clear diagnostic_trades:', _e.message); }
          await saveBypassFlags();
          const _sfLine = fmtSessionFilters() !== 'None active'
            ? `🔍 Session filters active:\n${fmtSessionFilters()}\n\n`
            : `🔍 No session filters set — use /filter to narrow entries\n\n`;
          await sendTelegram(
            `🔬 *DIAGNOSTIC PAPER — ON (FRESH START)*\n\n` +
            (_clearedCount > 0 ? `🗑 Previous data cleared (${_clearedCount} trades wiped)\n\n` : ``) +
            `✅ Strategy filters bypassed · Liq ≥ $${(DIAG_MIN_LIQ/1000).toFixed(0)}k floor\n` +
            `✅ Slot cap: ${DIAG_MAX_POSITIONS} · Manual mode: cleared\n` +
            `✅ Daily loss limit: bypassed\n` +
            `🛡 Security: ACTIVE — honeypot (≥3 sells), LP lock, holder concentration\n` +
            `✅ Every closed trade logged to Firestore\n\n` +
            _sfLine +
            `⚠️ _Paper trades only — no real funds at risk._\n` +
            `Send /diagnostic real to switch to live-fund test.\n` +
            `Send /diagnostic off to stop. /diagreport for snapshot.`
          );

        } else if (diagArg === 'real') {
          // ── Enable diagnostic REAL ──────────────────────────────────────────
          diagnosticMode        = true;
          diagnosticReal        = true;
          globalGatesBypass     = true;
          lpLockBypass          = false; // Nov-25: security checks ACTIVE in diagnostic — RugCheck + holder concentration run normally
          strategyFiltersActive = false;
          autoEntryPaused       = false;
          dayHaltedToday        = false;
          diagnosticTradeCount  = 0;
          let _clearedCount2 = 0;
          try {
            const _oldSnap2 = await db.collection('diagnostic_trades').get();
            if (!_oldSnap2.empty) {
              const _delBatch2 = db.batch();
              _oldSnap2.docs.forEach(d => _delBatch2.delete(d.ref));
              await _delBatch2.commit();
              _clearedCount2 = _oldSnap2.size;
            }
          } catch(_e2) { console.warn('[DIAG] Could not clear diagnostic_trades:', _e2.message); }
          await saveBypassFlags();
          await sendTelegram(
            `🔴 *DIAGNOSTIC REAL — ON (LIVE FUNDS)*\n\n` +
            (_clearedCount2 > 0 ? `🗑 Previous data cleared (${_clearedCount2} trades wiped)\n\n` : ``) +
            `⚠️ *REAL SOL WILL BE USED FOR ENTRIES*\n\n` +
            `✅ All strategy filters bypassed · Liq ≥ $${(DIAG_MIN_LIQ/1000).toFixed(0)}k only\n` +
            `✅ Slot cap: ${DIAG_MAX_POSITIONS} · Manual mode: cleared\n` +
            `✅ Daily loss limit: bypassed\n` +
            `✅ Every closed trade logged to Firestore\n\n` +
            `Purpose: test the diagnostic 8k-liq signal with real capital.\n` +
            `Send /diagnostic off to stop at any time. /diagreport for snapshot.`
          );

        } else {
          // ── Off ─────────────────────────────────────────────────────────────
          diagnosticMode        = false;
          diagnosticReal        = false;
          globalGatesBypass     = false;
          lpLockBypass          = false;
          strategyFiltersActive = true;
          await saveBypassFlags();
          await sendTelegram(
            `🔬 *DIAGNOSTIC MODE — OFF*\n\n` +
            `All filters and gates restored to normal.\n` +
            `Trades logged: *${diagnosticTradeCount}/${DIAGNOSTIC_TARGET}*\n\n` +
            `Send /diagreport to view the data collected so far.`
          );
        }
        continue;
      }

      // ── /diagreport — generate diagnostic analysis report ───────────────────────
      if (text === '/diagreport') {
        await sendTelegram(`📊 Generating diagnostic report... (querying ${diagnosticTradeCount} trades)`);
        await generateDiagnosticReport();
        continue;
      }

      // ── /diagclear — wipe all diagnostic_trades records and reset counter ────────
      // Use this to start a fresh measurement period without restarting diagnostic mode.
      if (text === '/diagclear') {
        if (!diagnosticMode) {
          await sendTelegram(`⚠️ Diagnostic mode is not active.\nSend /diagnostic paper or /diagnostic real first.`);
          continue;
        }
        let cleared = 0;
        try {
          const snap = await db.collection('diagnostic_trades').get();
          if (!snap.empty) {
            const batch = db.batch();
            snap.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
            cleared = snap.size;
          }
        } catch(e) {
          await sendTelegram(`❌ Error clearing diagnostic data: ${e.message}`);
          continue;
        }
        diagnosticTradeCount = 0;
        await sendTelegram(
          `🗑 *DIAGNOSTIC DATA CLEARED*\n\n` +
          `${cleared} trade record${cleared !== 1 ? 's' : ''} wiped.\n` +
          `Counter reset to 0/${DIAGNOSTIC_TARGET}.\n\n` +
          `Diagnostic mode is still *${diagnosticReal ? '🔴 REAL' : '🔬 PAPER'}* — bot continues running.\n` +
          `New trades will build a fresh dataset from this point.\n\n` +
          `Send /diagreport anytime for a snapshot.`
        );
        continue;
      }

      // ── /manual | /auto | /pauseentry [on|off] — toggle manual-only mode ───────
      // Manual-only: bot fires alerts but skips enterPosition; manual queue still works.
      // /manual = manual-only on; /auto = back to full auto. Persists across restarts.
      if (text === '/manual' || text === '/auto' ||
          text === '/pauseentry' || text === '/pauseentry on' || text === '/pauseentry off') {
        if (text === '/manual' || text === '/pauseentry on')  autoEntryPaused = true;
        else if (text === '/auto' || text === '/pauseentry off') autoEntryPaused = false;
        else autoEntryPaused = !autoEntryPaused; // /pauseentry toggle
        await saveBypassFlags();
        if (autoEntryPaused) {
          await sendTelegram(
            `🖐 *MANUAL-ONLY MODE ON*\n\n` +
            `Auto-entry is *off* — the bot will not enter positions automatically.\n\n` +
            `You still get full signal alerts. Add tokens to the queue yourself via the dashboard or /enter [address].\n\n` +
            `Monitoring, stop-losses, partial closes and profit withdrawals on existing positions continue normally.\n\n` +
            `Send /auto to return to full auto-entry.`
          );
        } else {
          await sendTelegram(
            `🤖 *AUTO MODE ON*\n\n` +
            `The bot will now enter positions automatically when signals qualify.\n\n` +
            `Send /manual to switch back to manual-only.`
          );
        }
        continue;
      }

      // ── /slbase [30|50] — toggle SL trail mode ──────────────────────────────────
      // '30' = tight 6-phase (30%→5%), '50' = wide phase (50%→5% after recovery)
      // Existing positions keep whatever mode they were entered in.
      if (text === '/slbase' || text === '/slbase 30' || text === '/slbase 50') {
        if (text === '/slbase 30')      slTrailMode = '30';
        else if (text === '/slbase 50') slTrailMode = '50';
        else slTrailMode = slTrailMode === '30' ? '50' : '30'; // toggle
        await saveBypassFlags();
        if (slTrailMode === '30') {
          await sendTelegram(
            `📐 *SL TRAIL: TIGHT MODE (30%)*\n\n` +
            `New entries will use the 6-phase tight trail:\n` +
            `• Entry SL: −30% from entry price\n` +
            `• Tightens: 30%→25%→20%→15%→10%→5% (per +30% ATH gain)\n\n` +
            `_Existing positions keep their original trail mode._\n` +
            `Send /slbase to switch to wide 50% mode.`
          );
        } else {
          await sendTelegram(
            `📐 *SL TRAIL: WIDE MODE (50%)*\n\n` +
            `New entries will use the wide trail:\n` +
            `• Entry SL: −50% from entry price\n` +
            `• Flat 50% gap until +50% ATH gain (capital recovery)\n` +
            `• Then tightens: −5% per +20% ATH gain, floor at 5%\n\n` +
            `_Existing positions keep their original trail mode._\n` +
            `Send /slbase to switch to tight 30% mode.`
          );
        }
        continue;
      }

      // ── /hidden — show backgrounded positions with inline detail buttons ────────
      if (text === '/hidden') {
        const allPos    = await getOpenPositions();
        const bgCoins   = allPos.filter(p => p.backgrounded);
        if (!bgCoins.length) {
          await sendTelegram(`📦 *HIDDEN POSITIONS* — none right now\n\n_Dormant coins will appear here once backgrounded._`);
        } else {
          const lines = bgCoins.map((p, i) => {
            const price   = p.currentPrice || p.entryPrice;
            const gain    = (price - p.entryPrice) / p.entryPrice * 100;
            const holdH   = ((Date.now() - p.enteredAt) / 3600000).toFixed(1);
            return `${i + 1}. *${p.symbol}* ${p.strategyLabel} · ${gain >= 0 ? '+' : ''}${gain.toFixed(1)}% · ${holdH}h`;
          });
          const keyboard = bgCoins.map(p => [
            { text: `${p.symbol} · tap for details`, callback_data: `bg_view:${p.id}` }
          ]);
          await sendTelegramWithButtons(
            `📦 *HIDDEN POSITIONS* (${bgCoins.length})\n\n` +
            lines.join('\n') +
            `\n\n_SL/TP active on all. Tap any to see full details._`,
            keyboard
          );
        }
      }

      // ── /help ─────────────────────────────────────────────────────────────────
      if (text === '/help') {
        await sendTelegram(
          `📋 *MemeScan Bot Commands*\n\n` +
          `/status — P&L, mode, balance\n` +
          `/stats — daily revenue: profit, losses, fees, net\n` +
          `/watching — coins being monitored (near threshold)\n` +
          `/gates — gate rejection breakdown (since last heartbeat)\n` +
          `/hidden — view backgrounded positions (dormant slots)\n` +
          `/mode paper — switch to paper trading\n` +
          `/mode real — switch to real (Solana) trading\n` +
          `/wallets — list connected wallets\n` +
          `/addfunds 500 — add $500 to balance\n` +
          `/setsize 10 — set position size to $10\n` +
          `/clearall — force-close all open positions\n` +
          `/clearreal — delete ghost real-mode positions\n` +
          `/restart — reset daily loss counter\n` +
          `/queue <CA> — evaluate a contract address now\n\n` +
          `🔬 *Research Mode*\n` +
          `/diagnostic paper|real|off — bypass filters, test signal (paper=safe, real=live SOL)\n` +
          `/diagreport — generate trade analysis report now\n` +
          `/diagclear — wipe diagnostic trade history (fresh start, mode stays on)\n\n` +
          `🔓 *Filter Controls* _(saved — survive restarts)_\n` +
          `/openmode — open ALL filters at once (master toggle)\n` +
          `/pauseentry — pause auto-entry (signals still alert; enter manually)\n` +
          `/skipgates — toggle global entry gates\n` +
          `/skiplp — toggle LP/RugCheck security gate\n` +
          `/skipstrats — toggle per-strategy filters\n\n` +
          `💡 *MemeScan PRO Bridge*\n` +
          `Forward any PRO signal here → bot auto-evaluates if PRO score ≥ 80`
        );
      }

      // ── /queue <CA> — manually queue a contract address for immediate evaluation ──
      if (text.startsWith('/queue ')) {
        const ca = text.split(/\s+/)[1]?.trim();
        if (!ca || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) {
          await sendTelegram(
            `❌ Usage: \`/queue <contract_address>\`\n` +
            `Example: \`/queue CvRJ8MrnBpump\`\n` +
            `_Manual entries bypass bot filters and go straight in_`
          );
        } else {
          // Manual command — goes straight in, no filter checks (human override)
          await db.collection('paper_manual_queue').add({
            address: ca, status: 'pending',
            source: 'manual_command',
            queuedAt: Date.now(),
          });
          await sendTelegram(
            `✅ *Queued — entering shortly*\n` +
            `\`${ca.slice(0, 8)}…${ca.slice(-6)}\`\n` +
            `_Manual entries bypass bot filters and go straight in_`
          );
        }
      }

      // ── MemeScan PRO Signal Bridge ─────────────────────────────────────────────
      // Forward (or send) any MemeScan PRO signal to this chat.
      // Bot queues the CA for its own evaluation when the PRO score is ≥ 80.
      // Score < 80 is silently ignored so the chat stays clean.
      if (rawText.includes('MEMESCAN PRO SIGNAL') || rawText.includes('MemeScan PRO')) {
        try {
          const scoreMatch = rawText.match(/Score:\s*(\d+)\s*\/\s*100/i);
          const proScore   = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;

          if (proScore >= 80) {
            // Extract CA — Solana base58 address, typically 43-44 chars
            const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
            let ca = null;
            for (const line of lines) {
              if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(line)) { ca = line; break; }
            }

            if (ca) {
              const existSnap = await db.collection('paper_manual_queue')
                .where('address', '==', ca).where('status', '==', 'pending').get();
              if (existSnap.empty) {
                await db.collection('paper_manual_queue').add({
                  address: ca, status: 'pending',
                  source: 'memscan_pro_signal',
                  proScore,
                  queuedAt: Date.now(),
                });
                // Nov-11: silent queue — no Telegram ack; bot speaks only on actual entry
                console.log(`[PRO-BRIDGE] queued ${ca.slice(0, 8)} (PRO ${proScore}/100)`);
              } else {
                // Nov-11: silent duplicate — already queued, bot is on it
                console.log(`[PRO-BRIDGE] ${ca.slice(0, 8)} already queued`);
              }
            } else {
              // Nov-11: silent parse failure — user forwarded signal without extractable CA
              console.log(`[PRO-BRIDGE] could not extract CA from PRO signal (score ${proScore})`);
            }
          }
          // score < 80 → silent ignore
          // Nov-11: auto-delete the PRO signal message so the chat stays clean
          await deleteTelegramMessage(chatId, update.message?.message_id).catch(() => {});
        } catch(e) { console.error('[PRO-BRIDGE]', e.message); }
      } // closes PRO bridge if block

      } catch(cmdErr) { // ── end per-message guard ────────────────────────────
        console.error(`[CMD] Error on update ${update.update_id}:`, cmdErr.message);
        await sendTelegram(`❌ Command error — please retry`).catch(() => {});
      }
    }
  } catch(e) {
    console.error('[TELEGRAM-POLL]', e.message);
  }
}

// ─── SURGE REINVESTMENT ──────────────────────────────────────────────────────
// Called after a surge exit. Opens two new positions from a capped portion of profit:
//   • Moon bag  (50%): tpDisabled, graduated SL 25% → 5% floor
//   • Normal    (50%): standard TP1/TP2/TP3 for the original strategy
//
// Reinvestment tiers (prevents pumping $3k back into a thin coin):
//   profit ≤ $100   → reinvest all (up to $100)
//   $100–$200       → reinvest flat $100
//   $200–$500       → reinvest $150
//   > $500          → reinvest 20%, capped at $200
//   Liquidity check → never reinvest more than 0.5% of pool liquidity
async function calcSurgeReinvest(totalPnL, liquidityUsd) {
  let base;
  if (totalPnL <= 100)       base = totalPnL;          // reinvest everything
  else if (totalPnL <= 200)  base = 100;               // flat $100
  else if (totalPnL <= 500)  base = 150;               // flat $150
  else                       base = Math.min(totalPnL * 0.20, 200); // 20%, max $200

  // Liquidity cap: never reinvest more than 0.5% of current pool liquidity
  // (avoids massive price impact on thin coins)
  if (liquidityUsd > 0) {
    const liqCap = liquidityUsd * 0.005; // 0.5% of pool
    if (liqCap < base) {
      console.log(`[SURGE REINVEST] Liquidity cap applied: $${base.toFixed(2)} → $${liqCap.toFixed(2)} (pool $${liquidityUsd.toFixed(0)})`);
      base = Math.max(liqCap, 20); // never less than $20 if we bother at all
    }
  }

  return Math.max(base, 0);
}

// openSurgeReinvest disabled — surge exit + reinvest mechanic removed.
// Profit protection is now handled entirely by the capital floor (100% gain → capital withdrawn)
// and the progressive trailing SL. No new position is ever opened at the surge peak price.
async function openSurgeReinvest(pos, exitPrice, totalPnL) {
  console.log(`[SURGE REINVEST] Disabled — ${pos.symbol} $${totalPnL?.toFixed(2)} profit rides via capital floor + trail`);
  return;
  // ── dead code below — kept for reference ──
  if (totalPnL <= 0) return;

  // Check slots
  const openPositions = await getVisiblePositions();
  const slotsLeft = MAX_POSITIONS - openPositions.length;
  if (slotsLeft < 1) {
    await sendTelegram(`⚠️ *SURGE REINVEST SKIPPED — ${pos.symbol}*\nNo open slots (${openPositions.length}/${MAX_POSITIONS})`);
    return;
  }

  // Fetch current liquidity for the coin to apply slippage cap
  let liquidityUsd = pos.liquidityAtEntry || 0;
  try {
    const r = await httpGet('api.dexscreener.com', `/latest/dex/tokens/${pos.address}`);
    const d = JSON.parse(r.body);
    if (d.pairs?.length) {
      d.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      liquidityUsd = d.pairs[0].liquidity?.usd || liquidityUsd;
    }
  } catch(e) {
    console.warn(`[SURGE REINVEST] Could not fetch liquidity for ${pos.symbol}:`, e.message);
  }

  const reinvestAmt = await calcSurgeReinvest(totalPnL, liquidityUsd);
  if (reinvestAmt < 5) {
    await sendTelegram(`⚠️ *SURGE REINVEST SKIPPED — ${pos.symbol}*\nReinvest amount too small ($${reinvestAmt.toFixed(2)}) — pool liquidity too thin`);
    return;
  }
  const moonBagAmt  = reinvestAmt * SURGE_MOON_BAG_RATIO;
  const normalAmt   = reinvestAmt - moonBagAmt;
  const s           = STRATEGIES.find(st => st.id === pos.strategyId) || STRATEGIES[1];

  const baseDoc = {
    symbol: pos.symbol, name: pos.name, address: pos.address,
    chain: pos.chain, dexUrl: pos.dexUrl,
    strategyId: pos.strategyId, strategyLabel: pos.strategyLabel,
    entryPrice: exitPrice, peakPrice: exitPrice,
    currentSL: exitPrice * (1 - MOON_BAG_INITIAL_SL),
    sl:         exitPrice * (1 - MOON_BAG_INITIAL_SL),
    initialTrailPct: MOON_BAG_INITIAL_SL * 100,
    trailingActive: false, remaining: 1.0,
    tp1Hit: false, tp2Hit: false,
    partialStage: 0, recoveredAmount: 0, freeRide: false,
    youngCoin: false, surgeMomentum: false,
    status: 'open', enteredAt: Date.now(), pnl: 0,
    tradingMode: pos.tradingMode || 'paper',
    walletId: pos.walletId || null, walletLabel: pos.walletLabel || null,
    walletAddress: pos.walletAddress || null, walletChain: pos.walletChain || null,
    score: pos.score || 80, isManual: false, isReinvest: true,
  };

  // ── Moon bag ─────────────────────────────────────────────────────────────
  const { positions: _posCol } = await getCollections();
  const mbRef = db.collection(_posCol).doc();
  const moonBagDoc = {
    ...baseDoc, size: moonBagAmt,
    tp1: exitPrice * 1.30, tp2: exitPrice * 1.80, tp3: exitPrice * 3.00,
    tpDisabled: true,  // no TP exits — rides on graduated SL only
    isMoonBag: true, parentPositionId: pos.id,
  };
  await mbRef.set(moonBagDoc);

  // ── Normal TP position ────────────────────────────────────────────────────
  let normalRef = null;
  if (slotsLeft >= 2) {
    normalRef = db.collection(_posCol).doc();
    const normalDoc = {
      ...baseDoc, size: normalAmt,
      tp1: exitPrice * s.tp1x, tp2: exitPrice * s.tp2x, tp3: exitPrice * s.tp3x,
      sl: exitPrice * s.slx, currentSL: exitPrice * s.slx,
      initialTrailPct: s.initialTrailPct,
      tpDisabled: false, isMoonBag: false,
    };
    await normalRef.set(normalDoc);
  }

  // Invalidate cache so next monitor cycle picks up the new positions
  _posCacheAt = 0;

  const tpLine = slotsLeft >= 2
    ? `📈 *Normal $${normalAmt.toFixed(2)}*: TP1 +${((s.tp1x-1)*100).toFixed(0)}% → TP2 +${((s.tp2x-1)*100).toFixed(0)}% → TP3 +${((s.tp3x-1)*100).toFixed(0)}%`
    : `⚠️ Only 1 slot open — moon bag only`;

  const reinvestPct = ((reinvestAmt / totalPnL) * 100).toFixed(0);
  await sendTelegram(
    `♻️ *SURGE REINVEST — ${pos.symbol}*\n\n` +
    `💰 Total profit: *+$${totalPnL.toFixed(2)}* | Reinvesting ${reinvestPct}% = *$${reinvestAmt.toFixed(2)}*\n` +
    `💧 Pool liquidity: $${liquidityUsd > 0 ? (liquidityUsd/1000).toFixed(0)+'k' : 'unknown'}\n\n` +
    `🌕 *Moon Bag $${moonBagAmt.toFixed(2)}*:\n` +
    `   SL: 25% → 20% (+50%) → 15% (+100%) → 10% (+150%) → 5% (+250%)\n` +
    `   Pure ride — no TP exits, just gradual SL floor\n\n` +
    `${tpLine}\n\n🔗 [Chart](${pos.dexUrl})`
  );
  console.log(`[SURGE REINVEST] ${pos.symbol}: MoonBag $${moonBagAmt.toFixed(2)} + Normal $${slotsLeft>=2?normalAmt.toFixed(2):'SKIPPED (no slot)'}`);
}

// ─── PRICE HISTORY HELPERS ────────────────────────────────────────────────────
function recordPriceHistory(addr, price, score, vol = 0, buys = 0, sells = 0) {
  if (!price || price <= 0) return;
  const hist = priceHistory.get(addr) || [];
  hist.push({ price, score, ts: Date.now(), vol, buys, sells });
  if (hist.length > PRICE_HIST_MAX) hist.shift();
  priceHistory.set(addr, hist);
}

// True = last N prices consistently rising (momentum confirmed)
// null = not enough data yet
function isTrendingUp(addr, points = PRICE_HIST_TREND) {
  const hist = priceHistory.get(addr);
  if (!hist || hist.length < points) return null;
  const tail = hist.slice(-points);
  for (let i = 1; i < tail.length; i++) {
    if (tail[i].price < tail[i-1].price * 0.998) return false;
  }
  return true;
}

// True = coin dipped then recovered >= 5% from local minimum
// null = not enough data
function isRebounding(addr) {
  const hist = priceHistory.get(addr);
  if (!hist || hist.length < PRICE_HIST_TREND) return null;
  const prices = hist.map(h => h.price);
  const minPrice = Math.min(...prices);
  const minIdx   = prices.lastIndexOf(minPrice);
  const curPrice = prices[prices.length - 1];
  if (minIdx === prices.length - 1) return false;
  return (curPrice - minPrice) / minPrice >= PRICE_HIST_REBOUND_PCT;
}

// True = last N prices ALL declining (active downtrend — the only hard block)
function isDeclining(addr, points = PRICE_HIST_TREND) {
  const hist = priceHistory.get(addr);
  if (!hist || hist.length < points) return false;
  const tail = hist.slice(-points);
  for (let i = 1; i < tail.length; i++) {
    if (tail[i].price > tail[i-1].price * 1.002) return false; // allow 0.2% noise
  }
  return true; // every reading lower than the last
}

// Returns a quality label for logging
function priceQualityLabel(addr) {
  if (isTrendingUp(addr) === true) return '📈 TREND';
  if (isRebounding(addr) === true) return '🔄 REBOUND';
  if (isDeclining(addr))           return '📉 DECLINING';
  const hist = priceHistory.get(addr);
  if (!hist || hist.length < PRICE_HIST_TREND) return '🆕 NEW';
  return '➡️ STABLE';
}

// ─── SURGE_CATCH PULLBACK GATE ────────────────────────────────────────────────
// Called for every SURGE_CATCH candidate in the entry loop.
// Returns true → enter now.  false → keep watching (or discard if dumped).
//
// State machine per coin (stored in surgeWatchlist):
//   1. FIRST SIGHT: add to watchlist at current price (the peak) — don't enter yet.
//   2. RISING FURTHER: update peak price, reset pullback tracking.
//   3. PULLBACK (5–35% below peak): track pullback low.
//   4. BOUNCE (3%+ recovery from pullback low): enter the position.
//   5. DUMP (>35% below peak): discard — not a pullback, a collapse.
//   6. EXPIRY (25 min): discard — surge faded, no good entry appeared.
//
// Mutates coin._pulledBackPct / coin._bouncedPct so the Telegram entry message
// can mention the pullback details when returning true.
function checkSurgePullback(coin, pullbackMin = SURGE_PULLBACK_MIN, bounceConfirm = SURGE_BOUNCE_CONFIRM) {
  const addr  = coin.addr;
  const price = coin.price;
  const now   = Date.now();

  let entry = surgeWatchlist.get(addr);

  // ── FIRST SIGHT ──────────────────────────────────────────────────────────────
  if (!entry) {
    surgeWatchlist.set(addr, {
      symbol:           coin.symbol,
      peakPrice:        price,
      pullbackLow:      Infinity,
      pullbackDetected: false,
      watchedSince:     now,
    });
    console.log(`[SURGE-WATCH] ${coin.symbol} — added at $${fmtPrice(price)}, waiting for pullback`);
    return false; // don't enter on first sight — wait for the dip
  }

  // ── EXPIRY CHECK ─────────────────────────────────────────────────────────────
  if (now - entry.watchedSince > SURGE_WATCH_EXPIRY_MS) {
    surgeWatchlist.delete(addr);
    console.log(`[SURGE-WATCH] ${coin.symbol} — expired after 3 min without entry`);
    return false;
  }

  // ── BUY-RATE CONFIRMATION: enter without pullback if momentum is sustained ────
  // Requires: watched ≥1 min + strong buy rate + healthy avg trade + uptrend
  const watchedMs = now - entry.watchedSince;
  if (
    watchedMs >= SURGE_CONFIRM_MIN_MS &&
    coin.m5BuyRate  >= SURGE_BUY_RATE_MIN  &&
    coin.avgTrade   >= SURGE_AVG_TRADE_MIN &&
    isTrendingUp(addr, 3)
  ) {
    coin._buyRateEntry = true;
    console.log(`[SURGE-WATCH] ${coin.symbol} — BUY-RATE CONFIRMED ✅ ${coin.m5BuyRate.toFixed(1)}/min buys, avgTrade $${coin.avgTrade?.toFixed(0)}, trend up — ENTERING`);
    surgeWatchlist.delete(addr);
    return true; // ✅ enter on sustained momentum
  }

  // ── STILL RISING: update peak ─────────────────────────────────────────────────
  if (price >= entry.peakPrice) {
    entry.peakPrice        = price;
    entry.pullbackLow      = Infinity;
    entry.pullbackDetected = false;
    console.log(`[SURGE-WATCH] ${coin.symbol} — new peak $${fmtPrice(price)}, still surging`);
    return false;
  }

  const dropFromPeak = (entry.peakPrice - price) / entry.peakPrice;

  // ── DUMP GUARD: too deep, not a healthy pullback ──────────────────────────────
  if (dropFromPeak > SURGE_PULLBACK_MAX) {
    surgeWatchlist.delete(addr);
    console.log(`[SURGE-WATCH] ${coin.symbol} — dumped ${(dropFromPeak*100).toFixed(1)}% from peak — aborting watch`);
    return false;
  }

  // ── PULLBACK ZONE ─────────────────────────────────────────────────────────────
  if (dropFromPeak >= pullbackMin) {
    entry.pullbackDetected = true;
    if (price < entry.pullbackLow) entry.pullbackLow = price; // track the deepest dip

    // ── BOUNCE CONFIRMATION: recovering from pullback low ─────────────────────
    if (entry.pullbackLow < Infinity) {
      const bounceFromLow = (price - entry.pullbackLow) / entry.pullbackLow;
      if (bounceFromLow >= bounceConfirm) {
        // Bounce confirmed — enter now!
        coin._pulledBackPct = (dropFromPeak  * 100).toFixed(1);
        coin._bouncedPct    = (bounceFromLow * 100).toFixed(1);
        console.log(`[SURGE-WATCH] ${coin.symbol} — BOUNCE ✅ pulled back ${coin._pulledBackPct}% then bounced ${coin._bouncedPct}% — ENTERING`);
        surgeWatchlist.delete(addr);
        return true; // ✅ enter position
      }
      console.log(`[SURGE-WATCH] ${coin.symbol} — pullback ${(dropFromPeak*100).toFixed(1)}% | bounce ${(bounceFromLow*100).toFixed(1)}% (need ${(bounceConfirm*100).toFixed(0)}%)`);
    } else {
      console.log(`[SURGE-WATCH] ${coin.symbol} — in pullback ${(dropFromPeak*100).toFixed(1)}% below peak — tracking low`);
    }
    return false;
  }

  // ── SMALL DIP: not yet in pullback zone ──────────────────────────────────────
  console.log(`[SURGE-WATCH] ${coin.symbol} — ${(dropFromPeak*100).toFixed(1)}% below peak — waiting for ≥${(pullbackMin*100).toFixed(0)}% pullback`);
  return false;
}

// ─── RUGCHECK HELPER ─────────────────────────────────────────────────────────
// Calls api.rugcheck.xyz for one Solana token.
// Returns { lpLocked, riskScore, ts } or null on error (caller fails open).
// Defensive: handles both the native RugCheck report structure and wrapper APIs.
async function checkRugCheck(addr, symbol) {
  const cached = rugCheckCache.get(addr);
  if (cached && Date.now() - cached.ts < RUGCHECK_TTL) return cached;

  try {
    const r = await httpGet('api.rugcheck.xyz', `/v1/tokens/${addr}/report`);
    if (r.status !== 200) {
      console.warn(`[RUGCHECK] ${symbol} (${addr.slice(0,8)}…) — HTTP ${r.status}`);
      return null;
    }
    const d = JSON.parse(r.body);

    // ── Extract LP lock ────────────────────────────────────────────────────
    // Native RugCheck report: markets[].lp.lpLocked (percentage) or markets[].lp.lpBurned
    // Wrapper APIs: lp_locked boolean
    let lpLocked = false;
    if (Array.isArray(d.markets)) {
      for (const m of d.markets) {
        const lp = m.lp || m.lpInfo || {};
        if ((lp.lpLocked > 0) || (lp.lpBurned > 0)) { lpLocked = true; break; }
      }
    }
    if (!lpLocked && d.lp_locked === true) lpLocked = true;

    // ── Extract risk score (normalise to 0–100) ───────────────────────────
    // Native RugCheck: 'score' on 0–65535 scale (inverted — lower = riskier)
    // Some wrappers expose risk_score 0–100 directly
    let riskScore = 50; // default to mid-risk if unknown
    if (typeof d.score === 'number') {
      // Native scale is 0–65535; normalise to 0–100 risk (invert: high score = good = low risk)
      riskScore = Math.max(0, Math.min(100, Math.round(100 - (d.score / 65535) * 100)));
    } else if (typeof d.risk_score === 'number') {
      riskScore = Math.min(100, d.risk_score);
    }

    // ── Mint/freeze signals from RugCheck risks ───────────────────────────
    const risks = d.risks || d.warnings || [];
    const hasCriticalRisk = risks.some(r => /mint|freeze|rug/i.test(r.name || r.label || ''));

    // ── Level 3: Top holder concentration ────────────────────────────────
    // RugCheck returns topHolders array sorted descending by pct.
    // If top wallet holds >50% of supply it can rug solo at any moment.
    let topHolderPct = null;
    if (Array.isArray(d.topHolders) && d.topHolders.length > 0) {
      topHolderPct = parseFloat(d.topHolders[0].pct) || null;
    }

    const result = { lpLocked, riskScore, hasCriticalRisk, topHolderPct, ts: Date.now() };
    rugCheckCache.set(addr, result);
    const holderStr = topHolderPct !== null ? `, top holder ${topHolderPct.toFixed(1)}%` : '';
    console.log(`[RUGCHECK] ${symbol} (${addr.slice(0,8)}…) — LP ${lpLocked ? 'LOCKED ✅' : 'UNLOCKED ⚠️'}, risk ${riskScore}/100${holderStr}`);
    return result;
  } catch(e) {
    console.warn(`[RUGCHECK] ${symbol} (${addr.slice(0,8)}…) error: ${e.message} — failing open`);
    return null;
  }
}

// ─── LP PROBATION HELPERS ────────────────────────────────────────────────────
function addToProbation(coin, rugScore) {
  if (lpProbationCoins.has(coin.addr)) return; // already tracked

  // Drop oldest if at cap
  if (lpProbationCoins.size >= LP_PROBATION_MAX) {
    let oldestAddr = null, oldestAt = Infinity;
    for (const [a, e] of lpProbationCoins) {
      if (e.addedAt < oldestAt) { oldestAt = e.addedAt; oldestAddr = a; }
    }
    if (oldestAddr) {
      console.log(`[PROBATION] Cap reached — dropping oldest (${lpProbationCoins.get(oldestAddr).symbol})`);
      lpProbationCoins.delete(oldestAddr);
    }
  }

  lpProbationCoins.set(coin.addr, {
    symbol:      coin.symbol,
    addedAt:     Date.now(),
    lastChecked: Date.now(),
    rugScore,
    liq:         coin.liq,
    mcLiqRatio:  coin.mcLiqRatio,
    strategyId:  coin.strategy?.id,
  });
}

// Called from the main scan interval — rechecks probation coins every 5 min.
// If LP gets locked → clears caches so the next normal scan picks the coin up.
async function processLpProbation() {
  if (!lpProbationCoins.size) return;
  const now = Date.now();
  let checked = 0;

  for (const [addr, entry] of lpProbationCoins) {
    // Expire after 90 min
    if (now - entry.addedAt > LP_PROBATION_MAX_MS) {
      lpProbationCoins.delete(addr);
      console.log(`[PROBATION] ⏰ ${entry.symbol} — 90 min elapsed, LP still unlocked, dropped`);
      continue;
    }
    // Only recheck every 5 min
    if (now - entry.lastChecked < LP_PROBATION_RECHECK_MS) continue;

    entry.lastChecked = now;
    checked++;

    // Bust RugCheck cache so we get a fresh read
    rugCheckCache.delete(addr);
    const rc = await checkRugCheck(addr, entry.symbol);
    if (!rc) continue; // RugCheck unavailable — keep on probation

    if (rc.lpLocked) {
      // LP is now locked — clear all caches, next scan will pick it up normally
      lpProbationCoins.delete(addr);
      lpLockCache.delete(addr);
      rugCheckCache.delete(addr);
      console.log(`[PROBATION] 🔓 ${entry.symbol} — LP LOCKED, cleared for entry on next scan`);
      await sendTelegram(
        `🔓 *LP LOCKED* — *${entry.symbol}*\n` +
        `Was on probation · LP lock now confirmed\n` +
        `_Will be picked up on next scan_`
      ).catch(() => {});
    } else {
      const ageMin = Math.floor((now - entry.addedAt) / 60000);
      console.log(`[PROBATION] 🕐 ${entry.symbol} — still unlocked (${ageMin}m in, ${LP_PROBATION_MAX - lpProbationCoins.size + 1} slots remaining)`);
    }

    await sleep(300); // pace RugCheck calls
  }

  if (checked > 0) console.log(`[PROBATION] Rechecked ${checked} probation coins · ${lpProbationCoins.size} still pending`);
}

// ─── LP LOCK + SECURITY FILTER ───────────────────────────────────────────────
// Security filter — RugCheck LP lock check (Solana-native, GoPlus removed Nov-11):
//   Nov-14: Rug risk ceiling RESTORED at 80 (removed Nov-13, back Nov-14).
//   1. RugCheck unavailable (rc-fail) → liq+ratio filter only (no risk check)
//   2. LP locked → pass unconditionally
//   3. pump.fun bonding-curve → pass unconditionally (no traditional LP pool)
//   3.5. PumpSwap graduated → pass if risk ≤ 80, reject if > 80
//   4. LP unlocked + risk ≤ 80 + liq ≥ minLiq + ratio ≤ 30× → PASS
//   4r. LP unlocked + risk > 80 OR thin pool / bad ratio → hard block
//
// EVM chains: fail open (no checker after GoPlus removal).
// Results cached 10 min.
async function filterByLpLock(matches) {
  const passed   = new Set();
  const toCheck  = [];

  for (const coin of matches) {
    const cached = lpLockCache.get(coin.addr);
    if (cached && Date.now() - cached.ts < LP_LOCK_TTL) {
      if (cached.locked) passed.add(coin.addr);
      continue;
    }
    toCheck.push(coin);
  }

  if (!toCheck.length) return matches.filter(c => passed.has(c.addr));

  for (const coin of toCheck) {
    const chain    = (coin.chain || '').toLowerCase();
    const isSolana = chain === 'solana';

    // ── Non-Solana: no checker available — fail open ──────────────────────
    if (!isSolana) {
      lpLockCache.set(coin.addr, { locked: true, ts: Date.now() });
      passed.add(coin.addr);
      continue;
    }

    // ── RugCheck — LP lock + risk score + holder concentration (Solana) ───
    const rc = await checkRugCheck(coin.addr, coin.symbol);
    lpPeriodStats.checked++;

    // Level 3: Holder concentration — top wallet >50% = can rug solo instantly.
    // Not applied to pump.fun bonding curve (the curve contract inherently holds supply).
    if (rc && !coin.isPumpFun && rc.topHolderPct !== null && rc.topHolderPct > 50) {
      console.log(`[RUGCHECK] ❌ ${coin.symbol} — top holder ${rc.topHolderPct.toFixed(1)}% > 50%, rejected`);
      lpPeriodStats.failRisk++;
      lpLockCache.set(coin.addr, { locked: false, ts: Date.now() });
      continue;
    }

    if (!rc) {
      // RugCheck unavailable — apply liq+ratio only (no auto-reject, no auto-pass)
      lpPeriodStats.rcFail++;
      // Trending coins earn a relaxed strict floor — their platform-vetting compensates
      // for lower LP. 1 platform → minLiqLocked; 2+ platforms → minLiqLocked × 0.65.
      const _rcBaseLiq    = coin.strategy?.minLiq || Infinity;
      const _rcLockedLiq  = coin.strategy?.minLiqLocked || _rcBaseLiq;
      const _rcTrendTier  = coin._trendingPlatforms || 0;
      const rcFailStrictLiq = _rcTrendTier >= 2
        ? Math.round(_rcLockedLiq * 0.65)
        : _rcTrendTier === 1
        ? _rcLockedLiq
        : _rcBaseLiq;
      const rcFailStrictRatio = ANTI_MANIP_MC_LIQ_RATIO_MAX;
      const rcFailLiqOk       = coin.liq >= rcFailStrictLiq;
      const rcFailRatioOk     = (coin.mcLiqRatio || 999) <= rcFailStrictRatio;
      if (!rcFailLiqOk) {
        console.log(`[RUGCHECK] ❌ ${coin.symbol} — rc-fail, liq $${coin.liq.toFixed(0)} < $${rcFailStrictLiq}${_rcTrendTier > 0 ? ` (trending:${_rcTrendTier} relaxed)` : ''}, rejected`);
        lpPeriodStats.failLiq++;
        lpLockCache.set(coin.addr, { locked: false, ts: Date.now() });
      } else if (!rcFailRatioOk) {
        console.log(`[RUGCHECK] ❌ ${coin.symbol} — rc-fail, MC/Liq ${(coin.mcLiqRatio||0).toFixed(1)}× > ${rcFailStrictRatio}×, rejected`);
        lpPeriodStats.failRatio++;
        lpLockCache.set(coin.addr, { locked: false, ts: Date.now() });
      } else {
        console.log(`[RUGCHECK] ✅ ${coin.symbol} — rc-fail, liq+ratio OK ($${coin.liq.toFixed(0)}), PASSED`);
        lpPeriodStats.passed++;
        lpLockCache.set(coin.addr, { locked: true, ts: Date.now() });
        passed.add(coin.addr);
      }
      continue;
    }

    // ── 2: LP locked — pass ─────────────────────────────────────────────
    if (rc.lpLocked) {
      console.log(`[RUGCHECK] ✅ ${coin.symbol} — LP locked, risk ${rc.riskScore}/100, PASSED`);
      lpPeriodStats.passed++;
      lpLockCache.set(coin.addr, { locked: true, ts: Date.now() });
      passed.add(coin.addr);
      continue;
    }

    // ── 3: pump.fun bonding-curve — no traditional LP ───────────────────
    // Bonding-curve tokens have no separate LP pool; risk score is the
    // only rug signal available. Already passed gate 1 above (≤maxRiskScore).
    // Nov-11: applies to ANY strategy, not just PS (all strategies compete freely).
    if (coin.isPumpFun) {
      console.log(`[RUGCHECK] ✅ ${coin.symbol} — pump.fun bonding-curve (${coin.strategy?.label}), risk ${rc.riskScore}/100, PASSED`);
      lpPeriodStats.passed++;
      lpLockCache.set(coin.addr, { locked: true, ts: Date.now() });
      passed.add(coin.addr);
      continue;
    }

    // ── 3.5: PumpSwap graduated coins — no traditional LP lock in this ecosystem ─
    // PumpSwap (pump.fun graduated) pools almost never have locked LP; requiring
    // it blocks every PumpSwap coin. Pass on risk score alone (≤ 40).
    // Nov-12: gate added so PumpSwap scans actually yield entries.
    const isPumpSwap = ['pumpswap','pump_amm','pump-amm','pump_swap','pump-swap']
      .includes((coin.dexId || '').toLowerCase());
    if (isPumpSwap) {
      // Nov-14: risk ceiling restored at 80
      if (rc.riskScore > 80) {
        console.log(`[RUGCHECK] ❌ ${coin.symbol} — PumpSwap graduated, risk ${rc.riskScore}/100 > 80, rejected`);
        lpPeriodStats.failRisk++;
        lpLockCache.set(coin.addr, { locked: false, ts: Date.now() });
      } else {
        console.log(`[RUGCHECK] ✅ ${coin.symbol} — PumpSwap graduated, risk ${rc.riskScore}/100 ≤ 80, PASSED`);
        lpPeriodStats.passed++;
        lpLockCache.set(coin.addr, { locked: true, ts: Date.now() });
        passed.add(coin.addr);
      }
      continue;
    }

    // ── 4: LP NOT locked — pass on risk score alone if floors met, else reject ─
    // Nov-12: removed probation; waiting for LP lock almost never triggered an
    // entry in practice (Raydium meme coins rarely lock within 90 min). Coins
    // that clear risk (≤ 40) + liq + ratio floors pass directly — same logic as
    // gate 3.5 for PumpSwap but now extended to all DEXes.
    // Nov-14: rug risk ceiling restored at 80 — risk checked first, then liq+ratio
    // Nov-15: trending coins earn a relaxed strict floor — platform-vetting compensates
    // for lower LP. 1 platform → minLiqLocked; 2+ platforms → minLiqLocked × 0.65.
    const _baseLiq    = coin.strategy?.minLiq || Infinity;
    const _lockedLiq  = coin.strategy?.minLiqLocked || _baseLiq;
    const _trendTier  = coin._trendingPlatforms || 0;
    const strictLiq   = _trendTier >= 2
      ? Math.round(_lockedLiq * 0.65)
      : _trendTier === 1
      ? _lockedLiq
      : _baseLiq;
    const strictRatio = ANTI_MANIP_MC_LIQ_RATIO_MAX; // 30×
    const riskOk      = rc.riskScore <= 80;
    const liqOk       = coin.liq >= strictLiq;
    const ratioOk     = (coin.mcLiqRatio || 999) <= strictRatio;

    if (!riskOk) {
      console.log(`[RUGCHECK] ❌ ${coin.symbol} — LP unlocked, risk ${rc.riskScore}/100 > 80, rejected`);
      lpPeriodStats.failRisk++;
      lpLockCache.set(coin.addr, { locked: false, ts: Date.now() });
    } else if (!liqOk) {
      console.log(`[RUGCHECK] ❌ ${coin.symbol} — LP unlocked, liq $${coin.liq.toFixed(0)} < $${strictLiq} strict floor${_trendTier > 0 ? ` (trending:${_trendTier} relaxed)` : ''}, rejected`);
      lpPeriodStats.failLiq++;
      lpLockCache.set(coin.addr, { locked: false, ts: Date.now() });
    } else if (!ratioOk) {
      console.log(`[RUGCHECK] ❌ ${coin.symbol} — LP unlocked, MC/Liq ${(coin.mcLiqRatio||0).toFixed(1)}× > ${strictRatio}×, rejected`);
      lpPeriodStats.failRatio++;
      lpLockCache.set(coin.addr, { locked: false, ts: Date.now() });
    } else {
      console.log(`[RUGCHECK] ✅ ${coin.symbol} — LP unlocked, risk ${rc.riskScore}/100 ≤ 80, liq $${coin.liq.toFixed(0)}${_trendTier > 0 ? ` [trending:${_trendTier} floor=$${strictLiq}]` : ''}, PASSED`);
      lpPeriodStats.passed++;
      lpLockCache.set(coin.addr, { locked: true, ts: Date.now() });
      passed.add(coin.addr);
    }
    await sleep(200); // pace RugCheck calls
  }

  return matches.filter(c => passed.has(c.addr));
}

// ─── ORPHAN TOKEN RECOVERY ────────────────────────────────────────────────────
// Finds wallet tokens with no open real_positions record and creates monitoring
// positions for them. Runs every 60s automatically + instantly on /recover.
// Covers: bot-entered tokens whose Firestore write silently failed, and tokens
// the trader bought manually outside the bot.
const TOKEN_PROGRAM_ID_STR  = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_ID_STR     = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ORPHAN_MIN_USD        = 0.50;  // ignore dust below this USD value
let lastOrphanScan = 0;
const ORPHAN_SCAN_INTERVAL  = 60000; // at most once per minute (auto mode)

async function detectAndRecoverOrphans(force = false) {
  const cfg = await getTradingConfig();
  if ((cfg.tradingMode || 'paper') !== 'real') return 0; // real mode only

  const now = Date.now();
  if (!force && now - lastOrphanScan < ORPHAN_SCAN_INTERVAL) return 0;
  lastOrphanScan = now;

  try {
    const { Connection, PublicKey } = SolanaWeb3;

    // Get active Solana wallet
    const wallet = await selectWalletForChain('solana', cfg);
    if (!wallet) return 0;
    const pk = process.env[wallet.envKey + '_PRIVATE_KEY'];
    if (!pk) return 0;
    const keypair = parseSolanaKeypair(pk.trim());

    const connection = new Connection(SOL_RPC, 'confirmed');

    // Get ALL token accounts for this wallet (both SPL programs)
    const allTokenAccounts = [];
    for (const progIdStr of [TOKEN_PROGRAM_ID_STR, TOKEN_2022_ID_STR]) {
      try {
        const { value } = await connection.getParsedTokenAccountsByOwner(
          keypair.publicKey,
          { programId: new PublicKey(progIdStr) }
        );
        allTokenAccounts.push(...value);
      } catch(e) {
        console.warn(`[ORPHAN] Token program ${progIdStr.slice(0,8)} query failed: ${e.message}`);
      }
    }
    if (!allTokenAccounts.length) return 0;

    // Get currently tracked open positions
    const openPositions = await getOpenPositions();
    const trackedAddresses = new Set(openPositions.map(p => (p.address || '').toLowerCase()));

    // Get recently closed positions (last 24 h) — don't re-open these
    const { history, positions } = await getCollections();
    const yesterday = Date.now() - 86400000;
    let recentlyClosed = new Set();
    try {
      const rcSnap = await db.collection(history).where('closedAt', '>=', yesterday).get();
      rcSnap.docs.forEach(d => {
        const addr = (d.data().address || '').toLowerCase();
        if (addr) recentlyClosed.add(addr);
      });
    } catch(e) {
      console.warn('[ORPHAN] Could not read recent history:', e.message);
    }

    // Find orphan token accounts
    const orphans = [];
    for (const acct of allTokenAccounts) {
      const info = acct.account?.data?.parsed?.info;
      if (!info) continue;
      const mintAddress = info.mint;
      const rawBalance  = BigInt(info.tokenAmount?.amount || '0');
      if (rawBalance === BigInt(0)) continue;
      if (mintAddress === SOL_MINT) continue;
      if (trackedAddresses.has(mintAddress.toLowerCase())) continue;
      if (recentlyClosed.has(mintAddress.toLowerCase())) continue;
      orphans.push({
        mintAddress,
        rawBalance,
        decimals: info.tokenAmount?.decimals ?? 6,
      });
    }
    if (!orphans.length) return 0;

    // For each orphan: fetch price, verify USD value, create recovery position
    let recovered = 0;
    for (const orphan of orphans) {
      try {
        const r = await httpGet('api.dexscreener.com', `/latest/dex/tokens/${orphan.mintAddress}`);
        const d = JSON.parse(r.body);
        const pairs = (d.pairs || []).filter(p => p.chainId === 'solana');
        if (!pairs.length) {
          console.log(`[ORPHAN] No DexScreener pairs for ${orphan.mintAddress} — skipping`);
          continue;
        }
        pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        const best  = pairs[0];
        const price = parseFloat(best.priceUsd || '0');
        if (!price) continue;

        const humanBalance = Number(orphan.rawBalance) / (10 ** orphan.decimals);
        const usdValue = humanBalance * price;
        if (usdValue < ORPHAN_MIN_USD) {
          console.log(`[ORPHAN] ${best.baseToken?.symbol || orphan.mintAddress.slice(0,8)} dust ($${usdValue.toFixed(4)}) — skipping`);
          continue;
        }

        const symbol  = best.baseToken?.symbol || orphan.mintAddress.slice(0, 8);
        const dexUrl  = best.url || `https://dexscreener.com/solana/${orphan.mintAddress}`;
        const liq     = best.liquidity?.usd   || 0;
        const mcap    = parseFloat(best.marketCap || best.fdv || 0);

        // Create recovery position — entry = current price, SL = 50% below current
        const ref = db.collection(positions).doc();
        const recoveryPos = {
          symbol,
          address:           orphan.mintAddress,
          chain:             'solana',
          entryPrice:        price,
          currentSL:         price * (slTrailMode === '50' ? 0.50 : 0.70),
          peakPrice:         price,
          size:              usdValue,
          remaining:         1.0,
          pnl:               0,
          status:            'open',
          tradingMode:       'real',
          walletId:          wallet.id,
          walletLabel:       wallet.label   || 'Wallet 1',
          walletAddress:     wallet.address || null,
          walletChain:       'solana',
          enteredAt:         Date.now(),
          dexUrl,
          isOrphanRecovery:  true,
          orphanRecoveredAt: Date.now(),
          realTokenAmount:   orphan.rawBalance.toString(),
          capitalWithdrawn:  false,
          strategyId:        -1,
          strategyLabel:     '♻️ Recovered',
          liquidityAtEntry:  liq,
          mcap,
          slTrailMode:       slTrailMode,
          trailPct:          slTrailMode === '50' ? 50 : 30,
        };

        await ref.set(recoveryPos);
        if (_posCache) _posCache.push({ id: ref.id, ...recoveryPos });
        recovered++;

        await sendTelegram(
          `♻️ *ORPHAN TOKEN RECOVERED*\n\n` +
          `*${symbol}* found in wallet with no position record.\n\n` +
          `💵 Est. value: *$${usdValue.toFixed(2)}*\n` +
          `📈 Current price: $${fmtPrice(price)}\n` +
          `🛑 SL set at: $${fmtPrice(price * 0.50)} (50% below current)\n\n` +
          `Bot is now monitoring with standard SL/TP rules.\n` +
          `Entry = current price. SL trails up as price rises.\n` +
          `🔗 [Chart](${dexUrl})`
        ).catch(() => {});
        console.log(`[ORPHAN] ♻️ Recovered ${symbol} ($${usdValue.toFixed(2)}) price $${fmtPrice(price)} SL $${fmtPrice(price * 0.50)}`);

        await sleep(500); // pace DexScreener calls
      } catch(orphanErr) {
        console.warn(`[ORPHAN] Failed to recover ${orphan.mintAddress.slice(0,8)}: ${orphanErr.message}`);
      }
    }
    return recovered;
  } catch(e) {
    console.error('[ORPHAN] detectAndRecoverOrphans error:', e.message);
    return 0;
  }
}

async function monitorPositions() {
  if (!(await isBotRunning())) return;

  // Check for day-restart, period transitions, and add-funds requests
  await checkDayRestart();
  await checkTradingPeriod();
  const cfg = await getTradingConfig();
  await checkAddFunds(cfg);

  // Auto-detect wallet tokens with no position record (rate-limited to once/min)
  await detectAndRecoverOrphans().catch(e => console.warn('[ORPHAN]', e.message));

  const positions = await getOpenPositions();
  if (!positions.length) return;

  // ── MANUAL CLOSE REQUESTS — processed FIRST, even when bot is halted ──────
  // This ensures "Sell Now" on the dashboard always works regardless of daily
  // loss limit state. Without this, closeRequested was silently ignored after
  // the daily limit return below.
  for (const pos of positions) {
    if (!pos.closeRequested) continue;
    const isManual = !!pos.isManual;
    const price    = await getCurrentPrice(pos.address, pos.chain) || pos.entryPrice;
    const exitFillPriceManual = pos.tradingMode === 'paper'
      ? simulateFillPrice(price, pos.size * pos.remaining, pos.liquidityAtEntry || 0, false)
      : price;
    const exitPnl  = (exitFillPriceManual - pos.entryPrice) / pos.entryPrice * pos.size * pos.remaining;
    const pnl      = (pos.pnl || 0) + exitPnl;
    const _result = await realClose(pos, exitFillPriceManual, 'MANUAL_CLOSE', pnl);
    if (!_result?.ok) continue;
    await updateDailyStats(exitPnl, exitPnl > 0, isManual, calcExitFeeUsd(pos, price, exitFillPriceManual, pos.remaining, _result.exitImpactPct), pos.strategyId ?? null);
    enteredToday.delete(pos.address);
    await sendTelegram(
      `🚫 *MANUAL CLOSE*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
      `${fmtTradeResult(pos.size, pnl)}\n` +
      `📥 Exit price: $${fmtPrice(exitFillPriceManual)}\n🔗 [Chart](${pos.dexUrl})` +
      `${_result.txHash ? `\n📡 [Tx](https://solscan.io/tx/${_result.txHash})` : ''}`
    );
  }

  // Refresh list after manual closes
  const remaining_positions = await getOpenPositions();
  if (!remaining_positions.length) return;

  const stats = await getDailyStats();
  // Diagnostic mode runs outside the daily loss limit — bypassed entirely so the
  // 1,000-trade research trial is not interrupted by normal daily P&L boundaries.
  if (!diagnosticMode && stats.realizedPnL / stats.startBalance <= DAILY_LOSS_LIMIT) {
    if (!dayHaltedToday) {
      // First time crossing the limit this session — close all and notify
      console.log('[BOT] Daily loss limit hit — closing all positions');
      dayHaltedToday = true;
      for (const pos of remaining_positions) {
        const price         = await getCurrentPrice(pos.address, pos.chain) || pos.entryPrice;
        const exitFillPrice = pos.tradingMode === 'paper'
          ? simulateFillPrice(price, pos.size * pos.remaining, pos.liquidityAtEntry || 0, false)
          : price;
        const exitPnl       = (exitFillPrice - pos.entryPrice) / pos.entryPrice * pos.size * pos.remaining;
        const pnl           = (pos.pnl || 0) + exitPnl;
        const _result = await realClose(pos, exitFillPrice, 'DAILY_LIMIT', pnl);
        if (!_result?.ok) continue;
        await updateDailyStats(exitPnl, exitPnl > 0, !!pos.isManual, calcExitFeeUsd(pos, price, exitFillPrice, pos.remaining, _result.exitImpactPct), pos.strategyId ?? null);
        await sendTelegram(`🚨 *DAILY LOSS LIMIT*\n*${pos.symbol}* ${pos.strategyLabel}\n${fmtTradeResult(pos.size, pnl)}` +
          `${_result.txHash ? `\n📡 [Tx](https://solscan.io/tx/${_result.txHash})` : ''}`);
      }
      const lostPct = Math.abs((stats.realizedPnL / stats.startBalance) * 100).toFixed(1);
      await sendTelegram(
        `🛑 *BOT HALTED — Daily ${lostPct}% loss limit reached*\n\n` +
        `All positions closed. No new entries today.\n\n` +
        `▶️ *To restart the day:*\n` +
        `• Send */restart* here\n` +
        `• Or tap Restart Day on the dashboard\n\n` +
        `_Loss counter resets. Previous P&L is locked for records._`
      );
    }
    return;
  }

  // Track coins where rug emergency exit fired this tick — skip normal processing
  const rugExitedThisTick = new Set();

  for (const pos of remaining_positions) {
    const isManual = !!pos.isManual;

    // Skip if already emergency-exited this tick (rug on same coin, multiple positions)
    if (rugExitedThisTick.has(pos.address)) continue;

    // Auto-close after 7 days
    if (Date.now() - pos.enteredAt > 7 * 86400000) {
      const price   = await getCurrentPrice(pos.address, pos.chain) || pos.entryPrice;
      const exitFillPriceExp = pos.tradingMode === 'paper'
        ? simulateFillPrice(price, pos.size * pos.remaining, pos.liquidityAtEntry || 0, false)
        : price;
      const exitPnl = (exitFillPriceExp - pos.entryPrice) / pos.entryPrice * pos.size * pos.remaining;
      const pnl     = (pos.pnl || 0) + exitPnl;  // total including any earlier partial exits
      const _result = await realClose(pos, exitFillPriceExp, 'EXPIRED', pnl);
      if (!_result?.ok) continue;
      await updateDailyStats(exitPnl, exitPnl > 0, isManual, calcExitFeeUsd(pos, price, exitFillPriceExp, pos.remaining, _result.exitImpactPct), pos.strategyId ?? null);
      await sendTelegram(`⏰ *EXPIRED* — *${pos.symbol}* ${pos.strategyLabel}\n${fmtTradeResult(pos.size, pnl)}\n📥 Exit: $${fmtPrice(exitFillPriceExp)}\n🔗 [Chart](${pos.dexUrl})` +
        `${_result.txHash ? `\n📡 [Tx](https://solscan.io/tx/${_result.txHash})` : ''}`);
      enteredToday.delete(pos.address);
      continue;
    }

    const { price, liq: currentLiq } = await getCurrentPriceAndLiq(pos.address, pos.chain);
    if (!price || price <= 0) continue;

    // ── LIQUIDITY DRAIN EXIT ──────────────────────────────────────────────────
    // If pool liquidity drops below $2,500 we can no longer exit at any real price.
    // PumpSwap coins get a 4-min grace window (secondary Raydium migration may cause
    // a temporary collapse that is NOT a rug). All other DEXes exit immediately.
    if (currentLiq !== null && currentLiq < 2500 && !closingNow.has(pos.id)) {
      if (pos.isUngraduated) {
        // ── PumpSwap: apply graduation grace window ──────────────────────────
        const _now     = Date.now();
        const _prevLiq = posLastLiq.get(pos.id) ?? currentLiq;
        if (!graduationGrace.has(pos.id) && _prevLiq >= 2500) {
          // Sudden drop from healthy liq — may be a graduation migration, not a rug
          const _expiresAt = _now + 4 * 60 * 1000;
          graduationGrace.set(pos.id, _expiresAt);
          console.log(`[GRAD] ${pos.symbol}: liq collapsed $${_prevLiq.toFixed(0)}→$${currentLiq < 1 ? '<1' : currentLiq.toFixed(0)} — 4-min grace started`);
          const _suspGainPct = ((price - pos.entryPrice) / pos.entryPrice * 100).toFixed(1);
          const _suspSign    = parseFloat(_suspGainPct) >= 0 ? '+' : '';
          await sendTelegram(
            `⏳ *GRADUATION SUSPECTED — ${pos.symbol}*\n\n` +
            `💧 Liq collapsed to $${currentLiq < 1 ? '<1' : currentLiq.toFixed(0)} — PumpSwap→Raydium migration possible\n` +
            `📊 Position now: *${_suspSign}${_suspGainPct}%*\n` +
            `⏱️ Holding 4-min grace window\n` +
            `🔗 [Chart](${pos.dexUrl})`
          ).catch(() => {});
          // Fall through — normal SL/TP processing continues during grace
        } else if (graduationGrace.has(pos.id) && _now < graduationGrace.get(pos.id)) {
          // Grace active, not expired — keep watching; fall through to normal processing
        } else {
          // Grace expired and liq still < $2,500 — real rug confirmed, exit now
          graduationGrace.delete(pos.id);
          closingNow.add(pos.id);
          try {
            const exitFillPrice = pos.tradingMode === 'paper'
              ? simulateFillPrice(price, pos.size * pos.remaining, currentLiq, false)
              : price;
            const exitPnL = (exitFillPrice - pos.entryPrice) / pos.entryPrice * pos.size * pos.remaining;
            const pnl     = (pos.pnl || 0) + exitPnL;
            const _result = await realClose(pos, exitFillPrice, 'LIQ_DRAINED', pnl);
            if (!_result?.ok) continue;
            await updateDailyStats(exitPnL, exitPnL > 0, !!pos.isManual, calcExitFeeUsd(pos, price, exitFillPrice, pos.remaining, _result.exitImpactPct), pos.strategyId ?? null);
            await sendTelegram(
              `⚠️ *LIQ DRAINED — EMERGENCY EXIT*\n\n` +
              `*${pos.symbol}* ${pos.strategyLabel}\n` +
              `💧 Liquidity collapsed to $${currentLiq < 1 ? '<1' : currentLiq.toFixed(0)} — rug pull confirmed\n` +
              `⏱️ 4-min grace window expired — not a graduation\n` +
              `📥 Entry: $${fmtPrice(pos.entryPrice)} → Exit: $${fmtPrice(exitFillPrice)}\n` +
              `${fmtTradeResult(pos.size, pnl)}\n🔗 [Chart](${pos.dexUrl})` +
              `${_result.txHash ? `\n📡 [Tx](https://solscan.io/tx/${_result.txHash})` : ''}`
            );
            enteredToday.delete(pos.address);
            console.log(`[BOT] LIQ_DRAINED(post-grace) ${pos.symbol}: liq=$${currentLiq?.toFixed(0)}`);
          } catch(e) {
            console.error(`[BOT] LIQ_DRAINED close failed for ${pos.symbol}:`, e);
            closingNow.delete(pos.id);
          }
          continue;
        }
      } else {
        // ── Raydium / Meteora / Orca: fully settled — exit immediately ───────
        closingNow.add(pos.id);
        try {
          const exitFillPrice = pos.tradingMode === 'paper'
            ? simulateFillPrice(price, pos.size * pos.remaining, currentLiq, false)
            : price;
          const exitPnL = (exitFillPrice - pos.entryPrice) / pos.entryPrice * pos.size * pos.remaining;
          const pnl     = (pos.pnl || 0) + exitPnL;
          const _result = await realClose(pos, exitFillPrice, 'LIQ_DRAINED', pnl);
          if (!_result?.ok) continue;
          await updateDailyStats(exitPnL, exitPnL > 0, !!pos.isManual, calcExitFeeUsd(pos, price, exitFillPrice, pos.remaining, _result.exitImpactPct), pos.strategyId ?? null);
          await sendTelegram(
            `⚠️ *LIQ DRAINED — EMERGENCY EXIT*\n\n` +
            `*${pos.symbol}* ${pos.strategyLabel}\n` +
            `💧 Liquidity collapsed to $${currentLiq < 1 ? '<1' : currentLiq.toFixed(0)} — rug pull risk\n` +
            `📥 Entry: $${fmtPrice(pos.entryPrice)} → Exit: $${fmtPrice(exitFillPrice)}\n` +
            `${fmtTradeResult(pos.size, pnl)}\n🔗 [Chart](${pos.dexUrl})` +
            `${_result.txHash ? `\n📡 [Tx](https://solscan.io/tx/${_result.txHash})` : ''}`
          );
          enteredToday.delete(pos.address);
          console.log(`[BOT] LIQ_DRAINED ${pos.symbol}: liq=$${currentLiq?.toFixed(0)}`);
        } catch(e) {
          console.error(`[BOT] LIQ_DRAINED close failed for ${pos.symbol}:`, e);
          closingNow.delete(pos.id);
        }
        continue;
      }
    }
    // Nov-24: Graduation confirmed when liq recovers during grace window.
    // Exit at the new Raydium price with GRADUATED label (Option 1 — don't follow to Raydium).
    if (graduationGrace.has(pos.id) && currentLiq !== null && currentLiq >= 2500) {
      graduationGrace.delete(pos.id);
      console.log(`[GRAD] ${pos.symbol}: liq recovered to $${currentLiq.toFixed(0)} — graduation confirmed, closing`);
      if (!closingNow.has(pos.id)) {
        closingNow.add(pos.id);
        try {
          const gradFill = pos.tradingMode === 'paper'
            ? simulateFillPrice(price, pos.size * pos.remaining, currentLiq, false)
            : price;
          const gradPnl  = (gradFill - pos.entryPrice) / pos.entryPrice * pos.size * pos.remaining;
          const pnl      = (pos.pnl || 0) + gradPnl;
          const _result  = await realClose(pos, gradFill, 'GRADUATED', pnl);
          if (_result?.ok) {
            await updateDailyStats(gradPnl, gradPnl > 0, false, calcExitFeeUsd(pos, price, gradFill, pos.remaining, _result.exitImpactPct), pos.strategyId ?? null);
            const gradGainPct = ((gradFill - pos.entryPrice) / pos.entryPrice * 100).toFixed(1);
            const gradSign    = parseFloat(gradGainPct) >= 0 ? '+' : '';
            await sendTelegram(
              `🎓 *GRADUATED — POSITION CLOSED*\n\n` +
              `*${pos.symbol}* ${pos.strategyLabel}\n` +
              `✅ Bonding curve complete — migrated to Raydium\n` +
              `📥 Entry: $${fmtPrice(pos.entryPrice)} → Exit: $${fmtPrice(gradFill)}\n` +
              `💰 P&L: *${gradSign}${gradGainPct}%*\n` +
              `${fmtTradeResult(pos.size, pnl)}\n🔗 [Chart](${pos.dexUrl})` +
              `${_result.txHash ? `\n📡 [Tx](https://solscan.io/tx/${_result.txHash})` : ''}`
            );
            enteredToday.delete(pos.address);
          }
        } catch(e) {
          console.error(`[GRAD] Exit failed for ${pos.symbol}:`, e);
          closingNow.delete(pos.id);
        }
        continue;
      }
    }
    if (currentLiq !== null) posLastLiq.set(pos.id, currentLiq);

    // ── SC RUG DETECTION ──────────────────────────────────────────────────────
    // Surge Catch only: young coins can rug in seconds — monitor a 15s price window.
    // 30%+ drop in 15s = rug signal.
    //   1st signal → capital protection + tighten SL
    //   2nd+ signal → exit ALL positions on this coin immediately
    if (pos.strategyId === 2 && !pos.isMoonBag && !closingNow.has(pos.id)) {
      const addr = pos.address;
      const now  = Date.now();

      // Maintain 15s rolling window in memory
      let win = scPriceWindow.get(addr) || [];
      win.push({ price, ts: now });
      win = win.filter(e => now - e.ts <= SC_RUG_WINDOW_MS + 3000); // keep 18s max
      scPriceWindow.set(addr, win);

      // Need at least 4 entries (~12s) before firing to avoid early-tick false positives
      if (win.length >= 4) {
        // Compare to the oldest entry in the window (closest to 15s ago)
        const refEntry = win[0];
        const drop = refEntry.price > 0 ? (refEntry.price - price) / refEntry.price : 0;

        if (drop >= SC_RUG_DROP_PCT) {
          const prevCount  = scRugSignals.get(addr) || 0;
          const sigCount   = prevCount + 1;
          scRugSignals.set(addr, sigCount);
          console.log(`[RUG] ${pos.symbol} signal #${sigCount}: ${(drop*100).toFixed(0)}% drop in ${Math.round((now - refEntry.ts)/1000)}s`);

          if (sigCount >= SC_RUG_EXIT_CNT) {
            // ── EMERGENCY EXIT — all positions on this coin ──────────────────
            const allOnCoin = remaining_positions.filter(p =>
              p.address === addr && !closingNow.has(p.id) && !rugExitedThisTick.has(p.address)
            );
            rugExitedThisTick.add(addr);
            scPriceWindow.delete(addr);
            scRugSignals.delete(addr);

            for (const rugPos of allOnCoin) {
              if (closingNow.has(rugPos.id)) continue;
              closingNow.add(rugPos.id);
              try {
                const rugFill  = rugPos.tradingMode === 'paper'
                  ? simulateFillPrice(price, rugPos.size * rugPos.remaining, rugPos.liquidityAtEntry || 0, false)
                  : price;
                const rugGain  = (rugFill - rugPos.entryPrice) / rugPos.entryPrice;
                const rugPnL   = rugGain * rugPos.size * rugPos.remaining + (rugPos.pnl || 0);
                const _result = await realClose(rugPos, rugFill, 'RUG_EMERGENCY', rugPnL);
                if (!_result?.ok) continue;
                await updateDailyStats(rugPnL, false, rugPos.isManual || false,
                  calcExitFeeUsd(rugPos, price, rugFill, rugPos.remaining, _result.exitImpactPct), rugPos.strategyId ?? null);
                await sendTelegram(
                  `🚨 *RUG EMERGENCY EXIT*\n\n` +
                  `*${rugPos.symbol}* ${rugPos.strategyLabel}\n` +
                  `📉 *${(drop*100).toFixed(0)}% crash in ${Math.round((now - refEntry.ts)/1000)}s* (signal #${sigCount})\n` +
                  `📥 Entry: $${fmtPrice(rugPos.entryPrice)} → Exit: $${fmtPrice(rugFill)}\n` +
                  `${fmtTradeResult(rugPos.size, rugPnL)}\n🔗 [Chart](${rugPos.dexUrl})` +
                  `${_result.txHash ? `\n📡 [Tx](https://solscan.io/tx/${_result.txHash})` : ''}`
                );
              } finally {
                closingNow.delete(rugPos.id);
              }
            }
            continue; // skip normal processing for this pos (already closed)

          } else {
            // ── SIGNAL #1: capital protection + tighten SL ──────────────────
            const capUpdates = {};
            if (!pos.capitalWithdrawn && pos.remaining > 0.01) {
              const totalRecovered = pos.recoveredAmount || 0;
              const stillNeeded    = pos.size - totalRecovered;
              if (stillNeeded > 0.01) {
                const rugFill    = pos.tradingMode === 'paper'
                  ? simulateFillPrice(price, pos.size * pos.remaining, pos.liquidityAtEntry || 0, false)
                  : price;
                const rugFillGain = (rugFill - pos.entryPrice) / pos.entryPrice;
                const curValue   = pos.remaining * pos.size * (price / pos.entryPrice);
                const capFrac    = Math.min(pos.remaining, stillNeeded / curValue);
                const proceeds   = capFrac * pos.size * (rugFill / pos.entryPrice);
                const partPnL    = rugFillGain * pos.size * capFrac;
                capUpdates.capitalWithdrawn     = true;
                capUpdates.capitalWithdrawPrice = price;
                capUpdates.capitalWithdrawnAt   = price;
                capUpdates.remaining            = pos.remaining - capFrac;
                capUpdates.recoveredAmount      = totalRecovered + proceeds;
                capUpdates.pnl                  = (pos.pnl || 0) + partPnL;
                capUpdates.tpDisabled           = true;
                await updateDailyStats(partPnL, true, isManual,
                  calcExitFeeUsd(pos, price, rugFill, capFrac), pos.strategyId ?? null);
              } else {
                capUpdates.capitalWithdrawn     = true;
                capUpdates.capitalWithdrawPrice = price;
                capUpdates.capitalWithdrawnAt   = price;
                capUpdates.tpDisabled           = true;
              }
            }
            // Tighten SL to current price × 0.90 (10% buffer) — above existing SL
            const tightenedSL = price * 0.90;
            if (tightenedSL > (pos.currentSL || 0)) {
              capUpdates.currentSL      = tightenedSL;
              capUpdates.trailingActive = true;
            }
            if (Object.keys(capUpdates).length > 0) {
              await updatePosition(pos.id, capUpdates);
              Object.assign(pos, capUpdates);
            }
            await sendTelegram(
              `⚠️ *RUG SIGNAL #1 — ${pos.symbol}*\n\n` +
              `📉 *${(drop*100).toFixed(0)}% drop in ${Math.round((now - refEntry.ts)/1000)}s*\n` +
              `🛡️ Capital protection applied\n` +
              `🛑 SL tightened to $${fmtPrice(price * 0.90)} (10% buffer)\n` +
              `⚠️ *One more signal = emergency exit*\n🔗 [Chart](${pos.dexUrl})`
            );
          }
        }
      }
    }
    // ── END SC RUG DETECTION ──────────────────────────────────────────────────

    // Store currentPrice in Firestore so dashboard doesn't depend on browser-side DexScreener fetch.
    // Only write when price moved ≥ 0.5% to limit Firestore writes.
    // Nov-19: skip in diagnostic mode — no dashboard watching, and 100 slots × every scan burns quota fast.
    const lastStored = pos.currentPrice || 0;
    if (!diagnosticMode && (!lastStored || Math.abs(price - lastStored) / lastStored > 0.005)) {
      pos.currentPrice = price; // patch cache immediately
      await updatePosition(pos.id, { currentPrice: price, priceUpdatedAt: Date.now() });
    }

    const gain    = (price - pos.entryPrice) / pos.entryPrice; // e.g. 0.50 = +50%
    const gainPct = gain * 100;
    let updates   = {};
    let alertMsg  = null;

    // Paper mode: compute realistic exit fill price (exit slippage + fee).
    // This is used for P&L recording only — SL/TP/peak comparisons still use raw price.
    const exitFillPrice = pos.tradingMode === 'paper'
      ? simulateFillPrice(price, pos.size * pos.remaining, pos.liquidityAtEntry || 0, false)
      : price;
    // Gain computed from simulated fill (what we'd actually receive)
    const fillGain = (exitFillPrice - pos.entryPrice) / pos.entryPrice;

    // ── PEAK PRICE TRACKER ─────────────────────────────────────────────────
    // Track highest price seen — used for rug detection & trailing SL base
    const peak = pos.peakPrice || pos.entryPrice;
    if (price > peak * 1.05) {          // only write to Firestore every 5% rise
      updates.peakPrice = price;
      pos.peakPrice = price;            // patch cache immediately
    }
    const currentPeak = pos.peakPrice || peak;

    // Surge exit + reinvest removed — positions now ride via capital floor + progressive trail.
    // At 100% gain the capital floor withdraws the original capital; profit continues trailing.
    // (Any legacy Firestore positions with surgeMomentum:true simply continue with normal TP/SL.)

    // ── SURGE_CATCH STALE EXIT — rotate slots for fresh surges ────────────
    // If a SURGE_CATCH position (strategyId 2) hasn't auto-switched to surge
    // mode (surgeMomentum) and the initial move has faded, free the slot.
    //   • Gain < 30% (surge fizzled) + profitable + age ≥ 10 min → exit, take profit
    //   • At a loss + age ≥ 15 min → exit, accept the small loss
    // If gain ≥ 30% the surge is still alive — leave it to ride (auto-switch
    // will kick in at 40% or normal TPs will handle it).
    if (pos.strategyId === 2 && !pos.isMoonBag && !pos.surgeMomentum) {
      const ageMs               = Date.now() - pos.enteredAt;
      const STALE_PROFIT_MS     = 10 * 60 * 1000; // 10 min — exit if profitable & faded
      const STALE_LOSS_MS       = 15 * 60 * 1000; // 15 min — exit even at a loss
      const SURGE_ACTIVE_THRESH = 0.30;            // ≥30% gain → surge still live, hold

      const surgeStillLive = gain >= SURGE_ACTIVE_THRESH;

      if (!surgeStillLive) {
        if (ageMs >= STALE_PROFIT_MS && gain > 0) {
          // Profitable but surge faded — take profit, free the slot
          if (closingNow.has(pos.id)) continue;
          closingNow.add(pos.id);
          try {
            const exitPnl = fillGain * pos.size * pos.remaining;
            const pnl     = (pos.pnl || 0) + exitPnl;
            const _result = await realClose(pos, exitFillPrice, 'SURGE_STALE_PROFIT', pnl);
            if (!_result?.ok) continue;
            await updateDailyStats(exitPnl, true, isManual, calcExitFeeUsd(pos, price, exitFillPrice, pos.remaining, _result.exitImpactPct), pos.strategyId ?? null);
            enteredToday.delete(pos.address);
            await sendTelegram(
              `⏱ *SURGE FADED — QUICK EXIT*\n\n` +
              `*${pos.symbol}* ${pos.strategyLabel}\n` +
              `📊 Held ${Math.round(ageMs/60000)}min — surge didn't continue\n` +
              `📥 Entry: $${fmtPrice(pos.entryPrice)} → Exit: $${fmtPrice(exitFillPrice)}\n` +
              `💰 P&L: *+$${pnl.toFixed(2)}* (+${gainPct.toFixed(1)}%) | Slot freed\n🔗 [Chart](${pos.dexUrl})` +
              `${_result.txHash ? `\n📡 [Tx](https://solscan.io/tx/${_result.txHash})` : ''}`
            );
          } finally {
            closingNow.delete(pos.id);
          }
          continue;
        }

        if (ageMs >= STALE_LOSS_MS && gain < 0) {
          // At a loss and going nowhere — cut it, free the slot
          if (closingNow.has(pos.id)) continue;
          closingNow.add(pos.id);
          try {
            const exitPnl = fillGain * pos.size * pos.remaining;
            const pnl     = (pos.pnl || 0) + exitPnl;
            const _result = await realClose(pos, exitFillPrice, 'SURGE_STALE_LOSS', pnl);
            if (!_result?.ok) continue;
            await updateDailyStats(exitPnl, false, isManual, calcExitFeeUsd(pos, price, exitFillPrice, pos.remaining, _result.exitImpactPct), pos.strategyId ?? null);
            // Loss exit — keep in enteredToday (blocked for the rest of the day)
            await sendTelegram(
              `⏱ *SURGE STALE — EXIT WITH LOSS*\n\n` +
              `*${pos.symbol}* ${pos.strategyLabel}\n` +
              `📉 ${gainPct.toFixed(1)}% after ${Math.round(ageMs/60000)}min — no recovery\n` +
              `📥 Entry: $${fmtPrice(pos.entryPrice)} → Exit: $${fmtPrice(exitFillPrice)}\n` +
              `💸 P&L: *$${pnl.toFixed(2)}* | Slot freed for new surges\n🔗 [Chart](${pos.dexUrl})` +
              `${_result.txHash ? `\n📡 [Tx](https://solscan.io/tx/${_result.txHash})` : ''}`
            );
          } finally {
            closingNow.delete(pos.id);
          }
          continue;
        }
      }
    }

    // ── RANGE-TRADE EXIT (Bottom Bounce id 0, Active Momentum id 1, Old Recovery id 3) ──
    // PROFIT-FIRST cycling: when movement is slow (<5% in 30 min), identify the S/R
    // range and extract consistent small profits instead of sitting flat.
    //   • At resistance + declining → exit now, watch for support re-entry
    //   • At resistance + still rising → hold, tighten SL (never sell into strength)
    if ([0, 1, 3].includes(pos.strategyId) && !pos.tpDisabled && gain > RANGE_MIN_EXIT_GAIN) {
      const ageMs = Date.now() - pos.enteredAt;
      if (ageMs >= RANGE_SLOW_MIN_AGE) {
        const hist = priceHistory.get(pos.address) || [];
        // Find the price snapshot from ~30 min ago to measure progress
        const cutoff30 = Date.now() - RANGE_SLOW_MIN_AGE;
        const snap30   = hist.slice().reverse().find(h => h.ts <= cutoff30);
        const priceAt30 = snap30 ? snap30.price : pos.entryPrice;
        const gainSince30 = (price - priceAt30) / priceAt30;
        const isSlowMovement = Math.abs(gainSince30) < RANGE_SLOW_GAIN_MAX;

        if (isSlowMovement && hist.length >= 4) {
          // Build S/R range from recent price history
          const recentSnaps = hist.slice(-12);
          const recentHigh  = Math.max(...recentSnaps.map(h => h.price));
          const recentLow   = Math.min(...recentSnaps.map(h => h.price));

          // Keep a running range on the position (grows as we see more data)
          const rangeHigh = Math.max(pos.rangeHigh || recentHigh, recentHigh);
          const rangeLow  = Math.min(pos.rangeLow  || recentLow,  recentLow);
          if (rangeHigh !== pos.rangeHigh) { updates.rangeHigh = rangeHigh; pos.rangeHigh = rangeHigh; }
          if (rangeLow  !== pos.rangeLow)  { updates.rangeLow  = rangeLow;  pos.rangeLow  = rangeLow; }

          const atResistance = price >= rangeHigh * RANGE_RESISTANCE_PCT;
          if (atResistance) {
            const declining = isDeclining(pos.address, 3);
            const rising    = isTrendingUp(pos.address, 3);

            if (declining && !rising) {
              // Fading at resistance — take profit, free slot, watch for support bounce
              if (closingNow.has(pos.id)) continue;
              closingNow.add(pos.id);
              try {
                const exitPnl = fillGain * pos.size * pos.remaining;
                const pnl     = (pos.pnl || 0) + exitPnl;
                const _result = await realClose(pos, exitFillPrice, 'RANGE_EXIT', pnl);
                if (!_result?.ok) continue;
                await updateDailyStats(exitPnl, true, isManual, calcExitFeeUsd(pos, price, exitFillPrice, pos.remaining, _result.exitImpactPct), pos.strategyId ?? null);
                enteredToday.delete(pos.address);
                rangeReentryWatchlist.set(pos.address, {
                  symbol: pos.symbol, strategyId: pos.strategyId, strategyLabel: pos.strategyLabel,
                  supportLevel: rangeLow, exitPrice: exitFillPrice, exitTime: Date.now(), dexUrl: pos.dexUrl,
                });
                await sendTelegram(
                  `🔄 *RANGE EXIT — PROFIT LOCKED*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
                  `📊 At resistance $${fmtPrice(rangeHigh)}, momentum declining\n` +
                  `📥 Entry: $${fmtPrice(pos.entryPrice)} → Exit: $${fmtPrice(exitFillPrice)}\n` +
                  `💰 P&L: *+$${pnl.toFixed(2)}* (+${gainPct.toFixed(1)}%)\n` +
                  `👀 Watching for re-entry near $${fmtPrice(rangeLow)}\n🔗 [Chart](${pos.dexUrl})` +
                  `${_result.txHash ? `\n📡 [Tx](https://solscan.io/tx/${_result.txHash})` : ''}`
                );
              } finally {
                closingNow.delete(pos.id);
              }
              continue;

            } else if (rising) {
              // Uptrend still intact at resistance — hold, tighten SL to protect gain
              const tightSL = Math.max(pos.currentSL, price * 0.97);
              if (tightSL > (updates.currentSL ?? pos.currentSL) * 1.005) {
                updates.currentSL    = tightSL;
                updates.trailingActive = true;
                if (!pos.rangeHoldAlert) {
                  updates.rangeHoldAlert = true;
                  alertMsg = `📈 *RANGE HOLD — TREND STRONG*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
                    `At resistance $${fmtPrice(rangeHigh)} but uptrend confirmed — holding full position\n` +
                    `🔒 SL tightened to $${fmtPrice(tightSL)}\n🔗 [Chart](${pos.dexUrl})`;
                }
              }
            }
          }
        }
      }
    }

    // ── RUG DETECTION — EMERGENCY EXIT ────────────────────────────────────
    // If price crashes >40% from peak in a single 5s tick AND we were profitable,
    // exit immediately before it goes to near-zero.
    // Nov-24: Skip during graduation grace — pump.fun price collapses on PumpSwap→Raydium
    // migration (looks like a rug but isn't). Grace window handles the outcome: liq recovery
    // → GRADUATED exit, grace expiry → LIQ_DRAINED exit.
    if (!graduationGrace.has(pos.id) && currentPeak > pos.entryPrice * 1.15 && price < currentPeak * 0.60) {
      // Guard against concurrent monitor ticks closing the same position twice
      if (closingNow.has(pos.id)) continue;
      closingNow.add(pos.id);
      try {
        const exitPnl = fillGain * pos.size * pos.remaining;
        const pnl     = (pos.pnl || 0) + exitPnl;  // total including any earlier partial exits
        const _result = await realClose(pos, exitFillPrice, 'RUG_DETECTED', pnl);
        if (!_result?.ok) continue;
        await updateDailyStats(exitPnl, exitPnl > 0, isManual, calcExitFeeUsd(pos, price, exitFillPrice, pos.remaining, _result.exitImpactPct), pos.strategyId ?? null);
        recentSLCoins.set(pos.address, Date.now()); // block re-entry for 6h
        const dropPct = ((price / currentPeak - 1) * 100).toFixed(0);
        await sendTelegram(
          `⚠️ *RUG DETECTED — EMERGENCY EXIT*\n\n` +
          `*${pos.symbol}* ${pos.strategyLabel}\n` +
          `📉 Dropped *${dropPct}%* from peak in one tick\n` +
          `📥 Entry: $${fmtPrice(pos.entryPrice)} → Exit: $${fmtPrice(exitFillPrice)}\n` +
          `${fmtTradeResult(pos.size, pnl)}\n🔗 [Chart](${pos.dexUrl})` +
          `${_result.txHash ? `\n📡 [Tx](https://solscan.io/tx/${_result.txHash})` : ''}`
        );
        console.log(`[BOT] RUG_DETECTED ${pos.symbol}: peak $${fmtPrice(currentPeak)} → now $${fmtPrice(price)} (${dropPct}%)`);
      } finally {
        closingNow.delete(pos.id);
      }
      continue;
    }

    // ── STOP LOSS ──────────────────────────────────────────────────────────
    if (price <= pos.currentSL) {
      // Guard against concurrent monitor ticks closing the same position twice
      if (closingNow.has(pos.id)) continue;
      closingNow.add(pos.id);
      try {
        const exitPnl = fillGain * pos.size * pos.remaining;
        const pnl     = (pos.pnl || 0) + exitPnl;  // total including any earlier partial TP exits
        const _result = await realClose(pos, exitFillPrice, 'STOP_LOSS', pnl);
        if (!_result?.ok) { closingNow.delete(pos.id); continue; }
        await updateDailyStats(exitPnl, false, isManual, calcExitFeeUsd(pos, price, exitFillPrice, pos.remaining, _result.exitImpactPct), pos.strategyId ?? null);
        // Slippage check — lifted here so it's available for both loss and profit paths
        const slippagePct = pos.currentSL > 0
          ? (pos.currentSL - exitFillPrice) / pos.currentSL
          : 0;
        const highSlippage = slippagePct > 0.10;
        if (pnl <= 0) {
          // Loss SL — allow same-day re-entry for ALL strategies as soon as indicators
          // qualify again (a stop loss doesn't permanently invalidate the coin).
          // Exception: if fill slipped >10% below the SL price (rug-like behaviour —
          // price blew through the stop), block 6h regardless of strategy.
          if (!highSlippage) {
            // Normal loss — free the coin; re-entry fires when scan indicators reset
            enteredToday.delete(pos.address);
          } else {
            // High-slippage exit (rug-like) — block 6h to avoid chasing a falling knife
            recentSLCoins.set(pos.address, Date.now());
          }
        } else {
          // Profitable trailing SL (capital secured, positive P&L) — allow same-day re-entry
          enteredToday.delete(pos.address);
        }
        // ── MOMENTUM RE-ENTRY WATCH ───────────────────────────────────────────
        // For AM(1), SC(2), PS(4): if loss ≤ 10% and not rug-slippage,
        // watch for higher-low reversal within 30 min and auto-re-enter.
        const pnlPct = pos.size > 0 ? pnl / pos.size : 0;
        if (MOMENTUM_REENTRY_STRATEGIES.has(pos.strategyId)
            && pnlPct >= MOMENTUM_REENTRY_MAX_LOSS
            && !highSlippage) {
          // Record structural low/high from recent price history at time of exit
          const hist         = priceHistory.get(pos.address) || [];
          const recentPrices = hist.slice(-20).map(h => h.price).filter(p => p > 0);
          const snapshotLow  = recentPrices.length > 0
            ? Math.min(...recentPrices)
            : pos.entryPrice;
          const snapshotHigh = recentPrices.length > 0
            ? Math.max(...recentPrices)
            : pos.entryPrice;
          // BB(0) and OR(3) are patient strategies — no time limit on the watch.
          // AM(1), SC(2), PS(4) are momentum plays — expire after 30 min.
          const isPatient = pos.strategyId === 0 || pos.strategyId === 3;
          momentumReentryWatch.set(pos.address, {
            symbol: pos.symbol, strategyId: pos.strategyId, strategyLabel: pos.strategyLabel,
            dexUrl: pos.dexUrl, chain: pos.chain, liq: pos.liq || 0, mcap: pos.mcap || 0,
            score: pos.botScore || 60, ageMinutes: pos.ageMinutes || 60,
            snapshotLow,
            snapshotHigh,                // peak price before SL (used for lower-high gate on re-entry)
            postExitLow: exitFillPrice,  // tracks lowest price seen after exit
            postExitHigh: exitFillPrice, // tracks highest price seen after exit (bounce peak)
            exitPrice: exitFillPrice,
            exitTime: Date.now(),
            expiry: isPatient ? Infinity : Date.now() + MOMENTUM_REENTRY_WINDOW_MS,
            isPatient,
            pnlPct,
          });
          console.log(`[MREENTRY] ${pos.symbol} — watching for higher-low re-entry | snapshotLow:$${fmtPrice(snapshotLow)} exitPrice:$${fmtPrice(exitFillPrice)} pnl:${(pnlPct*100).toFixed(1)}%`);
        }
        await sendTelegram(
          `🛑 *STOP LOSS HIT*\n\n` +
          `*${pos.symbol}* ${pos.strategyLabel}\n` +
          `📥 Entry: $${fmtPrice(pos.entryPrice)} → Exit: $${fmtPrice(exitFillPrice)}\n` +
          `🛑 SL: $${fmtPrice(pos.currentSL)} | Trail: ${pos.trailPct != null ? pos.trailPct : '—'}%\n` +
          `${fmtTradeResult(pos.size, pnl)}\n🔗 [Chart](${pos.dexUrl})` +
          `${_result.txHash ? `\n📡 [Tx](https://solscan.io/tx/${_result.txHash})` : ''}`
        );
      } finally {
        closingNow.delete(pos.id);
      }
      continue;
    }

    // ══════════════════════════════════════════════════════════════════════
    // ── PROGRESSIVE FLOOR SYSTEM — Milestone Floor Lock (Nov-25) ─────────
    // notionalGain: dollar gain on FULL original position (as if we still held
    // everything). Used as the universal milestone reference even after partial
    // sells — milestones advance as coin climbs and lock floors behind it.
    //
    // Floor fires when notionalGain drops below the locked floor level:
    //   Pre-TP1  → full exit (pos.remaining ≈ 1.0)
    //   Post-TP1 → partial exit (pos.remaining ≈ 0.33)
    // ══════════════════════════════════════════════════════════════════════
    {
      const tcfg         = getTierConfig(pos.tier || 1);
      const notionalGain = gain * pos.size;  // $ gain on full position from entry
      let floorIdx       = (pos.floorMilestoneIdx != null) ? pos.floorMilestoneIdx : -1;
      let activeFloor    = (pos.activeFloor   != null) ? pos.activeFloor   : null;
      let milestoneChanged = false;

      // Advance milestones in ascending order as coin climbs
      for (let i = floorIdx + 1; i < tcfg.milestones.length; i++) {
        const ms        = tcfg.milestones[i];
        const msGainDlr = ms.gainPct * pos.size;  // milestone threshold in dollars
        if (notionalGain >= msGainDlr) {
          const newFloor = msGainDlr * (1 - ms.trailPct);  // floor below this milestone
          if (newFloor > (activeFloor || 0)) {
            activeFloor   = newFloor;
            floorIdx      = i;
            milestoneChanged = true;
          }
        } else {
          break;  // milestones are ordered; stop at first unmet
        }
      }

      // Persist new milestone state
      if (milestoneChanged) {
        updates.activeFloor       = activeFloor;
        updates.floorMilestoneIdx = floorIdx;
        pos.activeFloor           = activeFloor;
        pos.floorMilestoneIdx     = floorIdx;
        const ms = tcfg.milestones[floorIdx];
        sendTelegram(
          `🔒 *FLOOR LOCKED — ${pos.symbol}*\n` +
          `Milestone: +${(ms.gainPct * 100).toFixed(0)}% | Floor: *$${activeFloor.toFixed(2)}* gain protected\n` +
          `📊 Tier ${pos.tier || 1} | ${pos.strategyLabel}\n🔗 [Chart](${pos.dexUrl})`
        ).catch(() => {});
        console.log(`[FLOOR] ${pos.symbol} milestone ${floorIdx+1} locked — floor $${activeFloor.toFixed(2)} (notionalGain $${notionalGain.toFixed(2)})`);
      }

      // Floor exit: notionalGain dropped below locked floor → sell remaining
      if (activeFloor !== null && notionalGain < activeFloor && !closingNow.has(pos.id)) {
        closingNow.add(pos.id);
        try {
          const exitPnl = fillGain * pos.size * pos.remaining;
          const pnl     = (pos.pnl || 0) + exitPnl;
          const preTP1  = !pos.capitalWithdrawn;
          const reason  = preTP1 ? 'FLOOR_PRE_TP1' : 'FLOOR_POST_TP1';
          const _result = await realClose(pos, exitFillPrice, reason, pnl);
          if (!_result?.ok) { closingNow.delete(pos.id); continue; }
          await updateDailyStats(exitPnl, exitPnl > 0, isManual, calcExitFeeUsd(pos, price, exitFillPrice, pos.remaining, _result.exitImpactPct), pos.strategyId ?? null);
          enteredToday.delete(pos.address);
          await sendTelegram(
            `🔒 *FLOOR EXIT — ${pos.symbol}*\n\n` +
            `*${pos.strategyLabel}*\n` +
            `📉 Gain dropped below floor *$${activeFloor.toFixed(2)}*\n` +
            `📥 Entry: $${fmtPrice(pos.entryPrice)} → Exit: $${fmtPrice(exitFillPrice)}\n` +
            `${preTP1 ? '⚡ Pre-TP1 reversal — full exit' : '🏁 Post-TP1 — remaining sold'}\n` +
            `${fmtTradeResult(pos.size, pnl)}\n🔗 [Chart](${pos.dexUrl})` +
            `${_result.txHash ? `\n📡 [Tx](https://solscan.io/tx/${_result.txHash})` : ''}`
          );
          console.log(`[FLOOR_EXIT] ${pos.symbol} — notional $${notionalGain.toFixed(2)} < floor $${activeFloor.toFixed(2)} | ${reason} | pnl $${pnl.toFixed(2)}`);
        } finally {
          closingNow.delete(pos.id);
        }
        continue;
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // ── CAPITAL WITHDRAWAL (TP1 — tier-based gain threshold) ─────────────
    // Sell the minimum fraction needed to recover original capital ($pos.size).
    // Tier 1: +50% | Tier 2: +40% | Tier 3: +30%
    // ══════════════════════════════════════════════════════════════════════
    if (!pos.capitalWithdrawn) {
      const capThreshold = (pos.tp1GainPct || 50) / 100; // tier-based TP1 gain %
      if (gain >= capThreshold && pos.remaining > 0.01) {
        const totalRecovered = pos.recoveredAmount || 0;
        const stillNeeded    = pos.size - totalRecovered; // capital still at risk
        if (stillNeeded > 0.01) {
          // Sell the minimum fraction needed to bring total recovered >= pos.size.
          // At +50%: capitalFrac = size / (remaining × size × 1.5) = 1/1.5 = 0.667
          const currentValue = pos.remaining * pos.size * (price / pos.entryPrice);
          const capitalFrac  = Math.min(pos.remaining, stillNeeded / currentValue);
          const proceeds     = capitalFrac * pos.size * (exitFillPrice / pos.entryPrice);
          const partPnL      = fillGain * pos.size * capitalFrac;
          const newRemaining = pos.remaining - capitalFrac;
          const newRecovered = totalRecovered + proceeds;
          const capUpdates   = {
            capitalWithdrawn:    true,
            capitalWithdrawPrice: price,
            capitalWithdrawnAt:  price,  // used for progressive withdrawal trigger
            remaining:           newRemaining,
            recoveredAmount:     newRecovered,
            pnl:                 (pos.pnl || 0) + partPnL,
            tpDisabled:          true, // TP sells done — profit trail takes over
          };
          const _cSell = await realPartialSell(pos, capitalFrac, exitFillPrice);
          if (_cSell.ok) {
            await updatePosition(pos.id, capUpdates);
            await updateDailyStats(partPnL, true, isManual, calcExitFeeUsd(pos, price, exitFillPrice, capitalFrac, _cSell.exitImpactPct), pos.strategyId ?? null);
            Object.assign(pos, capUpdates);
            alertMsg = `🛡️ *CAPITAL RECOVERED — TP1*\n\n` +
              `*${pos.symbol}* ${pos.strategyLabel}\n` +
              `📥 Entry: $${fmtPrice(pos.entryPrice)} | Trigger: +${((pos.tp1GainPct||50)).toFixed(0)}% (Tier ${pos.tier||1})\n` +
              `💰 Sold ${(capitalFrac * 100).toFixed(1)}% → recovered $${newRecovered.toFixed(2)}\n` +
              `🎯 ${(newRemaining * 100).toFixed(1)}% remains — TP2 at +${pos.tp2GainPct||200}% · then floor trail\n` +
              `🔗 [Chart](${pos.dexUrl})` +
              `${_cSell.txHash ? `\n📡 [Tx](https://solscan.io/tx/${_cSell.txHash})` : ''}`;
          }
        } else {
          // Prior TP sells already recovered full capital — just flip the flag
          const capUpdates = {
            capitalWithdrawn:   true,
            capitalWithdrawPrice: price,
            capitalWithdrawnAt: price,
            tpDisabled:         true,
          };
          await updatePosition(pos.id, capUpdates);
          Object.assign(pos, capUpdates);
        }
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // ── PROGRESSIVE PROFIT WITHDRAWALS (Nov-12) ──────────────────────────
    // After capital recovery (+50%), extract profits in up to 5 × $20 chunks:
    //   • 1st withdrawal: when price doubles from capitalWithdrawnAt
    //   • 2nd–5th:        every +50% above the last withdrawal price
    // After 5 withdrawals (5×20% = 100% of original position in profit): moon bag.
    // Each sells just enough of remaining to realize 20% of original position size.
    // ══════════════════════════════════════════════════════════════════════
    if (false) { // Nov-19: replaced by SL tightening in 3-phase system (was progressive withdrawals)
      const wCount        = pos.withdrawalCount || 0;
      const originalSize  = pos.originalPositionSize || pos.size;
      const withdrawGoal  = originalSize * 0.20; // $20 per trigger on $100 position

      let shouldWithdraw = false;
      if (wCount === 0) {
        // 1st: when price doubles from capital withdrawal price
        const refP = pos.capitalWithdrawnAt || pos.capitalWithdrawPrice || (pos.entryPrice * 1.50);
        shouldWithdraw = price >= refP * 2.0;
      } else {
        // 2nd–5th: every +50% from last withdrawal price
        shouldWithdraw = !!(pos.lastWithdrawalPrice && price >= pos.lastWithdrawalPrice * 1.50);
      }

      if (shouldWithdraw) {
        const curValue   = pos.remaining * pos.size * (price / pos.entryPrice);
        const closeRatio = Math.min(pos.remaining - 0.001, withdrawGoal / curValue);
        if (closeRatio > 0.001) {
          const wFill        = pos.tradingMode === 'paper'
            ? simulateFillPrice(price, pos.size * closeRatio, pos.liquidityAtEntry || 0, false)
            : price;
          const wGain        = (wFill - pos.entryPrice) / pos.entryPrice;
          const partPnL      = wGain * pos.size * closeRatio;
          const newRemaining = +(pos.remaining - closeRatio).toFixed(6);
          const newCount     = wCount + 1;
          const toMoonBag    = newCount >= 5;
          const wUpdates     = {
            remaining:          newRemaining,
            pnl:                (pos.pnl || 0) + partPnL,
            withdrawalCount:    newCount,
            lastWithdrawalPrice: price,
            isMoonBag:          toMoonBag,
          };
          const _wSell = await realPartialSell(pos, closeRatio, wFill);
          if (_wSell.ok) {
            await updatePosition(pos.id, wUpdates);
            await updateDailyStats(partPnL, true, isManual, calcExitFeeUsd(pos, price, wFill, closeRatio, _wSell.exitImpactPct), pos.strategyId ?? null);
            Object.assign(pos, wUpdates);
            await sendTelegram(
              `💰 *PROFIT WITHDRAWAL ${newCount}/5*\n\n` +
              `*${pos.symbol}* ${pos.strategyLabel}\n` +
              `📥 Entry: $${fmtPrice(pos.entryPrice)} | Now: +${gainPct.toFixed(1)}%\n` +
              `💸 Sold ${(closeRatio*100).toFixed(1)}% → locked *$${partPnL.toFixed(2)}*\n` +
              `🎯 ${(newRemaining*100).toFixed(1)}% remains${toMoonBag ? '\n🌕 *MOON BAG MODE — 20% trailing SL from ATH*' : ` — next at $${fmtPrice(price * 1.50)}`}\n` +
              `🔗 [Chart](${pos.dexUrl})` +
              `${_wSell.txHash ? `\n📡 [Tx](https://solscan.io/tx/${_wSell.txHash})` : ''}`
            );
            console.log(`[BOT] PROFIT_WITHDRAWAL ${newCount}/5 ${pos.symbol}: +${gainPct.toFixed(1)}%, sold ${(closeRatio*100).toFixed(1)}%, locked $${partPnL.toFixed(2)}`);
          }
        }
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // ── TP2: take 50% of gain at tp2GainPct milestone → moon bag remainder
    // Tier 1: +200% gain (3×) | Tier 2: +150% (2.5×) | Tier 3: +100% (2×)
    // Sell 50% of what's left → remaining becomes moon bag at 10% trail.
    // ══════════════════════════════════════════════════════════════════════
    const tp2MultRef = 1 + (pos.tp2GainPct || 200) / 100;
    if (pos.capitalWithdrawn && !pos.tp2Hit && price >= pos.entryPrice * tp2MultRef && pos.remaining > 0.01) {
      const tp2Frac      = pos.remaining * 0.50;   // sell 50% of what's left
      const tp2FillPrice = pos.tradingMode === 'paper'
        ? simulateFillPrice(price, pos.size * tp2Frac, pos.liquidityAtEntry || 0, false)
        : exitFillPrice;
      const tp2Gain      = (tp2FillPrice - pos.entryPrice) / pos.entryPrice;
      const tp2PnL       = tp2Gain * pos.size * tp2Frac;
      const newRemaining = +(pos.remaining - tp2Frac).toFixed(6);
      const tp2Updates   = {
        tp2Hit:          true,
        remaining:       newRemaining,
        pnl:             (pos.pnl || 0) + tp2PnL,
        isMoonBag:       true,          // remaining becomes moon bag
        moonBagTrailPct: 0.10,          // 10% from ATH — tightens to 5% on exhaustion
        moonBagEnteredAt: Date.now(),
        moonBagPeakGain: gainPct,       // gainPct when moon bag started (exhaustion reference)
      };
      const _tp2Sell = await realPartialSell(pos, tp2Frac, tp2FillPrice);
      if (_tp2Sell.ok) {
        await updatePosition(pos.id, tp2Updates);
        await updateDailyStats(tp2PnL, true, isManual, calcExitFeeUsd(pos, price, tp2FillPrice, tp2Frac, _tp2Sell.exitImpactPct), pos.strategyId ?? null);
        Object.assign(pos, tp2Updates);
        alertMsg = `💰 *PROFIT SECURED — TP2*\n\n` +
          `*${pos.symbol}* ${pos.strategyLabel}\n` +
          `📥 Entry: $${fmtPrice(pos.entryPrice)} | Now: +${gainPct.toFixed(1)}% (Tier ${pos.tier||1})\n` +
          `💸 Sold ${(tp2Frac * 100).toFixed(1)}% → locked *$${tp2PnL.toFixed(2)}*\n` +
          `🌕 ${(newRemaining * 100).toFixed(1)}% moon bag — 10% trail from ATH\n` +
          `🔗 [Chart](${pos.dexUrl})` +
          `${_tp2Sell.txHash ? `\n📡 [Tx](https://solscan.io/tx/${_tp2Sell.txHash})` : ''}`;
        console.log(`[BOT] TP2 ${pos.symbol}: +${gainPct.toFixed(1)}%, locked $${tp2PnL.toFixed(2)}, ${(newRemaining*100).toFixed(1)}% moon bag`);
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // ── STRATEGY 5 — PROFIT HALVING at 4× entry (300% gain) ─────────────
    // After capital recovery, sell 50% of remaining at 4× — locks substantial
    // profit while letting the other 50% ride the -10% floor trail to max upside.
    // Fires once (s5ProfitHalved flag prevents repeat).
    // ══════════════════════════════════════════════════════════════════════
    if (false) { // Nov-19: replaced by SL tightening in 3-phase system (was S5 profit halving)
      const halveFrac    = 0.50;
      const amountSold   = halveFrac * pos.remaining;
      const halveExit    = pos.tradingMode === 'paper'
        ? simulateFillPrice(price, pos.size * amountSold, pos.liquidityAtEntry || 0, false)
        : price;
      const proceeds     = amountSold * pos.size * (halveExit / pos.entryPrice);
      const partPnL      = fillGain * pos.size * amountSold;
      const newRemaining = +(pos.remaining * (1 - halveFrac)).toFixed(6);
      const halvUpdates  = {
        s5ProfitHalved: true,
        remaining:      newRemaining,
        pnl:            (pos.pnl || 0) + partPnL,
      };
      const _hSell = await realPartialSell(pos, halveFrac, halveExit);
      if (_hSell.ok) {
        await updatePosition(pos.id, halvUpdates);
        await updateDailyStats(partPnL, true, isManual, calcExitFeeUsd(pos, price, halveExit, amountSold, _hSell.exitImpactPct), pos.strategyId ?? null);
        Object.assign(pos, halvUpdates);
        await sendTelegram(
          `📤 *PROFIT HALVED — LOCKED*\n\n` +
          `*${pos.symbol}* ${pos.strategyLabel}\n` +
          `📥 Entry: $${fmtPrice(pos.entryPrice)} | Now: 4× (+${gainPct.toFixed(0)}%)\n` +
          `💰 Sold 50% → $${proceeds.toFixed(2)} locked\n` +
          `🎯 ${(newRemaining * 100).toFixed(1)}% remains — riding −10% trail\n` +
          `🔗 [Chart](${pos.dexUrl})` +
          `${_hSell.txHash ? `\n📡 [Tx](https://solscan.io/tx/${_hSell.txHash})` : ''}`
        );
        console.log(`[BOT] S5_PROFIT_HALVED ${pos.symbol}: +${gainPct.toFixed(0)}%, locked $${proceeds.toFixed(2)}, ${(newRemaining*100).toFixed(1)}% remains`);
      }
    }

    // ── RESISTANCE EXIT — 50% partial at estimated overhead resistance ─────────
    // Computed at entry from h1/h6/h24 DexScreener data. Fires once per position.
    // Takes 50% — locks profit at the first overhead wall, lets rest ride with SL/trail.
    if (false) { // Nov-19: exits only via SL tightening (was resistance partial exit)
      // exitFrac = fraction of *remaining* to sell (0.50 = sell half of what's left)
      const exitFrac      = Math.min(RESISTANCE_EXIT_FRAC, 1 - 0.01 / pos.remaining);
      const amountSold    = exitFrac * pos.remaining;          // as fraction of original position
      const exitFillPrice = pos.tradingMode === 'paper'
        ? simulateFillPrice(price, pos.size * amountSold, pos.liquidityAtEntry || 0, false)
        : price;
      const partPnL      = (exitFillPrice - pos.entryPrice) / pos.entryPrice * pos.size * amountSold;
      const newRemaining = +(pos.remaining * (1 - exitFrac)).toFixed(6);
      const resistUpdates = {
        resistanceHit: true,
        remaining:     newRemaining,
        pnl:           (pos.pnl || 0) + partPnL,
      };
      const _reSell = await realPartialSell(pos, exitFrac, exitFillPrice);
      if (_reSell.ok) {
        await updatePosition(pos.id, resistUpdates);
        await updateDailyStats(partPnL, true, isManual, calcExitFeeUsd(pos, price, exitFillPrice, amountSold, _reSell.exitImpactPct), pos.strategyId ?? null);
        Object.assign(pos, resistUpdates);
        await sendTelegram(
          `🧱 *RESISTANCE — PARTIAL EXIT*\n\n` +
          `*${pos.symbol}* ${pos.strategyLabel}\n` +
          `📐 Resistance hit at $${fmtPrice(pos.resistancePrice)}\n` +
          `📥 Entry: $${fmtPrice(pos.entryPrice)} → Exit: $${fmtPrice(exitFillPrice)}\n` +
          `💰 P&L (${(exitFrac*100).toFixed(0)}%): *${partPnL >= 0 ? '+' : ''}$${partPnL.toFixed(2)}*\n` +
          `📊 ${(newRemaining * 100).toFixed(0)}% remains — riding with SL & trail\n` +
          `🔗 [Chart](${pos.dexUrl})` +
          `${_reSell.txHash ? `\n📡 [Tx](https://solscan.io/tx/${_reSell.txHash})` : ''}`
        );
        console.log(`[BOT] RESISTANCE_EXIT ${pos.symbol}: hit $${fmtPrice(pos.resistancePrice)}, pnL +$${partPnL.toFixed(2)}`);
      }
    }

    // ── TP EXITS REMOVED ─────────────────────────────────────────────────────
    // All TP exits replaced by universal trailing SL.
    // Capital is recovered at +100% via CAPITAL WITHDRAWAL above.
    // Everything else rides via progressive trailing SL below.
    // ─────────────────────────────────────────────────────────────────────────

    // ══════════════════════════════════════════════════════════════════════
    // ── LOWER-HIGH TIGHTENING (swing structure guard) ────────────────────
    // If the most recent swing high is LOWER than the previous swing high
    // (i.e. a "lower high" pattern — classic downtrend signal), tighten SL
    // to 5% immediately regardless of trail phase.
    // When price subsequently sets a new high above lhPrevPeak, the tight
    // SL is released and normal trailing resumes.
    // ══════════════════════════════════════════════════════════════════════
    if (!pos.isDiagnostic && !pos.backgrounded) {
      try {
        const lhCandles = buildVirtualCandles(pos.address, 4); // 1-min candles
        if (lhCandles.length >= 5) {
          const { highs: lhHighs } = detectSwingPoints(lhCandles, 2);

          // ── Release tight SL if price broke above the previous peak ──────
          if (pos.lhTightened && pos.lhPrevPeak && price > pos.lhPrevPeak) {
            const relMsg = `📈 *SWING RECOVERY — ${pos.symbol}*\n` +
              `Price $${fmtPrice(price)} exceeded prev peak $${fmtPrice(pos.lhPrevPeak)}\n` +
              `Lower-high guard released — resuming normal trail\n🔗 [Chart](${pos.dexUrl})`;
            updates.lhTightened = false;
            updates.lhPrevPeak  = null;
            pos.lhTightened     = false;
            pos.lhPrevPeak      = null;
            sendTelegram(relMsg).catch(() => {});
            console.log(`[LH-GUARD] ${pos.symbol} — recovery above prev peak $${fmtPrice(pos.lhPrevPeak)}, releasing tight SL`);
          }

          // ── Detect lower-high pattern and tighten SL ─────────────────────
          if (!pos.lhTightened && lhHighs.length >= 2) {
            const lastHigh = lhHighs[lhHighs.length - 1].price;
            const prevHigh = lhHighs[lhHighs.length - 2].price;
            if (lastHigh < prevHigh) {
              // Lower high confirmed — tighten SL to 5% below current price
              const tightSL = price * 0.95;
              if (tightSL > (updates.currentSL ?? pos.currentSL ?? 0)) {
                updates.currentSL  = tightSL;
                updates.lhTightened = true;
                updates.lhPrevPeak  = prevHigh; // release when price > this
                pos.lhTightened     = true;
                pos.lhPrevPeak      = prevHigh;
                const tightMsg = `⚠️ *LOWER-HIGH DETECTED — ${pos.symbol}*\n` +
                  `Swing high: $${fmtPrice(lastHigh)} < prev: $${fmtPrice(prevHigh)}\n` +
                  `SL tightened to 5% → $${fmtPrice(tightSL)}\n` +
                  `Will release when price > $${fmtPrice(prevHigh)}\n🔗 [Chart](${pos.dexUrl})`;
                sendTelegram(tightMsg).catch(() => {});
                console.log(`[LH-GUARD] ${pos.symbol} — lower high ($${fmtPrice(lastHigh)} < $${fmtPrice(prevHigh)}), SL tightened to $${fmtPrice(tightSL)}`);
              }
            }
          }
        }
      } catch(lhErr) {
        // Swing detection failure is non-critical — continue with normal SL
        console.log(`[LH-GUARD] ${pos.symbol} — swing check error: ${lhErr.message}`);
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // ── SL TRAIL — 6-phase tightening (Nov-20) ───────────────────────────
    // ATH gain:  0–30%  → gap 30%  SL = ATH × 0.70
    //           30–60%  → gap 25%  SL = ATH × 0.75
    //           60–90%  → gap 20%  SL = ATH × 0.80
    //          90–120%  → gap 15%  SL = ATH × 0.85
    //         120–150%  → gap 10%  SL = ATH × 0.90
    //            150%+  → gap  5%  SL = ATH × 0.95  ← floor
    // SL only ever moves UP (ratchet). No separate phase for capital recovery.
    // Diagnostic: Phase 1 (ATHGain<30%) = ATH×0.50; Phase 2 = 60% gap trail
    // Moon bag: flat 20% below ATH — SL = ATH × 0.80. Never comes down.
    // ══════════════════════════════════════════════════════════════════════
    if (gainPct > 0) {
      let newSL;
      const slFloor        = pos.slFloor || pos.preEntryPrice || pos.entryPrice * 0.97;
      const trailThreshold = 5;     // all strategies: trail activates at +5% ATH gain
      const gapStart       = 0.60;  // all strategies: gap starts at 60%

      if (pos.isDiagnostic) {
        // ── DIAGNOSTIC TRAIL ─────────────────────────────────────────────
        // Phase 1 (ATHGain < 30%): SL = ATH × (1 − entrySLPct%)  [tier-based]
        // Phase 2 (ATHGain ≥ 30%): standard 60% tightening trail
        // Floor system handles the actual exits once milestones are reached.
        const ATHd        = currentPeak;
        const ATHGainPctD = (ATHd - pos.entryPrice) / pos.entryPrice * 100;
        const entrySLFrac = (pos.entrySLPct || 50) / 100;
        if (ATHGainPctD >= 30) {
          const stepsD  = Math.max(0, Math.floor((ATHGainPctD - 5) / 10));
          const gapPctD = Math.max(0.05, gapStart - stepsD * 0.05);
          newSL = pos.entryPrice + (1 - gapPctD) * (ATHd - pos.entryPrice);
        } else {
          newSL = ATHd * (1 - entrySLFrac);  // Tier 1=50%, Tier 2=40%, Tier 3=30%
        }
        newSL = Math.max(slFloor, newSL);

      } else if (pos.isMoonBag) {
        // ── MOON BAG: 10% trailing from ATH → tighten to 5% on exhaustion ─
        // moonBagTrailPct starts at 0.10; flips to 0.05 when coin goes dormant.
        const mbTrail = pos.moonBagTrailPct || 0.10;
        newSL = currentPeak * (1 - mbTrail);

        // Exhaustion detection: in moon bag > 30 min + gain not extending above entry
        if (mbTrail > 0.05 && pos.moonBagEnteredAt) {
          const moonBagAgeMin = (Date.now() - pos.moonBagEnteredAt) / 60000;
          const mbPeakGain    = pos.moonBagPeakGain || gainPct;
          // Exhausted: > 30 min old AND current gain < 110% of gain when moon bag started
          if (moonBagAgeMin > 30 && gainPct < mbPeakGain * 1.10) {
            updates.moonBagTrailPct = 0.05;
            pos.moonBagTrailPct     = 0.05;
            newSL = currentPeak * 0.95;  // 5% from ATH
            sendTelegram(
              `🌙 *MOON BAG EXHAUSTION — ${pos.symbol}*\n` +
              `Trail tightened: 10% → *5%* | Age: ${moonBagAgeMin.toFixed(0)}min\n` +
              `SL now: $${fmtPrice(newSL)} | Gain: +${gainPct.toFixed(1)}%\n🔗 [Chart](${pos.dexUrl})`
            ).catch(() => {});
            console.log(`[MOONBAG] ${pos.symbol} exhaustion — trail 10%→5%, SL $${fmtPrice(newSL)}`);
          }
        }

      } else {
        // ── SL TRAIL — integer arithmetic (float-safe, Nov-20) ──────────
        // pos.slTrailMode = '30' (default): 30%→25%→20%→15%→10%→5% per 30% ATH gain
        // pos.slTrailMode = '50': flat 50% until +50% ATH gain, then −5% per +20% gain
        // SL = ATH × (1 − gapPct/100). Only moves UP (ratchet via Math.max).
        // Integer comparisons prevent JS float drift (0.30−0.05−0.05 ≠ 0.20 exactly).
        const ATH        = currentPeak;
        const ATHGainPct = (ATH - pos.entryPrice) / pos.entryPrice * 100;
        const posMode    = pos.slTrailMode || '30';

        // Work in integer percentages — no floating-point drift
        let gapPct;
        if (posMode === '50') {
          // Wide system: flat 50% until capital recovered (+50%), then −5% per +20% ATH gain
          gapPct = Math.max(5, 50 - Math.max(0, Math.floor((ATHGainPct - 50) / 20)) * 5);
        } else {
          // Tight system: −5% per +30% ATH gain, starting at 30%
          gapPct = Math.max(5, 30 - Math.floor(ATHGainPct / 30) * 5);
        }
        const gap = gapPct / 100;

        newSL = Math.max(pos.currentSL ?? 0, ATH * (1 - gap));

        // Persist trail state; notify on tighten — integer comparison, no float drift
        const prevGapPct = pos.trailPct != null ? Math.round(pos.trailPct) : (posMode === '50' ? 50 : 30);
        if (gapPct < prevGapPct) {
          updates.trailPct    = gapPct;
          updates.tightenBase = ATH;
          pos.trailPct        = gapPct;
          pos.tightenBase     = ATH;
          sendTelegram(`📐 *SL TIGHTENED — ${pos.symbol}*\n` +
            `Gap: ${prevGapPct}% → *${gapPct}%* | Floor: 5%\n` +
            `ATH: $${fmtPrice(ATH)} | Gain: +${ATHGainPct.toFixed(1)}%\n🔗 [Chart](${pos.dexUrl})`
          ).catch(() => {});
        }
      }

      if (newSL !== undefined) {
        const currentSL = updates.currentSL ?? pos.currentSL;
        // Only write if SL moved ≥ 0.5% — prevents thousands of tiny writes per day
        if (newSL > currentSL * 1.005) {
          updates.currentSL      = newSL;
          updates.trailingActive = true;
        }
      }
    }

    if (Object.keys(updates).length > 0) await updatePosition(pos.id, updates);
    if (alertMsg) await sendTelegram(alertMsg);

    // ── BACKGROUND SLOT MANAGEMENT ─────────────────────────────────────────────
    // Backgrounded positions: SL/TP still processed above; check for reactivation.
    // Visible positions: check if they've gone dormant and should be backgrounded.
    if (pos.backgrounded) {
      // ── Reactivation check: +50% gain within a rolling 1-hour window ─────────
      const { positions: posCol } = await getCollections();
      const bgNow = Date.now();
      let refPrice = pos.bgHourlyRefPrice || pos.entryPrice;
      let refAt    = pos.bgHourlyRefAt    || pos.backgroundedAt || bgNow;

      // Roll the reference price every hour
      if (bgNow - refAt >= BG_REACTIVATE_WIN_MS) {
        refPrice = price;
        refAt    = bgNow;
        await db.collection(posCol).doc(pos.id).update({
          bgHourlyRefPrice: refPrice,
          bgHourlyRefAt:    refAt,
        });
        if (_posCache) {
          const cp = _posCache.find(p => p.id === pos.id);
          if (cp) { cp.bgHourlyRefPrice = refPrice; cp.bgHourlyRefAt = refAt; }
        }
      }

      if (price >= refPrice * (1 + BG_REACTIVATE_GAIN)) {
        // Find the most dormant visible position to swap to background
        const allOpen   = await getOpenPositions();
        const visible   = allOpen.filter(p => !p.backgrounded && p.id !== pos.id);
        // "Most dormant" = lowest current gain. Use stored currentPrice for speed.
        const dormant = visible.sort((a, b) => {
          const gA = ((a.currentPrice || a.entryPrice) - a.entryPrice) / a.entryPrice;
          const gB = ((b.currentPrice || b.entryPrice) - b.entryPrice) / b.entryPrice;
          return gA - gB;
        })[0] || null;
        await reactivatePosition(pos, dormant);
      }
    } else {
      // ── Dormancy check: should this visible position be backgrounded? ─────────
      if (!closingNow.has(pos.id)) {
        const holdMs    = Date.now() - pos.enteredAt;
        const isAMSC    = pos.strategyId === 1 || pos.strategyId === 2;
        const isBBOR    = pos.strategyId === 0 || pos.strategyId === 3;
        const timeout   = isAMSC ? BG_AMSC_TIMEOUT_MS : BG_BBOR_TIMEOUT_MS;
        const minGain   = isAMSC ? BG_AMSC_MIN_GAIN   : BG_BBOR_MIN_GAIN;

        if (holdMs >= timeout && gain < minGain) {
          await backgroundPosition(pos, gainPct);
        }
      }
    }
    // ── END BACKGROUND SLOT MANAGEMENT ────────────────────────────────────────
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ─── TRENDING FETCHER ─────────────────────────────────────────────────────────
// Fetches top 200 trending coins from pump.fun and Birdeye every 5 min.
// Builds trendingAddrs: Map<addr_lowercase, platform_count>.
// DexScreener boosts are merged separately per scan (already fetched there).
// ─────────────────────────────────────────────────────────────────────────────
async function fetchTrendingAddrs() {
  const now = Date.now();
  if (now - trendingLastFetch < TRENDING_TTL_MS) return; // still fresh — skip
  trendingLastFetch = now; // claim the slot immediately to prevent concurrent fetches

  const fresh = new Map();

  // ── Platform 1a: pump.fun — top 200 most recently traded coins ─────────────
  try {
    const r = await httpGet(
      'frontend-api.pump.fun',
      '/coins?offset=0&limit=200&sort=last_trade_unix_time&order=DESC'
    );
    const coins = JSON.parse(r.body);
    const list  = Array.isArray(coins) ? coins : [];
    let grad1a = 0;
    for (const c of list) {
      const addr = (c.mint || '').toLowerCase();
      if (!addr) continue;
      // Graduated tokens get weight 5 — these are SC/AM's target market.
      // raydium_pool = old graduation path (Raydium AMM)
      // pump_pool    = new graduation path (PumpSwap AMM, pump.fun's own DEX)
      const isGraduated = !!(c.raydium_pool || c.pump_pool);
      const w = isGraduated ? 5 : 1;
      fresh.set(addr, (fresh.get(addr) || 0) + w);
      if (isGraduated) grad1a++;
    }
    console.log(`[TRENDING] pump.fun (recent): ${list.length} coins (${grad1a} graduated)`);
  } catch(e) { console.log(`[TRENDING] pump.fun (recent) error: ${e.message}`); }

  // ── Platform 1b: pump.fun movers — top 100 by market cap (most active SC pool)
  // These are the coins with the most momentum — Surge Catch hunts from this list.
  try {
    const r = await httpGet(
      'frontend-api.pump.fun',
      '/coins?offset=0&limit=100&sort=market_cap&order=DESC'
    );
    const coins = JSON.parse(r.body);
    const list  = Array.isArray(coins) ? coins : [];
    let grad1b = 0;
    for (const c of list) {
      const addr = (c.mint || '').toLowerCase();
      if (!addr) continue;
      const isGraduated2 = !!(c.raydium_pool || c.pump_pool);
      const w = isGraduated2 ? 5 : 1;
      fresh.set(addr, (fresh.get(addr) || 0) + w);
      if (isGraduated2) grad1b++;
    }
    console.log(`[TRENDING] pump.fun (movers/mcap): ${list.length} coins (${grad1b} graduated)`);
  } catch(e) { console.log(`[TRENDING] pump.fun (movers) error: ${e.message}`); }

  // ── Platform 2: DexScreener — latest new token profiles (infant surge feed) ──
  // /token-profiles/latest/v1 surfaces newly listed tokens — these are the coins
  // that appear in "New Trending" screener views (coins 10–90 min old with explosive
  // early momentum). Perfect pool for Surge Catch to hunt from.
  try {
    const r = await httpGet(
      'api.dexscreener.com',
      '/token-profiles/latest/v1'
    );
    const profiles = JSON.parse(r.body);
    const list = Array.isArray(profiles) ? profiles : [];
    let added = 0;
    for (const p of list) {
      // Only Solana tokens
      if ((p.chainId || '').toLowerCase() !== 'solana') continue;
      const addr = (p.tokenAddress || '').toLowerCase();
      if (addr) { fresh.set(addr, (fresh.get(addr) || 0) + 1); added++; }
    }
    console.log(`[TRENDING] DexScreener new profiles: ${added} Solana tokens`);
  } catch(e) { console.log(`[TRENDING] DexScreener new profiles error: ${e.message}`); }

  // ── Platform 3: Birdeye — top 200 trending tokens on Solana ─────────────────
  const birdeyeKey = process.env.BIRDEYE_KEY || '';
  if (birdeyeKey) {
    try {
      const r = await httpGet(
        'public-api.birdeye.so',
        '/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=200&chain=solana',
        { 'X-API-KEY': birdeyeKey }
      );
      const d      = JSON.parse(r.body);
      const tokens = d?.data?.tokens || (Array.isArray(d?.data) ? d.data : []);
      for (const t of tokens) {
        const addr = (t.address || '').toLowerCase();
        if (addr) fresh.set(addr, (fresh.get(addr) || 0) + 1);
      }
      console.log(`[TRENDING] Birdeye: ${tokens.length} trending coins`);
    } catch(e) { console.log(`[TRENDING] Birdeye error: ${e.message}`); }
  } else {
    console.log('[TRENDING] Birdeye: no API key — skipping');
  }

  trendingAddrs = fresh;
  console.log(`[TRENDING] Cache updated: ${fresh.size} unique trending addrs (pump.fun + DexScreener new + Birdeye)`);
}

// ─── BACKGROUND SLOT HELPERS ─────────────────────────────────────────────────

async function backgroundPosition(pos, gainPct) {
  const { positions } = await getCollections();
  const now = Date.now();
  await db.collection(positions).doc(pos.id).update({
    backgrounded:       true,
    backgroundedAt:     now,
    bgHourlyRefPrice:   pos.currentPrice || pos.entryPrice,
    bgHourlyRefAt:      now,
  });
  if (_posCache) {
    const p = _posCache.find(p => p.id === pos.id);
    if (p) Object.assign(p, { backgrounded: true, backgroundedAt: now });
  }
  const holdH = ((now - pos.enteredAt) / 3600000).toFixed(1);
  await sendTelegram(
    `📦 *BACKGROUNDED* — *${pos.symbol}* ${pos.strategyLabel}\n` +
    `Held ${holdH}h · Gain: ${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(1)}%\n` +
    `_SL/TP still active · /hidden to review_`
  );
  console.log(`[BG] ${pos.symbol} backgrounded after ${holdH}h (gain ${gainPct.toFixed(1)}%)`);
}

async function reactivatePosition(bgPos, mostDormantVisible) {
  const { positions } = await getCollections();
  const now = Date.now();
  // Bring background coin back to visible
  await db.collection(positions).doc(bgPos.id).update({
    backgrounded:    false,
    reactivatedAt:   now,
  });
  if (_posCache) {
    const p = _posCache.find(p => p.id === bgPos.id);
    if (p) { p.backgrounded = false; p.reactivatedAt = now; }
  }
  // Push the most dormant visible coin to background
  if (mostDormantVisible) {
    await db.collection(positions).doc(mostDormantVisible.id).update({
      backgrounded:     true,
      backgroundedAt:   now,
      bgHourlyRefPrice: mostDormantVisible.currentPrice || mostDormantVisible.entryPrice,
      bgHourlyRefAt:    now,
    });
    if (_posCache) {
      const p = _posCache.find(p => p.id === mostDormantVisible.id);
      if (p) Object.assign(p, { backgrounded: true, backgroundedAt: now });
    }
    await sendTelegram(
      `🔄 *REACTIVATED* — *${bgPos.symbol}* ${bgPos.strategyLabel}\n` +
      `+50% surge detected · Back on dashboard\n` +
      `📦 Swapped out: *${mostDormantVisible.symbol}* (most dormant)`
    );
  } else {
    await sendTelegram(
      `🔄 *REACTIVATED* — *${bgPos.symbol}* ${bgPos.strategyLabel}\n` +
      `+50% surge detected · Back on dashboard`
    );
  }
  console.log(`[BG] ${bgPos.symbol} reactivated — swapped ${mostDormantVisible?.symbol || 'nobody'} to background`);
}

// ─── CANDIDATE POOL REFRESH ──────────────────────────────────────────────────
// Source: GeckoTerminal trending pools (organic momentum, 6H) + new pools on
// Solana — 5 pages × 20 = up to 100 from each list.  Each GT pool address is
// looked up on DexScreener for full pair data (m5Txns etc).  DexScreener boost
// tokens are added on top.  Called every 3 min by scanForEntries(); results are
// cached in _candidatePool / _candidatePoolMap so the 15-second evaluation loop
// never touches any external API directly.
async function refreshCandidatePool() {
  console.log('[POOL] Refreshing candidate pool — GeckoTerminal trending + new pools...');
  const seen          = new Set();
  const candidates    = [];
  // graduatedSeen: token addresses for which a graduated-DEX pair is already in
  // candidates — prevents the seen check from blocking a graduated pair when the
  // same address appeared earlier as a pump.fun bonding-curve pair.
  const graduatedSeen = new Set();
  const dexBoostAddrs = new Set(); // merged into trending map below

  // ── GeckoTerminal — trending Solana pools (6H) ─────────────────────────────
  // Top 100 organic momentum coins — no paid boosts, purely tx/volume growth.
  // Pages 1-5 × 20 results = up to 100 pools.
  const MAX_FDV_USD     = 10_000_000; // skip coins with FDV > $10M (too large for $50 position to move meaningfully)
  const gtTrendingPools = [];
  for (let page = 1; page <= 5; page++) {
    try {
      const r = await httpGet('api.coingecko.com', `/api/v3/onchain/networks/solana/trending_pools?duration=6h&page=${page}`);
      if (r.status === 401 || r.status === 403) {
        console.log(`[POOL] GeckoTerminal trending: HTTP ${r.status} — API key may be required`); break;
      }
      const d     = JSON.parse(r.body);
      const pools = d.data || [];
      gtTrendingPools.push(...pools);
      console.log(`[POOL] GT trending page ${page}: ${pools.length} pools`);
      if (pools.length < 20) break; // end of data
    } catch(e) { console.log(`[POOL] GT trending page ${page} error: ${e.message}`); break; }
    await sleep(300);
  }

  // ── GeckoTerminal — new Solana pools ───────────────────────────────────────
  // Newly launched coins gaining traction — equivalent to DexScreener "New Trending" tab.
  const gtNewPools = [];
  for (let page = 1; page <= 5; page++) {
    try {
      const r = await httpGet('api.coingecko.com', `/api/v3/onchain/networks/solana/new_pools?page=${page}`);
      if (r.status === 401 || r.status === 403) {
        console.log(`[POOL] GeckoTerminal new: HTTP ${r.status} — API key may be required`); break;
      }
      const d     = JSON.parse(r.body);
      const pools = d.data || [];
      gtNewPools.push(...pools);
      console.log(`[POOL] GT new page ${page}: ${pools.length} pools`);
      if (pools.length < 20) break;
    } catch(e) { console.log(`[POOL] GT new page ${page} error: ${e.message}`); break; }
    await sleep(300);
  }

  // ── Fetch DexScreener pair data for each GeckoTerminal pool ───────────────
  // GT pool address = Raydium / PumpSwap pair address → lookup full pair data
  // including m5Txns which GeckoTerminal does not expose directly.
  const gtAllPools  = [...gtTrendingPools, ...gtNewPools];
  const gtPoolAddrs = new Set();
  let fdvFiltered   = 0;
  let dexFetched    = 0;

  for (const pool of gtAllPools) {
    const a        = pool.attributes || {};
    const poolAddr = a.address || '';
    if (!poolAddr || gtPoolAddrs.has(poolAddr)) continue;

    // FDV filter — skip established large-cap coins; $50 position can't move them
    const fdv = parseFloat(a.fdv_usd) || 0;
    if (fdv > MAX_FDV_USD) { fdvFiltered++; continue; }

    gtPoolAddrs.add(poolAddr);

    try {
      const r    = await httpGet('api.dexscreener.com', `/latest/dex/pairs/solana/${poolAddr}`);
      const d    = JSON.parse(r.body);
      const pair = d.pair || (d.pairs || [])[0];
      if (pair) {
        const tokenAddr = pair.baseToken?.address || '';
        if (tokenAddr && !seen.has(tokenAddr)) {
          seen.add(tokenAddr); candidates.push(pair);
          if (ALLOWED_DEXES.has(pair.dexId)) graduatedSeen.add(tokenAddr);
          dexFetched++;
        }
      }
    } catch(e) {}
    await sleep(100);
  }
  console.log(`[POOL] GT → DexScreener: ${dexFetched} pairs | ${fdvFiltered} skipped (FDV > $${(MAX_FDV_USD/1e6).toFixed(0)}M) | ${gtTrendingPools.length} trending + ${gtNewPools.length} new pools`);

  // ── DexScreener Boosted Tokens ─────────────────────────────────────────────
  const boostEndpoints = ['/token-boosts/top/v1', '/token-boosts/latest/v1'];
  for (const boostEp of boostEndpoints) {
    try {
      const r = await httpGet('api.dexscreener.com', boostEp);
      const d = JSON.parse(r.body);
      const boosted = Array.isArray(d) ? d : [];
      const solanaBoosted = boosted.filter(b => b.chainId === 'solana').slice(0, 50);
      console.log(`[POOL] Boosted (${boostEp.split('/')[1]}): ${boosted.length} total, ${solanaBoosted.length} Solana`);
      for (const b of solanaBoosted) {
        const addr = b.tokenAddress || '';
        if (!addr || graduatedSeen.has(addr)) continue;
        seen.add(addr);
        dexBoostAddrs.add(addr.toLowerCase());
        try {
          const r2 = await httpGet('api.dexscreener.com', `/latest/dex/tokens/${addr}`);
          const d2 = JSON.parse(r2.body);
          const graduatedPair = (d2.pairs || []).find(p => ALLOWED_DEXES.has(p.dexId));
          const targetPair    = graduatedPair || (d2.pairs || [])[0];
          if (targetPair) {
            const a2 = targetPair.baseToken?.address || '';
            if (a2 && !graduatedSeen.has(a2)) {
              seen.add(a2); candidates.push(targetPair);
              if (ALLOWED_DEXES.has(targetPair.dexId)) graduatedSeen.add(a2);
            }
          }
        } catch(e) {}
        await sleep(80);
      }
    } catch(e) { console.log(`[POOL] Boosted endpoint error (${boostEp}): ${e.message}`); }
  }

  // ── Trending cross-reference ───────────────────────────────────────────────
  await fetchTrendingAddrs();
  const scanTrendingMap = new Map(trendingAddrs);
  for (const a of dexBoostAddrs) {
    scanTrendingMap.set(a, (scanTrendingMap.get(a) || 0) + 1);
  }
  const trendingTotal = scanTrendingMap.size;
  if (trendingTotal > 0) console.log(`[POOL] ${trendingTotal} addrs in trending map (${dexBoostAddrs.size} DexBoost + pump.fun + Birdeye)`);

  // ── Trending passes 1 & 2 — fetch individual token pairs ──────────────────
  {
    const gradAddrs = [...scanTrendingMap.entries()]
      .filter(([, w]) => w >= 5)
      .sort((a, b) => b[1] - a[1])
      .map(([addr]) => addr)
      .filter(a => !graduatedSeen.has(a))
      .slice(0, 50);

    const otherAddrs = [...scanTrendingMap.entries()]
      .filter(([, w]) => w < 5)
      .sort((a, b) => b[1] - a[1])
      .map(([addr]) => addr)
      .filter(a => !seen.has(a))
      .slice(0, 50);

    const totalFetch = gradAddrs.length + otherAddrs.length;
    if (totalFetch > 0) {
      console.log(`[POOL] Fetching ${totalFetch} addrs (${gradAddrs.length} grad pass + ${otherAddrs.length} other trending)`);
      let fetched = 0;

      // Pass 1: graduated coins — look for best graduated-DEX pair
      for (const ta of gradAddrs) {
        try {
          const r = await httpGet('api.dexscreener.com', `/latest/dex/tokens/${ta}`);
          const d = JSON.parse(r.body);
          const graduatedPair = (d.pairs || []).find(p => ALLOWED_DEXES.has(p.dexId));
          if (graduatedPair) {
            const a = graduatedPair.baseToken?.address || '';
            if (a && !graduatedSeen.has(a)) {
              seen.add(a); graduatedSeen.add(a); candidates.push(graduatedPair); fetched++;
            }
          }
        } catch(e) {}
        await sleep(80);
      }

      // Pass 2: non-graduated trending
      for (const ta of otherAddrs) {
        try {
          const r = await httpGet('api.dexscreener.com', `/latest/dex/tokens/${ta}`);
          const d = JSON.parse(r.body);
          for (const p of (d.pairs || []).slice(0, 2)) {
            const a = p.baseToken?.address || '';
            if (a && !seen.has(a)) {
              seen.add(a); candidates.push(p); fetched++;
              if (ALLOWED_DEXES.has(p.dexId)) graduatedSeen.add(a);
            }
          }
        } catch(e) {}
        await sleep(80);
      }

      console.log(`[POOL] Added ${fetched} new candidates from trending feeds`);
    }
  }

  // ── Commit to module-level cache ───────────────────────────────────────────
  _candidatePool    = candidates;
  _candidatePoolMap = scanTrendingMap;
  _candidatePoolAt  = Date.now();
  console.log(`[POOL] Cache committed: ${candidates.length} candidates, ${scanTrendingMap.size} trending addrs`);
}

// ─── SCANNER ─────────────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
async function scanForEntries() {
  if (!(await isBotRunning())) return;
  // Fast in-memory check — no Firestore read needed when already halted
  // Diagnostic mode bypasses the daily halt — research trial must not be gated by daily P&L.
  if (dayHaltedToday && !diagnosticMode) {
    await checkDayRestart(); // check if user sent /restart
    return;
  }
  await checkTradingPeriod();
  const positions = await getVisiblePositions();
  const _maxPos = diagnosticMode ? DIAG_MAX_POSITIONS : MAX_POSITIONS;
  if (positions.length >= _maxPos) return;

  const vacantSlots = _maxPos - positions.length;

  // Count open slots per strategy
  const slotCount = {};
  STRATEGIES.forEach(s => slotCount[s.id] = 0);
  positions.forEach(p => { if (p.strategyId != null) slotCount[p.strategyId]++; });

  const openStrategies = STRATEGIES.filter(s => slotCount[s.id] < s.maxSlots);
  if (!openStrategies.length) return;

  // ── Score threshold — slight relief (−5) when 5+ slots empty, floor at 30 ──
  // Nov-12: fixed bug — was Math.max(MIN_SCORE, MIN_SCORE-5) which always = MIN_SCORE.
  // Now correctly lowers to MIN_SCORE-5 (40) when 5+ slots are vacant.
  const scoreThreshold = vacantSlots >= 5 ? Math.max(30, MIN_SCORE - 5) : MIN_SCORE;
  if (vacantSlots >= 3) console.log(`[BOT] ${vacantSlots} slots vacant — score threshold: ${scoreThreshold}`);

  // ── Candidate pool — refreshed every 3 min; evaluation runs every 15s against cache ──
  // This decouples the 100+ DexScreener API calls (fetch phase) from the fast
  // detectStrategy evaluation loop — fixing the rate-limiting root cause of 0 candidates.
  if (Date.now() - _candidatePoolAt > CANDIDATE_POOL_TTL) {
    console.log('[POOL] Cache stale — refreshing DexScreener candidates...');
    await refreshCandidatePool();
  }
  const candidates      = _candidatePool;
  const scanTrendingMap = _candidatePoolMap;

  // Clean up expired SL blocks (older than 6h)
  const nowTs = Date.now();
  for (const [addr, ts] of recentSLCoins) {
    if (nowTs - ts > SL_BLOCK_MS) recentSLCoins.delete(addr);
  }

  // Score and match each candidate to a strategy
  // Use both address and mint fields to catch duplicates regardless of which was stored
  const openAddrs = new Set([
    ...positions.map(p => p.address).filter(Boolean),
    ...positions.map(p => p.mint).filter(Boolean),
  ]);
  const matches          = [];
  const watchingCoins    = []; // near-miss coins for the periodic monitoring report
  let nearMissCount = 0;

  for (const pair of candidates) {
    const addr = pair.baseToken?.address || '';
    if (openAddrs.has(addr) || enteredToday.has(addr) || recentSLCoins.has(addr)) continue;

    const result = detectStrategy(pair, openStrategies);
    if (result) {
      // Tiered threshold: trending presence lowers the bar
      // Base: MIN_SCORE | On 1 platform: −4 | On 2+ platforms: −8 (always relative to base)
      const addrLower  = (result.addr || '').toLowerCase();
      const trendCount = scanTrendingMap.get(addrLower) || 0;
      const effectiveThreshold = trendCount >= 2
        ? Math.max(30, scoreThreshold - 8)
        : trendCount === 1
        ? Math.max(34, scoreThreshold - 4)
        : scoreThreshold;

      // ── TA BONUS (RSI + EMA + Bollinger + Volume, up to +20) ───────────────
      // Computed before the threshold check so it can lift near-miss coins over the bar.
      // Only run when the coin is within striking distance (base score ≥ threshold - 20).
      // Virtual candles (PS/SC/AM <6h): instant in-memory — no API call.
      // GeckoTerminal fetch (BB/OR/AM ≥6h): async, 60-s cached to avoid repeat calls.
      if (result.score >= effectiveThreshold - 20) {
        const taBonus = await computeTAScore(result);
        if (taBonus > 0) {
          result.score    = Math.min(result.score + taBonus, 120); // allow up to 120 with TA bonus
          result._taBonus = taBonus;
        }
      }

      if (result.score >= effectiveThreshold || diagnosticMode) {
        if (trendCount > 0) result._trendingPlatforms = trendCount; // attach badge for Telegram
        // Record price snapshot for trend/rebound tracking (also store volume/buys for TA indicators)
        const price = parseFloat(pair.priceUsd || 0);
        const m5Sells = (result.m5Txns || 0) - (result.m5Buys || 0);
        recordPriceHistory(result.addr, price, result.score, result.m5Vol || 0, result.m5Buys || 0, Math.max(0, m5Sells));
        // Track strategy distribution for period stats
        const _stratKeys = ['bb','am','sc','or','ps'];
        const _sk = _stratKeys[result.strategy.id];
        if (_sk !== undefined) stratPeriodStats[_sk]++;
        matches.push(result);
      } else {
        nearMissCount++;
        // Log near misses for visibility
        if (result.score >= 40) {
          const trendNote = trendCount > 0 ? ` [trending:${trendCount}]` : '';
          console.log(`[NEAR MISS] ${result.symbol}: ${result.strategy.label} score ${result.score} (need ${effectiveThreshold}${trendNote}) | m5:${result.m5Ch?.toFixed(1)}% m5txns:${result.m5Txns} h1:${result.ch1?.toFixed(1)}% buy:${result.buyPct?.toFixed(0)}%`);
        }
        // Collect near-misses for on-demand /watching command: score ≥60, or trending with score ≥50
        if (result.score >= 60 || (trendCount > 0 && result.score >= 50)) {
          watchingCoins.push(result);
        }
      }
    }
  }

  // Always log scan summary so Fly.io logs show activity
  console.log(`[SCAN] #${scanCount}: ${candidates.length} candidates → ${matches.length} above threshold, ${nearMissCount} near misses (threshold: ${scoreThreshold})`);
  // ── GATE DIAGNOSTIC (temporary — shows which filter is blocking all coins) ──
  if (gateStats.total > 0) {
    const g = gateStats;
    const bypassNote = [
      globalGatesBypass      ? 'GLOBAL BYPASSED' : '',
      tierGateBypass         ? 'TIERS BYPASSED'  : '',
      !strategyFiltersActive ? 'STRATS BYPASSED' : '',
      lpLockBypass           ? 'LP BYPASSED'     : '',
    ].filter(Boolean).join(' + ');
    const bypassPrefix = bypassNote ? ` [${bypassNote}]` : '';
    console.log(`[SCAN-DIAG]${bypassPrefix} dex:${g.dex} mom:${g.mom} dead:${g.dead} young:${g.young} ratio:${g.ratio} avgT:${g.avgT} noAct:${g.noAct} noMatch:${g.noMatch} | honey:${g.honey} txns:${g.txns} chain:${g.chain} liqFloor:${g.liqFloor} price:${g.price} age:${g.age} live:${g.live} | TOTAL:${g.total}`);
    // Accumulate into period stats before resetting (period stats are flushed to Telegram on heartbeat)
    Object.keys(gateStats).forEach(k => { gatePeriodStats[k] = (gatePeriodStats[k] || 0) + gateStats[k]; });
    Object.keys(gateStats).forEach(k => { gateStats[k] = 0; });
  }

  // ── PERIODIC "WATCHING" REPORT — every 60 scans (~15 min) ───────────────────
  // Tells Telegram what the bot is monitoring but has NOT entered yet.
  // Score ≥ 60 = on radar (strong signal, monitoring). Score ≥ MIN_SCORE = entered (separate message).
  // This answers: "are those 3 coins qualified or just monitoring?" — here they are NOT.
  // Periodic scan report suppressed — use /watching command for on-demand monitoring status
  watchingCoinsSnapshot = [...watchingCoins]; // keep latest for /watching command

  // Sort: trending/rebounding coins first, then by score
  matches.sort((a, b) => {
    const qa = isTrendingUp(a.addr) === true || isRebounding(a.addr) === true ? 1 : 0;
    const qb = isTrendingUp(b.addr) === true || isRebounding(b.addr) === true ? 1 : 0;
    if (qb !== qa) return qb - qa; // quality coins first
    return b.score - a.score;      // then by score
  });

  // Filter by LP lock (batch GoPlus check per chain)
  if (matches.length > 0) console.log(`[SCAN] ${candidates.length} candidates → ${matches.length} scored matches`);
  let lockedMatches;
  if (lpLockBypass) {
    lockedMatches = matches;
    if (matches.length > 0) console.log(`[LP LOCK] ⚠️ BYPASSED — passing all ${matches.length} matches through (diagnostic mode)`);
  } else {
    lockedMatches = await filterByLpLock(matches);
    if (matches.length > 0) {
      const dropped = matches.length - lockedMatches.length;
      if (dropped > 0) console.log(`[LP LOCK] ${dropped}/${matches.length} matches skipped — LP not locked`);
      else console.log(`[LP LOCK] All ${lockedMatches.length} matches passed LP check`);
    }
  }

  // Apply price quality gate: only block coins in confirmed active decline
  // (all last 3 price points dropping). Trending, rebounding, stable, or new coins
  // all pass. High-confidence signals (score ≥ 85) always pass regardless.
  const qualityMatches = lockedMatches.filter(coin => {
    if (coin.score >= 85 || diagnosticMode) return true; // always pass high-confidence / diagnostic
    if (isDeclining(coin.addr)) {
      console.log(`[QUALITY] ❌ ${coin.symbol} — ${priceQualityLabel(coin.addr)}, skipped`);
      return false;
    }
    const label = priceQualityLabel(coin.addr);
    if (label !== '🆕 NEW') console.log(`[QUALITY] ✅ ${coin.symbol} — ${label}`);
    return true;
  });

  // ── Periodic heartbeat (every 20 scans ≈ 5 min) ─────────────────────────────
  // Placed here so lockedMatches and qualityMatches are already declared above.
  if (scanCount % 20 === 0) {
    const openPositions = await getOpenPositions().catch(() => []);
    const cfg2 = await getTradingConfig().catch(() => ({}));
    const mode = (cfg2.tradingMode || 'paper').toUpperCase();
    const paused = cfg2.running === false ? ' ⏸PAUSED' : '';
    const halted = dayHaltedToday ? ' 🚨HALTED' : '';

    // ── Build gate diagnostic section ────────────────────────────────────
    const gp = gatePeriodStats;
    const lp = lpPeriodStats;
    const sp = stratPeriodStats;
    const totalGlobal = gp.total;

    // Top rejections (sorted by count, top 5)
    const topRej = Object.entries({ dex:gp.dex, mom:gp.mom, dead:gp.dead, young:gp.young,
      noMatch:gp.noMatch, ratio:gp.ratio, avgT:gp.avgT, noAct:gp.noAct,
      age:gp.age, live:gp.live, honey:gp.honey, txns:gp.txns, liqFloor:gp.liqFloor })
      .filter(([,v]) => v > 0).sort(([,a],[,b]) => b-a).slice(0,5)
      .map(([k,v]) => `${k}:${v}`).join(' ');

    const stratLine = `BB:${sp.bb} AM:${sp.am} SC:${sp.sc} OR:${sp.or} PS:${sp.ps}`;

    const lpLine = lp.checked > 0
      ? `LP: ${lp.checked} chk→${lp.passed} pass | risk:${lp.failRisk} liq:${lp.failLiq} ratio:${lp.failRatio}${lp.rcFail > 0 ? ` ⚠️rc-fail:${lp.rcFail}` : ''}`
      : '';

    const gateSection = totalGlobal > 0 || lp.checked > 0
      ? `\n\n📊 *Gates (${scanCount - 19}–${scanCount})*\n` +
        (totalGlobal > 0 ? `Global: ${totalGlobal} processed${topRej ? ` | ${topRej}` : ' | no rejections'}\n` : '') +
        (lpLine ? lpLine + '\n' : '') +
        `Strats: ${stratLine}`
      : '';

    // ── Build gate simulation section ─────────────────────────────────────
    const sim = gateSimStats;
    const simGlobalTopRej = Object.entries({
      liqFloor:sim.liqFloor, honey:sim.honey, txns:sim.txns, avgT:sim.avgT, ratio:sim.ratio,
      youngBuy:sim.youngBuy, youngTxns:sim.youngTxns, dead:sim.dead, noAct:sim.noAct,
      dex:sim.dex, age:sim.age, mom:sim.mom
    }).filter(([,v]) => v > 0).sort(([,a],[,b]) => b-a).slice(0,5)
      .map(([k,v]) => `${k}:${v}`).join(' ');
    const simStratLines = [
      `BB: age:${sim.bbAge} ch24:${sim.bbCh24} ch1:${sim.bbCh1} m5:${sim.bbM5Ch} buy:${sim.bbBuy} txns:${sim.bbTxns} liq:${sim.bbLiq}`,
      `AM: m5:${sim.amM5Ch} buy:${sim.amBuy} txns:${sim.amTxns} liq:${sim.amLiq} ch1:${sim.amCh1}`,
      `SC: age:${sim.scAge} m5:${sim.scM5Ch} buy:${sim.scBuy} txns:${sim.scTxns} liq:${sim.scLiq} avgT:${sim.scAvgT}`,
      `OR: age:${sim.orAge} ch24:${sim.orCh24} ch1:${sim.orCh1} buy:${sim.orBuy} liq:${sim.orLiq} b24:${sim.orBuys24}`,
      `PS: age:${sim.psAge} ch1:${sim.psCh1} m5:${sim.psM5Ch} buy:${sim.psBuy} txns:${sim.psTxns} liq:${sim.psLiq}`,
    ].join('\n');
    const simLpLine = `BB:${sim.lpBB} AM:${sim.lpAM} SC:${sim.lpSC} OR:${sim.lpOR} PS:${sim.lpPS} ratio:${sim.lpRatio}`;
    const simSection = sim.total > 0
      ? `\n\n🔬 *Sim (${sim.total} coins — bypass-independent)*\n` +
        `Global: ${simGlobalTopRej || 'no blocks'}\n` +
        `LP liq: ${simLpLine}\n` +
        simStratLines
      : '';

    await sendTelegram(
      `🔍 *Scan #${scanCount}*${paused}${halted}\n` +
      `Mode: *${mode}${diagnosticMode ? ' 🔬DIAG' : ''}* · Open: ${openPositions.length}/${diagnosticMode ? DIAG_MAX_POSITIONS : MAX_POSITIONS}${diagnosticMode ? ` (${diagnosticTradeCount}/${DIAGNOSTIC_TARGET} logged)` : ''}\n` +
      `${candidates.length} cands→${matches.length} scored→${lockedMatches.length} LP OK→${qualityMatches.length} quality\n` +
      `${nearMissCount} near-misses (score ${MIN_SCORE - 8}-${scoreThreshold - 1})` +
      gateSection +
      simSection +
      (globalGatesBypass || tierGateBypass || lpLockBypass || !strategyFiltersActive
        ? `\n\n🔓 *OPEN MODE ACTIVE*` +
          (globalGatesBypass      ? `\n⚠️ Global gates: BYPASSED (/skipgates to restore)`  : '') +
          (tierGateBypass         ? `\n⚠️ Tier gates: BYPASSED (/skiptiers to restore)`    : '') +
          (lpLockBypass           ? `\n⚠️ LP/RugCheck: BYPASSED (/skiplp to restore)`       : '') +
          (!strategyFiltersActive ? `\n⚠️ Strategy filters: OFF (/skipstrats to restore)`   : '') +
          `\n_/openmode to restore all at once_`
        : '')
    ).catch(() => {});

    // Reset period stats after sending heartbeat
    Object.keys(gatePeriodStats).forEach(k => { gatePeriodStats[k] = 0; });
    Object.keys(lpPeriodStats).forEach(k => { lpPeriodStats[k] = 0; });
    Object.keys(stratPeriodStats).forEach(k => { stratPeriodStats[k] = 0; });
    Object.keys(gateSimStats).forEach(k => { gateSimStats[k] = 0; });
  }

  const usedThisScan = new Set();

  // ── RANGE RE-ENTRY: flag quality coins that bounced off support after range exit ──
  // These coins already scored, passed LP gate, and appeared in qualityMatches.
  // If they match our watchlist and show a support bounce, mark for direct entry
  // (bypassing the pullback gate — we know the range and this IS the entry signal).
  for (const coin of qualityMatches) {
    const w = rangeReentryWatchlist.get(coin.addr);
    if (!w) continue;
    // Expire old watchlist entries
    if (Date.now() - w.exitTime > RANGE_REENTRY_WINDOW) {
      rangeReentryWatchlist.delete(coin.addr);
      continue;
    }
    // Already in a position for this coin — watchlist entry is stale
    if (positions.find(p => p.address === coin.addr)) {
      rangeReentryWatchlist.delete(coin.addr);
      continue;
    }
    // Price near support level and bouncing back up?
    const atSupport = coin.price <= w.supportLevel * RANGE_SUPPORT_PCT;
    const bouncing  = isRebounding(coin.addr);
    const rising    = isTrendingUp(coin.addr, 3);
    if (atSupport && (bouncing || rising)) {
      coin._rangeReentry = true; // bypass pullback gate — this IS the re-entry signal
      console.log(`[RANGE-REENTRY] ${coin.symbol} bouncing from support $${fmtPrice(w.supportLevel)} — flagged for entry`);
    }
  }

  // Load cfg once for the entry loop (position ceiling + tiered entry gate)
  const _entryCfg = await getTradingConfig().catch(() => ({}));
  const _entryCeiling = parseFloat(_entryCfg.positionSize) || POSITION_SIZE;

  // Apply session filters (age/mcap/vol/liq restrictions set by user via /filter)
  // Nov-23: diagnostic mode now respects session filters too — previously bypassed them,
  // making /filter commands have zero effect on diagnostic results. The 8k liq floor
  // is enforced separately in detectStrategy(), so it is preserved regardless.
  const filteredMatches = applySessionFilters(qualityMatches);
  if (filteredMatches.length < qualityMatches.length) {
    console.log(`[SESSION-FILTER] ${qualityMatches.length - filteredMatches.length}/${qualityMatches.length} matches dropped by session filters (${fmtSessionFilters().replace(/\n/g,' | ')})`);
  }

  for (const coin of filteredMatches) {
    if (positions.length >= _maxPos) break;
    if (usedThisScan.has(coin.addr)) continue;
    // Entry cooldown: only blocks when NOT paused (paused path uses its own cooldown)
    const last = alertCooldown.get(coin.addr) || 0;
    if (!autoEntryPaused && Date.now() - last < 30 * 60 * 1000) continue;
    // Manual-mode window gate: max MANUAL_MAX_ALERTS per MANUAL_WINDOW_MS; resets after window expires
    if (autoEntryPaused) {
      const ms = manualAlertState.get(coin.addr);
      if (ms) {
        const windowAge = Date.now() - ms.windowStart;
        if (windowAge < MANUAL_WINDOW_MS && (ms.count >= MANUAL_MAX_ALERTS || ms.skipped)) continue;
        if (windowAge >= MANUAL_WINDOW_MS) manualAlertState.delete(coin.addr); // new window
      }
    }
    // Check slot still available (may have been filled earlier in this loop) — bypassed in diagnostic mode
    if (!diagnosticMode && slotCount[coin.strategy.id] >= coin.strategy.maxSlots) continue;

    // ── Tiered entry gate (age + transaction rate by position size) ───────────
    // Uses the actual dynamic size (liq × 1% × MC multiplier, capped at ceiling)
    // so a $100 ceiling on a thin-liquidity coin isn't forced into the $50+ age tier.
    {
      const _age      = coin.ageMinutes || 0;
      const _buysMin  = (coin.m5Buys  || 0) / 5;  // buys per minute
      const _sellsMin = (coin.m5Sells || 0) / 5;  // sells per minute
      const _sz       = calcDynamicPositionSize(coin.liq || 0, coin.mcap || 0, _entryCeiling);
      let _tierBlock  = null;

      if (_sz < 5) {
        // $1–$4: need ≥1 buy/min + ≥1 sell/min — confirms 2-sided trading (Nov-19: lowered from 3 buys/min)
        if (_buysMin  < 1) _tierBlock = `buys/min ${_buysMin.toFixed(1)} < 1 (tier $1–$4)`;
        else if (_sellsMin < 1) _tierBlock = `sells/min ${_sellsMin.toFixed(1)} < 1 (tier $1–$4)`;
      } else if (_sz < 10) {
        // $5–$9: coin must be ≥5 min old (no txn minimum)
        if (_age < 5) _tierBlock = `age ${_age.toFixed(1)}min < 5 (tier $5–$9)`;
      } else if (_sz < 20) {
        // $10–$19: coin must be ≥15 min old (no txn minimum)
        if (_age < 15) _tierBlock = `age ${_age.toFixed(1)}min < 15 (tier $10–$19)`;
      } else if (_sz < 50) {
        // $20–$49: coin must be ≥15 min old (no txn minimum)
        if (_age < 15) _tierBlock = `age ${_age.toFixed(1)}min < 15 (tier $20–$49)`;
      } else {
        // $50+: coin must be ≥20 min old (no txn minimum)
        if (_age < 20) _tierBlock = `age ${_age.toFixed(1)}min < 20 (tier $50+)`;
      }

      if (_tierBlock && !diagnosticMode && !globalGatesBypass && !tierGateBypass) {
        console.log(`[TIER-GATE] BLOCKED ${coin.symbol} — ${_tierBlock} (dynSize=$${_sz.toFixed(2)} ceiling=$${_entryCeiling})`);
        usedThisScan.add(coin.addr);
        continue;
      }
    }

    // ── RANGE-TOP GUARD (id 1 / id 2 only) ─────────────────────────────────────
    // If the bot has seen this coin ≥5 times AND its current price is in the top
    // 20% of the observed price range, the coin is ranging — we're about to buy
    // the top of a spike that will retrace.  Skip and wait for a lower entry.
    if (coin.strategy.id === 1 || coin.strategy.id === 2) {
      const hist = priceHistory.get(coin.addr) || [];
      if (hist.length >= 5) {
        const prices  = hist.map(h => h.price);
        const minP    = Math.min(...prices);
        const maxP    = Math.max(...prices);
        const rangeSize = maxP - minP;
        if (rangeSize > minP * 0.08) { // meaningful oscillation (>8% swing observed)
          const posInRange = (coin.price - minP) / rangeSize;
          if (posInRange > 0.80 && !diagnosticMode) {
            console.log(`[RANGE-TOP] ${coin.symbol} — price in top ${(posInRange*100).toFixed(0)}% of range ($${fmtPrice(minP)}–$${fmtPrice(maxP)}) — skipping range-top entry`);
            usedThisScan.add(coin.addr);
            continue;
          }
        }
      }
    }

    // ── BUILD signal alert fields (used for both entered and paused-entry alerts) ──
    const s = coin.strategy;
    const isYoung = s.id === 1 && (coin.ageMinutes || 0) < 60;
    const ageLabel = coin.ageMinutes < 60
      ? `${Math.round(coin.ageMinutes)}min old`
      : `${(coin.ageDays * 24).toFixed(1)}h old`;
    const tpInfo = isYoung
      ? `⚡ *YOUNG COIN MODE* (${ageLabel}) — quick exits:\n` +
        `🎯 +10%: sell 30% | +20%: sell 30% | +30%: sell 30%\n` +
        `🏁 10% remains on 5% tight trailing SL\n`
      : s.usePartialProfit
        ? `🎯 Stage 1 (+50%): sell 25%\n🎯 Stage 2 (+100%): sell 30%\n🎯 Stage 3 (+200%): sell 15% → free ride\n`
        : s.tp1x
          ? `🎯 TP1: $${fmtPrice(coin.price * s.tp1x)} (+${((s.tp1x-1)*100).toFixed(0)}%) → 50%\n` +
            `🎯 TP2: $${fmtPrice(coin.price * s.tp2x)} (+${((s.tp2x-1)*100).toFixed(0)}%) → 30%\n` +
            `🎯 TP3: $${fmtPrice(coin.price * s.tp3x)} (+${((s.tp3x-1)*100).toFixed(0)}%) → 20%\n`
          : `🎯 SL: 50% trail · capital out +50% · tightens 5%/+20% → 5% floor\n`;
    const pumpBadge     = coin.isPumpFun ? `🎪 Pump.fun${isYoung?' · YOUNG COIN':''}\n` : '';
    const trendBadge    = coin._trendingPlatforms
      ? `🔥 Trending on ${coin._trendingPlatforms} platform${coin._trendingPlatforms > 1 ? 's' : ''} (score threshold lowered)\n`
      : '';
    const pullbackBadge = coin._pulledBackPct
      ? `📉 Pullback entry: -${coin._pulledBackPct}% → +${coin._bouncedPct}% bounce\n`
      : '';
    const explosiveBadge = coin._explosiveEntry
      ? `⚡ Explosive trend — immediate entry (m5:+${coin.m5Ch?.toFixed(1)}% h1:+${coin.ch1?.toFixed(1)}%)\n`
      : '';
    const rangeReentryBadge = coin._rangeReentry
      ? `🔄 Range re-entry — support bounce confirmed\n`
      : '';
    const taBadge = coin._taBonus
      ? `📐 TA boost: +${coin._taBonus}pts (RSI/EMA/BB/Volume)\n`
      : '';

    // ── MANUAL MODE: send signal with inline Enter / Skip buttons ────────────────
    // Diagnostic mode bypasses the pause — research trial must enter positions freely.
    // PARTIAL-AUTO: trend-confirmed coins (previously in a position today) bypass the
    // manual gate and auto-enter even in manual mode — they've already proven themselves.
    if (autoEntryPaused && !diagnosticMode) {
      const isTrendConfirmed = trendConfirmedAddrs.has((coin.addr || '').toLowerCase());

      if (!isTrendConfirmed) {
        // ── Unknown coin in manual mode → show Enter / Skip buttons ────────────
        usedThisScan.add(coin.addr);

        // Update (or create) the 5-min window state for this coin
        const existing   = manualAlertState.get(coin.addr);
        const alertState = existing || { count: 0, windowStart: Date.now(), coin, s, skipped: false };
        alertState.count++;
        alertState.coin = coin;   // freshen coin data each alert
        alertState.s    = s;
        manualAlertState.set(coin.addr, alertState);

        const alertN  = alertState.count;
        const msLeft  = Math.max(1, Math.ceil((MANUAL_WINDOW_MS - (Date.now() - alertState.windowStart)) / 60000));
        const header  = alertN === 1
          ? `🎯 *MANUAL SIGNAL — tap to enter*`
          : `🔔 *SIGNAL (${alertN}/${MANUAL_MAX_ALERTS}) — still qualifying*`;

        const posSize = calcDynamicPositionSize(coin.liq || 0, coin.mcap || 0, _entryCeiling);

        await sendTelegramWithButtons(
          `${header}\n\n` +
          `*${coin.symbol}* — ${coin.name}\n` +
          `${s.label} · Score: *${coin.score}/100*\n` +
          `${pumpBadge}` +
          `${trendBadge}` +
          `${pullbackBadge}` +
          `${explosiveBadge}` +
          `${rangeReentryBadge}` +
          `${taBadge}` +
          `💡 ${s.desc}\n\n` +
          `💵 Price: $${fmtPrice(coin.price)}\n` +
          `💰 Est. size: $${posSize.toFixed(0)}\n` +
          `📊 Buy%: ${coin.buyPct.toFixed(0)}% | Liq: $${(coin.liq/1000).toFixed(0)}k\n` +
          `📈 Age: ${ageLabel} | m5: ${coin.m5Ch>0?'+':''}${coin.m5Ch.toFixed(1)}% | h1: ${coin.ch1!=null?(coin.ch1>0?'+':'')+coin.ch1.toFixed(1)+'%':'<1h'}\n\n` +
          `🔗 [Chart](${coin.dexUrl})\n` +
          `⏳ _Window: ~${msLeft}min left_`,
          [
            [
              { text: `✅ Enter Trade ($${posSize.toFixed(0)})`, callback_data: `manual_enter:${coin.addr}` },
              { text: `❌ Skip`,                                  callback_data: `manual_skip:${coin.addr}`  },
            ]
          ]
        );
        console.log(`[MANUAL] ${coin.symbol} alert ${alertN}/${MANUAL_MAX_ALERTS} (${msLeft}min left in window)`);
        continue;
      }

      // ── Trend-confirmed in manual mode → auto-enter (partial auto) ─────────
      coin._trendReentry = true;
      console.log(`[PARTIAL-AUTO] ${coin.symbol} — trend confirmed, auto-entering in manual mode`);
    }

    // Reserve coin BEFORE the async enterPosition call — a concurrent scan tick
    // starting during the Firestore await would otherwise find the coin absent
    // from enteredToday and enter it a second time. Roll back if entry fails.
    enteredToday.add(coin.addr);
    usedThisScan.add(coin.addr);
    const pos = await enterPosition(coin);
    if (!pos) {
      enteredToday.delete(coin.addr); // no position created — release the reservation
      continue; // null = real mode with no matching wallet for this chain
    }
    alertCooldown.set(coin.addr, Date.now()); // set AFTER successful entry to avoid 30-min lockout on failure
    positions.push(pos);
    slotCount[coin.strategy.id]++;
    if (coin._rangeReentry) rangeReentryWatchlist.delete(coin.addr); // watchlist fulfilled

    const modeHeader = coin._trendReentry
      ? (pos.tradingMode === 'real'
          ? `⚡ *AUTO RE-ENTRY — REAL (trend confirmed)*`
          : `⚡ *AUTO RE-ENTRY — PAPER (trend confirmed)*`)
      : (pos.tradingMode === 'real'
          ? `💰 *BOT ENTERED — REAL TRADE*`
          : `✅ *BOT ENTERED — PAPER TRADE*`);
    // Note: "BOT ENTERED" = the bot has already bought this position.
    //       This is NOT a suggestion or monitoring alert.
    //       Compare with "👀 MONITORING" messages which are NOT entered.
    await sendTelegram(
      `${modeHeader}\n\n` +
      `*${coin.symbol}* — ${coin.name}\n` +
      `${s.label} · Score: *${coin.score}/100*\n` +
      `${pumpBadge}` +
      `${trendBadge}` +
      `${pullbackBadge}` +
      `${explosiveBadge}` +
      `${rangeReentryBadge}` +
      `${taBadge}` +
      `💡 ${s.desc}\n\n` +
      `💵 Entry: $${fmtPrice(coin.price)}\n` +
      `💰 Position: ${pos.sizeNote || '$'+pos.size}${pos.walletLabel ? ` · ${pos.walletLabel}` : ''}\n` +
      `📊 Buy%: ${coin.buyPct.toFixed(0)}% | Liq: $${(coin.liq/1000).toFixed(0)}k\n` +
      `📈 Age: ${ageLabel} | m5: ${coin.m5Ch>0?'+':''}${coin.m5Ch.toFixed(1)}% | h1: ${coin.ch1!=null?(coin.ch1>0?'+':'')+coin.ch1.toFixed(1)+'%':'<1h'}\n\n` +
      tpInfo +
      `🛑 SL: $${fmtPrice(coin.price * s.slx)} | Trail: ${s.initialTrailPct}% → floors at 5%\n\n` +
      `\`${coin.addr}\`\n🔗 [Chart](${coin.dexUrl})`
    );
    console.log(`[BOT] Entered ${coin.symbol} via ${s.label} at $${coin.price}`);
  }

  // Process pullback watchlist — check BB and OR coins waiting for support bounce
  await processPullbackWatchlist(positions, slotCount, usedThisScan);

  // Process momentum re-entry — check AM/SC/PS coins after SL for higher-low reversal
  await processMomentumReentry(positions);
}

// ─── HOURLY SUMMARY ───────────────────────────────────────────────────────────
// Build a per-tier breakdown string from daily stats doc
// Returns lines like: 🥇 BB  +$12.34  5T 80%W  or  🔴 SC  -$2.10  3T 33%W
function buildTierBreakdown(stats) {
  const tiers = [
    { key: 'bb', label: 'Bottom Bounce' },
    { key: 'am', label: 'Act. Momentum' },
    { key: 'sc', label: 'Surge Catch'   },
    { key: 'or', label: 'Open Range'    },
    { key: 'ps', label: 'Pump Spec'     },
  ];
  const rows = tiers
    .map(t => {
      const pnl    = stats[`${t.key}_pnl`]    || 0;
      const trades = stats[`${t.key}_trades`] || 0;
      const wins   = stats[`${t.key}_wins`]   || 0;
      return { label: t.label, pnl, trades, wins };
    })
    .filter(r => r.trades > 0)
    .sort((a, b) => b.pnl - a.pnl);

  if (rows.length === 0) return '  (no trades yet)';

  return rows.map((r, i) => {
    const wr   = r.trades > 0 ? Math.round(r.wins / r.trades * 100) : 0;
    const sign = r.pnl >= 0 ? '+' : '';
    const icon = i === 0 && r.pnl > 0 ? '🥇' : r.pnl >= 0 ? '✅' : '🔴';
    return `  ${icon} ${r.label.padEnd(14)} ${sign}$${r.pnl.toFixed(2)}  ${r.trades}T  ${wr}%W`;
  }).join('\n');
}

async function sendHourlySummary() {
  const stats     = await getDailyStats();
  const positions = await getOpenPositions();
  const slotCount = {};
  STRATEGIES.forEach(s => slotCount[s.id] = 0);
  positions.forEach(p => { if (p.strategyId != null) slotCount[p.strategyId]++; });
  const winRate = stats.trades > 0 ? ((stats.wins/stats.trades)*100).toFixed(0) : '—';

  const grossProfit = stats.grossProfit    || 0;
  const grossLoss   = stats.grossLoss      || 0;
  const fees        = stats.dailyFees      || 0;
  const netRevenue  = grossProfit - grossLoss - fees;
  const capital     = stats.capitalDeployed || 0;

  let slotLines = STRATEGIES.map(s =>
    `  ${s.label}: ${slotCount[s.id]}/${s.maxSlots}`
  ).join('\n');

  const tierBreakdown = buildTierBreakdown(stats);

  // Nov-23: Build diagnostic PAPER section — real diag trades already in main P&L above
  let diagSection = '';
  try {
    const oneHourAgo = Date.now() - 3600000;
    const diagSnap = await db.collection('diagnostic_trades').get();
    const diagPaperTrades = diagSnap.docs
      .map(d => d.data())
      .filter(t => (t.tradingMode === 'paper' || !t.tradingMode) && (t.closedAt || 0) >= oneHourAgo);
    if (diagPaperTrades.length > 0) {
      const dWins    = diagPaperTrades.filter(t => t.pnl > 0).length;
      const dLosses  = diagPaperTrades.filter(t => t.pnl <= 0).length;
      const dPnl     = diagPaperTrades.reduce((s, t) => s + (t.pnl || 0), 0);
      const dWinRate = diagPaperTrades.length > 0 ? Math.round(dWins / diagPaperTrades.length * 100) : 0;
      const dSign    = dPnl >= 0 ? '+' : '';
      // Count open diagnostic positions
      const openDiag = positions.filter(p => p.isDiagnostic && p.tradingMode !== 'real').length;
      diagSection =
        `\n─────────────────────\n` +
        `🔬 *DIAGNOSTIC PAPER (last 1h)*\n` +
        `Closed: ${diagPaperTrades.length} trades · Open: ${openDiag}\n` +
        `P&L: ${dSign}$${dPnl.toFixed(2)} · Win rate: ${dWinRate}% (${dWins}W/${dLosses}L)`;
    } else if (diagnosticMode && !diagnosticReal) {
      // Diagnostic paper is active but no trades closed this hour — show open count
      const openDiag = positions.filter(p => p.isDiagnostic).length;
      if (openDiag > 0) {
        diagSection = `\n─────────────────────\n🔬 *DIAGNOSTIC PAPER* — ${openDiag} open, no closes this hour`;
      }
    }
  } catch (e) {
    console.warn('[HOURLY] diag section error:', e.message);
  }

  await sendTelegram(
    `📊 *MEMESCAN — HOURLY*\n\n` +
    `✅ Gross profit:  +$${grossProfit.toFixed(2)}\n` +
    `❌ Gross loss:    -$${grossLoss.toFixed(2)}\n` +
    `💸 Fees paid:     -$${fees.toFixed(2)}\n` +
    `─────────────────────\n` +
    `🏆 Net revenue:   ${netRevenue>=0?'+':''}$${netRevenue.toFixed(2)}\n` +
    `💼 Capital used:  $${capital.toFixed(2)}\n\n` +
    `📈 Win rate: ${winRate}% (${stats.wins}W/${stats.losses}L)\n` +
    `🔓 Positions: ${positions.length}/${MAX_POSITIONS}\n\n` +
    `*Tier P&L (best → worst):*\n${tierBreakdown}\n\n` +
    `*Slots:*\n${slotLines}` +
    diagSection
  );
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────
async function main() {
  console.log('[BOT] MemeScan PRO — 4-Strategy Bot starting...');
  // Log env var presence (not values) so Fly.io logs show what's configured
  // Mask TELEGRAM_CHAT: show first 3 + last 3 chars so we can spot whitespace issues
  // without exposing the full ID in logs (it's not a secret but good hygiene)
  const chatMask = TELEGRAM_CHAT.length >= 6
    ? TELEGRAM_CHAT.slice(0, 3) + '…' + TELEGRAM_CHAT.slice(-3) + ` (${TELEGRAM_CHAT.length} chars)`
    : `"${TELEGRAM_CHAT}" (${TELEGRAM_CHAT.length} chars)`;
  console.log('[BOT] Env check:',
    'TELEGRAM_TOKEN=' + (TELEGRAM_TOKEN ? '✓' : '✗ MISSING'),
    'TELEGRAM_CHAT='  + (TELEGRAM_CHAT  ? chatMask : '✗ MISSING'),
    'FIREBASE_PROJECT=' + (process.env.FIREBASE_PROJECT_ID ? '✓' : '✗ MISSING'),
    'FIREBASE_EMAIL='   + (process.env.FIREBASE_CLIENT_EMAIL ? '✓' : '✗ MISSING'),
    'FIREBASE_KEY='     + (process.env.FIREBASE_PRIVATE_KEY ? '✓' : '✗ MISSING'),
  );

  // Skip all queued Telegram messages so old /start /help etc. don't replay
  await drainTelegramQueue();

  // First thing: announce we're alive (before any Firestore calls)
  await sendTelegram(`🟡 *BOT STARTING...* Firebase: ${firebaseError ? '❌ ' + firebaseError : '✅ connected'}`);

  if (firebaseError) {
    await sendTelegram(`🔴 *FIREBASE ERROR — bot cannot trade*\n\`${firebaseError}\`\n\nFix secrets then restart.`);
    // Keep process alive so Fly.io doesn't roll back — poll Telegram every 30s
    setInterval(() => pollTelegramCommands().catch(() => {}), 30000);
    return; // exits main() but setInterval keeps Node.js alive
  }

  let startCfg, startMode, wallets;
  try {
    startCfg  = await getTradingConfig();
    startMode = (startCfg.tradingMode || 'paper').toUpperCase();
    wallets   = await getWallets();
  } catch(e) {
    await sendTelegram(`🔴 *FIRESTORE ERROR*\n\`${e.message}\`\n\nBot cannot start — check Firebase project permissions.`);
    // Keep process alive so Fly.io doesn't roll back — poll Telegram every 30s
    setInterval(() => pollTelegramCommands().catch(() => {}), 30000);
    return; // exits main() but setInterval keeps Node.js alive
  }

  // ── Restore persisted bypass flags (Nov-12) ────────────────────────────────
  // Flags are now saved to Firestore so they survive restarts.
  globalGatesBypass     = startCfg.gatesOpen ?? false;
  tierGateBypass        = startCfg.tierGateOpen ?? false; // default false = tier gate ON
  lpLockBypass          = !!startCfg.lpOpen;
  strategyFiltersActive = !(startCfg.stratsSkipped ?? true); // Nov-19: default OFF — only age/mcap guards active
  autoEntryPaused          = !!startCfg.autoEntryPaused;
  slTrailMode              = startCfg.slTrailMode || '30';
  diagnosticMode           = !!startCfg.diagnosticMode;
  diagnosticReal           = !!startCfg.diagnosticReal;
  diagnosticTradeCount     = startCfg.diagTradeCount || 0;
  lastAnnouncedPeriodKey   = startCfg.currentPeriod?.key || null; // don't re-announce on restart
  if (startCfg.sessionFilters) sessionFilters = { ...sessionFilters, ...startCfg.sessionFilters };

  // ── Restore trend-confirmed addresses from today's history (Nov-21) ────────
  // Coins that exited today are eligible for auto re-entry even in manual mode.
  try {
    const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
    const { history } = await getCollections();
    const todaySnap  = await db.collection(history).where('closedAt', '>=', todayStart.getTime()).get();
    todaySnap.docs.forEach(d => {
      const addr = (d.data().address || '').toLowerCase();
      if (addr) trendConfirmedAddrs.add(addr);
    });
    if (trendConfirmedAddrs.size > 0)
      console.log(`[BOT] Partial-auto: restored ${trendConfirmedAddrs.size} trend-confirmed addr(s) from today's history`);
  } catch(e) {
    console.warn('[BOT] Could not restore trend-confirmed addrs:', e.message);
  }

  if (globalGatesBypass || lpLockBypass || !strategyFiltersActive) {
    const active = [
      globalGatesBypass      ? '⚠️ Global gates: BYPASSED' : null,
      lpLockBypass           ? '⚠️ LP/RugCheck: BYPASSED'  : null,
      !strategyFiltersActive ? '⚠️ Strategy filters: OFF'  : null,
    ].filter(Boolean).join('\n');
    await sendTelegram(`⚠️ *OPEN MODE ACTIVE* (restored from last session)\n\n${active}\n\nSend /openmode to restore all filters, or /status to confirm.`);
  }
  const walletLine = wallets.length
    ? `👛 ${wallets.length} wallet(s): ${wallets.map(w => w.chain).join(', ')}`
    : `👛 No wallets configured (/wallets to set up)`;

  const slotLines = STRATEGIES.map(s => `${s.label}: ${s.maxSlots} slot${s.maxSlots !== 1 ? 's' : ''}`).join('\n');

  await sendTelegram(
    `✅ *MemeScan PRO — 4-STRATEGY BOT LIVE*\n\n` +
    `${slotLines}\n\n` +
    `💰 Dynamic sizing (liq × 1%, $10–$${POSITION_SIZE} cap) · 🛑 Daily limit: 30%\n` +
    `🎛 Mode: *${startMode}*\n` +
    `${walletLine}\n` +
    `⏱ Scanning every 15 seconds\n\n` +
    `_/help for all commands_`
  );

  let lastHourly = Date.now();

  setInterval(async () => {
    try { await monitorPositions(); }
    catch(e) { console.error('[MONITOR]', e.message); }
  }, PRICE_CHECK);

  await sleep(7500);

  // Fast queue loop — checks for manual entries every 5 s so dashboard Add Now
  // is processed almost immediately without waiting for the full 15 s scan cycle.
  setInterval(async () => {
    try { await processManualQueue(); }
    catch(e) { console.error('[QUEUE]', e.message); }
  }, 5000);

  setInterval(async () => {
    try {
      scanCount++;
      await scanForEntries();
      if (scanCount % 4 === 0) console.log(`[BOT] Scan #${scanCount}`);
    } catch(e) { console.error('[SCANNER]', e.message); }
  }, SCAN_INTERVAL);

  setInterval(async () => {
    if (Date.now() - lastHourly >= 3600000) {
      lastHourly = Date.now();
      try { await sendHourlySummary(); } catch(e) {}
    }
  }, 60000);

  // Poll for /restart and /status Telegram commands every 30 s
  setInterval(async () => {
    try { await pollTelegramCommands(); } catch(e) {}
  }, 30000);
}

main().catch(e => {
  console.error('[FATAL] Uncaught error in main():', e);
  // Do NOT call process.exit — keep process alive so Fly.io doesn't roll back
  // Try to send Telegram alert, then keep polling
  sendTelegram(`🔴 *BOT FATAL ERROR*\n\`${e.message}\`\n\nProcess staying alive — restart manually if needed.`)
    .catch(() => {});
  setInterval(() => {}, 60000); // keepalive — prevents Node.js from exiting
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function fmtPrice(p) {
  if (!p || isNaN(p)) return '—';
  if (p < 0.000001) return p.toExponential(3);
  if (p < 0.01)     return p.toPrecision(4);
  return p.toFixed(4);
}

// Trade result summary: "💵 Entered $100.00 → Returned $102.40 (+$2.40, +2.4%)"
// Used in every final-close notification so the user can see at a glance
// what they put in and what came back (or didn't).
function fmtTradeResult(size, totalPnl) {
  const returned = size + totalPnl;
  const pct      = size > 0 ? (totalPnl / size * 100) : 0;
  const sign     = totalPnl >= 0 ? '+' : '';
  return `💵 Entered $${size.toFixed(2)} → Returned $${returned.toFixed(2)} (${sign}$${totalPnl.toFixed(2)}, ${sign}${pct.toFixed(1)}%)`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function deleteTelegramMessage(chatId, messageId) {
  if (!TELEGRAM_TOKEN || !chatId || !messageId) return;
  const body = JSON.stringify({ chat_id: chatId, message_id: messageId });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/deleteMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', e => { console.error('[TG-DEL]', e.message); resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT, text,
    parse_mode:'Markdown', disable_web_page_preview:true });
  return new Promise(resolve => {
    const req = https.request({
      hostname:'api.telegram.org',
      path:`/bot${TELEGRAM_TOKEN}/sendMessage`,
      method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},
      timeout:10000,
    }, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d));
    });
    req.on('error', e => { console.error('[TG]',e.message); resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

async function sendTelegramWithButtons(text, inlineKeyboard) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  const body = JSON.stringify({
    chat_id: TELEGRAM_CHAT, text,
    parse_mode: 'Markdown', disable_web_page_preview: true,
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', e => { console.error('[TG]', e.message); resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

async function answerCallbackQuery(callbackQueryId, text = '') {
  if (!TELEGRAM_TOKEN) return;
  const body = JSON.stringify({ callback_query_id: callbackQueryId, text });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/answerCallbackQuery`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', e => { console.error('[TG-CBQ]', e.message); resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

function httpGet(hostname, path, extraHeaders = {}) {
  return new Promise(resolve => {
    const req = https.request({
      hostname, path, method:'GET', timeout:10000,
      headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0', ...extraHeaders},
    }, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({status:res.statusCode,body:d}));
    });
    req.on('error', (e) => { console.error(`[HTTP] Network error → ${hostname}: ${e.message}`); resolve({status:500,body:'{}'}); });
    req.on('timeout', () => { req.destroy(); console.error(`[HTTP] Timeout → ${hostname}`); resolve({status:504,body:'{}'}); });
    req.end();
  });
}
