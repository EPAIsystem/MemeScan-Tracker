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
const SURGE_RESERVED  = 5;   // last 5 slots reserved for Surge Catch (id 2) only
const MIN_SCORE       = 35;  // minimum entry score — wider net; no upper cap (80, 90, 100 all pass)
const DAILY_LOSS_LIMIT= -0.30;
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
// DexScreener chain ID → GoPlus numeric / named chain ID
const GOPLUS_CHAIN_MAP = {
  solana: 'solana', ethereum: '1', eth: '1',
  bsc: '56', base: '8453', polygon: '137',
  arbitrum: '42161', avalanche: '43114', optimism: '10',
};
const lpLockCache = new Map();   // addr → { locked: bool, ts: number }
const LP_LOCK_TTL = 30 * 60 * 1000; // 30-min cache — GoPlus data changes rarely

// ─── WATCHING SNAPSHOT (for /watching command) ────────────────────────────────
let watchingCoinsSnapshot = []; // updated each scan; holds near-miss coins for on-demand reporting

// ─── PRICE HISTORY TRACKER ────────────────────────────────────────────────────
const priceHistory = new Map(); // addr → [{price, score, ts}, ...]
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
const SURGE_WATCH_EXPIRY_MS = 5 * 60 * 1000;  // 5 min max watch window — more time to confirm pullback/bounce cycle
const SURGE_BUY_RATE_MIN    = 8;        // ≥8 buys/min = confirmed real surge (m5Buys/5)
const SURGE_CONFIRM_MIN_MS  = 60000;    // must watch ≥1 min before buy-rate entry fires
const SURGE_AVG_TRADE_MIN   = 25;       // avg trade ≥$25 — young surging coins trade smaller; still above $20 anti-manip floor

// ─── ANTI-MANIPULATION THRESHOLDS ────────────────────────────────────────────
// Applied globally in detectStrategy() before any strategy-specific scoring.
// Catches bot farms (micro-trade spam), thin-pool manipulation, and wash trading.
const ANTI_MANIP_AVG_TRADE_FLOOR  = 15;   // global: avg trade must be ≥$15 (kills $0.01–$2 spam)
const ANTI_MANIP_M5_TXNS_MAX      = 200;  // global: >200 txns in 5min = 40/min = bots
const ANTI_MANIP_MC_LIQ_RATIO_MAX = 30;   // global: mc/liq > 30× = thin pool, easy to manipulate
const ANTI_MANIP_SC_AVG_TRADE     = 20;   // Surge Catch: young coins trade smaller ($20 floor)
const ANTI_MANIP_SC_TXNS_MAX      = 150;  // Surge Catch only: 30/min ceiling
const ANTI_MANIP_SC_MC_LIQ_MAX    = 30;   // Surge Catch: thin pools normal for young surges

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
    desc: 'Oversold token reversing from its bottom',
    // ── Entry criteria ──
    maxCh24: -10,       // was falling — 24h must be negative (e.g. -10% to -90%)
    minCh24: -92,
    maxCh1: 5,          // h1 not still crashing (< +5% = hasn't mooned yet)
    minCh1: 0,          // h1 must be positive — ascending recovery confirmed
    minCh6: -50,        // h6 allowed down to -50% — h1 + m5 confirm the actual turn
    minM5Ch: -0.5,      // m5 stabilising or turning green
    minBuyPct: 55,      // buyers coming in
    minLiq: 15000,
    minM5Txns: 8,       // real bounce needs real tx flow, not a single spike
    // ── TP / SL (standard 3-step) ──
    tp1x: 1.25, tp2x: 1.55, tp3x: 2.10,
    slx: 0.87,
    initialTrailPct: 13,
  },
  {
    id: 1,
    label: '⚡ ACTIVE MOMENTUM',
    maxSlots: 20, // unlimited — competes openly for global slots with id 0 and id 3
    desc: 'Price ticking every 5-15 min — strong live activity',
    // ── Entry criteria ──
    minM5Txns: 15,       // busy last 5 min
    minM5Ch: 1.0,        // at least +1% in last 5 min — MUST be going UP (was abs check)
    minCh1: 3,           // positive h1 trend
    minBuyPct: 55,
    minLiq: 8000,
    // No age cap — any coin with strong active momentum qualifies
    // ── TP / SL (partial profit — sell in bits) ──
    tp1x: 1.50, tp2x: 2.50, tp3x: 5.00,
    slx: 0.80,
    initialTrailPct: 20,
    usePartialProfit: true,  // stage-based selling like old Alpha
  },
  {
    id: 2,
    label: '🚀 SURGE CATCH',
    maxSlots: 20, // competes for all global slots — last 5 reserved exclusively via SURGE_RESERVED logic
    desc: 'Any token actively surging RIGHT NOW — catch it mid-flight, not after',
    // ── Entry criteria — use m5 as primary signal, not h1 ──
    // h1 is a lagging indicator — the surge may already be over by then
    // m5 catches it while it's still happening
    minM5Ch: 3,          // up 3%+ in last 5 min — actively surging NOW
    minM5Txns: 20,       // very high activity in last 5 min
    minCh1: 3,           // h1 positive (confirming uptrend, not requiring 40%)
    minBuyPct: 58,       // buyers still in control
    minLiq: 4000,        // low bar — new coins surge fast
    // No age limit — that's the point
    // ── TP / SL (quick first profit, trail the rest) ──
    tp1x: 1.25, tp2x: 1.80, tp3x: 3.50,
    slx: 0.82,
    initialTrailPct: 18,
    usePartialProfit: true,  // take bits on the way up
  },
  {
    id: 3,
    label: '📈 OLD RECOVERY',
    maxSlots: 20, // unlimited — competes openly for global slots with id 0 and id 1
    desc: 'Established coin climbing back steadily',
    // ── Entry criteria ──
    minAgeDays: 15,
    minCh24: 3,          // positive 24h
    minCh1: 0.5,         // positive h1 (still climbing)
    minCh6: 0,           // h6 positive — sustained momentum (not noise)
    minBuyPct: 50,
    minLiq: 50000,       // realistic floor for established coins
    minBuys24: 35,       // real buy activity without over-restricting
    maxCh1: 30,          // not a sudden spike — steady recovery
    minAvgTrade: 20,     // real buyers filter — lowered to match real market behaviour
    // ── TP / SL (conservative) ──
    tp1x: 1.12, tp2x: 1.30, tp3x: 1.65,
    slx: 0.92,
    initialTrailPct: 8,
  },
];

// Trailing SL: tightens as price rises, floors at 5%
// gain = % gain e.g. 50 for +50%
// Tightening: faster than before — at 80% gain, Active Momentum locks within 7% of price
function calcTrailPct(initialTrailPct, gainPct) {
  // Tighten twice as fast for big gains (÷7 instead of ÷10)
  return Math.max(5, initialTrailPct - (gainPct / 7));
}

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
  if (!isSolana && !isEVM) return null;
  if (liq < 3000)  return null;
  if (price <= 0)  return null;
  if (sells24 === 0 && buys24 > 10) return null; // honeypot guard

  // ── ANTI-MANIPULATION GLOBAL FILTERS ─────────────────────────────────────────
  // Reject bot farms and thin-pool manipulation before wasting scoring cycles.
  if (m5Txns > ANTI_MANIP_M5_TXNS_MAX) return null;                        // 40+ txns/min = bot spam
  if (avgTrade !== null && avgTrade < ANTI_MANIP_AVG_TRADE_FLOOR) return null; // micro-trade spam
  if (mcLiqRatio > ANTI_MANIP_MC_LIQ_RATIO_MAX) return null;                // thin pool — easy to fake

  // Calculate age before the dead coin guard — needed for the young-coin exemption
  const ageMinutes = (now - created) / 60000;

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
  //      Allow if buyPct ≥ 50% (buyers are still present) and liq ≥ 10000.
  //
  //   3. Strong m5 on any coin:
  //      If m5Ch ≥ 3% regardless of h1, the coin is moving RIGHT NOW.
  //
  if (ch1 === null) {
    const pass = (ageMinutes >= 60 && ageMinutes < 240 && m5Ch >= 2)
              || (m5Ch >= 3);
    if (!pass) return null;
  } else if (Math.abs(ch1) < 0.5) {
    const pass = (ageMinutes >= 60 && ageMinutes < 240 && m5Ch >= 2) // young coin pumping
              || (ch24 <= -10 && buyPct >= 50 && liq >= 10000)        // bottom bounce stabilising
              || (m5Ch >= 3);                                           // actively surging now
    if (!pass) return null;
  }
  const dexId      = pair.dexId || '';
  const isPumpFun  = dexId === 'pump-fun';

  // UNIVERSAL MINIMUM AGE: 60 minutes for ALL tokens (pump.fun or otherwise).
  // Coins under 60 min are in their most volatile phase — initial hype spike,
  // then immediate dump. Even a perfect-looking score at 12 min can hit SL in seconds.
  // 60 min also eliminates YOUNG COIN MODE (< 60 min special exits), so all trades
  // use the standard TP1/TP2/TP3 targets which are better calibrated for real moves.
  if (ageMinutes < 60) return null;

  // PUMP.FUN YOUNG COIN extra requirements (60–90 min): tighter liquidity + buy pressure
  // (age < 60 already blocked above, so this only applies between 60–90 min)
  if (isPumpFun && ageMinutes < 90 && liq < 15000) return null;
  if (isPumpFun && ageMinutes < 90 && buyPct < 62)  return null;

  const base = {
    addr, price, liq, mcap, vol24, buyPct, buys24, ch1, ch6, ch24, m5Ch, m5Txns,
    m5Buys, m5Vol, m5BuyRate, avgTrade, mcLiqRatio, mcSweetSpot,
    ageDays, ageMinutes, volMcap,
    symbol: pair.baseToken?.symbol || '???',
    name:   pair.baseToken?.name   || '',
    chain:  pair.chainId || 'unknown',
    dexUrl: `https://dexscreener.com/${pair.chainId}/${addr}`,
    isPumpFun,
  };

  // Try each open strategy, return first match with highest confidence
  const matches = [];

  for (const s of openStrategies) {
    let score = 50;
    let match = true;

    if (s.id === 0) {
      // ── BOTTOM BOUNCE ──────────────────────────────────────────────────────
      if (ch24 > s.maxCh24 || ch24 < s.minCh24) { match = false; }
      if (ch1  < s.minCh1  || ch1 > s.maxCh1)   { match = false; }
      if (s.minCh6 != null && ch6 < s.minCh6)   { match = false; } // 6h must also be positive
      if (m5Ch < s.minM5Ch)                       { match = false; }
      if (buyPct < s.minBuyPct)                   { match = false; }
      if (liq < s.minLiq)                          { match = false; }
      if (m5Txns < s.minM5Txns)                   { match = false; }
      if (match) {
        // Scoring: depth of drop + strength of reversal
        score += Math.min(20, Math.abs(ch24) / 4);   // deeper drop = more potential
        if (m5Ch > 2)   score += 15; else if (m5Ch > 0) score += 8;
        if (buyPct > 65) score += 15; else if (buyPct > 58) score += 8;
        if (m5Txns > 20) score += 10; else if (m5Txns > 8) score += 5;
        if (liq > 50000) score += 8; else if (liq > 20000) score += 4;
        if (ch1 > 0)    score += 10; // h1 already positive = confirmed reversal
        if (volMcap > 0.3) score += 5;
        // MC sweet spot + avg trade quality
        if (mcSweetSpot) score += 10;
        if (avgTrade !== null) {
          if (avgTrade > 80) score += 5;
          else if (avgTrade < 30) score -= 10;
        }
      }
    }

    else if (s.id === 1) {
      // ── ACTIVE MOMENTUM ────────────────────────────────────────────────────
      if (m5Txns < s.minM5Txns)  { match = false; }
      if (m5Ch < s.minM5Ch)      { match = false; } // POSITIVE direction required (was abs)
      if (ch1 < s.minCh1)        { match = false; }
      if (buyPct < s.minBuyPct)  { match = false; }
      if (liq < s.minLiq)        { match = false; }
      // No age cap — any age qualifies as long as momentum is live
      // Anti-manipulation: require meaningful avg trade size
      if (avgTrade !== null && avgTrade < 25) { match = false; }
      if (match) {
        score += Math.min(20, m5Txns / 2);         // very active = more confidence
        if (m5Ch > 5)  score += 15; else if (m5Ch > 2) score += 8;
        if (buyPct > 65) score += 15; else if (buyPct > 58) score += 8;
        if (ch1 > 20)  score += 12; else if (ch1 > 8) score += 6;
        if (liq > 30000) score += 8; else if (liq > 15000) score += 4;
        if (volMcap > 1) score += 10; else if (volMcap > 0.4) score += 5;
        // Range-spike guard: if 1h is a big spike but 24h is flat/modest,
        // the coin is likely ranging and we're buying the top of a local spike.
        // True breakouts have 24h trend that SUPPORTS the 1h move.
        const ch24pos1 = Math.max(ch24, 0);
        if      (ch1 > 30 && ch24pos1 < 20) score -= 35; // spike in flat day = range top
        else if (ch1 > 20 && ch24pos1 < 8)  score -= 20; // moderate spike, very weak 24h
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
      // Primary signal: m5 activity — catch it WHILE it's happening
      if (m5Ch < s.minM5Ch)      { match = false; } // must be moving in last 5 min
      if (m5Txns < s.minM5Txns)  { match = false; } // must be very active
      if (ch1 < s.minCh1)        { match = false; } // h1 confirms uptrend
      if (buyPct < s.minBuyPct)  { match = false; }
      if (liq < s.minLiq)        { match = false; }
      // Stricter anti-manipulation for Surge Catch (high-risk, bot-targeted strategy)
      if (avgTrade !== null && avgTrade < ANTI_MANIP_SC_AVG_TRADE) { match = false; }
      if (m5Txns > ANTI_MANIP_SC_TXNS_MAX)                         { match = false; }
      if (mcLiqRatio > ANTI_MANIP_SC_MC_LIQ_MAX)                   { match = false; }
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
      if (ageDays < s.minAgeDays)  { match = false; }
      if (ch24 < s.minCh24)        { match = false; }
      if (ch1 < s.minCh1)          { match = false; }
      if (ch1 > s.maxCh1)          { match = false; } // spike guard
      if (s.minCh6 != null && ch6 < s.minCh6) { match = false; } // 6h sustained momentum
      if (buyPct < s.minBuyPct)    { match = false; }
      if (liq < s.minLiq)          { match = false; }
      if (buys24 < s.minBuys24)    { match = false; }
      if (s.minAvgTrade != null && avgTrade !== null && avgTrade < s.minAvgTrade) { match = false; } // real buyers only
      if (match) {
        score += Math.min(15, ch24 / 3);
        if (ch1 > 8)  score += 12; else if (ch1 > 3) score += 6;
        if (buyPct > 55) score += 10; else if (buyPct > 50) score += 5;
        if (liq > 300000) score += 12; else if (liq > 150000) score += 7;
        if (buys24 > 200) score += 10; else if (buys24 > 100) score += 5;
        if (volMcap > 0.05) score += 5;
        // MC sweet spot + avg trade quality
        if (mcSweetSpot) score += 10;
        if (avgTrade !== null) {
          if (avgTrade > 80) score += 5;
          else if (avgTrade < 30) score -= 10;
        }
      }
    }

    if (match) {
      score = Math.max(0, Math.min(100, Math.round(score)));
      matches.push({ strategy: s, score, ...base });
    }
  }

  if (matches.length === 0) return null;
  // Return the highest-scoring match
  matches.sort((a, b) => b.score - a.score);
  return matches[0];
}

// ─── STATE ────────────────────────────────────────────────────────────────────
const enteredToday  = new Set();
const alertCooldown = new Map();
// Block re-entry for 6h after SL or rug — prevents the triple-entry bug
// (address → timestamp of SL/rug close)
const recentSLCoins = new Map();
// Guards against concurrent-tick races: positions currently being closed
// (added before the async Firestore write; cleared when done)
const closingNow    = new Set();
const SL_BLOCK_MS   = 6 * 60 * 60 * 1000; // 6 hours
let scanCount = 0;
// Daily loss limit state — set true when limit hit, cleared on /restart
let dayHaltedToday  = false;
let telegramOffset  = 0; // for Telegram command polling

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
//     > 5%    → ~6%   slippage   (very thin — should avoid)
function simulateFillPrice(rawPrice, positionSize, liquidityUsd, isBuy) {
  const DEX_FEE = 0.0025; // 0.25% each way
  const ratio = liquidityUsd > 0 ? positionSize / liquidityUsd : 0.05;
  let slippage;
  if      (ratio < 0.001) slippage = 0.002;  // 0.2%
  else if (ratio < 0.01)  slippage = 0.010;  // 1%
  else if (ratio < 0.05)  slippage = 0.030;  // 3%
  else                    slippage = 0.060;  // 6%

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
  const ceiling    = overrides.size || parseFloat(cfg.positionSize) || POSITION_SIZE;
  const posSize    = calcDynamicPositionSize(coin.liq || 0, coin.mcap || 0, ceiling);
  const rawSize    = (coin.liq || 0) * 0.01;  // 1% of liq before MC multiplier & ceiling
  const posSizeNote = posSize >= ceiling
    ? `$${posSize} _(capped — liq 1% = $${rawSize.toFixed(0)})_`
    : `$${posSize} _(liq × 1%)_`;
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
  // Surge momentum: flag if m5 is ripping fast at entry (not applicable to moon bags)
  const isSurge = !overrides.isMoonBag && (coin.m5Ch || 0) >= SURGE_M5_ENTRY_TRIGGER;
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
    sl:  effectiveEntry * s.slx,
    currentSL: effectiveEntry * s.slx,
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
    // Young coin mode: quick 10/20/30% exits for Active Momentum coins < 1h old
    youngCoin: (s.id === 1 && (coin.ageMinutes || 0) < 60),
    // Surge momentum: skip TP1/TP2, ride to 80%+ then full-exit & reinvest
    surgeMomentum: isSurge,
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

    const positions = await getOpenPositions();
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
            await sendTelegram(`⏭️ PRO signal (${item.proScore}/100) skipped — all strategy slots full.`);
            continue;
          }

          // Run bot's scoring algorithm
          const result = detectStrategy(pair, openStrategies);
          const botScore = result?.score ?? 0;

          if (!result || botScore < MIN_SCORE) {
            const reason = result ? `score_${botScore}_below_${MIN_SCORE}` : 'no_strategy_match';
            await doc.ref.update({ status: 'rejected', reason, botScore, processedAt: Date.now() });
            await sendTelegram(
              `❌ *PRO Signal Rejected*\n` +
              `PRO: ${item.proScore}/100 → Bot: ${botScore}/${MIN_SCORE} needed\n` +
              `\`${item.address.slice(0, 8)}…${item.address.slice(-6)}\``
            );
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
        const coin = {
          symbol: item.symbol || pair.baseToken?.symbol || '?',
          name:   pair.baseToken?.name || '',
          addr:   item.address,
          chain:  pair.chainId,
          price,
          score:  100,
          dexUrl: `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`,
          strategy: MANUAL_STRATEGY,
        };

        const pos = await enterPosition(coin, {
          size: item.size || POSITION_SIZE,
          isManual: true,
        });

        await doc.ref.update({ status: 'entered', enteredPositionId: pos.id, processedAt: Date.now() });
        positions.push(pos);

        await sendTelegram(
          `🎯 *MANUAL ENTRY*\n` +
          `*${coin.symbol}* @ ${fmtPrice(price)}\n` +
          `💰 Size: $${coin.size || POSITION_SIZE} · TP3: ${fmtPrice(pos.tp3)} · SL: ${fmtPrice(pos.sl)}`
        );
        console.log(`[MANUAL] Entered ${coin.symbol} @ ${price}`);
      } catch (e) {
        await doc.ref.update({ status: 'failed', error: e.message, processedAt: Date.now() });
        console.error(`[MANUAL] Failed for ${item.address}: ${e.message}`);
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
  // Write history entry — wrapped so a failure doesn't revert the close
  try {
    const snap = await db.collection(positions).doc(id).get();
    await db.collection(history).add({ ...snap.data(), ...closeData });
  } catch(e) {
    console.warn(`[BOT] History write failed for ${id} — position is still closed:`, e.message);
  }
}

async function getDailyStats() {
  const now = Date.now();
  if (_statsCache && now - _statsCacheAt < STATS_TTL) return _statsCache;
  const today  = new Date().toISOString().slice(0, 10);
  const { stats } = await getCollections();
  const doc    = await db.collection(stats).doc(today).get();
  // Use paperBalance from config if set; fall back to env-based default
  const cfg    = await getTradingConfig();
  const expectedBalance = parseFloat(cfg.paperBalance || 0) || (POSITION_SIZE * MAX_POSITIONS);
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
    const path = `/bot${TELEGRAM_TOKEN}/getUpdates?offset=${telegramOffset}&timeout=5&allowed_updates=${encodeURIComponent('["message"]')}`;
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
        const stats   = await getDailyStats();
        const cfg     = await getTradingConfig();
        const mode    = (cfg.tradingMode || 'paper').toUpperCase();
        const pnlStr  = stats.realizedPnL >= 0
          ? `+$${stats.realizedPnL.toFixed(2)}`
          : `-$${Math.abs(stats.realizedPnL).toFixed(2)}`;
        const pct     = ((stats.realizedPnL / stats.startBalance) * 100).toFixed(1);
        const botPaused = cfg.running === false;
        const state   = botPaused        ? '⏸ PAUSED (running=false in DB)'
                      : dayHaltedToday   ? '🚨 HALTED (daily limit)'
                      : '✅ Running';
        const posSize = parseFloat(cfg.positionSize) || POSITION_SIZE;
        const pausedNote = botPaused
          ? `\n⚠️ _Bot is PAUSED — set running=true in Firebase to resume_`
          : '';
        await sendTelegram(
          `📊 *STATUS*\n\n` +
          `${state} · *${mode} mode*\n` +
          `Daily P&L: *${pnlStr}* (${pct}%)\n` +
          `Balance: $${(cfg.paperBalance || POSITION_SIZE * MAX_POSITIONS).toFixed(2)}\n` +
          `Position size: *$${posSize.toFixed(2)}*\n` +
          `Limit: ${(DAILY_LOSS_LIMIT * 100).toFixed(0)}%\n` +
          `Scan #: ${scanCount}${pausedNote}\n\n` +
          `_/ping · /setsize 3 · /mode paper|real · /wallets · /clearreal · /restart_`
        );
      }

      if (text === '/stats') {
        const stats       = await getDailyStats();
        const grossProfit = stats.grossProfit    || 0;
        const grossLoss   = stats.grossLoss      || 0;
        const fees        = stats.dailyFees      || 0;
        const netRevenue  = grossProfit - grossLoss - fees;
        const capital     = stats.capitalDeployed || 0;
        const winRate     = stats.trades > 0 ? ((stats.wins/stats.trades)*100).toFixed(0) : '—';
        await sendTelegram(
          `📈 *DAILY REVENUE REPORT*\n\n` +
          `✅ Gross profit:  +$${grossProfit.toFixed(2)}\n` +
          `❌ Gross loss:    -$${grossLoss.toFixed(2)}\n` +
          `💸 Fees paid:     -$${fees.toFixed(2)}\n` +
          `─────────────────────\n` +
          `🏆 Net revenue:   ${netRevenue>=0?'+':''}$${netRevenue.toFixed(2)}\n\n` +
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

      // ── /help ─────────────────────────────────────────────────────────────────
      if (text === '/help') {
        await sendTelegram(
          `📋 *MemeScan Bot Commands*\n\n` +
          `/status — P&L, mode, balance\n` +
          `/stats — daily revenue: profit, losses, fees, net\n` +
          `/watching — coins being monitored (near threshold)\n` +
          `/mode paper — switch to paper trading\n` +
          `/mode real — switch to real (Solana) trading\n` +
          `/wallets — list connected wallets\n` +
          `/addfunds 500 — add $500 to balance\n` +
          `/setsize 10 — set position size to $10\n` +
          `/clearall — force-close all open positions\n` +
          `/clearreal — delete ghost real-mode positions\n` +
          `/restart — reset daily loss counter\n` +
          `/queue <CA> — evaluate a contract address now\n\n` +
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
          const existSnap = await db.collection('paper_manual_queue')
            .where('address', '==', ca).where('status', '==', 'pending').get();
          if (!existSnap.empty) {
            await sendTelegram(`ℹ️ \`${ca.slice(0, 8)}…${ca.slice(-6)}\` is already queued.`);
          } else {
            await db.collection('paper_manual_queue').add({
              address: ca, status: 'pending',
              source: 'manual_command',
              queuedAt: Date.now(),
            });
            await sendTelegram(
              `🔍 *Queued for evaluation*\n` +
              `\`${ca.slice(0, 8)}…${ca.slice(-6)}\`\n` +
              `_Bot will enter only if it scores ≥ ${MIN_SCORE}_`
            );
          }
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
                await sendTelegram(
                  `🤖 *PRO Signal → Bot Queue*\n` +
                  `PRO: ${proScore}/100 → bot evaluating with its own scoring\n` +
                  `CA: \`${ca.slice(0, 8)}…${ca.slice(-6)}\`\n` +
                  `_Entry only if bot score ≥ ${MIN_SCORE}_`
                );
              } else {
                await sendTelegram(`ℹ️ PRO signal (${proScore}/100) — CA already queued, bot is on it.`);
              }
            } else {
              await sendTelegram(
                `⚠️ PRO signal (${proScore}/100) found but couldn't extract the contract address.\n` +
                `Use \`/queue <CA>\` to add it manually.`
              );
            }
          }
          // score < 80 → silent ignore
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

async function openSurgeReinvest(pos, exitPrice, totalPnL) {
  if (totalPnL <= 0) return;

  // Check slots
  const openPositions = await getOpenPositions();
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

// ─── LP LOCK + SECURITY FILTER (GoPlus batch check) ──────────────────────────
// Checks every strategy match for three things via GoPlus token_security API:
//
//   1. Mintable  — mint authority still active → ALWAYS rejected
//   2. Freezable — freeze authority still active → ALWAYS rejected
//   3. LP locked — liquidity locked/burned → required (EVM only via GoPlus)
//
// Pump.fun tokens are EXEMPT from the LP lock check (pump.fun burns LP on
// graduation to Raydium — the burn IS the lock), but they are NOT exempt from
// the mintable/freezable check. Every coin gets screened for mint + freeze.
//
// Results cached 30 min to minimise API calls.
async function filterByLpLock(matches) {
  const passed   = new Set();
  const toCheck  = [];
  const lpExempt = new Set(); // LP lock not required for these (pump.fun)

  for (const coin of matches) {
    const cached = lpLockCache.get(coin.addr);
    if (cached && Date.now() - cached.ts < LP_LOCK_TTL) {
      if (cached.locked) passed.add(coin.addr);
      continue;
    }

    // Pump.fun: LP is burned on graduation → exempt from LP lock check only.
    // Still needs mintable/freezable screening — do NOT skip GoPlus entirely.
    const isPumpFun = coin.isPumpFun || coin.addr.endsWith('pump');
    if (isPumpFun) lpExempt.add(coin.addr);

    toCheck.push(coin);
  }

  if (!toCheck.length) return matches.filter(c => passed.has(c.addr));

  // Group by chain for batched API calls
  const byChain = {};
  for (const coin of toCheck) {
    const chain = (coin.chain || '').toLowerCase();
    if (!byChain[chain]) byChain[chain] = [];
    byChain[chain].push(coin);
  }

  for (const [chain, coins] of Object.entries(byChain)) {
    const goplusChain = GOPLUS_CHAIN_MAP[chain] || null;
    if (!goplusChain) {
      // Unknown chain → block conservatively
      for (const c of coins) lpLockCache.set(c.addr, { locked: false, ts: Date.now() });
      continue;
    }

    // GoPlus accepts comma-separated addresses per chain
    const addrs = coins.map(c => c.addr).join(',');
    try {
      const r = await httpGet('api.gopluslabs.io', `/api/v1/token_security/${goplusChain}?contract_addresses=${addrs}`);
      if (r.status !== 200) {
        // GoPlus unavailable — fail open so the bot can still trade
        console.warn(`[SECURITY] GoPlus returned ${r.status} for chain ${chain} — failing open (${coins.length} coins allowed through)`);
        for (const c of coins) { lpLockCache.set(c.addr, { locked: true, ts: Date.now() }); passed.add(c.addr); }
        continue;
      }
      const d      = JSON.parse(r.body);
      const result = d?.result || {};

      const isSolana = chain === 'solana';
      for (const coin of coins) {
        // GoPlus keys EVM addresses lowercase; Solana keeps exact case
        const info = result[coin.addr.toLowerCase()] || result[coin.addr] || null;

        // ── 1 & 2: Mintable / Freezable — hard block, all chains ────────
        let isMintable  = false;
        let isFreezable = false;
        if (info) {
          if (isSolana) {
            // GoPlus Solana: mint_authority present = can mint more tokens
            //                freeze_authority present = can freeze transfers
            isMintable  = !!(info.mint_authority  && info.mint_authority  !== '');
            isFreezable = !!(info.freeze_authority && info.freeze_authority !== '');
          } else {
            // GoPlus EVM: is_mintable = "1", transfer_pausable = "1" (freeze equivalent)
            isMintable  = info.is_mintable        === '1';
            isFreezable = info.transfer_pausable  === '1';
          }
        }

        if (isMintable) {
          console.log(`[SECURITY] ❌ ${coin.symbol} (${coin.addr.slice(0,8)}…) — MINTABLE token rejected`);
          lpLockCache.set(coin.addr, { locked: false, ts: Date.now() });
          continue;
        }
        if (isFreezable) {
          console.log(`[SECURITY] ❌ ${coin.symbol} (${coin.addr.slice(0,8)}…) — FREEZABLE token rejected`);
          lpLockCache.set(coin.addr, { locked: false, ts: Date.now() });
          continue;
        }

        // ── 3: LP Lock ───────────────────────────────────────────────────
        let lpPasses;
        if (lpExempt.has(coin.addr)) {
          // Pump.fun burns LP on graduation to Raydium — counts as locked
          lpPasses = true;
        } else if (isSolana) {
          // Non-pump.fun Solana: GoPlus lacks reliable LP lock data for Solana.
          // Block on airdrop scam flag; pass otherwise.
          const isScam = info?.is_airdrop_scam === '1';
          lpPasses = !isScam;
          if (isScam) console.log(`[SECURITY] ❌ ${coin.symbol} (${coin.addr.slice(0,8)}…) — airdrop scam, skipped`);
        } else {
          // EVM: require LP locked or burned via third-party locker
          lpPasses = info?.lp_locked === '1' || info?.lp_burned === '1';
          if (!lpPasses) console.log(`[SECURITY] ❌ ${coin.symbol} (${coin.addr.slice(0,8)}…) — LP not locked, skipped`);
        }

        lpLockCache.set(coin.addr, { locked: lpPasses, ts: Date.now() });
        if (lpPasses) passed.add(coin.addr);
      }
    } catch(e) {
      // GoPlus network error — fail open so the bot can still trade
      console.warn(`[SECURITY] GoPlus error for chain ${chain}: ${e.message} — failing open (${coins.length} coins allowed through)`);
      for (const c of coins) { lpLockCache.set(c.addr, { locked: true, ts: Date.now() }); passed.add(c.addr); }
    }
    await sleep(200); // brief pause between chain batches
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
      `Exit: $${fmtPrice(exitFillPriceManual)} | P&L: *${pnl>=0?'+':''}$${pnl.toFixed(2)}*`
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
        const price   = await getCurrentPrice(pos.address, pos.chain) || pos.entryPrice;
        const exitPnl = (price - pos.entryPrice) / pos.entryPrice * pos.size * pos.remaining;
        const pnl     = (pos.pnl || 0) + exitPnl;
        await closePosition(pos.id, { exitPrice: price, exitReason: 'DAILY_LIMIT', pnl });
        await sendTelegram(`🚨 *DAILY LOSS LIMIT*\n*${pos.symbol}* closed. P&L: ${pnl>=0?'+':''}$${pnl.toFixed(2)}`);
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

  for (const pos of remaining_positions) {
    const isManual = !!pos.isManual;

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
      await sendTelegram(`⏰ *EXPIRED* — *${pos.symbol}*\nExit: $${fmtPrice(exitFillPriceExp)} | P&L: ${pnl>=0?'+':''}$${pnl.toFixed(2)}`);
      enteredToday.delete(pos.address);
      continue;
    }

    const price = await getCurrentPrice(pos.address, pos.chain);
    if (!price || price <= 0) continue;

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

    // ── SURGE MOMENTUM — AUTO-DETECT & EXIT ───────────────────────────────────
    // Auto-switch to surge mode if coin rips +40%+ within first 20 minutes.
    if (!pos.surgeMomentum && !pos.isMoonBag) {
      const elapsed = Date.now() - pos.enteredAt;
      if (gain >= SURGE_AUTO_GAIN_TRIGGER && elapsed < SURGE_AUTO_TIME_LIMIT) {
        await updatePosition(pos.id, { surgeMomentum: true });
        pos.surgeMomentum = true;
        await sendTelegram(
          `🚀 *SURGE MODE AUTO-SWITCH*\n*${pos.symbol}* +${gainPct.toFixed(1)}% in ${Math.round(elapsed/60000)}min\n` +
          `Skipping TP1/TP2 — riding to 80%+ full exit\n🔗 [Chart](${pos.dexUrl})`
        );
      }
    }
    // Surge exit: full position at 80%+ gain, then reinvest capped portion of profit
    if (pos.surgeMomentum && !pos.isMoonBag && gain >= SURGE_EXIT_AT) {
      // Guard against concurrent monitor ticks firing duplicate SURGE_EXIT
      if (closingNow.has(pos.id)) continue;
      closingNow.add(pos.id);
      try {
        const exitPnl = fillGain * pos.size * pos.remaining;
        const pnl     = (pos.pnl || 0) + exitPnl;
        await closePosition(pos.id, { exitPrice: exitFillPrice, exitReason: 'SURGE_EXIT', pnl });
        await updateDailyStats(exitPnl, true, isManual, calcExitFeeUsd(pos, price, exitFillPrice, pos.remaining));
        enteredToday.delete(pos.address);
        await sendTelegram(
          `🚀 *SURGE EXIT — FULL POSITION*\n\n` +
          `*${pos.symbol}* ${pos.strategyLabel}\n` +
          `📥 Entry: $${fmtPrice(pos.entryPrice)} → Exit: $${fmtPrice(exitFillPrice)}\n` +
          `📊 P&L: *+$${pnl.toFixed(2)}* (+${gainPct.toFixed(1)}%)\n` +
          `♻️ Calculating reinvestment…\n🔗 [Chart](${pos.dexUrl})`
        );
        await openSurgeReinvest(pos, exitFillPrice, pnl);
      } finally {
        closingNow.delete(pos.id);
      }
      continue;
    }

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
            enteredToday.delete(pos.address);
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
          `📊 P&L: *${pnl>=0?'+':''}$${pnl.toFixed(2)}*\n🔗 [Chart](${pos.dexUrl})`
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
        recentSLCoins.set(pos.address, Date.now()); // block re-entry for 6h — prevents triple entries
        await sendTelegram(
          `🛑 *STOP LOSS HIT*\n\n` +
          `*${pos.symbol}* ${pos.strategyLabel}\n` +
          `📥 Entry: $${fmtPrice(pos.entryPrice)} → Exit: $${fmtPrice(exitFillPrice)}\n` +
          `🛑 SL: $${fmtPrice(pos.currentSL)} | Trail: ${calcTrailPct(pos.initialTrailPct, gainPct).toFixed(1)}%\n` +
          `📊 P&L: *${pnl>=0?'+':''}$${pnl.toFixed(2)}*\n🔗 [Chart](${pos.dexUrl})`
        );
      } finally {
        closingNow.delete(pos.id);
      }
      continue;
    }

    // ══════════════════════════════════════════════════════════════════════
    // ── TAKE PROFIT (skipped when tpDisabled — trailing SL rides the surge)
    // ══════════════════════════════════════════════════════════════════════
    // TWO MODES for Active Momentum:
    //
    // 🔥 YOUNG COIN (< 1h old at entry): quick exits — 10 / 20 / 30% gains
    //    Sell 30% at each stage, keep 10% for trailing SL ride
    //    These coins pump fast then rug — don't chase 50/100/200%
    //
    // 📈 NORMAL (≥ 1h old): standard stages — 50 / 100 / 200% gains
    //    Sell 25% / 30% / 15%, let the rest ride
    // ══════════════════════════════════════════════════════════════════════
    if (!pos.tpDisabled && pos.partialStage !== null && !(pos.surgeMomentum && !pos.isMoonBag)) {
      const stage  = pos.partialStage || 0;
      const target = pos.size * 1.2; // recover 120% of investment

      if (pos.youngCoin) {
        // ── YOUNG COIN MODE: quick 10 / 20 / 30% ──────────────────────────
        if (stage === 0 && price >= pos.entryPrice * 1.10) {
          const frac     = 0.30;
          const proceeds = frac * pos.size * (exitFillPrice / pos.entryPrice);
          const partPnL  = proceeds - frac * pos.size;
          const newRec   = (pos.recoveredAmount || 0) + proceeds;
          updates = { partialStage:1, remaining: pos.remaining - frac,
            recoveredAmount: newRec, pnl: (pos.pnl || 0) + partPnL };
          await updatePosition(pos.id, updates); await updateDailyStats(partPnL, true, isManual, calcExitFeeUsd(pos, price, exitFillPrice, frac));
          alertMsg = `🔥 *YOUNG COIN — 30% SOLD (+10%)*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
            `⚡ Quick exit: coin is <1h old\n` +
            `💰 Proceeds: $${proceeds.toFixed(2)} | P&L: +$${partPnL.toFixed(2)}\n` +
            `🎯 Riding 70% — next exit at +20%\n🔗 [Chart](${pos.dexUrl})`;
          Object.assign(pos, updates);
        }
        else if (stage === 1 && price >= pos.entryPrice * 1.20) {
          const frac     = 0.30;
          const proceeds = frac * pos.size * (exitFillPrice / pos.entryPrice);
          const partPnL  = proceeds - frac * pos.size;
          const newRec   = (pos.recoveredAmount || 0) + proceeds;
          updates = { partialStage:2, remaining: pos.remaining - frac,
            recoveredAmount: newRec, pnl: (pos.pnl || 0) + partPnL };
          await updatePosition(pos.id, updates); await updateDailyStats(partPnL, true, isManual, calcExitFeeUsd(pos, price, exitFillPrice, frac));
          alertMsg = `🔥 *YOUNG COIN — 30% MORE SOLD (+20%)*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
            `💰 Proceeds: $${proceeds.toFixed(2)} | P&L: +$${partPnL.toFixed(2)}\n` +
            `🎯 Riding 40% — next exit at +30%\n🔗 [Chart](${pos.dexUrl})`;
          Object.assign(pos, updates);
        }
        else if (stage === 2 && price >= pos.entryPrice * 1.30) {
          const frac     = 0.30;
          const proceeds = frac * pos.size * (exitFillPrice / pos.entryPrice);
          const partPnL  = proceeds - frac * pos.size;
          const newRec   = (pos.recoveredAmount || 0) + proceeds;
          // After 3 quick exits: 10% remains riding on tight trailing SL only
          updates = { partialStage:3, remaining: pos.remaining - frac,
            recoveredAmount: newRec, freeRide: newRec >= target,
            pnl: (pos.pnl || 0) + partPnL,
            // Tighten SL to 5% after final quick exit — protect the last 10%
            currentSL: price * 0.95, initialTrailPct: 8 };
          await updatePosition(pos.id, updates); await updateDailyStats(partPnL, true, isManual, calcExitFeeUsd(pos, price, exitFillPrice, frac));
          alertMsg = `🔥 *YOUNG COIN — FINAL QUICK EXIT (+30%)*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
            `💰 Proceeds: $${proceeds.toFixed(2)} | P&L: +$${partPnL.toFixed(2)}\n` +
            `🎯 10% remains on tight 5% trailing SL — ride or die!\n🔗 [Chart](${pos.dexUrl})`;
          Object.assign(pos, updates);
        }
      } else {
        // ── NORMAL MODE: standard 50 / 100 / 200% stages ─────────────────
        if (stage === 0 && price >= pos.entryPrice * 1.5) {
          const frac     = 0.25;
          const proceeds = frac * pos.size * (exitFillPrice / pos.entryPrice);
          const partPnL  = proceeds - frac * pos.size;
          const newRec   = (pos.recoveredAmount || 0) + proceeds;
          updates = { partialStage:1, remaining: pos.remaining - frac,
            recoveredAmount: newRec, pnl: (pos.pnl || 0) + partPnL };
          await updatePosition(pos.id, updates); await updateDailyStats(partPnL, true, isManual, calcExitFeeUsd(pos, price, exitFillPrice, frac));
          alertMsg = `⚡ *STAGE 1 — 25% SOLD (+50%)*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
            `💰 Proceeds: $${proceeds.toFixed(2)} | P&L: +$${partPnL.toFixed(2)}\n` +
            `🎯 Recovered $${newRec.toFixed(2)} / $${target.toFixed(2)} — riding 75%\n🔗 [Chart](${pos.dexUrl})`;
          Object.assign(pos, updates);
        }
        else if (stage === 1 && price >= pos.entryPrice * 2.0) {
          const frac     = 0.30;
          const proceeds = frac * pos.size * (exitFillPrice / pos.entryPrice);
          const partPnL  = proceeds - frac * pos.size;
          const newRec   = (pos.recoveredAmount || 0) + proceeds;
          const fr       = newRec >= target;
          updates = { partialStage:2, remaining: pos.remaining - frac,
            recoveredAmount: newRec, freeRide: fr, pnl: (pos.pnl || 0) + partPnL };
          await updatePosition(pos.id, updates); await updateDailyStats(partPnL, true, isManual, calcExitFeeUsd(pos, price, exitFillPrice, frac));
          alertMsg = `⚡ *STAGE 2 — 30% SOLD (+100%)*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
            `💰 Proceeds: $${proceeds.toFixed(2)} | P&L: +$${partPnL.toFixed(2)}\n` +
            `🎯 Recovered $${newRec.toFixed(2)}${fr?' ✅ FREE RIDE!':''}\n🔗 [Chart](${pos.dexUrl})`;
          Object.assign(pos, updates);
        }
        else if (stage === 2 && price >= pos.entryPrice * 3.0) {
          const frac     = Math.min(0.15, pos.remaining - 0.10);
          const proceeds = frac * pos.size * (exitFillPrice / pos.entryPrice);
          const partPnL  = proceeds - frac * pos.size;
          const newRec   = (pos.recoveredAmount || 0) + proceeds;
          updates = { partialStage:3, remaining: pos.remaining - frac,
            recoveredAmount: newRec, freeRide: true, pnl: (pos.pnl || 0) + partPnL };
          await updatePosition(pos.id, updates); await updateDailyStats(partPnL, true, isManual, calcExitFeeUsd(pos, price, exitFillPrice, frac));
          alertMsg = `🚀 *STAGE 3 — FREE RIDE (+200%)*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
            `💰 Total recovered: $${newRec.toFixed(2)} | Remaining ${((pos.remaining-frac)*100).toFixed(0)}% is pure profit\n🔗 [Chart](${pos.dexUrl})`;
          Object.assign(pos, updates);
        }
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // ── STANDARD TP1 / TP2 / TP3 (Bottom Bounce + Old Recovery) ─────────
    // ══════════════════════════════════════════════════════════════════════
    else if (!pos.tpDisabled) {
      // ── PROFIT-FIRST TP1 OVERRIDE: skip TP1 if strong uptrend still running ──
      // Never sell into strength — trail SL instead and capture the bigger move.
      // If tp1 was skipped but trend later fades (retests TP1), take the sell then.
      if (!pos.tp1Hit && !pos.tp1Skipped && price >= pos.tp1) {
        if (isTrendingUp(pos.address, 5)) {
          // Trend strong — hold full position, tighten SL to protect the gain
          const tightSL = Math.max(pos.currentSL, pos.tp1 * 0.97);
          updates = { tp1Skipped: true, currentSL: tightSL, trailingActive: true };
          alertMsg = `📈 *TP1 SKIPPED — TREND HOLDING*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
            `+${gainPct.toFixed(1)}% — momentum strong, holding full position for bigger move\n` +
            `🔒 SL raised to $${fmtPrice(tightSL)}\n🔗 [Chart](${pos.dexUrl})`;
          Object.assign(pos, updates);
        } else {
          // Trend not strong enough — take the standard TP1 partial
          const partPnL = fillGain * pos.size * 0.50;
          updates = { tp1Hit:true, remaining: pos.remaining - 0.50,
            currentSL: pos.entryPrice * 1.01, trailingActive:true, pnl: (pos.pnl || 0) + partPnL };
          await updatePosition(pos.id, updates); await updateDailyStats(partPnL, true, isManual, calcExitFeeUsd(pos, price, exitFillPrice, 0.50));
          alertMsg = `✅ *TP1 HIT — 50% SOLD*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
            `Entry: $${fmtPrice(pos.entryPrice)} → $${fmtPrice(exitFillPrice)}\n` +
            `💰 +$${partPnL.toFixed(2)} | SL → breakeven\n🔗 [Chart](${pos.dexUrl})`;
          Object.assign(pos, updates);
        }
      }
      // TP1 was skipped but trend has since faded — re-test, take the delayed sell
      else if (!pos.tp1Hit && pos.tp1Skipped && price >= pos.tp1 && !isTrendingUp(pos.address, 3)) {
        const partPnL = fillGain * pos.size * 0.50;
        updates = { tp1Hit:true, tp1Skipped:false, remaining: pos.remaining - 0.50,
          currentSL: pos.entryPrice * 1.01, trailingActive:true, pnl: (pos.pnl || 0) + partPnL };
        await updatePosition(pos.id, updates); await updateDailyStats(partPnL, true, isManual, calcExitFeeUsd(pos, price, exitFillPrice, 0.50));
        alertMsg = `✅ *TP1 HIT (DELAYED) — 50% SOLD*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
          `Entry: $${fmtPrice(pos.entryPrice)} → $${fmtPrice(exitFillPrice)}\n` +
          `💰 +$${partPnL.toFixed(2)} | SL → breakeven\n🔗 [Chart](${pos.dexUrl})`;
        Object.assign(pos, updates);
      }
      // TP2: triggers whether TP1 was hit normally or skipped (sell combined 80% if skipped)
      else if ((pos.tp1Hit || pos.tp1Skipped) && !pos.tp2Hit && price >= pos.tp2) {
        const wasSkipped = pos.tp1Skipped && !pos.tp1Hit;
        const sellFrac  = wasSkipped ? 0.80 : 0.30; // 80% combined if TP1 was held; 30% normal
        const tp2Label  = wasSkipped ? 'TP2 HIT — 80% SOLD (TP1 held for uptrend)' : 'TP2 HIT — 30% SOLD';
        const partPnL = fillGain * pos.size * sellFrac;
        updates = { tp2Hit:true, tp1Hit:true, tp1Skipped:false, remaining: pos.remaining - sellFrac,
          currentSL: pos.tp1 * 0.99, pnl: (pos.pnl || 0) + partPnL };
        await updatePosition(pos.id, updates); await updateDailyStats(partPnL, true, isManual, calcExitFeeUsd(pos, price, exitFillPrice, sellFrac));
        alertMsg = `🎯 *${tp2Label}*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
          `💰 +$${partPnL.toFixed(2)} | SL → TP1 level\n🔗 [Chart](${pos.dexUrl})`;
        Object.assign(pos, updates);
      }
      else if (pos.tp1Hit && pos.tp2Hit && price >= pos.tp3) {
        const partPnL = fillGain * pos.size * pos.remaining;
        await closePosition(pos.id, { exitPrice: exitFillPrice, exitReason:'TP3', pnl: (pos.pnl || 0) + partPnL });
        await updateDailyStats(partPnL, true, isManual, calcExitFeeUsd(pos, price, exitFillPrice, pos.remaining));
        enteredToday.delete(pos.address);
        await sendTelegram(`🏆 *TP3 — FULL EXIT*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
          `Entry: $${fmtPrice(pos.entryPrice)} → $${fmtPrice(exitFillPrice)}\n` +
          `💰 Final: +$${partPnL.toFixed(2)}\n🔗 [Chart](${pos.dexUrl})`);
        continue;
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // ── PROGRESSIVE TRAILING SL — ALL STRATEGIES, EVERY TICK ─────────────
    // Tightens as price rises, floors at 5%
    // ══════════════════════════════════════════════════════════════════════
    if (gainPct > 0) {
      let newSL;
      if (pos.isMoonBag) {
        // Moon bag: graduated SL schedule (25 → 20 → 15 → 10 → 5% floor)
        const targetPct = getMoonBagSL(gain);
        newSL = price * (1 - targetPct);
        // Notify when the SL tier actually drops (not every tick)
        const prevGain  = ((pos.peakPrice || pos.entryPrice) - pos.entryPrice) / pos.entryPrice;
        const prevPct   = getMoonBagSL(prevGain);
        if (targetPct < prevPct && newSL > (updates.currentSL ?? pos.currentSL) * 1.005) {
          await sendTelegram(
            `🌕 *MOON BAG SL TIGHTENED — ${pos.symbol}*\n` +
            `+${gainPct.toFixed(1)}% from entry\n` +
            `SL: ${(prevPct*100).toFixed(0)}% → *${(targetPct*100).toFixed(0)}%*\n🔗 [Chart](${pos.dexUrl})`
          );
        }
      } else {
        let trailPct = calcTrailPct(pos.initialTrailPct, gainPct);
        // SURGE_CATCH profit lock: once ≥20% gain, clamp trail to 5%
        // Slippery coins spike fast and reverse hard — hold the gain tight
        if (pos.strategyId === 2 && gain >= 0.20 && !pos.surgeMomentum) {
          trailPct = Math.min(trailPct, 5);
        }
        newSL = price * (1 - trailPct / 100);
      }
      const currentSL = updates.currentSL ?? pos.currentSL;
      // Only write if SL moved ≥ 0.5% — prevents thousands of tiny writes per day
      if (newSL > currentSL * 1.005) {
        updates.currentSL      = newSL;
        updates.trailingActive = true;
      }
    }

    if (Object.keys(updates).length > 0) await updatePosition(pos.id, updates);
    if (alertMsg) await sendTelegram(alertMsg);
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

  // ── Platform 1: pump.fun — top 200 most recently traded coins ──────────────
  try {
    const r = await httpGet(
      'frontend-api.pump.fun',
      '/coins?offset=0&limit=200&sort=last_trade_unix_time&order=DESC'
    );
    const coins = JSON.parse(r.body);
    const list  = Array.isArray(coins) ? coins : [];
    for (const c of list) {
      const addr = (c.mint || '').toLowerCase();
      if (addr) fresh.set(addr, (fresh.get(addr) || 0) + 1);
    }
    console.log(`[TRENDING] pump.fun: ${list.length} trending coins`);
  } catch(e) { console.log(`[TRENDING] pump.fun error: ${e.message}`); }

  // ── Platform 2: Birdeye — top 200 trending tokens on Solana ─────────────────
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
  console.log(`[TRENDING] Cache updated: ${fresh.size} unique trending addrs (pump.fun + Birdeye)`);
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
  const positions = await getOpenPositions();
  if (positions.length >= MAX_POSITIONS) return;

  const vacantSlots = MAX_POSITIONS - positions.length;

  // Count open slots per strategy
  const slotCount = {};
  STRATEGIES.forEach(s => slotCount[s.id] = 0);
  positions.forEach(p => { if (p.strategyId != null) slotCount[p.strategyId]++; });

  const openStrategies = STRATEGIES.filter(s => slotCount[s.id] < s.maxSlots);
  if (!openStrategies.length) return;

  // ── Score threshold — never lower than MIN_SCORE regardless of vacant slots ──
  // Resist the urge to fill slots with low-quality coins. Quality > quantity.
  // Slight relief (−5) when 5+ slots empty, but never below MIN_SCORE.
  const scoreThreshold = vacantSlots >= 5 ? Math.max(MIN_SCORE, MIN_SCORE - 5) : MIN_SCORE;
  if (vacantSlots >= 3) console.log(`[BOT] ${vacantSlots} slots vacant — score threshold: ${scoreThreshold}`);

  // Fetch candidates from DexScreener
  // Diverse keyword set — covers meme coins, AI tokens, trending names, and general Solana ecosystem.
  // 1–4 hour coins appear in these results as long as they have volume/activity.
  const keywords = [
    // classic meme
    'meme','pepe','dog','cat','inu','shib','doge','frog','chad',
    // trending/viral & influencer names
    'pump','moon','elon','trump','wojak','grok','ai',
    'ansem','alpha','bull','bear','black',
    // broader ecosystem
    'sol','baby','floki','coin','token',
    // newer launches
    'new','launch','fair',
    // ecosystem & DeFi (always included — ANSEM-type coins won't match meme keywords)
    'defi','swap','yield','nft','gaming','web3','dao','ape','based','surge',
  ];
  // When urgently filling (5+ vacant), cast an even wider net
  if (vacantSlots >= 5) {
    keywords.push('eth','avax','bonk','wif','trump','bitcoin','hot','fire','gem','100x');
  }
  const seen = new Set();
  const candidates    = [];
  const dexBoostAddrs = new Set(); // DexScreener boosted token addresses — merged into trending map below

  for (const kw of keywords) {
    try {
      const r = await httpGet('api.dexscreener.com', `/latest/dex/search?q=${kw}`);
      const d = JSON.parse(r.body);
      for (const p of (d.pairs || [])) {
        const addr = p.baseToken?.address || '';
        if (!seen.has(addr)) { seen.add(addr); candidates.push(p); }
      }
    } catch(e) {}
    await sleep(200);
  }

  // Also fetch trending/gainers for Surge detection
  try {
    const r = await httpGet('api.dexscreener.com', '/latest/dex/search?q=solana');
    const d = JSON.parse(r.body);
    for (const p of (d.pairs || [])) {
      const addr = p.baseToken?.address || '';
      if (!seen.has(addr)) { seen.add(addr); candidates.push(p); }
    }
  } catch(e) {}

  // ── DexScreener Boosted Tokens (same source as MemeScan PRO signals) ──────────
  // MemeScan PRO uses /token-boosts/top/v1 and /token-boosts/latest/v1 to find
  // promoted/trending coins. Without this, the bot only sees keyword matches and
  // misses all boosted coins regardless of their names (e.g. HEXN, HYPERCHAN, etc.)
  const boostEndpoints = ['/token-boosts/top/v1', '/token-boosts/latest/v1'];
  for (const boostEp of boostEndpoints) {
    try {
      const r = await httpGet('api.dexscreener.com', boostEp);
      const d = JSON.parse(r.body);
      // API returns array of {chainId, tokenAddress, amount, ...}
      const boosted = Array.isArray(d) ? d : [];
      // Filter to Solana only, take top 50 per endpoint (was 25 — doubled to catch mid-range trending coins)
      const solanaBoosted = boosted.filter(b => b.chainId === 'solana').slice(0, 50);
      console.log(`[SCAN] Boosted (${boostEp.split('/')[1]}): ${boosted.length} total, ${solanaBoosted.length} Solana`);
      for (const b of solanaBoosted) {
        const addr = b.tokenAddress || '';
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        dexBoostAddrs.add(addr.toLowerCase()); // track for trending cross-reference
        try {
          const r2 = await httpGet('api.dexscreener.com', `/latest/dex/tokens/${addr}`);
          const d2 = JSON.parse(r2.body);
          for (const p2 of (d2.pairs || []).slice(0, 2)) {
            const a2 = p2.baseToken?.address || '';
            if (a2 && !seen.has(a2)) { seen.add(a2); candidates.push(p2); }
            else if (a2 === addr) candidates.push(p2); // include even if addr already seen (different pair)
          }
        } catch(e) {}
        await sleep(80); // rate limit — DexScreener allows ~10 req/s
      }
    } catch(e) { console.log(`[SCAN] Boosted endpoint error (${boostEp}): ${e.message}`); }
  }

  // ── DexScreener Top Solana Pairs (by volume) ─────────────────────────────────
  // Catches high-volume coins that don't match any keyword and aren't in the boosted
  // list — e.g. "ANSEM / The Black Bear" with $1M daily volume.
  // DexScreener's /latest/dex/tokens/{chain} returns top pairs by volume for a chain.
  // We sweep the top 30 Solana pairs to surface any coin that is genuinely active.
  try {
    const r = await httpGet('api.dexscreener.com', '/latest/dex/search?q=solana');
    const d = JSON.parse(r.body);
    const topPairs = (d.pairs || [])
      .filter(p => p.chainId === 'solana' && p.volume?.h24 > 50000)
      .slice(0, 30);
    for (const p of topPairs) {
      const a = p.baseToken?.address || '';
      if (a && !seen.has(a)) { seen.add(a); candidates.push(p); }
    }
    console.log(`[SCAN] Top-volume sweep: ${topPairs.length} Solana pairs (vol > $50k)`);
  } catch(e) { console.log(`[SCAN] Top-volume sweep error: ${e.message}`); }

  console.log(`[SCAN] Fetched ${candidates.length} unique candidates via ${keywords.length} keywords + boosts + vol sweep`);

  // ── Trending cross-reference ──────────────────────────────────────────────
  // Merge pump.fun + Birdeye (refreshed every 5 min) with DexScreener boosts
  // (already fetched above) into one per-scan map: addr → platform count.
  // trendCount 0 → use base scoreThreshold (MIN_SCORE)
  // trendCount 1 → threshold drops by 4
  // trendCount 2+ → threshold drops by 8
  await fetchTrendingAddrs();
  const scanTrendingMap = new Map(trendingAddrs); // start from pump.fun + Birdeye
  for (const a of dexBoostAddrs) {
    scanTrendingMap.set(a, (scanTrendingMap.get(a) || 0) + 1); // add DexScreener boost
  }
  const trendingTotal = scanTrendingMap.size;
  if (trendingTotal > 0) console.log(`[TRENDING] ${trendingTotal} addrs in merged map (${dexBoostAddrs.size} DexBoost + pump.fun + Birdeye)`);

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
  const lockedMatches = await filterByLpLock(matches);
  if (matches.length > 0) {
    const dropped = matches.length - lockedMatches.length;
    if (dropped > 0) console.log(`[LP LOCK] ${dropped}/${matches.length} matches skipped — LP not locked`);
    else console.log(`[LP LOCK] All ${lockedMatches.length} matches passed LP check`);
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
      `${nearMissCount} near-misses (score ${MIN_SCORE - 8}-${scoreThreshold - 1})`
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
    // Reserve last SURGE_RESERVED slots exclusively for Surge Catch (id 2).
    // Other strategies stop competing once positions reach MAX_POSITIONS - SURGE_RESERVED.
    if (coin.strategy.id !== 2 && positions.length >= MAX_POSITIONS - SURGE_RESERVED) continue;
    if (usedThisScan.has(coin.addr)) continue;
    // Check cooldown
    const last = alertCooldown.get(coin.addr) || 0;
    if (Date.now() - last < 30 * 60 * 1000) continue;
    // Check slot still available (may have been filled earlier in this loop)
    if (slotCount[coin.strategy.id] >= coin.strategy.maxSlots) continue;

    // ── PULLBACK GATE — wait for a dip before entering, not at the peak ────────
    // Applied to SURGE_CATCH (id 2) and ACTIVE MOMENTUM (id 1) only.
    // Bottom Bounce (id 0) and Old Recovery (id 3) are EXEMPT: their 24h drop
    // IS the pullback — adding another intraday dip gate double-filters them and
    // prevents any entries after a bot restart (surgeWatchlist is empty on deploy).
    //
    // Entry paths for id 1 (Active Momentum):
    //   A) EXPLOSIVE BYPASS: m5 > 8% AND h1 > 25% AND buyPct > 70% — enter immediately
    //   B) FULL PULLBACK CYCLE (via checkSurgePullback): ≥5% dip → ≥3% bounce
    // Entry paths for id 2 (Surge Catch — via checkSurgePullback):
    //   A) BUY-RATE CONFIRMATION: watched ≥1 min + m5BuyRate ≥8/min + avgTrade ≥$40 + uptrend
    //   B) FULL PULLBACK CYCLE: ≥5% dip from peak → ≥3% bounce from that low

    if (coin.strategy.id === 2) {
      // Two paths through the gate (both handled inside checkSurgePullback):
      //   A) BUY-RATE CONFIRMATION: watched ≥1 min + m5BuyRate ≥8/min + avgTrade ≥$40 + uptrend
      //   B) FULL PULLBACK CYCLE: ≥5% dip from peak → ≥3% bounce from that low
      const shouldEnter = checkSurgePullback(coin);
      if (!shouldEnter) {
        usedThisScan.add(coin.addr); // don't reprocess same coin twice this scan
        continue;
      }
    }

    if (coin.strategy.id === 1) {
      const isExplosive = (coin.m5Ch || 0) >= 8 && (coin.ch1 || 0) >= 25 && (coin.buyPct || 0) >= 70;
      if (coin._rangeReentry) {
        // Range re-entry: support bounce confirmed — skip pullback gate, enter directly
        console.log(`[AM-WATCH] ${coin.symbol} — RANGE RE-ENTRY bypass — entering at support bounce`);
      } else if (isExplosive) {
        console.log(`[AM-WATCH] ${coin.symbol} — EXPLOSIVE entry bypass (m5:${coin.m5Ch?.toFixed(1)}% h1:${coin.ch1?.toFixed(1)}% buy:${coin.buyPct?.toFixed(0)}%) — entering immediately`);
        coin._explosiveEntry = true;
      } else {
        const watchEntry = surgeWatchlist.get(coin.addr);
        const watchedMs  = watchEntry ? (Date.now() - watchEntry.watchedSince) : 0;
        const isMomentumBypass = watchedMs > 5 * 60 * 1000
          && (coin.m5Ch || 0) > 2 && (coin.buyPct || 0) > 62;
        if (isMomentumBypass) {
          console.log(`[AM-WATCH] ${coin.symbol} — MOMENTUM BYPASS (watched ${Math.round(watchedMs/60000)}min, m5:${coin.m5Ch?.toFixed(1)}%, buy:${coin.buyPct?.toFixed(0)}%) — entering`);
          coin._momentumBypass = true;
        } else {
          const shouldEnter = checkSurgePullback(coin);
          if (!shouldEnter) {
            usedThisScan.add(coin.addr);
            continue;
          }
        }
      }
    }

    // id 0 (Bottom Bounce) and id 3 (Old Recovery): NO pullback gate.
    // The 24h decline already confirmed the drawdown — enter when momentum turns positive.

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
        : `🎯 TP1: $${fmtPrice(coin.price * s.tp1x)} (+${((s.tp1x-1)*100).toFixed(0)}%) → 50%\n` +
          `🎯 TP2: $${fmtPrice(coin.price * s.tp2x)} (+${((s.tp2x-1)*100).toFixed(0)}%) → 30%\n` +
          `🎯 TP3: $${fmtPrice(coin.price * s.tp3x)} (+${((s.tp3x-1)*100).toFixed(0)}%) → 20%\n`;

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

  setInterval(async () => {
    try {
      scanCount++;
      await processManualQueue();   // manual entries first
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
