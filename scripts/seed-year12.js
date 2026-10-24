const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'quiz.db');
const db = new DatabaseSync(dbPath);

const rawQuizData = [
  { q: 'In the Von Neumann CPU cycle, what happens during the "Decode" stage?', opts: ['A) The Control Unit interprets the opcode and addressing mode in the Current Instruction Register (CIR)', 'B) Data is read from the hard disk', 'C) The ALU computes arithmetic logic', 'D) Results are written back to main memory'], ans: 'A', section: 'Processor Architecture' },
  { q: 'Which CPU register stores the result of the most recent mathematical or logic operation executed by the ALU?', opts: ['A) Accumulator (ACC)', 'B) Memory Address Register (MAR)', 'C) Program Counter (PC)', 'D) Stack Pointer (SP)'], ans: 'A', section: 'Processor Architecture' },
  { q: 'Which data structure operates on a Last-In, First-Out (LIFO) access order?', opts: ['A) Queue', 'B) Stack', 'C) Linked List', 'D) Binary Tree'], ans: 'B', section: 'Data Structures' },
  { q: 'In a Queue data structure (FIFO), from which end are new items inserted?', opts: ['A) Front / Head', 'B) Rear / Tail', 'C) Middle', 'D) Top'], ans: 'B', section: 'Data Structures' },
  { q: 'What is the best-case and worst-case time complexity of Merge Sort on an array of n elements?', opts: ['A) O(n log n) in all cases', 'B) O(n) best case, O(n²) worst case', 'C) O(1) best case, O(n) worst case', 'D) O(n²) in all cases'], ans: 'A', section: 'Advanced Algorithms' },
  { q: 'Which algorithm design paradigm divides a problem into subproblems, solves each recursively, and combines the solutions (e.g. Merge Sort)?', opts: ['A) Greedy Approach', 'B) Divide and Conquer', 'C) Dynamic Programming', 'D) Brute Force'], ans: 'B', section: 'Advanced Algorithms' },
  { q: 'What is the primary purpose of Operating System virtual memory?', opts: ['A) To use secondary storage (pagefile/swap) to extend physical RAM when RAM is exhausted', 'B) To simulate 3D virtual reality headsets', 'C) To speed up CPU clock cycles', 'D) To encrypt network traffic'], ans: 'A', section: 'Operating Systems' },
  { q: 'In OS memory management, what is "Paging"?', opts: ['A) Physical memory is divided into fixed-size frames and logical memory into pages of equal size', 'B) Programs are printed onto paper pages', 'C) Web pages are downloaded simultaneously', 'D) The CPU switches power modes'], ans: 'A', section: 'Operating Systems' },
  { q: 'What is an OS interrupt in computer architecture?', opts: ['A) A signal emitted by hardware or software alerting the CPU to immediately suspend its current task and handle an event', 'B) A physical break in the motherboard wire', 'C) A power outage event', 'D) A corrupted storage sector'], ans: 'A', section: 'Operating Systems' },
  { q: 'In asymmetric public-key cryptography, which key is used to decrypt a message that was encrypted using the recipient\'s public key?', opts: ['A) The recipient\'s private key', 'B) The sender\'s public key', 'C) The sender\'s private key', 'D) A shared symmetric secret key'], ans: 'A', section: 'Cryptography & Security' },
  { q: 'What is the role of a Digital Certificate issued by a Certificate Authority (CA) in HTTPS?', opts: ['A) It authenticates the web server\'s identity and binds its public key to the domain', 'B) It pays for web hosting fees', 'C) It accelerates download speeds', 'D) It replaces the need for a firewall'], ans: 'A', section: 'Cryptography & Security' },
  { q: 'In the Software Development Life Cycle (SDLC), what distinguishes the Agile methodology from the traditional Waterfall model?', opts: ['A) Agile uses iterative sprints with continuous user feedback, while Waterfall follows rigid sequential phases', 'B) Agile requires no testing', 'C) Waterfall is only used for mobile apps', 'D) Agile never writes documentation'], ans: 'A', section: 'Software Engineering' },
  { q: 'In database design, what is the goal of First Normal Form (1NF)?', opts: ['A) Ensuring all column values are atomic (no repeating groups or multi-valued fields) with a primary key', 'B) Removing all foreign keys', 'C) Combining all tables into a single giant table', 'D) Encrypting every table column'], ans: 'A', section: 'Databases & Normalization' },
  { q: 'In relational database theory, what does Third Normal Form (3NF) eliminate?', opts: ['A) Partial dependencies', 'B) Transitive dependencies (non-key attributes depending on other non-key attributes)', 'C) Primary keys', 'D) Indexes'], ans: 'B', section: 'Databases & Normalization' },
  { q: 'In database transactions, what does the "A" in ACID properties stand for?', opts: ['A) Atomicity (all changes in a transaction succeed or all roll back)', 'B) Authentication', 'C) Asynchronous', 'D) Availability'], ans: 'A', section: 'Databases & Transactions' },
  { q: 'In machine learning, what type of learning trains models using labeled input-output pairs?', opts: ['A) Supervised Learning', 'B) Unsupervised Learning', 'C) Reinforcement Learning', 'D) Heuristic Learning'], ans: 'A', section: 'Artificial Intelligence' },
  { q: 'In assembly language, what does an "Opcode" (operation code) specify?', opts: ['A) The specific operation or instruction to be performed by the processor (e.g., ADD, MOV, JMP)', 'B) The name of the programmer', 'C) The memory address location', 'D) The file size in bytes'], ans: 'A', section: 'Low-Level Programming' },
  { q: 'In assembly addressing modes, what is "Immediate Addressing"?', opts: ['A) The operand value itself is directly specified in the instruction rather than an address', 'B) The address points to a register', 'C) The CPU waits 0 cycles', 'D) The instruction is cached in L1'], ans: 'A', section: 'Low-Level Programming' },
  { q: 'In modern cloud computing architecture, what is "Serverless Computing" (e.g. AWS Lambda)?', opts: ['A) An execution model where the cloud provider dynamically manages server allocation and provisioning on demand', 'B) Computing without any physical computers existing', 'C) Computers operating completely without internet', 'D) A local desktop application'], ans: 'A', section: 'Cloud & Emerging Tech' },
  { q: 'What is the fundamental unit of information in quantum computing that can exist in a superposition of states?', opts: ['A) Bit', 'B) Qubit (Quantum Bit)', 'C) Byte', 'D) Flop'], ans: 'B', section: 'Emerging Technologies' }
];

const ansMap = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };

db.exec('BEGIN');
try {
  db.prepare('DELETE FROM questions WHERE class_id = ?').run('year-12');
  db.prepare('DELETE FROM comp_questions WHERE class_id = ?').run('year-12');

  const insertQ = db.prepare('INSERT INTO questions (class_id, position, text, options, answer) VALUES (?, ?, ?, ?, ?)');
  const insertCompQ = db.prepare('INSERT INTO comp_questions (class_id, position, text, options, answer) VALUES (?, ?, ?, ?, ?)');

  rawQuizData.forEach((q, i) => {
    const cleanOpts = q.opts.map(o => o.replace(/^[A-D]\)\s*/, '').trim());
    const ansIdx = ansMap[q.ans.toUpperCase()] ?? 0;
    insertQ.run('year-12', i, q.q, JSON.stringify(cleanOpts), ansIdx);
    insertCompQ.run('year-12', i, q.q, JSON.stringify(cleanOpts), ansIdx);
  });

  db.prepare('INSERT OR REPLACE INTO class_settings (class_id, published, updated_at) VALUES (?, 1, ?)').run('year-12', Date.now());
  db.exec('COMMIT');
  console.log(`[SEED] Successfully inserted ${rawQuizData.length} questions into Year 12 in quiz.db`);
} catch (e) {
  try { db.exec('ROLLBACK'); } catch {}
  console.error('[SEED] Year 12 seed error:', e.message);
  process.exit(1);
}
