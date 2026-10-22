const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'quiz.db');
const db = new DatabaseSync(dbPath);

const rawQuizData = [
  {"q": "What is the default file extension for documents created in Microsoft Word 2007 and later?", "opts": ["A) .doc", "B) .docx", "C) .txt", "D) .rtf"], "ans": "B"},
  {"q": "Which keyboard shortcut is used to undo the last action in MS Word?", "opts": ["A) Ctrl + Z", "B) Ctrl + Y", "C) Ctrl + U", "D) Ctrl + X"], "ans": "A"},
  {"q": "The feature used to send the same letter to multiple recipients is called:", "opts": ["A) Macros", "B) Hyperlink", "C) Mail Merge", "D) AutoFormat"], "ans": "C"},
  {"q": "Which alignment justifies the text on both the left and right margins?", "opts": ["A) Left Align", "B) Center", "C) Right Align", "D) Justify"], "ans": "D"},
  {"q": "Where is the zoom slider typically located in the MS Word window?", "opts": ["A) Title bar", "B) Status bar", "C) Ribbon", "D) Quick Access Toolbar"], "ans": "B"},
  {"q": "To move the cursor to the beginning of a document, you press:", "opts": ["A) Home", "B) Ctrl + Home", "C) Page Up", "D) Alt + Home"], "ans": "B"},
  {"q": "The intersection of a row and a column in a Word table is called a:", "opts": ["A) Block", "B) Grid", "C) Cell", "D) Box"], "ans": "C"},
  {"q": "What is the shortcut key to print a document?", "opts": ["A) Ctrl + P", "B) Shift + P", "C) Alt + P", "D) Windows + P"], "ans": "A"},
  {"q": "Which tab in the Ribbon contains the Header and Footer commands?", "opts": ["A) Home", "B) Insert", "C) Page Layout", "D) View"], "ans": "B"},
  {"q": "Which key combination makes the selected text bold?", "opts": ["A) Ctrl + B", "B) Alt + B", "C) Shift + B", "D) Tab + B"], "ans": "A"},
  {"q": "The Thesaurus tool in MS Word is primarily used for:", "opts": ["A) Spelling checks", "B) Grammar corrections", "C) Finding synonyms and antonyms", "D) Language translation"], "ans": "C"},
  {"q": "What is the default font style in Microsoft Word 2013 and later?", "opts": ["A) Arial", "B) Times New Roman", "C) Calibri", "D) Tahoma"], "ans": "C"},
  {"q": "Portrait and Landscape are examples of:", "opts": ["A) Page Orientation", "B) Page Size", "C) Page Margin", "D) Page Setup"], "ans": "A"},
  {"q": "A Drop Cap is used in a document to:", "opts": ["A) Drop all capital letters", "B) Begin a paragraph with a large dropped initial capital letter", "C) Convert text to small caps", "D) Remove capitalization"], "ans": "B"},
  {"q": "The expression x² is an example of:", "opts": ["A) Subscript", "B) Superscript", "C) Strikethrough", "D) Small caps"], "ans": "B"},
  {"q": "What is the default file extension for an Excel spreadsheet?", "opts": ["A) .xls / .xlsx", "B) .doc / .docx", "C) .ppt / .pptx", "D) .exe"], "ans": "A"},
  {"q": "A collection of worksheets in Excel is known as a:", "opts": ["A) Workspace", "B) File", "C) Workbook", "D) Folder"], "ans": "C"},
  {"q": "In a spreadsheet, all formulas must begin with which symbol?", "opts": ["A) +", "B) -", "C) =", "D) *"], "ans": "C"},
  {"q": "What is the correct cell address for the intersection of row 5 and column B?", "opts": ["A) 5B", "B) B5", "C) B-5", "D) 5-B"], "ans": "B"},
  {"q": "Which built-in function is used to calculate the total of a range of values?", "opts": ["A) ADD()", "B) TOTAL()", "C) SUM()", "D) PLUS()"], "ans": "C"},
  {"q": "An absolute cell reference is represented by which symbol?", "opts": ["A) #", "B) $", "C) &", "D) @"], "ans": "B"},
  {"q": "How do you highlight an entire column in a spreadsheet?", "opts": ["A) Click the column heading letter", "B) Press Ctrl + C", "C) Press Ctrl + A", "D) Double-click the cell"], "ans": "A"},
  {"q": "By default, how many worksheets are present in a new Excel 2010 workbook?", "opts": ["A) 1", "B) 2", "C) 3", "D) 4"], "ans": "C"},
  {"q": "Which chart type is best for showing proportions or percentages of a whole?", "opts": ["A) Bar chart", "B) Pie chart", "C) Line chart", "D) Scatter plot"], "ans": "B"},
  {"q": "Which function is used to find the highest number in a range of cells?", "opts": ["A) HIGH()", "B) MAX()", "C) TOP()", "D) UPPER()"], "ans": "B"},
  {"q": "What does a cell displaying '######' indicate?", "opts": ["A) A formula error", "B) The column is not wide enough to display the data", "C) The cell is protected", "D) A spelling mistake"], "ans": "B"},
  {"q": "The active cell in a worksheet is indicated by:", "opts": ["A) A red border", "B) A dotted border", "C) A dark, heavy border", "D) Blinking text"], "ans": "C"},
  {"q": "What does the 'V' in VLOOKUP stand for?", "opts": ["A) Vertical", "B) Visual", "C) Value", "D) Variable"], "ans": "A"},
  {"q": "Which keyboard shortcut is used to select all cells in a worksheet?", "opts": ["A) Ctrl + S", "B) Ctrl + A", "C) Alt + A", "D) Shift + A"], "ans": "B"},
  {"q": "To arrange data in a specific order (alphabetical or numerical) is called:", "opts": ["A) Filtering", "B) Sorting", "C) Validating", "D) Formatting"], "ans": "B"}
];

const ansMap = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };

db.exec('BEGIN');
try {
  db.prepare('DELETE FROM questions WHERE class_id = ?').run('year-11');
  db.prepare('DELETE FROM comp_questions WHERE class_id = ?').run('year-11');

  const insertQ = db.prepare('INSERT INTO questions (class_id, position, text, options, answer) VALUES (?, ?, ?, ?, ?)');
  const insertCompQ = db.prepare('INSERT INTO comp_questions (class_id, position, text, options, answer) VALUES (?, ?, ?, ?, ?)');

  rawQuizData.forEach((q, i) => {
    const cleanOpts = q.opts.map(o => o.replace(/^[A-D]\)\s*/, '').trim());
    const ansIdx = ansMap[q.ans.toUpperCase()] ?? 0;
    insertQ.run('year-11', i, q.q, JSON.stringify(cleanOpts), ansIdx);
    insertCompQ.run('year-11', i, q.q, JSON.stringify(cleanOpts), ansIdx);
  });

  db.prepare('INSERT OR REPLACE INTO class_settings (class_id, published, updated_at) VALUES (?, 1, ?)').run('year-11', Date.now());
  db.exec('COMMIT');
  console.log('Successfully inserted ' + rawQuizData.length + ' questions into Year 11 in quiz.db');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('Error inserting:', e);
  process.exit(1);
}
