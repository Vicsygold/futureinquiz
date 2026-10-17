// FutureIN Quiz — quiz platform with class question banks and a private admin area.
// No external packages: Node's built-in http server and SQLite (Node 22.13+).
//
// Children:  /            (pick name, school, class)  ·  /quiz/<class-id>  (class pre-selected)
// Admin:     /admin       (or ADMIN_PATH) — username + password, never linked from children's pages
//
// Security notes
// - The admin password is stored only as a salted scrypt hash (data/admin.json or ADMIN_PASSWORD_HASH).
// - Admin sessions use a random token in an HttpOnly, SameSite=Strict cookie; only its SHA-256 is stored.
// - Repeated wrong logins from one address are locked out for 15 minutes.
// - Correct answers never leave the server; marking and timing happen here.

const http = require('http');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'quiz.db');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const ADMIN_PATH = ('/' + (process.env.ADMIN_PATH || 'admin').replace(/^\/+|\/+$/g, '')).toLowerCase();
const SESSION_HOURS = 12;
const PUBLIC_DIR = path.join(__dirname, 'public');

const CLASSES = [
  { id: 'nursery-2', label: 'Nursery 2' },
  ...Array.from({ length: 12 }, (_, i) => ({ id: `year-${i + 1}`, label: `Year ${i + 1}` })),
];
const CLASS_BY_ID = new Map(CLASSES.map((c) => [c.id, c]));

// ---------- Database ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS questions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id   TEXT NOT NULL,
    position   INTEGER NOT NULL,
    text       TEXT NOT NULL,
    options    TEXT NOT NULL,
    answer     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_q_class ON questions(class_id, position);
  CREATE TABLE IF NOT EXISTS class_settings (
    class_id   TEXT PRIMARY KEY,
    published  INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS attempts (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    school      TEXT NOT NULL,
    class_id    TEXT NOT NULL,
    name_key    TEXT NOT NULL,
    school_key  TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    score       INTEGER,
    total       INTEGER,
    duration_ms INTEGER,
    answer_key  TEXT NOT NULL,
    answers     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_att_class ON attempts(class_id, name_key, school_key);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    pw_fp      TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

const q = {
  questionsFor: db.prepare(`SELECT id, text, options, answer FROM questions WHERE class_id = ? ORDER BY position, id`),
  deleteQuestions: db.prepare(`DELETE FROM questions WHERE class_id = ?`),
  insertQuestion: db.prepare(`INSERT INTO questions (class_id, position, text, options, answer) VALUES (?, ?, ?, ?, ?)`),
  getSetting: db.prepare(`SELECT published, updated_at FROM class_settings WHERE class_id = ?`),
  setPublished: db.prepare(`INSERT INTO class_settings (class_id, published, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(class_id) DO UPDATE SET published = excluded.published, updated_at = excluded.updated_at`),
  touch: db.prepare(`INSERT INTO class_settings (class_id, published, updated_at) VALUES (?, 0, ?)
    ON CONFLICT(class_id) DO UPDATE SET updated_at = excluded.updated_at`),
  counts: db.prepare(`SELECT class_id, COUNT(*) AS n FROM questions GROUP BY class_id`),
  attemptCounts: db.prepare(`SELECT class_id, COUNT(*) AS n FROM attempts WHERE finished_at IS NOT NULL GROUP BY class_id`),
  settings: db.prepare(`SELECT class_id, published, updated_at FROM class_settings`),
  insertAttempt: db.prepare(`INSERT INTO attempts (id, name, school, class_id, name_key, school_key, started_at, answer_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  getAttempt: db.prepare(`SELECT * FROM attempts WHERE id = ?`),
  finishAttempt: db.prepare(`UPDATE attempts SET finished_at = ?, score = ?, total = ?, duration_ms = ?, answers = ?
    WHERE id = ? AND finished_at IS NULL`),
  insertSession: db.prepare(`INSERT INTO sessions (token_hash, username, pw_fp, expires_at) VALUES (?, ?, ?, ?)`),
  getSession: db.prepare(`SELECT username, pw_fp, expires_at FROM sessions WHERE token_hash = ?`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE token_hash = ?`),
  purgeSessions: db.prepare(`DELETE FROM sessions WHERE expires_at < ?`),
  purgeOpenAttempts: db.prepare(`DELETE FROM attempts WHERE finished_at IS NULL AND started_at < ?`),
};

function seedNursery() {
  try {
    const existing = q.questionsFor.all('nursery-2');
    if (existing.length === 0) {
      const nurseryQs = [
        { text: 'Find the computer!', options: ['Computer', 'Banana 🍌', 'Car 🚗'], answer: 0 },
        { text: 'Which one is a computer?', options: ['Laptop', 'Teddy Bear 🧸', 'Football ⚽'], answer: 0 },
        { text: 'A computer is a… machine!', options: ['Computer', 'Apple 🍎', 'Cat 🐱'], answer: 0 },
        { text: 'Find the System Unit!', options: ['System Unit (Tower)', 'Monitor', 'Mouse'], answer: 0 },
        { text: 'The brain of the computer?', options: ['System Unit (Tower)', 'Banana 🍌', 'Balloon 🎈'], answer: 0 },
        { text: 'What makes the computer work?', options: ['System Unit (Tower)', 'Teddy Bear 🧸', 'Juice Cup 🥤'], answer: 0 },
        { text: 'Find the Monitor!', options: ['Monitor', 'System Unit (Tower)', 'Mouse'], answer: 0 },
        { text: 'We SEE pictures on the…', options: ['Monitor', 'Shoe 👟', 'Apple 🍎'], answer: 0 },
        { text: 'A monitor looks like a…', options: ['Television 📺', 'Banana 🍌', 'Dog 🐶'], answer: 0 },
        { text: 'Find the Power Button!', options: ['Power Button', 'Star ⭐', 'Heart ❤️'], answer: 0 },
        { text: 'Press it to switch ON!', options: ['Power Button', 'Cookie 🍪', 'Football ⚽'], answer: 0 },
        { text: 'The computer needs…', options: ['Electricity (Plug) ⚡', 'Water 💧', 'Ice Cream 🍦'], answer: 0 },
        { text: 'Find the Mouse!', options: ['Computer Mouse', 'System Unit (Tower)', 'Monitor'], answer: 0 },
        { text: 'Which mouse is for the computer?', options: ['Computer Mouse', 'Animal Mouse 🐭', 'Cheese 🧀'], answer: 0 },
        { text: 'We CLICK with the…', options: ['Computer Mouse', 'Banana 🍌', 'Shoe 👟'], answer: 0 },
      ];
      db.exec('BEGIN');
      nurseryQs.forEach((x, i) => q.insertQuestion.run('nursery-2', i, x.text, JSON.stringify(x.options), x.answer));
      q.setPublished.run('nursery-2', 1, Date.now());
      db.exec('COMMIT');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
  }
}
seedNursery();

function seedYear1() {
  try {
    const existing = q.questionsFor.all('year-1');
    if (existing.length === 0) {
      const year1Qs = [
        { text: 'ICT means Information and Communication ___', options: ['Technology', 'Science', 'Battery'], answer: 0 },
        { text: 'Which one is an ICT device?', options: ['Radio 📻', 'Apple 🍎', 'Tree 🌳'], answer: 0 },
        { text: 'Electronic devices need electricity to work.', options: ['True ✅', 'False ❌'], answer: 0 },
        { text: 'A computer is an electronic ___', options: ['machine', 'animal', 'food'], answer: 0 },
        { text: 'Find the Keyboard!', options: ['Keyboard', 'Mouse', 'Monitor'], answer: 0 },
        { text: 'Which one is a Laptop?', options: ['Laptop', 'Tower (System Unit)', 'Car 🚗'], answer: 0 },
        { text: 'The most important part of the computer is the ___', options: ['System Unit', 'Mouse', 'Keyboard'], answer: 0 },
        { text: 'Press this to start the computer!', options: ['Power Button', 'Star ⭐', 'Cookie 🍪'], answer: 0 },
        { text: 'CPU means Central ___ Unit', options: ['Processing', 'Playing', 'Painting'], answer: 0 },
        { text: 'Find the CD!', options: ['CD 💿', 'Doughnut 🍩', 'Cookie 🍪'], answer: 0 },
        { text: 'CD means Compact ___', options: ['Disc', 'Dog', 'Door'], answer: 0 },
        { text: 'Find the Flash Drive!', options: ['Flash Drive', 'Shoe 👟', 'Banana 🍌'], answer: 0 },
        { text: 'The mouse is the ___ of the computer.', options: ['hand', 'eye', 'foot'], answer: 0 },
        { text: 'Which one shows the Scroll Button?', options: ['Scroll Button (Wheel)', 'Left Button', 'Right Button'], answer: 0 },
        { text: 'We shut down the computer with the ___ click.', options: ['Left click', 'Right click', 'Top click'], answer: 0 },
      ];
      db.exec('BEGIN');
      year1Qs.forEach((x, i) => q.insertQuestion.run('year-1', i, x.text, JSON.stringify(x.options), x.answer));
      q.setPublished.run('year-1', 1, Date.now());
      db.exec('COMMIT');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
  }
}
seedYear1();

function seedYear2() {
  try {
    const existing = q.questionsFor.all('year-2');
    if (existing.length === 0) {
      const year2Qs = [
        { text: 'A computer is an electronic ___', options: ['machine', 'animal', 'food', 'toy'], answer: 0 },
        { text: 'Which one is an example of data?', options: ['1, 2, 3', 'a chair', 'a cup', 'a shoe'], answer: 0 },
        { text: 'The computer keeps information for a long time. This is called ___', options: ['Storage', 'Input', 'Output', 'Sleeping'], answer: 0 },
        { text: 'Which one is the System Unit?', options: ['System Unit (Tower)', 'Monitor', 'Keyboard', 'Mouse'], answer: 0 },
        { text: 'CPU means Central ___ Unit', options: ['Processing', 'Playing', 'Printing', 'Painting'], answer: 0 },
        { text: 'The two types of system unit are Desktop and ___', options: ['Tower', 'Table', 'Window', 'Door'], answer: 0 },
        { text: 'The computer part used for typing is the ___', options: ['Keyboard', 'Monitor', 'Speaker', 'Printer'], answer: 0 },
        { text: 'Which input device is used to play games?', options: ['Joystick 🕹️', 'Keyboard', 'Mouse', 'Microphone 🎤'], answer: 0 },
        { text: 'Which input device sends sound into the computer?', options: ['Microphone 🎤', 'Joystick 🕹️', 'Mouse', 'Keyboard'], answer: 0 },
        { text: 'Output devices ___ information from the computer.', options: ['bring out', 'send in', 'eat', 'hide'], answer: 0 },
        { text: 'Which one is an OUTPUT device?', options: ['Monitor', 'Keyboard', 'Mouse', 'Joystick 🕹️'], answer: 0 },
        { text: 'We hear music from the computer through the…', options: ['Speaker 🔊', 'Microphone 🎤', 'Keyboard', 'Mouse'], answer: 0 },
        { text: 'The keyboard is an input device. The monitor is an ___ device.', options: ['Output', 'Input', 'Eating', 'Sleeping'], answer: 0 },
        { text: 'Which one do we use to print a document?', options: ['Printer', 'Keyboard', 'Mouse', 'Microphone 🎤'], answer: 0 },
        { text: 'Input devices let you talk to the computer. Output devices let the computer ___', options: ['talk back to you', 'go to sleep', 'eat food', 'run away'], answer: 0 },
      ];
      db.exec('BEGIN');
      year2Qs.forEach((x, i) => q.insertQuestion.run('year-2', i, x.text, JSON.stringify(x.options), x.answer));
      q.setPublished.run('year-2', 1, Date.now());
      db.exec('COMMIT');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
  }
}
seedYear2();


// Best attempt per child (same name + school) within each class; ranked by score, then speed.
function leaderboard(classId) {
  const where = classId ? `AND class_id = ?` : ``;
  const sql = `
    SELECT name, school, class_id, score, total, duration_ms, finished_at, attempts_count FROM (
      SELECT a.*,
        ROW_NUMBER() OVER (PARTITION BY class_id, name_key, school_key
                           ORDER BY score DESC, duration_ms ASC, finished_at ASC) AS rn,
        COUNT(*)     OVER (PARTITION BY class_id, name_key, school_key) AS attempts_count
      FROM attempts a WHERE finished_at IS NOT NULL ${where}
    ) WHERE rn = 1
    ORDER BY CAST(score AS REAL) / total DESC, duration_ms ASC, finished_at ASC`;
  return classId ? db.prepare(sql).all(classId) : db.prepare(sql).all();
}
function allAttempts(classId) {
  const sql = `SELECT name, school, class_id, score, total, duration_ms, finished_at FROM attempts
    WHERE finished_at IS NOT NULL ${classId ? 'AND class_id = ?' : ''} ORDER BY finished_at DESC LIMIT 5000`;
  return classId ? db.prepare(sql).all(classId) : db.prepare(sql).all();
}

// ---------- Admin credentials (hashed) ----------
// Stored format: "scrypt$<N>$<saltBase64>$<hashBase64>"
const cleanVal = (s) => String(s || '').trim().replace(/^["']|["']$/g, '');

function verifyPassword(password, stored) {
  try {
    const [algo, n, salt, hash] = cleanVal(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length,
      { N: Number(n), r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
const DEFAULT_ADMIN_USERNAME = 'futurein-admin';
const DEFAULT_ADMIN_HASH = 'scrypt$16384$ytU+Kr0a0RY0Iy5LEL9WLQ==$FXVNxw/+Wx80LJP0KWHixsjdiW0HAMi9+YcxzCzQGFQzeS3xilRf/tEYPJ9utLNznkkcanNv90QxNdQRqYX/Yg==';

function loadAdmin() {
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD_HASH) {
    return { username: cleanVal(process.env.ADMIN_USERNAME), passwordHash: cleanVal(process.env.ADMIN_PASSWORD_HASH) };
  }
  try {
    const file = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
    if (file && file.username && file.passwordHash) return file;
  } catch {}
  return { username: DEFAULT_ADMIN_USERNAME, passwordHash: DEFAULT_ADMIN_HASH };
}
// A fixed dummy hash so a wrong username takes as long to check as a wrong password.
const DUMMY_HASH = 'scrypt$16384$' + crypto.randomBytes(16).toString('base64') + '$' + crypto.randomBytes(64).toString('base64');

const failures = new Map(); // ip -> { count, until }
function lockedOut(ip) {
  const f = failures.get(ip);
  return f && f.until > Date.now();
}
function noteFailure(ip) {
  const f = failures.get(ip) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= 8) { f.until = Date.now() + 15 * 60 * 1000; f.count = 0; }
  failures.set(ip, f);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function sessionUser(req) {
  const token = parseCookies(req).fin_admin;
  if (!token) return null;
  const s = q.getSession.get(sha256(token));
  if (!s || s.expires_at < Date.now()) return null;
  // Changing the password signs everyone out: the session must match the current password hash.
  const admin = loadAdmin();
  if (!admin || s.pw_fp !== sha256(admin.passwordHash)) return null;
  return s.username;
}
function isHttps(req) {
  return req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').startsWith('https');
}
function cookie(req, value, maxAgeSec) {
  return `fin_admin=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
}
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// ---------- Helpers ----------
const clean = (s, max = 80) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function sendJson(res, status, obj, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(obj));
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' };
function sendFile(res, file, extra = {}) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', ...extra });
    res.end(buf);
  });
}
function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(new Error('too_large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function validateQuestions(list) {
  if (!Array.isArray(list)) return { error: 'Questions must be a list.' };
  if (list.length > 300) return { error: 'A class can have at most 300 questions.' };
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i] || {};
    const text = clean(item.text ?? item.question, 1000);
    const options = (Array.isArray(item.options) ? item.options : []).map((o) => clean(o, 300)).filter(Boolean);
    const answer = Number(item.answer);
    const n = i + 1;
    if (!text) return { error: `Question ${n} has no text.` };
    if (options.length < 2) return { error: `Question ${n} needs at least 2 options.` };
    if (options.length > 6) return { error: `Question ${n} has more than 6 options.` };
    if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) return { error: `Question ${n} has no correct answer selected.` };
    out.push({ text, options, answer });
  }
  return { questions: out };
}

function classSummary() {
  const counts = Object.fromEntries(q.counts.all().map((r) => [r.class_id, r.n]));
  const attempts = Object.fromEntries(q.attemptCounts.all().map((r) => [r.class_id, r.n]));
  const settings = Object.fromEntries(q.settings.all().map((r) => [r.class_id, r]));
  return CLASSES.map((c) => ({
    ...c,
    questions: counts[c.id] || 0,
    attempts: attempts[c.id] || 0,
    published: !!(settings[c.id] && settings[c.id].published),
    updatedAt: settings[c.id] ? settings[c.id].updated_at : null,
  }));
}

// ---------- Route handlers ----------
async function startQuiz(req, res) {
  const body = await readBody(req, 20_000);
  const name = clean(body.name);
  const school = clean(body.school);
  const cls = CLASS_BY_ID.get(String(body.classId || ''));
  if (name.length < 2 || school.length < 2) return sendJson(res, 400, { error: 'Please type your name and your school.' });
  if (!cls) return sendJson(res, 400, { error: 'Please choose your class.' });

  const setting = q.getSetting.get(cls.id);
  const questions = q.questionsFor.all(cls.id);
  if (!setting || !setting.published || questions.length === 0) {
    return sendJson(res, 200, { noQuiz: true, classLabel: cls.label });
  }
  const id = crypto.randomUUID();
  const key = questions.map((x) => x.answer);
  q.insertAttempt.run(id, name, school, cls.id, name.toLowerCase(), school.toLowerCase(), Date.now(), JSON.stringify(key));
  sendJson(res, 200, {
    attemptId: id,
    classLabel: cls.label,
    questions: questions.map((x) => ({ question: x.text, options: JSON.parse(x.options) })),
  });
}

async function submitQuiz(req, res) {
  const body = await readBody(req, 50_000);
  const attempt = q.getAttempt.get(String(body.attemptId || ''));
  if (!attempt) return sendJson(res, 404, { error: 'This quiz session has ended. Please start again.' });
  if (attempt.finished_at) return sendJson(res, 200, { score: attempt.score, total: attempt.total, durationMs: attempt.duration_ms });
  const key = JSON.parse(attempt.answer_key);
  const answers = Array.isArray(body.answers) ? body.answers.slice(0, key.length) : [];
  const score = key.reduce((n, correct, i) => n + (answers[i] !== null && answers[i] !== undefined && Number(answers[i]) === correct ? 1 : 0), 0);
  const now = Date.now();
  const durationMs = now - attempt.started_at;
  q.finishAttempt.run(now, score, key.length, durationMs, JSON.stringify(answers), attempt.id);
  sendJson(res, 200, { score, total: key.length, durationMs });
}

async function adminLogin(req, res) {
  const ip = clientIp(req);
  if (lockedOut(ip)) return sendJson(res, 429, { error: 'Too many wrong attempts. Please wait 15 minutes and try again.' });
  const admin = loadAdmin();
  if (!admin) {
    console.warn('[AUTH] Admin login failed: no admin account configured. Ensure ADMIN_USERNAME and ADMIN_PASSWORD_HASH are set in environment variables.');
    return sendJson(res, 503, { error: 'The admin account has not been set up on the server yet. Please verify that ADMIN_USERNAME and ADMIN_PASSWORD_HASH are set in your Render Environment settings.' });
  }
  const body = await readBody(req, 5_000);
  const username = clean(body.username, 100);
  const userOk = username.toLowerCase() === cleanVal(admin.username).toLowerCase();
  const passOk = verifyPassword(String(body.password || ''), userOk ? admin.passwordHash : DUMMY_HASH);
  if (!userOk || !passOk) {
    noteFailure(ip);
    console.warn(`[AUTH] Failed login for user "${username}" from IP ${ip}. userOk=${userOk}, passOk=${passOk}`);
    return sendJson(res, 401, { error: 'Wrong username or password.' });
  }
  failures.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  q.purgeSessions.run(Date.now());
  q.insertSession.run(sha256(token), admin.username, sha256(admin.passwordHash), Date.now() + SESSION_HOURS * 3600 * 1000);
  sendJson(res, 200, { ok: true, username: admin.username }, { 'Set-Cookie': cookie(req, token, SESSION_HOURS * 3600) });
}

async function adminRoutes(req, res, p, url) {
  if (p === '/api/admin/login' && req.method === 'POST') return adminLogin(req, res);

  const user = sessionUser(req);
  if (p === '/api/admin/logout' && req.method === 'POST') {
    const token = parseCookies(req).fin_admin;
    if (token) q.deleteSession.run(sha256(token));
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
  }
  if (!user) return sendJson(res, 401, { error: 'Please sign in.' });

  if (p === '/api/admin/me') return sendJson(res, 200, { username: user, adminPath: ADMIN_PATH });
  if (p === '/api/admin/classes') return sendJson(res, 200, { classes: classSummary() });

  const m = p.match(/^\/api\/admin\/classes\/([a-z0-9-]+)\/(questions|publish)$/);
  if (m) {
    const cls = CLASS_BY_ID.get(m[1]);
    if (!cls) return sendJson(res, 404, { error: 'Unknown class.' });
    if (m[2] === 'questions' && req.method === 'GET') {
      const rows = q.questionsFor.all(cls.id).map((r) => ({ text: r.text, options: JSON.parse(r.options), answer: r.answer }));
      const s = q.getSetting.get(cls.id);
      return sendJson(res, 200, { questions: rows, published: !!(s && s.published) });
    }
    if (m[2] === 'questions' && req.method === 'PUT') {
      const body = await readBody(req);
      const v = validateQuestions(body.questions);
      if (v.error) return sendJson(res, 400, { error: v.error });
      db.exec('BEGIN');
      try {
        q.deleteQuestions.run(cls.id);
        v.questions.forEach((x, i) => q.insertQuestion.run(cls.id, i, x.text, JSON.stringify(x.options), x.answer));
        q.touch.run(cls.id, Date.now());
        if (v.questions.length === 0) q.setPublished.run(cls.id, 0, Date.now());
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return sendJson(res, 200, { ok: true, count: v.questions.length });
    }
    if (m[2] === 'publish' && req.method === 'POST') {
      const body = await readBody(req, 1_000);
      const publish = !!body.published;
      if (publish && q.questionsFor.all(cls.id).length === 0) return sendJson(res, 400, { error: `Add questions to ${cls.label} before publishing.` });
      q.setPublished.run(cls.id, publish ? 1 : 0, Date.now());
      return sendJson(res, 200, { ok: true, published: publish });
    }
  }

  if (p === '/api/admin/leaderboard') {
    const classId = CLASS_BY_ID.has(url.searchParams.get('class')) ? url.searchParams.get('class') : null;
    return sendJson(res, 200, { rows: leaderboard(classId) });
  }
  if (p === '/api/admin/attempts') {
    const classId = CLASS_BY_ID.has(url.searchParams.get('class')) ? url.searchParams.get('class') : null;
    return sendJson(res, 200, { rows: allAttempts(classId) });
  }
  return sendJson(res, 404, { error: 'Not found' });
}

// ---------- Server ----------
const SECURITY_HEADERS = { 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/';
  const lower = p.toLowerCase();
  try {
    if (lower === '/api/classes') return sendJson(res, 200, { classes: CLASSES });
    if (lower === '/api/start' && req.method === 'POST') return await startQuiz(req, res);
    if (lower === '/api/submit' && req.method === 'POST') return await submitQuiz(req, res);
    if (lower.startsWith('/api/admin/')) return await adminRoutes(req, res, lower, url);
    if (lower.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });

    if (lower === ADMIN_PATH) return sendFile(res, path.join(PUBLIC_DIR, 'private', 'admin.html'),
      { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    if (lower === '/nursery' || lower === '/nursery-2' || lower === '/quiz/nursery-2' || lower === '/quiz/nursery') return sendFile(res, path.join(PUBLIC_DIR, 'nursery.html'));
    if (lower === '/year-1' || lower === '/quiz/year-1' || lower === '/year1' || lower === '/quiz/year1') return sendFile(res, path.join(PUBLIC_DIR, 'year-1.html'));
    if (lower === '/year-2' || lower === '/quiz/year-2' || lower === '/year2' || lower === '/quiz/year2') return sendFile(res, path.join(PUBLIC_DIR, 'year-2.html'));
    if (lower === '/' || /^\/quiz\/[a-z0-9-]+$/.test(lower)) return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    if (lower.startsWith('/private')) { res.writeHead(404); return res.end('Not found'); }

    const file = path.normalize(path.join(PUBLIC_DIR, p));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(404); return res.end('Not found'); }
    return sendFile(res, file);
  } catch (e) {
    if (e.message === 'too_large') return sendJson(res, 413, { error: 'That upload is too large.' });
    console.error(e);
    sendJson(res, 500, { error: 'Something went wrong on the server.' });
  }
});

// Tidy up abandoned quiz sessions and expired logins once an hour.
setInterval(() => {
  q.purgeSessions.run(Date.now());
  q.purgeOpenAttempts.run(Date.now() - 24 * 3600 * 1000);
}, 3600 * 1000).unref();

server.listen(PORT, () => {
  console.log(`FutureIN Quiz:   http://localhost:${PORT}`);
  console.log(`Admin dashboard: http://localhost:${PORT}${ADMIN_PATH}`);
  if (!loadAdmin()) console.log('No admin account yet. Run:  npm run set-admin');
});
