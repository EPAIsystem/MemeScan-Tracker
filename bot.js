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
    minAbsM5Ch: 1.0,     // at least 1% price move in 5 min
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
  const ch1     = parseFloat(pair.priceChange?.h1  || 0);
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

  const base = { addr, price, liq, vol24, buyPct, buys24, ch1, ch24, m5Ch, m5Txns, ageDays, volMcap,
    symbol: pair.baseToken?.symbol || '???',
    name:   pair.baseToken?.name   || '',
    chain:  pair.chainId || 'unknown',
    dexUrl: `https://dexscreener.com/${pair.chainId}/${addr}`,
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
      if (m5Txns < s.minM5Txns)             { match = false; }
      if (Math.abs(m5Ch) < s.minAbsM5Ch)    { match = false; }
      if (ch1 < s.minCh1)                   { match = false; }
      if (buyPct < s.minBuyPct)             { match = false; }
      if (liq < s.minLiq)                   { match = false; }
      if (ageDays > s.maxAgeDays)           { match = false; }
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
let scanCount = 0;

// ─── POSITION CACHE ───────────────────────────────────────────────────────────
// Reduces Firestore reads from ~250K/day to ~1.5K/day
// Full re-query every 60s; individual updates/closes patch in-place.
let _posCache   = null;
let _posCacheAt = 0;
const POS_TTL   = 60000; // 60 seconds between full re-queries

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
  const ref = db.collection('paper_positions').doc();
  const s   = coin.strategy;
  const usePartial = !!s.usePartialProfit;
  const posSize = overrides.size || POSITION_SIZE;
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
    status: 'open',
    enteredAt: Date.now(),
    dexUrl: coin.dexUrl,
    pnl: 0,
    peakPrice: coin.price,  // track highest price seen — for rug detection
  };
  await ref.set(pos);
  const newPos = { id: ref.id, ...pos };
  // Add to cache immediately so next cycle sees it without a Firestore read
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
  const today           = new Date().toISOString().slice(0,10);
  const doc             = await db.collection('paper_stats').doc(today).get();
  const expectedBalance = POSITION_SIZE * MAX_POSITIONS;
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
  // Auto-correct startBalance if MAX_POSITIONS or POSITION_SIZE changed
  if (data.startBalance !== expectedBalance) {
    await db.collection('paper_stats').doc(today).update({ startBalance: expectedBalance });
    data.startBalance = expectedBalance;
    console.log(`[BOT] startBalance corrected: $${data.startBalance} → $${expectedBalance}`);
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

async function monitorPositions() {
  if (!(await isBotRunning())) return;
  const positions = await getOpenPositions();
  if (!positions.length) return;

  const stats = await getDailyStats();
  if (stats.realizedPnL / stats.startBalance <= DAILY_LOSS_LIMIT) {
    console.log('[BOT] Daily loss limit — closing all');
    for (const pos of positions) {
      const price = await getCurrentPrice(pos.address, pos.chain) || pos.entryPrice;
      const pnl = (price - pos.entryPrice) / pos.entryPrice * pos.size * pos.remaining;
      await closePosition(pos.id, { exitPrice: price, exitReason: 'DAILY_LIMIT', pnl });
      await sendTelegram(`🚨 *DAILY LOSS LIMIT*\n*${pos.symbol}* closed. P&L: ${pnl>=0?'+':''}$${pnl.toFixed(2)}`);
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
      enteredToday.delete(pos.address);
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
      enteredToday.delete(pos.address);
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
    // ── PARTIAL PROFIT SYSTEM (Active Momentum + Surge Catch) ────────────
    // Stage 0 → +50%: sell 25%
    // Stage 1 → +100%: sell 30%
    // Stage 2 → +200%: sell 15%, mark free ride
    // ══════════════════════════════════════════════════════════════════════
    if (!pos.tpDisabled && pos.partialStage !== null) {
      const stage     = pos.partialStage || 0;
      const target    = pos.size * 1.2; // recover 120% of investment

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

  // Score and match each candidate to a strategy
  const openAddrs = new Set(positions.map(p => p.address));
  const matches   = [];

  for (const pair of candidates) {
    const addr = pair.baseToken?.address || '';
    if (openAddrs.has(addr) || enteredToday.has(addr)) continue;

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
    enteredToday.add(coin.addr);
    usedThisScan.add(coin.addr);
    positions.push(pos);
    slotCount[coin.strategy.id]++;

    const s = coin.strategy;
    const tpInfo = s.usePartialProfit
      ? `🎯 Stage 1 (+50%): sell 25%\n🎯 Stage 2 (+100%): sell 30%\n🎯 Stage 3 (+200%): sell 15% → free ride\n`
      : `🎯 TP1: $${fmtPrice(coin.price * s.tp1x)} (+${((s.tp1x-1)*100).toFixed(0)}%) → 50%\n` +
        `🎯 TP2: $${fmtPrice(coin.price * s.tp2x)} (+${((s.tp2x-1)*100).toFixed(0)}%) → 30%\n` +
        `🎯 TP3: $${fmtPrice(coin.price * s.tp3x)} (+${((s.tp3x-1)*100).toFixed(0)}%) → 20%\n`;

    await sendTelegram(
      `📊 *PAPER TRADE ENTRY*\n\n` +
      `*${coin.symbol}* — ${coin.name}\n` +
      `${s.label} · Score: *${coin.score}/100*\n` +
      `💡 ${s.desc}\n\n` +
      `💵 Entry: $${fmtPrice(coin.price)}\n` +
      `💰 Position: $${POSITION_SIZE} (paper)\n` +
      `📊 Buy%: ${coin.buyPct.toFixed(0)}% | Liq: $${(coin.liq/1000).toFixed(0)}k\n` +
      `📈 m5: ${coin.m5Ch>0?'+':''}${coin.m5Ch.toFixed(1)}% | h1: ${coin.ch1>0?'+':''}${coin.ch1.toFixed(1)}% | 24h: ${coin.ch24>0?'+':''}${coin.ch24.toFixed(1)}%\n\n` +
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
  await sendTelegram(
    `✅ *MemeScan PRO — 4-STRATEGY BOT LIVE*\n\n` +
    `📉 Bottom Bounce: 3 slots\n` +
    `⚡ Active Momentum: 3 slots\n` +
    `🚀 Surge Catch: 2 slots\n` +
    `📈 Old Recovery: 2 slots\n\n` +
    `💰 $${POSITION_SIZE}/position · 🛑 Daily limit: 30%\n` +
    `⏱ Scanning every 15 seconds`
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
