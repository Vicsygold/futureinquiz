const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'quiz.db');
const db = new DatabaseSync(dbPath);

const rawQuizData = [
  { q: 'Which of the following best defines an "Algorithm" in computer science?', opts: ['A) A step-by-step set of instructions to solve a problem', 'B) The physical hardware inside a computer', 'C) A malicious program that damages files', 'D) The speed of an internet connection'], ans: 'A', section: 'Computational Thinking' },
  { q: 'In binary addition, what is the result of adding 1 + 1?', opts: ['A) 2', 'B) 10 (binary for 2)', 'C) 11', 'D) 01'], ans: 'B', section: 'Binary & Number Systems' },
  { q: 'What is the decimal (base-10) equivalent of the 8-bit binary number 00001010?', opts: ['A) 8', 'B) 10', 'C) 12', 'D) 16'], ans: 'B', section: 'Binary & Number Systems' },
  { q: 'In the Von Neumann architecture, which special register holds the memory address of the next instruction to be fetched?', opts: ['A) Accumulator (ACC)', 'B) Program Counter (PC)', 'C) Memory Data Register (MDR)', 'D) Current Instruction Register (CIR)'], ans: 'B', section: 'Computer Architecture' },
  { q: 'What does the CPU clock speed measured in Gigahertz (GHz) indicate?', opts: ['A) The number of fetch-decode-execute cycles the CPU can execute per second', 'B) The amount of storage on the hard drive', 'C) The speed of the internet connection', 'D) The time it takes to boot the computer'], ans: 'A', section: 'Hardware & CPU' },
  { q: 'In Python programming, which data type is best suited to store a student\'s test score with a decimal point (e.g. 87.5)?', opts: ['A) Integer (int)', 'B) Boolean (bool)', 'C) Floating point (float)', 'D) String (str)'], ans: 'C', section: 'Programming Fundamentals' },
  { q: 'What will the following Python code output: print(15 // 4)?', opts: ['A) 3.75', 'B) 3', 'C) 4', 'D) 3 remainder 3'], ans: 'B', section: 'Programming Fundamentals' },
  { q: 'Which computational thinking technique involves breaking a complex problem down into smaller, manageable sub-problems?', opts: ['A) Decomposition', 'B) Abstraction', 'C) Pattern Recognition', 'D) Evaluation'], ans: 'A', section: 'Computational Thinking' },
  { q: 'Which computational thinking technique involves focusing only on the essential details and ignoring unnecessary information?', opts: ['A) Decomposition', 'B) Abstraction', 'C) Automation', 'D) Iteration'], ans: 'B', section: 'Computational Thinking' },
  { q: 'What is the unique numerical address assigned to every device connected to the Internet called?', opts: ['A) MAC Address', 'B) IP Address', 'C) URL Link', 'D) Domain Name'], ans: 'B', section: 'Networking & Internet' },
  { q: 'Which network system translates human-friendly web addresses like www.futurein.org into machine-readable IP addresses?', opts: ['A) DNS (Domain Name System)', 'B) DHCP', 'C) FTP', 'D) SMTP'], ans: 'A', section: 'Networking & Internet' },
  { q: 'In HTML, which tag is correctly used to create a clickable hyperlink to another web page?', opts: ['A) <link>', 'B) <href>', 'C) <a>', 'D) <url>'], ans: 'C', section: 'Web Development' },
  { q: 'In CSS styling, which property is used to change the text color of an HTML element?', opts: ['A) font-color', 'B) color', 'C) text-style', 'D) background-color'], ans: 'B', section: 'Web Development' },
  { q: 'In a relational database table, what is a column that uniquely identifies each individual record called?', opts: ['A) Foreign Key', 'B) Primary Key', 'C) Candidate Index', 'D) Composite Key'], ans: 'B', section: 'Databases' },
  { q: 'Which database command language is the international standard used to query and manipulate relational databases?', opts: ['A) HTML', 'B) SQL (Structured Query Language)', 'C) Python', 'D) XML'], ans: 'B', section: 'Databases' },
  { q: 'What type of malware secretly records keyboard strokes to steal usernames and passwords?', opts: ['A) Ransomware', 'B) Keylogger (Spyware)', 'C) Adware', 'D) Worm'], ans: 'B', section: 'Cybersecurity' },
  { q: 'What security practice requires a user to provide two different forms of identification before gaining account access?', opts: ['A) Single Sign-On (SSO)', 'B) Two-Factor Authentication (2FA)', 'C) Captcha Verification', 'D) Password Recovery'], ans: 'B', section: 'Cybersecurity' },
  { q: 'The trail of data you leave behind whenever you use the internet, browse websites, or post online is known as your ___', opts: ['A) Digital Footprint', 'B) IP Pathway', 'C) Cache Registry', 'D) Cookie Monster'], ans: 'A', section: 'Digital Ethics' },
  { q: 'Which search algorithm inspects each item in a list one by one from the beginning until the target item is found?', opts: ['A) Binary Search', 'B) Linear Search', 'C) Hash Lookup', 'D) Bubble Search'], ans: 'B', section: 'Algorithms' },
  { q: 'What condition MUST be met before a Binary Search algorithm can be performed on a list?', opts: ['A) The list must be sorted in order', 'B) The list must contain only numbers', 'C) The list must have an even number of items', 'D) The list must be stored in the cloud'], ans: 'A', section: 'Algorithms' }
];

const ansMap = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };

db.exec('BEGIN');
try {
  db.prepare('DELETE FROM questions WHERE class_id = ?').run('year-9');
  db.prepare('DELETE FROM comp_questions WHERE class_id = ?').run('year-9');

  const insertQ = db.prepare('INSERT INTO questions (class_id, position, text, options, answer) VALUES (?, ?, ?, ?, ?)');
  const insertCompQ = db.prepare('INSERT INTO comp_questions (class_id, position, text, options, answer) VALUES (?, ?, ?, ?, ?)');

  rawQuizData.forEach((q, i) => {
    const cleanOpts = q.opts.map(o => o.replace(/^[A-D]\)\s*/, '').trim());
    const ansIdx = ansMap[q.ans.toUpperCase()] ?? 0;
    insertQ.run('year-9', i, q.q, JSON.stringify(cleanOpts), ansIdx);
    insertCompQ.run('year-9', i, q.q, JSON.stringify(cleanOpts), ansIdx);
  });

  db.prepare('INSERT OR REPLACE INTO class_settings (class_id, published, updated_at) VALUES (?, 1, ?)').run('year-9', Date.now());
  db.exec('COMMIT');
  console.log(`[SEED] Successfully inserted ${rawQuizData.length} questions into Year 9 in quiz.db`);
} catch (e) {
  try { db.exec('ROLLBACK'); } catch {}
  console.error('[SEED] Year 9 seed error:', e.message);
  process.exit(1);
}
