// Stores posts the marketing team adds directly from the tool, for content
// that isn't tied to a Trello campaign card (e.g. organic posts). Lives in
// Netlify Blobs so it persists across function cold starts and is shared
// by the whole team — no Trello list setup required.
//
// Data shape (single blob, key "manual-posts", store "hg-social"):
//   { "AC": [ { id, date, platform, type, cardName, cardUrl, source }, ... ], "BS": [...], ... }
//   source is "manual" (added by hand in the tool) or "later" (bulk-imported
//   from Later — see the import-later action below). Imported posts may also
//   carry an optional "time" (24h "HH:MM") and "profile" (the Later profile).
//
// Endpoints:
//   GET    ?club=CODE   -> { posts: [...] } for that club
//   GET    ?club=ALL    -> { clubs: { CODE: [...], ... } }
//   POST   body: { club, date, platform, type, cardName } -> adds a post, returns { posts: [...] }
//   POST   body: { action: "import-later", dryRun, posts: [...] } + header x-import-key
//          -> one-time bulk import from Later (see handleImportLater). TEMPORARY:
//          remove this action (and the IMPORT_KEY env var) once the import is done.
//   DELETE body: { club, id } -> removes a post, returns { posts: [...] }

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { CLUBS } = require('./social-shared');

const SYNCED_KEY = 'synced-schedule';
const IMPORT_MAX_POSTS = 5000;

function store() {
  return getStore({
    name: 'hg-social',
    siteID: process.env.SITE_ID,
    token: process.env.BLOBS_TOKEN
  });
}

async function loadAll() {
  const data = await store().get('manual-posts', { type: 'json' });
  return data || {};
}

async function saveAll(data) {
  await store().setJSON('manual-posts', data);
}

// ── Bulk import from Later ───────────────────────────────────────────────

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function pad2(n) { return String(n).padStart(2, '0'); }

// "10AM", "10:30PM", "10:00 AM" (Trello / Later styles) or "14:30" -> "HH:MM".
// Returns '' when the value can't be read — those posts just fall back to
// matching without a time.
function normTime(t) {
  if (!t) return '';
  const s = String(t).trim().toUpperCase().replace(/\s+/g, '');
  let m = /^(\d{1,2})(?::(\d{2}))?(AM|PM)$/.exec(s);
  if (m) {
    let h = parseInt(m[1], 10) % 12;
    if (m[3] === 'PM') h += 12;
    return pad2(h) + ':' + (m[2] || '00');
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) return pad2(parseInt(m[1], 10)) + ':' + m[2];
  return '';
}

// Post / Reel / Carousel / Video all count as one "feed" kind, so a Later
// "Carousel" still matches a Trello "IG Post" for the same day. Stories and
// Events stay separate.
function typeClass(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'story') return 'story';
  if (t === 'event') return 'event';
  return 'feed';
}

function dedupeKey(club, p) {
  return `${club}|${p.date}|${String(p.platform || '').toUpperCase()}|${typeClass(p.type)}`;
}

function json(statusCode, headers, obj) {
  return { statusCode, headers, body: JSON.stringify(obj) };
}

// Imports a snapshot of Later's schedule. Safety rules:
//  - Needs the x-import-key header to match the IMPORT_KEY env var (if the
//    env var isn't set, the action is disabled).
//  - Defaults to a DRY RUN: nothing is written unless the body says
//    dryRun === false.
//  - A real run first saves a backup of the current manual-posts blob.
//  - Previously imported Later posts for the clubs in the request are
//    replaced, so re-running never stacks duplicates. Hand-added "manual"
//    posts are never touched.
//  - Posts already in the tool (Trello-synced posts and hand-added posts)
//    are not imported again. Matching is by COUNT per club + date +
//    platform + kind, so two real posts on the same day aren't collapsed.
async function handleImportLater(event, body, headers) {
  const expected = process.env.IMPORT_KEY;
  if (!expected) {
    return json(503, headers, { error: 'Import is disabled: IMPORT_KEY is not set on the site.' });
  }
  const supplied = event.headers && (event.headers['x-import-key'] || event.headers['X-Import-Key']);
  if (!safeEqual(supplied, expected)) {
    return json(401, headers, { error: 'Invalid import key.' });
  }

  const dryRun = body.dryRun !== false;
  const posts = body.posts;
  if (!Array.isArray(posts) || posts.length === 0) {
    return json(400, headers, { error: 'posts must be a non-empty array' });
  }
  if (posts.length > IMPORT_MAX_POSTS) {
    return json(400, headers, { error: `Too many posts (max ${IMPORT_MAX_POSTS})` });
  }

  const seenIds = new Set();
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const club = String(p && p.club || '').toUpperCase();
    if (!CLUBS[club]) return json(400, headers, { error: `Row ${i}: unknown club "${p && p.club}"` });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.date || ''))) return json(400, headers, { error: `Row ${i}: bad date "${p.date}"` });
    if (!['IG', 'FB', 'LI', 'TT', 'X', 'YT'].includes(String(p.platform || '').toUpperCase())) {
      return json(400, headers, { error: `Row ${i}: bad platform "${p.platform}"` });
    }
    if (!p.id || seenIds.has(p.id)) return json(400, headers, { error: `Row ${i}: missing or duplicate id` });
    seenIds.add(p.id);
  }

  const all = await loadAll();
  const synced = (await store().get(SYNCED_KEY, { type: 'json' })) || { cards: {} };
  const clubsInRequest = new Set(posts.map(p => String(p.club).toUpperCase()));

  // What's already in the tool, grouped by dedupe key.
  const existingByKey = {};
  function addExisting(club, p, src) {
    const k = dedupeKey(club, p);
    if (!existingByKey[k]) existingByKey[k] = [];
    existingByKey[k].push({ time: normTime(p.time), src });
  }
  Object.values(synced.cards || {}).forEach(entry => {
    (entry.posts || []).forEach(p => addExisting(String(entry.code || '').toUpperCase(), p, 'trello'));
  });
  let replacedPreviousLater = 0;
  Object.keys(all).forEach(code => {
    (all[code] || []).forEach(p => {
      if (p.source === 'later') {
        if (clubsInRequest.has(code)) replacedPreviousLater++; // will be replaced below
        else addExisting(code, p, 'later');
        return;
      }
      addExisting(code, p, 'manual');
    });
  });

  // Group incoming by key, then drop one incoming post per existing post.
  const incomingByKey = {};
  posts.forEach(p => {
    const club = String(p.club).toUpperCase();
    const k = dedupeKey(club, p);
    if (!incomingByKey[k]) incomingByKey[k] = [];
    incomingByKey[k].push(p);
  });

  const byClub = {};
  function tally(club, field) {
    if (!byClub[club]) byClub[club] = { incoming: 0, skippedDuplicate: 0, added: 0 };
    byClub[club][field]++;
  }
  posts.forEach(p => tally(String(p.club).toUpperCase(), 'incoming'));

  const toAdd = [];
  Object.keys(incomingByKey).forEach(k => {
    const club = k.split('|')[0];
    const remaining = incomingByKey[k].slice().sort((a, b) => normTime(a.time).localeCompare(normTime(b.time)));
    (existingByKey[k] || []).forEach(ex => {
      if (remaining.length === 0) return;
      let idx = ex.time ? remaining.findIndex(p => normTime(p.time) === ex.time) : -1;
      if (idx === -1) idx = 0;
      remaining.splice(idx, 1);
      tally(club, 'skippedDuplicate');
    });
    remaining.forEach(p => { toAdd.push({ club, p }); tally(club, 'added'); });
  });

  const totals = {
    incoming: posts.length,
    skippedDuplicate: Object.values(byClub).reduce((n, c) => n + c.skippedDuplicate, 0),
    added: toAdd.length,
    replacedPreviousLater
  };

  if (dryRun) {
    return json(200, headers, { dryRun: true, totals, byClub, backupKey: null });
  }

  // Real run: back up first, then apply everything in a single save.
  const backupKey = 'manual-posts-backup-' + new Date().toISOString().replace(/[:.]/g, '-');
  await store().setJSON(backupKey, all);

  clubsInRequest.forEach(code => {
    all[code] = (all[code] || []).filter(p => p.source !== 'later');
  });
  toAdd.forEach(({ club, p }) => {
    if (!all[club]) all[club] = [];
    all[club].push({
      id: String(p.id),
      date: p.date,
      time: p.time || '',
      platform: String(p.platform).toUpperCase(),
      type: p.type || '',
      cardName: p.cardName || '',
      cardUrl: null,
      profile: p.profile || '',
      source: 'later'
    });
  });
  await saveAll(all);

  return json(200, headers, { dryRun: false, totals, byClub, backupKey });
}

// ── Handler ──────────────────────────────────────────────────────────────

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

      if (body.action === 'import-later') {
        return await handleImportLater(event, body, headers);
      }

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

    if (event.httpMethod === 'PUT') {
      const body = JSON.parse(event.body || '{}');
      const { club, id, date, platform, type, cardName } = body;

      if (!club || !id || !date || !platform) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing club, id, date, or platform' }) };
      }

      const all = await loadAll();
      const code = club.toUpperCase();
      const list = all[code] || [];
      const idx = list.findIndex(p => p.id === id);

      if (idx === -1) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Post not found' }) };
      }

      list[idx] = {
        ...list[idx],
        date,
        platform: platform.toUpperCase(),
        type: type || '',
        cardName: cardName || ''
      };
      all[code] = list;
      await saveAll(all);

      return { statusCode: 200, headers, body: JSON.stringify({ posts: all[code] }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (error) {
    console.error('manual-posts error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to process manual post request' }) };
  }
};
