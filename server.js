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
        if (!existing) {
          const finishedAt = Number(r.finished_at) || Date.now();
          const dur = Number(r.duration_ms) || 60000;
          const startedAt = Number(r.started_at) || (finishedAt - dur);
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
      }
    }
    if (count > 0) {
      console.log(`[SUPABASE] Synced ${count} attempt(s) from Supabase cloud into local database.`);
    }
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
  const cls = CLASS_BY_ID.get(String(body.classId || ''));
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
    await syncAttemptsFromSupabase();
    const classId = CLASS_BY_ID.has(url.searchParams.get('class')) ? url.searchParams.get('class') : null;
    return sendJson(res, 200, { rows: leaderboard(classId) });
  }
  if (p === '/api/admin/attempts') {
    await syncAttemptsFromSupabase();
    const classId = CLASS_BY_ID.has(url.searchParams.get('class')) ? url.searchParams.get('class') : null;
    return sendJson(res, 200, { rows: allAttempts(classId) });
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
    if (lower.startsWith('/api/admin/')) return await adminRoutes(req, res, lower, url);
    if (lower.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });

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
