// Shared parsing logic used by both sync-social-data.js (the scheduled
// Trello sync) and social-data.js (the fast read endpoint the calendar
// pages call). Kept in one place so the two never drift out of sync.

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
// error, just not schedule data.
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

// Recognized club codes — used to validate a requested club and to loop
// over all clubs for the "ALL" endpoint.
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

// Posts drop out once their date is this many months in the past.
const POST_RETENTION_MONTHS = 3;

function isWithinRetention(dateStr) {
  const postDate = new Date(dateStr + 'T00:00:00');
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - POST_RETENTION_MONTHS);
  cutoff.setHours(0, 0, 0, 0);
  return postDate >= cutoff;
}

module.exports = {
  parseScheduleComment,
  parseCardPrefix,
  CLUBS,
  isWithinRetention,
  POST_RETENTION_MONTHS
};