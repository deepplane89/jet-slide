// Jet Horizon — High Score Leaderboard API
// GET  /api/scores  → returns top 10 scores
// POST /api/scores  → submits a new score, returns updated top 10
//
// Storage: /tmp/jet-horizon-scores.json (Vercel serverless ephemeral storage)
// Note: /tmp is shared within the same Lambda instance; on cold start it's empty.

'use strict';

const fs   = require('fs');
const path = require('path');

const SCORES_FILE = '/tmp/jet-horizon-scores.json';
const MAX_ENTRIES = 50;
const TOP_N       = 10;

// In-memory rate-limit map: ip → last submit timestamp (ms)
const rateLimitMap = new Map();
const RATE_LIMIT_MS = 5000; // 5 seconds

// ── Helpers ────────────────────────────────────────────────────────────────

function readScores() {
  try {
    if (fs.existsSync(SCORES_FILE)) {
      const raw = fs.readFileSync(SCORES_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (_) {
    // File corrupt or missing — start fresh
  }
  return [];
}

function writeScores(scores) {
  fs.writeFileSync(SCORES_FILE, JSON.stringify(scores), 'utf8');
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

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // ── GET: return top 10 ──────────────────────────────────────────────────
  if (req.method === 'GET') {
    const scores = readScores();
    const top10  = scores.slice(0, TOP_N);
    res.status(200).json(top10);
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
      res.status(429).json({ error: 'Too many requests — wait a moment before submitting again.' });
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

    // Validate score
    if (
      typeof score !== 'number' ||
      !Number.isFinite(score)   ||
      score < 0                 ||
      Math.floor(score) !== score
    ) {
      res.status(400).json({ error: 'score must be a non-negative integer.' });
      return;
    }

    // Load, append, sort, trim, save
    const scores = readScores();
    scores.push({ name, score, date: now });
    scores.sort((a, b) => b.score - a.score);
    const trimmed = scores.slice(0, MAX_ENTRIES);
    writeScores(trimmed);

    const top10 = trimmed.slice(0, TOP_N);
    res.status(200).json(top10);
    return;
  }

  // Unsupported method
  res.status(405).json({ error: 'Method not allowed.' });
};
