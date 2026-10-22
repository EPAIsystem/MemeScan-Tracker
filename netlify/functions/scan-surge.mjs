// MemeScan PRO - Surge Watch
// Netlify Scheduled Function. Runs every 5 min (set in netlify.toml).
//
// What it does:
//  1. Scans Solana + Ethereum for newly-listed DEX pools (GeckoTerminal "new_pools").
//     On Solana this IS "post-graduation" - pump.fun tokens only get a DEX pool
//     once they graduate off the bonding curve, so new_pools already excludes
//     pre-graduation tokens automatically.
//  2. Keeps a watchlist (Netlify Blobs) of tokens aged 4h-48h with mcap 30k-120k.
//  3. Pulls recent candles (RSI/MACD/EMA/Bollinger) AND recent individual trades
//     (to count real buys-per-minute) for each watched token.
//  4. Fires a Telegram alert ONLY when the token has bottomed and is turning up
//     AND buy pace clears an age-tiered bar:
//       4h-20h old  -> >= 5 buys/min
//       20h-48h old -> >= 3 buys/min
//     Dead/non-performing tokens are never surfaced.
//
// Env vars needed (Netlify site settings -> Environment variables):
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   (reuse the ones your existing alerts use)

import { getStore } from '@netlify/blobs';

// ---------- tunables ----------
const CHAINS = { solana: 'solana', eth: 'eth' }; // GeckoTerminal network ids
const MCAP_MIN = 30_000;
const MCAP_MAX = 120_000;
const AGE_MIN_MS = 4 * 3600 * 1000;    // start watching at 4h old
const AGE_MAX_MS = 48 * 3600 * 1000;   // stop watching at 48h old
const MIN_LIQUIDITY_USD = 25_000;      // "performing" floor - below this we never alert
const REALERT_COOLDOWN_MS = 2 * 3600 * 1000; // don't re-alert the same token sooner than this
// Three age tiers: younger tokens need to buy faster to count as "surging";
// older ones get credit for a slower-but-real pace.
const TIER_1_MAX_MS = 12 * 3600 * 1000; // 4h-12h
const TIER_2_MAX_MS = 20 * 3600 * 1000; // 12h-20h (TIER_2_MAX_MS to AGE_MAX_MS = "after a day")
const BUY_RATE_TIER1 = 5;  // 4h-12h
const BUY_RATE_TIER2 = 4;  // 12h-20h
const BUY_RATE_TIER3 = 3;  // 20h-48h
const BUY_RATE_WINDOW_MIN = 5; // average buys/min over this many trailing minutes

// What counts as a real prior pump before the bottom (not just flat chop):
const MIN_RUNUP = 1.3;    // peak must be >= 30% above the earliest price we can see
const MIN_DRAWDOWN = 0.25; // then must have pulled back >= 25% off that peak (the "bottom")
const MIN_RECOVERY = 0.05; // and now be >= 5% back up off that bottom (recovery underway)
const GT = 'https://api.geckoterminal.com/api/v2';
const sleep = ms => new Promise(res => setTimeout(res, ms));

// ---------- indicator math ----------
function ema(values, period) {
  const k = 2 / (period + 1);
  let out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  const avgG = gains / period, avgL = losses / period;
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}
function macd(closes) {
  if (closes.length < 35) return null;
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const macdLine = closes.map((_, i) => e12[i] - e26[i]);
  const signal = ema(macdLine, 9);
  const hist = macdLine.map((v, i) => v - signal[i]);
  return { macd: macdLine.at(-1), signal: signal.at(-1), hist: hist.at(-1), prevHist: hist.at(-2) };
}
function bollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { upper: mean + mult * sd, lower: mean - mult * sd, mid: mean, width: (2 * mult * sd) / mean };
}

// ---------- GeckoTerminal fetch helpers ----------
async function fetchNewPools(network, page) {
  const r = await fetch(`${GT}/networks/${network}/new_pools?page=${page}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`new_pools ${network} p${page}: ${r.status}`);
  return (await r.json()).data || [];
}
async function fetchOhlcv(network, poolAddr) {
  // 15-minute candles, enough history for MACD(26) + signal(9) + Bollinger(20)
  const r = await fetch(`${GT}/networks/${network}/pools/${poolAddr}/ohlcv/minute?aggregate=15&limit=200`, { headers: { Accept: 'application/json' } }); // 200 x 15min ~= 50h, enough to see the full post-graduation life
  if (!r.ok) return null;
  const j = await r.json();
  const list = j?.data?.attributes?.ohlcv_list || []; // [ts, open, high, low, close, volume], oldest first after reverse
  return list.reverse().map(c => ({ t: c[0] * 1000, o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] }));
}

// Recent individual trades (not candles) - needed to count real buys/minute.
// GeckoTerminal returns up to the last ~300 trades for the pool.
async function fetchTrades(network, poolAddr) {
  const r = await fetch(`${GT}/networks/${network}/pools/${poolAddr}/trades`, { headers: { Accept: 'application/json' } });
  if (!r.ok) return [];
  const j = await r.json();
  const rows = j?.data || [];
  return rows.map(t => ({
    t: new Date(t.attributes.block_timestamp).getTime(),
    kind: t.attributes.kind, // "buy" | "sell"
  }));
}

// Average buys/min over the trailing BUY_RATE_WINDOW_MIN minutes.
function buysPerMinute(trades, now = Date.now()) {
  const windowMs = BUY_RATE_WINDOW_MIN * 60 * 1000;
  const since = now - windowMs;
  const buys = trades.filter(t => t.t >= since && t.kind === 'buy').length;
  return buys / BUY_RATE_WINDOW_MIN;
}

// ---------- trigger logic ----------
// A token only counts as "surging" if it (1) had a real prior pump on real volume,
// (2) pulled back meaningfully off that peak - the actual bottom, (3) is now
// recovering off that bottom, confirmed by indicators, and (4) is buying fast
// enough for its age tier. Flat/noisy tokens that never ran never qualify,
// no matter what the indicators say in isolation.
function evaluateSetup(candles, trades, ageMs) {
  if (!candles || candles.length < 35) return { fire: false, reason: 'not enough candle history yet' };
  const closes = candles.map(c => c.c);
  const last = candles.at(-1);

  // 0. Did this token actually pump, then correct, on real volume? Find the
  //    highest close so far, then the lowest close after that peak (the bottom).
  let peakIdx = 0;
  for (let i = 1; i < closes.length; i++) if (closes[i] > closes[peakIdx]) peakIdx = i;
  const peak = closes[peakIdx];
  const earliest = closes[0];
  let troughIdx = peakIdx, trough = peak;
  for (let i = peakIdx; i < closes.length; i++) if (closes[i] < trough) { trough = closes[i]; troughIdx = i; }

  const runUp = peak / earliest;
  const drawdown = (peak - trough) / peak;
  const recoveryFromTrough = (last.c - trough) / trough;
  // real volume during the pump leg (not a price wick on zero volume)
  const pumpLegVol = candles.slice(0, peakIdx + 1).reduce((s, c) => s + c.v, 0);

  const hadRealRun =
    runUp >= MIN_RUNUP &&
    drawdown >= MIN_DRAWDOWN &&
    troughIdx < closes.length - 1 &&      // the bottom isn't literally right now, i.e. it has started recovering
    recoveryFromTrough >= MIN_RECOVERY &&
    pumpLegVol > 0;

  const bb = bollinger(closes);
  const r = rsi(closes);
  const m = macd(closes);
  const e9 = ema(closes, 9).at(-1);
  if (!bb || r === null || !m) return { fire: false, reason: 'indicators not ready' };

  // bottomed (micro-confirmation): band squeeze or two higher lows right now
  const widths = [];
  for (let i = 20; i < closes.length; i++) {
    const bbi = bollinger(closes.slice(0, i + 1));
    if (bbi) widths.push(bbi.width);
  }
  const avgWidth = widths.length ? widths.reduce((a, b) => a + b, 0) / widths.length : bb.width;
  const squeeze = bb.width < avgWidth * 0.85;
  const lows = candles.slice(-6).map(c => c.l);
  const higherLows = lows[lows.length - 1] > lows[0] && lows[lows.length - 3] > lows[0];
  const bottomed = squeeze || higherLows;

  // RSI recovering from weakness, not already overbought
  const rsiTurning = r > 40 && r < 70;

  // MACD bullish cross + price reclaiming short EMA
  const macdCross = m.prevHist <= 0 && m.hist > 0;
  const aboveEma = last.c > e9;
  const turningUp = macdCross && aboveEma;

  // age-tiered buy pace
  const bpm = buysPerMinute(trades);
  const minBpm = ageMs <= TIER_1_MAX_MS ? BUY_RATE_TIER1 : ageMs <= TIER_2_MAX_MS ? BUY_RATE_TIER2 : BUY_RATE_TIER3;
  const buyRateOk = bpm >= minBpm;

  const fire = hadRealRun && bottomed && rsiTurning && turningUp && buyRateOk;
  return {
    fire, rsi: r.toFixed(1), hadRealRun, bottomed, turningUp,
    runUp: runUp.toFixed(2), drawdown: (drawdown * 100).toFixed(0),
    buysPerMin: bpm.toFixed(1), minBpm,
  };
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { console.log('Telegram env vars missing, alert not sent:', text); return; }
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
}

export default async () => {
  const store = getStore('surge-watch');
  const state = (await store.get('state', { type: 'json' })) || {};
  const now = Date.now();
  let scanned = 0, watching = 0, alerted = 0;

  for (const [label, network] of Object.entries(CHAINS)) {
    // Discovery: walk a few pages of newest pools looking for ones that just entered the age window
    for (let page = 1; page <= 4; page++) {
      if (page > 1) await sleep(600); // stay under GeckoTerminal's rate limit
      let pools;
      try { pools = await fetchNewPools(network, page); } catch (e) { console.log(e.message); break; }
      if (!pools.length) break;

      for (const p of pools) {
        scanned++;
        const addr = p.attributes.address;
        const key = `${label}:${addr}`;
        const createdAt = new Date(p.attributes.pool_created_at).getTime();
        const age = now - createdAt;
        const mcap = Number(p.attributes.market_cap_usd || p.attributes.fdv_usd || 0);
        const liquidity = Number(p.attributes.reserve_in_usd || 0);

        if (state[key]?.status === 'dropped') continue;

        const inWindow = age >= AGE_MIN_MS && age <= AGE_MAX_MS;
        const inMcap = mcap >= MCAP_MIN && mcap <= MCAP_MAX;

        if (!state[key] && inWindow && inMcap && liquidity >= MIN_LIQUIDITY_USD) {
          state[key] = { chain: label, addr, name: p.attributes.name, firstSeen: now, status: 'watching', lastAlert: 0 };
        }
      }
    }

    // Evaluate everything currently on the watchlist for this chain
    for (const [key, t] of Object.entries(state)) {
      if (t.chain !== label || t.status === 'dropped') continue;
      const age = now - t.firstSeen;
      if (age > AGE_MAX_MS) { state[key].status = 'dropped'; continue; }
      watching++;

      const [candles, trades] = await Promise.all([
        fetchOhlcv(network, t.addr),
        fetchTrades(network, t.addr),
      ]);
      const setup = evaluateSetup(candles, trades, age);
      const liqOk = candles && candles.slice(-4).some(c => c.v > 0); // some recent trade activity = still "performing"

      if (setup.fire && liqOk && now - t.lastAlert > REALERT_COOLDOWN_MS) {
        alerted++;
        state[key].lastAlert = now;
        state[key].status = 'alerted';
        const chainTag = label === 'solana' ? 'SOL' : 'ETH';
        const link = `https://www.geckoterminal.com/${network}/pools/${t.addr}`;
        const ageH = (age / 3600000).toFixed(1);
        await sendTelegram(
          `🚀 <b>Surge setup — ${t.name || t.addr}</b> (${chainTag})\n` +
          `Age: ${ageH}h post-graduation\n` +
          `Ran up ${setup.runUp}x, pulled back ${setup.drawdown}%, now recovering off that bottom\n` +
          `RSI ${setup.rsi}, MACD bullish cross, buys ${setup.buysPerMin}/min (needed >= ${setup.minBpm}/min at this age)\n` +
          `${link}`
        );
      }
    }
  }

  await store.setJSON('state', state);
  console.log(`scan done: ${scanned} pools scanned, ${watching} watching, ${alerted} alerted`);
  return new Response(JSON.stringify({ scanned, watching, alerted }), { status: 200 });
};

export const config = { schedule: '*/5 * * * *' };
