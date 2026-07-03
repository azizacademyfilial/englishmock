require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
if (!DATABASE_URL) {
  console.error('DATABASE_URL topilmadi. backend/.env fayliga PostgreSQL URL yozing.');
  process.exit(1);
}

const ssl = (process.env.PGSSLMODE || '').toLowerCase() === 'require' || process.env.DATABASE_SSL === 'true'
  ? { rejectUnauthorized: false }
  : undefined;
const pool = new Pool({ connectionString: DATABASE_URL, ssl });

function todayPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function ensurePasswordHashSync(user) {
  if (!user || user.passwordHash) return;
  if (!user.password) return;
  user.passwordHash = bcrypt.hashSync(String(user.password), 10);
  delete user.password;
  user.passwordUpdatedAt = new Date().toISOString();
}

function normalizeDb(db) {
  const now = new Date().toISOString();
  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.enrollments)) db.enrollments = [];
  if (!Array.isArray(db.certificates)) db.certificates = [];
  if (!db.progress || typeof db.progress !== 'object') db.progress = {};
  for (const user of db.users) {
    if (!user.id) user.id = `u_${Math.random().toString(16).slice(2)}`;
    if (!user.role) user.role = 'student';
    if (!user.username) user.username = user.id;
    if (!user.subject) user.subject = user.role === 'admin' ? 'all' : 'english';
    if (typeof user.isSuper === 'undefined') user.isSuper = user.username === 'admin';
    if (typeof user.isActive === 'undefined') user.isActive = true;
    if (!user.createdAt) user.createdAt = now;
    if (typeof user.expiresAt === 'undefined') user.expiresAt = user.role === 'student' ? todayPlus(365) : null;
    ensurePasswordHashSync(user);
  }
  return db;
}

async function ensureSchema(client) {
  await client.query(`
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

async function main() {
  const reset = process.argv.includes('--reset');
  const dbPath = path.join(__dirname, '..', 'data', 'db.json');
  if (!fs.existsSync(dbPath)) {
    console.error('backend/data/db.json topilmadi. Import qilish uchun fayl kerak.');
    process.exit(1);
  }
  const db = normalizeDb(JSON.parse(fs.readFileSync(dbPath, 'utf8')));
  const client = await pool.connect();
  try {
    await client.query('begin');
    await ensureSchema(client);
    if (reset) {
      await client.query('delete from app_users');
      await client.query('delete from app_enrollments');
      await client.query('delete from app_progress');
      await client.query('delete from app_certificates');
    }

    for (const user of db.users) {
      await client.query(
        `insert into app_users
         (id, role, username, full_name, subject, is_super, is_active, expires_at, created_at, session_id, session_updated_at, data)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
         on conflict (id) do update set
           role = excluded.role,
           username = excluded.username,
           full_name = excluded.full_name,
           subject = excluded.subject,
           is_super = excluded.is_super,
           is_active = excluded.is_active,
           expires_at = excluded.expires_at,
           created_at = excluded.created_at,
           session_id = excluded.session_id,
           session_updated_at = excluded.session_updated_at,
           data = excluded.data`,
        [user.id, user.role, user.username, user.fullName || '', user.subject, !!user.isSuper, !!user.isActive, user.expiresAt || null, user.createdAt || null, user.sessionId || null, user.sessionUpdatedAt || null, JSON.stringify(user)]
      );
    }

    for (const enrollment of db.enrollments) {
      await client.query(
        `insert into app_enrollments (id, user_id, created_at, data)
         values ($1,$2,$3,$4::jsonb)
         on conflict (id) do update set user_id = excluded.user_id, created_at = excluded.created_at, data = excluded.data`,
        [enrollment.id, enrollment.userId || enrollment.studentId || null, enrollment.createdAt || null, JSON.stringify(enrollment)]
      );
    }

    for (const [userId, data] of Object.entries(db.progress)) {
      await client.query(
        `insert into app_progress (user_id, data, updated_at)
         values ($1,$2::jsonb,now())
         on conflict (user_id) do update set data = excluded.data, updated_at = now()`,
        [userId, JSON.stringify(data || {})]
      );
    }

    for (const cert of db.certificates) {
      await client.query(
        `insert into app_certificates (id, user_id, code, language, level, score, created_at, data)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         on conflict (id) do update set user_id = excluded.user_id, code = excluded.code, language = excluded.language, level = excluded.level, score = excluded.score, created_at = excluded.created_at, data = excluded.data`,
        [cert.id || cert.code, cert.userId || null, cert.code || cert.id || null, cert.language || cert.subject || null, cert.level || null, Number(cert.score || 0), cert.createdAt || null, JSON.stringify(cert)]
      );
    }

    await client.query(
      `insert into app_meta (key, value, updated_at) values ('migration', $1::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [JSON.stringify({ importedAt: new Date().toISOString(), users: db.users.length, certificates: db.certificates.length, reset })]
    );
    await client.query('commit');
    console.log(`PostgreSQLga import qilindi: ${db.users.length} user, ${db.certificates.length} sertifikat, ${Object.keys(db.progress).length} progress yozuvi.`);
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
