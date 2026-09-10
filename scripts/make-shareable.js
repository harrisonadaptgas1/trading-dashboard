// Build a clean copy of the project that is safe to send to someone else.
//
// Everything personal is left behind: API credentials, the dashboard password,
// scan output containing holdings, and the git history. What ships is source,
// config and a plain-English setup guide.
//
//   node scripts/make-shareable.js
import { cp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '..', 'Trading Bot - to share');

// Anything that is personal, huge, or machine-specific.
const EXCLUDE = new Set([
  'node_modules', '.git', 'cache',
  'secrets.local.json',        // Trading 212 API key and secret
  'start-dashboard.bat',       // contains the dashboard password
  'Trading Bot - to share',
]);
const EXCLUDE_PATHS = [
  'public/data',               // scan output: holdings, values, P&L
];

const SETUP_BAT = `@echo off
REM ============================================================
REM  FIRST TIME SETUP - double-click this once.
REM  You need Node.js installed first: https://nodejs.org
REM ============================================================
cd /d "%~dp0"
echo.
echo  Installing... this takes a minute the first time.
echo.
call npm install
if errorlevel 1 (
  echo.
  echo  Install failed. Is Node.js installed? Get it from https://nodejs.org
  pause
  exit /b 1
)
echo.
echo  Done. From now on, use start-dashboard.bat
echo.
pause
`;

const START_BAT = `@echo off
REM ============================================================
REM  Watchlist dashboard - double-click to start.
REM
REM  CHANGE THE PASSWORD BELOW to anything you like, then save.
REM  You will type it into the dashboard to unlock it.
REM ============================================================

set DASHBOARD_PASSWORD=change-me-to-something-else

REM  Optional: your own Trading 212 READ-ONLY API key, for the
REM  Portfolio tab. Leave blank to turn the portfolio off.
set T212_API_KEY=
set T212_API_SECRET=

cd /d "%~dp0"
echo.
echo  Starting the dashboard...
echo  Opening http://localhost:4173 in your browser.
echo.
echo  Leave this black window open while you use it.
echo.
timeout /t 2 /nobreak >nul
start "" http://localhost:4173
node scripts/serve.js
echo.
echo  Server stopped. Press any key to close.
pause >nul
`;

const READ_ME_FIRST = `# Watchlist Dashboard - start here

A stock screening dashboard. It scans a list of shares once a day, scores each
one against a fixed set of rules, and shows you the results on a page you open
in your browser.

**It is a research tool, not advice.** A score says how well a share matches the
rules built into it. It does not predict anything, and the rules have not been
proven to make money - see "Be realistic" at the bottom.

---

## Setting it up (about 5 minutes, once)

1. **Install Node.js** if you do not have it: https://nodejs.org - take the
   "LTS" version and click through the installer.
2. **Double-click \`SETUP.bat\`** in this folder. It installs what the app needs.
   Takes a minute.
3. **Open \`start-dashboard.bat\`** in Notepad (right-click, Edit) and change this line
   to any password you like, then save:
   \`\`\`
   set DASHBOARD_PASSWORD=change-me-to-something-else
   \`\`\`
4. **Double-click \`start-dashboard.bat\`.** A black window opens and your browser
   goes to the dashboard. Type your password.

Leave the black window open while you use it. Close it when you are done.

## Using it

- **Run new scan** fetches fresh prices and news for every share on the list.
  Takes about 10 seconds.
- **Long-Term** and **Swing-Term** tabs score shares on different rules.
- **Portfolio** is optional - see below.

Prices come from Yahoo Finance and are end-of-day. Outside US market hours
(2:30pm-9pm UK) a scan refreshes news but prices will not move, because the
market is shut.

## Changing the list of shares

Edit \`config/watchlist.json\`. Add or remove entries in either list:

\`\`\`json
{ "ticker": "AAPL", "name": "Apple" }
\`\`\`

Then run a scan.

## Connecting Trading 212 (optional)

Only if you have an account and want to see your holdings.

1. In the Trading 212 app: **menu -> Settings -> API (Beta) -> Generate API key**
2. Tick **portfolio** and **account** permissions only.
   **Never tick "orders"** - that permission can place real trades.
3. Copy both the API Key and the API Secret.
4. In the dashboard, go to the **Portfolio** tab, paste both, press Connect.

The key is stored on your own PC only and is never sent anywhere except
Trading 212.

## Be realistic about it

The swing-trading rules in here were written by hand and tested on two years of
past data. That test has real weaknesses: the shares were chosen with hindsight,
and the rules were tuned on the same data they were measured against.

A fair estimate is roughly a **1-in-3 chance** the rules are profitable after
costs, and lower than that of beating a simple index fund. Every card shows what
the rules actually did in the past rather than what they promise.

Use it to decide what to look at. Do not use it as a reason to buy something.
`;

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  await cp(ROOT, OUT, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(ROOT.length + 1).replace(/\\/g, '/');
      if (!rel) return true;
      const first = rel.split('/')[0];
      if (EXCLUDE.has(first)) return false;
      if (EXCLUDE_PATHS.some((p) => rel === p || rel.startsWith(`${p}/`))) return false;
      // Backups of the watchlist are personal history, not needed by anyone else.
      if (/^config\/watchlist\.backup/.test(rel)) return false;
      return true;
    },
  });

  await writeFile(join(OUT, 'SETUP.bat'), SETUP_BAT.replace(/\n/g, '\r\n'));
  await writeFile(join(OUT, 'start-dashboard.bat'), START_BAT.replace(/\n/g, '\r\n'));
  await writeFile(join(OUT, 'READ ME FIRST.md'), READ_ME_FIRST);

  // Prove nothing personal came along for the ride.
  const leaked = [];
  for (const f of ['secrets.local.json', 'public/data/latest.json', 'public/data/latest.enc.json']) {
    try { await readFile(join(OUT, f)); leaked.push(f); } catch { /* absent, good */ }
  }

  console.log(`\nClean copy written to:\n  ${OUT}\n`);
  console.log(leaked.length
    ? `WARNING - these personal files were copied: ${leaked.join(', ')}`
    : 'Verified: no credentials, no password, no portfolio data.');
  console.log('\nZip that folder and send it. Roughly 600KB.\n');
}

main().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
