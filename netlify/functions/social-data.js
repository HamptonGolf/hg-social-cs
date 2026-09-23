// Serves scheduled social posts to the calendar pages, read from Netlify
// Blobs. This function never talks to Trello directly — sync-social-data.js
// (a separate scheduled function) does that periodically and stores the
// result here, which is what keeps page loads fast.
//
// See sync-social-data.js for how data gets into storage, and
// social-shared.js for the club list and parsing helpers.

const { getStore } = require('@netlify/blobs');
const { CLUBS, isWithinRetention } = require('./social-shared');

const BLOB_KEY = 'synced-schedule';

function store() {
  return getStore({
    name: 'hg-social',
    siteID: process.env.SITE_ID,
    token: process.env.BLOBS_TOKEN
  });
}

async function loadStored() {
  const data = await store().get(BLOB_KEY, { type: 'json' });
  return data || { cards: {}, lastSyncedAt: null };
}

// Groups stored card data by club code, applying a final retention check
// (cheap, no API calls) in case a sync outage has let old data linger.
function groupByCode(stored) {
  const byCode = {};
  Object.values(stored.cards || {}).forEach(entry => {
    const posts = entry.posts.filter(p => isWithinRetention(p.date));
    if (posts.length === 0) return;
    byCode[entry.code] = (byCode[entry.code] || []).concat(posts);
  });
  return byCode;
}

exports.handler = async (event) => {
  const { club } = event.queryStringParameters || {};

  if (!club) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing club parameter' }),
      headers: { 'Content-Type': 'application/json' }
    };
  }

  try {
    const stored = await loadStored();
    const byCode = groupByCode(stored);

    if (club === 'ALL') {
      const codes = Object.keys(CLUBS);
      const clubs = {};
      codes.forEach(code => {
        clubs[code] = { posts: byCode[code] || [], source: 'synced', lastSyncedAt: stored.lastSyncedAt };
      });

      return {
        statusCode: 200,
        body: JSON.stringify({ clubs }),
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' }
      };
    }

    if (!/^[A-Z0-9]{2,6}(\/[A-Z0-9]{2,6})?$/i.test(club)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid club code format' }),
        headers: { 'Content-Type': 'application/json' }
      };
    }

    const code = club.toUpperCase();
    const data = CLUBS[code]
      ? { posts: byCode[code] || [], source: 'synced', lastSyncedAt: stored.lastSyncedAt }
      : { posts: [], source: 'unknown' };

    return {
      statusCode: 200,
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' }
    };
  } catch (error) {
    console.error('social-data error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to read social schedule data' }),
      headers: { 'Content-Type': 'application/json' }
    };
  }
};
