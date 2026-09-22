// Stores posts the marketing team adds directly from the tool, for content
// that isn't tied to a Trello campaign card (e.g. organic posts). Lives in
// Netlify Blobs so it persists across function cold starts and is shared
// by the whole team — no Trello list setup required.
//
// Data shape (single blob, key "manual-posts", store "hg-social"):
//   { "AC": [ { id, date, platform, type, cardName, cardUrl, source }, ... ], "BS": [...], ... }
//
// Endpoints:
//   GET    ?club=CODE   -> { posts: [...] } for that club
//   GET    ?club=ALL    -> { clubs: { CODE: [...], ... } }
//   POST   body: { club, date, platform, type, cardName } -> adds a post, returns { posts: [...] }
//   DELETE body: { club, id } -> removes a post, returns { posts: [...] }

const { getStore } = require('@netlify/blobs');

function store() {
  return getStore('hg-social');
}

async function loadAll() {
  const data = await store().get('manual-posts', { type: 'json' });
  return data || {};
}

async function saveAll(data) {
  await store().setJSON('manual-posts', data);
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  try {
    if (event.httpMethod === 'GET') {
      const { club } = event.queryStringParameters || {};
      const all = await loadAll();

      if (!club) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing club parameter' }) };
      }
      if (club === 'ALL') {
        return { statusCode: 200, headers, body: JSON.stringify({ clubs: all }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ posts: all[club.toUpperCase()] || [] }) };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { club, date, platform, type, cardName } = body;

      if (!club || !date || !platform) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing club, date, or platform' }) };
      }

      const all = await loadAll();
      const code = club.toUpperCase();
      if (!all[code]) all[code] = [];

      const post = {
        id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        date,
        platform: platform.toUpperCase(),
        type: type || '',
        cardName: cardName || '',
        cardUrl: null,
        source: 'manual'
      };

      all[code].push(post);
      await saveAll(all);

      return { statusCode: 200, headers, body: JSON.stringify({ posts: all[code] }) };
    }

    if (event.httpMethod === 'DELETE') {
      const body = JSON.parse(event.body || '{}');
      const { club, id } = body;

      if (!club || !id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing club or id' }) };
      }

      const all = await loadAll();
      const code = club.toUpperCase();
      all[code] = (all[code] || []).filter(p => p.id !== id);
      await saveAll(all);

      return { statusCode: 200, headers, body: JSON.stringify({ posts: all[code] }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (error) {
    console.error('manual-posts error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to process manual post request' }) };
  }
};