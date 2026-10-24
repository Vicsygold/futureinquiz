const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'quiz.db');
const db = new DatabaseSync(dbPath);

const rawQuizData = [
  { q: 'Which software translator converts source code into machine code line-by-line and executes it immediately?', opts: ['A) Compiler', 'B) Interpreter', 'C) Assembler', 'D) Linker'], ans: 'B', section: 'System Software' },
  { q: 'What is the key advantage of a Compiler over an Interpreter?', opts: ['A) Compiled code produces an executable file that runs faster without needing source code', 'B) Compilers execute code line by line with no memory', 'C) Compilers never report syntax errors', 'D) Compilers are only used for text formatting'], ans: 'A', section: 'System Software' },
  { q: 'Which logic gate outputs TRUE (1) only when BOTH of its inputs are TRUE (1)?', opts: ['A) OR Gate', 'B) AND Gate', 'C) NOT Gate', 'D) XOR Gate'], ans: 'B', section: 'Logic & Boolean Algebra' },
  { q: 'What is the output of an XOR (Exclusive OR) gate when both inputs are 1?', opts: ['A) 0', 'B) 1', 'C) Undefined', 'D) 2'], ans: 'A', section: 'Logic & Boolean Algebra' },
  { q: 'How many unique characters can standard 7-bit ASCII represent?', opts: ['A) 64', 'B) 128', 'C) 256', 'D) 65,536'], ans: 'B', section: 'Data Representation' },
  { q: 'Why was Unicode developed to replace standard ASCII?', opts: ['A) To support symbols and writing systems of all languages worldwide using 16/32 bits', 'B) To make file sizes smaller', 'C) To remove vowels from text', 'D) To encrypt all text messages'], ans: 'A', section: 'Data Representation' },
  { q: 'In digital sound representation, what does the "Sampling Rate" refer to?', opts: ['A) The volume of the sound wave', 'B) The number of audio samples captured per second (measured in Hz)', 'C) The physical length of the audio cable', 'D) The number of speakers playing the sound'], ans: 'B', section: 'Media Representation' },
  { q: 'What is the total number of colors that can be represented with an 8-bit color depth per pixel?', opts: ['A) 16 colors', 'B) 64 colors', 'C) 256 colors', 'D) 16.7 million colors'], ans: 'C', section: 'Media Representation' },
  { q: 'In packet switching networks, what does each data packet contain in its header?', opts: ['A) Source IP, destination IP, packet sequence number, and checksum', 'B) The user\'s credit card number', 'C) The browser history', 'D) The monitor resolution'], ans: 'A', section: 'Networks & Protocols' },
  { q: 'Which protocol is responsible for securely transmitting encrypted web pages between a client and a web server?', opts: ['A) HTTP', 'B) HTTPS (using SSL/TLS)', 'C) FTP', 'D) POP3'], ans: 'B', section: 'Networks & Protocols' },
  { q: 'What type of malicious attack floods a target server with bogus traffic to knock it offline?', opts: ['A) DDoS (Distributed Denial of Service)', 'B) SQL Injection', 'C) Phishing', 'D) Brute Force'], ans: 'A', section: 'Cybersecurity' },
  { q: 'What is the primary purpose of a SQL injection attack?', opts: ['A) To exploit unsanitized user inputs to manipulate and access database records', 'B) To physically damage the hard disk drive', 'C) To speed up database searches', 'D) To change the color scheme of a website'], ans: 'A', section: 'Cybersecurity' },
  { q: 'In SQL, which query clause filters query results to include only records matching a specific condition?', opts: ['A) GROUP BY', 'B) ORDER BY', 'C) WHERE', 'D) SELECT'], ans: 'C', section: 'Databases & SQL' },
  { q: 'What is the worst-case time complexity of the Linear Search algorithm for a list of n elements?', opts: ['A) O(1)', 'B) O(log n)', 'C) O(n)', 'D) O(n²)'], ans: 'C', section: 'Algorithms & Efficiency' },
  { q: 'What is the average time complexity of the Binary Search algorithm for a list of n elements?', opts: ['A) O(1)', 'B) O(log n)', 'C) O(n)', 'D) O(n²)'], ans: 'B', section: 'Algorithms & Efficiency' },
  { q: 'In sorting algorithms, which comparison sort repeatedly steps through the list, swaps adjacent elements that are out of order, until sorted?', opts: ['A) Bubble Sort', 'B) Merge Sort', 'C) Quick Sort', 'D) Binary Sort'], ans: 'A', section: 'Algorithms & Efficiency' },
  { q: 'In Object-Oriented Programming (OOP), what is the blueprint or template from which individual objects are created?', opts: ['A) Class', 'B) Method', 'C) Property', 'D) Variable'], ans: 'A', section: 'Software Development' },
  { q: 'What OOP principle bundles data (attributes) and methods that operate on that data within a single unit and restricts direct outside access?', opts: ['A) Inheritance', 'B) Encapsulation', 'C) Polymorphism', 'D) Recursion'], ans: 'B', section: 'Software Development' },
  { q: 'Which type of secondary storage relies on microscopic magnetic charge patterns on spinning aluminum platters?', opts: ['A) Solid State Drive (SSD)', 'B) Hard Disk Drive (HDD)', 'C) DVD-ROM', 'D) USB Flash Drive'], ans: 'B', section: 'Computer Hardware' },
  { q: 'The environmental issue caused by discarded electronics containing toxic materials like lead and mercury is known as ___', opts: ['A) E-Waste (Electronic Waste)', 'B) Digital Smog', 'C) Cyber Pollution', 'D) Carbon Footprint'], ans: 'A', section: 'Ethics & Environment' }
];

const ansMap = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };

db.exec('BEGIN');
try {
  db.prepare('DELETE FROM questions WHERE class_id = ?').run('year-10');
  db.prepare('DELETE FROM comp_questions WHERE class_id = ?').run('year-10');

  const insertQ = db.prepare('INSERT INTO questions (class_id, position, text, options, answer) VALUES (?, ?, ?, ?, ?)');
  const insertCompQ = db.prepare('INSERT INTO comp_questions (class_id, position, text, options, answer) VALUES (?, ?, ?, ?, ?)');

  rawQuizData.forEach((q, i) => {
    const cleanOpts = q.opts.map(o => o.replace(/^[A-D]\)\s*/, '').trim());
    const ansIdx = ansMap[q.ans.toUpperCase()] ?? 0;
    insertQ.run('year-10', i, q.q, JSON.stringify(cleanOpts), ansIdx);
    insertCompQ.run('year-10', i, q.q, JSON.stringify(cleanOpts), ansIdx);
  });

  db.prepare('INSERT OR REPLACE INTO class_settings (class_id, published, updated_at) VALUES (?, 1, ?)').run('year-10', Date.now());
  db.exec('COMMIT');
  console.log(`[SEED] Successfully inserted ${rawQuizData.length} questions into Year 10 in quiz.db`);
} catch (e) {
  try { db.exec('ROLLBACK'); } catch {}
  console.error('[SEED] Year 10 seed error:', e.message);
  process.exit(1);
}
