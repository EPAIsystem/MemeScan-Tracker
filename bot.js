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
const PRICE_HIST_MAX    = 40;   // keep last 40 scan snapshots per coin (~10 min of data at 15s scans)
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
const ANTI_MANIP_AVG_TRADE_FLOOR  = 8;    // global: avg trade must be ≥$8 (kills $0.01–$2 spam; lowered for slow markets)
const ANTI_MANIP_M5_TXNS_MAX      = 200;  // global: >200 txns in 5min = 40/min = bots
const ANTI_MANIP_MC_LIQ_RATIO_MAX        = 30;   // global: mc/liq > 30× = thin pool, easy to manipulate (enforced for UNLOCKED LP)
const ANTI_MANIP_MC_LIQ_RATIO_MAX_LOCKED = 40;   // relaxed when LP is confirmed locked — dev can't drain the pool
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
// ─── DIAGNOSTIC GATE COUNTERS (temporary — remove once root cause identified) ─
const gateStats = { total:0, chain:0, liqFloor:0, price:0, honey:0, txns:0, avgT:0, ratio:0, young:0, dead:0, noAct:0, dex:0, age:0, mom:0, live:0, noMatch:0 };

// ─── DYNAMIC POSITION SIZING ─────────────────────────────────────────────────
// Position scales with liquidity (1% of pool ≈ <1% price impact) and market cap.
// POSITION_SIZE env var is now the MAXIMUM cap — not a fixed amount.
// MC sweet spot ($25k–$200k): fast-moving small caps where small traders make the most.
const POS_FLOOR = 10;   // $10 minimum — below this, fees erase profits

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
const MOMENTUM_REENTRY_STRATEGIES  = new Set([1, 2, 4]); // AM, SC, PUMP SPEC
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
    // ── Entry criteria ──
    minAgeDays: 0.042,  // Nov-12: ≥ 1 hour — anything under 1h is PS territory, not BB
    maxCh24: -5,        // Nov-11: -20→-5 — open to any meaningful pullback, not just big crashes
    minCh24: -85,       // Nov-9: not a dead coin
    maxCh1: 12,         // Nov-9: h1 not already mooned
    minCh1: -8,         // Nov-9: h1 turning; not in freefall
    minM5Ch: 0,         // Nov-10: 1.5→0 — pullback watchlist confirms the bounce; scan detects stabilisation
    minBuyPct: 55,      // Nov-11: 60→55 — relaxed to accommodate pump.fun/PumpSwap ecosystem
    minLiq: 5000,       // Nov-11: 25k→5k — pump.fun/PumpSwap ecosystem has thin pools; RugCheck handles rug risk
    minLiqLocked: 3000, // Nov-11: 15k→3k — relaxed floor for LP-locked coins
    minM5Txns: 5,       // Nov-10: 12→5 — crashed coins have thin volume; 5 confirms it's not dead
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
    minM5Ch: 0.5,        // Nov-11: 1.5→0.5 — subtle positive momentum is a valid signal in pump ecosystem
    minM5Txns: 8,        // Nov-11: 15→8 — pump.fun coins have thinner activity
    minBuyPct: 52,       // Nov-11: 58→52 — marginal buyer edge is enough with RugCheck backing it
    minCh1: -2,          // Nov-11: 0→-2 — allow slight h1 dip as long as m5 is positive
    minLiq: 5000,        // Nov-11: 15k→5k — pump.fun/PumpSwap ecosystem; RugCheck handles rug risk
    minLiqLocked: 3000,  // Nov-11: 10k→3k — relaxed floor for LP-locked coins
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
    minLiq: 3000,        // Nov-11: 8k→3k — pump.fun/PumpSwap ecosystem; RugCheck handles rug risk
    minLiqLocked: 2000,  // Nov-11: 5k→2k — relaxed floor for LP-locked coins
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
    // ── Entry criteria ──
    minAgeDays: 1,       // Nov-12: 3→1 — any coin ≥ 1 day old qualifies as "old recovery"
    minCh24: 2,          // Nov-11: 5→2 — less aggressive recovery signal required
    minCh1: 0.5,         // Nov-10: 1.5→0.5 — ch24≥2% already confirms recovery; 0.5% checks h1 trend intact
    maxCh1: 20,          // Nov-9: tighter spike guard — >20% in 1h on old coin is suspicious
    minBuyPct: 50,       // Nov-11: 58→50 — marginal buyer dominance allowed with RugCheck backing
    minLiq: 10000,       // Nov-11: 25k→10k — open to pump.fun ecosystem; RugCheck handles rug risk
    minLiqLocked: 5000,  // Nov-11: 15k→5k — relaxed floor for LP-locked coins
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
    maxAgeDays: 0.042,  // Nov-12: < 1 hour — strictly new coins; anything older routes to BB/SC/AM/OR
    minLiq: 3000,
    minLiqLocked: 3000,
    minH1Ch: 2,          // Nov-11: 5→2 — h1 just needs to show positive trend, not strongly up
    minM5Ch: -5,         // allow pullback entry — not chasing the top
    maxM5Ch: 4,          // Nov-11: 2→4 — wider pullback window; allows more entry points
    minM5Sells: 1,       // at least one sell — confirms real 2-sided trading
    minBuyPct: 50,       // Nov-11: 55→50 — marginal buyer edge enough for speculative entries
    minM5Txns: 6,        // Nov-11: 10→6 — allow thinner activity
    maxMcLiqRatio: 60,   // more lenient ratio for thin pump pools
    rugCheckMaxRisk: 50, // stricter rug threshold (50 vs standard 60)
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
  if (!globalGatesBypass) {
    if (liq < 3000)  return rej('liqFloor');
  }
  if (price <= 0)  return rej('price');  // always keep — zero price breaks arithmetic
  if (!globalGatesBypass) {
    if (sells24 === 0 && buys24 > 10) return rej('honey'); // honeypot guard

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
    if (!scIsOpen && !s5OpenForYoung && avgTrade !== null && avgTrade < 20) return rej('young');
    if (s5OpenForYoung) {
      // Nov-11: aligned to PS's current thresholds (was 55/10, PS now accepts 50/6)
      if (buyPct < 50) return rej('young');  // S5 minBuyPct (updated)
      if (m5Txns  <  6) return rej('young'); // S5 minM5Txns (updated)
    } else {
      // Nov-11: lowered to match the most lenient strategy thresholds across all open strategies
      // (was 60/25 — far stricter than any strategy's own filter, blocking most PumpSwap young coins)
      if (buyPct < 50)  return rej('young'); // matches OR/PS minBuyPct (50)
      if (m5Txns  <  6) return rej('young'); // matches PS minM5Txns (6, the lowest)
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
      const pass = (ageMinutes >= 60 && ageMinutes < 240 && m5Ch >= 2)
                || (m5Ch >= 3);
      if (!pass) return rej('dead');
    } else if (Math.abs(ch1) < 0.5) {
      const pass = (ageMinutes >= 60 && ageMinutes < 240 && m5Ch >= 2) // young coin pumping
                || (ch24 <= -5 && buyPct >= 50 && liq >= 5000)          // bottom bounce stabilising — Nov-11: liq floor 10k→5k (matches BB minLiq)
                || (m5Ch >= 3);                                           // actively surging now
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
    // it can have a slightly negative m5 as the coin is stabilising. Allow m5Ch ≥ -1%.
    // Strategy 5 (Pump Spec) enters on pullbacks — allow m5Ch down to -5% when s5 is open.
    // All other strategies require m5Ch ≥ -1% (no meaningful decline allowed).
    if (m5Ch !== null && m5Ch < -1) {
      const s5Open = openStrategies.some(st => st.id === 4);
      if (!s5Open || m5Ch < -5) return rej('mom'); // declining too hard — skip
    }

    const liveHist = priceHistory.get(addr) || [];
    if (liveHist.length >= 3) {
      const newest = liveHist[liveHist.length - 1]?.price;
      const older  = liveHist[liveHist.length - 3]?.price; // ~6 seconds ago
      if (newest && older && newest < older * 0.999) return rej('live'); // price declining in live feed
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
    dexId,  // Nov-12: propagate dexId so filterByLpLock gate 3.5 (PumpSwap pass-through) can read it
  };

  // Try each open strategy, return first match with highest confidence
  const matches = [];

  for (const s of openStrategies) {
    let score = 50;
    let match = true;

    if (s.id === 0) {
      // ── BOTTOM BOUNCE — Path A only (Nov-9 overhaul) ────────────────────
      // Nov-11: pump.fun/PumpSwap coins now allowed — all strategies compete freely.
      // BB is ONLY for genuine oversold recovery: coin crashed 20–85%,
      // h1 turning up, m5 actively bouncing NOW with strong buyer conviction.
      if (!strategyFiltersActive) {
        match = true;
      } else {

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
      } // end strategyFiltersActive else
    }

    else if (s.id === 1) {
      // ── ACTIVE MOMENTUM ────────────────────────────────────────────────────
      // Nov-11: pump.fun/PumpSwap coins now allowed — all strategies compete freely.
      if (strategyFiltersActive) {
        if (s.minAgeDays != null && ageDays < s.minAgeDays) { match = false; } // 2h+ only — SC covers 0–24h
        if (s.maxAgeDays != null && ageDays > s.maxAgeDays) { match = false; } // age upper cap (AM has none — applies to any age)
        if (m5Txns < s.minM5Txns)  { match = false; }
        if (m5Ch < s.minM5Ch)      { match = false; } // POSITIVE direction required (was abs)
        if (ch1 < s.minCh1)        { match = false; }
        if (buyPct < s.minBuyPct)  { match = false; }
        if (liq < s.minLiqLocked)  { match = false; } // relaxed floor — strict floor enforced in filterByLpLock for unlocked LP
        // Anti-manipulation: require meaningful avg trade size (from strategy definition)
        if (s.minAvgTrade != null && avgTrade !== null && avgTrade < s.minAvgTrade) { match = false; }
      }
      if (match) {
        score += Math.min(20, m5Txns / 2);         // very active = more confidence
        if (m5Ch > 5)  score += 15; else if (m5Ch > 2) score += 8;
        if (buyPct > 65) score += 15; else if (buyPct > 58) score += 8;
        if (ch1 > 20)  score += 12; else if (ch1 > 8) score += 6;
        if (liq > 30000) score += 8; else if (liq > 15000) score += 4;
        if (volMcap > 1) score += 10; else if (volMcap > 0.4) score += 5;
        // MC sweet spot + avg trade quality
        // NOTE: Range-spike guard removed — with graduated-only gate, high ch1 / modest ch24
        // is EXPECTED for a recently migrated Raydium coin and must not be penalised.
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
      // Age gate: 0–24 hours (recently graduated coins surge post-migration)
      if (strategyFiltersActive) {
        if (s.minAgeDays != null && ageDays < s.minAgeDays) { match = false; } // ≥ 1h — PS takes the sub-1h coins
        if (s.maxAgeDays != null && ageDays > s.maxAgeDays) { match = false; } // over 24h → AM/BB/OR
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
      } else if (strategyFiltersActive) {
        // < 1 hour only — older coins route to BB/SC/AM/OR
        if (s.maxAgeDays != null && ageDays > s.maxAgeDays) { match = false; }
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
// Block re-entry for 6h after SL or rug — prevents the triple-entry bug
// (address → timestamp of SL/rug close)
const recentSLCoins = new Map();
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
let lpLockBypass        = false; // /skiplp toggle  — bypasses filterByLpLock() for diagnostics
let autoEntryPaused     = false; // /pauseentry toggle — signals alert but bot skips auto-entry
let telegramOffset      = 0; // for Telegram command polling

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
      lpOpen:           lpLockBypass,
      stratsSkipped:    !strategyFiltersActive,
      autoEntryPaused:  autoEntryPaused,
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
  const matching = wallets.filter(w => w.chain === chain && w.active !== false);
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
  try {
    const path = `/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`;
    const r = await httpGet('quote-api.jup.ag', path);
    if (r.status !== 200) { console.error('[JUPITER] Quote HTTP', r.status); return null; }
    return JSON.parse(r.body);
  } catch(e) { console.error('[JUPITER] Quote error:', e.message); return null; }
}

async function jupiterGetSwapTx(quote, walletPublicKey) {
  try {
    const body = JSON.stringify({
      quoteResponse: quote,
      userPublicKey: walletPublicKey,
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: 5000, // ~0.000005 SOL tip for faster landing
    });
    const r = await new Promise((resolve) => {
      const req = https.request({
        hostname: 'quote-api.jup.ag',
        path: '/v6/swap',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 15000,
      }, (res) => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', () => resolve({ status: 500, body: '{}' }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 504, body: '{}' }); });
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
    req.on('error',   () => resolve({ status: 500, body: '{}' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 504, body: '{}' }); });
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

    const quote = await jupiterQuote(SOL_MINT, coin.addr, lamports, 150); // 1.5% slippage
    if (!quote) return { txHash: null, executedPrice: coin.price, error: 'Jupiter quote failed' };

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

    const tokensOut = parseFloat(quote.outAmount); // raw units (must divide by decimals later)
    const outDecimals = parseInt(quote.outputDecimals || quote.swapInfo?.outputMint?.decimals || 6, 10);
    const tokenAmount = tokensOut / (10 ** outDecimals);
    console.log(`[REAL] Jupiter: ${solAmount.toFixed(4)} SOL → ${tokenAmount.toLocaleString()} ${coin.symbol}`);

    const swapTx = await jupiterGetSwapTx(quote, keypair.publicKey.toBase58());
    if (!swapTx) return { txHash: null, executedPrice: coin.price, error: 'Jupiter swap TX failed' };

    const sig = await sendViaJitoBundle(swapTx, keypair);
    console.log(`[REAL] ✅ ENTRY TX confirmed (Jito): https://solscan.io/tx/${sig}`);
    const entryImpactPct = parseFloat(quote.priceImpactPct || 0) * 100;
    const jitoTipUsd     = (_jitoTip / 1e9) * solPrice;
    return { txHash: sig, executedPrice: coin.price, tokenAmount, tokenDecimals: outDecimals, entryImpactPct, jitoTipUsd };
  } catch(e) {
    console.error(`[REAL] ENTRY failed for ${coin.symbol}:`, e.message);
    return { txHash: null, executedPrice: coin.price, error: e.message };
  }
}

async function executeRealExit(pos, wallet, exitPrice) {
  if (pos.chain !== 'solana') {
    console.warn(`[REAL] Chain "${pos.chain}" not yet supported. Exit logged as paper.`);
    return { txHash: null, executedPrice: exitPrice, simulated: true };
  }
  if (!SolanaWeb3 || !bs58) return { txHash: null, executedPrice: exitPrice, error: 'Solana SDK not installed' };

  const privKeyStr = process.env[`${wallet.envKey}_PRIVATE_KEY`];
  if (!privKeyStr) {
    console.warn(`[REAL] ⚠️  No private key for ${wallet.label}. Exit NOT executed.`);
    return { txHash: null, executedPrice: exitPrice, error: 'Missing private key' };
  }

  let keypair;
  try { keypair = parseSolanaKeypair(privKeyStr); }
  catch(e) { return { txHash: null, executedPrice: exitPrice, error: e.message }; }

  try {
    // Token amount stored at entry. "remaining" fraction applies for partial exits.
    const remaining   = pos.remaining || 1.0;
    const totalTokens = pos.realTokenAmount || 0; // raw units set at entry
    if (!totalTokens) {
      console.warn(`[REAL] EXIT ${pos.symbol} — no realTokenAmount on position, cannot sell. Logging as paper.`);
      return { txHash: null, executedPrice: exitPrice, simulated: true, error: 'No token amount stored' };
    }
    const tokensToSell = Math.floor(totalTokens * remaining);
    console.log(`[REAL] EXIT ${pos.symbol} | ${tokensToSell} raw tokens (${(remaining*100).toFixed(0)}% of ${totalTokens})`);

    const quote = await jupiterQuote(pos.address, SOL_MINT, tokensToSell, 200); // 2% slippage on sell
    if (!quote) return { txHash: null, executedPrice: exitPrice, error: 'Jupiter exit quote failed' };

    // ── PRICE IMPACT GUARD on exit — warn if selling into thin liquidity ──
    const MAX_EXIT_IMPACT = 0.02; // 2% — warn and log but still exit (must sell)
    const impactExit = parseFloat(quote.priceImpactPct || 0);
    if (impactExit > MAX_EXIT_IMPACT) {
      const impactStr = (impactExit * 100).toFixed(2);
      console.warn(`[REAL] ⚠️  EXIT high impact ${impactStr}% for ${pos.symbol} — proceeding (must exit)`);
      await sendTelegram(
        `⚠️ *HIGH IMPACT EXIT — ${pos.symbol}*\n\n` +
        `Selling into thin liquidity — price impact *${impactStr}%*\n` +
        `Proceeding anyway (position must close).`
      );
    }

    const swapTx = await jupiterGetSwapTx(quote, keypair.publicKey.toBase58());
    if (!swapTx) return { txHash: null, executedPrice: exitPrice, error: 'Jupiter exit swap TX failed' };

    const sig = await sendViaJitoBundle(swapTx, keypair);
    console.log(`[REAL] ✅ EXIT TX confirmed (Jito): https://solscan.io/tx/${sig}`);
    const exitImpactPct = parseFloat(quote.priceImpactPct || 0) * 100;
    const solPriceExit  = await getSolPriceUsd();
    const jitoTipUsd    = (_jitoTip / 1e9) * solPriceExit;
    return { txHash: sig, executedPrice: exitPrice, exitImpactPct, jitoTipUsd };
  } catch(e) {
    console.error(`[REAL] EXIT failed for ${pos.symbol}:`, e.message);
    return { txHash: null, executedPrice: exitPrice, error: e.message };
  }
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
// paper mode only — for real mode, use jitoTipUsd + exitImpactPct from the tx.
function calcExitFeeUsd(pos, rawPrice, fillPrice, fraction) {
  if (!rawPrice || rawPrice <= 0) return 0;
  const frac = fraction != null ? fraction : (pos.remaining || 1);
  // Cost = dollars we lost vs fair value: position_value * (1 - fillPrice/rawPrice)
  return pos.size * frac * Math.max(0, 1 - fillPrice / rawPrice);
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
  const posSize      = calcDynamicPositionSize(coin.liq || 0, coin.mcap || 0, stratCeiling);
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
  } else if (ceiling < dynRec * 0.5 && ceiling < 50) {
    // User's ceiling is too restrictive — entry may not cover fees
    advisoryNote = `⚠️ Set size $${ceiling} is well below the bot's recommended $${dynRec} (liq × 1%). At this size, profits may not cover fees. Suggested: $${dynRec}.`;
  }
  // Surge momentum disabled — surge exit + reinvest removed; capital floor handles profit protection
  const isSurge = false;
  const tradingMode = cfg.tradingMode || 'paper';
  const coinChain  = normaliseChain(coin.chain);
  const wallet     = await selectWalletForChain(coinChain, cfg);

  // Real mode: execute swap
  let realTx = null;
  if (tradingMode === 'real' && wallet) {
    realTx = await executeRealEntry(coin, wallet, posSize);
    // If the on-chain tx failed (no hash), abort entirely — do NOT create a ghost position
    if (!realTx || !realTx.txHash) {
      const reason = realTx?.error || 'Transaction not executed';
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

  // ── INITIAL SL = 7% BELOW ENTRY (Phase 1 buffer) ───────────────────────────
  // Gives the coin room to breathe after entry without triggering on normal pullbacks.
  //   Phase 1: SL = entry × 0.93 (holds until +7% gain — cost = 7% + fees if hit)
  //   Phase 2: SL = entry + 50% × ATH_gain (fires at gain ≥ 7%, applied in monitorPositions)
  //   Phase 3: gap tightens 50→45→40→35%… per +20% ATH move (monitorPositions)
  // Old fixed-% stop (s.slx) is no longer used.
  const initialSLPrice = effectiveEntry * 0.93;

  const pos = {
    symbol: coin.symbol, name: coin.name, address: coin.addr,
    chain: coin.chain, strategyId: s.id, strategyLabel: s.label,
    score: coin.score,
    entryPrice: effectiveEntry,
    rawEntryPrice,    // keep the raw price for reference/display
    liquidityAtEntry, // store so exit slippage cap can use it
    tp1: effectiveEntry * s.tp1x,
    tp2: effectiveEntry * s.tp2x,
    tp3: effectiveEntry * s.tp3x,
    sl:  initialSLPrice,
    currentSL: initialSLPrice,
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
    isManual:        overrides.isManual || false,
    advisoryNote:    advisoryNote,  // non-null = dashboard shows advisory toast on next refresh
    // Overhead resistance — 50% partial exit fires when price reaches this level
    resistancePrice: resistancePrice,
    resistanceHit:   false,
    // Young coin mode flag (kept for reference — no longer drives TP exits)
    youngCoin: (s.id === 1 && (coin.ageMinutes || 0) < 60),
    // Age at entry — reference only
    coinAgeDays: coin.ageDays || 0,
    // Universal progressive trail state — gap % of ATH gain given back (Phase 3)
    trailPct:    null,   // current gap % × 100 (50 → 45 → 40 → 35 … → 10)
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
  };
  await ref.set(pos);
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
  // Remove from cache BEFORE the async Firestore write so a concurrent monitor
  // tick that starts during the await doesn't see this position as still open
  // and fire a second close / duplicate notification.
  if (_posCache) _posCache = _posCache.filter(p => p.id !== id);
  // Always update the position status — this is the critical write
  await db.collection(positions).doc(id).update(closeData);
  // Write history entry — wrapped so a failure doesn't revert the close.
  // Nov-12: added retry + Telegram alert so silent failures are visible.
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

async function updateDailyStats(pnl, isWin, isManual = false, exitFeeUsd = 0) {
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
  await db.collection(stats).doc(today).set(base, { merge: true });
  _statsCache = null; _statsCacheAt = 0; // bust cache so next read gets fresh P&L
}

async function updateDailyStatsEntry(posSize, entryFeeUsd) {
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
          : `🎯 TP: Dynamic (capital recovery → profit trail → 4× halving)\n`;
      const modeHeader = pos.tradingMode === 'real'
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
    // ── Expire ───────────────────────────────────────────────────────────────
    if (now - entry.exitTime > MOMENTUM_REENTRY_WINDOW_MS) {
      console.log(`[MREENTRY] ${entry.symbol} — 30min window expired, removing`);
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

    // ── Track post-exit low (the dip after the SL close) ─────────────────────
    if (price < entry.postExitLow) entry.postExitLow = price;

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
// If paper_config/control.restartDay == true → zero out today's P&L, clear
// in-memory state, resume trading.  Also handles real-mode restart (future).
async function checkDayRestart() {
  try {
    // Use cached config first to avoid a Firestore read every monitor cycle.
    // The cache TTL is 30s, so restart commands are picked up within 30 seconds.
    const data = await getTradingConfig();
    if (!data.restartDay) return false;
    // Invalidate cache so the flag-clear write below is reflected immediately
    _tradingCfg = null; _tradingCfgAt = 0;

    // ── Perform restart ──
    const today = new Date().toISOString().slice(0, 10);
    const { stats: _statsCol2 } = await getCollections();
    const statsSnap = await db.collection(_statsCol2).doc(today).get();
    const prevPnL   = statsSnap.exists ? (statsSnap.data().realizedPnL || 0) : 0;

    // Zero out today's P&L; accumulate total loss across restarts for transparency
    await db.collection(_statsCol2).doc(today).set({
      realizedPnL: 0, autoPnL: 0, manualPnL: 0,
      restartCount:   FieldValue.increment(1),
      cumulativeLoss: FieldValue.increment(prevPnL < 0 ? prevPnL : 0),
      lastRestartAt:  Date.now(),
    }, { merge: true });

    // Clear in-memory state so old coins don't block fresh entries
    enteredToday.clear();
    recentSLCoins.clear();
    alertCooldown.clear();
    momentumReentryWatch.clear();
    dayHaltedToday = false;

    // Clear the flag so we don't restart again immediately
    await db.collection('paper_config').doc('control').update({
      restartDay: false, lastRestartAt: Date.now(),
    });

    const lostStr = prevPnL >= 0
      ? `+$${prevPnL.toFixed(2)}`
      : `-$${Math.abs(prevPnL).toFixed(2)}`;

    await sendTelegram(
      `🔄 *DAY RESTARTED*\n\n` +
      `Session P&L locked: *${lostStr}*\n` +
      `Loss counter reset → $0. Bot scanning again.\n\n` +
      `_Send /restart any time to reset again_`
    );
    console.log(`[BOT] Day restarted — prev session PnL: ${lostStr}`);
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
          `Scan #: ${scanCount}${pausedNote}${entryNote}\n\n` +
          `_/stats · /ping · /setsize · /mode paper|real · /wallets_`
        );
      }

      if (text === '/stats') {
        const stats       = await getDailyStats();
        const grossProfit = stats.grossProfit    || 0;
        const grossLoss   = stats.grossLoss      || 0;
        const fees        = stats.dailyFees      || 0;
        const netRevenue  = grossProfit - grossLoss;   // fees baked into fill-price PnL
        const capital     = stats.capitalDeployed || 0;
        const winRate     = stats.trades > 0 ? ((stats.wins/stats.trades)*100).toFixed(0) : '—';
        await sendTelegram(
          `📈 *DAILY REVENUE REPORT*\n\n` +
          `✅ Gross profit:  +$${grossProfit.toFixed(2)}\n` +
          `❌ Gross loss:    -$${grossLoss.toFixed(2)}\n` +
          `─────────────────────\n` +
          `🏆 Net revenue:   ${netRevenue>=0?'+':''}$${netRevenue.toFixed(2)}\n` +
          `💸 Fees (in P&L): $${fees.toFixed(2)}\n\n` +
          `💼 Capital deployed: $${capital.toFixed(2)}\n` +
          `📊 Trades: ${stats.trades} · Win rate: ${winRate}% (${stats.wins}W/${stats.losses}L)\n` +
          `💰 Running P&L: ${stats.realizedPnL>=0?'+':''}$${stats.realizedPnL.toFixed(2)}`
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
              await closePosition(pos.id, { exitPrice: price, exitReason: 'MANUAL_CLEARALL', pnl });
              await updateDailyStats(exitPnl, exitPnl > 0, !!pos.isManual, 0);
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

      // ── /pauseentry [on|off] — pause/resume auto-entry without stopping monitoring ─
      // When paused: signals fire the full alert (Option A) but bot skips enterPosition.
      // Existing positions, SL, partial closes, and profit withdrawals are unaffected.
      if (text === '/pauseentry' || text === '/pauseentry on' || text === '/pauseentry off') {
        if (text === '/pauseentry on')  autoEntryPaused = true;
        else if (text === '/pauseentry off') autoEntryPaused = false;
        else autoEntryPaused = !autoEntryPaused; // toggle
        await saveBypassFlags();
        if (autoEntryPaused) {
          await sendTelegram(
            `⏸ *AUTO-ENTRY PAUSED*\n\n` +
            `The bot will *not* enter new positions automatically.\n\n` +
            `When a signal fires you'll still get the *full signal alert* so you can decide to enter manually with /enter [address].\n\n` +
            `Monitoring, stop-losses, partial closes and profit withdrawals on existing positions continue normally.\n\n` +
            `Send /pauseentry again (or /pauseentry off) to resume auto-entry.`
          );
        } else {
          await sendTelegram(
            `▶️ *AUTO-ENTRY RESUMED*\n\n` +
            `The bot will now enter positions automatically when signals qualify.\n\n` +
            `Run /status to confirm.`
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
            `_Bot will evaluate with its own scoring (needs ≥ ${MIN_SCORE})_`
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
function recordPriceHistory(addr, price, score) {
  if (!price || price <= 0) return;
  const hist = priceHistory.get(addr) || [];
  hist.push({ price, score, ts: Date.now() });
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

    const result = { lpLocked, riskScore, hasCriticalRisk, ts: Date.now() };
    rugCheckCache.set(addr, result);
    console.log(`[RUGCHECK] ${symbol} (${addr.slice(0,8)}…) — LP ${lpLocked ? 'LOCKED ✅' : 'UNLOCKED ⚠️'}, risk ${riskScore}/100`);
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
// Security filter — RugCheck only (Solana-native, GoPlus removed Nov-11):
//   1. Risk score > maxRiskScore (default 60) → hard block
//   2. LP locked → pass
//   3. pump.fun bonding-curve → pass on risk score alone (≤ 50)
//   3.5. PumpSwap graduated → pass on risk score alone (≤ 40)
//   4. LP unlocked + risk ≤ 40 + strict liq/ratio floors → PASS (no probation)
//   4r. LP unlocked + too risky / thin pool → hard block
//
// EVM chains: fail open (no checker after GoPlus removal).
// Results cached 10 min. Probation coins bust their own cache on recheck.
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

    // ── RugCheck — LP lock + risk score (Solana) ─────────────────────────
    const rc = await checkRugCheck(coin.addr, coin.symbol);

    if (!rc) {
      // RugCheck unavailable — fail open
      console.log(`[RUGCHECK] ⚠️ ${coin.symbol} — RugCheck unavailable, allowing through`);
      lpLockCache.set(coin.addr, { locked: true, ts: Date.now() });
      passed.add(coin.addr);
      continue;
    }

    // ── 1: Risk score gate ──────────────────────────────────────────────
    // Strategy 4 (Pump Spec) uses stricter threshold (50 vs standard 60).
    const maxRiskScore = coin.strategy?.rugCheckMaxRisk ?? 60;
    if (rc.riskScore > maxRiskScore) {
      console.log(`[RUGCHECK] ❌ ${coin.symbol} — risk score ${rc.riskScore}/100 (>${maxRiskScore}), rejected`);
      lpLockCache.set(coin.addr, { locked: false, ts: Date.now() });
      continue;
    }

    // ── 2: LP locked — pass ─────────────────────────────────────────────
    if (rc.lpLocked) {
      console.log(`[RUGCHECK] ✅ ${coin.symbol} — LP locked, risk ${rc.riskScore}/100, PASSED`);
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
      const maxUnlockedPS = 40;
      if (rc.riskScore <= maxUnlockedPS) {
        console.log(`[RUGCHECK] ✅ ${coin.symbol} — PumpSwap graduated, risk ${rc.riskScore}/100, PASSED`);
        lpLockCache.set(coin.addr, { locked: true, ts: Date.now() });
        passed.add(coin.addr);
      } else {
        console.log(`[RUGCHECK] ❌ ${coin.symbol} — PumpSwap risk ${rc.riskScore}/100 > ${maxUnlockedPS}, rejected`);
        lpLockCache.set(coin.addr, { locked: false, ts: Date.now() });
      }
      continue;
    }

    // ── 4: LP NOT locked — pass on risk score alone if floors met, else reject ─
    // Nov-12: removed probation; waiting for LP lock almost never triggered an
    // entry in practice (Raydium meme coins rarely lock within 90 min). Coins
    // that clear risk (≤ 40) + liq + ratio floors pass directly — same logic as
    // gate 3.5 for PumpSwap but now extended to all DEXes.
    const strictLiq       = coin.strategy?.minLiq || Infinity;
    const strictRatio     = ANTI_MANIP_MC_LIQ_RATIO_MAX; // 30×
    const liqOk           = coin.liq >= strictLiq;
    const ratioOk         = (coin.mcLiqRatio || 999) <= strictRatio;
    const maxUnlockedRisk = 40;

    if (rc.riskScore > maxUnlockedRisk) {
      console.log(`[RUGCHECK] ❌ ${coin.symbol} — LP unlocked, risk ${rc.riskScore}/100 (>${maxUnlockedRisk}), rejected`);
      lpLockCache.set(coin.addr, { locked: false, ts: Date.now() });
    } else if (!liqOk) {
      console.log(`[RUGCHECK] ❌ ${coin.symbol} — LP unlocked + liq $${coin.liq.toFixed(0)} < $${strictLiq} strict floor, rejected`);
      lpLockCache.set(coin.addr, { locked: false, ts: Date.now() });
    } else if (!ratioOk) {
      console.log(`[RUGCHECK] ❌ ${coin.symbol} — LP unlocked + MC/Liq ${(coin.mcLiqRatio||0).toFixed(1)}× > ${strictRatio}×, rejected`);
      lpLockCache.set(coin.addr, { locked: false, ts: Date.now() });
    } else {
      // Risk ≤ 40, liq OK, ratio OK — pass without requiring LP lock
      console.log(`[RUGCHECK] ✅ ${coin.symbol} — LP unlocked but risk ${rc.riskScore}/100 ≤ ${maxUnlockedRisk}, liq $${coin.liq.toFixed(0)}, PASSED`);
      lpLockCache.set(coin.addr, { locked: true, ts: Date.now() });
      passed.add(coin.addr);
    }
    await sleep(200); // pace RugCheck calls
  }

  return matches.filter(c => passed.has(c.addr));
}

async function monitorPositions() {
  if (!(await isBotRunning())) return;

  // Check for day-restart and add-funds requests before anything else
  await checkDayRestart();
  const cfg = await getTradingConfig();
  await checkAddFunds(cfg);

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
    await closePosition(pos.id, { exitPrice: exitFillPriceManual, exitReason: 'MANUAL_CLOSE', pnl });
    await updateDailyStats(exitPnl, exitPnl > 0, isManual, calcExitFeeUsd(pos, price, exitFillPriceManual, pos.remaining));
    enteredToday.delete(pos.address);
    await sendTelegram(
      `🚫 *MANUAL CLOSE*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
      `${fmtTradeResult(pos.size, pnl)}\n` +
      `📥 Exit price: $${fmtPrice(exitFillPriceManual)}\n🔗 [Chart](${pos.dexUrl})`
    );
  }

  // Refresh list after manual closes
  const remaining_positions = await getOpenPositions();
  if (!remaining_positions.length) return;

  const stats = await getDailyStats();
  if (stats.realizedPnL / stats.startBalance <= DAILY_LOSS_LIMIT) {
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
        await closePosition(pos.id, { exitPrice: exitFillPrice, exitReason: 'DAILY_LIMIT', pnl });
        await updateDailyStats(exitPnl, exitPnl > 0, !!pos.isManual, calcExitFeeUsd(pos, price, exitFillPrice, pos.remaining));
        await sendTelegram(`🚨 *DAILY LOSS LIMIT*\n*${pos.symbol}* ${pos.strategyLabel}\n${fmtTradeResult(pos.size, pnl)}`);
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
      await closePosition(pos.id, { exitPrice: exitFillPriceExp, exitReason: 'EXPIRED', pnl });
      await updateDailyStats(exitPnl, exitPnl > 0, isManual, calcExitFeeUsd(pos, price, exitFillPriceExp, pos.remaining));
      await sendTelegram(`⏰ *EXPIRED* — *${pos.symbol}* ${pos.strategyLabel}\n${fmtTradeResult(pos.size, pnl)}\n📥 Exit: $${fmtPrice(exitFillPriceExp)}\n🔗 [Chart](${pos.dexUrl})`);
      enteredToday.delete(pos.address);
      continue;
    }

    const { price, liq: currentLiq } = await getCurrentPriceAndLiq(pos.address, pos.chain);
    if (!price || price <= 0) continue;

    // ── LIQUIDITY DRAIN EXIT ──────────────────────────────────────────────────
    // If pool liquidity drops below $2,500 we can no longer exit at any real price.
    // Close immediately — before all other checks — to protect remaining capital.
    if (currentLiq !== null && currentLiq < 2500 && !closingNow.has(pos.id)) {
      closingNow.add(pos.id);
      try {
        const exitFillPrice = pos.tradingMode === 'paper'
          ? simulateFillPrice(price, pos.size * pos.remaining, currentLiq, false)
          : price;
        const exitPnL = (exitFillPrice - pos.entryPrice) / pos.entryPrice * pos.size * pos.remaining;
        const pnl     = (pos.pnl || 0) + exitPnL;
        await closePosition(pos.id, { exitPrice: exitFillPrice, exitReason: 'LIQ_DRAINED', pnl });
        await updateDailyStats(exitPnL, exitPnL > 0, !!pos.isManual, calcExitFeeUsd(pos, price, exitFillPrice, pos.remaining));
        await sendTelegram(
          `⚠️ *LIQ DRAINED — EMERGENCY EXIT*\n\n` +
          `*${pos.symbol}* ${pos.strategyLabel}\n` +
          `💧 Liquidity collapsed to $${currentLiq < 1 ? '<1' : currentLiq.toFixed(0)} — rug pull risk\n` +
          `📥 Entry: $${fmtPrice(pos.entryPrice)} → Exit: $${fmtPrice(exitFillPrice)}\n` +
          `${fmtTradeResult(pos.size, pnl)}\n🔗 [Chart](${pos.dexUrl})`
        );
        enteredToday.delete(pos.address);
        console.log(`[BOT] LIQ_DRAINED ${pos.symbol}: liq=$${currentLiq?.toFixed(0)}`);
      } catch(e) {
        console.error(`[BOT] LIQ_DRAINED close failed for ${pos.symbol}:`, e);
        closingNow.delete(pos.id);
      }
      continue;
    }

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
                await closePosition(rugPos.id, { exitPrice: rugFill, exitReason: 'RUG_EMERGENCY', pnl: rugPnL });
                await updateDailyStats(rugPnL, false, rugPos.isManual || false,
                  calcExitFeeUsd(rugPos, price, rugFill, rugPos.remaining));
                await sendTelegram(
                  `🚨 *RUG EMERGENCY EXIT*\n\n` +
                  `*${rugPos.symbol}* ${rugPos.strategyLabel}\n` +
                  `📉 *${(drop*100).toFixed(0)}% crash in ${Math.round((now - refEntry.ts)/1000)}s* (signal #${sigCount})\n` +
                  `📥 Entry: $${fmtPrice(rugPos.entryPrice)} → Exit: $${fmtPrice(rugFill)}\n` +
                  `${fmtTradeResult(rugPos.size, rugPnL)}\n🔗 [Chart](${rugPos.dexUrl})`
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
                  calcExitFeeUsd(pos, price, rugFill, capFrac));
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
    const lastStored = pos.currentPrice || 0;
    if (!lastStored || Math.abs(price - lastStored) / lastStored > 0.005) {
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
            await closePosition(pos.id, { exitPrice: exitFillPrice, exitReason: 'SURGE_STALE_PROFIT', pnl });
            await updateDailyStats(exitPnl, true, isManual, calcExitFeeUsd(pos, price, exitFillPrice, pos.remaining));
            enteredToday.delete(pos.address);
            await sendTelegram(
              `⏱ *SURGE FADED — QUICK EXIT*\n\n` +
              `*${pos.symbol}* ${pos.strategyLabel}\n` +
              `📊 Held ${Math.round(ageMs/60000)}min — surge didn't continue\n` +
              `📥 Entry: $${fmtPrice(pos.entryPrice)} → Exit: $${fmtPrice(exitFillPrice)}\n` +
              `💰 P&L: *+$${pnl.toFixed(2)}* (+${gainPct.toFixed(1)}%) | Slot freed\n🔗 [Chart](${pos.dexUrl})`
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
            await closePosition(pos.id, { exitPrice: exitFillPrice, exitReason: 'SURGE_STALE_LOSS', pnl });
            await updateDailyStats(exitPnl, false, isManual, calcExitFeeUsd(pos, price, exitFillPrice, pos.remaining));
            // Loss exit — keep in enteredToday (blocked for the rest of the day)
            await sendTelegram(
              `⏱ *SURGE STALE — EXIT WITH LOSS*\n\n` +
              `*${pos.symbol}* ${pos.strategyLabel}\n` +
              `📉 ${gainPct.toFixed(1)}% after ${Math.round(ageMs/60000)}min — no recovery\n` +
              `📥 Entry: $${fmtPrice(pos.entryPrice)} → Exit: $${fmtPrice(exitFillPrice)}\n` +
              `💸 P&L: *$${pnl.toFixed(2)}* | Slot freed for new surges\n🔗 [Chart](${pos.dexUrl})`
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
                await closePosition(pos.id, { exitPrice: exitFillPrice, exitReason: 'RANGE_EXIT', pnl });
                await updateDailyStats(exitPnl, true, isManual, calcExitFeeUsd(pos, price, exitFillPrice, pos.remaining));
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
                  `👀 Watching for re-entry near $${fmtPrice(rangeLow)}\n🔗 [Chart](${pos.dexUrl})`
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
    // exit immediately before it goes to near-zero
    if (currentPeak > pos.entryPrice * 1.15 && price < currentPeak * 0.60) {
      // Guard against concurrent monitor ticks closing the same position twice
      if (closingNow.has(pos.id)) continue;
      closingNow.add(pos.id);
      try {
        const exitPnl = fillGain * pos.size * pos.remaining;
        const pnl     = (pos.pnl || 0) + exitPnl;  // total including any earlier partial exits
        await closePosition(pos.id, { exitPrice: exitFillPrice, exitReason: 'RUG_DETECTED', pnl });
        await updateDailyStats(exitPnl, exitPnl > 0, isManual, calcExitFeeUsd(pos, price, exitFillPrice, pos.remaining));
        recentSLCoins.set(pos.address, Date.now()); // block re-entry for 6h
        const dropPct = ((price / currentPeak - 1) * 100).toFixed(0);
        await sendTelegram(
          `⚠️ *RUG DETECTED — EMERGENCY EXIT*\n\n` +
          `*${pos.symbol}* ${pos.strategyLabel}\n` +
          `📉 Dropped *${dropPct}%* from peak in one tick\n` +
          `📥 Entry: $${fmtPrice(pos.entryPrice)} → Exit: $${fmtPrice(exitFillPrice)}\n` +
          `${fmtTradeResult(pos.size, pnl)}\n🔗 [Chart](${pos.dexUrl})`
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
        await closePosition(pos.id, { exitPrice: exitFillPrice, exitReason: 'STOP_LOSS', pnl });
        await updateDailyStats(exitPnl, false, isManual, calcExitFeeUsd(pos, price, exitFillPrice, pos.remaining));
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
          // Record structural low from recent price history at time of exit
          const hist         = priceHistory.get(pos.address) || [];
          const recentPrices = hist.slice(-20).map(h => h.price).filter(p => p > 0);
          const snapshotLow  = recentPrices.length > 0
            ? Math.min(...recentPrices)
            : pos.entryPrice;
          momentumReentryWatch.set(pos.address, {
            symbol: pos.symbol, strategyId: pos.strategyId, strategyLabel: pos.strategyLabel,
            dexUrl: pos.dexUrl, chain: pos.chain, liq: pos.liq || 0, mcap: pos.mcap || 0,
            score: pos.botScore || 60, ageMinutes: pos.ageMinutes || 60,
            snapshotLow,
            postExitLow: exitFillPrice, // tracks lowest price seen after exit
            exitPrice: exitFillPrice,
            exitTime: Date.now(),
            pnlPct,
          });
          console.log(`[MREENTRY] ${pos.symbol} — watching for higher-low re-entry | snapshotLow:$${fmtPrice(snapshotLow)} exitPrice:$${fmtPrice(exitFillPrice)} pnl:${(pnlPct*100).toFixed(1)}%`);
        }
        await sendTelegram(
          `🛑 *STOP LOSS HIT*\n\n` +
          `*${pos.symbol}* ${pos.strategyLabel}\n` +
          `📥 Entry: $${fmtPrice(pos.entryPrice)} → Exit: $${fmtPrice(exitFillPrice)}\n` +
          `🛑 SL: $${fmtPrice(pos.currentSL)} | Trail: ${pos.trailPct != null ? pos.trailPct : '—'}%\n` +
          `${fmtTradeResult(pos.size, pnl)}\n🔗 [Chart](${pos.dexUrl})`
        );
      } finally {
        closingNow.delete(pos.id);
      }
      continue;
    }

    // ══════════════════════════════════════════════════════════════════════
    // ── CAPITAL WITHDRAWAL (+100% gain — universal all strategies) ─────────
    // Sell the minimum fraction needed to recover original capital ($pos.size).
    // Triggers at +100% for all coins. After this, trailing SL rides the profit.
    // ══════════════════════════════════════════════════════════════════════
    if (!pos.capitalWithdrawn) {
      const capThreshold = 0.50; // +50% gain — recover original capital at first profit milestone
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
          await updatePosition(pos.id, capUpdates);
          await updateDailyStats(partPnL, true, isManual, calcExitFeeUsd(pos, price, exitFillPrice, capitalFrac));
          Object.assign(pos, capUpdates);
          alertMsg = `🛡️ *CAPITAL RECOVERED*\n\n` +
            `*${pos.symbol}* ${pos.strategyLabel}\n` +
            `📥 Entry: $${fmtPrice(pos.entryPrice)} | Trigger: +50% (house money)\n` +
            `💰 Sold ${(capitalFrac * 100).toFixed(1)}% → recovered $${newRecovered.toFixed(2)}\n` +
            `🎯 ${(newRemaining * 100).toFixed(1)}% remains — 5× $${((pos.originalPositionSize || pos.size) * 0.20).toFixed(0)} profit withdrawals ahead\n` +
            `🔗 [Chart](${pos.dexUrl})`;
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
    if (pos.capitalWithdrawn && !pos.isMoonBag && (pos.withdrawalCount || 0) < 5
        && pos.remaining > 0.01 && !closingNow.has(pos.id)) {
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
          await updatePosition(pos.id, wUpdates);
          await updateDailyStats(partPnL, true, isManual, calcExitFeeUsd(pos, price, wFill, closeRatio));
          Object.assign(pos, wUpdates);
          await sendTelegram(
            `💰 *PROFIT WITHDRAWAL ${newCount}/5*\n\n` +
            `*${pos.symbol}* ${pos.strategyLabel}\n` +
            `📥 Entry: $${fmtPrice(pos.entryPrice)} | Now: +${gainPct.toFixed(1)}%\n` +
            `💸 Sold ${(closeRatio*100).toFixed(1)}% → locked *$${partPnL.toFixed(2)}*\n` +
            `🎯 ${(newRemaining*100).toFixed(1)}% remains${toMoonBag ? '\n🌕 *MOON BAG MODE — 20% trailing SL from ATH*' : ` — next at $${fmtPrice(price * 1.50)}`}\n` +
            `🔗 [Chart](${pos.dexUrl})`
          );
          console.log(`[BOT] PROFIT_WITHDRAWAL ${newCount}/5 ${pos.symbol}: +${gainPct.toFixed(1)}%, sold ${(closeRatio*100).toFixed(1)}%, locked $${partPnL.toFixed(2)}`);
        }
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // ── STRATEGY 5 — PROFIT HALVING at 4× entry (300% gain) ─────────────
    // After capital recovery, sell 50% of remaining at 4× — locks substantial
    // profit while letting the other 50% ride the -10% floor trail to max upside.
    // Fires once (s5ProfitHalved flag prevents repeat).
    // ══════════════════════════════════════════════════════════════════════
    if (pos.strategyId === 4 && pos.capitalWithdrawn && !pos.s5ProfitHalved
        && gain >= 3.0 && pos.remaining > 0.01 && !closingNow.has(pos.id)) {
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
      await updatePosition(pos.id, halvUpdates);
      await updateDailyStats(partPnL, true, isManual, calcExitFeeUsd(pos, price, halveExit, amountSold));
      Object.assign(pos, halvUpdates);
      await sendTelegram(
        `📤 *PROFIT HALVED — LOCKED*\n\n` +
        `*${pos.symbol}* ${pos.strategyLabel}\n` +
        `📥 Entry: $${fmtPrice(pos.entryPrice)} | Now: 4× (+${gainPct.toFixed(0)}%)\n` +
        `💰 Sold 50% → $${proceeds.toFixed(2)} locked\n` +
        `🎯 ${(newRemaining * 100).toFixed(1)}% remains — riding −10% trail\n` +
        `🔗 [Chart](${pos.dexUrl})`
      );
      console.log(`[BOT] S5_PROFIT_HALVED ${pos.symbol}: +${gainPct.toFixed(0)}%, locked $${proceeds.toFixed(2)}, ${(newRemaining*100).toFixed(1)}% remains`);
    }

    // ── RESISTANCE EXIT — 50% partial at estimated overhead resistance ─────────
    // Computed at entry from h1/h6/h24 DexScreener data. Fires once per position.
    // Takes 50% — locks profit at the first overhead wall, lets rest ride with SL/trail.
    if (pos.resistancePrice && !pos.resistanceHit && price >= pos.resistancePrice
        && !closingNow.has(pos.id) && pos.remaining > 0.05) {
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
      await updatePosition(pos.id, resistUpdates);
      await updateDailyStats(partPnL, true, isManual, calcExitFeeUsd(pos, price, exitFillPrice, amountSold));
      Object.assign(pos, resistUpdates);
      await sendTelegram(
        `🧱 *RESISTANCE — PARTIAL EXIT*\n\n` +
        `*${pos.symbol}* ${pos.strategyLabel}\n` +
        `📐 Resistance hit at $${fmtPrice(pos.resistancePrice)}\n` +
        `📥 Entry: $${fmtPrice(pos.entryPrice)} → Exit: $${fmtPrice(exitFillPrice)}\n` +
        `💰 P&L (${(exitFrac*100).toFixed(0)}%): *${partPnL >= 0 ? '+' : ''}$${partPnL.toFixed(2)}*\n` +
        `📊 ${(newRemaining * 100).toFixed(0)}% remains — riding with SL & trail\n` +
        `🔗 [Chart](${pos.dexUrl})`
      );
      console.log(`[BOT] RESISTANCE_EXIT ${pos.symbol}: hit $${fmtPrice(pos.resistancePrice)}, pnL +$${partPnL.toFixed(2)}`);
    }

    // ── TP EXITS REMOVED ─────────────────────────────────────────────────────
    // All TP exits replaced by universal trailing SL.
    // Capital is recovered at +100% via CAPITAL WITHDRAWAL above.
    // Everything else rides via progressive trailing SL below.
    // ─────────────────────────────────────────────────────────────────────────

    // ── PHASE 2 CAPITAL FLOOR — fires at gain ≥ 7% ──────────────────────────
    // SL = entry + 50% × (ATH − entry). Covers gains 7–20%.
    // At first fire (+7% ATH): SL = entry × 1.035 — smooth step up from the -7% buffer.
    // Phase 3 (progressive tightening) takes over above 20% — both run; Phase 3 wins.
    if (!pos.isMoonBag && gain >= 0.07) {
      const profitLockSL = pos.entryPrice + 0.50 * (currentPeak - pos.entryPrice);
      if (profitLockSL > (updates.currentSL ?? pos.currentSL) * 1.005) {
        updates.currentSL      = profitLockSL;
        updates.trailingActive = true;
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // ── PHASE 3 PROGRESSIVE TRAILING SL ──────────────────────────────────
    // Activates at +20% gain (Phase 2 covers 0–20%; both run, Phase 3 wins).
    //   stepsAbove20 = floor((ATHGain − 20%) / 20%)   → 0 at +20%, 1 at +40%…
    //   gapPct       = max(10%, 50% − steps × 5%)      → 50%→45%→40%→…→10%
    //   SL           = entry + (1 − gapPct) × (ATH − entry)
    //   SL never below entryPrice (zero-loss). Ratchet: only rises.
    // Moon bag: flat 20% below ATH — SL = ATH × 0.80. Never comes down.
    // ══════════════════════════════════════════════════════════════════════
    if (gainPct > 0) {
      let newSL;

      if (pos.isMoonBag) {
        // ── MOON BAG: flat 20% trailing from ATH ─────────────────────────
        // SL = ATH × 0.80 — rises with ATH, never comes down (ratchet).
        newSL = currentPeak * 0.80;

      } else if (gainPct >= 20) {
        // ── PHASE 3: progressive trail starting at +20% gain ─────────────
        const ATH     = currentPeak;
        const ATHGain = (ATH - pos.entryPrice) / pos.entryPrice; // e.g. 0.40 at +40%
        const steps   = Math.max(0, Math.floor((ATHGain - 0.20) / 0.20)); // 0=at20%, 1=at40%…
        const gapPct  = Math.max(0.10, 0.50 - steps * 0.05);              // 50%→45%→…→10%

        // Persist gap state; notify when gap tightens
        const prevGap = pos.trailPct != null ? pos.trailPct / 100 : 0.50;
        if (gapPct !== prevGap) {
          updates.trailPct    = gapPct * 100;   // stored as 50/45/40… for readability
          updates.tightenBase = ATH;
          pos.trailPct        = gapPct * 100;
          pos.tightenBase     = ATH;
          if (gapPct < prevGap) {
            sendTelegram(
              `📐 *SL TIGHTENED — ${pos.symbol}*\n` +
              `Gap: ${(prevGap*100).toFixed(0)}% → *${(gapPct*100).toFixed(0)}%* | Floor: 10%\n` +
              `ATH: $${fmtPrice(ATH)} | Gain: +${gainPct.toFixed(1)}%\n🔗 [Chart](${pos.dexUrl})`
            ).catch(() => {});
          }
        }

        // SL = entry + (1 − gapPct) × (ATH − entry)
        newSL = pos.entryPrice + (1 - gapPct) * (ATH - pos.entryPrice);
        newSL = Math.max(pos.entryPrice, newSL); // zero-loss floor
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
  if (dayHaltedToday) {
    await checkDayRestart(); // check if user sent /restart
    return;
  }
  const positions = await getVisiblePositions();
  if (positions.length >= MAX_POSITIONS) return;

  const vacantSlots = MAX_POSITIONS - positions.length;

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

      if (result.score >= effectiveThreshold) {
        if (trendCount > 0) result._trendingPlatforms = trendCount; // attach badge for Telegram
        // Record price snapshot for trend/rebound tracking
        const price = parseFloat(pair.priceUsd || 0);
        recordPriceHistory(result.addr, price, result.score);
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
      !strategyFiltersActive ? 'STRATS BYPASSED' : '',
      lpLockBypass           ? 'LP BYPASSED'     : '',
    ].filter(Boolean).join(' + ');
    const bypassPrefix = bypassNote ? ` [${bypassNote}]` : '';
    console.log(`[SCAN-DIAG]${bypassPrefix} dex:${g.dex} mom:${g.mom} dead:${g.dead} young:${g.young} ratio:${g.ratio} avgT:${g.avgT} noAct:${g.noAct} noMatch:${g.noMatch} | honey:${g.honey} txns:${g.txns} chain:${g.chain} liqFloor:${g.liqFloor} price:${g.price} age:${g.age} live:${g.live} | TOTAL:${g.total}`);
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
    if (coin.score >= 85) return true; // always trust high-confidence signals
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
    await sendTelegram(
      `🔍 *Scan #${scanCount}*${paused}${halted}\n` +
      `Mode: *${mode}* · Open positions: ${openPositions.length}/${MAX_POSITIONS}\n` +
      `${candidates.length} candidates → ${matches.length} matched → ${lockedMatches.length} LP OK → ${qualityMatches.length} quality\n` +
      `${nearMissCount} near-misses (score ${MIN_SCORE - 8}-${scoreThreshold - 1})` +
      (globalGatesBypass || lpLockBypass || !strategyFiltersActive
        ? `\n\n🔓 *OPEN MODE ACTIVE*` +
          (globalGatesBypass      ? `\n⚠️ Global gates: BYPASSED (/skipgates to restore)`  : '') +
          (lpLockBypass           ? `\n⚠️ LP/RugCheck: BYPASSED (/skiplp to restore)`       : '') +
          (!strategyFiltersActive ? `\n⚠️ Strategy filters: OFF (/skipstrats to restore)`   : '') +
          `\n_/openmode to restore all at once_`
        : '')
    ).catch(() => {});
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

  for (const coin of qualityMatches) {
    if (positions.length >= MAX_POSITIONS) break;
    if (usedThisScan.has(coin.addr)) continue;
    // Entry cooldown: only blocks when NOT paused (paused path uses its own cooldown)
    const last = alertCooldown.get(coin.addr) || 0;
    if (!autoEntryPaused && Date.now() - last < 30 * 60 * 1000) continue;
    // Pause-alert cooldown: suppress repeat signals while paused (separate from entry cooldown)
    const lastPaused = pausedAlertCooldown.get(coin.addr) || 0;
    if (autoEntryPaused && Date.now() - lastPaused < 30 * 60 * 1000) continue;
    // Check slot still available (may have been filled earlier in this loop)
    if (slotCount[coin.strategy.id] >= coin.strategy.maxSlots) continue;

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
          if (posInRange > 0.80) {
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
          : `🎯 TP: Dynamic (capital recovery → profit trail → 4× halving)\n`;
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

    // ── If auto-entry is paused: send full signal alert but skip entering ─────────
    if (autoEntryPaused) {
      pausedAlertCooldown.set(coin.addr, Date.now()); // pause-only cooldown — never touches entry cooldown
      usedThisScan.add(coin.addr);
      await sendTelegram(
        `⏸ *SIGNAL — AUTO-ENTRY PAUSED*\n\n` +
        `*${coin.symbol}* — ${coin.name}\n` +
        `${s.label} · Score: *${coin.score}/100*\n` +
        `${pumpBadge}` +
        `${trendBadge}` +
        `${pullbackBadge}` +
        `${explosiveBadge}` +
        `${rangeReentryBadge}` +
        `💡 ${s.desc}\n\n` +
        `💵 Price now: $${fmtPrice(coin.price)}\n` +
        `📊 Buy%: ${coin.buyPct.toFixed(0)}% | Liq: $${(coin.liq/1000).toFixed(0)}k\n` +
        `📈 Age: ${ageLabel} | m5: ${coin.m5Ch>0?'+':''}${coin.m5Ch.toFixed(1)}% | h1: ${coin.ch1!=null?(coin.ch1>0?'+':'')+coin.ch1.toFixed(1)+'%':'<1h'}\n\n` +
        tpInfo +
        `\`${coin.addr}\`\n🔗 [Chart](${coin.dexUrl})\n\n` +
        `_Enter manually: /enter ${coin.addr}_\n` +
        `_Resume auto-entry: /pauseentry off_`
      );
      console.log(`[BOT] ENTRY PAUSED — signal fired for ${coin.symbol} (${s.label}) but auto-entry is off`);
      continue;
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

    const modeHeader = pos.tradingMode === 'real'
      ? `💰 *BOT ENTERED — REAL TRADE*`
      : `✅ *BOT ENTERED — PAPER TRADE*`;
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
    `*Slots:*\n${slotLines}`
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
  globalGatesBypass     = !!startCfg.gatesOpen;
  lpLockBypass          = !!startCfg.lpOpen;
  strategyFiltersActive = !startCfg.stratsSkipped; // inverted: true = filters on
  autoEntryPaused       = !!startCfg.autoEntryPaused;
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
    req.on('error', () => resolve({status:500,body:'{}'}));
    req.on('timeout', () => { req.destroy(); resolve({status:504,body:'{}'}); });
    req.end();
  });
}
