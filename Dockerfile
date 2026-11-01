FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
# Verify critical modules installed correctly — build fails loudly if missing
RUN node -e "require('firebase-admin/app'); require('firebase-admin/firestore'); console.log('[BUILD] firebase-admin OK');"
RUN node -e "require('bs58'); console.log('[BUILD] bs58 OK');"
# @solana/web3.js uses ESM internally — verified by npm install succeeding, not require()
COPY bot.js ./
CMD ["node", "bot.js"]
