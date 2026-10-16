// Sets (or changes) the admin username and password.
// The password is typed hidden and saved ONLY as a salted scrypt hash in data/admin.json.
//
//   npm run set-admin
//
// For hosts where you set environment variables instead of keeping files, it also prints
// ADMIN_USERNAME and ADMIN_PASSWORD_HASH values you can paste into the host's settings.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const N = 16384;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
let muted = false;
const write = rl._writeToOutput.bind(rl);
rl._writeToOutput = (s) => { if (!muted) write(s); else if (s !== '\r\n' && s !== '\n') write('*'); };

function ask(question, hidden) {
  return new Promise((resolve) => {
    muted = false;
    rl.question(question, (answer) => { muted = false; if (hidden) process.stdout.write('\n'); resolve(answer); });
    muted = !!hidden;
  });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

(async () => {
  console.log('\nFutureIN Quiz — set the admin login\n');
  const username = (await ask('Admin username: ')).trim();
  if (username.length < 3) { rl.close(); console.error('Username must be at least 3 characters.'); process.exit(1); }
  const p1 = await ask('Password (min 10 characters): ', true);
  if (p1.length < 10) { rl.close(); console.error('Password must be at least 10 characters.'); process.exit(1); }
  const p2 = await ask('Type the password again: ', true);
  if (p1 !== p2) { rl.close(); console.error('The passwords do not match. Nothing was changed.'); process.exit(1); }

  rl.close();
  const passwordHash = hashPassword(p1);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ADMIN_FILE, JSON.stringify({ username, passwordHash }, null, 2), { mode: 0o600 });
  console.log(`\nSaved. Only a hash of the password is stored (${ADMIN_FILE}).`);
  console.log('Anyone signed in with the old password is signed out automatically.\n');
  console.log('If your host uses environment variables instead, set these two:');
  console.log(`  ADMIN_USERNAME=${username}`);
  console.log(`  ADMIN_PASSWORD_HASH=${passwordHash}\n`);
})();
