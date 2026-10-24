const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'quiz.db');
const db = new DatabaseSync(dbPath);

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
try {
  const delStmt = db.prepare('DELETE FROM comp_questions WHERE class_id = ?');
  const insStmt = db.prepare('INSERT INTO comp_questions (class_id, position, text, options, answer) VALUES (?, ?, ?, ?, ?)');

  for (const [catId, questions] of Object.entries(competitionBank)) {
    delStmt.run(catId);
    questions.forEach((q, i) => {
      insStmt.run(catId, i, q.text, JSON.stringify(q.options), q.answer);
    });
    console.log(`[COMPETITION] Seeded ${questions.length} questions for category: ${catId}`);
  }

  db.exec('COMMIT');
  console.log('[COMPETITION] Successfully seeded all 4 competition categories!');
} catch (e) {
  try { db.exec('ROLLBACK'); } catch {}
  console.error('[COMPETITION] Error seeding:', e.message);
  process.exit(1);
}
