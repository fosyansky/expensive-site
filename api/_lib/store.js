const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const TMP_DB = path.join('/tmp', 'expensive-db.json');
const LOCAL_DB = path.join(__dirname, '..', '.data', 'db.json');
const GH_REPO = String(process.env.GITHUB_DB_REPO || 'fosyansky/expensive-db').trim();
const GH_PATH = String(process.env.GITHUB_DB_PATH || 'db.json').trim();

function emptyDb() {
  return {
    nextUid: 1,
    users: [],
    sessions: {},
    parties: {},
    messages: {},
    subKeys: [],
  };
}

function githubToken() {
  return String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PAT || '').trim();
}

function useGithub() {
  return Boolean(githubToken());
}

function localFile() {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) return TMP_DB;
  try {
    fs.mkdirSync(path.dirname(LOCAL_DB), { recursive: true });
    return LOCAL_DB;
  } catch (_) {
    return TMP_DB;
  }
}

let cache = { db: null, sha: null, at: 0 };

async function ghFetch(pathname, opts = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken()}`,
      'User-Agent': 'expensive-site',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  return res;
}

async function loadDbFromGithub() {
  const res = await ghFetch(`/repos/${GH_REPO}/contents/${GH_PATH}`);
  if (res.status === 404) {
    const db = emptyDb();
    await saveDbToGithub(db, null);
    return db;
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub DB read ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  cache.sha = data.sha;
  const raw = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8').replace(/^\uFEFF/, '');
  const db = JSON.parse(raw || '{}');
  if (!db.users) db.users = [];
  if (!db.sessions) db.sessions = {};
  if (!db.parties) db.parties = {};
  if (!db.messages) db.messages = {};
  if (!db.nextUid) db.nextUid = 1;
  cache.db = db;
  cache.at = Date.now();
  return db;
}

async function saveDbToGithub(db, sha) {
  const content = Buffer.from(JSON.stringify(db, null, 2), 'utf8').toString('base64');
  const body = {
    message: `db sync ${new Date().toISOString()}`,
    content,
    branch: process.env.GITHUB_DB_BRANCH || 'main',
  };
  if (sha || cache.sha) body.sha = sha || cache.sha;

  let res = await ghFetch(`/repos/${GH_REPO}/contents/${GH_PATH}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 409 || res.status === 422) {
    const meta = await ghFetch(`/repos/${GH_REPO}/contents/${GH_PATH}`);
    if (meta.ok) {
      const data = await meta.json();
      cache.sha = data.sha;
    }
    const retryBody = {
      message: `db sync retry ${new Date().toISOString()}`,
      content,
      branch: process.env.GITHUB_DB_BRANCH || 'main',
      sha: cache.sha,
    };
    res = await ghFetch(`/repos/${GH_REPO}/contents/${GH_PATH}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(retryBody),
    });
  }

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub DB write ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  cache.sha = data.content && data.content.sha;
  cache.db = db;
  cache.at = Date.now();
  return db;
}

function loadDbLocal() {
  const file = localFile();
  try {
    if (!fs.existsSync(file)) {
      const db = emptyDb();
      fs.writeFileSync(file, JSON.stringify(db, null, 2), 'utf8');
      return db;
    }
    const db = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!db.users) db.users = [];
    if (!db.sessions) db.sessions = {};
    if (!db.parties) db.parties = {};
    if (!db.messages) db.messages = {};
    if (!db.nextUid) db.nextUid = 1;
    return db;
  } catch (_) {
    return emptyDb();
  }
}

function saveDbLocal(db) {
  try {
    fs.writeFileSync(localFile(), JSON.stringify(db, null, 2), 'utf8');
  } catch (_) {}
  return db;
}

async function loadDb() {
  if (useGithub()) {
    if (cache.db && Date.now() - cache.at < 1500) return structuredClone(cache.db);
    return structuredClone(await loadDbFromGithub());
  }
  return loadDbLocal();
}

async function saveDb(db) {
  if (useGithub()) {
    await saveDbToGithub(db, cache.sha);
    return db;
  }
  return saveDbLocal(db);
}

function publicUser(u) {
  if (!u) return null;
  const role = u.role || 'user';
  const banned = Boolean(u.banned);
  const subEndsAt = role === 'admin' ? '9999-12-31T23:59:59.000Z' : (u.subEndsAt || null);
  const hasSub = role === 'admin' || (subEndsAt && new Date(subEndsAt).getTime() > Date.now());
  const daysLeft = role === 'admin'
    ? 99999
    : (subEndsAt ? Math.max(0, Math.ceil((new Date(subEndsAt).getTime() - Date.now()) / 86400000)) : 0);
  return {
    uid: u.uid,
    login: u.login,
    email: u.email,
    role,
    balance: u.balance || 0,
    banned,
    hwid: u.hwid || null,
    hwidBound: Boolean(u.hwid),
    subEndsAt,
    hasSub,
    daysLeft,
    registeredAt: u.registeredAt,
  };
}

async function authUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  const db = await loadDb();
  const login = db.sessions[token];
  if (!login) return null;
  return db.users.find((u) => u.login === login) || null;
}

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function partyCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function dbBackend() {
  return useGithub() ? `github:${GH_REPO}` : `file:${localFile()}`;
}

module.exports = {
  loadDb,
  saveDb,
  publicUser,
  authUser,
  json,
  readBody,
  bcrypt,
  uuidv4,
  partyCode,
  dbBackend,
};
