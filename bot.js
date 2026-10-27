const https = require('https');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT   = process.env.TELEGRAM_CHAT_ID;
const POSITION_SIZE   = parseFloat(process.env.POSITION_SIZE || '100');
const MAX_POSITIONS   = 10;
const MIN_SCORE       = 60;
const DAILY_LOSS_LIMIT= -0.30;
const SCAN_INTERVAL   = 15000;  // 15s — entry scanner
const PRICE_CHECK     =  5000;  //  5s — position monitor

// ─── FIREBASE INIT ────────────────────────────────────────────────────────────
let db;
try {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(sa) });
  db = getFirestore();
  console.log('[BOT] Firebase connected');
} catch(e) {
  console.error('[BOT] Firebase init failed:', e.message);
  process.exit(1);
}

// ═════════════════════════════════════════════════════════════════════════════
// ─── 4-STRATEGY SYSTEM  (10 total slots) ─────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
const STRATEGIES = [
  {
    id: 0,
    label: '📉 BOTTOM BOUNCE',
    maxSlots: 3,
    desc: 'Oversold token reversing from its bottom',
    // ── Entry criteria ──
    maxCh24: -10,       // was falling — 24h must be negative (e.g. -10% to -90%)
    minCh24: -92,
    maxCh1: 5,          // h1 not still crashing (< +5% = hasn't mooned yet)
    minCh1: -20,        // h1 not still in freefall (> -20%)
    minM5Ch: -0.5,      // m5 stabilising or turning green
    minBuyPct: 55,      // buyers coming in
    minLiq: 15000,
    minM5Txns: 3,       // activity picking up
    // ── TP / SL (standard 3-step) ──
    tp1x: 1.25, tp2x: 1.55, tp3x: 2.10,
    slx: 0.87,
    initialTrailPct: 13,
  },
  {
    id: 1,
    label: '⚡ ACTIVE MOMENTUM',
    maxSlots: 3,
    desc: 'Price ticking every 5-15 min — strong live activity',
    // ── Entry criteria ──
    minM5Txns: 15,       // busy last 5 min
    minM5Ch: 1.0,        // at least +1% in last 5 min — MUST be going UP (was abs check)
    minCh1: 3,           // positive h1 trend
    minBuyPct: 55,
    minLiq: 8000,
    maxAgeDays: 3,       // young, active coins
    // ── TP / SL (partial profit — sell in bits) ──
    tp1x: 1.50, tp2x: 2.50, tp3x: 5.00,
    slx: 0.80,
    initialTrailPct: 20,
    usePartialProfit: true,  // stage-based selling like old Alpha
  },
  {
    id: 2,
    label: '🚀 SURGE CATCH',
    maxSlots: 2,
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
    maxSlots: 2,
    desc: 'Established coin climbing back steadily',
    // ── Entry criteria ──
    minAgeDays: 15,
    minCh24: 3,          // positive 24h
    minCh1: 0.5,         // positive h1 (still climbing)
    minBuyPct: 50,
    minLiq: 80000,       // established = decent liquidity
    minBuys24: 50,
    maxCh1: 30,          // not a sudden spike — steady recovery
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
  const mcap    = pair.fdv || pair.marketCap || 1;
  const ch1Raw  = pair.priceChange?.h1;                                 // null = no data
  const ch1     = ch1Raw == null ? null : parseFloat(ch1Raw);
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
  const volMcap = mcap > 0 ? vol24 / mcap : 0;

  // Universal hard filters
  const isSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
  const isEVM    = /^0x[0-9a-fA-F]{40}$/.test(addr);
  if (!isSolana && !isEVM) return null;
  if (liq < 3000)  return null;
  if (price <= 0)  return null;
  if (sells24 === 0 && buys24 > 10) return null; // honeypot guard

  // DEAD COIN GUARD: reject any coin where the 1h price change is missing or flat.
  // ch1 === null → DexScreener has no h1 data at all (coin too new / data gap).
  // ch1 === 0    → price did not move one pip in the last hour = zero trade activity.
  // Both cases mean there is nothing to trade; we skip them unconditionally.
  // A very small non-zero value combined with zero recent txns also signals a dead market.
  if (ch1 === null)                            return null; // no h1 data
  if (ch1 === 0)                               return null; // completely flat h1
  if (Math.abs(ch1) < 0.1 && m5Txns < 3)      return null; // near-flat + no recent txns

  const ageMinutes = (now - created) / 60000;
  const dexId      = pair.dexId || '';
  const isPumpFun  = dexId === 'pump-fun';

  // PUMP.FUN INFANT PROTECTION: coins < 20 min old are pre-pump / extreme rug risk
  // Skip entirely — the initial hype dies in minutes and most go to 0
  if (isPumpFun && ageMinutes < 20) return null;

  // PUMP.FUN YOUNG COIN extra requirements (20–60 min): tighter liquidity + buy pressure
  // Standard liq/buyPct minimums are too loose for coins this fresh
  if (isPumpFun && ageMinutes < 60 && liq < 15000) return null;
  if (isPumpFun && ageMinutes < 60 && buyPct < 62)  return null;

  const base = { addr, price, liq, vol24, buyPct, buys24, ch1, ch24, m5Ch, m5Txns, ageDays, ageMinutes, volMcap,
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
      }
    }

    else if (s.id === 1) {
      // ── ACTIVE MOMENTUM ────────────────────────────────────────────────────
      if (m5Txns < s.minM5Txns)  { match = false; }
      if (m5Ch < s.minM5Ch)      { match = false; } // POSITIVE direction required (was abs)
      if (ch1 < s.minCh1)        { match = false; }
      if (buyPct < s.minBuyPct)  { match = false; }
      if (liq < s.minLiq)        { match = false; }
      if (ageDays > s.maxAgeDays){ match = false; }
      if (match) {
        score += Math.min(20, m5Txns / 2);         // very active = more confidence
        if (m5Ch > 5)  score += 15; else if (m5Ch > 2) score += 8;
        if (buyPct > 65) score += 15; else if (buyPct > 58) score += 8;
        if (ch1 > 20)  score += 12; else if (ch1 > 8) score += 6;
        if (liq > 30000) score += 8; else if (liq > 15000) score += 4;
        if (volMcap > 1) score += 10; else if (volMcap > 0.4) score += 5;
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
      if (match) {
        score += Math.min(25, m5Ch * 3);             // bigger m5 move = higher score
        if (m5Txns > 50) score += 15; else if (m5Txns > 30) score += 10; else if (m5Txns > 20) score += 5;
        if (buyPct > 70) score += 15; else if (buyPct > 62) score += 8;
        if (m5Ch > 10)   score += 12; else if (m5Ch > 5) score += 7;   // speed of surge
        if (ch1 > 20)    score += 8;  else if (ch1 > 8)  score += 4;   // h1 momentum bonus
        if (liq > 20000) score += 6;  else if (liq > 8000) score += 3;
        // Penalty: volume/mcap ratio too extreme = possible wash trading
        if (volMcap > 10) score -= 10;
      }
    }

    else if (s.id === 3) {
      // ── OLD RECOVERY ───────────────────────────────────────────────────────
      if (ageDays < s.minAgeDays)  { match = false; }
      if (ch24 < s.minCh24)        { match = false; }
      if (ch1 < s.minCh1)          { match = false; }
      if (ch1 > s.maxCh1)          { match = false; } // spike guard
      if (buyPct < s.minBuyPct)    { match = false; }
      if (liq < s.minLiq)          { match = false; }
      if (buys24 < s.minBuys24)    { match = false; }
      if (match) {
        score += Math.min(15, ch24 / 3);
        if (ch1 > 8)  score += 12; else if (ch1 > 3) score += 6;
        if (buyPct > 55) score += 10; else if (buyPct > 50) score += 5;
        if (liq > 300000) score += 12; else if (liq > 150000) score += 7;
        if (buys24 > 200) score += 10; else if (buys24 > 100) score += 5;
        if (volMcap > 0.05) score += 5;
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
    await db.collection('paper_stats').doc(today).set(
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

// ─── REAL TRADE EXECUTION STUBS ───────────────────────────────────────────────
// These will be wired to actual chain SDKs in a future release.
// Solana: @solana/web3.js + Jupiter aggregator
// EVM (ETH/BSC/Base): ethers.js + 1inch or Uniswap v3 router
// Private key loaded from Fly.io secret: process.env[wallet.envKey + '_PRIVATE_KEY']
async function executeRealEntry(coin, wallet, posSize) {
  const privKey = process.env[`${wallet.envKey}_PRIVATE_KEY`] || '';
  if (!privKey) {
    console.warn(`[REAL] ⚠️  No private key for ${wallet.label} (${wallet.envKey}_PRIVATE_KEY). Simulating.`);
  }
  console.log(`[REAL] 🟡 ENTRY STUB — ${coin.symbol} | chain: ${coin.chain} | wallet: ${wallet.label} | $${posSize}`);
  // TODO: swap execution
  return { txHash: 'PENDING-REAL', executedPrice: coin.price };
}

async function executeRealExit(pos, wallet, exitPrice) {
  const privKey = process.env[`${wallet.envKey}_PRIVATE_KEY`] || '';
  if (!privKey) console.warn(`[REAL] ⚠️  No private key for ${wallet.label}.`);
  console.log(`[REAL] 🟡 EXIT STUB — ${pos.symbol} | chain: ${pos.chain} | wallet: ${wallet.label} | price: ${exitPrice}`);
  // TODO: swap execution
  return { txHash: 'PENDING-REAL', executedPrice: exitPrice };
}

async function getOpenPositions() {
  const now = Date.now();
  if (_posCache && now - _posCacheAt < POS_TTL) return _posCache;
  const snap  = await db.collection('paper_positions').where('status','==','open').get();
  _posCache   = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  _posCacheAt = now;
  return _posCache;
}

// ─── FIREBASE HELPERS ─────────────────────────────────────────────────────────

async function enterPosition(coin, overrides = {}) {
  const ref  = db.collection('paper_positions').doc();
  const s    = coin.strategy;
  const usePartial = !!s.usePartialProfit;
  const posSize    = overrides.size || POSITION_SIZE;

  // ── Trading mode & wallet ──────────────────────────────────────────────────
  const cfg        = await getTradingConfig();
  const tradingMode = cfg.tradingMode || 'paper';
  const coinChain  = normaliseChain(coin.chain);
  const wallet     = await selectWalletForChain(coinChain, cfg);

  // Real mode: execute swap (stub for now)
  let realTx = null;
  if (tradingMode === 'real' && wallet) {
    realTx = await executeRealEntry(coin, wallet, posSize);
  } else if (tradingMode === 'real' && !wallet) {
    console.warn(`[REAL] No wallet configured for chain "${coinChain}" — skipping ${coin.symbol}`);
    return null; // can't enter a real trade without a wallet
  }

  const pos = {
    symbol: coin.symbol, name: coin.name, address: coin.addr,
    chain: coin.chain, strategyId: s.id, strategyLabel: s.label,
    score: coin.score,
    entryPrice: coin.price,
    tp1: coin.price * s.tp1x,
    tp2: coin.price * s.tp2x,
    tp3: coin.price * s.tp3x,
    sl:  coin.price * s.slx,
    currentSL: coin.price * s.slx,
    initialTrailPct: s.initialTrailPct,
    trailingActive: false,
    size: posSize,
    remaining: 1.0,
    tp1Hit: false, tp2Hit: false,
    // Partial profit fields (Active Momentum + Surge)
    partialStage:    usePartial ? 0 : null,
    recoveredAmount: usePartial ? 0 : null,
    freeRide:        usePartial ? false : null,
    isManual:        overrides.isManual || false,
    // Young coin mode: quick 10/20/30% exits for Active Momentum coins < 1h old
    youngCoin: (s.id === 1 && (coin.ageMinutes || 0) < 60),
    status: 'open',
    enteredAt: Date.now(),
    dexUrl: coin.dexUrl,
    pnl: 0,
    peakPrice: coin.price,
    // ── Trade mode & wallet ──
    tradingMode,
    walletId:      wallet ? wallet.id      : null,
    walletLabel:   wallet ? wallet.label   : null,
    walletAddress: wallet ? wallet.address : null,
    walletChain:   wallet ? wallet.chain   : null,
    realTxEntry:   realTx ? realTx.txHash  : null,
  };
  await ref.set(pos);
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

async function updatePosition(id, data) {
  await db.collection('paper_positions').doc(id).update(data);
  // Patch cache in-place so TP/SL logic sees current state without re-querying
  if (_posCache) {
    const p = _posCache.find(p => p.id === id);
    if (p) Object.assign(p, data);
  }
}

async function closePosition(id, data) {
  const closeData = { ...data, status: 'closed', closedAt: Date.now() };
  // Use cached position to build history entry — avoids an extra Firestore read
  const cached = _posCache?.find(p => p.id === id);
  await db.collection('paper_positions').doc(id).update(closeData);
  if (cached) {
    await db.collection('paper_history').add({ ...cached, ...closeData });
  } else {
    const snap = await db.collection('paper_positions').doc(id).get();
    await db.collection('paper_history').add({ ...snap.data(), ...closeData });
  }
  // Remove from cache immediately
  if (_posCache) _posCache = _posCache.filter(p => p.id !== id);
}

async function getDailyStats() {
  const today  = new Date().toISOString().slice(0, 10);
  const doc    = await db.collection('paper_stats').doc(today).get();
  // Use paperBalance from config if set; fall back to env-based default
  const cfg    = await getTradingConfig();
  const expectedBalance = parseFloat(cfg.paperBalance || 0) || (POSITION_SIZE * MAX_POSITIONS);
  if (!doc.exists) {
    const init = {
      date: today, startBalance: expectedBalance,
      realizedPnL: 0, trades: 0, wins: 0, losses: 0,
      autoPnL: 0, autoTrades: 0, autoWins: 0,
      manualPnL: 0, manualTrades: 0, manualWins: 0,
    };
    await db.collection('paper_stats').doc(today).set(init);
    return init;
  }
  const data = doc.data();
  // Auto-correct startBalance if balance was topped up today
  if (data.startBalance !== expectedBalance) {
    await db.collection('paper_stats').doc(today).update({ startBalance: expectedBalance });
    data.startBalance = expectedBalance;
    console.log(`[BOT] startBalance updated: $${data.startBalance} → $${expectedBalance}`);
  }
  return data;
}

async function updateDailyStats(pnl, isWin, isManual = false) {
  const today = new Date().toISOString().slice(0,10);
  const base = {
    realizedPnL: FieldValue.increment(pnl),
    trades:      FieldValue.increment(1),
    wins:        FieldValue.increment(isWin ? 1 : 0),
    losses:      FieldValue.increment(isWin ? 0 : 1),
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
  await db.collection('paper_stats').doc(today).update(base);
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
  try {
    const doc = await db.collection('paper_config').doc('control').get();
    if (!doc.exists) return true; // default: running if no doc yet
    const data = doc.data();
    return data.running !== false;
  } catch { return true; } // on error, don't block trading
}

// ─── DAY RESTART ─────────────────────────────────────────────────────────────
// Called at the top of each scan/monitor cycle.
// If paper_config/control.restartDay == true → zero out today's P&L, clear
// in-memory state, resume trading.  Also handles real-mode restart (future).
async function checkDayRestart() {
  try {
    const doc = await db.collection('paper_config').doc('control').get();
    if (!doc.exists) return false;
    const data = doc.data();
    if (!data.restartDay) return false;

    // ── Perform restart ──
    const today = new Date().toISOString().slice(0, 10);
    const statsSnap = await db.collection('paper_stats').doc(today).get();
    const prevPnL   = statsSnap.exists ? (statsSnap.data().realizedPnL || 0) : 0;

    // Zero out today's P&L; accumulate total loss across restarts for transparency
    await db.collection('paper_stats').doc(today).set({
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
// Polls for /restart and /status commands from the authorized chat.
// Lightweight — runs every 30 s, uses long-poll with timeout=5.
async function pollTelegramCommands() {
  try {
    const path = `/bot${TELEGRAM_TOKEN}/getUpdates?offset=${telegramOffset}&timeout=5&allowed_updates=${encodeURIComponent('["message"]')}`;
    const r = await httpGet('api.telegram.org', path);
    const d = JSON.parse(r.body);
    if (!d.ok || !d.result?.length) return;

    for (const update of d.result) {
      telegramOffset = update.update_id + 1;
      const text   = (update.message?.text || '').trim().toLowerCase();
      const chatId = String(update.message?.chat?.id || '');

      if (chatId !== String(TELEGRAM_CHAT)) continue; // ignore strangers

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
        const state   = dayHaltedToday ? '🚨 HALTED (daily limit)' : '✅ Running';
        await sendTelegram(
          `📊 *STATUS*\n\n` +
          `${state} · *${mode} mode*\n` +
          `Daily P&L: *${pnlStr}* (${pct}%)\n` +
          `Balance: $${(cfg.paperBalance || POSITION_SIZE * MAX_POSITIONS).toFixed(2)}\n` +
          `Limit: ${(DAILY_LOSS_LIMIT * 100).toFixed(0)}%\n\n` +
          `_Commands: /mode paper|real · /wallets · /addfunds <$> · /restart_`
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

      // ── /help ─────────────────────────────────────────────────────────────────
      if (text === '/help') {
        await sendTelegram(
          `📋 *MemeScan Bot Commands*\n\n` +
          `/status — P&L, mode, balance\n` +
          `/mode paper — switch to paper trading\n` +
          `/mode real — switch to real trading\n` +
          `/wallets — list connected wallets\n` +
          `/addfunds 500 — add $500 to balance\n` +
          `/restart — reset daily loss counter\n`
        );
      }
    }
  } catch(e) {
    console.error('[TELEGRAM-POLL]', e.message);
  }
}

async function monitorPositions() {
  if (!(await isBotRunning())) return;

  // Check for day-restart and add-funds requests before anything else
  await checkDayRestart();
  const cfg = await getTradingConfig();
  await checkAddFunds(cfg);

  const positions = await getOpenPositions();
  if (!positions.length) return;

  const stats = await getDailyStats();
  if (stats.realizedPnL / stats.startBalance <= DAILY_LOSS_LIMIT) {
    if (!dayHaltedToday) {
      // First time crossing the limit this session — close all and notify
      console.log('[BOT] Daily loss limit hit — closing all positions');
      dayHaltedToday = true;
      for (const pos of positions) {
        const price = await getCurrentPrice(pos.address, pos.chain) || pos.entryPrice;
        const pnl = (price - pos.entryPrice) / pos.entryPrice * pos.size * pos.remaining;
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

  for (const pos of positions) {
    const isManual = !!pos.isManual;

    // ── MANUAL CLOSE REQUEST (user tapped "Sell Now" on dashboard) ─────────
    if (pos.closeRequested) {
      const price = await getCurrentPrice(pos.address, pos.chain) || pos.entryPrice;
      const pnl   = (price - pos.entryPrice) / pos.entryPrice * pos.size * pos.remaining;
      await closePosition(pos.id, { exitPrice: price, exitReason: 'MANUAL_CLOSE', pnl });
      await updateDailyStats(pnl, pnl > 0, isManual);
      enteredToday.delete(pos.address);
      await sendTelegram(
        `🚫 *MANUAL CLOSE*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
        `Exit: $${fmtPrice(price)} | P&L: *${pnl>=0?'+':''}$${pnl.toFixed(2)}*`
      );
      continue;
    }

    // Auto-close after 7 days
    if (Date.now() - pos.enteredAt > 7 * 86400000) {
      const price = await getCurrentPrice(pos.address, pos.chain) || pos.entryPrice;
      const pnl = (price - pos.entryPrice) / pos.entryPrice * pos.size * pos.remaining;
      await closePosition(pos.id, { exitPrice: price, exitReason: 'EXPIRED', pnl });
      await updateDailyStats(pnl, pnl > 0, isManual);
      await sendTelegram(`⏰ *EXPIRED* — *${pos.symbol}*\nExit: $${fmtPrice(price)} | P&L: ${pnl>=0?'+':''}$${pnl.toFixed(2)}`);
      enteredToday.delete(pos.address);
      continue;
    }

    const price = await getCurrentPrice(pos.address, pos.chain);
    if (!price || price <= 0) continue;

    const gain    = (price - pos.entryPrice) / pos.entryPrice; // e.g. 0.50 = +50%
    const gainPct = gain * 100;
    let updates   = {};
    let alertMsg  = null;

    // ── PEAK PRICE TRACKER ─────────────────────────────────────────────────
    // Track highest price seen — used for rug detection & trailing SL base
    const peak = pos.peakPrice || pos.entryPrice;
    if (price > peak * 1.05) {          // only write to Firestore every 5% rise
      updates.peakPrice = price;
      pos.peakPrice = price;            // patch cache immediately
    }
    const currentPeak = pos.peakPrice || peak;

    // ── RUG DETECTION — EMERGENCY EXIT ────────────────────────────────────
    // If price crashes >40% from peak in a single 5s tick AND we were profitable,
    // exit immediately before it goes to near-zero
    if (currentPeak > pos.entryPrice * 1.15 && price < currentPeak * 0.60) {
      const pnl = gain * pos.size * pos.remaining;
      await closePosition(pos.id, { exitPrice: price, exitReason: 'RUG_DETECTED', pnl });
      await updateDailyStats(pnl, pnl > 0, isManual);
      recentSLCoins.set(pos.address, Date.now()); // block re-entry for 6h
      const dropPct = ((price / currentPeak - 1) * 100).toFixed(0);
      await sendTelegram(
        `⚠️ *RUG DETECTED — EMERGENCY EXIT*\n\n` +
        `*${pos.symbol}* ${pos.strategyLabel}\n` +
        `📉 Dropped *${dropPct}%* from peak in one tick\n` +
        `📥 Entry: $${fmtPrice(pos.entryPrice)} → Exit: $${fmtPrice(price)}\n` +
        `📊 P&L: *${pnl>=0?'+':''}$${pnl.toFixed(2)}*\n🔗 [Chart](${pos.dexUrl})`
      );
      console.log(`[BOT] RUG_DETECTED ${pos.symbol}: peak $${fmtPrice(currentPeak)} → now $${fmtPrice(price)} (${dropPct}%)`);
      continue;
    }

    // ── STOP LOSS ──────────────────────────────────────────────────────────
    if (price <= pos.currentSL) {
      const pnl = gain * pos.size * pos.remaining;
      await closePosition(pos.id, { exitPrice: price, exitReason: 'STOP_LOSS', pnl });
      await updateDailyStats(pnl, false, isManual);
      recentSLCoins.set(pos.address, Date.now()); // block re-entry for 6h — prevents triple entries
      await sendTelegram(
        `🛑 *STOP LOSS HIT*\n\n` +
        `*${pos.symbol}* ${pos.strategyLabel}\n` +
        `📥 Entry: $${fmtPrice(pos.entryPrice)} → Exit: $${fmtPrice(price)}\n` +
        `🛑 SL: $${fmtPrice(pos.currentSL)} | Trail: ${calcTrailPct(pos.initialTrailPct, gainPct).toFixed(1)}%\n` +
        `📊 P&L: *${pnl>=0?'+':''}$${pnl.toFixed(2)}*\n🔗 [Chart](${pos.dexUrl})`
      );
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
    if (!pos.tpDisabled && pos.partialStage !== null) {
      const stage  = pos.partialStage || 0;
      const target = pos.size * 1.2; // recover 120% of investment

      if (pos.youngCoin) {
        // ── YOUNG COIN MODE: quick 10 / 20 / 30% ──────────────────────────
        if (stage === 0 && price >= pos.entryPrice * 1.10) {
          const frac     = 0.30;
          const proceeds = frac * pos.size * (price / pos.entryPrice);
          const partPnL  = proceeds - frac * pos.size;
          const newRec   = (pos.recoveredAmount || 0) + proceeds;
          updates = { partialStage:1, remaining: pos.remaining - frac,
            recoveredAmount: newRec, pnl: FieldValue.increment(partPnL) };
          await updatePosition(pos.id, updates); await updateDailyStats(partPnL, true, isManual);
          alertMsg = `🔥 *YOUNG COIN — 30% SOLD (+10%)*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
            `⚡ Quick exit: coin is <1h old\n` +
            `💰 Proceeds: $${proceeds.toFixed(2)} | P&L: +$${partPnL.toFixed(2)}\n` +
            `🎯 Riding 70% — next exit at +20%\n🔗 [Chart](${pos.dexUrl})`;
          Object.assign(pos, updates);
        }
        else if (stage === 1 && price >= pos.entryPrice * 1.20) {
          const frac     = 0.30;
          const proceeds = frac * pos.size * (price / pos.entryPrice);
          const partPnL  = proceeds - frac * pos.size;
          const newRec   = (pos.recoveredAmount || 0) + proceeds;
          updates = { partialStage:2, remaining: pos.remaining - frac,
            recoveredAmount: newRec, pnl: FieldValue.increment(partPnL) };
          await updatePosition(pos.id, updates); await updateDailyStats(partPnL, true, isManual);
          alertMsg = `🔥 *YOUNG COIN — 30% MORE SOLD (+20%)*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
            `💰 Proceeds: $${proceeds.toFixed(2)} | P&L: +$${partPnL.toFixed(2)}\n` +
            `🎯 Riding 40% — next exit at +30%\n🔗 [Chart](${pos.dexUrl})`;
          Object.assign(pos, updates);
        }
        else if (stage === 2 && price >= pos.entryPrice * 1.30) {
          const frac     = 0.30;
          const proceeds = frac * pos.size * (price / pos.entryPrice);
          const partPnL  = proceeds - frac * pos.size;
          const newRec   = (pos.recoveredAmount || 0) + proceeds;
          // After 3 quick exits: 10% remains riding on tight trailing SL only
          updates = { partialStage:3, remaining: pos.remaining - frac,
            recoveredAmount: newRec, freeRide: newRec >= target,
            pnl: FieldValue.increment(partPnL),
            // Tighten SL to 5% after final quick exit — protect the last 10%
            currentSL: price * 0.95, initialTrailPct: 8 };
          await updatePosition(pos.id, updates); await updateDailyStats(partPnL, true, isManual);
          alertMsg = `🔥 *YOUNG COIN — FINAL QUICK EXIT (+30%)*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
            `💰 Proceeds: $${proceeds.toFixed(2)} | P&L: +$${partPnL.toFixed(2)}\n` +
            `🎯 10% remains on tight 5% trailing SL — ride or die!\n🔗 [Chart](${pos.dexUrl})`;
          Object.assign(pos, updates);
        }
      } else {
        // ── NORMAL MODE: standard 50 / 100 / 200% stages ─────────────────
        if (stage === 0 && price >= pos.entryPrice * 1.5) {
          const frac     = 0.25;
          const proceeds = frac * pos.size * (price / pos.entryPrice);
          const partPnL  = proceeds - frac * pos.size;
          const newRec   = (pos.recoveredAmount || 0) + proceeds;
          updates = { partialStage:1, remaining: pos.remaining - frac,
            recoveredAmount: newRec, pnl: FieldValue.increment(partPnL) };
          await updatePosition(pos.id, updates); await updateDailyStats(partPnL, true, isManual);
          alertMsg = `⚡ *STAGE 1 — 25% SOLD (+50%)*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
            `💰 Proceeds: $${proceeds.toFixed(2)} | P&L: +$${partPnL.toFixed(2)}\n` +
            `🎯 Recovered $${newRec.toFixed(2)} / $${target.toFixed(2)} — riding 75%\n🔗 [Chart](${pos.dexUrl})`;
          Object.assign(pos, updates);
        }
        else if (stage === 1 && price >= pos.entryPrice * 2.0) {
          const frac     = 0.30;
          const proceeds = frac * pos.size * (price / pos.entryPrice);
          const partPnL  = proceeds - frac * pos.size;
          const newRec   = (pos.recoveredAmount || 0) + proceeds;
          const fr       = newRec >= target;
          updates = { partialStage:2, remaining: pos.remaining - frac,
            recoveredAmount: newRec, freeRide: fr, pnl: FieldValue.increment(partPnL) };
          await updatePosition(pos.id, updates); await updateDailyStats(partPnL, true, isManual);
          alertMsg = `⚡ *STAGE 2 — 30% SOLD (+100%)*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
            `💰 Proceeds: $${proceeds.toFixed(2)} | P&L: +$${partPnL.toFixed(2)}\n` +
            `🎯 Recovered $${newRec.toFixed(2)}${fr?' ✅ FREE RIDE!':''}\n🔗 [Chart](${pos.dexUrl})`;
          Object.assign(pos, updates);
        }
        else if (stage === 2 && price >= pos.entryPrice * 3.0) {
          const frac     = Math.min(0.15, pos.remaining - 0.10);
          const proceeds = frac * pos.size * (price / pos.entryPrice);
          const partPnL  = proceeds - frac * pos.size;
          const newRec   = (pos.recoveredAmount || 0) + proceeds;
          updates = { partialStage:3, remaining: pos.remaining - frac,
            recoveredAmount: newRec, freeRide: true, pnl: FieldValue.increment(partPnL) };
          await updatePosition(pos.id, updates); await updateDailyStats(partPnL, true, isManual);
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
      if (!pos.tp1Hit && price >= pos.tp1) {
        const partPnL = gain * pos.size * 0.50;
        updates = { tp1Hit:true, remaining: pos.remaining - 0.50,
          currentSL: pos.entryPrice * 1.01, trailingActive:true, pnl: FieldValue.increment(partPnL) };
        await updatePosition(pos.id, updates); await updateDailyStats(partPnL, true, isManual);
        alertMsg = `✅ *TP1 HIT — 50% SOLD*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
          `Entry: $${fmtPrice(pos.entryPrice)} → $${fmtPrice(price)}\n` +
          `💰 +$${partPnL.toFixed(2)} | SL → breakeven\n🔗 [Chart](${pos.dexUrl})`;
        Object.assign(pos, updates);
      }
      else if (pos.tp1Hit && !pos.tp2Hit && price >= pos.tp2) {
        const partPnL = gain * pos.size * 0.30;
        updates = { tp2Hit:true, remaining: pos.remaining - 0.30,
          currentSL: pos.tp1 * 0.99, pnl: FieldValue.increment(partPnL) };
        await updatePosition(pos.id, updates); await updateDailyStats(partPnL, true, isManual);
        alertMsg = `🎯 *TP2 HIT — 30% SOLD*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
          `💰 +$${partPnL.toFixed(2)} | SL → TP1 level\n🔗 [Chart](${pos.dexUrl})`;
        Object.assign(pos, updates);
      }
      else if (pos.tp1Hit && pos.tp2Hit && price >= pos.tp3) {
        const partPnL = gain * pos.size * pos.remaining;
        await closePosition(pos.id, { exitPrice: price, exitReason:'TP3', pnl: FieldValue.increment(partPnL) });
        await updateDailyStats(partPnL, true, isManual);
        enteredToday.delete(pos.address);
        await sendTelegram(`🏆 *TP3 — FULL EXIT*\n*${pos.symbol}* ${pos.strategyLabel}\n` +
          `Entry: $${fmtPrice(pos.entryPrice)} → $${fmtPrice(price)}\n` +
          `💰 Final: +$${partPnL.toFixed(2)}\n🔗 [Chart](${pos.dexUrl})`);
        continue;
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // ── PROGRESSIVE TRAILING SL — ALL STRATEGIES, EVERY TICK ─────────────
    // Tightens as price rises, floors at 5%
    // ══════════════════════════════════════════════════════════════════════
    if (gainPct > 0) {
      const trailPct  = calcTrailPct(pos.initialTrailPct, gainPct);
      const newSL     = price * (1 - trailPct / 100);
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

  // ── Dynamic score threshold — fill slots aggressively when many are empty ──
  // 6+ vacant → 45  |  3–5 vacant → 50  |  1–2 vacant → normal 60
  const scoreThreshold = vacantSlots >= 6 ? 45 : vacantSlots >= 3 ? 50 : MIN_SCORE;
  if (vacantSlots >= 3) console.log(`[BOT] ${vacantSlots} slots vacant — score threshold: ${scoreThreshold}`);

  // Fetch candidates from DexScreener
  const keywords = ['meme','pepe','dog','cat','inu','moon','elon','baby','pump','shib'];
  // When urgently filling (5+ vacant), cast a wider net
  if (vacantSlots >= 5) {
    keywords.push('sol','grok','ai','doge','floki','frog','chad','coin','trump','wojak');
  }
  const seen = new Set();
  const candidates = [];

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

  // Clean up expired SL blocks (older than 6h)
  const nowTs = Date.now();
  for (const [addr, ts] of recentSLCoins) {
    if (nowTs - ts > SL_BLOCK_MS) recentSLCoins.delete(addr);
  }

  // Score and match each candidate to a strategy
  const openAddrs = new Set(positions.map(p => p.address));
  const matches   = [];

  for (const pair of candidates) {
    const addr = pair.baseToken?.address || '';
    if (openAddrs.has(addr) || enteredToday.has(addr) || recentSLCoins.has(addr)) continue;

    const result = detectStrategy(pair, openStrategies);
    if (result && result.score >= scoreThreshold) {
      matches.push(result);
    }
  }

  // Sort by score, enter top matches (one per unique address)
  matches.sort((a,b) => b.score - a.score);
  const usedThisScan = new Set();

  for (const coin of matches) {
    if (positions.length >= MAX_POSITIONS) break;
    if (usedThisScan.has(coin.addr)) continue;
    // Check cooldown
    const last = alertCooldown.get(coin.addr) || 0;
    if (Date.now() - last < 30 * 60 * 1000) continue;
    // Check slot still available (may have been filled earlier in this loop)
    if (slotCount[coin.strategy.id] >= coin.strategy.maxSlots) continue;

    alertCooldown.set(coin.addr, Date.now());
    const pos = await enterPosition(coin);
    if (!pos) continue; // null = real mode with no matching wallet for this chain
    enteredToday.add(coin.addr);
    usedThisScan.add(coin.addr);
    positions.push(pos);
    slotCount[coin.strategy.id]++;

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

    const pumpBadge = coin.isPumpFun ? `🎪 Pump.fun${isYoung?' · YOUNG COIN':''}\n` : '';
    await sendTelegram(
      `📊 *PAPER TRADE ENTRY*\n\n` +
      `*${coin.symbol}* — ${coin.name}\n` +
      `${s.label} · Score: *${coin.score}/100*\n` +
      `${pumpBadge}` +
      `💡 ${s.desc}\n\n` +
      `💵 Entry: $${fmtPrice(coin.price)}\n` +
      `💰 Position: $${pos.size}${pos.tradingMode === 'real' ? ` 💰 REAL` : ` (paper)`}${pos.walletLabel ? ` · ${pos.walletLabel}` : ''}\n` +
      `📊 Buy%: ${coin.buyPct.toFixed(0)}% | Liq: $${(coin.liq/1000).toFixed(0)}k\n` +
      `📈 Age: ${ageLabel} | m5: ${coin.m5Ch>0?'+':''}${coin.m5Ch.toFixed(1)}% | h1: ${coin.ch1>0?'+':''}${coin.ch1.toFixed(1)}%\n\n` +
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

  let slotLines = STRATEGIES.map(s =>
    `  ${s.label}: ${slotCount[s.id]}/${s.maxSlots}`
  ).join('\n');

  await sendTelegram(
    `📊 *MEMESCAN — HOURLY*\n\n` +
    `💰 Daily P&L: *${stats.realizedPnL>=0?'+':''}$${stats.realizedPnL.toFixed(2)}*\n` +
    `📈 Win rate: ${winRate}% (${stats.wins}W/${stats.losses}L)\n` +
    `🔓 Positions: ${positions.length}/${MAX_POSITIONS}\n\n` +
    `*Slots:*\n${slotLines}`
  );
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────
async function main() {
  console.log('[BOT] MemeScan PRO — 4-Strategy Bot starting...');
  const startCfg  = await getTradingConfig();
  const startMode = (startCfg.tradingMode || 'paper').toUpperCase();
  const wallets   = await getWallets();
  const walletLine = wallets.length
    ? `👛 ${wallets.length} wallet(s): ${wallets.map(w => w.chain).join(', ')}`
    : `👛 No wallets configured (/wallets to set up)`;

  await sendTelegram(
    `✅ *MemeScan PRO — 4-STRATEGY BOT LIVE*\n\n` +
    `📉 Bottom Bounce: 3 slots\n` +
    `⚡ Active Momentum: 3 slots\n` +
    `🚀 Surge Catch: 2 slots\n` +
    `📈 Old Recovery: 2 slots\n\n` +
    `💰 $${POSITION_SIZE}/position · 🛑 Daily limit: 30%\n` +
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

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });

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

function httpGet(hostname, path) {
  return new Promise(resolve => {
    const req = https.request({
      hostname, path, method:'GET', timeout:10000,
      headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0'},
    }, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({status:res.statusCode,body:d}));
    });
    req.on('error', () => resolve({status:500,body:'{}'}));
    req.on('timeout', () => { req.destroy(); resolve({status:504,body:'{}'}); });
    req.end();
  });
}
