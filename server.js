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
const DATA_DIR = process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/data' : path.join(__dirname, 'data'));
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

const COMPETITION_CATEGORIES = [
  { id: 'lower-primary', label: 'Lower Primary' },
  { id: 'upper-primary', label: 'Upper Primary' },
  { id: 'junior-secondary', label: 'Junior Secondary' },
  { id: 'senior-secondary', label: 'Senior Secondary' },
];
const COMP_CAT_BY_ID = new Map(COMPETITION_CATEGORIES.map((c) => [c.id, c]));

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

  CREATE TABLE IF NOT EXISTS competition_state (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    title         TEXT NOT NULL DEFAULT 'FutureIN Inter-School Grand Championship',
    status        TEXT NOT NULL DEFAULT 'draft',
    duration_mins INTEGER NOT NULL DEFAULT 30,
    started_at    INTEGER,
    ended_at      INTEGER,
    updated_at    INTEGER
  );
  INSERT OR IGNORE INTO competition_state (id, title, status, duration_mins, updated_at)
  VALUES (1, 'FutureIN Inter-School Grand Championship', 'draft', 30, 0);

  CREATE TABLE IF NOT EXISTS comp_questions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id   TEXT NOT NULL,
    position   INTEGER NOT NULL,
    text       TEXT NOT NULL,
    options    TEXT NOT NULL,
    answer     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_comp_q_class ON comp_questions(class_id, position);

  CREATE TABLE IF NOT EXISTS comp_attempts (
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
  CREATE INDEX IF NOT EXISTS idx_comp_att ON comp_attempts(class_id, finished_at);
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
  insertDirectAttempt: db.prepare(`INSERT OR REPLACE INTO attempts (id, name, school, class_id, name_key, school_key, started_at, finished_at, score, total, duration_ms, answer_key, answers)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getAttempt: db.prepare(`SELECT * FROM attempts WHERE id = ?`),
  finishAttempt: db.prepare(`UPDATE attempts SET finished_at = ?, score = ?, total = ?, duration_ms = ?, answers = ?
    WHERE id = ? AND finished_at IS NULL`),
  insertSession: db.prepare(`INSERT INTO sessions (token_hash, username, pw_fp, expires_at) VALUES (?, ?, ?, ?)`),
  getSession: db.prepare(`SELECT username, pw_fp, expires_at FROM sessions WHERE token_hash = ?`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE token_hash = ?`),
  purgeSessions: db.prepare(`DELETE FROM sessions WHERE expires_at < ?`),
  purgeOpenAttempts: db.prepare(`DELETE FROM attempts WHERE finished_at IS NULL AND started_at < ?`),

  // Competition queries
  getCompState: db.prepare(`SELECT * FROM competition_state WHERE id = 1`),
  updateCompConfig: db.prepare(`UPDATE competition_state SET title = ?, duration_mins = ?, updated_at = ? WHERE id = 1`),
  startComp: db.prepare(`UPDATE competition_state SET status = 'active', started_at = ?, ended_at = ?, updated_at = ? WHERE id = 1`),
  endComp: db.prepare(`UPDATE competition_state SET status = 'ended', ended_at = ?, updated_at = ? WHERE id = 1`),
  resetComp: db.prepare(`UPDATE competition_state SET status = 'draft', started_at = NULL, ended_at = NULL, updated_at = ? WHERE id = 1`),
  clearCompAttempts: db.prepare(`DELETE FROM comp_attempts`),

  compQuestionsFor: db.prepare(`SELECT id, text, options, answer FROM comp_questions WHERE class_id = ? ORDER BY position, id`),
  deleteCompQuestions: db.prepare(`DELETE FROM comp_questions WHERE class_id = ?`),
  insertCompQuestion: db.prepare(`INSERT INTO comp_questions (class_id, position, text, options, answer) VALUES (?, ?, ?, ?, ?)`),
  compCounts: db.prepare(`SELECT class_id, COUNT(*) AS n FROM comp_questions GROUP BY class_id`),
  compAttemptCounts: db.prepare(`SELECT class_id, COUNT(*) AS n FROM comp_attempts WHERE finished_at IS NOT NULL GROUP BY class_id`),

  insertCompAttempt: db.prepare(`INSERT INTO comp_attempts (id, name, school, class_id, name_key, school_key, started_at, answer_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  insertDirectCompAttempt: db.prepare(`INSERT OR REPLACE INTO comp_attempts (id, name, school, class_id, name_key, school_key, started_at, finished_at, score, total, duration_ms, answer_key, answers)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getCompAttempt: db.prepare(`SELECT * FROM comp_attempts WHERE id = ?`),
  finishCompAttempt: db.prepare(`UPDATE comp_attempts SET finished_at = ?, score = ?, total = ?, duration_ms = ?, answers = ? WHERE id = ? AND finished_at IS NULL`),
};

const BACKUP_FILE = path.join(DATA_DIR, 'attempts_backup.json');

function logAttemptBackup(item) {
  try {
    fs.appendFileSync(BACKUP_FILE, JSON.stringify(item) + '\n', 'utf8');
  } catch (e) {
    console.warn('[BACKUP] Append failed:', e.message);
  }
}

function restoreFromBackup() {
  try {
    if (!fs.existsSync(BACKUP_FILE)) return;
    const lines = fs.readFileSync(BACKUP_FILE, 'utf8').split('\n').filter(Boolean);
    let count = 0;
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item && item.id && item.name && item.school && item.classId) {
          const existing = q.getAttempt.get(item.id);
          if (!existing) {
            const finishedAt = Number(item.finishedAt) || Date.now();
            const dur = Number(item.durationMs) || 60000;
            const startedAt = finishedAt - dur;
            q.insertDirectAttempt.run(
              item.id,
              item.name,
              item.school,
              item.classId,
              item.name.toLowerCase(),
              item.school.toLowerCase(),
              startedAt,
              finishedAt,
              Number(item.score) || 0,
              Number(item.total) || 15,
              dur,
              '[]',
              '[]'
            );
            q.insertDirectCompAttempt.run(
              item.id,
              item.name,
              item.school,
              item.classId,
              item.name.toLowerCase(),
              item.school.toLowerCase(),
              startedAt,
              finishedAt,
              Number(item.score) || 0,
              Number(item.total) || 15,
              dur,
              '[]',
              '[]'
            );
            count++;
          }
        }
      } catch {}
    }
    if (count > 0) console.log(`[BACKUP] Restored ${count} attempt(s) from ${BACKUP_FILE}`);
  } catch (e) {
    console.warn('[BACKUP] Restore failed:', e.message);
  }
}
restoreFromBackup();

// Backfill any completed quiz attempts into competition arena on boot
function syncInitialCompAttempts() {
  try {
    const attempts = db.prepare(`SELECT * FROM attempts WHERE finished_at IS NOT NULL`).all();
    let count = 0;
    for (const a of attempts) {
      const existing = q.getCompAttempt.get(a.id);
      if (!existing) {
        q.insertDirectCompAttempt.run(
          a.id,
          a.name,
          a.school || '',
          a.class_id,
          a.name_key || a.name.toLowerCase(),
          a.school_key || (a.school || '').toLowerCase(),
          a.started_at,
          a.finished_at,
          a.score,
          a.total,
          a.duration_ms,
          a.answer_key || '[]',
          a.answers || '[]'
        );
        count++;
      }
    }
    if (count > 0) {
      console.log(`[COMPETITION] Synced ${count} existing attempt(s) into competition attempts.`);
    }
  } catch (e) {
    console.warn('[COMPETITION] Initial sync notice:', e.message);
  }
}
syncInitialCompAttempts();

// ---------- Cloud Database Sync (Supabase PostgreSQL) ----------
let rawUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
let rawKey = (process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

// Auto-detect if user swapped URL and Key in Render Environment settings
if ((rawUrl.startsWith('sb_') || rawUrl.startsWith('eyJ')) && (rawKey.startsWith('http://') || rawKey.startsWith('https://'))) {
  console.log('[SUPABASE] Detected swapped SUPABASE_URL and SUPABASE_KEY in environment variables. Auto-correcting...');
  const tmp = rawUrl;
  rawUrl = rawKey;
  rawKey = tmp;
}

// If someone provided "xxxx.supabase.co" without https://
if (rawUrl && !rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
  if (rawUrl.includes('supabase.co')) {
    rawUrl = 'https://' + rawUrl;
  }
}

const SUPABASE_URL = (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) ? rawUrl : '';
const SUPABASE_KEY = rawKey;

if (process.env.SUPABASE_URL && !SUPABASE_URL) {
  console.warn(`[SUPABASE] Configuration Notice: SUPABASE_URL is currently set to "${process.env.SUPABASE_URL}". It should be your Project URL starting with "https://" (e.g. https://xyz.supabase.co). The API key "${rawKey || process.env.SUPABASE_URL}" belongs in SUPABASE_KEY.`);
}

let lastSupabaseSync = 0;
async function syncAttemptsFromSupabase(force = false) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  const now = Date.now();
  if (!force && now - lastSupabaseSync < 10000) return;
  lastSupabaseSync = now;
  try {
    const url = `${SUPABASE_URL}/rest/v1/attempts?select=*&order=finished_at.desc&limit=5000`;

    const res = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      }
    });
    if (!res.ok) {
      console.warn('[SUPABASE] Sync failed status:', res.status);
      return;
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) return;
    let count = 0;
    for (const r of rows) {
      if (r && r.id && r.name && r.class_id) {
        const existing = q.getAttempt.get(r.id);
        const finishedAt = Number(r.finished_at) || Date.now();
        const dur = Number(r.duration_ms) || 60000;
        const startedAt = Number(r.started_at) || (finishedAt - dur);
        if (!existing) {
          q.insertDirectAttempt.run(
            r.id,
            r.name,
            r.school || '',
            r.class_id,
            (r.name_key || r.name).toLowerCase(),
            (r.school_key || r.school || '').toLowerCase(),
            startedAt,
            finishedAt,
            Number(r.score) || 0,
            Number(r.total) || 15,
            dur,
            r.answer_key || '[]',
            r.answers || '[]'
          );
          count++;
        }
        const existingComp = q.getCompAttempt.get(r.id);
        if (!existingComp) {
          q.insertDirectCompAttempt.run(
            r.id,
            r.name,
            r.school || '',
            r.class_id,
            (r.name_key || r.name).toLowerCase(),
            (r.school_key || r.school || '').toLowerCase(),
            startedAt,
            finishedAt,
            Number(r.score) || 0,
            Number(r.total) || 15,
            dur,
            r.answer_key || '[]',
            r.answers || '[]'
          );
        }
      }
    }
    if (count > 0) {
      console.log(`[SUPABASE] Synced ${count} attempt(s) from Supabase cloud into local database.`);
    }
    if (typeof regradeZeroAttempts === 'function') regradeZeroAttempts();
  } catch (err) {
    console.warn('[SUPABASE] Sync error:', err.message);
  }
}

async function saveAttemptToSupabase(item) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    const url = `${SUPABASE_URL}/rest/v1/attempts`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(item)
    });
    if (!res.ok) {
      const txt = await res.text();
      console.warn('[SUPABASE] Save failed status:', res.status, txt);
    } else {
      console.log(`[SUPABASE] Attempt for "${item.name}" (${item.class_id}) saved to cloud.`);
    }
  } catch (err) {
    console.warn('[SUPABASE] Save network error:', err.message);
  }
}

// Initial sync on boot if credentials are present
syncAttemptsFromSupabase(true).catch(() => {});



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

function seedYear3() {
  try {
    const existing = q.questionsFor.all('year-3');
    if (existing.length === 0) {
      const year3Qs = [
        { text: 'Long ago, people did counting with ___', options: ['fingers, stones and sticks', 'phones', 'calculators', 'laptops'], answer: 0 },
        { text: 'This counting device uses columns of beads. It is called ___', options: ['Abacus', 'Napier Bones', 'Plotter', 'Joystick'], answer: 0 },
        { text: "Pascal's Wheel was able to ___ numbers.", options: ['add and subtract', 'print', 'sing', 'draw'], answer: 0 },
        { text: 'Who is called the Father of the Computer?', options: ['Charles Babbage', 'Blaise Pascal', 'John Napier', 'Isaac Newton'], answer: 0 },
        { text: 'Based on size, computers are grouped into how many classes?', options: ['4', '2', '6', '10'], answer: 0 },
        { text: 'The most common kind of computer in use today is the ___', options: ['Microcomputer', 'Supercomputer', 'Mainframe computer', 'Minicomputer'], answer: 0 },
        { text: 'Which one is also a microcomputer?', options: ['Smartphone 📱', 'Bicycle 🚲', 'Teddy Bear 🧸', 'Pizza 🍕'], answer: 0 },
        { text: 'Which of these is NOT a class of computer?', options: ['Joystick computer', 'Microcomputer', 'Supercomputer', 'Mainframe computer'], answer: 0 },
        { text: 'Hardware means the parts of the computer we can ___', options: ['see and touch', 'only hear', 'eat', 'smell'], answer: 0 },
        { text: 'Which input device is a camera attached to the computer?', options: ['Webcam', 'Printer', 'Monitor', 'Speaker 🔊'], answer: 0 },
        { text: 'Which one is an OUTPUT device?', options: ['Printer', 'Keyboard', 'Mouse', 'Microphone 🎤'], answer: 0 },
        { text: 'The ___ prints big banners and flex in the printing press.', options: ['Plotter', 'Webcam', 'Joystick', 'Microphone'], answer: 0 },
        { text: 'The brain of the computer is the ___', options: ['C.P.U', 'Monitor', 'Speaker', 'Printer'], answer: 0 },
        { text: 'Which one is a Tower system unit?', options: ['Tower System Unit', 'Desktop Unit', 'Monitor', 'Printer'], answer: 0 },
        { text: 'The main circuit board inside the system unit is the ___', options: ['Motherboard', 'Keyboard', 'Blackboard', 'Mousepad'], answer: 0 },
        { text: 'All other parts of the computer are connected to the ___', options: ['System unit', 'Speaker', 'Mouse', 'Microphone'], answer: 0 },
        { text: 'Software means all the ___ that a computer uses.', options: ['programs', 'cables', 'screws', 'chairs'], answer: 0 },
        { text: 'Software is like the ___ of the computer system.', options: ['heart', 'leg', 'hair', 'shoe'], answer: 0 },
        { text: 'The two main types of software are System Software and ___ Software.', options: ['Application', 'Hardware', 'Paper', 'Keyboard'], answer: 0 },
        { text: 'Which one is an example of Application Software?', options: ['Microsoft Word', 'Keyboard', 'Monitor', 'Motherboard'], answer: 0 },
      ];
      db.exec('BEGIN');
      year3Qs.forEach((x, i) => q.insertQuestion.run('year-3', i, x.text, JSON.stringify(x.options), x.answer));
      q.setPublished.run('year-3', 1, Date.now());
      db.exec('COMMIT');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
  }
}
seedYear3();

function seedYear4() {
  try {
    const existing = q.questionsFor.all('year-4');
    if (existing.length === 0) {
      const year4Qs = [
        { text: 'The three elements of a computer are Hardware, Software and ___', options: ['Human ware', 'Keyboard', 'Electricity', 'Monitor'], answer: 0 },
        { text: 'Which one is the Processing device?', options: ['System Unit (Tower)', 'Printer', 'Keyboard', 'Monitor'], answer: 0 },
        { text: 'Which cable connects the system unit to the monitor?', options: ['VGA cable', 'Printer cable', 'Network cable', 'Power cable'], answer: 0 },
        { text: 'USB means Universal Serial ___', options: ['Bus', 'Box', 'Button', 'Battery'], answer: 0 },
        { text: 'Data are raw facts or ___ information.', options: ['incomplete', 'complete', 'printed', 'coloured'], answer: 0 },
        { text: 'Which of these is a special character?', options: ['*', 'A', '7', 'b'], answer: 0 },
        { text: 'Information is data that has been ___', options: ['processed', 'deleted', 'hidden', 'lost'], answer: 0 },
        { text: 'Good information should be timely, accurate and ___', options: ['complete', 'late', 'messy', 'secret'], answer: 0 },
        { text: 'Collecting, organising, protecting and storing data is called ___', options: ['Data management', 'Data deleting', 'Typing', 'Printing'], answer: 0 },
        { text: 'Using paper and pen to record data, like a class register, is the ___ method.', options: ['Manual', 'Computer', 'Electronic', 'Automatic'], answer: 0 },
        { text: 'Computer simulation is also called ___ data management.', options: ['Electronic', 'Manual', 'Paper', 'Pencil'], answer: 0 },
        { text: 'Why do we need data management?', options: ['To find data quickly and keep it safe', 'To make data messy and hard to find', 'To lose data and forget about it', 'To slow the computer down'], answer: 0 },
        { text: 'A spreadsheet is a program used to ___', options: ['do calculations, make charts and store information', 'play music, show films and record videos', 'draw pictures, paint and colour them', 'send messages, chat and make calls'], answer: 0 },
        { text: 'The small boxes in a spreadsheet are called ___', options: ['Cells', 'Rooms', 'Windows', 'Doors'], answer: 0 },
        { text: 'Which one is a good example of a spreadsheet program?', options: ['Microsoft Excel', 'Microsoft Paint', 'Media Player', 'Notepad'], answer: 0 },
        { text: 'The yellow part going up and down in a spreadsheet is a ___', options: ['Column', 'Row', 'Chart', 'Cell'], answer: 0 },
        { text: 'The yellow part going across in a spreadsheet is a ___', options: ['Row', 'Column', 'Chart', 'Theme'], answer: 0 },
        { text: 'What can we type into the cells of a worksheet?', options: ['Numbers, alphabets and signs', 'Only pictures', 'Only colours', 'Nothing at all'], answer: 0 },
        { text: 'Look at the sales worksheet. How much is a Pen?', options: ['₦300', '₦6000', '₦100', '₦3000'], answer: 0 },
        { text: 'Look at the sales worksheet. Which product costs the most?', options: ['Textbooks', 'Pen', 'Eraser', 'Price'], answer: 0 },
      ];
      db.exec('BEGIN');
      year4Qs.forEach((x, i) => q.insertQuestion.run('year-4', i, x.text, JSON.stringify(x.options), x.answer));
      q.setPublished.run('year-4', 1, Date.now());
      db.exec('COMMIT');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
  }
}
seedYear4();

function seedYear5() {
  try {
    const existing = q.questionsFor.all('year-5');
    if (existing.length === 0) {
      const year5Qs = [
        { text: 'This counting device uses columns of beads. What is it called?', options: ['Abacus', 'Napier Bones', "Pascal's Wheel", 'Analytical Engine'], answer: 0 },
        { text: "Pascal's Wheel was the first mechanical calculating machine. It could ___", options: ['add and subtract numbers', 'print documents', 'send emails', 'store pictures'], answer: 0 },
        { text: "Odometers in cars use the principle of ___", options: ["Pascal's Wheel", 'the Abacus', 'Napier Bones', 'the Analytical Engine'], answer: 0 },
        { text: 'Who invented the Analytical Engine, the first mechanical computer?', options: ['Charles Babbage', 'Blaise Pascal', 'John Napier', 'Isaac Newton'], answer: 0 },
        { text: 'Which is the fastest, strongest and most expensive computer?', options: ['Supercomputer', 'Microcomputer', 'Minicomputer', 'Mainframe computer'], answer: 0 },
        { text: 'Mainframe computers are mostly used in ___', options: ['banks, government and large companies', 'toy shops and playgrounds', 'cars and bicycles', 'wrist watches and phones'], answer: 0 },
        { text: 'Which one is a Palmtop computer?', options: ['Tablet', 'Laptop', 'Tower Unit', 'Desktop Unit'], answer: 0 },
        { text: 'A laptop is also called an ___ computer.', options: ['All-in-one', 'In-car', 'Analog', 'Mainframe'], answer: 0 },
        { text: 'A thermometer is an example of a ___ computer.', options: ['Analog', 'Digital', 'Hybrid', 'Super'], answer: 0 },
        { text: 'Which one is a Digital computer?', options: ['Calculator', 'Thermometer', 'Speedometer', 'Fuel pump'], answer: 0 },
        { text: 'A fuel pump at a filling station measures AND counts. It is a ___ computer.', options: ['Hybrid', 'Analog', 'Digital', 'Mini'], answer: 0 },
        { text: 'An ATM can only do one kind of job. It is a ___ purpose computer.', options: ['Special', 'General', 'Hybrid', 'Analog'], answer: 0 },
        { text: 'First generation computers (1946–1959) were based on ___', options: ['Vacuum tubes', 'Transistors', 'Integrated circuits', 'Microprocessors'], answer: 0 },
        { text: 'Computers based on Transistors belong to which generation?', options: ['Second generation', 'First generation', 'Fourth generation', 'Fifth generation'], answer: 0 },
        { text: 'The third generation (1965–1971) was based on ___', options: ['Integrated circuits', 'Vacuum tubes', 'Transistors', 'Beads and sticks'], answer: 0 },
        { text: 'The fifth generation (1980 onwards) is based on ___', options: ['Artificial intelligence', 'Vacuum tubes', 'Transistors', 'The Abacus'], answer: 0 },
        { text: 'What is the full meaning of AI?', options: ['Artificial Intelligence', 'Automatic Internet', 'Active Information', 'Advanced Input'], answer: 0 },
        { text: 'Which of these is a voice assistant?', options: ['Siri', 'Canva', 'Grammarly', 'Google AutoDraw'], answer: 0 },
        { text: 'Which AI tool turns rough doodles into neat drawings?', options: ['Google AutoDraw', 'Grammarly', 'Google Translate', 'Netflix'], answer: 0 },
        { text: 'Which one is a safe rule for using AI?', options: ['Never share your name, school or address', 'Copy AI answers for your homework', 'Believe everything that AI tells you', 'Use AI apps without asking an adult'], answer: 0 },
      ];
      db.exec('BEGIN');
      year5Qs.forEach((x, i) => q.insertQuestion.run('year-5', i, x.text, JSON.stringify(x.options), x.answer));
      q.setPublished.run('year-5', 1, Date.now());
      db.exec('COMMIT');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
  }
}
seedYear5();

function seedYear6() {
  try {
    const existing = q.questionsFor.all('year-6');
    if (existing.length === 0) {
      const year6Qs = [
        { text: 'Another name for computer personnel is ___', options: ['Human ware', 'Hardware', 'Software', 'Firmware'], answer: 0 },
        { text: 'Telling a computer what to do through a special set of instructions is called ___', options: ['Computer programming', 'Web design', 'Network engineering', 'Data management'], answer: 0 },
        { text: 'Which of these is a programming language?', options: ['Java', 'Excel', 'Google', 'Windows'], answer: 0 },
        { text: 'Architects use which software to design buildings?', options: ['AutoCAD', 'Photoshop', 'CorelDraw', 'Microsoft Excel'], answer: 0 },
        { text: 'A computer application that does a job a human expert would normally do is called an ___', options: ['Expert system', 'Operating system', 'Search engine', 'Spreadsheet'], answer: 0 },
        { text: 'The ATM is an expert system in banking. ATM means Automated ___ Machine.', options: ['Teller', 'Typing', 'Transfer', 'Ticket'], answer: 0 },
        { text: 'Expert systems belong to a group of computer applications called ___', options: ['Artificial intelligence', 'Word processing', 'Desktop publishing', 'Spreadsheets'], answer: 0 },
        { text: 'Which one is an ADVANTAGE of an expert system?', options: ['It can work round the clock', 'It lacks common sense', 'It cannot make creative responses', 'It cannot adapt to changes'], answer: 0 },
        { text: 'Which AI tool did we use to generate creative writing ideas?', options: ['ChatGPT', 'AutoCAD', 'Natural Reader', 'Microsoft Excel'], answer: 0 },
        { text: 'What is the FIRST step to start writing with ChatGPT?', options: ['Log in or sign up', 'Click Play to listen', 'Print the story', 'Choose a voice'], answer: 0 },
        { text: 'Look at the picture. What is the pupil asking the AI to do?', options: ['Write a short story about a talking dog', 'Draw a picture of a dog', 'Read a story out loud', 'Translate a story into French'], answer: 0 },
        { text: 'AI that creates new stories, ideas or pictures is called ___ AI.', options: ['Generative', 'Analog', 'Hybrid', 'Digital'], answer: 0 },
        { text: 'AI gives you a starting point. What makes the story truly yours?', options: ['Your own imagination', 'Copying the AI exactly', 'A faster computer', 'A bigger keyboard'], answer: 0 },
        { text: 'After AI gives you a story idea, what is the BEST thing to do?', options: ['Improve it with your own ideas', 'Submit it exactly as it is', 'Delete it and stop writing', 'Share it as your own work'], answer: 0 },
        { text: 'In the group activity, one pupil asks AI for a story ___ and the others expand it.', options: ['starter', 'password', 'printer', 'voice'], answer: 0 },
        { text: 'The group then presents its finished story to the class as a short ___', options: ['drama', 'spreadsheet', 'email', 'password'], answer: 0 },
        { text: 'AI text-to-speech turns written words into ___', options: ['spoken audio', 'pictures', 'videos', 'numbers'], answer: 0 },
        { text: 'Which AI tool did we use to turn our story into audio?', options: ['Natural Reader', 'ChatGPT', 'AutoCAD', 'Photoshop'], answer: 0 },
        { text: 'What is the correct order of steps in Natural Reader?', options: ['Input story → Choose voice → Listen', 'Listen → Input story → Choose voice', 'Choose voice → Listen → Input story', 'Listen → Choose voice → Input story'], answer: 0 },
        { text: 'Which button do you click to hear your story read aloud?', options: ['Play ▶️', 'Stop ⏹️', 'Delete 🗑️', 'Print 🖨️'], answer: 0 },
      ];
      db.exec('BEGIN');
      year6Qs.forEach((x, i) => q.insertQuestion.run('year-6', i, x.text, JSON.stringify(x.options), x.answer));
      q.setPublished.run('year-6', 1, Date.now());
      db.exec('COMMIT');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
  }
}
seedYear6();

function seedYear7() {
  try {
    const existing = q.questionsFor.all('year-7');
    if (existing.length === 0) {
      const year7Qs = [
        { text: 'Which part of the computer is known as the "brain" and performs calculations and logical operations?', options: ['Hard Disk Drive', 'Central Processing Unit (CPU)', 'Monitor', 'Keyboard'], answer: 1 },
        { text: 'Which of the following is strictly an INPUT device used to capture physical photos or documents into digital form?', options: ['Scanner', 'Printer', 'Monitor', 'Projector'], answer: 0 },
        { text: 'What does the acronym "RAM" stand for in computer memory?', options: ['Read Access Method', 'Rapid Action Memory', 'Random Access Memory', 'Remote Audio Module'], answer: 2 },
        { text: 'Which type of software controls the computer hardware and allows applications to run?', options: ['Web Browser', 'Operating System', 'Word Processor', 'Spreadsheet'], answer: 1 },
        { text: 'What is the smallest basic unit of digital data in computing?', options: ['Byte', 'Kilobyte', 'Bit', 'Megabyte'], answer: 2 },
        { text: 'How many bits make up one single byte?', options: ['4 bits', '8 bits', '16 bits', '32 bits'], answer: 1 },
        { text: 'Which ancient calculating device used beads sliding on rods for arithmetic operations?', options: ['Abacus', 'Slide Rule', 'Napier Bones', 'Pascaline'], answer: 0 },
        { text: 'Who is widely regarded as the "Father of Computers" for designing the Analytical Engine?', options: ['Alan Turing', 'Blaise Pascal', 'John von Neumann', 'Charles Babbage'], answer: 3 },
        { text: 'Which of these is permanent, non-volatile primary memory that stores initial startup instructions?', options: ['RAM', 'ROM (Read Only Memory)', 'Cache Memory', 'Virtual Memory'], answer: 1 },
        { text: 'What is the standard keyboard shortcut used to COPY highlighted text or items?', options: ['Ctrl + C', 'Ctrl + V', 'Ctrl + X', 'Ctrl + Z'], answer: 0 },
        { text: 'What is the standard keyboard shortcut used to PASTE copied text or items?', options: ['Ctrl + P', 'Ctrl + S', 'Ctrl + V', 'Ctrl + C'], answer: 2 },
        { text: 'Which symbol is essential in every email address to separate the username from the domain name?', options: ['#', '@', '$', '&'], answer: 1 },
        { text: 'A worldwide global network connecting millions of computers together across the planet is the ___', options: ['Intranet', 'Local Area Network', 'Internet', 'Bluetooth'], answer: 2 },
        { text: 'Which software application is specifically used to view and navigate web pages?', options: ['Web Browser (e.g. Chrome, Edge)', 'Search Engine', 'Spreadsheet', 'Media Player'], answer: 0 },
        { text: 'In word processing, what does clicking the "B" button on the formatting toolbar do?', options: ['Changes font to Blue', 'Makes text Bold (darker and thicker)', 'Underlines text', 'Converts to Bullet points'], answer: 1 },
        { text: 'Which storage medium uses laser beams to read and write data on a shiny spinning disc?', options: ['Magnetic Hard Drive', 'Optical Disc (CD / DVD)', 'Solid State Drive', 'Flash Drive'], answer: 1 },
        { text: 'What do we call raw, unorganized facts and figures before they are processed by a computer?', options: ['Information', 'Knowledge', 'Data', 'Output'], answer: 2 },
        { text: 'Processed data that is organized, meaningful, and useful for decision making is known as ___', options: ['Information', 'Raw Code', 'Hardware', 'Algorithm'], answer: 0 },
        { text: 'Which keyboard key is pressed to delete characters located to the left of the blinking cursor?', options: ['Delete', 'Backspace', 'Enter', 'Spacebar'], answer: 1 },
        { text: 'Which of the following is recommended for good computer ergonomics?', options: ['Slouching deep in the chair', 'Keeping monitor screen at eye level with back supported', 'Placing screen in complete darkness', 'Reaching far away to type'], answer: 1 }
      ];
      db.exec('BEGIN');
      year7Qs.forEach((x, i) => q.insertQuestion.run('year-7', i, x.text, JSON.stringify(x.options), x.answer));
      q.setPublished.run('year-7', 1, Date.now());
      db.exec('COMMIT');
      console.log('[SEED] Successfully seeded Year 7 question bank.');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    console.warn('[SEED] Year 7 seed notice:', e.message);
  }
}
seedYear7();

function seedYear8() {
  try {
    const existing = q.questionsFor.all('year-8');
    if (existing.length === 0) {
      const year8Qs = [
        { text: 'What does the "ALU" component inside the Central Processing Unit stand for?', options: ['Advanced Link Utility', 'Arithmetic Logic Unit', 'Automatic Linear Unit', 'Access Level User'], answer: 1 },
        { text: 'Which CPU unit directs data flow and coordinates the operations of all computer components?', options: ['Control Unit (CU)', 'Arithmetic Logic Unit (ALU)', 'Cache Memory', 'System Bus'], answer: 0 },
        { text: 'Which number system uses base-16 and contains digits 0–9 and letters A–F?', options: ['Binary', 'Decimal', 'Hexadecimal', 'Octal'], answer: 2 },
        { text: 'What is the binary representation of the decimal number 5?', options: ['110', '101', '011', '100'], answer: 1 },
        { text: 'Which network topology connects all client computers to a single central switch or hub?', options: ['Bus Topology', 'Ring Topology', 'Star Topology', 'Mesh Topology'], answer: 2 },
        { text: 'What kind of network covers a small localized geographical area like a school lab or office building?', options: ['LAN (Local Area Network)', 'WAN (Wide Area Network)', 'MAN (Metropolitan Area Network)', 'PAN (Personal Area Network)'], answer: 0 },
        { text: 'Which high-speed storage device uses flash memory chips instead of moving magnetic platters?', options: ['Hard Disk Drive (HDD)', 'Solid State Drive (SSD)', 'Floppy Disk', 'Magnetic Tape'], answer: 1 },
        { text: 'What is the main printed circuit board that connects the CPU, RAM, and all other components together?', options: ['Motherboard', 'Expansion Card', 'Sound Card', 'Power Supply'], answer: 0 },
        { text: 'Which system utility rearranges fragmented files on a hard disk to improve access speed?', options: ['Antivirus', 'Disk Defragmenter', 'File Compression', 'Task Scheduler'], answer: 1 },
        { text: 'What does the letter "S" stand for in the web protocol "https://"?', options: ['System', 'Standard', 'Secure (encrypted)', 'Speed'], answer: 2 },
        { text: 'A visual diagram representing an algorithm step-by-step with geometric shapes and arrows is a ___', options: ['Pseudocode', 'Flowchart', 'Wireframe', 'Schematic'], answer: 1 },
        { text: 'In a standard flowchart, which geometric shape represents a decision point (Yes/No)?', options: ['Rectangle', 'Oval', 'Diamond', 'Parallelogram'], answer: 2 },
        { text: 'In spreadsheet software like Microsoft Excel, which character MUST begin every formula?', options: ['=', '+', '@', '#'], answer: 0 },
        { text: 'In an Excel spreadsheet, which formula correctly calculates the sum of cells from A1 to A10?', options: ['=ADD(A1:A10)', '=SUM(A1:A10)', '=TOTAL(A1:A10)', '=COUNT(A1:A10)'], answer: 1 },
        { text: 'What cyber attack tricks users into revealing confidential passwords via fraudulent emails or websites?', options: ['Trojan Horse', 'DDoS', 'Phishing', 'Spyware'], answer: 2 },
        { text: 'A network security barrier that monitors and filters traffic between trusted and untrusted networks is a ___', options: ['Firewall', 'Modem', 'Switch', 'Repeater'], answer: 0 },
        { text: 'Which of the following is an open-source operating system widely used in servers and software development?', options: ['Microsoft Windows', 'Apple macOS', 'Linux', 'iOS'], answer: 2 },
        { text: 'Approximately how many Megabytes (MB) are in 1 Gigabyte (GB)?', options: ['100 MB', '1024 MB', '500 MB', '10000 MB'], answer: 1 },
        { text: 'In computer programming, a named container in memory used to store values that can change is a ___', options: ['Constant', 'Variable', 'Function', 'Loop'], answer: 1 },
        { text: 'What legal framework protects creators from unauthorized copying of their software, music, and writing?', options: ['Copyright and Intellectual Property', 'Creative Commons Zero', 'Public Domain', 'Fair Use Only'], answer: 0 }
      ];
      db.exec('BEGIN');
      year8Qs.forEach((x, i) => q.insertQuestion.run('year-8', i, x.text, JSON.stringify(x.options), x.answer));
      q.setPublished.run('year-8', 1, Date.now());
      db.exec('COMMIT');
      console.log('[SEED] Successfully seeded Year 8 question bank.');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    console.warn('[SEED] Year 8 seed notice:', e.message);
  }
}
seedYear8();

function seedYear11() {
  try {
    const existing = q.questionsFor.all('year-11');
    if (existing.length === 0) {
      const year11Qs = [
        { text: 'What is the default file extension for documents created in Microsoft Word 2007 and later?', options: ['.doc', '.docx', '.txt', '.rtf'], answer: 1 },
        { text: 'Which keyboard shortcut is used to undo the last action in MS Word?', options: ['Ctrl + Z', 'Ctrl + Y', 'Ctrl + U', 'Ctrl + X'], answer: 0 },
        { text: 'The feature used to send the same letter to multiple recipients is called:', options: ['Macros', 'Hyperlink', 'Mail Merge', 'AutoFormat'], answer: 2 },
        { text: 'Which alignment justifies the text on both the left and right margins?', options: ['Left Align', 'Center', 'Right Align', 'Justify'], answer: 3 },
        { text: 'Where is the zoom slider typically located in the MS Word window?', options: ['Title bar', 'Status bar', 'Ribbon', 'Quick Access Toolbar'], answer: 1 },
        { text: 'To move the cursor to the beginning of a document, you press:', options: ['Home', 'Ctrl + Home', 'Page Up', 'Alt + Home'], answer: 1 },
        { text: 'The intersection of a row and a column in a Word table is called a:', options: ['Block', 'Grid', 'Cell', 'Box'], answer: 2 },
        { text: 'What is the shortcut key to print a document?', options: ['Ctrl + P', 'Shift + P', 'Alt + P', 'Windows + P'], answer: 0 },
        { text: 'Which tab in the Ribbon contains the Header and Footer commands?', options: ['Home', 'Insert', 'Page Layout', 'View'], answer: 1 },
        { text: 'Which key combination makes the selected text bold?', options: ['Ctrl + B', 'Alt + B', 'Shift + B', 'Tab + B'], answer: 0 },
        { text: 'The Thesaurus tool in MS Word is primarily used for:', options: ['Spelling checks', 'Grammar corrections', 'Finding synonyms and antonyms', 'Language translation'], answer: 2 },
        { text: 'What is the default font style in Microsoft Word 2013 and later?', options: ['Arial', 'Times New Roman', 'Calibri', 'Tahoma'], answer: 2 },
        { text: 'Portrait and Landscape are examples of:', options: ['Page Orientation', 'Page Size', 'Page Margin', 'Page Setup'], answer: 0 },
        { text: 'A Drop Cap is used in a document to:', options: ['Drop all capital letters', 'Begin a paragraph with a large dropped initial capital letter', 'Convert text to small caps', 'Remove capitalization'], answer: 1 },
        { text: 'The expression x² is an example of:', options: ['Subscript', 'Superscript', 'Strikethrough', 'Small caps'], answer: 1 },
        { text: 'What is the default file extension for an Excel spreadsheet?', options: ['.xls / .xlsx', '.doc / .docx', '.ppt / .pptx', '.exe'], answer: 0 },
        { text: 'A collection of worksheets in Excel is known as a:', options: ['Workspace', 'File', 'Workbook', 'Folder'], answer: 2 },
        { text: 'In a spreadsheet, all formulas must begin with which symbol?', options: ['+', '-', '=', '*'], answer: 2 },
        { text: 'What is the correct cell address for the intersection of row 5 and column B?', options: ['5B', 'B5', 'B-5', '5-B'], answer: 1 },
        { text: 'Which built-in function is used to calculate the total of a range of values?', options: ['ADD()', 'TOTAL()', 'SUM()', 'PLUS()'], answer: 2 },
        { text: 'An absolute cell reference is represented by which symbol?', options: ['#', '$', '&', '@'], answer: 1 },
        { text: 'How do you highlight an entire column in a spreadsheet?', options: ['Click the column heading letter', 'Press Ctrl + C', 'Press Ctrl + A', 'Double-click the cell'], answer: 0 },
        { text: 'By default, how many worksheets are present in a new Excel 2010 workbook?', options: ['1', '2', '3', '4'], answer: 2 },
        { text: 'Which chart type is best for showing proportions or percentages of a whole?', options: ['Bar chart', 'Pie chart', 'Line chart', 'Scatter plot'], answer: 1 },
        { text: 'Which function is used to find the highest number in a range of cells?', options: ['HIGH()', 'MAX()', 'TOP()', 'UPPER()'], answer: 1 },
        { text: 'What does a cell displaying "######" indicate?', options: ['A formula error', 'The column is not wide enough to display the data', 'The cell is protected', 'A spelling mistake'], answer: 1 },
        { text: 'The active cell in a worksheet is indicated by:', options: ['A red border', 'A dotted border', 'A dark, heavy border', 'Blinking text'], answer: 2 },
        { text: 'What does the "V" in VLOOKUP stand for?', options: ['Vertical', 'Visual', 'Value', 'Variable'], answer: 0 },
        { text: 'Which keyboard shortcut is used to select all cells in a worksheet?', options: ['Ctrl + S', 'Ctrl + A', 'Alt + A', 'Shift + A'], answer: 1 },
        { text: 'To arrange data in a specific order (alphabetical or numerical) is called:', options: ['Filtering', 'Sorting', 'Validating', 'Formatting'], answer: 1 }
      ];
      db.exec('BEGIN');
      year11Qs.forEach((x, i) => q.insertQuestion.run('year-11', i, x.text, JSON.stringify(x.options), x.answer));
      q.setPublished.run('year-11', 1, Date.now());
      db.exec('COMMIT');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
  }
}
seedYear11();

function seedYear9() {
  try {
    const existing = q.questionsFor.all('year-9');
    if (existing.length === 0) {
      const year9Qs = [
        { text: 'Which of the following best defines an "Algorithm" in computer science?', options: ['A step-by-step set of instructions to solve a problem', 'The physical hardware inside a computer', 'A malicious program that damages files', 'The speed of an internet connection'], answer: 0 },
        { text: 'In binary addition, what is the result of adding 1 + 1?', options: ['2', '10 (binary for 2)', '11', '01'], answer: 1 },
        { text: 'What is the decimal (base-10) equivalent of the 8-bit binary number 00001010?', options: ['8', '10', '12', '16'], answer: 1 },
        { text: 'In the Von Neumann architecture, which special register holds the memory address of the next instruction to be fetched?', options: ['Accumulator (ACC)', 'Program Counter (PC)', 'Memory Data Register (MDR)', 'Current Instruction Register (CIR)'], answer: 1 },
        { text: 'What does the CPU clock speed measured in Gigahertz (GHz) indicate?', options: ['The number of fetch-decode-execute cycles the CPU can execute per second', 'The amount of storage on the hard drive', 'The speed of the internet connection', 'The time it takes to boot the computer'], answer: 0 },
        { text: 'In Python programming, which data type is best suited to store a student\'s test score with a decimal point (e.g. 87.5)?', options: ['Integer (int)', 'Boolean (bool)', 'Floating point (float)', 'String (str)'], answer: 2 },
        { text: 'What will the following Python code output: print(15 // 4)?', options: ['3.75', '3', '4', '3 remainder 3'], answer: 1 },
        { text: 'Which computational thinking technique involves breaking a complex problem down into smaller, manageable sub-problems?', options: ['Decomposition', 'Abstraction', 'Pattern Recognition', 'Evaluation'], answer: 0 },
        { text: 'Which computational thinking technique involves focusing only on the essential details and ignoring unnecessary information?', options: ['Decomposition', 'Abstraction', 'Automation', 'Iteration'], answer: 1 },
        { text: 'What is the unique numerical address assigned to every device connected to the Internet called?', options: ['MAC Address', 'IP Address', 'URL Link', 'Domain Name'], answer: 1 },
        { text: 'Which network system translates human-friendly web addresses like www.futurein.org into machine-readable IP addresses?', options: ['DNS (Domain Name System)', 'DHCP', 'FTP', 'SMTP'], answer: 0 },
        { text: 'In HTML, which tag is correctly used to create a clickable hyperlink to another web page?', options: ['<link>', '<href>', '<a>', '<url>'], answer: 2 },
        { text: 'In CSS styling, which property is used to change the text color of an HTML element?', options: ['font-color', 'color', 'text-style', 'background-color'], answer: 1 },
        { text: 'In a relational database table, what is a column that uniquely identifies each individual record called?', options: ['Foreign Key', 'Primary Key', 'Candidate Index', 'Composite Key'], answer: 1 },
        { text: 'Which database command language is the international standard used to query and manipulate relational databases?', options: ['HTML', 'SQL (Structured Query Language)', 'Python', 'XML'], answer: 1 },
        { text: 'What type of malware secretly records keyboard strokes to steal usernames and passwords?', options: ['Ransomware', 'Keylogger (Spyware)', 'Adware', 'Worm'], answer: 1 },
        { text: 'What security practice requires a user to provide two different forms of identification before gaining account access?', options: ['Single Sign-On (SSO)', 'Two-Factor Authentication (2FA)', 'Captcha Verification', 'Password Recovery'], answer: 1 },
        { text: 'The trail of data you leave behind whenever you use the internet, browse websites, or post online is known as your ___', options: ['Digital Footprint', 'IP Pathway', 'Cache Registry', 'Cookie Monster'], answer: 0 },
        { text: 'Which search algorithm inspects each item in a list one by one from the beginning until the target item is found?', options: ['Binary Search', 'Linear Search', 'Hash Lookup', 'Bubble Search'], answer: 1 },
        { text: 'What condition MUST be met before a Binary Search algorithm can be performed on a list?', options: ['The list must be sorted in order', 'The list must contain only numbers', 'The list must have an even number of items', 'The list must be stored in the cloud'], answer: 0 }
      ];
      db.exec('BEGIN');
      year9Qs.forEach((x, i) => q.insertQuestion.run('year-9', i, x.text, JSON.stringify(x.options), x.answer));
      q.setPublished.run('year-9', 1, Date.now());
      db.exec('COMMIT');
      console.log('[SEED] Successfully seeded Year 9 question bank.');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    console.warn('[SEED] Year 9 seed notice:', e.message);
  }
}
seedYear9();

function seedYear10() {
  try {
    const existing = q.questionsFor.all('year-10');
    if (existing.length === 0) {
      const year10Qs = [
        { text: 'Which software translator converts source code into machine code line-by-line and executes it immediately?', options: ['Compiler', 'Interpreter', 'Assembler', 'Linker'], answer: 1 },
        { text: 'What is the key advantage of a Compiler over an Interpreter?', options: ['Compiled code produces an executable file that runs faster without needing source code', 'Compilers execute code line by line with no memory', 'Compilers never report syntax errors', 'Compilers are only used for text formatting'], answer: 0 },
        { text: 'Which logic gate outputs TRUE (1) only when BOTH of its inputs are TRUE (1)?', options: ['OR Gate', 'AND Gate', 'NOT Gate', 'XOR Gate'], answer: 1 },
        { text: 'What is the output of an XOR (Exclusive OR) gate when both inputs are 1?', options: ['0', '1', 'Undefined', '2'], answer: 0 },
        { text: 'How many unique characters can standard 7-bit ASCII represent?', options: ['64', '128', '256', '65,536'], answer: 1 },
        { text: 'Why was Unicode developed to replace standard ASCII?', options: ['To support symbols and writing systems of all languages worldwide using 16/32 bits', 'To make file sizes smaller', 'To remove vowels from text', 'To encrypt all text messages'], answer: 0 },
        { text: 'In digital sound representation, what does the "Sampling Rate" refer to?', options: ['The volume of the sound wave', 'The number of audio samples captured per second (measured in Hz)', 'The physical length of the audio cable', 'The number of speakers playing the sound'], answer: 1 },
        { text: 'What is the total number of colors that can be represented with an 8-bit color depth per pixel?', options: ['16 colors', '64 colors', '256 colors', '16.7 million colors'], answer: 2 },
        { text: 'In packet switching networks, what does each data packet contain in its header?', options: ['Source IP, destination IP, packet sequence number, and checksum', 'The user\'s credit card number', 'The browser history', 'The monitor resolution'], answer: 0 },
        { text: 'Which protocol is responsible for securely transmitting encrypted web pages between a client and a web server?', options: ['HTTP', 'HTTPS (using SSL/TLS)', 'FTP', 'POP3'], answer: 1 },
        { text: 'What type of malicious attack floods a target server with bogus traffic to knock it offline?', options: ['DDoS (Distributed Denial of Service)', 'SQL Injection', 'Phishing', 'Brute Force'], answer: 0 },
        { text: 'What is the primary purpose of a SQL injection attack?', options: ['To exploit unsanitized user inputs to manipulate and access database records', 'To physically damage the hard disk drive', 'To speed up database searches', 'To change the color scheme of a website'], answer: 0 },
        { text: 'In SQL, which query clause filters query results to include only records matching a specific condition?', options: ['GROUP BY', 'ORDER BY', 'WHERE', 'SELECT'], answer: 2 },
        { text: 'What is the worst-case time complexity of the Linear Search algorithm for a list of n elements?', options: ['O(1)', 'O(log n)', 'O(n)', 'O(n²)'], answer: 2 },
        { text: 'What is the average time complexity of the Binary Search algorithm for a list of n elements?', options: ['O(1)', 'O(log n)', 'O(n)', 'O(n²)'], answer: 1 },
        { text: 'In sorting algorithms, which comparison sort repeatedly steps through the list, swaps adjacent elements that are out of order, until sorted?', options: ['Bubble Sort', 'Merge Sort', 'Quick Sort', 'Binary Sort'], answer: 0 },
        { text: 'In Object-Oriented Programming (OOP), what is the blueprint or template from which individual objects are created?', options: ['Class', 'Method', 'Property', 'Variable'], answer: 0 },
        { text: 'What OOP principle bundles data (attributes) and methods that operate on that data within a single unit and restricts direct outside access?', options: ['Inheritance', 'Encapsulation', 'Polymorphism', 'Recursion'], answer: 1 },
        { text: 'Which type of secondary storage relies on microscopic magnetic charge patterns on spinning aluminum platters?', options: ['Solid State Drive (SSD)', 'Hard Disk Drive (HDD)', 'DVD-ROM', 'USB Flash Drive'], answer: 1 },
        { text: 'The environmental issue caused by discarded electronics containing toxic materials like lead and mercury is known as ___', options: ['E-Waste (Electronic Waste)', 'Digital Smog', 'Cyber Pollution', 'Carbon Footprint'], answer: 0 }
      ];
      db.exec('BEGIN');
      year10Qs.forEach((x, i) => q.insertQuestion.run('year-10', i, x.text, JSON.stringify(x.options), x.answer));
      q.setPublished.run('year-10', 1, Date.now());
      db.exec('COMMIT');
      console.log('[SEED] Successfully seeded Year 10 question bank.');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    console.warn('[SEED] Year 10 seed notice:', e.message);
  }
}
seedYear10();

function seedYear12() {
  try {
    const existing = q.questionsFor.all('year-12');
    if (existing.length === 0) {
      const year12Qs = [
        { text: 'In the Von Neumann CPU cycle, what happens during the "Decode" stage?', options: ['The Control Unit interprets the opcode and addressing mode in the Current Instruction Register (CIR)', 'Data is read from the hard disk', 'The ALU computes arithmetic logic', 'Results are written back to main memory'], answer: 0 },
        { text: 'Which CPU register stores the result of the most recent mathematical or logic operation executed by the ALU?', options: ['Accumulator (ACC)', 'Memory Address Register (MAR)', 'Program Counter (PC)', 'Stack Pointer (SP)'], answer: 0 },
        { text: 'Which data structure operates on a Last-In, First-Out (LIFO) access order?', options: ['Queue', 'Stack', 'Linked List', 'Binary Tree'], answer: 1 },
        { text: 'In a Queue data structure (FIFO), from which end are new items inserted?', options: ['Front / Head', 'Rear / Tail', 'Middle', 'Top'], answer: 1 },
        { text: 'What is the best-case and worst-case time complexity of Merge Sort on an array of n elements?', options: ['O(n log n) in all cases', 'O(n) best case, O(n²) worst case', 'O(1) best case, O(n) worst case', 'O(n²) in all cases'], answer: 0 },
        { text: 'Which algorithm design paradigm divides a problem into subproblems, solves each recursively, and combines the solutions (e.g. Merge Sort)?', options: ['Greedy Approach', 'Divide and Conquer', 'Dynamic Programming', 'Brute Force'], answer: 1 },
        { text: 'What is the primary purpose of Operating System virtual memory?', options: ['To use secondary storage (pagefile/swap) to extend physical RAM when RAM is exhausted', 'To simulate 3D virtual reality headsets', 'To speed up CPU clock cycles', 'To encrypt network traffic'], answer: 0 },
        { text: 'In OS memory management, what is "Paging"?', options: ['Physical memory is divided into fixed-size frames and logical memory into pages of equal size', 'Programs are printed onto paper pages', 'Web pages are downloaded simultaneously', 'The CPU switches power modes'], answer: 0 },
        { text: 'What is an OS interrupt in computer architecture?', options: ['A signal emitted by hardware or software alerting the CPU to immediately suspend its current task and handle an event', 'A physical break in the motherboard wire', 'A power outage event', 'A corrupted storage sector'], answer: 0 },
        { text: 'In asymmetric public-key cryptography, which key is used to decrypt a message that was encrypted using the recipient\'s public key?', options: ['The recipient\'s private key', 'The sender\'s public key', 'The sender\'s private key', 'A shared symmetric secret key'], answer: 0 },
        { text: 'What is the role of a Digital Certificate issued by a Certificate Authority (CA) in HTTPS?', options: ['It authenticates the web server\'s identity and binds its public key to the domain', 'It pays for web hosting fees', 'It accelerates download speeds', 'It replaces the need for a firewall'], answer: 0 },
        { text: 'In the Software Development Life Cycle (SDLC), what distinguishes the Agile methodology from the traditional Waterfall model?', options: ['Agile uses iterative sprints with continuous user feedback, while Waterfall follows rigid sequential phases', 'Agile requires no testing', 'Waterfall is only used for mobile apps', 'Agile never writes documentation'], answer: 0 },
        { text: 'In database design, what is the goal of First Normal Form (1NF)?', options: ['Ensuring all column values are atomic (no repeating groups or multi-valued fields) with a primary key', 'Removing all foreign keys', 'Combining all tables into a single giant table', 'Encrypting every table column'], answer: 0 },
        { text: 'In relational database theory, what does Third Normal Form (3NF) eliminate?', options: ['Partial dependencies', 'Transitive dependencies (non-key attributes depending on other non-key attributes)', 'Primary keys', 'Indexes'], answer: 1 },
        { text: 'In database transactions, what does the "A" in ACID properties stand for?', options: ['Atomicity (all changes in a transaction succeed or all roll back)', 'Authentication', 'Asynchronous', 'Availability'], answer: 0 },
        { text: 'In machine learning, what type of learning trains models using labeled input-output pairs?', options: ['Supervised Learning', 'Unsupervised Learning', 'Reinforcement Learning', 'Heuristic Learning'], answer: 0 },
        { text: 'In assembly language, what does an "Opcode" (operation code) specify?', options: ['The specific operation or instruction to be performed by the processor (e.g., ADD, MOV, JMP)', 'The name of the programmer', 'The memory address location', 'The file size in bytes'], answer: 0 },
        { text: 'In assembly addressing modes, what is "Immediate Addressing"?', options: ['The operand value itself is directly specified in the instruction rather than an address', 'The address points to a register', 'The CPU waits 0 cycles', 'The instruction is cached in L1'], answer: 0 },
        { text: 'In modern cloud computing architecture, what is "Serverless Computing" (e.g. AWS Lambda)?', options: ['An execution model where the cloud provider dynamically manages server allocation and provisioning on demand', 'Computing without any physical computers existing', 'Computers operating completely without internet', 'A local desktop application'], answer: 0 },
        { text: 'What is the fundamental unit of information in quantum computing that can exist in a superposition of states?', options: ['Bit', 'Qubit (Quantum Bit)', 'Byte', 'Flop'], answer: 1 }
      ];
      db.exec('BEGIN');
      year12Qs.forEach((x, i) => q.insertQuestion.run('year-12', i, x.text, JSON.stringify(x.options), x.answer));
      q.setPublished.run('year-12', 1, Date.now());
      db.exec('COMMIT');
      console.log('[SEED] Successfully seeded Year 12 question bank.');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    console.warn('[SEED] Year 12 seed notice:', e.message);
  }
}
seedYear12();

// ---------- Phase 3: Dedicated Competition Questions Seeding ----------
function seedCompetitionQuestions() {
  try {
    const competitionBank = {
      'lower-primary': [
        { text: 'Which computer part looks like a small mouse and is clicked to select items on screen?', options: ['Mouse', 'Keyboard', 'Printer', 'Monitor'], answer: 0 },
        { text: 'What do we use to see pictures, games, and videos on a computer?', options: ['Monitor / Screen', 'Keyboard', 'Cable', 'Power plug'], answer: 0 },
        { text: 'Which computer part has keys with letters, numbers, and symbols used for typing words?', options: ['Keyboard', 'Mouse', 'Speaker', 'Webcam'], answer: 0 },
        { text: 'Which machine produces physical copies of our drawings and text onto paper?', options: ['Printer', 'Monitor', 'Mouse', 'CPU'], answer: 0 },
        { text: 'The Central Processing Unit (CPU) is known as the computer\'s ___', options: ['Brain', 'Eyes', 'Ears', 'Feet'], answer: 0 },
        { text: 'Which device helps you hear sounds and music from a computer?', options: ['Speakers / Headphones', 'Scanner', 'Printer', 'Microphone'], answer: 0 },
        { text: 'Which device allows you to record your speaking voice into the computer?', options: ['Microphone', 'Speaker', 'Monitor', 'Mouse'], answer: 0 },
        { text: 'What is the longest key on the computer keyboard used to make spaces between words?', options: ['Spacebar', 'Enter key', 'Shift key', 'Backspace'], answer: 0 },
        { text: 'Which key on the keyboard moves the blinking cursor to a brand new line?', options: ['Enter key', 'Spacebar', 'Caps Lock', 'Escape'], answer: 0 },
        { text: 'To type CAPITAL letters continuously without holding Shift, which key do you turn on?', options: ['Caps Lock', 'Tab', 'Ctrl', 'Alt'], answer: 0 },
        { text: 'Which small blinking symbol on screen marks where your next typed letter will appear?', options: ['Cursor', 'Icon', 'Folder', 'Window'], answer: 0 },
        { text: 'A portable computer that you can fold closed and easily carry in a backpack is a ___', options: ['Laptop', 'Desktop Tower', 'Mainframe', 'Server'], answer: 0 },
        { text: 'Which rule keeps your computer lab and equipment safe?', options: ['Keep drinks and food away from the computer', 'Bang on the keyboard keys hard', 'Pull on all the cables', 'Leave computers out in the rain'], answer: 0 },
        { text: 'What should you do if an unfamiliar pop-up appears on screen asking for personal info?', options: ['Tell a teacher or parent immediately', 'Type your home address', 'Click everything quickly', 'Turn off the lights'], answer: 0 },
        { text: 'Which small pictures on the computer desktop represent apps, files, or folders?', options: ['Icons', 'Cables', 'Sockets', 'Chips'], answer: 0 },
        { text: 'Double-clicking with the left mouse button is commonly used to ___', options: ['Open an app or folder', 'Turn off the power', 'Delete the computer', 'Eject paper'], answer: 0 },
        { text: 'Which key erases letters to the left of the blinking cursor?', options: ['Backspace', 'Spacebar', 'Enter', 'Shift'], answer: 0 },
        { text: 'Which device is an INPUT device used to capture physical photos into the computer?', options: ['Scanner', 'Printer', 'Monitor', 'Projector'], answer: 0 },
        { text: 'A touch-screen device bigger than a phone that you hold with two hands to play learning games is a ___', options: ['Tablet', 'Keyboard', 'Modem', 'Floppy disk'], answer: 0 },
        { text: 'Computers run on which kind of energy?', options: ['Electricity', 'Water', 'Gasoline', 'Wind only'], answer: 0 }
      ],
      'upper-primary': [
        { text: 'In block coding (like Scratch), a sequence of blocks snapped together to perform actions is called a ___', options: ['Script / Program', 'Sprite', 'Costume', 'Backdrop'], answer: 0 },
        { text: 'The characters or movable objects that perform actions on the Scratch stage are called ___', options: ['Sprites', 'Pixels', 'Blocks', 'Nodes'], answer: 0 },
        { text: 'In programming, a named memory container used to store numbers or text that can change (like a player\'s score) is a ___', options: ['Variable', 'Constant', 'Loop', 'Comment'], answer: 0 },
        { text: 'Making decisions in computer code using "IF ... THEN" statements is called ___', options: ['Conditional logic', 'Infinite looping', 'Variable naming', 'Hardcoding'], answer: 0 },
        { text: 'A programming instruction that repeats a group of steps over and over until finished is a ___', options: ['Loop', 'Bug', 'Branch', 'Variable'], answer: 0 },
        { text: 'Finding and fixing mistakes in your computer program or algorithm is called ___', options: ['Debugging', 'Compiling', 'Hacking', 'Browsing'], answer: 0 },
        { text: 'Which computer memory is temporary, volatile, and wiped clean when the computer is turned off?', options: ['RAM (Random Access Memory)', 'ROM (Read Only Memory)', 'Hard Disk', 'Flash Drive'], answer: 0 },
        { text: 'What does the worldwide network connecting millions of computing devices together called?', options: ['Internet', 'Intranet', 'Bluetooth', 'Local Bus'], answer: 0 },
        { text: 'Which application is specifically designed to browse and view websites on the Internet?', options: ['Web Browser (e.g. Chrome, Edge)', 'Word Processor', 'Spreadsheet', 'Media Player'], answer: 0 },
        { text: 'What kind of cyber attack uses fake messages or emails to trick students into giving away passwords?', options: ['Phishing', 'Debugging', 'Streaming', 'Coding'], answer: 0 },
        { text: 'Which sensor on an educational robot allows it to measure distance to a wall or obstacle?', options: ['Ultrasonic / Distance sensor', 'Speaker', 'Battery gauge', 'LED light'], answer: 0 },
        { text: 'A machine that senses its environment, computes decisions, and performs physical movements is a ___', options: ['Robot', 'Typewriter', 'Monitor', 'Calculator'], answer: 0 },
        { text: 'Saving your school files to remote servers accessible from anywhere via the internet is known as ___', options: ['Cloud Storage', 'RAM Memory', 'Desktop Shortcut', 'Floppy Backup'], answer: 0 },
        { text: 'Which of these pieces of information should you NEVER share with strangers on the internet?', options: ['Your full home address and passwords', 'Your favorite hobby', 'Your favorite school subject', 'Your favorite animal'], answer: 0 },
        { text: 'AI systems that can create original stories, code, drawings, or music are called ___', options: ['Generative AI', 'Analog AI', 'Static Computing', 'Rule-based firmware'], answer: 0 },
        { text: 'The prompt or instructions given to an AI tool to generate an answer is known as a ___', options: ['Prompt', 'Token', 'Cable', 'Register'], answer: 0 },
        { text: 'What is the standard keyboard shortcut used to COPY highlighted text?', options: ['Ctrl + C', 'Ctrl + V', 'Ctrl + Z', 'Ctrl + S'], answer: 0 },
        { text: 'What is the standard keyboard shortcut used to PASTE copied text?', options: ['Ctrl + V', 'Ctrl + C', 'Ctrl + P', 'Ctrl + X'], answer: 0 },
        { text: 'A step-by-step set of precise instructions designed to accomplish a specific task is an ___', options: ['Algorithm', 'Icon', 'Hardware', 'Pixel'], answer: 0 },
        { text: 'Who is historically recognized as the world\'s very first computer programmer for her work on Charles Babbage\'s engine?', options: ['Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'Steve Jobs'], answer: 0 }
      ],
      'junior-secondary': [
        { text: 'Which CPU unit carries out all mathematical calculations and logical decision-making?', options: ['Arithmetic Logic Unit (ALU)', 'Control Unit (CU)', 'Cache Memory', 'System Bus'], answer: 0 },
        { text: 'Which CPU unit directs data flow and coordinates operations of all computer hardware?', options: ['Control Unit (CU)', 'Arithmetic Logic Unit (ALU)', 'Accumulator', 'RAM'], answer: 0 },
        { text: 'In binary addition, what is the value of 1 + 1 in binary notation?', options: ['10', '2', '11', '01'], answer: 0 },
        { text: 'What is the decimal equivalent of the binary number 00001100?', options: ['12', '8', '14', '6'], answer: 0 },
        { text: 'Which number system uses base-16 and contains digits 0–9 and letters A–F?', options: ['Hexadecimal', 'Binary', 'Decimal', 'Octal'], answer: 0 },
        { text: 'In the Von Neumann architecture, which register holds the memory address of the next instruction to fetch?', options: ['Program Counter (PC)', 'Accumulator (ACC)', 'Memory Data Register (MDR)', 'Current Instruction Register (CIR)'], answer: 0 },
        { text: 'Which network topology connects all nodes to a single central hub or switch?', options: ['Star Topology', 'Bus Topology', 'Ring Topology', 'Mesh Topology'], answer: 0 },
        { text: 'What type of computer network is restricted to a small local area like a single school building or computer lab?', options: ['LAN (Local Area Network)', 'WAN (Wide Area Network)', 'MAN (Metropolitan Area Network)', 'PAN (Personal Area Network)'], answer: 0 },
        { text: 'In a flowchart, which geometric shape is standardly used to represent an IF/THEN decision?', options: ['Diamond', 'Rectangle', 'Oval', 'Parallelogram'], answer: 0 },
        { text: 'In spreadsheet software (like Excel), which symbol must begin every formula?', options: ['=', '+', '@', '#'], answer: 0 },
        { text: 'Which Excel formula calculates the total sum of cell values from B1 to B20?', options: ['=SUM(B1:B20)', '=ADD(B1:B20)', '=TOTAL(B1:B20)', '=COUNT(B1:B20)'], answer: 0 },
        { text: 'In Python, which built-in function is used to display output text on the console?', options: ['print()', 'output()', 'echo()', 'display()'], answer: 0 },
        { text: 'What will the Python expression "17 % 5" evaluate to?', options: ['2 (the remainder)', '3', '3.4', '0'], answer: 0 },
        { text: 'What is the primary key in a relational database table?', options: ['A field that uniquely identifies every individual record', 'A password used to open the database', 'The largest number in a table', 'A foreign connection link'], answer: 0 },
        { text: 'Which international query language is used to retrieve, update, and manage data in relational databases?', options: ['SQL (Structured Query Language)', 'HTML', 'Python', 'CSS'], answer: 0 },
        { text: 'What hardware or software barrier monitors and filters network traffic based on security rules?', options: ['Firewall', 'Modem', 'Switch', 'Repeater'], answer: 0 },
        { text: 'What security measure requires users to verify identity with a password plus a phone code?', options: ['Two-Factor Authentication (2FA)', 'Single Sign-On (SSO)', 'Captcha', 'Antivirus'], answer: 0 },
        { text: 'Which search algorithm checks each element sequentially one by one from start to end?', options: ['Linear Search', 'Binary Search', 'Hash Lookup', 'Bubble Search'], answer: 0 },
        { text: 'What condition is strictly required before a Binary Search can be conducted on a list?', options: ['The list must be sorted in order', 'The list must contain only numbers', 'The list must have an even number of elements', 'The list must be stored online'], answer: 0 },
        { text: 'The digital trail of activities, posts, and websites you leave behind while using the internet is your ___', options: ['Digital Footprint', 'IP Pathway', 'Cache Archive', 'Cookie Token'], answer: 0 }
      ],
      'senior-secondary': [
        { text: 'Which software translator translates high-level code into machine code line-by-line and executes it immediately?', options: ['Interpreter', 'Compiler', 'Assembler', 'Linker'], answer: 0 },
        { text: 'What is the main operational advantage of compiled programs over interpreted programs?', options: ['Compiled executables run significantly faster and do not require the original source code to execute', 'Compilers use zero RAM memory', 'Compilers never produce syntax errors', 'Compilers work only with text formatting'], answer: 0 },
        { text: 'Which logic gate outputs TRUE (1) if and only if BOTH input signals are TRUE (1)?', options: ['AND Gate', 'OR Gate', 'NOT Gate', 'XOR Gate'], answer: 0 },
        { text: 'What is the output of a 2-input XOR (Exclusive OR) gate when both inputs are 1?', options: ['0', '1', 'Undefined', '2'], answer: 0 },
        { text: 'Why was Unicode developed as the modern standard over 7-bit/8-bit ASCII?', options: ['To support characters and symbols from all living languages across the globe using 16/32 bits', 'To decrease all file sizes', 'To eliminate punctuation from computer files', 'To encrypt web traffic'], answer: 0 },
        { text: 'In digital audio recording, what does the "Sampling Rate" (measured in Hz) specify?', options: ['The number of audio frequency measurements recorded per second', 'The volume loudness of the speaker', 'The length of the audio file in bytes', 'The number of audio channels'], answer: 0 },
        { text: 'In packet-switched computer networks, what information is included in each packet\'s header?', options: ['Source IP, destination IP, packet sequence number, and checksum error data', 'The computer monitor resolution', 'The user credit card number', 'The browser homepage'], answer: 0 },
        { text: 'Which cryptographic protocol encrypts web traffic and secures HTTPS communications using digital certificates?', options: ['TLS / SSL', 'FTP', 'SMTP', 'DHCP'], answer: 0 },
        { text: 'In Object-Oriented Programming (OOP), what is the blueprint from which objects are instantiated?', options: ['Class', 'Method', 'Variable', 'Module'], answer: 0 },
        { text: 'Which OOP pillar involves bundling attributes and methods together and hiding internal state from outside direct modification?', options: ['Encapsulation', 'Inheritance', 'Polymorphism', 'Abstraction'], answer: 0 },
        { text: 'What is the average and worst-case time complexity of Merge Sort on an array of n items?', options: ['O(n log n)', 'O(n²)', 'O(n)', 'O(1)'], answer: 0 },
        { text: 'What is the worst-case time complexity of a Linear Search on an unsorted list of n elements?', options: ['O(n)', 'O(log n)', 'O(1)', 'O(n log n)'], answer: 0 },
        { text: 'What is the average time complexity of a Binary Search on a sorted array of n elements?', options: ['O(log n)', 'O(n)', 'O(1)', 'O(n²)'], answer: 0 },
        { text: 'Which data structure adheres strictly to the Last-In, First-Out (LIFO) protocol?', options: ['Stack', 'Queue', 'Linked List', 'Array'], answer: 0 },
        { text: 'In an Operating System, what mechanism enables physical RAM to be extended using designated hard disk storage space?', options: ['Virtual Memory (Paging / Swap)', 'Overclocking', 'Defragmentation', 'System Bus Multiplexing'], answer: 0 },
        { text: 'In asymmetric cryptography, which cryptographic key is kept secret and used to decrypt messages encrypted by the sender?', options: ['The recipient\'s Private Key', 'The sender\'s Public Key', 'A shared symmetric secret key', 'The Certificate Authority key'], answer: 0 },
        { text: 'In relational database design, what does Third Normal Form (3NF) eliminate?', options: ['Transitive dependencies (non-key fields depending on other non-key fields)', 'Primary keys', 'Foreign key relationships', 'Atomic attributes'], answer: 0 },
        { text: 'In database transactions, what does the "A" in the ACID guarantee signify?', options: ['Atomicity (all operations within the transaction succeed, or the entire transaction is rolled back)', 'Authentication', 'Asynchrony', 'Accessibility'], answer: 0 },
        { text: 'In the Software Development Life Cycle (SDLC), what key feature distinguishes Agile from traditional Waterfall development?', options: ['Agile relies on iterative short sprints with continuous stakeholder feedback rather than rigid sequential stages', 'Agile prohibits testing', 'Waterfall is exclusive to web development', 'Agile produces no documentation'], answer: 0 },
        { text: 'In machine learning, what category of learning involves training an algorithm using labeled training data with known correct outputs?', options: ['Supervised Learning', 'Unsupervised Learning', 'Reinforcement Learning', 'Heuristic Learning'], answer: 0 }
      ]
    };

    db.exec('BEGIN');
    for (const [classId, questions] of Object.entries(competitionBank)) {
      const existing = q.compQuestionsFor.all(classId);
      if (existing.length === 0) {
        questions.forEach((x, i) => {
          q.insertCompQuestion.run(classId, i, x.text, JSON.stringify(x.options), x.answer);
        });
      }
    }
    db.exec('COMMIT');
    console.log('[COMPETITION] Seeded competition question banks successfully.');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    console.warn('[COMPETITION] Seed error:', e.message);
  }
}
seedCompetitionQuestions();

function regradeZeroAttempts() {
  try {
    const zeroAttempts = db.prepare(`SELECT id, name, school, class_id, answers, total, score, started_at, finished_at, duration_ms, answer_key FROM attempts WHERE score = 0 AND answers IS NOT NULL AND answers != '[]'`).all();
    for (const att of zeroAttempts) {
      const cls = COMP_CAT_BY_ID.get(att.class_id) || CLASS_BY_ID.get(att.class_id);
      if (!cls) continue;
      const questions = q.questionsFor.all(cls.id);
      if (questions.length > 0) {
        const key = questions.map(x => x.answer);
        let answers = [];
        try { answers = JSON.parse(att.answers || '[]'); } catch {}
        if (Array.isArray(answers) && answers.length > 0) {
          const newScore = key.reduce((n, correct, i) => n + (answers[i] !== null && answers[i] !== undefined && Number(answers[i]) === correct ? 1 : 0), 0);
          const newTotal = questions.length;
          db.prepare(`UPDATE attempts SET score = ?, total = ?, answer_key = ? WHERE id = ?`).run(newScore, newTotal, JSON.stringify(key), att.id);
          try {
            db.prepare(`UPDATE comp_attempts SET score = ?, total = ?, answer_key = ? WHERE id = ?`).run(newScore, newTotal, JSON.stringify(key), att.id);
          } catch {}
          console.log(`[REGRADE] Regraded attempt for "${att.name}" (${att.class_id}): score updated from 0 to ${newScore}/${newTotal}`);
          saveAttemptToSupabase({
            id: att.id,
            name: att.name,
            school: att.school,
            class_id: att.class_id,
            name_key: (att.name || '').toLowerCase(),
            school_key: (att.school || '').toLowerCase(),
            started_at: att.started_at,
            finished_at: att.finished_at || Date.now(),
            score: newScore,
            total: newTotal,
            duration_ms: att.duration_ms,
            answer_key: JSON.stringify(key),
            answers: att.answers
          }).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.warn('[REGRADE] Notice:', e.message);
  }
}
regradeZeroAttempts();

// Best attempt per child (same name + school) within each class; ranked by score, then speed.
function leaderboard(classId) {
  regradeZeroAttempts();
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
  regradeZeroAttempts();
  const sql = `SELECT name, school, class_id, score, total, duration_ms, finished_at FROM attempts
    WHERE finished_at IS NOT NULL ${classId ? 'AND class_id = ?' : ''} ORDER BY finished_at DESC LIMIT 5000`;
  return classId ? db.prepare(sql).all(classId) : db.prepare(sql).all();
}

// ---------- Phase 3: Competition State & Leaderboard Functions ----------
function getCompetitionState() {
  const row = q.getCompState.get();
  if (!row) {
    return {
      title: 'FutureIN Inter-School Grand Championship',
      status: 'draft',
      durationMins: 30,
      startedAt: null,
      endedAt: null,
      remainingMs: 30 * 60 * 1000,
      updatedAt: Date.now()
    };
  }
  const now = Date.now();
  let status = row.status;
  let remainingMs = 0;
  if (status === 'active') {
    if (row.ended_at && now >= row.ended_at) {
      status = 'ended';
      try { q.endComp.run(row.ended_at, now); } catch (_) {}
    } else if (row.ended_at) {
      remainingMs = Math.max(0, row.ended_at - now);
    }
  } else if (status === 'draft') {
    remainingMs = (row.duration_mins || 30) * 60 * 1000;
  }
  return {
    title: row.title || 'FutureIN Inter-School Grand Championship',
    status,
    durationMins: row.duration_mins || 30,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    remainingMs,
    updatedAt: row.updated_at
  };
}

function compClassSummary() {
  const counts = Object.fromEntries(q.compCounts.all().map((r) => [r.class_id, r.n]));
  const attempts = Object.fromEntries(q.compAttemptCounts.all().map((r) => [r.class_id, r.n]));
  return COMPETITION_CATEGORIES.map((c) => ({
    ...c,
    questions: counts[c.id] || 0,
    attempts: attempts[c.id] || 0,
  }));
}

function compSchoolLeaderboard() {
  const sql = `
    SELECT 
      COALESCE(NULLIF(TRIM(school), ''), 'Independent Innovators') AS school,
      COUNT(DISTINCT name_key) AS total_students,
      COUNT(*) AS total_attempts,
      ROUND(AVG(CAST(score AS REAL) / total * 100), 1) AS avg_score_pct,
      SUM(score) AS total_stars,
      MAX(score) AS highest_score
    FROM comp_attempts
    WHERE finished_at IS NOT NULL
    GROUP BY LOWER(TRIM(COALESCE(NULLIF(TRIM(school), ''), 'Independent Innovators')))
    ORDER BY avg_score_pct DESC, total_students DESC, total_stars DESC
  `;
  const rows = db.prepare(sql).all();
  
  const topStudentStmt = db.prepare(`
    SELECT name, class_id, score, total
    FROM comp_attempts
    WHERE finished_at IS NOT NULL AND LOWER(TRIM(COALESCE(NULLIF(TRIM(school), ''), 'Independent Innovators'))) = ?
    ORDER BY CAST(score AS REAL) / total DESC, duration_ms ASC, finished_at ASC
    LIMIT 1
  `);

  return rows.map((r, idx) => {
    let topStudent = null;
    try {
      topStudent = topStudentStmt.get(r.school.toLowerCase());
    } catch (_) {}

    let trophy = '🎖️';
    if (idx === 0) trophy = '🥇';
    else if (idx === 1) trophy = '🥈';
    else if (idx === 2) trophy = '🥉';

    return {
      rank: idx + 1,
      trophy,
      school: r.school,
      totalStudents: Number(r.total_students) || 0,
      totalAttempts: Number(r.total_attempts) || 0,
      avgScorePct: Number(r.avg_score_pct) || 0,
      totalStars: Number(r.total_stars) || 0,
      highestScore: Number(r.highest_score) || 0,
      topStudent: topStudent ? `${topStudent.name} (${topStudent.score}/${topStudent.total})` : null
    };
  });
}

function schoolLeaderboard() {
  const sql = `
    SELECT 
      COALESCE(NULLIF(TRIM(school), ''), 'Independent Innovators') AS school,
      COUNT(DISTINCT name_key) AS total_students,
      COUNT(*) AS total_attempts,
      ROUND(AVG(CAST(score AS REAL) / total * 100), 1) AS avg_score_pct,
      SUM(score) AS total_stars,
      MAX(score) AS highest_score
    FROM attempts
    WHERE finished_at IS NOT NULL
    GROUP BY LOWER(TRIM(COALESCE(NULLIF(TRIM(school), ''), 'Independent Innovators')))
    ORDER BY avg_score_pct DESC, total_students DESC, total_stars DESC
  `;
  const rows = db.prepare(sql).all();
  
  const topStudentStmt = db.prepare(`
    SELECT name, class_id, score, total
    FROM attempts
    WHERE finished_at IS NOT NULL AND LOWER(TRIM(COALESCE(NULLIF(TRIM(school), ''), 'Independent Innovators'))) = ?
    ORDER BY CAST(score AS REAL) / total DESC, duration_ms ASC, finished_at ASC
    LIMIT 1
  `);

  return rows.map((r, idx) => {
    let topStudent = null;
    try {
      topStudent = topStudentStmt.get(r.school.toLowerCase());
    } catch (_) {}

    let trophy = '🎖️';
    if (idx === 0) trophy = '🥇';
    else if (idx === 1) trophy = '🥈';
    else if (idx === 2) trophy = '🥉';

    return {
      rank: idx + 1,
      trophy,
      school: r.school,
      totalStudents: Number(r.total_students) || 0,
      totalAttempts: Number(r.total_attempts) || 0,
      avgScorePct: Number(r.avg_score_pct) || 0,
      totalStars: Number(r.total_stars) || 0,
      highestScore: Number(r.highest_score) || 0,
      topStudent: topStudent ? `${topStudent.name} (${topStudent.score}/${topStudent.total})` : null
    };
  });
}

function recentAttempts(limit = 25, classId = null) {
  const where = classId && classId !== 'all' ? `AND class_id = ?` : ``;
  const sql = `
    SELECT name, school, class_id, score, total, duration_ms, finished_at
    FROM comp_attempts
    WHERE finished_at IS NOT NULL ${where}
    ORDER BY finished_at DESC
    LIMIT ?
  `;
  return (classId && classId !== 'all') ? db.prepare(sql).all(classId, limit) : db.prepare(sql).all(limit);
}

function competitionLive(classId) {
  const compState = getCompetitionState();
  const where = classId && classId !== 'all' ? `AND class_id = ?` : ``;

  // Query competition attempts
  const sql = `
    SELECT name, school, class_id, score, total, duration_ms, finished_at, attempts_count FROM (
      SELECT a.*,
        ROW_NUMBER() OVER (PARTITION BY class_id, name_key, school_key
                           ORDER BY score DESC, duration_ms ASC, finished_at ASC) AS rn,
        COUNT(*)     OVER (PARTITION BY class_id, name_key, school_key) AS attempts_count
      FROM comp_attempts a WHERE finished_at IS NOT NULL ${where}
    ) WHERE rn = 1
    ORDER BY CAST(score AS REAL) / total DESC, duration_ms ASC, finished_at ASC
    LIMIT 50`;

  let topRows = (classId && classId !== 'all') ? db.prepare(sql).all(classId) : db.prepare(sql).all();

  const podium = topRows.slice(0, 3).map((r, i) => ({
    rank: i + 1,
    medal: i === 0 ? '🥇' : (i === 1 ? '🥈' : '🥉'),
    ...r
  }));

  const schools = compSchoolLeaderboard();
  const ticker = recentAttempts(25, classId);

  const stats = db.prepare(`
    SELECT 
      COUNT(*) AS total_attempts,
      COUNT(DISTINCT name_key) AS total_students,
      COUNT(DISTINCT LOWER(TRIM(school))) AS total_schools,
      COALESCE(SUM(score), 0) AS total_stars,
      ROUND(AVG(CAST(score AS REAL) / total * 100), 1) AS overall_avg_pct
    FROM comp_attempts
    WHERE finished_at IS NOT NULL
  `).get() || { total_attempts: 0, total_students: 0, total_schools: 0, total_stars: 0, overall_avg_pct: 0 };

  return {
    classId: classId || 'all',
    compState,
    podium,
    topStudents: topRows,
    schools,
    ticker,
    stats: {
      totalAttempts: Number(stats.total_attempts) || 0,
      totalStudents: Number(stats.total_students) || 0,
      totalSchools: Number(stats.total_schools) || 0,
      totalStars: Number(stats.total_stars) || 0,
      overallAvgPct: Number(stats.overall_avg_pct) || 0
    },
    timestamp: Date.now()
  };
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

function getSessionSecret() {
  const admin = loadAdmin();
  const base = (process.env.SESSION_SECRET || '') + '::' + (admin ? admin.passwordHash : DEFAULT_ADMIN_HASH);
  return crypto.createHash('sha256').update(base).digest();
}

function createSessionToken(username, maxAgeSec = SESSION_HOURS * 3600) {
  const exp = Date.now() + maxAgeSec * 1000;
  const payload = Buffer.from(JSON.stringify({ u: username, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  try {
    const expectedSig = crypto.createHmac('sha256', getSessionSecret()).update(payloadB64).digest('base64url');
    if (sig.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;

    const data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!data || !data.u || typeof data.exp !== 'number') return null;
    if (Date.now() > data.exp) return null;
    const admin = loadAdmin();
    if (!admin || cleanVal(admin.username).toLowerCase() !== cleanVal(data.u).toLowerCase()) return null;
    return data.u;
  } catch {
    return null;
  }
}

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

  // 1. Stateless HMAC verification (works across all serverless lambda containers)
  const user = verifySessionToken(token);
  if (user) return user;

  // 2. Fallback to SQLite sessions table
  try {
    const s = q.getSession.get(sha256(token));
    if (s && s.expires_at >= Date.now()) {
      const admin = loadAdmin();
      if (admin && s.pw_fp === sha256(admin.passwordHash)) return s.username;
    }
  } catch {}

  return null;
}

function isHttps(req) {
  return req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').startsWith('https');
}

function cookie(req, value, maxAgeSec) {
  return `fin_admin=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
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
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream', ...extra };
    if (ext === '.html' && !headers['Cache-Control']) {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    }
    res.writeHead(200, headers);
    res.end(buf);
  });
}
function readBody(req, limit = 2_000_000) {
  if (req.body && typeof req.body === 'object') {
    return Promise.resolve(req.body);
  }
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); } catch { return Promise.resolve({}); }
  }
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
  const now = Date.now();
  const attemptId = String(body.attemptId || '').trim();
  let attempt = attemptId ? q.getAttempt.get(attemptId) : null;

  if (attempt && attempt.finished_at) {
    if (attempt.score === 0) {
      const cls = CLASS_BY_ID.get(String(attempt.class_id || body.classId || ''));
      if (cls) {
        const questions = q.questionsFor.all(cls.id);
        const key = questions.map((x) => x.answer);
        let answers = [];
        try { answers = JSON.parse(attempt.answers || '[]'); } catch {}
        if (!answers.length && Array.isArray(body.answers)) answers = body.answers;
        let score = 0;
        if (typeof body.score === 'number' && body.score > 0) {
          score = body.score;
        } else if (key.length > 0 && answers.length > 0) {
          score = key.reduce((n, correct, i) => n + (answers[i] !== null && answers[i] !== undefined && Number(answers[i]) === correct ? 1 : 0), 0);
        }
        if (score > 0) {
          const total = key.length || attempt.total || 20;
          db.prepare(`UPDATE attempts SET score = ?, total = ?, answer_key = ? WHERE id = ?`).run(score, total, JSON.stringify(key), attempt.id);
          try { db.prepare(`UPDATE comp_attempts SET score = ?, total = ?, answer_key = ? WHERE id = ?`).run(score, total, JSON.stringify(key), attempt.id); } catch {}
          return sendJson(res, 200, { score, total, durationMs: attempt.duration_ms });
        }
      }
    }
    return sendJson(res, 200, { score: attempt.score, total: attempt.total, durationMs: attempt.duration_ms });
  }

  // Active attempt path
  if (attempt) {
    const key = JSON.parse(attempt.answer_key || '[]');
    const answers = Array.isArray(body.answers) ? body.answers.slice(0, Math.max(key.length, body.answers.length)) : [];
    let score;
    if (typeof body.score === 'number' && body.score >= 0) {
      score = body.score;
    } else {
      score = key.reduce((n, correct, i) => n + (answers[i] !== null && answers[i] !== undefined && Number(answers[i]) === correct ? 1 : 0), 0);
    }
    const total = key.length || Number(body.total) || answers.length || 15;
    const durationMs = Number(body.durationMs) || Math.max(1000, now - attempt.started_at);
    q.finishAttempt.run(now, score, total, durationMs, JSON.stringify(answers), attempt.id);
    logAttemptBackup({ id: attempt.id, name: attempt.name, school: attempt.school, classId: attempt.class_id, score, total, durationMs, finishedAt: now });
    // Mirror into comp_attempts so competition arena and admin area immediately show result
    try {
      q.insertDirectCompAttempt.run(
        attempt.id,
        attempt.name,
        attempt.school,
        attempt.class_id,
        attempt.name.toLowerCase(),
        attempt.school.toLowerCase(),
        attempt.started_at,
        now,
        score,
        total,
        durationMs,
        attempt.answer_key,
        JSON.stringify(answers)
      );
    } catch (e) {
      console.warn('[COMPETITION] Mirror failed:', e.message);
    }
    try {
      await saveAttemptToSupabase({
        id: attempt.id,
        name: attempt.name,
        school: attempt.school,
        class_id: attempt.class_id,
        name_key: attempt.name.toLowerCase(),
        school_key: attempt.school.toLowerCase(),
        started_at: attempt.started_at,
        finished_at: now,
        score,
        total,
        duration_ms: durationMs,
        answer_key: attempt.answer_key,
        answers: JSON.stringify(answers)
      });
    } catch {}
    return sendJson(res, 200, { score, total, durationMs });
  }

  // Resilient fallback: Server restarted or attemptId lost/expired during the quiz, but student finished!
  const name = clean(body.name);
  const school = clean(body.school);
  const cls = COMP_CAT_BY_ID.get(String(body.classId || '')) || CLASS_BY_ID.get(String(body.classId || ''));
  if (name.length >= 2 && school.length >= 2 && cls) {
    const id = attemptId || crypto.randomUUID();
    const questions = q.questionsFor.all(cls.id);
    const key = questions.map((x) => x.answer);
    const answers = Array.isArray(body.answers) ? body.answers : [];
    let score;
    if (typeof body.score === 'number' && body.score >= 0) {
      score = body.score;
    } else if (key.length > 0) {
      score = key.reduce((n, correct, i) => n + (answers[i] !== null && answers[i] !== undefined && Number(answers[i]) === correct ? 1 : 0), 0);
    } else {
      score = 0;
    }
    const total = key.length || Number(body.total) || answers.length || 15;
    const durationMs = Number(body.durationMs) || 60000;
    const startedAt = now - durationMs;
    q.insertDirectAttempt.run(
      id,
      name,
      school,
      cls.id,
      name.toLowerCase(),
      school.toLowerCase(),
      startedAt,
      now,
      score,
      total,
      durationMs,
      JSON.stringify(key),
      JSON.stringify(answers)
    );
    logAttemptBackup({ id, name, school, classId: cls.id, score, total, durationMs, finishedAt: now });
    // Mirror into comp_attempts so competition arena and admin area immediately show result
    try {
      q.insertDirectCompAttempt.run(
        id,
        name,
        school,
        cls.id,
        name.toLowerCase(),
        school.toLowerCase(),
        startedAt,
        now,
        score,
        total,
        durationMs,
        JSON.stringify(key),
        JSON.stringify(answers)
      );
    } catch (e) {
      console.warn('[COMPETITION] Mirror failed:', e.message);
    }
    try {
      await saveAttemptToSupabase({
        id,
        name,
        school,
        class_id: cls.id,
        name_key: name.toLowerCase(),
        school_key: school.toLowerCase(),
        started_at: startedAt,
        finished_at: now,
        score,
        total,
        duration_ms: durationMs,
        answer_key: JSON.stringify(key),
        answers: JSON.stringify(answers)
      });
    } catch {}
    return sendJson(res, 200, { score, total, durationMs });
  }

  return sendJson(res, 404, { error: 'This quiz session has ended. Please start again.' });
}

async function startCompAttempt(req, res) {
  const compState = getCompetitionState();
  const body = await readBody(req, 20_000);
  if (compState.status !== 'active' && !body.isTest) {
    return sendJson(res, 400, {
      error: compState.status === 'draft'
        ? 'The competition arena has not started yet. Please wait in the waiting room!'
        : 'The competition has ended. Check the big-screen projector for final winners!',
      status: compState.status,
      title: compState.title
    });
  }
  const name = clean(body.name);
  const school = clean(body.school);
  const cls = COMP_CAT_BY_ID.get(String(body.classId || '')) || CLASS_BY_ID.get(String(body.classId || ''));
  if (name.length < 2 || school.length < 2) {
    return sendJson(res, 400, { error: 'Please enter your name and school.' });
  }
  if (!cls) return sendJson(res, 400, { error: 'Please select your competition category.' });

  let questions = q.compQuestionsFor.all(cls.id);
  if (questions.length === 0) {
    questions = q.questionsFor.all(cls.id);
  }
  if (questions.length === 0) {
    return sendJson(res, 400, { error: `No competition questions set for ${cls.label} yet.` });
  }

  const id = crypto.randomUUID();
  const key = questions.map(x => x.answer);
  q.insertCompAttempt.run(id, name, school, cls.id, name.toLowerCase(), school.toLowerCase(), Date.now(), JSON.stringify(key));

  sendJson(res, 200, {
    attemptId: id,
    title: compState.title,
    classLabel: cls.label,
    remainingMs: compState.remainingMs,
    durationMins: compState.durationMins,
    questions: questions.map(x => ({ question: x.text, options: JSON.parse(x.options) }))
  });
}

async function submitCompAttempt(req, res) {
  const body = await readBody(req, 50_000);
  const now = Date.now();
  const attemptId = String(body.attemptId || '').trim();
  let attempt = attemptId ? q.getCompAttempt.get(attemptId) : null;

  if (attempt && attempt.finished_at) {
    return sendJson(res, 200, { score: attempt.score, total: attempt.total, durationMs: attempt.duration_ms });
  }

  if (attempt) {
    const key = JSON.parse(attempt.answer_key || '[]');
    const answers = Array.isArray(body.answers) ? body.answers : [];
    let score;
    if (typeof body.score === 'number' && body.score >= 0) {
      score = body.score;
    } else {
      score = key.reduce((n, correct, i) => n + (answers[i] !== null && answers[i] !== undefined && Number(answers[i]) === correct ? 1 : 0), 0);
    }
    const total = key.length || Number(body.total) || answers.length || 10;
    const durationMs = Number(body.durationMs) || Math.max(1000, now - attempt.started_at);
    q.finishCompAttempt.run(now, score, total, durationMs, JSON.stringify(answers), attempt.id);
    // Mirror into attempts for unified scoreboard
    try {
      q.insertDirectAttempt.run(
        attempt.id,
        attempt.name,
        attempt.school,
        attempt.class_id,
        attempt.name_key,
        attempt.school_key,
        attempt.started_at,
        now,
        score,
        total,
        durationMs,
        attempt.answer_key,
        JSON.stringify(answers)
      );
    } catch (_) {}
    logAttemptBackup({ id: attempt.id, name: attempt.name, school: attempt.school, classId: attempt.class_id, score, total, durationMs, finishedAt: now });
    try {
      await saveAttemptToSupabase({
        id: attempt.id,
        name: attempt.name,
        school: attempt.school,
        class_id: attempt.class_id,
        name_key: attempt.name_key,
        school_key: attempt.school_key,
        started_at: attempt.started_at,
        finished_at: now,
        score,
        total,
        duration_ms: durationMs,
        answer_key: attempt.answer_key,
        answers: JSON.stringify(answers)
      });
    } catch (_) {}
    return sendJson(res, 200, { score, total, durationMs });
  }

  const name = clean(body.name);
  const school = clean(body.school);
  const cls = CLASS_BY_ID.get(String(body.classId || ''));
  if (name.length >= 2 && school.length >= 2 && cls) {
    const id = attemptId || crypto.randomUUID();
    let questions = q.compQuestionsFor.all(cls.id);
    if (questions.length === 0) questions = q.questionsFor.all(cls.id);
    const key = questions.map(x => x.answer);
    const answers = Array.isArray(body.answers) ? body.answers : [];
    const score = Number(body.score) || 0;
    const total = key.length || Number(body.total) || 10;
    const durationMs = Number(body.durationMs) || 60000;
    const startedAt = now - durationMs;
    q.insertCompAttempt.run(id, name, school, cls.id, name.toLowerCase(), school.toLowerCase(), startedAt, JSON.stringify(key));
    q.finishCompAttempt.run(now, score, total, durationMs, JSON.stringify(answers), id);
    // Mirror into attempts for unified scoreboard
    try {
      q.insertDirectAttempt.run(
        id,
        name,
        school,
        cls.id,
        name.toLowerCase(),
        school.toLowerCase(),
        startedAt,
        now,
        score,
        total,
        durationMs,
        JSON.stringify(key),
        JSON.stringify(answers)
      );
    } catch (_) {}
    logAttemptBackup({ id, name, school, classId: cls.id, score, total, durationMs, finishedAt: now });
    try {
      await saveAttemptToSupabase({
        id,
        name,
        school,
        class_id: cls.id,
        name_key: name.toLowerCase(),
        school_key: school.toLowerCase(),
        started_at: startedAt,
        finished_at: now,
        score,
        total,
        duration_ms: durationMs,
        answer_key: JSON.stringify(key),
        answers: JSON.stringify(answers)
      });
    } catch (_) {}
    return sendJson(res, 200, { score, total, durationMs });
  }

  return sendJson(res, 404, { error: 'Competition session not found.' });
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
  const token = createSessionToken(admin.username, SESSION_HOURS * 3600);
  try {
    q.purgeSessions.run(Date.now());
    q.insertSession.run(sha256(token), admin.username, sha256(admin.passwordHash), Date.now() + SESSION_HOURS * 3600 * 1000);
  } catch {}
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
    await syncAttemptsFromSupabase();
    const classId = CLASS_BY_ID.has(url.searchParams.get('class')) ? url.searchParams.get('class') : null;
    return sendJson(res, 200, { rows: leaderboard(classId) });
  }
  if (p === '/api/admin/attempts') {
    await syncAttemptsFromSupabase();
    const classId = CLASS_BY_ID.has(url.searchParams.get('class')) ? url.searchParams.get('class') : null;
    return sendJson(res, 200, { rows: allAttempts(classId) });
  }

  // Competition Admin Endpoints
  if (p === '/api/admin/competition' && req.method === 'GET') {
    return sendJson(res, 200, {
      state: getCompetitionState(),
      classes: compClassSummary()
    });
  }
  if (p === '/api/admin/competition/config' && req.method === 'POST') {
    const body = await readBody(req, 10_000);
    const title = clean(body.title, 120) || 'FutureIN Inter-School Grand Championship';
    const durationMins = Math.max(1, Math.min(240, Number(body.durationMins) || 30));
    q.updateCompConfig.run(title, durationMins, Date.now());
    return sendJson(res, 200, { ok: true, state: getCompetitionState() });
  }
  if (p === '/api/admin/competition/action' && req.method === 'POST') {
    const body = await readBody(req, 10_000);
    const action = String(body.action || '').trim();
    const now = Date.now();
    const state = getCompetitionState();

    if (action === 'start') {
      const endedAt = now + state.durationMins * 60 * 1000;
      q.startComp.run(now, endedAt, now);
    } else if (action === 'end') {
      q.endComp.run(now, now);
    } else if (action === 'reset') {
      q.resetComp.run(now);
      if (body.clearAttempts) {
        q.clearCompAttempts.run();
      }
    }
    return sendJson(res, 200, { ok: true, state: getCompetitionState() });
  }
  if (p === '/api/admin/competition/questions' && req.method === 'GET') {
    const classId = String(url.searchParams.get('class') || '').trim();
    const cls = COMP_CAT_BY_ID.get(classId) || CLASS_BY_ID.get(classId);
    if (!cls) return sendJson(res, 400, { error: 'Unknown competition category or class' });
    const rows = q.compQuestionsFor.all(cls.id).map(r => ({ text: r.text, options: JSON.parse(r.options), answer: r.answer }));
    return sendJson(res, 200, { classId: cls.id, classLabel: cls.label, questions: rows });
  }
  if (p === '/api/admin/competition/questions' && req.method === 'PUT') {
    const body = await readBody(req);
    const cls = COMP_CAT_BY_ID.get(String(body.classId || '')) || CLASS_BY_ID.get(String(body.classId || ''));
    if (!cls) return sendJson(res, 400, { error: 'Unknown competition category or class' });
    const v = validateQuestions(body.questions);
    if (v.error) return sendJson(res, 400, { error: v.error });
    db.exec('BEGIN');
    try {
      q.deleteCompQuestions.run(cls.id);
      v.questions.forEach((x, i) => q.insertCompQuestion.run(cls.id, i, x.text, JSON.stringify(x.options), x.answer));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return sendJson(res, 200, { ok: true, count: v.questions.length });
  }
  if (p === '/api/admin/competition/attempts' && req.method === 'GET') {
    await syncAttemptsFromSupabase().catch(() => {});
    const classId = url.searchParams.get('class');
    const where = classId && classId !== 'all' ? `AND class_id = ?` : ``;
    const sql = `SELECT name, school, class_id, score, total, duration_ms, finished_at FROM comp_attempts
      WHERE finished_at IS NOT NULL ${where} ORDER BY finished_at DESC LIMIT 2000`;
    const rows = (classId && classId !== 'all') ? db.prepare(sql).all(classId) : db.prepare(sql).all();
    return sendJson(res, 200, { rows });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

// ---------- Server ----------
const SECURITY_HEADERS = { 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };

const server = http.createServer(requestHandler);

async function requestHandler(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');
  const forwarded = url.searchParams.get('__path')
    || req.headers['x-matched-path']
    || req.headers['x-forwarded-uri']
    || req.headers['x-original-url']
    || req.originalUrl;
  
  if (url.searchParams.has('__path')) url.searchParams.delete('__path');

  const rawPath = (forwarded && !forwarded.startsWith('/api/index'))
    ? forwarded
    : (!url.pathname.startsWith('/api/index') ? url.pathname : '/');

  const p = decodeURIComponent(rawPath.split('?')[0]).replace(/\/+$/, '') || '/';
  const lower = p.toLowerCase();
  try {
    if (lower === '/api/classes') return sendJson(res, 200, { classes: CLASSES });
    if (lower === '/api/start' && req.method === 'POST') return await startQuiz(req, res);
    if (lower === '/api/submit' && req.method === 'POST') return await submitQuiz(req, res);

    // Competition public endpoints
    if (lower === '/api/competition/status') {
      return sendJson(res, 200, getCompetitionState());
    }
    if (lower === '/api/competition/start-attempt' && req.method === 'POST') {
      return await startCompAttempt(req, res);
    }
    if (lower === '/api/competition/submit' && req.method === 'POST') {
      return await submitCompAttempt(req, res);
    }
    if (lower === '/api/competition/live' || lower === '/api/competition/schools') {
      const user = sessionUser(req);
      if (!user) return sendJson(res, 401, { error: 'Admin access required to view the live arena.' });
      if (lower === '/api/competition/live') {
        const classId = url.searchParams.get('classId') || url.searchParams.get('class');
        syncAttemptsFromSupabase().catch(() => {});
        return sendJson(res, 200, competitionLive(classId));
      }
      syncAttemptsFromSupabase().catch(() => {});
      return sendJson(res, 200, { schools: compSchoolLeaderboard() });
    }

    if (lower.startsWith('/api/admin/')) return await adminRoutes(req, res, lower, url);
    if (lower.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });

    if (lower === '/compete' || lower.startsWith('/compete/') || lower === '/compete.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'compete.html'));
    }
    if (lower === '/projector' || lower === '/competition' || lower === '/projector.html' || lower === '/leaderboard') {
      const user = sessionUser(req);
      if (!user) {
        res.writeHead(302, { Location: ADMIN_PATH });
        return res.end();
      }
      return sendFile(res, path.join(PUBLIC_DIR, 'projector.html'), { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    }
    if (lower === ADMIN_PATH || lower === '/admin.html') {
      const adminFile = fs.existsSync(path.join(PUBLIC_DIR, 'admin.html'))
        ? path.join(PUBLIC_DIR, 'admin.html')
        : path.join(PUBLIC_DIR, 'private', 'admin.html');
      return sendFile(res, adminFile, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    }
    if (lower === '/nursery' || lower === '/nursery-2' || lower === '/quiz/nursery-2' || lower === '/quiz/nursery') return sendFile(res, path.join(PUBLIC_DIR, 'nursery.html'));
    if (lower === '/year-1' || lower === '/quiz/year-1' || lower === '/year1' || lower === '/quiz/year1') return sendFile(res, path.join(PUBLIC_DIR, 'year-1.html'));
    if (lower === '/year-2' || lower === '/quiz/year-2' || lower === '/year2' || lower === '/quiz/year2') return sendFile(res, path.join(PUBLIC_DIR, 'year-2.html'));
    if (lower === '/year-3' || lower === '/quiz/year-3' || lower === '/year3' || lower === '/quiz/year3') return sendFile(res, path.join(PUBLIC_DIR, 'year-3.html'));
    if (lower === '/year-4' || lower === '/quiz/year-4' || lower === '/year4' || lower === '/quiz/year4') return sendFile(res, path.join(PUBLIC_DIR, 'year-4.html'));
    if (lower === '/year-5' || lower === '/quiz/year-5' || lower === '/year5' || lower === '/quiz/year5') return sendFile(res, path.join(PUBLIC_DIR, 'year-5.html'));
    if (lower === '/year-6' || lower === '/quiz/year-6' || lower === '/year6' || lower === '/quiz/year6') return sendFile(res, path.join(PUBLIC_DIR, 'year-6.html'));
    if (lower === '/year-7' || lower === '/quiz/year-7' || lower === '/year7' || lower === '/quiz/year7') return sendFile(res, path.join(PUBLIC_DIR, 'year-7.html'));
    if (lower === '/year-8' || lower === '/quiz/year-8' || lower === '/year8' || lower === '/quiz/year8') return sendFile(res, path.join(PUBLIC_DIR, 'year-8.html'));
    if (lower === '/year-9' || lower === '/quiz/year-9' || lower === '/year9' || lower === '/quiz/year9') return sendFile(res, path.join(PUBLIC_DIR, 'year-9.html'));
    if (lower === '/year-10' || lower === '/quiz/year-10' || lower === '/year10' || lower === '/quiz/year10') return sendFile(res, path.join(PUBLIC_DIR, 'year-10.html'));
    if (lower === '/year-11' || lower === '/quiz/year-11' || lower === '/year11' || lower === '/quiz/year11') return sendFile(res, path.join(PUBLIC_DIR, 'year-11.html'));
    if (lower === '/year-12' || lower === '/quiz/year-12' || lower === '/year12' || lower === '/quiz/year12') return sendFile(res, path.join(PUBLIC_DIR, 'year-12.html'));
    const ym = lower.match(/^\/(?:quiz\/)?year-?([0-9]+)$/);
    if (ym && fs.existsSync(path.join(PUBLIC_DIR, `year-${ym[1]}.html`))) {
      return sendFile(res, path.join(PUBLIC_DIR, `year-${ym[1]}.html`));
    }
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
}

if (!process.env.VERCEL) {
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
}

module.exports = requestHandler;
module.exports.server = server;
