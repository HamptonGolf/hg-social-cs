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

// ── Trello fetch ──
// Pulls every card on the shared board — open AND archived, so a card
// archived after its posts were scheduled still stays on the calendar —
// along with its comments in a single request (actions=commentCard
// embeds each card's comment history), parses every comment matching the
// bookmarklet's schedule format, and groups the resulting posts by the
// club code parsed from each card's title.
const BOARD_PAGE_SIZE = 100; // Trello caps cards-with-actions requests; page through in batches

async function fetchBoardData(apiKey, token) {
  const byCode = {};
  let beforeId = null;

  // Page through the whole board using "before" (a card id) as the
  // cursor. Trello returns cards in a fixed order, so requesting
  // "before=<last card id seen>" reliably picks up where the previous
  // page left off. Stop once a page comes back short of a full page.
  while (true) {
    const params = new URLSearchParams({
      key: apiKey,
      token,
      filter: 'all',
      fields: 'name,shortUrl',
      actions: 'commentCard',
      actions_limit: '1000',
      limit: String(BOARD_PAGE_SIZE)
    });
    if (beforeId) params.set('before', beforeId);

    const cardsRes = await fetch(
      `https://api.trello.com/1/boards/${SOCIAL_BOARD_ID}/cards?${params.toString()}`
    );
    if (!cardsRes.ok) {
      const bodyText = await cardsRes.text().catch(() => '');
      throw new Error(`Trello board fetch failed (HTTP ${cardsRes.status}): ${bodyText}`);
    }
    const cards = await cardsRes.json();

    cards.forEach(card => {
      const code = parseCardPrefix(card.name);
      if (!code) return; // title doesn't follow the "CODE - Title" pattern

      let cardPosts = [];
      (card.actions || []).forEach(action => {
        const text = action.data && action.data.text;
        cardPosts = cardPosts.concat(parseScheduleComment(text, card.name, card.shortUrl));
      });
      if (cardPosts.length === 0) return; // no schedule comments on this card

      byCode[code] = (byCode[code] || []).concat(cardPosts);
    });

    if (cards.length < BOARD_PAGE_SIZE) break; // last page
    beforeId = cards[cards.length - 1].id;
  }

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
