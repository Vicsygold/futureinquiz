const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'quiz.db');
const db = new DatabaseSync(dbPath);

const rawQuizData = [
  { q: 'Which part of the computer is known as the "brain" and performs calculations and logical operations?', opts: ['A) Hard Disk Drive', 'B) Central Processing Unit (CPU)', 'C) Monitor', 'D) Keyboard'], ans: 'B' },
  { q: 'Which of the following is strictly an INPUT device used to capture physical photos or documents into digital form?', opts: ['A) Scanner', 'B) Printer', 'C) Monitor', 'D) Projector'], ans: 'A' },
  { q: 'What does the acronym "RAM" stand for in computer memory?', opts: ['A) Read Access Method', 'B) Rapid Action Memory', 'C) Random Access Memory', 'D) Remote Audio Module'], ans: 'C' },
  { q: 'Which type of software controls the computer hardware and allows applications to run?', opts: ['A) Web Browser', 'B) Operating System', 'C) Word Processor', 'D) Spreadsheet'], ans: 'B' },
  { q: 'What is the smallest basic unit of digital data in computing?', opts: ['A) Byte', 'B) Kilobyte', 'C) Bit', 'D) Megabyte'], ans: 'C' },
  { q: 'How many bits make up one single byte?', opts: ['A) 4 bits', 'B) 8 bits', 'C) 16 bits', 'D) 32 bits'], ans: 'B' },
  { q: 'Which ancient calculating device used beads sliding on rods for arithmetic operations?', opts: ['A) Abacus', 'B) Slide Rule', 'C) Napier Bones', 'D) Pascaline'], ans: 'A' },
  { q: 'Who is widely regarded as the "Father of Computers" for designing the Analytical Engine?', opts: ['A) Alan Turing', 'B) Blaise Pascal', 'C) John von Neumann', 'D) Charles Babbage'], ans: 'D' },
  { q: 'Which of these is permanent, non-volatile primary memory that stores initial startup instructions?', opts: ['A) RAM', 'B) ROM (Read Only Memory)', 'C) Cache Memory', 'D) Virtual Memory'], ans: 'B' },
  { q: 'What is the standard keyboard shortcut used to COPY highlighted text or items?', opts: ['A) Ctrl + C', 'B) Ctrl + V', 'C) Ctrl + X', 'D) Ctrl + Z'], ans: 'A' },
  { q: 'What is the standard keyboard shortcut used to PASTE copied text or items?', opts: ['A) Ctrl + P', 'B) Ctrl + S', 'C) Ctrl + V', 'D) Ctrl + C'], ans: 'C' },
  { q: 'Which symbol is essential in every email address to separate the username from the domain name?', opts: ['A) #', 'B) @', 'C) $', 'D) &'], ans: 'B' },
  { q: 'A worldwide global network connecting millions of computers together across the planet is the ___', opts: ['A) Intranet', 'B) Local Area Network', 'C) Internet', 'D) Bluetooth'], ans: 'C' },
  { q: 'Which software application is specifically used to view and navigate web pages?', opts: ['A) Web Browser (e.g. Chrome, Edge)', 'B) Search Engine', 'C) Spreadsheet', 'D) Media Player'], ans: 'A' },
  { q: 'In word processing, what does clicking the "B" button on the formatting toolbar do?', opts: ['A) Changes font to Blue', 'B) Makes text Bold (darker and thicker)', 'C) Underlines text', 'D) Converts to Bullet points'], ans: 'B' },
  { q: 'Which storage medium uses laser beams to read and write data on a shiny spinning disc?', opts: ['A) Magnetic Hard Drive', 'B) Optical Disc (CD / DVD)', 'C) Solid State Drive', 'D) Flash Drive'], ans: 'B' },
  { q: 'What do we call raw, unorganized facts and figures before they are processed by a computer?', opts: ['A) Information', 'B) Knowledge', 'C) Data', 'D) Output'], ans: 'C' },
  { q: 'Processed data that is organized, meaningful, and useful for decision making is known as ___', opts: ['A) Information', 'B) Raw Code', 'C) Hardware', 'D) Algorithm'], ans: 'A' },
  { q: 'Which keyboard key is pressed to delete characters located to the left of the blinking cursor?', opts: ['A) Delete', 'B) Backspace', 'C) Enter', 'D) Spacebar'], ans: 'B' },
  { q: 'Which of the following is recommended for good computer ergonomics?', opts: ['A) Slouching deep in the chair', 'B) Keeping monitor screen at eye level with back supported', 'C) Placing screen in complete darkness', 'D) Reaching far away to type'], ans: 'B' }
];

const ansMap = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };

db.exec('BEGIN');
try {
  db.prepare('DELETE FROM questions WHERE class_id = ?').run('year-7');
  db.prepare('DELETE FROM comp_questions WHERE class_id = ?').run('year-7');

  const insertQ = db.prepare('INSERT INTO questions (class_id, position, text, options, answer) VALUES (?, ?, ?, ?, ?)');
  const insertCompQ = db.prepare('INSERT INTO comp_questions (class_id, position, text, options, answer) VALUES (?, ?, ?, ?, ?)');

  rawQuizData.forEach((q, i) => {
    const cleanOpts = q.opts.map(o => o.replace(/^[A-D]\)\s*/, '').trim());
    const ansIdx = ansMap[q.ans.toUpperCase()] ?? 0;
    insertQ.run('year-7', i, q.q, JSON.stringify(cleanOpts), ansIdx);
    insertCompQ.run('year-7', i, q.q, JSON.stringify(cleanOpts), ansIdx);
  });

  db.prepare('INSERT OR REPLACE INTO class_settings (class_id, published, updated_at) VALUES (?, 1, ?)').run('year-7', Date.now());
  db.exec('COMMIT');
  console.log('Successfully inserted ' + rawQuizData.length + ' questions into Year 7 in quiz.db');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('Error inserting:', e);
  process.exit(1);
}
