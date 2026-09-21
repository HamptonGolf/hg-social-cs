// Single admin login for the Social Command Center — unlike the project
// dashboard (one password per club), this tool is meant to be used by the
// marketing team as internal admins with access to every property's
// schedule, so it checks against one shared admin roster instead.
//
// Configure via environment variables in Netlify:
//   SOCIAL_ADMIN_USERS = "ryan:S0meP@ssword,teammate:AnotherPassword"
// (comma-separated "username:password" pairs)
//
// Falls back to a single demo account if the env var isn't set yet, so the
// tool is testable immediately — change this before sharing real access.

exports.handler = async (event, context) => {
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ success: false, error: 'Malformed request' }),
      headers: { 'Content-Type': 'application/json' }
    };
  }

  const { username, password } = body;

  if (!username || !password) {
    return {
      statusCode: 400,
      body: JSON.stringify({ success: false, error: 'Missing username or password' }),
      headers: { 'Content-Type': 'application/json' }
    };
  }

  const rosterRaw = process.env.SOCIAL_ADMIN_USERS || 'admin:HamptonGolf2025';
  const roster = {};
  rosterRaw.split(',').forEach(pair => {
    const idx = pair.indexOf(':');
    if (idx === -1) return;
    const user = pair.slice(0, idx).trim();
    const pass = pair.slice(idx + 1).trim();
    if (user) roster[user.toLowerCase()] = pass;
  });

  const match = roster[username.trim().toLowerCase()];

  if (match && match === password) {
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Authentication successful' }),
      headers: { 'Content-Type': 'application/json' }
    };
  }

  return {
    statusCode: 401,
    body: JSON.stringify({ success: false, error: 'Invalid username or password' }),
    headers: { 'Content-Type': 'application/json' }
  };
};
