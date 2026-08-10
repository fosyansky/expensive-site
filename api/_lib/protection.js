const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { uuidv4 } = require('./store');

const LAUNCH_SESSION_TTL_MS = 10 * 60 * 1000;
const LAUNCH_SESSION_HARD_MAX_MS = 6 * 60 * 60 * 1000;
const MAX_ACTIVE_INSTALLATIONS = 2;
const RATE = new Map();

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let bucket = RATE.get(key);
  if (!bucket || now - bucket.start > windowMs) {
    bucket = { start: now, count: 0 };
    RATE.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

function ensureProtectionDb(db) {
  if (!Array.isArray(db.installations)) db.installations = [];
  if (!db.launchSessions || typeof db.launchSessions !== 'object') db.launchSessions = {};
  if (!Array.isArray(db.builds)) db.builds = [];
  if (!Array.isArray(db.protectionEvents)) db.protectionEvents = [];
  if (!db.protectionMeta || typeof db.protectionMeta !== 'object') db.protectionMeta = {};
}

function keysDir() {
  const dir = path.join(__dirname, '..', '.data');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  return dir;
}

function loadOrCreateSigningKeys() {
  const envPriv = String(process.env.PROTECTION_ED25519_PRIVATE || '').trim();
  const envPub = String(process.env.PROTECTION_ED25519_PUBLIC || '').trim();
  if (envPriv && envPub) {
    return {
      keyId: String(process.env.PROTECTION_KEY_ID || 'env-1').trim(),
      privateKey: crypto.createPrivateKey({ key: Buffer.from(envPriv, 'base64'), format: 'der', type: 'pkcs8' }),
      publicKey: crypto.createPublicKey({ key: Buffer.from(envPub, 'base64'), format: 'der', type: 'spki' }),
      publicKeySpkiB64: envPub.trim(),
    };
  }
  const file = path.join(keysDir(), 'protection-ed25519.json');
  if (fs.existsSync(file)) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const privB64 = j.privateKeyPkcs8B64 || j.privateKeySpkiB64;
    return {
      keyId: String(j.keyId || 'local-1').trim(),
      privateKey: crypto.createPrivateKey({ key: Buffer.from(privB64, 'base64'), format: 'der', type: 'pkcs8' }),
      publicKey: crypto.createPublicKey({ key: Buffer.from(j.publicKeySpkiB64, 'base64'), format: 'der', type: 'spki' }),
      publicKeySpkiB64: String(j.publicKeySpkiB64 || '').trim(),
    };
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeySpkiB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const privateKeyPkcs8B64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const keyId = 'local-1';
  fs.writeFileSync(
    file,
    JSON.stringify({ keyId, publicKeySpkiB64, privateKeyPkcs8B64, createdAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
  return { keyId, privateKey, publicKey, publicKeySpkiB64 };
}

function payloadMasterKey() {
  const hex = String(process.env.PROTECTION_PAYLOAD_MASTER || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  const file = path.join(keysDir(), 'payload-master.key');
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('hex'), 'utf8');
  return key;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function signManifestBody(bodyObj) {
  const keys = loadOrCreateSigningKeys();
  const unsigned = { ...bodyObj };
  delete unsigned.signature;
  delete unsigned.keyId;
  const canonical = canonicalJson(unsigned);
  const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), keys.privateKey);
  return {
    ...unsigned,
    keyId: keys.keyId,
    signature: sig.toString('base64'),
  };
}

function verifyManifest(bodyObj, publicKeySpkiB64) {
  const unsigned = { ...bodyObj };
  const signature = unsigned.signature;
  delete unsigned.signature;
  delete unsigned.keyId;
  const canonical = canonicalJson(unsigned);
  const pub = crypto.createPublicKey({ key: Buffer.from(publicKeySpkiB64, 'base64'), format: 'der', type: 'spki' });
  return crypto.verify(null, Buffer.from(canonical, 'utf8'), pub, Buffer.from(signature, 'base64'));
}

function aesGcmEncrypt(plainBuf, keyBuf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const enc = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: enc.toString('base64'),
  };
}

function aesGcmDecrypt(payload, keyBuf) {
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const data = Buffer.from(payload.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function pushProtectionEvent(db, ev) {
  ensureProtectionDb(db);
  db.protectionEvents.push({
    id: uuidv4(),
    at: new Date().toISOString(),
    atMs: Date.now(),
    accountId: ev.accountId || null,
    login: ev.login || null,
    installationId: ev.installationId || null,
    sessionId: ev.sessionId || null,
    buildId: ev.buildId || null,
    type: ev.type || 'UNKNOWN',
    severity: ev.severity || 'info',
    status: ev.status || 'open',
    action: ev.action || '',
    correlationId: ev.correlationId || uuidv4(),
  });
  if (db.protectionEvents.length > 500) db.protectionEvents = db.protectionEvents.slice(-500);
}

function findActiveInstallation(db, login, installationId) {
  return db.installations.find(
    (i) => i.installationId === installationId && i.login === login && i.status === 'ACTIVE',
  );
}

function enrollInstallation(db, user, body) {
  ensureProtectionDb(db);
  const deviceBinding = String(body.deviceBinding || body.hwid || '').trim().slice(0, 128);
  if (!deviceBinding || deviceBinding.length < 8) {
    const err = new Error('DEVICE_BINDING_REQUIRED');
    err.code = 'INVALID_INSTALLATION';
    throw err;
  }
  const active = db.installations.filter((i) => i.login === user.login && i.status === 'ACTIVE');
  if (active.length >= MAX_ACTIVE_INSTALLATIONS) {
    const oldest = active.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
    if (oldest) {
      oldest.status = 'REVOKED';
      oldest.revokedAt = new Date().toISOString();
    }
  }
  const installationId = uuidv4();
  const row = {
    installationId,
    accountId: user.uid,
    login: user.login,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    status: 'ACTIVE',
    deviceBinding,
    clientVersion: String(body.clientVersion || '1.21.11').slice(0, 32),
    launcherVersion: String(body.launcherVersion || '1.0.0').slice(0, 32),
    revokedAt: null,
  };
  db.installations.push(row);
  if (db.installations.length > 2000) db.installations = db.installations.slice(-2000);
  return row;
}

function resetInstallation(db, login) {
  ensureProtectionDb(db);
  const now = new Date().toISOString();
  for (const i of db.installations) {
    if (i.login === login && i.status === 'ACTIVE') {
      i.status = 'REVOKED';
      i.revokedAt = now;
    }
  }
  for (const s of Object.values(db.launchSessions)) {
    if (s.login === login && s.status === 'ACTIVE') {
      s.status = 'REVOKED';
      s.revokedAt = now;
    }
  }
}

function createLaunchSession(db, user, installation, build) {
  ensureProtectionDb(db);
  const sessionId = uuidv4();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  const sessionPayloadKey = crypto.randomBytes(32);
  const session = {
    sessionId,
    accountId: user.uid,
    login: user.login,
    installationId: installation.installationId,
    buildId: build.buildId,
    channel: buildChannel(build),
    nonce,
    nonceUsedAt: null,
    payloadIssuedAt: null,
    issuedAt: new Date(now).toISOString(),
    issuedAtMs: now,
    expiresAt: new Date(now + LAUNCH_SESSION_TTL_MS).toISOString(),
    expiresAtMs: now + LAUNCH_SESSION_TTL_MS,
    hardExpiresAtMs: now + LAUNCH_SESSION_HARD_MAX_MS,
    lastSeenAt: new Date(now).toISOString(),
    status: 'ACTIVE',
    payloadKeyB64: sessionPayloadKey.toString('base64'),
    manifestVersion: build.manifestVersion || 1,
  };
  const attestationBody = {
    schemaVersion: 1,
    sessionId: session.sessionId,
    accountId: session.accountId,
    login: session.login,
    installationId: session.installationId,
    buildId: session.buildId,
    nonce: session.nonce,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
  };
  session.attestation = signManifestBody(attestationBody);
  db.launchSessions[sessionId] = session;
  return session;
}

function revokeLaunchSessionsForLogin(db, login, reason) {
  ensureProtectionDb(db);
  const now = new Date().toISOString();
  let n = 0;
  for (const s of Object.values(db.launchSessions)) {
    if (s.login === login && s.status === 'ACTIVE') {
      s.status = 'REVOKED';
      s.revokedAt = now;
      s.revokeReason = reason || 'REVOKED';
      n += 1;
    }
  }
  return n;
}

function loadBuildEnvelope(channel) {
  const file = payloadFilePath(normalizeChannel(channel));
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return parsed;
}

function issueSessionPayload(session, build) {
  if (!session || session.status !== 'ACTIVE') {
    const err = new Error('INVALID_SESSION');
    err.code = 'INVALID_SESSION';
    throw err;
  }
  if (session.nonceUsedAt || session.payloadIssuedAt) {
    const err = new Error('REPLAY');
    err.code = 'INVALID_SESSION';
    throw err;
  }
  const now = Date.now();
  if (session.hardExpiresAtMs && now > session.hardExpiresAtMs) {
    session.status = 'EXPIRED';
    const err = new Error('SESSION_EXPIRED');
    err.code = 'INVALID_SESSION';
    throw err;
  }
  if (session.expiresAtMs && now > session.expiresAtMs) {
    session.status = 'EXPIRED';
    const err = new Error('SESSION_EXPIRED');
    err.code = 'INVALID_SESSION';
    throw err;
  }
  const channel = normalizeChannel(session.channel || (build && build.channel) || CHANNEL_STABLE);
  const envelope = loadBuildEnvelope(channel);
  if (!envelope || !build || !build.payloadKeyB64) {
    const err = new Error('CORRUPT_PAYLOAD');
    err.code = 'CORRUPT_PAYLOAD';
    throw err;
  }
  const buildKey = Buffer.from(build.payloadKeyB64, 'base64');
  let plain;
  try {
    plain = aesGcmDecrypt(
      { iv: envelope.iv, tag: envelope.tag, ciphertext: envelope.ciphertext },
      buildKey,
    );
  } catch (_) {
    const err = new Error('CORRUPT_PAYLOAD');
    err.code = 'CORRUPT_PAYLOAD';
    throw err;
  }
  const sessionKey = Buffer.from(session.payloadKeyB64, 'base64');
  const reenc = aesGcmEncrypt(plain, sessionKey);
  const sessionEnvelope = {
    buildId: build.buildId,
    payloadId: `${envelope.payloadId || build.payloadId}-s`,
    sessionId: session.sessionId,
    iv: reenc.iv,
    tag: reenc.tag,
    ciphertext: reenc.ciphertext,
    plaintextSha256: build.plaintextSha256 || envelope.plaintextSha256,
    alg: 'AES-256-GCM',
    sessionBound: true,
  };
  sessionEnvelope.payloadSha256 = sha256Buf(
    Buffer.from(
      JSON.stringify({
        iv: sessionEnvelope.iv,
        tag: sessionEnvelope.tag,
        ciphertext: sessionEnvelope.ciphertext,
        payloadId: sessionEnvelope.payloadId,
        sessionId: session.sessionId,
      }),
    ),
  );
  sessionEnvelope.payloadSize = Buffer.byteLength(JSON.stringify(sessionEnvelope));
  session.nonceUsedAt = new Date().toISOString();
  session.payloadIssuedAt = session.nonceUsedAt;
  return sessionEnvelope;
}

function publicSessionView(session) {
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    accountId: session.accountId,
    login: session.login,
    installationId: session.installationId,
    buildId: session.buildId,
    channel: session.channel || 'stable',
    nonce: session.nonce,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
    status: session.status,
    manifestVersion: session.manifestVersion,
    payloadAuthorization: true,
    attestation: session.attestation || null,
    hardExpiresAt: session.hardExpiresAtMs ? new Date(session.hardExpiresAtMs).toISOString() : null,
  };
}

function sanitizeSessionForAdmin(session) {
  if (!session) return null;
  const { payloadKeyB64, ...rest } = session;
  return rest;
}

function getLaunchSession(db, sessionId) {
  ensureProtectionDb(db);
  return db.launchSessions[sessionId] || null;
}

function touchLaunchSession(session) {
  session.lastSeenAt = new Date().toISOString();
  const now = Date.now();
  if (session.status !== 'ACTIVE') return;
  if (session.hardExpiresAtMs && now > session.hardExpiresAtMs) {
    session.status = 'EXPIRED';
    return;
  }
  if (session.expiresAtMs && now > session.expiresAtMs) {
    session.status = 'EXPIRED';
  }
}

const CHANNEL_STABLE = 'stable';
const CHANNEL_DEVELOPER = 'developer';

function normalizeChannel(raw) {
  const c = String(raw || CHANNEL_STABLE).trim().toLowerCase();
  if (c === 'dev' || c === 'developer' || c === 'developer-v') return CHANNEL_DEVELOPER;
  return CHANNEL_STABLE;
}

function buildChannel(build) {
  if (!build) return CHANNEL_STABLE;
  return normalizeChannel(build.channel || CHANNEL_STABLE);
}

function payloadFilePath(channel) {
  const ch = normalizeChannel(channel);
  if (ch === CHANNEL_DEVELOPER) return path.join(keysDir(), 'client.payload.dev.enc.json');
  return path.join(keysDir(), 'client.payload.enc.json');
}

function payloadKeyFilePath(channel) {
  const ch = normalizeChannel(channel);
  if (ch === CHANNEL_DEVELOPER) return path.join(keysDir(), 'client.payload.dev.key.b64');
  return path.join(keysDir(), 'client.payload.key.b64');
}

function activeBuild(db, channel) {
  ensureProtectionDb(db);
  const ch = normalizeChannel(channel || CHANNEL_STABLE);
  return db.builds.find((b) => b.state === 'ENABLED' && buildChannel(b) === ch) || null;
}

function readPayloadDisk(channel) {
  const ch = normalizeChannel(channel);
  const payloadPath = payloadFilePath(ch);
  if (!fs.existsSync(payloadPath)) return null;
  const enc = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  let payloadKeyB64 = enc.payloadKeyB64;
  if (!payloadKeyB64) {
    const keyFile = payloadKeyFilePath(ch);
    if (fs.existsSync(keyFile)) payloadKeyB64 = fs.readFileSync(keyFile, 'utf8').trim();
  }
  if (!payloadKeyB64) return null;
  return { enc, payloadKeyB64, channel: ch };
}

function makeBuildFromDisk(channel, enc, payloadKeyB64) {
  const ch = normalizeChannel(channel);
  const suffix = ch === CHANNEL_DEVELOPER ? '-dev' : '';
  return {
    buildId: `${enc.buildId || '1.0.0'}${suffix}`,
    channel: ch,
    state: 'ENABLED',
    minecraftVersion: '1.21.11',
    fabricLoader: '0.19.3',
    clientVersion: ch === CHANNEL_DEVELOPER ? 'Developer -v' : 'Fabric 1.21.11 BETA',
    manifestVersion: 1,
    payloadId: enc.payloadId,
    payloadSha256: enc.payloadSha256,
    plaintextSha256: enc.plaintextSha256,
    payloadSize: enc.payloadSize,
    payloadKeyB64,
    createdAt: new Date().toISOString(),
  };
}

function syncBuildFromDisk(db, channel) {
  ensureProtectionDb(db);
  const ch = normalizeChannel(channel);
  const disk = readPayloadDisk(ch);
  if (!disk) return activeBuild(db, ch);
  const existing = activeBuild(db, ch);
  if (
    existing
    && existing.payloadSha256 === disk.enc.payloadSha256
    && existing.plaintextSha256 === disk.enc.plaintextSha256
  ) {
    return existing;
  }
  for (const b of db.builds) {
    if (b.state === 'ENABLED' && buildChannel(b) === ch) {
      b.state = 'REVOKED';
      b.revokedAt = new Date().toISOString();
    }
  }
  const build = makeBuildFromDisk(ch, disk.enc, disk.payloadKeyB64);
  db.builds.push(build);
  return build;
}

function ensureDefaultBuild(db, channel) {
  ensureProtectionDb(db);
  const ch = normalizeChannel(channel || CHANNEL_STABLE);
  const synced = syncBuildFromDisk(db, ch);
  if (synced) return synced;
  if (ch === CHANNEL_STABLE) {
    const envBuild = String(process.env.PROTECTION_BUILD_JSON || '').trim();
    if (envBuild) {
      try {
        const build = JSON.parse(envBuild);
        if (build && build.buildId && build.payloadKeyB64) {
          build.state = 'ENABLED';
          build.channel = CHANNEL_STABLE;
          db.builds.push(build);
          return build;
        }
      } catch (_) {}
    }
  }
  return null;
}

function promoteDeveloperToStable(db) {
  ensureProtectionDb(db);
  const devPath = payloadFilePath(CHANNEL_DEVELOPER);
  const devKeyPath = payloadKeyFilePath(CHANNEL_DEVELOPER);
  if (!fs.existsSync(devPath)) {
    const err = new Error('Developer payload отсутствует');
    err.code = 'UNSUPPORTED_BUILD';
    throw err;
  }
  const stablePath = payloadFilePath(CHANNEL_STABLE);
  const stableKeyPath = payloadKeyFilePath(CHANNEL_STABLE);
  fs.copyFileSync(devPath, `${stablePath}.partial`);
  fs.renameSync(`${stablePath}.partial`, stablePath);
  if (fs.existsSync(devKeyPath)) {
    fs.copyFileSync(devKeyPath, `${stableKeyPath}.partial`);
    fs.renameSync(`${stableKeyPath}.partial`, stableKeyPath);
  }
  const build = syncBuildFromDisk(db, CHANNEL_STABLE);
  if (!build) {
    const err = new Error('Не удалось зарегистрировать stable build');
    err.code = 'UNSUPPORTED_BUILD';
    throw err;
  }
  return build;
}

function ok(data) {
  return { ok: true, code: 'OK', data };
}

function fail(code, message) {
  return { ok: false, code, message };
}

module.exports = {
  LAUNCH_SESSION_TTL_MS,
  LAUNCH_SESSION_HARD_MAX_MS,
  MAX_ACTIVE_INSTALLATIONS,
  rateLimit,
  ensureProtectionDb,
  loadOrCreateSigningKeys,
  canonicalJson,
  signManifestBody,
  verifyManifest,
  aesGcmEncrypt,
  aesGcmDecrypt,
  sha256Buf,
  pushProtectionEvent,
  findActiveInstallation,
  enrollInstallation,
  resetInstallation,
  createLaunchSession,
  getLaunchSession,
  touchLaunchSession,
  revokeLaunchSessionsForLogin,
  issueSessionPayload,
  publicSessionView,
  sanitizeSessionForAdmin,
  CHANNEL_STABLE,
  CHANNEL_DEVELOPER,
  normalizeChannel,
  buildChannel,
  activeBuild,
  ensureDefaultBuild,
  syncBuildFromDisk,
  promoteDeveloperToStable,
  payloadFilePath,
  payloadKeyFilePath,
  payloadMasterKey,
  ok,
  fail,
  keysDir,
};
