# FutureIN Quiz

The quiz platform for Future Innovators Network (FutureIN).

**Children** open a link, type their **name**, **school** and **class**, and get only that class's quiz.
If their class has no published quiz, they see a friendly "No quiz for your class yet" notice.
They can take a quiz as many times as they like; nothing on screen mentions it.

**Admins** use a separate page (`/admin`) that is never linked from the children's pages. There they:

- pick a class (Nursery 2, Year 1 … Year 12)
- add questions by uploading a file (`.html`, `.txt`, `.csv`, `.json`), pasting them, or typing them one by one
- check and fix the questions, then **Save** and **Publish** (only published classes are visible to children)
- copy the link for each class to send to children
- see the **scoreboard** per class or for all classes, and download it as CSV

Ranking: highest score first; if two children tie, the faster one wins. If a child takes a quiz more
than once, the scoreboard keeps their best attempt and shows how many attempts they made.
Marking and timing happen on the server, and the correct answers never reach the child's browser.

No external packages. Needs **Node.js 22.13 or newer**. Data is one SQLite file in `data/`.

---

## 1. Set the admin login (once)

```bash
npm run set-admin
```

It asks for a username and a password (at least 10 characters). Your password shows as `*` while you type.
Only a **salted scrypt hash** is saved, in `data/admin.json`. The real password is not stored anywhere,
is never shown on the website, and can't be read back. Run the same command again any time to change it.
Changing it signs everyone out.

Some hosts don't let you keep files or run commands. The command also prints two values,
`ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH`. Run it on your own computer and paste those two values
into the host's **environment variables** instead.

Login protection: wrong username and wrong password give the same message, and after 8 wrong tries
that address is locked out for 15 minutes. Admin sessions last 12 hours and use a secure,
HttpOnly cookie.

## 2. Run it

```bash
npm start
```

- Children: http://localhost:3000 (general link) or http://localhost:3000/quiz/year-6 (class link)
- Admin: http://localhost:3000/admin

To use a less guessable admin address, set `ADMIN_PATH`, e.g. `ADMIN_PATH=fin-staff` serves it at `/fin-staff`.

## 3. Adding questions

**Upload a file or paste text** in this format. Use an Answer line, or a `*` after the correct option:

```
1. Which part of the computer is its "brain"?
A. Monitor
B. CPU
C. Keyboard
D. Mouse
Answer: B

2. What does AI stand for?
A. Automatic Internet
B. Artificial Intelligence *
C. Apple Interface
```

- **Word / Google Docs:** type the questions like this, then save as **Web page (.html)** or
  **Plain text (.txt)** and upload. Word `.docx` files can't be read directly.
- **Excel / Google Sheets:** use the columns `question, A, B, C, D, E, F, answer` and save as CSV.
  `public/question-template.csv` is a ready-made template.
- `public/question-sample.html` is a sample HTML file.

Each question can have 2 to 6 options. After uploading, you see every question before saving.
Anything that needs fixing, like a missing correct answer, is outlined in red.

## 4. Put it online

Recommended address: **quiz.thefuturein.org**. Add a DNS record for it at your domain provider,
pointing to the host. The admin page is then `quiz.thefuturein.org/admin`.

The database must be on **persistent storage**, or results and questions are lost when the app restarts.

- **Render:** Web Service, start command `npm start`, add a **Disk** at `/var/data`
  (a paid instance is needed for a disk). Environment: `DATA_DIR=/var/data`, plus `ADMIN_USERNAME`
  and `ADMIN_PASSWORD_HASH` from step 1.
- **Railway:** deploy, add a Volume at `/data`, set `DATA_DIR=/data` and the two admin values.
- **A VPS** (DigitalOcean, Hetzner, etc.): install Node 22, copy the folder, run `npm run set-admin`,
  then keep it running with `pm2 start npm -- start`. Put it behind HTTPS
  (Caddy or Nginx with Let's Encrypt).

Always serve it over **HTTPS** so the admin login is encrypted in transit.

Back up by copying the `data/` folder, or download the CSV from the scoreboard.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on (most hosts set this for you) |
| `DATA_DIR` | `./data` | Where the database and admin login are kept |
| `ADMIN_PATH` | `admin` | Address of the admin page |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` | (none) | Admin login from `npm run set-admin`, for hosts that use environment variables |

## Branding and fonts

Colours and fonts live in `public/brand.css`. To use FutureIN's own font, put the font files in
`public/fonts/`, add a `@font-face` rule at the top of `brand.css`, and set `--display` and `--body`
to that font. The logo is `public/logo.png`.

## Files

```
server.js                  server: quiz, marking, timing, admin login, class question banks
scripts/set-admin.js       sets the admin username + hashed password
public/index.html          children's quiz page
public/private/admin.html  admin dashboard (served only at /admin, not as a file)
public/brand.css           FutureIN colours, fonts and shared styles
public/api.js              small helper the pages use to talk to the server
public/question-template.csv, public/question-sample.html   example question files
```
