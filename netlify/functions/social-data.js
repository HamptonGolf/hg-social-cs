// Pulls scheduled social posts out of Trello CARD COMMENTS, from ONE
// shared Trello board used for all properties (not a separate list per
// club).
//
// HOW CLUBS ARE IDENTIFIED
// -------------------------
// Every card on the board starts its title with "CODE - ", e.g.:
//   "AC - Wine Down Wednesday December 2 (2026)"
//   "TARA - Thanksgiving Buffet November 26 (2026)"
// The text before the first " - " is taken as the club code, whatever it
// is — a code that doesn't match a known club (e.g. "HG") simply never
// gets requested by any club's calendar; nothing is dropped or flagged.
//
// HOW THE SCHEDULE DATA IS STORED
// ---------------------------------
// The social media specialist posts one Trello comment per platform/post
// they schedule, using the "Social Posting" bookmarklet folder, which
// inserts a comment in this exact format (built-in validation rejects
// malformed dates/times before the comment is ever submitted):
//
//   PLATFORM M/D/YYYY (hAM/PM), M/D/YYYY (hAM/PM), ...
//
// Examples:
//   IG Post 9/25/2026 (10AM)
//   FB Story 9/25/2026 (10AM), 9/26/2026 (2PM)
//
// Recognized platform tags: IG Post, IG Story, IG Reel, FB Story, FB Post,
// FB Event, FB Reel, LI Post, X Post — one per bookmarklet. A card can
// carry any number of these comments (one per platform it's posted to),
// and every matching comment on the card is pulled in — not just the most
// recent. If a post's schedule changes, the specialist edits the original
// comment rather than adding a new one.
//
// Comments that don't start with a recognized platform tag are ordinary
// card discussion and are silently ignored.
//
// Each parsed post carries the source card's name and link (shortUrl), so
// the calendar lightbox can show which campaign card it came from.
//
// HOW THE FETCH WORKS (two phases, to stay under Trello's request limits)
// -------------------------------------------------------------------------
// Phase 1: fetch the full board's card list with NO comments attached
// (cheap — one or two requests covers the whole board). Filter that list
// down to cards that (a) match a recognized club prefix and (b) were
// created in 2026 or later — older cards are ignored entirely, no API
// call spent on them.
// Phase 2: fetch comments individually for just that filtered set of
// cards, a handful in parallel at a time. This is the expensive part, so
// phase 1's filtering is what keeps it fast.
//
// DATA RETENTION
// ---------------
// Individual scheduled posts are dropped once their date is more than 3
// months in the past — this happens at fetch time (nothing is persisted
// long-term), so old posts simply stop appearing rather than needing a
// cleanup job.
//
// CONFIGURATION NEEDED BEFORE GOING LIVE
// ---------------------------------------
//   TRELLO_API_KEY, TRELLO_TOKEN - same Trello credentials the project
//                                  dashboard already uses
//   SOCIAL_BOARD_ID (optional)  - the shared board's id or short link.
//                                 Defaults to "pMMdpWft" (the "Marketing
//                                 Requests" board) below — override via
//                                 env var if that ever changes.

// Cache holds the WHOLE board's parsed results, grouped by club code —
// one Trello fetch serves every club, since they all share one board.
const cache = { data: null, timestamp: 0 };
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

const SOCIAL_BOARD_ID = process.env.SOCIAL_BOARD_ID || 'pMMdpWft'; // "Marketing Requests" board

// Recognized club codes — used to validate a requested club and to loop
// over all clubs for the "ALL" endpoint. Trello access no longer needs a
// per-club id here; every club reads from the same shared board.
const CLUBS = {
  "AC":   { name: "Astor Creek Golf & Country Club" },
  "BS":   { name: "Blue Sky Golf Club" },
  "DCC":  { name: "Deerwood Country Club" },
  "ECHO": { name: "Echo Hills Golf Course" },
  "EH":   { name: "Eagle Harbor Golf Club" },
  "FF":   { name: "Falcon's Fire Golf Club" },
  "FPP":  { name: "Fort Piqua Plaza" },
  "GK":   { name: "Glen Kernan Club" },
  "GCC":  { name: "Glynlea Country Club" },
  "HCC":  { name: "Hampshire Country Club" },
  "HH":   { name: "Harbor Hills Country Club" },
  "KGGC": { name: "Kings Gate Golf Club" },
  "LO":   { name: "Laurel Oak Country Club" },
  "MVC":  { name: "Medalist Village Club" },
  "NCC":  { name: "Northland Country Club" },
  "PR/DWN": { name: "Panther Run Golf Club" },
  "PS":   { name: "PipeStone Golf Club" },
  "RBCC": { name: "Rarity Bay Golf & Country Club" },
  "RH":   { name: "River Hall Country Club" },
  "RMC":  { name: "Roscoe Mountain Club" },
  "RVCC": { name: "Raritan Valley Country Club" },
  "SW":   { name: "Stillwater Golf & Country Club" },
  "SCGC": { name: "Stone Creek Golf Club" },
  "STG":  { name: "Stonegate Golf Club" },
  "TARA": { name: "Tara Golf and Country Club" },
  "TER":  { name: "Terreno" },
  "TN":   { name: "Tennessee National" },
  "VER":  { name: "Verandah Golf Club" },
  "VRC":  { name: "Venetian River Club" }
};

function pad2(n) { return String(n).padStart(2, '0'); }

// One entry per bookmarklet in the "Social Posting" folder.
const PLATFORM_TAGS = {
  'IG Post':  { platform: 'IG', type: 'Post' },
  'IG Story': { platform: 'IG', type: 'Story' },
  'IG Reel':  { platform: 'IG', type: 'Reel' },
  'FB Story': { platform: 'FB', type: 'Story' },
  'FB Post':  { platform: 'FB', type: 'Post' },
  'FB Event': { platform: 'FB', type: 'Event' },
  'FB Reel':  { platform: 'FB', type: 'Reel' },
  'LI Post':  { platform: 'LI', type: 'Post' },
  'X Post':   { platform: 'X', type: 'Post' }
};

const PLATFORM_TAG_PATTERN = Object.keys(PLATFORM_TAGS)
  .map(tag => tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

// Matches a full comment, e.g.:
//   "IG Post 9/25/2026 (10AM), 9/26/2026 (2PM)"
const COMMENT_LINE_PATTERN = new RegExp(`^(${PLATFORM_TAG_PATTERN})\\s+(.+)$`);

// Matches one "M/D/YYYY (hAM/PM)" entry within a comment.
const ENTRY_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*\((\d{1,2}(?::\d{2})?(?:AM|PM))\)$/;

// Parses a single Trello comment's text. Returns [] if it isn't a
// recognized schedule comment (ordinary card discussion) — that's not an
// error, just not schedule data, so nothing is flagged.
function parseScheduleComment(text, cardName, cardUrl) {
  if (!text) return [];
  const line = text.trim();

  const lineMatch = COMMENT_LINE_PATTERN.exec(line);
  if (!lineMatch) return [];

  const { platform, type } = PLATFORM_TAGS[lineMatch[1]];
  const entries = lineMatch[2].split(',').map(s => s.trim());

  const posts = [];
  entries.forEach(entry => {
    const m = ENTRY_PATTERN.exec(entry);
    if (!m) return; // defensive: bookmarklet validation should prevent this

    const month = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    const time = m[4];

    posts.push({
      date: `${year}-${pad2(month)}-${pad2(day)}`,
      time,
      platform,
      type,
      cardName,
      cardUrl
    });
  });

  return posts;
}

// A card's title always starts with "CODE - " (e.g. "AC - Wine Down
// Wednesday"). The text before the first " - " is taken as the code
// as-is — matched against known clubs when grouping, never validated or
// corrected here.
const CARD_PREFIX_PATTERN = /^(.+?)\s-\s(.*)$/;

function parseCardPrefix(cardName) {
  const m = CARD_PREFIX_PATTERN.exec(cardName || '');
  return m ? m[1].trim().toUpperCase() : null;
}

// ── Trello fetch (two phases — see header comment) ──

const MIN_CARD_CREATED = new Date(Date.UTC(2026, 0, 1)); // ignore cards created before 2026
const POST_RETENTION_MONTHS = 3; // drop individual posts once their date is this old
const COMMENT_FETCH_CONCURRENCY = 8; // per-card comment requests in flight at once

// A Trello card id's first 8 hex characters encode its creation time
// (Unix seconds) — this reads that off the id with no extra API call.
function cardCreatedAt(cardId) {
  const seconds = parseInt(cardId.substring(0, 8), 16);
  return new Date(seconds * 1000);
}

// True if a post's date is within the retention window (not yet 3+
// months old).
function isWithinRetention(dateStr) {
  const postDate = new Date(dateStr + 'T00:00:00');
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - POST_RETENTION_MONTHS);
  cutoff.setHours(0, 0, 0, 0);
  return postDate >= cutoff;
}

// Runs `fn` over `items` with at most `limit` running at once, so we
// don't fire hundreds of simultaneous requests at Trello.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Phase 1: the full card list, no comments attached — cheap, and avoids
// Trello's "too many cards requested" limit that only triggers when
// comments are bundled in. Paginates defensively in case the board ever
// exceeds Trello's 1000-cards-per-request cap.
async function fetchBoardCardList(apiKey, token) {
  const cards = [];
  let beforeId = null;

  while (true) {
    const params = new URLSearchParams({
      key: apiKey,
      token,
      filter: 'all',
      fields: 'name,shortUrl',
      limit: '1000'
    });
    if (beforeId) params.set('before', beforeId);

    const res = await fetch(`https://api.trello.com/1/boards/${SOCIAL_BOARD_ID}/cards?${params.toString()}`);
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(`Trello board fetch failed (HTTP ${res.status}): ${bodyText}`);
    }
    const page = await res.json();
    cards.push(...page);

    if (page.length < 1000) break; // last page
    beforeId = page[page.length - 1].id;
  }

  return cards;
}

// Phase 2: comments for one card.
async function fetchCardComments(cardId, apiKey, token) {
  const params = new URLSearchParams({ key: apiKey, token, filter: 'commentCard', limit: '1000' });
  const res = await fetch(`https://api.trello.com/1/cards/${cardId}/actions?${params.toString()}`);
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`Trello comment fetch failed for card ${cardId} (HTTP ${res.status}): ${bodyText}`);
  }
  return res.json();
}

async function fetchBoardData(apiKey, token) {
  const t0 = Date.now();
  const allCards = await fetchBoardCardList(apiKey, token);
  const t1 = Date.now();

  // Only fetch comments for cards that actually matter: a recognized
  // club prefix, and created in 2026 or later. This is what keeps phase 2
  // fast — most of the board never gets a comment request at all.
  const relevantCards = allCards.filter(card => {
    const code = parseCardPrefix(card.name);
    if (!code) return false;
    return cardCreatedAt(card.id) >= MIN_CARD_CREATED;
  });

  const byCode = {};

  await mapWithConcurrency(relevantCards, COMMENT_FETCH_CONCURRENCY, async card => {
    const code = parseCardPrefix(card.name);
    const actions = await fetchCardComments(card.id, apiKey, token);

    let cardPosts = [];
    actions.forEach(action => {
      const text = action.data && action.data.text;
      cardPosts = cardPosts.concat(parseScheduleComment(text, card.name, card.shortUrl));
    });

    // Retention: drop individual posts once they're 3+ months past
    // their date, regardless of the card itself.
    cardPosts = cardPosts.filter(p => isWithinRetention(p.date));

    if (cardPosts.length === 0) return;
    byCode[code] = (byCode[code] || []).concat(cardPosts);
  });

  const t2 = Date.now();

  // TEMP diagnostics — remove once performance/parsing is confirmed working.
  byCode.__debug = {
    totalCardsOnBoard: allCards.length,
    relevantCardsAfterFilter: relevantCards.length,
    relevantCardNames: relevantCards.map(c => c.name),
    phase1Ms: t1 - t0,
    phase2Ms: t2 - t1,
    totalMs: t2 - t0
  };

  return byCode;
}

// Board-wide cache — every club's calendar reads from the same cached
// result instead of each triggering its own Trello fetch.
async function getBoardData(apiKey, token) {
  const now = Date.now();
  if (cache.data && (now - cache.timestamp) < CACHE_DURATION) {
    return cache.data;
  }
  const byCode = await fetchBoardData(apiKey, token);
  cache.data = byCode;
  cache.timestamp = now;
  return byCode;
}

// Builds a single club's result from the board-wide grouped data. Pure/
// sync — the actual Trello fetch happens once in getBoardData, above.
function buildClubResult(code, byCode) {
  if (!CLUBS[code]) return { posts: [], source: 'unknown' };
  return { posts: byCode[code] || [], source: 'trello' };
}

exports.handler = async (event, context) => {
  const { club } = event.queryStringParameters || {};
  const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
  const TRELLO_TOKEN = process.env.TRELLO_TOKEN;

  if (!club) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing club parameter' }),
      headers: { 'Content-Type': 'application/json' }
    };
  }

  try {
    // Fetch (or reuse the cached copy of) the whole board ONCE per
    // request, regardless of whether this is a single-club or ALL
    // request — every club's data comes from the same shared board.
    let byCode = {};
    let boardError = null;

    if (!TRELLO_API_KEY || !TRELLO_TOKEN) {
      boardError = 'Trello credentials not configured';
    } else {
      try {
        byCode = await getBoardData(TRELLO_API_KEY, TRELLO_TOKEN);
      } catch (err) {
        console.error(`Trello fetch failed for board ${SOCIAL_BOARD_ID}:`, err);
        boardError = 'Failed to fetch from Trello';
      }
    }

    if (club === 'ALL') {
      const codes = Object.keys(CLUBS);
      const clubs = {};
      codes.forEach(code => {
        clubs[code] = boardError
          ? { posts: [], source: 'error', error: boardError }
          : buildClubResult(code, byCode);
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
    const data = boardError
      ? { posts: [], source: 'error', error: boardError }
      : buildClubResult(code, byCode);

    if (byCode.__debug) data.__debug = byCode.__debug; // TEMP

    return {
      statusCode: 200,
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' }
    };
  } catch (error) {
    console.error('social-data error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to fetch social schedule data' }),
      headers: { 'Content-Type': 'application/json' }
    };
  }
};
