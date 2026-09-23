// Scheduled sync — runs periodically (see netlify.toml) and is the ONLY
// place that talks to Trello for social schedule data. It reads the
// COMPLETE list (where a card lands once its social posts are scheduled,
// shortly before Friday's auto-archive), parses every comment that
// matches the bookmarklet's format, and stores the result in Netlify
// Blobs, keyed by card id so re-syncing updates a card in place rather
// than duplicating it.
//
// Cards that later get archived off the COMPLETE list are NOT re-fetched
// (the list-scoped Trello call naturally stops returning them) — but
// their previously-synced data stays in storage, since it was captured
// before the archive happened. It ages out naturally via the 3-month
// retention window, applied here on every sync run.
//
// social-data.js (the function the calendar pages call) only ever reads
// from Blobs — it never calls Trello — so page loads stay fast regardless
// of how the sync is doing.
//
// CONFIGURATION
// --------------
//   TRELLO_API_KEY, TRELLO_TOKEN     - same Trello credentials used
//                                      elsewhere in this project
//   SOCIAL_COMPLETE_LIST_ID (optional) - defaults to the "COMPLETE" list
//                                        id below; override via env var
//                                        if that list is ever recreated

const { getStore } = require('@netlify/blobs');
const { parseScheduleComment, parseCardPrefix, isWithinRetention } = require('./social-shared');

const COMPLETE_LIST_ID = process.env.SOCIAL_COMPLETE_LIST_ID || '649969320cb542d64cea6970';
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

async function saveStored(data) {
  await store().setJSON(BLOB_KEY, data);
}

// The COMPLETE list is small (cards sit here only briefly before Friday's
// archive), so unlike a whole-board scan this single request — comments
// included — stays comfortably under Trello's per-request limits.
async function fetchCompleteListCards(apiKey, token) {
  const params = new URLSearchParams({
    key: apiKey,
    token,
    fields: 'name,shortUrl',
    actions: 'commentCard',
    actions_limit: '1000'
  });
  const res = await fetch(`https://api.trello.com/1/lists/${COMPLETE_LIST_ID}/cards?${params.toString()}`);
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`Trello list fetch failed (HTTP ${res.status}): ${bodyText}`);
  }
  return res.json();
}

exports.handler = async () => {
  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;

  if (!apiKey || !token) {
    console.error('sync-social-data: Trello credentials not configured');
    return { statusCode: 500, body: JSON.stringify({ error: 'Trello credentials not configured' }) };
  }

  try {
    const stored = await loadStored();
    const cards = await fetchCompleteListCards(apiKey, token);

    let updatedCount = 0;
    let skippedNoPrefix = 0;

    cards.forEach(card => {
      const code = parseCardPrefix(card.name);
      if (!code) { skippedNoPrefix++; return; }

      let posts = [];
      (card.actions || []).forEach(action => {
        const text = action.data && action.data.text;
        posts = posts.concat(parseScheduleComment(text, card.name, card.shortUrl));
      });

      // Upsert: this fully replaces the card's stored entry each sync, so
      // an edited or deleted comment is correctly reflected next time.
      stored.cards[card.id] = { code, cardName: card.name, cardUrl: card.shortUrl, posts };
      updatedCount++;
    });

    // Retention: prune old posts everywhere in storage (including cards
    // that have since been archived off the COMPLETE list, since we only
    // touch cards currently in the list above). Drop a card entry
    // entirely once none of its posts remain.
    let prunedCards = 0;
    Object.keys(stored.cards).forEach(cardId => {
      const entry = stored.cards[cardId];
      const kept = entry.posts.filter(p => isWithinRetention(p.date));
      if (kept.length === 0) {
        delete stored.cards[cardId];
        prunedCards++;
      } else {
        entry.posts = kept;
      }
    });

    stored.lastSyncedAt = new Date().toISOString();
    await saveStored(stored);

    const summary = {
      syncedAt: stored.lastSyncedAt,
      cardsInCompleteList: cards.length,
      cardsUpdated: updatedCount,
      cardsSkippedNoPrefix: skippedNoPrefix,
      cardsPrunedForRetention: prunedCards,
      totalCardsStored: Object.keys(stored.cards).length
    };

    console.log('sync-social-data:', JSON.stringify(summary));
    return { statusCode: 200, body: JSON.stringify(summary) };
  } catch (error) {
    console.error('sync-social-data error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};