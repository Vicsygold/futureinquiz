const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'quiz.db');
const db = new DatabaseSync(dbPath);

const rawQuizData = [
  { q: 'What does the "ALU" component inside the Central Processing Unit stand for?', opts: ['A) Advanced Link Utility', 'B) Arithmetic Logic Unit', 'C) Automatic Linear Unit', 'D) Access Level User'], ans: 'B' },
  { q: 'Which CPU unit directs data flow and coordinates the operations of all computer components?', opts: ['A) Control Unit (CU)', 'B) Arithmetic Logic Unit (ALU)', 'C) Cache Memory', 'D) System Bus'], ans: 'A' },
  { q: 'Which number system uses base-16 and contains digits 0–9 and letters A–F?', opts: ['A) Binary', 'B) Decimal', 'C) Hexadecimal', 'D) Octal'], ans: 'C' },
  { q: 'What is the binary representation of the decimal number 5?', opts: ['A) 110', 'B) 101', 'C) 011', 'D) 100'], ans: 'B' },
  { q: 'Which network topology connects all client computers to a single central switch or hub?', opts: ['A) Bus Topology', 'B) Ring Topology', 'C) Star Topology', 'D) Mesh Topology'], ans: 'C' },
  { q: 'What kind of network covers a small localized geographical area like a school lab or office building?', opts: ['A) LAN (Local Area Network)', 'B) WAN (Wide Area Network)', 'C) MAN (Metropolitan Area Network)', 'D) PAN (Personal Area Network)'], ans: 'A' },
  { q: 'Which high-speed storage device uses flash memory chips instead of moving magnetic platters?', opts: ['A) Hard Disk Drive (HDD)', 'B) Solid State Drive (SSD)', 'C) Floppy Disk', 'D) Magnetic Tape'], ans: 'B' },
  { q: 'What is the main printed circuit board that connects the CPU, RAM, and all other components together?', opts: ['A) Motherboard', 'B) Expansion Card', 'C) Sound Card', 'D) Power Supply'], ans: 'A' },
  { q: 'Which system utility rearranges fragmented files on a hard disk to improve access speed?', opts: ['A) Antivirus', 'B) Disk Defragmenter', 'C) File Compression', 'D) Task Scheduler'], ans: 'B' },
  { q: 'What does the letter "S" stand for in the web protocol "https://"?', opts: ['A) System', 'B) Standard', 'C) Secure (encrypted)', 'D) Speed'], ans: 'C' },
  { q: 'A visual diagram representing an algorithm step-by-step with geometric shapes and arrows is a ___', opts: ['A) Pseudocode', 'B) Flowchart', 'C) Wireframe', 'D) Schematic'], ans: 'B' },
  { q: 'In a standard flowchart, which geometric shape represents a decision point (Yes/No)?', opts: ['A) Rectangle', 'B) Oval', 'C) Diamond', 'D) Parallelogram'], ans: 'C' },
  { q: 'In spreadsheet software like Microsoft Excel, which character MUST begin every formula?', opts: ['A) =', 'B) +', 'C) @', 'D) #'], ans: 'A' },
  { q: 'In an Excel spreadsheet, which formula correctly calculates the sum of cells from A1 to A10?', opts: ['A) =ADD(A1:A10)', 'B) =SUM(A1:A10)', 'C) =TOTAL(A1:A10)', 'D) =COUNT(A1:A10)'], ans: 'B' },
  { q: 'What cyber attack tricks users into revealing confidential passwords via fraudulent emails or websites?', opts: ['A) Trojan Horse', 'B) DDoS', 'C) Phishing', 'D) Spyware'], ans: 'C' },
  { q: 'A network security barrier that monitors and filters traffic between trusted and untrusted networks is a ___', opts: ['A) Firewall', 'B) Modem', 'C) Switch', 'D) Repeater'], ans: 'A' },
  { q: 'Which of the following is an open-source operating system widely used in servers and software development?', opts: ['A) Microsoft Windows', 'B) Apple macOS', 'C) Linux', 'D) iOS'], ans: 'C' },
  { q: 'Approximately how many Megabytes (MB) are in 1 Gigabyte (GB)?', opts: ['A) 100 MB', 'B) 1024 MB', 'C) 500 MB', 'D) 10000 MB'], ans: 'B' },
  { q: 'In computer programming, a named container in memory used to store values that can change is a ___', opts: ['A) Constant', 'B) Variable', 'C) Function', 'D) Loop'], ans: 'B' },
  { q: 'What legal framework protects creators from unauthorized copying of their software, music, and writing?', opts: ['A) Copyright and Intellectual Property', 'B) Creative Commons Zero', 'C) Public Domain', 'D) Fair Use Only'], ans: 'A' }
];

const ansMap = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };

db.exec('BEGIN');
try {
  db.prepare('DELETE FROM questions WHERE class_id = ?').run('year-8');
  db.prepare('DELETE FROM comp_questions WHERE class_id = ?').run('year-8');

  const insertQ = db.prepare('INSERT INTO questions (class_id, position, text, options, answer) VALUES (?, ?, ?, ?, ?)');
  const insertCompQ = db.prepare('INSERT INTO comp_questions (class_id, position, text, options, answer) VALUES (?, ?, ?, ?, ?)');

  rawQuizData.forEach((q, i) => {
    const cleanOpts = q.opts.map(o => o.replace(/^[A-D]\)\s*/, '').trim());
    const ansIdx = ansMap[q.ans.toUpperCase()] ?? 0;
    insertQ.run('year-8', i, q.q, JSON.stringify(cleanOpts), ansIdx);
    insertCompQ.run('year-8', i, q.q, JSON.stringify(cleanOpts), ansIdx);
  });

  db.prepare('INSERT OR REPLACE INTO class_settings (class_id, published, updated_at) VALUES (?, 1, ?)').run('year-8', Date.now());
  db.exec('COMMIT');
  console.log('Successfully inserted ' + rawQuizData.length + ' questions into Year 8 in quiz.db');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('Error inserting:', e);
  process.exit(1);
}
