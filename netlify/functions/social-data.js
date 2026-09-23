// Pulls each club's scheduled social posts out of Trello.
//
// HOW THE DATA IS STORED IN TRELLO
// ---------------------------------
// Each campaign card has a single text Custom Field (default name:
// "Scheduled Posts") that the social media specialist fills in with one
// line per post, in this format:
//
//   MM/DD - PLATFORM Type
//   MM/DD/YY - PLATFORM Type
//
// Examples:
//   09/22 - IG Reel
//   09/24 - FB Post
//   09/29/26 - TikTok
//
// Recognized platform codes: IG/Instagram, FB/Facebook, TT/TikTok,
// LI/LinkedIn, X/Twitter, YT/YouTube. Anything else is still captured and
// shown, just without a dedicated color.
//
// Lines that don't match the pattern are NOT silently dropped — they come
// back in `unparsed` so the calendar UI can flag that card for the admin
// to fix, per the "don't lose posts to a typo" plan.
//
// CONFIGURATION NEEDED BEFORE GOING LIVE
// ---------------------------------------
//   TRELLO_API_KEY, TRELLO_TOKEN        - same Trello credentials the
//                                          project dashboard already uses
//   SOCIAL_CUSTOM_FIELD_NAME (optional) - defaults to "Scheduled Posts"
//   Per-club `socialListId` below        - the Trello LIST id holding that
//                                          club's campaign cards. A club
//                                          with no socialListId set returns
//                                          source: "unconfigured" (empty
//                                          posts) instead of sample data.

const cache = { data: {}, timestamps: {} };
const boardFieldCache = { data: {}, timestamps: {} };
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const BOARD_FIELD_CACHE_DURATION = 30 * 60 * 1000; // custom field defs change rarely

const CUSTOM_FIELD_NAME = (process.env.SOCIAL_CUSTOM_FIELD_NAME || 'Scheduled Posts').toLowerCase();

// Fill in each club's Trello list id once the social-scheduling lists exist.
// Everything else (name/threshold) mirrors the front-end CLUBS config.
const CLUBS = {
  "AC":   { name: "Astor Creek Golf & Country Club", socialListId: null },
  "BS":   { name: "Blue Sky Golf Club", socialListId: null },
  "DCC":  { name: "Deerwood Country Club", socialListId: null },
  "ECHO": { name: "Echo Hills Golf Course", socialListId: null },
  "EH":   { name: "Eagle Harbor Golf Club", socialListId: null },
  "FF":   { name: "Falcon's Fire Golf Club", socialListId: null },
  "FPP":  { name: "Fort Piqua Plaza", socialListId: null },
  "GK":   { name: "Glen Kernan Club", socialListId: null },
  "GCC":  { name: "Glynlea Country Club", socialListId: null },
  "HCC":  { name: "Hampshire Country Club", socialListId: null },
  "HH":   { name: "Harbor Hills Country Club", socialListId: null },
  "KGGC": { name: "Kings Gate Golf Club", socialListId: null },
  "LO":   { name: "Laurel Oak Country Club", socialListId: null },
  "MVC":  { name: "Medalist Village Club", socialListId: null },
  "NCC":  { name: "Northland Country Club", socialListId: null },
  "PR/DWN": { name: "Panther Run Golf Club", socialListId: null },
  "PS":   { name: "PipeStone Golf Club", socialListId: null },
  "RBCC": { name: "Rarity Bay Golf & Country Club", socialListId: null },
  "RH":   { name: "River Hall Country Club", socialListId: null },
  "RMC":  { name: "Roscoe Mountain Club", socialListId: null },
  "RVCC": { name: "Raritan Valley Country Club", socialListId: null },
  "SW":   { name: "Stillwater Golf & Country Club", socialListId: null },
  "SCGC": { name: "Stone Creek Golf Club", socialListId: null },
  "STG":  { name: "Stonegate Golf Club", socialListId: null },
  "TARA": { name: "Tara Golf and Country Club", socialListId: null },
  "TER":  { name: "Terreno", socialListId: null },
  "TN":   { name: "Tennessee National", socialListId: null },
  "VER":  { name: "Verandah Golf Club", socialListId: null },
  "VRC":  { name: "Venetian River Club", socialListId: null }
};

const LINE_PATTERN = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*-\s*([A-Za-z]+)\s*(.*)$/;

const PLATFORM_ALIASES = {
  ig: 'IG', instagram: 'IG',
  fb: 'FB', facebook: 'FB',
  tt: 'TT', tiktok: 'TT',
  li: 'LI', linkedin: 'LI',
  x: 'X', twitter: 'X',
  yt: 'YT', youtube: 'YT'
};

function pad2(n) { return String(n).padStart(2, '0'); }

function resolveYear(rawYear, month, day) {
  const now = new Date();
  if (rawYear) {
    let y = parseInt(rawYear, 10);
    if (y < 100) y += 2000;
    return y;
  }
  // No year given: assume current year, but if that date is more than ~4
  // months in the past, assume the specialist meant next year (handles
  // campaigns typed in December that roll into January).
  const candidate = new Date(now.getFullYear(), month - 1, day);
  const diffDays = (now - candidate) / 86400000;
  if (diffDays > 120) return now.getFullYear() + 1;
  return now.getFullYear();
}

function parseCustomFieldText(text, cardName, cardUrl) {
  const posts = [];
  const unparsed = [];
  if (!text) return { posts, unparsed };

  text.split('\n').forEach(rawLine => {
    const line = rawLine.trim();
    if (!line) return;

    const m = LINE_PATTERN.exec(line);
    if (!m) {
      unparsed.push({ cardName, cardUrl, line });
      return;
    }

    const month = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      unparsed.push({ cardName, cardUrl, line });
      return;
    }

    const year = resolveYear(m[3], month, day);
    const platformRaw = (m[4] || '').toLowerCase();
    const platform = PLATFORM_ALIASES[platformRaw] || m[4].toUpperCase();
    const type = (m[5] || '').trim();

    posts.push({
      date: `${year}-${pad2(month)}-${pad2(day)}`,
      platform,
      type,
      cardName,
      cardUrl
    });
  });

  return { posts, unparsed };
}

// ── Trello fetch ──
async function getBoardCustomFieldId(boardId, apiKey, token) {
  const now = Date.now();
  if (boardFieldCache.data[boardId] && (now - boardFieldCache.timestamps[boardId]) < BOARD_FIELD_CACHE_DURATION) {
    return boardFieldCache.data[boardId];
  }
  const res = await fetch(`https://api.trello.com/1/boards/${boardId}/customFields?key=${apiKey}&token=${token}`);
  if (!res.ok) throw new Error('Failed to fetch board custom fields');
  const fields = await res.json();
  const match = fields.find(f => (f.name || '').toLowerCase() === CUSTOM_FIELD_NAME);
  const fieldId = match ? match.id : null;
  boardFieldCache.data[boardId] = fieldId;
  boardFieldCache.timestamps[boardId] = now;
  return fieldId;
}

async function fetchClubFromTrello(code, listId, apiKey, token) {
  const cardsRes = await fetch(
    `https://api.trello.com/1/lists/${listId}/cards?key=${apiKey}&token=${token}&fields=name,shortUrl,idBoard&customFieldItems=true`
  );
  if (!cardsRes.ok) throw new Error(`Trello card fetch failed for list ${listId}`);
  const cards = await cardsRes.json();

  if (cards.length === 0) {
    return { posts: [], unparsed: [], source: 'trello' };
  }

  const boardId = cards[0].idBoard;
  const fieldId = await getBoardCustomFieldId(boardId, apiKey, token);

  let posts = [];
  let unparsed = [];

  if (fieldId) {
    cards.forEach(card => {
      const item = (card.customFieldItems || []).find(ci => ci.idCustomField === fieldId);
      const text = item && item.value ? item.value.text : null;
      const { posts: p, unparsed: u } = parseCustomFieldText(text, card.name, card.shortUrl);
      posts = posts.concat(p);
      unparsed = unparsed.concat(u);
    });
  }

  return { posts, unparsed, source: 'trello' };
}

async function getClubData(code, apiKey, token) {
  const now = Date.now();
  const cacheKey = `social_${code}`;

  if (cache.data[cacheKey] && (now - cache.timestamps[cacheKey]) < CACHE_DURATION) {
    return cache.data[cacheKey];
  }

  const clubConfig = CLUBS[code];
  let result;

  if (!clubConfig) {
    result = { posts: [], unparsed: [], source: 'unknown' };
  } else if (!clubConfig.socialListId) {
    result = { posts: [], unparsed: [], source: 'unconfigured' };
  } else if (!apiKey || !token) {
    result = { posts: [], unparsed: [], source: 'error', error: 'Trello credentials not configured' };
  } else {
    try {
      result = await fetchClubFromTrello(code, clubConfig.socialListId, apiKey, token);
    } catch (err) {
      console.error(`Trello fetch failed for ${code}:`, err);
      result = { posts: [], unparsed: [], source: 'error', error: 'Failed to fetch from Trello' };
    }
  }

  cache.data[cacheKey] = result;
  cache.timestamps[cacheKey] = now;
  return result;
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
    if (club === 'ALL') {
      const codes = Object.keys(CLUBS);
      const results = await Promise.all(codes.map(code => getClubData(code, TRELLO_API_KEY, TRELLO_TOKEN)));
      const clubs = {};
      codes.forEach((code, i) => { clubs[code] = results[i]; });

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

    const data = await getClubData(club.toUpperCase(), TRELLO_API_KEY, TRELLO_TOKEN);
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
