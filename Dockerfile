FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
# Verify firebase-admin installed correctly — build fails loudly if module missing
RUN node -e "require('firebase-admin/app'); require('firebase-admin/firestore'); console.log('[BUILD] firebase-admin OK');"
COPY bot.js ./
CMD ["node", "bot.js"]
