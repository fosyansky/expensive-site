const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const TMP_DB = path.join('/tmp', 'expensive-db.json');
const LOCAL_DB = path.join(__dirname, '..', '.data', 'db.json');

function dbFile() {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return TMP_DB;
  }
  try {
    fs.mkdirSync(path.dirname(LOCAL_DB), { recursive: true });
    return LOCAL_DB;
  } catch (_) {
    return TMP_DB;
  }
}

function emptyDb() {
  return {
    nextUid: 1,
    users: [],
    sessions: {},
    parties: {},
    messages: {},
  };
}

let memDb = null;

function loadDb() {
  if (memDb) return memDb;
  const file = dbFile();
  try {
    if (!fs.existsSync(file)) {
      const db = emptyDb();
      fs.writeFileSync(file, JSON.stringify(db, null, 2), 'utf8');
      memDb = db;
      return db;
    }
    memDb = JSON.parse(fs.readFileSync(file, 'utf8'));
    return memDb;
  } catch (_) {
    memDb = emptyDb();
    return memDb;
  }
}

function saveDb(db) {
  memDb = db;
  try {
    fs.writeFileSync(dbFile(), JSON.stringify(db, null, 2), 'utf8');
  } catch (_) {}
}

function publicUser(u) {
  if (!u) return null;
  return {
    uid: u.uid,
    login: u.login,
    email: u.email,
    role: u.role || 'user',
    registeredAt: u.registeredAt,
  };
}

function authUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  const db = loadDb();
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
};
