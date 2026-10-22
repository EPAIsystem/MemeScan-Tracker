// Returns the current watchlist + recent alerts as JSON, for the dashboard page.
import { getStore } from '@netlify/blobs';

export default async () => {
  const store = getStore('surge-watch');
  const state = (await store.get('state', { type: 'json' })) || {};
  const rows = Object.entries(state).map(([key, t]) => ({ key, ...t }));
  rows.sort((a, b) => (b.lastAlert || 0) - (a.lastAlert || 0) || (b.firstSeen || 0) - (a.firstSeen || 0));
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
};
