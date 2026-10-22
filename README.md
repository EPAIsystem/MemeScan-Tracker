# MemeScan Tracker — Surge Watch

Standalone from MemeScan PRO. Scans Solana + Ethereum for newly-graduated
tokens ($30k-$120k mcap, 4h-48h old), watches them, and alerts on Telegram
only when a bottom-forming + momentum-turning setup appears.

## Setup
1. Push this repo to GitHub, connect it as a new Netlify site.
2. Netlify > Site configuration > Environment variables, add:
   - TELEGRAM_BOT_TOKEN
   - TELEGRAM_CHAT_ID
3. Deploy. The scanner (netlify/functions/scan-surge.mjs) runs every 5 min
   automatically (schedule set in netlify.toml). The dashboard (index.html)
   shows the live watchlist and reads it from netlify/functions/status.mjs.
