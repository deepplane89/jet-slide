// Jet Horizon — High Score Leaderboard API
// GET  /api/scores  → returns top 10 scores
// POST /api/scores  → submits a new score, returns updated top 10
//
// Storage: Upstash Redis (persistent, free tier: 500K commands/month)
// Uses Redis REST API directly — no npm dependencies needed.

'use strict';

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY         = 'jet-horizon:scores';   // sorted set key
const TOP_N       = 10;
const MAX_ENTRIES = 50;

// In-memory rate-limit map: ip → last submit timestamp (ms)
const rateLimitMap = new Map();
const RATE_LIMIT_MS = 5000;

// ── Redis helpers (REST API, zero dependencies) ─────────────────────────

async function redis(...args) {
  const r = await fetch(`${REDIS_URL}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

// Pipeline: send multiple commands in one round-trip
async function redisPipeline(commands) {
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  const data = await r.json();
  return data;
}

async function getTop(n = TOP_N) {
  // ZREVRANGE returns highest scores first, WITHSCORES includes the score
  const raw = await redis('ZREVRANGE', KEY, 0, n - 1, 'WITHSCORES');
  // raw = [member1, score1, member2, score2, ...]
  const results = [];
  for (let i = 0; i < raw.length; i += 2) {
    let name;
    try {
      const parsed = JSON.parse(raw[i]);
      name = parsed.name || raw[i];
    } catch (_) {
      name = raw[i]; // plain name string (new format)
    }
    results.push({
      name,
      score: parseInt(raw[i + 1], 10),
    });
  }
  return results;
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'UNKNOWN';
  return raw
    .trim()
    .slice(0, 12)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;') || 'UNKNOWN';
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Handler ────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // If Redis is not configured, return empty (graceful fallback)
  if (!REDIS_URL || !REDIS_TOKEN) {
    if (req.method === 'GET') return res.status(200).json([]);
    return res.status(503).json({ error: 'Leaderboard storage not configured.' });
  }

  // ── GET: return top 10 ──────────────────────────────────────────────────
  if (req.method === 'GET') {
    const top = await getTop();
    res.status(200).json(top);
    return;
  }

  // ── POST: submit a new score ────────────────────────────────────────────
  if (req.method === 'POST') {
    // Rate limit by IP
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
              || req.socket?.remoteAddress
              || 'unknown';
    const now = Date.now();
    const lastSubmit = rateLimitMap.get(ip) || 0;
    if (now - lastSubmit < RATE_LIMIT_MS) {
      res.status(429).json({ error: 'Too many requests — wait a moment.' });
      return;
    }
    rateLimitMap.set(ip, now);

    // Parse body
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) { body = {}; }
    }
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'Invalid request body.' });
      return;
    }

    const name  = sanitizeName(body.name);
    const score = body.score;

    if (
      typeof score !== 'number' ||
      !Number.isFinite(score)   ||
      score < 0                 ||
      Math.floor(score) !== score
    ) {
      res.status(400).json({ error: 'score must be a non-negative integer.' });
      return;
    }

    // One entry per player name — use name as the member key so ZADD GT
    // only updates if the new score is higher than the existing one.
    // First, remove any legacy entries for this name (old format: {name, date} JSON members)
    const allRaw = await redis('ZRANGE', KEY, 0, -1);
    const toRemove = [];
    for (const raw of allRaw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.name && parsed.name.toLowerCase() === name.toLowerCase() && raw !== name) {
          toRemove.push(raw);
        }
      } catch (_) {}
    }
    const cmds = [];
    for (const m of toRemove) cmds.push(['ZREM', KEY, m]);
    // Use the player name directly as the sorted set member (one entry per name)
    // ZADD GT: only update if the new score is greater than the existing score
    cmds.push(['ZADD', KEY, 'GT', score, name]);
    cmds.push(['ZREMRANGEBYRANK', KEY, 0, -(MAX_ENTRIES + 1)]);
    await redisPipeline(cmds);

    const top = await getTop();
    res.status(200).json(top);
    return;
  }

  res.status(405).json({ error: 'Method not allowed.' });
};
