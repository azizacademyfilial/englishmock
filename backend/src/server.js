require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 5000;
const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');
const tokens = new Map();

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const REQUIRE_POSTGRES = process.env.REQUIRE_POSTGRES !== 'false';
const JWT_SECRET = process.env.JWT_SECRET || 'english-mock-dev-secret-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-5.5').trim();

let pgPool = null;
let dbCache = null;
let pgWriteQueue = Promise.resolve();
let lastPgError = null;

const allowedOrigins = (process.env.CLIENT_URL || process.env.FRONTEND_URL || 'http://127.0.0.1:5173,http://localhost:5173')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);

function isAllowedCorsOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    if (process.env.ALLOW_NETLIFY_PREVIEWS !== 'false' && host.endsWith('.netlify.app')) return true;
  } catch {}
  return false;
}

app.disable('x-powered-by');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cache-Control', req.path.startsWith('/api/admin') ? 'no-store' : 'no-cache');
  next();
}

function createRateLimiter({ windowMs, max, key = req => req.ip, message = 'Juda ko‘p so‘rov yuborildi. Birozdan keyin qayta urinib ko‘ring.' }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const id = key(req) || req.ip || 'unknown';
    const current = hits.get(id) || { count: 0, resetAt: now + windowMs };
    if (current.resetAt <= now) {
      current.count = 0;
      current.resetAt = now + windowMs;
    }
    current.count += 1;
    hits.set(id, current);
    if (current.count > max) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ message });
    }
    if (hits.size > 5000 && Math.random() < 0.02) {
      for (const [k, v] of hits.entries()) if (v.resetAt <= now) hits.delete(k);
    }
    next();
  };
}

const loginRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 15,
  key: req => `${req.ip}:${String(req.body?.username || '').toLowerCase()}`,
  message: 'Login urinishlari ko‘payib ketdi. 15 daqiqadan keyin qayta urinib ko‘ring.'
});
const adminRateLimit = createRateLimiter({ windowMs: 60 * 1000, max: 240 });
const adminWriteRateLimit = createRateLimiter({ windowMs: 60 * 1000, max: 80 });
const publicCertificateRateLimit = createRateLimiter({ windowMs: 60 * 1000, max: 120 });

function toInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function paginateList(list, req, defaultPageSize = 25, maxPageSize = 100) {
  const page = toInt(req.query.page, 1, 1, 1000000);
  const pageSize = toInt(req.query.pageSize || req.query.limit, defaultPageSize, 1, maxPageSize);
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  return { page: safePage, pageSize, total, totalPages, items: list.slice(start, start + pageSize) };
}
function normalizeSearch(value = '') {
  return String(value).trim().toLowerCase().replace(/[‘’`´]/g, "'").replace(/\s+/g, ' ');
}
function safeIncludes(text, query) {
  if (!query) return true;
  return normalizeSearch(text).includes(query);
}


function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
}
function addActionLog(db, actor, action, target = '', details = {}, req = null) {
  if (!db) return;
  if (!Array.isArray(db.actionLogs)) db.actionLogs = [];
  const item = {
    id: makeId('log'),
    createdAt: new Date().toISOString(),
    actorId: actor?.id || '',
    actorName: actor?.fullName || actor?.username || 'system',
    actorRole: actor?.role || 'system',
    action,
    target,
    details,
    ip: req ? clientIp(req) : ''
  };
  db.actionLogs.unshift(item);
  db.actionLogs = db.actionLogs.slice(0, 1500);
}
function addSystemLog(level, message, details = {}) {
  try {
    const db = dbCache || { systemLogs: [] };
    if (!Array.isArray(db.systemLogs)) db.systemLogs = [];
    db.systemLogs.unshift({ id: makeId('sys'), createdAt: new Date().toISOString(), level, message, details });
    db.systemLogs = db.systemLogs.slice(0, 800);
    if (dbCache) writeDb(db);
  } catch (err) {
    console.error('System log error:', err.message);
  }
}
function csvEscape(value = '') {
  const text = String(value ?? '').replace(/\r?\n/g, ' ');
  if (/[",;]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}
function toCsv(rows, headers) {
  const head = headers.map(h => csvEscape(h.label)).join(',');
  const body = rows.map(row => headers.map(h => csvEscape(typeof h.value === 'function' ? h.value(row) : row[h.value])).join(',')).join('\n');
  return '\ufeff' + head + (body ? '\n' + body : '');
}
function parseCsvLine(line = '') {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
function parseCsv(text = '') {
  const lines = String(text).replace(/^\ufeff/, '').split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map(h => normalizeSearch(h));
  return lines.slice(1).map(line => {
    const cols = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i] || ''; });
    return row;
  });
}
function backupDirPath() {
  return path.join(__dirname, '..', 'backups');
}
function ensureBackupDir() {
  const dir = backupDirPath();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function createBackupFile(db, reason = 'manual', actor = null) {
  const dir = ensureBackupDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `backup-${stamp}-${reason}.json`;
  const payload = {
    createdAt: new Date().toISOString(),
    reason,
    actor: actor ? { id: actor.id, username: actor.username, fullName: actor.fullName } : null,
    counts: {
      users: db.users?.length || 0,
      enrollments: db.enrollments?.length || 0,
      certificates: db.certificates?.length || 0,
      progressUsers: Object.keys(db.progress || {}).length
    },
    data: db
  };
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(payload, null, 2));
  return { filename, ...payload.counts, createdAt: payload.createdAt, reason, size: fs.statSync(path.join(dir, filename)).size };
}
function listBackups() {
  const dir = ensureBackupDir();
  return fs.readdirSync(dir)
    .filter(name => /^backup-.*\.json$/.test(name))
    .map(name => {
      const stat = fs.statSync(path.join(dir, name));
      return { filename: name, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
function publicVerificationData(db, rawCert) {
  const cert = hydrateCertificate(db, rawCert);
  return {
    valid: true,
    id: cert.id,
    code: cert.code,
    fullName: cert.fullName,
    subject: cert.language,
    subjectTitle: subjectMap[cert.language] || cert.language,
    level: cert.level,
    score: cert.score,
    createdAt: cert.createdAt
  };
}
function normalizePaymentStatus(value) {
  const raw = String(value || 'paid').trim().toLowerCase();
  if (['unpaid', 'partial', 'trial', 'qisman', 'sinov', 'to‘lanmagan', "to'lanmagan", 'tolanmagan', 'not_paid'].includes(raw)) return 'unpaid';
  return 'paid';
}
function paymentStatusLabel(value) {
  return normalizePaymentStatus(value) === 'unpaid' ? 'To‘lanmagan' : 'To‘langan';
}
function clearUserSessions(user) {
  if (!user) return;
  if (user.sessionToken) tokens.delete(user.sessionToken);
  if (user.id) {
    for (const [oldToken, oldUserId] of tokens.entries()) {
      if (oldUserId === user.id) tokens.delete(oldToken);
    }
  }
  user.sessionToken = '';
  user.sessionId = '';
  user.sessionUpdatedAt = new Date().toISOString();
}
function enforcePaymentAccess(user) {
  if (!user || user.role !== 'student') return false;
  const normalized = normalizePaymentStatus(user.paymentStatus);
  const changed = user.paymentStatus !== normalized || (normalized === 'unpaid' && user.isActive !== false);
  user.paymentStatus = normalized;
  if (normalized === 'unpaid') {
    user.isActive = false;
    clearUserSessions(user);
  }
  return changed;
}
function topicOverrideKey(language, level, topicNo) {
  return `${language}:${level}:${topicNo}`;
}
function applyTopicOverride(db, topic) {
  const overrides = db?.customContent?.topics?.[topicOverrideKey(topic.language, topic.level, topic.topicNo)];
  if (!overrides) return topic;
  const next = { ...topic };
  if (overrides.youtubeVideo) next.youtubeVideo = { ...(next.youtubeVideo || {}), ...overrides.youtubeVideo };
  if (overrides.extraNote) next.explanation = [...(next.explanation || []), { heading: 'Admin qo‘shimcha izohi', text: overrides.extraNote }];
  if (Array.isArray(overrides.vocabulary) && overrides.vocabulary.length) {
    const existing = new Set((next.vocabulary || []).map(v => String(v.word || '').toLowerCase()));
    const extra = overrides.vocabulary.filter(v => v.word && !existing.has(String(v.word).toLowerCase())).map((v, idx) => ({ id: `admin-${idx + 1}`, ...v }));
    next.vocabulary = [...extra, ...(next.vocabulary || [])].slice(0, VOCABULARY_ITEM_COUNT);
  }
  if (Array.isArray(overrides.questions) && overrides.questions.length) {
    const clean = overrides.questions.filter(q => q.question && Array.isArray(q.options) && q.options.length >= 2).map((q, idx) => {
      const packed = forceCorrectAnswerA(q.options, Number(q.correctIndex || 0), idx + 31);
      return { id: `admin-q${idx + 1}`, question: q.question, options: packed.options, correctIndex: packed.correctIndex, note: q.note || 'Admin qo‘shgan savol' };
    });
    next.questions = clean.length ? clean : next.questions;
  }
  return next;
}
function buildNotifications(db, currentAdmin) {
  const now = new Date();
  const students = db.users.filter(u => u.role === 'student' && canAdminAccessCenter(currentAdmin, centerIdOf(u)) && (currentAdmin.subject === 'all' || u.subject === currentAdmin.subject));
  const notes = [];
  for (const user of students) {
    const safe = safeUser(user, db);
    if (safe.status === 'expired') notes.push({ type: 'expired', tone: 'danger', userId: user.id, title: `${user.fullName} muddati tugagan`, text: `${safe.subjectTitle} · ${fmtDateSafe(user.expiresAt)}` });
    if (user.paymentStatus === 'unpaid') notes.push({ type: 'payment', tone: 'warning', userId: user.id, title: `${user.fullName} to‘lov qilmagan`, text: `${safe.subjectTitle} · ${paymentStatusLabel(user.paymentStatus)}` });
    if (safe.progressPercent < 30) notes.push({ type: 'weak', tone: 'warning', userId: user.id, title: `${user.fullName} progressi past`, text: `${safe.progressPercent}% · ${safe.currentTopicTitle || 'Boshlanmagan'}` });
    if (user.lastLoginAt) {
      const days = Math.floor((now - new Date(user.lastLoginAt)) / 86400000);
      if (days >= 3) notes.push({ type: 'inactive', tone: 'info', userId: user.id, title: `${user.fullName} ${days} kundan beri kirmagan`, text: `${safe.subjectTitle} · oxirgi kirish: ${fmtDateSafe(user.lastLoginAt)}` });
    } else {
      notes.push({ type: 'never_login', tone: 'info', userId: user.id, title: `${user.fullName} hali login qilmagan`, text: safe.subjectTitle });
    }
  }
  return notes.slice(0, 60);
}
function fmtDateSafe(value) {
  if (!value) return '—';
  try { return new Date(value).toLocaleDateString('uz-UZ'); } catch { return value; }
}

app.use(securityHeaders);
app.use(cors({
  origin(origin, callback) {
    if (isAllowedCorsOrigin(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use('/api/admin', adminRateLimit);
app.use('/certificate', publicCertificateRateLimit);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'ENGLISH Mock backend', database: DATABASE_URL ? 'postgresql' : 'missing', openaiEnabled: Boolean(OPENAI_API_KEY), openaiModel: OPENAI_MODEL, time: new Date().toISOString() });
});

if (REQUIRE_POSTGRES && (!JWT_SECRET || JWT_SECRET.length < 24 || JWT_SECRET === 'al_aziz_secret_key' || JWT_SECRET.includes('dev-secret'))) {
  console.warn('⚠️  JWT_SECRET juda sodda. Real ishga tushirishdan oldin backend/.env ichida uzun va maxfiy JWT_SECRET yozing.');
}

const subjects = [
  { id: 'english', title: 'Ingliz tili', short: 'EN' },
  { id: 'russia', title: 'Rus tili', short: 'RU' },
  { id: 'koreys', title: 'Koreys tili', short: 'KR' },
  { id: 'ona_tili', title: 'Ona tili', short: 'OT' },
  { id: 'tarix', title: 'Tarix', short: 'TX' }
];
const subjectMap = Object.fromEntries(subjects.map(s => [s.id, s.title]));

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatCertificateDate(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('uz-UZ', { year: 'numeric', month: 'long', day: 'numeric' });
}

const CERTIFICATE_LOGO_PATH = path.join(__dirname, 'assets', 'aziz-academy-logo-transparent.png');

function imageDataUri(filePath, mime) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const resolvedMime = mime || (ext === '.png' ? 'image/png' : ext === '.svg' ? 'image/svg+xml' : 'image/jpeg');
    return `data:${resolvedMime};base64,${fs.readFileSync(filePath).toString('base64')}`;
  } catch {
    return '';
  }
}


function createQrSvg(value, size = 78) {
  if (!value) return '';
  try {
    const qr = QRCode.create(value, { errorCorrectionLevel: 'M', margin: 2 });
    const count = qr.modules.size;
    const data = qr.modules.data;
    const quiet = 2;
    const total = count + quiet * 2;
    const cell = size / total;
    const rects = [];
    for (let y = 0; y < count; y++) {
      for (let x = 0; x < count; x++) {
        if (data[y * count + x]) {
          rects.push(`<rect x="${((x + quiet) * cell).toFixed(2)}" y="${((y + quiet) * cell).toFixed(2)}" width="${Math.ceil(cell * 100) / 100}" height="${Math.ceil(cell * 100) / 100}"/>`);
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Sertifikat QR"><rect width="${size}" height="${size}" fill="#fff"/> <g fill="#111">${rects.join('')}</g></svg>`;
  } catch {
    return '';
  }
}
function pdfQrOps(value, x, y, size, color = [0, 0, 0]) {
  if (!value) return [];
  try {
    const qr = QRCode.create(value, { errorCorrectionLevel: 'M', margin: 2 });
    const count = qr.modules.size;
    const data = qr.modules.data;
    const quiet = 2;
    const total = count + quiet * 2;
    const cell = size / total;
    const ops = [`q 1 1 1 rg ${x} ${y} ${size} ${size} re f Q`, `q ${color.join(' ')} rg`];
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (data[row * count + col]) {
          ops.push(`${(x + (col + quiet) * cell).toFixed(2)} ${(y + size - (row + quiet + 1) * cell).toFixed(2)} ${Math.ceil(cell * 100) / 100} ${Math.ceil(cell * 100) / 100} re f`);
        }
      }
    }
    ops.push('Q');
    return ops;
  } catch {
    return [];
  }
}

function formatCertificateDateShort(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}.${month}.${year}`;
}

function addYearsToDate(value, years = 2) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  date.setFullYear(date.getFullYear() + years);
  return date.toISOString();
}

function topicCountForLevel(language, level) {
  return Math.max(0, (topicTitles?.[language]?.[level] || []).length);
}

function summarizeSpeakingForLevel(db, userId, language, level) {
  const p = (db?.progress && db.progress[userId]) || {};
  const count = topicCountForLevel(language, level);
  let checkedWords = 0;
  let passedWords = 0;
  let totalWords = 0;
  let attempts = 0;
  let weightedScore = 0;
  for (let topicNo = 1; topicNo <= count; topicNo += 1) {
    const summary = summarizeSpeakingRecord(p[speakingProgressKey(language, level, topicNo)] || {}, VOCABULARY_ITEM_COUNT);
    checkedWords += Number(summary.checkedWords || 0);
    passedWords += Number(summary.passedWords || 0);
    totalWords += Number(summary.totalWords || 0);
    attempts += Number(summary.attempts || 0);
    weightedScore += Number(summary.score || 0) * Number(summary.totalWords || 0);
  }
  const percent = totalWords ? Math.round(weightedScore / totalWords) : 0;
  return { percent, checkedWords, passedWords, totalWords, attempts };
}

function subjectCertificateConfig(language) {
  const map = {
    english: {
      cls: 'cert-english',
      title: 'ENGLISH SERTIFIKATI',
      subjectLabel: 'English',
      codePrefix: 'ENG',
      intro: 'USHBU SERTIFIKAT BILAN',
      text: 'muvaffaqiyatli tarzda English kursini tamomlagani va yuqori natija bilan yakunlagani tasdiqlanadi.',
      verifyText: 'TEKSHIRISH UCHUN<br>QR KODNI SKANER QILING',
      sealText: 'ENGLISH<br>MOCK<br>CERTIFIED',
      topNote: 'Professional English Certificate'
    },
    russia: {
      cls: 'cert-russian',
      title: 'RUS TILI SERTIFIKATI',
      subjectLabel: 'Rus tili',
      codePrefix: 'RUS',
      intro: 'Ushbu sertifikat',
      text: 'ENGLISH Mock tomonidan tashkil etilgan rus tili kursini muvaffaqiyatli tamomlagani va yuqori natija ko‘rsatgani uchun ushbu sertifikat bilan taqdirlanadi.',
      verifyText: 'Sertifikatning haqiqiyligini<br>tekshirish uchun QR kodni<br>skaner qiling',
      sealText: 'ENGLISH<br>MOCK<br>CERTIFIED',
      topNote: 'Formal Russian Language Certificate'
    },
    tarix: {
      cls: 'cert-history',
      title: 'TARIX SERTIFIKATI',
      subjectLabel: 'Tarix',
      codePrefix: 'TAR',
      intro: 'Ushbu sertifikat tasdiqlaydi',
      text: 'ENGLISH Mock tomonidan tashkil etilgan tarix kursini muvaffaqiyatli tamomlaganini va yuqori natija bilan yakunlaganini tasdiqlaydi.',
      verifyText: 'Tekshirish uchun<br>skanerlang',
      sealText: 'ENGLISH<br>MOCK<br>CERTIFIED',
      topNote: 'History Achievement Certificate'
    },
    ona_tili: {
      cls: 'cert-ona',
      title: 'ONA TILI SERTIFIKATI',
      subjectLabel: 'Ona tili',
      codePrefix: 'ONA',
      intro: 'Ushbu sertifikat bilan',
      text: 'Ona tili fanini muvaffaqiyatli tamomlagani va yakuniy baholashdan yuqori natija ko‘rsatgani uchun taqdim etiladi.',
      verifyText: 'Sertifikatni tekshirish uchun<br>QR kodni skaner qiling',
      sealText: 'ENGLISH<br>MOCK<br>CERTIFIED',
      topNote: 'Official Uzbek Language Certificate'
    },
    koreys: {
      cls: 'cert-korean',
      title: 'KOREYS TILI SERTIFIKATI',
      subjectLabel: 'Koreys tili',
      codePrefix: 'KOR',
      intro: 'Ushbu sertifikat bilan',
      text: 'Koreys tili kursini muvaffaqiyatli tamomlagani va yakuniy baholashdan yuqori natija ko‘rsatgani uchun taqdim etiladi.',
      verifyText: 'Sertifikatni tekshirish uchun<br>QR kodni skaner qiling',
      sealText: 'ENGLISH<br>MOCK<br>CERTIFIED',
      topNote: 'Korean Language Certificate'
    }
  };
  return map[language] || {
    cls: 'cert-default',
    title: `${subjectMap[language] || 'FAN'} SERTIFIKATI`,
    subjectLabel: subjectMap[language] || 'Fan',
    codePrefix: 'GEN',
    intro: 'Ushbu sertifikat bilan',
    text: 'Kursni muvaffaqiyatli tamomlagani va yakuniy baholashdan yuqori natija ko‘rsatgani uchun taqdim etiladi.',
    verifyText: 'Sertifikatni tekshirish uchun<br>QR kodni skaner qiling',
    sealText: 'ENGLISH Mock<br>CERTIFIED',
    topNote: 'Official Certificate'
  };
}

function makeCertificateCode(language, level) {
  const cfg = subjectCertificateConfig(language);
  const random = String(crypto.randomInt(100000, 999999));
  return `EM-${cfg.codePrefix}-${level}-${random}`;
}


function certificateRankByScore(score = 0) {
  const value = clampScore(score);
  if (value >= 90) return 'A’lo';
  if (value >= 80) return 'Yaxshi';
  if (value >= 70) return 'Qoniqarli';
  return 'Ishtirok etdi';
}

function issueOrUpdateLevelCertificate(db, user, language, level, score) {
  const now = new Date().toISOString();
  const mastery = clampScore(score);
  let certificate = db.certificates.find(c => c.userId === user.id && c.language === language && c.level === level);
  const levelSpeaking = summarizeSpeakingForLevel(db, user.id, language, level);
  const certificateData = {
    fullName: user.fullName,
    birthDate: user.birthDate || '',
    language,
    level,
    score: mastery,
    grammarPercent: mastery,
    vocabularyPercent: clampScore(levelSpeaking.percent || 0),
    overallPercent: mastery,
    masteryPercent: mastery,
    rank: certificateRankByScore(mastery),
    centerId: centerIdOf(user),
    updatedAt: now
  };

  if (!certificate) {
    certificate = {
      id: makeId('cert'),
      code: makeCertificateCode(language, level),
      userId: user.id,
      createdAt: now,
      ...certificateData
    };
    db.certificates.push(certificate);
  } else {
    const bestScore = Math.max(Number(certificate.score || 0), mastery);
    const bestRank = certificateRankByScore(bestScore);
    Object.assign(certificate, certificateData, {
      score: bestScore,
      grammarPercent: bestScore,
      overallPercent: bestScore,
      masteryPercent: bestScore,
      rank: bestRank,
      fullName: certificate.fullName || user.fullName,
      birthDate: certificate.birthDate || user.birthDate || ''
    });
  }

  return certificate;
}

function absoluteUrl(req, pathValue) {
  const baseFromEnv = (process.env.PUBLIC_URL || process.env.PUBLIC_APP_URL || '').trim().replace(/\/$/, '');
  if (baseFromEnv) return `${baseFromEnv}${pathValue}`;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  const host = req.get('host');
  return `${proto}://${host}${pathValue}`;
}

function hydrateCertificate(db, cert) {
  const owner = db.users.find(u => u.id === cert.userId);
  const ownerName = owner?.fullName || owner?.username || '';
  const certName = cert.fullName || '';
  const genericName = /^(tarix|ona\s*tili|rus\s*tili|koreys\s*tili|ingliz\s*tili|english|student|o[‘'`]quvchi)\s+o[‘'`]quvchi$/i;
  let fullName = ownerName || certName || owner?.username || 'Foydalanuvchi';
  if (genericName.test(String(fullName).trim()) && certName && !genericName.test(String(certName).trim())) fullName = certName;

  const birthDateRaw = cert.birthDate || owner?.birthDate || '';
  const issueDate = formatCertificateDateShort(cert.createdAt);
  const validUntil = formatCertificateDateShort(cert.validUntil || addYearsToDate(cert.createdAt, 2));
  const levelSpeaking = summarizeSpeakingForLevel(db, cert.userId, cert.language, cert.level);
  const grammarPercent = clampScore(cert.grammarPercent ?? cert.score ?? 0);
  const vocabularyPercent = clampScore(cert.vocabularyPercent ?? levelSpeaking.percent ?? 0);
  const overallPercent = clampScore(cert.overallPercent ?? Math.round((grammarPercent + vocabularyPercent) / 2));

  return {
    ...cert,
    fullName,
    birthDate: birthDateRaw,
    birthDateFull: formatCertificateDateShort(birthDateRaw),
    issueDate,
    validUntil,
    grammarPercent,
    vocabularyPercent,
    overallPercent,
    masteryPercent: clampScore(cert.masteryPercent ?? cert.overallPercent ?? cert.score ?? overallPercent),
    rank: cert.rank || certificateRankByScore(cert.score ?? overallPercent),
    vocabularyPassedWords: Number(levelSpeaking.passedWords || 0),
    vocabularyCheckedWords: Number(levelSpeaking.checkedWords || 0),
    vocabularyTotalWords: Number(levelSpeaking.totalWords || 0)
  };
}


function pdfEscape(value = '') {
  return String(value)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[^\x20-\x7E]/g, ch => {
      const map = { 'á':'a','à':'a','é':'e','í':'i','ó':'o','ú':'u','Á':'A','É':'E','Í':'I','Ó':'O','Ú':'U','ʻ':'\'', 'ʼ':'\'' };
      return map[ch] || '';
    });
}
function pdfText(text, x, y, size = 14, font = 'F1', color = [0,0,0]) {
  return `${color[0]} ${color[1]} ${color[2]} rg /${font} ${size} Tf ${x} ${y} Td (${pdfEscape(text)}) Tj`;
}
function buildCertificatePdf(cert, options = {}) {
  const cfg = subjectCertificateConfig(cert.language);
  const W = 842, H = 595;
  const palette = {
    english: { main:[0.04,0.16,0.38], accent:[0.78,0.58,0.17], paper:[0.98,0.99,1], light:[0.93,0.96,1] },
    russia: { main:[0.56,0.08,0.11], accent:[0.75,0.55,0.18], paper:[1,0.98,0.93], light:[1,0.95,0.94] },
    tarix: { main:[0.25,0.16,0.07], accent:[0.70,0.50,0.18], paper:[0.96,0.90,0.76], light:[1,0.96,0.86] },
    ona_tili: { main:[0.05,0.32,0.20], accent:[0.74,0.54,0.16], paper:[0.98,1,0.96], light:[0.93,1,0.94] }
  }[cert.language] || { main:[0.08,0.20,0.42], accent:[0.78,0.58,0.17], paper:[1,1,1], light:[0.96,0.98,1] };
  const subjectTitle = cfg.subjectLabel || subjectMap[cert.language] || cert.language || 'Fan';
  const name = cert.fullName || 'Oquvchi';
  const level = cert.level || FIRST_LEVEL;
  const score = `${cert.masteryPercent ?? cert.overallPercent ?? cert.score ?? 0}%`;
  const rank = cert.rank || certificateRankByScore(cert.score ?? cert.overallPercent ?? 0);
  const code = cert.code || cert.id || 'AZ-CERT';
  const created = formatCertificateDateShort(cert.createdAt);
  const title = cfg.title || 'SERTIFIKAT';
  const publicUrl = options.publicUrl || cert.publicUrl || '';
  const lines = [];
  function rect(x,y,w,h,stroke,fill,lw=1){ lines.push(`q ${fill?fill.join(' ')+' rg':''} ${stroke?stroke.join(' ')+' RG':''} ${lw} w ${x} ${y} ${w} ${h} re ${fill&&stroke?'B':fill?'f':'S'} Q`); }
  function text(t,x,y,size=14,font='F1',color=palette.main){ lines.push(`BT ${pdfText(t,x,y,size,font,color)} ET`); }
  rect(0,0,W,H,null,palette.paper);
  rect(18,18,W-36,H-36,palette.main,null,4);
  rect(28,28,W-56,H-56,palette.accent,null,2);
  rect(40,40,W-80,H-80,palette.accent,null,0.7);
  rect(18,H-80,150,62,null,palette.main);
  rect(W-168,18,150,62,null,palette.main);
  text('AA',70,H-82,46,'F2',[0.02,0.20,1]);
  text('ENGLISH MOCK',58,H-104,16,'F2',[0.02,0.20,1]);
  text(cfg.topNote || 'Official Certificate',W/2-90,H-82,12,'F1',palette.accent);
  text(title,W/2-210,H-145,38,'F2',palette.main);
  text(cfg.intro || 'Ushbu sertifikat bilan',W/2-95,H-182,14,'F2',palette.main);
  text(name,W/2-170,H-238,40,'F3',palette.main);
  text(cfg.text || 'Kursni muvaffaqiyatli yakunlagani uchun berildi.',W/2-260,H-272,13,'F1',palette.main);
  const boxY=250, boxW=170, gap=24, start=(W-(boxW*3+gap*2))/2;
  const infos=[['Fan',subjectTitle],['Daraja',level],['Natija',`${score} · ${rank}`]];
  infos.forEach((it,i)=>{const x=start+i*(boxW+gap); rect(x,boxY,boxW,58,palette.accent,palette.light,1.2); text(it[0]+':',x+18,boxY+34,12,'F2',palette.main); text(it[1],x+70,boxY+22,22,'F2',palette.main);});
  text('Berilgan sana: '+created,88,196,14,'F1',palette.main);
  text('Sertifikat ID: '+code,332,196,14,'F1',palette.main);
  if (publicUrl) text('QR/skaner: '+publicUrl,548,196,9,'F1',palette.main);
  lines.push(`q ${palette.accent.join(' ')} RG 1.2 w 155 105 m 335 105 l S Q`);
  text('Direktor',205,82,14,'F2',palette.main);
  rect(W/2-52,72,104,104,palette.accent,null,2);
  text('A',W/2-18,110,48,'F2',palette.main);
  lines.push(...pdfQrOps(publicUrl, 682, 92, 82, [0,0,0]));
  text('Tekshirish uchun',650,82,11,'F1',palette.main);
  const stream = lines.join('\n');
  const objects=[];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 7 0 R >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>');
  objects.push(`<< /Length ${Buffer.byteLength(stream, 'binary')} >>\nstream\n${stream}\nendstream`);
  let pdf='%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets=[0];
  objects.forEach((obj,i)=>{offsets[i+1]=Buffer.byteLength(pdf,'binary'); pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf,'binary');
  pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for(let i=1;i<=objects.length;i++) pdf+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
  pdf+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf,'binary');
}

function buildCertificateHtml(cert, options = {}) {
  const publicUrl = options.publicUrl || cert.publicUrl || '';
  const qrSvg = createQrSvg(publicUrl || (cert.code || cert.id || ''), 112);
  const fullName = escapeHtml(cert.fullName || 'O‘quvchi');
  const levelRaw = String(cert.level || FIRST_LEVEL);
  const level = escapeHtml(levelRaw.toUpperCase());
  const levelTitle = escapeHtml(levelRaw);
  const scoreValue = clampScore(cert.masteryPercent ?? cert.overallPercent ?? cert.score ?? 0);
  const score = escapeHtml(scoreValue);
  const code = escapeHtml(cert.code || cert.id || 'EM-CERT');
  const issueDate = escapeHtml(cert.issueDate || formatCertificateDateShort(cert.createdAt));
  const pngFileName = `ENGLISH-Mock-${String(levelRaw).replace(/[^a-zA-Z0-9_-]+/g, '-')}-${String(cert.fullName || 'student').replace(/[^a-zA-Z0-9_-]+/g, '-')}.png`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>ENGLISH Mock Certificate</title>
  <style>
    :root{--navy:#061a3f;--navy2:#0a2d63;--gold:#bd8b22;--gold2:#e4b94f;--paper:#fffdf7;--muted:#5b6682}
    *{box-sizing:border-box} body{margin:0;background:#eef2f7;font-family:Arial,Helvetica,sans-serif;color:var(--navy);padding:18px}
    .toolbar{position:sticky;top:0;z-index:5;display:flex;gap:10px;justify-content:center;margin:0 0 14px;flex-wrap:wrap}
    .toolbar button{border:0;border-radius:999px;background:var(--navy);color:#fff;font-weight:800;padding:11px 16px;cursor:pointer;box-shadow:0 10px 24px rgba(6,26,63,.18)}
    .toolbar .secondary{background:#fff;color:var(--navy);border:1px solid #d8dee9}
    .certificate-wrap{width:min(1120px,100%);margin:0 auto;background:white;padding:12px;box-shadow:0 30px 70px rgba(15,23,42,.18)}
    .certificate{position:relative;min-height:760px;overflow:hidden;background:radial-gradient(circle at 50% 35%,#fff 0,#fffdf8 45%,#fbf7ed 100%);border:3px solid var(--gold);padding:58px 76px 34px}
    .certificate:before{content:"";position:absolute;inset:18px;border:2px solid rgba(189,139,34,.75);pointer-events:none;z-index:1}
    .certificate:after{content:"";position:absolute;inset:0;background:linear-gradient(135deg,rgba(6,26,63,.06),transparent 28%,transparent 72%,rgba(6,26,63,.06));pointer-events:none}
    .corner-navy{position:absolute;background:var(--navy);z-index:0}.corner-gold{position:absolute;background:linear-gradient(90deg,var(--gold),var(--gold2));z-index:0}
    .tl{left:-125px;top:-95px;width:420px;height:265px;border-radius:0 0 260px 0;transform:rotate(-9deg)}
    .tl-g{left:-110px;top:78px;width:440px;height:26px;border-radius:40px;transform:rotate(-31deg)}
    .br{right:-150px;bottom:-120px;width:500px;height:305px;border-radius:260px 0 0 0;transform:rotate(-9deg)}
    .br-g{right:-120px;bottom:160px;width:450px;height:24px;border-radius:40px;transform:rotate(-31deg)}
    .content{position:relative;z-index:2;text-align:center}.brand{display:flex;justify-content:center;align-items:center;gap:12px;margin-top:0}
    .brandIcon{width:72px;height:58px;position:relative}.book{position:absolute;left:8px;right:8px;bottom:2px;height:28px;border:5px solid var(--navy);border-top:0;border-radius:0 0 14px 14px}.cap{position:absolute;left:14px;top:0;width:44px;height:24px;background:var(--navy);clip-path:polygon(50% 0,100% 35%,50% 70%,0 35%)}
    .brandText b{display:block;font-size:33px;letter-spacing:1px;color:var(--navy)}.brandText b span{color:var(--gold)}.brandText small{display:block;font-size:13px;letter-spacing:3px;font-weight:800;color:var(--navy);margin-top:4px}
    h1{font-family:Georgia,'Times New Roman',serif;font-size:70px;line-height:.95;letter-spacing:9px;margin:42px 0 8px;color:var(--navy);font-weight:700;text-shadow:0 2px 0 rgba(189,139,34,.12)}
    .subtitle{display:flex;align-items:center;justify-content:center;gap:18px;color:var(--gold);font-size:25px;letter-spacing:11px;font-weight:800;margin-bottom:28px}.subtitle:before,.subtitle:after{content:"";display:block;width:100px;height:2px;background:var(--gold)}
    .presented{font-size:22px;font-weight:700;color:var(--navy);margin:12px 0}.studentName{font-family:'Brush Script MT','Segoe Script',cursive;font-size:66px;line-height:1.05;color:var(--navy);display:inline-block;min-width:470px;border-bottom:2px solid var(--gold);padding:0 35px 2px;margin:4px auto 18px}
    .desc{font-size:22px;line-height:1.45;color:var(--navy);font-weight:600;margin:0 auto 20px;max-width:720px}.desc b{color:var(--gold);font-size:27px}
    .levelBadge{display:inline-block;background:linear-gradient(180deg,var(--navy2),var(--navy));color:white;border:2px solid var(--gold);border-radius:16px;padding:14px 52px;font-size:26px;letter-spacing:3px;font-weight:900;box-shadow:0 10px 0 rgba(189,139,34,.18);margin:2px 0 18px}
    .bottom{display:grid;grid-template-columns:1fr 190px 1fr;align-items:end;gap:24px;margin-top:10px;text-align:left}.dateBox,.idBox{text-align:center}.label{font-size:15px;font-weight:900;color:var(--navy);margin-bottom:8px}.value{font-size:16px;font-weight:900;color:var(--gold);border-bottom:2px solid #e0c27a;display:inline-block;padding:0 12px 8px;min-width:190px}
    .seal{margin:auto;width:148px;height:148px;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle,#0b2b60 0 52%,var(--gold2) 53% 66%,var(--gold) 67%);color:#ffd86a;box-shadow:0 14px 24px rgba(6,26,63,.18);position:relative}.seal b{font-size:22px;text-align:center;line-height:1.05;color:#ffd86a}.seal:after{content:"";position:absolute;bottom:-42px;border-left:28px solid transparent;border-right:28px solid transparent;border-top:54px solid var(--gold);filter:drop-shadow(0 6px 5px rgba(0,0,0,.12))}
    .sign{margin-top:30px;text-align:left}.signature{font-family:'Brush Script MT','Segoe Script',cursive;font-size:36px;color:#0b1533;border-bottom:2px solid #d5b365;display:inline-block;min-width:180px;padding-bottom:2px}.director{font-weight:900;margin-top:6px;color:var(--navy)}.orgName{font-weight:900;color:var(--gold);margin-top:2px}.qr{width:112px;height:112px;background:white;border:2px solid var(--gold);padding:7px;margin:0 auto}.qr svg{width:100%;height:100%;display:block}.mission{text-align:center;margin-top:24px;font-size:19px;font-weight:900;letter-spacing:.4px;color:var(--navy)}
    .watermark{position:absolute;inset:150px 180px 120px;border-radius:50%;border:20px solid rgba(189,139,34,.045);z-index:0}.laurel{position:absolute;top:240px;font-size:230px;color:rgba(6,26,63,.045);z-index:0}.laurel.left{left:210px}.laurel.right{right:210px;transform:scaleX(-1)}
    @page{size:A4 landscape;margin:0}@media print{body{padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}.toolbar{display:none}.certificate-wrap{width:100%;box-shadow:none;padding:0}.certificate{min-height:100vh;border-width:3px}}
    @media(max-width:760px){body{padding:8px}.certificate{padding:38px 22px;min-height:auto}.brandText b{font-size:25px}h1{font-size:40px;letter-spacing:4px}.subtitle{font-size:16px;letter-spacing:5px}.subtitle:before,.subtitle:after{width:44px}.studentName{font-size:44px;min-width:0;width:100%;padding:0 8px}.desc{font-size:17px}.bottom{grid-template-columns:1fr;text-align:center}.sign{text-align:center}.corner-navy,.corner-gold,.laurel,.watermark{display:none}}
  </style>
</head>
<body>
  <script>
    function downloadCertificate(){
      const node = document.querySelector('.certificate-wrap');
      if (!node) return window.print();
      const width = Math.ceil(node.scrollWidth || node.getBoundingClientRect().width || 1120);
      const height = Math.ceil(node.scrollHeight || node.getBoundingClientRect().height || 790);
      const css = Array.from(document.querySelectorAll('style')).map(function(s){ return s.textContent || ''; }).join('\n');
      const clone = node.cloneNode(true); clone.setAttribute('xmlns','http://www.w3.org/1999/xhtml');
      const source = '<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+' '+height+'"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml"><style><![CDATA['+css+']]></style>'+clone.outerHTML+'</div></foreignObject></svg>';
      const img = new Image(); const blob = new Blob([source],{type:'image/svg+xml;charset=utf-8'}); const url = URL.createObjectURL(blob);
      img.onload=function(){ const scale=2; const canvas=document.createElement('canvas'); canvas.width=width*scale; canvas.height=height*scale; const ctx=canvas.getContext('2d'); ctx.scale(scale,scale); ctx.fillStyle='#fff'; ctx.fillRect(0,0,width,height); ctx.drawImage(img,0,0,width,height); URL.revokeObjectURL(url); canvas.toBlob(function(b){ if(!b) return window.print(); const a=document.createElement('a'); const u=URL.createObjectURL(b); a.href=u; a.download='${escapeHtml(pngFileName)}'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function(){URL.revokeObjectURL(u)},1000); },'image/png',1); };
      img.onerror=function(){URL.revokeObjectURL(url); window.print();}; img.src=url;
    }
  </script>
  <div class="toolbar"><button onclick="downloadCertificate()">⬇️ Rasm yuklash</button><button onclick="window.print()">🖨️ PDF / Chop etish</button><button class="secondary" onclick="history.back()">Ortga</button></div>
  <section class="certificate-wrap">
    <article class="certificate">
      <div class="corner-navy tl"></div><div class="corner-gold tl-g"></div><div class="corner-navy br"></div><div class="corner-gold br-g"></div><div class="watermark"></div><div class="laurel left">❦</div><div class="laurel right">❦</div>
      <div class="content">
        <div class="brand"><div class="brandIcon"><div class="cap"></div><div class="book"></div></div><div class="brandText"><b>ENGLISH <span>Mock</span></b><small>LEARN • PRACTICE • SUCCEED</small></div></div>
        <h1>CERTIFICATE</h1><div class="subtitle">OF ACHIEVEMENT</div>
        <div class="presented">This is proudly presented to</div>
        <div class="studentName">${fullName}</div>
        <p class="desc">for successfully completing the <b>${levelTitle}</b> level<br/>and passing the Final Test with a score of <b>${score}%</b></p>
        <div class="levelBadge">${level}</div>
        <div class="bottom">
          <div><div class="dateBox"><div class="label">Date of Completion</div><div class="value">${issueDate}</div></div><div class="sign"><div class="signature">A. Teacher</div><div class="director">Academic Director</div><div class="orgName">ENGLISH Mock</div></div></div>
          <div class="seal"><b>WELL<br/>DONE!</b></div>
          <div><div class="idBox"><div class="label">Certificate ID</div><div class="value">${code}</div></div><div class="qr">${qrSvg || `<span>${code}</span>`}</div></div>
        </div>
        <div class="mission">Your Progress. Our Mission.</div>
      </div>
    </article>
  </section>
</body>
</html>`;
}

const levels = ['Beginner', 'Elementary', 'Pre-Intermediate', 'Intermediate'];
const FIRST_LEVEL = levels[0];
const levelIndex = Object.fromEntries(levels.map((level, index) => [level, index]));

const topicTitles = {
  english: {
    A1: ['To be: am/is/are', 'Articles: a/an/the', 'Plural nouns', 'This, that, these, those', 'Present Simple'],
    A2: ['Present Continuous', 'Past Simple regular verbs', 'Past Simple irregular verbs', 'Future with going to', 'Comparatives', 'Superlatives', 'Modal should', 'Some / Any', 'Much / Many', 'Present Perfect intro', 'Adverbs of manner', 'Object pronouns', 'Gerund basics', 'Invitations', 'A2 conversation'],
    B1: ['Present Perfect', 'Past Continuous', 'First Conditional', 'Second Conditional', 'Passive Voice intro', 'Relative Clauses', 'Reported Speech intro', 'Used to', 'Modal verbs', 'Linking words', 'Phrasal verbs', 'Complex questions', 'Essay basics', 'Speaking opinions', 'B1 review'],
    B2: ['Advanced tenses review', 'Mixed conditionals', 'Passive voice advanced', 'Reported speech', 'Relative clauses advanced', 'Wish / If only', 'Modal deduction', 'Participle clauses', 'Inversion intro', 'Cleft sentences', 'Academic vocabulary', 'Argument essays', 'Speaking debate', 'Listening strategies', 'B2 mastery']
  },
  russia: {
    A1: ['Алфавит и звуки', 'Личные местоимения', 'Глагол быть', 'Род существительных', 'Множественное число', 'Настоящее время', 'Вопросы', 'Числа', 'Семья', 'Мой день', 'Предлоги места', 'Винительный падеж intro', 'Прилагательные', 'Еда и покупки', 'A1 разговор'],
    A2: ['Прошедшее время', 'Будущее время', 'Дательный падеж', 'Творительный падеж', 'Родительный падеж', 'Глаголы движения', 'Виды глагола', 'Сравнение', 'Наречия', 'Приглашение', 'Телефонный разговор', 'Город', 'Работа', 'Письмо', 'A2 обзор'],
    B1: ['Падежи повторение', 'Сложные предложения', 'Причастия intro', 'Деепричастия intro', 'Условные конструкции', 'Прямая и косвенная речь', 'Официальная речь', 'Мнение', 'Аргументы', 'СМИ', 'Культура', 'Путешествие', 'Рабочая коммуникация', 'Письменная речь', 'B1 обзор'],
    B2: ['Стилистика', 'Сложный синтаксис', 'Причастные обороты', 'Деепричастные обороты', 'Научный стиль', 'Деловой русский', 'Дискуссия', 'Презентация', 'Анализ текста', 'Аргументированное эссе', 'Идиомы', 'Публицистика', 'Интервью', 'Экзамен стратегия', 'B2 мастерство']
  },
  koreys: {
    A1: ['한글 basics', 'Greetings', 'Particles 은/는', 'Particles 이/가', 'To be 이에요/예요', 'Numbers', 'Present tense', 'Objects 을/를', 'Location 에/에서', 'Family words', 'Daily routine', 'Polite requests', 'Past tense intro', 'Food words', 'A1 conversation'],
    A2: ['Past tense', 'Future tense', 'Want to -고 싶다', 'Can -을 수 있다', 'Because -아서/어서', 'When -때', 'Honorifics intro', 'Comparisons', 'Shopping', 'Directions', 'Weather', 'Hobbies', 'Phone talk', 'Short writing', 'A2 review'],
    B1: ['Connectors', 'Reasons', 'Indirect speech intro', 'Intention -려고', 'Experience -아/어 봤다', 'Must -아/어야 하다', 'Passive intro', 'Opinions', 'Debate basics', 'News vocabulary', 'Work Korean', 'Essay intro', 'Listening notes', 'Speaking fluency', 'B1 review'],
    B2: ['Advanced endings', 'Nuance grammar', 'Formal speech', 'Academic Korean', 'Business Korean', 'Presentations', 'Debate', 'Essay structure', 'Culture topics', 'Idioms', 'Listening strategy', 'Reading strategy', 'TOPIK style', 'Interview practice', 'B2 mastery']
  },
  ona_tili: {
    A1: ['Gap va so‘z', 'Unli va undosh tovushlar', 'Bo‘g‘in va urg‘u', 'Ot so‘z turkumi', 'Sifat so‘z turkumi', 'Son so‘z turkumi', 'Olmosh', 'Fe’l so‘z turkumi', 'Gap bo‘laklari', 'Ega va kesim', 'Darak gap', 'So‘roq gap', 'Undov gap', 'Imlo qoidalari', 'Matn tuzish'],
    A2: ['Sinonim va antonim', 'Ko‘p ma’noli so‘zlar', 'So‘z yasalishi', 'Qo‘shimchalar', 'Kelishik qo‘shimchalari', 'Egalik qo‘shimchalari', 'Fe’l zamonlari', 'Ravish', 'Bog‘lovchilar', 'Uyushiq bo‘laklar', 'Ajratilgan bo‘laklar', 'Ko‘chirma gap', 'Nutq uslublari', 'Reja tuzish', 'Insho yozish'],
    B1: ['Morfologik tahlil', 'Sintaktik tahlil', 'Qo‘shma gap', 'Ergash gapli qo‘shma gap', 'Bog‘langan qo‘shma gap', 'Punktuatsiya', 'Frazeologizmlar', 'Maqol va matallar', 'Badiiy tasvir vositalari', 'Matn tahlili', 'Publitsistik uslub', 'Ilmiy uslub', 'Rasmiy uslub', 'Esse yozish', 'B1 takrorlash'],
    B2: ['Murakkab sintaksis', 'Uslubiy xatolar', 'Tahrir va tahlil', 'Badiiy matn tahlili', 'Ilmiy matn yozish', 'Dalillash', 'Munozara matni', 'Terminlar bilan ishlash', 'Matn kompozitsiyasi', 'Nutq madaniyati', 'Ijodiy yozuv', 'Referat tuzish', 'Test strategiyasi', 'Yakuniy tahlil', 'B2 mahorat']
  },
  tarix: {
    A1: ['Tarix fani nimani o‘rganadi', 'Tarixiy manbalar', 'Xronologiya', 'Ibtidoiy jamiyat', 'Qadimgi Misr', 'Qadimgi Mesopotamiya', 'Qadimgi Hindiston', 'Qadimgi Xitoy', 'Qadimgi Yunoniston', 'Qadimgi Rim', 'O‘rta Osiyo qadimgi davrda', 'Buyuk Ipak yo‘li', 'Ilk davlatlar', 'Madaniyat va dinlar', 'A1 tarix takrorlash'],
    A2: ['Arab xalifaligi', 'Somoniylar davlati', 'Qoraxoniylar', 'Xorazmshohlar', 'Mo‘g‘ullar istilosi', 'Amir Temur davlati', 'Temuriylar madaniyati', 'Shayboniylar', 'Buxoro xonligi', 'Xiva xonligi', 'Qo‘qon xonligi', 'Jadidchilik', 'Rossiya imperiyasi davri', 'Milliy uyg‘onish', 'A2 tarix takrorlash'],
    B1: ['Birinchi jahon urushi', '1917-yil voqealari', 'Turkiston muxtoriyati', 'Sovet davri boshlanishi', 'Ikkinchi jahon urushi', 'Urushdan keyingi davr', 'Mustaqillikka yo‘l', '1991-yil mustaqillik', 'Konstitutsiya tarixi', 'O‘zbekistonning rivojlanishi', 'Jahon sivilizatsiyalari', 'Tarixiy shaxslar', 'Tarixiy xarita bilan ishlash', 'Sabab va oqibat', 'B1 tarix takrorlash'],
    B2: ['Tarixiy tahlil metodlari', 'Manbalarni solishtirish', 'Davlat boshqaruvi tarixi', 'Iqtisodiy tarix', 'Madaniy meros', 'Diplomatiya tarixi', 'Islohotlar tarixi', 'Tarixiy bahs va dalil', 'Jahon urushlari tahlili', 'Sovuq urush', 'Globalizatsiya tarixi', 'Mustaqil tadqiqot', 'Tarixiy esse', 'Test strategiyasi', 'B2 tarix mahorat']
  }
};

const requestedEnglishTopics = {
  Beginner: [
    'ALFABIT',
    'A / AN',
    'PLURALS (REGULAR)',
    'PLURAL (IRREGULAR)',
    'SUBJECT PRONOUN',
    'TO BE',
    'THERE IS / THERE ARE',
    'HAVE / HAS',
    'CAN / CAN’T',
    'WHO / WHAT',
    'PRESENT CONTINUOUS',
    'PRESENT SIMPLE',
    'PREPOSITION OF PLACE',
    'PREPOSITION OF TIME',
    'COMPARATIVE ADJECTIVES'
  ],
  Elementary: [
    'PRESENT SIMPLE & PRESENT CONTINUOUS',
    'ADVERB AND ADJECTIVE',
    'PREPOSITION TIME AND PLACE',
    'PAST CONTINUOUS',
    'CONDITIONAL 0',
    'HAVE TO / MUST',
    'PAST SIMPLE',
    'WOULD / COULD',
    'USED TO',
    'FUTURE SIMPLE / TO BE GOING TO',
    'CONDITIONAL 1',
    'GERUND INFINITIVE',
    'USED TO / WOULD'
  ],
  'Pre-Intermediate': [
    'Present Simple, Present Continuous, Past Simple, Past Continuous',
    'Relative Clauses (who, which, where, whose, that)',
    'Present Perfect Simple, Present Perfect Continuous',
    'Articles (a, an, the, no article)',
    'Past Simple and Present Perfect',
    'Comparative, Superlative',
    'Past Perfect Simple, Past Perfect Continuous',
    'Modal Verbs 1, Modal Verbs 2',
    'Conditionals 2 & 3',
    'Passive Voice 1 (Present and Past Tenses)',
    'Passive Voice 2 (All Tenses)',
    'Reported Speech',
    'Connectives',
    'Despite, In Spite of, Although, While'
  ]
};
const legacyLevelTopicMap = { Beginner: 'A1', Elementary: 'A2', 'Pre-Intermediate': 'B1', Intermediate: 'B2' };
Object.keys(topicTitles).forEach(subjectId => {
  const source = topicTitles[subjectId] || {};
  const mapped = {};
  levels.forEach(level => {
    mapped[level] = subjectId === 'english' && requestedEnglishTopics[level]
      ? requestedEnglishTopics[level]
      : [...(source[legacyLevelTopicMap[level]] || [])];
  });
  topicTitles[subjectId] = mapped;
});




const englishYoutubeVideos = {
  'ALFABIT': { videoId: '75p-N9YKqNo', title: 'English Alphabet' },
  'A / AN': { videoId: 'RDkx4J__-QY', title: 'Articles A / An' },
  'PLURALS (REGULAR)': { videoId: 'L4B7XxuJO6A', title: 'Regular Plurals' },
  'PLURAL (IRREGULAR)': { videoId: '7q1K_cXjG5k', title: 'Irregular Plurals' },
  'TO BE': { videoId: 'VKmoxVefioI', title: 'Verb To Be' },
  'SUBJECT PRONOUN': { videoId: 'm0kTGL6Flzg', title: 'Subject Pronouns' },
  'THERE IS / THERE ARE': { videoId: 'xCrsoRmPFok', title: 'There is / There are' },
  'HAVE / HAS': { videoId: 'AHrTnC4hZ08', title: 'Have / Has' },
  'CAN / CAN’T': { videoId: 'R5eDl6C4MEw', title: 'Can / Can’t' },
  'WHO / WHAT': { videoId: 'x_4AjSwTXdc', title: 'Who / What Questions' },
  'PRESENT CONTINUOUS': { videoId: 'QqxdZzOorAU', title: 'Present Continuous' },
  'PRESENT SIMPLE': { videoId: 'kC8LI7TaEqY', title: 'Present Simple' },
  'PREPOSITION OF PLACE': { videoId: 'kq65VGkVwC8', title: 'Prepositions of Place' },
  'PREPOSITION OF TIME': { videoId: 'KySfIeH3QHc', title: 'Prepositions of Time' },
  'COMPARATIVE ADJECTIVES': { videoId: 'r6i7_5dYJyc', title: 'Comparative Adjectives' },
  'PRESENT SIMPLE & PRESENT CONTINUOUS': { videoId: 'VP8MRGAjgAs', title: 'Present Simple vs Present Continuous' },
  'ADVERB AND ADJECTIVE': { videoId: 'jrpYF-RdUNM', title: 'Adjectives and Adverbs' },
  'PREPOSITION TIME AND PLACE': { videoId: '5Tk5j3T3h0M', title: 'Prepositions of Time and Place' },
  'PAST CONTINUOUS': { videoId: 'etvW0FOD_so', title: 'Past Continuous' },
  'CONDITIONAL 0': { videoId: 'HtkGJ5EkdJY', title: 'Zero Conditional' },
  'HAVE TO / MUST': { videoId: 'bV3SWLJXWjQ', title: 'Have to / Must' },
  'PAST SIMPLE': { videoId: 'kgcd4gj9zNw', title: 'Past Simple' },
  'WOULD / COULD': { videoId: 'T0W0n0zSXUQ', title: 'Would / Could' },
  'USED TO': { videoId: 'EvjdYDhyfv4', title: 'Used to' },
  'FUTURE SIMPLE / TO BE GOING TO': { videoId: 'OeVMUDc_xc0', title: 'Future Simple / Going To' },
  'CONDITIONAL 1': { videoId: 'fSDxMaC0V5Y', title: 'First Conditional' },
  'GERUND INFINITIVE': { videoId: 'zE_2GgGSVqY', title: 'Gerund and Infinitive' },
  'USED TO / WOULD': { videoId: 'EvjdYDhyfv4', title: 'Used to / Would' },
  'To be: am/is/are': { videoId: 'VKmoxVefioI', title: 'Verb To Be: am / is / are' },
  'Articles: a/an/the': { videoId: 'RDkx4J__-QY', title: 'Articles: a / an / the' },
  'Plural nouns': { videoId: 'L4B7XxuJO6A', title: 'Singular and Plural Nouns' },
  'This, that, these, those': { videoId: 'rimSOFeVrYA', title: 'This, That, These, Those' },
  'Present Simple': { videoId: 'kC8LI7TaEqY', title: 'Present Simple' },
  'Have/Has': { videoId: 'AHrTnC4hZ08', title: 'Have vs Has' },
  'There is / There are': { videoId: 'xCrsoRmPFok', title: 'There is / There are' },
  'Can / Cannot': { videoId: 'R5eDl6C4MEw', title: 'Can / Cannot' },
  'Prepositions of place': { videoId: 'kq65VGkVwC8', title: 'Prepositions of Place' },
  'Possessive adjectives': { videoId: 'rF070hPFbas', title: 'Possessive Adjectives' },
  'Question words': { videoId: 'x_4AjSwTXdc', title: 'Question Words / WH Questions' },
  'Adverbs of frequency': { videoId: 'p8I5zw2Rels', title: 'Adverbs of Frequency' },
  'Countable / Uncountable nouns': { videoId: 'xbiiSPdiZes', title: 'Countable and Uncountable Nouns' },
  'Past Simple intro': { videoId: 'kgcd4gj9zNw', title: 'Past Simple' },
  'Daily conversation': { videoId: 'LngHOPOTKxE', title: 'Daily English Conversation' },
  'Present Continuous': { videoId: 'QqxdZzOorAU', title: 'Present Continuous' },
  'Past Simple regular verbs': { videoId: 'O2nqdDSy9nk', title: 'Past Simple Regular Verbs' },
  'Past Simple irregular verbs': { videoId: 'aPgtdZ_urZk', title: 'Past Simple Irregular Verbs' },
  'Future with going to': { videoId: 'OeVMUDc_xc0', title: 'Future with Going To' },
  'Comparatives': { videoId: 'oGr7l3q7SMI', title: 'Comparatives' },
  'Superlatives': { videoId: 'hw3MfjuXFIE', title: 'Superlatives' },
  'Modal should': { videoId: '-N9te6dUqjw', title: 'Should / Shouldn’t' },
  'Some / Any': { videoId: 'H57QBF9mR-g', title: 'Some / Any' },
  'Much / Many': { videoId: '60IbxyhRStQ', title: 'Much / Many' },
  'Present Perfect intro': { videoId: '553eeL1Dvho', title: 'Present Perfect' },
  'Adverbs of manner': { videoId: 'N9_8l4MgJzU', title: 'Adverbs of Manner' },
  'Object pronouns': { videoId: 'aqJMbCvduhY', title: 'Object Pronouns' },
  'Gerund basics': { videoId: 'lw6nJHmYcaI', title: 'Gerunds' },
  'Invitations': { videoId: 'MGRESx97b4s', title: 'Invitations and Making Plans' },
  'A2 conversation': { videoId: 'DPmtnb8NBog', title: 'A2 Daily Conversation' },
  'Present Perfect': { videoId: '553eeL1Dvho', title: 'Present Perfect' },
  'Past Continuous': { videoId: 'iv7MuzK9xuw', title: 'Past Continuous' },
  'First Conditional': { videoId: 's59ygVYxpag', title: 'First Conditional' },
  'Second Conditional': { videoId: 'iZnL2cb_w20', title: 'Second Conditional' },
  'Passive Voice intro': { videoId: '7FBr-G0ur9I', title: 'Passive Voice' },
  'Relative Clauses': { videoId: 'eFmfoeTkhH0', title: 'Relative Clauses' },
  'Reported Speech intro': { videoId: 'nec6ozGJli0', title: 'Reported Speech' },
  'Used to': { videoId: 'w-0FSBudtd0', title: 'Used To / Be Used To' },
  'Modal verbs': { videoId: '36wG9pSYu7Q', title: 'Modal Verbs' },
  'Linking words': { videoId: 'EoX9gW1sbnM', title: 'Linking Words' },
  'Phrasal verbs': { videoId: 'WHwxdtT302I', title: 'Phrasal Verbs' },
  'Complex questions': { videoId: 'ZBcuZNwyB_g', title: 'Question Word Order' },
  'Essay basics': { videoId: 'rIhX8lkJ_2k', title: 'Essay Writing Basics' },
  'Speaking opinions': { videoId: 'Hf4SnAQXwHk', title: 'Giving Opinions in English' },
  'B1 review': { videoId: '7QUCNjbDUlA', title: 'B1 English Grammar Review' },
  'Advanced tenses review': { videoId: '2vjo7u2aR3Y', title: 'English Tenses Review' },
  'Mixed conditionals': { videoId: 'nIfKWExlp2M', title: 'Mixed Conditionals' },
  'Passive voice advanced': { videoId: 'CmqOXaSUpFo', title: 'Passive Voice Advanced' },
  'Reported speech': { videoId: 'Mi9UPE2C91I', title: 'Reported Speech' },
  'Relative clauses advanced': { videoId: 'oUw9qHAbcys', title: 'Advanced Relative Clauses' },
  'Wish / If only': { videoId: 'k5lTGZgfRAQ', title: 'Wish / If Only' },
  'Modal deduction': { videoId: 'h3BKobLiMu0', title: 'Modal Deduction' },
  'Participle clauses': { videoId: 'ftZr1_Ny8L8', title: 'Participle / Reduced Clauses' },
  'Inversion intro': { videoId: 'GYZ-7LmxplA', title: 'Inversion in English' },
  'Cleft sentences': { videoId: 'P-wB0gwMnfE', title: 'Cleft Sentences' },
  'Academic vocabulary': { videoId: 'YWTa7j8IE8o', title: 'Academic Vocabulary' },
  'Argument essays': { videoId: '5Z18mi1aG5Y', title: 'Argument Essay' },
  'Speaking debate': { videoId: '1xIoL-uGT20', title: 'Debate Speaking' },
  'Listening strategies': { videoId: 'UYwYFN6mA1A', title: 'Listening Strategies' },
  'B2 mastery': { videoId: '2vjo7u2aR3Y', title: 'B2 English Grammar Review' }
};

function getEnglishYoutubeVideo(language, title, level) {
  if (language !== 'english') return null;
  const video = englishYoutubeVideos[title] || { videoId: '7QUCNjbDUlA', title: 'English grammar lesson' };
  const query = encodeURIComponent(`${title} ${level} English grammar lesson`);
  return {
    ...video,
    provider: 'YouTube',
    searchUrl: `https://www.youtube.com/results?search_query=${query}`,
    embedUrl: `https://www.youtube-nocookie.com/embed/${video.videoId}`
  };
}

const vocabSets = {
  english: [
    ['teacher','ustoz','The teacher explains the grammar.'], ['student','o‘quvchi','The student answers the question.'], ['lesson','dars','Today our lesson is about grammar.'], ['grammar','grammatika','Grammar helps us build correct sentences.'], ['sentence','gap','Write one sentence using the new word.'], ['question','savol','Read the question carefully.'], ['answer','javob','Choose the correct answer.'], ['example','misol','Look at the example first.'], ['practice','mashq','Practice every day.'], ['mistake','xato','A mistake helps you learn.'], ['correct','to‘g‘ri','This answer is correct.'], ['daily','kundalik','Daily practice improves speaking.'], ['book','kitob','Open your book.'], ['listen','tinglamoq','Listen and repeat.'], ['speak','gapirmoq','Speak in full sentences.'], ['write','yozmoq','Write your answer.'], ['read','o‘qimoq','Read the text.'], ['understand','tushunmoq','I understand this topic.'], ['repeat','takrorlamoq','Repeat the rule.'], ['complete','tugatmoq','Complete the test.']
  ],
  russia: [
    ['учитель','teacher','Учитель объясняет правило.'], ['ученик','student','Ученик отвечает на вопрос.'], ['урок','lesson','Сегодня у нас новый урок.'], ['грамматика','grammar','Грамматика помогает говорить правильно.'], ['предложение','sentence','Напишите одно предложение.'], ['вопрос','question','Прочитайте вопрос внимательно.'], ['ответ','answer','Выберите правильный ответ.'], ['пример','example','Сначала посмотрите пример.'], ['практика','practice','Практика нужна каждый день.'], ['ошибка','mistake','Ошибка помогает учиться.'], ['правильно','correct','Это правильный ответ.'], ['ежедневно','daily','Занимайтесь ежедневно.'], ['книга','book','Откройте книгу.'], ['слушать','listen','Слушайте и повторяйте.'], ['говорить','speak','Говорите полными предложениями.'], ['писать','write','Пишите ответ.'], ['читать','read','Читайте текст.'], ['понимать','understand','Я понимаю эту тему.'], ['повторять','repeat','Повторите правило.'], ['закончить','complete','Закончите тест.']
  ],
  koreys: [
    ['선생님','teacher','선생님이 문법을 설명합니다.'], ['학생','student','학생이 질문에 대답합니다.'], ['수업','lesson','오늘 수업은 문법입니다.'], ['문법','grammar','문법은 문장을 만드는 데 필요합니다.'], ['문장','sentence','새 단어로 문장을 쓰세요.'], ['질문','question','질문을 잘 읽으세요.'], ['대답','answer','맞는 대답을 고르세요.'], ['예문','example','먼저 예문을 보세요.'], ['연습','practice','매일 연습하세요.'], ['실수','mistake','실수는 배움에 도움이 됩니다.'], ['맞다','correct','이 대답은 맞습니다.'], ['매일','daily','매일 공부하세요.'], ['책','book','책을 펴세요.'], ['듣다','listen','듣고 따라 하세요.'], ['말하다','speak','문장으로 말하세요.'], ['쓰다','write','답을 쓰세요.'], ['읽다','read','글을 읽으세요.'], ['이해하다','understand','저는 이 주제를 이해합니다.'], ['반복하다','repeat','규칙을 반복하세요.'], ['끝내다','complete','시험을 끝내세요.']
  ],
  ona_tili: [
    ['ega','gapda kim yoki nima haqida aytilayotganini bildiradi','Ega gapning asosiy bo‘lagidir.'], ['kesim','eganing harakati yoki holatini bildiradi','Kesim gapni yakunlaydi.'], ['ot','shaxs, narsa yoki joy nomini bildiradi','Kitob — ot.'], ['sifat','belgi-xususiyatni bildiradi','Chiroyli — sifat.'], ['fe’l','harakat yoki holatni bildiradi','O‘qimoq — fe’l.'], ['son','miqdor yoki tartibni bildiradi','Besh — son.'], ['olmosh','ot o‘rnida keladigan so‘z','Men — olmosh.'], ['gap','tugallangan fikrni bildiradi','Bugun dars bor.'], ['matn','mazmunan bog‘langan gaplar','Matn mavzu asosida tuziladi.'], ['imlo','so‘zlarni to‘g‘ri yozish qoidalari','Imlo savodxonlikni oshiradi.']
  ],
  tarix: [
    ['xronologiya','voqealarni vaqt tartibida o‘rganish','Tarixda xronologiya muhim.'], ['manba','tarixiy ma’lumot beruvchi dalil','Yozma manba o‘tmish haqida xabar beradi.'], ['davlat','boshqaruv tizimiga ega jamiyat','Qadimgi davlatlar tarixda muhim o‘rin tutadi.'], ['sivilizatsiya','taraqqiy etgan jamiyat va madaniyat','Misr sivilizatsiyasi qadimiydir.'], ['madaniyat','xalqning moddiy va ma’naviy boyligi','Madaniyat tarixni tushunishga yordam beradi.'], ['islohot','hayotni yaxshilash uchun o‘zgarish','Islohotlar davlat rivojiga ta’sir qiladi.'], ['mustaqillik','erkin va suveren davlat bo‘lish','O‘zbekiston mustaqillikka erishdi.'], ['xarita','hudud va joylashuvni ko‘rsatuvchi manba','Tarixiy xarita voqealarni tushuntiradi.'], ['sabab','voqeani keltirib chiqargan omil','Har bir tarixiy hodisaning sababi bor.'], ['oqibat','voqeadan keyingi natija','Urushning oqibatlari og‘ir bo‘ladi.']
  ]
};


function ensurePasswordHashSync(user) {
  if (!user || user.passwordHash) return false;
  if (!user.password) return false;
  user.passwordHash = bcrypt.hashSync(String(user.password), 10);
  delete user.password;
  user.passwordUpdatedAt = new Date().toISOString();
  return true;
}

function postgresSslConfig() {
  const mode = (process.env.PGSSLMODE || '').toLowerCase();
  if (mode === 'require' || process.env.DATABASE_SSL === 'true') return { rejectUnauthorized: false };
  return undefined;
}

async function ensurePostgresSchema() {
  if (!pgPool) throw new Error('PostgreSQL pool tayyor emas');
  await pgPool.query(`
    create table if not exists app_users (
      id text primary key,
      role text not null,
      username text unique not null,
      full_name text,
      subject text,
      is_super boolean not null default false,
      is_active boolean not null default true,
      expires_at text,
      created_at timestamptz,
      session_id text,
      session_updated_at timestamptz,
      data jsonb not null
    );
    create index if not exists idx_app_users_role on app_users(role);
    create index if not exists idx_app_users_subject on app_users(subject);

    create table if not exists app_enrollments (
      id text primary key,
      user_id text,
      created_at timestamptz,
      data jsonb not null
    );
    create index if not exists idx_app_enrollments_user_id on app_enrollments(user_id);

    create table if not exists app_progress (
      user_id text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    );

    create table if not exists app_certificates (
      id text primary key,
      user_id text,
      code text unique,
      language text,
      level text,
      score numeric,
      created_at timestamptz,
      data jsonb not null
    );
    create index if not exists idx_app_certificates_user_id on app_certificates(user_id);
    create index if not exists idx_app_certificates_code on app_certificates(code);
    create index if not exists idx_app_certificates_language on app_certificates(language);

    create table if not exists app_meta (
      key text primary key,
      value jsonb not null,
      updated_at timestamptz not null default now()
    );
  `);
}

function defaultSeedDb() {
  ensureDb();
  const fileDb = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  normalizeDb(fileDb);
  return fileDb;
}

async function loadDbFromPostgres() {
  const [usersResult, enrollmentsResult, progressResult, certificatesResult, metaResult] = await Promise.all([
    pgPool.query('select data from app_users order by created_at nulls last, username asc'),
    pgPool.query('select data from app_enrollments order by created_at nulls last, id asc'),
    pgPool.query('select user_id, data from app_progress order by user_id asc'),
    pgPool.query('select data from app_certificates order by created_at desc nulls last, id asc'),
    pgPool.query("select key, value from app_meta where key in ('action_logs','system_logs','custom_content','last_auto_backup','centers','game_plays','shop_orders')")
  ]);

  const hasData = usersResult.rows.length || enrollmentsResult.rows.length || progressResult.rows.length || certificatesResult.rows.length;
  if (!hasData) {
    // Birinchi ishga tushganda eski db.json seed sifatida olinadi, keyingi ishlash faqat PostgreSQL orqali bo'ladi.
    const seed = defaultSeedDb();
    await saveDbToPostgres(seed);
    return seed;
  }

  const progress = {};
  for (const row of progressResult.rows) progress[row.user_id] = row.data || {};
  const meta = Object.fromEntries(metaResult.rows.map(row => [row.key, row.value]));
  const db = {
    users: usersResult.rows.map(row => row.data),
    enrollments: enrollmentsResult.rows.map(row => row.data),
    certificates: certificatesResult.rows.map(row => row.data),
    progress,
    actionLogs: Array.isArray(meta.action_logs) ? meta.action_logs : [],
    systemLogs: Array.isArray(meta.system_logs) ? meta.system_logs : [],
    customContent: meta.custom_content || { topics: {} },
    lastAutoBackup: meta.last_auto_backup || null,
    centers: Array.isArray(meta.centers) ? meta.centers : [],
    gamePlays: Array.isArray(meta.game_plays) ? meta.game_plays : [],
    shopOrders: Array.isArray(meta.shop_orders) ? meta.shop_orders : []
  };
  normalizeDb(db);
  return db;
}

async function saveDbToPostgres(db) {
  if (!pgPool) throw new Error('PostgreSQL ulanmagan');
  const normalized = JSON.parse(JSON.stringify(db || {}));
  normalizeDb(normalized);
  const client = await pgPool.connect();
  try {
    await client.query('begin');
    await client.query('delete from app_users');
    await client.query('delete from app_enrollments');
    await client.query('delete from app_progress');
    await client.query('delete from app_certificates');

    for (const user of normalized.users || []) {
      await client.query(
        `insert into app_users
         (id, role, username, full_name, subject, is_super, is_active, expires_at, created_at, session_id, session_updated_at, data)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [
          user.id, user.role || 'student', user.username || user.id, user.fullName || '', user.subject || 'english',
          !!user.isSuper, statusOf(user) === 'active', user.expiresAt || null, user.createdAt || null,
          user.sessionId || null, user.sessionUpdatedAt || null, JSON.stringify(user)
        ]
      );
    }

    for (const enrollment of normalized.enrollments || []) {
      await client.query(
        `insert into app_enrollments (id, user_id, created_at, data)
         values ($1,$2,$3,$4::jsonb)`,
        [enrollment.id || makeId('enr'), enrollment.userId || enrollment.studentId || null, enrollment.createdAt || null, JSON.stringify(enrollment)]
      );
    }

    for (const [userId, value] of Object.entries(normalized.progress || {})) {
      await client.query(
        `insert into app_progress (user_id, data, updated_at)
         values ($1,$2::jsonb,now())`,
        [userId, JSON.stringify(value || {})]
      );
    }

    for (const cert of normalized.certificates || []) {
      await client.query(
        `insert into app_certificates (id, user_id, code, language, level, score, created_at, data)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          cert.id || cert.code || makeId('cert'), cert.userId || null, cert.code || cert.id || null,
          cert.language || cert.subject || null, cert.level || null, Number(cert.score || 0), cert.createdAt || null,
          JSON.stringify(cert)
        ]
      );
    }

    await client.query(
      `insert into app_meta (key, value, updated_at) values ('last_save', $1::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [JSON.stringify({ savedAt: new Date().toISOString(), users: normalized.users?.length || 0, certificates: normalized.certificates?.length || 0 })]
    );
    const extraMeta = [
      ['action_logs', normalized.actionLogs || []],
      ['system_logs', normalized.systemLogs || []],
      ['custom_content', normalized.customContent || { topics: {} }],
      ['last_auto_backup', normalized.lastAutoBackup || null],
      ['centers', normalized.centers || []],
      ['game_plays', normalized.gamePlays || []],
      ['shop_orders', normalized.shopOrders || []]
    ];
    for (const [key, value] of extraMeta) {
      await client.query(
        `insert into app_meta (key, value, updated_at) values ($1, $2::jsonb, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, JSON.stringify(value)]
      );
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

function queuePostgresSave(db) {
  if (!pgPool) return;
  const snapshot = JSON.parse(JSON.stringify(db));
  pgWriteQueue = pgWriteQueue
    .then(() => saveDbToPostgres(snapshot))
    .catch((err) => {
      lastPgError = err;
      console.error('PostgreSQL save error:', err.message);
    });
}


async function maybeCreateDailyBackup() {
  if (!dbCache) return;
  const today = new Date().toISOString().slice(0, 10);
  if (dbCache.lastAutoBackup?.date === today) return;
  try {
    const backup = createBackupFile(dbCache, 'auto-daily', null);
    dbCache.lastAutoBackup = { date: today, filename: backup.filename, createdAt: backup.createdAt };
    addActionLog(dbCache, null, 'auto_backup_created', backup.filename, backup, null);
    writeDb(dbCache);
  } catch (err) {
    lastPgError = err;
    addSystemLog('error', 'Avtomatik backup yaratilmadi', { error: err.message });
  }
}
function startDailyBackupScheduler() {
  maybeCreateDailyBackup();
  setInterval(maybeCreateDailyBackup, 6 * 60 * 60 * 1000);
}

async function initPersistentDb() {
  if (!DATABASE_URL) {
    const message = [
      'DATABASE_URL topilmadi.',
      'Bu versiya PostgreSQL bilan to‘liq ishlaydi va db.json fallback ishlatmaydi.',
      'backend/.env fayliga DATABASE_URL yozing. Masalan:',
      'DATABASE_URL=postgresql://postgres:password@localhost:5432/al_aziz_language'
    ].join('\n');
    if (REQUIRE_POSTGRES) throw new Error(message);
    console.warn(message);
  }

  if (!DATABASE_URL) {
    // Faqat dasturchi vaqtincha REQUIRE_POSTGRES=false qilsa ishlaydigan emergency mode.
    dbCache = defaultSeedDb();
    console.log('Database mode: temporary in-memory seed. PostgreSQL tavsiya qilinadi.');
    return;
  }

  pgPool = new Pool({ connectionString: DATABASE_URL, ssl: postgresSslConfig() });
  await ensurePostgresSchema();
  dbCache = await loadDbFromPostgres();
  await saveDbToPostgres(dbCache);
  console.log('Database mode: PostgreSQL full tables (users, progress, certificates, enrollments).');
}

function readDb() {
  if (!dbCache) throw new Error('Database hali ishga tushmagan');
  if (normalizeDb(dbCache)) writeDb(dbCache);
  return dbCache;
}
function writeDb(db) {
  dbCache = db;
  queuePostgresSave(dbCache);
}
function createJwtForUser(user) {
  const sessionId = crypto.randomBytes(24).toString('hex');
  const token = jwt.sign(
    { sub: user.id, sid: sessionId, role: user.role, subject: user.subject || 'english', centerId: user.centerId || DEFAULT_CENTER_ID },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
  user.sessionId = sessionId;
  user.sessionToken = token;
  user.sessionUpdatedAt = new Date().toISOString();
  return token;
}

function verifyJwtToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function todayPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function makeId(prefix) { return `${prefix}_${crypto.randomBytes(8).toString('hex')}`; }
const DEFAULT_CENTER_ID = 'center_main';
function slugifyCenter(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'center';
}
function isSuperAdmin(user = {}) {
  return !!user.isSuper || (user.role === 'admin' && user.username === 'admin');
}
function centerIdOf(user = {}) {
  return user.centerId || DEFAULT_CENTER_ID;
}
function ensureDefaultCenter(db) {
  if (!Array.isArray(db.centers)) db.centers = [];
  let main = db.centers.find(center => center.id === DEFAULT_CENTER_ID);
  if (!main) {
    main = {
      id: DEFAULT_CENTER_ID,
      name: 'ENGLISH Mock',
      logoDataUrl: '',
      status: 'active',
      createdAt: new Date().toISOString(),
      createdBy: 'system'
    };
    db.centers.unshift(main);
  }
  return main;
}
function centerById(db, centerId) {
  const id = centerId || DEFAULT_CENTER_ID;
  return (db.centers || []).find(center => center.id === id) || ensureDefaultCenter(db);
}
function canAdminAccessCenter(admin, centerId) {
  if (isSuperAdmin(admin)) return true;
  return centerIdOf(admin) === (centerId || DEFAULT_CENTER_ID);
}
function canAdminAccessUser(admin, user) {
  if (!admin || !user) return false;
  if (isSuperAdmin(admin)) return true;
  if (user.id === admin.id) return true;
  if (isSuperAdmin(user)) return false;
  if (!canAdminAccessCenter(admin, centerIdOf(user))) return false;
  return admin.subject === 'all' || user.subject === admin.subject;
}
function visibleUsersForAdmin(db, admin) {
  return (db.users || []).filter(user => canAdminAccessUser(admin, user));
}
function visibleStudentsForAdmin(db, admin) {
  return visibleUsersForAdmin(db, admin).filter(user => user.role === 'student');
}
function ensureCenterLogo(value = '') {
  const logo = String(value || '').trim();
  if (!logo) return '';
  if (logo.startsWith('data:image/') && logo.length < 350000) return logo;
  if (/^https?:\/\//i.test(logo)) return logo.slice(0, 1000);
  return '';
}
function centerStats(db, center) {
  const centerId = center.id || DEFAULT_CENTER_ID;
  const users = (db.users || []).filter(user => centerIdOf(user) === centerId && !isSuperAdmin(user));
  const students = users.filter(user => user.role === 'student').map(user => safeUser(user, db));
  const teachers = users.filter(user => user.role === 'teacher');
  const admins = users.filter(user => user.role === 'admin');
  const activeStudents = students.filter(user => user.status === 'active');
  const avgProgress = Math.round(students.reduce((sum, user) => sum + Number(user.progressPercent || 0), 0) / Math.max(1, students.length));
  const avgSpeaking = Math.round(students.reduce((sum, user) => sum + Number(user.speakingPercent || 0), 0) / Math.max(1, students.length));
  const weakStudents = [...students].sort((a, b) => Number(a.progressPercent || 0) - Number(b.progressPercent || 0)).slice(0, 8);
  const levelStats = levels.map(level => {
    const levelStudents = students.filter(user => (user.currentLevel || FIRST_LEVEL) === level);
    const avg = Math.round(levelStudents.reduce((sum, user) => sum + Number(user.progressPercent || 0), 0) / Math.max(1, levelStudents.length));
    return { level, count: levelStudents.length, avg };
  });
  return {
    students: students.length,
    teachers: teachers.length,
    admins: admins.length,
    activeStudents: activeStudents.length,
    inactiveStudents: Math.max(0, students.length - activeStudents.length),
    avgProgress,
    avgSpeaking,
    weakStudents,
    levelStats
  };
}
function publicCenter(center = {}, db = null) {
  const stats = db ? centerStats(db, center) : {};
  return {
    id: center.id,
    name: center.name,
    logoDataUrl: center.logoDataUrl || '',
    status: center.status || 'active',
    createdAt: center.createdAt || '',
    updatedAt: center.updatedAt || '',
    ...stats
  };
}
function ensureDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const now = new Date().toISOString();
    const initial = {
      centers: [
        { id: DEFAULT_CENTER_ID, name: 'ENGLISH Mock', logoDataUrl: '', status: 'active', createdAt: now, createdBy: 'system' }
      ],
      users: [
        { id: 'u_admin', role: 'admin', username: 'admin', password: 'admin123', fullName: 'ENGLISH Mock Super Admin', subject: 'all', centerId: 'all', isSuper: true, isActive: true, createdAt: now, expiresAt: null },
        { id: 'u_student', role: 'student', username: 'student', password: 'student123', fullName: 'Ali Valiyev', birthDate: '2010-05-12', subject: 'english', centerId: DEFAULT_CENTER_ID, isSuper: false, isActive: true, createdAt: now, expiresAt: todayPlus(365) },
        { id: 'u_rus', role: 'student', username: 'russtudent', password: 'student123', fullName: 'Aziza Karimova', birthDate: '2011-09-03', subject: 'russia', centerId: DEFAULT_CENTER_ID, isSuper: false, isActive: true, createdAt: now, expiresAt: todayPlus(365) },
        { id: 'u_kor', role: 'student', username: 'korstudent', password: 'student123', fullName: 'Sardor Kim', birthDate: '2009-12-21', subject: 'koreys', centerId: DEFAULT_CENTER_ID, isSuper: false, isActive: true, createdAt: now, expiresAt: todayPlus(365) }
      ],
      enrollments: [],
      certificates: [],
      progress: {}
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
  }
}
function normalizeDb(db) {
  let changed = false;
  const now = new Date().toISOString();
  if (!Array.isArray(db.centers)) { db.centers = []; changed = true; }
  ensureDefaultCenter(db);
  for (const center of db.centers) {
    if (!center.id) { center.id = `${DEFAULT_CENTER_ID}_${crypto.randomBytes(4).toString('hex')}`; changed = true; }
    if (!center.name) { center.name = 'Yangi markaz'; changed = true; }
    if (typeof center.logoDataUrl === 'undefined') { center.logoDataUrl = ''; changed = true; }
    if (!center.status) { center.status = 'active'; changed = true; }
    if (!center.createdAt) { center.createdAt = now; changed = true; }
  }
  if (!Array.isArray(db.users)) { db.users = []; changed = true; }
  for (const user of db.users) {
    if (!user.subject) { user.subject = user.role === 'admin' ? 'all' : 'english'; changed = true; }
    if (typeof user.isSuper === 'undefined') { user.isSuper = user.username === 'admin'; changed = true; }
    if (typeof user.isActive === 'undefined') { user.isActive = true; changed = true; }
    if (isSuperAdmin(user)) { if (!user.centerId) { user.centerId = 'all'; changed = true; } }
    else { if (!user.centerId) { user.centerId = DEFAULT_CENTER_ID; changed = true; } }
    if (!user.createdAt) { user.createdAt = now; changed = true; }
    if (ensurePasswordHashSync(user)) { changed = true; }
    if (typeof user.expiresAt === 'undefined') { user.expiresAt = user.role === 'student' ? todayPlus(365) : null; changed = true; }
    if (user.role === 'student' && !user.paymentStatus) { user.paymentStatus = 'paid'; changed = true; }
    if (user.role === 'student' && typeof user.allowUnlimitedTopics === 'undefined') { user.allowUnlimitedTopics = false; changed = true; }
    if (user.role === 'student' && !user.topicAccessMode) { user.topicAccessMode = normalizeTopicAccessMode(user.topicAccessMode, !!user.allowUnlimitedTopics); changed = true; }
    if (user.role === 'student') { user.allowUnlimitedTopics = normalizeTopicAccessMode(user.topicAccessMode, !!user.allowUnlimitedTopics) === 'unlimited'; }
    if (user.role === 'student' && enforcePaymentAccess(user)) { changed = true; }
    if (typeof user.paymentAmount === 'undefined') { user.paymentAmount = ''; changed = true; }
    if (typeof user.paymentNote === 'undefined') { user.paymentNote = ''; changed = true; }
    if (!user.isSuper && user.expiresAt && new Date(user.expiresAt + 'T23:59:59') < new Date() && user.isActive) {
      user.isActive = false;
      user.expiredAt = now;
      changed = true;
    }
  }
  if (!Array.isArray(db.enrollments)) { db.enrollments = []; changed = true; }
  for (const enrollment of db.enrollments) { if (!enrollment.centerId) { enrollment.centerId = DEFAULT_CENTER_ID; changed = true; } }
  if (!Array.isArray(db.certificates)) { db.certificates = []; changed = true; }
  for (const cert of db.certificates) {
    if (!cert.centerId) {
      const owner = db.users.find(u => u.id === cert.userId);
      cert.centerId = owner ? centerIdOf(owner) : DEFAULT_CENTER_ID;
      changed = true;
    }
  }
  if (!db.progress) { db.progress = {}; changed = true; }
  if (!Array.isArray(db.actionLogs)) { db.actionLogs = []; changed = true; }
  if (!Array.isArray(db.systemLogs)) { db.systemLogs = []; changed = true; }
  if (!Array.isArray(db.gamePlays)) { db.gamePlays = []; changed = true; }
  if (!Array.isArray(db.shopOrders)) { db.shopOrders = []; changed = true; }
  if (!db.customContent || typeof db.customContent !== 'object') { db.customContent = { topics: {} }; changed = true; }
  if (!db.customContent.topics) { db.customContent.topics = {}; changed = true; }
  return changed;
}
function isExpired(user) { return !!(user.expiresAt && new Date(user.expiresAt + 'T23:59:59') < new Date()); }
function statusOf(user) {
  if (user.isSuper) return 'active';
  if (isExpired(user)) return 'expired';
  return user.isActive === false ? 'non-active' : 'active';
}

function speakingProgressValue(db, userId, language, level, topicNo) {
  const p = (db.progress && db.progress[userId]) || {};
  return p[speakingProgressKey(language, level, topicNo)] || null;
}
function normalizeSpeakingWordKey(value = '') {
  return normalizeSpeech(value).replace(/\s+/g, '_') || crypto.createHash('sha1').update(String(value || 'word')).digest('hex').slice(0, 12);
}
function clampScore(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}
function summarizeSpeakingRecord(record = {}, totalWordsOverride = null) {
  const words = record.words && typeof record.words === 'object' ? Object.values(record.words) : [];
  const totalWords = Math.max(1, Number(totalWordsOverride || record.totalWords || VOCABULARY_ITEM_COUNT));
  const checkedWords = Math.min(totalWords, words.length);
  const passedWords = Math.min(totalWords, words.filter(item => Number(item.bestScore || item.score || 0) >= 75 || item.passed === true).length);
  const totalScore = words.reduce((sum, item) => sum + clampScore(item.bestScore || item.score || 0), 0);

  // MUHIM: speaking foizi faqat aytilgan so'zlar o'rtachasi emas.
  // 30 ta so'zdan 4 tasi aytilsa, qolgan 26 tasi 0 hisoblanadi.
  // Shunda 4 ta so'z 98% bo'lsa ham mavzu foizi taxminan 13% chiqadi.
  const score = Math.round(totalScore / totalWords);

  return {
    score,
    percent: score,
    bestScore: score,
    lastScore: Number(record.lastScore || 0),
    checkedWords,
    passedWords,
    totalWords,
    attempts: Number(record.attempts || 0),
    updatedAt: record.updatedAt || ''
  };
}
function getUnlockedSpeakingRecords(db, user) {
  if (!db || !user || user.role !== 'student' || !subjectMap[user.subject]) return [];
  const p = (db.progress && db.progress[user.id]) || {};
  const records = [];
  for (const level of levels) {
    const titles = topicTitles[user.subject]?.[level] || [];
    for (let index = 0; index < titles.length; index += 1) {
      const topicNo = index + 1;
      if (!isTopicUnlocked(db, user.id, user.subject, level, topicNo)) continue;
      const key = speakingProgressKey(user.subject, level, topicNo);
      records.push({
        key,
        level,
        topicNo,
        title: titles[index],
        summary: summarizeSpeakingRecord(p[key] || {}, VOCABULARY_ITEM_COUNT)
      });
    }
  }
  return records;
}
function summarizeSpeakingForUser(db, user) {
  if (!db || !user || user.role !== 'student') return { percent: 0, passedPercent: 0, checkedWords: 0, passedWords: 0, totalWords: 0, topicCount: 0, attempts: 0 };
  const records = getUnlockedSpeakingRecords(db, user);
  const checkedWords = records.reduce((sum, item) => sum + Number(item.summary.checkedWords || 0), 0);
  const passedWords = records.reduce((sum, item) => sum + Number(item.summary.passedWords || 0), 0);
  const totalWords = records.reduce((sum, item) => sum + Number(item.summary.totalWords || 0), 0);
  const attempts = records.reduce((sum, item) => sum + Number(item.summary.attempts || 0), 0);
  const totalScore = records.reduce((sum, item) => sum + Number(item.summary.score || 0) * Number(item.summary.totalWords || 0), 0);
  const percent = totalWords ? Math.round(totalScore / totalWords) : 0;
  const passedPercent = totalWords ? Math.round((passedWords / totalWords) * 100) : 0;
  return { percent, passedPercent, checkedWords, passedWords, totalWords, topicCount: records.length, attempts };
}
function topicScoreFromProgress(db, userId, language, level, topicNo) {
  const p = (db.progress && db.progress[userId]) || {};
  return p[progressKey(language, level, topicNo)] || null;
}

function buildStudentProgressSummary(db, user) {
  if (!db || user.role !== 'student' || !subjectMap[user.subject]) {
    return { currentLevel: '', currentTopicNo: null, currentTopicTitle: '', currentTopicScore: 0, progressPercent: 0, topicProgress: [] };
  }
  const language = user.subject;
  const p = (db.progress && db.progress[user.id]) || {};
  const topicProgress = [];
  let completedTopics = 0;
  let firstOpenTopic = null;
  let lastOpenLevel = FIRST_LEVEL;

  for (const level of levels) {
    const levelUnlocked = hasLevelAccess(db, user.id, language, level);
    if (levelUnlocked) lastOpenLevel = level;
    const titles = topicTitles[language]?.[level] || [];
    const topics = titles.map((title, index) => {
      const topicNo = index + 1;
      const key = progressKey(language, level, topicNo);
      const value = p[key] || {};
      const bestScore = Number(value.bestScore || 0);
      const attempts = Number(value.attempts || 0);
      const unlocked = levelUnlocked && isTopicUnlocked(db, user.id, language, level, topicNo);
      const completed = bestScore >= TOPIC_PASS_SCORE;
      if (completed) completedTopics += 1;
      if (!firstOpenTopic && unlocked && !completed) {
        firstOpenTopic = { level, topicNo, title, bestScore, attempts };
      }
      const speaking = summarizeSpeakingRecord(speakingProgressValue(db, user.id, language, level, topicNo) || {});
      return {
        level,
        topicNo,
        title,
        unlocked,
        completed,
        bestScore,
        lastScore: Number(value.lastScore || 0),
        attempts,
        updatedAt: value.updatedAt || '',
        speakingScore: speaking.score,
        speakingBestScore: speaking.bestScore,
        speakingCheckedWords: speaking.checkedWords,
        speakingPassedWords: speaking.passedWords,
        speakingTotalWords: speaking.totalWords,
        speakingAttempts: speaking.attempts,
        speakingUpdatedAt: speaking.updatedAt
      };
    });
    topicProgress.push({ level, unlocked: levelUnlocked, finalBest: Number(p[finalKey(language, level)]?.bestScore || 0), topics });
  }

  let currentTopic = firstOpenTopic;
  if (!currentTopic) {
    const accessibleLevels = topicProgress.filter(group => group.unlocked);
    const finalNeeded = accessibleLevels.find(group => group.topics.every(t => t.completed) && group.finalBest < 90);
    if (finalNeeded) currentTopic = { level: finalNeeded.level, topicNo: null, title: 'Yakuniy test', bestScore: finalNeeded.finalBest, attempts: 0 };
  }
  if (!currentTopic) currentTopic = { level: lastOpenLevel, topicNo: null, title: 'Kurs yakunlangan', bestScore: 100, attempts: 0 };

  return {
    currentLevel: currentTopic.level || lastOpenLevel,
    currentTopicNo: currentTopic.topicNo,
    currentTopicTitle: currentTopic.title,
    currentTopicScore: currentTopic.bestScore || 0,
    progressPercent: Math.round((completedTopics / Math.max(1, levels.reduce((sum, lvl) => sum + topicCountForLevel(language, lvl), 0))) * 100),
    topicProgress
  };
}

function getUserCurrentLevel(db, user) {
  if (!db || user.role !== 'student' || !subjectMap[user.subject]) return '';
  const p = (db.progress && db.progress[user.id]) || {};
  const canAccess = level => {
    if (level === FIRST_LEVEL) return true;
    if (hasAdminLevelUnlock(user, level)) return true;
    const previous = levels[levelIndex[level] - 1];
    return (p[gateKey(user.subject, level)]?.bestScore || 0) >= LEVEL_PASS_SCORE || (p[finalKey(user.subject, previous)]?.bestScore || 0) >= LEVEL_PASS_SCORE;
  };
  for (const level of [...levels].reverse()) {
    if (canAccess(level)) return level;
  }
  return FIRST_LEVEL;
}

const TOPIC_PASS_SCORE = 90;
const LEVEL_PASS_SCORE = 90;
const PLAN_DAYS = ['Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba', 'Yakshanba'];

function normalizeLevelName(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const compact = raw.toLowerCase().replace(/[–—]/g, '-').replace(/[_\s-]+/g, '-').replace(/^-+|-+$/g, '');
  return levels.find(level => {
    const levelKey = level.toLowerCase().replace(/[–—]/g, '-').replace(/[_\s-]+/g, '-').replace(/^-+|-+$/g, '');
    return levelKey === compact || level.toLowerCase() === raw.toLowerCase();
  }) || raw;
}

function normalizeUnlockedLevels(value = []) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  const selected = list
    .map(item => normalizeLevelName(item))
    .filter(level => levels.includes(level));

  // Admin yuqori darajani qo'lda ochsa, undan oldingi darajalar ham avtomatik ochiq hisoblanadi.
  // Masalan: Pre-Intermediate ochilsa, Beginner + Elementary + Pre-Intermediate ochiladi.
  const expanded = [];
  selected.forEach(level => {
    const idx = levelIndex[level];
    for (let i = 0; i <= idx; i += 1) expanded.push(levels[i]);
  });

  const seen = new Set();
  return expanded.filter(level => {
    if (seen.has(level)) return false;
    seen.add(level);
    return true;
  });
}

function hasAdminLevelUnlock(user, level) {
  if (!user) return false;
  if (level === FIRST_LEVEL) return true;
  return normalizeUnlockedLevels(user.unlockedLevels || []).includes(level);
}

function normalizePlanDays(value = []) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .map(item => String(item || '').trim())
    .filter(day => PLAN_DAYS.includes(day))
    .filter(day => {
      if (seen.has(day)) return false;
      seen.add(day);
      return true;
    });
}

function normalizeTopicAccessMode(value, fallbackUnlimited = false) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'unlimited') return 'unlimited';
  if (mode === 'daily') return 'daily';
  return fallbackUnlimited ? 'unlimited' : 'daily';
}

const WEEKDAY_UZ_BY_EN = {
  Monday: 'Dushanba', Tuesday: 'Seshanba', Wednesday: 'Chorshanba', Thursday: 'Payshanba', Friday: 'Juma', Saturday: 'Shanba', Sunday: 'Yakshanba'
};
function tashkentWeekday(value = new Date()) {
  try {
    const en = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'Asia/Tashkent' }).format(new Date(value));
    return WEEKDAY_UZ_BY_EN[en] || 'Dushanba';
  } catch (error) {
    return ['Yakshanba', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'][new Date(value).getDay()] || 'Dushanba';
  }
}
function tashkentDateNumber(value = new Date()) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return 0;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const data = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
    return Number(`${data.year}${data.month}${data.day}`);
  } catch (error) {
    return Number(`${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`);
  }
}
function topicPassedRecord(db, userId, language, level, topicNo) {
  const p = userProgress(db, userId);
  const rec = p[progressKey(language, level, topicNo)] || null;
  return rec && Number(rec.bestScore || 0) >= TOPIC_PASS_SCORE ? rec : null;
}
function topicPassedAt(record) {
  return record?.passedAt || record?.firstPassedAt || record?.updatedAt || record?.createdAt || '';
}
function topicScheduleStatus(db, userId, language, level, topicNo, now = new Date()) {
  const user = db.users.find(u => u.id === userId);
  const topicAccessMode = normalizeTopicAccessMode(user?.topicAccessMode, !!user?.allowUnlimitedTopics);
  const allowUnlimitedTopics = topicAccessMode === 'unlimited';
  const planDays = normalizePlanDays(user?.planDays || []);
  const todayName = tashkentWeekday(now);
  const todayAllowed = !planDays.length || planDays.includes(todayName);
  const p = userProgress(db, userId);
  const current = p[progressKey(language, level, topicNo)] || null;
  const currentDone = Number(current?.bestScore || 0) >= TOPIC_PASS_SCORE;

  if (allowUnlimitedTopics) {
    return {
      scheduled: false,
      allowed: true,
      todayName,
      todayAllowed: true,
      planDays,
      allowUnlimitedTopics: true,
      message: currentDone
        ? 'Bu mavzu yakunlangan, ko‘rish mumkin.'
        : 'Cheklovsiz rejim: admin tomonidan barcha mavzular ochilgan.'
    };
  }
  if (!planDays.length) {
    return { scheduled: true, allowed: false, todayName, todayAllowed: false, planDays, allowUnlimitedTopics: false, message: 'Admin hali bu o‘quvchiga dars kunlarini biriktirmagan.' };
  }
  if (currentDone) {
    return { scheduled: true, allowed: true, todayName, todayAllowed, planDays, allowUnlimitedTopics: false, message: 'Bu mavzu yakunlangan, ko‘rish mumkin.' };
  }
  if (!todayAllowed) {
    return { scheduled: true, allowed: false, todayName, todayAllowed: false, planDays, allowUnlimitedTopics: false, message: `Bu mavzu faqat belgilangan kunlarda ochiladi: ${planDays.join(', ')}.` };
  }
  if (topicNo === 1) {
    return { scheduled: true, allowed: true, todayName, todayAllowed: true, planDays, allowUnlimitedTopics: false, message: `Bugun ${todayName} — mavzu ishlash kuni.` };
  }
  const prev = topicPassedRecord(db, userId, language, level, topicNo - 1);
  if (!prev) {
    return { scheduled: true, allowed: false, todayName, todayAllowed: true, planDays, allowUnlimitedTopics: false, message: `Avval ${topicNo - 1}-mavzudan kamida 90% oling.` };
  }
  const prevDate = tashkentDateNumber(topicPassedAt(prev));
  const todayDate = tashkentDateNumber(now);
  if (prevDate && todayDate <= prevDate) {
    return { scheduled: true, allowed: false, todayName, todayAllowed: true, planDays, allowUnlimitedTopics: false, message: 'Keyingi mavzu keyingi belgilangan kunda ochiladi.' };
  }
  return { scheduled: true, allowed: true, todayName, todayAllowed: true, planDays, allowUnlimitedTopics: false, message: `Bugun ${todayName} — yangi mavzu ochiq.` };
}


function displayCenterName(name = '') {
  const raw = String(name || '').trim();
  if (!raw) return '';
  if (/al\s*-?\s*aziz|mock\s+platform|main\s+center/i.test(raw)) return 'ENGLISH Mock';
  return raw;
}

function safeUser(user, db = null) {
  const subjectTitle = user.subject === 'all' ? 'Barcha fanlar' : subjectMap[user.subject];
  const progressSummary = buildStudentProgressSummary(db, user);
  const speakingSummary = summarizeSpeakingForUser(db, user);
  const currentLevel = progressSummary.currentLevel || getUserCurrentLevel(db, user);
  return {
    id: user.id,
    role: user.role,
    username: user.username,
    fullName: user.fullName,
    birthDate: user.birthDate || '',
    subject: user.subject || 'english',
    subjectTitle,
    centerId: user.centerId || (isSuperAdmin(user) ? 'all' : DEFAULT_CENTER_ID),
    centerName: user.centerId === 'all' ? 'Barcha markazlar' : (db ? displayCenterName(centerById(db, user.centerId).name) : ''),
    centerLogoDataUrl: db ? centerById(db, user.centerId).logoDataUrl || '' : '',
    currentLevel,
    currentTopicNo: progressSummary.currentTopicNo,
    currentTopicTitle: progressSummary.currentTopicTitle,
    currentTopicScore: progressSummary.currentTopicScore,
    progressPercent: progressSummary.progressPercent,
    speakingPercent: speakingSummary.percent,
    speakingPassedPercent: speakingSummary.passedPercent,
    speakingCheckedWords: speakingSummary.checkedWords,
    speakingPassedWords: speakingSummary.passedWords,
    speakingTotalWords: speakingSummary.totalWords,
    speakingAttempts: speakingSummary.attempts,
    speakingSummary,
    topicProgress: progressSummary.topicProgress || [],
    isSuper: !!user.isSuper,
    isActive: statusOf(user) === 'active',
    status: statusOf(user),
    createdAt: user.createdAt || '',
    expiresAt: user.expiresAt || '',
    lastLoginAt: user.lastLoginAt || '',
    loginCount: user.loginCount || 0,
    planDays: Array.isArray(user.planDays) ? user.planDays : [],
    allowUnlimitedTopics: normalizeTopicAccessMode(user.topicAccessMode, !!user.allowUnlimitedTopics) === 'unlimited',
    topicAccessMode: normalizeTopicAccessMode(user.topicAccessMode, !!user.allowUnlimitedTopics),
    unlockedLevels: normalizeUnlockedLevels(user.unlockedLevels || []),
    paymentStatus: normalizePaymentStatus(user.paymentStatus || 'paid'),
    paymentStatusTitle: paymentStatusLabel(user.paymentStatus || 'paid'),
    paymentAmount: user.paymentAmount || '',
    paymentNote: user.paymentNote || ''
  };
}
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ message: 'Login qiling' });
  const payload = verifyJwtToken(token);
  if (!payload || !payload.sub || !payload.sid) {
    return res.status(401).json({ message: 'Sessiya eskirgan. Qayta login qiling.' });
  }
  const db = readDb();
  const user = db.users.find(u => u.id === payload.sub);
  if (!user) return res.status(401).json({ message: 'Foydalanuvchi topilmadi. Qayta login qiling.' });

  // JWT + session control: account faqat oxirgi login qilingan bitta qurilmada ishlaydi.
  if (!user.sessionId || user.sessionId !== payload.sid || user.sessionToken !== token) {
    return res.status(401).json({ message: 'Bu account boshqa qurilmada ochilgan yoki sessiya eskirgan. Qayta login qiling.' });
  }
  if (statusOf(user) !== 'active') return res.status(403).json({ message: 'Accountingiz non-active holatda. Admin bilan bog‘laning.' });
  req.user = user;
  req.db = db;
  next();
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Faqat admin uchun' });
  next();
}

function teacherOnly(req, res, next) {
  if (req.user.role !== 'teacher' && req.user.role !== 'admin') return res.status(403).json({ message: 'Faqat o‘qituvchi yoki admin uchun' });
  next();
}
function teacherSubject(req) { return req.user.subject === 'all' ? 'english' : req.user.subject; }
function canAdminManageSubject(admin, subject) { return admin.subject === 'all' || admin.subject === subject; }
function requireSubject(req, res, next) {
  const language = req.params.language;
  if (!subjectMap[language]) return res.status(404).json({ message: 'Fan topilmadi' });
  if (req.user.role === 'student' && req.user.subject !== language) {
    return res.status(403).json({ message: `Sizga faqat ${subjectMap[req.user.subject]} fani biriktirilgan` });
  }
  if (req.user.role === 'admin' && !canAdminManageSubject(req.user, language)) {
    return res.status(403).json({ message: `Bu admin faqat ${subjectMap[req.user.subject]} fanini boshqaradi` });
  }
  next();
}
function makeProfile(config) {
  return {
    concept: config.concept,
    core: config.core,
    structure: config.structure,
    usage: config.usage,
    nuance: config.nuance,
    mistakes: config.mistakes,
    examples: config.examples || [],
    terms: config.terms || [],
    checks: config.checks || [],
    writingTasks: config.writingTasks || []
  };
}
function topicTerm(word, meaning, example) { return { word, meaning, example }; }

// Original Essential Grammar in Use style lesson profiles.
// These are inspired by the simple unit format, but all text and exercises are custom-written for this platform.
const ESSENTIAL_STYLE_ENGLISH_PROFILES = {
  "A / AN": {
    "concept": "A / An — noaniq artikl",
    "core": "Ingliz tilida a va an bitta sanaladigan narsaning oldidan keladi. Ular ko‘pincha o‘zbekchaga alohida tarjima qilinmaydi, lekin ma’nosi: bitta, biror, noaniq narsa. Masalan: a book — bitta kitob yoki biror kitob; an apple — bitta olma yoki biror olma.",
    "form": "a + undosh tovush: a book, a pen, a dog, a student.\nan + unli tovush: an apple, an egg, an orange, an umbrella.\na/an + adjective + singular noun: a big dog, an old car.",
    "use": "A/an faqat birlikdagi sanaladigan ot bilan ishlatiladi. Biror narsani birinchi marta aytganda, odamning kasbini aytganda yoki bitta narsani umumiy ma’noda aytganda ishlatiladi: I have a pen. She is a teacher. He has an idea.",
    "note": "A yoki an tanlashda birinchi harfga emas, birinchi tovushga qaraladi. University u harfi bilan yoziladi, lekin /juː/ tovushi bilan boshlanadi, shuning uchun a university. Hour h bilan yoziladi, lekin h talaffuz qilinmaydi, shuning uchun an hour.",
    "mistakes": "A/an ko‘plik ot bilan ishlatilmaydi: a books emas, books. Sanalmaydigan ot bilan ham ishlatilmaydi: a water emas, water yoki some water. Eng ko‘p xatolar: a apple → an apple; an book → a book; an university → a university; a hour → an hour.",
    "examples": [
      "a book / bitta kitob",
      "a pen / bitta ruchka",
      "a dog / bitta it",
      "a cat / bitta mushuk",
      "an apple / bitta olma",
      "an egg / bitta tuxum",
      "an orange / bitta apelsin",
      "an umbrella / bitta soyabon",
      "a big dog / katta it",
      "an old car / eski mashina",
      "She is a teacher. / U ustoz.",
      "He is an engineer. / U muhandis.",
      "I have a new phone. / Menda yangi telefon bor.",
      "There is an office near here. / Bu yer yaqinida ofis bor.",
      "They are students. / Ular o‘quvchilar. A/an ishlatilmaydi, chunki students ko‘plik."
    ],
    "terms": [
      ["a", "undosh tovushdan oldin", "a book, a dog, a pen"],
      ["an", "unli tovushdan oldin", "an apple, an egg, an orange"],
      ["singular", "birlik", "a car"],
      ["plural", "ko‘plik", "cars — a cars emas"],
      ["countable noun", "sanasa bo‘ladigan ot", "a pen, an apple"],
      ["uncountable noun", "sanab bo‘lmaydigan ot", "water — a water emas"],
      ["vowel sound", "unli tovush", "an umbrella"],
      ["consonant sound", "undosh tovush", "a teacher"],
      ["job", "kasb", "She is a nurse."],
      ["a/an kerak emas", "ko‘plik yoki sanalmaydigan otlarda", "books, water, milk"]
    ],
    "checks": [
      ["___ apple", ["a", "an"], 1, "Apple unli tovush bilan boshlanadi: an apple."],
      ["___ dog", ["a", "an"], 0, "Dog undosh tovush bilan boshlanadi: a dog."],
      ["___ elephant", ["a", "an"], 1, "Elephant unli tovush bilan boshlanadi: an elephant."],
      ["___ university", ["a", "an"], 0, "University /juː/ tovushi bilan boshlanadi: a university."],
      ["___ hour", ["a", "an"], 1, "Hour so‘zida h talaffuz qilinmaydi: an hour."],
      ["Qaysi gap to‘g‘ri?", ["They are students.", "They are a students.", "They are an students.", "They is students."], 0, "Students ko‘plik, shuning uchun a/an qo‘yilmaydi."]
    ]
  },
  "PLURALS (REGULAR)": {
    "concept": "Regular plurals — qoidali ko‘plik",
    "core": "Ingliz tilida bitta narsa singular, ikki yoki undan ko‘p narsa plural deyiladi. Qoidali ko‘plikda ot ko‘plik shaklida yoziladi: one book — two books. O‘zbek tilidagi -lar ma’nosiga o‘xshaydi, lekin ingliz tilida son kelganda ot ham ko‘plik shaklida bo‘lishi kerak.",
    "form": "1) Oddiy otlar ko‘plikda -s bilan tugaydi: flowers, zebras, lions.\n2) s, ss, sh, ch, x, o bilan tugagan otlar ko‘pincha -es bilan tugaydi: buses, glasses, dishes, watches, boxes, tomatoes.\n3) Undosh + y bilan tugagan otlarda ko‘plik shakli -ies bilan tugaydi: babies, cities.\n4) Unli + y bo‘lsa, y qoladi va -s keladi: boys, toys.",
    "use": "Regular plurals sonlar bilan, ko‘p miqdorni aytganda va rasmda nechta narsa borligini yozganda ishlatiladi: two flowers, four zebras, three lions, many students. Ko‘plik otlar bilan ko‘pincha are, these, those, many, some ishlatiladi.",
    "note": "A/an faqat birlik ot bilan ishlatiladi: a book, an apple. Ko‘plikda a/an ishlatilmaydi: two books, three apples. one book deyamiz, lekin two books deyish kerak. Agar son 2 yoki undan katta bo‘lsa, ot ko‘plik shaklida keladi.",
    "mistakes": "Eng ko‘p xatolar: two book, boxs, watchs, babys, a books. To‘g‘ri yozishda son va many/these/those kabi so‘zlardan keyin ot ko‘plik shaklida keladi. s, ss, sh, ch, x, o oxirida ko‘pincha -es, undosh + y oxirida esa -ies keladi.",
    "examples": [
      "one flower — two flowers / bitta gul — ikkita gul",
      "one zebra — four zebras / bitta zebra — to‘rtta zebra",
      "one lion — three lions / bitta sher — uchta sher",
      "one car — five cars / bitta mashina — beshta mashina",
      "one pen — two pens / bitta ruchka — ikkita ruchka",
      "one bus — two buses / bitta avtobus — ikkita avtobus",
      "one glass — three glasses / bitta stakan — uchta stakan",
      "one dish — four dishes / bitta idish — to‘rtta idish",
      "one watch — two watches / bitta soat — ikkita soat",
      "one box — three boxes / bitta quti — uchta quti",
      "one tomato — two tomatoes / bitta pomidor — ikkita pomidor",
      "one baby — two babies / bitta chaqaloq — ikkita chaqaloq",
      "one city — three cities / bitta shahar — uchta shahar",
      "one boy — two boys / bitta bola — ikkita bola"
    ],
    "terms": [
      ["singular", "birlik", "one book"],
      ["plural", "ko‘plik", "two books"],
      ["-s", "oddiy ko‘plik qo‘shimchasi", "flowers, zebras, lions"],
      ["-es", "s/ss/sh/ch/x/o bilan tugagan otlarda", "buses, glasses, boxes"],
      ["-ies", "undosh + y dan keyin", "baby — babies"],
      ["vowel + y", "unli + y bo‘lsa -s qo‘shiladi", "boys"],
      ["countable noun", "sanaladigan ot", "one pen, two pens"],
      ["many", "ko‘p", "many students"]
    ],
    "checks": [
      ["one flower — two ___", ["flowers", "flower", "floweres", "floweries"], 0, "Flower oddiy ot, -s qo‘shiladi."],
      ["one zebra — four ___", ["zebras", "zebra", "zebraes", "zebraies"], 0, "Zebra oddiy ot, -s qo‘shiladi."],
      ["one lion — three ___", ["lions", "lion", "liones", "lionies"], 0, "Lion oddiy ot, -s qo‘shiladi."],
      ["one bus — two ___", ["buses", "bus", "buss", "busies"], 0, "Bus oxiri s, -es qo‘shiladi."],
      ["one box — three ___", ["boxes", "boxs", "boxies", "box"], 0, "Box oxiri x, -es qo‘shiladi."],
      ["one baby — two ___", ["babies", "babys", "babyes", "baby"], 0, "Undosh + y: y → ies."],
      ["one boy — two ___", ["boys", "boies", "boyes", "boy"], 0, "Vowel + y bo‘lsa faqat -s qo‘shiladi."]
    ]
  },
  "PLURAL (IRREGULAR)": {
    "concept": "Irregular plurals",
    "core": "Irregular plural oddiy -s qoidasiga bo‘ysunmaydi. Bu so‘zlar alohida shaklga ega va ularni misollar bilan yodlash kerak.",
    "form": "man → men; woman → women; child → children; person → people; tooth → teeth; foot → feet; mouse → mice.",
    "use": "Odamlar, tana a’zolari va ayrim kundalik otlarning ko‘plik shaklida ishlatiladi.",
    "note": "Irregular shaklning o‘zi ko‘plik ma’nosini beradi. Children so‘ziga yana -s qo‘shilmaydi.",
    "mistakes": "Ko‘p xato: childs, childrens, mans, womans, foots. Bu shakllarni alohida mashq qilish kerak.",
    "examples": [
      "one child — two children / bitta bola — ikkita bola",
      "one man — three men / bitta erkak — uchta erkak",
      "one woman — two women / bitta ayol — ikkita ayol",
      "one person — many people / bitta odam — ko‘p odamlar",
      "one tooth — two teeth / bitta tish — ikkita tish",
      "one foot — two feet / bitta oyoq panjasi — ikkita oyoq panjasi"
    ],
    "terms": [
      [
        "child",
        "bola",
        "children"
      ],
      [
        "man",
        "erkak",
        "men"
      ],
      [
        "woman",
        "ayol",
        "women"
      ],
      [
        "person",
        "odam",
        "people"
      ],
      [
        "tooth",
        "tish",
        "teeth"
      ],
      [
        "foot",
        "oyoq panjasi",
        "feet"
      ]
    ],
    "checks": [
      [
        "one child — two ___",
        [
          "children",
          "childs",
          "childrens",
          "childes"
        ],
        0,
        "Child → children."
      ],
      [
        "one man — three ___",
        [
          "men",
          "mans",
          "man",
          "menes"
        ],
        0,
        "Man → men."
      ],
      [
        "one foot — two ___",
        [
          "feet",
          "foots",
          "feets",
          "foot"
        ],
        0,
        "Foot → feet."
      ]
    ]
  },
  "TO BE": {
    "concept": "To be: am / is / are",
    "core": "To be ingliz tilidagi eng asosiy fe’llardan biri. U o‘zbek tilidagi -man, -san, -dir, holatda kabi ma’nolarni beradi. Ingliz tilida bunday gaplarda fe’l tushib qolmaydi: Men o‘quvchiman — I am a student. U tayyor — She is ready. Ular xursand — They are happy.",
    "form": "Positive:\nI am ...\nHe / She / It is ...\nYou / We / They are ...\n\nNegative:\nI am not ...\nHe / She / It is not ...\nYou / We / They are not ...\n\nQuestion:\nAm I ...?\nIs he / she / it ...?\nAre you / we / they ...?",
    "use": "To be asosan kim ekanini, kasbni, yoshni, millatni, holatni va sifatni aytishda ishlatiladi. Masalan: I am a student. He is a doctor. She is thirteen. We are happy. They are ready.",
    "note": "Qisqa shakllar ko‘p ishlatiladi: I am = I’m, you are = you’re, he is = he’s, she is = she’s, it is = it’s, we are = we’re, they are = they’re. Inkor qisqa shakllari: is not = isn’t, are not = aren’t. I am not odatda I’m not bo‘ladi. Qisqa javoblarda to be qaytariladi: Are you ready? — Yes, I am. / No, I’m not.",
    "mistakes": "Eng ko‘p xatolar: I student emas — I am a student. He are emas — He is. They is emas — They are. Savolda You are ready? emas — Are you ready? To be gapda ega bilan mos bo‘lishi kerak.",
    "examples": [
      "I am a student. / Men o‘quvchiman.",
      "You are my friend. / Siz mening do‘stimsiz.",
      "He is a doctor. / U shifokor.",
      "She is thirteen. / U o‘n uch yoshda.",
      "It is cold today. / Bugun sovuq.",
      "We are happy. / Biz xursandmiz.",
      "They are ready. / Ular tayyor.",
      "I am not tired. / Men charchagan emasman.",
      "She is not busy. / U band emas.",
      "They are not late. / Ular kechikkan emas.",
      "Are you ready? / Siz tayyormisiz?",
      "Is he your teacher? / U sizning ustozingizmi?",
      "Yes, I am. / Ha.",
      "No, she isn’t. / Yo‘q."
    ],
    "terms": [
      ["am", "faqat I bilan ishlatiladi", "I am a student."],
      ["is", "he / she / it yoki birlik ot bilan ishlatiladi", "She is happy."],
      ["are", "you / we / they yoki ko‘plik ot bilan ishlatiladi", "They are ready."],
      ["not", "inkor yasaydi: emas", "He is not here."],
      ["subject", "ega: kim yoki nima haqida gap ketyapti", "I, you, he, she, it, we, they"],
      ["adjective", "sifat: qanday?", "The room is clean."],
      ["noun", "ot: odam/narsa/joy nomi", "He is a teacher."],
            ["short answer", "qisqa javob", "Yes, I am. / No, I’m not."],
      ["contraction", "qisqa shakl", "I’m, he’s, we’re, isn’t, aren’t"]
    ],
    "checks": [
      ["I ___ a student.", ["am", "is", "are", "be"], 0, "I bilan am ishlatiladi."],
      ["She ___ my sister.", ["is", "am", "are", "be"], 0, "She bilan is ishlatiladi."],
      ["They ___ at school.", ["are", "is", "am", "be"], 0, "They bilan are ishlatiladi."],
      ["You ___ ready.", ["are", "is", "am", "be"], 0, "You bilan are ishlatiladi."],
      ["He ___ not busy.", ["is", "are", "am", "be"], 0, "He bilan is, inkorda is not."],
      ["___ you OK?", ["Are", "Is", "Am", "Be"], 0, "Savolda are gap boshiga chiqadi."],
      ["___ Ali your friend?", ["Is", "Are", "Am", "Be"], 0, "Ali bitta odam, shuning uchun Is."],
      ["We ___ happy.", ["are", "is", "am", "be"], 0, "We bilan are ishlatiladi."],
      ["It ___ cold today.", ["is", "are", "am", "be"], 0, "It bilan is ishlatiladi."],
      ["I ___ not tired.", ["am", "is", "are", "be"], 0, "I bilan am not ishlatiladi."]
    ]
  },
  "SUBJECT PRONOUN": {
      "concept": "Subject pronouns — I / you / he / she / it / we / they",
      "core": "Ingliz tilida subject pronouns deganda gapda ega o‘rnida ishlatiladigan olmoshlar tushuniladi. Ular odam, narsa yoki guruh nomini qayta-qayta takrorlamaslik uchun kerak. Masalan: John is my brother. He is my brother. Bu yerda He so‘zi John o‘rnida ishlatilgan.",
      "form": "Birlikda (Singular):\nI = men\nyou = sen / siz\nhe = u — erkak\nshe = u — ayol\nit = u — narsa yoki hayvon\n\nKo‘plikda (Plural):\nwe = biz\nyou = siz / sizlar\nthey = ular",
      "use": "Subject pronoun gapda kim yoki nima haqida gap ketayotganini bildiradi. Odatda gap boshida keladi va undan keyin fe’l ishlatiladi: I am, you are, he is, she works, they play. Ism birinchi marta aytilgandan keyin keyingi gapda olmosh ishlatamiz: Malika is my sister. She is kind.",
      "note": "I har doim katta harf bilan yoziladi. You bitta odamga ham, ko‘p odamga ham ishlatiladi. He faqat erkak kishi uchun, she ayol kishi uchun, it narsa, hayvon yoki ob-havo uchun ishlatiladi. They ikki yoki undan ko‘p odam/narsa uchun ishlatiladi.",
      "mistakes": "Ko‘p uchraydigan xatolar: Ali = she emas, Ali erkak bo‘lsa he. Book = he emas, it. Children = it emas, they. I kichik harf bilan yozilmaydi. They ko‘plik bo‘lgani uchun to be bilan are ishlatiladi: They are, They is emas.",
      "examples": [
          "John is my brother. He is my brother. / John mening akam. U mening akam.",
          "Malika is my sister. She is my sister. / Malika mening singlim. U mening singlim.",
          "The book is on the table. It is on the table. / Kitob stol ustida. U stol ustida.",
          "Children are playing in the garden. They are playing in the garden. / Bolalar bog‘da o‘ynayapti. Ular bog‘da o‘ynayapti.",
          "My father is a doctor. He is a doctor. / Otam shifokor. U shifokor.",
          "My mother is a teacher. She is a teacher. / Onam ustoz. U ustoz.",
          "You and I are students. We are students. / Sen va men o‘quvchimiz. Biz o‘quvchimiz.",
          "Tom and Ali are friends. They are friends. / Tom va Ali do‘stlar. Ular do‘stlar.",
          "I am a pupil. / Men o‘quvchiman.",
          "You are my friend. / Sen mening do‘stimsan.",
          "He is 18 years old. / U 18 yoshda.",
          "She is very beautiful. / U juda chiroyli.",
          "It is a phone. / U telefon.",
          "We are in class. / Biz sinfdamiz.",
          "They are happy. / Ular xursand."
      ],
      "terms": [
          [
              "I",
              "men",
              "I am a pupil."
          ],
          [
              "you",
              "sen / siz / sizlar",
              "You are my friend."
          ],
          [
              "he",
              "u — erkak kishi",
              "Ali is my brother. He is kind."
          ],
          [
              "she",
              "u — ayol kishi",
              "Malika is my sister. She is kind."
          ],
          [
              "it",
              "u — narsa, hayvon yoki ob-havo",
              "The book is new. It is red."
          ],
          [
              "we",
              "biz",
              "You and I are students. We are students."
          ],
          [
              "they",
              "ular",
              "Children are playing. They are playing."
          ],
          [
              "singular",
              "birlik",
              "I, you, he, she, it"
          ],
          [
              "plural",
              "ko‘plik",
              "we, you, they"
          ],
          [
              "subject",
              "ega",
              "Subject + verb: He is, They are"
          ]
      ],
      "checks": [
          [
              "John is my brother. ___ is my brother.",
              [
                  "He",
                  "She",
                  "It",
                  "They"
              ],
              0,
              "John erkak ism, shuning uchun he."
          ],
          [
              "Malika is my sister. ___ is my sister.",
              [
                  "She",
                  "He",
                  "It",
                  "They"
              ],
              0,
              "Malika ayol ism, shuning uchun she."
          ],
          [
              "The book is new. ___ is new.",
              [
                  "It",
                  "He",
                  "She",
                  "They"
              ],
              0,
              "Narsa uchun it ishlatiladi."
          ],
          [
              "Children are playing. ___ are playing.",
              [
                  "They",
                  "It",
                  "He",
                  "She"
              ],
              0,
              "Children ko‘plik, shuning uchun they."
          ],
          [
              "You and I = ___",
              [
                  "we",
                  "they",
                  "you",
                  "it"
              ],
              0,
              "You and I birga bo‘lsa we."
          ],
          [
              "Tom and Ali are friends. ___ are friends.",
              [
                  "They",
                  "He",
                  "We",
                  "It"
              ],
              0,
              "Ikki odam = they."
          ],
          [
              "___ am a pupil.",
              [
                  "I",
                  "He",
                  "She",
                  "They"
              ],
              0,
              "Am faqat I bilan ishlatiladi."
          ],
          [
              "My mother is a teacher. ___ is a teacher.",
              [
                  "She",
                  "He",
                  "It",
                  "They"
              ],
              0,
              "Mother ayol, shuning uchun she."
          ],
          [
              "A dog is under the tree. ___ is under the tree.",
              [
                  "It",
                  "He",
                  "She",
                  "They"
              ],
              0,
              "Hayvon haqida umumiy gapda it ishlatiladi."
          ],
          [
              "My friends are here. ___ are here.",
              [
                  "They",
                  "We",
                  "It",
                  "He"
              ],
              0,
              "Friends ko‘plik, shuning uchun they."
          ]
      ]
  },
  "THERE IS / THERE ARE": {
    "concept": "There is / There are",
    "core": "There is/are biror joyda narsa yoki odam borligini aytadi. Gapning ma’nosi “bor/yo‘q” atrofida bo‘ladi.",
    "form": "There is + singular/uncountable. There are + plural. Question: Is there...? / Are there...?",
    "use": "Xona, rasm, shahar yoki stol ustidagi narsalarni tasvirlashda ishlatiladi.",
    "note": "There is a book — kitob bor. Ko‘plikda there are books bo‘ladi.",
    "mistakes": "Ko‘p xato: There is two books, There are a pen. Ot birlikmi yoki ko‘plikmi tekshiring.",
    "examples": [
      "There is a book on the table. / Stol ustida kitob bor.",
      "There are three students in the room. / Xonada uchta o‘quvchi bor.",
      "There is not any milk. / Sut yo‘q.",
      "Are there many cars? / Mashinalar ko‘pmi?",
      "Is there a bank near here? / Yaqinda bank bormi?",
      "There are no problems. / Muammo yo‘q."
    ],
    "terms": [
      [
        "there is",
        "birlik uchun",
        "There is a chair"
      ],
      [
        "there are",
        "ko‘plik uchun",
        "There are chairs"
      ],
      [
        "singular",
        "birlik",
        "a book"
      ],
      [
        "plural",
        "ko‘plik",
        "books"
      ],
      [
        "place",
        "joy",
        "in the room"
      ],
      [
        "any",
        "savol/inkorda",
        "any water"
      ]
    ],
    "checks": [
      [
        "There ___ a pen on the desk.",
        [
          "is",
          "are",
          "am",
          "be"
        ],
        0,
        "A pen birlik."
      ],
      [
        "There ___ two pens.",
        [
          "are",
          "is",
          "am",
          "be"
        ],
        0,
        "Two pens ko‘plik."
      ],
      [
        "___ there a school near here?",
        [
          "Is",
          "Are",
          "Do",
          "Does"
        ],
        0,
        "A school birlik."
      ]
    ]
  },
  "HAVE / HAS": {
    "concept": "Have / Has",
    "core": "Have/has kimdadir biror narsa borligini aytadi.",
    "structure": "I/you/we/they + have. He/she/it yoki bitta ism + has.",
    "usage": "Egalik, oila, dars, narsa yoki holatni sodda gapda aytishda ishlatiladi.",
    "nuance": "Have va has boshqa zamonlar bilan aralashtirilmaydi. Bu mavzuda faqat have yoki has tanlanadi.",
    "mistakes": "She have demang — She has. They has demang — They have. I has demang — I have.",
    "examples": [
      "I have a new phone. / Menda yangi telefon bor.",
      "She has two brothers. / Uning ikkita aka/ukasi bor.",
      "We have English on Monday. / Dushanba kuni ingliz tili darsimiz bor.",
      "The school has many rooms. / Maktabda ko‘p xona bor."
    ],
    "terms": [
      ["have", "I/you/we/they bilan", "I have a pen."],
      ["has", "he/she/it bilan", "She has a bag."],
      ["We have", "bizda bor", "We have English."],
      ["They have", "ularda bor", "They have books."],
      ["He has", "unda bor", "He has a car."],
      ["The school has", "maktabda bor", "The school has rooms."]
    ],
    "checks": [
      ["She ___ a red bag.", ["have", "has"], 1, "She bilan has."],
      ["They ___ a big house.", ["have", "has"], 0, "They bilan have."],
      ["The teacher ___ a laptop.", ["have", "has"], 1, "Teacher bitta odam, shuning uchun has."]
    ]
  },
  "PREPOSITION OF PLACE": {
    "concept": "Prepositions of place",
    "core": "Joy predloglari narsa yoki odam qayerda turganini ko‘rsatadi: in, on, under, next to, between, behind, in front of.",
    "form": "preposition + noun: on the table, in the bag, under the chair.",
    "use": "Xona, rasm, maktab, shahar va narsa joylashuvini tasvirlashda ishlatiladi.",
    "note": "O‘zbek tilida ko‘p joyda “-da” bo‘ladi, lekin ingliz tilida in, on, at, under kabi alohida predlog tanlanadi.",
    "mistakes": "Ko‘p xato: in the table, on school, under chair. Predlogdan keyingi ot ko‘pincha article bilan keladi.",
    "examples": [
      "The book is on the table. / Kitob stol ustida.",
      "The phone is in the bag. / Telefon sumka ichida.",
      "The cat is under the chair. / Mushuk stul ostida.",
      "Ali is next to me. / Ali yonimda.",
      "The bank is between the shop and the school. / Bank do‘kon va maktab orasida.",
      "The car is behind the house. / Mashina uy orqasida."
    ],
    "terms": [
      [
        "in",
        "ichida",
        "in the room"
      ],
      [
        "on",
        "ustida",
        "on the desk"
      ],
      [
        "under",
        "ostida",
        "under the bed"
      ],
      [
        "next to",
        "yonida",
        "next to the door"
      ],
      [
        "between",
        "orasida",
        "between two chairs"
      ],
      [
        "behind",
        "orqasida",
        "behind the house"
      ]
    ],
    "checks": [
      [
        "The book is ___ the table.",
        [
          "on",
          "in",
          "under",
          "between"
        ],
        0,
        "Stol ustida — on."
      ],
      [
        "The phone is ___ the bag.",
        [
          "in",
          "on",
          "behind",
          "between"
        ],
        0,
        "Sumka ichida — in."
      ],
      [
        "The cat is ___ the chair. (ostida)",
        [
          "under",
          "on",
          "in",
          "next to"
        ],
        0,
        "Ostida — under."
      ]
    ]
  },
  "PREPOSITION OF TIME": {
    "concept": "Prepositions of time",
    "core": "Vaqt predloglari ish-harakat qachon bo‘lishini ko‘rsatadi: at, on, in.",
    "form": "at + exact time: at 5 o’clock. on + day/date: on Monday. in + month/year/season/part of day: in May.",
    "use": "Dars vaqti, tug‘ilgan kun, oy, yil, fasl va kun qismlarini aytishda ishlatiladi.",
    "note": "At aniq soat uchun, on kun/sana uchun, in kattaroq vaqt oralig‘i uchun ishlatiladi.",
    "mistakes": "Ko‘p xato: in Monday, on 5 o’clock, at May. Vaqt turini aniqlang.",
    "examples": [
      "The lesson starts at 9 o’clock. / Dars soat 9 da boshlanadi.",
      "We meet on Monday. / Biz dushanba kuni uchrashamiz.",
      "My birthday is in June. / Tug‘ilgan kunim iyunda.",
      "I study in the morning. / Men ertalab o‘qiyman.",
      "She was born in 2010. / U 2010-yilda tug‘ilgan.",
      "The test is on 15 May. / Test 15-may kuni."
    ],
    "terms": [
      [
        "at",
        "aniq vaqt",
        "at 7:00"
      ],
      [
        "on",
        "kun/sana",
        "on Friday"
      ],
      [
        "in",
        "oy/yil/fasl",
        "in 2026"
      ],
      [
        "morning",
        "ertalab",
        "in the morning"
      ],
      [
        "date",
        "sana",
        "on 12 April"
      ],
      [
        "exact time",
        "aniq vaqt",
        "at noon"
      ]
    ],
    "checks": [
      [
        "The class starts ___ 8:00.",
        [
          "at",
          "on",
          "in"
        ],
        0,
        "Aniq soat — at."
      ],
      [
        "We meet ___ Monday.",
        [
          "on",
          "in",
          "at"
        ],
        0,
        "Kun — on."
      ],
      [
        "My birthday is ___ July.",
        [
          "in",
          "on",
          "at"
        ],
        0,
        "Oy — in."
      ]
    ]
  },
  "PRESENT SIMPLE & PRESENT CONTINUOUS": {
    "concept": "Present Simple vs Present Continuous",
    "core": "Present Simple odat va doimiy holatni, Present Continuous esa hozir davom etayotgan yoki vaqtinchalik ishni bildiradi.",
    "form": "Present Simple: V1 / V-s. Present Continuous: am/is/are + V-ing.",
    "use": "Every day, usually → Present Simple. Now, at the moment, today → Present Continuous.",
    "note": "I work every day — odat. I am working now — ayni paytdagi ish.",
    "mistakes": "Ko‘p xato: I am go every day, She play now. Vaqt belgilarini ko‘ring.",
    "examples": [
      "I work every day. / Men har kuni ishlayman.",
      "I am working now. / Men hozir ishlayapman.",
      "She usually drinks tea. / U odatda choy ichadi.",
      "She is drinking tea now. / U hozir choy ichyapti.",
      "They play football on Sundays. / Ular yakshanba futbol o‘ynaydi.",
      "They are playing football at the moment. / Ular ayni paytda futbol o‘ynashyapti."
    ],
    "terms": [
      [
        "habit",
        "odat",
        "every day"
      ],
      [
        "now",
        "hozir",
        "now"
      ],
      [
        "usually",
        "odatda",
        "usually"
      ],
      [
        "at the moment",
        "ayni paytda",
        "at the moment"
      ],
      [
        "temporary",
        "vaqtinchalik",
        "this week"
      ],
      [
        "state verb",
        "holat fe’li",
        "like, know"
      ]
    ],
    "checks": [
      [
        "I ___ coffee every morning.",
        [
          "drink",
          "am drinking",
          "drinks",
          "is drinking"
        ],
        0,
        "Every morning — odat."
      ],
      [
        "Look! She ___.",
        [
          "is running",
          "runs",
          "run",
          "running"
        ],
        0,
        "Look! hozir bo‘layotgan ish."
      ],
      [
        "He usually ___.",
        [
          "walks",
          "is walking",
          "walk",
          "walking"
        ],
        0,
        "Usually — Present Simple."
      ]
    ]
  },
  "ADVERB AND ADJECTIVE": {
    "concept": "Adjective and adverb",
    "core": "Adjective otni tasvirlaydi, adverb esa fe’lni yoki ish-harakat qanday bajarilganini tasvirlaydi.",
    "form": "adjective + noun: a slow car. verb + adverb: drive slowly. Ko‘p adverb: adjective + -ly.",
    "use": "Odam, narsa va ish-harakatni aniqroq tasvirlash uchun ishlatiladi.",
    "note": "Good adjective, well adverb: She is a good singer. She sings well.",
    "mistakes": "Ko‘p xato: He drives careful, She sings good. Fe’lni tasvirlayotganda adverb kerak.",
    "examples": [
      "It is a slow car. / Bu sekin mashina.",
      "He drives slowly. / U sekin haydaydi.",
      "She is a careful student. / U e’tiborli o‘quvchi.",
      "She writes carefully. / U e’tibor bilan yozadi.",
      "This is a good answer. / Bu yaxshi javob.",
      "You speak English well. / Siz inglizcha yaxshi gapirasiz."
    ],
    "terms": [
      [
        "adjective",
        "sifat",
        "slow car"
      ],
      [
        "adverb",
        "ravish",
        "drive slowly"
      ],
      [
        "-ly",
        "adverb qo‘shimchasi",
        "quickly"
      ],
      [
        "good",
        "sifat",
        "good teacher"
      ],
      [
        "well",
        "ravish",
        "speak well"
      ],
      [
        "verb",
        "fe’l",
        "run, write"
      ]
    ],
    "checks": [
      [
        "He is a ___ driver.",
        [
          "careful",
          "carefully",
          "care",
          "carefulness"
        ],
        0,
        "Driver otini adjective tasvirlaydi."
      ],
      [
        "He drives ___.",
        [
          "carefully",
          "careful",
          "care",
          "carefulness"
        ],
        0,
        "Drive fe’lini adverb tasvirlaydi."
      ],
      [
        "She sings ___.",
        [
          "well",
          "good",
          "betterly",
          "goodly"
        ],
        0,
        "Fe’l uchun well."
      ]
    ]
  },
  "PREPOSITION TIME AND PLACE": {
    "concept": "Prepositions of time and place",
    "core": "Time predloglari qachon, place predloglari qayerda ekanini ko‘rsatadi. Ba’zi predloglar ikkala ma’noda ham kelishi mumkin.",
    "form": "Time: at 5, on Monday, in May. Place: at school, on the table, in the room.",
    "use": "Vaqt va joyni bitta gapda aniq aytish uchun ishlatiladi.",
    "note": "At kichik/aniq nuqta, on yuza yoki kun, in ichki/keng joy yoki katta vaqt oralig‘i uchun ishlatiladi.",
    "mistakes": "Ko‘p xato: on 7 o’clock, in Monday, at the room. Vaqtmi yoki joymi — avval shuni aniqlang.",
    "examples": [
      "I am at school at 9 o’clock. / Men soat 9 da maktabdaman.",
      "The book is on the table. / Kitob stol ustida.",
      "We meet on Friday. / Biz juma kuni uchrashamiz.",
      "She lives in Tashkent. / U Toshkentda yashaydi.",
      "The test is in May. / Test may oyida.",
      "He is in the room now. / U hozir xonada."
    ],
    "terms": [
      [
        "at",
        "aniq nuqta/vaqt",
        "at school, at 8"
      ],
      [
        "on",
        "yuza/kun",
        "on the wall, on Monday"
      ],
      [
        "in",
        "ichida/keng vaqt",
        "in the room, in June"
      ],
      [
        "time",
        "vaqt",
        "at 5"
      ],
      [
        "place",
        "joy",
        "in the room"
      ],
      [
        "context",
        "kontekst",
        "time or place"
      ]
    ],
    "checks": [
      [
        "I am ___ school.",
        [
          "at",
          "on",
          "in",
          "under"
        ],
        0,
        "Aniq joy — at school."
      ],
      [
        "The picture is ___ the wall.",
        [
          "on",
          "in",
          "at",
          "between"
        ],
        0,
        "Devorda — on the wall."
      ],
      [
        "We meet ___ Sunday.",
        [
          "on",
          "in",
          "at",
          "under"
        ],
        0,
        "Kun — on."
      ]
    ]
  },
  "PAST CONTINUOUS": {
    "concept": "Past Continuous",
    "core": "Past Continuous o‘tmishda ma’lum paytda davom etayotgan ish-harakatni bildiradi.",
    "form": "was/were + V-ing. I/he/she/it was; you/we/they were.",
    "use": "At 8 o’clock yesterday, while, when kabi so‘zlar bilan o‘tmishdagi davomiy ishni ko‘rsatadi.",
    "note": "Past Continuous ko‘pincha Past Simple bilan keladi: I was reading when he called.",
    "mistakes": "Ko‘p xato: I were reading, they was playing, was read. Was/were va -ing kerak.",
    "examples": [
      "I was reading at 8 pm. / Men soat 8 da o‘qiyotgan edim.",
      "They were playing football. / Ular futbol o‘ynayotgan edi.",
      "She was cooking when I came. / Men kelganimda u ovqat pishirayotgan edi.",
      "We were not sleeping. / Biz uxlayotgan emas edik.",
      "Was he studying? / U o‘qiyotgan edimi?",
      "What were you doing? / Nima qilayotgan edingiz?"
    ],
    "terms": [
      [
        "was",
        "I/he/she/it bilan",
        "was reading"
      ],
      [
        "were",
        "you/we/they bilan",
        "were playing"
      ],
      [
        "V-ing",
        "davomiy shakl",
        "reading"
      ],
      [
        "while",
        "paytida",
        "while I was walking"
      ],
      [
        "when",
        "qachonki",
        "when he called"
      ],
      [
        "past time",
        "o‘tgan vaqt",
        "yesterday"
      ]
    ],
    "checks": [
      [
        "They ___ playing football.",
        [
          "were",
          "was",
          "are",
          "did"
        ],
        0,
        "They bilan were."
      ],
      [
        "I ___ reading at 7.",
        [
          "was",
          "were",
          "am",
          "did"
        ],
        0,
        "I bilan was."
      ],
      [
        "She was ___.",
        [
          "cooking",
          "cook",
          "cooks",
          "cooked"
        ],
        0,
        "Was + V-ing."
      ]
    ]
  },
  "CONDITIONAL 0": {
    "concept": "Zero Conditional",
    "core": "Zero Conditional doimiy haqiqat, qoida yoki natija har safar bir xil bo‘ladigan holatni bildiradi.",
    "form": "If + Present Simple, Present Simple. Example: If you heat water, it boils.",
    "use": "Ilmiy faktlar, umumiy qoidalar va odatiy natijalarni aytishda ishlatiladi.",
    "note": "Bu yerda if ma’nosi “qachonki/agar har safar”ga yaqin. Kelajak haqida taxmin emas, umumiy haqiqat.",
    "mistakes": "Ko‘p xato: If you will heat water, it will boil. Zero conditionalda ikkala qism Present Simple bo‘ladi.",
    "examples": [
      "If you heat water, it boils. / Suvni qizdirsangiz, qaynaydi.",
      "If it rains, the ground gets wet. / Yomg‘ir yog‘sa, yer ho‘l bo‘ladi.",
      "If you mix red and blue, you get purple. / Qizil va ko‘kni aralashtirsangiz, binafsha chiqadi.",
      "If people eat too much, they get tired. / Ko‘p yesa, charchashadi.",
      "Ice melts if you heat it. / Muzni qizdirsangiz, eriydi.",
      "If students practice, they improve. / O‘quvchilar mashq qilsa, yaxshilanadi."
    ],
    "terms": [
      [
        "if",
        "agar/qachonki",
        "if you heat"
      ],
      [
        "present simple",
        "hozirgi oddiy",
        "water boils"
      ],
      [
        "fact",
        "haqiqat",
        "scientific fact"
      ],
      [
        "result",
        "natija",
        "it boils"
      ],
      [
        "rule",
        "qoida",
        "class rule"
      ],
      [
        "comma",
        "vergul",
        "If..., ..."
      ]
    ],
    "checks": [
      [
        "If you heat ice, it ___.",
        [
          "melts",
          "will melt",
          "melted",
          "is melting"
        ],
        0,
        "Zero conditional: Present Simple."
      ],
      [
        "If it rains, the road ___.",
        [
          "gets wet",
          "will get wet",
          "getting wet",
          "got wet"
        ],
        0,
        "Umumiy natija."
      ],
      [
        "If you press this button, the machine ___.",
        [
          "starts",
          "will start",
          "started",
          "is start"
        ],
        0,
        "Qoida — Present Simple."
      ]
    ]
  },
  "HAVE TO / MUST": {
    "concept": "Have to / Must",
    "core": "Have to va must majburiyat, qoida yoki zaruratni bildiradi. Must ko‘pincha kuchliroq yoki gapiruvchining talabi bo‘ladi.",
    "form": "must + V1. have/has to + V1. Negative: mustn’t = mumkin emas; don’t/doesn’t have to = shart emas.",
    "use": "Qoidalar, dars, ish, xavfsizlik va maslahat/majburiyatlarda ishlatiladi.",
    "note": "Mustn’t va don’t have to bir xil emas: mustn’t = taqiqlangan, don’t have to = majbur emassan.",
    "mistakes": "Ko‘p xato: must to go, he have to, mustn’t = shart emas deb tushunish.",
    "examples": [
      "You must wear a seat belt. / Xavfsizlik kamarini taqishingiz shart.",
      "I have to finish my homework. / Uy vazifamni tugatishim kerak.",
      "She has to wake up early. / U erta turishi kerak.",
      "You mustn’t smoke here. / Bu yerda chekish mumkin emas.",
      "You don’t have to come early. / Erta kelishingiz shart emas.",
      "Do we have to pay now? / Hozir to‘lashimiz kerakmi?"
    ],
    "terms": [
      [
        "must",
        "shart/kerak",
        "must study"
      ],
      [
        "have to",
        "majburiyat",
        "have to go"
      ],
      [
        "has to",
        "he/she/it bilan",
        "has to work"
      ],
      [
        "mustn’t",
        "mumkin emas",
        "mustn’t smoke"
      ],
      [
        "don’t have to",
        "shart emas",
        "don’t have to wait"
      ],
      [
        "V1",
        "asosiy fe’l",
        "must go"
      ]
    ],
    "checks": [
      [
        "You ___ stop at a red light.",
        [
          "must",
          "must to",
          "musts",
          "are must"
        ],
        0,
        "Must + V1."
      ],
      [
        "She ___ work today.",
        [
          "has to",
          "have to",
          "musts",
          "haves to"
        ],
        0,
        "She bilan has to."
      ],
      [
        "You ___ use your phone here. It is forbidden.",
        [
          "mustn’t",
          "don’t have to",
          "doesn’t have to",
          "not have"
        ],
        0,
        "Taqiq — mustn’t."
      ]
    ]
  },
  "PAST SIMPLE": {
    "concept": "Past Simple",
    "core": "Past Simple o‘tmishda tugagan ish-harakatni bildiradi.",
    "form": "Regular: V-ed. Irregular: went, saw, ate. Negative: did not + V1. Question: Did + subject + V1?",
    "use": "Yesterday, last week, two days ago, in 2020 kabi o‘tgan vaqt so‘zlari bilan ishlatiladi.",
    "note": "Did kelganda asosiy fe’l V1 bo‘ladi: Did you go? “Did you went?” noto‘g‘ri.",
    "mistakes": "Ko‘p xato: I go yesterday, Did he went, she didn’t played. Did + V1 qoidasini tekshiring.",
    "examples": [
      "I watched a film yesterday. / Kecha film ko‘rdim.",
      "She went to school. / U maktabga bordi.",
      "They played football last week. / Ular o‘tgan hafta futbol o‘ynadi.",
      "He did not come. / U kelmadi.",
      "Did you see Ali? / Alini ko‘rdingizmi?",
      "We studied English two days ago. / Ikki kun oldin inglizcha o‘qidik."
    ],
    "terms": [
      [
        "-ed",
        "regular past",
        "watched"
      ],
      [
        "V2",
        "o‘tgan shakl",
        "went"
      ],
      [
        "did",
        "savol/inkor yordamchisi",
        "Did you...?"
      ],
      [
        "yesterday",
        "kecha",
        "yesterday"
      ],
      [
        "last week",
        "o‘tgan hafta",
        "last week"
      ],
      [
        "ago",
        "oldin",
        "two days ago"
      ]
    ],
    "checks": [
      [
        "I ___ TV yesterday.",
        [
          "watched",
          "watch",
          "watches",
          "watching"
        ],
        0,
        "Yesterday — Past Simple."
      ],
      [
        "She ___ to school last week.",
        [
          "went",
          "go",
          "goes",
          "going"
        ],
        0,
        "Go → went."
      ],
      [
        "Did you ___ him?",
        [
          "see",
          "saw",
          "seen",
          "seeing"
        ],
        0,
        "Did dan keyin V1."
      ]
    ]
  },
  "WOULD / COULD": {
    "concept": "Would / Could",
    "core": "Would muloyim so‘rov, xohish yoki shartli holatni; could esa qobiliyatning o‘tgan shakli yoki muloyim so‘rovni bildiradi.",
    "form": "would/could + V1. Question: Would/Could + subject + V1?",
    "use": "Iltimos, taklif, ehtimoliy holat va odobli savollarda ishlatiladi.",
    "note": "Would/could dan keyin to kelmaydi: Would you help? Could I ask?",
    "mistakes": "Ko‘p xato: would to go, coulds, I would went. Modal fe’ldan keyin V1 keladi.",
    "examples": [
      "Would you help me? / Menga yordam berarmidingiz?",
      "Could I ask a question? / Savol bersam bo‘ladimi?",
      "I would like some tea. / Choy xohlardim.",
      "When I was young, I could swim fast. / Yoshligimda tez suza olardim.",
      "Would you like to join us? / Bizga qo‘shilishni xohlaysizmi?",
      "Could you repeat, please? / Iltimos, qaytarasizmi?"
    ],
    "terms": [
      [
        "would",
        "muloyim/shartli",
        "would like"
      ],
      [
        "could",
        "qila olardi/mumkinmi",
        "could swim"
      ],
      [
        "polite request",
        "muloyim so‘rov",
        "Could you...?"
      ],
      [
        "would like",
        "xohlardim",
        "I would like"
      ],
      [
        "V1",
        "asosiy fe’l",
        "would go"
      ],
      [
        "modal",
        "modal fe’l",
        "would/could"
      ]
    ],
    "checks": [
      [
        "___ you help me, please?",
        [
          "Could",
          "Could to",
          "Coulds",
          "Did could"
        ],
        0,
        "Muloyim so‘rov."
      ],
      [
        "I ___ like some water.",
        [
          "would",
          "coulds",
          "would to",
          "am would"
        ],
        0,
        "Would like."
      ],
      [
        "He could ___ fast.",
        [
          "run",
          "runs",
          "running",
          "ran"
        ],
        0,
        "Could + V1."
      ]
    ]
  },
  "USED TO": {
    "concept": "Used to",
    "core": "Used to o‘tmishda odat bo‘lgan, lekin hozir davom etmaydigan holat yoki ish-harakatni bildiradi.",
    "form": "used to + V1. Negative: did not use to + V1. Question: Did + subject + use to + V1?",
    "use": "Eski odatlar, bolalikdagi holatlar va hozir o‘zgargan narsalar haqida ishlatiladi.",
    "note": "I used to play football = oldin o‘ynardim, hozir odatda o‘ynamayman.",
    "mistakes": "Ko‘p xato: I use to played, Did you used to. Did bilan use to bo‘ladi.",
    "examples": [
      "I used to play football. / Men oldin futbol o‘ynardim.",
      "She used to live here. / U oldin shu yerda yashardi.",
      "We did not use to watch TV. / Biz oldin televizor ko‘rmasdik.",
      "Did you use to read a lot? / Oldin ko‘p o‘qirmidingiz?",
      "He used to be shy. / U oldin uyatchan edi.",
      "They used to walk to school. / Ular oldin maktabga piyoda borishardi."
    ],
    "terms": [
      [
        "used to",
        "oldingi odat",
        "used to play"
      ],
      [
        "use to",
        "did bilan shakl",
        "Did you use to...?"
      ],
      [
        "past habit",
        "o‘tgan odat",
        "played before"
      ],
      [
        "changed situation",
        "o‘zgargan holat",
        "not now"
      ],
      [
        "V1",
        "asosiy fe’l",
        "use to live"
      ],
      [
        "did not",
        "inkor",
        "did not use to"
      ]
    ],
    "checks": [
      [
        "I ___ live in a village.",
        [
          "used to",
          "use to",
          "used",
          "am used to"
        ],
        0,
        "Oldingi holat — used to."
      ],
      [
        "Did you ___ play tennis?",
        [
          "use to",
          "used to",
          "using to",
          "used"
        ],
        0,
        "Did bilan use to."
      ],
      [
        "She used to ___ here.",
        [
          "work",
          "works",
          "worked",
          "working"
        ],
        0,
        "Used to + V1."
      ]
    ]
  },
  "FUTURE SIMPLE / TO BE GOING TO": {
    "concept": "Will and be going to",
    "core": "Will ko‘pincha tez qaror, taxmin yoki va’da uchun, be going to esa oldindan reja yoki dalilga asoslangan kelajak uchun ishlatiladi.",
    "form": "will + V1. am/is/are going to + V1.",
    "use": "Kelajak rejalari, va’dalar, qarorlar va taxminlarda ishlatiladi.",
    "note": "Look at the clouds — It is going to rain. I think it will be good — taxmin.",
    "mistakes": "Ko‘p xato: will to go, she going to, I am will. Har bir shaklning o‘z yordamchisi bor.",
    "examples": [
      "I will call you later. / Keyin qo‘ng‘iroq qilaman.",
      "She is going to visit her grandmother. / U buvisini ko‘rgani bormoqchi.",
      "It will be cold tomorrow. / Ertaga sovuq bo‘ladi.",
      "Look! It is going to rain. / Qara, yomg‘ir yog‘moqchi.",
      "We are going to start at 9. / Biz 9 da boshlamoqchimiz.",
      "I won’t be late. / Kechikmayman."
    ],
    "terms": [
      [
        "will",
        "kelajak/taxmin",
        "will go"
      ],
      [
        "going to",
        "reja/dalil",
        "going to rain"
      ],
      [
        "V1",
        "asosiy fe’l",
        "will call"
      ],
      [
        "plan",
        "reja",
        "going to visit"
      ],
      [
        "prediction",
        "taxmin",
        "will be"
      ],
      [
        "promise",
        "va’da",
        "I will help"
      ]
    ],
    "checks": [
      [
        "I ___ call you tomorrow.",
        [
          "will",
          "will to",
          "am will",
          "will going"
        ],
        0,
        "Will + V1."
      ],
      [
        "She ___ going to study.",
        [
          "is",
          "are",
          "am",
          "will"
        ],
        0,
        "She bilan is going to."
      ],
      [
        "Look at the clouds! It ___ rain.",
        [
          "is going to",
          "will to",
          "will going",
          "going"
        ],
        0,
        "Dalil bor — going to."
      ]
    ]
  },
  "CONDITIONAL 1": {
    "concept": "First Conditional",
    "core": "First Conditional kelajakda real bo‘lishi mumkin bo‘lgan shart va natijani bildiradi.",
    "form": "If + Present Simple, will + V1. Example: If it rains, I will stay home.",
    "use": "Reja, ogohlantirish, va’da va real ehtimolli holatlarda ishlatiladi.",
    "note": "If qismida will qo‘yilmaydi: If it rains, I will stay. “If it will rain” noto‘g‘ri.",
    "mistakes": "Ko‘p xato: If I will study, I pass. If qismida Present Simple kerak, natijada will keladi.",
    "examples": [
      "If I study, I will pass. / O‘qisam, o‘taman.",
      "If it rains, we will stay home. / Yomg‘ir yog‘sa, uyda qolamiz.",
      "If you hurry, you will catch the bus. / Shoshsangiz, avtobusga ulgurasiz.",
      "I will call you if I have time. / Vaqtim bo‘lsa, qo‘ng‘iroq qilaman.",
      "If she comes, we will start. / U kelsa, boshlaymiz.",
      "If you don’t practice, you won’t improve. / Mashq qilmasangiz, yaxshilanmaysiz."
    ],
    "terms": [
      [
        "if",
        "agar",
        "if I study"
      ],
      [
        "will",
        "natija",
        "will pass"
      ],
      [
        "present simple",
        "if qismi",
        "if it rains"
      ],
      [
        "real condition",
        "real shart",
        "possible future"
      ],
      [
        "result",
        "natija",
        "will stay"
      ],
      [
        "won’t",
        "will not",
        "won’t improve"
      ]
    ],
    "checks": [
      [
        "If it rains, I ___ home.",
        [
          "will stay",
          "stay",
          "stayed",
          "am staying"
        ],
        0,
        "Natija qismida will."
      ],
      [
        "If she ___, we will start.",
        [
          "comes",
          "will come",
          "came",
          "coming"
        ],
        0,
        "If qismi Present Simple."
      ],
      [
        "If you study, you ___ pass.",
        [
          "will",
          "are",
          "did",
          "have"
        ],
        0,
        "Kelajak natija — will."
      ]
    ]
  },
  "GERUND INFINITIVE": {
    "concept": "Gerund and infinitive",
    "core": "Gerund fe’lning -ing shakli ot vazifasida keladi. Infinitive esa to + V1 shaklida keladi.",
    "form": "gerund: V-ing. infinitive: to + V1. Some verbs: enjoy + V-ing, want + to V1.",
    "use": "Fe’l boshqa fe’ldan keyin kelganda yoki ish-harakatni narsa sifatida aytganda ishlatiladi.",
    "note": "Har bir asosiy fe’l o‘zidan keyin gerund yoki infinitive talab qilishi mumkin: enjoy reading, want to read.",
    "mistakes": "Ko‘p xato: enjoy to read, want reading, decide going. Fe’l birikmalarini misol bilan yodlang.",
    "examples": [
      "I enjoy reading. / Men o‘qishni yoqtiraman.",
      "She wants to learn English. / U ingliz tilini o‘rganmoqchi.",
      "We decided to go home. / Uyga borishga qaror qildik.",
      "He finished doing homework. / U uy vazifasini tugatdi.",
      "Learning English is useful. / Ingliz tilini o‘rganish foydali.",
      "I need to practice more. / Ko‘proq mashq qilishim kerak."
    ],
    "terms": [
      [
        "gerund",
        "V-ing ot vazifasida",
        "reading"
      ],
      [
        "infinitive",
        "to + V1",
        "to read"
      ],
      [
        "enjoy",
        "gerund bilan",
        "enjoy swimming"
      ],
      [
        "want",
        "infinitive bilan",
        "want to go"
      ],
      [
        "finish",
        "gerund bilan",
        "finish writing"
      ],
      [
        "decide",
        "infinitive bilan",
        "decide to study"
      ]
    ],
    "checks": [
      [
        "I enjoy ___ books.",
        [
          "reading",
          "to read",
          "read",
          "reads"
        ],
        0,
        "Enjoy + V-ing."
      ],
      [
        "She wants ___ English.",
        [
          "to learn",
          "learning",
          "learns",
          "learned"
        ],
        0,
        "Want + to V1."
      ],
      [
        "He finished ___ homework.",
        [
          "doing",
          "to do",
          "do",
          "does"
        ],
        0,
        "Finish + V-ing."
      ]
    ]
  },
  "USED TO / WOULD": {
    "concept": "Used to / Would",
    "core": "Used to va would o‘tmishdagi odatlarni aytadi. Used to holat uchun ham keladi, would esa odatda takroriy harakat uchun ishlatiladi.",
    "form": "used to + V1; would + V1. Would odatda action verbs bilan ishlatiladi.",
    "use": "Bolalik, eski odatlar va takroriy voqealarni hikoya qilishda ishlatiladi.",
    "note": "I used to live here to‘g‘ri. I would live here eski holat ma’nosida odatda mos emas.",
    "mistakes": "Ko‘p xato: would bilan state verb ishlatish, did used to, would to go.",
    "examples": [
      "I used to live in a small town. / Men oldin kichik shaharda yashardim.",
      "When we were children, we would play outside. / Bolaligimizda tashqarida o‘ynardik.",
      "She used to be quiet. / U oldin kamgap edi.",
      "My grandfather would tell stories. / Bobom hikoyalar aytib berardi.",
      "Did you use to walk to school? / Oldin maktabga piyoda borarmidingiz?",
      "We didn’t use to have computers. / Oldin kompyuterimiz yo‘q edi."
    ],
    "terms": [
      [
        "used to",
        "oldingi odat/holat",
        "used to live"
      ],
      [
        "would",
        "takroriy o‘tgan harakat",
        "would play"
      ],
      [
        "state verb",
        "holat fe’li",
        "live, be, know"
      ],
      [
        "action verb",
        "harakat fe’li",
        "play, go"
      ],
      [
        "past habit",
        "o‘tgan odat",
        "when I was a child"
      ],
      [
        "did use to",
        "savol shakli",
        "Did you use to...?"
      ]
    ],
    "checks": [
      [
        "I ___ live here when I was young.",
        [
          "used to",
          "would to",
          "use",
          "am used to"
        ],
        0,
        "Holat uchun used to."
      ],
      [
        "Every summer, we ___ visit our grandparents.",
        [
          "would",
          "would to",
          "used",
          "were"
        ],
        0,
        "Takroriy harakat — would."
      ],
      [
        "Did she ___ play tennis?",
        [
          "use to",
          "used to",
          "would to",
          "using to"
        ],
        0,
        "Did bilan use to."
      ]
    ]
  },
  "CAN / CAN’T": {
  "concept": "Can / Can’t",
  "core": "Can modal fe’li “qila olmoq”, “bajara olmoq”, “mumkin” degan ma’nolarni bildiradi. U egadan keyin keladi va barcha shaxslar bilan bir xil ishlatiladi: I can, you can, he can, she can, it can, we can, they can. O‘zbekchada ko‘pincha “-a olaman / -a oladi” deb tarjima qilinadi.",
  "structure": "Positive: subject + can + V1.\nNegative: subject + can not / can’t + V1.\nQuestion: Can + subject + V1?",
  "usage": "Can qobiliyatni aytishda ishlatiladi: I can read. Can ruxsat so‘rashda ham ishlatiladi: Can I come in? Can bilan imkoniyat ham aytiladi: We can start now.",
  "nuance": "Can dan keyin fe’lning oddiy shakli keladi. Fe’lga -s, -ing yoki to qo‘shilmaydi. He can reads emas, He can read. Can hamma shaxslar uchun o‘zgarmaydi: she cans emas, she can.",
  "mistakes": "Eng ko‘p xatolar: can to read, she can reads, do you can, he doesn’t can. To‘g‘ri shakllar: can read, she can read, Can you read?, he can’t read.",
  "examples": [
    "I can read. / Men o‘qiy olaman.",
    "I can swim. / Men suza olaman.",
    "She can speak English. / U ingliz tilida gapira oladi.",
    "He can play football. / U futbol o‘ynay oladi.",
    "They can dance. / Ular raqs tusha oladi.",
    "I can not swim. / Men suza olmayman.",
    "You can’t run fast. / Siz tez yugura olmaysiz.",
    "He can’t drive a car. / U mashina hayday olmaydi.",
    "Can you sing? / Qo‘shiq ayta olasizmi?",
    "Can she speak English? / U ingliz tilida gapira oladimi?",
    "Can I come in? / Kirsam bo‘ladimi?",
    "Can you help me? / Menga yordam bera olasizmi?"
  ],
  "terms": [
    [
      "can",
      "qila olmoq / mumkin",
      "I can read."
    ],
    [
      "can’t",
      "qila olmaslik",
      "I can’t swim."
    ],
    [
      "modal verb",
      "modal fe’l",
      "Can is a modal verb."
    ],
    [
      "ability",
      "qobiliyat",
      "She can sing."
    ],
    [
      "permission",
      "ruxsat",
      "Can I come in?"
    ],
    [
      "V1",
      "fe’lning oddiy shakli",
      "can read, can go"
    ],
    [
      "positive",
      "darak shakl",
      "I can speak English."
    ],
    [
      "negative",
      "inkor shakl",
      "I can’t speak English."
    ],
    [
      "question",
      "savol shakli",
      "Can you speak English?"
    ],
    [
      "short answer",
      "qisqa javob",
      "Yes, I can. / No, I can’t."
    ]
  ],
  "checks": [
    [
      "I can ___ English.",
      [
        "speak",
        "speaks",
        "speaking",
        "to speak"
      ],
      0,
      "Can dan keyin V1 keladi."
    ],
    [
      "She can ___ very well.",
      [
        "sing",
        "sings",
        "singing",
        "to sing"
      ],
      0,
      "She can sing — can o‘zgarmaydi."
    ],
    [
      "___ you help me?",
      [
        "Can",
        "Do can",
        "Are can",
        "Can to"
      ],
      0,
      "Savolda Can gap boshiga chiqadi."
    ],
    [
      "He ___ swim.",
      [
        "can’t",
        "doesn’t can",
        "not can",
        "can not to"
      ],
      0,
      "Inkor shakli can’t."
    ],
    [
      "Can she ___ English?",
      [
        "speak",
        "speaks",
        "speaking",
        "to speak"
      ],
      0,
      "Savolda ham can + V1."
    ],
    [
      "They can ___ football.",
      [
        "play",
        "plays",
        "playing",
        "to play"
      ],
      0,
      "Can + V1: play."
    ]
  ]
}
};

// Clean workbook-style explanations for selected grammar topics.
// Text and examples are original, but the order is intentionally book-like: meaning, form, use, note and mistakes.
Object.assign(ESSENTIAL_STYLE_ENGLISH_PROFILES, {
  "THERE IS / THERE ARE": {
    "concept": "There is / There are",
    "core": "There is / there are joyda narsa yoki odam borligini aytadi. Gapni o‘zbekchaga ko‘pincha “bor” deb tarjima qilamiz.",
    "structure": "There is + birlik ot. There are + ko‘plik ot. Inkor: There isn't / There aren't. Savol: Is there...? / Are there...?",
    "usage": "Xona, sinf, stol, ko‘cha yoki shaharda nimalar borligini aytish uchun ishlatiladi.",
    "nuance": "Ot birlik bo‘lsa is, ko‘plik bo‘lsa are ishlating. Savol va inkorda any ko‘p ishlatiladi: Is there any milk? There aren't any chairs.",
    "mistakes": "There is two books demang. To‘g‘risi: There are two books. There are a chair demang. To‘g‘risi: There is a chair.",
    "examples": [
      "There is a book on the table. / Stol ustida bitta kitob bor.",
      "There are three books on the table. / Stol ustida uchta kitob bor.",
      "There isn't a computer in the room. / Xonada kompyuter yo‘q.",
      "There aren't any chairs here. / Bu yerda stullar yo‘q.",
      "Is there a bank near here? / Bu yer yaqinida bank bormi?",
      "Are there any students in the classroom? / Sinfxonada o‘quvchilar bormi?"
    ],
    "terms": [
      [
        "there is",
        "birlik narsa bor",
        "There is a book."
      ],
      [
        "there are",
        "ko‘plik narsa bor",
        "There are books."
      ],
      [
        "isn't",
        "there is not",
        "There isn't a table."
      ],
      [
        "aren't",
        "there are not",
        "There aren't chairs."
      ],
      [
        "any",
        "savol/inkorda ishlatiladi",
        "Are there any apples?"
      ],
      [
        "a/an",
        "bitta narsa bilan",
        "There is a pen."
      ]
    ],
    "checks": [
      [
        "There ___ a book on the desk.",
        [
          "is",
          "are",
          "am",
          "be"
        ],
        0,
        "A book birlik."
      ],
      [
        "There ___ two books on the desk.",
        [
          "are",
          "is",
          "am",
          "be"
        ],
        0,
        "Two books ko‘plik."
      ],
      [
        "___ there any water?",
        [
          "Is",
          "Are",
          "Do",
          "Does"
        ],
        0,
        "Water sanalmaydi, is ishlatiladi."
      ]
    ]
  },
  "HAVE / HAS": {
    "concept": "Have / Has",
    "core": "Have/has kimdadir biror narsa borligini aytadi.",
    "structure": "I/you/we/they + have. He/she/it yoki bitta ism + has.",
    "usage": "Egalik, oila, dars, narsa yoki holatni sodda gapda aytishda ishlatiladi.",
    "nuance": "Have va has boshqa zamonlar bilan aralashtirilmaydi. Bu mavzuda faqat have yoki has tanlanadi.",
    "mistakes": "She have demang — She has. They has demang — They have. I has demang — I have.",
    "examples": [
      "I have a new phone. / Menda yangi telefon bor.",
      "She has two brothers. / Uning ikkita aka/ukasi bor.",
      "We have English on Monday. / Dushanba kuni ingliz tili darsimiz bor.",
      "The school has many rooms. / Maktabda ko‘p xona bor."
    ],
    "terms": [
      ["have", "I/you/we/they bilan", "I have a pen."],
      ["has", "he/she/it bilan", "She has a bag."],
      ["We have", "bizda bor", "We have English."],
      ["They have", "ularda bor", "They have books."],
      ["He has", "unda bor", "He has a car."],
      ["The school has", "maktabda bor", "The school has rooms."]
    ],
    "checks": [
      ["She ___ a red bag.", ["have", "has"], 1, "She bilan has."],
      ["They ___ a big house.", ["have", "has"], 0, "They bilan have."],
      ["The teacher ___ a laptop.", ["have", "has"], 1, "Teacher bitta odam, shuning uchun has."]
    ]
  },
  "PREPOSITION OF PLACE": {
    "concept": "Prepositions of place",
    "core": "Joy predloglari odam yoki narsa qayerda turganini ko‘rsatadi: ichida, ustida, ostida, yonida, oldida yoki orasida.",
    "structure": "in/on/under/next to/behind/in front of/between + noun. Odatda: subject + be + preposition + place.",
    "usage": "Rasm, xona, sinf, stol ustidagi narsalar, uy yoki ko‘chadagi joylashuvni tasvirlash uchun ishlatiladi.",
    "nuance": "In — ichida. On — ustida/yuzasida. Under — ostida. Next to — yonida. Behind — orqasida. In front of — oldida. Between — ikkita narsa orasida.",
    "mistakes": "On the school demang, odatda at school/in school bo‘ladi. In the table demang — narsa stol ustida bo‘lsa on the table.",
    "examples": [
      "The keys are in my bag. / Kalitlar sumkam ichida.",
      "The picture is on the wall. / Rasm devorda.",
      "The cat is under the chair. / Mushuk stul ostida.",
      "The bank is next to the school. / Bank maktab yonida.",
      "The bus stop is in front of the hotel. / Avtobus bekati mehmonxona oldida.",
      "Ali is between two friends. / Ali ikki do‘stining orasida."
    ],
    "terms": [
      [
        "in",
        "ichida",
        "in the bag"
      ],
      [
        "on",
        "ustida/yuzasida",
        "on the table"
      ],
      [
        "under",
        "ostida",
        "under the chair"
      ],
      [
        "next to",
        "yonida",
        "next to the school"
      ],
      [
        "behind",
        "orqasida",
        "behind the door"
      ],
      [
        "between",
        "orasida",
        "between two chairs"
      ]
    ],
    "checks": [
      [
        "The book is ___ the bag.",
        [
          "in",
          "on",
          "at",
          "to"
        ],
        0,
        "Bag ichida: in."
      ],
      [
        "The picture is ___ the wall.",
        [
          "on",
          "in",
          "under",
          "between"
        ],
        0,
        "Devorda: on."
      ],
      [
        "The cat is ___ the chair.",
        [
          "under",
          "at",
          "to",
          "from"
        ],
        0,
        "Stul ostida: under."
      ]
    ]
  },
  "PREPOSITION OF TIME": {
    "concept": "Prepositions of time",
    "core": "Vaqt predloglari ish-harakat qachon bo‘lishini ko‘rsatadi: aniq vaqt, kun, oy, fasl yoki davr.",
    "structure": "at + aniq vaqt. on + hafta kuni/sana. in + oy/yil/fasl/kun qismi.",
    "usage": "Dars vaqti, kunlar, sanalar, oylar, yillar va kundalik reja haqida gapirganda ishlatiladi.",
    "nuance": "At 7 o'clock. On Monday. On 12 May. In April. In 2026. In the morning. Lekin: at night, at the weekend.",
    "mistakes": "In Monday demang — on Monday. On 7 o'clock demang — at 7 o'clock. At April demang — in April.",
    "examples": [
      "I start work at 9 o'clock. / Men ishni soat 9 da boshlayman.",
      "We have English on Monday. / Dushanba kuni ingliz tili darsimiz bor.",
      "My birthday is on 15 June. / Tug‘ilgan kunim 15-iyunda.",
      "It is cold in winter. / Qishda sovuq bo‘ladi.",
      "She was born in 2010. / U 2010-yilda tug‘ilgan.",
      "I usually study in the evening. / Men odatda kechqurun o‘qiyman."
    ],
    "terms": [
      [
        "at",
        "aniq vaqt",
        "at 8 o'clock"
      ],
      [
        "on",
        "kun/sana",
        "on Friday"
      ],
      [
        "in",
        "oy/yil/fasl",
        "in May"
      ],
      [
        "night",
        "tun",
        "at night"
      ]
    ],
    "checks": [
      [
        "I get up ___ 7 o'clock.",
        [
          "at",
          "on",
          "in"
        ],
        0,
        "Aniq vaqt: at."
      ],
      [
        "We study ___ Monday.",
        [
          "on",
          "at",
          "in"
        ],
        0,
        "Kun: on."
      ],
      [
        "It is hot ___ July.",
        [
          "in",
          "on",
          "at"
        ],
        0,
        "Oy: in."
      ]
    ]
  },
  "PRESENT CONTINUOUS": {
    "concept": "Present Continuous",
    "core": "Present Continuous hozir, gapirilayotgan paytda davom etayotgan ish-harakatni bildiradi.",
    "structure": "am/is/are + verb-ing. Inkor: am/is/are + not + verb-ing. Savol: Am/Is/Are + subject + verb-ing?",
    "usage": "Now, at the moment, today, this week kabi vaqtlar bilan hozir davom etayotgan ish yoki vaqtinchalik holatni aytish uchun ishlatiladi.",
    "nuance": "I am reading now = men hozir o‘qiyapman. Bu odat emas, aynan hozir yoki shu davrda davom etayotgan ish.",
    "mistakes": "I reading demang — I am reading. He are working demang — He is working. She is work demang — She is working.",
    "examples": [
      "I am reading a book now. / Men hozir kitob o‘qiyapman.",
      "She is watching TV at the moment. / U hozir televizor ko‘ryapti.",
      "They are playing football. / Ular futbol o‘ynashyapti.",
      "He isn't sleeping now. / U hozir uxlamayapti.",
      "Are you listening? / Tinglayapsizmi?",
      "What are you doing? / Nima qilyapsiz?"
    ],
    "terms": [
      [
        "am/is/are",
        "yordamchi fe’l",
        "I am, she is, they are"
      ],
      [
        "verb-ing",
        "davomiy fe’l",
        "reading, working"
      ],
      [
        "now",
        "hozir",
        "I am working now."
      ],
      [
        "at the moment",
        "ayni paytda",
        "She is studying at the moment."
      ],
      [
        "not",
        "inkor",
        "is not working"
      ],
      [
        "question",
        "savol",
        "Are you coming?"
      ]
    ],
    "checks": [
      [
        "I ___ reading now.",
        [
          "am",
          "is",
          "are",
          "do"
        ],
        0,
        "I bilan am."
      ],
      [
        "She is ___.",
        [
          "working",
          "work",
          "works",
          "worked"
        ],
        0,
        "Is + verb-ing."
      ],
      [
        "___ they playing?",
        [
          "Are",
          "Is",
          "Do",
          "Does"
        ],
        0,
        "They bilan are."
      ]
    ]
  },
  "PRESENT SIMPLE": {
    "concept": "Present Simple",
    "core": "Present Simple odat, doimiy holat yoki umumiy haqiqatni bildiradi.",
    "structure": "I/you/we/they + V1. He/she/it + V-s/es. Inkor: don't/doesn't + V1. Savol: Do/Does + subject + V1?",
    "usage": "Every day, usually, often, sometimes, always kabi so‘zlar bilan kundalik odat va takrorlanadigan ishlarni aytish uchun ishlatiladi.",
    "nuance": "He/she/it bilan darak gapda fe’lga -s/-es qo‘shiladi. Lekin does bilan savol/inkorda fe’l yana V1 bo‘ladi.",
    "mistakes": "She go demang — She goes. Does he goes demang — Does he go. He doesn't goes demang — He doesn't go.",
    "examples": [
      "I live in Tashkent. / Men Toshkentda yashayman.",
      "She works in a school. / U maktabda ishlaydi.",
      "They play football every day. / Ular har kuni futbol o‘ynashadi.",
      "He doesn't drink coffee. / U kofe ichmaydi.",
      "Do you speak English? / Inglizcha gapirasizmi?",
      "Does your brother study here? / Akangiz/ukangiz shu yerda o‘qiydimi?"
    ],
    "terms": [
      [
        "V1",
        "fe’lning asosiy shakli",
        "I work."
      ],
      [
        "V-s/es",
        "he/she/it shakli",
        "She works."
      ],
      [
        "do",
        "savol/inkor yordamchisi",
        "Do you work?"
      ],
      [
        "does",
        "he/she/it yordamchisi",
        "Does he work?"
      ],
      [
        "usually",
        "odatda",
        "I usually study."
      ],
      [
        "every day",
        "har kuni",
        "She walks every day."
      ]
    ],
    "checks": [
      [
        "She ___ English every day.",
        [
          "studies",
          "study",
          "studying",
          "studied"
        ],
        0,
        "She bilan -s/-es."
      ],
      [
        "They ___ football.",
        [
          "play",
          "plays",
          "playing",
          "played"
        ],
        0,
        "They bilan V1."
      ],
      [
        "Does he ___ here?",
        [
          "work",
          "works",
          "working",
          "worked"
        ],
        0,
        "Does dan keyin V1."
      ]
    ]
  },
  "PRESENT SIMPLE & PRESENT CONTINUOUS": {
    "concept": "Present Simple vs Present Continuous",
    "core": "Present Simple odatni, Present Continuous esa hozir davom etayotgan ishni bildiradi.",
    "structure": "Present Simple: subject + V1/V-s. Present Continuous: am/is/are + verb-ing.",
    "usage": "Odat va doimiy holat uchun Present Simple; now/at the moment/this week kabi vaqtinchalik yoki hozirgi harakat uchun Present Continuous ishlatiladi.",
    "nuance": "I usually work at home = odat. I am working at home today = bugungi vaqtinchalik holat.",
    "mistakes": "Now bo‘lsa odatda am/is/are + ing kerak. Every day bo‘lsa odatda Present Simple kerak.",
    "examples": [
      "I usually walk to school. / Men odatda maktabga piyoda boraman.",
      "I am walking to school now. / Men hozir maktabga piyoda ketyapman.",
      "She works in a bank. / U bankda ishlaydi.",
      "She is working late today. / U bugun kechgacha ishlayapti.",
      "Do you play tennis? / Tennis o‘ynaysizmi?",
      "Are you playing tennis now? / Hozir tennis o‘ynayapsizmi?"
    ],
    "terms": [
      [
        "usually",
        "odat belgisi",
        "I usually go."
      ],
      [
        "now",
        "hozirgi harakat belgisi",
        "I am going now."
      ],
      [
        "every day",
        "takroriy ish",
        "She studies every day."
      ],
      [
        "at the moment",
        "ayni payt",
        "She is studying at the moment."
      ],
      [
        "V-s",
        "Present Simple he/she/it",
        "He works."
      ],
      [
        "verb-ing",
        "Present Continuous",
        "He is working."
      ]
    ],
    "checks": [
      [
        "She usually ___ tea.",
        [
          "drinks",
          "is drinking",
          "drink",
          "drinking"
        ],
        0,
        "Usually — Present Simple."
      ],
      [
        "She ___ tea now.",
        [
          "is drinking",
          "drinks",
          "drink",
          "drank"
        ],
        0,
        "Now — Present Continuous."
      ],
      [
        "They ___ football every Sunday.",
        [
          "play",
          "are playing",
          "plays",
          "played"
        ],
        0,
        "Every Sunday — Present Simple."
      ]
    ]
  },
  "PAST SIMPLE": {
    "concept": "Past Simple",
    "core": "Past Simple o‘tmishda tugagan ish-harakatni bildiradi.",
    "structure": "Regular: verb + -ed. Irregular: went, saw, did... Inkor: didn't + V1. Savol: Did + subject + V1?",
    "usage": "Yesterday, last week, last year, two days ago kabi aniq o‘tgan vaqtlar bilan ishlatiladi.",
    "nuance": "Darak gapda fe’l V2 bo‘ladi: went, played. Lekin did/didn't bilan fe’l yana V1 bo‘ladi: Did you go? I didn't go.",
    "mistakes": "Did you went demang — Did you go. I didn't went demang — I didn't go. She play yesterday demang — She played yesterday.",
    "examples": [
      "I watched TV yesterday. / Men kecha televizor ko‘rdim.",
      "She went to Samarkand last week. / U o‘tgan hafta Samarqandga bordi.",
      "They played football two days ago. / Ular ikki kun oldin futbol o‘ynashdi.",
      "He didn't come to class. / U darsga kelmadi.",
      "Did you see Ali? / Alini ko‘rdingizmi?",
      "Where did you go yesterday? / Kecha qayerga bordingiz?"
    ],
    "terms": [
      [
        "-ed",
        "regular fe’l qo‘shimchasi",
        "played, watched"
      ],
      [
        "V2",
        "o‘tgan zamon shakli",
        "went, saw"
      ],
      [
        "did",
        "savol yordamchisi",
        "Did you go?"
      ],
      [
        "didn't",
        "inkor yordamchisi",
        "I didn't go."
      ],
      [
        "yesterday",
        "kecha",
        "yesterday evening"
      ],
      [
        "ago",
        "oldin",
        "two days ago"
      ]
    ],
    "checks": [
      [
        "I ___ TV yesterday.",
        [
          "watched",
          "watch",
          "watching",
          "watches"
        ],
        0,
        "Yesterday — Past Simple."
      ],
      [
        "She ___ to school last week.",
        [
          "went",
          "go",
          "goes",
          "going"
        ],
        0,
        "Go ning V2 shakli went."
      ],
      [
        "Did you ___ him?",
        [
          "see",
          "saw",
          "seen",
          "seeing"
        ],
        0,
        "Did dan keyin V1."
      ]
    ]
  },
  "PAST CONTINUOUS": {
    "concept": "Past Continuous",
    "core": "Past Continuous o‘tmishdagi bir vaqtda davom etayotgan ish-harakatni bildiradi.",
    "structure": "was/were + verb-ing. Inkor: wasn't/weren't + verb-ing. Savol: Was/Were + subject + verb-ing?",
    "usage": "O‘tmishda aniq vaqtda davom etgan ishni yoki bir ish davom etayotgan paytda boshqa ish bo‘lganini aytish uchun ishlatiladi.",
    "nuance": "I was cooking when you called = siz qo‘ng‘iroq qilgan paytda ovqat qilish davom etayotgan edi.",
    "mistakes": "I were working demang — I was working. They was playing demang — They were playing. Was play demang — was playing.",
    "examples": [
      "I was doing my homework at 8 o'clock. / Soat 8 da uy vazifamni qilayotgan edim.",
      "She was cooking when I called. / Men qo‘ng‘iroq qilganimda u ovqat tayyorlayotgan edi.",
      "They were watching TV. / Ular televizor ko‘rayotgan edi.",
      "We weren't sleeping. / Biz uxlamayotgan edik.",
      "Were you studying at 9? / Soat 9 da o‘qiyotgan edingizmi?",
      "What were you doing yesterday evening? / Kecha kechqurun nima qilayotgan edingiz?"
    ],
    "terms": [
      [
        "was",
        "I/he/she/it bilan",
        "I was reading."
      ],
      [
        "were",
        "you/we/they bilan",
        "They were playing."
      ],
      [
        "verb-ing",
        "davomiy fe’l",
        "working, cooking"
      ],
      [
        "when",
        "qachonki",
        "when he called"
      ],
      [
        "while",
        "... paytida",
        "while I was reading"
      ],
      [
        "at 8 o'clock",
        "aniq o‘tgan vaqt",
        "at 8 yesterday"
      ]
    ],
    "checks": [
      [
        "I ___ reading at 8.",
        [
          "was",
          "were",
          "am",
          "did"
        ],
        0,
        "I bilan was."
      ],
      [
        "They ___ playing football.",
        [
          "were",
          "was",
          "are",
          "did"
        ],
        0,
        "They bilan were."
      ],
      [
        "She was ___.",
        [
          "cooking",
          "cook",
          "cooks",
          "cooked"
        ],
        0,
        "Was + verb-ing."
      ]
    ]
  },
  "FUTURE SIMPLE / TO BE GOING TO": {
    "concept": "Future: will / going to",
    "core": "Will va going to kelajak haqida gapirish uchun ishlatiladi, lekin ma’nosi bir xil emas.",
    "structure": "Will: subject + will + V1. Going to: am/is/are + going to + V1.",
    "usage": "Will ko‘pincha hozir qaror qilish, va’da yoki taxmin uchun. Going to oldindan reja yoki ko‘rinib turgan belgi uchun.",
    "nuance": "I think it will rain = taxmin. Look at the clouds — it is going to rain = belgi bor. I am going to visit my uncle = oldindan reja.",
    "mistakes": "Will to go demang — will go. She going to study demang — She is going to study. I am go to demang — I am going to.",
    "examples": [
      "I will call you later. / Men sizga keyin qo‘ng‘iroq qilaman.",
      "I think he will come tomorrow. / Menimcha u ertaga keladi.",
      "She is going to buy a new phone. / U yangi telefon sotib olmoqchi.",
      "Look at the sky. It is going to rain. / Osmonga qarang, yomg‘ir yog‘adiganga o‘xshaydi.",
      "We aren't going to stay long. / Biz uzoq qolmoqchi emasmiz.",
      "Will you help me? / Menga yordam berasizmi?"
    ],
    "terms": [
      [
        "will",
        "taxmin/va’da/tez qaror",
        "I will help you."
      ],
      [
        "won't",
        "will not",
        "I won't be late."
      ],
      [
        "going to",
        "reja yoki belgi",
        "I am going to travel."
      ],
      [
        "plan",
        "reja",
        "future plan"
      ],
      [
        "prediction",
        "taxmin",
        "I think he will win."
      ],
      [
        "V1",
        "asosiy fe’l",
        "will go"
      ]
    ],
    "checks": [
      [
        "I ___ call you later.",
        [
          "will",
          "am",
          "going",
          "to"
        ],
        0,
        "Will + V1."
      ],
      [
        "She ___ going to study tonight.",
        [
          "is",
          "are",
          "am",
          "will"
        ],
        0,
        "She bilan is."
      ],
      [
        "Look! It ___ rain.",
        [
          "is going to",
          "will to",
          "going",
          "are going to"
        ],
        0,
        "Belgi bor — going to."
      ]
    ]
  },
  "PRESENT PERFECT": {
    "concept": "Present Perfect",
    "core": "Present Perfect o‘tmishda bo‘lgan ishning hozirga bog‘langan natijasi yoki tajribasini bildiradi.",
    "structure": "have/has + V3. Inkor: haven't/hasn't + V3. Savol: Have/Has + subject + V3?",
    "usage": "Natija hozir muhim bo‘lsa, hayotiy tajriba haqida gapirilsa yoki just, already, yet, ever, never bilan ishlatiladi.",
    "nuance": "I have lost my key = kalitim yo‘q va bu hozir muhim. Aniq tugagan vaqt aytilsa Past Simple ishlatiladi: I lost it yesterday.",
    "mistakes": "She have finished demang — She has finished. I have went demang — I have gone. Did you have seen demang — Have you seen?",
    "examples": [
      "I have finished my homework. / Men uy vazifamni tugatdim.",
      "She has visited Samarkand. / U Samarqandga borgan.",
      "Have you ever seen snow? / Hech qor ko‘rganmisiz?",
      "They haven't arrived yet. / Ular hali yetib kelmagan.",
      "He has just opened the door. / U hozirgina eshikni ochdi.",
      "We have never eaten this food. / Biz bu ovqatni hech yegan emasmiz."
    ],
    "terms": [
      [
        "have/has",
        "yordamchi fe’l",
        "have finished"
      ],
      [
        "V3",
        "uchinchi shakl",
        "seen, done, gone"
      ],
      [
        "ever",
        "tajriba savolida",
        "Have you ever...?"
      ],
      [
        "never",
        "hech qachon",
        "I have never..."
      ],
      [
        "yet",
        "hali",
        "hasn't arrived yet"
      ],
      [
        "just",
        "hozirgina",
        "has just opened"
      ]
    ],
    "checks": [
      [
        "She ___ finished the work.",
        [
          "has",
          "have",
          "is",
          "did"
        ],
        0,
        "She bilan has."
      ],
      [
        "I have ___ this film.",
        [
          "seen",
          "saw",
          "see",
          "seeing"
        ],
        0,
        "Have + V3."
      ],
      [
        "Have you ___ eaten sushi?",
        [
          "ever",
          "yesterday",
          "last",
          "ago"
        ],
        0,
        "Tajriba savolida ever."
      ]
    ]
  },
  "PRESENT PERFECT INTRO": {
    "concept": "Present Perfect intro",
    "core": "Present Perfect hozirga bog‘langan natija yoki hayotiy tajribani bildiradi. Avval have/has + V3 shaklini tanib oling.",
    "structure": "I/you/we/they have + V3. He/she/it has + V3. Savol: Have/Has + subject + V3?",
    "usage": "finished work, visited places, ever/never, just/already/yet kabi holatlarda ishlatiladi.",
    "nuance": "Yesterday, last week, ago kabi aniq vaqt bo‘lsa ko‘pincha Past Simple ishlatiladi.",
    "mistakes": "Have/hasni tashlab ketmang va V2 o‘rniga V3 ishlating: I have gone, she has done.",
    "examples": [
      "I have finished my test. / Men testimni tugatdim.",
      "She has cleaned the room. / U xonani tozalagan.",
      "Have you ever been to Tashkent? / Hech Toshkentda bo‘lganmisiz?",
      "He hasn't done his homework yet. / U hali uy vazifasini bajarmagan.",
      "They have already started. / Ular allaqachon boshlashgan.",
      "We have never played this game. / Biz bu o‘yinni hech o‘ynamaganmiz."
    ],
    "terms": [
      [
        "have",
        "I/you/we/they bilan",
        "I have finished."
      ],
      [
        "has",
        "he/she/it bilan",
        "She has finished."
      ],
      [
        "V3",
        "uchinchi shakl",
        "done, seen, gone"
      ],
      [
        "already",
        "allaqachon",
        "already started"
      ],
      [
        "yet",
        "hali",
        "not yet"
      ],
      [
        "ever",
        "tajriba savolida",
        "Have you ever...?"
      ]
    ],
    "checks": [
      [
        "They ___ already started.",
        [
          "have",
          "has",
          "are",
          "did"
        ],
        0,
        "They bilan have."
      ],
      [
        "He has ___ his homework.",
        [
          "done",
          "did",
          "do",
          "doing"
        ],
        0,
        "Has + V3."
      ],
      [
        "___ you ever been to Tashkent?",
        [
          "Have",
          "Did",
          "Are",
          "Do"
        ],
        0,
        "Present Perfect savoli."
      ]
    ]
  }
});


// PRESENT CONTINUOUS deep lesson update V73.
// This keeps the lesson in a simple workbook-like style, with original Uzbek explanations and translated examples.
Object.assign(ESSENTIAL_STYLE_ENGLISH_PROFILES, {
  "PRESENT CONTINUOUS": {
    "concept": "Present Continuous — hozir davomli zamon",
    "core": "Present Continuous hozir gapirilayotgan paytda davom etayotgan ish-harakatni bildiradi. O‘zbekchaga ko‘pincha “-yapti / -moqda” deb tarjima qilinadi. Masalan: He is sleeping now. — U hozir uxlayapti. I am reading now. — Men hozir o‘qiyapman. Bu zamon aynan hozir bo‘layotgan harakat yoki shu kunlarda vaqtincha davom etayotgan holat uchun ishlatiladi.",
    "structure": "Positive: subject + am/is/are + verb-ing.\nNegative: subject + am/is/are + not + verb-ing.\nQuestion: Am/Is/Are + subject + verb-ing?",
    "usage": "Present Continuous now, right now, at the moment, today, this week, these days kabi vaqt so‘zlari bilan ko‘p ishlatiladi. Gap ma’nosi “hozir qilyapti”, “ayni paytda bo‘lyapti” yoki “shu kunlarda vaqtincha davom etyapti” bo‘lsa, Present Continuous tanlanadi.",
    "nuance": "Present Continuous odatni emas, hozirgi yoki vaqtinchalik harakatni bildiradi. I read every day — men har kuni o‘qiyman, bu Present Simple. I am reading now — men hozir o‘qiyapman, bu Present Continuous. Always bilan ishlatilganda ba’zan bezovtalik yoki shikoyat bildiradi: He is always using my phone. — U doim telefonimni ishlatyapti.",
    "mistakes": "Eng ko‘p xatolar: I reading now demang — I am reading now. She are cooking demang — She is cooking. They is playing demang — They are playing. He is read demang — He is reading. Bu zamonda ham to be yordamchisi, ham verb-ing kerak.",
    "examples": [
      "I am reading now. / Men hozir o‘qiyapman.",
      "You are listening to the teacher. / Siz ustozni tinglayapsiz.",
      "He is sleeping now. / U hozir uxlayapti.",
      "She is cooking dinner. / U kechki ovqat pishiryapti.",
      "It is raining at the moment. / Ayni paytda yomg‘ir yog‘yapti.",
      "We are learning English today. / Biz bugun ingliz tilini o‘rganyapmiz.",
      "They are playing football in the yard. / Ular hovlida futbol o‘ynashyapti.",
      "I am not working now. / Men hozir ishlamayapman.",
      "She is not watching TV. / U televizor ko‘rmayapti.",
      "Are you studying now? / Hozir o‘qiyapsizmi?",
      "Is he playing? / U o‘ynayaptimi?",
      "What are you doing? / Nima qilyapsiz?"
    ],
    "terms": [
      ["now", "hozir", "I am reading now."],
      ["right now", "aynan hozir", "She is working right now."],
      ["at the moment", "ayni paytda", "They are eating at the moment."],
      ["today", "bugun / vaqtincha holat", "I am studying at home today."],
      ["this week", "shu hafta", "We are learning a new topic this week."],
      ["these days", "shu kunlarda", "He is staying with his aunt these days."],
      ["Look!", "Qara! hozir bo‘layotgan ish", "Look! The boy is running."],
      ["Listen!", "Eshit! hozir bo‘layotgan ish", "Listen! Someone is singing."],
      ["am/is/are", "to be yordamchi fe’llari", "I am, she is, they are"],
      ["verb-ing", "fe’lning -ing shakli", "read → reading"],
      ["not", "inkor yasaydi", "is not sleeping"],
      ["always", "doim — shikoyat ma’nosida ham keladi", "He is always talking."
      ]
    ],
    "checks": [
      ["I ___ reading now.", ["am", "is", "are", "do"], 0, "I bilan am ishlatiladi."],
      ["She ___ cooking at the moment.", ["is", "am", "are", "do"], 0, "She bilan is ishlatiladi."],
      ["They ___ playing football now.", ["are", "is", "am", "does"], 0, "They ko‘plik, are ishlatiladi."],
      ["He is not ___.", ["sleeping", "sleep", "sleeps", "slept"], 0, "Present Continuous: be + verb-ing."],
      ["___ you listening?", ["Are", "Do", "Is", "Does"], 0, "Savolda are egadan oldinga chiqadi."],
      ["Look! The cat ___.", ["is running", "runs", "run", "are running"], 0, "Look! hozirgi harakatni ko‘rsatadi."],
      ["write + ing = ___", ["writing", "writeing", "writting", "writeng"], 0, "Oxiri -e bo‘lsa, e tushadi: write → writing."]
    ]
  }
});


// PRESENT SIMPLE deep lesson update V74.
// Original Uzbek explanation in a simple workbook-like order.
Object.assign(ESSENTIAL_STYLE_ENGLISH_PROFILES, {
  "PRESENT SIMPLE": {
    "concept": "Present Simple — hozirgi oddiy zamon",
    "core": "Present Simple ingliz tilida doimiy yoki qaytarilib turadigan ish-harakatni bildiradi. Bu zamon odat, kun tartibi, ish joyi, dars jadvali, umumiy haqiqat va doimiy holatlar uchun ishlatiladi. O‘zbekchaga ko‘pincha “-adi / -ydi / -aman / -san” ma’nosida tarjima qilinadi. Masalan: I go to school every day. — Men har kuni maktabga boraman. You work at the hospital. — Siz shifoxonada ishlaysiz.",
    "structure": "Positive: I / you / we / they + V1. He / she / it + V-s/es.\nNegative: I / you / we / they + do not + V1. He / she / it + does not + V1.\nQuestion: Do + I / you / we / they + V1? Does + he / she / it + V1?",
    "usage": "Present Simple every day, every week, usually, always, often, sometimes, never kabi so‘zlar bilan ko‘p ishlatiladi. Biror ish doim takrorlansa, odat bo‘lsa yoki umumiy fakt bo‘lsa, Present Simple ishlatiladi. Masalan: The shop opens at nine. — Do‘kon soat to‘qqizda ochiladi. Water boils at 100°C. — Suv 100°C da qaynaydi.",
    "nuance": "3-shaxs birlikda — he, she, it yoki bitta odam/narsa bilan — darak gapda fe’lga -s yoki -es qo‘shiladi: He works. She goes. It rains. Lekin inkor va savolda does ishlatilganda asosiy fe’lga -s/-es qo‘shilmaydi: He does not work. Does she go?",
    "mistakes": "Eng ko‘p xatolar: He go demang — He goes. She don’t like demang — She doesn’t like. Does he goes? demang — Does he go? He doesn’t likes demang — He doesn’t like. Do/does kelgandan keyin asosiy fe’l doim V1 bo‘ladi.",
    "examples": [
      "I go to school every day. / Men har kuni maktabga boraman.",
      "You work at the hospital. / Siz shifoxonada ishlaysiz.",
      "We study English on Monday. / Biz dushanba kuni ingliz tili o‘qiymiz.",
      "They play football after school. / Ular darsdan keyin futbol o‘ynashadi.",
      "He goes to school every day. / U har kuni maktabga boradi.",
      "She watches TV in the evening. / U kechqurun televizor ko‘radi.",
      "My mother works at the hospital. / Onam shifoxonada ishlaydi.",
      "The shop opens at nine. / Do‘kon soat to‘qqizda ochiladi.",
      "I don’t like coffee. / Men kofeni yoqtirmayman.",
      "Tom doesn’t work at school. / Tom maktabda ishlamaydi.",
      "Do you speak English? / Siz inglizcha gapirasizmi?",
      "Does she speak English? / U inglizcha gapiradimi?",
      "Water boils at 100°C. / Suv 100°C da qaynaydi.",
      "The sun rises in the east. / Quyosh sharqdan chiqadi."
    ],
    "terms": [
      ["every day", "har kuni", "I study every day."],
      ["usually", "odatda", "We usually have lunch at one."],
      ["always", "har doim", "He always gets up early."],
      ["often", "tez-tez", "They often play football."],
      ["sometimes", "ba’zan", "She sometimes drinks tea."],
      ["never", "hech qachon", "I never smoke."],
      ["do", "I/you/we/they bilan savol va inkorda", "Do you work?"],
      ["does", "he/she/it bilan savol va inkorda", "Does he work?"],
      ["V1", "fe’lning asosiy shakli", "I work."],
      ["-s / -es", "he/she/it bilan darak gapda", "She works. He goes."]
    ],
    "checks": [
      ["I ___ to school every day.", ["go", "goes", "am going", "went"], 0, "I bilan V1 ishlatiladi."],
      ["He ___ to school every day.", ["goes", "go", "going", "is go"], 0, "He bilan darak gapda -s/-es qo‘shiladi."],
      ["My mother ___ at the hospital.", ["works", "work", "is working", "worked"], 0, "My mother = she, works."],
      ["Tom ___ work at school.", ["doesn't", "don't", "isn't", "aren't"], 0, "Tom = he, does not + V1."],
      ["___ you speak English?", ["Do", "Does", "Are", "Is"], 0, "You bilan Do."],
      ["___ she speak English?", ["Does", "Do", "Is", "Are"], 0, "She bilan Does."],
      ["She ___ TV in the evening.", ["watches", "watch", "watchs", "watching"], 0, "watch → watches."],
      ["The shop ___ at nine.", ["opens", "open", "is opening", "opened"], 0, "Jadval/fakt — Present Simple."]
    ]
  }
});



// PREPOSITION OF PLACE and PREPOSITION OF TIME deep lesson update V75.
Object.assign(ESSENTIAL_STYLE_ENGLISH_PROFILES, {
  "PREPOSITION OF PLACE": {
    "concept": "Preposition of Place — joy predloglari",
    "core": "Preposition of place joy predloglari bo‘lib, odam yoki buyumning qayerda joylashganini bildiradi. Ular odatda otdan oldin keladi: in the bag, on the table, under the chair. O‘zbekchaga ko‘pincha ichida, ustida, ostida, yonida, orqasida, oldida, orasida deb tarjima qilinadi.",
    "structure": "in — ichida\non — ustida / yuzasida\nunder — ostida\nbehind — orqasida\nnext to — yonida\nbetween — ikki narsa orasida\nin front of — oldida\nGap tuzilishi: Subject + be + preposition of place + noun/place.",
    "usage": "Bu predloglar rasmda, xonada, sinfda, stol ustida, sumka ichida yoki ko‘chada narsalar qayerda turganini aytish uchun ishlatiladi. Avval narsa yoki odam aytiladi, keyin to be fe’li, keyin joy predlogi va joy keladi: The book is on the table.",
    "nuance": "In ichkarida bo‘lsa ishlatiladi: in the box. On biror yuzaning ustida bo‘lsa ishlatiladi: on the desk. Under pastida bo‘lsa ishlatiladi: under the bed. Behind orqasida, in front of oldida, next to yonida, between esa ikki narsa orasida degani.",
    "mistakes": "Eng ko‘p xatolar: in the table demang — agar narsa stol ustida bo‘lsa on the table. under the table — stol ostida. between Ali and Vali — Ali va Vali orasida. Predlogdan keyin ko‘pincha article keladi: in a bag, on the table, under the chair.",
    "examples": [
      "The rabbit is in the hat. / Quyon shlyapa ichida.",
      "The book is on the table. / Kitob stol ustida.",
      "The ball is under the chair. / To‘p stul ostida.",
      "The boy is behind the door. / Bola eshik orqasida.",
      "The girl is next to the window. / Qiz deraza yonida.",
      "The school is between the bank and the shop. / Maktab bank va do‘kon orasida.",
      "The car is in front of the house. / Mashina uy oldida.",
      "The picture is on the wall. / Rasm devorda.",
      "The keys are in my bag. / Kalitlar sumkam ichida.",
      "The cat is under the bed. / Mushuk karavot ostida."
    ],
    "terms": [
      [
        "in",
        "ichida",
        "The phone is in the bag."
      ],
      [
        "on",
        "ustida / yuzasida",
        "The book is on the table."
      ],
      [
        "under",
        "ostida",
        "The cat is under the chair."
      ],
      [
        "behind",
        "orqasida",
        "The boy is behind the door."
      ],
      [
        "next to",
        "yonida",
        "Ali is next to me."
      ],
      [
        "between",
        "orasida",
        "The bank is between the shop and the school."
      ],
      [
        "in front of",
        "oldida",
        "The car is in front of the house."
      ],
      [
        "wall",
        "devor",
        "The picture is on the wall."
      ],
      [
        "bag",
        "sumka",
        "The keys are in my bag."
      ],
      [
        "chair",
        "stul",
        "The ball is under the chair."
      ]
    ],
    "checks": [
      [
        "The rabbit is ___ the hat.",
        [
          "in",
          "on",
          "under",
          "behind"
        ],
        0,
        "Shlyapa ichida — in."
      ],
      [
        "The book is ___ the table.",
        [
          "on",
          "in",
          "under",
          "between"
        ],
        0,
        "Stol ustida — on."
      ],
      [
        "The ball is ___ the chair.",
        [
          "under",
          "on",
          "in",
          "next to"
        ],
        0,
        "Stul ostida — under."
      ],
      [
        "The boy is ___ the door.",
        [
          "behind",
          "on",
          "in",
          "between"
        ],
        0,
        "Eshik orqasida — behind."
      ],
      [
        "Ali is ___ me.",
        [
          "next to",
          "under",
          "in",
          "behind"
        ],
        0,
        "Yonimda — next to."
      ],
      [
        "The bank is ___ the shop and the school.",
        [
          "between",
          "behind",
          "under",
          "on"
        ],
        0,
        "Ikki joy orasida — between."
      ]
    ]
  },
  "PREPOSITION OF TIME": {
    "concept": "Preposition of Time — vaqt predloglari",
    "core": "Preposition of time vaqt predloglari bo‘lib, ish-harakat qachon bo‘lishini bildiradi. Ingliz tilida eng kerakli vaqt predloglari: at, on, in. Ular o‘zbekchadagi “-da” ma’nosiga yaqin, lekin ingliz tilida vaqt turiga qarab alohida tanlanadi.",
    "structure": "at + aniq vaqt: at 7 o’clock, at night\non + hafta kuni yoki sana: on Monday, on 15 May\nin + oy, yil, fasl yoki kun qismi: in June, in 2026, in summer, in the morning",
    "usage": "Aniq soat aytilsa at ishlatiladi: at 9 o’clock. Hafta kuni yoki to‘liq sana aytilsa on ishlatiladi: on Monday, on 15 May. Oy, yil, fasl yoki kun qismi aytilsa in ishlatiladi: in May, in 2026, in winter, in the morning.",
    "nuance": "At kichik va aniq vaqt nuqtasi uchun ishlatiladi. On bir kun yoki sana uchun ishlatiladi. In esa kattaroq vaqt oralig‘i uchun ishlatiladi: oy, yil, fasl, asr yoki kun qismi. Eslatma: in the morning, in the afternoon, in the evening, lekin at night deyiladi.",
    "mistakes": "Eng ko‘p xatolar: in Monday demang — on Monday. on May demang — in May. at 2026 demang — in 2026. on 9 o’clock demang — at 9 o’clock. in night demang — at night.",
    "examples": [
      "The lesson starts at 9 o’clock. / Dars soat 9 da boshlanadi.",
      "I get up at seven. / Men soat yettida turaman.",
      "We have English on Monday. / Bizda dushanba kuni ingliz tili bor.",
      "The test is on 15 May. / Test 15-may kuni.",
      "My birthday is in June. / Mening tug‘ilgan kunim iyun oyida.",
      "She was born in 2010. / U 2010-yilda tug‘ilgan.",
      "I study in the morning. / Men ertalab o‘qiyman.",
      "We sleep at night. / Biz tunda uxlaymiz.",
      "The exam is on Friday. / Imtihon juma kuni.",
      "We travel in summer. / Biz yozda sayohat qilamiz."
    ],
    "terms": [
      [
        "at",
        "aniq vaqt bilan",
        "at 9 o’clock"
      ],
      [
        "on",
        "hafta kuni yoki sana bilan",
        "on Monday, on 15 May"
      ],
      [
        "in",
        "oy/yil/fasl/kun qismi bilan",
        "in June, in 2026"
      ],
      [
        "morning",
        "ertalab",
        "in the morning"
      ],
      [
        "night",
        "tun",
        "at night"
      ],
      [
        "Monday",
        "dushanba",
        "on Monday"
      ],
      [
        "June",
        "iyun",
        "in June"
      ]
    ],
    "checks": [
      [
        "The lesson starts ___ 9 o’clock.",
        [
          "at",
          "on",
          "in"
        ],
        0,
        "Aniq soat — at."
      ],
      [
        "We have English ___ Monday.",
        [
          "on",
          "in",
          "at"
        ],
        0,
        "Hafta kuni — on."
      ],
      [
        "My birthday is ___ June.",
        [
          "in",
          "on",
          "at"
        ],
        0,
        "Oy — in."
      ],
      [
        "She was born ___ 2010.",
        [
          "in",
          "on",
          "at"
        ],
        0,
        "Yil — in."
      ],
      [
        "The test is ___ 15 May.",
        [
          "on",
          "in",
          "at"
        ],
        0,
        "Sana — on."
      ],
      [
        "We sleep ___ night.",
        [
          "at",
          "on",
          "in"
        ],
        0,
        "At night deyiladi."
      ]
    ]
  }
});


// ULUGBEK_UPGRADED_BEGINNER_EXPLANATIONS_V1
Object.assign(ESSENTIAL_STYLE_ENGLISH_PROFILES, {
  "PLURALS (REGULAR)": {
    "concept": "Regular Plurals — qoidali ko‘plik",
    "core": "Regular plurals — bu bitta narsani ikki yoki undan ko‘p narsaga aylantirish usuli. O‘zbekchada ko‘pincha -lar qo‘shamiz. Ingliz tilida ham sanaladigan ot ko‘plik shaklida yoziladi: two books, three boxes, many students. Eng muhim fikr: son 2 yoki undan katta bo‘lsa, ot ham ko‘plik shaklida bo‘lishi shart.",
    "structure": "1) Ko‘p oddiy otlar -s bilan tugaydi: books, pens, cars.\n2) s, ss, sh, ch, x, o bilan tugagan otlar ko‘pincha -es bilan tugaydi: buses, classes, dishes, watches, boxes, tomatoes.\n3) Undosh + y bilan tugagan otlarda ko‘plik shakli -ies bilan tugaydi: babies, cities.\n4) Unli + y bo‘lsa, y qoladi va -s keladi: boys, toys, keys.\n5) Oxiri f/fe bo‘lgan ayrim so‘zlarda ko‘plik shakli -ves bilan tugaydi: leaves, knives.",
    "usage": "Bu mavzu narsalarni sanaganda, rasmni tasvirlaganda, sinfdagi buyumlar, odamlar, hayvonlar yoki ro‘yxat haqida gapirganda ishlatiladi. Masalan: three pens, many students, two boxes. Ko‘plik otlar bilan ko‘pincha are, these, those, many, some keladi: The books are on the table.",
    "nuance": "Regular pluralning asosiy siri — oxirgi tovushga qarash. Oddiy tovush bo‘lsa -s; talaffuz qilish qiyin bo‘lgan s/ss/sh/ch/x/o oxirlari bo‘lsa -es; consonant + y bo‘lsa y tushib -ies bo‘ladi. A/an faqat bitta narsa uchun: a book. Ko‘plikda a/an yo‘q: books yoki two books.",
    "mistakes": "Ko‘p uchraydigan xatolar: two book, three boxs, two babys, a books, many student. Tekshirish usuli: oldida two, three, many, some, these, those bo‘lsa, ot ko‘plik shaklida turishi kerak.",
    "examples": [
      "one book — two books / bitta kitob — ikkita kitob",
      "one pen — five pens / bitta ruchka — beshta ruchka",
      "one bus — two buses / bitta avtobus — ikkita avtobus",
      "one box — three boxes / bitta quti — uchta quti",
      "one watch — two watches / bitta qo‘l soati — ikkita qo‘l soati",
      "one class — four classes / bitta sinf — to‘rtta sinf",
      "one baby — two babies / bitta chaqaloq — ikkita chaqaloq",
      "one city — three cities / bitta shahar — uchta shahar",
      "one boy — two boys / bitta bola — ikkita bola",
      "one key — many keys / bitta kalit — ko‘p kalitlar",
      "The students are in the classroom. / O‘quvchilar sinfxonada.",
      "There are three apples on the table. / Stol ustida uchta olma bor."
    ],
    "terms": [
      [
        "singular",
        "birlik — bitta narsa",
        "one book"
      ],
      [
        "plural",
        "ko‘plik — ikki yoki undan ko‘p",
        "two books"
      ],
      [
        "-s",
        "eng oddiy ko‘plik qo‘shimchasi",
        "pens, cars, books"
      ],
      [
        "-es",
        "s/ss/sh/ch/x/o dan keyin",
        "buses, boxes, watches"
      ],
      [
        "-ies",
        "undosh + y dan keyin",
        "babies"
      ],
      [
        "many",
        "ko‘p",
        "many students"
      ],
      [
        "these/those",
        "ko‘plik ko‘rsatkichlari",
        "these books"
      ],
      [
        "are",
        "ko‘plik bilan ishlatiladigan to be",
        "The books are new."
      ]
    ],
    "checks": [
      [
        "one book — two ___",
        [
          "books",
          "book",
          "bookes",
          "bookies"
        ],
        0,
        "Book oddiy ot, -s qo‘shiladi."
      ],
      [
        "one box — three ___",
        [
          "boxes",
          "boxs",
          "boxies",
          "box"
        ],
        0,
        "Box x bilan tugaydi, -es qo‘shiladi."
      ],
      [
        "one baby — two ___",
        [
          "babies",
          "babys",
          "babyes",
          "baby"
        ],
        0,
        "Consonant + y: y → ies."
      ],
      [
        "one boy — two ___",
        [
          "boys",
          "boies",
          "boyes",
          "boy"
        ],
        0,
        "Vowel + y bo‘lsa faqat -s qo‘shiladi."
      ],
      [
        "Qaysi gap to‘g‘ri?",
        [
          "I have two book.",
          "I have two books.",
          "I have a books.",
          "I have two bookes."
        ],
        1,
        "Two bo‘lsa ot ko‘plik bo‘ladi: books."
      ],
      [
        "The ___ are new.",
        [
          "cars",
          "car",
          "a car",
          "cares"
        ],
        0,
        "Are ko‘plik bilan keladi."
      ],
      [
        "Many ___ are in the classroom.",
        [
          "students",
          "student",
          "a student",
          "studentes"
        ],
        0,
        "Many dan keyin plural noun keladi."
      ]
    ]
  },
  "PLURAL (IRREGULAR)": {
    "concept": "Irregular Plurals — notekis ko‘plik",
    "core": "Irregular plurals — bu oddiy -s/-es qoidasiga bo‘ysunmaydigan ko‘pliklar. Ularni “maxsus kiyim kiygan so‘zlar” deb tasavvur qiling: child ko‘plikda childs bo‘lmaydi, children bo‘ladi; man → men; person → people. Ya’ni bu so‘zlarni qoida bilan emas, ko‘p misol va takror bilan eslab qolamiz.",
    "structure": "Eng kerakli shakllar:\nchild → children\nman → men\nwoman → women\nperson → people\ntooth → teeth\nfoot → feet\nmouse → mice\ngoose → geese\nsheep → sheep\nfish → fish",
    "usage": "Irregular plural odamlar, oila, tana a’zolari, hayvonlar va kundalik vaziyatlarda juda ko‘p uchraydi: children in the class, two men, many people, my feet. Gapda bu so‘zlar allaqachon ko‘plik ma’nosini bergani uchun ularga yana -s qo‘shilmaydi.",
    "nuance": "Irregular so‘zning o‘zi ko‘plik vazifasini bajaradi. Children = bolalar, childrens emas. People = odamlar, peoples emas oddiy ma’noda. Sheep va fish kabi ayrim so‘zlar birlikda ham, ko‘plikda ham bir xil ko‘rinadi: one sheep, two sheep.",
    "mistakes": "Eng ko‘p xatolar: childs, childrens, mans, womans, foots, tooths, mouses. To‘g‘ri shakllar: children, men, women, feet, teeth, mice. Eslab qolish usuli: har birini juft qilib ayting — one child, two children; one foot, two feet.",
    "examples": [
      "one child — two children / bitta bola — ikkita bola",
      "one man — three men / bitta erkak — uchta erkak",
      "one woman — two women / bitta ayol — ikkita ayol",
      "one person — many people / bitta odam — ko‘p odamlar",
      "one tooth — two teeth / bitta tish — ikkita tish",
      "one foot — two feet / bitta oyoq panjasi — ikkita oyoq panjasi",
      "one mouse — two mice / bitta sichqon — ikkita sichqon",
      "one sheep — ten sheep / bitta qo‘y — o‘nta qo‘y",
      "The children are playing. / Bolalar o‘ynayapti.",
      "Many people are here. / Bu yerda ko‘p odamlar bor.",
      "My feet are cold. / Oyoqlarim sovuq.",
      "The women are teachers. / Ayollar ustozlar."
    ],
    "terms": [
      [
        "irregular plural",
        "qoidaga bo‘ysunmaydigan ko‘plik",
        "children"
      ],
      [
        "children",
        "bolalar",
        "The children are happy."
      ],
      [
        "men",
        "erkaklar",
        "Two men are in the room."
      ],
      [
        "women",
        "ayollar",
        "The women are teachers."
      ],
      [
        "people",
        "odamlar",
        "Many people are here."
      ],
      [
        "feet",
        "oyoqlar/oyoq panjalari",
        "My feet are cold."
      ],
      [
        "teeth",
        "tishlar",
        "Brush your teeth."
      ],
      [
        "same form",
        "birlik va ko‘plik bir xil",
        "one sheep — two sheep"
      ]
    ],
    "checks": [
      [
        "one child — two ___",
        [
          "children",
          "childs",
          "childrens",
          "childes"
        ],
        0,
        "Child → children."
      ],
      [
        "one man — three ___",
        [
          "men",
          "mans",
          "man",
          "menes"
        ],
        0,
        "Man → men."
      ],
      [
        "one woman — two ___",
        [
          "women",
          "womans",
          "woman",
          "womens"
        ],
        0,
        "Woman → women."
      ],
      [
        "one person — many ___",
        [
          "people",
          "persons",
          "persones",
          "peoples"
        ],
        0,
        "Oddiy ma’noda person → people."
      ],
      [
        "one foot — two ___",
        [
          "feet",
          "foots",
          "feets",
          "foot"
        ],
        0,
        "Foot → feet."
      ],
      [
        "Qaysi gap to‘g‘ri?",
        [
          "Two childs are here.",
          "Two children are here.",
          "Two childrens are here.",
          "Two child are here."
        ],
        1,
        "Child ning ko‘pligi children."
      ],
      [
        "There are many ___ in the park.",
        [
          "people",
          "person",
          "peoples",
          "person"
        ],
        0,
        "Many people — ko‘p odamlar."
      ]
    ]
  },
  "TO BE": {
    "concept": "To be — am / is / are",
    "core": "To be ingliz tilining eng asosiy “bog‘lovchi” fe’lidir. O‘zbekchada ko‘pincha alohida so‘z sifatida ko‘rinmaydi, lekin ingliz tilida gapni to‘liq qilish uchun kerak bo‘ladi: Men o‘quvchiman — I am a student. U xursand — She is happy. Ular tayyor — They are ready. To be gapda kim ekanini yoki qanday holatda ekanini ko‘rsatadi.",
    "structure": "Positive:\nI am ...\nHe / She / It is ...\nYou / We / They are ...\n\nNegative:\nI am not ...\nHe / She / It is not ...\nYou / We / They are not ...\n\nQuestion:\nAm I ...?\nIs he / she / it ...?\nAre you / we / they ...?",
    "usage": "To be kasb, yosh, ism, millat, holat va sifatni aytishda ishlatiladi: I am a student, She is thirteen, We are happy, They are ready. Oddiy aytganda, fe’l ko‘rinmaydigan o‘zbekcha gaplarning inglizcha tarjimasida ko‘pincha am/is/are kerak bo‘ladi.",
    "nuance": "Am faqat I bilan ishlatiladi. Is — he/she/it yoki bitta ism/narsa bilan. Are — you/we/they va ko‘plik otlar bilan. Savolda am/is/are gap boshiga chiqadi: Are you ready? Inkor gapda to be dan keyin not keladi: She is not busy. Qisqa shakllar: I’m, he’s, she’s, we’re, they’re, isn’t, aren’t.",
    "mistakes": "Eng ko‘p xatolar: I student → I am a student; He are → He is; They is → They are; You ready? → Are you ready? Ingliz tilida bu turdagi gaplarda am/is/are ni tashlab ketmang. Tekshirish formulasi: gapda harakat fe’li yo‘q bo‘lsa, ehtimol to be kerak.",
    "examples": [
      "I am a student. / Men o‘quvchiman.",
      "You are my friend. / Siz mening do‘stimsiz.",
      "He is a doctor. / U shifokor.",
      "She is thirteen. / U o‘n uch yoshda.",
      "It is cold today. / Bugun sovuq.",
      "We are happy. / Biz xursandmiz.",
      "They are ready. / Ular tayyor.",
      "I am not tired. / Men charchagan emasman.",
      "She is not busy. / U band emas.",
      "They are not late. / Ular kechikkan emas.",
      "Are you ready? / Siz tayyormisiz?",
      "Is he your teacher? / U sizning ustozingizmi?",
      "Yes, I am. / Ha.",
      "No, she isn’t. / Yo‘q."
    ],
    "terms": [
      [
        "am",
        "faqat I bilan",
        "I am ready."
      ],
      [
        "is",
        "he/she/it yoki birlik ot bilan",
        "She is happy."
      ],
      [
        "are",
        "you/we/they yoki ko‘plik ot bilan",
        "They are students."
      ],
      [
        "not",
        "emas — inkor yasaydi",
        "He is not here."
      ],
      [
        "subject",
        "ega — gap kim/nima haqida",
        "I, you, Ali, the book"
      ],
      [
        "adjective",
        "sifat — qanday?",
        "happy, tired, cold"
      ],
      [
        "noun",
        "ot — kim/nima?",
        "student, teacher, book"
      ],
      [
        "question order",
        "savolda to be boshiga chiqadi",
        "Are you ready?"
      ],
      [
        "short answer",
        "qisqa javob",
        "Yes, I am. / No, I’m not."
      ]
    ],
    "checks": [
      [
        "I ___ a student.",
        [
          "am",
          "is",
          "are",
          "be"
        ],
        0,
        "I bilan am ishlatiladi."
      ],
      [
        "She ___ my sister.",
        [
          "is",
          "am",
          "are",
          "be"
        ],
        0,
        "She bilan is ishlatiladi."
      ],
      [
        "They ___ at school.",
        [
          "are",
          "is",
          "am",
          "be"
        ],
        0,
        "They ko‘plik, are ishlatiladi."
      ],
      [
        "___ you ready?",
        [
          "Are",
          "Is",
          "Am",
          "Be"
        ],
        0,
        "Savolda are boshiga chiqadi."
      ],
      [
        "He ___ not busy.",
        [
          "is",
          "are",
          "am",
          "be"
        ],
        0,
        "He bilan is not."
      ],
      [
        "Qaysi gap to‘g‘ri?",
        [
          "I student.",
          "I am a student.",
          "I is student.",
          "I are student."
        ],
        1,
        "Ingliz tilida am kerak."
      ],
      [
        "The books ___ on the table.",
        [
          "are",
          "is",
          "am",
          "be"
        ],
        0,
        "Books ko‘plik, are ishlatiladi."
      ]
    ]
  },
  "THERE IS / THERE ARE": {
    "concept": "There is / There are — bor / mavjud",
    "core": "There is / There are biror joyda narsa yoki odam borligini aytish uchun ishlatiladi. O‘zbekchada buni ko‘pincha “bor” deb tarjima qilamiz: There is a book — kitob bor. There are books — kitoblar bor. Bu mavzu xona, rasm, maktab, ko‘cha, shahar yoki sumka ichidagi narsalarni tasvirlashda juda kerak bo‘ladi.",
    "structure": "Positive:\nThere is + singular noun / uncountable noun\nThere are + plural noun\n\nNegative:\nThere is not / There isn’t + singular noun\nThere are not / There aren’t + plural noun\n\nQuestion:\nIs there + singular noun?\nAre there + plural noun?",
    "usage": "Joyni tasvirlaganda ishlatiladi: xonada nima bor, stol ustida nima bor, rasmda nechta odam bor, shaharda qanday joylar bor. Masalan: There is a TV in the room. There are three students in the classroom. Savol shakli bilan biror narsa bor-yo‘qligini so‘raymiz: Is there a bank near here?",
    "nuance": "Asosiy farq otning sonida: bitta narsa yoki sanalmaydigan narsa bo‘lsa there is; ikki yoki undan ko‘p narsa bo‘lsa there are. Milk, water kabi sanalmaydigan otlar bilan there is ishlatiladi: There is some water. Savol va inkorda any ko‘p ishlatiladi: Is there any milk? There aren’t any chairs.",
    "mistakes": "Eng ko‘p xatolar: There is two books → There are two books; There are a chair → There is a chair; Is there many students? → Are there many students? Tekshirish formulasi: there dan keyingi otga qarang — birlik bo‘lsa is, ko‘plik bo‘lsa are.",
    "examples": [
      "There is a book on the table. / Stol ustida bitta kitob bor.",
      "There are three books on the table. / Stol ustida uchta kitob bor.",
      "There is a teacher in the room. / Xonada bitta ustoz bor.",
      "There are students in the classroom. / Sinfxonada o‘quvchilar bor.",
      "There is some water in the glass. / Stakanda biroz suv bor.",
      "There isn't a computer in the room. / Xonada kompyuter yo‘q.",
      "There aren't any chairs here. / Bu yerda stullar yo‘q.",
      "Is there a bank near here? / Bu yer yaqinida bank bormi?",
      "Are there any students in the classroom? / Sinfxonada o‘quvchilar bormi?",
      "There are no problems. / Muammo yo‘q."
    ],
    "terms": [
      [
        "there is",
        "bitta narsa bor",
        "There is a chair."
      ],
      [
        "there are",
        "ko‘p narsalar bor",
        "There are chairs."
      ],
      [
        "singular",
        "birlik",
        "a book"
      ],
      [
        "plural",
        "ko‘plik",
        "books"
      ],
      [
        "uncountable",
        "sanalmaydigan",
        "water, milk"
      ],
      [
        "any",
        "savol/inkorda biror/hech qanday",
        "Is there any water?"
      ],
      [
        "no",
        "yo‘q ma’nosi",
        "There are no problems."
      ],
      [
        "place",
        "joy",
        "in the room, on the table"
      ]
    ],
    "checks": [
      [
        "There ___ a book on the table.",
        [
          "is",
          "are",
          "am",
          "be"
        ],
        0,
        "A book birlik, there is."
      ],
      [
        "There ___ two chairs.",
        [
          "are",
          "is",
          "am",
          "be"
        ],
        0,
        "Two chairs ko‘plik, there are."
      ],
      [
        "___ there a bank near here?",
        [
          "Is",
          "Are",
          "Do",
          "Does"
        ],
        0,
        "A bank birlik, Is there...?"
      ],
      [
        "___ there many students?",
        [
          "Are",
          "Is",
          "Do",
          "Does"
        ],
        0,
        "Many students ko‘plik, Are there...?"
      ],
      [
        "There ___ some water in the glass.",
        [
          "is",
          "are",
          "am",
          "be"
        ],
        0,
        "Water sanalmaydi, there is."
      ],
      [
        "Qaysi gap to‘g‘ri?",
        [
          "There is three students.",
          "There are a teacher.",
          "There are many students.",
          "There be students."
        ],
        2,
        "Many students ko‘plik, there are."
      ],
      [
        "There aren’t ___ chairs here.",
        [
          "any",
          "a",
          "an",
          "is"
        ],
        0,
        "Inkor ko‘plikda any ishlatiladi."
      ]
    ]
  }
});

function getEssentialStyleEnglishProfile(title = '') {
  const key = normalizeTopicName(title);
  const data = ESSENTIAL_STYLE_ENGLISH_PROFILES[key];
  if (!data) return null;
  return makeProfile({
    concept: data.concept,
    core: data.core,
    structure: data.structure || data.form,
    usage: data.usage || data.use,
    nuance: data.nuance || data.note,
    mistakes: data.mistakes,
    examples: data.examples || [],
    terms: data.terms || [],
    checks: data.checks || []
  });
}

const VOCABULARY_ITEM_COUNT = 30;
const ENGLISH_VOCABULARY_EXCLUDE = new Set(['am', 'is', 'are']);


const ENGLISH_TOPIC_VOCABULARY_BANK = {
  "ALFABIT": [
    [
      "alphabet",
      "alifbo",
      "The English alphabet has 26 letters."
    ],
    [
      "letter",
      "harf",
      "Write the letter clearly."
    ],
    [
      "sound",
      "tovush",
      "Listen to the sound and repeat it."
    ],
    [
      "capital letter",
      "bosh harf",
      "Names start with a capital letter."
    ],
    [
      "small letter",
      "kichik harf",
      "Write small letters on the line."
    ],
    [
      "vowel",
      "unli harf",
      "A, E, I, O and U are vowels."
    ],
    [
      "consonant",
      "undosh harf",
      "B and C are consonants."
    ],
    [
      "spell",
      "harflab aytmoq",
      "Can you spell your name?"
    ],
    [
      "name",
      "ism",
      "My name is Ali."
    ],
    [
      "word",
      "so‘z",
      "Read the word aloud."
    ],
    [
      "pronounce",
      "talaffuz qilmoq",
      "Pronounce the word slowly."
    ],
    [
      "repeat",
      "takrorlamoq",
      "Repeat after the teacher."
    ],
    [
      "listen",
      "tinglamoq",
      "Listen to the letter sound."
    ],
    [
      "say",
      "aytmoq",
      "Say the word again."
    ],
    [
      "write",
      "yozmoq",
      "Write the letters in your notebook."
    ],
    [
      "read",
      "o‘qimoq",
      "Read the alphabet."
    ],
    [
      "line",
      "chiziq / qator",
      "Write on the line."
    ],
    [
      "page",
      "sahifa",
      "Open page one."
    ],
    [
      "book",
      "kitob",
      "This is my English book."
    ],
    [
      "pen",
      "ruchka",
      "I write with a pen."
    ],
    [
      "notebook",
      "daftar",
      "Open your notebook."
    ],
    [
      "board",
      "doska",
      "Look at the board."
    ],
    [
      "teacher",
      "ustoz",
      "The teacher says the sound."
    ],
    [
      "student",
      "o‘quvchi",
      "The student writes the word."
    ],
    [
      "English",
      "ingliz tili",
      "English uses Latin letters."
    ],
    [
      "first letter",
      "birinchi harf",
      "What is the first letter?"
    ],
    [
      "last letter",
      "oxirgi harf",
      "What is the last letter?"
    ],
    [
      "uppercase",
      "bosh harf shakli",
      "Use uppercase for A."
    ],
    [
      "lowercase",
      "kichik harf shakli",
      "Use lowercase for a."
    ],
    [
      "ABC",
      "alifbo ketma-ketligi",
      "Say A, B, C."
    ]
  ],
  "A / AN": [
    ["a", "undosh tovushdan oldin artikl", "This is a book."],
    ["an", "unli tovushdan oldin artikl", "This is an apple."],
    ["article", "artikl", "A and an are articles."],
    ["singular", "birlik", "Use a/an with singular nouns."],
    ["countable", "sanasa bo‘ladigan", "A pen is countable."],
    ["vowel sound", "unli tovush", "An apple starts with a vowel sound."],
    ["consonant sound", "undosh tovush", "A dog starts with a consonant sound."],
    ["apple", "olma", "I have an apple."],
    ["egg", "tuxum", "It is an egg."],
    ["orange", "apelsin", "He eats an orange."],
    ["umbrella", "soyabon", "She has an umbrella."],
    ["elephant", "fil", "It is an elephant."],
    ["ant", "chumoli", "This is an ant."],
    ["owl", "ukki", "It is an owl."],
    ["ostrich", "tuyaqush", "This is an ostrich."],
    ["book", "kitob", "I have a book."],
    ["pen", "ruchka", "This is a pen."],
    ["dog", "it", "It is a dog."],
    ["cat", "mushuk", "It is a cat."],
    ["zebra", "zebra", "This is a zebra."],
    ["snake", "ilon", "It is a snake."],
    ["frog", "qurbaqa", "This is a frog."],
    ["cow", "sigir", "It is a cow."],
    ["bird", "qush", "This is a bird."],
    ["teacher", "ustoz", "She is a teacher."],
    ["engineer", "muhandis", "He is an engineer."],
    ["university", "universitet", "It is a university."],
    ["hour", "soat", "We waited for an hour."],
    ["water", "suv", "I need water."],
    ["students", "o‘quvchilar", "They are students."]
  ],
  "PLURALS_REGULAR": [
    [
      "books",
      "kitob → kitoblar",
      "I have two books."
    ],
    [
      "car → cars",
      "mashina → mashinalar",
      "Five cars are outside."
    ],
    [
      "pen → pens",
      "ruchka → ruchkalar",
      "There are three pens."
    ],
    [
      "cat → cats",
      "mushuk → mushuklar",
      "Two cats are sleeping."
    ],
    [
      "dog → dogs",
      "it → itlar",
      "The dogs are in the garden."
    ],
    [
      "chair → chairs",
      "stul → stullar",
      "Four chairs are in the room."
    ],
    [
      "table → tables",
      "stol → stollar",
      "The tables are clean."
    ],
    [
      "apple → apples",
      "olma → olmalar",
      "These apples are red."
    ],
    [
      "student → students",
      "o‘quvchi → o‘quvchilar",
      "The students are ready."
    ],
    [
      "teacher → teachers",
      "ustoz → ustozlar",
      "The teachers are in class."
    ],
    [
      "box → boxes",
      "quti → qutilar",
      "The boxes are heavy."
    ],
    [
      "bus → buses",
      "avtobus → avtobuslar",
      "Two buses are late."
    ],
    [
      "watch → watches",
      "soat → soatlar",
      "These watches are expensive."
    ],
    [
      "dish → dishes",
      "idish → idishlar",
      "The dishes are clean."
    ],
    [
      "glass → glasses",
      "stakan → stakanlar",
      "The glasses are on the table."
    ],
    [
      "class → classes",
      "sinf → sinflar",
      "We have two classes today."
    ],
    [
      "brush → brushes",
      "cho‘tka → cho‘tkalar",
      "The brushes are new."
    ],
    [
      "wish → wishes",
      "tilak → tilaklar",
      "Best wishes to you."
    ],
    [
      "tomato → tomatoes",
      "pomidor → pomidorlar",
      "Tomatoes are fresh."
    ],
    [
      "potato → potatoes",
      "kartoshka → kartoshkalar",
      "Potatoes are in the bag."
    ],
    [
      "city → cities",
      "shahar → shaharlar",
      "Big cities are busy."
    ],
    [
      "babies",
      "chaqaloq → chaqaloqlar",
      "The babies are sleeping."
    ],
    [
      "family → families",
      "oila → oilalar",
      "Many families live here."
    ],
    [
      "boys",
      "bola → bolalar",
      "The boys are playing."
    ],
    [
      "toy → toys",
      "o‘yinchoq → o‘yinchoqlar",
      "The toys are on the floor."
    ],
    [
      "key → keys",
      "kalit → kalitlar",
      "My keys are in my bag."
    ],
    [
      "photo → photos",
      "rasm → rasmlar",
      "These photos are nice."
    ],
    [
      "room → rooms",
      "xona → xonalar",
      "The rooms are big."
    ],
    [
      "lesson → lessons",
      "dars → darslar",
      "English lessons are useful."
    ],
    [
      "page → pages",
      "sahifa → sahifalar",
      "Read two pages."
    ]
  ],
  "PLURAL_IRREGULAR": [
    [
      "children",
      "bola → bolalar",
      "The children are in the park."
    ],
    [
      "men",
      "erkak → erkaklar",
      "Two men are outside."
    ],
    [
      "women",
      "ayol → ayollar",
      "The women are teachers."
    ],
    [
      "people",
      "odam → odamlar",
      "Many people are here."
    ],
    [
      "teeth",
      "tish → tishlar",
      "My teeth are clean."
    ],
    [
      "feet",
      "oyoq → oyoqlar",
      "His feet are cold."
    ],
    [
      "mice",
      "sichqon → sichqonlar",
      "Mice are small animals."
    ],
    [
      "geese",
      "g‘oz → g‘ozlar",
      "The geese are near the lake."
    ],
    [
      "sheep → sheep",
      "qo‘y → qo‘ylar",
      "There are ten sheep."
    ],
    [
      "fish → fish",
      "baliq → baliqlar",
      "We saw many fish."
    ],
    [
      "deer → deer",
      "kiyik → kiyiklar",
      "Deer live in the forest."
    ],
    [
      "ox → oxen",
      "ho‘kiz → ho‘kizlar",
      "Oxen work on the farm."
    ],
    [
      "leaf → leaves",
      "barg → barglar",
      "Leaves fall in autumn."
    ],
    [
      "knife → knives",
      "pichoq → pichoqlar",
      "The knives are sharp."
    ],
    [
      "wife → wives",
      "xotin → xotinlar",
      "Their wives are friends."
    ],
    [
      "life → lives",
      "hayot → hayotlar",
      "Many lives changed."
    ],
    [
      "wolf → wolves",
      "bo‘ri → bo‘rilar",
      "Wolves live in groups."
    ],
    [
      "half → halves",
      "yarim → yarimlar",
      "Cut it into two halves."
    ],
    [
      "shelf → shelves",
      "javon → javonlar",
      "The shelves are full."
    ],
    [
      "scarf → scarves",
      "sharf → sharflar",
      "The scarves are warm."
    ],
    [
      "loaf → loaves",
      "non bo‘lagi → bo‘laklar",
      "Two loaves are on the table."
    ],
    [
      "die → dice",
      "zar → zarlar",
      "Roll the dice."
    ],
    [
      "cactus → cacti",
      "kaktus → kaktuslar",
      "Cacti grow in dry places."
    ],
    [
      "analysis → analyses",
      "tahlil → tahlillar",
      "The analyses are clear."
    ],
    [
      "crisis → crises",
      "inqiroz → inqirozlar",
      "Crises need quick decisions."
    ],
    [
      "datum → data",
      "ma’lumot → ma’lumotlar",
      "The data are important."
    ],
    [
      "medium → media",
      "vosita → vositalar",
      "The media are online."
    ],
    [
      "bacterium → bacteria",
      "bakteriya → bakteriyalar",
      "Bacteria are tiny."
    ],
    [
      "criterion → criteria",
      "mezon → mezonlar",
      "The criteria are simple."
    ],
    [
      "index → indices",
      "indeks → indekslar",
      "The indices changed."
    ]
  ],
  "TO BE": [
    [
      "I am",
      "men ...man",
      "I am a student."
    ],
    [
      "you are",
      "siz ...siz",
      "You are ready."
    ],
    [
      "he is",
      "u ...dir / erkak",
      "He is my brother."
    ],
    [
      "she is",
      "u ...dir / ayol",
      "She is my teacher."
    ],
    [
      "it is",
      "u ...dir / narsa",
      "It is a book."
    ],
    [
      "we are",
      "biz ...miz",
      "We are happy."
    ],
    [
      "they are",
      "ular ...dir",
      "They are friends."
    ],
    [
      "student",
      "o‘quvchi",
      "I am a student."
    ],
    [
      "teacher",
      "ustoz",
      "She is a teacher."
    ],
    [
      "friend",
      "do‘st",
      "They are my friends."
    ],
    [
      "happy",
      "xursand",
      "We are happy today."
    ],
    [
      "sad",
      "xafa",
      "He is sad."
    ],
    [
      "tired",
      "charchagan",
      "I am tired."
    ],
    [
      "ready",
      "tayyor",
      "Are you ready?"
    ],
    [
      "busy",
      "band",
      "She is busy."
    ],
    [
      "late",
      "kech qolgan",
      "You are late."
    ],
    [
      "early",
      "erta",
      "We are early."
    ],
    [
      "at home",
      "uyda",
      "He is at home."
    ],
    [
      "at school",
      "maktabda",
      "They are at school."
    ],
    [
      "in class",
      "darsda",
      "We are in class."
    ],
    [
      "from Tashkent",
      "Toshkentdan",
      "I am from Tashkent."
    ],
    [
      "not",
      "emas",
      "I am not tired."
    ],
    [
      "isn’t",
      "emas / is not",
      "He isn’t here."
    ],
    [
      "aren’t",
      "emas / are not",
      "They aren’t ready."
    ],
    [
      "am I?",
      "men ...manmi?",
      "Am I late?"
    ],
    [
      "are you?",
      "siz ...misiz?",
      "Are you a student?"
    ],
    [
      "is he?",
      "u ...mi?",
      "Is he your friend?"
    ],
    [
      "short answer",
      "qisqa javob",
      "Yes, I am."
    ],
    [
      "job",
      "ish / kasb",
      "He is a doctor."
    ],
    [
      "age",
      "yosh",
      "She is ten years old."
    ]
  ],
  "SUBJECT_PRONOUN": [
    [
      "I",
      "men",
      "I am a student."
    ],
    [
      "you",
      "sen / siz",
      "You are my friend."
    ],
    [
      "he",
      "u / erkak",
      "He is my brother."
    ],
    [
      "she",
      "u / ayol",
      "She is my sister."
    ],
    [
      "it",
      "u / narsa yoki hayvon",
      "It is a cat."
    ],
    [
      "we",
      "biz",
      "We are students."
    ],
    [
      "they",
      "ular",
      "They are teachers."
    ],
    [
      "my brother",
      "mening akam / ukam",
      "My brother is kind."
    ],
    [
      "my sister",
      "mening opam / singlim",
      "My sister is clever."
    ],
    [
      "Ali",
      "Ali",
      "Ali is my friend. He is funny."
    ],
    [
      "Madina",
      "Madina",
      "Madina is a student. She is smart."
    ],
    [
      "the book",
      "kitob",
      "The book is new. It is red."
    ],
    [
      "the cat",
      "mushuk",
      "The cat is small. It is white."
    ],
    [
      "my friends",
      "do‘stlarim",
      "My friends are here. They are happy."
    ],
    [
      "my mother",
      "onam",
      "My mother is a nurse. She is kind."
    ],
    [
      "my father",
      "otam",
      "My father is a driver. He is busy."
    ],
    [
      "people",
      "odamlar",
      "People are waiting. They are tired."
    ],
    [
      "children",
      "bolalar",
      "Children are playing. They are noisy."
    ],
    [
      "subject",
      "ega",
      "The subject comes before the verb."
    ],
    [
      "pronoun",
      "olmosh",
      "A pronoun replaces a noun."
    ],
    [
      "replace",
      "almashtirmoq",
      "Use he instead of Ali."
    ],
    [
      "male",
      "erkak",
      "Use he for a male person."
    ],
    [
      "female",
      "ayol",
      "Use she for a female person."
    ],
    [
      "thing",
      "narsa",
      "Use it for one thing."
    ],
    [
      "animal",
      "hayvon",
      "Use it for one animal."
    ],
    [
      "singular",
      "birlik",
      "He, she, it are singular."
    ],
    [
      "plural",
      "ko‘plik",
      "We and they are plural."
    ],
    [
      "speaker",
      "gapiruvchi",
      "I means the speaker."
    ],
    [
      "listener",
      "tinglovchi",
      "You means the listener."
    ],
    [
      "group",
      "guruh",
      "We means I and other people."
    ]
  ],
  "THERE_IS_THERE_ARE": [
    [
      "there is",
      "bor / birlik",
      "There is a book on the table."
    ],
    [
      "there are",
      "bor / ko‘plik",
      "There are two chairs in the room."
    ],
    [
      "room",
      "xona",
      "There is a desk in the room."
    ],
    [
      "desk",
      "parta / ish stoli",
      "There is a notebook on the desk."
    ],
    [
      "chair",
      "stul",
      "There are chairs near the table."
    ],
    [
      "table",
      "stol",
      "There is a cup on the table."
    ],
    [
      "computer",
      "kompyuter",
      "There is a computer in the office."
    ],
    [
      "window",
      "deraza",
      "There are two windows."
    ],
    [
      "door",
      "eshik",
      "There is a door near the board."
    ],
    [
      "board",
      "doska",
      "There is a board on the wall."
    ],
    [
      "wall",
      "devor",
      "There are pictures on the wall."
    ],
    [
      "floor",
      "pol",
      "There is a bag on the floor."
    ],
    [
      "bag",
      "sumka",
      "There is a phone in the bag."
    ],
    [
      "park",
      "bog‘",
      "There is a park near my house."
    ],
    [
      "street",
      "ko‘cha",
      "There are many shops on this street."
    ],
    [
      "bank",
      "bank",
      "Is there a bank near here?"
    ],
    [
      "bus stop",
      "avtobus bekati",
      "There is a bus stop in front of the hotel."
    ],
    [
      "hotel",
      "mehmonxona",
      "There are two hotels in this area."
    ],
    [
      "shop",
      "do‘kon",
      "There is a small shop here."
    ],
    [
      "school",
      "maktab",
      "There is a school near the park."
    ],
    [
      "classroom",
      "sinfxona",
      "There are students in the classroom."
    ],
    [
      "student",
      "o‘quvchi",
      "There are fifteen students."
    ],
    [
      "teacher",
      "ustoz",
      "There is a teacher in the room."
    ],
    [
      "some",
      "bir nechta / biroz",
      "There are some apples."
    ],
    [
      "any",
      "biror / hech qanday",
      "Are there any chairs?"
    ],
    [
      "no",
      "yo‘q",
      "There are no problems."
    ],
    [
      "near",
      "yaqinida",
      "There is a bank near here."
    ],
    [
      "in front of",
      "oldida",
      "There is a bus stop in front of the school."
    ],
    [
      "behind",
      "orqasida",
      "There is a garden behind the house."
    ],
    [
      "next to",
      "yonida",
      "There is a shop next to the bank."
    ]
  ],
  "HAVE_HAS": [
    [
      "have",
      "bor / ega bo‘lmoq",
      "I have a book."
    ],
    [
      "has",
      "bor / he/she/it bilan",
      "She has a phone."
    ],
    [
      "phone",
      "telefon",
      "I have a new phone."
    ],
    [
      "laptop",
      "noutbuk",
      "My sister has a laptop."
    ],
    [
      "dictionary",
      "lug‘at",
      "Do you have a dictionary?"
    ],
    [
      "bag",
      "sumka",
      "She has a blue bag."
    ],
    [
      "pen",
      "ruchka",
      "They have black pens."
    ],
    [
      "notebook",
      "daftar",
      "We have notebooks for English."
    ],
    [
      "brother",
      "aka / uka",
      "He has one brother."
    ],
    [
      "sister",
      "opa / singil",
      "She has two sisters."
    ],
    [
      "parents",
      "ota-ona",
      "I have kind parents."
    ],
    [
      "family",
      "oila",
      "They have a big family."
    ],
    [
      "lesson",
      "dars",
      "We have a lesson today."
    ],
    [
      "time",
      "vaqt",
      "I do not have much time."
    ],
    [
      "money",
      "pul",
      "He does not have money."
    ],
    [
      "problem",
      "muammo",
      "She has a small problem."
    ],
    [
      "question",
      "savol",
      "Do you have a question?"
    ],
    [
      "idea",
      "g‘oya",
      "They have a good idea."
    ],
    [
      "headache",
      "bosh og‘rig‘i",
      "He has a headache."
    ],
    [
      "cold",
      "shamollash",
      "She has a cold."
    ],
    [
      "breakfast",
      "nonushta",
      "We have breakfast at seven."
    ],
    [
      "lunch",
      "tushlik",
      "They have lunch at school."
    ],
    [
      "dinner",
      "kechki ovqat",
      "I have dinner at home."
    ],
    [
      "meeting",
      "uchrashuv",
      "She has a meeting today."
    ],
    [
      "class",
      "dars / sinf",
      "We have English class."
    ],
    [
      "pet",
      "uy hayvoni",
      "Do you have a pet?"
    ],
    [
      "car",
      "mashina",
      "My uncle has a car."
    ],
    [
      "house",
      "uy",
      "They have a big house."
    ],
    [
      "key",
      "kalit",
      "I have the key."
    ],
    [
      "umbrella",
      "soyabon",
      "Do you have an umbrella?"
    ]
  ],
  "CAN_CANT": [
    [
      "can",
      "qila olmoq / mumkin",
      "I can swim."
    ],
    [
      "can’t",
      "qila olmaslik",
      "She can’t drive."
    ],
    [
      "swim",
      "suzmoq",
      "Can you swim?"
    ],
    [
      "drive",
      "mashina haydamoq",
      "My father can drive."
    ],
    [
      "sing",
      "kuylamoq",
      "She can sing well."
    ],
    [
      "dance",
      "raqs tushmoq",
      "They can dance."
    ],
    [
      "read",
      "o‘qimoq",
      "I can read English."
    ],
    [
      "write",
      "yozmoq",
      "He can write his name."
    ],
    [
      "speak",
      "gapirmoq",
      "Can you speak English?"
    ],
    [
      "understand",
      "tushunmoq",
      "I can understand this text."
    ],
    [
      "open",
      "ochmoq",
      "Can you open the window?"
    ],
    [
      "close",
      "yopmoq",
      "Can you close the door?"
    ],
    [
      "help",
      "yordam bermoq",
      "Can you help me?"
    ],
    [
      "come in",
      "ichkariga kirmoq",
      "Can I come in?"
    ],
    [
      "use",
      "foydalanmoq",
      "You can use my pen."
    ],
    [
      "borrow",
      "qarzga olmoq",
      "Can I borrow your book?"
    ],
    [
      "ability",
      "qobiliyat",
      "Can shows ability."
    ],
    [
      "permission",
      "ruxsat",
      "Can is used for permission."
    ],
    [
      "request",
      "iltimos",
      "Can you repeat that?"
    ],
    [
      "impossible",
      "imkonsiz",
      "I can’t come today."
    ],
    [
      "possible",
      "mumkin",
      "We can start now."
    ],
    [
      "well",
      "yaxshi",
      "He can play well."
    ],
    [
      "fast",
      "tez",
      "She can run fast."
    ],
    [
      "slowly",
      "sekin",
      "I can speak slowly."
    ],
    [
      "try",
      "urinmoq",
      "Try again if you can’t."
    ],
    [
      "learn",
      "o‘rganmoq",
      "You can learn English."
    ],
    [
      "play football",
      "futbol o‘ynamoq",
      "They can play football."
    ],
    [
      "play piano",
      "pianino chalmoq",
      "She can play the piano."
    ],
    [
      "carry",
      "ko‘tarmoq",
      "Can you carry this bag?"
    ],
    [
      "answer",
      "javob bermoq",
      "Can you answer the question?"
    ]
  ],
  "WHO_WHAT": [
    [
      "who",
      "kim",
      "Who is your teacher?"
    ],
    [
      "what",
      "nima",
      "What is your name?"
    ],
    [
      "name",
      "ism",
      "What is your name?"
    ],
    [
      "teacher",
      "ustoz",
      "Who is your teacher?"
    ],
    [
      "student",
      "o‘quvchi",
      "Who is that student?"
    ],
    [
      "friend",
      "do‘st",
      "Who is your best friend?"
    ],
    [
      "book",
      "kitob",
      "What is this book?"
    ],
    [
      "pen",
      "ruchka",
      "What is on the table?"
    ],
    [
      "job",
      "ish / kasb",
      "What is your job?"
    ],
    [
      "phone number",
      "telefon raqami",
      "What is your phone number?"
    ],
    [
      "address",
      "manzil",
      "What is your address?"
    ],
    [
      "subject",
      "fan",
      "What is your favorite subject?"
    ],
    [
      "person",
      "odam",
      "Use who for a person."
    ],
    [
      "thing",
      "narsa",
      "Use what for a thing."
    ],
    [
      "question word",
      "savol so‘zi",
      "Who and what are question words."
    ],
    [
      "answer",
      "javob",
      "Answer the question."
    ],
    [
      "called",
      "qo‘ng‘iroq qildi",
      "Who called you?"
    ],
    [
      "speaking",
      "gapiryapti",
      "Who is speaking?"
    ],
    [
      "doing",
      "qilyapti",
      "What are you doing?"
    ],
    [
      "want",
      "xohlamoq",
      "What do you want?"
    ],
    [
      "need",
      "kerak bo‘lmoq",
      "What do you need?"
    ],
    [
      "see",
      "ko‘rmoq",
      "What can you see?"
    ],
    [
      "choose",
      "tanlamoq",
      "What do you choose?"
    ],
    [
      "know",
      "bilmoq",
      "Who knows the answer?"
    ],
    [
      "meet",
      "uchrashmoq",
      "Who did you meet?"
    ],
    [
      "bring",
      "olib kelmoq",
      "What did you bring?"
    ],
    [
      "write",
      "yozmoq",
      "What are you writing?"
    ],
    [
      "read",
      "o‘qimoq",
      "What are you reading?"
    ],
    [
      "that man",
      "ana u erkak",
      "Who is that man?"
    ],
    [
      "this object",
      "bu narsa",
      "What is this object?"
    ]
  ],
  "PRESENT_CONTINUOUS": [
    [
      "now",
      "hozir",
      "I am studying now."
    ],
    [
      "at the moment",
      "ayni paytda",
      "She is speaking at the moment."
    ],
    [
      "today",
      "bugun / vaqtincha",
      "They are working late today."
    ],
    [
      "this week",
      "shu hafta",
      "We are learning new grammar this week."
    ],
    [
      "right now",
      "aynan hozir",
      "He is writing right now."
    ],
    [
      "still",
      "hali ham",
      "She is still sleeping."
    ],
    [
      "look",
      "qarang",
      "Look! It is raining."
    ],
    [
      "listen",
      "tinglang",
      "Listen! They are singing."
    ],
    [
      "read",
      "o‘qimoq",
      "I am reading a book."
    ],
    [
      "write",
      "yozmoq",
      "He is writing a message."
    ],
    [
      "watch",
      "tomosha qilmoq",
      "She is watching a video."
    ],
    [
      "listen to",
      "tinglamoq",
      "They are listening to music."
    ],
    [
      "speak",
      "gapirmoq",
      "We are speaking English."
    ],
    [
      "study",
      "o‘qimoq / o‘rganmoq",
      "You are studying grammar."
    ],
    [
      "work",
      "ishlamoq",
      "My father is working now."
    ],
    [
      "play",
      "o‘ynamoq",
      "The children are playing outside."
    ],
    [
      "cook",
      "ovqat pishirmoq",
      "My mother is cooking dinner."
    ],
    [
      "sleep",
      "uxlamoq",
      "The baby is sleeping."
    ],
    [
      "wait",
      "kutmoq",
      "I am waiting for my friend."
    ],
    [
      "rain",
      "yomg‘ir yog‘moq",
      "It is raining now."
    ],
    [
      "run",
      "yugurmoq",
      "He is running in the park."
    ],
    [
      "sit",
      "o‘tirmoq",
      "We are sitting near the window."
    ],
    [
      "stand",
      "turmoq",
      "They are standing outside."
    ],
    [
      "wear",
      "kiyib olmoq",
      "She is wearing a blue dress."
    ],
    [
      "build",
      "qurmoq",
      "Workers are building a house."
    ],
    [
      "change",
      "o‘zgarmoq",
      "The weather is changing."
    ],
    [
      "learn",
      "o‘rganmoq",
      "I am learning English."
    ],
    [
      "travel",
      "sayohat qilmoq",
      "They are traveling this month."
    ],
    [
      "stay",
      "qolmoq",
      "We are staying at a hotel."
    ],
    [
      "look for",
      "qidirmoq",
      "I am looking for my keys."
    ]
  ],
  "PRESENT_SIMPLE": [
    [
      "every day",
      "har kuni",
      "I go to school every day."
    ],
    [
      "every week",
      "har hafta",
      "We have a test every week."
    ],
    [
      "always",
      "har doim",
      "He always comes on time."
    ],
    [
      "usually",
      "odatda",
      "She usually drinks tea."
    ],
    [
      "often",
      "tez-tez",
      "They often visit us."
    ],
    [
      "sometimes",
      "ba’zan",
      "I sometimes watch films."
    ],
    [
      "rarely",
      "kamdan-kam",
      "We rarely eat out."
    ],
    [
      "never",
      "hech qachon",
      "She never eats meat."
    ],
    [
      "in the morning",
      "ertalab",
      "I get up in the morning."
    ],
    [
      "in the evening",
      "kechqurun",
      "We study in the evening."
    ],
    [
      "on Mondays",
      "dushanba kunlari",
      "He plays football on Mondays."
    ],
    [
      "go",
      "bormoq",
      "He goes to school by bus."
    ],
    [
      "come",
      "kelmoq",
      "She comes home at six."
    ],
    [
      "live",
      "yashamoq",
      "They live in Tashkent."
    ],
    [
      "work",
      "ishlamoq",
      "My father works in an office."
    ],
    [
      "study",
      "o‘qimoq",
      "We study English."
    ],
    [
      "like",
      "yoqtirmoq",
      "I like English."
    ],
    [
      "love",
      "sevmoq",
      "She loves music."
    ],
    [
      "know",
      "bilmoq",
      "He knows the answer."
    ],
    [
      "need",
      "kerak bo‘lmoq",
      "We need more practice."
    ],
    [
      "want",
      "xohlamoq",
      "He wants a new book."
    ],
    [
      "watch",
      "tomosha qilmoq",
      "They watch TV at night."
    ],
    [
      "read",
      "o‘qimoq",
      "I read books."
    ],
    [
      "play",
      "o‘ynamoq",
      "Children play games."
    ],
    [
      "eat",
      "yemoq",
      "We eat breakfast at seven."
    ],
    [
      "drink",
      "ichmoq",
      "She drinks water."
    ],
    [
      "teach",
      "o‘qitmoq",
      "He teaches English."
    ],
    [
      "finish",
      "tugatmoq",
      "The lesson finishes at five."
    ],
    [
      "start",
      "boshlanmoq",
      "The class starts at nine."
    ],
    [
      "do homework",
      "uy vazifasini qilmoq",
      "I do homework after school."
    ]
  ],
  "PRESENT_SIMPLE_CONTINUOUS": [
    [
      "habit",
      "odat",
      "Present Simple is used for habits."
    ],
    [
      "temporary",
      "vaqtinchalik",
      "Present Continuous can show a temporary action."
    ],
    [
      "fact",
      "fakt",
      "Water boils at 100 degrees."
    ],
    [
      "action now",
      "hozirgi harakat",
      "I am writing now."
    ],
    [
      "usual action",
      "odatdagi harakat",
      "I usually write emails."
    ],
    [
      "every day",
      "har kuni",
      "She walks every day."
    ],
    [
      "now",
      "hozir",
      "She is walking now."
    ],
    [
      "at the moment",
      "ayni paytda",
      "He is working at the moment."
    ],
    [
      "this week",
      "shu hafta",
      "We are staying home this week."
    ],
    [
      "today",
      "bugun",
      "They are working late today."
    ],
    [
      "always",
      "har doim",
      "He always helps me."
    ],
    [
      "usually",
      "odatda",
      "I usually go by bus."
    ],
    [
      "often",
      "tez-tez",
      "We often meet on Friday."
    ],
    [
      "sometimes",
      "ba’zan",
      "She sometimes cooks dinner."
    ],
    [
      "never",
      "hech qachon",
      "He never drinks coffee."
    ],
    [
      "right now",
      "aynan hozir",
      "I am not busy right now."
    ],
    [
      "live",
      "yashamoq",
      "They live in Tashkent."
    ],
    [
      "stay",
      "qolmoq",
      "They are staying in Tashkent this week."
    ],
    [
      "work",
      "ishlamoq",
      "She works in a bank."
    ],
    [
      "working late",
      "kechgacha ishlamoq",
      "She is working late today."
    ],
    [
      "play tennis",
      "tennis o‘ynamoq",
      "Do you play tennis?"
    ],
    [
      "playing tennis",
      "tennis o‘ynayapti",
      "Are you playing tennis now?"
    ],
    [
      "wear",
      "kiymoq",
      "He usually wears a suit."
    ],
    [
      "wearing",
      "kiyib olgan",
      "He is wearing jeans today."
    ],
    [
      "think",
      "o‘ylamoq",
      "I think this is right."
    ],
    [
      "look",
      "ko‘rinmoq / qaramoq",
      "You look tired."
    ],
    [
      "look at",
      "qaramoq",
      "Look! He is looking at us."
    ],
    [
      "need",
      "kerak bo‘lmoq",
      "I need help."
    ],
    [
      "wait",
      "kutmoq",
      "I am waiting for the bus."
    ],
    [
      "compare",
      "solishtirmoq",
      "Compare the two tenses."
    ]
  ],
  "PREPOSITION_OF_PLACE": [
    [
      "in",
      "ichida",
      "The phone is in the bag."
    ],
    [
      "on",
      "ustida",
      "The book is on the table."
    ],
    [
      "under",
      "ostida",
      "The cat is under the chair."
    ],
    [
      "next to",
      "yonida",
      "Ali is next to me."
    ],
    [
      "between",
      "orasida",
      "The bank is between the shop and the school."
    ],
    [
      "behind",
      "orqasida",
      "The garden is behind the house."
    ],
    [
      "in front of",
      "oldida",
      "The bus stop is in front of the school."
    ],
    [
      "near",
      "yaqinida",
      "There is a park near my house."
    ],
    [
      "opposite",
      "qarshisida",
      "The bank is opposite the hotel."
    ],
    [
      "above",
      "tepasida",
      "The picture is above the sofa."
    ],
    [
      "below",
      "pastida",
      "The shoes are below the shelf."
    ],
    [
      "inside",
      "ichkarisida",
      "The keys are inside the box."
    ],
    [
      "outside",
      "tashqarisida",
      "The children are outside the classroom."
    ],
    [
      "at",
      "aniq joyda",
      "I am at school."
    ],
    [
      "by",
      "yonida / yaqinida",
      "She is sitting by the window."
    ],
    [
      "in the corner",
      "burchakda",
      "The desk is in the corner."
    ],
    [
      "on the left",
      "chap tomonda",
      "The door is on the left."
    ],
    [
      "on the right",
      "o‘ng tomonda",
      "The board is on the right."
    ],
    [
      "in the middle",
      "o‘rtasida",
      "The table is in the middle."
    ],
    [
      "on the wall",
      "devorda",
      "The clock is on the wall."
    ],
    [
      "on the floor",
      "polda",
      "The bag is on the floor."
    ],
    [
      "in the room",
      "xonada",
      "There are chairs in the room."
    ],
    [
      "at the door",
      "eshik yonida",
      "He is at the door."
    ],
    [
      "at the bus stop",
      "bekatda",
      "We are at the bus stop."
    ],
    [
      "in bed",
      "yotoqda",
      "The baby is in bed."
    ],
    [
      "at home",
      "uyda",
      "They are at home."
    ],
    [
      "at work",
      "ishda",
      "My father is at work."
    ],
    [
      "at university",
      "universitetda",
      "She is at university."
    ],
    [
      "in a picture",
      "rasmda",
      "There are two people in the picture."
    ],
    [
      "on a page",
      "sahifada",
      "The answer is on page five."
    ]
  ],
  "PREPOSITION_OF_TIME": [
    [
      "at 9 o’clock",
      "soat 9 da",
      "The lesson starts at 9 o’clock."
    ],
    [
      "at night",
      "tunda",
      "I do not study at night."
    ],
    [
      "at the weekend",
      "dam olish kunida",
      "We meet at the weekend."
    ],
    [
      "at lunchtime",
      "tushlik vaqtida",
      "She calls me at lunchtime."
    ],
    [
      "on Monday",
      "dushanba kuni",
      "We have English on Monday."
    ],
    [
      "on Friday",
      "juma kuni",
      "The test is on Friday."
    ],
    [
      "on 5 May",
      "5-may kuni",
      "My birthday is on 5 May."
    ],
    [
      "on my birthday",
      "tug‘ilgan kunimda",
      "I see my friends on my birthday."
    ],
    [
      "in May",
      "may oyida",
      "We finish in May."
    ],
    [
      "in 2026",
      "2026-yilda",
      "The course starts in 2026."
    ],
    [
      "in summer",
      "yozda",
      "It is hot in summer."
    ],
    [
      "in the morning",
      "ertalab",
      "I get up in the morning."
    ],
    [
      "in the afternoon",
      "tushdan keyin",
      "We study in the afternoon."
    ],
    [
      "in the evening",
      "kechqurun",
      "They watch TV in the evening."
    ],
    [
      "in winter",
      "qishda",
      "It is cold in winter."
    ],
    [
      "on Sunday",
      "yakshanba kuni",
      "We rest on Sunday."
    ],
    [
      "at noon",
      "tush paytida",
      "We have a break at noon."
    ],
    [
      "tomorrow",
      "ertaga",
      "I will call you tomorrow."
    ],
    [
      "yesterday",
      "kecha",
      "I saw him yesterday."
    ],
    [
      "next week",
      "keyingi hafta",
      "We have a test next week."
    ],
    [
      "last week",
      "o‘tgan hafta",
      "They visited us last week."
    ],
    [
      "soon",
      "tez orada",
      "The lesson will start soon."
    ],
    [
      "later",
      "keyinroq",
      "I will do it later."
    ],
    [
      "early",
      "erta",
      "She comes early."
    ],
    [
      "late",
      "kech",
      "He arrived late."
    ]
  ],
  "PAST_SIMPLE": [
    [
      "yesterday",
      "kecha",
      "I watched TV yesterday."
    ],
    [
      "last night",
      "kecha kechqurun",
      "We studied last night."
    ],
    [
      "last week",
      "o‘tgan hafta",
      "She visited us last week."
    ],
    [
      "two days ago",
      "ikki kun oldin",
      "He came two days ago."
    ],
    [
      "ago",
      "oldin",
      "They moved here years ago."
    ],
    [
      "went",
      "bordi",
      "He went to school."
    ],
    [
      "came",
      "keldi",
      "My friend came late."
    ],
    [
      "saw",
      "ko‘rdi",
      "I saw a good film."
    ],
    [
      "bought",
      "sotib oldi",
      "She bought a new bag."
    ],
    [
      "had",
      "bor edi / ega edi",
      "We had a good lesson."
    ],
    [
      "did",
      "qildi / savol yordamchisi",
      "Did you finish?"
    ],
    [
      "made",
      "yasadi / qildi",
      "They made a cake."
    ],
    [
      "took",
      "oldi",
      "He took my pen."
    ],
    [
      "gave",
      "berdi",
      "She gave me a book."
    ],
    [
      "found",
      "topdi",
      "I found my keys."
    ],
    [
      "started",
      "boshladi",
      "The lesson started at nine."
    ],
    [
      "finished",
      "tugatdi",
      "We finished the test."
    ],
    [
      "played",
      "o‘ynadi",
      "They played football."
    ],
    [
      "watched",
      "tomosha qildi",
      "I watched a film."
    ],
    [
      "visited",
      "tashrif buyurdi",
      "We visited Samarkand."
    ],
    [
      "studied",
      "o‘qidi",
      "She studied English."
    ],
    [
      "worked",
      "ishladi",
      "He worked yesterday."
    ],
    [
      "called",
      "qo‘ng‘iroq qildi",
      "I called my friend."
    ],
    [
      "opened",
      "ochdi",
      "She opened the door."
    ],
    [
      "closed",
      "yopdi",
      "He closed the window."
    ],
    [
      "asked",
      "so‘radi",
      "The teacher asked a question."
    ],
    [
      "answered",
      "javob berdi",
      "I answered correctly."
    ],
    [
      "tried",
      "urinib ko‘rdi",
      "They tried again."
    ],
    [
      "needed",
      "kerak bo‘ldi",
      "We needed help."
    ],
    [
      "wanted",
      "xohladi",
      "He wanted a new phone."
    ]
  ],
  "PAST_CONTINUOUS": [
    [
      "was",
      "edi / I-he-she-it bilan",
      "I was reading at eight."
    ],
    [
      "were",
      "edi / you-we-they bilan",
      "They were playing outside."
    ],
    [
      "while",
      "... paytida",
      "I was cooking while she was studying."
    ],
    [
      "when",
      "... bo‘lganda",
      "I was sleeping when you called."
    ],
    [
      "at 8 o’clock",
      "soat 8 da",
      "We were watching TV at 8 o’clock."
    ],
    [
      "yesterday evening",
      "kecha kechqurun",
      "She was working yesterday evening."
    ],
    [
      "all morning",
      "butun tong",
      "He was studying all morning."
    ],
    [
      "all day",
      "butun kun",
      "It was raining all day."
    ],
    [
      "reading",
      "o‘qiyotgan",
      "I was reading a book."
    ],
    [
      "writing",
      "yozayotgan",
      "He was writing a letter."
    ],
    [
      "watching",
      "tomosha qilayotgan",
      "They were watching TV."
    ],
    [
      "listening",
      "tinglayotgan",
      "She was listening to music."
    ],
    [
      "speaking",
      "gapirayotgan",
      "We were speaking English."
    ],
    [
      "studying",
      "o‘qiyotgan",
      "You were studying grammar."
    ],
    [
      "working",
      "ishlayotgan",
      "My father was working."
    ],
    [
      "playing",
      "o‘ynayotgan",
      "The children were playing."
    ],
    [
      "cooking",
      "ovqat qilayotgan",
      "My mother was cooking."
    ],
    [
      "sleeping",
      "uxlayotgan",
      "The baby was sleeping."
    ],
    [
      "waiting",
      "kutayotgan",
      "I was waiting for the bus."
    ],
    [
      "raining",
      "yomg‘ir yog‘ayotgan",
      "It was raining."
    ],
    [
      "walking",
      "yurayotgan",
      "They were walking home."
    ],
    [
      "talking",
      "gaplashayotgan",
      "He was talking to his friend."
    ],
    [
      "looking",
      "qarayotgan / izlayotgan",
      "She was looking at the picture."
    ],
    [
      "wearing",
      "kiyib turgan",
      "He was wearing a blue jacket."
    ],
    [
      "driving",
      "haydayotgan",
      "She was driving to work."
    ],
    [
      "cleaning",
      "tozalayotgan",
      "We were cleaning the room."
    ],
    [
      "drinking",
      "ichayotgan",
      "He was drinking tea."
    ],
    [
      "eating",
      "yeyayotgan",
      "They were eating lunch."
    ],
    [
      "helping",
      "yordam berayotgan",
      "I was helping my sister."
    ],
    [
      "doing homework",
      "uy vazifasini qilayotgan",
      "She was doing homework."
    ]
  ],
  "FUTURE_GOING_TO": [
    [
      "will",
      "kelajak yordamchisi",
      "I will call you later."
    ],
    [
      "going to",
      "reja / niyat",
      "She is going to buy a phone."
    ],
    [
      "tomorrow",
      "ertaga",
      "We will meet tomorrow."
    ],
    [
      "next week",
      "keyingi hafta",
      "They are going to travel next week."
    ],
    [
      "next month",
      "keyingi oy",
      "I will start next month."
    ],
    [
      "later",
      "keyinroq",
      "I will do it later."
    ],
    [
      "soon",
      "tez orada",
      "The lesson will start soon."
    ],
    [
      "tonight",
      "bugun kechqurun",
      "We are going to study tonight."
    ],
    [
      "plan",
      "reja",
      "This is my plan."
    ],
    [
      "future",
      "kelajak",
      "Use will for future."
    ],
    [
      "promise",
      "va’da",
      "I will help you."
    ],
    [
      "decision",
      "qaror",
      "I will answer now."
    ],
    [
      "prediction",
      "taxmin",
      "I think it will rain."
    ],
    [
      "intention",
      "niyat",
      "I am going to learn English."
    ],
    [
      "call",
      "qo‘ng‘iroq qilmoq",
      "I will call you."
    ],
    [
      "help",
      "yordam bermoq",
      "She will help me."
    ],
    [
      "visit",
      "tashrif buyurmoq",
      "We are going to visit Samarkand."
    ],
    [
      "travel",
      "sayohat qilmoq",
      "They will travel in summer."
    ],
    [
      "buy",
      "sotib olmoq",
      "He is going to buy a laptop."
    ],
    [
      "sell",
      "sotmoq",
      "They will sell the car."
    ],
    [
      "start",
      "boshlamoq",
      "The course will start tomorrow."
    ],
    [
      "finish",
      "tugatmoq",
      "We will finish soon."
    ],
    [
      "open",
      "ochmoq",
      "The shop will open at nine."
    ],
    [
      "close",
      "yopmoq",
      "The school will close in July."
    ],
    [
      "stay",
      "qolmoq",
      "I am going to stay home."
    ],
    [
      "move",
      "ko‘chmoq",
      "They are going to move."
    ],
    [
      "study",
      "o‘qimoq",
      "She will study tonight."
    ],
    [
      "work",
      "ishlamoq",
      "He is going to work late."
    ],
    [
      "meet",
      "uchrashmoq",
      "We will meet at six."
    ],
    [
      "be late",
      "kech qolmoq",
      "I will not be late."
    ]
  ],
  "PRESENT_PERFECT": [
    [
      "have",
      "Present Perfect yordamchisi",
      "I have finished."
    ],
    [
      "has",
      "he/she/it bilan yordamchi",
      "She has finished."
    ],
    [
      "finished",
      "tugatgan",
      "I have finished my homework."
    ],
    [
      "done",
      "qilgan",
      "He has done the task."
    ],
    [
      "seen",
      "ko‘rgan",
      "Have you seen this film?"
    ],
    [
      "been",
      "bo‘lgan / borgan",
      "I have been to Samarkand."
    ],
    [
      "gone",
      "ketgan",
      "She has gone home."
    ],
    [
      "written",
      "yozgan",
      "He has written a letter."
    ],
    [
      "read",
      "o‘qigan",
      "I have read this book."
    ],
    [
      "eaten",
      "yegan",
      "They have eaten lunch."
    ],
    [
      "drunk",
      "ichgan",
      "She has drunk tea."
    ],
    [
      "bought",
      "sotib olgan",
      "We have bought tickets."
    ],
    [
      "lost",
      "yo‘qotgan",
      "I have lost my keys."
    ],
    [
      "found",
      "topgan",
      "He has found his phone."
    ],
    [
      "opened",
      "ochgan",
      "They have opened the door."
    ],
    [
      "closed",
      "yopgan",
      "She has closed the window."
    ],
    [
      "already",
      "allaqachon",
      "I have already eaten."
    ],
    [
      "yet",
      "hali / hali ham",
      "He has not arrived yet."
    ],
    [
      "ever",
      "hech qachon? / tajriba",
      "Have you ever flown?"
    ],
    [
      "never",
      "hech qachon",
      "I have never seen snow."
    ],
    [
      "just",
      "hozirgina",
      "She has just left."
    ],
    [
      "recently",
      "yaqinda",
      "We have recently moved."
    ],
    [
      "so far",
      "hozirgacha",
      "I have learned ten words so far."
    ],
    [
      "for two years",
      "ikki yildan beri",
      "They have lived here for two years."
    ],
    [
      "since 2020",
      "2020-yildan beri",
      "She has worked here since 2020."
    ],
    [
      "experience",
      "tajriba",
      "Present Perfect can show experience."
    ],
    [
      "result",
      "natija",
      "The result is important now."
    ],
    [
      "V3",
      "fe’lning 3-shakli",
      "Use V3 after have/has."
    ],
    [
      "not yet",
      "hali emas",
      "I have not finished yet."
    ],
    [
      "have you ever",
      "hech ... qilganmisiz?",
      "Have you ever visited Bukhara?"
    ]
  ],
  "ADJECTIVE_ADVERB": [
    [
      "adjective",
      "sifat",
      "A quick student answers fast."
    ],
    [
      "adverb",
      "ravish",
      "She speaks clearly."
    ],
    [
      "quick",
      "tez / sifat",
      "He is a quick runner."
    ],
    [
      "quickly",
      "tezda / ravish",
      "He runs quickly."
    ],
    [
      "slow",
      "sekin / sifat",
      "This is a slow bus."
    ],
    [
      "slowly",
      "sekinlik bilan",
      "Please speak slowly."
    ],
    [
      "careful",
      "ehtiyotkor",
      "She is a careful driver."
    ],
    [
      "carefully",
      "ehtiyotkorlik bilan",
      "She drives carefully."
    ],
    [
      "good",
      "yaxshi / sifat",
      "He is a good student."
    ],
    [
      "well",
      "yaxshi tarzda",
      "He speaks English well."
    ],
    [
      "bad",
      "yomon / sifat",
      "This is a bad idea."
    ],
    [
      "badly",
      "yomon tarzda",
      "He played badly."
    ],
    [
      "loud",
      "baland ovozli",
      "The music is loud."
    ],
    [
      "loudly",
      "baland ovozda",
      "They are talking loudly."
    ],
    [
      "quiet",
      "sokin / jim",
      "The room is quiet."
    ],
    [
      "quietly",
      "jimgina",
      "Please work quietly."
    ],
    [
      "happy",
      "xursand",
      "She is happy."
    ],
    [
      "happily",
      "xursand holda",
      "They smiled happily."
    ],
    [
      "easy",
      "oson",
      "This is an easy question."
    ],
    [
      "easily",
      "osongina",
      "She passed easily."
    ],
    [
      "beautiful",
      "chiroyli",
      "It is a beautiful picture."
    ],
    [
      "beautifully",
      "chiroyli tarzda",
      "She sings beautifully."
    ],
    [
      "clear",
      "aniq",
      "The explanation is clear."
    ],
    [
      "clearly",
      "aniq qilib",
      "Explain it clearly."
    ],
    [
      "correct",
      "to‘g‘ri",
      "This is the correct answer."
    ],
    [
      "correctly",
      "to‘g‘ri tarzda",
      "Write the answer correctly."
    ],
    [
      "fast",
      "tez",
      "He is a fast runner."
    ],
    [
      "hard",
      "qattiq / tirishib",
      "She works hard."
    ],
    [
      "late",
      "kech",
      "He is late."
    ],
    [
      "lately",
      "so‘nggi paytlarda",
      "I have been busy lately."
    ]
  ],
  "CONDITIONAL_0": [
    [
      "if",
      "agar",
      "If you heat water, it boils."
    ],
    [
      "when",
      "qachonki",
      "When it rains, the ground gets wet."
    ],
    [
      "always true",
      "doim rost",
      "Zero conditional shows always true things."
    ],
    [
      "fact",
      "fakt",
      "This sentence is a fact."
    ],
    [
      "result",
      "natija",
      "The result is certain."
    ],
    [
      "condition",
      "shart",
      "The condition comes after if."
    ],
    [
      "heat",
      "isitmoq",
      "If you heat ice, it melts."
    ],
    [
      "boil",
      "qaynamoq",
      "Water boils at 100°C."
    ],
    [
      "melt",
      "erimoq",
      "Ice melts in the sun."
    ],
    [
      "freeze",
      "muzlamoq",
      "Water freezes at 0°C."
    ],
    [
      "rain",
      "yomg‘ir yog‘moq",
      "If it rains, roads get wet."
    ],
    [
      "get wet",
      "ho‘l bo‘lmoq",
      "Clothes get wet in rain."
    ],
    [
      "press",
      "bosmoq",
      "If you press this button, the light turns on."
    ],
    [
      "turn on",
      "yoqilmoq",
      "The light turns on."
    ],
    [
      "turn off",
      "o‘chmoq",
      "If you turn it off, it stops."
    ],
    [
      "plants",
      "o‘simliklar",
      "Plants die without water."
    ],
    [
      "need",
      "kerak bo‘lmoq",
      "Plants need sunlight."
    ],
    [
      "sunlight",
      "quyosh nuri",
      "Plants grow with sunlight."
    ],
    [
      "water",
      "suv",
      "If people do not drink water, they get thirsty."
    ],
    [
      "get thirsty",
      "chanqamoq",
      "You get thirsty in hot weather."
    ],
    [
      "study",
      "o‘qimoq",
      "If students study, they learn."
    ],
    [
      "learn",
      "o‘rganmoq",
      "You learn when you practice."
    ],
    [
      "practice",
      "mashq qilmoq",
      "If you practice, you improve."
    ],
    [
      "improve",
      "yaxshilanmoq",
      "Your English improves."
    ],
    [
      "touch",
      "tegmoq",
      "If you touch fire, it burns."
    ],
    [
      "burn",
      "kuydirmoq",
      "Fire burns."
    ],
    [
      "fall",
      "yiqilmoq",
      "If you drop a glass, it breaks."
    ],
    [
      "break",
      "sinmoq",
      "Glass breaks easily."
    ],
    [
      "use present simple",
      "present simple ishlatish",
      "Both parts use Present Simple."
    ],
    [
      "general truth",
      "umumiy haqiqat",
      "Zero conditional is for general truths."
    ]
  ],
  "CONDITIONAL_1": [
    [
      "if",
      "agar",
      "If it rains, I will stay home."
    ],
    [
      "will",
      "kelajak natija",
      "I will help you."
    ],
    [
      "possible",
      "mumkin",
      "First conditional is for possible future."
    ],
    [
      "condition",
      "shart",
      "The if part is the condition."
    ],
    [
      "result",
      "natija",
      "The will part is the result."
    ],
    [
      "rain",
      "yomg‘ir yog‘moq",
      "If it rains, we will not go out."
    ],
    [
      "stay home",
      "uyda qolmoq",
      "I will stay home."
    ],
    [
      "study",
      "o‘qimoq",
      "If you study, you will pass."
    ],
    [
      "pass",
      "imtihondan o‘tmoq",
      "You will pass the test."
    ],
    [
      "fail",
      "yiqilmoq",
      "If you do not study, you may fail."
    ],
    [
      "come",
      "kelmoq",
      "If he comes, I will call you."
    ],
    [
      "call",
      "qo‘ng‘iroq qilmoq",
      "I will call you."
    ],
    [
      "be late",
      "kech qolmoq",
      "If you are late, we will start."
    ],
    [
      "start",
      "boshlamoq",
      "The lesson will start."
    ],
    [
      "finish",
      "tugatmoq",
      "If we finish early, we will go home."
    ],
    [
      "go out",
      "tashqariga chiqmoq",
      "We will go out."
    ],
    [
      "help",
      "yordam bermoq",
      "If you ask, I will help."
    ],
    [
      "ask",
      "so‘ramoq",
      "Ask me if you need help."
    ],
    [
      "need",
      "kerak bo‘lmoq",
      "If you need money, tell me."
    ],
    [
      "tell",
      "aytmoq",
      "I will tell the teacher."
    ],
    [
      "win",
      "yutmoq",
      "If they play well, they will win."
    ],
    [
      "lose",
      "yutqazmoq",
      "If they are tired, they will lose."
    ],
    [
      "buy",
      "sotib olmoq",
      "If I have money, I will buy it."
    ],
    [
      "save money",
      "pul yig‘moq",
      "If I save money, I will travel."
    ],
    [
      "travel",
      "sayohat qilmoq",
      "I will travel next summer."
    ],
    [
      "prepare",
      "tayyorlanmoq",
      "If we prepare, we will succeed."
    ],
    [
      "succeed",
      "muvaffaqiyat qozonmoq",
      "You will succeed."
    ],
    [
      "weather",
      "ob-havo",
      "If the weather is good, we will walk."
    ],
    [
      "future plan",
      "kelajak reja",
      "Use this for future possibilities."
    ],
    [
      "main clause",
      "asosiy gap",
      "The main clause uses will."
    ]
  ],
  "HAVE_TO_MUST": [
    [
      "must",
      "shart / majbur",
      "You must wear a seat belt."
    ],
    [
      "have to",
      "majbur bo‘lmoq",
      "I have to get up early."
    ],
    [
      "has to",
      "majbur / he-she-it bilan",
      "She has to work today."
    ],
    [
      "don’t have to",
      "shart emas",
      "You don’t have to come early."
    ],
    [
      "doesn’t have to",
      "shart emas / he-she-it",
      "He doesn’t have to pay."
    ],
    [
      "mustn’t",
      "mumkin emas",
      "You mustn’t smoke here."
    ],
    [
      "rule",
      "qoida",
      "This is a school rule."
    ],
    [
      "law",
      "qonun",
      "Drivers must follow the law."
    ],
    [
      "obligation",
      "majburiyat",
      "Have to shows obligation."
    ],
    [
      "necessary",
      "zarur",
      "It is necessary."
    ],
    [
      "not necessary",
      "zarur emas",
      "It is not necessary."
    ],
    [
      "forbidden",
      "taqiqlangan",
      "Smoking is forbidden here."
    ],
    [
      "wear",
      "kiymoq",
      "Students have to wear uniforms."
    ],
    [
      "arrive",
      "yetib kelmoq",
      "We must arrive on time."
    ],
    [
      "be quiet",
      "jim bo‘lmoq",
      "You must be quiet in the library."
    ],
    [
      "pay",
      "to‘lamoq",
      "He has to pay today."
    ],
    [
      "show",
      "ko‘rsatmoq",
      "You have to show your ID."
    ],
    [
      "bring",
      "olib kelmoq",
      "You must bring your notebook."
    ],
    [
      "finish",
      "tugatmoq",
      "I have to finish this work."
    ],
    [
      "clean",
      "tozalamoq",
      "They have to clean the room."
    ],
    [
      "listen",
      "tinglamoq",
      "You must listen carefully."
    ],
    [
      "wait",
      "kutmoq",
      "You have to wait here."
    ],
    [
      "enter",
      "kirmoq",
      "You mustn’t enter this room."
    ],
    [
      "touch",
      "tegmoq",
      "You mustn’t touch that button."
    ],
    [
      "use phone",
      "telefon ishlatmoq",
      "You mustn’t use your phone in the test."
    ],
    [
      "permission",
      "ruxsat",
      "Rules give or remove permission."
    ],
    [
      "warning",
      "ogohlantirish",
      "Mustn’t is a strong warning."
    ],
    [
      "advice",
      "maslahat",
      "Must can sound very strong."
    ],
    [
      "workplace",
      "ish joyi",
      "Workplaces have rules."
    ],
    [
      "school rule",
      "maktab qoidasi",
      "School rules are important."
    ]
  ],
  "WOULD_COULD": [
    [
      "would",
      "xohish / odobli so‘rov",
      "Would you like some tea?"
    ],
    [
      "could",
      "qila olardi / iltimos",
      "Could you help me?"
    ],
    [
      "polite request",
      "odobli iltimos",
      "Could you open the door?"
    ],
    [
      "offer",
      "taklif",
      "Would you like coffee?"
    ],
    [
      "possibility",
      "imkoniyat",
      "It could rain later."
    ],
    [
      "past ability",
      "o‘tmish qobiliyati",
      "I could swim when I was young."
    ],
    [
      "would like",
      "xohlamoq",
      "I would like a glass of water."
    ],
    [
      "would prefer",
      "afzal ko‘rmoq",
      "I would prefer tea."
    ],
    [
      "could you",
      "qila olasizmi",
      "Could you repeat that?"
    ],
    [
      "could I",
      "qilsam bo‘ladimi",
      "Could I use your phone?"
    ],
    [
      "help",
      "yordam bermoq",
      "Could you help me?"
    ],
    [
      "repeat",
      "takrorlamoq",
      "Could you repeat the question?"
    ],
    [
      "open",
      "ochmoq",
      "Could you open the window?"
    ],
    [
      "close",
      "yopmoq",
      "Could you close the door?"
    ],
    [
      "borrow",
      "qarzga olmoq",
      "Could I borrow your pen?"
    ],
    [
      "bring",
      "olib kelmoq",
      "Could you bring a chair?"
    ],
    [
      "join",
      "qo‘shilmoq",
      "Could I join the class?"
    ],
    [
      "invite",
      "taklif qilmoq",
      "Would you invite him?"
    ],
    [
      "choose",
      "tanlamoq",
      "I would choose this one."
    ],
    [
      "visit",
      "tashrif buyurmoq",
      "I would visit Samarkand."
    ],
    [
      "travel",
      "sayohat qilmoq",
      "We could travel by train."
    ],
    [
      "maybe",
      "balki",
      "Maybe it could work."
    ],
    [
      "if I were",
      "agar men bo‘lganimda",
      "If I were you, I would study."
    ],
    [
      "advice",
      "maslahat",
      "I would talk to the teacher."
    ],
    [
      "soft question",
      "muloyim savol",
      "Would you mind helping me?"
    ],
    [
      "restaurant",
      "restoran",
      "I would like a table."
    ],
    [
      "menu",
      "menyu",
      "Could I see the menu?"
    ],
    [
      "tea",
      "choy",
      "Would you like tea?"
    ],
    [
      "coffee",
      "kofe",
      "Would you like coffee?"
    ],
    [
      "thanks",
      "rahmat",
      "Thanks for your help."
    ]
  ],
  "USED_TO": [
    [
      "used to",
      "oldin odat bo‘lgan",
      "I used to play football."
    ],
    [
      "didn’t use to",
      "oldin odat bo‘lmagan",
      "She didn’t use to drink coffee."
    ],
    [
      "did you use to",
      "oldin ... qilarmidingiz?",
      "Did you use to live here?"
    ],
    [
      "past habit",
      "o‘tmishdagi odat",
      "Used to shows a past habit."
    ],
    [
      "now",
      "hozir",
      "Now I study more."
    ],
    [
      "before",
      "oldin",
      "Before, I lived in a village."
    ],
    [
      "when I was young",
      "yoshligimda",
      "I used to run every day."
    ],
    [
      "childhood",
      "bolalik",
      "My childhood was happy."
    ],
    [
      "live",
      "yashamoq",
      "We used to live in Andijan."
    ],
    [
      "work",
      "ishlamoq",
      "He used to work in a bank."
    ],
    [
      "study",
      "o‘qimoq",
      "I used to study at night."
    ],
    [
      "play",
      "o‘ynamoq",
      "Children used to play outside."
    ],
    [
      "watch",
      "tomosha qilmoq",
      "She used to watch cartoons."
    ],
    [
      "read",
      "o‘qimoq",
      "I used to read comics."
    ],
    [
      "walk",
      "yurmoq",
      "We used to walk to school."
    ],
    [
      "go",
      "bormoq",
      "He used to go by bus."
    ],
    [
      "have",
      "bor bo‘lmoq",
      "They used to have a car."
    ],
    [
      "be",
      "bo‘lmoq",
      "It used to be cheap."
    ],
    [
      "like",
      "yoqtirmoq",
      "I used to like this song."
    ],
    [
      "hate",
      "yomon ko‘rmoq",
      "She used to hate vegetables."
    ],
    [
      "smoke",
      "chekmoq",
      "He used to smoke."
    ],
    [
      "exercise",
      "mashq qilmoq",
      "I used to exercise daily."
    ],
    [
      "neighbour",
      "qo‘shni",
      "Our neighbour used to help us."
    ],
    [
      "old school",
      "eski maktab",
      "I used to study at that school."
    ],
    [
      "small town",
      "kichik shahar",
      "We used to live in a small town."
    ],
    [
      "change",
      "o‘zgarmoq",
      "Things changed."
    ],
    [
      "not anymore",
      "endi emas",
      "I don’t do it anymore."
    ],
    [
      "remember",
      "eslamoq",
      "Do you remember your old habits?"
    ],
    [
      "then",
      "o‘sha paytda",
      "Life was different then."
    ],
    [
      "these days",
      "hozirgi kunlarda",
      "These days I am busier."
    ]
  ],
  "GERUND_INFINITIVE": [
    [
      "gerund",
      "verb-ing shakli",
      "I enjoy reading."
    ],
    [
      "infinitive",
      "to + verb",
      "I want to learn."
    ],
    [
      "reading",
      "o‘qish",
      "Reading is useful."
    ],
    [
      "writing",
      "yozish",
      "Writing helps grammar."
    ],
    [
      "speaking",
      "gapirish",
      "Speaking is important."
    ],
    [
      "listening",
      "tinglash",
      "Listening improves pronunciation."
    ],
    [
      "learning",
      "o‘rganish",
      "Learning English takes time."
    ],
    [
      "to learn",
      "o‘rganmoq",
      "I want to learn English."
    ],
    [
      "to study",
      "o‘qimoq",
      "She needs to study."
    ],
    [
      "to go",
      "bormoq",
      "We decided to go."
    ],
    [
      "to help",
      "yordam bermoq",
      "He offered to help."
    ],
    [
      "enjoy",
      "zavqlanmoq",
      "I enjoy playing football."
    ],
    [
      "finish",
      "tugatmoq",
      "She finished doing homework."
    ],
    [
      "keep",
      "davom ettirmoq",
      "Keep trying."
    ],
    [
      "avoid",
      "chetlab o‘tmoq",
      "Avoid making mistakes."
    ],
    [
      "mind",
      "qarshi bo‘lmoq",
      "Do you mind opening the window?"
    ],
    [
      "suggest",
      "taklif qilmoq",
      "He suggested going home."
    ],
    [
      "want",
      "xohlamoq",
      "I want to sleep."
    ],
    [
      "need",
      "kerak bo‘lmoq",
      "You need to practice."
    ],
    [
      "decide",
      "qaror qilmoq",
      "They decided to leave."
    ],
    [
      "hope",
      "umid qilmoq",
      "I hope to pass."
    ],
    [
      "plan",
      "reja qilmoq",
      "We plan to travel."
    ],
    [
      "promise",
      "va’da bermoq",
      "She promised to call."
    ],
    [
      "learn how to",
      "qanday qilishni o‘rganmoq",
      "Learn how to write sentences."
    ],
    [
      "be good at",
      "yaxshi bo‘lmoq",
      "He is good at drawing."
    ],
    [
      "be interested in",
      "qiziqmoq",
      "She is interested in learning."
    ],
    [
      "after preposition",
      "predlogdan keyin",
      "Use gerund after a preposition."
    ],
    [
      "without",
      "siz / -masdan",
      "He left without saying goodbye."
    ],
    [
      "before",
      "oldin",
      "Check before sending."
    ],
    [
      "after",
      "keyin",
      "Rest after studying."
    ]
  ],
  "PASSIVE_VOICE": [
    [
      "passive voice",
      "majhul nisbat",
      "The room is cleaned every day."
    ],
    [
      "be + V3",
      "be + uchinchi shakl",
      "Passive uses be + V3."
    ],
    [
      "is made",
      "tayyorlanadi",
      "Bread is made from flour."
    ],
    [
      "are used",
      "ishlatiladi",
      "Computers are used at school."
    ],
    [
      "was built",
      "qurilgan edi",
      "This school was built in 2010."
    ],
    [
      "were invited",
      "taklif qilingan edi",
      "We were invited to the party."
    ],
    [
      "by",
      "tomonidan",
      "The book was written by Ali."
    ],
    [
      "agent",
      "bajaruvchi",
      "The agent can come after by."
    ],
    [
      "object",
      "obyekt",
      "The object becomes the subject."
    ],
    [
      "subject",
      "ega",
      "The subject receives the action."
    ],
    [
      "made",
      "tayyorlangan",
      "This phone is made in China."
    ],
    [
      "written",
      "yozilgan",
      "The letter was written yesterday."
    ],
    [
      "opened",
      "ochilgan",
      "The door was opened."
    ],
    [
      "closed",
      "yopilgan",
      "The shop is closed."
    ],
    [
      "cleaned",
      "tozalangan",
      "The classroom is cleaned."
    ],
    [
      "built",
      "qurilgan",
      "The bridge was built last year."
    ],
    [
      "spoken",
      "gapiriladigan",
      "English is spoken in many countries."
    ],
    [
      "known",
      "ma’lum",
      "This rule is known."
    ],
    [
      "sold",
      "sotilgan",
      "Tickets are sold online."
    ],
    [
      "sent",
      "yuborilgan",
      "The message was sent."
    ],
    [
      "received",
      "qabul qilingan",
      "The email was received."
    ],
    [
      "called",
      "atalgan / chaqirilgan",
      "This city is called Bukhara."
    ],
    [
      "chosen",
      "tanlangan",
      "The best answer was chosen."
    ],
    [
      "found",
      "topilgan",
      "The keys were found."
    ],
    [
      "kept",
      "saqlangan",
      "The records are kept here."
    ],
    [
      "reported",
      "xabar qilingan",
      "The problem was reported."
    ],
    [
      "checked",
      "tekshirilgan",
      "The test was checked."
    ],
    [
      "printed",
      "chop etilgan",
      "The document was printed."
    ],
    [
      "designed",
      "dizayn qilingan",
      "The website was designed well."
    ],
    [
      "created",
      "yaratilgan",
      "The account was created."
    ]
  ],
  "RELATIVE_CLAUSES": [
    [
      "who",
      "odam uchun",
      "The man who teaches us is kind."
    ],
    [
      "which",
      "narsa / hayvon uchun",
      "The book which I bought is useful."
    ],
    [
      "that",
      "odam yoki narsa uchun",
      "The phone that I use is new."
    ],
    [
      "where",
      "joy uchun",
      "This is the school where I study."
    ],
    [
      "whose",
      "kimning",
      "The girl whose bag is red is my friend."
    ],
    [
      "when",
      "vaqt uchun",
      "I remember the day when we met."
    ],
    [
      "relative clause",
      "aniqlovchi gap",
      "It gives extra information."
    ],
    [
      "extra information",
      "qo‘shimcha ma’lumot",
      "The clause adds information."
    ],
    [
      "person",
      "odam",
      "Use who for a person."
    ],
    [
      "thing",
      "narsa",
      "Use which for a thing."
    ],
    [
      "place",
      "joy",
      "Use where for a place."
    ],
    [
      "owner",
      "egasi",
      "Use whose for possession."
    ],
    [
      "teacher",
      "ustoz",
      "The teacher who helps us is patient."
    ],
    [
      "student",
      "o‘quvchi",
      "The student who won is here."
    ],
    [
      "book",
      "kitob",
      "The book that I read was interesting."
    ],
    [
      "film",
      "film",
      "The film which we watched was funny."
    ],
    [
      "city",
      "shahar",
      "The city where I was born is beautiful."
    ],
    [
      "house",
      "uy",
      "The house where she lives is big."
    ],
    [
      "friend",
      "do‘st",
      "The friend who called me is Ali."
    ],
    [
      "car",
      "mashina",
      "The car that he bought is expensive."
    ],
    [
      "phone",
      "telefon",
      "The phone which I lost was old."
    ],
    [
      "job",
      "ish",
      "The job that she wants is difficult."
    ],
    [
      "reason",
      "sabab",
      "The reason why he left is clear."
    ],
    [
      "main sentence",
      "asosiy gap",
      "The main sentence can stand alone."
    ],
    [
      "clause",
      "gap bo‘lagi",
      "A clause has a subject and verb."
    ],
    [
      "defining",
      "zarur aniqlovchi",
      "It identifies the noun."
    ],
    [
      "non-defining",
      "qo‘shimcha aniqlovchi",
      "It adds extra information."
    ],
    [
      "comma",
      "vergul",
      "Use commas in non-defining clauses."
    ],
    [
      "identify",
      "aniqlamoq",
      "The clause identifies the person."
    ],
    [
      "connect",
      "bog‘lamoq",
      "Relative words connect ideas."
    ]
  ],
  "REPORTED_SPEECH": [
    [
      "reported speech",
      "ko‘chirma emas, aytilgan gap",
      "He said that he was tired."
    ],
    [
      "direct speech",
      "bevosita nutq",
      "He said, “I am tired.”"
    ],
    [
      "said",
      "dedi",
      "She said she was happy."
    ],
    [
      "told",
      "aytdi / dedi",
      "He told me the answer."
    ],
    [
      "that",
      "deb",
      "She said that she was busy."
    ],
    [
      "backshift",
      "zamon orqaga siljishi",
      "Present often changes to past."
    ],
    [
      "I am → he was",
      "men ...man → u ...edi",
      "He said he was ready."
    ],
    [
      "do → did",
      "qiladi → qildi",
      "She said she did homework."
    ],
    [
      "will → would",
      "will → would",
      "He said he would call."
    ],
    [
      "can → could",
      "can → could",
      "She said she could help."
    ],
    [
      "my → his/her",
      "mening → uning",
      "He said his phone was new."
    ],
    [
      "here → there",
      "bu yerda → u yerda",
      "She said she lived there."
    ],
    [
      "now → then",
      "hozir → o‘sha paytda",
      "He said he was busy then."
    ],
    [
      "today → that day",
      "bugun → o‘sha kuni",
      "She said she was working that day."
    ],
    [
      "yesterday → the day before",
      "kecha → oldingi kuni",
      "He said he had called the day before."
    ],
    [
      "tomorrow → the next day",
      "ertaga → keyingi kuni",
      "She said she would come the next day."
    ],
    [
      "ask",
      "so‘ramoq",
      "He asked a question."
    ],
    [
      "answer",
      "javob bermoq",
      "She answered that she knew."
    ],
    [
      "promise",
      "va’da bermoq",
      "He promised to help."
    ],
    [
      "explain",
      "tushuntirmoq",
      "The teacher explained the rule."
    ],
    [
      "report",
      "xabar bermoq",
      "They reported the problem."
    ],
    [
      "message",
      "xabar",
      "The message was reported."
    ],
    [
      "question",
      "savol",
      "Reported questions change order."
    ],
    [
      "statement",
      "darak gap",
      "Reported statements often use that."
    ],
    [
      "order",
      "buyruq",
      "He told me to sit down."
    ],
    [
      "request",
      "iltimos",
      "She asked me to help."
    ],
    [
      "advise",
      "maslahat bermoq",
      "He advised me to study."
    ],
    [
      "warn",
      "ogohlantirmoq",
      "They warned us to be careful."
    ],
    [
      "claim",
      "da’vo qilmoq",
      "He claimed he was right."
    ],
    [
      "mention",
      "aytib o‘tmoq",
      "She mentioned the test."
    ]
  ],
  "MODAL_VERBS": [
    [
      "can",
      "qila olmoq",
      "I can swim."
    ],
    [
      "could",
      "qila olardi / iltimos",
      "Could you help me?"
    ],
    [
      "may",
      "mumkin / ehtimol",
      "May I come in?"
    ],
    [
      "might",
      "ehtimol",
      "It might rain."
    ],
    [
      "must",
      "shart / kerak",
      "You must stop."
    ],
    [
      "have to",
      "majbur",
      "I have to work."
    ],
    [
      "should",
      "kerak / maslahat",
      "You should sleep."
    ],
    [
      "would",
      "xohlar edi",
      "I would like tea."
    ],
    [
      "will",
      "kelajak / xohish",
      "I will help you."
    ],
    [
      "shall",
      "taklif / rasmiy kelajak",
      "Shall we start?"
    ],
    [
      "ability",
      "qobiliyat",
      "Can shows ability."
    ],
    [
      "permission",
      "ruxsat",
      "May asks permission."
    ],
    [
      "possibility",
      "imkoniyat",
      "Might shows possibility."
    ],
    [
      "obligation",
      "majburiyat",
      "Must shows obligation."
    ],
    [
      "advice",
      "maslahat",
      "Should gives advice."
    ],
    [
      "request",
      "iltimos",
      "Could is polite for requests."
    ],
    [
      "offer",
      "taklif",
      "Would you like coffee?"
    ],
    [
      "prediction",
      "taxmin",
      "It will be cold."
    ],
    [
      "certainty",
      "aniqlik",
      "He must be tired."
    ],
    [
      "prohibition",
      "taqiq",
      "You mustn’t smoke."
    ],
    [
      "not allowed",
      "ruxsat yo‘q",
      "You may not enter."
    ],
    [
      "be able to",
      "qila olmoq",
      "He is able to drive."
    ],
    [
      "ought to",
      "kerak",
      "You ought to apologize."
    ],
    [
      "needn’t",
      "shart emas",
      "You needn’t come."
    ],
    [
      "used to",
      "oldin odat",
      "I used to play."
    ],
    [
      "had better",
      "yaxshisi",
      "You had better hurry."
    ],
    [
      "modal + V1",
      "modal + asosiy fe’l",
      "He can play."
    ],
    [
      "no -s after modal",
      "modaldan keyin -s yo‘q",
      "She can plays is wrong."
    ],
    [
      "negative modal",
      "modal inkor",
      "Cannot, must not, should not."
    ],
    [
      "question modal",
      "modal savol",
      "Can you help?"
    ]
  ],
  "LINKING_WORDS": [
    [
      "and",
      "va",
      "I like tea and coffee."
    ],
    [
      "but",
      "lekin",
      "It is small but useful."
    ],
    [
      "because",
      "chunki",
      "I stayed home because I was tired."
    ],
    [
      "so",
      "shuning uchun",
      "It was late, so we left."
    ],
    [
      "although",
      "garchi",
      "Although it rained, we went out."
    ],
    [
      "however",
      "biroq",
      "It was difficult. However, we finished."
    ],
    [
      "therefore",
      "shu sababli",
      "He was ill; therefore, he stayed home."
    ],
    [
      "also",
      "shuningdek",
      "She also speaks Russian."
    ],
    [
      "too",
      "ham",
      "I like English too."
    ],
    [
      "as well",
      "ham",
      "He plays football as well."
    ],
    [
      "first",
      "birinchidan",
      "First, read the question."
    ],
    [
      "then",
      "keyin",
      "Then write the answer."
    ],
    [
      "after that",
      "undan keyin",
      "After that, check your work."
    ],
    [
      "finally",
      "nihoyat",
      "Finally, submit the test."
    ],
    [
      "for example",
      "masalan",
      "For example, use simple words."
    ],
    [
      "such as",
      "kabi",
      "I like fruits such as apples."
    ],
    [
      "in addition",
      "qo‘shimcha ravishda",
      "In addition, practice speaking."
    ],
    [
      "on the other hand",
      "boshqa tomondan",
      "On the other hand, it is expensive."
    ],
    [
      "in contrast",
      "aksincha",
      "In contrast, this one is cheap."
    ],
    [
      "while",
      "esa / paytda",
      "I like tea while he likes coffee."
    ],
    [
      "whereas",
      "holbuki",
      "She is quiet whereas he is loud."
    ],
    [
      "before",
      "oldin",
      "Check before you send."
    ],
    [
      "after",
      "keyin",
      "Rest after you study."
    ],
    [
      "when",
      "qachon",
      "Call me when you arrive."
    ],
    [
      "if",
      "agar",
      "If you need help, ask."
    ],
    [
      "unless",
      "agar ...masa",
      "We will go unless it rains."
    ],
    [
      "since",
      "chunki / beri",
      "Since it is late, we should go."
    ],
    [
      "as a result",
      "natijada",
      "He studied hard; as a result, he passed."
    ],
    [
      "in conclusion",
      "xulosa qilib",
      "In conclusion, grammar needs practice."
    ]
  ],
  "PHRASAL_VERBS": [
    [
      "get up",
      "uyg‘onib turmoq",
      "I get up at seven."
    ],
    [
      "wake up",
      "uyg‘onmoq",
      "She wakes up early."
    ],
    [
      "turn on",
      "yoqmoq",
      "Turn on the light."
    ],
    [
      "turn off",
      "o‘chirmoq",
      "Turn off the phone."
    ],
    [
      "look for",
      "qidirmoq",
      "I am looking for my keys."
    ],
    [
      "look after",
      "g‘amxo‘rlik qilmoq",
      "She looks after her brother."
    ],
    [
      "look up",
      "lug‘atdan qaramoq",
      "Look up this word."
    ],
    [
      "write down",
      "yozib olmoq",
      "Write down the answer."
    ],
    [
      "fill in",
      "to‘ldirmoq",
      "Fill in the form."
    ],
    [
      "give up",
      "taslim bo‘lmoq",
      "Do not give up."
    ],
    [
      "come back",
      "qaytib kelmoq",
      "Come back later."
    ],
    [
      "go out",
      "tashqariga chiqmoq",
      "We go out on Sundays."
    ],
    [
      "come in",
      "ichkariga kirmoq",
      "Come in, please."
    ],
    [
      "sit down",
      "o‘tirmoq",
      "Sit down here."
    ],
    [
      "stand up",
      "turmoq",
      "Stand up, please."
    ],
    [
      "pick up",
      "olmoq / ko‘tarib olmoq",
      "Pick up your bag."
    ],
    [
      "put on",
      "kiymoq",
      "Put on your coat."
    ],
    [
      "take off",
      "yechmoq",
      "Take off your shoes."
    ],
    [
      "try on",
      "kiyib ko‘rmoq",
      "Try on this jacket."
    ],
    [
      "find out",
      "bilib olmoq",
      "Find out the answer."
    ],
    [
      "check in",
      "ro‘yxatdan o‘tmoq",
      "Check in at the hotel."
    ],
    [
      "check out",
      "chiqib ketmoq",
      "Check out at eleven."
    ],
    [
      "run out of",
      "tugab qolmoq",
      "We ran out of time."
    ],
    [
      "look forward to",
      "intizor bo‘lmoq",
      "I look forward to the lesson."
    ],
    [
      "put away",
      "joyiga qo‘ymoq",
      "Put away your books."
    ],
    [
      "throw away",
      "tashlab yubormoq",
      "Throw away old papers."
    ],
    [
      "turn down",
      "pasaytirmoq / rad etmoq",
      "Turn down the music."
    ],
    [
      "turn up",
      "baland qilmoq / paydo bo‘lmoq",
      "Turn up the volume."
    ],
    [
      "grow up",
      "ulg‘aymoq",
      "He grew up in Tashkent."
    ],
    [
      "bring back",
      "qaytarib olib kelmoq",
      "Bring back my book."
    ]
  ],
  "SPEAKING_OPINIONS": [
    [
      "opinion",
      "fikr",
      "In my opinion, this is useful."
    ],
    [
      "in my opinion",
      "mening fikrimcha",
      "In my opinion, English is important."
    ],
    [
      "I think",
      "menimcha",
      "I think this answer is correct."
    ],
    [
      "I believe",
      "men ishonamanki",
      "I believe practice helps."
    ],
    [
      "I agree",
      "roziman",
      "I agree with you."
    ],
    [
      "I disagree",
      "rozi emasman",
      "I disagree with that idea."
    ],
    [
      "reason",
      "sabab",
      "Give a reason for your opinion."
    ],
    [
      "example",
      "misol",
      "Give an example."
    ],
    [
      "for example",
      "masalan",
      "For example, students need practice."
    ],
    [
      "because",
      "chunki",
      "I like it because it is simple."
    ],
    [
      "maybe",
      "balki",
      "Maybe this is better."
    ],
    [
      "probably",
      "ehtimol",
      "It is probably true."
    ],
    [
      "definitely",
      "aniq",
      "This is definitely important."
    ],
    [
      "important",
      "muhim",
      "Education is important."
    ],
    [
      "useful",
      "foydali",
      "This method is useful."
    ],
    [
      "difficult",
      "qiyin",
      "Speaking can be difficult."
    ],
    [
      "easy",
      "oson",
      "This topic is easy."
    ],
    [
      "interesting",
      "qiziqarli",
      "The lesson is interesting."
    ],
    [
      "boring",
      "zerikarli",
      "Long texts can be boring."
    ],
    [
      "advantage",
      "ustunlik",
      "One advantage is speed."
    ],
    [
      "disadvantage",
      "kamchilik",
      "One disadvantage is cost."
    ],
    [
      "problem",
      "muammo",
      "The main problem is time."
    ],
    [
      "solution",
      "yechim",
      "A good solution is practice."
    ],
    [
      "compare",
      "solishtirmoq",
      "Compare two ideas."
    ],
    [
      "prefer",
      "afzal ko‘rmoq",
      "I prefer online lessons."
    ],
    [
      "support",
      "qo‘llab-quvvatlamoq",
      "I support this idea."
    ],
    [
      "against",
      "qarshi",
      "I am against this rule."
    ],
    [
      "conclusion",
      "xulosa",
      "Give a short conclusion."
    ],
    [
      "firstly",
      "birinchidan",
      "Firstly, it saves time."
    ],
    [
      "secondly",
      "ikkinchidan",
      "Secondly, it is cheap."
    ]
  ],
  "COMPARATIVES": [
    [
      "bigger",
      "kattaroq",
      "This room is bigger."
    ],
    [
      "smaller",
      "kichikroq",
      "My bag is smaller."
    ],
    [
      "taller",
      "balandroq",
      "Ali is taller than me."
    ],
    [
      "shorter",
      "pastroq / qisqaroq",
      "This pencil is shorter."
    ],
    [
      "older",
      "kattaroq / eskiroq",
      "My brother is older."
    ],
    [
      "younger",
      "yoshroq",
      "She is younger than me."
    ],
    [
      "faster",
      "tezroq",
      "A car is faster than a bike."
    ],
    [
      "slower",
      "sekinroq",
      "This bus is slower."
    ],
    [
      "cheaper",
      "arzonroq",
      "This phone is cheaper."
    ],
    [
      "more expensive",
      "qimmatroq",
      "That laptop is more expensive."
    ],
    [
      "easier",
      "osonroq",
      "This test is easier."
    ],
    [
      "more difficult",
      "qiyinroq",
      "Grammar is more difficult today."
    ],
    [
      "better",
      "yaxshiroq",
      "This answer is better."
    ],
    [
      "worse",
      "yomonroq",
      "The weather is worse."
    ],
    [
      "hotter",
      "issiqroq",
      "Today is hotter."
    ],
    [
      "colder",
      "sovuqroq",
      "Winter is colder."
    ],
    [
      "cleaner",
      "tozaroq",
      "This room is cleaner."
    ],
    [
      "dirtier",
      "iflosroq",
      "My shoes are dirtier."
    ],
    [
      "more interesting",
      "qiziqroq",
      "This book is more interesting."
    ],
    [
      "less important",
      "kamroq muhim",
      "This detail is less important."
    ],
    [
      "than",
      "...dan ko‘ra",
      "She is taller than me."
    ],
    [
      "as ... as",
      "...dek",
      "He is as tall as Ali."
    ],
    [
      "not as ... as",
      "...dek emas",
      "This is not as easy as that."
    ],
    [
      "compare",
      "solishtirmoq",
      "Compare the two pictures."
    ],
    [
      "price",
      "narx",
      "Compare the price."
    ],
    [
      "size",
      "o‘lcham",
      "Compare the size."
    ],
    [
      "age",
      "yosh",
      "Compare their age."
    ],
    [
      "speed",
      "tezlik",
      "Compare the speed."
    ],
    [
      "quality",
      "sifat",
      "Compare the quality."
    ],
    [
      "difference",
      "farq",
      "What is the difference?"
    ]
  ],
  "SUPERLATIVES": [
    [
      "the biggest",
      "eng katta",
      "This is the biggest room."
    ],
    [
      "the smallest",
      "eng kichik",
      "That is the smallest bag."
    ],
    [
      "the tallest",
      "eng baland",
      "Ali is the tallest student."
    ],
    [
      "the shortest",
      "eng past / qisqa",
      "This is the shortest answer."
    ],
    [
      "the oldest",
      "eng katta / eng eski",
      "He is the oldest in the family."
    ],
    [
      "the youngest",
      "eng yosh",
      "She is the youngest student."
    ],
    [
      "the fastest",
      "eng tez",
      "This car is the fastest."
    ],
    [
      "the slowest",
      "eng sekin",
      "This bus is the slowest."
    ],
    [
      "the cheapest",
      "eng arzon",
      "This pen is the cheapest."
    ],
    [
      "the most expensive",
      "eng qimmat",
      "This laptop is the most expensive."
    ],
    [
      "the easiest",
      "eng oson",
      "This exercise is the easiest."
    ],
    [
      "the most difficult",
      "eng qiyin",
      "This topic is the most difficult."
    ],
    [
      "the best",
      "eng yaxshi",
      "This is the best answer."
    ],
    [
      "the worst",
      "eng yomon",
      "That was the worst day."
    ],
    [
      "the hottest",
      "eng issiq",
      "July is the hottest month."
    ],
    [
      "the coldest",
      "eng sovuq",
      "January is the coldest month."
    ],
    [
      "the cleanest",
      "eng toza",
      "This is the cleanest room."
    ],
    [
      "the dirtiest",
      "eng iflos",
      "These are the dirtiest shoes."
    ],
    [
      "the most interesting",
      "eng qiziqarli",
      "This is the most interesting story."
    ],
    [
      "the least important",
      "eng kam muhim",
      "This is the least important point."
    ],
    [
      "in the class",
      "sinfda",
      "He is the tallest in the class."
    ],
    [
      "in the world",
      "dunyoda",
      "It is the biggest in the world."
    ],
    [
      "of all",
      "hammasidan",
      "This is the best of all."
    ],
    [
      "choose",
      "tanlamoq",
      "Choose the best answer."
    ],
    [
      "record",
      "rekord",
      "He broke the record."
    ],
    [
      "rank",
      "daraja / o‘rin",
      "What is the rank?"
    ],
    [
      "first place",
      "birinchi o‘rin",
      "She is in first place."
    ],
    [
      "last place",
      "oxirgi o‘rin",
      "They are in last place."
    ],
    [
      "group",
      "guruh",
      "Who is the youngest in the group?"
    ],
    [
      "category",
      "toifa",
      "Choose the best in each category."
    ]
  ]
};

function normalizeVocabularyBankKey(value = '') {
  return String(value || '')
    .toUpperCase()
    .replace(/[’‘`]/g, "'")
    .replace(/CAN'T/g, 'CANT')
    .replace(/CAN’T/g, 'CANT')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function resolveEnglishVocabularyBankKey(title = '') {
  const key = normalizeVocabularyBankKey(title);
  if (ENGLISH_TOPIC_VOCABULARY_BANK[key]) return key;
  const t = String(title || '').toLowerCase().replace(/[’‘`]/g, "'");
  if (t.includes('a / an') || t.includes('article')) return 'A / AN';
  if (t.includes('irregular') && t.includes('plural')) return 'PLURAL_IRREGULAR';
  if (t.includes('plural')) return 'PLURALS_REGULAR';
  if (t.includes('subject pronoun')) return 'SUBJECT_PRONOUN';
  if (t.includes('there is') || t.includes('there are')) return 'THERE_IS_THERE_ARE';
  if (t.includes('have / has') || /have\s*\/\s*has/.test(t) || t === 'have has') return 'HAVE_HAS';
  if (t.includes('can') && !t.includes('modal')) return 'CAN_CANT';
  if (t.includes('who') || t.includes('what')) return 'WHO_WHAT';
  if (t.includes('present simple') && t.includes('continuous')) return 'PRESENT_SIMPLE_CONTINUOUS';
  if (t.includes('present continuous')) return 'PRESENT_CONTINUOUS';
  if (t.includes('present simple')) return 'PRESENT_SIMPLE';
  if (t.includes('preposition') && t.includes('time') && t.includes('place')) return 'PREPOSITION_OF_PLACE';
  if (t.includes('preposition') && t.includes('time')) return 'PREPOSITION_OF_TIME';
  if (t.includes('preposition') && t.includes('place')) return 'PREPOSITION_OF_PLACE';
  if (t.includes('adverb') || t.includes('adjective')) return 'ADJECTIVE_ADVERB';
  if (t.includes('past continuous')) return 'PAST_CONTINUOUS';
  if (t.includes('past simple')) return 'PAST_SIMPLE';
  if (t.includes('future') || t.includes('going to')) return 'FUTURE_GOING_TO';
  if (t.includes('present perfect')) return 'PRESENT_PERFECT';
  if (t.includes('conditional 0') || t.includes('zero conditional')) return 'CONDITIONAL_0';
  if (t.includes('conditional 1') || t.includes('first conditional')) return 'CONDITIONAL_1';
  if (t.includes('second conditional')) return 'CONDITIONAL_1';
  if (t.includes('must') || t.includes('have to')) return 'HAVE_TO_MUST';
  if (t.includes('would') || t.includes('could')) return 'WOULD_COULD';
  if (t.includes('used to')) return 'USED_TO';
  if (t.includes('gerund') || t.includes('infinitive')) return 'GERUND_INFINITIVE';
  if (t.includes('passive')) return 'PASSIVE_VOICE';
  if (t.includes('relative clause')) return 'RELATIVE_CLAUSES';
  if (t.includes('reported speech') || t.includes('indirect speech')) return 'REPORTED_SPEECH';
  if (t.includes('modal')) return 'MODAL_VERBS';
  if (t.includes('linking') || t.includes('connector')) return 'LINKING_WORDS';
  if (t.includes('phrasal')) return 'PHRASAL_VERBS';
  if (t.includes('opinion') || t.includes('debate')) return 'SPEAKING_OPINIONS';
  if (t.includes('comparative')) return 'COMPARATIVES';
  if (t.includes('superlative')) return 'SUPERLATIVES';
  if (t.includes('to be')) return 'TO BE';
  if (t.includes('alphabet') || t.includes('alfabit')) return 'ALFABIT';
  return '';
}


const ESSENTIAL_SINGLE_WORD_VOCABULARY_POOL = [
  ['ability','qobiliyat',''], ['able','qodir',''], ['accept','qabulqilmoq',''], ['accident','hodisa',''], ['action','harakat',''], ['activity','faoliyat',''], ['address','manzil',''], ['adult','kattalar',''], ['advice','maslahat',''], ['afraid','qo‘rqgan',''],
  ['agency','agentlik',''], ['agree','rozi',''], ['air','havo',''], ['allow','ruxsat',''], ['alone','yolg‘iz',''], ['angry','jahldor',''], ['animal','hayvon',''], ['answer','javob',''], ['appear','paydobo‘lmoq',''], ['apple','olma',''],
  ['area','hudud',''], ['arrive','kelmoq',''], ['artist','rassom',''], ['attack','hujum',''], ['attention','e’tibor',''], ['autumn','kuz',''], ['baby','chaqaloq',''], ['bad','yomon',''], ['bank','bank',''], ['basic','asosiy',''],
  ['beautiful','chiroyli',''], ['begin','boshlamoq',''], ['believe','ishonmoq',''], ['best','engyaxshi',''], ['better','yaxshiroq',''], ['bird','qush',''], ['black','qora',''], ['blood','qon',''], ['blue','ko‘k',''], ['boat','qayiq',''],
  ['body','tana',''], ['book','kitob',''], ['boring','zerikarli',''], ['bottle','shisha',''], ['brave','jasur',''], ['bread','non',''], ['break','sindirmoq',''], ['bright','yorqin',''], ['brother','aka',''], ['brown','jigarrang',''],
  ['build','qurmoq',''], ['busy','band',''], ['butter','sariyog‘',''], ['cake','tort',''], ['call','chaqirmoq',''], ['camera','kamera',''], ['capital','poytaxt',''], ['care','g‘amxo‘rlik',''], ['careful','ehtiyotkor',''], ['carry','ko‘tarmoq',''],
  ['cat','mushuk',''], ['catch','ushlamoq',''], ['cause','sabab',''], ['center','markaz',''], ['chance','imkoniyat',''], ['change','o‘zgartirmoq',''], ['cheap','arzon',''], ['check','tekshirmoq',''], ['child','bola',''], ['choose','tanlamoq',''],
  ['city','shahar',''], ['class','sinf',''], ['clean','toza',''], ['clear','aniq',''], ['clever','aqlli',''], ['climb','ko‘tarilmoq',''], ['close','yopmoq',''], ['cloud','bulut',''], ['cold','sovuq',''], ['color','rang',''],
  ['come','kelmoq',''], ['common','umumiy',''], ['company','kompaniya',''], ['complete','tugatmoq',''], ['computer','kompyuter',''], ['correct','to‘g‘ri',''], ['country','davlat',''], ['course','kurs',''], ['cover','yopmoq',''], ['create','yaratmoq',''],
  ['crowd','olomon',''], ['cry','yig‘lamoq',''], ['culture','madaniyat',''], ['danger','xavf',''], ['dark','qorong‘i',''], ['daughter','qiz',''], ['dead','o‘lik',''], ['deep','chuqur',''], ['degree','daraja',''], ['describe','tasvirlamoq',''],
  ['desk','parta',''], ['develop','rivojlanmoq',''], ['die','o‘lmoq',''], ['different','boshqa',''], ['difficult','qiyin',''], ['dirty','kir',''], ['doctor','shifokor',''], ['dog','it',''], ['door','eshik',''], ['dream','orzu',''],
  ['drink','ichmoq',''], ['drive','haydamoq',''], ['dry','quruq',''], ['early','erta',''], ['earth','yer',''], ['easy','oson',''], ['education','ta’lim',''], ['effect','ta’sir',''], ['egg','tuxum',''], ['empty','bo‘sh',''],
  ['enjoy','rohatlanmoq',''], ['enough','yetarli',''], ['enter','kirmoq',''], ['equal','teng',''], ['escape','qochmoq',''], ['evening','kechqurun',''], ['event','voqea',''], ['exam','imtihon',''], ['example','misol',''], ['excited','hayajonli',''],
  ['exercise','mashq',''], ['expect','kutmoq',''], ['expensive','qimmat',''], ['explain','tushuntirmoq',''], ['eye','ko‘z',''], ['face','yuz',''], ['fact','fakt',''], ['family','oila',''], ['famous','mashhur',''], ['fast','tez',''],
  ['father','ota',''], ['fear','qo‘rquv',''], ['field','dala',''], ['fight','kurashmoq',''], ['film','film',''], ['final','yakuniy',''], ['find','topmoq',''], ['fire','olov',''], ['fish','baliq',''], ['floor','pol',''],
  ['flower','gul',''], ['food','ovqat',''], ['forest','o‘rmon',''], ['forget','unutmoq',''], ['free','bo‘sh',''], ['friend','do‘st',''], ['front','old',''], ['fruit','meva',''], ['funny','kulgili',''], ['garden','bog‘',''],
  ['gate','darvoza',''], ['girl','qiz',''], ['give','bermoq',''], ['glass','stakan',''], ['gold','oltin',''], ['good','yaxshi',''], ['grade','baho',''], ['grass','o‘t',''], ['great','buyuk',''], ['green','yashil',''],
  ['group','guruh',''], ['grow','o‘smoq',''], ['guess','taxmin',''], ['guide','yo‘lko‘rsatmoq',''], ['happy','xursand',''], ['hard','qattiq',''], ['hate','yomonko‘rmoq',''], ['head','bosh',''], ['health','sog‘liq',''], ['hear','eshitmoq',''],
  ['heavy','og‘ir',''], ['help','yordam',''], ['hide','yashirmoq',''], ['high','baland',''], ['history','tarix',''], ['hold','ushlamoq',''], ['home','uy',''], ['hope','umid',''], ['hospital','shifoxona',''], ['hour','soat',''],
  ['house','uy',''], ['hungry','och',''], ['idea','g‘oya',''], ['important','muhim',''], ['inside','ichida',''], ['interest','qiziqish',''], ['island','orol',''], ['join','qo‘shilmoq',''], ['journey','sayohat',''], ['judge','hakam',''],
  ['kind','mehribon',''], ['king','qirol',''], ['kitchen','oshxona',''], ['know','bilmoq',''], ['lake','ko‘l',''], ['language','til',''], ['large','katta',''], ['late','kech',''], ['laugh','kulmoq',''], ['learn','o‘rganmoq',''],
  ['leave','ketmoq',''], ['lesson','dars',''], ['letter','harf',''], ['life','hayot',''], ['light','yorug‘lik',''], ['listen','tinglamoq',''], ['little','kichik',''], ['live','yashamoq',''], ['long','uzun',''], ['look','qaramoq',''],
  ['love','sevmoq',''], ['lucky','omadli',''], ['market','bozor',''], ['meal','ovqat',''], ['mean','anglatmoq',''], ['message','xabar',''], ['middle','o‘rta',''], ['minute','daqiqa',''], ['mistake','xato',''], ['money','pul',''],
  ['month','oy',''], ['mother','ona',''], ['mountain','tog‘',''], ['movie','kino',''], ['music','musiqa',''], ['narrow','tor',''], ['nature','tabiat',''], ['near','yaqin',''], ['need','kerak',''], ['never','hechqachon',''],
  ['night','tun',''], ['noise','shovqin',''], ['normal','oddiy',''], ['north','shimol',''], ['notice','sezmoq',''], ['number','raqam',''], ['object','narsa',''], ['office','ofis',''], ['open','ochmoq',''], ['orange','apelsin',''],
  ['order','buyruq',''], ['outside','tashqarida',''], ['page','sahifa',''], ['paint','bo‘yamoq',''], ['paper','qog‘oz',''], ['parent','otaona',''], ['park','bog‘',''], ['party','ziyofat',''], ['pass','o‘tmoq',''], ['patient','bemor',''],
  ['pay','to‘lamoq',''], ['peace','tinchlik',''], ['people','odamlar',''], ['phone','telefon',''], ['place','joy',''], ['plan','reja',''], ['plant','o‘simlik',''], ['play','o‘ynamoq',''], ['police','politsiya',''], ['poor','kambag‘al',''],
  ['possible','mumkin',''], ['power','kuch',''], ['practice','mashq',''], ['prepare','tayyorlamoq',''], ['present','sovg‘a',''], ['problem','muammo',''], ['protect','himoya',''], ['proud','faxrli',''], ['question','savol',''], ['quick','tez',''],
  ['quiet','tinch',''], ['rain','yomg‘ir',''], ['ready','tayyor',''], ['real','haqiqiy',''], ['reason','sabab',''], ['red','qizil',''], ['remember','eslamoq',''], ['reply','javob',''], ['result','natija',''], ['rich','boy',''],
  ['right','to‘g‘ri',''], ['river','daryo',''], ['road','yo‘l',''], ['room','xona',''], ['round','dumaloq',''], ['safe','xavfsiz',''], ['school','maktab',''], ['science','fan',''], ['sea','dengiz',''], ['search','qidirmoq',''],
  ['season','fasl',''], ['second','ikkinchi',''], ['secret','sir',''], ['see','ko‘rmoq',''], ['sell','sotmoq',''], ['send','yubormoq',''], ['sentence','gap',''], ['shape','shakl',''], ['share','bo‘lishmoq',''], ['short','qisqa',''],
  ['show','ko‘rsatmoq',''], ['sick','kasal',''], ['simple','sodda',''], ['sing','kuylamoq',''], ['sister','opa',''], ['sleep','uxlamoq',''], ['slow','sekin',''], ['small','kichik',''], ['smile','tabassum',''], ['snow','qor',''],
  ['solve','yechmoq',''], ['sound','tovush',''], ['south','janub',''], ['space','joy',''], ['speak','gapirmoq',''], ['special','maxsus',''], ['spring','bahor',''], ['stand','turmoq',''], ['start','boshlamoq',''], ['story','hikoya',''],
  ['strong','kuchli',''], ['student','o‘quvchi',''], ['study','o‘qimoq',''], ['summer','yoz',''], ['table','stol',''], ['teacher','ustoz',''], ['team','jamoa',''], ['test','test',''], ['thirsty','chanqagan',''], ['thought','fikr',''],
  ['time','vaqt',''], ['today','bugun',''], ['travel','sayohat',''], ['tree','daraxt',''], ['true','rost',''], ['understand','tushunmoq',''], ['use','ishlatmoq',''], ['useful','foydali',''], ['village','qishloq',''], ['voice','ovoz',''],
  ['wait','kutmoq',''], ['walk','yurmoq',''], ['warm','iliq',''], ['water','suv',''], ['week','hafta',''], ['white','oq',''], ['window','deraza',''], ['winter','qish',''], ['woman','ayol',''], ['word','so‘z',''],
  ['work','ishlamoq',''], ['world','dunyo',''], ['write','yozmoq',''], ['wrong','noto‘g‘ri',''], ['yellow','sariq',''], ['young','yosh','']
];

function makeEssentialSingleWordVocabulary(title = '') {
  const cleanTitle = String(title || 'topic');
  let hash = 0;
  for (const ch of cleanTitle) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const pool = ESSENTIAL_SINGLE_WORD_VOCABULARY_POOL;
  const used = new Set();
  const out = [];
  let index = hash % pool.length;
  while (out.length < VOCABULARY_ITEM_COUNT && used.size < pool.length) {
    const item = pool[index % pool.length];
    index += 7;
    const word = String(item[0] || '').trim();
    if (/^[A-Za-z]+$/.test(word) && !used.has(word.toLowerCase())) {
      used.add(word.toLowerCase());
      out.push([word, item[1] || 'muhim so‘z', '']);
    }
  }
  return out.slice(0, VOCABULARY_ITEM_COUNT);
}

function makeUniqueTopicFallback(title = '') {
  const clean = String(title || 'English topic').trim() || 'English topic';
  const base = clean.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() || 'english topic';
  const short = base.split(' ').slice(0, 3).join(' ');
  return [
    [`${short} pattern`, `${clean} qolipi`, `Learn the ${clean} pattern.`],
    [`${short} example`, `${clean} misoli`, `Make one ${clean} example.`],
    [`${short} sentence`, `${clean} gapi`, `Write a ${clean} sentence.`],
    [`${short} question`, `${clean} savoli`, `Ask a ${clean} question.`],
    [`${short} negative`, `${clean} inkor shakli`, `Make a negative ${clean} sentence.`],
    [`${short} answer`, `${clean} javobi`, `Give a short answer.`],
    [`${short} marker`, `${clean} belgisi`, `Find the marker in the sentence.`],
    [`${short} usage`, `${clean} ishlatilishi`, `Use it in a real sentence.`],
    [`${short} contrast`, `${clean} farqi`, `Compare it with another form.`],
    [`${short} review`, `${clean} takrorlash`, `Review this topic.`],
    [`${short} speaking`, `${clean} speaking`, `Say one sentence aloud.`],
    [`${short} writing`, `${clean} writing`, `Write two examples.`],
    [`${short} listening`, `${clean} listening`, `Listen and repeat.`],
    [`${short} grammar`, `${clean} grammatikasi`, `Check the grammar carefully.`],
    [`${short} mistake`, `${clean} xatosi`, `Correct the mistake.`],
    [`${short} practice`, `${clean} mashqi`, `Practice the topic again.`],
    [`${short} clue`, `${clean} belgisi`, `Use the clue to choose the answer.`],
    [`${short} form`, `${clean} shakli`, `Choose the correct form.`],
    [`${short} rule`, `${clean} qoidasi`, `Read the rule first.`],
    [`${short} meaning`, `${clean} ma’nosi`, `Understand the meaning in context.`],
    [`${short} context`, `${clean} konteksti`, `Read the context.`],
    [`${short} note`, `${clean} eslatmasi`, `Remember the short note.`],
    [`${short} mini test`, `${clean} mini testi`, `Try the mini test.`],
    [`${short} correction`, `${clean} tuzatish`, `Correct the sentence.`],
    [`${short} final check`, `${clean} yakuniy tekshiruv`, `Check your final answer.`]
  ];
}

function topicVocabularyExtras(language, title) {
  if (language === 'english') {
    return makeEssentialSingleWordVocabulary(title);
  }
  return [];
}

function normalizeTerms(profile, language, title) {
  const defaults = {
    english: [
      ['subject', 'ega', 'The subject comes before the verb.'], ['verb', 'fe’l', 'Choose the correct verb form.'], ['object', 'to‘ldiruvchi', 'The object receives the action.'], ['question', 'savol', 'Make a question with the correct order.'], ['negative', 'inkor shakl', 'Use not in a negative sentence.'], ['sentence', 'gap', 'Write a complete sentence.']
    ],
    russia: [
      ['подлежащее', 'ega', 'Подлежащее стоит в начале предложения.'], ['сказуемое', 'kesim', 'Сказуемое показывает действие.'], ['вопрос', 'savol', 'Задайте вопрос правильно.'], ['форма', 'shakl', 'Выберите правильную форму.'], ['окончание', 'qo‘shimcha', 'Окончание меняет значение слова.'], ['предложение', 'gap', 'Составьте предложение.']
    ],
    koreys: [
      ['주어', 'ega', '주어는 문장의 주인공입니다.'], ['동사', 'fe’l', '동사는 문장 끝에 옵니다.'], ['조사', 'ko‘makchi qo‘shimcha', '조사는 단어 뒤에 붙습니다.'], ['문장', 'gap', '문장을 완성하세요.'], ['질문', 'savol', '질문을 만드세요.'], ['어미', 'fe’l yakuni', '어미는 말투를 바꿉니다.']
    ],
    ona_tili: [
      ['ega', 'gapning bosh bo‘lagi', 'Ega kim? nima? so‘roqlariga javob beradi.'], ['kesim', 'gapning bosh bo‘lagi', 'Kesim nima qildi? qanday? so‘roqlariga javob beradi.'], ['ot', 'shaxs, narsa, joy nomi', 'Maktab, kitob, o‘quvchi — ot.'], ['sifat', 'belgi bildiradi', 'Katta, chiroyli, bilimli — sifat.'], ['fe’l', 'harakat yoki holat bildiradi', 'O‘qidi, yozdi, keldi — fe’l.'], ['imlo', 'to‘g‘ri yozish qoidalari', 'Imlo savodxonlik uchun muhim.']
    ],
    tarix: [
      ['xronologiya', 'vaqt tartibi', 'Xronologiya voqealarni yillar bo‘yicha tartiblaydi.'], ['manba', 'tarixiy dalil', 'Manba voqea haqida ma’lumot beradi.'], ['sabab', 'voqea boshlanishiga ta’sir qilgan omil', 'Sababni bilsak, voqeani tushunamiz.'], ['oqibat', 'voqeadan keyingi natija', 'Oqibat tarixiy jarayonni ko‘rsatadi.'], ['davlat', 'boshqaruv tizimi', 'Davlat qonun va boshqaruvga ega bo‘ladi.'], ['madaniyat', 'xalqning moddiy va ma’naviy boyligi', 'Madaniyat tarixda muhim o‘rin tutadi.']
    ]
  };
  const seen = new Set();
  const out = [];
  const topicSpecificVocabulary = topicVocabularyExtras(language, title);
  const sources = language === 'english'
    ? [
        ...topicSpecificVocabulary,
        ...(profile.terms || []),
        ...(defaults[language] || defaults.english),
        ...(vocabSets[language] || vocabSets.english)
      ]
    : [
        ...(profile.terms || []),
        ...(defaults[language] || defaults.english),
        ...(vocabSets[language] || vocabSets.english)
      ];
  for (const item of sources) {
    const arr = Array.isArray(item) ? item : [item.word, item.meaning, item.example];
    const word = String(arr[0] || '').trim();
    if (!word) continue;
    const key = word.toLowerCase().replace(/[’‘`]/g, "'");
    if (language === 'english' && ENGLISH_VOCABULARY_EXCLUDE.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(topicTerm(word, arr[1] || 'muhim so‘z', typeof arr[2] === 'string' ? arr[2] : ''));
    if (out.length >= VOCABULARY_ITEM_COUNT) break;
  }
  while (out.length < VOCABULARY_ITEM_COUNT) {
    const n = out.length + 1;
    out.push(topicTerm(`word${n}`, `muhim so‘z ${n}`, ''));
  }
  return out.slice(0, VOCABULARY_ITEM_COUNT);
}
function englishProfile(title, level) {
  const essentialStyleProfile = getEssentialStyleEnglishProfile(title);
  if (essentialStyleProfile) return essentialStyleProfile;
  const t = title.toLowerCase();
  if (t.includes('to be')) return makeProfile({
    concept: 'To be: am / is / are',
    core: 'To be ingliz tilida “bo‘lmoq”, “-man”, “-san”, “-dir” ma’nosini beradi. U ega kim yoki nima ekanini, holatini, yoshini va joylashuvini aytish uchun ishlatiladi.',
    structure: 'I + am; he/she/it + is; you/we/they + are. Inkor gapda am/is/are dan keyin not keladi. Savolda am/is/are gap boshiga chiqadi.',
    usage: 'Kasb, holat, millat, yosh, joylashuv va sifatni aytishda ishlatiladi: I am a student, She is happy, They are at school.',
    nuance: 'O‘zbek tilida “Men o‘quvchiman” gapida alohida fe’l ko‘rinmaydi, lekin ingliz tilida “I am a student” bo‘lishi shart. “I student” noto‘g‘ri.',
    mistakes: 'Eng ko‘p xato: I bilan is/are ishlatish, he/she/it bilan are ishlatish, ko‘plik they bilan is ishlatish va savolda so‘z tartibini o‘zgartirmaslik.',
    examples: ['I am a student. / Men o‘quvchiman.', 'She is my teacher. / U mening ustozim.', 'They are friends. / Ular do‘stlar.', 'I am not tired. / Men charchagan emasman.', 'He is not busy. / U band emas.', 'They are not at home. / Ular uyda emas.', 'Is he at home? / U uydami?', 'Are you ready? / Siz tayyormisiz?', 'Are they in the classroom? / Ular sinfxonadami?', 'We are happy today. / Biz bugun xursandmiz.'],
    terms: [['am', 'I bilan ishlatiladigan to be shakli', 'I am ready.'], ['is', 'he/she/it yoki birlik ot bilan ishlatiladi', 'She is kind.'], ['are', 'you/we/they yoki ko‘plik ot bilan ishlatiladi', 'They are students.'], ['not', 'inkor yasaydi', 'He is not here.'], ['subject', 'ega', 'I, he, she, they — subject.'], ['complement', 'gapni to‘ldiruvchi qism', 'I am happy.']],
    checks: [
      ['“Men o‘quvchiman” inglizcha to‘g‘ri shakli qaysi?', ['I am a student.', 'I is a student.', 'I student.', 'I are a student.'], 0, 'I bilan faqat am ishlatiladi.'],
      ['She ___ my sister.', ['am', 'are', 'is', 'be'], 2, 'She bilan is ishlatiladi.'],
      ['They ___ at school.', ['is', 'am', 'be', 'are'], 3, 'They ko‘plik bo‘lgani uchun are keladi.'],
      ['Savol gapni tanlang.', ['You are ready?', 'Are you ready?', 'You ready are?', 'Ready you are?'], 1, 'Savolda to be gap boshiga chiqadi.']
    ]
  });
  if (t.includes('article')) return makeProfile({
    concept: 'Articles: a / an / the',
    core: 'Article ot oldidan kelib, otning umumiy yoki aniq ekanini ko‘rsatadi. A/an — bitta, umumiy narsa; the — suhbatdoshga tanish yoki aniq narsa.',
    structure: 'a + undosh tovush: a book; an + unli tovush: an apple; the + aniq ot: the book on the table.',
    usage: 'Birinchi marta aytilgan bitta narsa uchun a/an ishlatiladi. Ikkinchi marta yoki aniq narsa haqida gapirilsa the ishlatiladi.',
    nuance: 'A/an har doim talaffuz tovushiga qaraydi: an hour, a university. Harf emas, tovush muhim.',
    mistakes: 'Ko‘plik ot bilan a/an ishlatish, sanalmaydigan ot oldidan a/an qo‘yish va aniq narsa oldidan the ni tashlab ketish ko‘p uchraydi.',
    examples: ['I have a pen. / Menda bitta ruchka bor.', 'She eats an apple. / U olma yeydi.', 'The pen is blue. / Ruchka ko‘k.', 'This is a university. / Bu universitet.', 'He is an honest man. / U halol odam.', 'Open the door. / Eshikni oching.'],
    terms: [['article', 'ot oldidagi yordamchi so‘z', 'A/an/the are articles.'], ['a', 'bitta va umumiy narsa', 'a car'], ['an', 'unli tovushdan oldin', 'an egg'], ['the', 'aniq narsa', 'the sun'], ['countable noun', 'sanash mumkin bo‘lgan ot', 'a book'], ['specific noun', 'aniq ot', 'the book']],
    checks: [['___ apple', ['a', 'an'], 1, 'Apple unli tovush bilan boshlanadi, an ishlatiladi.'], ['___ book', ['a', 'an'], 0, 'Book undosh tovush bilan boshlanadi, a ishlatiladi.'], ['___ hour', ['a', 'an'], 1, 'Hour so‘zida h talaffuz qilinmaydi, an ishlatiladi.']]
  });
  if (t.includes('plural')) return makeProfile({
    concept: 'Plural nouns',
    core: 'Plural nouns bitta emas, ikki yoki undan ko‘p narsa/shaxsni bildiradi. Ingliz tilida ko‘plik ko‘pincha -s yoki -es bilan yasaladi.',
    structure: 'Ko‘plik shakllarini to‘g‘ri yozing: books, boxes, cities, children. Ko‘plik ot bilan odatda are, these, those, many ishlatiladi.',
    usage: 'Son, miqdor, ro‘yxat va umumiy guruhlarni aytishda ishlatiladi: two books, many students, these boxes.',
    nuance: 'Ba’zi otlar irregular bo‘ladi: man → men, woman → women, child → children, person → people. Bularni alohida yodlash kerak.',
    mistakes: 'Two book, many student kabi -s ni tashlab ketish; children so‘ziga yana -s qo‘shish; ko‘plik ot bilan is ishlatish xato.',
    examples: ['one book — two books / bitta kitob — ikkita kitob', 'one box — three boxes / bitta quti — uchta quti', 'one child — many children / bitta bola — ko‘p bolalar', 'The students are here. / O‘quvchilar shu yerda.', 'These apples are fresh. / Bu olmalar yangi.', 'My friends are kind. / Do‘stlarim mehribon.'],
    terms: [['singular', 'birlik', 'one book'], ['plural', 'ko‘plik', 'two books'], ['-s ending', '-s qo‘shimchasi', 'cars'], ['-es ending', '-es qo‘shimchasi', 'boxes'], ['irregular plural', 'notekis ko‘plik', 'children'], ['many', 'ko‘p', 'many students']],
    checks: [['“book” so‘zining ko‘plik shakli qaysi?', ['bookes', 'books', 'bookies', 'booken'], 1, 'Oddiy otlarga -s qo‘shiladi.'], ['Qaysi gap to‘g‘ri?', ['Two child are here.', 'Two childs are here.', 'Two children are here.', 'Two children is here.'], 2, 'Child → children, va ko‘plik bilan are.'], ['box ko‘plikda qanday bo‘ladi?', ['boxs', 'boxes', 'boxies', 'boxen'], 1, 'x bilan tugagan otga -es qo‘shiladi.']]
  });
  if (t.includes('this') || t.includes('that') || t.includes('these') || t.includes('those')) return makeProfile({
    concept: 'This / that / these / those',
    core: 'Bu so‘zlar narsaning yaqin-uzoqligi va birlik-ko‘pligini ko‘rsatadi.',
    structure: 'this + singular + is; that + singular + is; these + plural + are; those + plural + are.',
    usage: 'Yaqin bitta narsa uchun this, uzoq bitta narsa uchun that; yaqin ko‘plik uchun these, uzoq ko‘plik uchun those ishlatiladi.',
    nuance: 'This/that birlik, these/those ko‘plik. Shuning uchun “these book” emas, “these books” bo‘ladi.',
    mistakes: 'These is, this are, these book, those apple kabi birlik-ko‘plik moslashuvini buzish ko‘p uchraydi.',
    examples: ['This is my phone. / Bu mening telefonim.', 'That is your bag. / Ana u sening sumkang.', 'These are my books. / Bular mening kitoblarim.', 'Those are our teachers. / Anavilar bizning ustozlarimiz.', 'This room is clean. / Bu xona toza.', 'Those cars are expensive. / Anavi mashinalar qimmat.'],
    terms: [['this', 'bu — yaqin birlik', 'This is a pen.'], ['that', 'u/ana u — uzoq birlik', 'That is a school.'], ['these', 'bular — yaqin ko‘plik', 'These are books.'], ['those', 'ular/anavilar — uzoq ko‘plik', 'Those are cars.'], ['near', 'yaqin', 'This is near.'], ['far', 'uzoq', 'That is far.']],
    checks: [['___ are my books.', ['This', 'That', 'These', 'Is'], 2, 'Books ko‘plik, yaqin bo‘lsa these ishlatiladi.'], ['Uzoqdagi bitta narsani ko‘rsatish uchun qaysi so‘z?', ['this', 'that', 'these', 'those'], 1, 'That — uzoq birlik.'], ['Qaysi gap to‘g‘ri?', ['This are pens.', 'These is pen.', 'These are pens.', 'Those is cars.'], 2, 'These + plural + are.']]
  });
  if (t.includes('present simple')) return makeProfile({
    concept: 'Present Simple',
    core: 'Present Simple odat, doimiy holat, takroriy ish va umumiy haqiqatlarni aytish uchun ishlatiladi.',
    structure: 'I/you/we/they + V1. He/she/it + V+s/es. Inkor: do not / does not + V1. Savol: Do/Does + subject + V1?',
    usage: 'Every day, usually, often, sometimes, always kabi vaqt so‘zlari bilan ko‘p ishlatiladi.',
    nuance: 'He/she/it bilan ijobiy gapda fe’lga -s qo‘shiladi, lekin savol va inkorda does kelgani uchun fe’l yana V1 shaklda qoladi: Does he play?',
    mistakes: 'He go, does he goes, she don’t kabi xatolar ko‘p uchraydi.',
    examples: ['I study English every day. / Men har kuni ingliz tili o‘qiyman.', 'She plays tennis. / U tennis o‘ynaydi.', 'He does not work on Sunday. / U yakshanba ishlamaydi.', 'Do you like coffee? / Siz kofe yoqtirasizmi?', 'Does Ali speak English? / Ali inglizcha gapiradimi?', 'Water boils at 100°C. / Suv 100°C da qaynaydi.'],
    terms: [['do', 'I/you/we/they bilan yordamchi fe’l', 'Do you study?'], ['does', 'he/she/it bilan yordamchi fe’l', 'Does she study?'], ['V1', 'fe’lning asosiy shakli', 'play, read, write'], ['habit', 'odat', 'I read every day.'], ['always', 'har doim', 'She always helps.'], ['usually', 'odatda', 'We usually walk.']],
    checks: [['She ___ English every day.', ['study', 'studies', 'studying', 'studied'], 1, 'She bilan ijobiy gapda -s qo‘shiladi.'], ['___ you like tea?', ['Does', 'Do', 'Are', 'Is'], 1, 'You bilan savolda Do ishlatiladi.'], ['He does not ___ football.', ['plays', 'play', 'playing', 'played'], 1, 'Does not dan keyin V1 keladi.']]
  });
  if (t.includes('have/has')) return makeProfile({
    concept: 'Have / Has',
    core: 'Have/has biror narsa kimdadir borligini bildiradi.',
    structure: 'I/you/we/they + have. He/she/it yoki bitta ism + has.',
    usage: 'Narsa, oila, dars yoki holat borligini sodda gapda aytishda ishlatiladi.',
    nuance: 'Have va has hozircha faqat egaga qarab tanlanadi: I have, she has, Ali has, they have.',
    mistakes: 'She have, I has, they has kabi ega bilan moslashmagan shakllar xato.',
    examples: ['I have a car. / Menda mashina bor.', 'She has a sister. / Uning singlisi bor.', 'They have a big classroom. / Ularda katta sinfxona bor.', 'Ali has a red pen. / Alida qizil ruchka bor.'],
    terms: [['have', 'I/you/we/they bilan', 'I have a pen.'], ['has', 'he/she/it bilan', 'He has a bag.'], ['I have', 'menda bor', 'I have a book.'], ['She has', 'unda bor', 'She has a phone.'], ['They have', 'ularda bor', 'They have books.'], ['Ali has', 'Alida bor', 'Ali has a bike.']],
    checks: [['He ___ a new phone.', ['have', 'has'], 1, 'He bilan has ishlatiladi.'], ['They ___ books.', ['have', 'has'], 0, 'They bilan have ishlatiladi.'], ['She ___ a bag.', ['have', 'has'], 1, 'She bilan has ishlatiladi.']]
  });
  if (t.includes('there is')) return makeProfile({
    concept: 'There is / There are',
    core: 'There is/are biror joyda narsa yoki odam borligini aytadi.',
    structure: 'There is + singular/uncountable. There are + plural. Inkor: There is not / There are not. Savol: Is there? / Are there?',
    usage: 'Xona, shahar, rasm, sinf, stol usti kabi joylarda mavjud narsalarni tasvirlashda ishlatiladi.',
    nuance: 'There is a book = “Kitob bor”. Ega kitob emas, mavjudlik gapi. Ko‘plikda there are ishlatiladi.',
    mistakes: 'There is books, there are a pen, is there many kabi birlik-ko‘plik xatolari ko‘p uchraydi.',
    examples: ['There is a book on the table. / Stol ustida kitob bor.', 'There are five students in the room. / Xonada beshta o‘quvchi bor.', 'There is not any milk. / Sut yo‘q.', 'Are there many cars? / Mashinalar ko‘pmi?', 'Is there a bank near here? / Bu yer yaqinida bank bormi?', 'There are no problems. / Muammo yo‘q.'],
    terms: [['there is', 'birlik/mavjudlik', 'There is a chair.'], ['there are', 'ko‘plik/mavjudlik', 'There are chairs.'], ['singular', 'birlik', 'a book'], ['plural', 'ko‘plik', 'books'], ['place', 'joy', 'in the room'], ['any', 'savol/inkorda “biror”', 'Is there any water?']],
    checks: [['There ___ two books on the desk.', ['is', 'are', 'am', 'be'], 1, 'Two books ko‘plik, there are.'], ['___ there a bank near here?', ['Are', 'Is', 'Do', 'Does'], 1, 'A bank birlik, Is there...?'], ['Qaysi gap to‘g‘ri?', ['There is three students.', 'There are a teacher.', 'There are many students.', 'There be students.'], 2, 'Many students ko‘plik, there are.']]
  });
  if (t.includes('can')) return makeProfile({
    concept: 'Can / Cannot',
    core: 'Can qobiliyat, ruxsat va imkoniyatni bildiradi. Cannot yoki can’t inkor shaklidir.',
    structure: 'Subject + can + V1. Subject + cannot + V1. Can + subject + V1?',
    usage: 'I can swim — qila olaman. Can I come in? — ruxsat so‘rash. You can use this phone — imkoniyat/ruxsat.',
    nuance: 'Can dan keyin fe’lga -s, -ing yoki to qo‘shilmaydi: He can play, “he can plays” emas.',
    mistakes: 'Can to go, can goes, do can kabi xatolar ko‘p uchraydi.',
    examples: ['I can speak English. / Men inglizcha gapira olaman.', 'She can swim. / U suza oladi.', 'He cannot drive. / U mashina hayday olmaydi.', 'Can you help me? / Menga yordam bera olasizmi?', 'We can start now. / Hozir boshlashimiz mumkin.', 'You can’t smoke here. / Bu yerda chekish mumkin emas.'],
    terms: [['can', 'qila olmoq/mumkin', 'I can read.'], ['cannot', 'qila olmaslik', 'I cannot swim.'], ['can’t', 'cannot qisqartmasi', 'She can’t come.'], ['ability', 'qobiliyat', 'can sing'], ['permission', 'ruxsat', 'Can I go?'], ['V1', 'asosiy fe’l', 'can play']],
    checks: [['She can ___ very well.', ['sings', 'sing', 'singing', 'to sing'], 1, 'Can dan keyin V1 keladi.'], ['Inkor shaklni tanlang.', ['I not can swim.', 'I cannot swim.', 'I can not to swim.', 'I don’t can swim.'], 1, 'Cannot/can’t to‘g‘ri inkor.'], ['Savol gap qaysi?', ['You can help?', 'Can you help?', 'Do can you help?', 'You help can?'], 1, 'Can savolda gap boshiga chiqadi.']]
  });
  if (t.includes('preposition')) return makeProfile({ concept: 'Prepositions of place', core: 'Joy predloglari predmetning qayerda turganini ko‘rsatadi.', structure: 'in, on, under, next to, between, behind, in front of + noun.', usage: 'Xona, stol, maktab, bino, rasm va yo‘nalish tasvirida ishlatiladi.', nuance: 'In — ichida, on — ustida, at — aniq nuqta/joy. O‘zbekchada bitta “da” bo‘lishi mumkin, inglizchada predlog farqlanadi.', mistakes: 'In the table, on school kabi predloglarni aralashtirish ko‘p uchraydi.', examples: ['The book is on the table. / Kitob stol ustida.', 'The cat is under the chair. / Mushuk stul ostida.', 'I am at school. / Men maktabdaman.', 'The phone is in the bag. / Telefon sumka ichida.', 'Ali is next to me. / Ali yonimda.', 'The bank is between the shop and the school. / Bank do‘kon va maktab orasida.'], terms: [['in', 'ichida', 'in the room'], ['on', 'ustida', 'on the table'], ['under', 'ostida', 'under the bed'], ['next to', 'yonida', 'next to the door'], ['between', 'orasida', 'between two chairs'], ['behind', 'orqasida', 'behind the house']], checks: [['The book is ___ the table.', ['in', 'on', 'between', 'behind'], 1, 'Stol ustida — on the table.'], ['“Ichida” ma’nosidagi predlog qaysi?', ['under', 'in', 'on', 'next to'], 1, 'In — ichida.'], ['Qaysi gap to‘g‘ri?', ['The cat is under the chair.', 'The cat is under chair the.', 'The cat are under the chair.', 'The cat under is chair.'], 0, 'Predlog ot oldidan keladi.'] ] });
  if (t.includes('possessive')) return makeProfile({ concept: 'Possessive adjectives', core: 'Possessive adjectives egalikni bildiradi: my, your, his, her, its, our, their.', structure: 'possessive adjective + noun: my book, her phone, their house.', usage: 'Kimga tegishli ekanini ko‘rsatishda ishlatiladi.', nuance: 'His — erkak uchun, her — ayol uchun, its — hayvon/narsa uchun. My book gapida bookdan oldin article qo‘yilmaydi.', mistakes: 'He book, she phone, my a book kabi xatolar ko‘p uchraydi.', examples: ['This is my book. / Bu mening kitobim.', 'Her phone is new. / Uning telefoni yangi.', 'His brother is tall. / Uning akasi baland bo‘yli.', 'Our teacher is kind. / Bizning ustozimiz mehribon.', 'Their house is big. / Ularning uyi katta.', 'Its color is white. / Uning rangi oq.'], terms: [['my', 'mening', 'my bag'], ['your', 'sening/sizning', 'your phone'], ['his', 'uning — erkak', 'his car'], ['her', 'uning — ayol', 'her book'], ['our', 'bizning', 'our class'], ['their', 'ularning', 'their school']], checks: [['___ name is Ali. (mening)', ['My', 'His', 'Their', 'Our'], 0, 'Mening — my.'], ['She has a phone. ___ phone is new.', ['His', 'Her', 'Its', 'Their'], 1, 'She uchun her ishlatiladi.'], ['Qaysi gap to‘g‘ri?', ['This is my a book.', 'This is my book.', 'This my is book.', 'This is me book.'], 1, 'Possessive adjective bevosita ot oldida keladi.']] });
  if (t.includes('question words')) return makeProfile({ concept: 'Question words', core: 'Question words savolning maqsadini bildiradi: who, what, where, when, why, how, which, whose.', structure: 'Question word + auxiliary/be + subject + main verb?', usage: 'Shaxs, narsa, joy, vaqt, sabab, usul va tanlov haqida so‘rashda ishlatiladi.', nuance: 'What — nima, where — qayerda, why — nima uchun, how — qanday. Savol so‘zidan keyin ko‘pincha yordamchi fe’l keladi.', mistakes: 'Where you live?, What he does? kabi yordamchi fe’lni tashlab ketish ko‘p uchraydi.', examples: ['What is your name? / Ismingiz nima?', 'Where do you live? / Qayerda yashaysiz?', 'When does the lesson start? / Dars qachon boshlanadi?', 'Why are you late? / Nega kechikdingiz?', 'How do you go to school? / Maktabga qanday borasiz?', 'Who is your teacher? / Ustozingiz kim?'], terms: [['who', 'kim', 'Who is he?'], ['what', 'nima', 'What is this?'], ['where', 'qayerda', 'Where do you live?'], ['when', 'qachon', 'When is the lesson?'], ['why', 'nima uchun', 'Why are you sad?'], ['how', 'qanday', 'How are you?']], checks: [['“Qayerda?” inglizcha qaysi?', ['Who', 'Where', 'When', 'Why'], 1, 'Where — qayerda/qayerga.'], ['___ do you live?', ['What', 'Where', 'Who', 'Whose'], 1, 'Yashash joyi haqida where bilan so‘raladi.'], ['Qaysi savol to‘g‘ri?', ['Where you live?', 'Where do you live?', 'Where does you live?', 'Where are live?'], 1, 'Present Simple savolda do yordamchisi kerak.']] });
  if (t.includes('frequency')) return makeProfile({ concept: 'Adverbs of frequency', core: 'Frequency adverbs ish-harakat qanchalik tez-tez bo‘lishini bildiradi: always, usually, often, sometimes, rarely, never.', structure: 'Oddiy fe’ldan oldin: I always read. To be dan keyin: She is always busy.', usage: 'Odat va takroriy harakatlarni aniqlashtirish uchun ishlatiladi.', nuance: 'Always 100%, usually ko‘pincha, often tez-tez, sometimes ba’zan, never hech qachon.', mistakes: 'I read always, She always is late kabi joylashuv xatolari ko‘p uchraydi.', examples: ['I always do homework. / Men har doim uy vazifasini qilaman.', 'She is usually busy. / U odatda band.', 'We often play football. / Biz tez-tez futbol o‘ynaymiz.', 'He sometimes drinks tea. / U ba’zan choy ichadi.', 'They never smoke. / Ular hech qachon chekishmaydi.', 'Are you often late? / Tez-tez kechikasizmi?'], terms: [['always', 'har doim', 'I always study.'], ['usually', 'odatda', 'She usually walks.'], ['often', 'tez-tez', 'We often meet.'], ['sometimes', 'ba’zan', 'He sometimes reads.'], ['rarely', 'kamdan-kam', 'They rarely call.'], ['never', 'hech qachon', 'I never lie.']], checks: [['I ___ study at night. (har doim)', ['never', 'always', 'rarely', 'sometimes'], 1, 'Always — har doim.'], ['To be bilan to‘g‘ri tartib qaysi?', ['She always is busy.', 'She is always busy.', 'Always she is busy.', 'She busy always is.'], 1, 'Frequency adverb to be dan keyin keladi.'], ['“Hech qachon” qaysi so‘z?', ['often', 'never', 'usually', 'always'], 1, 'Never — hech qachon.']] });
  if (t.includes('countable') || t.includes('uncountable')) return makeProfile({ concept: 'Countable / Uncountable nouns', core: 'Countable nouns sanaladi: one apple, two books. Uncountable nouns odatda sanalmaydi: water, rice, information.', structure: 'Countable: a/an, many, few. Uncountable: much, little, some. Both: some/any/a lot of.', usage: 'Miqdor, savdo, ovqat, pul, vaqt va narsalarni sanashda muhim.', nuance: 'Uncountable otlarga a/an qo‘yilmaydi va odatda ko‘plik -s olmaydi: water emas “waters” emas oddiy holatda.', mistakes: 'An information, many water, two bread kabi xatolar ko‘p uchraydi.', examples: ['I have two books. / Menda ikkita kitob bor.', 'I need some water. / Menga biroz suv kerak.', 'There is much rice. / Guruch ko‘p.', 'There are many apples. / Olmalar ko‘p.', 'Can I have a piece of bread? / Bir bo‘lak non olsam bo‘ladimi?', 'We need some information. / Bizga ma’lumot kerak.'], terms: [['countable', 'sanaladigan', 'book/books'], ['uncountable', 'sanalmaydigan', 'water'], ['many', 'ko‘p — sanaladigan', 'many students'], ['much', 'ko‘p — sanalmaydigan', 'much water'], ['some', 'biroz/ba’zi', 'some rice'], ['a piece of', 'bir bo‘lak', 'a piece of bread']], checks: [['“Ko‘p suv” qaysi?', ['many water', 'much water', 'a water', 'waters'], 1, 'Water uncountable, much ishlatiladi.'], ['Qaysi biri countable?', ['water', 'rice', 'book', 'information'], 2, 'Book sanaladi: one book, two books.'], ['Qaysi gap to‘g‘ri?', ['I need an information.', 'I need some information.', 'I need many information.', 'I need informations.'], 1, 'Information uncountable.']] });
  if (t.includes('present continuous')) return tenseProfile(title, 'Present Continuous', 'hozir ayni paytda davom etayotgan ish-harakatni', 'am/is/are + V-ing', ['I am reading now.', 'She is cooking.', 'They are playing football.'], [['now', 'hozir', 'I am studying now.'], ['V-ing', '-yapti shakli', 'reading'], ['am/is/are', 'to be yordamchisi', 'She is writing.']], [['She ___ reading now.', ['am', 'is', 'are', 'do'], 1, 'She bilan is va V-ing ishlatiladi.']]);
  if (t.includes('past simple')) return tenseProfile(title, 'Past Simple', 'o‘tgan vaqtda tugagan ish-harakatni', 'regular: V-ed; irregular: maxsus shakl; inkor/savol: did + V1', ['I watched a film yesterday.', 'She went to school.', 'Did you see Ali?'], [['yesterday', 'kecha', 'I worked yesterday.'], ['did', 'o‘tgan zamon yordamchisi', 'Did you go?'], ['V2', 'o‘tgan zamon shakli', 'went']], [['I ___ to school yesterday.', ['go', 'goes', 'went', 'going'], 2, 'Yesterday o‘tgan zamon, go → went.']]);
  if (t.includes('future') || t.includes('going to')) return tenseProfile(title, 'Future with going to', 'reja va yaqin kelajakdagi niyatni', 'am/is/are + going to + V1', ['I am going to study.', 'She is going to travel.', 'Are they going to come?'], [['going to', 'reja/niyat', 'I am going to read.'], ['plan', 'reja', 'future plan'], ['V1', 'asosiy fe’l', 'to + V1']], [['She ___ going to study.', ['am', 'is', 'are', 'do'], 1, 'She bilan is going to ishlatiladi.']]);
  if (t.includes('comparative')) return degreeProfile(title, 'Comparatives', 'ikki narsa/shaxsni solishtirishni', 'short adjective + -er + than; long adjective: more + adjective + than', ['Ali is taller than Vali.', 'This book is more interesting than that book.', 'English is easier than I thought.'], [['than', 'dan ko‘ra', 'taller than'], ['-er', 'qisqa sifat qo‘shimchasi', 'smaller'], ['more', 'uzun sifatlar uchun', 'more beautiful']], [['Ali is ___ than Vali.', ['tall', 'taller', 'tallest', 'more tall'], 1, 'Ikki odam solishtirilsa comparative kerak.']]);
  if (t.includes('superlative')) return degreeProfile(title, 'Superlatives', 'uch yoki undan ko‘p ichida eng yuqori darajani', 'the + adjective-est; the most + long adjective', ['He is the tallest student.', 'This is the most useful book.', 'It is the best answer.'], [['the', 'superlative oldidan', 'the biggest'], ['-est', 'eng ...', 'smallest'], ['most', 'uzun sifatlar uchun', 'most beautiful']], [['This is ___ book in the class.', ['good', 'better', 'the best', 'best than'], 2, 'Guruh ichida eng yaxshisi: the best.']]);
  if (t.includes('should')) return modalProfile(title, 'Should', 'maslahat va tavsiya berishni', 'subject + should/should not + V1', ['You should sleep early.', 'He should not smoke.', 'Should I call him?'], [['should', 'kerak/tavsiya', 'You should read.'], ['should not', 'qilmaslik kerak', 'You should not wait.'], ['advice', 'maslahat', 'good advice']], [['You ___ study more.', ['should', 'to should', 'shoulds', 'are should'], 0, 'Should dan keyin V1 keladi.']]);
  if (t.includes('some') || t.includes('any')) return quantifierProfile(title, 'Some / Any', 'miqdorni noaniq aytishni', 'some — ijobiy/taklif; any — savol/inkor', ['I have some books.', 'Do you have any questions?', 'There isn’t any milk.'], [['some', 'biroz/ba’zi', 'some water'], ['any', 'biror/hech qanday', 'any questions'], ['offer', 'taklif', 'Would you like some tea?']], [['Do you have ___ questions?', ['some', 'any', 'a', 'many of'], 1, 'Savolda odatda any ishlatiladi.']]);
  if (t.includes('much') || t.includes('many')) return quantifierProfile(title, 'Much / Many', 'ko‘plik yoki sanalmaydigan miqdorni', 'many + countable plural; much + uncountable', ['There are many students.', 'There is much water.', 'How many books do you have?'], [['many', 'sanaladigan ko‘p', 'many books'], ['much', 'sanalmaydigan ko‘p', 'much money'], ['how many', 'nechta', 'how many apples']], [['How ___ books do you have?', ['much', 'many', 'some', 'any'], 1, 'Books sanaladi, how many ishlatiladi.']]);
  if (t.includes('present perfect')) return tenseProfile(title, 'Present Perfect', 'o‘tmishda boshlanib hozirga bog‘langan natijani', 'have/has + V3', ['I have finished my homework.', 'She has visited Samarkand.', 'Have you ever seen this film?'], [['have/has', 'Present Perfect yordamchisi', 'I have done.'], ['V3', 'past participle', 'gone, seen, written'], ['ever', 'hech qachon/tajriba', 'Have you ever...?']], [['She ___ finished the work.', ['have', 'has', 'is', 'did'], 1, 'She bilan has + V3.']]);
  if (t.includes('past continuous')) return tenseProfile(title, 'Past Continuous', 'o‘tmishda ma’lum vaqtda davom etayotgan harakatni', 'was/were + V-ing', ['I was reading at 8 pm.', 'They were playing when I came.', 'Was she sleeping?'], [['was', 'I/he/she/it bilan', 'I was writing.'], ['were', 'you/we/they bilan', 'They were running.'], ['while', 'paytida', 'while I was reading']], [['They ___ playing football.', ['was', 'were', 'are', 'did'], 1, 'They bilan were + V-ing.']]);
  if (t.includes('conditional')) return conditionalProfile(title);
  if (t.includes('passive')) return passiveProfile(title);
  if (t.includes('relative')) return clauseProfile(title, 'Relative clauses', 'who, which, that yordamida otni izohlashni', 'noun + who/which/that + clause', ['The man who teaches us is kind.', 'This is the book that I bought.', 'The phone which is on the table is mine.']);
  if (t.includes('reported')) return reportedProfile(title);
  if (t.includes('used to')) return grammarSimpleProfile(title, 'Used to', 'o‘tmishda bor bo‘lgan, hozir esa yo‘q odat yoki holatni', 'used to + V1', ['I used to play football.', 'She used to live here.', 'Did you use to read a lot?']);
  if (t.includes('modal')) return modalProfile(title, 'Modal verbs', 'imkoniyat, majburiyat, ehtimol va maslahatni', 'modal + V1', ['You must stop.', 'She might come.', 'We should practice.'], [['must', 'majburiyat', 'You must study.'], ['might', 'ehtimol', 'He might come.'], ['could', 'mumkin/qila olardi', 'Could you help?']], [['You ___ wear a seat belt.', ['must', 'musts', 'to must', 'are must'], 0, 'Modal fe’l o‘zgarmaydi.']]);
  if (t.includes('phrasal')) return grammarSimpleProfile(title, 'Phrasal verbs', 'fe’l + particle birikmasi orqali yangi ma’no berishni', 'verb + up/off/on/out/in', ['Turn on the light.', 'I looked up the word.', 'She gave up smoking.']);
  if (t.includes('gerund')) return grammarSimpleProfile(title, 'Gerund', 'fe’lning -ing shaklini ot vazifasida ishlatishni', 'V-ing as noun: reading, swimming, learning', ['Reading is useful.', 'I enjoy learning English.', 'Swimming is good for health.']);
  if (t.includes('pronoun')) return grammarSimpleProfile(title, 'Object pronouns', 'fe’l yoki predlogdan keyin keladigan olmoshlarni', 'me, you, him, her, it, us, them', ['Call me.', 'I know him.', 'Listen to them.']);
  if (t.includes('adverbs of manner')) return grammarSimpleProfile(title, 'Adverbs of manner', 'ish-harakat qanday bajarilganini', 'adjective + -ly: slow → slowly', ['She speaks clearly.', 'He drives carefully.', 'They worked hard.']);
  if (t.includes('wish')) return grammarSimpleProfile(title, 'Wish / If only', 'afsus, orzu yoki hozirgi holatdan norozilikni', 'wish + past simple; wish + would; wish + past perfect', ['I wish I knew English better.', 'If only I had more time.', 'I wish he would listen.']);
  if (t.includes('inversion')) return grammarSimpleProfile(title, 'Inversion', 'rasmiy yoki kuchli urg‘u uchun so‘z tartibini o‘zgartirishni', 'negative adverb + auxiliary + subject + verb', ['Never have I seen this.', 'Rarely does he arrive late.', 'Not only did she help, but she also stayed.']);
  if (t.includes('cleft')) return grammarSimpleProfile(title, 'Cleft sentences', 'gapning muhim qismini ajratib ko‘rsatishni', 'It is/was ... that/who ...', ['It was Ali who called me.', 'It is practice that improves speaking.', 'What I need is time.']);
  if (t.includes('participle')) return grammarSimpleProfile(title, 'Participle clauses', 'gapni qisqartirib, sabab/vaqt/holatni ifodalashni', 'V-ing / V3 clause + main clause', ['Walking home, I met Ali.', 'Written in English, the text was difficult.', 'Feeling tired, she went home.']);
  if (t.includes('essay')) return writingProfile(title, 'essay yozish', 'kirish, asosiy fikr, dalil, misol va xulosani tartibli berishni', ['Firstly, education is important.', 'For example, online learning saves time.', 'In conclusion, practice is necessary.']);
  if (t.includes('speaking') || t.includes('conversation') || t.includes('invitation') || t.includes('debate') || t.includes('listening')) return speakingProfile(title);
  if (t.includes('academic') || t.includes('vocabulary')) return vocabularyProfile(title);
  return grammarSimpleProfile(title, title, `${title} mavzusidagi asosiy grammatik yoki kommunikativ tushunchani`, `${title} uchun mavzuga mos so‘z tartibi va shakl tanlanadi`, [`${title}: I can make a correct sentence.`, `${title}: This topic helps communication.`, `${title}: Practice makes the rule clear.`]);
}
function tenseProfile(title, concept, meaning, structure, examples, terms, checks) {
  return makeProfile({ concept, core: `${concept} ${meaning} bildiradi. Vaqt ma’nosi gapdagi fe’l shakli va vaqt ko‘rsatkichlari orqali tushuniladi.`, structure, usage: `${concept} odatda vaqt so‘zlari, kontekst va gap maqsadiga qarab ishlatiladi.`, nuance: `Bu mavzuda yordamchi fe’l va asosiy fe’l shaklini adashtirmaslik muhim. Yordamchi kelganda asosiy fe’l ko‘pincha bazaviy shaklda qoladi.`, mistakes: `Eng ko‘p xato — yordamchi fe’lni tashlab ketish, noto‘g‘ri fe’l shaklini tanlash yoki savol/inkor tartibini buzish.`, examples: examples.map(e => `${e} / ${concept} misoli.`), terms, checks });
}
function degreeProfile(title, concept, meaning, structure, examples, terms, checks) { return makeProfile({ concept, core: `${concept} ${meaning} bildiradi. Sifat darajasi narsa yoki odamlarni solishtirishda ishlatiladi.`, structure, usage: 'Sifat, ot va solishtirilayotgan tomon aniq bo‘lishi kerak.', nuance: 'Qisqa va uzun sifatlar turlicha yasaladi; good/bad kabi irregular shakllar alohida yodlanadi.', mistakes: 'More better, most easiest, taller from kabi xatolar ko‘p uchraydi.', examples: examples.map(e => `${e} / Sifat darajasi misoli.`), terms, checks }); }
function modalProfile(title, concept, meaning, structure, examples, terms, checks) { return makeProfile({ concept, core: `${concept} ${meaning} bildiradi. Modal fe’llar gapga qo‘shimcha munosabat beradi.`, structure, usage: 'Maslahat, ruxsat, majburiyat, ehtimol yoki qobiliyatni ifodalashda ishlatiladi.', nuance: 'Modal fe’ldan keyin asosiy fe’l doim V1 shaklda keladi; modalning o‘ziga -s qo‘shilmaydi.', mistakes: 'He shoulds, can to go, musts kabi shakllar noto‘g‘ri.', examples: examples.map(e => `${e} / Modal fe’l misoli.`), terms, checks }); }
function quantifierProfile(title, concept, meaning, structure, examples, terms, checks) { return makeProfile({ concept, core: `${concept} ${meaning} bildiradi. Ot sanaladimi yoki sanalmaydimi — tanlov shunga bog‘liq.`, structure, usage: 'Miqdor, savol, inkor va umumiy gaplarda ishlatiladi.', nuance: 'Countable va uncountable otlarni farqlash bu mavzuning markaziy qismidir.', mistakes: 'Sanaladigan ot bilan much, sanalmaydigan ot bilan many ishlatish ko‘p xato beradi.', examples: examples.map(e => `${e} / Miqdor ifodasi.`), terms, checks }); }
function conditionalProfile(title) { return makeProfile({ concept: title, core: `${title} shart va natija orasidagi bog‘lanishni bildiradi.`, structure: title.toLowerCase().includes('second') ? 'If + past simple, would + V1' : title.toLowerCase().includes('mixed') ? 'If + past perfect, would + V1 yoki If + past simple, would have + V3' : 'If + present simple, will + V1', usage: 'Real, ehtimoliy yoki xayoliy vaziyatlarni tushuntirishda ishlatiladi.', nuance: 'If qismi va natija qismi zamon jihatdan mos bo‘lishi kerak.', mistakes: 'If I will go..., If I would know... kabi noto‘g‘ri aralashmalar ko‘p uchraydi.', examples: ['If it rains, I will stay home. / Yomg‘ir yog‘sa, uyda qolaman.', 'If I had time, I would travel. / Vaqtim bo‘lsa, sayohat qilardim.', 'If I had studied, I would know it now. / O‘qiganimda hozir bilardim.'], terms: [['if', 'agar', 'If I go...'], ['result', 'natija', 'I will call you'], ['condition', 'shart', 'If it rains'], ['would', 'xayoliy natija', 'I would help'], ['will', 'kelajak natija', 'I will come'], ['past simple', 'xayoliy shartda ishlatiladi', 'If I knew']], checks: [['First Conditional tuzilmasi qaysi?', ['If + past, would + V1', 'If + present, will + V1', 'If + Ving, can', 'If + will, will'], 1, 'Real kelajak sharti uchun If + present, will + V1.'], ['If I had time, I ___ help you.', ['will', 'would', 'am', 'do'], 1, 'Second Conditional natija qismida would ishlatiladi.']] }); }
function passiveProfile(title) { return makeProfile({ concept: title, core: `${title} ishni kim bajarganidan ko‘ra ishning o‘zi yoki natijasiga urg‘u beradi.`, structure: 'be + V3: is made, was written, has been built', usage: 'Rasmiy matn, yangilik, ilmiy gap, jarayon va natija tasvirida ishlatiladi.', nuance: 'Passive gapda object oldinga chiqadi. By + doer faqat bajaruvchini aytish kerak bo‘lsa ishlatiladi.', mistakes: 'Is write, was wrote, by ni keraksiz ishlatish ko‘p uchraydi.', examples: ['The letter was written yesterday. / Xat kecha yozildi.', 'English is spoken in many countries. / Ingliz tili ko‘p davlatlarda gapiriladi.', 'The room has been cleaned. / Xona tozalangan.'], terms: [['passive', 'majhul nisbat', 'is written'], ['V3', 'past participle', 'written'], ['by', 'tomonidan', 'by Ali'], ['be', 'passive yordamchisi', 'is/was/been'], ['object', 'ta’sir oluvchi', 'the letter'], ['agent', 'bajaruvchi', 'by the teacher']], checks: [['Passive tuzilma qaysi?', ['subject + V1', 'be + V3', 'do + V1', 'have + V1'], 1, 'Passive: be + V3.'], ['The book ___ written by Ali.', ['is', 'are', 'do', 'has'], 0, 'Book birlik, is written.']] }); }
function clauseProfile(title, concept, meaning, structure, examples) { return makeProfile({ concept, core: `${concept} ${meaning} bildiradi. U gap ichida qo‘shimcha ma’lumot beradi.`, structure, usage: 'Otni aniqlash, gaplarni bog‘lash va matnni tabiiyroq qilish uchun ishlatiladi.', nuance: 'Who odam uchun, which narsa uchun, that esa ko‘p holatda ikkalasiga ham ishlatiladi.', mistakes: 'Relative pronounni noto‘g‘ri tanlash yoki ikki ega qo‘yish xato: The man who he teaches... noto‘g‘ri.', examples: examples.map(e => `${e} / Bog‘lovchi gap misoli.`), terms: [['who', 'odam uchun', 'the teacher who helps'], ['which', 'narsa uchun', 'the book which I read'], ['that', 'odam/narsa uchun', 'the car that I bought'], ['clause', 'gap bo‘lagi', 'who teaches us'], ['noun', 'ot', 'the man'], ['relative pronoun', 'bog‘lovchi olmosh', 'who/which/that']], checks: [['Odam uchun qaysi relative pronoun ko‘p ishlatiladi?', ['which', 'who', 'where', 'when'], 1, 'Who odamlar uchun ishlatiladi.'], ['This is the book ___ I bought.', ['who', 'which', 'when', 'why'], 1, 'Book narsa, which/that ishlatiladi.']] }); }
function reportedProfile(title) { return makeProfile({ concept: title, core: `${title} boshqa odam aytgan gapni ko‘chirma emas, qayta hikoya qilib berishni bildiradi.`, structure: 'say/tell + that + shifted tense: am → was, do → did, will → would', usage: 'Yangilik, suhbat, xabar va hikoya qilishda ishlatiladi.', nuance: 'Vaqt va olmoshlar kontekstga qarab o‘zgaradi: I → he/she, today → that day.', mistakes: 'He said me, he said that he is tired (o‘tgan reportingda) kabi xatolar ko‘p uchraydi.', examples: ['He said that he was tired. / U charchaganini aytdi.', 'She told me that she liked English. / U menga ingliz tilini yoqtirishini aytdi.', 'Ali said he would come. / Ali kelishini aytdi.'], terms: [['said', 'aytdi', 'He said...'], ['told', 'aytib berdi', 'She told me...'], ['reported speech', 'ko‘chirma gapni hikoya qilish', 'He said that...'], ['tense shift', 'zamon siljishi', 'am → was'], ['pronoun change', 'olmosh o‘zgarishi', 'I → he'], ['that', 'deb/ligini', 'said that']], checks: [['He said, “I am tired.” Reported speech qaysi?', ['He said he is tired.', 'He said he was tired.', 'He said I was tired.', 'He told that tired.'], 1, 'Am → was bo‘ladi.'], ['Tell fe’li bilan qaysi gap to‘g‘ri?', ['She told me the news.', 'She told to me the news.', 'She said me the news.', 'She told I news.'], 0, 'Tell + object: told me.']] }); }
function grammarSimpleProfile(title, concept, meaning, structure, examples) { return makeProfile({ concept, core: `${concept} ${meaning} bildiradi. Bu mavzuda asosiy e’tibor ma’no, tuzilma va gapdagi vazifaga qaratiladi.`, structure, usage: `${concept} real gaplarda fikrni aniqroq, tabiiyroq va grammatik jihatdan to‘g‘riroq ifodalash uchun ishlatiladi.`, nuance: 'Tuzilmani yodlashdan tashqari, qaysi vaziyatda ishlatilishini ham tushunish kerak. Shunda gap avtomatik tarjima emas, tabiiy inglizcha bo‘ladi.', mistakes: 'Ko‘p xato so‘z tartibi, yordamchi so‘z, qo‘shimcha va noto‘g‘ri tarjima sababli yuzaga keladi.', examples: examples.map(e => `${e} / ${concept} misoli.`), terms: [[concept, 'mavzuning asosiy tushunchasi', examples[0] || concept], ['structure', 'tuzilma', structure], ['meaning', 'ma’no', meaning], ['usage', 'ishlatilish holati', 'real communication'], ['mistake', 'xato shakl', 'avoid mistakes'], ['context', 'kontekst', 'use in context']], checks: [[`${concept} mavzusida asosiy tuzilma qaysi?`, [structure, 'do + be + V3', 'article + modal + past', 'subject without verb'], 0, `${concept} mavzusida asosiy tuzilma: ${structure}`], [`${concept} mavzusi nima uchun kerak?`, [meaning, 'faqat ranglarni aytish uchun', 'faqat sonlarni sanash uchun', 'faqat ism yozish uchun'], 0, `${concept} mavzusi ${meaning} uchun ishlatiladi.`]] }); }
function writingProfile(title, concept, meaning, examples) { return makeProfile({ concept: title, core: `${title} ${meaning} o‘rgatadi.`, structure: 'Introduction → main idea → supporting argument → example → conclusion.', usage: 'Rasmiy yozuv, imtihon, fikr bildirish va dalil keltirishda ishlatiladi.', nuance: 'Har bir paragraph bitta asosiy fikrga xizmat qilishi kerak. Bog‘lovchi so‘zlar fikrni tartibli qiladi.', mistakes: 'Xulosasiz yozish, dalilsiz fikr berish, juda og‘zaki uslub va linking words yetishmasligi ko‘p uchraydi.', examples: examples.map(e => `${e} / Yozma nutq misoli.`), terms: [['introduction', 'kirish qismi', 'This essay discusses...'], ['argument', 'dalil', 'The main reason is...'], ['example', 'misol', 'For example,...'], ['conclusion', 'xulosa', 'In conclusion,...'], ['linking word', 'bog‘lovchi so‘z', 'however, therefore'], ['paragraph', 'abzas', 'one idea per paragraph']], checks: [['Essayda xulosa uchun qaysi ibora mos?', ['In conclusion', 'Yesterday', 'At the table', 'Very tall'], 0, 'In conclusion — xulosa boshlash uchun.'], ['Dalil keltirish uchun qaysi ibora mos?', ['For example', 'How old', 'Never mind', 'At home'], 0, 'For example misol keltiradi.']] }); }
function speakingProfile(title) { return makeProfile({ concept: title, core: `${title} og‘zaki muloqotda fikrni tabiiy, ravon va vaziyatga mos aytishni o‘rgatadi.`, structure: 'Opening phrase → main message → reason/example → closing response.', usage: 'Suhbat, taklif, fikr bildirish, bahs, telefon orqali gaplashish yoki imtihon speaking qismida ishlatiladi.', nuance: 'Og‘zaki nutqda qisqa, aniq va tabiiy iboralar muhim. Juda uzun tarjima qilingan gaplar nutqni sun’iy qiladi.', mistakes: 'Faqat bitta so‘z bilan javob berish, sabab bermaslik, talaffuzga e’tibor bermaslik va so‘z tartibini buzish ko‘p uchraydi.', examples: ['In my opinion, practice is important. / Fikrimcha, mashq muhim.', 'Could you repeat, please? / Iltimos, qaytara olasizmi?', 'Would you like to join us? / Bizga qo‘shilishni xohlaysizmi?', 'I agree because it is useful. / Foydali bo‘lgani uchun qo‘shilaman.', 'Let me explain my point. / Fikrimni tushuntirib beray.', 'That sounds good. / Bu yaxshi eshitilyapti.'], terms: [['opinion', 'fikr', 'In my opinion...'], ['reason', 'sabab', 'because...'], ['example', 'misol', 'for example...'], ['fluency', 'ravonlik', 'speak fluently'], ['response', 'javob', 'give a response'], ['pronunciation', 'talaffuz', 'clear pronunciation']], checks: [['Fikr bildirish uchun qaysi ibora mos?', ['In my opinion', 'On the table', 'At 5 o’clock', 'Blue pen'], 0, 'In my opinion fikr boshlash uchun ishlatiladi.'], ['Sabab berish uchun qaysi so‘z ishlatiladi?', ['because', 'under', 'these', 'never'], 0, 'Because sababni bildiradi.']] }); }
function vocabularyProfile(title) { return makeProfile({ concept: title, core: `${title} mavzusi so‘z boyligini kengaytirish va so‘zlarni kontekstda ishlatishni o‘rgatadi.`, structure: 'word → meaning → collocation → sentence → context.', usage: 'O‘qish, yozish, speaking va listeningda aniqroq fikr aytish uchun ishlatiladi.', nuance: 'So‘zni alohida yodlash yetarli emas; collocation va gap ichidagi ma’nosi bilan o‘rganish kerak.', mistakes: 'So‘zni noto‘g‘ri tarjima qilish, noto‘g‘ri predlog bilan ishlatish yoki formal/informal farqini bilmaslik ko‘p uchraydi.', examples: ['This word is useful in academic writing. / Bu so‘z akademik yozuvda foydali.', 'Use new vocabulary in a sentence. / Yangi so‘zni gapda ishlating.', 'The context changes the meaning. / Kontekst ma’noni o‘zgartiradi.'], terms: [['vocabulary', 'so‘z boyligi', 'academic vocabulary'], ['collocation', 'birikma', 'make a decision'], ['context', 'kontekst', 'meaning in context'], ['synonym', 'ma’nodosh', 'big — large'], ['formal', 'rasmiy', 'formal word'], ['informal', 'norasmiy', 'informal speech']], checks: [['So‘zni yaxshi o‘rganish uchun nima muhim?', ['faqat tarjima', 'kontekst va gap', 'faqat yozilishi', 'faqat ovozi'], 1, 'So‘z kontekstda mustahkam o‘rganiladi.'], ['Collocation nima?', ['so‘z birikmasi', 'faqat harf', 'faqat son', 'inkor gap'], 0, 'Collocation — tabiiy so‘z birikmasi.']] }); }
function russianProfile(title, level) {
  const low = title.toLowerCase();
  if (title.includes('Алфавит')) return makeProfile({ concept: 'Русский алфавит и звуки', core: 'Rus tilida harflar va tovushlar talaffuzning poydevori hisoblanadi. Harf yozuvda ko‘rinadi, tovush og‘izda aytiladi.', structure: 'гласные: а, о, у, э, ы, и; согласные: б, в, г, д...; yumshatish belgilari: ь, я, е, ё, ю.', usage: 'O‘qish, yozish va to‘g‘ri talaffuz qilishda ishlatiladi.', nuance: 'Rus tilida urg‘u ma’noga va talaffuzga ta’sir qiladi: о urg‘usiz holatda ko‘pincha a ga yaqin eshitiladi.', mistakes: 'Ы/И, Ш/Щ, Ж, Х tovushlarini adashtirish va urg‘uni noto‘g‘ri qo‘yish ko‘p uchraydi.', examples: ['мама — ona', 'школа — maktab', 'учитель — ustoz', 'это дом — bu uy', 'я читаю — men o‘qiyman', 'он говорит — u gapiryapti'], terms: [['алфавит', 'alifbo', 'Русский алфавит'], ['звук', 'tovush', 'звук Ы'], ['буква', 'harf', 'буква А'], ['ударение', 'urg‘u', 'ударение в слове'], ['гласный', 'unli', 'а, о, у'], ['согласный', 'undosh', 'б, в, г']], checks: [['“Буква” nimani bildiradi?', ['tovush', 'harf', 'gap', 'fe’l'], 1, 'Буква — harf.'], ['Rus tilida urg‘u nima uchun muhim?', ['faqat rang uchun', 'talaffuz va ma’no uchun', 'faqat son uchun', 'kerak emas'], 1, 'Urg‘u talaffuzga ta’sir qiladi.']] });
  if (low.includes('местоим')) return makeProfile({ concept: title, core: 'Личные местоимения shaxsni bildiradi: я, ты, он, она, оно, мы, вы, они.', structure: 'я + говорю; ты + говоришь; он/она + говорит; мы + говорим; вы + говорите; они + говорят.', usage: 'Kim gapirayotganini yoki kim haqida gap ketayotganini bildirish uchun ishlatiladi.', nuance: 'Вы hurmat shakli ham, ko‘plik shakli ham bo‘lishi mumkin.', mistakes: 'Он/она jinsini adashtirish, вы va ты ni vaziyatga mos ishlatmaslik ko‘p uchraydi.', examples: ['Я студент. / Men o‘quvchiman.', 'Ты дома? / Sen uydamisan?', 'Он учитель. / U ustoz.', 'Она читает. / U o‘qiydi.', 'Мы говорим. / Biz gapiramiz.', 'Они работают. / Ular ishlaydi.'], terms: [['я', 'men', 'Я читаю.'], ['ты', 'sen', 'Ты учишься.'], ['он', 'u — erkak', 'Он дома.'], ['она', 'u — ayol', 'Она врач.'], ['мы', 'biz', 'Мы здесь.'], ['они', 'ular', 'Они там.']], checks: [['“Men” ruscha qaysi?', ['ты', 'я', 'мы', 'они'], 1, 'Я — men.'], ['Hurmat shakli qaysi?', ['ты', 'он', 'вы', 'она'], 2, 'Вы hurmat yoki ko‘plik.']] });
  if (low.includes('быть') || low.includes('глагол быть')) return makeProfile({ concept: 'Глагол быть', core: 'Rus tilida “быть” fe’li hozirgi zamonda ko‘pincha tushib qoladi, lekin o‘tgan va kelasi zamonda ishlatiladi.', structure: 'Hozir: Я студент. O‘tgan: Я был/была студентом. Kelasi: Я буду студентом.', usage: 'Kim/nima ekanini, holatni va mavjudlikni aytishda ishlatiladi.', nuance: 'O‘zbek va ingliz tilidan farqli, rus hozirgi zamonida “is/am/are” ko‘pincha yozilmaydi.', mistakes: 'Hozirgi zamonda лишний “есть” qo‘yish yoki был/была jinsini adashtirish ko‘p uchraydi.', examples: ['Я студент. / Men o‘quvchiman.', 'Она была дома. / U uyda edi.', 'Он был учителем. / U ustoz edi.', 'Мы будем готовы. / Biz tayyor bo‘lamiz.', 'Это книга. / Bu kitob.', 'У меня есть брат. / Mening akam bor.'], terms: [['быть', 'bo‘lmoq', 'глагол быть'], ['есть', 'bor/mavjud', 'У меня есть книга.'], ['был', 'edi — erkak', 'Он был дома.'], ['была', 'edi — ayol', 'Она была дома.'], ['буду', 'bo‘laman', 'Я буду...'], ['это', 'bu', 'Это дом.']], checks: [['“U uyda edi” ayol uchun qaysi?', ['Она был дома.', 'Она была дома.', 'Она есть дома.', 'Она буду дома.'], 1, 'Она bilan была.'], ['Hozirgi zamon: “Men studentman” ruscha qaysi?', ['Я есть студент.', 'Я студент.', 'Я был студент.', 'Я буду студент.'], 1, 'Hozirgi zamonda быть ko‘pincha tushib qoladi.']] });
  if (low.includes('падеж') || low.includes('род') || low.includes('число') || low.includes('прилагательные')) return caseRussianProfile(title);
  if (low.includes('настоящее') || low.includes('прошедшее') || low.includes('будущее') || low.includes('глагол')) return verbRussianProfile(title);
  if (low.includes('вопрос')) return russianCommunicationProfile(title, 'savol tuzish', 'кто, что, где, когда, почему, как kabi savol so‘zlari va intonatsiya yordamida savol berishni');
  if (low.includes('числа')) return russianCommunicationProfile(title, 'sonlar', 'miqdor, yosh, narx, sana va tartibni rus tilida aytishni');
  if (low.includes('семья')) return russianCommunicationProfile(title, 'oila mavzusi', 'oila a’zolari, egalik va qisqa ta’riflarni ruscha aytishni');
  if (low.includes('еда') || low.includes('покупки') || low.includes('город') || low.includes('путешествие') || low.includes('работа') || low.includes('телефон') || low.includes('разговор') || low.includes('приглашение')) return russianCommunicationProfile(title, 'kundalik muloqot', `${title} vaziyatida kerakli iboralar, savol-javoblar va polite shakllarni ishlatishni`);
  if (low.includes('слож') || low.includes('синтаксис') || low.includes('причаст') || low.includes('деепричаст')) return russianSyntaxProfile(title);
  if (low.includes('мнение') || low.includes('аргумент') || low.includes('дискус') || low.includes('эссе') || low.includes('презентац') || low.includes('интервью')) return russianCommunicationProfile(title, 'fikr va dalil', 'fikrni rasmiyroq, mantiqli va dalillar bilan ifodalashni');
  return russianCommunicationProfile(title, title, `${title} mavzusidagi asosiy so‘zlar, tuzilma va muloqot iboralarini`);
}
function caseRussianProfile(title) { return makeProfile({ concept: title, core: `${title} rus tilida ot, sifat va olmoshlarning gapdagi vazifasiga qarab shakli o‘zgarishini tushuntiradi.`, structure: 'Savol + qo‘shimcha: кто/что, кого/что, кому/чему, кем/чем, о ком/о чём.', usage: 'Egalik, yo‘nalish, vosita, obyekt va joy haqida gapirganda kerak bo‘ladi.', nuance: 'Rus tilida so‘z tartibi nisbatan erkin, lekin qo‘shimcha ma’no beradi. Shuning uchun падежni bilish juda muhim.', mistakes: 'Qo‘shimchani jins, son va kelishikka moslamaslik eng ko‘p uchraydi.', examples: ['Я вижу книгу. / Men kitobni ko‘ryapman.', 'Я говорю с другом. / Men do‘stim bilan gapiryapman.', 'Я иду к учителю. / Ustoz oldiga boryapman.', 'У меня нет времени. / Menda vaqt yo‘q.', 'Она читает новую книгу. / U yangi kitob o‘qiydi.', 'Мы говорим о школе. / Biz maktab haqida gapiryapmiz.'], terms: [['падеж', 'kelishik', 'родительный падеж'], ['род', 'jins', 'мужской род'], ['окончание', 'qo‘shimcha', 'новая книга'], ['существительное', 'ot', 'книга'], ['прилагательное', 'sifat', 'новый'], ['вопрос падежа', 'kelishik savoli', 'кого? чему?']], checks: [['Rus tilida падеж nimani ko‘rsatadi?', ['rangni', 'otning gapdagi vazifasini', 'faqat vaqtni', 'faqat sonni'], 1, 'Падеж so‘zning gapdagi vazifasini bildiradi.'], ['“Я говорю с другом” gapida с другом nima bildiradi?', ['kim bilan', 'qayerga', 'nima uchun', 'qachon'], 0, 'С + творительный ko‘pincha “bilan” ma’nosini beradi.']] }); }
function verbRussianProfile(title) { return makeProfile({ concept: title, core: `${title} rus tilida fe’lning vaqt, shaxs va harakat turi bo‘yicha o‘zgarishini tushuntiradi.`, structure: 'я читаю; ты читаешь; он читает; мы читаем; вы читаете; они читают. O‘tgan zamonda jins ham muhim: был/была.', usage: 'Harakat, odat, reja, voqea va natijani ifodalashda ishlatiladi.', nuance: 'Rus fe’llarida shaxs qo‘shimchasi va vid (совершенный/несовершенный) ma’noni o‘zgartiradi.', mistakes: 'Shaxs qo‘shimchasini noto‘g‘ri tanlash yoki vidni aralashtirish ko‘p uchraydi.', examples: ['Я читаю книгу. / Men kitob o‘qiyapman.', 'Она читает текст. / U matn o‘qiydi.', 'Мы будем работать. / Biz ishlaymiz.', 'Он написал письмо. / U xat yozdi.', 'Я писал письмо. / Men xat yozayotgan edim/yozdim.', 'Они идут домой. / Ular uyga ketyapti.'], terms: [['глагол', 'fe’l', 'читать'], ['настоящее время', 'hozirgi zamon', 'я читаю'], ['прошедшее время', 'o‘tgan zamon', 'он читал'], ['будущее время', 'kelasi zamon', 'буду читать'], ['вид глагола', 'fe’l turi', 'писать/написать'], ['окончание', 'shaxs qo‘shimchasi', 'читаешь']], checks: [['“Я читаю” nimani bildiradi?', ['Men o‘qiyman/o‘qiyapman', 'U o‘qidi', 'Biz o‘qiymiz', 'Sen yozasan'], 0, 'Я читаю — men o‘qiyman/o‘qiyapman.'], ['Rus fe’lida shaxs nima orqali ko‘rinadi?', ['faqat artikl', 'fe’l qo‘shimchasi', 'rang', 'vergul'], 1, 'Fe’l oxiridagi qo‘shimcha shaxsni bildiradi.']] }); }
function russianSyntaxProfile(title) { return makeProfile({ concept: title, core: `${title} murakkab gaplarni aniq va rasmiyroq tuzishni o‘rgatadi.`, structure: 'Asosiy gap + bog‘lovchi/oborot + qo‘shimcha ma’no.', usage: 'Matn, rasmiy nutq, insho, tahlil va og‘zaki fikrni boyitishda ishlatiladi.', nuance: 'Murakkab tuzilmada vergul, kelishik va bog‘lovchi so‘zlar ma’noni boshqaradi.', mistakes: 'Vergul qo‘ymaslik, oborotni noto‘g‘ri joylashtirish yoki kelishikni moslamaslik ko‘p uchraydi.', examples: ['Когда я пришёл, урок уже начался. / Men kelganimda dars boshlangan edi.', 'Человек, который говорит, мой учитель. / Gapirayotgan odam mening ustozim.', 'Прочитав текст, я ответил на вопросы. / Matnni o‘qib, savollarga javob berdim.'], terms: [['синтаксис', 'gap qurilishi', 'сложный синтаксис'], ['союз', 'bog‘lovchi', 'когда, потому что'], ['оборот', 'oborot', 'причастный оборот'], ['запятая', 'vergul', 'ставится запятая'], ['главная часть', 'asosiy qism', 'main clause'], ['зависимая часть', 'tobe qism', 'subordinate clause']], checks: [['Murakkab gapda bog‘lovchi nima qiladi?', ['gaplarni bog‘laydi', 'faqat sonni bildiradi', 'harfni almashtiradi', 'rangni bildiradi'], 0, 'Bog‘lovchi gap qismlarini bog‘laydi.'], ['Rus sintaksisida vergul nima uchun muhim?', ['talaffuz va ma’no chegarasi uchun', 'faqat bezak uchun', 'har doim kerak emas', 'faqat son oldida'], 0, 'Vergul gap qismlarini ajratadi.']] }); }
function russianCommunicationProfile(title, concept, meaning) { return makeProfile({ concept: title, core: `${title} ${meaning} o‘rgatadi.`, structure: 'Asosiy so‘zlar + to‘g‘ri kelishik/fe’l shakli + vaziyatga mos ibora.', usage: 'Kundalik suhbat, dars, ish, sayohat yoki rasmiy muloqotda ishlatiladi.', nuance: 'Rus tilida hurmat shakli, jins va kelishik ma’noga ta’sir qiladi. Faqat so‘zlarni tarjima qilish yetarli emas.', mistakes: 'So‘z tartibi, kelishik qo‘shimchasi va urg‘uni noto‘g‘ri ishlatish ko‘p uchraydi.', examples: ['Здравствуйте! / Assalomu alaykum.', 'Как вас зовут? / Ismingiz nima?', 'Я хочу купить книгу. / Men kitob sotib olmoqchiman.', 'Где находится школа? / Maktab qayerda joylashgan?', 'Можно мне помочь? / Yordam bersam bo‘ladimi?', 'Спасибо, до свидания. / Rahmat, xayr.'], terms: [['здравствуйте', 'salom/assalomu alaykum', 'Здравствуйте!'], ['пожалуйста', 'iltimos/marhamat', 'Скажите, пожалуйста...'], ['спасибо', 'rahmat', 'Спасибо!'], ['где', 'qayerda', 'Где школа?'], ['как', 'qanday/qalay', 'Как дела?'], ['можно', 'mumkinmi', 'Можно войти?']], checks: [['Hurmatli salomlashuv qaysi?', ['Привет', 'Здравствуйте', 'Пока', 'Да'], 1, 'Здравствуйте — rasmiy/hurmatli salom.'], ['“Qayerda?” ruscha qaysi?', ['кто', 'где', 'когда', 'почему'], 1, 'Где — qayerda.']] }); }
function koreanProfile(title, level) {
  const low = title.toLowerCase();
  if (title.includes('한글')) return makeProfile({ concept: '한글 basics', core: 'Koreys yozuvi 한글 undosh va unlilarni birlashtirib bo‘g‘in hosil qiladi. Har bir bo‘g‘in odatda kvadrat blok ichida yoziladi.', structure: 'Undosh + unli: 가, 나, 다. Undosh + unli + batchim: 한, 말, 학교.', usage: 'O‘qish, yozish va talaffuzni boshlash uchun asos hisoblanadi.', nuance: 'Koreys yozuvida harflar ketma-ket emas, bo‘g‘in bloklarida joylashadi. Batchim talaffuzga ta’sir qiladi.', mistakes: 'Harflarni lotinchadek ketma-ket yozish, batchimni o‘qimaslik va ㅓ/ㅗ, ㅡ/ㅜ ni adashtirish ko‘p uchraydi.', examples: ['가 — ga', '나 — na', '한글 — koreys yozuvi', '학교 — maktab', '사람 — odam', '한국 — Koreya'], terms: [['한글', 'koreys yozuvi', '한글을 배워요.'], ['자음', 'undosh', 'ㄱ, ㄴ, ㄷ'], ['모음', 'unli', 'ㅏ, ㅓ, ㅗ'], ['받침', 'bo‘g‘in oxiri undoshi', '한'], ['음절', 'bo‘g‘in', '가'], ['발음', 'talaffuz', '발음 연습']], checks: [['한글 nima?', ['koreys yozuvi', 'xitoy soni', 'rus harfi', 'ingliz zamoni'], 0, '한글 — koreys yozuvi.'], ['Bo‘g‘in oxiridagi undosh nima deyiladi?', ['모음', '받침', '문장', '조사'], 1, '받침 — bo‘g‘in oxiridagi undosh.']] });
  if (low.includes('particles') || title.includes('은') || title.includes('는') || title.includes('이') || title.includes('가') || title.includes('을') || title.includes('를') || title.includes('에') || title.includes('에서')) return koreanParticleProfile(title);
  if (low.includes('to be') || title.includes('이에요') || title.includes('예요')) return makeProfile({ concept: '이에요 / 예요', core: 'Koreys tilida 이에요/예요 “bo‘lmoq/dir” ma’nosida ot bilan ishlatiladi.', structure: 'Undosh bilan tugasa: 이에요. Unli bilan tugasa: 예요. 저는 학생이에요. 저는 의사예요.', usage: 'Kim yoki nima ekanini muloyim uslubda aytishda ishlatiladi.', nuance: 'Koreys tilida fe’l/qo‘shimcha gap oxirida keladi. O‘zbekchadagi “-man/-dir” ma’nosini gap oxiridagi 이에요/예요 beradi.', mistakes: 'Unli/undoshga qarab tanlamaslik, gap oxiriga qo‘ymaslik va juda norasmiy shakl bilan aralashtirish ko‘p uchraydi.', examples: ['저는 학생이에요. / Men o‘quvchiman.', '이것은 책이에요. / Bu kitob.', '저는 의사예요. / Men shifokorman.', '여기는 학교예요. / Bu yer maktab.', '그 사람은 선생님이에요. / U odam ustoz.', '오늘은 월요일이에요. / Bugun dushanba.'], terms: [['이에요', 'undoshdan keyin “dir”', '학생이에요'], ['예요', 'unlidan keyin “dir”', '의사예요'], ['저는', 'men', '저는 학생이에요'], ['이것은', 'bu narsa', '이것은 책이에요'], ['학생', 'o‘quvchi', '학생이에요'], ['선생님', 'ustoz', '선생님이에요']], checks: [['학생 + ___ qaysi to‘g‘ri?', ['예요', '이에요', '가요', '해요'], 1, '학생 undosh bilan tugaydi, 이에요.'], ['의사 + ___ qaysi to‘g‘ri?', ['이에요', '예요', '입니다요', '가 있어요'], 1, '의사 unli bilan tugaydi, 예요.']] });
  if (low.includes('past') || low.includes('present') || low.includes('future') || low.includes('tense')) return koreanTenseProfile(title);
  if (title.includes('고 싶다')) return koreanGrammarProfile(title, 'istak va xohishni', 'verb stem + 고 싶어요', ['저는 한국어를 배우고 싶어요. / Men koreys tilini o‘rganmoqchiman.', '물을 마시고 싶어요. / Suv ichmoqchiman.', '집에 가고 싶어요. / Uyga bormoqchiman.']);
  if (title.includes('수 있다')) return koreanGrammarProfile(title, 'qobiliyat yoki imkoniyatni', 'verb stem + ㄹ/을 수 있어요', ['저는 읽을 수 있어요. / Men o‘qiy olaman.', '한국어를 말할 수 있어요. / Koreyscha gapira olaman.', '갈 수 없어요. / Bora olmayman.']);
  if (title.includes('아서') || title.includes('어서') || low.includes('because') || low.includes('reason')) return koreanGrammarProfile(title, 'sabab yoki ketma-ketlikni', '아/어서', ['바빠서 못 가요. / Band bo‘lganim uchun bora olmayman.', '배고파서 먹었어요. / Qorni och bo‘lgani uchun yedim.', '집에 가서 쉬어요. / Uyga borib dam olaman.']);
  if (title.includes('때') || low.includes('when')) return koreanGrammarProfile(title, 'vaqt/“paytida” ma’nosini', 'verb/adjective + 때', ['학교에 갈 때 공부해요. / Maktabga borganda o‘qiyman.', '어릴 때 많이 놀았어요. / Bolaligimda ko‘p o‘ynaganman.', '시간이 있을 때 전화하세요. / Vaqtingiz bo‘lganda telefon qiling.']);
  if (low.includes('honorific')) return koreanGrammarProfile(title, 'hurmat shaklini', 'verb stem + 시/으시 + ending', ['선생님이 오세요. / Ustoz keladilar.', '할머니께서 주무세요. / Buvim uxlayaptilar.', '어디에 가세요? / Qayerga ketyapsiz?']);
  if (low.includes('indirect speech')) return koreanGrammarProfile(title, 'boshqa odam gapini hikoya qilishni', '-다고 하다 / -냐고 하다', ['그는 간다고 했어요. / U borishini aytdi.', '학생이라고 했어요. / O‘quvchi ekanini aytdi.', '뭐 하냐고 물었어요. / Nima qilyapsan deb so‘radi.']);
  if (low.includes('intention') || title.includes('려고')) return koreanGrammarProfile(title, 'niyat va maqsadni', 'verb stem + 려고 해요', ['공부하려고 해요. / O‘qimoqchiman.', '친구를 만나려고 해요. / Do‘stim bilan uchrashmoqchiman.', '한국에 가려고 해요. / Koreyaga bormoqchiman.']);
  if (title.includes('아/어 봤다') || low.includes('experience')) return koreanGrammarProfile(title, 'tajriba qilib ko‘rganlikni', 'verb stem + 아/어 봤어요', ['김치를 먹어 봤어요. / Kimchini yeb ko‘rganman.', '한국에 가 봤어요. / Koreyaga borib ko‘rganman.', '이 책을 읽어 봤어요. / Bu kitobni o‘qib ko‘rganman.']);
  if (title.includes('아/어야 하다') || low.includes('must')) return koreanGrammarProfile(title, 'majburiyat yoki keraklikni', 'verb stem + 아/어야 해요', ['공부해야 해요. / O‘qishim kerak.', '일찍 자야 해요. / Erta uxlash kerak.', '숙제를 해야 해요. / Uy vazifasini qilish kerak.']);
  if (low.includes('passive')) return koreanGrammarProfile(title, 'majhul nisbatni', '이/히/리/기 yoki 되다 shakllari', ['문이 열려요. / Eshik ochiladi.', '책이 읽혀요. / Kitob o‘qiladi.', '문제가 해결됐어요. / Muammo hal bo‘ldi.']);
  if (low.includes('connect') || low.includes('ending') || low.includes('nuance') || low.includes('grammar')) return koreanGrammarProfile(title, `${title} orqali gaplarni bog‘lash yoki ma’no nozikligini`, 'Korean ending + context', ['그래서 집에 갔어요. / Shuning uchun uyga ketdim.', '하지만 어려워요. / Lekin qiyin.', '공부하면서 음악을 들어요. / O‘qiyotib musiqa eshitaman.']);
  if (low.includes('shopping') || low.includes('directions') || low.includes('weather') || low.includes('hobbies') || low.includes('phone') || low.includes('conversation') || low.includes('speaking') || low.includes('debate') || low.includes('presentations') || low.includes('interview')) return koreanCommunicationProfile(title);
  if (low.includes('writing')) return koreanCommunicationProfile(title);
  return koreanCommunicationProfile(title);
}
function koreanParticleProfile(title) { return makeProfile({ concept: title, core: `${title} koreys tilida so‘zning gapdagi vazifasini ko‘rsatadigan qo‘shimcha/particle mavzusidir.`, structure: 'ot + particle: 저는, 학생이, 책을, 학교에, 학교에서.', usage: 'Ega, mavzu, obyekt, joy, yo‘nalish va harakat joyini aniqlashda ishlatiladi.', nuance: '은/는 mavzu yoki kontrastni, 이/가 esa ega yoki yangi ma’lumotni kuchliroq ko‘rsatadi. 을/를 obyektni bildiradi.', mistakes: 'Particle qo‘ymaslik, noto‘g‘ri particle tanlash yoki gap oxiridagi fe’l bilan moslashtirmaslik ko‘p uchraydi.', examples: ['저는 학생이에요. / Men o‘quvchiman.', '학생이 와요. / O‘quvchi keladi.', '책을 읽어요. / Kitob o‘qiyman.', '학교에 가요. / Maktabga boraman.', '학교에서 공부해요. / Maktabda o‘qiyman.', '사과를 먹어요. / Olma yeyman.'], terms: [['은/는', 'mavzu particle', '저는 학생이에요'], ['이/가', 'ega particle', '학생이 와요'], ['을/를', 'obyekt particle', '책을 읽어요'], ['에', 'yo‘nalish/joy', '학교에 가요'], ['에서', 'harakat joyi', '학교에서 공부해요'], ['조사', 'particle', '한국어 조사']], checks: [['Obyekt particle qaysi?', ['은/는', '이/가', '을/를', '에'], 2, '을/를 obyektni bildiradi.'], ['“Maktabda o‘qiyman” uchun qaysi particle mos?', ['학교에 공부해요', '학교에서 공부해요', '학교를 공부해요', '학교가 공부해요'], 1, 'Harakat joyi: 에서.']] }); }
function koreanTenseProfile(title) { return makeProfile({ concept: title, core: `${title} koreys tilida harakatning vaqtini bildiradi. Fe’l asosi va gap oxiridagi ending zamonni ko‘rsatadi.`, structure: 'Present: 아/어요; Past: 았/었어요; Future: ㄹ/을 거예요.', usage: 'Hozirgi odat, o‘tgan voqea va kelajak reja haqida gapirganda ishlatiladi.', nuance: 'Koreys tilida gap oxiridagi fe’l/ending eng muhim qism. Zamon ko‘pincha aynan shu yerda bilinadi.', mistakes: 'Fe’l asosini noto‘g‘ri ajratish, unli uyg‘unligini adashtirish va endingni tushirib qoldirish ko‘p uchraydi.', examples: ['가요. / Boraman.', '갔어요. / Bordim.', '갈 거예요. / Boraman (kelajak).', '먹어요. / Yeyman.', '먹었어요. / Yedim.', '먹을 거예요. / Yeyman (kelajak).'], terms: [['아/어요', 'hozirgi/polite ending', '가요'], ['았/었어요', 'o‘tgan zamon', '갔어요'], ['ㄹ/을 거예요', 'kelasi zamon', '갈 거예요'], ['동사 어간', 'fe’l asosi', '가-'], ['현재', 'hozirgi zamon', 'present'], ['과거', 'o‘tgan zamon', 'past']], checks: [['“갔어요” qaysi zamon?', ['hozirgi', 'o‘tgan', 'kelasi', 'savol'], 1, '갔어요 — o‘tgan zamon.'], ['Kelasi zamon shakli qaysi?', ['가요', '갔어요', '갈 거예요', '가고 있어요'], 2, 'ㄹ/을 거예요 kelajakni bildiradi.']] }); }
function koreanGrammarProfile(title, meaning, structure, examples) { return makeProfile({ concept: title, core: `${title} ${meaning} bildiradi. Koreys tilida bunday ma’no odatda fe’l asosiga qo‘shimcha ending qo‘shish orqali yasaladi.`, structure, usage: 'Kundalik suhbat, yozish, TOPIK uslubidagi matn va og‘zaki javoblarda ishlatiladi.', nuance: 'Fe’l asosi, oxirgi unli/undosh va hurmat darajasi to‘g‘ri tanlanishi kerak.', mistakes: 'Fe’l asosini noto‘g‘ri ajratish, qo‘shimchani gap oxiriga noto‘g‘ri ulash va particle bilan adashtirish ko‘p uchraydi.', examples, terms: [[title, 'mavzu nomi', examples[0] || title], ['어간', 'fe’l asosi', '가- / 먹-'], ['어미', 'fe’l yakuni', structure], ['정중한 말', 'muloyim nutq', '-요'], ['문장 끝', 'gap oxiri', 'verb ending'], ['의미', 'ma’no', meaning]], checks: [[`${title} mavzusida asosiy tuzilma qaysi?`, [structure, '은/는 + noun', 'a/an/the + noun', 'do + subject + V1'], 0, `Asosiy tuzilma: ${structure}`], [`${title} nimani bildiradi?`, [meaning, 'faqat rangni', 'faqat sonni', 'faqat artiklni'], 0, `${title} ${meaning} bildiradi.`]] }); }
function koreanCommunicationProfile(title) { return makeProfile({ concept: title, core: `${title} koreys tilida real vaziyatda muloqot qilish uchun kerakli ibora va grammatikani o‘rgatadi.`, structure: 'situation phrase + particle + polite ending (-요 / -습니다).', usage: 'Salomlashish, xarid, yo‘l so‘rash, ob-havo, hobbi, ish, bahs yoki suhbat vaziyatida ishlatiladi.', nuance: 'Koreys tilida hurmat darajasi juda muhim. Yoshi katta yoki notanish odam bilan muloyim ending ishlatiladi.', mistakes: 'Norasmiy va rasmiy uslubni aralashtirish, particle tushirib qoldirish va fe’lni gap oxiriga qo‘ymaslik ko‘p uchraydi.', examples: ['안녕하세요. / Salom.', '어디에 가요? / Qayerga ketyapsiz?', '얼마예요? / Necha pul?', '도와주세요. / Yordam bering.', '괜찮아요. / Mayli/yaxshi.', '감사합니다. / Rahmat.'], terms: [['안녕하세요', 'salom', '안녕하세요!'], ['감사합니다', 'rahmat', '감사합니다.'], ['어디', 'qayer', '어디에 가요?'], ['얼마예요', 'necha pul', '이거 얼마예요?'], ['주세요', 'bering', '물 주세요.'], ['괜찮아요', 'yaxshi/mayli', '괜찮아요.']], checks: [['Koreyscha rasmiy rahmat qaysi?', ['안녕하세요', '감사합니다', '어디예요', '주세요'], 1, '감사합니다 — rahmat.'], ['“Necha pul?” koreyscha qaysi?', ['얼마예요?', '어디예요?', '누구예요?', '왜요?'], 0, '얼마예요? narx so‘rash uchun.']] }); }

function openWritingTasks(items) {
  return items.slice(0, 5).map((item, index) => ({
    id: `w${index + 1}`,
    type: 'open_answer',
    title: item.title || 'Yozma javob yozing',
    prompt: item.prompt,
    expected: Array.isArray(item.expected) ? item.expected : [item.expected],
    hint: item.hint || 'Javobni to‘liq va tushunarli gap bilan yozing.'
  }));
}
function onaTiliProfile(title, level) {
  const low = title.toLowerCase();
  if (low.includes('ega') && low.includes('kesim')) return makeProfile({
    concept: 'Ega va kesim',
    core: 'Ega va kesim gapning bosh bo‘laklari hisoblanadi. Ega gapda kim yoki nima haqida aytilayotganini bildiradi, kesim esa ega haqida xabar beradi.',
    structure: 'Ega odatda kim? nima? qayer? so‘roqlariga, kesim esa nima qildi? nima bo‘ldi? qanday? kabi so‘roqlarga javob beradi.',
    usage: 'Gapni tahlil qilish, tinish belgilarini to‘g‘ri qo‘yish va mazmunni tushunishda ega-kesimni ajratish juda muhim.',
    nuance: 'Ba’zan ega gapda yashirin keladi: “Keldim” gapida ega “men” yashiringan. Kesim esa gapning mazmunini tugallaydi.',
    mistakes: 'O‘quvchilar ko‘pincha to‘ldiruvchini ega deb, aniqlovchini kesim deb adashtiradi. Har doim so‘roq bering va gapda asosiy xabar qaysi so‘zda ekanini toping.',
    examples: ['Ali kitob o‘qidi. / Ega — Ali, kesim — o‘qidi.', 'Bugun havo sovuq. / Ega — havo, kesim — sovuq.', 'O‘quvchilar darsga keldi. / Ega — o‘quvchilar, kesim — keldi.', 'Men maktabdaman. / Ega — men, kesim — maktabdaman.', 'Bog‘da gullar ochildi. / Ega — gullar, kesim — ochildi.'],
    terms: [['ega', 'gap kim yoki nima haqida ekanini bildiradi', 'Ali keldi. Ega — Ali.'], ['kesim', 'ega haqida xabar beradi', 'Ali keldi. Kesim — keldi.'], ['bosh bo‘lak', 'gapning asosiy bo‘lagi', 'Ega va kesim bosh bo‘lakdir.'], ['yashirin ega', 'gapda yozilmagan, lekin anglashiladigan ega', 'Keldim = Men keldim.'], ['so‘roq', 'bo‘lakni topishga yordam beradi', 'Kim keldi? Ali.']],
    checks: [
      ['“Ali kitob o‘qidi” gapida ega qaysi?', ['Ali', 'kitob', 'o‘qidi', 'gap yo‘q'], 0, 'Kim o‘qidi? Ali — ega.'],
      ['“O‘quvchilar keldi” gapida kesim qaysi?', ['O‘quvchilar', 'keldi', 'gap', 'dars'], 1, 'Nima qildi? keldi — kesim.'],
      ['Qaysi gapda ega yashirin?', ['Keldim.', 'Ali keldi.', 'Kitob qiziqarli.', 'Havo sovuq.'], 0, 'Keldim = Men keldim.'],
      ['Kesim nimani bildiradi?', ['Ega haqida xabarni', 'faqat joy nomini', 'faqat sonni', 'so‘zning sinonimini'], 0, 'Kesim ega haqida xabar beradi.']
    ],
    writingTasks: openWritingTasks([
      { prompt: '“Ali kitob o‘qidi” gapida ega va kesimni yozing.', expected: ['Ega Ali, kesim o‘qidi', 'Ali ega, o‘qidi kesim'], hint: 'Ega va kesimni alohida ko‘rsating.' },
      { prompt: '“Bugun havo sovuq” gapida kesimni toping.', expected: ['Kesim sovuq', 'sovuq'], hint: 'Kesim ega haqida xabar beradi.' },
      { prompt: 'Yashirin egali bitta gap yozing.', expected: ['Keldim', 'Bordim', 'O‘qidim', 'Yozdim'], hint: 'Masalan: Keldim = Men keldim.' },
      { prompt: 'Ega qanday so‘roqlarga javob beradi?', expected: ['Kim nima qayer', 'kim nima', 'kim? nima?'], hint: 'Asosiy so‘roqlarni yozing.' },
      { prompt: 'Ega va kesim qatnashgan bitta gap tuzing.', expected: ['Ali keldi', 'Men o‘qidim', 'O‘quvchi yozdi'], hint: 'To‘liq gap yozing.' }
    ])
  });
  if (low.includes('ot')) return makeProfile({
    concept: 'Ot so‘z turkumi',
    core: 'Ot shaxs, narsa, joy, hodisa yoki tushuncha nomini bildiradi. Otlar kim? nima? qayer? so‘roqlariga javob beradi.',
    structure: 'Ot + qo‘shimcha: kitob, kitoblar, kitobim, kitobni. Ot gapda ega, to‘ldiruvchi yoki hol vazifasida kelishi mumkin.',
    usage: 'Predmet va shaxs nomlarini aytishda, matn tuzishda, gap bo‘laklarini aniqlashda ishlatiladi.',
    nuance: 'Kim? so‘rog‘i ko‘pincha shaxsga, nima? so‘rog‘i narsa va tushunchaga, qayer? so‘rog‘i joy nomiga beriladi.',
    mistakes: 'Sifat va otni adashtirish ko‘p uchraydi: “chiroyli” belgi, “kitob” narsa nomidir.',
    examples: ['O‘quvchi darsga keldi. / O‘quvchi — ot.', 'Kitob stol ustida turibdi. / Kitob — ot.', 'Toshkent katta shahar. / Toshkent — joy nomi.', 'Do‘stlik kuch beradi. / Do‘stlik — tushuncha nomi.', 'Gullar ochildi. / Gullar — ot.'],
    terms: [['ot', 'nom bildiruvchi so‘z turkumi', 'kitob'], ['shaxs oti', 'inson nomi yoki kasb', 'o‘quvchi'], ['narsa oti', 'predmet nomi', 'qalam'], ['joy oti', 'joy nomi', 'Toshkent'], ['ko‘plik', 'bir nechta narsa', 'kitoblar']],
    checks: [['Qaysi so‘z ot?', ['kitob', 'chiroyli', 'tez', 'keldi'], 0, 'Kitob narsa nomi.'], ['Ot qaysi so‘roqqa javob beradi?', ['kim? nima?', 'qanday?', 'nechanchi?', 'qachon?'], 0, 'Ot kim? nima? qayer? so‘roqlariga javob beradi.'], ['“O‘quvchi yozdi” gapida ot qaysi?', ['O‘quvchi', 'yozdi', 'gap', 'qaysi'], 0, 'O‘quvchi — shaxs nomi.']],
    writingTasks: openWritingTasks([
      { prompt: 'Otga 3 ta misol yozing.', expected: ['kitob qalam o‘quvchi', 'o‘quvchi maktab kitob'], hint: 'Shaxs, narsa yoki joy nomlarini yozing.' },
      { prompt: '“Kitob qiziqarli” gapida otni toping.', expected: ['kitob'], hint: 'Narsa nomini toping.' },
      { prompt: 'Kim? so‘rog‘iga javob bo‘ladigan 2 ta ot yozing.', expected: ['o‘quvchi ustoz', 'Ali o‘qituvchi'], hint: 'Shaxs nomlarini yozing.' },
      { prompt: 'Nima? so‘rog‘iga javob bo‘ladigan 2 ta ot yozing.', expected: ['kitob qalam', 'daftar ruchka'], hint: 'Narsa nomlarini yozing.' },
      { prompt: 'Ot qatnashgan bitta gap yozing.', expected: ['Kitob qiziqarli', 'O‘quvchi keldi', 'Qalam stol ustida'], hint: 'Gapda ot bo‘lsin.' }
    ])
  });
  if (low.includes('sifat')) return makeProfile({
    concept: 'Sifat so‘z turkumi',
    core: 'Sifat predmetning belgi-xususiyatini bildiradi. U qanday? qanaqa? qaysi? so‘roqlariga javob beradi.',
    structure: 'Sifat ko‘pincha ot oldidan keladi: chiroyli gul, katta uy, bilimli o‘quvchi.',
    usage: 'Narsani tasvirlash, matnni boyitish va fikrni aniqroq aytishda ishlatiladi.',
    nuance: 'Sifat predmetning o‘zini emas, uning belgisini bildiradi. “Kitob” ot, “qiziqarli” sifat.',
    mistakes: 'Ot va sifatni adashtirmang: ot nom bildiradi, sifat belgi bildiradi.',
    examples: ['Chiroyli gul ochildi. / Chiroyli — sifat.', 'Katta uy ko‘rindi. / Katta — sifat.', 'Bilimli o‘quvchi javob berdi. / Bilimli — sifat.', 'Shirin olma yedim. / Shirin — sifat.', 'Yangi daftar oldim. / Yangi — sifat.'],
    terms: [['sifat', 'belgi bildiradi', 'chiroyli'], ['belgi', 'predmet xususiyati', 'katta'], ['qanday?', 'sifat so‘rog‘i', 'qanday uy? katta uy'], ['qanaqa?', 'sifat so‘rog‘i', 'qanaqa gul? chiroyli gul'], ['ot', 'sifat izohlaydigan so‘z', 'qiziqarli kitob']],
    checks: [['Qaysi so‘z sifat?', ['chiroyli', 'kitob', 'keldi', 'beshta'], 0, 'Chiroyli belgi bildiradi.'], ['Sifat qaysi so‘roqqa javob beradi?', ['qanday?', 'kim?', 'nima qildi?', 'qachon?'], 0, 'Sifat qanday? qanaqa? so‘roqlariga javob beradi.'], ['“Yangi daftar” birikmasida sifat qaysi?', ['yangi', 'daftar', 'birikma', 'yo‘q'], 0, 'Yangi — belgi bildiradi.']],
    writingTasks: openWritingTasks([
      { prompt: 'Sifatga 3 ta misol yozing.', expected: ['chiroyli katta yangi', 'yaxshi shirin bilimli'], hint: 'Belgi bildiruvchi so‘zlar yozing.' },
      { prompt: '“Qiziqarli kitob” birikmasida sifatni toping.', expected: ['qiziqarli'], hint: 'Qanday kitob?' },
      { prompt: 'Sifat qatnashgan bitta gap yozing.', expected: ['Chiroyli gul ochildi', 'Yangi daftar oldim'], hint: 'Gapda belgi bildiruvchi so‘z bo‘lsin.' },
      { prompt: 'Sifat qaysi so‘roqlarga javob beradi?', expected: ['qanday qanaqa qaysi', 'qanday qanaqa'], hint: 'Sifat so‘roqlarini yozing.' },
      { prompt: '“Katta uy” birikmasida otni yozing.', expected: ['uy'], hint: 'Sifat nimani izohlayapti?' }
    ])
  });
  return makeProfile({
    concept: title,
    core: `${title} ona tili fanida savodxonlik, to‘g‘ri tahlil va matn tuzish uchun muhim mavzu hisoblanadi. O‘quvchi avval mavzuning ma’nosini, keyin uning gap yoki matndagi vazifasini tushunishi kerak.`,
    structure: `${title} mavzusida avval ta’rifni ajrating, keyin so‘roqlar, belgilar va misollar orqali mustahkamlang. Har bir qoida alohida misol bilan yodda qoladi.`,
    usage: 'Diktant, matn tahlili, insho, test va og‘zaki javoblarda ishlatiladi. Mavzuni o‘zlashtirish uchun qoidani misol bilan bog‘lash kerak.',
    nuance: 'Ona tilida bitta so‘z gapda turli vazifa bajarishi mumkin. Shuning uchun so‘zning o‘zini emas, gapdagi vazifasini ham tekshiring.',
    mistakes: 'Faqat ta’rifni yodlash, misol keltira olmaslik va so‘roqlarni bermaslik ko‘p uchraydigan xatodir.',
    examples: [`${title} mavzusida avval qoidani ayting. / Qoidani eslab qolish birinchi qadam.`, `${title} uchun 2 ta misol yozing. / Misol mavzuni mustahkamlaydi.`, `${title} mavzusini gap ichida qo‘llang. / Qoida amaliy ishlatilganda yaxshi tushuniladi.`, `Matndan ${title}ga oid birlikni toping. / Tahlil qilish ko‘nikmani kuchaytiradi.`, `${title} bo‘yicha xatoni tuzating. / Xato orqali qoida mustahkamlanadi.`],
    terms: vocabSets.ona_tili,
    checks: [[`${title}ni yaxshi o‘zlashtirish uchun birinchi qadam nima?`, ['Ta’rifni tushunish va misol ko‘rish', 'Faqat taxmin qilish', 'Javobni ko‘chirish', 'Mavzuni tashlab ketish'], 0, 'Avval ma’no tushuniladi, keyin misol bilan mustahkamlanadi.'], [`${title} mavzusida eng foydali mashq qaysi?`, ['Gap yoki matndan misol topish', 'Faqat rasm chizish', 'Faqat sanani yodlash', 'Javobsiz qoldirish'], 0, 'Ona tilida amaliy tahlil muhim.'], ['Qoidani eslab qolish uchun nima qilish kerak?', ['Misol bilan bog‘lash', 'Umuman yozmaslik', 'Faqat tarjima qilish', 'Tasodifiy tanlash'], 0, 'Misollar qoidani tezroq esda qoldiradi.']],
    writingTasks: openWritingTasks([
      { prompt: `${title} mavzusining qisqa ta’rifini yozing.`, expected: [`${title} ona tili mavzusi`, `${title} muhim mavzu`], hint: 'Ta’rifni o‘z so‘zingiz bilan yozing.' },
      { prompt: `${title} mavzusiga bitta misol yozing.`, expected: [`${title} misol`, 'misol yozdim'], hint: 'Mavzuga mos misol keltiring.' },
      { prompt: `${title} bo‘yicha bitta qoida yozing.`, expected: [`${title} qoidasi`, 'qoida'], hint: 'Qoidani qisqa yozing.' },
      { prompt: `${title} nima uchun kerak?`, expected: ['to‘g‘ri yozish va tahlil qilish uchun', 'savodxonlik uchun', 'matn tuzish uchun'], hint: 'Amaliy foydasini yozing.' },
      { prompt: `${title} mavzusini mustahkamlash uchun qanday mashq qilasiz?`, expected: ['misol yozaman', 'gap tuzaman', 'matndan topaman'], hint: 'O‘zingiz bajaradigan mashqni yozing.' }
    ])
  });
}
function historyProfile(title, level) {
  const low = title.toLowerCase();
  if (low.includes('xronologiya')) return makeProfile({
    concept: 'Xronologiya',
    core: 'Xronologiya tarixiy voqealarni vaqt tartibida o‘rganishdir. U voqealar qachon bo‘lganini va qaysi voqea oldin yoki keyin sodir bo‘lganini tushunishga yordam beradi.',
    structure: 'Sana → voqea → sabab → oqibat tartibida tahlil qilinadi. Masalan: 1991-yil — O‘zbekiston mustaqillikka erishdi — yangi davlat rivojlanishi boshlandi.',
    usage: 'Tarixiy jadval tuzish, testda sanani topish, voqealarni solishtirish va tarixiy jarayonni tushunishda ishlatiladi.',
    nuance: 'Faqat sanani yodlash yetarli emas. Sana bilan birga voqea, joy, shaxs va natijani ham bog‘lab eslab qolish kerak.',
    mistakes: 'Yillarni aralashtirish, asrni noto‘g‘ri aniqlash va voqeani sanadan ajratib yodlash ko‘p uchraydi.',
    examples: ['1991-yil — O‘zbekiston mustaqillikka erishdi. / Bu sana mustaqillik bilan bog‘liq.', 'Amir Temur 14-asrda yashagan. / Asrni aniqlash xronologiyaga kiradi.', 'Oldin sabab, keyin voqea, so‘ng oqibat tahlil qilinadi. / Tarixiy tartib muhim.', 'Miloddan avvalgi davrlar teskari sanaladi. / Qadimgi tarixda ehtiyot bo‘lish kerak.', 'Tarixiy jadval voqealarni tartiblaydi. / Jadval eslab qolishni osonlashtiradi.'],
    terms: [['xronologiya', 'vaqt tartibi', 'Voqealar xronologik tartibda yoziladi.'], ['sana', 'voqea bo‘lgan vaqt', '1991-yil'], ['asr', '100 yillik davr', 'XX asr'], ['davr', 'tarixiy vaqt oralig‘i', 'Qadimgi davr'], ['voqea', 'tarixda sodir bo‘lgan hodisa', 'Mustaqillik e’lon qilindi.']],
    checks: [['Xronologiya nimani o‘rganadi?', ['Voqealarni vaqt tartibida', 'faqat xaritani', 'faqat she’rni', 'faqat til qoidalarini'], 0, 'Xronologiya vaqt tartibini o‘rganadi.'], ['1991-yil O‘zbekiston tarixida nima bilan bog‘liq?', ['Mustaqillik', 'Qadimgi Rim', 'Mo‘g‘ullar istilosi', 'Somoniylar tugashi'], 0, '1991-yil mustaqillik yili.'], ['Asr nechta yildan iborat?', ['100 yil', '10 yil', '1000 yil', '50 yil'], 0, 'Bir asr 100 yil.']],
    writingTasks: openWritingTasks([
      { prompt: 'Xronologiya nima?', expected: ['Voqealarni vaqt tartibida o‘rganish', 'tarixiy voqealarni vaqt tartibida o‘rganadi'], hint: 'Qisqa ta’rif yozing.' },
      { prompt: '1991-yil O‘zbekiston tarixida nima bo‘lgan?', expected: ['O‘zbekiston mustaqillikka erishdi', 'mustaqillik e’lon qilindi'], hint: 'Sana bilan voqeani bog‘lang.' },
      { prompt: 'Bir asr nechta yildan iborat?', expected: ['100 yil', 'yuz yil'], hint: 'Raqam bilan ham yozishingiz mumkin.' },
      { prompt: 'Tarixiy voqeani tahlil qilishda nimalar yoziladi?', expected: ['sana voqea sabab oqibat', 'sana va voqea sabab oqibat'], hint: 'Tartibni yozing.' },
      { prompt: 'Xronologik jadval nima uchun kerak?', expected: ['voqealarni tartibga solish uchun', 'voqealarni eslab qolish uchun'], hint: 'Amaliy foydasini yozing.' }
    ])
  });
  if (low.includes('tarixiy manba') || low.includes('manbalar')) return makeProfile({
    concept: 'Tarixiy manbalar',
    core: 'Tarixiy manba o‘tmish haqida ma’lumot beradigan dalildir. Manbalar orqali tarixchi voqealar, shaxslar, madaniyat va jamiyat hayotini o‘rganadi.',
    structure: 'Manba turi → undagi ma’lumot → ishonchlilik → tarixiy xulosa. Manbalar yozma, moddiy, og‘zaki va tasviriy bo‘lishi mumkin.',
    usage: 'Tarixiy faktni isbotlash, voqeani solishtirish va xulosa chiqarishda ishlatiladi.',
    nuance: 'Har bir manba ham to‘liq va xolis bo‘lmasligi mumkin. Shuning uchun bir nechta manbani solishtirish kerak.',
    mistakes: 'Manba bilan fikrni adashtirish, dalilsiz xulosa qilish va faqat bitta manbaga tayanish xato hisoblanadi.',
    examples: ['Yozma manba — yilnoma yoki hujjat. / U voqea haqida yozma xabar beradi.', 'Moddiy manba — tangalar, qurollar, binolar. / U hayot tarzini ko‘rsatadi.', 'Og‘zaki manba — rivoyat va xotiralar. / U xalq xotirasini aks ettiradi.', 'Tasviriy manba — rasm yoki xarita. / U ko‘rinish orqali ma’lumot beradi.', 'Manbalar solishtirilsa, xulosa aniqroq bo‘ladi. / Tarixiy tahlil kuchayadi.'],
    terms: [['manba', 'tarixiy dalil', 'Manba tarix haqida ma’lumot beradi.'], ['yozma manba', 'hujjat, yilnoma, kitob', 'Yilnoma yozma manbadir.'], ['moddiy manba', 'buyum yoki inshoot', 'Tanga moddiy manba.'], ['og‘zaki manba', 'rivoyat yoki xotira', 'Rivoyat og‘zaki manba.'], ['xulosa', 'manbadan chiqarilgan fikr', 'Xulosa dalilga tayanadi.']],
    checks: [['Tarixiy manba nima?', ['O‘tmish haqida ma’lumot beruvchi dalil', 'faqat badiiy so‘z', 'matematik formula', 'sport turi'], 0, 'Manba tarixiy dalildir.'], ['Tanga qaysi manba turiga kiradi?', ['moddiy manba', 'og‘zaki manba', 'badiiy uslub', 'sifat'], 0, 'Tanga buyum, ya’ni moddiy manba.'], ['Yilnoma qaysi manba?', ['yozma manba', 'moddiy manba', 'og‘zaki manba', 'xarita emas'], 0, 'Yilnoma yozma manbadir.']],
    writingTasks: openWritingTasks([
      { prompt: 'Tarixiy manba nima?', expected: ['o‘tmish haqida ma’lumot beruvchi dalil', 'tarixiy dalil'], hint: 'Ta’rif yozing.' },
      { prompt: 'Moddiy manbaga 2 ta misol yozing.', expected: ['tanga qurol', 'bino tanga', 'sopol buyum tanga'], hint: 'Buyum yoki inshoot yozing.' },
      { prompt: 'Yozma manbaga misol yozing.', expected: ['yilnoma', 'hujjat', 'kitob'], hint: 'Yozib qoldirilgan manba.' },
      { prompt: 'Nega manbalarni solishtirish kerak?', expected: ['xulosa aniqroq bo‘lishi uchun', 'ishonchli xulosa uchun'], hint: 'Sababini yozing.' },
      { prompt: 'Og‘zaki manbaga misol yozing.', expected: ['rivoyat', 'xotira', 'afsona'], hint: 'Og‘zaki aytiladigan manba.' }
    ])
  });
  if (low.includes('amir temur')) return makeProfile({
    concept: 'Amir Temur davlati',
    core: 'Amir Temur 14-asrda kuchli markazlashgan davlat barpo etgan buyuk sarkarda va davlat arbobidir. Uning davrida boshqaruv, harbiy tartib va bunyodkorlik ishlari rivojlangan.',
    structure: 'Shaxs → davr → davlat boshqaruvi → harbiy yurishlar → madaniy meros tartibida o‘rganiladi.',
    usage: 'O‘zbekiston tarixi, davlat boshqaruvi, harbiy san’at va madaniy meros mavzularida ishlatiladi.',
    nuance: 'Amir Temur faqat sarkarda sifatida emas, balki davlat boshqaruvini mustahkamlagan tarixiy shaxs sifatida ham o‘rganiladi.',
    mistakes: 'Sana va asrlarni aralashtirish, Temuriylar bilan Amir Temur davrini ajratmaslik ko‘p uchraydi.',
    examples: ['Amir Temur 14-asrda yashagan. / Bu davr O‘rta asrlar tarixiga kiradi.', 'Samarqand Temur davrida yuksaldi. / Shahar madaniy markazga aylandi.', 'Markazlashgan davlat kuchaydi. / Boshqaruv tartibi mustahkamlandi.', 'Temur tuzuklari boshqaruvga oid manbadir. / Unda tartib-qoidalar aks etgan.', 'Temuriylar davrida ilm-fan va san’at rivojlandi. / Bu madaniy merosdir.'],
    terms: [['Amir Temur', 'buyuk sarkarda va davlat arbobi', 'Amir Temur davlat barpo etdi.'], ['Samarqand', 'poytaxt va madaniy markaz', 'Samarqand yuksaldi.'], ['markazlashgan davlat', 'boshqaruv bir markazdan bo‘lishi', 'Davlat markazlashdi.'], ['Temur tuzuklari', 'boshqaruv qoidalari manbasi', 'Tuzuklar tarixiy manbadir.'], ['Temuriylar', 'Amir Temur avlodlari davri', 'Temuriylar madaniyati rivojlandi.']],
    checks: [['Amir Temur qaysi jihati bilan mashhur?', ['sarkarda va davlat arbobi', 'faqat shoir', 'faqat dengizchi', 'faqat rassom'], 0, 'Amir Temur sarkarda va davlat arbobi.'], ['Temur davrida qaysi shahar yuksaldi?', ['Samarqand', 'Rim', 'Afina', 'London'], 0, 'Samarqand Temur davrida yuksalgan.'], ['Temur tuzuklari nimaga oid?', ['boshqaruv va tartib-qoidalarga', 'faqat oshpazlikka', 'faqat she’riyatga', 'sportga'], 0, 'Tuzuklar boshqaruvga oid manbadir.']],
    writingTasks: openWritingTasks([
      { prompt: 'Amir Temur kim bo‘lgan?', expected: ['sarkarda va davlat arbobi', 'buyuk sarkarda'], hint: 'Shaxsning tarixiy rolini yozing.' },
      { prompt: 'Temur davrida qaysi shahar yuksalgan?', expected: ['Samarqand'], hint: 'Poytaxt va madaniy markazni yozing.' },
      { prompt: 'Markazlashgan davlat nima?', expected: ['boshqaruv bir markazdan bo‘lgan davlat', 'bir markazdan boshqariladigan davlat'], hint: 'Boshqaruvga e’tibor bering.' },
      { prompt: 'Temur tuzuklari nimaga oid manba?', expected: ['boshqaruv va tartib qoidalarga', 'davlat boshqaruviga'], hint: 'Manbaning mazmunini yozing.' },
      { prompt: 'Amir Temur mavzusidan bitta xulosa yozing.', expected: ['Amir Temur kuchli davlat barpo etdi', 'Samarqand yuksaldi', 'davlat boshqaruvi mustahkamlandi'], hint: 'To‘liq gap yozing.' }
    ])
  });
  if (low.includes('mustaqillik') || low.includes('1991')) return makeProfile({
    concept: 'O‘zbekiston mustaqilligi',
    core: '1991-yil O‘zbekiston mustaqil davlat sifatida tarix sahnasiga chiqdi. Mustaqillik xalqning o‘z taqdirini o‘zi belgilashi, davlat ramzlari va mustaqil boshqaruvga ega bo‘lishini anglatadi.',
    structure: 'Sana → voqea → mazmun → natija: 1991-yil → mustaqillik → suveren davlat → yangi taraqqiyot bosqichi.',
    usage: 'O‘zbekiston tarixi, davlat ramzlari, konstitutsiya va zamonaviy rivojlanish mavzularida ishlatiladi.',
    nuance: 'Mustaqillik faqat sana emas, balki siyosiy, huquqiy va ma’naviy jarayondir.',
    mistakes: 'Sana bilan mazmunni ajratib yodlash, mustaqillikning natijalarini tushuntira olmaslik ko‘p uchraydi.',
    examples: ['1991-yil O‘zbekiston mustaqillikka erishdi. / Bu eng muhim tarixiy sana.', 'Mustaqillik suveren davlat bo‘lishni anglatadi. / Davlat o‘z yo‘lini tanlaydi.', 'Davlat ramzlari qabul qilindi. / Mustaqil davlat belgilariga ega bo‘lindi.', 'Konstitutsiya davlatning asosiy qonunidir. / Huquqiy asos yaratiladi.', 'Mustaqillik yangi taraqqiyot bosqichini boshladi. / Jamiyatda islohotlar amalga oshdi.'],
    terms: [['mustaqillik', 'suveren davlat bo‘lish', 'O‘zbekiston mustaqillikka erishdi.'], ['suverenitet', 'mustaqil boshqaruv huquqi', 'Davlat suverenitetga ega.'], ['ramz', 'davlat belgisi', 'Bayroq davlat ramzidir.'], ['Konstitutsiya', 'asosiy qonun', 'Konstitutsiya huquqiy asosdir.'], ['taraqqiyot', 'rivojlanish', 'Mustaqillik taraqqiyotga yo‘l ochdi.']],
    checks: [['O‘zbekiston qachon mustaqillikka erishgan?', ['1991-yil', '1917-yil', '1945-yil', '2001-yil'], 0, 'O‘zbekiston 1991-yilda mustaqillikka erishgan.'], ['Mustaqillik nimani anglatadi?', ['suveren davlat bo‘lishni', 'faqat bayramni', 'faqat xaritani', 'til qoidasini'], 0, 'Mustaqillik suverenlikni bildiradi.'], ['Konstitutsiya nima?', ['davlatning asosiy qonuni', 'tarixiy xarita', 'qo‘shiq turi', 'sifat so‘zi'], 0, 'Konstitutsiya asosiy qonun.']],
    writingTasks: openWritingTasks([
      { prompt: 'O‘zbekiston qachon mustaqillikka erishgan?', expected: ['1991-yil', '1991'], hint: 'Yilni yozing.' },
      { prompt: 'Mustaqillik nimani anglatadi?', expected: ['suveren davlat bo‘lish', 'mustaqil davlat bo‘lish'], hint: 'Mazmunini yozing.' },
      { prompt: 'Davlat ramzlariga misol yozing.', expected: ['bayroq gerb madhiya', 'bayroq', 'gerb', 'madhiya'], hint: 'Ramz nomini yozing.' },
      { prompt: 'Konstitutsiya nima?', expected: ['davlatning asosiy qonuni', 'asosiy qonun'], hint: 'Qisqa ta’rif.' },
      { prompt: 'Mustaqillikning bitta natijasini yozing.', expected: ['suveren davlat bo‘ldi', 'ramzlar qabul qilindi', 'taraqqiyot boshlandi'], hint: 'Natijani to‘liq gap bilan yozing.' }
    ])
  });
  return makeProfile({
    concept: title,
    core: `${title} tarix fanida muhim voqea, jarayon yoki tushuncha sifatida o‘rganiladi. Uni yaxshi tushunish uchun sana, joy, tarixiy shaxslar, sabab va oqibatni birgalikda ko‘rish kerak.`,
    structure: `${title} mavzusini quyidagi tartibda o‘rganing: 1) davr yoki sana, 2) voqea mazmuni, 3) sabab, 4) oqibat, 5) tarixiy ahamiyat.`,
    usage: 'Test, xarita, tarixiy jadval, esse va og‘zaki javoblarda ishlatiladi. Har bir mavzu dalil va xulosa bilan mustahkamlanadi.',
    nuance: 'Tarixda faqat faktni yodlash yetarli emas. Voqea nega bo‘lganini va qanday natija berganini tushuntirish kerak.',
    mistakes: 'Sana, shaxs va voqeani bir-biridan ajratib yodlash, sabab-oqibatni aralashtirish va dalilsiz javob berish ko‘p uchraydi.',
    examples: [`${title} mavzusida avval davrni aniqlang. / Davr voqeani joyiga qo‘yadi.`, `${title} bo‘yicha sababni yozing. / Sabab voqeani tushuntiradi.`, `${title} bo‘yicha oqibatni yozing. / Oqibat natijani ko‘rsatadi.`, `${title}ga oid bitta tarixiy shaxsni eslang. / Shaxs mavzuni aniq qiladi.`, `${title} mavzusidan xulosa chiqaring. / Xulosa bilimni mustahkamlaydi.`],
    terms: vocabSets.tarix,
    checks: [[`${title} mavzusini tahlil qilishda qaysi tartib foydali?`, ['sana, voqea, sabab, oqibat', 'faqat ranglar', 'faqat she’r', 'faqat formula'], 0, 'Tarixda voqea sabab-oqibat bilan o‘rganiladi.'], ['Tarixiy voqeaning oqibati nimani bildiradi?', ['voqeadan keyingi natijani', 'faqat boshlanish sanasini', 'faqat xaritani', 'ot so‘z turkumini'], 0, 'Oqibat — natija.'], ['Tarixda manba nima uchun kerak?', ['dalil va ma’lumot olish uchun', 'faqat rasm chizish uchun', 'talaffuz uchun', 'matematik hisob uchun'], 0, 'Manba tarixiy dalil beradi.']],
    writingTasks: openWritingTasks([
      { prompt: `${title} mavzusida sabab nima uchun kerak?`, expected: ['voqea nima uchun bo‘lganini tushunish uchun', 'voqeani tushunish uchun'], hint: 'Sababning vazifasini yozing.' },
      { prompt: `${title} mavzusida oqibat nimani bildiradi?`, expected: ['voqeadan keyingi natija', 'natija'], hint: 'Oqibat = natija.' },
      { prompt: `${title}ni o‘rganishda qaysi 4 narsani bilish kerak?`, expected: ['sana voqea sabab oqibat', 'sana joy sabab oqibat'], hint: 'Tahlil elementlarini yozing.' },
      { prompt: `${title} mavzusidan bitta tarixiy xulosa yozing.`, expected: [`${title} muhim tarixiy mavzu`, 'bu mavzu tarixda muhim'], hint: 'To‘liq gap yozing.' },
      { prompt: `Tarixiy manba nima uchun kerak?`, expected: ['dalil olish uchun', 'ma’lumot olish uchun', 'tarixni o‘rganish uchun'], hint: 'Manbaning vazifasini yozing.' }
    ])
  });
}

function getTopicProfile(language, level, title, topicNo) {
  if (language === 'english') return englishProfile(title, level);
  if (language === 'russia') return russianProfile(title, level);
  if (language === 'koreys') return koreanProfile(title, level);
  if (language === 'ona_tili') return onaTiliProfile(title, level);
  if (language === 'tarix') return historyProfile(title, level);
  return grammarSimpleProfile(title, title, `${title} mavzusini`, `${title} structure`, [`${title} example.`]);
}
function buildExplanation(language, level, title, topicNo) {
  const profile = getTopicProfile(language, level, title, topicNo);
  const isEssentialStyle = language === 'english' && Boolean(getEssentialStyleEnglishProfile(title));
  if (isEssentialStyle) {
    return [
      { heading: 'Mavzuning ma’nosi', text: profile.core },
      { heading: 'Shakl', text: profile.structure },
      { heading: 'Qachon ishlatiladi', text: profile.usage },
      { heading: 'Eslatma', text: profile.nuance },
      { heading: 'Xato qilmaslik', text: profile.mistakes }
    ].filter(part => part.text);
  }
  return [
    {
      heading: 'Mavzuning asosiy ma’nosi',
      text: `${profile.core} Bu mavzuni o‘rganishda eng muhim narsa — gapda u qanday vazifa bajarishini tushunish. Faqat tarjima yodlash yetarli emas: mavzu qaysi so‘z bilan keladi, gapning qaysi qismida turadi va ma’noni qanday o‘zgartiradi — shularni ham ko‘rish kerak.`
    },
    {
      heading: 'Grammatik tuzilma',
      text: `${profile.structure} Tuzilmani yodlashdan oldin gapni bo‘laklarga ajrating: ega, yordamchi yoki asosiy fe’l, keyin qolgan so‘zlar. Har bir mavzuda ijobiy gap, inkor gap va savol gap tartibini alohida yozib chiqish o‘quvchiga tezroq eslab qolishga yordam beradi.`
    },
    {
      heading: 'Qachon ishlatiladi',
      text: `${profile.usage} Bu mavzu ko‘pincha oddiy suhbat, darsdagi javoblar, matn yozish va test savollarida uchraydi. Agar gap real vaziyatga bog‘lansa, o‘quvchi qoida nima uchun kerakligini yaxshiroq tushunadi.`
    },
    {
      heading: 'Nozik farqlar',
      text: `${profile.nuance} Shunga o‘xshash mavzular bilan adashtirmaslik uchun har doim misol gapni solishtiring. Bitta so‘z yoki qo‘shimcha o‘zgarsa, gapning ma’nosi, zamoni yoki aniqligi ham o‘zgarishi mumkin.`
    },
    {
      heading: 'Ko‘p uchraydigan xatolar',
      text: `${profile.mistakes} Xatoni kamaytirish uchun avval sekin yozing, keyin gapni ovoz chiqarib o‘qing. Agar gap g‘alati eshitilsa, so‘z tartibi, yordamchi fe’l, birlik-ko‘plik yoki qo‘shimchani qayta tekshiring.`
    },
    {
      heading: 'Ijobiy, inkor va savol shakli',
      text: `${profile.concept} mavzusini mustahkamlash uchun bitta mavzudan kamida uch xil gap tuzing: oddiy tasdiq gap, inkor gap va savol gap. Shu usul o‘quvchiga testdagi o‘xshash variantlarni tez ajratishga yordam beradi.`
    },
    {
      heading: 'Eslab qolish formulasi',
      text: `${profile.concept}: avval ma’noni tushuning, keyin tuzilmani ajrating, so‘ng kamida 3 ta ijobiy, 3 ta inkor va 3 ta savol gap bilan mustahkamlang. Oxirida mavzuni o‘z hayotingizdan 2 ta real gap bilan bog‘lab yozing.`
    }
  ];
}

function buildExamples(language, level, title, topicNo) {
  const profile = getTopicProfile(language, level, title, topicNo);
  const examples = profile.examples && profile.examples.length ? profile.examples : [
    `${title}: mavzuga mos oddiy gap tuzing.`,
    `${title}: mavzuni real vaziyatda ishlating.`
  ];
  return examples.slice(0, 12);
}

function fallbackOption(index = 0, salt = 0) {
  const options = [
    'Bu javob mavzuga mos emas.',
    'So‘z tartibi noto‘g‘ri.',
    'Grammatik xato bor.',
    'Ma’no noto‘g‘ri berilgan.',
    'Keraksiz so‘z qo‘shilgan.',
    'Qoida noto‘g‘ri qo‘llangan.'
  ];
  const safeIndex = Math.abs((Number(index) || 0) + (Number(salt) || 0)) % options.length;
  return options[safeIndex];
}

function optionSet(correct, distractors, salt = 0) {
  const unique = [correct, ...distractors].filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 4);
  while (unique.length < 4) unique.push(fallbackOption(unique.length, salt));
  const rotation = salt % 4;
  const rotated = unique.slice(rotation).concat(unique.slice(0, rotation));
  return { options: rotated, correctIndex: rotated.indexOf(correct) };
}
function shuffledOptions(vocabulary, correctIndex, salt) {
  const pool = [correctIndex, (correctIndex + 3) % vocabulary.length, (correctIndex + 7) % vocabulary.length, (correctIndex + 11) % vocabulary.length].map(i => i % vocabulary.length);
  const rotation = salt % 4;
  const rotated = pool.slice(rotation).concat(pool.slice(0, rotation));
  return { options: rotated.map(i => vocabulary[i].word), correctIndex: rotated.indexOf(correctIndex) };
}
const TOPIC_TEST_QUESTION_COUNT = 3;
const NON_LANGUAGE_TOPIC_TEST_QUESTION_COUNT = 5;
function isHistoryA1(language, level) { return language === 'tarix' && level === FIRST_LEVEL; }
function isEnglishA1QuickCheck(language, level) { return false; }
function topicQuestionCount(language, level) {
  if (isHistoryA1(language, level) || isEnglishA1QuickCheck(language, level)) return 1;
  // Til mavzularida mashqlar faqat test bo'lib qolmasin: qisqa variant qismi + alohida yoziladigan qism.
  // Ona tili va tarixda esa avvalgidek 5 ta variantli savol qoladi.
  if (['ona_tili', 'tarix'].includes(language)) return NON_LANGUAGE_TOPIC_TEST_QUESTION_COUNT;
  return TOPIC_TEST_QUESTION_COUNT;
}
function forceCorrectAnswerA(options, correctIndex, salt = 0) {
  const cleanOptions = (options || []).filter(v => v !== undefined && v !== null && String(v).trim()).slice(0, 4);
  const originalLength = cleanOptions.length;
  if (originalLength !== 2) {
    while (cleanOptions.length < 4) cleanOptions.push(fallbackOption(cleanOptions.length, salt));
  }
  const optionCount = cleanOptions.length || 1;
  const safeIndex = Number.isInteger(correctIndex) && correctIndex >= 0 && correctIndex < optionCount ? correctIndex : 0;
  const correct = cleanOptions[safeIndex];
  const rest = cleanOptions.filter((_, idx) => idx !== safeIndex);
  const pattern = optionCount === 2 ? [1, 0, 0, 1, 1, 0] : [1, 3, 0, 2, 2, 0, 3, 1];
  const seedText = `${cleanOptions.join('|')}|${safeIndex}|${salt}`;
  let seed = 0;
  for (let i = 0; i < seedText.length; i += 1) seed = (seed + seedText.charCodeAt(i) * (i + 3)) % 9973;
  const correctPosition = pattern[Math.abs(seed + Number(salt || 0)) % pattern.length] % optionCount;
  const nextOptions = [];
  let restIndex = 0;
  for (let i = 0; i < optionCount; i += 1) {
    if (i === correctPosition) nextOptions[i] = correct;
    else nextOptions[i] = rest[restIndex++] || fallbackOption(i, salt);
  }
  return { options: nextOptions, correctIndex: correctPosition };
}

function splitExamplePair(example = '') {
  const parts = String(example).split(' / ');
  return { en: (parts[0] || '').trim(), uz: (parts[1] || '').trim() };
}

function makeTopicDistractors(language, title, vocabulary) {
  if (language === 'english') {
    return [
      'I student very good.',
      'He are my friend.',
      'They is at school.',
      'Do she is ready?',
      `${title} mavzusiga mos kelmaydigan gap.`
    ];
  }
  if (language === 'russia') {
    return ['Неправильный порядок слов.', 'Bu gap mavzuga mos emas.', 'Faqat tarjima yetarli.', 'So‘z shakli noto‘g‘ri.'];
  }
  if (language === 'koreys') {
    return ['문법이 맞지 않는 문장입니다.', 'Particle noto‘g‘ri ishlatilgan.', 'Gap oxiri noto‘g‘ri.', 'Bu variant mavzuga mos emas.'];
  }
  if (language === 'ona_tili') {
    return ['Bu javob mavzuga mos emas.', 'Faqat so‘zni ko‘chirish yetarli emas.', 'Tahlil noto‘g‘ri berilgan.', 'So‘roq boshqa bo‘lakka tegishli.'];
  }
  if (language === 'tarix') {
    return ['Bu tarixiy javob noto‘g‘ri.', 'Sana va voqea mos kelmaydi.', 'Sabab-oqibat aralashgan.', 'Bu javob mavzuga oid emas.'];
  }
  return ['Bu variant mavzuga mos emas.', 'Noto‘g‘ri gap.', 'Faqat yodlash kerak.', 'Talaffuz varianti.'];
}


// Workbook-style grammar exercises: fill-in-the-blank and choose-the-correct-form tasks.
// These are used for English grammar topics where book-like exercises are more useful than only vocabulary checks.
const ENGLISH_WORKBOOK_EXERCISES = {
  regularPlurals: {
    choice: [
      ['one book — two ___', ['book', 'books', 'bookes', 'bookies'], 1, 'Bu savolda book so‘zining ko‘plik shakli kerak.'],
      ['one box — three ___', ['boxs', 'boxes', 'boxies', 'boxen'], 1, 'Bu savolda box so‘zining ko‘plik shakli kerak.'],
      ['one bus — many ___', ['buss', 'buses', 'busies', 'busen'], 1, 'Bu savolda bus so‘zining ko‘plik shakli kerak.'],
      ['one baby — two ___', ['babys', 'babies', 'babyes', 'baby'], 1, 'Bu savolda baby so‘zining ko‘plik shakli kerak.'],
      ['one boy — two ___', ['boys', 'boies', 'boyes', 'boyies'], 0, 'Bu savolda boy so‘zining ko‘plik shakli kerak.'],
      ['one watch — two ___', ['watchs', 'watchies', 'watches', 'watchen'], 2, 'Bu savolda watch so‘zining ko‘plik shakli kerak.'],
      ['one class — three ___', ['classs', 'classes', 'classies', 'classen'], 1, 'Bu savolda class so‘zining ko‘plik shakli kerak.'],
      ['one tomato — many ___', ['tomatos', 'tomatoes', 'tomatoies', 'tomato'], 1, 'Bu savolda tomato so‘zining ko‘plik shakli kerak.'],
      ['one toy — two ___', ['toys', 'toies', 'toyes', 'toyies'], 0, 'Bu savolda toy so‘zining ko‘plik shakli kerak.'],
      ['These ___ are fresh.', ['apple', 'apples', 'applees', 'appless'], 1, 'These bilan ko‘plik ot ishlatiladi: apples.']
    ],
    blanks: [
      ['one car — five ___', ['cars'], 'Bu joyga car so‘zining ko‘plik shakli yoziladi.'],
      ['one pen — two ___', ['pens'], 'Bu joyga pen so‘zining ko‘plik shakli yoziladi.'],
      ['one bus — three ___', ['buses'], 'Bu joyga bus so‘zining ko‘plik shakli yoziladi.'],
      ['one box — four ___', ['boxes'], 'Bu joyga box so‘zining ko‘plik shakli yoziladi.'],
      ['one baby — two ___', ['babies'], 'Bu joyga baby so‘zining ko‘plik shakli yoziladi.'],
      ['one city — many ___', ['cities'], 'Bu joyga city so‘zining ko‘plik shakli yoziladi.'],
      ['one watch — two ___', ['watches'], 'Bu joyga watch so‘zining ko‘plik shakli yoziladi.'],
      ['one class — three ___', ['classes'], 'Bu joyga class so‘zining ko‘plik shakli yoziladi.'],
      ['one toy — two ___', ['toys'], 'Bu joyga toy so‘zining ko‘plik shakli yoziladi.'],
      ['These ___ are red. (apple)', ['apples'], 'These + plural noun: apples.']
    ],
    sentences: [
      ['Write one sentence with the plural noun “books”.', 'plural_regular', ['I have two books.', 'The books are on the table.'], 'books so‘zini ishlatib to‘liq inglizcha gap yozing.'],
      ['Write one sentence with the plural noun “boxes”.', 'plural_regular', ['There are three boxes.', 'The boxes are big.'], 'boxes so‘zini ishlatib to‘liq gap tuzing.'],
      ['Write one sentence with the plural noun “babies”.', 'plural_regular', ['The babies are sleeping.', 'Two babies are here.'], 'babies so‘zini ishlating.'],
      ['Write one sentence with the plural noun “watches”.', 'plural_regular', ['The watches are expensive.', 'I have two watches.'], 'watches so‘zini ishlating.'],
      ['Write one sentence with any regular plural noun.', 'plural_regular', ['The students are in the classroom.', 'I have three pens.'], 'Kamida bitta regular plural noun yozing: books, cars, pens, students kabi.']
    ]
  },
  irregularPlurals: {
    choice: [
      ['one child — many ___', ['childs', 'children', 'childrens', 'childes'], 1, 'child → children.'],
      ['one man — two ___', ['mans', 'men', 'mens', 'manies'], 1, 'man → men.'],
      ['one woman — three ___', ['womans', 'womens', 'women', 'womanes'], 2, 'woman → women.'],
      ['one person — many ___', ['persons', 'people', 'peoples', 'persones'], 1, 'person → people.'],
      ['one foot — two ___', ['foots', 'feets', 'feet', 'footen'], 2, 'foot → feet.'],
      ['one tooth — many ___', ['tooths', 'teeth', 'toothes', 'toothen'], 1, 'tooth → teeth.'],
      ['one mouse — two ___', ['mouses', 'mice', 'mousees', 'mices'], 1, 'mouse → mice.'],
      ['one goose — many ___', ['gooses', 'geese', 'goosees', 'goosen'], 1, 'goose → geese.'],
      ['one sheep — two ___', ['sheep', 'sheeps', 'sheepes', 'sheepen'], 0, 'sheep ko‘plikda ham sheep bo‘ladi.'],
      ['Two ___ are here.', ['woman', 'womans', 'women', 'womens'], 2, 'Two bilan ko‘plik shakl kerak: women.']
    ],
    blanks: [
      ['one child — two ___', ['children'], 'child → children.'],
      ['one man — many ___', ['men'], 'man → men.'],
      ['one woman — three ___', ['women'], 'woman → women.'],
      ['one person — many ___', ['people'], 'person → people.'],
      ['one foot — two ___', ['feet'], 'foot → feet.'],
      ['one tooth — many ___', ['teeth'], 'tooth → teeth.'],
      ['one mouse — two ___', ['mice'], 'mouse → mice.'],
      ['one goose — many ___', ['geese'], 'goose → geese.'],
      ['one sheep — two ___', ['sheep'], 'sheep o‘zgarmaydi.'],
      ['The ___ are playing. (child)', ['children'], 'child ko‘plikda children.']
    ],
    sentences: [
      ['Write one sentence with the plural noun “children”.', 'plural_irregular', ['The children are playing.', 'Children are in the classroom.'], 'children so‘zini ishlatib to‘liq gap yozing.'],
      ['Write one sentence with the plural noun “men”.', 'plural_irregular', ['The men are working.', 'Two men are here.'], 'men so‘zini ishlating.'],
      ['Write one sentence with the plural noun “women”.', 'plural_irregular', ['The women are teachers.', 'Two women are talking.'], 'women so‘zini ishlating.'],
      ['Write one sentence with the plural noun “people”.', 'plural_irregular', ['Many people are in the park.', 'People like music.'], 'people so‘zini ishlating.'],
      ['Write one sentence with any irregular plural noun.', 'plural_irregular', ['The mice are small.', 'My feet are cold.'], 'children, men, women, people, feet, teeth, mice kabi irregular plural ishlating.']
    ]
  },
  presentContinuous: {
    choice: [
      ['Gordon? I think he ___ a letter at the moment. (write)', ['writes', 'is writing', 'write', 'are writing'], 1, 'At the moment = hozir davom etyapti, shuning uchun is writing.'],
      ['Yes, the match is on TV now, but we ___. (lose)', ['lose', 'losing', 'are losing', 'lost'], 2, 'Now belgisi Present Continuousni talab qiladi: are losing.'],
      ['Right now, Margaret ___ a shower. (have)', ['has', 'is having', 'have', 'are having'], 1, 'Right now = ayni paytda: is having.'],
      ['Sally ___ with her aunt for a few days. (stay)', ['stays', 'is staying', 'stay', 'are staying'], 1, 'For a few days vaqtinchalik holat: is staying.'],
      ['I ___! It’s true! (not / lie)', ['am not lying', 'do not lie', 'not lying', 'am not lie'], 0, 'Present Continuous inkor: am/is/are + not + V-ing.'],
      ['Josh ___ my bike! It’s so annoying. (always / use)', ['always uses', 'is always using', 'always use', 'are always using'], 1, 'Always + Present Continuous norozilik/bezovtalikni bildirishi mumkin.'],
      ['We ___ lunch now. (have)', ['have', 'are having', 'has', 'having'], 1, 'Now = are having.'],
      ['___ music up there? It’s really noisy! (you / play)', ['Do you play', 'Are you playing', 'You are playing', 'Is you playing'], 1, 'Savolda yordamchi fe’l oldinga chiqadi: Are you playing?'],
      ['Look! The baby ___. (sleep)', ['sleeps', 'is sleeping', 'sleep', 'are sleeping'], 1, 'Look! hozirgi jarayon: is sleeping.'],
      ['They ___ TV at the moment. (not / watch)', ['do not watch', 'are not watching', 'not watching', 'is not watching'], 1, 'They bilan are not + V-ing.']
    ],
    blanks: [
      ['Gordon? I think he ___ a letter at the moment. (write)', ['is writing'], 'Present Continuous: he/she/it + is + V-ing.'],
      ['Yes, the match is on TV now, but we ___. (lose)', ['are losing'], 'We bilan are ishlatiladi.'],
      ['Right now, Margaret ___ a shower. (have)', ['is having'], 'Right now ayni paytdagi ish-harakatni bildiradi.'],
      ['Sally ___ with her aunt for a few days. (stay)', ['is staying'], 'Vaqtinchalik holat: is staying.'],
      ['I ___! It’s true! (not / lie)', ['am not lying', "i am not lying", "i'm not lying", "'m not lying"], 'Inkor shakl: am not + V-ing.'],
      ['Josh ___ my bike again. (always / use)', ['is always using'], 'He bilan is always using.'],
      ['We ___ lunch now. (have)', ['are having'], 'We + are + V-ing.'],
      ['___ music up there? (you / play)', ['are you playing'], 'Savolda: Are + you + V-ing?'],
      ['Look! The baby ___. (sleep)', ['is sleeping'], 'Baby = it/he/she, is sleeping.'],
      ['They ___ TV at the moment. (not / watch)', ['are not watching', "aren't watching"], 'They + are not + V-ing.']
    ],
    sentences: [
      ['Write one positive Present Continuous sentence.', 'present_continuous', ['I am reading now.', 'She is cooking.'], 'am/is/are + V-ing bilan ijobiy gap yozing.'],
      ['Write one negative Present Continuous sentence.', 'present_continuous', ['I am not sleeping.', 'They are not watching TV.'], 'am/is/are + not + V-ing ishlating.'],
      ['Write one Present Continuous question.', 'present_continuous', ['Are you studying now?', 'Is she reading?'], 'Savolda am/is/are boshiga chiqadi.'],
      ['Write one sentence using “at the moment”.', 'present_continuous', ['I am studying at the moment.', 'They are playing at the moment.'], 'at the moment bilan hozir davom etayotgan ishni yozing.'],
      ['Write one sentence using “now”.', 'present_continuous', ['We are learning English now.', 'He is writing now.'], 'now bilan Present Continuous gap tuzing.']
    ]
  },
  presentSimple: {
    choice: [
      ['She ___ English every day.', ['study', 'studies', 'is studying', 'studied'], 1, 'She/he/it bilan ijobiy gapda fe’lga -s/-es qo‘shiladi.'],
      ['We ___ to the theatre very often.', ['do not go', 'are not going', 'does not go', 'not go'], 0, 'Very often odatni bildiradi, Present Simple ishlatiladi.'],
      ['___ you practise the piano every day?', ['Are', 'Do', 'Does', 'Is'], 1, 'Every day bilan savolda Do/Does ishlatiladi.'],
      ['A good friend ___ when you are upset.', ['knows', 'is knowing', 'know', 'are knowing'], 0, 'Know stative verb, odatda continuousda ishlatilmaydi.'],
      ['How ___ your name?', ['are you spelling', 'do you spell', 'does you spell', 'you spell'], 1, 'Odatdagi savol: How do you spell...?'],
      ['My brother ___ TV after school.', ['watch', 'watches', 'is watching', 'watching'], 1, 'watch → watches.'],
      ['They usually ___ home at seven.', ['comes', 'come', 'are coming', 'came'], 1, 'They bilan V1: come.'],
      ['___ she like coffee?', ['Do', 'Does', 'Is', 'Are'], 1, 'She bilan savolda Does.'],
      ['He ___ football on Sundays.', ['play', 'plays', 'is playing', 'playing'], 1, 'He bilan plays.'],
      ['It ___ a lot in spring.', ['rain', 'rains', 'is raining', 'raining'], 1, 'It bilan rains.']
    ],
    blanks: [
      ['She ___ tennis every weekend. (play)', ['plays'], 'She bilan plays.'],
      ['We ___ coffee in the evening. (not / drink)', ['do not drink', "don't drink", "dont drink"], 'We bilan do not + V1.'],
      ['___ Ali speak English? (do)', ['does'], 'Ali = he, shuning uchun Does.'],
      ['My brother ___ TV after school. (watch)', ['watches'], 'watch → watches.'],
      ['They usually ___ home at seven. (come)', ['come'], 'They bilan V1 ishlatiladi.'],
      ['He ___ football on Sundays. (play)', ['plays'], 'He bilan plays.'],
      ['I ___ English every day. (study)', ['study'], 'I bilan V1.'],
      ['She ___ like tea. (not)', ['does not', "doesn't", "doesnt"], 'She bilan does not.'],
      ['___ they live in Tashkent? (do)', ['do'], 'They bilan Do.'],
      ['It ___ a lot in spring. (rain)', ['rains'], 'It bilan rains.']
    ],
    sentences: [
      ['Write one positive Present Simple sentence with I/you/we/they.', 'present_simple', ['I study English every day.', 'They play football.'], 'I/you/we/they + V1 ishlating.'],
      ['Write one negative Present Simple sentence with I/you/we/they.', 'present_simple', ['I do not watch TV.', 'We do not drink coffee.'], 'I/you/we/they + do not + V1 ishlating.'],
      ['Write one Present Simple question with Do and I/you/we/they.', 'present_simple', ['Do you speak English?', 'Do they play tennis?'], 'Do + I/you/we/they + V1?'],
      ['Write one positive Present Simple sentence with he/she/it.', 'present_simple', ['She plays tennis.', 'He studies every day.'], 'He/she/it + V-s/es ishlating.'],
      ['Write one negative Present Simple sentence with he/she/it.', 'present_simple', ['He does not like coffee.', 'She does not watch TV.'], 'He/she/it + does not + V1 ishlating.'],
      ['Write one Present Simple question with Does and he/she/it.', 'present_simple', ['Does she play tennis?', 'Does he study every day?'], 'Does + he/she/it + V1?'],
      ['Write one sentence using “every day”.', 'present_simple', ['I read every day.', 'She studies every day.'], 'every day bilan odatni yozing.'],
      ['Write one sentence using “usually”.', 'present_simple', ['We usually go to school.', 'He usually plays football.'], 'usually bilan Present Simple gap tuzing.']
    ]
  }
};

function normalizeTopicName(value = '') {
  return String(value || '')
    .toUpperCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}


// Three-part grammar practice packs: 10 choice tests, inline fill-in blanks and sentence writing.
const ESSENTIAL_STYLE_EXERCISE_PACKS = {
  "ALFABIT": {
    "choice": [
      ["English alphabet has ___ letters.", ["26", "24", "28", "20"], 0, "English alphabet 26 ta harfdan iborat."],
      ["A, E, I, O, U are ___.", ["vowels", "consonants", "numbers", "words"], 0, "A, E, I, O, U — vowel letters."],
      ["B, C, D are ___.", ["consonants", "vowels", "numbers", "articles"], 0, "B, C, D — consonant letters."],
      ["Capital letter means ___.", ["bosh harf", "kichik harf", "so‘z", "gap"], 0, "Capital letter — bosh harf."],
      ["Small letter means ___.", ["kichik harf", "bosh harf", "son", "tinish belgisi"], 0, "Small letter — kichik harf."],
      ["The first letter of alphabet is ___.", ["A", "B", "C", "Z"], 0, "Alphabet A harfi bilan boshlanadi."],
      ["The last letter of alphabet is ___.", ["Z", "A", "Y", "X"], 0, "Alphabet Z harfi bilan tugaydi."],
      ["A word is made of ___.", ["letters", "numbers", "colors", "days"], 0, "So‘z harflardan tuziladi."],
      ["To spell means ___.", ["harflab aytmoq", "tarjima qilmoq", "sanamoq", "chizmoq"], 0, "Spell — harflab aytmoq."],
      ["To pronounce means ___.", ["talaffuz qilmoq", "o‘chirmoq", "yopmoq", "sotib olmoq"], 0, "Pronounce — talaffuz qilmoq."]
    ],
    "blanks": [
      ["English alphabet has ___ letters.", ["26"], "English alphabet 26 ta harfdan iborat."],
      ["A is a ___.", ["vowel"], "A — vowel letter."],
      ["B is a ___.", ["consonant"], "B — consonant letter."],
      ["Capital letter means ___.", ["bosh harf"], "Capital letter — bosh harf."],
      ["Small letter means ___.", ["kichik harf"], "Small letter — kichik harf."],
      ["The first letter is ___.", ["A"], "Alphabet A bilan boshlanadi."],
      ["The last letter is ___.", ["Z"], "Alphabet Z bilan tugaydi."],
      ["A word is made of ___.", ["letters"], "Word lettersdan tuziladi."],
      ["Spell means ___.", ["harflab aytmoq"], "Spell — harflab aytmoq."],
      ["Pronounce means ___.", ["talaffuz qilmoq"], "Pronounce — talaffuz qilmoq."]
    ],
    "sentences": []
  },
  "A / AN": {
    "choice": [
      ["___ dog", ["a", "an", "the", "one"], 0, "Dog undosh tovush bilan boshlanadi."],
      ["___ elephant", ["an", "a", "the", "one"], 0, "Elephant unli tovush bilan boshlanadi."],
      ["___ zebra", ["a", "an", "the", "one"], 0, "Zebra undosh tovush bilan boshlanadi."],
      ["___ ant", ["an", "a", "the", "one"], 0, "Ant unli tovush bilan boshlanadi."],
      ["___ snake", ["a", "an", "the", "one"], 0, "Snake undosh tovush bilan boshlanadi."],
      ["___ owl", ["an", "a", "the", "one"], 0, "Owl unli tovush bilan boshlanadi."],
      ["___ university", ["a", "an", "the", "one"], 0, "University /juː/ tovushi bilan boshlanadi."],
      ["___ hour", ["an", "a", "the", "one"], 0, "Hour so‘zida h talaffuz qilinmaydi."],
      ["She is ___ teacher.", ["a", "an", "the", "one"], 0, "Teacher undosh tovush bilan boshlanadi."],
      ["Qaysi gap to‘g‘ri?", ["They are students.", "They are a students.", "They are an students.", "They is students."], 0, "Students ko‘plik, a/an ishlatilmaydi."]
    ],
    "blanks": [
      ["___ dog", ["a"], "Dog undosh tovush bilan boshlanadi."],
      ["___ elephant", ["an"], "Elephant unli tovush bilan boshlanadi."],
      ["___ zebra", ["a"], "Zebra undosh tovush bilan boshlanadi."],
      ["___ ant", ["an"], "Ant unli tovush bilan boshlanadi."],
      ["___ snake", ["a"], "Snake undosh tovush bilan boshlanadi."],
      ["___ frog", ["a"], "Frog undosh tovush bilan boshlanadi."],
      ["___ octopus", ["an"], "Octopus unli tovush bilan boshlanadi."],
      ["___ cow", ["a"], "Cow undosh tovush bilan boshlanadi."],
      ["___ insect", ["an"], "Insect unli tovush bilan boshlanadi."],
      ["___ bird", ["a"], "Bird undosh tovush bilan boshlanadi."],
      ["___ lion", ["a"], "Lion undosh tovush bilan boshlanadi."],
      ["___ alligator", ["an"], "Alligator unli tovush bilan boshlanadi."],
      ["___ donkey", ["a"], "Donkey undosh tovush bilan boshlanadi."],
      ["___ owl", ["an"], "Owl unli tovush bilan boshlanadi."],
      ["___ mouse", ["a"], "Mouse undosh tovush bilan boshlanadi."],
      ["___ sheep", ["a"], "Sheep undosh tovush bilan boshlanadi."],
      ["___ fish", ["a"], "Fish undosh tovush bilan boshlanadi."],
      ["___ horse", ["a"], "Horse undosh tovush bilan boshlanadi."],
      ["___ ostrich", ["an"], "Ostrich unli tovush bilan boshlanadi."],
      ["___ bee", ["a"], "Bee undosh tovush bilan boshlanadi."]
    ],
    "sentences": [
      ["Write one sentence with “a”.", "article", ["I have a pen.", "She is a teacher.", "This is a dog."], "a + singular countable noun ishlating."],
      ["Write one sentence with “an”.", "article", ["I have an apple.", "He is an engineer.", "This is an elephant."], "an + vowel sound ishlating."],
      ["Write one sentence with a job.", "article", ["She is a doctor.", "He is an actor.", "My father is a teacher."], "Kasb oldidan a/an ishlating."],
      ["Write one sentence with adjective + noun.", "article", ["It is a big dog.", "This is an old car.", "I have a new phone."], "a/an sifatdan oldin keladi, ot esa birlikda bo‘ladi."],
      ["Write one sentence without a/an before a plural noun.", "article", ["They are students.", "I have books.", "Dogs are friendly."], "Ko‘plik ot bilan a/an ishlatmang."]
    ]
  },
  "PLURALS (REGULAR)": {
    "choice": [
      ["one flower — two ___", ["flowers", "flower", "floweres", "floweries"], 0, "Bu savolda flower so‘zining ko‘plik shakli kerak."],
      ["one zebra — four ___", ["zebras", "zebra", "zebraes", "zebraies"], 0, "Bu savolda zebra so‘zining ko‘plik shakli kerak."],
      ["one lion — three ___", ["lions", "lion", "liones", "lionies"], 0, "Bu savolda lion so‘zining ko‘plik shakli kerak."],
      ["one watch — two ___", ["watches", "watchs", "watchies", "watch"], 0, "Bu savolda watch so‘zining ko‘plik shakli kerak."],
      ["one glass — three ___", ["glasses", "glasss", "glassies", "glass"], 0, "Bu savolda glass so‘zining ko‘plik shakli kerak."],
      ["one tomato — two ___", ["tomatoes", "tomatos", "tomatoies", "tomato"], 0, "Bu savolda tomato so‘zining ko‘plik shakli kerak."],
      ["one brush — four ___", ["brushes", "brushs", "brushies", "brush"], 0, "Bu savolda brush so‘zining ko‘plik shakli kerak."],
      ["one box — three ___", ["boxes", "boxs", "boxies", "box"], 0, "Bu savolda box so‘zining ko‘plik shakli kerak."],
      ["one baby — two ___", ["babies", "babys", "babyes", "baby"], 0, "Bu savolda baby so‘zining ko‘plik shakli kerak."],
      ["one boy — two ___", ["boys", "boies", "boyes", "boy"], 0, "Bu savolda boy so‘zining ko‘plik shakli kerak."]
    ],
    "blanks": [
      ["one flower — two ___", ["flowers"], "Bu joyga flower so‘zining ko‘plik shakli yoziladi."],
      ["one zebra — four ___", ["zebras"], "Bu joyga zebra so‘zining ko‘plik shakli yoziladi."],
      ["one lion — three ___", ["lions"], "Bu joyga lion so‘zining ko‘plik shakli yoziladi."],
      ["one watch — two ___", ["watches"], "Bu joyga watch so‘zining ko‘plik shakli yoziladi."],
      ["one glass — three ___", ["glasses"], "Bu joyga glass so‘zining ko‘plik shakli yoziladi."],
      ["one tomato — two ___", ["tomatoes"], "Bu joyga tomato so‘zining ko‘plik shakli yoziladi."],
      ["one brush — four ___", ["brushes"], "Bu joyga brush so‘zining ko‘plik shakli yoziladi."],
      ["one box — three ___", ["boxes"], "Bu joyga box so‘zining ko‘plik shakli yoziladi."],
      ["one baby — two ___", ["babies"], "Bu joyga baby so‘zining ko‘plik shakli yoziladi."],
      ["one boy — two ___", ["boys"], "Bu joyga boy so‘zining ko‘plik shakli yoziladi."]
    ],
    "sentences": [
      ["Write one sentence with “flowers”.", "plural_regular", ["There are two flowers.", "The flowers are beautiful."], "flowers so‘zini ishlating."],
      ["Write one sentence with “zebras”.", "plural_regular", ["I can see four zebras.", "The zebras are near the trees."], "zebras so‘zini ishlating."],
      ["Write one sentence with “boxes”.", "plural_regular", ["There are three boxes.", "The boxes are big."], "boxes so‘zini ishlating."],
      ["Write one sentence with “babies”.", "plural_regular", ["The babies are sleeping.", "There are two babies in the room."], "babies so‘zini ishlating."],
      ["Write one sentence with any regular plural noun.", "plural_regular", ["The students are in the classroom.", "I have three pens."], "Kamida bitta qoidali ko‘plik ot yozing."]
    ]
  },
  "PLURAL (IRREGULAR)": {
    "choice": [
      [
        "one child — two ___",
        [
          "children",
          "childs",
          "childrens",
          "childes"
        ],
        0,
        "Child → children."
      ],
      [
        "one man — three ___",
        [
          "men",
          "mans",
          "man",
          "manes"
        ],
        0,
        "Man → men."
      ],
      [
        "one woman — two ___",
        [
          "women",
          "womans",
          "woman",
          "womens"
        ],
        0,
        "Woman → women."
      ],
      [
        "one person — many ___",
        [
          "people",
          "persons",
          "persones",
          "peoples"
        ],
        0,
        "Person → people."
      ],
      [
        "one foot — two ___",
        [
          "feet",
          "foots",
          "feets",
          "foot"
        ],
        0,
        "Foot → feet."
      ],
      [
        "one tooth — two ___",
        [
          "teeth",
          "tooths",
          "toothes",
          "tooth"
        ],
        0,
        "Tooth → teeth."
      ],
      [
        "one mouse — two ___",
        [
          "mice",
          "mouses",
          "mouse",
          "mices"
        ],
        0,
        "Mouse → mice."
      ],
      [
        "one fish — two ___",
        [
          "fish",
          "fishes",
          "fishs",
          "fishen"
        ],
        0,
        "Fish ko‘pincha fish."
      ],
      [
        "one sheep — two ___",
        [
          "sheep",
          "sheeps",
          "sheepes",
          "sheepen"
        ],
        0,
        "Sheep shakli o‘zgarmaydi."
      ],
      [
        "one goose — two ___",
        [
          "geese",
          "gooses",
          "goose",
          "goosen"
        ],
        0,
        "Goose → geese."
      ]
    ],
    "blanks": [
      [
        "one child — two ___",
        [
          "children"
        ],
        "children"
      ],
      [
        "one man — three ___",
        [
          "men"
        ],
        "men"
      ],
      [
        "one woman — two ___",
        [
          "women"
        ],
        "women"
      ],
      [
        "one person — many ___",
        [
          "people"
        ],
        "people"
      ],
      [
        "one foot — two ___",
        [
          "feet"
        ],
        "feet"
      ],
      [
        "one tooth — two ___",
        [
          "teeth"
        ],
        "teeth"
      ],
      [
        "one mouse — two ___",
        [
          "mice"
        ],
        "mice"
      ]
    ],
    "sentences": [
      [
        "Write one sentence with “children”.",
        "plural_irregular",
        [
          "The children are playing.",
          "Children are in the classroom."
        ],
        "children so‘zini ishlating."
      ],
      [
        "Write one sentence with “men” or “women”.",
        "plural_irregular",
        [
          "The men are working.",
          "The women are teachers."
        ],
        "men/women ishlating."
      ],
      [
        "Write one sentence with any irregular plural noun.",
        "plural_irregular",
        [
          "My feet are cold.",
          "The mice are small."
        ],
        "feet, teeth, mice, people kabi so‘z ishlating."
      ]
    ]
  },
  "TO BE": {
    "choice": [
      ["I ___ a student.", ["am", "is", "are", "be"], 0, "I bilan am."],
      ["She ___ my sister.", ["is", "am", "are", "be"], 0, "She bilan is."],
      ["They ___ at school.", ["are", "is", "am", "be"], 0, "They bilan are."],
      ["You ___ ready.", ["are", "is", "am", "be"], 0, "You bilan are."],
      ["He ___ not busy.", ["is", "are", "am", "be"], 0, "He bilan is."],
      ["___ you OK?", ["Are", "Is", "Am", "Be"], 0, "Savolda Are ishlatiladi."],
      ["___ Ali your friend?", ["Is", "Are", "Am", "Be"], 0, "Ali birlik: Is."],
      ["We ___ happy.", ["are", "is", "am", "be"], 0, "We bilan are."],
      ["It ___ cold today.", ["is", "are", "am", "be"], 0, "It bilan is."],
      ["I ___ not tired.", ["am", "is", "are", "be"], 0, "I bilan am not."]
    ],
    "blanks": [
      ["I ___ a student.", ["am"], "I bilan am."],
      ["She ___ my teacher.", ["is"], "She bilan is."],
      ["They ___ friends.", ["are"], "They bilan are."],
      ["You ___ very kind.", ["are"], "You bilan are."],
      ["He ___ not at home.", ["is"], "He bilan is not."],
      ["We ___ in class.", ["are"], "We bilan are."],
      ["___ you ready?", ["are"], "Savolda Are gap boshiga chiqadi."],
      ["___ she your sister?", ["is"], "She bilan savolda Is."],
      ["It ___ a new book.", ["is"], "It bilan is."],
      ["I ___ not late.", ["am"], "I bilan am not."]
    ],
    "sentences": [
      ["Write one positive sentence with “am”.", "to_be", ["I am a student.", "I am ready."], "I + am ishlating."],
      ["Write one positive sentence with “is”.", "to_be", ["She is happy.", "He is a doctor."], "He/She/It + is ishlating."],
      ["Write one positive sentence with “are”.", "to_be", ["They are students.", "We are in class."], "You/We/They + are ishlating."],
      ["Write one negative sentence with “not”.", "to_be", ["I am not tired.", "They are not at home."], "am/is/are + not ishlating."],
      ["Write one question with am/is/are.", "to_be", ["Are you ready?", "Is he your teacher?"], "Am/Is/Are gap boshiga chiqadi."]
    ]
  },
  "SUBJECT PRONOUN": {
    "choice": [
      [
        "Ali is my friend. ___ is kind.",
        [
          "He",
          "She",
          "It",
          "They"
        ],
        0,
        "Ali = he."
      ],
      [
        "Malika is a teacher. ___ is busy.",
        [
          "She",
          "He",
          "It",
          "They"
        ],
        0,
        "Malika = she."
      ],
      [
        "The phone is new. ___ is black.",
        [
          "It",
          "He",
          "She",
          "They"
        ],
        0,
        "Phone = it."
      ],
      [
        "My parents are here. ___ are happy.",
        [
          "They",
          "We",
          "He",
          "It"
        ],
        0,
        "Parents = they."
      ],
      [
        "___ am a student.",
        [
          "I",
          "He",
          "She",
          "They"
        ],
        0,
        "Am faqat I bilan."
      ],
      [
        "___ are my friends.",
        [
          "They",
          "It",
          "He",
          "She"
        ],
        0,
        "Friends = they."
      ],
      [
        "You and I = ___",
        [
          "we",
          "they",
          "you",
          "it"
        ],
        0,
        "You and I = we."
      ],
      [
        "A dog = ___",
        [
          "it",
          "he",
          "she",
          "they"
        ],
        0,
        "Hayvon umumiy holatda it."
      ],
      [
        "Tom and Ali = ___",
        [
          "they",
          "he",
          "we",
          "it"
        ],
        0,
        "Ikki odam = they."
      ],
      [
        "My sister = ___",
        [
          "she",
          "he",
          "it",
          "they"
        ],
        0,
        "Sister = she."
      ]
    ],
    "blanks": [
      [
        "Ali is my friend. ___ is kind.",
        [
          "he"
        ],
        "Ali = he."
      ],
      [
        "Malika is a teacher. ___ is busy.",
        [
          "she"
        ],
        "Malika = she."
      ],
      [
        "The phone is new. ___ is black.",
        [
          "it"
        ],
        "Phone = it."
      ],
      [
        "My brothers are here. ___ are happy.",
        [
          "they"
        ],
        "Brothers = they."
      ],
      [
        "You and I are students. ___ are students.",
        [
          "we"
        ],
        "You and I = we."
      ]
    ],
    "sentences": [
      [
        "Write one sentence with “he”.",
        "subject_pronoun",
        [
          "He is my friend.",
          "He plays football."
        ],
        "he ishlating."
      ],
      [
        "Write one sentence with “she”.",
        "subject_pronoun",
        [
          "She is a teacher.",
          "She studies English."
        ],
        "she ishlating."
      ],
      [
        "Write one sentence with “they”.",
        "subject_pronoun",
        [
          "They are students.",
          "They play football."
        ],
        "they ishlating."
      ]
    ]
  },
  "THERE IS / THERE ARE": {
    "choice": [
      [
        "There ___ a book on the table.",
        [
          "is",
          "are",
          "am",
          "be"
        ],
        0,
        "A book birlik."
      ],
      [
        "There ___ two chairs.",
        [
          "are",
          "is",
          "am",
          "be"
        ],
        0,
        "Two chairs ko‘plik."
      ],
      [
        "___ there a bank near here?",
        [
          "Is",
          "Are",
          "Do",
          "Does"
        ],
        0,
        "A bank birlik."
      ],
      [
        "___ there many students?",
        [
          "Are",
          "Is",
          "Do",
          "Does"
        ],
        0,
        "Many students ko‘plik."
      ],
      [
        "There ___ not any milk.",
        [
          "is",
          "are",
          "am",
          "be"
        ],
        0,
        "Milk sanalmaydi, there is."
      ],
      [
        "There ___ five cars.",
        [
          "are",
          "is",
          "am",
          "be"
        ],
        0,
        "Five cars ko‘plik."
      ],
      [
        "There is ___ apple.",
        [
          "an",
          "a",
          "are",
          "many"
        ],
        0,
        "Apple unli tovush."
      ],
      [
        "There are ___ books.",
        [
          "many",
          "a",
          "an",
          "is"
        ],
        0,
        "Ko‘plik: many books."
      ],
      [
        "There ___ no problem.",
        [
          "is",
          "are",
          "am",
          "be"
        ],
        0,
        "Problem birlik."
      ],
      [
        "There ___ no problems.",
        [
          "are",
          "is",
          "am",
          "be"
        ],
        0,
        "Problems ko‘plik."
      ]
    ],
    "blanks": [
      [
        "There ___ a pen on the desk.",
        [
          "is"
        ],
        "A pen birlik."
      ],
      [
        "There ___ three students in the room.",
        [
          "are"
        ],
        "Three students ko‘plik."
      ],
      [
        "___ there a computer here?",
        [
          "is"
        ],
        "A computer birlik."
      ],
      [
        "___ there many books?",
        [
          "are"
        ],
        "Many books ko‘plik."
      ],
      [
        "There ___ not any water.",
        [
          "is"
        ],
        "Water sanalmaydi."
      ],
      [
        "There ___ two windows.",
        [
          "are"
        ],
        "Two windows ko‘plik."
      ]
    ],
    "sentences": [
      [
        "Write one sentence with “There is”.",
        "there_is",
        [
          "There is a book on the table.",
          "There is a cat in the room."
        ],
        "There is + singular yozing."
      ],
      [
        "Write one sentence with “There are”.",
        "there_are",
        [
          "There are three students.",
          "There are books on the desk."
        ],
        "There are + plural yozing."
      ],
      [
        "Write one question with Is there / Are there.",
        "there_is",
        [
          "Is there a bank near here?",
          "Are there many students?"
        ],
        "Is there yoki Are there bilan savol yozing."
      ]
    ]
  },
  "HAVE / HAS": {
    "choice": [
      ["I ___ a book.", ["have", "has"], 0, "I bilan have."],
      ["She ___ a sister.", ["have", "has"], 1, "She bilan has."],
      ["They ___ a car.", ["have", "has"], 0, "They bilan have."],
      ["He ___ a headache.", ["have", "has"], 1, "He bilan has."],
      ["We ___ two rooms.", ["have", "has"], 0, "We bilan have."],
      ["My mother ___ a phone.", ["have", "has"], 1, "My mother = she."],
      ["The students ___ new books.", ["have", "has"], 0, "Students ko‘plik: have."],
      ["The school ___ many rooms.", ["have", "has"], 1, "School bitta tashkilot: has."],
      ["You ___ a new bag.", ["have", "has"], 0, "You bilan have."],
      ["Ali ___ a red pen.", ["have", "has"], 1, "Ali = he."]
    ],
    "blanks": [
      ["I ___ a new pen.", ["have"], "I bilan have."],
      ["She ___ two brothers.", ["has"], "She bilan has."],
      ["They ___ English books.", ["have"], "They bilan have."],
      ["My father ___ a car.", ["has"], "My father = he."],
      ["We ___ a test today.", ["have"], "We bilan have."],
      ["The cat ___ green eyes.", ["has"], "Cat = it."]
    ],
    "sentences": [
      ["Write one sentence with “have”.", "have_has", ["I have a book.", "They have a car."], "Gap ichida have so‘zi aniq bo‘lsin."],
      ["Write one sentence with “has”.", "have_has", ["She has a phone.", "He has a sister."], "Gap ichida has so‘zi aniq bo‘lsin."],
      ["Write one sentence with “have”.", "have_has", ["We have English today.", "You have a new bag."], "I/you/we/they bilan have ishlating."],
      ["Write one sentence with “has”.", "have_has", ["Ali has a red pen.", "The school has many rooms."], "He/she/it yoki bitta ism bilan has ishlating."]
    ]
  },
  "CAN / CAN’T": {
  "choice": [
    [
      "I can ___ English.",
      [
        "speak",
        "speaks",
        "speaking",
        "to speak"
      ],
      0,
      "Can + V1."
    ],
    [
      "She can ___ fast.",
      [
        "run",
        "runs",
        "running",
        "to run"
      ],
      0,
      "Can dan keyin fe’lga -s qo‘shilmaydi."
    ],
    [
      "Can you ___ me?",
      [
        "help",
        "helps",
        "helping",
        "to help"
      ],
      0,
      "Savolda ham can + V1."
    ],
    [
      "He ___ swim.",
      [
        "can’t",
        "doesn’t can",
        "not can",
        "can not to"
      ],
      0,
      "Can’t — inkor shakl."
    ],
    [
      "They can ___ football.",
      [
        "play",
        "plays",
        "playing",
        "to play"
      ],
      0,
      "Can + V1."
    ],
    [
      "___ I come in?",
      [
        "Can",
        "Do can",
        "Am can",
        "Can to"
      ],
      0,
      "Ruxsat so‘rashda Can I...?"
    ],
    [
      "She can’t ___ today.",
      [
        "come",
        "comes",
        "coming",
        "to come"
      ],
      0,
      "Can’t + V1."
    ],
    [
      "We can ___ now.",
      [
        "start",
        "starts",
        "starting",
        "to start"
      ],
      0,
      "Can + V1."
    ],
    [
      "He can ___ a car.",
      [
        "drive",
        "drives",
        "driving",
        "to drive"
      ],
      0,
      "Can + V1."
    ],
    [
      "Can they ___?",
      [
        "read",
        "reads",
        "reading",
        "to read"
      ],
      0,
      "Can + subject + V1?"
    ]
  ],
  "blanks": [
    [
      "I can ___ English.",
      [
        "speak"
      ],
      "Can + V1."
    ],
    [
      "She can ___ very well.",
      [
        "sing"
      ],
      "Can + V1."
    ],
    [
      "Can you ___ me?",
      [
        "help"
      ],
      "Savolda Can boshida, fe’l V1."
    ],
    [
      "He can’t ___ a car.",
      [
        "drive"
      ],
      "Can’t + V1."
    ],
    [
      "They can ___ football.",
      [
        "play"
      ],
      "Can + V1."
    ],
    [
      "___ you swim?",
      [
        "can"
      ],
      "Savol: Can you...?"
    ],
    [
      "I ___ not come today.",
      [
        "can"
      ],
      "Can not / can’t inkor."
    ],
    [
      "Can she ___ English?",
      [
        "speak"
      ],
      "Can + V1."
    ],
    [
      "We can ___ the lesson now.",
      [
        "start"
      ],
      "Can + V1."
    ],
    [
      "You can ___ my pen.",
      [
        "use"
      ],
      "Ruxsat: You can use..."
    ]
  ],
  "sentences": [
    [
      "Write one sentence with can about ability.",
      "modal",
      [
        "I can swim.",
        "She can speak English."
      ],
      "can + V1 bilan qobiliyat gapini yozing."
    ],
    [
      "Write one negative sentence with can’t.",
      "modal",
      [
        "I can’t drive.",
        "He can’t come today."
      ],
      "can’t + V1 ishlating."
    ],
    [
      "Write one question with Can.",
      "modal",
      [
        "Can you help me?",
        "Can she read English?"
      ],
      "Can + subject + V1? shaklida yozing."
    ],
    [
      "Write one permission question with Can I...?.",
      "modal",
      [
        "Can I come in?",
        "Can I use your pen?"
      ],
      "Ruxsat so‘rash uchun Can I...? ishlating."
    ]
  ]
},
  "WHO / WHAT": {
  "choice": [
    [
      "___ is your name?",
      [
        "What",
        "Who",
        "Where",
        "When"
      ],
      0,
      "Name haqida What ishlatiladi."
    ],
    [
      "___ is your teacher?",
      [
        "Who",
        "What",
        "Where",
        "How"
      ],
      0,
      "Odam haqida Who."
    ],
    [
      "___ is this? It is a pen.",
      [
        "What",
        "Who",
        "Where",
        "Why"
      ],
      0,
      "Narsa haqida What."
    ],
    [
      "___ called you?",
      [
        "Who",
        "What",
        "When",
        "Where"
      ],
      0,
      "Kim qo‘ng‘iroq qilganini so‘rayapmiz."
    ],
    [
      "___ are they doing?",
      [
        "What",
        "Who",
        "Where",
        "Which person"
      ],
      0,
      "Ish-harakat haqida What."
    ],
    [
      "___ is that woman?",
      [
        "Who",
        "What",
        "Where",
        "When"
      ],
      0,
      "Woman — odam, shuning uchun Who."
    ],
    [
      "___ do you want?",
      [
        "What",
        "Who",
        "Where",
        "When"
      ],
      0,
      "Narsa yoki xohish haqida What."
    ],
    [
      "___ is in the room?",
      [
        "Who",
        "What",
        "Where",
        "How"
      ],
      0,
      "Xonada kim bor? — Who."
    ],
    [
      "___ is your phone number?",
      [
        "What",
        "Who",
        "Where",
        "When"
      ],
      0,
      "Raqam/ma’lumot haqida What."
    ],
    [
      "___ is speaking?",
      [
        "Who",
        "What",
        "Where",
        "When"
      ],
      0,
      "Gapirayotgan odam haqida Who."
    ]
  ],
  "blanks": [
    [
      "___ is your name?",
      [
        "what"
      ],
      "Ism haqida What."
    ],
    [
      "___ is your teacher?",
      [
        "who"
      ],
      "Odam haqida Who."
    ],
    [
      "___ is this?",
      [
        "what"
      ],
      "Narsa haqida What."
    ],
    [
      "___ called you?",
      [
        "who"
      ],
      "Odam haqida Who."
    ],
    [
      "___ are you doing?",
      [
        "what"
      ],
      "Ish-harakat haqida What."
    ],
    [
      "___ is that man?",
      [
        "who"
      ],
      "Odam haqida Who."
    ],
    [
      "___ do you want?",
      [
        "what"
      ],
      "Narsa/istak haqida What."
    ],
    [
      "___ is in the class?",
      [
        "who"
      ],
      "Kim bor? — Who."
    ],
    [
      "___ is your address?",
      [
        "what"
      ],
      "Ma’lumot haqida What."
    ],
    [
      "___ can you see?",
      [
        "what"
      ],
      "Ko‘rayotgan narsa haqida What."
    ]
  ],
  "sentences": [
    [
      "Write one question with Who.",
      "question_word",
      [
        "Who is your teacher?",
        "Who is that boy?"
      ],
      "Odam haqida Who bilan savol yozing."
    ],
    [
      "Write one question with What.",
      "question_word",
      [
        "What is your name?",
        "What is this?"
      ],
      "Narsa yoki ma’lumot haqida What bilan savol yozing."
    ],
    [
      "Write one Who question and one short answer.",
      "question_word",
      [
        "Who is she? She is my sister.",
        "Who is he? He is my friend."
      ],
      "Who savoliga odam bilan javob bering."
    ],
    [
      "Write one What question and one short answer.",
      "question_word",
      [
        "What is this? It is a pen.",
        "What are you doing? I am reading."
      ],
      "What savoliga narsa yoki ish-harakat bilan javob bering."
    ]
  ]
},
  "PRESENT CONTINUOUS": {
    "choice": [
      [
        "I ___ English now.",
        [
          "am studying",
          "study",
          "studies",
          "studied"
        ],
        0,
        "I am + V-ing."
      ],
      [
        "She ___ TV at the moment.",
        [
          "is watching",
          "watches",
          "watch",
          "are watching"
        ],
        0,
        "She is + V-ing."
      ],
      [
        "They ___ football now.",
        [
          "are playing",
          "is playing",
          "play",
          "plays"
        ],
        0,
        "They are + V-ing."
      ],
      [
        "He ___ a letter now.",
        [
          "is writing",
          "writes",
          "write",
          "are writing"
        ],
        0,
        "He is + V-ing."
      ],
      [
        "We ___ dinner now.",
        [
          "are eating",
          "eat",
          "eats",
          "is eating"
        ],
        0,
        "We are + V-ing."
      ],
      [
        "___ you listening?",
        [
          "Are",
          "Do",
          "Is",
          "Does"
        ],
        0,
        "You bilan Are."
      ],
      [
        "She is not ___.",
        [
          "sleeping",
          "sleeps",
          "sleep",
          "slept"
        ],
        0,
        "Is not + V-ing."
      ],
      [
        "What ___ they doing?",
        [
          "are",
          "is",
          "do",
          "does"
        ],
        0,
        "They bilan are."
      ],
      [
        "It ___ raining now.",
        [
          "is",
          "are",
          "am",
          "do"
        ],
        0,
        "It is + V-ing."
      ],
      [
        "My friends ___ coming.",
        [
          "are",
          "is",
          "am",
          "do"
        ],
        0,
        "Friends ko‘plik."
      ]
    ],
    "blanks": [
      [
        "I ___ English now. (study)",
        [
          "am studying"
        ],
        "I am + V-ing."
      ],
      [
        "She ___ TV at the moment. (watch)",
        [
          "is watching"
        ],
        "She is + V-ing."
      ],
      [
        "They ___ football now. (play)",
        [
          "are playing"
        ],
        "They are + V-ing."
      ],
      [
        "He ___ a letter now. (write)",
        [
          "is writing"
        ],
        "He is + V-ing."
      ],
      [
        "We ___ dinner now. (eat)",
        [
          "are eating"
        ],
        "We are + V-ing."
      ],
      [
        "___ you listening?",
        [
          "are"
        ],
        "You bilan Are."
      ],
      [
        "It ___ raining now.",
        [
          "is"
        ],
        "It bilan is."
      ]
    ],
    "sentences": [
      [
        "Write one positive Present Continuous sentence.",
        "present_continuous",
        [
          "I am reading now.",
          "She is cooking."
        ],
        "am/is/are + V-ing bilan yozing."
      ],
      [
        "Write one negative Present Continuous sentence.",
        "present_continuous",
        [
          "I am not sleeping.",
          "They are not watching TV."
        ],
        "am/is/are + not + V-ing."
      ],
      [
        "Write one Present Continuous question.",
        "present_continuous",
        [
          "Are you listening?",
          "Is she studying?"
        ],
        "Am/Is/Are bilan savol yozing."
      ]
    ]
  },
  "PRESENT SIMPLE": {
    "choice": [
      [
        "She ___ English every day.",
        [
          "studies",
          "study",
          "studying",
          "studied"
        ],
        0,
        "She bilan -s/-es."
      ],
      [
        "I ___ coffee every morning.",
        [
          "drink",
          "drinks",
          "am drinking",
          "drank"
        ],
        0,
        "I bilan V1."
      ],
      [
        "He ___ football on Sundays.",
        [
          "plays",
          "play",
          "playing",
          "played"
        ],
        0,
        "He bilan -s."
      ],
      [
        "They usually ___ home at seven.",
        [
          "come",
          "comes",
          "coming",
          "came"
        ],
        0,
        "They bilan V1."
      ],
      [
        "___ you like tea?",
        [
          "Do",
          "Does",
          "Are",
          "Is"
        ],
        0,
        "You bilan Do."
      ],
      [
        "___ she speak English?",
        [
          "Does",
          "Do",
          "Is",
          "Are"
        ],
        0,
        "She bilan Does."
      ],
      [
        "He does not ___ TV.",
        [
          "watch",
          "watches",
          "watching",
          "watched"
        ],
        0,
        "Does not + V1."
      ],
      [
        "We don’t ___ meat.",
        [
          "eat",
          "eats",
          "eating",
          "ate"
        ],
        0,
        "Don’t + V1."
      ],
      [
        "It ___ a lot in spring.",
        [
          "rains",
          "rain",
          "raining",
          "rained"
        ],
        0,
        "It bilan -s."
      ],
      [
        "My brother ___ in Tashkent.",
        [
          "lives",
          "live",
          "living",
          "lived"
        ],
        0,
        "Brother = he."
      ]
    ],
    "blanks": [
      [
        "She ___ tennis every weekend. (play)",
        [
          "plays"
        ],
        "She bilan -s."
      ],
      [
        "We ___ coffee in the evening. (not / drink)",
        [
          "do not drink",
          "don't drink",
          "dont drink"
        ],
        "We bilan do not + V1."
      ],
      [
        "___ Ali speak English?",
        [
          "does"
        ],
        "Ali = he."
      ],
      [
        "My brother ___ TV after school. (watch)",
        [
          "watches"
        ],
        "watch → watches."
      ],
      [
        "They usually ___ home at seven. (come)",
        [
          "come"
        ],
        "They bilan V1."
      ],
      [
        "It ___ a lot in spring. (rain)",
        [
          "rains"
        ],
        "It bilan -s."
      ],
      [
        "I ___ English every day. (study)",
        [
          "study"
        ],
        "I bilan V1."
      ]
    ],
    "sentences": [
      [
        "Write one positive Present Simple sentence.",
        "present_simple",
        [
          "I study English every day.",
          "She plays tennis."
        ],
        "Present Simple ijobiy gap yozing."
      ],
      [
        "Write one negative Present Simple sentence.",
        "present_simple",
        [
          "I do not watch TV.",
          "He does not like coffee."
        ],
        "do not / does not ishlating."
      ],
      [
        "Write one Present Simple question.",
        "present_simple",
        [
          "Do you speak English?",
          "Does she play tennis?"
        ],
        "Do/Does bilan savol yozing."
      ]
    ]
  },
  "CAN / CAN'T": {
  "choice": [
    [
      "I can ___ English.",
      [
        "speak",
        "speaks",
        "speaking",
        "to speak"
      ],
      0,
      "Can + V1."
    ],
    [
      "She can ___ fast.",
      [
        "run",
        "runs",
        "running",
        "to run"
      ],
      0,
      "Can dan keyin fe’lga -s qo‘shilmaydi."
    ],
    [
      "Can you ___ me?",
      [
        "help",
        "helps",
        "helping",
        "to help"
      ],
      0,
      "Savolda ham can + V1."
    ],
    [
      "He ___ swim.",
      [
        "can’t",
        "doesn’t can",
        "not can",
        "can not to"
      ],
      0,
      "Can’t — inkor shakl."
    ],
    [
      "They can ___ football.",
      [
        "play",
        "plays",
        "playing",
        "to play"
      ],
      0,
      "Can + V1."
    ],
    [
      "___ I come in?",
      [
        "Can",
        "Do can",
        "Am can",
        "Can to"
      ],
      0,
      "Ruxsat so‘rashda Can I...?"
    ],
    [
      "She can’t ___ today.",
      [
        "come",
        "comes",
        "coming",
        "to come"
      ],
      0,
      "Can’t + V1."
    ],
    [
      "We can ___ now.",
      [
        "start",
        "starts",
        "starting",
        "to start"
      ],
      0,
      "Can + V1."
    ],
    [
      "He can ___ a car.",
      [
        "drive",
        "drives",
        "driving",
        "to drive"
      ],
      0,
      "Can + V1."
    ],
    [
      "Can they ___?",
      [
        "read",
        "reads",
        "reading",
        "to read"
      ],
      0,
      "Can + subject + V1?"
    ]
  ],
  "blanks": [
    [
      "I can ___ English.",
      [
        "speak"
      ],
      "Can + V1."
    ],
    [
      "She can ___ very well.",
      [
        "sing"
      ],
      "Can + V1."
    ],
    [
      "Can you ___ me?",
      [
        "help"
      ],
      "Savolda Can boshida, fe’l V1."
    ],
    [
      "He can’t ___ a car.",
      [
        "drive"
      ],
      "Can’t + V1."
    ],
    [
      "They can ___ football.",
      [
        "play"
      ],
      "Can + V1."
    ],
    [
      "___ you swim?",
      [
        "can"
      ],
      "Savol: Can you...?"
    ],
    [
      "I ___ not come today.",
      [
        "can"
      ],
      "Can not / can’t inkor."
    ],
    [
      "Can she ___ English?",
      [
        "speak"
      ],
      "Can + V1."
    ],
    [
      "We can ___ the lesson now.",
      [
        "start"
      ],
      "Can + V1."
    ],
    [
      "You can ___ my pen.",
      [
        "use"
      ],
      "Ruxsat: You can use..."
    ]
  ],
  "sentences": [
    [
      "Write one sentence with can about ability.",
      "modal",
      [
        "I can swim.",
        "She can speak English."
      ],
      "can + V1 bilan qobiliyat gapini yozing."
    ],
    [
      "Write one negative sentence with can’t.",
      "modal",
      [
        "I can’t drive.",
        "He can’t come today."
      ],
      "can’t + V1 ishlating."
    ],
    [
      "Write one question with Can.",
      "modal",
      [
        "Can you help me?",
        "Can she read English?"
      ],
      "Can + subject + V1? shaklida yozing."
    ],
    [
      "Write one permission question with Can I...?.",
      "modal",
      [
        "Can I come in?",
        "Can I use your pen?"
      ],
      "Ruxsat so‘rash uchun Can I...? ishlating."
    ]
  ]
},
  "USED TO": {
    "choice": [
      [
        "I ___ live in a village.",
        [
          "used to",
          "use to",
          "used",
          "am used to"
        ],
        0,
        "Oldingi odat/holat — used to."
      ],
      [
        "She used to ___ here.",
        [
          "work",
          "works",
          "worked",
          "working"
        ],
        0,
        "Used to + V1."
      ],
      [
        "Did you ___ play tennis?",
        [
          "use to",
          "used to",
          "using to",
          "used"
        ],
        0,
        "Did bilan use to."
      ],
      [
        "We didn’t ___ have a car.",
        [
          "use to",
          "used to",
          "using to",
          "used"
        ],
        0,
        "Didn’t bilan use to."
      ],
      [
        "He ___ be shy.",
        [
          "used to",
          "use to",
          "would to",
          "using to"
        ],
        0,
        "Oldingi holat."
      ],
      [
        "They used to ___ to school.",
        [
          "walk",
          "walks",
          "walked",
          "walking"
        ],
        0,
        "Used to + V1."
      ],
      [
        "I used to ___ football.",
        [
          "play",
          "played",
          "plays",
          "playing"
        ],
        0,
        "Used to + V1."
      ],
      [
        "___ she use to read a lot?",
        [
          "Did",
          "Does",
          "Was",
          "Is"
        ],
        0,
        "Savol: Did + subject + use to."
      ],
      [
        "She didn’t use to ___ coffee.",
        [
          "drink",
          "drank",
          "drinks",
          "drinking"
        ],
        0,
        "Use to + V1."
      ],
      [
        "My father ___ work in a bank.",
        [
          "used to",
          "use to",
          "using to",
          "was used"
        ],
        0,
        "Oldingi ish."
      ]
    ],
    "blanks": [
      [
        "I ___ live in a village.",
        [
          "used to"
        ],
        "Oldingi holat."
      ],
      [
        "She used to ___ here. (work)",
        [
          "work"
        ],
        "Used to + V1."
      ],
      [
        "Did you ___ play tennis?",
        [
          "use to"
        ],
        "Did bilan use to."
      ],
      [
        "We didn’t ___ have a car.",
        [
          "use to"
        ],
        "Didn’t bilan use to."
      ],
      [
        "He ___ be shy.",
        [
          "used to"
        ],
        "Oldingi holat."
      ]
    ],
    "sentences": [
      [
        "Write one sentence with “used to”.",
        "used_to",
        [
          "I used to play football.",
          "She used to live here."
        ],
        "used to + V1."
      ],
      [
        "Write one negative sentence with “didn’t use to”.",
        "used_to",
        [
          "I didn’t use to drink coffee.",
          "We did not use to have a car."
        ],
        "didn’t use to + V1."
      ],
      [
        "Write one question with “Did ... use to”.",
        "used_to",
        [
          "Did you use to read a lot?",
          "Did she use to live here?"
        ],
        "Did + subject + use to + V1?"
      ]
    ]
  },
  "CONDITIONAL 1": {
    "choice": [
      [
        "If it rains, I ___ home.",
        [
          "will stay",
          "stay",
          "stayed",
          "am staying"
        ],
        0,
        "Natija: will + V1."
      ],
      [
        "If she ___, we will start.",
        [
          "comes",
          "will come",
          "came",
          "coming"
        ],
        0,
        "If qismi Present Simple."
      ],
      [
        "If you study, you ___ pass.",
        [
          "will",
          "are",
          "did",
          "have"
        ],
        0,
        "Will + V1."
      ],
      [
        "I will call you if I ___ time.",
        [
          "have",
          "will have",
          "had",
          "having"
        ],
        0,
        "If qismi Present Simple."
      ],
      [
        "If you hurry, you ___ catch the bus.",
        [
          "will",
          "do",
          "are",
          "did"
        ],
        0,
        "Natija qismi will."
      ],
      [
        "If he doesn’t practice, he ___ improve.",
        [
          "won’t",
          "doesn’t",
          "isn’t",
          "didn’t"
        ],
        0,
        "Will not = won’t."
      ],
      [
        "If they invite us, we ___ go.",
        [
          "will",
          "are",
          "did",
          "have"
        ],
        0,
        "Will + V1."
      ],
      [
        "If I see Ali, I ___ tell him.",
        [
          "will",
          "would",
          "am",
          "did"
        ],
        0,
        "Real future condition."
      ],
      [
        "If the weather is good, we ___ play football.",
        [
          "will",
          "are",
          "did",
          "have"
        ],
        0,
        "Natija qismi will."
      ],
      [
        "If you don’t sleep, you ___ tired.",
        [
          "will feel",
          "feel",
          "felt",
          "are feeling"
        ],
        0,
        "Future result."
      ]
    ],
    "blanks": [
      [
        "If it rains, I ___ home. (stay)",
        [
          "will stay"
        ],
        "Will + V1."
      ],
      [
        "If she ___, we will start. (come)",
        [
          "comes"
        ],
        "If qismi Present Simple."
      ],
      [
        "If you study, you ___ pass.",
        [
          "will"
        ],
        "Natija — will."
      ],
      [
        "I will call you if I ___ time. (have)",
        [
          "have"
        ],
        "If qismi Present Simple."
      ],
      [
        "If he doesn’t practice, he ___ improve.",
        [
          "won’t",
          "will not"
        ],
        "Negative result."
      ]
    ],
    "sentences": [
      [
        "Write one First Conditional sentence about study.",
        "conditional_first",
        [
          "If I study, I will pass.",
          "If you practice, you will improve."
        ],
        "If + Present Simple, will + V1."
      ],
      [
        "Write one First Conditional sentence about weather.",
        "conditional_first",
        [
          "If it rains, I will stay home.",
          "If the weather is good, we will play football."
        ],
        "Real future condition yozing."
      ],
      [
        "Write one negative First Conditional sentence.",
        "conditional_first",
        [
          "If you don’t practice, you won’t improve.",
          "If he doesn’t come, we won’t start."
        ],
        "won’t ishlating."
      ]
    ]
  },
  "GERUND INFINITIVE": {
    "choice": [
      [
        "I enjoy ___ books.",
        [
          "reading",
          "to read",
          "read",
          "reads"
        ],
        0,
        "Enjoy + V-ing."
      ],
      [
        "She wants ___ English.",
        [
          "to learn",
          "learning",
          "learn",
          "learns"
        ],
        0,
        "Want + to V1."
      ],
      [
        "He finished ___ homework.",
        [
          "doing",
          "to do",
          "do",
          "does"
        ],
        0,
        "Finish + V-ing."
      ],
      [
        "We decided ___ home.",
        [
          "to go",
          "going",
          "go",
          "goes"
        ],
        0,
        "Decide + to V1."
      ],
      [
        "___ English is useful.",
        [
          "Learning",
          "To learning",
          "Learn",
          "Learns"
        ],
        0,
        "Gerund subject."
      ],
      [
        "I need ___ more.",
        [
          "to practice",
          "practicing",
          "practice",
          "practices"
        ],
        0,
        "Need + to V1."
      ],
      [
        "She likes ___.",
        [
          "swimming",
          "to swimming",
          "swims",
          "swam"
        ],
        0,
        "Like + V-ing mumkin."
      ],
      [
        "They agreed ___ us.",
        [
          "to help",
          "helping",
          "help",
          "helps"
        ],
        0,
        "Agree + to V1."
      ],
      [
        "He avoids ___ late.",
        [
          "coming",
          "to come",
          "come",
          "comes"
        ],
        0,
        "Avoid + V-ing."
      ],
      [
        "I hope ___ soon.",
        [
          "to see you",
          "seeing you",
          "see you",
          "saw you"
        ],
        0,
        "Hope + to V1."
      ]
    ],
    "blanks": [
      [
        "I enjoy ___ books. (read)",
        [
          "reading"
        ],
        "Enjoy + V-ing."
      ],
      [
        "She wants ___ English. (learn)",
        [
          "to learn"
        ],
        "Want + to V1."
      ],
      [
        "He finished ___ homework. (do)",
        [
          "doing"
        ],
        "Finish + V-ing."
      ],
      [
        "We decided ___ home. (go)",
        [
          "to go"
        ],
        "Decide + to V1."
      ],
      [
        "___ English is useful. (learn)",
        [
          "learning"
        ],
        "Gerund subject."
      ],
      [
        "I need ___ more. (practice)",
        [
          "to practice"
        ],
        "Need + to V1."
      ]
    ],
    "sentences": [
      [
        "Write one sentence with a gerund after enjoy/finish.",
        "gerund",
        [
          "I enjoy reading.",
          "She finished doing homework."
        ],
        "V-ing ishlating."
      ],
      [
        "Write one sentence with an infinitive after want/need/decide.",
        "infinitive",
        [
          "I want to learn English.",
          "We decided to go home."
        ],
        "to + V1 ishlating."
      ],
      [
        "Write one sentence where gerund is the subject.",
        "gerund",
        [
          "Learning English is useful.",
          "Swimming is good for health."
        ],
        "V-ing gap boshida kelsin."
      ]
    ]
  },
  "USED TO / WOULD": {
    "choice": [
      [
        "I ___ live here when I was young.",
        [
          "used to",
          "would to",
          "use",
          "am used to"
        ],
        0,
        "Holat — used to."
      ],
      [
        "Every summer, we ___ visit our grandparents.",
        [
          "would",
          "would to",
          "used",
          "were"
        ],
        0,
        "Takroriy harakat — would."
      ],
      [
        "She ___ be quiet.",
        [
          "used to",
          "would",
          "would to",
          "use to"
        ],
        0,
        "Holat — used to."
      ],
      [
        "My grandfather would ___ stories.",
        [
          "tell",
          "told",
          "tells",
          "telling"
        ],
        0,
        "Would + V1."
      ],
      [
        "Did she ___ play tennis?",
        [
          "use to",
          "used to",
          "would to",
          "using to"
        ],
        0,
        "Did bilan use to."
      ],
      [
        "We didn’t ___ have computers.",
        [
          "use to",
          "used to",
          "would to",
          "using to"
        ],
        0,
        "Didn’t bilan use to."
      ],
      [
        "When I was a child, I would ___ outside.",
        [
          "play",
          "played",
          "plays",
          "playing"
        ],
        0,
        "Would + V1."
      ],
      [
        "He used to ___ in London.",
        [
          "live",
          "lived",
          "lives",
          "living"
        ],
        0,
        "Used to + V1."
      ],
      [
        "They would ___ us every week.",
        [
          "visit",
          "visited",
          "visits",
          "visiting"
        ],
        0,
        "Would + V1."
      ],
      [
        "I ___ know him before.",
        [
          "used to",
          "would",
          "would to",
          "am used"
        ],
        0,
        "State verb uchun used to."
      ]
    ],
    "blanks": [
      [
        "I ___ live here when I was young.",
        [
          "used to"
        ],
        "Holat — used to."
      ],
      [
        "Every summer, we ___ visit our grandparents.",
        [
          "would"
        ],
        "Takroriy harakat."
      ],
      [
        "She ___ be quiet.",
        [
          "used to"
        ],
        "Holat."
      ],
      [
        "My grandfather would ___ stories. (tell)",
        [
          "tell"
        ],
        "Would + V1."
      ],
      [
        "Did she ___ play tennis?",
        [
          "use to"
        ],
        "Did bilan use to."
      ]
    ],
    "sentences": [
      [
        "Write one sentence with “used to” for an old state.",
        "used_to",
        [
          "I used to live in a small town.",
          "She used to be quiet."
        ],
        "Oldingi holat yozing."
      ],
      [
        "Write one sentence with “would” for a repeated past action.",
        "modal",
        [
          "When I was a child, I would play outside.",
          "My grandfather would tell stories."
        ],
        "would + V1."
      ],
      [
        "Write one question with “Did ... use to”.",
        "used_to",
        [
          "Did you use to walk to school?",
          "Did she use to play tennis?"
        ],
        "Did + subject + use to + V1."
      ]
    ]
  },
  "PREPOSITION OF PLACE": {
    "choice": [
      [
        "The book is ___ the table.",
        [
          "on",
          "in",
          "at",
          "between"
        ],
        0,
        "Stol ustida — on."
      ],
      [
        "The phone is ___ the bag.",
        [
          "in",
          "on",
          "at",
          "under"
        ],
        0,
        "Sumka ichida — in."
      ],
      [
        "The cat is ___ the chair. (ostida)",
        [
          "under",
          "on",
          "in",
          "between"
        ],
        0,
        "Ostida — under."
      ],
      [
        "Ali is ___ me. (yonimda)",
        [
          "next to",
          "under",
          "in",
          "between"
        ],
        0,
        "Yonida — next to."
      ],
      [
        "The bank is ___ the shop and the school.",
        [
          "between",
          "on",
          "under",
          "behind"
        ],
        0,
        "Orasida — between."
      ],
      [
        "The car is ___ the house. (orqasida)",
        [
          "behind",
          "in",
          "on",
          "under"
        ],
        0,
        "Orqasida — behind."
      ],
      [
        "The teacher is ___ front of the class.",
        [
          "in",
          "on",
          "at",
          "under"
        ],
        0,
        "In front of."
      ],
      [
        "The picture is ___ the wall.",
        [
          "on",
          "in",
          "at",
          "under"
        ],
        0,
        "Devorda — on."
      ],
      [
        "I am ___ school.",
        [
          "at",
          "on",
          "under",
          "between"
        ],
        0,
        "At school."
      ],
      [
        "The keys are ___ the box.",
        [
          "in",
          "on",
          "at",
          "behind"
        ],
        0,
        "Quti ichida — in."
      ]
    ],
    "blanks": [
      [
        "The book is ___ the table.",
        [
          "on"
        ],
        "Stol ustida — on."
      ],
      [
        "The phone is ___ the bag.",
        [
          "in"
        ],
        "Sumka ichida — in."
      ],
      [
        "The cat is ___ the chair.",
        [
          "under"
        ],
        "Ostida — under."
      ],
      [
        "Ali is ___ me.",
        [
          "next to"
        ],
        "Yonida — next to."
      ],
      [
        "The bank is ___ the shop and the school.",
        [
          "between"
        ],
        "Orasida — between."
      ],
      [
        "The car is ___ the house.",
        [
          "behind"
        ],
        "Orqasida — behind."
      ]
    ],
    "sentences": [
      [
        "Write one sentence with “in”.",
        "preposition_place",
        [
          "The phone is in the bag.",
          "I am in the room."
        ],
        "in ishlating."
      ],
      [
        "Write one sentence with “on”.",
        "preposition_place",
        [
          "The book is on the table.",
          "The picture is on the wall."
        ],
        "on ishlating."
      ],
      [
        "Write one sentence with “under” or “between”.",
        "preposition_place",
        [
          "The cat is under the chair.",
          "The bank is between two shops."
        ],
        "under/between ishlating."
      ]
    ]
  },
  "PREPOSITION OF TIME": {
    "choice": [
      [
        "The lesson starts ___ 9 o’clock.",
        [
          "at",
          "on",
          "in"
        ],
        0,
        "Aniq vaqt — at."
      ],
      [
        "We meet ___ Monday.",
        [
          "on",
          "in",
          "at"
        ],
        0,
        "Kun — on."
      ],
      [
        "My birthday is ___ June.",
        [
          "in",
          "on",
          "at"
        ],
        0,
        "Oy — in."
      ],
      [
        "She was born ___ 2010.",
        [
          "in",
          "on",
          "at"
        ],
        0,
        "Yil — in."
      ],
      [
        "The test is ___ 15 May.",
        [
          "on",
          "in",
          "at"
        ],
        0,
        "Sana — on."
      ],
      [
        "I study ___ the morning.",
        [
          "in",
          "on",
          "at"
        ],
        0,
        "In the morning."
      ],
      [
        "We sleep ___ night.",
        [
          "at",
          "on",
          "in"
        ],
        0,
        "At night."
      ],
      [
        "The shop opens ___ 8:30.",
        [
          "at",
          "on",
          "in"
        ],
        0,
        "Aniq vaqt — at."
      ],
      [
        "They travel ___ summer.",
        [
          "in",
          "on",
          "at"
        ],
        0,
        "Fasl — in."
      ],
      [
        "See you ___ Friday.",
        [
          "on",
          "in",
          "at"
        ],
        0,
        "Kun — on."
      ]
    ],
    "blanks": [
      [
        "The lesson starts ___ 9 o’clock.",
        [
          "at"
        ],
        "Aniq vaqt — at."
      ],
      [
        "We meet ___ Monday.",
        [
          "on"
        ],
        "Kun — on."
      ],
      [
        "My birthday is ___ June.",
        [
          "in"
        ],
        "Oy — in."
      ],
      [
        "She was born ___ 2010.",
        [
          "in"
        ],
        "Yil — in."
      ],
      [
        "The test is ___ 15 May.",
        [
          "on"
        ],
        "Sana — on."
      ],
      [
        "I study ___ the morning.",
        [
          "in"
        ],
        "In the morning."
      ]
    ],
    "sentences": [
      [
        "Write one sentence with “at” for time.",
        "preposition_time",
        [
          "The lesson starts at 9 o’clock.",
          "I wake up at 7."
        ],
        "at + exact time ishlating."
      ],
      [
        "Write one sentence with “on” for time.",
        "preposition_time",
        [
          "We meet on Monday.",
          "The test is on 15 May."
        ],
        "on + day/date ishlating."
      ],
      [
        "Write one sentence with “in” for time.",
        "preposition_time",
        [
          "My birthday is in June.",
          "I study in the morning."
        ],
        "in + month/year/part of day ishlating."
      ]
    ]
  },
  "PRESENT SIMPLE & PRESENT CONTINUOUS": {
    "choice": [
      [
        "I ___ coffee every morning.",
        [
          "drink",
          "am drinking",
          "drinks",
          "drank"
        ],
        0,
        "Every morning — Present Simple."
      ],
      [
        "I ___ coffee now.",
        [
          "am drinking",
          "drink",
          "drinks",
          "drank"
        ],
        0,
        "Now — Present Continuous."
      ],
      [
        "She usually ___ to school.",
        [
          "goes",
          "is going",
          "go",
          "going"
        ],
        0,
        "Usually — Present Simple."
      ],
      [
        "Look! She ___.",
        [
          "is running",
          "runs",
          "run",
          "ran"
        ],
        0,
        "Look — hozir."
      ],
      [
        "They ___ football on Sundays.",
        [
          "play",
          "are playing",
          "plays",
          "played"
        ],
        0,
        "On Sundays — odat."
      ],
      [
        "They ___ football at the moment.",
        [
          "are playing",
          "play",
          "plays",
          "played"
        ],
        0,
        "At the moment — hozir."
      ],
      [
        "He ___ in a bank.",
        [
          "works",
          "is working",
          "work",
          "working"
        ],
        0,
        "Doimiy ish."
      ],
      [
        "He ___ late today.",
        [
          "is working",
          "works",
          "work",
          "worked"
        ],
        0,
        "Today vaqtinchalik."
      ],
      [
        "Water ___ at 100°C.",
        [
          "boils",
          "is boiling",
          "boil",
          "boiled"
        ],
        0,
        "Umumiy haqiqat."
      ],
      [
        "Please be quiet. I ___.",
        [
          "am studying",
          "study",
          "studies",
          "studied"
        ],
        0,
        "Hozir davom etyapti."
      ]
    ],
    "blanks": [
      [
        "I ___ coffee every morning. (drink)",
        [
          "drink"
        ],
        "Odat — Present Simple."
      ],
      [
        "I ___ coffee now. (drink)",
        [
          "am drinking"
        ],
        "Now — Present Continuous."
      ],
      [
        "She usually ___ to school. (go)",
        [
          "goes"
        ],
        "Usually — Present Simple."
      ],
      [
        "Look! She ___. (run)",
        [
          "is running"
        ],
        "Look — hozir."
      ],
      [
        "They ___ football on Sundays. (play)",
        [
          "play"
        ],
        "Odat."
      ],
      [
        "They ___ football at the moment. (play)",
        [
          "are playing"
        ],
        "At the moment."
      ]
    ],
    "sentences": [
      [
        "Write one Present Simple sentence about a habit.",
        "present_simple",
        [
          "I study English every day.",
          "She plays tennis on Sundays."
        ],
        "Odat haqida yozing."
      ],
      [
        "Write one Present Continuous sentence about now.",
        "present_continuous",
        [
          "I am reading now.",
          "They are playing football."
        ],
        "Now/at the moment ishlating."
      ],
      [
        "Write two short sentences: one habit, one now.",
        "present_simple",
        [
          "I work every day. I am working now.",
          "She usually drinks tea. She is drinking tea now."
        ],
        "Simple va Continuous farqini ko‘rsating."
      ]
    ]
  },
  "ADVERB AND ADJECTIVE": {
    "choice": [
      [
        "He is a ___ driver.",
        [
          "careful",
          "carefully",
          "care",
          "carefulness"
        ],
        0,
        "Otni adjective tasvirlaydi."
      ],
      [
        "He drives ___.",
        [
          "carefully",
          "careful",
          "care",
          "carefulness"
        ],
        0,
        "Fe’lni adverb tasvirlaydi."
      ],
      [
        "She is a ___ singer.",
        [
          "good",
          "well",
          "goodly",
          "betterly"
        ],
        0,
        "Singer ot."
      ],
      [
        "She sings ___.",
        [
          "well",
          "good",
          "goodly",
          "better"
        ],
        0,
        "Sing fe’l."
      ],
      [
        "It is a ___ test.",
        [
          "easy",
          "easily",
          "ease",
          "easyly"
        ],
        0,
        "Test ot."
      ],
      [
        "He answered ___.",
        [
          "easily",
          "easy",
          "ease",
          "easyly"
        ],
        0,
        "Answered fe’l."
      ],
      [
        "The lesson is ___.",
        [
          "clear",
          "clearly",
          "clearerly",
          "clearness"
        ],
        0,
        "Be + adjective."
      ],
      [
        "The teacher explains ___.",
        [
          "clearly",
          "clear",
          "clearness",
          "clearer"
        ],
        0,
        "Explain fe’l."
      ],
      [
        "This is a ___ answer.",
        [
          "quick",
          "quickly",
          "quickerly",
          "quickness"
        ],
        0,
        "Answer ot."
      ],
      [
        "She works ___.",
        [
          "quickly",
          "quick",
          "quickness",
          "quicker"
        ],
        0,
        "Works fe’l."
      ]
    ],
    "blanks": [
      [
        "He is a ___ driver. (careful/carefully)",
        [
          "careful"
        ],
        "Driver ot."
      ],
      [
        "He drives ___. (careful/carefully)",
        [
          "carefully"
        ],
        "Drive fe’l."
      ],
      [
        "She sings ___. (good/well)",
        [
          "well"
        ],
        "Sing fe’l."
      ],
      [
        "This is a ___ answer. (quick/quickly)",
        [
          "quick"
        ],
        "Answer ot."
      ],
      [
        "She works ___. (quick/quickly)",
        [
          "quickly"
        ],
        "Works fe’l."
      ],
      [
        "The teacher explains ___. (clear/clearly)",
        [
          "clearly"
        ],
        "Explains fe’l."
      ]
    ],
    "sentences": [
      [
        "Write one sentence with an adjective before a noun.",
        "adjective_adverb",
        [
          "It is a slow car.",
          "She is a careful student."
        ],
        "adjective + noun yozing."
      ],
      [
        "Write one sentence with an adverb after a verb.",
        "adjective_adverb",
        [
          "He drives slowly.",
          "She writes carefully."
        ],
        "verb + adverb yozing."
      ],
      [
        "Write one sentence with good or well.",
        "adjective_adverb",
        [
          "She is a good singer.",
          "She sings well."
        ],
        "good/well farqini ishlating."
      ]
    ]
  },
  "PREPOSITION TIME AND PLACE": {
    "choice": [
      [
        "I am ___ school ___ 9 o’clock.",
        [
          "at / at",
          "in / on",
          "on / in",
          "under / at"
        ],
        0,
        "Place: at school; time: at 9."
      ],
      [
        "The book is ___ the table.",
        [
          "on",
          "in",
          "at",
          "to"
        ],
        0,
        "Place — on."
      ],
      [
        "We meet ___ Friday.",
        [
          "on",
          "in",
          "at",
          "under"
        ],
        0,
        "Time day — on."
      ],
      [
        "She lives ___ Tashkent.",
        [
          "in",
          "on",
          "at",
          "to"
        ],
        0,
        "City — in."
      ],
      [
        "The class starts ___ 8.",
        [
          "at",
          "on",
          "in",
          "by"
        ],
        0,
        "Exact time — at."
      ],
      [
        "The picture is ___ the wall.",
        [
          "on",
          "in",
          "at",
          "under"
        ],
        0,
        "Wall surface — on."
      ],
      [
        "He is ___ the room.",
        [
          "in",
          "on",
          "at",
          "to"
        ],
        0,
        "Room inside — in."
      ],
      [
        "My birthday is ___ April.",
        [
          "in",
          "on",
          "at",
          "to"
        ],
        0,
        "Month — in."
      ],
      [
        "The test is ___ Monday.",
        [
          "on",
          "in",
          "at",
          "to"
        ],
        0,
        "Day — on."
      ],
      [
        "We are ___ home.",
        [
          "at",
          "in",
          "on",
          "under"
        ],
        0,
        "At home."
      ]
    ],
    "blanks": [
      [
        "I am ___ school.",
        [
          "at"
        ],
        "At school."
      ],
      [
        "The book is ___ the table.",
        [
          "on"
        ],
        "On the table."
      ],
      [
        "We meet ___ Friday.",
        [
          "on"
        ],
        "On + day."
      ],
      [
        "She lives ___ Tashkent.",
        [
          "in"
        ],
        "In + city."
      ],
      [
        "The class starts ___ 8.",
        [
          "at"
        ],
        "At + exact time."
      ],
      [
        "My birthday is ___ April.",
        [
          "in"
        ],
        "In + month."
      ]
    ],
    "sentences": [
      [
        "Write one sentence with a place preposition.",
        "preposition_place",
        [
          "The book is on the table.",
          "I am in the room."
        ],
        "Joy predlogi ishlating."
      ],
      [
        "Write one sentence with a time preposition.",
        "preposition_time",
        [
          "The lesson starts at 9.",
          "We meet on Monday."
        ],
        "Vaqt predlogi ishlating."
      ],
      [
        "Write one sentence with both time and place.",
        "preposition_time",
        [
          "I am at school at 9 o’clock.",
          "We meet at the office on Monday."
        ],
        "Vaqt va joyni bir gapda yozing."
      ]
    ]
  },
  "PAST CONTINUOUS": {
    "choice": [
      [
        "I ___ reading at 8.",
        [
          "was",
          "were",
          "am",
          "did"
        ],
        0,
        "I bilan was."
      ],
      [
        "They ___ playing football.",
        [
          "were",
          "was",
          "are",
          "did"
        ],
        0,
        "They bilan were."
      ],
      [
        "She was ___.",
        [
          "cooking",
          "cook",
          "cooks",
          "cooked"
        ],
        0,
        "Was + V-ing."
      ],
      [
        "We were ___ TV.",
        [
          "watching",
          "watch",
          "watched",
          "watches"
        ],
        0,
        "Were + V-ing."
      ],
      [
        "___ you sleeping?",
        [
          "Were",
          "Was",
          "Did",
          "Are"
        ],
        0,
        "You bilan were."
      ],
      [
        "He ___ not working.",
        [
          "was",
          "were",
          "did",
          "is"
        ],
        0,
        "He bilan was."
      ],
      [
        "What ___ they doing?",
        [
          "were",
          "was",
          "did",
          "are"
        ],
        0,
        "They bilan were."
      ],
      [
        "It ___ raining.",
        [
          "was",
          "were",
          "did",
          "are"
        ],
        0,
        "It bilan was."
      ],
      [
        "My friends ___ waiting.",
        [
          "were",
          "was",
          "did",
          "are"
        ],
        0,
        "Friends ko‘plik."
      ],
      [
        "Ali ___ studying when I called.",
        [
          "was",
          "were",
          "did",
          "is"
        ],
        0,
        "Ali birlik."
      ]
    ],
    "blanks": [
      [
        "I ___ reading at 8. (be)",
        [
          "was"
        ],
        "I bilan was."
      ],
      [
        "They ___ playing football. (be)",
        [
          "were"
        ],
        "They bilan were."
      ],
      [
        "She was ___ dinner. (cook)",
        [
          "cooking"
        ],
        "Was + V-ing."
      ],
      [
        "We were ___ TV. (watch)",
        [
          "watching"
        ],
        "Were + V-ing."
      ],
      [
        "___ you sleeping?",
        [
          "were"
        ],
        "You bilan were."
      ],
      [
        "It ___ raining.",
        [
          "was"
        ],
        "It bilan was."
      ]
    ],
    "sentences": [
      [
        "Write one positive Past Continuous sentence.",
        "past_continuous",
        [
          "I was reading at 8.",
          "They were playing football."
        ],
        "was/were + V-ing."
      ],
      [
        "Write one negative Past Continuous sentence.",
        "past_continuous",
        [
          "I was not sleeping.",
          "They were not watching TV."
        ],
        "was/were not + V-ing."
      ],
      [
        "Write one Past Continuous question.",
        "past_continuous",
        [
          "Were you studying?",
          "Was she cooking?"
        ],
        "Was/Were bilan savol yozing."
      ]
    ]
  },
  "CONDITIONAL 0": {
    "choice": [
      [
        "If you heat water, it ___.",
        [
          "boils",
          "will boil",
          "boiled",
          "is boiling"
        ],
        0,
        "Zero conditional: Present Simple."
      ],
      [
        "If it rains, the ground ___.",
        [
          "gets wet",
          "will get wet",
          "got wet",
          "getting wet"
        ],
        0,
        "Umumiy natija."
      ],
      [
        "If you mix red and blue, you ___ purple.",
        [
          "get",
          "will get",
          "got",
          "are getting"
        ],
        0,
        "Umumiy haqiqat."
      ],
      [
        "Ice ___ if you heat it.",
        [
          "melts",
          "will melt",
          "melted",
          "melting"
        ],
        0,
        "Fact."
      ],
      [
        "If students practice, they ___.",
        [
          "improve",
          "will improve",
          "improved",
          "are improving"
        ],
        0,
        "Umumiy qoida."
      ],
      [
        "If you press this button, the machine ___.",
        [
          "starts",
          "will start",
          "started",
          "starting"
        ],
        0,
        "Qoida."
      ],
      [
        "If people eat too much, they ___ tired.",
        [
          "get",
          "will get",
          "got",
          "getting"
        ],
        0,
        "Doimiy natija."
      ],
      [
        "If the sun goes down, it ___ dark.",
        [
          "gets",
          "will get",
          "got",
          "getting"
        ],
        0,
        "Fact."
      ],
      [
        "If you don’t water plants, they ___.",
        [
          "die",
          "will die",
          "died",
          "dying"
        ],
        0,
        "Umumiy natija."
      ],
      [
        "If you add sugar, it ___ sweet.",
        [
          "becomes",
          "will become",
          "became",
          "becoming"
        ],
        0,
        "Fact."
      ]
    ],
    "blanks": [
      [
        "If you heat water, it ___. (boil)",
        [
          "boils"
        ],
        "Present Simple."
      ],
      [
        "If it rains, the ground ___. (get wet)",
        [
          "gets wet"
        ],
        "Present Simple."
      ],
      [
        "If you mix red and blue, you ___ purple. (get)",
        [
          "get"
        ],
        "Present Simple."
      ],
      [
        "Ice ___ if you heat it. (melt)",
        [
          "melts"
        ],
        "Present Simple."
      ],
      [
        "If students practice, they ___. (improve)",
        [
          "improve"
        ],
        "Present Simple."
      ]
    ],
    "sentences": [
      [
        "Write one Zero Conditional sentence about nature.",
        "conditional_zero",
        [
          "If you heat water, it boils.",
          "If it rains, the ground gets wet."
        ],
        "If + Present Simple, Present Simple."
      ],
      [
        "Write one Zero Conditional sentence about study.",
        "conditional_zero",
        [
          "If students practice, they improve.",
          "If I sleep late, I feel tired."
        ],
        "Umumiy qoida yozing."
      ],
      [
        "Write one sentence starting with the result first.",
        "conditional_zero",
        [
          "Ice melts if you heat it.",
          "Plants die if you don’t water them."
        ],
        "Natijani boshida yozing."
      ]
    ]
  },
  "HAVE TO / MUST": {
    "choice": [
      [
        "You ___ stop at a red light.",
        [
          "must",
          "must to",
          "musts",
          "are must"
        ],
        0,
        "Must + V1."
      ],
      [
        "She ___ wake up early.",
        [
          "has to",
          "have to",
          "musts",
          "haves to"
        ],
        0,
        "She bilan has to."
      ],
      [
        "I ___ finish my homework.",
        [
          "have to",
          "has to",
          "musts",
          "am have"
        ],
        0,
        "I bilan have to."
      ],
      [
        "You ___ smoke here. It is forbidden.",
        [
          "mustn’t",
          "don’t have to",
          "doesn’t have to",
          "must"
        ],
        0,
        "Taqiq — mustn’t."
      ],
      [
        "You ___ come early. It is not necessary.",
        [
          "don’t have to",
          "mustn’t",
          "must",
          "has to"
        ],
        0,
        "Shart emas."
      ],
      [
        "He ___ wear a uniform.",
        [
          "has to",
          "have to",
          "musts",
          "does have"
        ],
        0,
        "He bilan has to."
      ],
      [
        "Do we ___ pay now?",
        [
          "have to",
          "has to",
          "must to",
          "musts"
        ],
        0,
        "Do bilan have to."
      ],
      [
        "Students ___ listen to the teacher.",
        [
          "must",
          "musts",
          "must to",
          "are must"
        ],
        0,
        "Must + V1."
      ],
      [
        "She doesn’t ___ work today.",
        [
          "have to",
          "has to",
          "must",
          "mustn’t"
        ],
        0,
        "Doesn’t + have to."
      ],
      [
        "We ___ be quiet in the library.",
        [
          "must",
          "must to",
          "musts",
          "are must"
        ],
        0,
        "Qoida."
      ]
    ],
    "blanks": [
      [
        "You ___ stop at a red light.",
        [
          "must"
        ],
        "Must + V1."
      ],
      [
        "She ___ wake up early.",
        [
          "has to"
        ],
        "She bilan has to."
      ],
      [
        "I ___ finish my homework.",
        [
          "have to"
        ],
        "I bilan have to."
      ],
      [
        "You ___ smoke here.",
        [
          "mustn’t",
          "must not",
          "mustnt"
        ],
        "Taqiq."
      ],
      [
        "You ___ come early. It is not necessary.",
        [
          "don’t have to",
          "do not have to",
          "dont have to"
        ],
        "Shart emas."
      ]
    ],
    "sentences": [
      [
        "Write one sentence with “must”.",
        "modal",
        [
          "You must study hard.",
          "We must be quiet."
        ],
        "must + V1."
      ],
      [
        "Write one sentence with “have to/has to”.",
        "modal",
        [
          "I have to finish my homework.",
          "She has to wake up early."
        ],
        "have to/has to ishlating."
      ],
      [
        "Write one sentence with “mustn’t” or “don’t have to”.",
        "modal",
        [
          "You mustn’t smoke here.",
          "You don’t have to come early."
        ],
        "Ma’noni aniq yozing."
      ]
    ]
  },
  "PAST SIMPLE": {
    "choice": [
      [
        "I ___ TV yesterday.",
        [
          "watched",
          "watch",
          "watches",
          "watching"
        ],
        0,
        "Yesterday — past."
      ],
      [
        "She ___ to school last week.",
        [
          "went",
          "go",
          "goes",
          "going"
        ],
        0,
        "Go → went."
      ],
      [
        "They ___ football yesterday.",
        [
          "played",
          "play",
          "plays",
          "playing"
        ],
        0,
        "Regular -ed."
      ],
      [
        "Did you ___ Ali?",
        [
          "see",
          "saw",
          "seen",
          "seeing"
        ],
        0,
        "Did + V1."
      ],
      [
        "He did not ___.",
        [
          "come",
          "came",
          "comes",
          "coming"
        ],
        0,
        "Did not + V1."
      ],
      [
        "We ___ English two days ago.",
        [
          "studied",
          "study",
          "studies",
          "studying"
        ],
        0,
        "Study → studied."
      ],
      [
        "She ___ a letter.",
        [
          "wrote",
          "write",
          "writes",
          "writing"
        ],
        0,
        "Write → wrote."
      ],
      [
        "I ___ breakfast at 7.",
        [
          "ate",
          "eat",
          "eats",
          "eating"
        ],
        0,
        "Eat → ate."
      ],
      [
        "They didn’t ___ the answer.",
        [
          "know",
          "knew",
          "known",
          "knowing"
        ],
        0,
        "Didn’t + V1."
      ],
      [
        "___ he call you?",
        [
          "Did",
          "Does",
          "Was",
          "Is"
        ],
        0,
        "Past Simple savol."
      ]
    ],
    "blanks": [
      [
        "I ___ TV yesterday. (watch)",
        [
          "watched"
        ],
        "Regular -ed."
      ],
      [
        "She ___ to school last week. (go)",
        [
          "went"
        ],
        "Go → went."
      ],
      [
        "They ___ football yesterday. (play)",
        [
          "played"
        ],
        "Play → played."
      ],
      [
        "Did you ___ Ali? (see)",
        [
          "see"
        ],
        "Did + V1."
      ],
      [
        "He did not ___. (come)",
        [
          "come"
        ],
        "Did not + V1."
      ],
      [
        "We ___ English two days ago. (study)",
        [
          "studied"
        ],
        "Study → studied."
      ]
    ],
    "sentences": [
      [
        "Write one positive Past Simple sentence.",
        "past_simple",
        [
          "I watched a film yesterday.",
          "She went to school."
        ],
        "Past Simple V2/-ed ishlating."
      ],
      [
        "Write one negative Past Simple sentence.",
        "past_simple",
        [
          "I did not watch TV.",
          "He did not come."
        ],
        "did not + V1."
      ],
      [
        "Write one Past Simple question.",
        "past_simple",
        [
          "Did you see Ali?",
          "Did she call you?"
        ],
        "Did + subject + V1."
      ]
    ]
  },
  "WOULD / COULD": {
    "choice": [
      [
        "___ you help me, please?",
        [
          "Could",
          "Could to",
          "Coulds",
          "Did could"
        ],
        0,
        "Polite request."
      ],
      [
        "I ___ like some tea.",
        [
          "would",
          "coulds",
          "would to",
          "am would"
        ],
        0,
        "Would like."
      ],
      [
        "He could ___ fast.",
        [
          "run",
          "runs",
          "running",
          "ran"
        ],
        0,
        "Could + V1."
      ],
      [
        "Would you ___ to join us?",
        [
          "like",
          "likes",
          "liked",
          "to like"
        ],
        0,
        "Would + V1."
      ],
      [
        "Could I ___ a question?",
        [
          "ask",
          "asks",
          "asking",
          "to ask"
        ],
        0,
        "Could + V1."
      ],
      [
        "When I was young, I ___ swim.",
        [
          "could",
          "can",
          "would to",
          "coulds"
        ],
        0,
        "Past ability."
      ],
      [
        "I would ___ to go home.",
        [
          "like",
          "liked",
          "likes",
          "liking"
        ],
        0,
        "Would like."
      ],
      [
        "Could you ___ that?",
        [
          "repeat",
          "repeats",
          "repeating",
          "to repeat"
        ],
        0,
        "Could + V1."
      ],
      [
        "She ___ come if she had time.",
        [
          "would",
          "would to",
          "woulds",
          "is would"
        ],
        0,
        "Would + V1."
      ],
      [
        "I ___ not do that.",
        [
          "would",
          "would to",
          "am would",
          "woulds"
        ],
        0,
        "Would not."
      ]
    ],
    "blanks": [
      [
        "___ you help me, please?",
        [
          "could"
        ],
        "Could bilan muloyim so‘rov."
      ],
      [
        "I ___ like some tea.",
        [
          "would"
        ],
        "Would like."
      ],
      [
        "He could ___ fast. (run)",
        [
          "run"
        ],
        "Could + V1."
      ],
      [
        "Could I ___ a question? (ask)",
        [
          "ask"
        ],
        "Could + V1."
      ],
      [
        "Would you ___ to join us?",
        [
          "like"
        ],
        "Would like."
      ]
    ],
    "sentences": [
      [
        "Write one polite request with “Could”.",
        "modal",
        [
          "Could you help me?",
          "Could I ask a question?"
        ],
        "Could bilan muloyim savol yozing."
      ],
      [
        "Write one sentence with “would like”.",
        "modal",
        [
          "I would like some tea.",
          "She would like to join us."
        ],
        "would like ishlating."
      ],
      [
        "Write one sentence with past ability using “could”.",
        "modal",
        [
          "When I was young, I could swim fast.",
          "I could read when I was five."
        ],
        "could + V1 ishlating."
      ]
    ]
  },
  "FUTURE SIMPLE / TO BE GOING TO": {
    "choice": [
      [
        "I ___ call you tomorrow.",
        [
          "will",
          "will to",
          "am will",
          "will going"
        ],
        0,
        "Will + V1."
      ],
      [
        "She ___ going to study.",
        [
          "is",
          "are",
          "am",
          "will"
        ],
        0,
        "She is going to."
      ],
      [
        "They ___ going to travel.",
        [
          "are",
          "is",
          "am",
          "will"
        ],
        0,
        "They are going to."
      ],
      [
        "Look! It ___ rain.",
        [
          "is going to",
          "will to",
          "will going",
          "going"
        ],
        0,
        "Dalil bor — going to."
      ],
      [
        "I think it ___ be cold.",
        [
          "will",
          "is going",
          "will to",
          "going to"
        ],
        0,
        "Taxmin — will."
      ],
      [
        "We ___ start at 9.",
        [
          "are going to",
          "is going to",
          "will to",
          "going"
        ],
        0,
        "We are going to."
      ],
      [
        "He ___ not be late.",
        [
          "will",
          "is will",
          "will to",
          "going"
        ],
        0,
        "Will not."
      ],
      [
        "___ you help me?",
        [
          "Will",
          "Will to",
          "Are will",
          "Do will"
        ],
        0,
        "Will savol."
      ],
      [
        "She is going to ___ her grandmother.",
        [
          "visit",
          "visits",
          "visiting",
          "visited"
        ],
        0,
        "Going to + V1."
      ],
      [
        "I will ___ you later.",
        [
          "call",
          "calls",
          "calling",
          "called"
        ],
        0,
        "Will + V1."
      ]
    ],
    "blanks": [
      [
        "I ___ call you tomorrow.",
        [
          "will"
        ],
        "Will + V1."
      ],
      [
        "She ___ going to study.",
        [
          "is"
        ],
        "She is going to."
      ],
      [
        "They ___ going to travel.",
        [
          "are"
        ],
        "They are going to."
      ],
      [
        "Look! It ___ rain.",
        [
          "is going to"
        ],
        "Dalil bor."
      ],
      [
        "I think it ___ be cold.",
        [
          "will"
        ],
        "Taxmin."
      ],
      [
        "She is going to ___ her grandmother. (visit)",
        [
          "visit"
        ],
        "Going to + V1."
      ]
    ],
    "sentences": [
      [
        "Write one sentence with “will”.",
        "future_going_to",
        [
          "I will call you tomorrow.",
          "It will be cold."
        ],
        "will + V1 ishlating."
      ],
      [
        "Write one sentence with “going to”.",
        "future_going_to",
        [
          "She is going to study.",
          "We are going to start at 9."
        ],
        "am/is/are going to + V1."
      ],
      [
        "Write one future question.",
        "future_going_to",
        [
          "Will you help me?",
          "Are you going to study?"
        ],
        "Will yoki going to bilan savol yozing."
      ]
    ]
  }
};

// Requested update: selected topics get 10 multiple-choice tasks, inline blanks, and sentence-building tasks.
Object.assign(ESSENTIAL_STYLE_EXERCISE_PACKS, {
  "THERE IS / THERE ARE": {
    "choice": [
      [
        "There ___ a lamp on the desk.",
        [
          "is",
          "are",
          "am",
          "be"
        ],
        0,
        "A lamp birlik."
      ],
      [
        "There ___ two bags near the door.",
        [
          "are",
          "is",
          "am",
          "be"
        ],
        0,
        "Two bags ko‘plik."
      ],
      [
        "___ there a pharmacy near here?",
        [
          "Is",
          "Are",
          "Do",
          "Does"
        ],
        0,
        "A pharmacy birlik."
      ],
      [
        "___ there any students in the room?",
        [
          "Are",
          "Is",
          "Do",
          "Does"
        ],
        0,
        "Students ko‘plik."
      ],
      [
        "There ___ any sugar in the tea.",
        [
          "isn't",
          "aren't",
          "doesn't",
          "don't"
        ],
        0,
        "Sugar sanalmaydi, there isn't."
      ],
      [
        "There ___ many chairs in this room.",
        [
          "aren't",
          "isn't",
          "doesn't",
          "don't"
        ],
        0,
        "Many chairs ko‘plik."
      ],
      [
        "There ___ no water in the bottle.",
        [
          "is",
          "are",
          "am",
          "be"
        ],
        0,
        "Water sanalmaydi."
      ],
      [
        "There ___ no windows here.",
        [
          "are",
          "is",
          "am",
          "be"
        ],
        0,
        "Windows ko‘plik."
      ],
      [
        "Is there ___ book on the table?",
        [
          "a",
          "many",
          "are",
          "any chairs"
        ],
        0,
        "Book birlik."
      ],
      [
        "Are there ___ books in your bag?",
        [
          "any",
          "a",
          "an",
          "is"
        ],
        0,
        "Savolda ko‘plik: any books."
      ]
    ],
    "blanks": [
      [
        "There ___ a lamp on the desk.",
        [
          "is"
        ],
        ""
      ],
      [
        "There ___ two bags near the door.",
        [
          "are"
        ],
        ""
      ],
      [
        "___ there a pharmacy near here?",
        [
          "is"
        ],
        ""
      ],
      [
        "___ there any students in the room?",
        [
          "are"
        ],
        ""
      ],
      [
        "There ___ any sugar in the tea.",
        [
          "isn't",
          "is not",
          "isnt"
        ],
        ""
      ],
      [
        "There ___ many chairs in this room.",
        [
          "aren't",
          "are not",
          "arent"
        ],
        ""
      ],
      [
        "There ___ no water in the bottle.",
        [
          "is"
        ],
        ""
      ]
    ],
    "sentences": [
      [
        "Write one positive sentence with “There is”.",
        "there_is_are",
        [
          "There is a lamp on the desk.",
          "There is a book in my bag."
        ],
        "There is + birlik/sanalmaydigan ot bilan gap yozing."
      ],
      [
        "Write one positive sentence with “There are”.",
        "there_is_are",
        [
          "There are two bags near the door.",
          "There are many students in the room."
        ],
        "There are + ko‘plik ot bilan gap yozing."
      ],
      [
        "Write one question with Is there / Are there.",
        "there_is_are",
        [
          "Is there a pharmacy near here?",
          "Are there any students in the room?"
        ],
        "Savol shaklida Is there yoki Are there ishlating."
      ]
    ]
  },
  "HAVE / HAS": {
    "choice": [
      ["I ___ a small room.", ["have", "has"], 0, "I bilan have."],
      ["She ___ two brothers.", ["have", "has"], 1, "She bilan has."],
      ["We ___ English on Monday.", ["have", "has"], 0, "We bilan have."],
      ["He ___ a headache.", ["have", "has"], 1, "He bilan has."],
      ["They ___ a big classroom.", ["have", "has"], 0, "They bilan have."],
      ["My sister ___ a phone.", ["have", "has"], 1, "Sister = she."],
      ["You ___ a dictionary.", ["have", "has"], 0, "You bilan have."],
      ["Your brother ___ a bike.", ["have", "has"], 1, "Your brother = he."],
      ["The teacher ___ a laptop.", ["have", "has"], 1, "Teacher bitta odam: has."],
      ["Our class ___ ten students.", ["have", "has"], 1, "Class bitta guruh sifatida: has."]
    ],
    "blanks": [
      ["I ___ a small room.", ["have"], ""],
      ["She ___ two brothers.", ["has"], ""],
      ["We ___ English on Monday.", ["have"], ""],
      ["He ___ a headache.", ["has"], ""],
      ["They ___ new notebooks.", ["have"], ""],
      ["My brother ___ a bike.", ["has"], ""]
    ],
    "sentences": [
      ["Write one sentence with “have”.", "have_has", ["I have a small room.", "We have English on Monday."], "Gap ichida have so‘zi aniq bo‘lsin."],
      ["Write one sentence with “has”.", "have_has", ["She has two brothers.", "He has a headache."], "Gap ichida has so‘zi aniq bo‘lsin."],
      ["Write one sentence with “have”.", "have_has", ["They have a big classroom.", "You have a dictionary."], "I/you/we/they bilan have ishlating."],
      ["Write one sentence with “has”.", "have_has", ["My sister has a phone.", "The teacher has a laptop."], "He/she/it yoki bitta ism bilan has ishlating."]
    ]
  },
  "PREPOSITION OF PLACE": {
    "choice": [
      [
        "The keys are ___ my bag.",
        [
          "in",
          "on",
          "at",
          "between"
        ],
        0,
        "Bag ichida — in."
      ],
      [
        "The picture is ___ the wall.",
        [
          "on",
          "in",
          "under",
          "between"
        ],
        0,
        "Devorda — on."
      ],
      [
        "The cat is ___ the chair.",
        [
          "under",
          "on",
          "in",
          "at"
        ],
        0,
        "Stul ostida — under."
      ],
      [
        "The bank is ___ the school.",
        [
          "next to",
          "in",
          "on",
          "under"
        ],
        0,
        "Maktab yonida — next to."
      ],
      [
        "The bus stop is ___ the hotel.",
        [
          "in front of",
          "between",
          "under",
          "on"
        ],
        0,
        "Oldida — in front of."
      ],
      [
        "Ali is ___ two friends.",
        [
          "between",
          "under",
          "on",
          "in"
        ],
        0,
        "Ikkita do‘st orasida — between."
      ],
      [
        "The car is ___ the house. (orqasida)",
        [
          "behind",
          "in",
          "on",
          "between"
        ],
        0,
        "Orqasida — behind."
      ],
      [
        "The phone is ___ the table.",
        [
          "on",
          "in",
          "at",
          "under of"
        ],
        0,
        "Stol ustida — on."
      ],
      [
        "The students are ___ the classroom.",
        [
          "in",
          "on",
          "under",
          "next"
        ],
        0,
        "Sinfxona ichida — in."
      ],
      [
        "The teacher is ___ the board.",
        [
          "near",
          "in",
          "under",
          "between of"
        ],
        0,
        "Doska yonida/yaqinida — near."
      ]
    ],
    "blanks": [
      [
        "The keys are ___ my bag.",
        [
          "in"
        ],
        ""
      ],
      [
        "The picture is ___ the wall.",
        [
          "on"
        ],
        ""
      ],
      [
        "The cat is ___ the chair.",
        [
          "under"
        ],
        ""
      ],
      [
        "The bank is ___ the school.",
        [
          "next to",
          "near"
        ],
        ""
      ],
      [
        "The bus stop is ___ the hotel.",
        [
          "in front of"
        ],
        ""
      ],
      [
        "Ali is ___ two friends.",
        [
          "between"
        ],
        ""
      ],
      [
        "The car is ___ the house.",
        [
          "behind"
        ],
        ""
      ]
    ],
    "sentences": [
      [
        "Write one sentence with “in”.",
        "prep_place",
        [
          "The keys are in my bag.",
          "The students are in the classroom."
        ],
        "Joy predlogi in bilan gap yozing."
      ],
      [
        "Write one sentence with “on”.",
        "prep_place",
        [
          "The picture is on the wall.",
          "The phone is on the table."
        ],
        "Joy predlogi on bilan gap yozing."
      ],
      [
        "Write one sentence with under/behind/next to/between.",
        "prep_place",
        [
          "The cat is under the chair.",
          "The bank is next to the school."
        ],
        "Joyni aniq ko‘rsatuvchi predlogdan foydalaning."
      ]
    ]
  },
  "PREPOSITION OF TIME": {
    "choice": [
      [
        "I get up ___ seven o'clock.",
        [
          "at",
          "on",
          "in"
        ],
        0,
        "Aniq soat — at."
      ],
      [
        "The lesson is ___ Monday.",
        [
          "on",
          "in",
          "at"
        ],
        0,
        "Kun — on."
      ],
      [
        "We go to Tashkent ___ May.",
        [
          "in",
          "on",
          "at"
        ],
        0,
        "Oy — in."
      ],
      [
        "She was born ___ 2010.",
        [
          "in",
          "on",
          "at"
        ],
        0,
        "Yil — in."
      ],
      [
        "The test is ___ 15 May.",
        [
          "on",
          "in",
          "at"
        ],
        0,
        "Sana — on."
      ],
      [
        "I study ___ the morning.",
        [
          "in",
          "on",
          "at"
        ],
        0,
        "Kun qismi — in the morning."
      ],
      [
        "We have dinner ___ night.",
        [
          "at",
          "on",
          "in"
        ],
        0,
        "At night."
      ],
      [
        "The shop opens ___ 9:00.",
        [
          "at",
          "on",
          "in"
        ],
        0,
        "Soat — at."
      ],
      [
        "My birthday is ___ July.",
        [
          "in",
          "on",
          "at"
        ],
        0,
        "Oy — in."
      ],
      [
        "We don't work ___ Sunday.",
        [
          "on",
          "in",
          "at"
        ],
        0,
        "Kun — on."
      ]
    ],
    "blanks": [
      [
        "I get up ___ seven o'clock.",
        [
          "at"
        ],
        ""
      ],
      [
        "The lesson is ___ Monday.",
        [
          "on"
        ],
        ""
      ],
      [
        "We go to Tashkent ___ May.",
        [
          "in"
        ],
        ""
      ],
      [
        "She was born ___ 2010.",
        [
          "in"
        ],
        ""
      ],
      [
        "The test is ___ 15 May.",
        [
          "on"
        ],
        ""
      ],
      [
        "I study ___ the morning.",
        [
          "in"
        ],
        ""
      ],
      [
        "We have dinner ___ night.",
        [
          "at"
        ],
        ""
      ]
    ],
    "sentences": [
      [
        "Write one sentence with “at” for exact time.",
        "prep_time",
        [
          "I get up at seven o'clock.",
          "The shop opens at 9:00."
        ],
        "Aniq soat bilan at ishlating."
      ],
      [
        "Write one sentence with “on” for a day/date.",
        "prep_time",
        [
          "The lesson is on Monday.",
          "The test is on 15 May."
        ],
        "Kun yoki sana bilan on ishlating."
      ],
      [
        "Write one sentence with “in” for month/year/part of day.",
        "prep_time",
        [
          "We go to Tashkent in May.",
          "I study in the morning."
        ],
        "Oy/yil/kun qismi bilan in ishlating."
      ]
    ]
  },
  "PRESENT CONTINUOUS": {
    "choice": [
      [
        "I ___ now.",
        [
          "am studying",
          "study",
          "studies",
          "studied"
        ],
        0,
        "I am + V-ing."
      ],
      [
        "She ___ a blue jacket today.",
        [
          "is wearing",
          "wears",
          "wear",
          "are wearing"
        ],
        0,
        "She is + V-ing."
      ],
      [
        "They ___ in the yard at the moment.",
        [
          "are playing",
          "is playing",
          "play",
          "plays"
        ],
        0,
        "They are + V-ing."
      ],
      [
        "The phone ___ now.",
        [
          "is ringing",
          "rings",
          "ring",
          "are ringing"
        ],
        0,
        "Phone = it, is + V-ing."
      ],
      [
        "We ___ TV now.",
        [
          "are not watching",
          "do not watch",
          "does not watch",
          "not watch"
        ],
        0,
        "Now — Present Continuous."
      ],
      [
        "___ you listening to me?",
        [
          "Are",
          "Do",
          "Is",
          "Does"
        ],
        0,
        "You bilan Are."
      ],
      [
        "He ___ a message at the moment.",
        [
          "is writing",
          "writes",
          "write",
          "are writing"
        ],
        0,
        "He is + V-ing."
      ],
      [
        "It ___ raining now.",
        [
          "is",
          "are",
          "am",
          "do"
        ],
        0,
        "It is raining."
      ],
      [
        "My parents ___ working today.",
        [
          "are",
          "is",
          "am",
          "do"
        ],
        0,
        "Parents ko‘plik."
      ],
      [
        "Look! The boy ___.",
        [
          "is running",
          "runs",
          "run",
          "ran"
        ],
        0,
        "Look! — hozirgi harakat."
      ]
    ],
    "blanks": [
      [
        "I ___ now. (study)",
        [
          "am studying"
        ],
        ""
      ],
      [
        "She ___ a blue jacket today. (wear)",
        [
          "is wearing"
        ],
        ""
      ],
      [
        "They ___ in the yard at the moment. (play)",
        [
          "are playing"
        ],
        ""
      ],
      [
        "The phone ___ now. (ring)",
        [
          "is ringing"
        ],
        ""
      ],
      [
        "We ___ TV now. (not / watch)",
        [
          "are not watching",
          "aren't watching",
          "arent watching"
        ],
        ""
      ],
      [
        "___ you listening to me?",
        [
          "are"
        ],
        ""
      ],
      [
        "He ___ a message at the moment. (write)",
        [
          "is writing"
        ],
        ""
      ]
    ],
    "sentences": [
      [
        "Write one positive Present Continuous sentence.",
        "present_continuous",
        [
          "I am studying now.",
          "She is wearing a blue jacket today."
        ],
        "am/is/are + V-ing ishlating."
      ],
      [
        "Write one negative Present Continuous sentence.",
        "present_continuous",
        [
          "We are not watching TV.",
          "He is not sleeping."
        ],
        "am/is/are + not + V-ing ishlating."
      ],
      [
        "Write one Present Continuous question.",
        "present_continuous",
        [
          "Are you listening to me?",
          "Is she studying now?"
        ],
        "Am/Is/Are bilan savol yozing."
      ]
    ]
  },
  "PRESENT SIMPLE": {
    "choice": [
      [
        "Nurses ___ people.",
        [
          "help",
          "helps",
          "are helping",
          "helped"
        ],
        0,
        "Nurses ko‘plik, V1."
      ],
      [
        "My father ___ in a bank.",
        [
          "works",
          "work",
          "is working",
          "worked"
        ],
        0,
        "Father = he, works."
      ],
      [
        "We usually ___ lunch at one.",
        [
          "have",
          "has",
          "are having",
          "had"
        ],
        0,
        "Usually — Present Simple."
      ],
      [
        "The shop ___ at nine.",
        [
          "opens",
          "open",
          "is opening",
          "opened"
        ],
        0,
        "Shop birlik, opens."
      ],
      [
        "She ___ coffee.",
        [
          "doesn't drink",
          "don't drink",
          "isn't drink",
          "doesn't drinks"
        ],
        0,
        "She bilan doesn't + V1."
      ],
      [
        "___ your brother play football?",
        [
          "Does",
          "Do",
          "Is",
          "Are"
        ],
        0,
        "Brother = he, Does."
      ],
      [
        "They ___ to school by bus.",
        [
          "go",
          "goes",
          "are going",
          "went"
        ],
        0,
        "They bilan V1."
      ],
      [
        "He usually ___ his homework after dinner.",
        [
          "does",
          "do",
          "is doing",
          "did"
        ],
        0,
        "He bilan does."
      ],
      [
        "I ___ English every day.",
        [
          "study",
          "studies",
          "am studying",
          "studied"
        ],
        0,
        "I bilan V1."
      ],
      [
        "Water ___ at 100°C.",
        [
          "boils",
          "boil",
          "is boiling",
          "boiled"
        ],
        0,
        "Umumiy fakt — Present Simple."
      ]
    ],
    "blanks": [
      [
        "Nurses ___ people. (help)",
        [
          "help"
        ],
        ""
      ],
      [
        "My father ___ in a bank. (work)",
        [
          "works"
        ],
        ""
      ],
      [
        "We usually ___ lunch at one. (have)",
        [
          "have"
        ],
        ""
      ],
      [
        "The shop ___ at nine. (open)",
        [
          "opens"
        ],
        ""
      ],
      [
        "She ___ coffee. (not / drink)",
        [
          "does not drink",
          "doesn't drink",
          "doesnt drink"
        ],
        ""
      ],
      [
        "___ your brother play football?",
        [
          "does"
        ],
        ""
      ],
      [
        "They ___ to school by bus. (go)",
        [
          "go"
        ],
        ""
      ]
    ],
    "sentences": [
      [
        "Write one positive Present Simple sentence.",
        "present_simple",
        [
          "Nurses help people.",
          "My father works in a bank."
        ],
        "Odat/fakt haqida Present Simple gap yozing."
      ],
      [
        "Write one negative Present Simple sentence.",
        "present_simple",
        [
          "She doesn't drink coffee.",
          "They don't play tennis."
        ],
        "don't/doesn't + V1 ishlating."
      ],
      [
        "Write one Present Simple question.",
        "present_simple",
        [
          "Does your brother play football?",
          "Do you live near here?"
        ],
        "Do/Does bilan savol yozing."
      ]
    ]
  },
  "PRESENT SIMPLE & PRESENT CONTINUOUS": {
    "choice": [
      [
        "I usually ___ to school, but today I ___ a bus.",
        [
          "walk / am taking",
          "am walking / take",
          "walks / taking",
          "walk / take"
        ],
        0,
        "Usually = Simple; today = Continuous."
      ],
      [
        "She ___ in a shop, but she ___ today.",
        [
          "works / isn't working",
          "is working / doesn't work",
          "work / isn't work",
          "works / doesn't working"
        ],
        0,
        "Doimiy ish + bugungi vaqtinchalik holat."
      ],
      [
        "Look! It ___.",
        [
          "is raining",
          "rains",
          "rain",
          "rained"
        ],
        0,
        "Look! — hozirgi harakat."
      ],
      [
        "He ___ tennis very often.",
        [
          "doesn't play",
          "isn't playing",
          "don't play",
          "doesn't plays"
        ],
        0,
        "Very often — Present Simple."
      ],
      [
        "What ___ you ___ now?",
        [
          "are / doing",
          "do / do",
          "does / do",
          "are / do"
        ],
        0,
        "Now — Present Continuous."
      ],
      [
        "What time ___ the shop ___?",
        [
          "does / open",
          "is / opening",
          "do / opens",
          "does / opens"
        ],
        0,
        "Jadval/fakt — Present Simple."
      ],
      [
        "She ___ this word.",
        [
          "knows",
          "is knowing",
          "know",
          "are knowing"
        ],
        0,
        "Know odatda Simple."
      ],
      [
        "They ___ lunch at the moment.",
        [
          "are having",
          "have",
          "has",
          "had"
        ],
        0,
        "At the moment — Continuous."
      ],
      [
        "We ___ English on Mondays.",
        [
          "study",
          "are studying",
          "studies",
          "studied"
        ],
        0,
        "On Mondays — odat."
      ],
      [
        "Today he ___ from home.",
        [
          "is working",
          "works",
          "work",
          "worked"
        ],
        0,
        "Today bu yerda vaqtinchalik holat."
      ]
    ],
    "blanks": [
      [
        "I usually ___ to school, but today I ___ a bus. (walk / take)",
        [
          "walk am taking",
          "walk, am taking",
          "walk - am taking"
        ],
        ""
      ],
      [
        "She ___ in a shop, but she ___ today. (work / not work)",
        [
          "works is not working",
          "works, isn't working",
          "works isn't working",
          "works is not working"
        ],
        ""
      ],
      [
        "Look! It ___. (rain)",
        [
          "is raining"
        ],
        ""
      ],
      [
        "He ___ tennis very often. (not / play)",
        [
          "does not play",
          "doesn't play",
          "doesnt play"
        ],
        ""
      ],
      [
        "What ___ you ___ now? (do)",
        [
          "are doing",
          "are you doing"
        ],
        ""
      ],
      [
        "She ___ this word. (know)",
        [
          "knows"
        ],
        ""
      ]
    ],
    "sentences": [
      [
        "Write one Present Simple sentence about a habit.",
        "present_simple",
        [
          "I usually walk to school.",
          "We study English on Mondays."
        ],
        "Odat haqida Present Simple gap yozing."
      ],
      [
        "Write one Present Continuous sentence about now/today.",
        "present_continuous",
        [
          "I am taking a bus today.",
          "He is working from home today."
        ],
        "now/today bilan vaqtinchalik ish yozing."
      ],
      [
        "Write two short sentences: one habit + one action now.",
        "present_simple_vs_continuous",
        [
          "I usually walk, but today I am taking a bus.",
          "She works in a shop, but she isn't working today."
        ],
        "Simple va Continuous farqini bitta javobda ko‘rsating."
      ]
    ]
  },
  "PAST SIMPLE": {
    "choice": [
      [
        "I ___ a film yesterday.",
        [
          "watched",
          "watch",
          "watches",
          "watching"
        ],
        0,
        "Yesterday — Past Simple."
      ],
      [
        "She ___ to school by bus.",
        [
          "went",
          "go",
          "goes",
          "going"
        ],
        0,
        "Go → went."
      ],
      [
        "They ___ well last night.",
        [
          "didn't play",
          "don't play",
          "weren't play",
          "didn't played"
        ],
        0,
        "Didn't + V1."
      ],
      [
        "Did you ___ the match?",
        [
          "see",
          "saw",
          "seen",
          "seeing"
        ],
        0,
        "Did + V1."
      ],
      [
        "We ___ Samarkand last year.",
        [
          "visited",
          "visit",
          "visits",
          "are visiting"
        ],
        0,
        "Last year — Past Simple."
      ],
      [
        "He ___ a new phone two days ago.",
        [
          "bought",
          "buy",
          "buys",
          "buying"
        ],
        0,
        "Buy → bought."
      ],
      [
        "She ___ at home yesterday.",
        [
          "was",
          "were",
          "is",
          "be"
        ],
        0,
        "She bilan was."
      ],
      [
        "They ___ late.",
        [
          "were",
          "was",
          "are",
          "be"
        ],
        0,
        "They bilan were."
      ],
      [
        "I ___ my homework last evening.",
        [
          "did",
          "do",
          "does",
          "doing"
        ],
        0,
        "Do → did."
      ],
      [
        "Where ___ you go yesterday?",
        [
          "did",
          "do",
          "were",
          "are"
        ],
        0,
        "Past Simple savolida did."
      ]
    ],
    "blanks": [
      [
        "I ___ a film yesterday. (watch)",
        [
          "watched"
        ],
        ""
      ],
      [
        "She ___ to school by bus. (go)",
        [
          "went"
        ],
        ""
      ],
      [
        "They ___ well last night. (not / play)",
        [
          "did not play",
          "didn't play",
          "didnt play"
        ],
        ""
      ],
      [
        "Did you ___ the match? (see)",
        [
          "see"
        ],
        ""
      ],
      [
        "We ___ Samarkand last year. (visit)",
        [
          "visited"
        ],
        ""
      ],
      [
        "He ___ a new phone two days ago. (buy)",
        [
          "bought"
        ],
        ""
      ],
      [
        "She ___ at home yesterday. (be)",
        [
          "was"
        ],
        ""
      ]
    ],
    "sentences": [
      [
        "Write one positive Past Simple sentence.",
        "past_simple",
        [
          "I watched a film yesterday.",
          "She went to school by bus."
        ],
        "O‘tgan vaqtda tugagan ishni yozing."
      ],
      [
        "Write one negative Past Simple sentence.",
        "past_simple",
        [
          "They didn't play well.",
          "I didn't go to school yesterday."
        ],
        "didn't + V1 ishlating."
      ],
      [
        "Write one Past Simple question.",
        "past_simple",
        [
          "Did you see the match?",
          "Where did you go yesterday?"
        ],
        "Did + subject + V1? shaklida yozing."
      ]
    ]
  },
  "PAST CONTINUOUS": {
    "choice": [
      [
        "At 8 o'clock, I ___ my homework.",
        [
          "was doing",
          "did",
          "do",
          "am doing"
        ],
        0,
        "At 8 o'clock — davom etayotgan ish."
      ],
      [
        "When you called, I ___ dinner.",
        [
          "was cooking",
          "cooked",
          "cook",
          "am cooking"
        ],
        0,
        "When you called paytida davom etgan ish."
      ],
      [
        "We ___ home when it started to rain.",
        [
          "were walking",
          "walked",
          "walk",
          "are walking"
        ],
        0,
        "We bilan were + V-ing."
      ],
      [
        "She ___ sleeping at midnight.",
        [
          "wasn't",
          "weren't",
          "doesn't",
          "didn't"
        ],
        0,
        "She bilan wasn't."
      ],
      [
        "___ they watching TV?",
        [
          "Were",
          "Was",
          "Did",
          "Do"
        ],
        0,
        "They bilan Were."
      ],
      [
        "What ___ you doing yesterday evening?",
        [
          "were",
          "was",
          "did",
          "do"
        ],
        0,
        "You bilan were."
      ],
      [
        "He ___ reading when I came.",
        [
          "was",
          "were",
          "is",
          "did"
        ],
        0,
        "He bilan was."
      ],
      [
        "The children ___ playing outside.",
        [
          "were",
          "was",
          "are",
          "did"
        ],
        0,
        "Children ko‘plik."
      ],
      [
        "I wasn't ___ TV.",
        [
          "watching",
          "watch",
          "watched",
          "watches"
        ],
        0,
        "Wasn't + V-ing."
      ],
      [
        "They were ___ for the bus.",
        [
          "waiting",
          "wait",
          "waited",
          "waits"
        ],
        0,
        "Were + V-ing."
      ]
    ],
    "blanks": [
      [
        "At 8 o'clock, I ___ my homework. (do)",
        [
          "was doing"
        ],
        ""
      ],
      [
        "When you called, I ___ dinner. (cook)",
        [
          "was cooking"
        ],
        ""
      ],
      [
        "We ___ home when it started to rain. (walk)",
        [
          "were walking"
        ],
        ""
      ],
      [
        "She ___ sleeping at midnight. (not / be)",
        [
          "was not",
          "wasn't",
          "wasnt"
        ],
        ""
      ],
      [
        "___ they watching TV?",
        [
          "were"
        ],
        ""
      ],
      [
        "What ___ you doing yesterday evening?",
        [
          "were"
        ],
        ""
      ],
      [
        "He ___ reading when I came.",
        [
          "was"
        ],
        ""
      ]
    ],
    "sentences": [
      [
        "Write one positive Past Continuous sentence.",
        "past_continuous",
        [
          "I was doing my homework at 8 o'clock.",
          "We were walking home."
        ],
        "was/were + V-ing ishlating."
      ],
      [
        "Write one Past Continuous sentence with “when”.",
        "past_continuous",
        [
          "When you called, I was cooking dinner.",
          "We were walking home when it started to rain."
        ],
        "when bilan davomiy ishni ko‘rsating."
      ],
      [
        "Write one Past Continuous question.",
        "past_continuous",
        [
          "Were they watching TV?",
          "What were you doing yesterday evening?"
        ],
        "Was/Were bilan savol yozing."
      ]
    ]
  },
  "FUTURE SIMPLE / TO BE GOING TO": {
    "choice": [
      [
        "I ___ call you later.",
        [
          "will",
          "am",
          "going",
          "to"
        ],
        0,
        "Will + V1."
      ],
      [
        "She ___ going to buy a new phone.",
        [
          "is",
          "are",
          "am",
          "will"
        ],
        0,
        "She is going to."
      ],
      [
        "Look at the sky. It ___ rain.",
        [
          "is going to",
          "will to",
          "going",
          "are going to"
        ],
        0,
        "Belgi bor — going to."
      ],
      [
        "I think he ___ come tomorrow.",
        [
          "will",
          "is going",
          "does",
          "did"
        ],
        0,
        "I think — taxmin."
      ],
      [
        "We ___ going to stay long.",
        [
          "are not",
          "do not",
          "will not to",
          "not"
        ],
        0,
        "We are not going to."
      ],
      [
        "___ you help me?",
        [
          "Will",
          "Are",
          "Do",
          "Did"
        ],
        0,
        "Will savolda boshida."
      ],
      [
        "They are going to ___ football.",
        [
          "play",
          "plays",
          "playing",
          "played"
        ],
        0,
        "Going to + V1."
      ],
      [
        "He won't ___ late.",
        [
          "be",
          "is",
          "being",
          "was"
        ],
        0,
        "Won't + V1."
      ],
      [
        "Are you going to ___ tonight?",
        [
          "study",
          "studies",
          "studying",
          "studied"
        ],
        0,
        "Going to + V1."
      ],
      [
        "I ___ visit my uncle tomorrow.",
        [
          "am going to",
          "going",
          "will to",
          "am go to"
        ],
        0,
        "Reja — am going to."
      ]
    ],
    "blanks": [
      [
        "I ___ call you later.",
        [
          "will"
        ],
        ""
      ],
      [
        "She ___ going to buy a new phone.",
        [
          "is"
        ],
        ""
      ],
      [
        "Look at the sky. It ___ rain.",
        [
          "is going to"
        ],
        ""
      ],
      [
        "I think he ___ come tomorrow.",
        [
          "will"
        ],
        ""
      ],
      [
        "We ___ going to stay long.",
        [
          "are not",
          "aren't",
          "arent"
        ],
        ""
      ],
      [
        "___ you help me?",
        [
          "will"
        ],
        ""
      ],
      [
        "They are going to ___ football.",
        [
          "play"
        ],
        ""
      ]
    ],
    "sentences": [
      [
        "Write one future sentence with “will”.",
        "future_simple",
        [
          "I will call you later.",
          "I think he will come tomorrow."
        ],
        "will + V1 bilan gap yozing."
      ],
      [
        "Write one future sentence with “going to”.",
        "future_going_to",
        [
          "She is going to buy a new phone.",
          "I am going to visit my uncle tomorrow."
        ],
        "am/is/are going to + V1 bilan gap yozing."
      ],
      [
        "Write one future question.",
        "future_simple",
        [
          "Will you help me?",
          "Are you going to study tonight?"
        ],
        "Will yoki going to bilan savol yozing."
      ]
    ]
  },
  "PRESENT PERFECT": {
    "choice": [
      [
        "I ___ finished my homework.",
        [
          "have",
          "has",
          "am",
          "did"
        ],
        0,
        "I bilan have."
      ],
      [
        "She ___ visited Samarkand.",
        [
          "has",
          "have",
          "is",
          "did"
        ],
        0,
        "She bilan has."
      ],
      [
        "Have you ever ___ snow?",
        [
          "seen",
          "saw",
          "see",
          "seeing"
        ],
        0,
        "Have + V3."
      ],
      [
        "They ___ arrived yet.",
        [
          "haven't",
          "hasn't",
          "didn't",
          "aren't"
        ],
        0,
        "They bilan haven't."
      ],
      [
        "He has just ___ the door.",
        [
          "opened",
          "open",
          "opens",
          "opening"
        ],
        0,
        "Has + V3."
      ],
      [
        "We have never ___ this food.",
        [
          "eaten",
          "ate",
          "eat",
          "eating"
        ],
        0,
        "Have + V3."
      ],
      [
        "___ she finished the test?",
        [
          "Has",
          "Have",
          "Did",
          "Does"
        ],
        0,
        "She bilan Has."
      ],
      [
        "I have ___ my book.",
        [
          "lost",
          "lose",
          "loses",
          "losing"
        ],
        0,
        "Have + V3."
      ],
      [
        "He ___ been to London.",
        [
          "has",
          "have",
          "is",
          "did"
        ],
        0,
        "He bilan has."
      ],
      [
        "Have they ___ home?",
        [
          "gone",
          "went",
          "go",
          "going"
        ],
        0,
        "Have + V3: gone."
      ]
    ],
    "blanks": [
      [
        "I ___ finished my homework.",
        [
          "have"
        ],
        ""
      ],
      [
        "She ___ visited Samarkand.",
        [
          "has"
        ],
        ""
      ],
      [
        "Have you ever ___ snow? (see)",
        [
          "seen"
        ],
        ""
      ],
      [
        "They ___ arrived yet.",
        [
          "have not",
          "haven't",
          "havent"
        ],
        ""
      ],
      [
        "He has just ___ the door. (open)",
        [
          "opened"
        ],
        ""
      ],
      [
        "We have never ___ this food. (eat)",
        [
          "eaten"
        ],
        ""
      ],
      [
        "___ she finished the test?",
        [
          "has"
        ],
        ""
      ]
    ],
    "sentences": [
      [
        "Write one Present Perfect sentence with have.",
        "present_perfect",
        [
          "I have finished my homework.",
          "We have never eaten this food."
        ],
        "have + V3 bilan gap yozing."
      ],
      [
        "Write one Present Perfect sentence with has.",
        "present_perfect",
        [
          "She has visited Samarkand.",
          "He has just opened the door."
        ],
        "has + V3 bilan gap yozing."
      ],
      [
        "Write one Present Perfect question.",
        "present_perfect",
        [
          "Have you ever seen snow?",
          "Has she finished the test?"
        ],
        "Have/Has + subject + V3? shaklida yozing."
      ]
    ]
  },
  "PRESENT PERFECT INTRO": {
    "choice": [
      [
        "I ___ finished my homework.",
        [
          "have",
          "has",
          "am",
          "did"
        ],
        0,
        "I bilan have."
      ],
      [
        "She ___ visited Samarkand.",
        [
          "has",
          "have",
          "is",
          "did"
        ],
        0,
        "She bilan has."
      ],
      [
        "Have you ever ___ snow?",
        [
          "seen",
          "saw",
          "see",
          "seeing"
        ],
        0,
        "Have + V3."
      ],
      [
        "They ___ arrived yet.",
        [
          "haven't",
          "hasn't",
          "didn't",
          "aren't"
        ],
        0,
        "They bilan haven't."
      ],
      [
        "He has just ___ the door.",
        [
          "opened",
          "open",
          "opens",
          "opening"
        ],
        0,
        "Has + V3."
      ],
      [
        "We have never ___ this food.",
        [
          "eaten",
          "ate",
          "eat",
          "eating"
        ],
        0,
        "Have + V3."
      ],
      [
        "___ she finished the test?",
        [
          "Has",
          "Have",
          "Did",
          "Does"
        ],
        0,
        "She bilan Has."
      ],
      [
        "I have ___ my book.",
        [
          "lost",
          "lose",
          "loses",
          "losing"
        ],
        0,
        "Have + V3."
      ],
      [
        "He ___ been to London.",
        [
          "has",
          "have",
          "is",
          "did"
        ],
        0,
        "He bilan has."
      ],
      [
        "Have they ___ home?",
        [
          "gone",
          "went",
          "go",
          "going"
        ],
        0,
        "Have + V3: gone."
      ]
    ],
    "blanks": [
      [
        "I ___ finished my homework.",
        [
          "have"
        ],
        ""
      ],
      [
        "She ___ visited Samarkand.",
        [
          "has"
        ],
        ""
      ],
      [
        "Have you ever ___ snow? (see)",
        [
          "seen"
        ],
        ""
      ],
      [
        "They ___ arrived yet.",
        [
          "have not",
          "haven't",
          "havent"
        ],
        ""
      ],
      [
        "He has just ___ the door. (open)",
        [
          "opened"
        ],
        ""
      ],
      [
        "We have never ___ this food. (eat)",
        [
          "eaten"
        ],
        ""
      ],
      [
        "___ she finished the test?",
        [
          "has"
        ],
        ""
      ]
    ],
    "sentences": [
      [
        "Write one Present Perfect sentence with have.",
        "present_perfect",
        [
          "I have finished my homework.",
          "We have never eaten this food."
        ],
        "have + V3 bilan gap yozing."
      ],
      [
        "Write one Present Perfect sentence with has.",
        "present_perfect",
        [
          "She has visited Samarkand.",
          "He has just opened the door."
        ],
        "has + V3 bilan gap yozing."
      ],
      [
        "Write one Present Perfect question.",
        "present_perfect",
        [
          "Have you ever seen snow?",
          "Has she finished the test?"
        ],
        "Have/Has + subject + V3? shaklida yozing."
      ]
    ]
  }
});




// Beginner 15-mavzu: Comparative Adjectives.
Object.assign(ESSENTIAL_STYLE_ENGLISH_PROFILES, {
  "COMPARATIVE ADJECTIVES": {
    "concept": "Comparative Adjectives",
    "core": "Comparative adjectives ikki odam, hayvon yoki narsani solishtirish uchun ishlatiladi. O‘zbekchada ko‘pincha “-roq” yoki “...dan ...roq” ma’nosini beradi.",
    "structure": "Qisqa sifat: adjective + -er + than. Masalan: taller than, faster than. Uzun sifat: more + adjective + than. Masalan: more interesting than. Irregular: good → better, bad → worse.",
    "usage": "Bo‘y, yosh, narx, tezlik, qiyinlik, qiziqarlilik kabi farqlarni aytishda ishlatiladi.",
    "nuance": "Big, hot kabi CVC so‘zlarda oxirgi harf ikki marta yoziladi: bigger, hotter. Easy, happy kabi y bilan tugagan so‘zlarda y → ier: easier, happier.",
    "mistakes": "more taller demang. To‘g‘risi: taller. beautifuler demang. To‘g‘risi: more beautiful. gooder demang. To‘g‘risi: better.",
    "examples": [
      "Ali is taller than Tom. / Ali Tomdan balandroq.",
      "This bag is cheaper than that bag. / Bu sumka u sumkadan arzonroq.",
      "English is more interesting than Math. / Ingliz tili matematikadan qiziqarliroq.",
      "Today is hotter than yesterday. / Bugun kechagidan issiqroq.",
      "My room is bigger than yours. / Mening xonam siznikidan kattaroq.",
      "His result is better than mine. / Uning natijasi menikidan yaxshiroq."
    ],
    "terms": [
      ["comparative", "solishtirma daraja", "taller than"],
      ["than", "...dan", "bigger than"],
      ["-er", "qisqa sifatlarga qo‘shiladi", "fast → faster"],
      ["more", "uzun sifatlardan oldin keladi", "more beautiful"],
      ["better", "good so‘zining comparative shakli", "better than"],
      ["worse", "bad so‘zining comparative shakli", "worse than"]
    ],
    "checks": [
      ["Ali is ___ than Tom.", ["taller", "tall", "more tall", "tallest"], 0, "Short adjective: tall → taller."],
      ["This book is ___ interesting than that book.", ["more", "most", "many", "much"], 0, "Long adjective: more interesting than."],
      ["Good → ___", ["better", "gooder", "more good", "best"], 0, "Good ning comparative shakli better."]
    ]
  }
});

// PRESENT SIMPLE workbook exercises update V74.
Object.assign(ESSENTIAL_STYLE_EXERCISE_PACKS, {
  "PRESENT SIMPLE": {
    "choice": [
      ["I ___ to school every day.", ["go", "goes", "am going", "went"], 0, "I bilan V1 ishlatiladi."],
      ["He ___ to school every day.", ["goes", "go", "going", "is go"], 0, "He bilan darak gapda -s/-es qo‘shiladi."],
      ["You ___ at the hospital.", ["work", "works", "are working", "worked"], 0, "You bilan V1."],
      ["My mother ___ at the hospital.", ["works", "work", "is working", "worked"], 0, "My mother = she, works."],
      ["The shop ___ at nine.", ["opens", "open", "is opening", "opened"], 0, "Jadval/fakt uchun Present Simple."],
      ["She ___ TV in the evening.", ["watches", "watch", "watchs", "watching"], 0, "watch → watches."],
      ["I ___ like coffee.", ["don't", "doesn't", "am not", "isn't"], 0, "I bilan don't + V1."],
      ["Tom ___ work at school.", ["doesn't", "don't", "isn't", "aren't"], 0, "Tom = he, doesn't + V1."],
      ["___ you speak English?", ["Do", "Does", "Are", "Is"], 0, "You bilan Do."],
      ["___ she speak English?", ["Does", "Do", "Is", "Are"], 0, "She bilan Does."]
    ],
    "blanks": [
      ["I ___ to school every day. (go)", ["go"], ""],
      ["He ___ to school every day. (go)", ["goes"], ""],
      ["You ___ at the hospital. (work)", ["work"], ""],
      ["My mother ___ at the hospital. (work)", ["works"], ""],
      ["The shop ___ at nine. (open)", ["opens"], ""],
      ["She ___ TV in the evening. (watch)", ["watches"], ""],
      ["I ___ like coffee. (not)", ["do not", "don't", "dont"], ""],
      ["Tom ___ work at school. (not)", ["does not", "doesn't", "doesnt"], ""],
      ["___ you speak English?", ["do"], ""],
      ["___ she speak English?", ["does"], ""]
    ],
    "sentences": [
      ["Write one positive Present Simple sentence with I/you/we/they.", "present_simple", ["I go to school every day.", "We study English."], "I/you/we/they + V1 ishlating."],
      ["Write one negative Present Simple sentence with I/you/we/they.", "present_simple", ["I do not like coffee.", "They do not play tennis."], "I/you/we/they + do not + V1 ishlating."],
      ["Write one Present Simple question with Do and I/you/we/they.", "present_simple", ["Do you speak English?", "Do they play football?"], "Do + I/you/we/they + V1?"],
      ["Write one positive Present Simple sentence with he/she/it.", "present_simple", ["She works at the hospital.", "He goes to school every day."], "He/she/it + V-s/es ishlating."],
      ["Write one negative Present Simple sentence with he/she/it.", "present_simple", ["She does not drink coffee.", "He does not play tennis."], "He/she/it + does not + V1 ishlating."],
      ["Write one Present Simple question with Does and he/she/it.", "present_simple", ["Does she speak English?", "Does he work here?"], "Does + he/she/it + V1?"],
      ["Write one sentence using “usually” with Present Simple.", "present_simple", ["I usually read books.", "She usually gets up early."], "usually bilan Present Simple gap yozing."],
      ["Write one sentence using “every day” with Present Simple.", "present_simple", ["We study every day.", "He walks every day."], "every day bilan odatni yozing."]
    ]
  }
});



// PREPOSITION OF PLACE and PREPOSITION OF TIME workbook exercises update V75.
Object.assign(ESSENTIAL_STYLE_EXERCISE_PACKS, {
  "PREPOSITION OF PLACE": {
    "choice": [
      [
        "The rabbit is ___ the hat.",
        [
          "in",
          "on",
          "under",
          "behind"
        ],
        0,
        "Ichida — in."
      ],
      [
        "The book is ___ the table.",
        [
          "on",
          "in",
          "under",
          "between"
        ],
        0,
        "Stol ustida — on."
      ],
      [
        "The ball is ___ the chair.",
        [
          "under",
          "on",
          "in",
          "next to"
        ],
        0,
        "Stul ostida — under."
      ],
      [
        "The boy is ___ the door.",
        [
          "behind",
          "on",
          "in",
          "between"
        ],
        0,
        "Eshik orqasida — behind."
      ],
      [
        "The girl is ___ the window.",
        [
          "next to",
          "under",
          "in",
          "behind"
        ],
        0,
        "Yonida — next to."
      ],
      [
        "The school is ___ the bank and the shop.",
        [
          "between",
          "behind",
          "under",
          "on"
        ],
        0,
        "Ikki joy orasida — between."
      ],
      [
        "The car is ___ the house.",
        [
          "in front of",
          "between",
          "under",
          "in"
        ],
        0,
        "Uy oldida — in front of."
      ],
      [
        "The picture is ___ the wall.",
        [
          "on",
          "in",
          "under",
          "between"
        ],
        0,
        "Devorda/yuzada — on."
      ],
      [
        "The keys are ___ my bag.",
        [
          "in",
          "on",
          "behind",
          "between"
        ],
        0,
        "Sumka ichida — in."
      ],
      [
        "The cat is ___ the bed.",
        [
          "under",
          "on",
          "between",
          "behind"
        ],
        0,
        "Karavot ostida — under."
      ]
    ],
    "blanks": [
      [
        "The rabbit is ___ the hat.",
        [
          "in"
        ],
        ""
      ],
      [
        "The book is ___ the table.",
        [
          "on"
        ],
        ""
      ],
      [
        "The ball is ___ the chair.",
        [
          "under"
        ],
        ""
      ],
      [
        "The boy is ___ the door.",
        [
          "behind"
        ],
        ""
      ],
      [
        "The girl is ___ the window.",
        [
          "next to"
        ],
        ""
      ],
      [
        "The school is ___ the bank and the shop.",
        [
          "between"
        ],
        ""
      ],
      [
        "The car is ___ the house.",
        [
          "in front of"
        ],
        ""
      ],
      [
        "The picture is ___ the wall.",
        [
          "on"
        ],
        ""
      ],
      [
        "The keys are ___ my bag.",
        [
          "in"
        ],
        ""
      ],
      [
        "The cat is ___ the bed.",
        [
          "under"
        ],
        ""
      ]
    ],
    "sentences": [
      [
        "Write one sentence with “in”.",
        "preposition_place",
        [
          "The phone is in the bag.",
          "The rabbit is in the hat."
        ],
        "in = ichida ma’nosida gap yozing."
      ],
      [
        "Write one sentence with “on”.",
        "preposition_place",
        [
          "The book is on the table.",
          "The picture is on the wall."
        ],
        "on = ustida/yuzasida ma’nosida gap yozing."
      ],
      [
        "Write one sentence with “under”.",
        "preposition_place",
        [
          "The ball is under the chair.",
          "The cat is under the bed."
        ],
        "under = ostida ma’nosida gap yozing."
      ],
      [
        "Write one sentence with “behind” or “next to”.",
        "preposition_place",
        [
          "The boy is behind the door.",
          "Ali is next to me."
        ],
        "behind yoki next to ishlating."
      ],
      [
        "Write one sentence with “between” or “in front of”.",
        "preposition_place",
        [
          "The school is between the bank and the shop.",
          "The car is in front of the house."
        ],
        "between yoki in front of ishlating."
      ]
    ]
  },
  "PREPOSITION OF TIME": {
    "choice": [
      ["The lesson starts ___ 9 o’clock.", ["at", "on", "in"], 0, "Aniq soat — at."],
      ["I get up ___ seven.", ["at", "on", "in"], 0, "Aniq soat — at."],
      ["We have English ___ Monday.", ["on", "in", "at"], 0, "Hafta kuni — on."],
      ["The test is ___ 15 May.", ["on", "in", "at"], 0, "Sana — on."],
      ["My birthday is ___ June.", ["in", "on", "at"], 0, "Oy — in."],
      ["She was born ___ 2010.", ["in", "on", "at"], 0, "Yil — in."],
      ["I study ___ the morning.", ["in", "on", "at"], 0, "in the morning."],
      ["We sleep ___ night.", ["at", "on", "in"], 0, "at night."],
      ["The movie starts ___ 8:00.", ["at", "on", "in"], 0, "Aniq soat — at."],
      ["We have a break ___ noon.", ["at", "on", "in"], 0, "Noon aniq vaqt nuqtasi — at."]
    ],
    "blanks": [
      ["The lesson starts ___ 9 o’clock.", ["at"], ""],
      ["I get up ___ seven.", ["at"], ""],
      ["We have English ___ Monday.", ["on"], ""],
      ["The test is ___ 15 May.", ["on"], ""],
      ["My birthday is ___ June.", ["in"], ""],
      ["She was born ___ 2010.", ["in"], ""],
      ["I study ___ the morning.", ["in"], ""],
      ["We sleep ___ night.", ["at"], ""],
      ["The movie starts ___ 8:00.", ["at"], ""],
      ["We have a break ___ noon.", ["at"], ""]
    ],
    "sentences": [
      ["Write one sentence with “at”.", "preposition_time", ["The lesson starts at 9 o’clock.", "I get up at seven."], "at + aniq vaqt bilan gap yozing."],
      ["Write one sentence with “on”.", "preposition_time", ["We have English on Monday.", "The test is on 15 May."], "on + kun yoki sana bilan gap yozing."],
      ["Write one sentence with “in”.", "preposition_time", ["My birthday is in June.", "She was born in 2010."], "in + oy/yil/fasl/kun qismi bilan gap yozing."],
      ["Write one sentence with “at night”.", "preposition_time", ["I sleep at night.", "We study at night."], "at night bilan gap yozing."],
      ["Write one sentence with “at noon”.", "preposition_time", ["We have a break at noon.", "I eat lunch at noon."], "Aniq vaqt nuqtasi uchun at ishlating."]
    ]
  }
});



// Beginner 15-mavzu Comparative Adjectives mashqlari.
Object.assign(ESSENTIAL_STYLE_EXERCISE_PACKS, {
  "COMPARATIVE ADJECTIVES": {
    "choice": [
      ["Ali is ___ than Bekzod.", ["taller", "tall", "tallest", "more tall"], 0, "Short adjective: tall → taller."],
      ["This bag is ___ than that bag.", ["cheaper", "cheap", "cheapest", "more cheap"], 0, "Cheap qisqa sifat, cheaper bo‘ladi."],
      ["Math is ___ than English.", ["more difficult", "difficult", "difficulter", "most difficult"], 0, "Difficult uzun sifat: more difficult."],
      ["My brother is ___ than me.", ["younger", "young", "youngest", "more young"], 0, "Young → younger."],
      ["Today is ___ than yesterday.", ["hotter", "hot", "hottest", "more hot"], 0, "Hot → hotter, oxirgi harf ikki marta yoziladi."],
      ["This movie is ___ than the last one.", ["more interesting", "interesting", "interestinger", "most interesting"], 0, "Interesting uzun sifat: more interesting."],
      ["A cheetah is ___ than a lion.", ["faster", "fast", "fastest", "more fast"], 0, "Fast → faster."],
      ["My house is ___ than yours.", ["bigger", "big", "biggest", "more big"], 0, "Big → bigger."],
      ["This question is ___ than that one.", ["easier", "easy", "easiest", "more easy"], 0, "Easy → easier."],
      ["His result is ___ than mine.", ["better", "good", "best", "gooder"], 0, "Good → better."]
    ],
    "blanks": [
      ["Ali is ___ than Tom. (tall)", ["taller"], "Tall qisqa sifat: taller."],
      ["This car is ___ than that car. (fast)", ["faster"], "Fast → faster."],
      ["English is ___ than History. (interesting)", ["more interesting"], "Interesting uzun sifat: more interesting."],
      ["My room is ___ than yours. (big)", ["bigger"], "Big → bigger."],
      ["Today is ___ than yesterday. (hot)", ["hotter"], "Hot → hotter."],
      ["This exercise is ___ than that exercise. (easy)", ["easier"], "Easy → easier."],
      ["This phone is ___ than my phone. (expensive)", ["more expensive"], "Expensive uzun sifat: more expensive."],
      ["Her answer is ___ than mine. (good)", ["better"], "Good → better."],
      ["This road is ___ than that road. (bad)", ["worse"], "Bad → worse."],
      ["The box is ___ than the bag. (heavy)", ["heavier"], "Heavy → heavier."
      ]
    ],
    "sentences": [
      ["Ali / tall / Tom", "comparative", ["Ali is taller than Tom."], "Subject + be + comparative + than + noun."],
      ["My car / fast / your car", "comparative", ["My car is faster than your car."], "Fast → faster than."],
      ["English / interesting / Math", "comparative", ["English is more interesting than Math."], "Long adjective: more interesting than."],
      ["Today / hot / yesterday", "comparative", ["Today is hotter than yesterday."], "Hot → hotter than."],
      ["This book / cheap / that book", "comparative", ["This book is cheaper than that book."], "Cheap → cheaper than."],
      ["My room / big / your room", "comparative", ["My room is bigger than your room."], "Big → bigger than."],
      ["This test / easy / that test", "comparative", ["This test is easier than that test."], "Easy → easier than."],
      ["His result / good / my result", "comparative", ["His result is better than my result."], "Good → better than."]
    ]
  }
});

function workbookExerciseKey(language, title = '') {
  if (language !== 'english') return '';
  const key = normalizeTopicName(title);
  return ESSENTIAL_STYLE_EXERCISE_PACKS[key] ? key : '';
}

function isThreePartWorkbookTopic(language, title = '') {
  // Ingliz tili mavzularining hammasi oldingi darajalardagidek 3 qismli bo'ladi:
  // 1-mashq: 10 ta test, 2-mashq: 8 ta yozish, 3-mashq: 7 ta gap tuzish.
  if (language === 'english') return true;
  return Boolean(workbookExerciseKey(language, title));
}

function getWorkbookExercisePack(language, title) {
  const key = workbookExerciseKey(language, title);
  return key ? ESSENTIAL_STYLE_EXERCISE_PACKS[key] : null;
}

function buildWorkbookStyleChoiceQuestions(language, title) {
  const key = normalizeTopicName(title);

  // A / AN mavzusida tanlov faqat “a” yoki “an” bo‘ladi.
  // “the”, “one” yoki boshqa article variantlari bu mavzudan olib tashlandi.
  if (language === 'english' && key === 'A / AN') {
    const articleOnlyChoice = [
      ['___ apple', ['a', 'an'], 1, 'Apple unli tovush bilan boshlanadi: an apple.'],
      ['___ dog', ['a', 'an'], 0, 'Dog undosh tovush bilan boshlanadi: a dog.'],
      ['___ elephant', ['a', 'an'], 1, 'Elephant unli tovush bilan boshlanadi: an elephant.'],
      ['___ book', ['a', 'an'], 0, 'Book undosh tovush bilan boshlanadi: a book.'],
      ['___ orange', ['a', 'an'], 1, 'Orange unli tovush bilan boshlanadi: an orange.'],
      ['___ pen', ['a', 'an'], 0, 'Pen undosh tovush bilan boshlanadi: a pen.'],
      ['___ umbrella', ['a', 'an'], 1, 'Umbrella unli tovush bilan boshlanadi: an umbrella.'],
      ['___ teacher', ['a', 'an'], 0, 'Teacher undosh tovush bilan boshlanadi: a teacher.'],
      ['___ hour', ['a', 'an'], 1, 'Hour so‘zida h talaffuz qilinmaydi: an hour.'],
      ['___ university', ['a', 'an'], 0, 'University /juː/ tovushi bilan boshlanadi: a university.']
    ];
    return articleOnlyChoice.map((item, index) => {
      const packed = forceCorrectAnswerA(item[1], Number(item[2] || 0), index + 11);
      return {
        id: `wbq${index + 1}`,
        question: item[0],
        options: packed.options,
        correctIndex: packed.correctIndex,
        note: item[3]
      };
    });
  }

  const pack = getWorkbookExercisePack(language, title);
  return (pack?.choice || []).map((item, index) => {
    const packed = forceCorrectAnswerA(item[1], Number(item[2] || 0), index + 11);
    return {
      id: `wbq${index + 1}`,
      question: item[0],
      options: packed.options,
      correctIndex: packed.correctIndex,
      note: item[3] || 'Workbook uslubidagi grammatika mashqi.'
    };
  });
}

// 1-mashqdagi tanlov savollari va 2-mashqdagi yozma gaplar bir xil bo‘lib qolmasligi uchun
// yozma bo‘sh joy topshiriqlari alohida misollar bilan beriladi.
const DIFFERENT_WORKBOOK_BLANKS = {
  'ALFABIT': [
    ['Write the number of English letters: ___.', ['26'], 'English alphabet 26 ta harfdan iborat.'],
    ['A, E, I, O, U are called ___.', ['vowels'], 'A, E, I, O, U — vowels.'],
    ['B, C, D are called ___.', ['consonants'], 'B, C, D — consonants.'],
    ['Big A is a ___ letter.', ['capital'], 'Bosh harf — capital letter.'],
    ['Small b is a ___ letter.', ['small', 'lowercase'], 'Kichik harf — small/lowercase letter.'],
    ['Alphabet starts with ___.', ['A', 'a'], 'Alphabet A bilan boshlanadi.'],
    ['Alphabet finishes with ___.', ['Z', 'z'], 'Alphabet Z bilan tugaydi.'],
    ['A sentence is made of ___.', ['words'], 'Gap so‘zlardan tuziladi.'],
    ['Every English word uses ___.', ['letters'], 'So‘z harflardan tuziladi.'],
    ['Say the word letter by letter means ___.', ['spell', 'spelling'], 'Spell — harflab aytmoq.']
  ],
  'A / AN': [
    ['I have ___ apple.', ['an'], 'Apple unli tovush bilan boshlanadi.'],
    ['This is ___ cat.', ['a'], 'Cat undosh tovush bilan boshlanadi.'],
    ['She has ___ umbrella.', ['an'], 'Umbrella unli tovush bilan boshlanadi.'],
    ['He is ___ doctor.', ['a'], 'Doctor undosh tovush bilan boshlanadi.'],
    ['It is ___ orange.', ['an'], 'Orange unli tovush bilan boshlanadi.'],
    ['There is ___ bird in the tree.', ['a'], 'Bird undosh tovush bilan boshlanadi.'],
    ['My father is ___ engineer.', ['an'], 'Engineer unli tovush bilan boshlanadi.'],
    ['This is ___ blue pen.', ['a'], 'Blue undosh tovush bilan boshlanadi.'],
    ['We waited for ___ hour.', ['an'], 'Hour so‘zida h talaffuz qilinmaydi.'],
    ['Ali studies at ___ university.', ['a'], 'University /juː/ tovushi bilan boshlanadi.']
  ],
  'PLURALS (REGULAR)': [
    ['I have three ___. (book)', ['books'], 'Bu joyga book so‘zining ko‘plik shakli yoziladi.'],
    ['There are five ___. (car)', ['cars'], 'Bu joyga car so‘zining ko‘plik shakli yoziladi.'],
    ['My bag has two ___. (pen)', ['pens'], 'Bu joyga pen so‘zining ko‘plik shakli yoziladi.'],
    ['The shop has many ___. (box)', ['boxes'], 'Bu joyga box so‘zining ko‘plik shakli yoziladi.'],
    ['Two ___ are crying. (baby)', ['babies'], 'Bu joyga baby so‘zining ko‘plik shakli yoziladi.'],
    ['Big ___ are beautiful. (city)', ['cities'], 'Bu joyga city so‘zining ko‘plik shakli yoziladi.'],
    ['I can see four ___. (bus)', ['buses'], 'Bu joyga bus so‘zining ko‘plik shakli yoziladi.'],
    ['The children have three ___. (toy)', ['toys'], 'Bu joyga toy so‘zining ko‘plik shakli yoziladi.'],
    ['There are two ___ on the wall. (watch)', ['watches'], 'Bu joyga watch so‘zining ko‘plik shakli yoziladi.'],
    ['Many ___ study here. (student)', ['students'], 'Bu joyga student so‘zining ko‘plik shakli yoziladi.']
  ],
  'PLURAL (IRREGULAR)': [
    ['Two ___ are in the classroom. (child)', ['children'], 'Bu joyga child so‘zining maxsus ko‘plik shakli yoziladi.'],
    ['Three ___ are waiting outside. (man)', ['men'], 'Bu joyga man so‘zining maxsus ko‘plik shakli yoziladi.'],
    ['Two ___ are speaking English. (woman)', ['women'], 'Bu joyga woman so‘zining maxsus ko‘plik shakli yoziladi.'],
    ['Many ___ live in this city. (person)', ['people'], 'Bu joyga person so‘zining maxsus ko‘plik shakli yoziladi.'],
    ['My ___ are cold. (foot)', ['feet'], 'Bu joyga foot so‘zining maxsus ko‘plik shakli yoziladi.'],
    ['Brush your ___ every day. (tooth)', ['teeth'], 'Bu joyga tooth so‘zining maxsus ko‘plik shakli yoziladi.'],
    ['The ___ are very small. (mouse)', ['mice'], 'Bu joyga mouse so‘zining maxsus ko‘plik shakli yoziladi.'],
    ['Several ___ are near the lake. (goose)', ['geese'], 'Bu joyga goose so‘zining maxsus ko‘plik shakli yoziladi.'],
    ['Two ___ are in the field. (sheep)', ['sheep'], 'Bu so‘z birlikda ham ko‘plikda ham bir xil yoziladi.'],
    ['Five ___ are swimming. (fish)', ['fish'], 'Bu so‘z ko‘pincha birlikda ham ko‘plikda ham bir xil yoziladi.']
  ],
  'SUBJECT PRONOUN': [
    ['Ali is my friend. ___ is kind.', ['He'], 'Ali erkak ism, shuning uchun he.'],
    ['Madina is my sister. ___ is clever.', ['She'], 'Madina ayol ism, shuning uchun she.'],
    ['The phone is new. ___ is expensive.', ['It'], 'Narsa uchun it ishlatiladi.'],
    ['My parents are at home. ___ are happy.', ['They'], 'Parents ko‘plik, shuning uchun they.'],
    ['My brother and I are students. ___ are students.', ['We'], 'I + another person = we.'],
    ['Aziza and Malika are friends. ___ are friends.', ['They'], 'Ikki kishi = they.'],
    ['___ am ready for the lesson.', ['I'], 'Am faqat I bilan keladi.'],
    ['The dog is under the chair. ___ is sleeping.', ['It'], 'Hayvon haqida umumiy gapda it.'],
    ['You and your brother are here. ___ are here.', ['You'], 'You birlik va ko‘plikda ham you.'],
    ['My mother is a doctor. ___ works at a hospital.', ['She'], 'Mother ayol, shuning uchun she.']
  ],
  'TO BE': [
    ['My name ___ Ali.', ['is'], 'Name birlik, shuning uchun is.'],
    ['I ___ twelve years old.', ['am'], 'I bilan am ishlatiladi.'],
    ['They ___ classmates.', ['are'], 'They bilan are ishlatiladi.'],
    ['My sister ___ not tired.', ['is'], 'My sister birlik, shuning uchun is not.'],
    ['We ___ ready for the lesson.', ['are'], 'We bilan are ishlatiladi.'],
    ['___ you happy today?', ['Are'], 'Savolda are gap boshiga chiqadi.'],
    ['He ___ a good student.', ['is'], 'He bilan is ishlatiladi.'],
    ['I ___ not late.', ['am'], 'I bilan am not ishlatiladi.'],
    ['The classroom ___ clean.', ['is'], 'Classroom birlik, shuning uchun is.'],
    ['You ___ my best friend.', ['are'], 'You bilan are ishlatiladi.']
  ],
  'THERE IS / THERE ARE': [
    ['There ___ a computer in the room.', ['is'], 'A computer birlik.'],
    ['There ___ five chairs near the table.', ['are'], 'Five chairs ko‘plik.'],
    ['___ there a park near your house?', ['Is'], 'A park birlik.'],
    ['___ there any books in your bag?', ['Are'], 'Books ko‘plik.'],
    ['There ___ not a TV in my room.', ['is'], 'A TV birlik, inkor: is not.'],
    ['There ___ not any students in the hall.', ['are'], 'Students ko‘plik, inkor: are not.'],
    ['There ___ some water in the bottle.', ['is'], 'Water uncountable, there is.'],
    ['There ___ two windows in our class.', ['are'], 'Two windows ko‘plik.'],
    ['___ there any milk in the fridge?', ['Is'], 'Milk uncountable, Is there.'],
    ['There ___ a picture on the wall.', ['is'], 'A picture birlik.']
  ],
  'HAVE / HAS': [
    ['I ___ a new notebook.', ['have'], 'I bilan have.'],
    ['My brother ___ a bicycle.', ['has'], 'My brother = he, shuning uchun has.'],
    ['They ___ English books.', ['have'], 'They bilan have.'],
    ['She ___ a red bag.', ['has'], 'She bilan has.'],
    ['We ___ a test today.', ['have'], 'We bilan have.'],
    ['Ali ___ a phone.', ['has'], 'Ali = he, shuning uchun has.'],
    ['My parents ___ a car.', ['have'], 'Parents ko‘plik, have.'],
    ['The cat ___ green eyes.', ['has'], 'Cat = it, shuning uchun has.'],
    ['The school ___ a big library.', ['has'], 'The school bitta tashkilot, has.'],
    ['You ___ time.', ['have'], 'You bilan have.']
  ],
  'CAN / CAN’T': [
    ['I ___ swim very well.', ['can'], 'Qobiliyat uchun can.'],
    ['She ___ speak Korean.', ['can'], 'Can barcha shaxslar bilan bir xil.'],
    ['We ___ not use phones here.', ['can'], 'Inkor: can not / cannot.'],
    ['___ you help me?', ['Can'], 'Savolda Can gap boshiga chiqadi.'],
    ['He can ___ fast.', ['run'], 'Can dan keyin V1.'],
    ['They can ___ football.', ['play'], 'Can dan keyin asosiy fe’l.'],
    ['My little brother ___ read English yet.', ["can't", 'cannot'], 'Qila olmaslik: can’t / cannot.'],
    ['Can she ___ a bike?', ['ride'], 'Can dan keyin V1.'],
    ['You ___ sit here.', ['can'], 'Ruxsat ma’nosida can.'],
    ['Birds ___ fly.', ['can'], 'Qobiliyat: can fly.']
  ],
  'CAN / CAN\'T': [
    ['I ___ swim very well.', ['can'], 'Qobiliyat uchun can.'],
    ['She ___ speak Korean.', ['can'], 'Can barcha shaxslar bilan bir xil.'],
    ['We ___ not use phones here.', ['can'], 'Inkor: can not / cannot.'],
    ['___ you help me?', ['Can'], 'Savolda Can gap boshiga chiqadi.'],
    ['He can ___ fast.', ['run'], 'Can dan keyin V1.'],
    ['They can ___ football.', ['play'], 'Can dan keyin asosiy fe’l.'],
    ['My little brother ___ read English yet.', ["can't", 'cannot'], 'Qila olmaslik: can’t / cannot.'],
    ['Can she ___ a bike?', ['ride'], 'Can dan keyin V1.'],
    ['You ___ sit here.', ['can'], 'Ruxsat ma’nosida can.'],
    ['Birds ___ fly.', ['can'], 'Qobiliyat: can fly.']
  ],
  'WHO / WHAT': [
    ['___ is your teacher?', ['Who'], 'Odam haqida who bilan so‘raladi.'],
    ['___ is this object?', ['What'], 'Narsa haqida what bilan so‘raladi.'],
    ['___ are those people?', ['Who'], 'Odamlar haqida who.'],
    ['___ is your favorite color?', ['What'], 'Narsa/tanlov haqida what.'],
    ['___ is calling you?', ['Who'], 'Qo‘ng‘iroq qilayotgan odam — who.'],
    ['___ do you want?', ['What'], 'Nimani xohlaysiz — what.'],
    ['___ is that man?', ['Who'], 'Man/person haqida who.'],
    ['___ is in your bag?', ['What'], 'Narsa haqida what.'],
    ['___ is your best friend?', ['Who'], 'Do‘st odam, who.'],
    ['___ is the answer?', ['What'], 'Javob/narsa, what.']
  ],
  'PRESENT CONTINUOUS': [
    ['Look! The girl ___ a picture. (draw)', ['is drawing'], 'Hozirgi jarayon: is drawing.'],
    ['We ___ English now. (learn)', ['are learning'], 'We + are + V-ing.'],
    ['I ___ my homework at the moment. (do)', ['am doing'], 'I + am + V-ing.'],
    ['The boys ___ football now. (play)', ['are playing'], 'Boys ko‘plik, are playing.'],
    ['My mother ___ dinner right now. (cook)', ['is cooking'], 'My mother birlik, is cooking.'],
    ['___ you listening to me?', ['Are'], 'Savolda Are + you + V-ing.'],
    ['He ___ not sleeping now. (sleep)', ['is'], 'Inkor: is not sleeping.'],
    ['They ___ TV at the moment. (watch)', ['are watching'], 'They + are watching.'],
    ['The baby ___ now. (cry)', ['is crying'], 'Baby birlik, is crying.'],
    ['I ___ not playing. (play)', ['am'], 'I am not + V-ing.']
  ],
  'PRESENT SIMPLE': [
    ['My father ___ in a bank. (work)', ['works'], 'My father = he, works.'],
    ['We ___ English every day. (study)', ['study'], 'We bilan V1.'],
    ['She ___ to school by bus. (go)', ['goes'], 'She bilan go → goes.'],
    ['They ___ football on Sundays. (play)', ['play'], 'They bilan V1.'],
    ['Ali ___ TV in the evening. (watch)', ['watches'], 'Ali = he, watch → watches.'],
    ['I ___ coffee every morning. (drink)', ['drink'], 'I bilan V1.'],
    ['Does she ___ here? (live)', ['live'], 'Does dan keyin V1.'],
    ['He does not ___ meat. (eat)', ['eat'], 'Does not dan keyin V1.'],
    ['The lesson ___ at nine. (start)', ['starts'], 'Lesson birlik, starts.'],
    ['Do you ___ chess? (play)', ['play'], 'Do dan keyin V1.']
  ],
  'PREPOSITION OF PLACE': [
    ['The keys are ___ the bag.', ['in'], 'Bag ichida — in.'],
    ['The picture is ___ the wall.', ['on'], 'Devorda — on the wall.'],
    ['The shoes are ___ the bed. (ostida)', ['under'], 'Ostida — under.'],
    ['The school is ___ the bank. (yonida)', ['next to'], 'Yonida — next to.'],
    ['The car is ___ the house. (orqasida)', ['behind'], 'Orqasida — behind.'],
    ['The shop is ___ the bank and the school.', ['between'], 'Ikki narsa orasida — between.'],
    ['The teacher is ___ the board. (oldida)', ['in front of'], 'Oldida — in front of.'],
    ['The phone is ___ the desk.', ['on'], 'Desk ustida — on.'],
    ['The students are ___ the classroom.', ['in'], 'Xona ichida — in.'],
    ['The cat is ___ the chair. (ostida)', ['under'], 'Ostida — under.']
  ],
  'PREPOSITION OF TIME': [
    ['The lesson starts ___ 8 o’clock.', ['at'], 'Aniq soat uchun at.'],
    ['My birthday is ___ June.', ['in'], 'Oy uchun in.'],
    ['We have English ___ Monday.', ['on'], 'Hafta kuni uchun on.'],
    ['I study ___ the morning.', ['in'], 'Kun qismi uchun in.'],
    ['The meeting is ___ noon.', ['at'], 'Noon uchun at.'],
    ['They visit us ___ Sundays.', ['on'], 'Hafta kuni uchun on.'],
    ['It is cold ___ winter.', ['in'], 'Fasl uchun in.'],
    ['The test is ___ 10:30.', ['at'], 'Aniq vaqt uchun at.'],
    ['We travel ___ July.', ['in'], 'Oy uchun in.'],
    ['The party is ___ Friday evening.', ['on'], 'Kun + evening uchun on.']
  ]
};

function getDifferentWorkbookBlanks(language, title, pack, limit = WRITING_FILL_BLANK_COUNT) {
  const key = normalizeTopicName(title);
  const custom = DIFFERENT_WORKBOOK_BLANKS[key];
  const choicePrompts = new Set((pack?.choice || []).map(item => normalizeTopicName(String(item?.[0] || '').replace(/\s+/g, ' '))));
  const source = Array.isArray(custom) && custom.length ? custom : (pack?.blanks || []);
  const unique = [];
  const seen = new Set();
  for (const item of source) {
    const prompt = String(item?.[0] || '').trim();
    const promptKey = normalizeTopicName(prompt.replace(/\s+/g, ' '));
    if (!prompt || seen.has(promptKey) || choicePrompts.has(promptKey)) continue;
    unique.push(item);
    seen.add(promptKey);
    if (unique.length >= limit) break;
  }
  if (unique.length >= limit) return unique.slice(0, limit);

  for (const item of (pack?.blanks || [])) {
    if (unique.length >= limit) break;
    const prompt = String(item?.[0] || '').trim();
    const promptKey = normalizeTopicName(prompt.replace(/\s+/g, ' '));
    if (!prompt || seen.has(promptKey) || choicePrompts.has(promptKey)) continue;
    unique.push(item);
    seen.add(promptKey);
  }

  // Pack bo'lmagan Pre-Intermediate kabi mavzularda ham 8 ta yozish mashqi bo'lishi uchun fallback.
  const fallbackBlanks = [
    [`Use the correct form for ${title}: I ___ English every day.`, ['study'], `${title} mavzusiga mos fe'l shaklini yozing.`],
    [`Use the correct form for ${title}: She ___ at the moment.`, ['is studying'], 'Hozir davom etayotgan ish uchun mos shakl yozing.'],
    [`Use the correct form for ${title}: They ___ yesterday.`, ['worked'], "O\'tgan zamon uchun mos shakl yozing."],
    [`Complete the sentence for ${title}: This is the person ___ helped me.`, ['who'], 'Odam uchun who ishlatiladi.'],
    [`Complete the sentence for ${title}: I have ___ my homework.`, ['finished'], 'Present Perfectda have/has + V3 ishlatiladi.'],
    [`Complete the sentence for ${title}: The letter was ___.`, ['written'], 'Passive Voice uchun V3 kerak.'],
    [`Complete the sentence for ${title}: If I had time, I ___ help you.`, ['would'], 'Second Conditional natija qismida would ishlatiladi.'],
    [`Complete the connector for ${title}: ___ it was raining, we went out.`, ['although'], 'Qarama-qarshilik uchun although ishlatiladi.']
  ];
  for (const item of fallbackBlanks) {
    if (unique.length >= limit) break;
    const promptKey = normalizeTopicName(item[0]);
    if (seen.has(promptKey) || choicePrompts.has(promptKey)) continue;
    unique.push(item);
    seen.add(promptKey);
  }
  return unique.slice(0, limit);
}

const WRITING_FILL_BLANK_COUNT = 8;
const WRITING_SENTENCE_COUNT = 7;

function defaultSentenceItemsForTopic(title = '') {
  const key = normalizeTopicName(title);
  const packs = {
    'A / AN': [
      ['Write one sentence with “a”.', 'article', ['I have a pen.', 'This is a dog.'], 'a + birlikdagi sanaladigan ot ishlating.'],
      ['Write one sentence with “an”.', 'article', ['I have an apple.', 'This is an elephant.'], 'an + unli tovush bilan boshlangan ot ishlating.'],
      ['Write one sentence about a job.', 'article', ['She is a teacher.', 'He is an actor.'], 'Kasb oldidan a/an ishlating.'],
      ['Write one sentence with an animal.', 'article', ['It is a cat.', 'This is an owl.'], 'Hayvon nomi bilan a yoki an ishlating.'],
      ['Write one sentence with adjective + noun.', 'article', ['It is a big dog.', 'I have an old car.'], 'a/an + sifat + birlik ot shaklida yozing.'],
      ['Write one sentence with “a university”.', 'article', ['He studies at a university.'], 'University /juː/ tovushi bilan boshlanadi, shuning uchun a.'],
      ['Write one sentence with “an hour”.', 'article', ['I have an hour.'], 'Hour so‘zida h talaffuz qilinmaydi, shuning uchun an.'],
      ['Write one sentence without a/an before plural noun.', 'article', ['They are students.', 'I have books.'], 'Ko‘plik ot oldidan a/an ishlatmang.']
    ],
    'PLURALS (REGULAR)': [
      ['Write one sentence with “flowers”.', 'plural_regular', ['There are two flowers.'], 'flowers so‘zini ishlating.'],
      ['Write one sentence with “zebras”.', 'plural_regular', ['I can see four zebras.'], 'zebras so‘zini ishlating.'],
      ['Write one sentence with “boxes”.', 'plural_regular', ['There are three boxes.'], 'boxes so‘zini ishlating.'],
      ['Write one sentence with “babies”.', 'plural_regular', ['The babies are sleeping.'], 'babies so‘zini ishlating.'],
      ['Write one sentence with “watches”.', 'plural_regular', ['I have two watches.'], 'watches so‘zini ishlating.'],
      ['Write one sentence with “cities”.', 'plural_regular', ['Big cities are busy.'], 'y → ies qoidasidagi ko‘plik otni ishlating.'],
      ['Write one sentence with “boys”.', 'plural_regular', ['The boys are in the garden.'], 'vowel + y bo‘lsa faqat -s qo‘shiladi.'],
      ['Write one sentence with any regular plural noun.', 'plural_regular', ['I have three pens.'], 'books, cars, pens, students kabi qoidali ko‘plik ot yozing.']
    ],
    'PLURAL (IRREGULAR)': [
      ['Write one sentence with “children”.', 'plural_irregular', ['The children are playing.'], 'children so‘zini ishlating.'],
      ['Write one sentence with “men”.', 'plural_irregular', ['The men are working.'], 'men so‘zini ishlating.'],
      ['Write one sentence with “women”.', 'plural_irregular', ['The women are teachers.'], 'women so‘zini ishlating.'],
      ['Write one sentence with “people”.', 'plural_irregular', ['Many people are in the park.'], 'people so‘zini ishlating.'],
      ['Write one sentence with “feet”.', 'plural_irregular', ['My feet are cold.'], 'feet so‘zini ishlating.'],
      ['Write one sentence with “teeth”.', 'plural_irregular', ['Her teeth are white.'], 'teeth so‘zini ishlating.'],
      ['Write one sentence with “mice”.', 'plural_irregular', ['The mice are small.'], 'mice so‘zini ishlating.'],
      ['Write one sentence with any irregular plural noun.', 'plural_irregular', ['The sheep are in the field.'], 'irregular plural noun ishlating.']
    ],
    'TO BE': [
      ['Write one sentence with “am”.', 'to_be', ['I am a student.'], 'I + am ishlating.'],
      ['Write one sentence with “is”.', 'to_be', ['She is happy.'], 'He/She/It + is ishlating.'],
      ['Write one sentence with “are”.', 'to_be', ['They are students.'], 'You/We/They + are ishlating.'],
      ['Write one negative sentence with “not”.', 'to_be', ['I am not tired.'], 'am/is/are + not ishlating.'],
      ['Write one question with “to be”.', 'to_be', ['Are you ready?'], 'Am/Is/Are gap boshiga chiqadi.'],
      ['Write one sentence about age.', 'to_be', ['He is 18 years old.'], 'Yoshni aytishda to be ishlating.'],
      ['Write one sentence about a job.', 'to_be', ['My mother is a teacher.'], 'Kasbni aytishda to be ishlating.'],
      ['Write one sentence with a short form.', 'to_be', ["She's my sister."], "I'm / you're / he's kabi qisqartma ishlating."]
    ],
    'SUBJECT PRONOUN': [
      ['Write one sentence with “I”.', 'subject_pronoun', ['I am a student.'], 'I subject pronounini ishlating.'],
      ['Write one sentence with “you”.', 'subject_pronoun', ['You are my friend.'], 'you subject pronounini ishlating.'],
      ['Write one sentence with “he”.', 'subject_pronoun', ['He is my brother.'], 'Erkak kishi uchun he ishlating.'],
      ['Write one sentence with “she”.', 'subject_pronoun', ['She is my sister.'], 'Ayol kishi uchun she ishlating.'],
      ['Write one sentence with “it”.', 'subject_pronoun', ['It is my book.'], 'Narsa yoki hayvon uchun it ishlating.'],
      ['Write one sentence with “we”.', 'subject_pronoun', ['We are students.'], 'Biz uchun we ishlating.'],
      ['Write one sentence with “they”.', 'subject_pronoun', ['They are playing.'], 'Ular uchun they ishlating.'],
      ['Write one sentence replacing a name with pronoun.', 'subject_pronoun', ['Ali is my friend. He is kind.'], 'Ismni takrorlamasdan pronoun ishlating.']
    ],
    'THERE IS / THERE ARE': [
      ['Write one sentence with “There is”.', 'there_is_are', ['There is a book on the table.'], 'Birlik ot bilan There is ishlating.'],
      ['Write one sentence with “There are”.', 'there_is_are', ['There are two books on the table.'], 'Ko‘plik ot bilan There are ishlating.'],
      ['Write one negative sentence with “There isn’t”.', 'there_is_are', ["There isn't a TV in my room."], 'Birlik inkor gap yozing.'],
      ['Write one negative sentence with “There aren’t”.', 'there_is_are', ["There aren't any apples in the bag."], 'Ko‘plik inkor gap yozing.'],
      ['Write one question with “Is there”.', 'there_is_are', ['Is there a shop near here?'], 'Birlik savol gap yozing.'],
      ['Write one question with “Are there”.', 'there_is_are', ['Are there any students in the room?'], 'Ko‘plik savol gap yozing.'],
      ['Write one sentence with “some”.', 'there_is_are', ['There are some books on the shelf.'], 'Darak gapda some ishlating.'],
      ['Write one sentence with “any”.', 'there_is_are', ["There aren't any chairs in the room."], 'Inkor yoki savolda any ishlating.']
    ],
    'HAVE / HAS': [
      ['Write one sentence with “have”.', 'have_has', ['I have a book.'], 'Gap ichida have so‘zi aniq ishlatilsin.'],
      ['Write one sentence with “has”.', 'have_has', ['She has a pen.'], 'Gap ichida has so‘zi aniq ishlatilsin.'],
      ['Write one sentence with “have”.', 'have_has', ['They have new books.'], 'I/you/we/they bilan have ishlating.'],
      ['Write one sentence with “has”.', 'have_has', ['Ali has a bag.'], 'He/she/it yoki bitta ism bilan has ishlating.'],
      ['Write one sentence with “have”.', 'have_has', ['We have English today.'], 'Gap ichida have so‘zi bo‘lsin.'],
      ['Write one sentence with “has”.', 'have_has', ['The school has many rooms.'], 'Gap ichida has so‘zi bo‘lsin.']
    ],
    "CAN / CAN'T": [
      ['Write one sentence with “can”.', 'modal', ['I can read.'], 'Qila olish ma’nosida can ishlating.'],
      ['Write one sentence with “can’t”.', 'modal', ["I can't swim."], 'Qila olmaslik ma’nosida can’t ishlating.'],
      ['Write one question with “Can you”.', 'modal', ['Can you sing?'], 'Can savolda egadan oldin keladi.'],
      ['Write one sentence about speaking English.', 'modal', ['She can speak English.'], 'can + V1 ishlating.'],
      ['Write one sentence about swimming.', 'modal', ['They can swim.'], 'can dan keyin fe’lga -s qo‘shmang.'],
      ['Write one negative sentence about playing.', 'modal', ["He can't play tennis."], 'can’t + V1 ishlating.'],
      ['Write one question about ability.', 'modal', ['Can he drive a car?'], 'Qobiliyat haqida savol yozing.'],
      ['Write one sentence with “can” and a base verb.', 'modal', ['We can help you.'], 'can + read/go/play/help kabi V1 ishlating.']
    ],
    'WHO / WHAT': [
      ['Write one question with “Who is”.', 'question_word', ['Who is that man?'], 'Inson haqida Who ishlating.'],
      ['Write one question with “Who are”.', 'question_word', ['Who are you?'], 'Kimlar yoki siz haqida savol yozing.'],
      ['Write one question with “What is”.', 'question_word', ['What is this?'], 'Narsa haqida What ishlating.'],
      ['Write one question with “What do”.', 'question_word', ['What do you think?'], 'What + do + subject + verb shaklida yozing.'],
      ['Write one question with “What are”.', 'question_word', ['What are you doing?'], 'Hozirgi ish haqida savol yozing.'],
      ['Write one question about a person.', 'question_word', ['Who is your teacher?'], 'Person = who.'],
      ['Write one question about a thing.', 'question_word', ['What is in your bag?'], 'Thing = what.'],
      ['Write one question with Who or What.', 'question_word', ['Who is this girl?'], 'Who yoki What bilan to‘liq savol yozing.']
    ],
    'PRESENT CONTINUOUS': [
      ['Write one positive Present Continuous sentence.', 'present_continuous', ['I am reading now.'], 'am/is/are + V-ing bilan ijobiy gap yozing.'],
      ['Write one negative Present Continuous sentence.', 'present_continuous', ['I am not sleeping.'], 'am/is/are + not + V-ing ishlating.'],
      ['Write one Present Continuous question.', 'present_continuous', ['Are you working?'], 'Am/Is/Are bilan savol yozing.'],
      ['Write one sentence using “now”.', 'present_continuous', ['He is writing now.'], 'now bilan gap tuzing.'],
      ['Write one sentence using “at the moment”.', 'present_continuous', ['I am studying at the moment.'], 'at the moment ishlating.'],
      ['Write one sentence starting with “Look!”.', 'present_continuous', ['Look! It is raining.'], 'Look! + Present Continuous ishlating.'],
      ['Write one sentence with “not”.', 'present_continuous', ['They are not watching TV.'], 'Inkor Present Continuous yozing.'],
      ['Write one sentence with a verb ending in -ing.', 'present_continuous', ['She is cooking dinner.'], 'V-ing shaklini ishlating.']
    ],
    'PRESENT SIMPLE': [
      ['Write one positive Present Simple sentence with I/you/we/they.', 'present_simple', ['I study English every day.'], 'I/you/we/they + V1 ishlating.'],
      ['Write one negative Present Simple sentence with I/you/we/they.', 'present_simple', ['I do not watch TV.'], 'I/you/we/they + do not + V1 ishlating.'],
      ['Write one Present Simple question with Do and I/you/we/they.', 'present_simple', ['Do you speak English?'], 'Do + I/you/we/they + V1?'],
      ['Write one positive Present Simple sentence with he/she/it.', 'present_simple', ['She plays tennis.'], 'He/she/it + V-s/es ishlating.'],
      ['Write one negative Present Simple sentence with he/she/it.', 'present_simple', ['He does not like coffee.'], 'He/she/it + does not + V1 ishlating.'],
      ['Write one Present Simple question with Does and he/she/it.', 'present_simple', ['Does she work here?'], 'Does + he/she/it + V1?'],
      ['Write one sentence using “every day”.', 'present_simple', ['I read every day.'], 'every day ishlating.'],
      ['Write one sentence using “usually”.', 'present_simple', ['We usually go to school.'], 'usually ishlating.']
    ],
    'PREPOSITION OF PLACE': [
      ['Write one sentence with “in”.', 'prep_place', ['The rabbit is in the hat.'], 'in = ichida.'],
      ['Write one sentence with “on”.', 'prep_place', ['The book is on the table.'], 'on = ustida.'],
      ['Write one sentence with “under”.', 'prep_place', ['The ball is under the chair.'], 'under = ostida.'],
      ['Write one sentence with “behind”.', 'prep_place', ['The cat is behind the door.'], 'behind = orqasida.'],
      ['Write one sentence with “next to”.', 'prep_place', ['The bank is next to the school.'], 'next to = yonida.'],
      ['Write one sentence with “between”.', 'prep_place', ['The shop is between the bank and the school.'], 'between = orasida.'],
      ['Write one sentence with “in front of”.', 'prep_place', ['The car is in front of the house.'], 'in front of = oldida.'],
      ['Write one sentence about location.', 'prep_place', ['My bag is under the table.'], 'Biror narsaning joylashuvini yozing.']
    ],
    'PREPOSITION OF TIME': [
      ['Write one sentence with “in the morning”.', 'prep_time', ['I study in the morning.'], 'Kun qismi uchun in ishlating.'],
      ['Write one sentence with “at 8 o’clock”.', 'prep_time', ["I get up at 8 o'clock."], 'Aniq soat uchun at ishlating.'],
      ['Write one sentence with “on Monday”.', 'prep_time', ['I go to school on Monday.'], 'Hafta kuni uchun on ishlating.'],
      ['Write one sentence with “in May”.', 'prep_time', ['My birthday is in May.'], 'Oylar uchun in ishlating.'],
      ['Write one sentence with “at night”.', 'prep_time', ['I sleep at night.'], 'at night ishlating.'],
      ['Write one sentence with “on Sunday afternoon”.', 'prep_time', ['We play football on Sunday afternoon.'], 'Kun + kun qismi uchun on ishlating.'],
      ['Write one sentence with “at noon”.', 'prep_time', ['We have a break at noon.'], 'at noon ishlating.'],
      ['Write one sentence with “in summer”.', 'prep_time', ['We study in summer.'], 'Fasl uchun in ishlating.']
    ]
  };
  if (packs[key]) return packs[key];
  if (key.includes('PRESENT SIMPLE') && key.includes('PRESENT CONTINUOUS')) return [
    ['Write one sentence with Present Simple.', 'present_simple', ['I usually read books.'], 'Odat uchun Present Simple yozing.'],
    ['Write one sentence with Present Continuous.', 'present_continuous', ['I am reading now.'], 'Hozir davom etayotgan ish uchun Present Continuous yozing.'],
    ['Write one sentence using “usually”.', 'present_simple', ['She usually walks to school.'], 'usually bilan odat yozing.'],
    ['Write one sentence using “now”.', 'present_continuous', ['She is walking now.'], 'now bilan hozirgi ish yozing.'],
    ['Write one contrast sentence.', 'present_simple_vs_continuous', ['I usually walk, but I am taking a bus today.'], 'Bitta gapda odat va hozirgi holatni solishtiring.'],
    ['Write one negative Present Simple sentence.', 'present_simple', ['He does not play tennis.'], 'do not / does not ishlating.'],
    ['Write one negative Present Continuous sentence.', 'present_continuous', ['He is not playing tennis now.'], 'am/is/are + not + V-ing ishlating.'],
    ['Write one question in Present Continuous.', 'present_continuous', ['Are you studying now?'], 'Am/Is/Are bilan savol yozing.']
  ];
  const tense = tenseKeyFromText(key) || (key.includes('CAN') ? 'modal' : key.includes('MUST') ? 'modal' : key.includes('PLACE') ? 'prep_place' : key.includes('TIME') ? 'prep_time' : '');
  return [
    [`Write one positive sentence for ${title}.`, tense, [], `${title} mavzusiga mos ijobiy gap yozing.`],
    [`Write one negative sentence for ${title}.`, tense, [], `${title} mavzusiga mos inkor gap yozing.`],
    [`Write one question for ${title}.`, tense, [], `${title} mavzusiga mos savol gap yozing.`],
    [`Write one sentence with a real-life example.`, tense, [], 'O‘zingizning hayotingizdan bitta misol yozing.'],
    [`Write one sentence about school.`, tense, [], 'Maktab yoki dars haqida gap yozing.'],
    [`Write one sentence about your friend.`, tense, [], 'Do‘stingiz haqida gap yozing.'],
    [`Write one sentence about today.`, tense, [], 'Bugungi kun haqida gap yozing.'],
    [`Write one more sentence for this topic.`, tense, [], `${title} mavzusini mustahkamlash uchun yana bitta gap yozing.`]
  ];
}

function expandSentenceItemsForTopic(title, sentenceItems = []) {
  const combined = [...(sentenceItems || [])];
  const defaults = defaultSentenceItemsForTopic(title);
  const seen = new Set(combined.map(item => String(item?.[0] || '').trim().toLowerCase()));
  for (const item of defaults) {
    if (combined.length >= WRITING_SENTENCE_COUNT) break;
    const promptKey = String(item?.[0] || '').trim().toLowerCase();
    if (!seen.has(promptKey)) {
      combined.push(item);
      seen.add(promptKey);
    }
  }
  while (combined.length < WRITING_SENTENCE_COUNT) {
    const n = combined.length + 1;
    combined.push([`Write sentence ${n} for ${title}.`, tenseKeyFromText(title), [], `${title} mavzusiga mos to‘liq inglizcha gap yozing.`]);
  }
  return combined.slice(0, WRITING_SENTENCE_COUNT);
}


function formatExpectedAnswers(expectedValues = []) {
  const values = (expectedValues || []).filter(Boolean).map(v => String(v).trim()).filter(Boolean);
  if (!values.length) return '';
  return values.slice(0, 4).join(' / ');
}

function splitBlankAnswerParts(prompt = '', answer = '') {
  const blankCount = (String(prompt || '').match(/___/g) || []).length;
  const safeAnswer = String(answer || '').trim();
  if (blankCount <= 1) return [safeAnswer];
  if (!safeAnswer) return Array.from({ length: blankCount }, () => '');

  let parts = safeAnswer.split(/\n+/).map(part => part.trim()).filter(Boolean);
  if (parts.length < blankCount && /\s*[|,]\s*/.test(safeAnswer)) {
    parts = safeAnswer.split(/\s*[|,]\s*/).map(part => part.trim()).filter(Boolean);
  }
  if (parts.length < blankCount) {
    const words = safeAnswer.replace(/[|,]+/g, ' ').split(/\s+/).filter(Boolean);
    if (words.length >= blankCount) {
      parts = [...words.slice(0, blankCount - 1), words.slice(blankCount - 1).join(' ')];
    }
  }
  while (parts.length < blankCount) parts.push('');
  if (parts.length > blankCount) {
    parts = [...parts.slice(0, blankCount - 1), parts.slice(blankCount - 1).join(' ')];
  }
  return parts.slice(0, blankCount);
}

function filledBlankSentence(prompt = '', answer = '') {
  const cleanPrompt = String(prompt || '').replace(/\s*\([^)]*\)\s*$/, '');
  const blankCount = (cleanPrompt.match(/___/g) || []).length;
  if (!blankCount) return cleanPrompt;
  const parts = splitBlankAnswerParts(cleanPrompt, answer);
  let blankIndex = 0;
  return cleanPrompt.replace(/___/g, () => {
    const current = String(parts[blankIndex++] || '').trim();
    return current || '___';
  });
}

function inferFillBlankHint(prompt = '', expectedValues = []) {
  const p = String(prompt || '').toLowerCase();
  const expected = String((expectedValues || [])[0] || '').toLowerCase();
  if (!expected) return 'Bo‘sh joyga mavzuga mos javob yozing.';
  if (expected === '26') return 'English alphabet 26 ta harfdan iborat.';
  if (['vowel','consonant','letters'].includes(expected)) return 'Alphabet mavzusida to‘g‘ri terminni yozing: vowel, consonant yoki letters.';
  if (['am', 'is', 'are'].includes(expected)) return 'To be mosligi: I am, he/she/it is, you/we/they are.';
  if (['a', 'an'].includes(expected)) return expected === 'an' ? 'Unli tovushdan oldin an ishlatiladi.' : 'Undosh tovushdan oldin a ishlatiladi.';
  if (['at', 'in', 'on'].includes(expected)) return 'Vaqt predlogi: at = aniq soat/vaqt, in = oy/yil/fasl/kun qismi, on = hafta kuni/sana.';
  if (['have', 'has'].includes(expected)) return 'Have/has mosligi: I/you/we/they have, he/she/it has.';
  if (['do', 'does', 'do not', "don't", 'dont', 'does not', "doesn't", 'doesnt'].includes(expected)) return 'Present Simple savol va inkorda do/does yordamchi fe’li ishlatiladi.';
  if (['children','men','women','people','feet','teeth','mice','geese','sheep','fish'].includes(expected)) return 'Bu irregular plural: oddiy -s qo‘shilmaydi, maxsus ko‘plik shakli ishlatiladi.';
  if (expected === 'watches') return 'He/she/it yoki birlik ega bilan Present Simpleda watch → watches bo‘ladi.';
  if (expected === 'watch') return 'I/you/we/they bilan Present Simpleda fe’l V1 shaklida qoladi: watch.';
  if (expected === 'goes') return 'He/she/it yoki birlik ega bilan Present Simpleda go → goes bo‘ladi.';
  if (expected === 'go') return 'I/you/we/they bilan Present Simpleda fe’l V1 shaklida qoladi: go.';
  if (expected === 'opens') return 'Birlik ega bilan Present Simpleda fe’lga -s qo‘shiladi: open → opens.';
  if (expected === 'open') return 'I/you/we/they yoki ko‘plik ega bilan fe’l V1 shaklida qoladi: open.';
  if (expected === 'works') return 'He/she/it yoki birlik ega bilan Present Simpleda fe’lga -s qo‘shiladi: work → works.';
  if (expected === 'work') return 'I/you/we/they bilan Present Simpleda fe’l V1 shaklida qoladi: work.';
  if (/s$|es$|ies$/.test(expected) && !['is','has','does'].includes(expected)) return 'Bu savolda otning ko‘plik shakli kerak.';
  if (/ing$/.test(expected)) return 'Present Continuousda am/is/are + V-ing shakli ishlatiladi.';
  if (/ed$/.test(expected)) return 'Past Simpleda fe’lning o‘tgan zamon shakli kerak.';
  return 'Bo‘sh joyga berilgan mavzu va gap ma’nosiga mos javob yozing.';
}


function isPluralWordTask(prompt = '', expectedValues = []) {
  const p = String(prompt || '').toLowerCase();
  const expected = String((expectedValues || [])[0] || '').toLowerCase().trim();
  const regularPluralSet = new Set(['books','cars','pens','boxes','babies','cities','buses','toys','watches','students','flowers','zebras','lions','glasses','dishes','tomatoes','boys']);
  const irregularPluralSet = new Set(['children','men','women','people','feet','teeth','mice','geese','sheep','fish']);
  if (!(regularPluralSet.has(expected) || irregularPluralSet.has(expected))) return false;
  return /\([^)]*\)/.test(p) || /\b(two|three|four|five|many|several|both)\b/.test(p);
}

function pluralTaskFeedbackText(task, answer, expectedValues = [], score = 0, exactFillBlank = false) {
  const cleanAnswer = String(answer || '').trim();
  const expectedText = formatExpectedAnswers(expectedValues);
  const expected = String((expectedValues || [])[0] || '').trim();
  const completed = filledBlankSentence(task?.prompt || '', cleanAnswer);
  const correctCompleted = expected ? filledBlankSentence(task?.prompt || '', expected) : '';
  if (!cleanAnswer) {
    return `Javob yozilmagan. Bu joyga “${expectedText || 'mavzuga mos javob'}” yozish kerak.`;
  }
  if (exactFillBlank || score >= 95) {
    return `To‘g‘ri. Siz “${cleanAnswer}” yozdingiz. Gap: “${completed}”.`;
  }
  const irregularPluralSet = new Set(['children','men','women','people','feet','teeth','mice','geese','sheep','fish']);
  const typeText = irregularPluralSet.has(expected.toLowerCase())
    ? 'Bu savolda so‘zning maxsus ko‘plik shakli kerak.'
    : 'Bu savolda berilgan otning ko‘plik shakli kerak.';
  let reason = `Siz “${cleanAnswer}” yozdingiz, to‘g‘ri javob “${expectedText || expected}”. ${typeText}`;
  if (correctCompleted) reason += ` To‘g‘ri gap: “${correctCompleted}”.`;
  return reason;
}

function analyzeFillBlankAnswer(task, answer, expectedValues = [], score = 0, exactFillBlank = false) {
  const cleanAnswer = String(answer || '').trim();
  const expectedText = formatExpectedAnswers(expectedValues);
  const expected = String((expectedValues || [])[0] || '').trim();
  const hint = String(task?.hint || '').trim() || inferFillBlankHint(task?.prompt, expectedValues);
  const completed = filledBlankSentence(task?.prompt || '', cleanAnswer);
  const correctCompleted = expected ? filledBlankSentence(task?.prompt || '', expected) : '';

  if (isPluralWordTask(task?.prompt, expectedValues)) {
    return pluralTaskFeedbackText(task, answer, expectedValues, score, exactFillBlank);
  }

  if (!cleanAnswer) {
    return `Javob yozilmagan. Bu joyga “${expectedText || 'mavzuga mos javob'}” yozish kerak.`;
  }
  if (exactFillBlank || score >= 95) {
    return `To‘g‘ri. Siz “${cleanAnswer}” yozdingiz. Gap: “${completed}”.`;
  }

  const normalizedAnswer = normalizeWritingAnswer(cleanAnswer);
  const normalizedExpected = normalizeWritingAnswer(expected);
  let reason = `Siz “${cleanAnswer}” yozdingiz, lekin bu joyga “${expectedText || expected}” kerak.`;

  if (normalizedAnswer && normalizedExpected && normalizedAnswer !== normalizedExpected) {
    if ((normalizedExpected === 'watches' && normalizedAnswer === 'watch') || (expected.toLowerCase() === 'watches')) {
      reason += ' Bu joyda ega “she / he / it” yoki birlik ega bo‘lsa, Present Simpleda fe’lga -s/-es qo‘shiladi: watch → watches.';
    } else if ((normalizedExpected === 'works' && normalizedAnswer === 'work') || (normalizedExpected === 'opens' && normalizedAnswer.replace(/s$/, '') === normalizedExpected.replace(/s$/, ''))) {
      reason += ' Bu joyda birlik ega uchun Present Simpleda fe’lga -s qo‘shiladi.';
    } else if (normalizedExpected === 'goes' && normalizedAnswer === 'go') {
      reason += ' He/she/it yoki birlik ega bilan go → goes bo‘ladi.';
    } else if (['am','is','are'].includes(normalizedExpected)) {
      reason += ' To be shaklini egaga qarab tanlang: I am, he/she/it is, you/we/they are.';
    } else if (['do','does','do not','does not','dont','doesnt'].includes(normalizedExpected)) {
      reason += ' Present Simpleda savol va inkorda do/does yordamchi fe’li ishlatiladi. He/she/it bilan does, I/you/we/they bilan do.';
    } else if (['a','an'].includes(normalizedExpected)) {
      reason += ' a/an tovushga qarab tanlanadi: undosh tovushdan oldin a, unli tovushdan oldin an.';
    } else if (['at','in','on'].includes(normalizedExpected)) {
      reason += ' Vaqt predloglarida: at — soat/aniq vaqt, in — oy/yil/fasl/kun qismi, on — hafta kuni/sana.';
    } else if (['have','has'].includes(normalizedExpected)) {
      reason += ' Have/has egaga bog‘liq: I/you/we/they have, he/she/it has.';
    } else if (['children','men','women','people','feet','teeth','mice','geese','sheep','fish'].includes(normalizedExpected)) {
      reason += ' Bu irregular plural, shuning uchun oddiy -s qo‘shilmaydi.';
    } else if (/ing$/.test(normalizedExpected)) {
      reason += ' Bu yerda -ing shakli kerak.';
    } else if (/s$|es$|ies$/.test(normalizedExpected) && !['is','has','does'].includes(normalizedExpected)) {
      reason += ' Bu yerda otning ko‘plik shakli kerak.';
    }
  }

  if (correctCompleted) reason += ` To‘g‘ri gap: “${correctCompleted}”.`;
  return reason;
}

const WORD_ONLY_WRITING_TOPICS_BEFORE_TO_BE = new Set(['ALFABIT', 'A / AN', 'PLURALS (REGULAR)', 'PLURAL (IRREGULAR)', 'SUBJECT PRONOUN']);

function isWordOnlyWritingBeforeToBeTopic(title = '') {
  return WORD_ONLY_WRITING_TOPICS_BEFORE_TO_BE.has(normalizeTopicName(title));
}

function buildWorkbookStyleWritingTasks(language, title) {
  const pack = getWorkbookExercisePack(language, title);
  const wordOnly = isWordOnlyWritingBeforeToBeTopic(title);
  const blankLimit = wordOnly ? 10 : WRITING_FILL_BLANK_COUNT;
  const blankItems = getDifferentWorkbookBlanks(language, title, pack, blankLimit);
  const blanks = blankItems.map((item, index) => ({
    id: `w${index + 1}`,
    type: 'fill_blank',
    section: wordOnly ? 'So‘z yozish mashqi' : 'Yoziladigan test',
    title: wordOnly ? 'So‘zni yozing' : 'Bo‘sh joyni to‘ldiring',
    prompt: item[0],
    expected: item[1],
    hint: item[2] || inferFillBlankHint(item[0], item[1])
  }));

  // TO BE gacha bo‘lgan mavzularda o‘quvchi gap tuzmaydi va gap tarjima qilmaydi:
  // faqat kerakli so‘z/shaklni yozadi.
  if (wordOnly) return blanks;

  // TO BE va undan keyingi grammar mavzularida so‘z yozishdan keyin gap tuzish mashqlari beriladi.
  const sentenceItems = expandSentenceItemsForTopic(title, pack?.sentences || []);
  const sentences = sentenceItems.map((item, index) => ({
    id: `w${WRITING_FILL_BLANK_COUNT + index + 1}`,
    type: 'sentence_generation',
    section: 'Gap tuzish testi',
    title: 'Gap tuzing',
    prompt: item[0],
    tense: item[1] || '',
    expected: item[2] || [],
    hint: item[3] || 'Mavzuga mos to‘liq inglizcha gap yozing.'
  }));
  return [...blanks, ...sentences];
}

function buildTopicQuestions(language, level, title, topicNo, vocabulary) {
  const profile = getTopicProfile(language, level, title, topicNo);
  const maxQuestions = isThreePartWorkbookTopic(language, title) ? 10 : topicQuestionCount(language, level);
  const historyA1 = isHistoryA1(language, level);
  const questions = [];
  const quickCheck = historyA1 || isEnglishA1QuickCheck(language, level);
  function addQuestion(question, options, correctIndex, note) {
    if (!question || !Array.isArray(options) || options.length < 2) return;
    const packed = forceCorrectAnswerA(options, correctIndex, questions.length + topicNo);
    questions.push({ id: `q${questions.length + 1}`, question, options: packed.options, correctIndex: packed.correctIndex, note });
  }

  for (const item of buildWorkbookStyleChoiceQuestions(language, title)) {
    if (questions.length >= maxQuestions) break;
    addQuestion(item.question, item.options, item.correctIndex, item.note);
  }

  for (const [q, options, correctIndex, note] of (profile.checks || [])) {
    if (questions.length >= maxQuestions) break;
    const qText = String(q || '').toLowerCase();
    if (qText.includes('asosiy tuzilma qaysi') || qText.includes('asosiy grammatika qaysi')) continue;
    addQuestion(q, options, correctIndex, note);
  }

  const distractors = makeTopicDistractors(language, title, vocabulary);
  for (const ex of (profile.examples || [])) {
    if (questions.length >= maxQuestions) break;
    const pair = splitExamplePair(ex);
    if (!pair.en) continue;
    const packed = optionSet(pair.en, distractors.filter(d => d !== pair.en), questions.length + topicNo);
    const promptLabel = (language === 'english' || language === 'russia' || language === 'koreys')
      ? `Berilgan tarjimaga mos gapni tanlang: “${pair.uz || pair.en}”`
      : `Berilgan savol yoki izohga mos javobni tanlang: “${pair.uz || pair.en}”`;
    addQuestion(
      promptLabel,
      packed.options,
      packed.correctIndex,
      `To‘g‘ri javob: ${pair.en}${pair.uz ? ' / ' + pair.uz : ''}`
    );
  }

  for (let i = 0; i < vocabulary.length && questions.length < maxQuestions; i++) {
    const item = vocabulary[i];
    const opts = shuffledOptions(vocabulary, i, i + topicNo);
    addQuestion(
      `“${item.meaning}” ma’nosiga mos so‘zni tanlang. Misol: ${item.example}`,
      opts.options,
      opts.correctIndex,
      `To‘g‘ri javob: ${item.word}.`
    );
  }

  while (questions.length < maxQuestions) {
    const i = questions.length % Math.max(1, vocabulary.length);
    const item = vocabulary[i] || { word: title, meaning: title, example: title };
    const opts = optionSet(item.word, ['wrong form', 'not related', 'grammar only'], questions.length + topicNo);
    addQuestion(`Gapdagi muhim so‘zni tanlang: ${item.example}`, opts.options, opts.correctIndex, `${item.word}: ${item.meaning}`);
  }
  return questions.slice(0, maxQuestions).map((q, idx) => ({ ...q, id: `q${idx + 1}` }));
}


function tenseKeyFromText(value = '') {
  const t = String(value || '').toLowerCase();
  if (t.includes('present continuous')) return 'present_continuous';
  if (t.includes('present simple')) return 'present_simple';
  if (t.includes('past simple')) return 'past_simple';
  if (t.includes('future') || t.includes('going to')) return 'future_going_to';
  if (t.includes('present perfect')) return 'present_perfect';
  if (t.includes('past continuous')) return 'past_continuous';
  if (t.includes('should')) return 'should';
  if (t.includes('can') || t.includes('modal')) return 'modal';
  return '';
}

function englishExampleTranslation(example = '') {
  const clean = String(example || '').replace(/[“”]/g, '').trim();
  const map = {
    'I am reading now.': ['Men hozir o‘qiyapman.', 'Men hozir kitob o‘qiyapman.', 'Men hozir oqiyapman.'],
    'She is cooking.': ['U ovqat pishiryapti.', 'U hozir ovqat pishiryapti.'],
    'They are playing football.': ['Ular futbol o‘ynashyapti.', 'Ular futbol oynashyapti.'],
    'I study English every day.': ['Men har kuni ingliz tilini o‘rganaman.', 'Men har kuni ingliz tili o‘qiyman.', 'Men har kuni ingliz tilini oqiyman.'],
    'She plays tennis.': ['U tennis o‘ynaydi.', 'U tennis oynaydi.'],
    'I watched a film yesterday.': ['Men kecha film ko‘rdim.', 'Men kecha kino ko‘rdim.', 'Men kecha film kordim.'],
    'She went to school.': ['U maktabga bordi.'],
    'I am going to study.': ['Men o‘qimoqchiman.', 'Men oqimoqchiman.', 'Men o‘qishga boraman.'],
    'I have finished my homework.': ['Men uy vazifamni tugatdim.', 'Men uy ishini tugatganman.'],
    'I was reading at 8 pm.': ['Men soat 8 da o‘qiyotgan edim.', 'Men kechki 8 da o‘qiyotgan edim.'],
    'You should sleep early.': ['Siz erta uxlashingiz kerak.'],
    'I can speak English.': ['Men inglizcha gapira olaman.']
  };
  return map[clean] || [];
}

function buildEnglishGrammarWritingTasks(profile, title) {
  const concept = profile?.concept || title || '';
  const tense = tenseKeyFromText(concept || title);
  const examples = (profile?.examples || []).map(splitExamplePair).map(pair => pair.en).filter(Boolean);
  const firstExample = examples[0] || 'I am reading now.';
  const translations = englishExampleTranslation(firstExample);
  const tasks = [];
  if (translations.length) {
    tasks.push({
      id: 'w1',
      type: 'en_to_uz',
      title: 'Gapni tarjima qiling',
      prompt: `Tarjima qiling: “${firstExample}”`,
      expected: translations,
      hint: 'Ma’noni to‘liq o‘zbekcha yozing. Nuqta majburiy emas.'
    });
  }
  if (tense) {
    tasks.push({
      id: `w${tasks.length + 1}`,
      type: 'sentence_generation',
      tense,
      title: `${concept}ga gap tuzing`,
      prompt: `${concept} mavzusiga mos bitta to‘liq inglizcha gap tuzing. Namuna: ${firstExample}`,
      expected: examples.slice(0, 3),
      hint: `Tuzilma: ${profile.structure || 'subject + verb + object'}. Gapni inglizcha yozing.`
    });
    tasks.push({
      id: `w${tasks.length + 1}`,
      type: 'sentence_generation',
      tense,
      title: 'Inkor yoki savol gap tuzing',
      prompt: `${concept} bo‘yicha inkor yoki savol gap yozing. Yordamchi fe’l va so‘z tartibiga e’tibor bering.`,
      expected: examples.slice(0, 3),
      hint: 'Grammatika: yordamchi fe’l, zamon shakli va so‘z tartibini tekshiring.'
    });
  }
  return tasks.slice(0, 5).map((task, index) => ({ ...task, id: `w${index + 1}` }));
}

function normalizeExerciseText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[“”‘’'`´]/g, '')
    .replace(/___+/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function writingTaskText(task = {}) {
  return [task.prompt, task.title, ...(Array.isArray(task.expected) ? task.expected : [])]
    .map(normalizeExerciseText)
    .filter(Boolean)
    .join(' ');
}

function taskLooksSameAsChoice(task = {}, choiceQuestions = []) {
  const taskText = writingTaskText(task);
  if (!taskText) return false;
  return (choiceQuestions || []).some(q => {
    const questionText = normalizeExerciseText(q?.question || '');
    const optionText = Array.isArray(q?.options) ? q.options.map(normalizeExerciseText).filter(Boolean).join(' ') : '';
    const combined = `${questionText} ${optionText}`.trim();
    if (!combined) return false;
    if (taskText === combined || questionText === taskText) return true;
    return taskText.length > 18 && questionText.length > 18 && (combined.includes(taskText) || taskText.includes(questionText));
  });
}

function distinctFallbackWritingTasks(title = '', count = WRITING_SENTENCE_COUNT) {
  const tense = tenseKeyFromText(title);
  const templates = [
    [`Write a new sentence about your class for ${title}.`, tense, [], '1-mashqdagi gaplarni ko‘chirmang, yangi gap yozing.'],
    [`Write a new sentence about your family for ${title}.`, tense, [], 'Oilaga oid yangi gap yozing.'],
    [`Write a new sentence about today for ${title}.`, tense, [], 'Bugungi kun haqida yangi gap yozing.'],
    [`Write a new sentence about your friend for ${title}.`, tense, [], 'Do‘stingiz haqida yangi gap yozing.'],
    [`Write a new sentence about school for ${title}.`, tense, [], 'Maktab yoki dars haqida yangi gap yozing.'],
    [`Write a new question for ${title}.`, tense, [], 'Mavzuga mos yangi savol gap yozing.'],
    [`Write a new negative sentence for ${title}.`, tense, [], 'Mavzuga mos yangi inkor gap yozing.'],
    [`Write one more original sentence for ${title}.`, tense, [], 'O‘zingiz mustaqil yangi gap tuzing.']
  ];
  return templates.slice(0, count).map((item, index) => ({
    id: `fallback_w${index + 1}`,
    type: 'sentence_generation',
    section: 'Gap tuzish testi',
    title: 'Yangi gap tuzing',
    prompt: item[0],
    tense: item[1] || '',
    expected: item[2] || [],
    hint: item[3]
  }));
}

function makeWritingTasksDistinctFromChoice(tasks = [], choiceQuestions = [], title = '') {
  const result = [];
  const seen = new Set();
  for (const task of tasks || []) {
    const key = writingTaskText(task);
    if (!key || seen.has(key) || taskLooksSameAsChoice(task, choiceQuestions)) continue;
    result.push(task);
    seen.add(key);
  }
  for (const task of distinctFallbackWritingTasks(title)) {
    if (result.length >= tasks.length) break;
    const key = writingTaskText(task);
    if (!key || seen.has(key) || taskLooksSameAsChoice(task, choiceQuestions)) continue;
    result.push(task);
    seen.add(key);
  }
  return result.slice(0, tasks.length);
}

function buildWritingTasks(language, level, title, topicNo, vocabulary, choiceQuestions = []) {
  // Yoziladigan test + gap tuzish workbook pack mavjud bo‘lgan ingliz tili mavzularida chiqadi.
  // 1-mashq (tanlash) va 2-mashq (yozma) gaplari bir xil bo‘lib qolmasligi uchun yozma topshiriqlar filtrlanadi.
  if (!isThreePartWorkbookTopic(language, title)) return [];
  const workbookWritingTasks = buildWorkbookStyleWritingTasks(language, title);
  const distinctTasks = makeWritingTasksDistinctFromChoice(workbookWritingTasks, choiceQuestions, title);
  return distinctTasks.map((task, index) => ({ ...task, id: `w${index + 1}` }));
}


function expandWritingContractions(value = '') {
  // Inglizcha qisqartmalar ma'noni o'zgartirmaydi: she's = she is, I'm = I am.
  // Shuning uchun yozma mashqda qisqartmalar to'liq shaklga keltiriladi.
  return String(value)
    .replace(/\bi['’`´]m\b/gi, 'i am')
    .replace(/\byou['’`´]re\b/gi, 'you are')
    .replace(/\bhe['’`´]s\b/gi, 'he is')
    .replace(/\bshe['’`´]s\b/gi, 'she is')
    .replace(/\bit['’`´]s\b/gi, 'it is')
    .replace(/\bwe['’`´]re\b/gi, 'we are')
    .replace(/\bthey['’`´]re\b/gi, 'they are')
    .replace(/\bisn['’`´]t\b/gi, 'is not')
    .replace(/\baren['’`´]t\b/gi, 'are not')
    .replace(/\bam\s+not\b/gi, 'am not')
    .replace(/\bdon['’`´]t\b/gi, 'do not')
    .replace(/\bdoesn['’`´]t\b/gi, 'does not')
    .replace(/\bdidn['’`´]t\b/gi, 'did not')
    .replace(/\bcan['’`´]t\b/gi, 'cannot')
    .replace(/\bwon['’`´]t\b/gi, 'will not')
    .replace(/\bwouldn['’`´]t\b/gi, 'would not')
    .replace(/\bshouldn['’`´]t\b/gi, 'should not')
    .replace(/\bcouldn['’`´]t\b/gi, 'could not');
}

function normalizeWritingAnswer(value = '') {
  return expandWritingContractions(value)
    .toLowerCase()
    .normalize('NFKC')
    // O'quvchi apostrofni turlicha yozishi mumkin: o'quvchi, o‘quvchi, oʻquvchi, do'stlar va hokazo.
    // Bular mazmunga ta'sir qilmaydi, shuning uchun tekshiruvda bitta ko'rinishga keltiriladi.
    .replace(/[\u0027\u0060\u00b4\u2018\u2019\u201b\u02bb\u02bc\u02bd\u02be\u02bf]/g, '')
    // Gap oxiridagi nuqta, vergul, savol belgisi yoki undov belgisi majburiy emas.
    // Tekshiruvda tinish belgilari emas, ma'no va asosiy so'zlar hisobga olinadi.
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\bman\b/g, 'men')
    .replace(/\bsan\b/g, 'sen')
    .replace(/\s+/g, ' ')
    .trim();
}

function editSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 100;
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return Math.max(0, Math.round((1 - rows[a.length][b.length] / maxLen) * 100));
}

function writingSimilarity(expected, actual) {
  const a = normalizeWritingAnswer(expected);
  const b = normalizeWritingAnswer(actual);
  if (!a || !b) return 0;
  if (a === b) return 100;

  const aWords = a.split(' ').filter(Boolean);
  const bWords = b.split(' ').filter(Boolean);
  const aSet = new Set(aWords);
  const bSet = new Set(bWords);
  const common = [...aSet].filter(w => bSet.has(w)).length;
  const requiredCoverage = common / Math.max(1, aSet.size);
  const answerCoverage = common / Math.max(1, bSet.size);
  const lengthRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);

  // To'liq gap qo'shimcha so'zlar bilan yozilsa ham qabul qilinadi.
  if (b.includes(a) && requiredCoverage >= 0.9) return Math.max(95, Math.round(lengthRatio * 100));

  // Juda qisqa javoblarni (masalan: faqat "u") 80% qilib yubormaslik kerak.
  // Agar javob kutilgan gapning ichida bo'lsa ham, yetarli so'z va uzunlik bo'lmasa bal past qoladi.
  if (a.includes(b)) {
    if (requiredCoverage >= 0.8 && lengthRatio >= 0.75 && bWords.length >= Math.max(2, aWords.length - 1)) {
      return Math.max(85, Math.round(lengthRatio * 100));
    }
    return Math.min(55, Math.round(requiredCoverage * 60 + lengthRatio * 25));
  }

  const wordScore = Math.round(requiredCoverage * 100);
  const charScore = editSimilarity(a, b);

  // Inkor gaplarda "not/emas" tushib qolsa ma'no o'zgaradi, balni keskin pasaytiramiz.
  const expectedNegative = /\b(not|emas|yoq|yo'q)\b/.test(a);
  const actualNegative = /\b(not|emas|yoq|yo'q)\b/.test(b);
  const negationPenalty = expectedNegative !== actualNegative ? 35 : 0;

  const fullSentenceBonus = bWords.length >= Math.max(2, aWords.length - 1) ? 5 : -15;
  const raw = Math.round((charScore * 0.35) + (wordScore * 0.55) + (answerCoverage * 10) + fullSentenceBonus - negationPenalty);
  return Math.max(0, Math.min(100, raw));
}


function normalizeEnglishSentence(value = '') {
  return expandWritingContractions(value)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function englishWords(value = '') { return normalizeEnglishSentence(value).split(' ').filter(Boolean); }
function hasSubject(words) { return words.some(w => ['i','you','he','she','it','we','they','this','that','these','those'].includes(w)) || words.length >= 4; }
function hasIngVerb(words) { return words.some(w => w.endsWith('ing') && w.length > 4); }
function hasRegularPluralNoun(words) {
  const regularPluralWords = ['books','boxes','buses','babies','boys','watches','classes','tomatoes','toys','apples','cars','pens','cities','students'];
  return words.some(w => regularPluralWords.includes(w) || (/^[a-z]{3,}(s|es|ies)$/.test(w) && !['is','was','does','has'].includes(w)));
}
function hasIrregularPluralNoun(words) {
  return words.some(w => ['children','men','women','people','feet','teeth','mice','geese','sheep','fish'].includes(w));
}
function hasPastVerb(words) { return words.some(w => /ed$/.test(w) || ['went','saw','ate','read','wrote','did','was','were','came','made','took','got','had','played','watched','studied','worked'].includes(w)); }
function hasPastParticiple(words) { return words.some(w => /ed$/.test(w) || ['gone','seen','eaten','read','written','done','been','come','made','taken','got','had','played','watched','studied','worked','finished','visited'].includes(w)); }
function thirdPersonSubject(words) { return ['he','she','it'].includes(words[0]); }
function firstPersonSubject(words) { return words[0] === 'i'; }
function pluralSubject(words) { return ['you','we','they'].includes(words[0]); }
function subjectBeAgreementOk(words, forms) {
  const joined = words.join(' ');
  if (forms === 'present') {
    if (firstPersonSubject(words)) return joined.includes('i am ');
    if (thirdPersonSubject(words)) return /\b(he|she|it) is\b/.test(joined);
    if (pluralSubject(words)) return /\b(you|we|they) are\b/.test(joined);
    return /\b(am|is|are)\b/.test(joined);
  }
  if (forms === 'past') {
    if (firstPersonSubject(words) || thirdPersonSubject(words)) return /\b(i|he|she|it) was\b/.test(joined);
    if (pluralSubject(words)) return /\b(you|we|they) were\b/.test(joined);
    return /\b(was|were)\b/.test(joined);
  }
  return true;
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|\[\]\\]/g, '\\$&');
}
function containsWordPhrase(joined = '', phrase = '') {
  const normalized = normalizeEnglishSentence(phrase);
  if (!normalized) return true;
  return new RegExp(`(^| )${escapeRegExp(normalized)}( |$)`).test(joined);
}
function quotedPhrasesFromPrompt(prompt = '') {
  const phrases = [];
  const rx = /[“"]([^”"]+)[”"]/g;
  let match;
  while ((match = rx.exec(String(prompt || ''))) !== null) {
    const phrase = normalizeEnglishSentence(match[1]);
    if (phrase && !phrase.includes('/')) phrases.push(phrase);
  }
  return phrases;
}
function sentenceFormInfo(answer = '', words = [], joined = '') {
  const raw = String(answer || '').trim();
  const startsWithAux = /^(am|is|are|do|does|did|can|could|should|must|may|might|will|would|have|has|was|were)\s+/.test(joined);
  const startsWithWhAux = /^(who|what|where|when|why|how)\s+(am|is|are|do|does|did|can|could|should|must|may|might|will|would|have|has|was|were)\b/.test(joined);
  const isQuestion = /\?\s*$/.test(raw) || startsWithAux || startsWithWhAux;
  const isNegative = /\b(not|cannot|do not|does not|did not|will not|would not|should not|could not|am not|is not|are not|was not|were not|have not|has not)\b/.test(joined);
  return { isQuestion, isNegative, isPositive: !isQuestion && !isNegative };
}
function promptRequirementInfo(task) {
  const rawPrompt = String(task?.prompt || '');
  const promptText = normalizeEnglishSentence(rawPrompt);
  const requiresQuestion = /\b(question|savol)\b/.test(promptText);
  const requiresNegative = /\b(negative|inkor)\b/.test(promptText) || /\b(not|cannot|can t|does not|do not|isn t|aren t|there isn t|there aren t)\b/.test(promptText);
  const requiresPositive = /\b(positive|ijobiy|darak)\b/.test(promptText);
  return { rawPrompt, promptText, requiresQuestion, requiresNegative, requiresPositive };
}
function stripLeadingPresentContinuousMarker(joined = '') {
  // Present Continuous gap tuzishda keyword boshida yoki oxirida kelishi mumkin:
  // “Now I am reading.” ham, “I am reading now.” ham qabul qilinadi.
  return String(joined || '')
    .replace(/^(now|right now|currently|today|these days)\s+/, '')
    .replace(/^at the moment\s+/, '')
    .trim();
}

function strictSentenceRequirementFailure(task, answer, words, joined) {
  const { rawPrompt, promptText, requiresQuestion, requiresNegative, requiresPositive } = promptRequirementInfo(task);
  const form = sentenceFormInfo(answer, words, joined);
  const tense = task?.tense || '';

  if (words.length < 3) return '0%: to‘liq gap yozilmagan. Kamida ega + fe’l + qolgan qism bo‘lishi kerak.';
  if (!hasSubject(words) && !/^look\b/.test(joined)) return '0%: gapda ega yo‘q. I, you, he, she, it, we, they kabi ega ishlating.';

  if (requiresPositive && !form.isPositive) return '0%: topshiriqda darak/positive gap so‘ralgan. Inkor yoki savol gap qabul qilinmaydi.';
  if (requiresNegative && (!form.isNegative || form.isQuestion)) return '0%: topshiriqda inkor/negative gap so‘ralgan. Aynan inkor gap yozing, savol yoki darak gap emas.';
  if (requiresQuestion && !form.isQuestion) return '0%: topshiriqda savol/question gap so‘ralgan. Javob savol tartibida yozilishi kerak.';

  for (const phrase of quotedPhrasesFromPrompt(rawPrompt)) {
    if (['i you we they', 'he she it', 'a an'].includes(phrase)) continue;
    // Present Continuousda keyword joylashuvi erkin: boshida, o‘rtasida yoki oxirida bo‘lsa ham mayli.
    // Muhimi keyword ishlatilgan va gap am/is/are + V-ing tuzilmasida to‘g‘ri bo‘lsin.
    if (/starting with/.test(promptText) && tense !== 'present_continuous') {
      if (!joined.startsWith(phrase)) return `0%: topshiriqda gap “${phrase}” bilan boshlanishi so‘ralgan.`;
    } else if (!containsWordPhrase(joined, phrase)) {
      return `0%: topshiriqda “${phrase}” ishlatish so‘ralgan. Javobda shu so‘z/ibora bo‘lishi shart.`;
    }
  }

  if (tense === 'present_simple') {
    const firstWord = words[0] || '';
    const requiresIYouWeThey = /i\s*\/\s*you\s*\/\s*we\s*\/\s*they/.test(rawPrompt.toLowerCase());
    const requiresHeSheIt = /he\s*\/\s*she\s*\/\s*it/.test(rawPrompt.toLowerCase());
    const requiresDoQuestion = /\bdo\b/.test(promptText) && requiresQuestion;
    const requiresDoesQuestion = /\bdoes\b/.test(promptText) && requiresQuestion;
    const baseVerbs = ['go','play','read','write','study','work','speak','like','watch','open','come','drink','live','eat','sleep','walk','run','learn','teach','help','clean','cook','drive','buy','sell','use','need','want','love','visit','start','finish','make','take'];
    const thirdForms = ['goes','plays','reads','writes','studies','works','speaks','likes','watches','opens','comes','drinks','lives','eats','sleeps','walks','runs','learns','teaches','helps','cleans','cooks','drives','buys','sells','uses','needs','wants','loves','visits','starts','finishes','makes','takes'];
    const hasBaseVerb = words.some(w => baseVerbs.includes(w));
    const hasThirdVerb = words.some(w => thirdForms.includes(w));
    const isDoQuestion = /^do\s+(i|you|we|they)\s+[a-z]+\b/.test(joined);
    const isDoesQuestion = /^does\s+(he|she|it)\s+[a-z]+\b/.test(joined);
    const isSimpleNegative = /^(i|you|we|they)\s+do not\s+[a-z]+\b/.test(joined) || /^(he|she|it)\s+does not\s+[a-z]+\b/.test(joined);
    const isSimplePositive = /^(i|you|we|they)\s+[a-z]+\b/.test(joined) || /^(he|she|it)\s+[a-z]+\b/.test(joined);
    const verbAfterQuestionAux = words[2] || '';
    const verbAfterNegativeAux = words[3] || '';

    // Present Simple topshirig'ida boshqa zamon, boshqa vaqt markeri yoki boshqa grammatika o'tmasin.
    // Masalan: I am playing now / I played yesterday / I will play tomorrow / I have played — barchasi 0%.
    const hasPresentContinuousForm = /\b(am|is|are)\s+(not\s+)?[a-z]+ing\b/.test(joined);
    const hasPastAuxiliary = /\b(was|were|did|had)\b/.test(joined);
    const hasFutureAuxiliary = /\b(will|would|shall)\b|\bgoing to\b/.test(joined);
    const hasModalVerb = /\b(can|cannot|could|should|must|may|might)\b/.test(joined);
    const hasPresentPerfectForm = /\b(have|has)\s+(been|gone|seen|eaten|written|done|finished|visited|played|watched|worked|studied|lived|opened|started|made|taken)\b/.test(joined);
    const pastTimeMarker = /\b(yesterday|ago)\b|\blast\s+(night|week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday|summer|winter|spring|autumn)\b/.test(joined);
    const futureTimeMarker = /\b(tomorrow|soon)\b|\bnext\s+(week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday|summer|winter|spring|autumn)\b/.test(joined);
    const continuousTimeMarker = /\b(now|right now|at the moment|currently)\b/.test(joined);
    const pastVerbForms = ['went','saw','ate','wrote','came','made','took','got','had','slept','drove','bought','sold','ran','drank','began','broke','chose','found','gave','knew','left','met','paid','put','said','sat','sent','spoke','stood','swam','taught','thought','understood','won'];
    const hasClearPastVerb = words.some(w => pastVerbForms.includes(w) || (/^[a-z]{3,}ed$/.test(w) && !['need','read'].includes(w)));

    if (hasPresentContinuousForm) return '0%: bu Present Continuous bo‘lib qolgan. Present Simple yozish kerak.';
    if (hasPastAuxiliary || pastTimeMarker || hasClearPastVerb) return '0%: bu Past Simple/Past zamonga o‘xshaydi. Present Simple yozing.';
    if (hasFutureAuxiliary || futureTimeMarker) return '0%: bu Future/Kelasi zamonga o‘xshaydi. Present Simple yozing.';
    if (hasPresentPerfectForm) return '0%: bu Present Perfectga o‘xshaydi. Present Simple yozing.';
    if (continuousTimeMarker) return '0%: “now / at the moment” Present Continuous belgisi. Present Simpleda odat/doimiy holat yozing.';
    if (hasModalVerb) return '0%: bu modal fe’l bilan gap. Present Simple mashqida do/does yoki V1/V-s shakli kerak.';
    if (/^(am|is|are)\s+/.test(joined) || /^(i|you|we|they|he|she|it)\s+(am|is|are)\b/.test(joined)) return '0%: bu TO BE gap. Present Simple mashqida V1 yoki he/she/it + V-s/es ishlating.';
    if (requiresDoQuestion && !isDoQuestion) return '0%: bu topshiriqda Do + I/you/we/they + V1 shaklidagi savol kerak.';
    if (requiresDoesQuestion && !isDoesQuestion) return '0%: bu topshiriqda Does + he/she/it + V1 shaklidagi savol kerak.';
    if (requiresQuestion && !(isDoQuestion || isDoesQuestion)) return '0%: Present Simple savolida gap Do/Does bilan boshlanishi kerak.';
    if ((isDoQuestion || isDoesQuestion) && thirdForms.includes(verbAfterQuestionAux)) return '0%: Do/Does dan keyin fe’l V1 bo‘ladi, -s/-es qo‘shilmaydi.';
    if (requiresNegative && !isSimpleNegative) return '0%: Present Simple inkorda subject + do/does not + V1 shakli kerak.';
    if (isSimpleNegative && thirdForms.includes(verbAfterNegativeAux)) return '0%: do/does not dan keyin fe’l V1 bo‘ladi, -s/-es qo‘shilmaydi.';
    if (requiresIYouWeThey && !(/^(i|you|we|they)\b/.test(joined) || /^do\s+(i|you|we|they)\b/.test(joined))) return '0%: topshiriqda I/you/we/they guruhi so‘ralgan.';
    if (requiresHeSheIt && !(/^(he|she|it)\b/.test(joined) || /^does\s+(he|she|it)\b/.test(joined))) return '0%: topshiriqda he/she/it guruhi so‘ralgan.';
    if (form.isPositive) {
      if (['i','you','we','they'].includes(firstWord) && !hasBaseVerb) return '0%: I/you/we/they bilan darak gapda fe’l V1 bo‘lishi kerak.';
      if (['he','she','it'].includes(firstWord) && !hasThirdVerb) return '0%: he/she/it bilan darak gapda fe’lga -s/-es qo‘shilishi kerak.';
      if (['i','you','we','they'].includes(firstWord) && hasThirdVerb) return '0%: I/you/we/they bilan fe’lga -s/-es qo‘shilmaydi.';
      if (['he','she','it'].includes(firstWord) && hasBaseVerb && !hasThirdVerb) return '0%: he/she/it bilan V1 emas, V-s/es kerak.';
    }
    if (!(isDoQuestion || isDoesQuestion || isSimpleNegative || (isSimplePositive && (hasBaseVerb || hasThirdVerb)))) return '0%: Present Simple tuzilmasi ko‘rinmadi.';
  }

  if (tense === 'present_continuous') {
    const continuousCore = stripLeadingPresentContinuousMarker(joined);
    const coreWords = englishWords(continuousCore);
    const isContinuousPositive = /^(i\s+am|you\s+are|we\s+are|they\s+are|he\s+is|she\s+is|it\s+is)\s+[a-z]+ing\b/.test(continuousCore);
    const isContinuousQuestion = /^(am|is|are)\s+(i|you|he|she|it|we|they)\s+(not\s+)?[a-z]+ing\b/.test(continuousCore);
    const isContinuousNegative = /^(i\s+am|you\s+are|we\s+are|they\s+are|he\s+is|she\s+is|it\s+is)\s+not\s+[a-z]+ing\b/.test(continuousCore);
    const isContinuous = isContinuousPositive || isContinuousQuestion || isContinuousNegative;
    if (/\b(do|does|did|will|would)\b|\bgoing to\b/.test(joined)) return '0%: boshqa zamon/yordamchi fe’l ishlatilgan. Present Continuousda am/is/are + V-ing kerak.';
    if (!isContinuous) return '0%: Present Continuous uchun am/is/are + V-ing bo‘lishi shart. Keyword boshida yoki oxirida bo‘lishi mumkin.';
    if (requiresQuestion && !isContinuousQuestion) return '0%: Present Continuous savolda Am/Is/Are + subject + V-ing tartibi kerak.';
    if (requiresNegative && !isContinuousNegative) return '0%: Present Continuous inkorda subject + am/is/are + not + V-ing kerak.';
    if (requiresPositive && (form.isQuestion || form.isNegative)) return '0%: ijobiy Present Continuous gap kerak.';
    if (!subjectBeAgreementOk(coreWords, 'present') && !/^look\b/.test(continuousCore)) return '0%: ega bilan am/is/are mos emas.';
  }

  if (tense === 'to_be') {
    if (/\b(do|does|did|will|going to)\b/.test(joined)) return '0%: TO BE mashqida do/does/did/will ishlatilmaydi.';
    if (/\b(am|is|are)\s+(not\s+)?[a-z]+ing\b/.test(joined)) return '0%: bu Present Continuous. TO BE gapda am/is/are + holat/ot/sifat bo‘lishi kerak.';
    if (!/\b(am|is|are)\b/.test(joined)) return '0%: TO BE mavzusida am/is/are ishlatilishi shart.';
    if (requiresQuestion && !/^(am|is|are)\s+/.test(joined)) return '0%: TO BE savolda Am/Is/Are gap boshida keladi.';
    if (requiresNegative && !/\b(am|is|are)\s+not\b/.test(joined)) return '0%: TO BE inkorda am/is/are + not kerak.';
    if (requiresPositive && (form.isQuestion || form.isNegative)) return '0%: ijobiy TO BE gap kerak.';
    if (!subjectBeAgreementOk(words, 'present')) return '0%: ega bilan am/is/are mos emas.';
  }

  if (tense === 'there_is_are' || tense === 'there_is' || tense === 'there_are') {
    const isTherePositive = /^there\s+(is|are)\b/.test(joined);
    const isThereNegative = /^there\s+(is|are)\s+not\b/.test(joined);
    const isThereQuestion = /^(is|are)\s+there\b/.test(joined);
    if (!(isTherePositive || isThereNegative || isThereQuestion)) return '0%: There is / There are tuzilmasi ishlatilishi shart.';
    if (requiresQuestion && !isThereQuestion) return '0%: savolda Is there yoki Are there bilan boshlang.';
    if (requiresNegative && !isThereNegative) return '0%: inkorda There is not yoki There are not kerak.';
    if (requiresPositive && !isTherePositive) return '0%: darak gapda There is yoki There are bilan boshlang.';
    if (/there\s+is\s+(two|three|four|five|many|some|students|books|chairs|bags|windows)\b/.test(joined)) return '0%: ko‘plik ot bilan There are ishlatiladi.';
    if (/there\s+are\s+(a|an)\b/.test(joined)) return '0%: birlik ot bilan There is ishlatiladi.';
  }

  if (tense === 'have_has') {
    const requiresHas = /[“"]has[”"]|with\s+has/.test(rawPrompt.toLowerCase());
    const requiresHave = /[“"]have[”"]|with\s+have/.test(rawPrompt.toLowerCase());
    if (/\b(had|having|have got|has got)\b/.test(joined)) return '0%: bu mashqda faqat have yoki has ishlating.';
    if (!/\b(have|has)\b/.test(joined)) return '0%: Have yoki has ishlatilishi shart.';
    if (requiresHas && !/\bhas\b/.test(joined)) return '0%: topshiriqda “has” so‘ralgan.';
    if (requiresHave && !/\bhave\b/.test(joined)) return '0%: topshiriqda “have” so‘ralgan.';
    if (/\b(he|she|it)\s+have\b/.test(joined)) return '0%: he/she/it bilan has ishlatiladi.';
    if (/\b(i|you|we|they)\s+has\b/.test(joined)) return '0%: I/you/we/they bilan have ishlatiladi.';
  }

  if (tense === 'modal' || tense === 'should') {
    const modal = promptText.includes('should') ? 'should' : promptText.includes('must') ? 'must' : promptText.includes('can') || promptText.includes('cannot') ? 'can' : '';
    if (modal === 'can') {
      if (promptText.includes('cannot') || promptText.includes('can t')) {
        if (!/\bcannot\b/.test(joined)) return '0%: topshiriqda can’t/cannot ishlatish so‘ralgan.';
      } else if (!/\bcan\b/.test(joined)) return '0%: topshiriqda can ishlatish so‘ralgan.';
    } else if (modal && !new RegExp(`\b${modal}\b`).test(joined)) return `0%: topshiriqda ${modal} modal fe’li ishlatilishi kerak.`;
    if (!/\b(can|cannot|should|could|must|might|may)\b/.test(joined)) return '0%: modal fe’l ishlatilishi shart.';
    if (requiresQuestion && !/^(can|should|could|must|might|may)\s+/.test(joined)) return '0%: modal savolda modal fe’l gap boshida keladi.';
    if (requiresNegative && !/\b(cannot|not)\b/.test(joined)) return '0%: modal inkor gapda not/cannot bo‘lishi kerak.';
    if (/\b(can|cannot|should|could|must|might|may)\s+to\b/.test(joined)) return '0%: modal fe’ldan keyin “to” kelmaydi.';
  }

  if (tense === 'question_word') {
    if (!/^(who|what)\b/.test(joined)) return '0%: savol Who yoki What bilan boshlanishi kerak.';
    if (!form.isQuestion) return '0%: Who/What topshirig‘ida to‘liq savol gap yozing.';
    if (containsWordPhrase(promptText, 'who is') && !/^who\s+is\b/.test(joined)) return '0%: topshiriqda Who is shakli so‘ralgan.';
    if (containsWordPhrase(promptText, 'who are') && !/^who\s+are\b/.test(joined)) return '0%: topshiriqda Who are shakli so‘ralgan.';
    if (containsWordPhrase(promptText, 'what is') && !/^what\s+is\b/.test(joined)) return '0%: topshiriqda What is shakli so‘ralgan.';
    if (containsWordPhrase(promptText, 'what do') && !/^what\s+do\b/.test(joined)) return '0%: topshiriqda What do shakli so‘ralgan.';
    if (containsWordPhrase(promptText, 'what are') && !/^what\s+are\b/.test(joined)) return '0%: topshiriqda What are shakli so‘ralgan.';
  }

  if (tense === 'prep_place') {
    if (!/\b(in|on|under|behind|between|near|next to|in front of)\b/.test(joined)) return '0%: joy predlogi ishlatilishi shart.';
  }
  if (tense === 'prep_time') {
    if (!/\b(at|on|in)\b/.test(joined)) return '0%: vaqt predlogi at/on/in ishlatilishi shart.';
    if (/\bon\s+(\d{1,2}:\d{2}|seven|eight|nine|ten|eleven|twelve|8|9|10|11|12)\b/.test(joined)) return '0%: aniq soat uchun on emas, at ishlatiladi.';
  }

  return '';
}
function scoreGeneratedSentence(task, answer) {
  if (!String(answer || '').trim()) {
    return { score: 0, ok: false, note: 'Javob yozilmagan. Topshiriqda so‘ralgan mavzuga mos to‘liq gap yozish kerak.' };
  }
  const words = englishWords(answer);
  const joined = words.join(' ');
  const errors = [];
  let score = 100;
  if (words.length < 3) { errors.push('To‘liq gap yozing: kamida ega + fe’l + qolgan qism bo‘lsin.'); score -= 35; }
  if (!hasSubject(words)) { errors.push('Gapda ega aniq bo‘lsin: I, you, he, she, we, they kabi.'); score -= 20; }
  const tense = task.tense || '';
  const strictFailure = strictSentenceRequirementFailure(task, answer, words, joined);
  if (strictFailure) {
    return { score: 0, ok: false, note: strictFailure };
  }
  if (tense === 'present_continuous') {
    if (!/\b(am|is|are)\b/.test(joined)) { errors.push('Present Continuousda am/is/are yordamchi fe’li kerak.'); score -= 30; }
    if (!hasIngVerb(words)) { errors.push('Present Continuousda asosiy fe’l -ing shaklida bo‘lishi kerak: reading, playing.'); score -= 30; }
    if (/\b(do|does|did)\b/.test(joined)) { errors.push('Present Continuousda do/does/did emas, am/is/are ishlatiladi.'); score -= 15; }
    if (!subjectBeAgreementOk(words, 'present')) { errors.push('Ega bilan am/is/are mos emas: I am, he/she/it is, you/we/they are.'); score -= 20; }
  } else if (tense === 'present_simple') {
    const promptText = String(task.prompt || '').toLowerCase();
    const rawAnswer = String(answer || '').trim();
    const firstWord = words[0] || '';
    const requiresIYouWeThey = /i\s*\/\s*you\s*\/\s*we\s*\/\s*they/.test(promptText);
    const requiresHeSheIt = /he\s*\/\s*she\s*\/\s*it/.test(promptText);
    const requiresDoQuestion = /question[^.]*\bdo\b|savol[^.]*\bdo\b|\bdo\s*\+\s*(i|you|we|they|subject)/.test(promptText);
    const requiresDoesQuestion = /question[^.]*\bdoes\b|savol[^.]*\bdoes\b|\bdoes\s*\+\s*(he|she|it|subject)/.test(promptText);
    const requiresNegative = /negative|inkor/.test(promptText);
    const requiresPositive = /positive|ijobiy/.test(promptText);
    const requiresQuestion = requiresDoQuestion || requiresDoesQuestion || /question|savol/.test(promptText);
    const isDoQuestion = /^do\s+(i|you|we|they)\b/.test(joined);
    const isDoesQuestion = /^does\s+(he|she|it)\b/.test(joined);
    const startsAsQuestion = /^(do|does)\s+/.test(joined);
    const isQuestion = /\?\s*$/.test(rawAnswer) || startsAsQuestion;
    const isNegative = /\bdo not\b|\bdoes not\b|\bdont\b|\bdoesnt\b/.test(joined);
    const actualForm = isQuestion ? 'question' : isNegative ? 'negative' : 'positive';
    const presentSimpleBaseVerbs = ['go','play','read','write','study','work','speak','like','watch','open','come','drink','live','eat','sleep','walk','run','learn','teach','help','clean','cook','drive','buy','sell','use','need','want','love','visit','start','finish','make','take'];
    const presentSimpleThirdForms = ['goes','plays','reads','writes','studies','works','speaks','likes','watches','opens','comes','drinks','lives','eats','sleeps','walks','runs','learns','teaches','helps','cleans','cooks','drives','buys','sells','uses','needs','wants','loves','visits','starts','finishes','makes','takes'];
    const hasBaseVerb = words.some(w => presentSimpleBaseVerbs.includes(w));
    const hasThirdVerb = words.some(w => presentSimpleThirdForms.includes(w));

    // Present Simple gap tuzishda topshiriq turi qat'iy tekshiriladi:
    // positive so'ralsa inkor/savol o'tmaydi, negative so'ralsa positive/savol o'tmaydi,
    // question so'ralsa oddiy darak/inkor gap o'tmaydi.
    if (requiresPositive && actualForm !== 'positive') {
      errors.push('Topshiriqda positive/darak gap so‘ralgan. Inkor yoki savol gap bu topshiriqqa mos emas.');
      score = Math.min(score - 45, 45);
    }
    if (requiresNegative && actualForm !== 'negative') {
      errors.push('Topshiriqda negative/inkor gap so‘ralgan. Gapda do not yoki does not bo‘lishi kerak.');
      score = Math.min(score - 45, 45);
    }
    if (requiresQuestion && actualForm !== 'question') {
      errors.push('Topshiriqda question/savol gap so‘ralgan. Gap Do yoki Does bilan boshlanishi kerak.');
      score = Math.min(score - 50, 40);
    }
    if (requiresQuestion && isNegative && !isQuestion) {
      errors.push('Bu inkor gap, savol emas. Savol gapda Do/Does boshida keladi.');
      score = Math.min(score, 35);
    }

    if (/\b(am|is|are)\s+\w+ing\b/.test(joined)) { errors.push('Bu Present Continuousga o‘xshab ketdi. Present Simpleda odat yoki doimiy holat yozing.'); score -= 25; }
    if (/\bdoes\s+\w+s\b/.test(joined)) { errors.push('Does dan keyin fe’lga -s qo‘shilmaydi: Does he play?'); score -= 25; }
    if (/^(he|she|it)\s+(go|play|read|write|study|work|speak|like|watch|open|come|drink|live|eat|sleep|walk|run|learn|teach|help)\b/.test(joined) && actualForm === 'positive') {
      errors.push('He/she/it bilan ijobiy gapda fe’lga -s/-es qo‘shiladi: she plays.');
      score -= 30;
    }
    if (/^(he|she|it)\s+(do not|don t|dont)\b/.test(joined)) { errors.push('He/she/it bilan inkorda does not ishlatiladi.'); score -= 30; }
    if (/^(i|you|we|they)\s+does not\b/.test(joined)) { errors.push('I/you/we/they bilan inkorda do not ishlatiladi.'); score -= 30; }

    if (requiresIYouWeThey) {
      const allowedGroup = ['i', 'you', 'we', 'they'];
      if (requiresQuestion) {
        if (!isDoQuestion) {
          errors.push('Topshiriqda I/you/we/they guruhi bilan savol so‘ralgan. Javob Do + I/you/we/they + V1 shaklida bo‘lsin.');
          score = Math.min(score - 55, 35);
        }
      } else if (!allowedGroup.includes(firstWord)) {
        errors.push('Topshiriqda I/you/we/they bilan gap tuzish so‘ralgan. He/she/it bilan yozilgan gap bu topshiriqqa mos emas.');
        score = Math.min(score - 60, 35);
      }
      if (/^(he|she|it)\b/.test(joined) || /^does\s+(he|she|it)\b/.test(joined)) score = Math.min(score, 30);
      if (requiresNegative && !/^((i|you|we|they)\s+do not\b)/.test(joined)) {
        errors.push('I/you/we/they bilan inkorda do not ishlating.');
        score = Math.min(score - 30, 45);
      }
    }

    if (requiresHeSheIt) {
      const thirdGroup = ['he', 'she', 'it'];
      if (requiresQuestion) {
        if (!isDoesQuestion) {
          errors.push('Topshiriqda he/she/it guruhi bilan savol so‘ralgan. Javob Does + he/she/it + V1 shaklida bo‘lsin.');
          score = Math.min(score - 55, 35);
        }
      } else if (!thirdGroup.includes(firstWord)) {
        errors.push('Topshiriqda he/she/it bilan gap tuzish so‘ralgan. I/you/we/they bilan yozilgan gap bu topshiriqqa mos emas.');
        score = Math.min(score - 60, 35);
      }
      if (/^(i|you|we|they)\b/.test(joined) || /^do\s+(i|you|we|they)\b/.test(joined)) score = Math.min(score, 30);
      if (requiresNegative && !/^((he|she|it)\s+does not\b)/.test(joined)) {
        errors.push('He/she/it bilan inkorda does not ishlating.');
        score = Math.min(score - 30, 45);
      }
    }

    if (requiresDoQuestion && !isDoQuestion) { errors.push('Bu topshiriqda Do bilan savol tuzish kerak.'); score = Math.min(score - 35, 40); }
    if (requiresDoesQuestion && !isDoesQuestion) { errors.push('Bu topshiriqda Does bilan savol tuzish kerak.'); score = Math.min(score - 35, 40); }
    if (requiresNegative && !isNegative) { errors.push('Bu topshiriqda inkor gap so‘ralgan, do not yoki does not ishlating.'); score = Math.min(score - 35, 45); }
    if (requiresPositive && (isNegative || isQuestion)) { errors.push('Bu topshiriqda ijobiy gap so‘ralgan, inkor yoki savol gap emas.'); score = Math.min(score - 35, 45); }

    if (actualForm === 'question' && !/^do\s+(i|you|we|they)\s+\w+|^does\s+(he|she|it)\s+\w+/.test(joined)) {
      errors.push('Present Simple savolda tartib: Do/Does + subject + V1.');
      score -= 25;
    }
    if (actualForm === 'negative' && !/^(i|you|we|they)\s+do not\s+\w+|^(he|she|it)\s+does not\s+\w+/.test(joined)) {
      errors.push('Present Simple inkorda tartib: subject + do/does not + V1.');
      score -= 20;
    }
    if (actualForm === 'positive' && requiresIYouWeThey && !hasBaseVerb) { errors.push('I/you/we/they bilan positive gapda fe‘l V1 bo‘lsin.'); score -= 15; }
    if (actualForm === 'positive' && requiresHeSheIt && !hasThirdVerb) { errors.push('He/she/it bilan positive gapda fe‘l -s/-es shaklda bo‘lsin.'); score -= 15; }
    if (!hasBaseVerb && !hasThirdVerb && !words.some(w => ['do','does','always','usually','often','sometimes','every','never'].includes(w))) { errors.push('Present Simple belgisi ko‘rinsin: V1, he/she/it + V+s yoki every day/usually kabi so‘zlar.'); score -= 15; }
  } else if (tense === 'plural_regular') {
    if (!hasRegularPluralNoun(words)) { errors.push('Regular plural noun ishlating: books, cars, boxes, babies kabi.'); score -= 35; }
    if (hasIrregularPluralNoun(words)) { errors.push('Bu mavzuda regular plural kerak, irregular plural emas.'); score -= 15; }
  } else if (tense === 'plural_irregular') {
    if (!hasIrregularPluralNoun(words)) { errors.push('Irregular plural noun ishlating: children, men, women, people, feet, teeth, mice kabi.'); score -= 35; }
  } else if (tense === 'article') {
    const p = String(task.prompt || '').toLowerCase();
    if (p.includes('“an”') || p.includes('with an')) {
      if (!words.includes('an')) { errors.push('Topshiriqda “an” talab qilingan. Unli tovushdan oldin an ishlatiladi.'); score -= 30; }
    } else if (p.includes('“a”') || p.includes('with a')) {
      if (!words.includes('a')) { errors.push('Topshiriqda “a” talab qilingan. Undosh tovushdan oldin a ishlatiladi.'); score -= 30; }
    } else if (p.includes('without a/an')) {
      if (/\b(a|an)\b/.test(joined)) { errors.push('Ko‘plik ot oldidan a/an ishlatilmaydi.'); score -= 30; }
    } else if (!/\b(a|an)\b/.test(joined)) {
      errors.push('Bu mavzuda a yoki an artiklini to‘g‘ri ishlating.'); score -= 25;
    }
  } else if (tense === 'subject_pronoun') {
    const p = String(task.prompt || '').toLowerCase();
    const pronouns = ['i','you','he','she','it','we','they'];
    const required = pronouns.find(pr => p.includes(`“${pr}”`) || p.includes(`"${pr}"`));
    if (required && !words.includes(required)) { errors.push(`Topshiriqda “${required}” subject pronoun ishlatish so‘ralgan.`); score -= 35; }
    if (!words.some(w => pronouns.includes(w))) { errors.push('Gapda subject pronoun bo‘lsin: I, you, he, she, it, we, they.'); score -= 30; }
  } else if (tense === 'to_be') {
    if (!/\b(am|is|are)\b/.test(joined)) { errors.push('TO BE mavzusida am/is/are ishlatilishi kerak.'); score -= 35; }
    if (/\b(do|does|did)\b/.test(joined)) { errors.push('TO BE gaplarida odatda do/does emas, am/is/are ishlatiladi.'); score -= 15; }
    if (!subjectBeAgreementOk(words, 'present')) { errors.push('Ega bilan to be mos bo‘lsin: I am, he/she/it is, you/we/they are.'); score -= 20; }
  } else if (tense === 'there_is_are' || tense === 'there_is' || tense === 'there_are') {
    if (!/\bthere\s+(is|are|isn t|isnt|are not|aren t|arent)\b/.test(joined) && !/\b(is|are)\s+there\b/.test(joined)) { errors.push('There is / There are shaklidan foydalaning.'); score -= 35; }
    const p = String(task.prompt || '').toLowerCase();
    const asksEitherQuestion = p.includes('is there / are there');
    if (tense === 'there_is' && !asksEitherQuestion && !/\bthere\s+(is|isn t|isnt)\b|\bis\s+there\b/.test(joined)) { errors.push('Bu topshiriqda There is yoki Is there shakli kerak.'); score -= 25; }
    if (tense === 'there_are' && !/\bthere\s+(are|are not|aren t|arent)\b|\bare\s+there\b/.test(joined)) { errors.push('Bu topshiriqda There are yoki Are there shakli kerak.'); score -= 25; }
    if (/\bthere\s+is\s+(two|three|four|five|many|students|books|chairs|bags|windows)\b/.test(joined)) { errors.push('Ko‘plik ot bilan there are ishlatiladi.'); score -= 20; }
    if (/\bthere\s+are\s+(a|an)\b/.test(joined)) { errors.push('Birlik ot bilan there is ishlatiladi.'); score -= 20; }
  } else if (tense === 'have_has') {
    const promptText = String(task.prompt || '').toLowerCase();
    const requiresHas = /[“\"]has[”\"]|with\s+has/.test(promptText);
    const requiresHave = /[“\"]have[”\"]|with\s+have/.test(promptText);
    if (!/\b(have|has)\b/.test(joined)) { errors.push('Have yoki has ishlating.'); score -= 45; }
    if (requiresHas && !/\bhas\b/.test(joined)) { errors.push('Topshiriqda “has” so‘zi talab qilingan. Javobda has bo‘lishi kerak.'); score -= 60; }
    if (requiresHave && !/\bhave\b/.test(joined)) { errors.push('Topshiriqda “have” so‘zi talab qilingan. Javobda have bo‘lishi kerak.'); score -= 60; }
    if (requiresHas && /\bhave\b/.test(joined) && !/\bhas\b/.test(joined)) { score = Math.min(score, 40); }
    if (requiresHave && /\bhas\b/.test(joined) && !/\bhave\b/.test(joined)) { score = Math.min(score, 40); }
    if (/\b(he|she|it)\s+have\b/.test(joined)) { errors.push('He/she/it bilan ijobiy gapda has ishlatiladi.'); score -= 25; }
    if (/\b(i|you|we|they)\s+has\b/.test(joined)) { errors.push('I/you/we/they bilan have ishlatiladi.'); score -= 25; }
    if (/\b(had|having|have got|has got|haven t got|hasn t got)\b/.test(joined)) { errors.push('Bu mashqda faqat have yoki has ishlating, boshqa zamon/shakl kerak emas.'); score -= 30; }
  } else if (tense === 'question_word') {
    if (!/\b(who|what)\b/.test(joined)) { errors.push('Who yoki What savol so‘zidan foydalaning.'); score -= 35; }
    if (/^what\s+(your|you|he|she|they)\b/.test(joined)) { errors.push('What savolida ko‘pincha yordamchi fe’l kerak: What is...? / What do...?'); score -= 20; }
    if (/^who\s+(your|you|he|she|they)\b/.test(joined)) { errors.push('Who savolida to be yoki yordamchi fe’lni qo‘shing: Who is...?'); score -= 20; }
  } else if (tense === 'prep_place') {
    if (!/\b(in|on|under|behind|between|near|next to|in front of)\b/.test(joined)) { errors.push('Joy predlogi ishlating: in, on, under, behind, between, next to.'); score -= 35; }
  } else if (tense === 'prep_time') {
    if (!/\b(at|on|in)\b/.test(joined)) { errors.push('Vaqt predlogi ishlating: at, on yoki in.'); score -= 35; }
    if (/\bon\s+(\d{1,2}:\d{2}|seven|eight|nine|ten|eleven|twelve)\b/.test(joined)) { errors.push('Aniq soat uchun at ishlatiladi.'); score -= 15; }
  } else if (tense === 'present_simple_vs_continuous') {
    const hasSimpleMarker = /\b(usually|often|every|always|never|does|do|works|plays|walks|studies|goes|opens)\b/.test(joined);
    const hasContinuousMarker = /\b(am|is|are)\s+\w+ing\b/.test(joined);
    if (!hasSimpleMarker || !hasContinuousMarker) { errors.push('Bu javobda odat uchun Present Simple va hozirgi/vaqtinchalik ish uchun Present Continuous ko‘rinsin.'); score -= 35; }
  } else if (tense === 'past_simple') {
    if (/\bdid\s+\w+(ed|went|saw|ate|wrote)\b/.test(joined)) { errors.push('Did dan keyin fe’l V1 bo‘ladi: did go, did write.'); score -= 25; }
    if (!hasPastVerb(words) && !words.includes('did')) { errors.push('Past Simpleda V2 yoki -ed shakli kerak: went, watched, studied.'); score -= 30; }
  } else if (tense === 'future_going_to') {
    if (!joined.includes('going to')) { errors.push('Future going to tuzilmasida “going to” bo‘lishi kerak.'); score -= 35; }
    if (!/\b(am|is|are)\b/.test(joined)) { errors.push('Going to oldidan am/is/are kerak.'); score -= 25; }
    if (!subjectBeAgreementOk(words, 'present')) { errors.push('Ega bilan am/is/are mos emas: I am going to, she is going to, they are going to.'); score -= 20; }
  } else if (tense === 'future_simple') {
    const hasWill = /\b(will|won t|wont|will not)\b/.test(joined);
    const hasGoingTo = joined.includes('going to') && /\b(am|is|are)\b/.test(joined);
    if (!hasWill && !hasGoingTo) { errors.push('Kelajak uchun will yoki am/is/are going to ishlating.'); score -= 35; }
    if (/\bwill\s+to\b/.test(joined)) { errors.push('Will dan keyin “to” kelmaydi: will go.'); score -= 25; }
  } else if (tense === 'present_perfect') {
    if (!/\b(have|has)\b/.test(joined)) { errors.push('Present Perfectda have/has yordamchi fe’li kerak.'); score -= 30; }
    if (thirdPersonSubject(words) && !joined.includes(`${words[0]} has`)) { errors.push('He/she/it bilan has ishlatiladi.'); score -= 20; }
    if ((firstPersonSubject(words) || pluralSubject(words)) && !/\b(i|you|we|they) have\b/.test(joined)) { errors.push('I/you/we/they bilan have ishlatiladi.'); score -= 20; }
    if (!hasPastParticiple(words)) { errors.push('Present Perfectda V3 kerak: finished, gone, seen.'); score -= 20; }
  } else if (tense === 'past_continuous') {
    if (!/\b(was|were)\b/.test(joined)) { errors.push('Past Continuousda was/were yordamchi fe’li kerak.'); score -= 30; }
    if (!hasIngVerb(words)) { errors.push('Past Continuousda fe’l -ing shaklida bo‘ladi.'); score -= 30; }
    if (!subjectBeAgreementOk(words, 'past')) { errors.push('Ega bilan was/were mos emas: I/he/she/it was, you/we/they were.'); score -= 20; }
  } else if (tense === 'should' || tense === 'modal') {
    if (!/\b(should|can|could|must|might|may)\b/.test(joined)) { errors.push('Modal gapda should/can/could/must kabi modal fe’l ishlating.'); score -= 25; }
    if (/\b(should|can|could|must|might|may)\s+to\b/.test(joined)) { errors.push('Modal fe’ldan keyin “to” kelmaydi: can go, should study.'); score -= 25; }
    if (/\b(should|can|could|must|might|may)\s+\w+s\b/.test(joined)) { errors.push('Modal fe’ldan keyin fe’lga -s qo‘shilmaydi.'); score -= 20; }
  }
  score = Math.max(0, Math.min(100, score));
  if (score >= 90 && !errors.length) errors.push('Gap grammatik jihatdan yaxshi tuzilgan.');
  return { score, ok: score >= 80, note: errors.join(' ') };
}

function gradeWritingTasks(tasks, answers) {
  let totalScore = 0;
  const details = tasks.map(task => {
    const answer = String((answers || {})[task.id] || '').trim();
    if (task.type === 'sentence_generation') {
      const generated = scoreGeneratedSentence(task, answer);
      totalScore += generated.score;
      return {
        id: task.id,
        type: task.type || '',
        section: task.section || '',
        title: task.title || '',
        prompt: task.prompt,
        answer: answer || 'Javob yozilmagan',
        expected: '',
        score: generated.score,
        ok: generated.ok,
        note: generated.note || 'Gap tuzilmasini tekshiring.'
      };
    }
    const expectedValues = task.expected || [];
    const normalizedAnswer = normalizeWritingAnswer(answer);
    const normalizedExpected = expectedValues.map(exp => normalizeWritingAnswer(exp));
    const exactFillBlank = task.type === 'fill_blank' && normalizedAnswer && normalizedExpected.some(exp => exp === normalizedAnswer);
    const scores = expectedValues.map(exp => writingSimilarity(exp, answer));
    const score = exactFillBlank ? 100 : Math.max(0, ...scores);
    totalScore += score;
    return {
      id: task.id,
      type: task.type || '',
      section: task.section || '',
      title: task.title || '',
      prompt: task.prompt,
      answer: answer || 'Javob yozilmagan',
      expected: expectedValues[0] || '',
      score,
      ok: score >= 80,
      note: task.type === 'fill_blank'
        ? analyzeFillBlankAnswer(task, answer, expectedValues, score, exactFillBlank)
        : score >= 90
          ? `Juda yaxshi. Siz “${answer}” yozdingiz, ma’no va tuzilma mos.`
          : score >= 80
            ? `Javob qabul qilindi. Siz “${answer}” yozdingiz, lekin yozuvni yanada aniqroq qilish mumkin.`
            : `Siz “${answer || 'javob yozmadingiz'}” yozdingiz. Tarjima yoki gap tuzilmasini qayta ko‘rib chiqing. Kutilgan namuna: “${expectedValues[0] || task.hint || 'to‘liq gap'}”.`
    };
  });
  const score = Math.round(totalScore / Math.max(1, tasks.length));
  const correct = details.filter(d => d.ok).length;
  return { score, correct, total: tasks.length, details };
}

function sanitizeWritingDetailsForFeedback(details = []) {
  return (details || []).map(item => ({
    prompt: item.prompt,
    answer: item.answer,
    expected: item.expected,
    section: item.section,
    title: item.title,
    ok: item.ok,
    score: item.score,
    note: item.note
  }));
}

function buildTopic(language, level, topicNo) {
  const title = topicTitles[language][level][topicNo - 1];
  const profile = getTopicProfile(language, level, title, topicNo);
  const vocabulary = normalizeTerms(profile, language, title).map((item, index) => ({ id: index + 1, ...item }));
  const questions = buildTopicQuestions(language, level, title, topicNo, vocabulary);
  const writingTasks = buildWritingTasks(language, level, title, topicNo, vocabulary, questions);
  const exerciseTypes = isThreePartWorkbookTopic(language, title)
    ? ['10 ta tanlanadigan test', 'Inputli yozma mashq', 'Gap tuzish testi']
    : ['Oddiy test'];
  return { id: `${language}_${level}_${topicNo}`, language, level, topicNo, totalTopics: topicCountForLevel(language, level), title, exerciseTypes, youtubeVideo: getEnglishYoutubeVideo(language, title, level), explanation: buildExplanation(language, level, title, topicNo), examples: buildExamples(language, level, title, topicNo), vocabulary, questions, writingTasks };
}
function getTopics(language, level) { const count = topicCountForLevel(language, level); return Array.from({ length: count }, (_, i) => buildTopic(language, level, i + 1)); }
function progressKey(language, level, topicNo) { return `${language}:${level}:topic:${topicNo}`; }
function speakingProgressKey(language, level, topicNo) { return `${language}:${level}:speaking:${topicNo}`; }
function gateKey(language, level) { return `${language}:${level}:gate`; }
function finalKey(language, level) { return `${language}:${level}:final`; }
function subjectFromProgressKey(key) { return key.split(':')[0]; }
function userProgress(db, userId) { if (!db.progress[userId]) db.progress[userId] = {}; return db.progress[userId]; }
function hasLevelAccess(db, userId, language, level) {
  if (level === FIRST_LEVEL) return true;
  const user = db.users.find(u => u.id === userId);
  if (hasAdminLevelUnlock(user, level)) return true;
  const p = userProgress(db, userId);
  const previous = levels[levelIndex[level] - 1];
  return (p[gateKey(language, level)]?.bestScore || 0) >= LEVEL_PASS_SCORE || (p[finalKey(language, previous)]?.bestScore || 0) >= LEVEL_PASS_SCORE;
}
function isTopicUnlocked(db, userId, language, level, topicNo) {
  const user = db.users.find(u => u.id === userId);
  if (hasAdminLevelUnlock(user, level)) return true;
  if (!hasLevelAccess(db, userId, language, level)) return false;
  return topicScheduleStatus(db, userId, language, level, Number(topicNo)).allowed;
}
function isFinalUnlocked(db, userId, language, level) {
  if (!hasLevelAccess(db, userId, language, level)) return false;
  const count = topicCountForLevel(language, level);
  if (!count) return false;
  for (let topicNo = 1; topicNo <= count; topicNo += 1) {
    if (!topicPassedRecord(db, userId, language, level, topicNo)) return false;
  }
  return true;
}

function buildElementaryEnglishFinalTest() {
  const answerIndex = { A: 0, B: 1, C: 2, D: 3 };
  const rows = [
    ['Look! The baby ______.', ['sleep', 'sleeps', 'is sleeping', 'slept'], 'C'],
    ['My father usually ______ to work by bus.', ['goes', 'is going', 'go', 'went'], 'A'],
    ['She sings very ______.', ['beautiful', 'beautifully', 'beauty', 'beautify'], 'B'],
    ['We have English lessons ______ Monday.', ['in', 'at', 'on', 'from'], 'C'],
    ['The books are ______ the table.', ['in', 'on', 'at', 'under'], 'B'],
    ['While I ______ TV, my brother was studying.', ['watch', 'watched', 'was watching', 'am watching'], 'C'],
    ['If you heat water, it ______.', ['boil', 'boils', 'boiled', 'will boil'], 'B'],
    ['Students ______ wear uniforms at this school.', ['have to', 'having to', 'has to', 'had'], 'A'],
    ["You ______ smoke here. It's forbidden.", ['have to', "mustn't", 'could', 'would'], 'B'],
    ['Yesterday I ______ my grandmother.', ['visit', 'visits', 'visited', 'visiting'], 'C'],
    ['______ you help me with this box?', ['Must', 'Would', 'Have to', 'Used to'], 'B'],
    ['When I was a child, I ______ play football every day.', ['use to', 'used to', 'using to', 'would to'], 'B'],
    ['We ______ visit Samarkand next summer.', ['are going to', 'goes to', 'going', 'went'], 'A'],
    ['I think it ______ rain tomorrow.', ['is going', 'rains', 'will', 'raining'], 'C'],
    ['If it rains tomorrow, we ______ at home.', ['stay', 'stayed', 'will stay', 'staying'], 'C'],
    ['I enjoy ______ books.', ['read', 'reading', 'to read', 'reads'], 'B'],
    ['She decided ______ a doctor.', ['become', 'becoming', 'to become', 'became'], 'C'],
    ['He drives very ______.', ['careful', 'carefully', 'care', 'caring'], 'B'],
    ['They are sitting ______ the classroom.', ['in', 'on', 'at', 'between'], 'A'],
    ['We usually have dinner ______ 7 p.m.', ['on', 'in', 'at', 'by'], 'C'],
    ['While they ______ home, it started to rain.', ['walk', 'walked', 'were walking', 'walking'], 'C'],
    ["If you don't water plants, they ______.", ['die', 'dies', 'died', 'will die'], 'A'],
    ['I ______ finish this report today.', ['have to', 'could', 'would', 'used to'], 'A'],
    ['Last year we ______ to Bukhara.', ['go', 'went', 'gone', 'going'], 'B'],
    ['______ I borrow your pen?', ['Must', 'Have to', 'Could', 'Used to'], 'C'],
    ["My grandfather ______ smoke, but now he doesn't.", ['used to', 'use', 'would to', 'using'], 'A'],
    ['They ______ buy a new car next month.', ['are going to', 'are buy', 'buys', 'bought'], 'A'],
    ['I am sure she ______ pass the exam.', ['will', 'is passing', 'passed', 'passing'], 'A'],
    ['If she studies hard, she ______ the exam.', ['pass', 'passed', 'will pass', 'passing'], 'C'],
    ['He wants ______ English better.', ['learn', 'learning', 'to learn', 'learned'], 'C'],
    ['We dislike ______ early.', ['wake up', 'waking up', 'woke up', 'to woke up'], 'B'],
    ['My sister is very ______.', ['kindly', 'kind', 'kindness', 'kinding'], 'B'],
    ['There is a picture ______ the wall.', ['on', 'in', 'under', 'at'], 'A'],
    ['I was born ______ 2010.', ['on', 'at', 'in', 'by'], 'C'],
    ['What ______ now?', ['do you do', 'are you doing', 'did you do', 'will you do'], 'B'],
    ['Every morning she ______ breakfast at 7.', ['has', 'is having', 'had', 'have'], 'A'],
    ['If people exercise regularly, they ______ healthier.', ['become', 'became', 'will become', 'becoming'], 'A'],
    ['You ______ be quiet in the library.', ['would', 'must', 'used to', 'could'], 'B'],
    ['Last weekend I ______ a movie with my friends.', ['watch', 'watched', 'watches', 'watching'], 'B'],
    ['When I was younger, I ______ ride my bike every evening.', ['used to', 'use', 'using', 'used'], 'A'],
    ['My family ______ visit our relatives this weekend.', ['is going to', 'are visited', 'visited', 'visit'], 'A'],
    ['I think Uzbekistan ______ many tourists in the future.', ['attract', 'attracted', 'will attract', 'attracting'], 'C'],
    ['If you are tired, you ______ go to bed early.', ['should', 'would', 'used to', 'had'], 'A'],
    ['She finished ______ her homework.', ['do', 'doing', 'to do', 'did'], 'B'],
    ['We hope ______ the competition.', ['win', 'winning', 'to win', 'won'], 'C'],
    ['The test was very ______.', ['easily', 'easy', 'easiness', 'easierly'], 'B'],
    ['There is a bank ______ the supermarket and the school.', ['between', 'under', 'on', 'in'], 'A'],
    ['At 8 p.m. yesterday, I ______ my homework.', ['do', 'did', 'was doing', 'am doing'], 'C'],
    ['If you mix blue and yellow, you ______ green.', ['get', 'got', 'will get', 'getting'], 'A'],
    ['When we were children, we ______ spend our summers in the village.', ['would', 'must', 'have to', 'are going to'], 'A']
  ];
  const questions = rows.map(([question, options, answer], index) => ({
    id: `ef${index + 1}`,
    question,
    options,
    correctIndex: answerIndex[answer],
    note: 'Elementary final / Pre-Intermediate ruxsat testi: aralash grammatika savoli.'
  }));
  return {
    title: 'Elementary yakuniy testi',
    description: '50 ta savol. Kamida 45 ta to‘g‘ri javob (90%+) bo‘lsa Pre-Intermediate darajasi avtomatik ochiladi.',
    questions
  };
}

function buildGateTest(language, level) {
  // Elementary ustiga bosilganda Beginner yakuniy 50 talik test chiqadi.
  // Pre-Intermediate ustiga bosilganda Elementary yakuniy 50 talik test chiqadi.
  // 45/50 (90%+) natija keyingi darajani ochadi.
  if (language === 'english' && level === 'Elementary') return buildBeginnerEnglishFinalTest();
  if (language === 'english' && level === 'Pre-Intermediate') return buildElementaryEnglishFinalTest();
  const prev = levels[Math.max(0, levelIndex[level] - 1)] || FIRST_LEVEL;
  const topics = getTopics(language, prev);
  const questionCount = ((language === 'tarix' && prev === FIRST_LEVEL)) ? 1 : 30;
  const questions = Array.from({ length: questionCount }, (_, i) => {
    const t = topics[i % topics.length];
    const base = t.questions[(i * 2 + levelIndex[level]) % t.questions.length];
    const prepared = forceCorrectAnswerA(base.options, base.correctIndex, i + levelIndex[level] + 41);
    return {
      ...base,
      options: prepared.options,
      correctIndex: prepared.correctIndex,
      id: `g${i + 1}`,
      question: `${prev} bazasidagi ${t.topicNo}-mavzu “${t.title}”: ${base.question}`,
      note: `${t.title} mavzusi: ${base.note}`
    };
  });
  return { title: `${level} darajasiga kirish testi`, description: `${questionCount} ta savol. Savollar oldingi darajadagi mavzu qoidalari, misollari va terminlari asosida tuzilgan.`, questions };
}

function buildBeginnerEnglishFinalTest() {
  const answerIndex = { A: 0, B: 1, C: 2, D: 3 };
  const rows = [
    ['She ___ a doctor.', ['are', 'is', 'am', 'be'], 'B'],
    ['There ___ two books on the table.', ['is', 'are', 'am', 'be'], 'B'],
    ['One child – two ___', ['childs', 'childes', 'children', 'child'], 'C'],
    ['They ___ football now.', ['are playing', 'play', 'plays', 'played'], 'A'],
    ['The cat is ___ the chair.', ['at', 'under', 'on', 'in'], 'B'],
    ['___ is your English teacher?', ['What', 'Which', 'Where', 'Who'], 'D'],
    ['He ___ a new bicycle.', ['have', 'has', 'having', 'had'], 'B'],
    ['Birds ___ fly.', ['can', "can't", 'has', 'are'], 'A'],
    ['We study ___ the evening.', ['at', 'on', 'in', 'under'], 'C'],
    ['One foot – two ___', ['foots', 'feet', 'feets', 'foot'], 'B'],
    ['___ are my friends.', ['He', 'It', 'They', 'She'], 'C'],
    ['I ___ breakfast every day.', ['am eating', 'eats', 'eat', 'ate'], 'C'],
    ['There ___ a computer in the room.', ['is', 'are', 'am', 'be'], 'A'],
    ['Fish ___ walk.', ['can', 'have', "can't", 'are'], 'C'],
    ['The keys are ___ the bag.', ['in', 'on', 'under', 'at'], 'A'],
    ['One woman – two ___', ['womans', 'women', 'womanes', 'womens'], 'B'],
    ['She ___ TV at the moment.', ['watch', 'watches', 'is watching', 'watched'], 'C'],
    ['___ is your favorite color?', ['Who', 'When', 'Where', 'What'], 'D'],
    ['We ___ students.', ['is', 'are', 'am', 'be'], 'B'],
    ['My brother ___ blue eyes.', ['have', 'having', 'has', 'had'], 'C'],
    ['One city – two ___', ['citys', 'cityes', 'cities', 'city'], 'C'],
    ['The picture is ___ the wall.', ['on', 'in', 'under', 'behind'], 'A'],
    ['You ___ swim very well.', ["can't", 'can', 'has', 'is'], 'B'],
    ['They ___ at school now.', ['are', 'is', 'am', 'be'], 'A'],
    ['One tooth – two ___', ['tooths', 'toothes', 'teeth', 'teeths'], 'C'],
    ['He ___ to work every day.', ['go', 'going', 'goes', 'went'], 'C'],
    ['___ is my sister.', ['He', 'She', 'It', 'They'], 'B'],
    ['There ___ five students in the class.', ['is', 'am', 'are', 'be'], 'C'],
    ['School starts ___ 8:00.', ['in', 'on', 'under', 'at'], 'D'],
    ['One box – two ___', ['boxs', 'boxes', 'boxies', 'box'], 'B'],
    ['The dog ___ sleeping now.', ['am', 'are', 'is', 'be'], 'C'],
    ['They ___ a big house.', ['have', 'has', 'having', 'had'], 'A'],
    ['___ are playing basketball.', ['He', 'She', 'We', 'It'], 'C'],
    ['The ball is ___ the table.', ['in', 'under', 'behind', 'on'], 'D'],
    ['One man – two ___', ['mans', 'men', 'mens', 'manes'], 'B'],
    ['She ___ English every day.', ['study', 'studying', 'studies', 'studied'], 'C'],
    ['___ is your phone number?', ['Who', 'What', 'Where', 'When'], 'B'],
    ['Cats ___ climb trees.', ["can't", 'can', 'has', 'are'], 'B'],
    ['We go to school ___ Monday.', ['in', 'at', 'on', 'under'], 'C'],
    ['One baby – two ___', ['babys', 'babies', 'babyes', 'baby'], 'B'],
    ['My parents ___ at home.', ['is', 'am', 'are', 'be'], 'C'],
    ['The children ___ in the park now.', ['plays', 'play', 'are playing', 'played'], 'C'],
    ['There ___ an apple on the desk.', ['are', 'is', 'am', 'be'], 'B'],
    ['One bus – two ___', ['buss', 'buses', 'busies', 'bus'], 'B'],
    ['The cat is ___ the box.', ['in', 'on', 'under', 'behind'], 'A'],
    ['He ___ play the piano.', ['can', "can't", 'has', 'is'], 'A'],
    ['___ are teachers.', ['He', 'She', 'It', 'They'], 'D'],
    ['I ___ my homework every evening.', ['do', 'does', 'doing', 'did'], 'A'],
    ['We have lunch ___ noon.', ['on', 'in', 'at', 'under'], 'C'],
    ['One mouse – two ___', ['mouses', 'mousees', 'mouse', 'mice'], 'D']
  ];
  const questions = rows.map(([question, options, answer], index) => ({
    id: `bf${index + 1}`,
    question,
    options,
    correctIndex: answerIndex[answer],
    note: 'Beginner final test: aralash grammatika savoli.'
  }));
  return {
    title: 'Beginner yakuniy testi',
    description: '50 ta savol. Kamida 45 ta to‘g‘ri javob (90%+) bo‘lsa Elementary darajasi avtomatik ochiladi.',
    questions
  };
}

function buildFinalTest(language, level) {
  if (language === 'english' && level === 'Beginner') return buildBeginnerEnglishFinalTest();
  if (language === 'english' && level === 'Elementary') return buildElementaryEnglishFinalTest();
  const topics = getTopics(language, level);
  const questionCount = (isHistoryA1(language, level) || isEnglishA1QuickCheck(language, level)) ? 1 : 30;
  const questions = Array.from({ length: questionCount }, (_, i) => {
    const t = topics[i % topics.length];
    const base = t.questions[(i * 3 + 1) % t.questions.length];
    const prepared = forceCorrectAnswerA(base.options, base.correctIndex, i + topicCountForLevel(language, level) + 71);
    return {
      ...base,
      options: prepared.options,
      correctIndex: prepared.correctIndex,
      id: `f${i + 1}`,
      question: `${level} yakuniy test — ${t.topicNo}-mavzu “${t.title}”: ${base.question}`,
      note: `${t.title} mavzusi: ${base.note}`
    };
  });
  return { title: `${level} daraja yakuniy testi`, description: `${questionCount} ta savol. Savollar shu darajadagi barcha mavzular qoidalari va misollari asosida tuzilgan. Test topshirilgandan keyin natijangiz foiz bo‘yicha sertifikatga yoziladi.`, questions };
}
function grade(questions, answers) {
  let correct = 0;
  const details = questions.map(q => {
    const chosen = Number(answers[q.id]);
    const ok = chosen === q.correctIndex;
    if (ok) correct += 1;
    return { type: 'choice', section: 'Tanlash savollari', question: q.question, chosen: q.options[chosen] || 'Tanlanmagan', correct: q.options[q.correctIndex], ok, note: q.note };
  });
  return { score: Math.round((correct / questions.length) * 100), correct, total: questions.length, details };
}
function sanitizeChoiceDetailsForFeedback(details = []) {
  return (details || []).map(item => ({
    question: item.question,
    ok: item.ok
  }));
}

function fallbackFeedback(details, score, passScore) {
  const wrongCount = details.filter(d => !d.ok).length;
  if (!wrongCount) return `Zo‘r! Natija ${score}%. Hamma javoblar to‘g‘ri.`;
  return `Natija ${score}%. Kerakli natija: ${passScore}%. ${score >= passScore ? 'Keyingi bosqich ochildi.' : 'Qayta tayyorlanish kerak.'} ${wrongCount} ta javob qayta mashq qilinishi kerak.`;
}
async function aiFeedback(prompt, fallback) {
  if (!OPENAI_API_KEY) return fallback;
  try {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        instructions: 'Sen ENGLISH Mock platformasida o‘zbek tilida qisqa, foydali va o‘quvchiga tushunarli feedback beradigan ingliz tili AI o‘qituvchisisan. Javob 1-3 gapdan oshmasin.',
        input: prompt,
        max_output_tokens: 220
      })
    });
    if (!r.ok) {
      console.warn('OpenAI feedback fallback:', r.status, await r.text().catch(() => ''));
      return fallback;
    }
    const data = await r.json();
    const text = String(data.output_text || '').trim();
    return text || fallback;
  } catch (error) {
    console.warn('OpenAI feedback error:', error?.message || error);
    return fallback;
  }
}



function normalizeSpeech(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function speechSimilarity(expected, spoken) {
  const a = normalizeSpeech(expected);
  const b = normalizeSpeech(spoken);
  if (!a || !b) return 0;
  if (a === b || b.includes(a)) return 100;
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  const distance = rows[a.length][b.length];
  return Math.max(0, Math.round((1 - distance / Math.max(a.length, b.length)) * 100));
}
function pronunciationFallback(score, expected, spoken) {
  if (score >= 90) return `Zo‘r! “${expected}” so‘zi juda aniq aytildi.`;
  if (score >= 75) return `Yaxshi! “${expected}” so‘zi qabul qilindi. Yanada ravon aytish uchun bir marta takrorlang.`;
  if (score >= 55) return `Yaqin, lekin hali to‘liq aniq emas. Siz “${spoken}” deb aytdingiz. Avval so‘zni eshiting, keyin sekinroq qayta ayting.`;
  return `Talaffuz mos kelmadi. “${expected}” so‘zini eshitib oling, bo‘g‘inlarga ajrating va mikrofonga aniq ayting.`;
}

function normalizeSpeakingBatchItems(rawItems = []) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .slice(0, VOCABULARY_ITEM_COUNT)
    .map((item, index) => {
      const expected = String(item.expected || item.word || '').trim();
      const spoken = String(item.spoken || '').trim();
      const meaning = String(item.meaning || '').trim();
      const score = typeof item.score !== 'undefined' ? clampScore(item.score) : speechSimilarity(expected, spoken);
      return {
        id: item.id || `v${index + 1}`,
        word: expected,
        expected,
        meaning,
        spoken,
        score,
        passed: score >= 75,
        feedback: pronunciationFallback(score, expected, spoken)
      };
    })
    .filter(item => item.expected && item.spoken);
}

function buildBatchPronunciationPrompt(language, items, avgScore) {
  const rows = items.map((item, index) => `${index + 1}. So‘z: ${item.expected}; Ma’nosi: ${item.meaning || '-'}; O‘quvchi aytdi: ${item.spoken}; Ball: ${item.score}%`).join('\n');
  return `O'zbek tilida qisqa pronunciation/vocabulary feedback yoz. Bu bitta AI request ichida ${items.length} ta vocabulary so'z tekshiruvi. Til: ${language}. O'rtacha natija: ${avgScore}%.\n${rows}\nJavob juda qisqa bo'lsin: 1) umumiy baho, 2) eng ko'p adashilgan 3 ta so'z, 3) keyingi mashq uchun aniq maslahat. Har bir so'zga uzun izoh yozma.`;
}


const GAME_WORDS = [
  { id: 'w_1', word: 'book', answer: 'kitob', alternatives: [] },
  { id: 'w_2', word: 'teacher', answer: 'ustoz', alternatives: ['o‘qituvchi', "o'qituvchi", 'muallim'] },
  { id: 'w_3', word: 'student', answer: 'o‘quvchi', alternatives: ["o'quvchi", 'talaba'] },
  { id: 'w_4', word: 'school', answer: 'maktab', alternatives: [] },
  { id: 'w_5', word: 'friend', answer: 'do‘st', alternatives: ["do'st", 'dost'] },
  { id: 'w_6', word: 'family', answer: 'oila', alternatives: [] },
  { id: 'w_7', word: 'water', answer: 'suv', alternatives: [] },
  { id: 'w_8', word: 'mother', answer: 'ona', alternatives: [] },
  { id: 'w_9', word: 'father', answer: 'ota', alternatives: [] },
  { id: 'w_10', word: 'house', answer: 'uy', alternatives: [] },
  { id: 'w_11', word: 'lesson', answer: 'dars', alternatives: [] },
  { id: 'w_12', word: 'question', answer: 'savol', alternatives: [] },
  { id: 'w_13', word: 'answer', answer: 'javob', alternatives: [] },
  { id: 'w_14', word: 'write', answer: 'yozmoq', alternatives: ['yozish'] },
  { id: 'w_15', word: 'read', answer: 'o‘qimoq', alternatives: ["o'qimoq", 'oqimoq', 'o‘qish', "o'qish"] },
  { id: 'w_16', word: 'speak', answer: 'gapirmoq', alternatives: ['so‘zlamoq', "so'zlamoq"] },
  { id: 'w_17', word: 'listen', answer: 'tinglamoq', alternatives: ['eshitmoq'] },
  { id: 'w_18', word: 'learn', answer: 'o‘rganmoq', alternatives: ["o'rganmoq", 'organmoq'] },
  { id: 'w_19', word: 'open', answer: 'ochmoq', alternatives: [] },
  { id: 'w_20', word: 'close', answer: 'yopmoq', alternatives: [] },
  { id: 'w_21', word: 'go', answer: 'bormoq', alternatives: ['ketmoq'] },
  { id: 'w_22', word: 'come', answer: 'kelmoq', alternatives: [] },
  { id: 'w_23', word: 'see', answer: 'ko‘rmoq', alternatives: ["ko'rmoq", 'kormoq'] },
  { id: 'w_24', word: 'know', answer: 'bilmoq', alternatives: [] },
  { id: 'w_25', word: 'think', answer: 'o‘ylamoq', alternatives: ["o'ylamoq", 'oylamoq'] },
  { id: 'w_26', word: 'make', answer: 'qilmoq', alternatives: ['yasamoq'] },
  { id: 'w_27', word: 'work', answer: 'ishlamoq', alternatives: [] },
  { id: 'w_28', word: 'play', answer: 'o‘ynamoq', alternatives: ["o'ynamoq", 'oynamoq'] },
  { id: 'w_29', word: 'eat', answer: 'yemoq', alternatives: [] },
  { id: 'w_30', word: 'drink', answer: 'ichmoq', alternatives: [] }
];
function normalizeGameAnswer(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[’`ʻ']/g, '')
    .replace(/\s+/g, ' ');
}
function getUsedGameWordIds(db, userId) {
  return new Set((db.gamePlays || [])
    .filter(play => play.userId === userId)
    .flatMap(play => Array.isArray(play.words) ? play.words.map(w => w.id).filter(Boolean) : []));
}
function dailyWordGame(db, userId) {
  const usedIds = getUsedGameWordIds(db, userId);
  const available = GAME_WORDS.filter(word => !usedIds.has(word.id));
  const source = available.length >= 3 ? available : available;
  const seedText = `${userId || 'student'}_${latestGamePlay(db, userId)?.id || 'first'}_${available.length}`;
  let seed = 0;
  for (let i = 0; i < seedText.length; i += 1) seed = (seed * 31 + seedText.charCodeAt(i)) >>> 0;
  const pool = [...source];
  const selected = [];
  while (selected.length < 3 && pool.length) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const index = seed % pool.length;
    selected.push(pool.splice(index, 1)[0]);
  }
  return selected;
}
const SHOP_ITEMS = [
  { id: 'bakal', title: 'Bakal', icon: '🥤', price: 100 },
  { id: 'futbolka', title: 'Futbolka', icon: '👕', price: 200 },
  { id: 'kitob', title: 'Kitob', icon: '📚', price: 300 },
  { id: 'atir', title: 'Atir', icon: '🌸', price: 500 },
  { id: 'telefon', title: 'Telefon', icon: '📱', price: 5000 }
];
function todayKey() { return new Date().toISOString().slice(0,10); }
const GAME_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 soat: o‘yin faqat kuniga 1 marta ochiladi
function coinBalance(db, userId) {
  const earned = (db.gamePlays || []).filter(x => x.userId === userId).reduce((s,x)=>s+Number(x.coins||0),0);
  const spent = (db.shopOrders || []).filter(x => x.userId === userId && x.status !== 'rejected').reduce((s,x)=>s+Number(x.price||0),0);
  return Math.max(0, earned - spent);
}
function latestGamePlay(db, userId) {
  return (db.gamePlays || [])
    .filter(x => x.userId === userId && x.createdAt)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] || null;
}
function gameStatus(db, userId) {
  const today = todayKey();
  const lastPlay = latestGamePlay(db, userId);
  const lastPlayedAt = lastPlay?.createdAt || null;
  const nextPlayAt = lastPlayedAt ? new Date(new Date(lastPlayedAt).getTime() + GAME_COOLDOWN_MS).toISOString() : null;
  const remainingMs = nextPlayAt ? Math.max(0, new Date(nextPlayAt).getTime() - Date.now()) : 0;
  const selectedWords = dailyWordGame(db, userId);
  const hasEnoughWords = selectedWords.length >= 3;
  const canPlay = remainingMs <= 0 && hasEnoughWords;
  const totalCoins = coinBalance(db, userId);
  const words = selectedWords.map(({ id, word, answer }) => ({ id, word, answer }));
  return { canPlay, playedToday: !!lastPlay && !canPlay, wordsFinished: !hasEnoughWords, today, lastPlayedAt, nextPlayAt, remainingMs, cooldownMs: GAME_COOLDOWN_MS, coins: totalCoins, game: { id: `word_${today}_${words.map(w => w.id).join('_')}`, type: 'translation', timePerWord: 15, words }, shopItems: SHOP_ITEMS };
}
app.get('/api/student/game', auth, (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ message: 'Faqat o‘quvchilar uchun' });
  res.json(gameStatus(req.db, req.user.id));
});
app.post('/api/student/game/play', auth, (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ message: 'Faqat o‘quvchilar uchun' });
  const db = req.db;
  const status = gameStatus(db, req.user.id);
  if (!status.canPlay) return res.status(400).json({ message: 'O‘yin hali ochilmadi. Qolgan vaqtni kuting.' });
  const answers = Array.isArray(req.body?.answers) ? req.body.answers.map(x => normalizeGameAnswer(x)) : [];
  const todayWords = dailyWordGame(db, req.user.id);
  const correct = todayWords.reduce((sum, item, idx) => {
    const accepted = [item.answer, ...(item.alternatives || [])].map(normalizeGameAnswer);
    return sum + (accepted.includes(answers[idx]) ? 1 : 0);
  }, 0);
  const play = { id: makeId('game'), userId: req.user.id, fullName: req.user.fullName || req.user.username, date: status.today, gameId: status.game.id, words: todayWords.map(({ id, word, answer, alternatives }) => ({ id, word, answer, alternatives: alternatives || [] })), answers, correct, coins: correct, createdAt: new Date().toISOString() };
  db.gamePlays.push(play);
  addActionLog(db, req.user, 'student_game_played', play.id, { correct, coins: correct }, req);
  writeDb(db);
  res.json({ ...gameStatus(db, req.user.id), result: play, message: `${correct} ta to‘g‘ri. ${correct} coin qo‘shildi.` });
});
app.post('/api/student/shop/buy', auth, (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ message: 'Faqat o‘quvchilar uchun' });
  const db = req.db;
  const item = SHOP_ITEMS.find(x => x.id === req.body?.itemId);
  if (!item) return res.status(404).json({ message: 'Mahsulot topilmadi' });
  const coins = coinBalance(db, req.user.id);
  if (coins < item.price) return res.status(400).json({ message: 'Sizda Coin yetarlicha emas', coins });
  const order = { id: makeId('order'), userId: req.user.id, fullName: req.user.fullName || req.user.username, username: req.user.username, itemId: item.id, itemTitle: item.title, itemIcon: item.icon, price: item.price, status: 'pending', createdAt: new Date().toISOString(), centerId: centerIdOf(req.user) };
  db.shopOrders.push(order);
  addActionLog(db, req.user, 'shop_order_created', order.id, order, req);
  writeDb(db);
  res.json({ message: 'Admin javobini kuting', order, coins: coinBalance(db, req.user.id) });
});
app.get('/api/admin/shop-orders', auth, adminOnly, (req, res) => {
  const orders = (req.db.shopOrders || []).filter(o => canAdminAccessCenter(req.user, o.centerId || centerIdOf(req.db.users.find(u => u.id === o.userId) || {}))).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json({ orders });
});

app.get('/api/health', async (req, res) => {
  let pgOk = false;
  try {
    if (pgPool) { await pgPool.query('select 1'); pgOk = true; }
  } catch (err) {
    lastPgError = err;
  }
  res.json({
    ok: true,
    message: 'Backend ishlayapti',
    database: 'postgresql',
    postgresConnected: pgOk,
    tables: ['app_users','app_progress','app_certificates','app_enrollments'],
    pgError: lastPgError ? lastPgError.message : null,
    openaiEnabled: Boolean(OPENAI_API_KEY),
    openaiModel: OPENAI_MODEL
  });
});
app.get('/api/public/meta', (req, res) => res.json({ subjects, levels }));
app.get('/api/admin/ai-status', auth, adminOnly, (req, res) => {
  res.json({
    openaiEnabled: Boolean(OPENAI_API_KEY),
    model: OPENAI_MODEL,
    message: OPENAI_API_KEY ? 'OpenAI ulangan' : 'OPENAI_API_KEY Railway Variables ichida yo‘q'
  });
});
app.post('/api/enroll', (req, res) => {
  const { fullName, birthDate, language, phone, telegram } = req.body;
  if (!fullName || !birthDate || !language || !phone || !telegram) return res.status(400).json({ message: 'Barcha maydonlarni to‘ldiring' });
  if (!subjectMap[language]) return res.status(400).json({ message: 'Tilni tanlang' });
  const db = readDb();
  const enrollment = { id: makeId('enroll'), fullName, birthDate, language, languageTitle: subjectMap[language], phone, telegram, status: 'new', centerId: req.body.centerId || DEFAULT_CENTER_ID, createdAt: new Date().toISOString() };
  db.enrollments.unshift(enrollment);
  addActionLog(db, null, 'enrollment_created', enrollment.id, { fullName, language }, req);
  writeDb(db);
  res.json({ message: 'Arizangiz adminga yuborildi. Tez orada siz bilan bog‘lanishadi.', enrollment });
});
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const db = readDb();
  const user = db.users.find(u => u.username === username);
  if (!user) return res.status(401).json({ message: 'Login yoki parol xato' });

  let passwordOk = false;
  if (user.passwordHash) {
    passwordOk = await bcrypt.compare(String(password || ''), user.passwordHash);
  } else if (user.password) {
    passwordOk = String(user.password) === String(password || '');
    if (passwordOk) ensurePasswordHashSync(user);
  }
  if (!passwordOk) return res.status(401).json({ message: 'Login yoki parol xato' });
  if (statusOf(user) !== 'active') return res.status(403).json({ message: user.expiresAt && isExpired(user) ? 'Accountingiz muddati tugagan. Admin bilan bog‘laning.' : 'Accountingiz non-active holatda. Admin bilan bog‘laning.' });

  user.lastLoginAt = new Date().toISOString();
  user.loginCount = Number(user.loginCount || 0) + 1;
  const token = createJwtForUser(user);
  addActionLog(db, user, 'login', user.id, { username: user.username }, req);
  writeDb(db);
  res.json({ token, user: safeUser(user, db), message: 'Login muvaffaqiyatli. Bu account uchun avvalgi qurilma sessiyasi yopildi.' });
});
app.get('/api/me', auth, (req, res) => res.json({ user: safeUser(req.user, req.db) }));

app.get('/api/content', auth, (req, res) => {
  const visibleSubjects = req.user.subject === 'all' ? subjects : subjects.filter(s => s.id === req.user.subject);
  res.json({ subjects: visibleSubjects, levels, assignedSubject: req.user.subject });
});
app.get('/api/progress', auth, (req, res) => {
  const db = req.db;
  const p = userProgress(db, req.user.id);
  const visibleSubjects = req.user.subject === 'all' ? subjects : subjects.filter(s => s.id === req.user.subject);
  const access = {};
  for (const s of visibleSubjects) {
    access[s.id] = {};
    for (const lvl of levels) access[s.id][lvl] = hasLevelAccess(db, req.user.id, s.id, lvl);
  }
  res.json({
    progress: p,
    access,
    manualUnlockedLevels: normalizeUnlockedLevels(req.user.unlockedLevels || []),
    user: { unlockedLevels: normalizeUnlockedLevels(req.user.unlockedLevels || []) },
    speakingSummary: summarizeSpeakingForUser(db, req.user),
    certificates: db.certificates.filter(c => c.userId === req.user.id)
  });
});
app.get('/api/topics/:language/:level', auth, requireSubject, (req, res) => {
  const { language, level } = req.params;
  if (!levels.includes(level)) return res.status(404).json({ message: 'Daraja topilmadi' });
  const db = req.db;
  const p = userProgress(db, req.user.id);
  const topics = getTopics(language, level).map(raw => {
    const t = applyTopicOverride(db, raw);
    const speaking = summarizeSpeakingRecord(p[speakingProgressKey(language, level, t.topicNo)] || {});
    const schedule = topicScheduleStatus(db, req.user.id, language, level, t.topicNo);
    const unlocked = isTopicUnlocked(db, req.user.id, language, level, t.topicNo);
    return {
      ...t,
      unlocked,
      scheduleLocked: schedule.scheduled && !schedule.allowed,
      unlockMessage: unlocked ? (schedule.message || '') : (schedule.message || 'Bu mavzu hali ochilmagan.'),
      todayPlanDay: schedule.todayName,
      planDays: schedule.planDays,
      bestScore: p[progressKey(language, level, t.topicNo)]?.bestScore || 0,
      attempts: p[progressKey(language, level, t.topicNo)]?.attempts || 0,
      speakingScore: speaking.score,
      speakingBestScore: speaking.bestScore,
      speakingCheckedWords: speaking.checkedWords,
      speakingPassedWords: speaking.passedWords,
      speakingTotalWords: speaking.totalWords,
      speakingAttempts: speaking.attempts,
      speakingUpdatedAt: speaking.updatedAt
    };
  });
  res.json({ topics, finalUnlocked: isFinalUnlocked(db, req.user.id, language, level), finalBest: p[finalKey(language, level)]?.bestScore || 0 });
});
app.post('/api/speaking-batch-check', auth, async (req, res) => {
  const language = String(req.body.language || 'english');
  const items = normalizeSpeakingBatchItems(req.body.items || []);
  if (!items.length) return res.status(400).json({ message: 'Batch tekshiruv uchun kamida 1 ta aytilgan vocabulary kerak' });

  const checkedWords = items.length;
  const passedWords = items.filter(item => item.passed).length;
  const score = Math.round(items.reduce((sum, item) => sum + item.score, 0) / Math.max(1, checkedWords));
  const weak = items.filter(item => item.score < 75).slice(0, 5).map(item => `${item.expected} (${item.score}%)`).join(', ');
  const fallback = score >= 85
    ? `Juda yaxshi! ${checkedWords} ta vocabulary bitta AI batchda tekshirildi. O‘rtacha natija ${score}%.`
    : `Vocabulary batch tekshiruvi: ${checkedWords} ta so‘zdan ${passedWords} tasi qabul qilindi. O‘rtacha ${score}%. ${weak ? `Ko‘proq mashq kerak: ${weak}.` : ''}`;
  const feedback = await aiFeedback(buildBatchPronunciationPrompt(language, items, score), fallback);

  res.json({
    mode: 'batch',
    requestCount: 1,
    message: `${checkedWords} ta vocabulary bitta AI request bilan tekshirildi`,
    score,
    checkedWords,
    passedWords,
    totalWords: VOCABULARY_ITEM_COUNT,
    feedback,
    results: items
  });
});

app.post('/api/speaking-check', auth, async (req, res) => {
  const expected = String(req.body.expected || req.body.word || '').trim();
  const spoken = String(req.body.spoken || '').trim();
  const language = String(req.body.language || 'english');
  const meaning = String(req.body.meaning || '').trim();
  if (!expected || !spoken) return res.status(400).json({ message: 'Tekshirish uchun so‘z va aytilgan matn kerak' });

  const score = speechSimilarity(expected, spoken);
  const fallback = pronunciationFallback(score, expected, spoken);
  const feedback = await aiFeedback(
    `O'zbek tilida bitta qisqa va tushunarli talaffuz feedback ber. Til: ${language}. Kutilgan so'z: ${expected}. Ma'nosi: ${meaning}. O'quvchi aytgan matn: ${spoken}. O'xshashlik: ${score}%. 1-2 gapdan oshmasin, aniq maslahat ber.`,
    fallback
  );
  res.json({ score, passed: score >= 75, feedback });
});

app.post('/api/speaking-progress-batch/:language/:level/:topicNo', auth, requireSubject, (req, res) => {
  const { language, level } = req.params;
  const topicNo = Number(req.params.topicNo);
  const db = req.db;
  if (!levels.includes(level) || !topicTitles[language]?.[level]?.[topicNo - 1]) return res.status(404).json({ message: 'Mavzu topilmadi' });
  if (!isTopicUnlocked(db, req.user.id, language, level, topicNo)) return res.status(403).json({ message: 'Bu mavzu hali ochilmagan' });

  const items = normalizeSpeakingBatchItems(req.body.items || []);
  if (!items.length) return res.status(400).json({ message: 'Saqlash uchun kamida 1 ta vocabulary natijasi kerak' });

  const p = userProgress(db, req.user.id);
  const key = speakingProgressKey(language, level, topicNo);
  const now = new Date().toISOString();
  const current = p[key] || { totalWords: VOCABULARY_ITEM_COUNT, words: {}, attempts: 0, createdAt: now };
  if (!current.words || typeof current.words !== 'object') current.words = {};

  for (const item of items) {
    const wordKey = normalizeSpeakingWordKey(item.expected);
    const oldWord = current.words[wordKey] || {};
    const bestScore = Math.max(Number(oldWord.bestScore || 0), item.score);
    current.words[wordKey] = {
      word: item.expected,
      meaning: item.meaning,
      bestScore,
      lastScore: item.score,
      passed: bestScore >= 75,
      attempts: Number(oldWord.attempts || 0) + 1,
      spoken: item.spoken,
      updatedAt: now
    };
  }

  current.totalWords = VOCABULARY_ITEM_COUNT;
  current.attempts = Number(current.attempts || 0) + items.length;
  current.lastScore = Math.round(items.reduce((sum, item) => sum + item.score, 0) / Math.max(1, items.length));
  current.updatedAt = now;
  const summary = summarizeSpeakingRecord(current);
  current.bestScore = Math.max(Number(current.bestScore || 0), summary.score);
  p[key] = current;
  writeDb(db);

  res.json({
    message: `${items.length} ta vocabulary natijasi batch qilib saqlandi`,
    key,
    topic: { ...summary, score: summary.score, percent: summary.score },
    speakingSummary: summarizeSpeakingForUser(db, req.user)
  });
});

app.post('/api/speaking-progress/:language/:level/:topicNo', auth, requireSubject, (req, res) => {
  const { language, level } = req.params;
  const topicNo = Number(req.params.topicNo);
  const db = req.db;
  if (!levels.includes(level) || !topicTitles[language]?.[level]?.[topicNo - 1]) return res.status(404).json({ message: 'Mavzu topilmadi' });
  if (!isTopicUnlocked(db, req.user.id, language, level, topicNo)) return res.status(403).json({ message: 'Bu mavzu hali ochilmagan' });

  const word = String(req.body.word || req.body.expected || '').trim();
  const spoken = String(req.body.spoken || '').trim();
  const meaning = String(req.body.meaning || '').trim();
  const score = clampScore(req.body.score);
  if (!word) return res.status(400).json({ message: 'Speaking progress uchun so‘z kerak' });

  const p = userProgress(db, req.user.id);
  const key = speakingProgressKey(language, level, topicNo);
  const now = new Date().toISOString();
  const current = p[key] || { totalWords: VOCABULARY_ITEM_COUNT, words: {}, attempts: 0, createdAt: now };
  if (!current.words || typeof current.words !== 'object') current.words = {};
  const wordKey = normalizeSpeakingWordKey(word);
  const oldWord = current.words[wordKey] || {};
  const bestScore = Math.max(Number(oldWord.bestScore || 0), score);
  current.words[wordKey] = {
    word,
    meaning,
    bestScore,
    lastScore: score,
    passed: bestScore >= 75,
    attempts: Number(oldWord.attempts || 0) + 1,
    spoken,
    updatedAt: now
  };
  current.totalWords = VOCABULARY_ITEM_COUNT;
  current.attempts = Number(current.attempts || 0) + 1;
  current.lastScore = score;
  current.updatedAt = now;
  const summary = summarizeSpeakingRecord(current);
  current.bestScore = Math.max(Number(current.bestScore || 0), summary.score);
  p[key] = current;
  writeDb(db);

  res.json({
    message: 'Speaking natijasi saqlandi',
    key,
    topic: { ...summary, score: summary.score, percent: summary.score },
    speakingSummary: summarizeSpeakingForUser(db, req.user)
  });
});

app.get('/api/gate-test/:language/:level', auth, requireSubject, (req, res) => {
  const { language } = req.params;
  const level = normalizeLevelName(req.params.level);
  if (level === FIRST_LEVEL) return res.status(400).json({ message: `${FIRST_LEVEL} darajasi ochiq` });

  // Qo'lda daraja ochilgan bo'lsa gate test qaytarmaymiz. Frontend to'g'ridan-to'g'ri mavzularga o'tadi.
  if (hasAdminLevelUnlock(req.user, level) || hasLevelAccess(req.db, req.user.id, language, level)) {
    return res.json({ skipGate: true, unlocked: true, level, questions: [] });
  }

  res.json(buildGateTest(language, level));
});
app.post('/api/gate-test/:language/:level', auth, requireSubject, async (req, res) => {
  const { language, level } = req.params;
  const test = buildGateTest(language, level);
  const result = grade(test.questions, req.body.answers || {});
  const db = req.db;
  const p = userProgress(db, req.user.id);
  const key = gateKey(language, level);
  p[key] = { bestScore: Math.max(p[key]?.bestScore || 0, result.score), lastScore: result.score, attempts: (p[key]?.attempts || 0) + 1, updatedAt: new Date().toISOString() };
  writeDb(db);
  const feedback = await aiFeedback(`O'zbek tilida qisqa feedback ber. Kirish testi ${level}. Natija ${result.score}%. Xatolar: ${JSON.stringify(sanitizeChoiceDetailsForFeedback(result.details.filter(d => !d.ok)))}`, fallbackFeedback(result.details, result.score, 80));
  res.json({ ...result, passed: result.score >= LEVEL_PASS_SCORE, feedback });
});
app.post('/api/topic-test/:language/:level/:topicNo', auth, requireSubject, async (req, res) => {
  const { language, level } = req.params;
  const topicNo = Number(req.params.topicNo);
  const db = req.db;
  if (!isTopicUnlocked(db, req.user.id, language, level, topicNo)) return res.status(403).json({ message: 'Bu mavzu hali ochilmagan' });
  const topic = applyTopicOverride(db, buildTopic(language, level, topicNo));
  const result = grade(topic.questions, req.body.answers || {});
  const feedback = await aiFeedback(`O'zbek tilida o'quvchiga feedback ber. Mavzu ${topic.title}. Tanlash mashqi natijasi ${result.score}%. Xatolar: ${JSON.stringify(sanitizeChoiceDetailsForFeedback(result.details.filter(d => !d.ok)))}. Eslatma: keyingi mavzu faqat umumiy mashq natijasi 90%+ bo'lsa ochiladi.`, fallbackFeedback(result.details, result.score, 80));
  res.json({ ...result, passed: false, feedback: `${feedback} Natijani saqlash uchun “Mashq bajarish” oqimidagi ikkala qismni ham yakunlang.` });
});
app.post('/api/topic-writing-test/:language/:level/:topicNo', auth, requireSubject, async (req, res) => {
  const { language, level } = req.params;
  const topicNo = Number(req.params.topicNo);
  const db = req.db;
  if (!isTopicUnlocked(db, req.user.id, language, level, topicNo)) return res.status(403).json({ message: 'Bu mavzu hali ochilmagan' });
  const topic = applyTopicOverride(db, buildTopic(language, level, topicNo));
  const result = gradeWritingTasks(topic.writingTasks || [], req.body.answers || {});
  const feedback = await aiFeedback(
    `O'zbek tilida yozma mashq uchun qisqa feedback ber. Mavzu: ${topic.title}. Natija: ${result.score}%. Javoblar holati: ${JSON.stringify(sanitizeWritingDetailsForFeedback(result.details))}. MUHIM: gap oxiridagi nuqta, vergul, savol belgisi, undov belgisi va katta-kichik harflar xato hisoblanmasin; o'quvchi gap oxiriga nuqta qo'ysa ham, qo'ymasa ham qabul qil. Man/Men va San/Sen kabi yozilishlar qabul qilinsin. Inglizcha qisqartmalar ham qabul qilinsin: she's = she is, I'm = I am, they're = they are. Lekin o'quvchi faqat bitta so'z yozsa, masalan faqat 'u', to'g'ri deb yuqori baholama; to'liq gap talab qilinsin. Faqat ma'no, asosiy so'zlar va grammatik tartib bo'yicha tushuntir. Tinish belgisi yetishmagani haqida feedback bermagin.`,
    result.score >= 80 ? `Zo‘r! Yozma mashq ${result.score}%. Gaplar mavzuga mos. Gap oxiridagi nuqta majburiy emas.` : `Natija ${result.score}%. Yozma javob, tarjima yoki gap tuzilmasida xatolar bor. Nuqta qo‘yish-qo‘ymaslik xato hisoblanmaydi; asosiy e’tibor ma’no va grammatik tartibga qaratiladi.`
  );
  res.json({ ...result, passed: result.score >= LEVEL_PASS_SCORE, feedback });
});

app.post('/api/topic-practice/:language/:level/:topicNo', auth, requireSubject, async (req, res) => {
  const { language, level } = req.params;
  const topicNo = Number(req.params.topicNo);
  const db = req.db;
  if (!isTopicUnlocked(db, req.user.id, language, level, topicNo)) return res.status(403).json({ message: 'Bu mavzu hali ochilmagan' });

  const topic = applyTopicOverride(db, buildTopic(language, level, topicNo));
  const choiceResult = grade(topic.questions || [], req.body.choiceAnswers || {});
  const writingEnabled = Array.isArray(topic.writingTasks) && topic.writingTasks.length > 0;
  const writingResult = writingEnabled
    ? gradeWritingTasks(topic.writingTasks || [], req.body.writingAnswers || {})
    : { score: null, correct: 0, total: 0, details: [] };
  const score = writingEnabled ? Math.round((choiceResult.score + writingResult.score) / 2) : choiceResult.score;
  const passed = score >= TOPIC_PASS_SCORE;

  const dbProgress = userProgress(db, req.user.id);
  const key = progressKey(language, level, topicNo);
  const nowIso = new Date().toISOString();
  const oldProgress = dbProgress[key] || {};
  dbProgress[key] = {
    ...oldProgress,
    bestScore: Math.max(oldProgress.bestScore || 0, score),
    lastScore: score,
    choiceScore: choiceResult.score,
    writingScore: writingEnabled ? writingResult.score : null,
    attempts: (oldProgress.attempts || 0) + 1,
    passedAt: score >= TOPIC_PASS_SCORE ? (oldProgress.passedAt || nowIso) : oldProgress.passedAt,
    updatedAt: nowIso
  };
  writeDb(db);

  const feedback = await aiFeedback(
    writingEnabled
      ? `O'zbek tilida o'quvchiga qisqa feedback ber. Mavzu: ${topic.title}. Umumiy natija: ${score}%. Tanlash mashqi: ${choiceResult.score}%. Yozma mashq: ${writingResult.score}%. Tanlashdagi xatolar: ${JSON.stringify(sanitizeChoiceDetailsForFeedback(choiceResult.details.filter(d => !d.ok)))}. Yozmadagi xatolar holati: ${JSON.stringify(sanitizeWritingDetailsForFeedback(writingResult.details.filter(d => !d.ok)))}. MUHIM: mavzu faqat umumiy natija 90% yoki undan yuqori bo'lsa o'tilgan hisoblanadi. Yozma javoblarda nuqta, apostrof va katta-kichik harf xato emas. Man/Men, San/Sen qabul qilinadi. She's = she is, I'm = I am kabi qisqartmalar qabul qilinadi. Lekin faqat bitta so'z yoki to'liq bo'lmagan gapga yuqori ball berilmaydi; to'liq gap yozish kerak.`
      : `O'zbek tilida o'quvchiga qisqa feedback ber. Mavzu: ${topic.title}. Natija: ${score}%. Bu fan uchun yozma mashq yo'q, faqat tanlash mashqi baholandi. Xatolar: ${JSON.stringify(sanitizeChoiceDetailsForFeedback(choiceResult.details.filter(d => !d.ok)))}. 90% yoki undan yuqori bo'lsa keyingi mavzu ochiladi.`,
    passed
      ? (writingEnabled ? `Zo‘r! Umumiy natija ${score}%. Tanlash mashqi ${choiceResult.score}%, yozma mashq ${writingResult.score}%. Natija saqlandi. Keyingi mavzu faqat admin belgilagan keyingi dars kunida ochiladi.` : `Zo‘r! Natija ${score}%. Natija saqlandi. Keyingi mavzu faqat admin belgilagan keyingi dars kunida ochiladi.`)
      : (writingEnabled ? `Umumiy natija ${score}%. Natijani yaxshilash uchun mavzu izohi, misollar va yozma javoblarni qayta mashq qiling.` : `Natija ${score}%. Natijani yaxshilash uchun mavzuni qayta o‘qib, tanlash mashqini qayta bajaring.`)
  );

  res.json({
    score,
    passed,
    feedback,
    choiceScore: choiceResult.score,
    writingScore: writingEnabled ? writingResult.score : null,
    choice: choiceResult,
    writing: writingEnabled ? writingResult : null,
    correct: choiceResult.correct + (writingEnabled ? writingResult.correct : 0),
    total: choiceResult.total + (writingEnabled ? writingResult.total : 0)
  });
});

app.get('/api/final-test/:language/:level', auth, requireSubject, (req, res) => {
  const { language, level } = req.params;
  if (!isFinalUnlocked(req.db, req.user.id, language, level)) return res.status(403).json({ message: `Avval ${topicCountForLevel(language, level)} ta mavzuni 90%+ bilan tugating` });
  res.json(buildFinalTest(language, level));
});
app.post('/api/final-test/:language/:level', auth, requireSubject, async (req, res) => {
  const { language, level } = req.params;
  const db = req.db;
  if (!isFinalUnlocked(db, req.user.id, language, level)) return res.status(403).json({ message: 'Yakuniy test hali ochilmagan' });
  const test = buildFinalTest(language, level);
  const result = grade(test.questions, req.body.answers || {});
  const p = userProgress(db, req.user.id);
  const key = finalKey(language, level);
  const bestScore = Math.max(p[key]?.bestScore || 0, result.score);
  p[key] = {
    bestScore,
    lastScore: result.score,
    attempts: (p[key]?.attempts || 0) + 1,
    passedAt: result.score >= LEVEL_PASS_SCORE ? (p[key]?.passedAt || new Date().toISOString()) : p[key]?.passedAt,
    updatedAt: new Date().toISOString()
  };

  // Daraja sertifikati faqat 90% yoki undan yuqori natijada beriladi.
  const passed = result.score >= LEVEL_PASS_SCORE;
  const certificate = passed ? issueOrUpdateLevelCertificate(db, req.user, language, level, bestScore) : null;
  const currentIndex = levelIndex[level];
  const nextLevel = levels[currentIndex + 1];
  if (passed && nextLevel) {
    req.user.unlockedLevels = normalizeUnlockedLevels([...(req.user.unlockedLevels || []), nextLevel]);
    req.user.updatedAt = new Date().toISOString();
  }

  writeDb(db);
  const feedback = await aiFeedback(
    `O'zbek tilida yakuniy test feedback. Natija ${result.score}%. Sertifikat sharti: ${LEVEL_PASS_SCORE}%.`,
    passed
      ? `Daraja testi yakunlandi. Natijangiz: ${result.score}%. Sertifikat tayyorlandi${levels[levelIndex[level] + 1] ? ' va keyingi daraja ochildi' : ''}.`
      : `Daraja testi yakunlandi. Natijangiz: ${result.score}%. Sertifikat va keyingi daraja uchun kamida ${LEVEL_PASS_SCORE}% olish kerak.`
  );
  res.json({ ...result, passed, feedback, certificate });
});
app.get('/api/certificates/:id/download', auth, (req, res) => {
  const rawCert = req.db.certificates.find(c => c.id === req.params.id && (c.userId === req.user.id || req.user.role === 'admin'));
  if (!rawCert) return res.status(404).send('Sertifikat topilmadi');
  if (req.user.role === 'admin' && req.user.subject !== 'all' && req.user.subject !== rawCert.language) return res.status(403).send('Bu sertifikat sizning faningizga tegishli emas');
  const cert = hydrateCertificate(req.db, rawCert);
  const publicUrl = absoluteUrl(req, `/certificate/${encodeURIComponent(cert.code || cert.id)}`);
  if (req.query.format === 'pdf' || req.query.download === 'pdf') {
    const pdf = buildCertificatePdf(cert, { publicUrl });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${escapeHtml(cert.code || cert.id)}.pdf"`);
    return res.send(pdf);
  }
  const html = buildCertificateHtml(cert, { publicUrl });
  const isAttachment = req.query.download === '1';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `${isAttachment ? 'attachment' : 'inline'}; filename="${escapeHtml(cert.code || cert.id)}.html"`);
  res.send(html);
});

app.get('/certificate/:code', (req, res) => {
  const db = readDb();
  const rawCert = db.certificates.find(c => c.code === req.params.code || c.id === req.params.code);
  if (!rawCert) return res.status(404).send('Sertifikat topilmadi');
  const cert = hydrateCertificate(db, rawCert);
  const publicUrl = absoluteUrl(req, `/certificate/${encodeURIComponent(cert.code || cert.id)}`);
  if (req.query.format === 'pdf' || req.query.download === 'pdf') {
    const pdf = buildCertificatePdf(cert, { publicUrl });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${escapeHtml(cert.code || cert.id)}.pdf"`);
    return res.send(pdf);
  }
  const html = buildCertificateHtml(cert, { publicUrl });
  const isAttachment = req.query.download === '1';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `${isAttachment ? 'attachment' : 'inline'}; filename="${escapeHtml(cert.code || cert.id)}.html"`);
  res.send(html);
});

app.use('/api/admin/users', (req, res, next) => req.method === 'GET' ? next() : adminWriteRateLimit(req, res, next));
app.use('/api/admin/enrollments', (req, res, next) => req.method === 'GET' ? next() : adminWriteRateLimit(req, res, next));

app.get('/api/admin/meta', auth, adminOnly, (req, res) => {
  const availableSubjects = req.user.subject === 'all' ? subjects : subjects.filter(s => s.id === req.user.subject);
  const currentCenter = isSuperAdmin(req.user) ? null : publicCenter(centerById(req.db, req.user.centerId), req.db);
  res.json({ subjects: availableSubjects, allSubjects: subjects, levels, currentAdmin: safeUser(req.user, req.db), currentCenter, centers: isSuperAdmin(req.user) ? req.db.centers.map(center => publicCenter(center, req.db)) : [currentCenter].filter(Boolean) });
});

app.get('/api/admin/centers', auth, adminOnly, (req, res) => {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ message: 'Faqat katta admin markazlarni ko‘ra oladi' });
  const db = req.db;
  const centers = (db.centers || []).map(center => publicCenter(center, db));
  const selectedId = String(req.query.selected || centers[0]?.id || DEFAULT_CENTER_ID);
  const selectedCenter = centers.find(center => center.id === selectedId) || centers[0] || null;
  const centerUsers = selectedCenter ? db.users.filter(user => centerIdOf(user) === selectedCenter.id && !isSuperAdmin(user)).map(user => safeUser(user, db)) : [];
  res.json({ centers, selectedCenter, users: centerUsers });
});

app.post('/api/admin/centers', auth, adminOnly, async (req, res) => {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ message: 'Faqat katta admin yangi markaz yarata oladi' });
  const db = req.db;
  const name = String(req.body.name || '').trim();
  const adminUsername = String(req.body.adminUsername || '').trim().toLowerCase();
  const adminPassword = String(req.body.adminPassword || '').trim();
  const adminFullName = String(req.body.adminFullName || `${name} bosh admin`).trim();
  if (!name || !adminUsername || !adminPassword || !adminFullName) return res.status(400).json({ message: 'Markaz nomi, admin login, parol va ism familyani to‘ldiring' });
  if (!/^[a-z0-9._-]{3,32}$/.test(adminUsername)) return res.status(400).json({ message: 'Admin login 3-32 ta belgi bo‘lsin' });
  if (adminPassword.length < 6) return res.status(400).json({ message: 'Admin paroli kamida 6 ta belgidan iborat bo‘lsin' });
  if (db.users.some(u => String(u.username).toLowerCase() === adminUsername)) return res.status(400).json({ message: 'Bu admin login allaqachon bor' });
  const baseSlug = slugifyCenter(name);
  let centerId = `center_${baseSlug}`;
  let index = 2;
  while (db.centers.some(center => center.id === centerId)) centerId = `center_${baseSlug}_${index++}`;
  const now = new Date().toISOString();
  const center = { id: centerId, name, logoDataUrl: ensureCenterLogo(req.body.logoDataUrl), status: 'active', createdAt: now, createdBy: req.user.id };
  const adminUser = {
    id: makeId('u'),
    role: 'admin',
    username: adminUsername,
    passwordHash: await bcrypt.hash(adminPassword, 10),
    fullName: adminFullName,
    birthDate: '',
    subject: 'all',
    centerId,
    isSuper: false,
    isActive: true,
    createdAt: now,
    expiresAt: null,
    paymentStatus: 'paid',
    paymentAmount: '',
    paymentNote: ''
  };
  db.centers.push(center);
  db.users.push(adminUser);
  addActionLog(db, req.user, 'center_created', center.id, { name, adminUsername }, req);
  writeDb(db);
  res.json({ message: `${name} markazi va bosh admin yaratildi`, center: publicCenter(center, db), admin: safeUser(adminUser, db) });
});

app.patch('/api/admin/centers/:id', auth, adminOnly, (req, res) => {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ message: 'Faqat katta admin markazni o‘zgartira oladi' });
  const db = req.db;
  const center = db.centers.find(item => item.id === req.params.id);
  if (!center) return res.status(404).json({ message: 'Markaz topilmadi' });
  if (req.body.name) center.name = String(req.body.name || '').trim();
  if (typeof req.body.logoDataUrl !== 'undefined') center.logoDataUrl = ensureCenterLogo(req.body.logoDataUrl);
  if (req.body.status) center.status = req.body.status === 'inactive' ? 'inactive' : 'active';
  center.updatedAt = new Date().toISOString();
  addActionLog(db, req.user, 'center_updated', center.id, { patch: Object.keys(req.body || {}) }, req);
  writeDb(db);
  res.json({ message: 'Markaz ma’lumotlari yangilandi', center: publicCenter(center, db) });
});

app.get('/api/admin/enrollments', auth, adminOnly, (req, res) => {
  const db = req.db;
  const q = normalizeSearch(req.query.search || req.query.q || '');
  const base = db.enrollments
    .filter(e => canAdminAccessCenter(req.user, e.centerId || DEFAULT_CENTER_ID))
    .filter(e => req.user.subject === 'all' || e.language === req.user.subject)
    .filter(e => safeIncludes(`${e.fullName || ''} ${e.phone || ''} ${e.telegram || ''} ${e.languageTitle || ''} ${e.status || ''}`, q))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const page = paginateList(base, req, 20, 100);
  res.json({ enrollments: page.items, page: page.page, pageSize: page.pageSize, total: page.total, totalPages: page.totalPages });
});
app.patch('/api/admin/enrollments/:id', auth, adminOnly, (req, res) => {
  const db = req.db;
  const item = db.enrollments.find(e => e.id === req.params.id);
  if (!item) return res.status(404).json({ message: 'Ariza topilmadi' });
  if (!canAdminManageSubject(req.user, item.language)) return res.status(403).json({ message: 'Ruxsat yo‘q' });
  if (req.body.status) item.status = req.body.status;
  item.updatedAt = new Date().toISOString();
  addActionLog(db, req.user, 'enrollment_updated', item.id, { status: item.status }, req);
  writeDb(db);
  res.json({ enrollment: item, message: 'Ariza yangilandi' });
});
app.get('/api/admin/users', auth, adminOnly, (req, res) => {
  const db = req.db;
  const q = normalizeSearch(req.query.search || req.query.q || '');
  const status = String(req.query.status || 'all');
  const role = String(req.query.role || 'all');
  const subject = String(req.query.subject || 'all');
  const centerFilter = String(req.query.center || 'all');
  const base = visibleUsersForAdmin(db, req.user)
    .filter(u => centerFilter === 'all' || centerIdOf(u) === centerFilter)
    .filter(u => role === 'all' || u.role === role)
    .filter(u => subject === 'all' || u.subject === subject)
    .filter(u => status === 'all' || statusOf(u) === status)
    .filter(u => safeIncludes(`${u.fullName || ''} ${u.username || ''} ${u.role || ''} ${subjectMap[u.subject] || ''} ${u.subject || ''} ${statusOf(u)}`, q))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(a.fullName || '').localeCompare(String(b.fullName || '')));
  const page = paginateList(base, req, 25, 500);
  res.json({ users: page.items.map(u => safeUser(u, db)), page: page.page, pageSize: page.pageSize, total: page.total, totalPages: page.totalPages });
});
app.post('/api/admin/users', auth, adminOnly, async (req, res) => {
  const { role, username, password, fullName, birthDate, subject, isActive, expiresAt } = req.body;
  const db = req.db;
  const cleanUsername = String(username || '').trim().toLowerCase();
  const cleanFullName = String(fullName || '').trim();
  if (!isSuperAdmin(req.user) && role === 'admin') return res.status(403).json({ message: 'Markaz admini faqat o‘quvchi va o‘qituvchi yarata oladi' });
  const requestedCenterId = isSuperAdmin(req.user) ? (req.body.centerId || DEFAULT_CENTER_ID) : centerIdOf(req.user);
  if (!canAdminAccessCenter(req.user, requestedCenterId)) return res.status(403).json({ message: 'Bu markazga user yarata olmaysiz' });
  if (!db.centers.some(center => center.id === requestedCenterId)) return res.status(400).json({ message: 'Markaz topilmadi' });
  const normalizedSubject = role === 'admin' && subject === 'all' && req.user.subject === 'all' ? 'all' : (subject || (req.user.subject === 'all' ? 'english' : req.user.subject));
  if (!['admin', 'student', 'teacher'].includes(role)) return res.status(400).json({ message: 'Role xato' });
  if (normalizedSubject !== 'all' && !subjectMap[normalizedSubject]) return res.status(400).json({ message: 'Fan tanlang' });
  if (normalizedSubject === 'all' && req.user.subject !== 'all') return res.status(403).json({ message: 'Faqat super admin barcha fan adminini yarata oladi' });
  if (normalizedSubject !== 'all' && !canAdminManageSubject(req.user, normalizedSubject)) return res.status(403).json({ message: 'Siz bu fanga user yarata olmaysiz' });
  if (!cleanUsername || !password || !cleanFullName) return res.status(400).json({ message: 'Login, parol va ism familyani to‘ldiring' });
  if (!/^[a-z0-9._-]{3,32}$/.test(cleanUsername)) return res.status(400).json({ message: 'Login 3-32 ta belgi bo‘lsin: lotin harf, raqam, nuqta, _ yoki -' });
  if (String(password).length < 6) return res.status(400).json({ message: 'Parol kamida 6 ta belgidan iborat bo‘lsin' });
  if (db.users.some(u => String(u.username).toLowerCase() === cleanUsername)) return res.status(400).json({ message: 'Bu login bor' });
  const passwordHash = await bcrypt.hash(String(password), 10);
  const paymentStatus = role === 'student' ? normalizePaymentStatus(req.body.paymentStatus || 'paid') : 'paid';
  const user = {
    id: makeId('u'), role, username: cleanUsername, passwordHash, fullName: cleanFullName, birthDate: birthDate || '', subject: normalizedSubject, centerId: requestedCenterId,
    isSuper: false, isActive: role === 'student' && paymentStatus === 'unpaid' ? false : isActive !== false, createdAt: new Date().toISOString(), expiresAt: role === 'student' ? (expiresAt || todayPlus(90)) : null,
    paymentStatus, paymentAmount: req.body.paymentAmount || '', paymentNote: req.body.paymentNote || '',
    unlockedLevels: role === 'student' ? normalizeUnlockedLevels(req.body.unlockedLevels || []) : [],
    topicAccessMode: role === 'student' ? normalizeTopicAccessMode(req.body.topicAccessMode, !!req.body.allowUnlimitedTopics) : 'daily',
    allowUnlimitedTopics: role === 'student' ? normalizeTopicAccessMode(req.body.topicAccessMode, !!req.body.allowUnlimitedTopics) === 'unlimited' : false
  };
  enforcePaymentAccess(user);
  db.users.push(user);
  addActionLog(db, req.user, 'user_created', user.id, { role, username: cleanUsername, fullName: cleanFullName, subject: normalizedSubject }, req);
  writeDb(db);
  res.json({ user: safeUser(user, db), message: `${cleanFullName} yaratildi. Status: ${safeUser(user, db).status}` });
});

app.patch('/api/admin/users/plan-days/bulk', auth, adminOnly, (req, res) => {
  const db = req.db;
  const userIds = Array.isArray(req.body.userIds) ? req.body.userIds.map(id => String(id || '').trim()).filter(Boolean) : [];
  const planDays = normalizePlanDays(req.body.planDays || []);
  const unlockedLevels = normalizeUnlockedLevels(req.body.unlockedLevels || []);
  const topicAccessMode = ['daily', 'unlimited'].includes(String(req.body.topicAccessMode || '')) ? String(req.body.topicAccessMode) : '';
  const allowUnlimitedTopics = topicAccessMode === 'unlimited' || req.body.allowUnlimitedTopics === true;
  const setDailyTopicMode = topicAccessMode === 'daily';
  if (!userIds.length) return res.status(400).json({ message: 'Avval o‘quvchilarni belgilang' });
  if (!planDays.length && !unlockedLevels.length && !allowUnlimitedTopics && !setDailyTopicMode) return res.status(400).json({ message: 'Kamida bitta kun, daraja yoki mavzu rejimini tanlang' });
  const updatedUsers = [];
  for (const userId of userIds) {
    const user = db.users.find(u => u.id === userId && u.role === 'student');
    if (!user) continue;
    if (!canAdminAccessUser(req.user, user)) continue;
    if (planDays.length) user.planDays = planDays;
    if (unlockedLevels.length) user.unlockedLevels = normalizeUnlockedLevels([...(user.unlockedLevels || []), ...unlockedLevels]);
    if (allowUnlimitedTopics) { user.topicAccessMode = 'unlimited'; user.allowUnlimitedTopics = true; }
    if (setDailyTopicMode) { user.topicAccessMode = 'daily'; user.allowUnlimitedTopics = false; }
    user.updatedAt = new Date().toISOString();
    updatedUsers.push(safeUser(user, db));
  }
  if (!updatedUsers.length) return res.status(404).json({ message: 'Tanlangan o‘quvchilar topilmadi yoki ruxsat yo‘q' });
  addActionLog(db, req.user, 'plan_days_or_levels_assigned', 'students', { userIds: updatedUsers.map(u => u.id), planDays, unlockedLevels, allowUnlimitedTopics }, req);
  writeDb(db);
  const parts = [];
  if (planDays.length) parts.push('kun biriktirildi');
  if (unlockedLevels.length) parts.push(`${unlockedLevels.join(', ')} darajalari ochildi`);
  if (allowUnlimitedTopics) parts.push('hamma mavzular cheklovsiz ochildi');
  if (setDailyTopicMode) parts.push('belgilangan kunda faqat 1 ta yangi mavzu ochiladigan rejim yoqildi');
  res.json({ message: `${updatedUsers.length} ta o‘quvchiga ${parts.join(' va ')}`, users: updatedUsers, planDays, unlockedLevels, allowUnlimitedTopics, topicAccessMode: topicAccessMode || (allowUnlimitedTopics ? 'unlimited' : '') });
});

app.delete('/api/admin/users/:id', auth, adminOnly, (req, res) => {
  const db = req.db;
  if (!isSuperAdmin(req.user)) return res.status(403).json({ message: 'Faqat Pro Admin account o‘chira oladi' });
  const userIndex = db.users.findIndex(u => u.id === req.params.id);
  if (userIndex === -1) return res.status(404).json({ message: 'Foydalanuvchi topilmadi' });
  const user = db.users[userIndex];
  if (user.id === req.user.id) return res.status(400).json({ message: 'O‘zingiz kirgan Pro Admin accountni o‘chira olmaysiz' });

  // O‘chirilayotgan userning aktiv sessiyalari ham bekor qilinadi.
  for (const [oldToken, oldUserId] of tokens.entries()) {
    if (oldUserId === user.id) tokens.delete(oldToken);
  }
  if (user.sessionToken) tokens.delete(user.sessionToken);

  const deletedSummary = {
    id: user.id,
    role: user.role,
    username: user.username,
    fullName: user.fullName,
    centerId: centerIdOf(user),
    subject: user.subject
  };

  db.users.splice(userIndex, 1);
  if (db.progress && typeof db.progress === 'object') delete db.progress[user.id];
  if (Array.isArray(db.certificates)) db.certificates = db.certificates.filter(c => c.userId !== user.id);
  if (Array.isArray(db.actionLogs)) db.actionLogs = db.actionLogs.filter(log => log.actorId !== user.id && log.target !== user.id);

  addActionLog(db, req.user, 'user_deleted', user.id, deletedSummary, req);
  writeDb(db);
  res.json({ message: `${deletedSummary.fullName || deletedSummary.username} accounti o‘chirildi`, deletedUser: deletedSummary });
});

app.patch('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  const db = req.db;
  const user = db.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ message: 'Foydalanuvchi topilmadi' });
  if (user.isSuper && user.id !== req.user.id) return res.status(403).json({ message: 'Super adminni boshqa admin o‘zgarta olmaydi' });
  if (!canAdminAccessUser(req.user, user)) return res.status(403).json({ message: 'Ruxsat yo‘q' });
  if (typeof req.body.isActive !== 'undefined') {
    user.isActive = !!req.body.isActive;
    if (user.isActive && user.role === 'student' && (!user.expiresAt || isExpired(user)) && typeof req.body.expiresAt === 'undefined') {
      user.expiresAt = todayPlus(90);
    }
  }
  if (typeof req.body.expiresAt !== 'undefined') user.expiresAt = req.body.expiresAt || null;
  if (req.body.password) {
    if (String(req.body.password).length < 6) return res.status(400).json({ message: 'Parol kamida 6 ta belgidan iborat bo‘lsin' });
    user.passwordHash = await bcrypt.hash(String(req.body.password), 10);
    delete user.password;
    user.passwordUpdatedAt = new Date().toISOString();
  }
  if (req.body.fullName) user.fullName = String(req.body.fullName).trim();
  if (typeof req.body.isActive !== 'undefined' && !user.isActive) {
    if (user.sessionToken) tokens.delete(user.sessionToken);
    user.sessionToken = '';
    user.sessionId = '';
    user.sessionUpdatedAt = new Date().toISOString();
  }
  if (req.body.password) {
    for (const [oldToken, oldUserId] of tokens.entries()) {
      if (oldUserId === user.id) tokens.delete(oldToken);
    }
    user.sessionToken = '';
    user.sessionId = '';
    user.sessionUpdatedAt = new Date().toISOString();
  }
  if (req.body.subject && req.body.subject !== user.subject) {
    if (req.body.subject !== 'all' && !canAdminManageSubject(req.user, req.body.subject)) return res.status(403).json({ message: 'Bu fanga o‘zgartira olmaysiz' });
    if (req.body.subject === 'all' && req.user.subject !== 'all') return res.status(403).json({ message: 'Faqat super admin all qila oladi' });
    user.subject = req.body.subject;
  }
  if (typeof req.body.paymentStatus !== 'undefined') user.paymentStatus = normalizePaymentStatus(req.body.paymentStatus || 'paid');
  if (typeof req.body.planDays !== 'undefined') user.planDays = normalizePlanDays(req.body.planDays);
  if (typeof req.body.unlockedLevels !== 'undefined' && user.role === 'student') user.unlockedLevels = normalizeUnlockedLevels(req.body.unlockedLevels);
  if (typeof req.body.topicAccessMode !== 'undefined' && user.role === 'student') { user.topicAccessMode = normalizeTopicAccessMode(req.body.topicAccessMode, !!user.allowUnlimitedTopics); user.allowUnlimitedTopics = user.topicAccessMode === 'unlimited'; }
  else if (typeof req.body.allowUnlimitedTopics !== 'undefined' && user.role === 'student') { user.allowUnlimitedTopics = !!req.body.allowUnlimitedTopics; user.topicAccessMode = normalizeTopicAccessMode(user.topicAccessMode, !!user.allowUnlimitedTopics); }
  if (user.role === 'student') enforcePaymentAccess(user);
  if (typeof req.body.paymentAmount !== 'undefined') user.paymentAmount = req.body.paymentAmount || '';
  if (typeof req.body.paymentNote !== 'undefined') user.paymentNote = req.body.paymentNote || '';
  user.updatedAt = new Date().toISOString();
  addActionLog(db, req.user, 'user_updated', user.id, { patch: Object.keys(req.body || {}) }, req);
  writeDb(db);
  const finalStatus = safeUser(user, db).status;
  res.json({ user: safeUser(user, db), message: `Foydalanuvchi yangilandi. Hozirgi status: ${finalStatus}` });
});
app.get('/api/admin/users/:id/progress', auth, adminOnly, (req, res) => {
  const db = req.db;
  const user = db.users.find(u => u.id === req.params.id && u.role === 'student');
  if (!user) return res.status(404).json({ message: 'O‘quvchi topilmadi' });
  if (!canAdminAccessUser(req.user, user)) return res.status(403).json({ message: 'Ruxsat yo‘q' });
  res.json({ user: safeUser(user, db) });
});
app.get('/api/admin/report', auth, adminOnly, (req, res) => {
  const db = req.db;
  const visibleUsers = visibleUsersForAdmin(db, req.user);
  const students = visibleUsers.filter(u => u.role === 'student');
  const admins = visibleUsers.filter(u => u.role === 'admin');
  const teachers = visibleUsers.filter(u => u.role === 'teacher');
  const safeStudents = students.map(user => safeUser(user, db));
  let totalAttempts = 0;
  let masteredTopics = 0;
  let speakingAttempts = 0;
  let speakingCheckedWords = 0;
  let speakingPassedWords = 0;
  let speakingTotalWords = 0;
  const completedBySubject = {};
  const lowTopicRows = [];
  const speakingRows = [];
  for (const user of students) {
    const p = db.progress[user.id] || {};
    for (const [key, val] of Object.entries(p)) {
      const subjectId = subjectFromProgressKey(key);
      if (req.user.subject !== 'all' && subjectId !== req.user.subject) continue;
      const parts = key.split(':');
      const level = parts[1] || '';
      const kind = parts[2] || '';
      const isTopic = kind === 'topic';
      const isSpeaking = kind === 'speaking';
      const topicNo = (isTopic || isSpeaking) ? Number(parts[3] || 0) : null;
      if (isSpeaking) {
        const topicTitle = topicNo ? (topicTitles[subjectId]?.[level]?.[topicNo - 1] || '') : '';
        const speech = summarizeSpeakingRecord(val);
        speakingAttempts += Number(speech.attempts || 0);
        speakingCheckedWords += Number(speech.checkedWords || 0);
        speakingPassedWords += Number(speech.passedWords || 0);
        speakingTotalWords += Number(speech.totalWords || 0);
        speakingRows.push({ userId: user.id, fullName: user.fullName, username: user.username, subject: user.subject, subjectTitle: subjectMap[user.subject], key, level, topicNo, topicTitle, speakingScore: speech.score, checkedWords: speech.checkedWords, passedWords: speech.passedWords, totalWords: speech.totalWords, attempts: speech.attempts, updatedAt: speech.updatedAt });
        continue;
      }
      totalAttempts += Number(val.attempts || 0);
      if (isTopic && Number(val.bestScore || 0) >= 80) {
        masteredTopics += 1;
        completedBySubject[subjectId] = (completedBySubject[subjectId] || 0) + 1;
      }
      if (isTopic && Number(val.attempts || 0) > 0 && Number(val.bestScore || 0) < 80) {
        const topicTitle = topicNo ? (topicTitles[subjectId]?.[level]?.[topicNo - 1] || '') : '';
        lowTopicRows.push({ userId: user.id, fullName: user.fullName, username: user.username, subject: user.subject, subjectTitle: subjectMap[user.subject], key, level, topicNo, topicTitle, bestScore: val.bestScore, lastScore: val.lastScore, attempts: val.attempts, updatedAt: val.updatedAt });
      }
    }
  }
  lowTopicRows.sort((a, b) => Number(a.bestScore || 0) - Number(b.bestScore || 0) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const activeCount = safeStudents.filter(user => user.status === 'active').length;
  const nonActiveCount = safeStudents.filter(user => user.status === 'non-active').length;
  const expiredCount = safeStudents.filter(user => user.status === 'expired').length;
  const avgProgress = Math.round(safeStudents.reduce((sum, user) => sum + Number(user.progressPercent || 0), 0) / Math.max(1, safeStudents.length));
  const avgSpeaking = Math.round(safeStudents.reduce((sum, user) => sum + Number(user.speakingPercent || 0), 0) / Math.max(1, safeStudents.length));
  speakingAttempts = safeStudents.reduce((sum, user) => sum + Number(user.speakingAttempts || 0), 0);
  speakingCheckedWords = safeStudents.reduce((sum, user) => sum + Number(user.speakingCheckedWords || 0), 0);
  speakingPassedWords = safeStudents.reduce((sum, user) => sum + Number(user.speakingPassedWords || 0), 0);
  speakingTotalWords = safeStudents.reduce((sum, user) => sum + Number(user.speakingTotalWords || 0), 0);
  const speakingPassedPercent = speakingTotalWords ? Math.round((speakingPassedWords / speakingTotalWords) * 100) : 0;
  speakingRows.sort((a, b) => Number(a.speakingScore || 0) - Number(b.speakingScore || 0) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const subjectStats = (req.user.subject === 'all' ? subjects : subjects.filter(s => s.id === req.user.subject)).map(subject => {
    const subjectStudents = safeStudents.filter(user => user.subject === subject.id);
    const active = subjectStudents.filter(user => user.status === 'active').length;
    const avg = Math.round(subjectStudents.reduce((sum, user) => sum + Number(user.progressPercent || 0), 0) / Math.max(1, subjectStudents.length));
    const completed = completedBySubject[subject.id] || 0;
    return { ...subject, count: subjectStudents.length, active, avg, completed };
  });
  const levelStats = levels.map(level => {
    const levelUsers = safeStudents.filter(user => (user.currentLevel || FIRST_LEVEL) === level);
    const avg = Math.round(levelUsers.reduce((sum, user) => sum + Number(user.progressPercent || 0), 0) / Math.max(1, levelUsers.length));
    return { level, count: levelUsers.length, avg };
  });
  const weakStudents = safeStudents
    .sort((a, b) => Number(a.progressPercent || 0) - Number(b.progressPercent || 0) || Number(a.currentTopicScore || 0) - Number(b.currentTopicScore || 0))
    .slice(0, 8)
    .map(user => ({ id: user.id, fullName: user.fullName, username: user.username, subjectTitle: user.subjectTitle, currentLevel: user.currentLevel, currentTopicTitle: user.currentTopicTitle, progressPercent: user.progressPercent, currentTopicScore: user.currentTopicScore }));
  const expiringSoon = safeStudents.filter(user => {
    if (!user.expiresAt || user.status !== 'active') return false;
    const diff = Math.ceil((new Date(user.expiresAt + 'T23:59:59') - new Date()) / (1000 * 60 * 60 * 24));
    return diff >= 0 && diff <= 7;
  }).slice(0, 10);
  const certificateCount = db.certificates.filter(c => canAdminAccessCenter(req.user, c.centerId || centerIdOf(db.users.find(u => u.id === c.userId) || {})) && (req.user.subject === 'all' || c.language === req.user.subject)).length;
  const pendingEnrollments = db.enrollments.filter(item => canAdminAccessCenter(req.user, item.centerId || DEFAULT_CENTER_ID) && (req.user.subject === 'all' || item.language === req.user.subject) && item.status === 'new').length;
  const unpaidCount = safeStudents.filter(user => user.paymentStatus === 'unpaid').length;
  const ranking = [...safeStudents]
    .sort((a, b) => Number(b.progressPercent || 0) - Number(a.progressPercent || 0) || Number(b.currentTopicScore || 0) - Number(a.currentTopicScore || 0))
    .slice(0, 10)
    .map((user, index) => ({ rank: index + 1, id: user.id, fullName: user.fullName, subjectTitle: user.subjectTitle, currentLevel: user.currentLevel, progressPercent: user.progressPercent, currentTopicScore: user.currentTopicScore }));
  const notifications = buildNotifications(db, req.user);
  res.json({
    stats: { studentCount: safeStudents.length, adminCount: admins.length, teacherCount: teachers.length, activeCount, nonActiveCount, expiredCount, avgProgress, avgSpeaking, speakingPassedPercent, speakingAttempts, speakingCheckedWords, speakingPassedWords, speakingTotalWords, totalAttempts, masteredTopics, pendingEnrollments, certificateCount, unpaidCount },
    subjectStats,
    levelStats,
    weakStudents,
    lowTopicRows: lowTopicRows.slice(0, 20),
    speakingRows: speakingRows.slice(0, 20),
    expiringSoon,
    ranking,
    centerStats: isSuperAdmin(req.user) ? db.centers.map(center => publicCenter(center, db)) : [publicCenter(centerById(db, req.user.centerId), db)],
    notifications: notifications.slice(0, 15)
  });
});

app.get('/api/admin/certificates', auth, adminOnly, (req, res) => {
  const db = req.db;
  const q = normalizeSearch(req.query.search || req.query.q || '');
  const subject = String(req.query.subject || 'all');
  const base = db.certificates
    .filter(c => canAdminAccessCenter(req.user, c.centerId || centerIdOf(db.users.find(u => u.id === c.userId) || {})))
    .filter(c => req.user.subject === 'all' || c.language === req.user.subject)
    .filter(c => subject === 'all' || c.language === subject)
    .map(c => ({ ...hydrateCertificate(db, c), subjectTitle: subjectMap[c.language] || c.language }))
    .filter(c => safeIncludes(`${c.fullName || ''} ${c.language || ''} ${c.subjectTitle || ''} ${c.level || ''} ${c.code || ''} ${c.id || ''}`, q))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const page = paginateList(base, req, 12, 60);
  res.json({ certificates: page.items, page: page.page, pageSize: page.pageSize, total: page.total, totalPages: page.totalPages });
});


app.get('/api/admin/action-logs', auth, adminOnly, (req, res) => {
  const q = normalizeSearch(req.query.search || '');
  const rows = (req.db.actionLogs || [])
    .filter(row => safeIncludes(`${row.actorName || ''} ${row.action || ''} ${row.target || ''} ${JSON.stringify(row.details || {})}`, q));
  const page = paginateList(rows, req, 20, 100);
  res.json({ logs: page.items, page: page.page, pageSize: page.pageSize, total: page.total, totalPages: page.totalPages });
});

app.get('/api/admin/system-logs', auth, adminOnly, (req, res) => {
  const rows = req.db.systemLogs || [];
  const page = paginateList(rows, req, 20, 100);
  res.json({ logs: page.items, page: page.page, pageSize: page.pageSize, total: page.total, totalPages: page.totalPages });
});

app.get('/api/admin/notifications', auth, adminOnly, (req, res) => {
  res.json({ notifications: buildNotifications(req.db, req.user) });
});

app.get('/api/admin/backups', auth, adminOnly, (req, res) => {
  res.json({ backups: listBackups().slice(0, 80) });
});
app.post('/api/admin/backups', auth, adminOnly, (req, res) => {
  const db = req.db;
  const backup = createBackupFile(db, 'manual', req.user);
  addActionLog(db, req.user, 'backup_created', backup.filename, backup, req);
  writeDb(db);
  res.json({ message: 'Backup yaratildi', backup });
});
app.get('/api/admin/backups/:filename', auth, adminOnly, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(ensureBackupDir(), filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'Backup topilmadi' });
  res.download(filePath, filename);
});

app.get('/api/admin/export/users.csv', auth, adminOnly, (req, res) => {
  const db = req.db;
  const rows = visibleUsersForAdmin(db, req.user).map(u => safeUser(u, db));
  const csv = toCsv(rows, [
    { label: 'ID', value: 'id' }, { label: 'Role', value: 'role' }, { label: 'Login', value: 'username' },
    { label: 'Ism Familya', value: 'fullName' }, { label: 'Fan', value: 'subjectTitle' }, { label: 'Daraja', value: 'currentLevel' },
    { label: 'Kelgan mavzu', value: 'currentTopicTitle' }, { label: 'Progress %', value: 'progressPercent' },
    { label: 'Status', value: 'status' }, { label: 'Tolov', value: 'paymentStatusTitle' }, { label: 'Muddat', value: 'expiresAt' }, { label: 'Oxirgi login', value: 'lastLoginAt' }
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="users-export.csv"');
  res.send(csv);
});
app.get('/api/admin/export/results.csv', auth, adminOnly, (req, res) => {
  const db = req.db;
  const rows = [];
  for (const user of visibleStudentsForAdmin(db, req.user)) {
    const p = db.progress[user.id] || {};
    for (const [key, val] of Object.entries(p)) {
      const [subject, level, kind, topicNo] = key.split(':');
      const speech = kind === 'speaking' ? summarizeSpeakingRecord(val) : null;
      rows.push({ user, subjectTitle: subjectMap[subject] || subject, level, kind, topicNo: topicNo || '', bestScore: speech ? speech.score : (val.bestScore || 0), lastScore: val.lastScore || 0, attempts: speech ? speech.attempts : (val.attempts || 0), checkedWords: speech ? speech.checkedWords : '', passedWords: speech ? speech.passedWords : '', updatedAt: val.updatedAt || '' });
    }
  }
  const csv = toCsv(rows, [
    { label: 'Ism Familya', value: r => r.user.fullName }, { label: 'Login', value: r => r.user.username }, { label: 'Fan', value: 'subjectTitle' },
    { label: 'Daraja', value: 'level' }, { label: 'Turi', value: 'kind' }, { label: 'Mavzu', value: 'topicNo' },
    { label: 'Eng yaxshi %', value: 'bestScore' }, { label: 'Oxirgi %', value: 'lastScore' }, { label: 'Urinish', value: 'attempts' },
    { label: 'Speaking aytilgan soz', value: 'checkedWords' }, { label: 'Speaking togri soz', value: 'passedWords' }, { label: 'Sana', value: 'updatedAt' }
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="results-export.csv"');
  res.send(csv);
});
app.get('/api/admin/export/certificates.csv', auth, adminOnly, (req, res) => {
  const db = req.db;
  const rows = db.certificates.filter(c => canAdminAccessCenter(req.user, c.centerId || centerIdOf(db.users.find(u => u.id === c.userId) || {})) && (req.user.subject === 'all' || c.language === req.user.subject)).map(c => ({ ...hydrateCertificate(db, c), subjectTitle: subjectMap[c.language] || c.language, centerName: centerById(db, c.centerId).name }));
  const csv = toCsv(rows, [
    { label: 'Sertifikat ID', value: 'code' }, { label: 'Ism Familya', value: 'fullName' }, { label: 'Fan', value: 'subjectTitle' },
    { label: 'Daraja', value: 'level' }, { label: 'Natija %', value: 'score' }, { label: 'Sana', value: 'createdAt' }
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="certificates-export.csv"');
  res.send(csv);
});
app.post('/api/admin/import/users-csv', auth, adminOnly, async (req, res) => {
  const csv = String(req.body.csv || '');
  if (!csv.trim()) return res.status(400).json({ message: 'CSV matn yoki fayl yuborilmadi' });
  const rows = parseCsv(csv);
  const db = req.db;
  const created = [];
  const skipped = [];
  for (const row of rows) {
    const username = normalizeSearch(row.login || row.username || row['foydalanuvchi login'] || '').replace(/\s+/g, '_');
    const fullName = String(row['ism familya'] || row.fullname || row.full_name || row.fish || row['f.i.sh'] || '').trim();
    const subject = String(row.fan || row.subject || row.language || 'english').trim() || 'english';
    const password = String(row.parol || row.password || 'student123').trim() || 'student123';
    if (!username || !fullName || !subjectMap[subject]) { skipped.push({ username, fullName, reason: 'login/ism/fan xato' }); continue; }
    const rowCenterId = isSuperAdmin(req.user) ? (row.markaz || row.center || row.centerid || req.body.centerId || DEFAULT_CENTER_ID) : centerIdOf(req.user);
    if (!canAdminAccessCenter(req.user, rowCenterId)) { skipped.push({ username, fullName, reason: 'markaz uchun ruxsat yo‘q' }); continue; }
    if (!canAdminManageSubject(req.user, subject)) { skipped.push({ username, fullName, reason: 'fan uchun ruxsat yo‘q' }); continue; }
    if (db.users.some(u => String(u.username).toLowerCase() === username)) { skipped.push({ username, fullName, reason: 'login mavjud' }); continue; }
    const user = {
      id: makeId('u'), role: 'student', username, passwordHash: await bcrypt.hash(password, 10), fullName,
      birthDate: row['tugilgan sana'] || row.birthdate || '', subject, centerId: rowCenterId, isSuper: false, isActive: true,
      createdAt: new Date().toISOString(), expiresAt: row.muddat || row.expiresat || todayPlus(90),
      paymentStatus: normalizePaymentStatus(row.tolov || row.payment || 'paid'), paymentAmount: row.summa || '', paymentNote: row.izoh || ''
    };
    enforcePaymentAccess(user);
    db.users.push(user);
    created.push(safeUser(user, db));
  }
  addActionLog(db, req.user, 'users_imported_csv', 'users', { created: created.length, skipped: skipped.length }, req);
  writeDb(db);
  res.json({ message: `${created.length} ta account import qilindi, ${skipped.length} ta o‘tkazib yuborildi`, created, skipped });
});

app.get('/api/admin/topic-editor', auth, adminOnly, (req, res) => {
  const { language = 'english', level = FIRST_LEVEL, topicNo = '1' } = req.query;
  if (!subjectMap[language] || !levels.includes(level)) return res.status(400).json({ message: 'Fan yoki daraja xato' });
  if (!canAdminManageSubject(req.user, language)) return res.status(403).json({ message: 'Bu fanni tahrirlashga ruxsat yo‘q' });
  const key = topicOverrideKey(language, level, Number(topicNo));
  res.json({ key, override: req.db.customContent?.topics?.[key] || {}, baseTopic: buildTopic(language, level, Number(topicNo)) });
});
app.put('/api/admin/topic-editor', auth, adminOnly, (req, res) => {
  const { language, level, topicNo, youtubeVideoUrl = '', extraNote = '', vocabularyText = '', questionsText = '' } = req.body;
  if (!subjectMap[language] || !levels.includes(level)) return res.status(400).json({ message: 'Fan yoki daraja xato' });
  if (!canAdminManageSubject(req.user, language)) return res.status(403).json({ message: 'Bu fanni tahrirlashga ruxsat yo‘q' });
  const db = req.db;
  const key = topicOverrideKey(language, level, Number(topicNo));
  const vocabulary = String(vocabularyText || '').split(/\r?\n/).map(line => {
    const [word, meaning, example] = line.split('|').map(x => String(x || '').trim());
    return word ? { word, meaning: meaning || 'admin qo‘shgan so‘z', example: example || word } : null;
  }).filter(Boolean);
  const questions = String(questionsText || '').split(/\r?\n/).map((line, idx) => {
    const parts = line.split('|').map(x => String(x || '').trim());
    if (parts.length < 6) return null;
    const packed = forceCorrectAnswerA(parts.slice(1, 5), Math.max(0, Math.min(3, Number(parts[5] || 0))), idx + 91);
    return { question: parts[0], options: packed.options, correctIndex: packed.correctIndex, note: parts[6] || '' };
  }).filter(Boolean);
  const videoId = String(youtubeVideoUrl || '').match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{6,})/)?.[1] || '';
  db.customContent.topics[key] = {
    extraNote: String(extraNote || '').trim(),
    vocabulary,
    questions,
    youtubeVideo: videoId ? { videoId, embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`, searchUrl: youtubeVideoUrl } : null,
    updatedAt: new Date().toISOString(),
    updatedBy: req.user.id
  };
  addActionLog(db, req.user, 'topic_content_updated', key, { language, level, topicNo }, req);
  writeDb(db);
  res.json({ message: 'Mavzu kontenti saqlandi', override: db.customContent.topics[key] });
});

app.get('/api/verify-certificate/:code', (req, res) => {
  const db = readDb();
  const rawCert = db.certificates.find(c => c.code === req.params.code || c.id === req.params.code);
  if (!rawCert) return res.status(404).json({ valid: false, message: 'Sertifikat topilmadi yoki haqiqiy emas' });
  res.json(publicVerificationData(db, rawCert));
});

app.get('/api/teacher/dashboard', auth, teacherOnly, (req, res) => {
  const db = req.db;
  const subject = req.user.role === 'admin' ? (req.query.subject || req.user.subject) : teacherSubject(req);
  if (req.user.role === 'admin' && req.user.subject !== 'all' && subject !== req.user.subject) return res.status(403).json({ message: 'Ruxsat yo‘q' });
  const students = db.users.filter(u => u.role === 'student' && u.subject === subject && canAdminAccessCenter(req.user, centerIdOf(u))).map(u => safeUser(u, db));
  const avgProgress = Math.round(students.reduce((sum, u) => sum + Number(u.progressPercent || 0), 0) / Math.max(1, students.length));
  const avgSpeaking = Math.round(students.reduce((sum, u) => sum + Number(u.speakingPercent || 0), 0) / Math.max(1, students.length));
  const weak = [...students].sort((a,b)=>Number(a.progressPercent||0)-Number(b.progressPercent||0)).slice(0,10);
  const ranking = [...students].sort((a,b)=>Number(b.progressPercent||0)-Number(a.progressPercent||0)).slice(0,10);
  const speakingRanking = [...students].sort((a,b)=>Number(b.speakingPercent||0)-Number(a.speakingPercent||0)).slice(0,10);
  res.json({ subject, subjectTitle: subjectMap[subject] || subject, stats: { students: students.length, avgProgress, avgSpeaking, active: students.filter(u=>u.status==='active').length }, weak, ranking, speakingRanking, notifications: buildNotifications(db, { ...req.user, subject }) });
});
app.get('/api/teacher/students', auth, teacherOnly, (req, res) => {
  const db = req.db;
  const subject = req.user.role === 'admin' ? (req.query.subject || req.user.subject) : teacherSubject(req);
  const q = normalizeSearch(req.query.search || '');
  const rows = db.users.filter(u => u.role === 'student' && u.subject === subject && canAdminAccessCenter(req.user, centerIdOf(u))).map(u => safeUser(u, db)).filter(u => safeIncludes(`${u.fullName} ${u.username} ${u.currentLevel} ${u.currentTopicTitle}`, q));
  const page = paginateList(rows, req, 25, 100);
  res.json({ students: page.items, page: page.page, total: page.total, totalPages: page.totalPages });
});
app.get('/api/teacher/students/:id/progress', auth, teacherOnly, (req, res) => {
  const db = req.db;
  const user = db.users.find(u => u.id === req.params.id && u.role === 'student');
  if (!user) return res.status(404).json({ message: 'O‘quvchi topilmadi' });
  if (req.user.role === 'teacher' && (user.subject !== teacherSubject(req) || centerIdOf(user) !== centerIdOf(req.user))) return res.status(403).json({ message: 'Bu o‘quvchi sizning markazingiz yoki faningizda emas' });
  res.json({ user: safeUser(user, db) });
});



process.on('unhandledRejection', (reason) => {
  const message = reason?.message || String(reason || 'Unhandled rejection');
  console.error('Unhandled rejection:', message);
  addSystemLog('error', 'Unhandled rejection', { message });
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  addSystemLog('critical', 'Uncaught exception', { message: err.message, stack: err.stack });
});

initPersistentDb()
  .then(() => app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend running on 0.0.0.0:${PORT}`);
    console.log(`OpenAI AI mode: ${OPENAI_API_KEY ? `enabled (${OPENAI_MODEL})` : 'disabled (OPENAI_API_KEY not set)'}`);
    startDailyBackupScheduler();
  }))
  .catch((err) => {
    console.error('Backend start error:', err);
    process.exit(1);
  });
