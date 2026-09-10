# Watchlist Dashboard

A private daily screening tool for a 30-stock watchlist. It scans once each weekday
morning, scores every stock against rules we defined, and publishes an encrypted
mobile-friendly page.

**It is a screening tool, not advice.** A score says how well a stock matches our
criteria on the day. Nothing here predicts what a price will do.

---

## Everyday use: just double-click `start-dashboard.bat`

That starts the local server and opens the dashboard. Leave the black window open
while you use it. The **Run new scan** button then works directly on this machine —
about 10 seconds, no GitHub and no token involved.

Your password lives on one line at the top of `start-dashboard.bat`; edit it there
and re-run the scan to change it. The file is gitignored so it never leaves your PC.

## Running it from a terminal instead

```bash
npm install
npm run scan                              # fetch + score -> public/data/latest.json
DASHBOARD_PASSWORD=your-password npm run encrypt
DASHBOARD_PASSWORD=your-password npm run serve   # http://localhost:4173
```

The password is needed by `serve` too, because the local **Run new scan** endpoint
re-encrypts the results after each scan.

Useful during development:

```bash
node src/scan.js --tickers=AAPL,TSLA      # just these two
node src/scan.js --limit=3                # first 3 of each category
```

`npm run build` does the scan and the encrypt in one step.

---

## How scoring works

Every component scores 0–10, they are combined by weight, then modifiers apply.
All weights live in `config/scoring.config.json` — edit and re-run, no code changes.

### Swing-term (20 stocks)

The idea: reward **pullbacks inside an uptrend** and **oversold stocks that have
started turning**. Penalise chasing what has already run, and catching falling knives.

| Signal | Weight | Best case | Worst case |
|---|---|---|---|
| Momentum gauge (RSI) | 25% | 35–50 **and rising** | Above 70, stretched |
| Trend / moving averages | 20% | Fresh bullish crossover, or a dip inside an uptrend | Below both averages |
| Volume | 20% | Over 2x average **on an up day** | Over 1.5x average **on a down day** |
| Recent moves | 20% | Month up, week slightly down — the dip | Week up over 10%, or both falling |
| News | 15% | Clear positive catalyst | Downgrade, miss, investigation |

Two deliberate choices: **volume direction matters more than volume size** (a heavy
down-day is distribution, not opportunity), and **news is capped at 15%** because free
sentiment is the least reliable input — it should tilt a score, never drive it.

Modifiers, applied after the weighted total:

- Earnings within 5 days → x0.85 and a flag. Results are unpredictable.
- Average daily swing above 6% → x0.9 and a flag. Volatility is risk, not opportunity.
- Average daily swing below 2% → x0.95. Too quiet for a short-term trade.
- Fewer than 60 days of history → score capped at 5.

The 6% threshold was set by measuring the actual watchlist: the median swing-term stock
moves about 5% a day, so 6% picks out the genuinely jumpy names rather than flagging
everything.

### Entry levels (swing stocks only)

Each swing card shows chart-derived levels. These are arithmetic on past prices, not
forecasts, and the dashboard says so on every card.

- **Zone our rules flag** — anchored on the 20-day average, which is where a pullback
  in an uptrend tends to find support. Floored at the recent 10-day low and widened by
  ATR, so a jumpy stock gets a wider band than a calm one.
- **Setup breaks below** — the level under which the setup has stopped being the thing
  we described. One ATR below the zone, or under the recent low, whichever is lower.
- **Recent 20-day high** — a factual reference point, not a target.
- **Zone top to break level** — how far apart those two are, as a percentage.

A stock either shows *"price is in the zone now"* or *"would need to fall X% to reach it"*.

**Stocks in a downtrend get no entry level at all.** Our rules only describe pullbacks
inside an uptrend, so inventing a level for a falling stock would be dressing up a
number we have no basis for. On the current watchlist that is 7 of the 20.

### Risk level (every stock)

Low / Medium / High / Very high, built only from measurable things — never a
probability of any outcome:

| Factor | Points |
|---|---|
| Daily movement (ATR%) | up to 3 |
| Priced above sector peers | up to 2 |
| Earnings within 7 days | 3 (within 21 days: 1) |
| Stop more than 10% / 15% below today's price | 1 / 2 |
| Trading below half its usual volume | 1 |
| Under 120 days of price history | 2 |
| Scores under 4 | 1 |

0–1 Low · 2–3 Medium · 4–5 High · 6+ Very high. Each card lists the factors that
applied, so a level is always explainable.

### The "matches every criterion" shortlist

Sits at the top of the Swing tab. A stock appears only if it meets all six:

1. Scores 5.5 or better
2. Price is inside the entry zone right now
3. Reward is at least 1.5x the risk
4. Medium-term trend is up
5. No earnings inside the next 5 days
6. Risk level is Low or Medium

Every card also shows its own "meets N of 6" with ticks and crosses.

The checklist counts criteria actually met, which is a fact that can be checked. When
nothing matches all six, the shortlist says so and names the closest.

### Historical hit rate (the backtest)

`src/backtest.js` walks back through two years of daily bars, finds every day the entry
rules would have fired, and records whether price reached the exit target or the stop
loss first. Rules chosen so the result cannot flatter itself:

- Only data up to the signal bar is used — no lookahead.
- Entry is the close of the signal bar.
- If one bar touches both stop and target, it counts as a **loss**.
- Overlapping signals are skipped until the open trade resolves.
- Still open after 30 trading days = "unresolved", excluded rather than counted as a win.

Each swing card then shows how many times the setup fired, the win/loss split, and the
**average outcome per setup**: `hitRate × todaysGain − (1 − hitRate) × todaysLoss`.

That last figure is the useful one. Hit rates across the watchlist run 23–65%, mostly
near a coin flip, so being right often is not where the edge is. A 39% hit rate with a
2:1 payoff beats a 63% hit rate with a 1:1 payoff.

**This is not a probability of future profit.** It is a record of what happened on past
setups on that stock, under these rules, in one particular two-year market. It carries no
guarantee about the next one, and the dashboard says so on every card.

### Analyst targets (long-term cards only)

From Yahoo's `financialData`: average target, the low–high range, how many analysts
cover it, and the consensus rating. Not shown on swing cards — a 12-month view says
nothing about a setup measured in days.

**Price targets are always a 12-month convention.** Analysts do not publish varied
horizons, so the dashboard does not invent one. Instead each card checks the implied
upside against the stock's own history: over 3, 6 and 12-month windows across two
years, how often did it actually move that far? The card names the shortest horizon
where it did so more than half the time, or says plainly that even 12 months has not
typically got there.

The **spread** is shown as prominently as the average, and flagged when the highest
target is 40%+ above the lowest. A wide spread means the "target" is the midpoint of
serious disagreement, not a consensus. On the current watchlist those spreads run from
41% (V) to 231% (AVGO).

### Long-term (11 stocks)

| Signal | Weight | Notes |
|---|---|---|
| Trend | 40% | Price vs the 200-day average, and whether that average is itself rising |
| Profit growth | 25% | Year-on-year earnings growth |
| Sales growth | 20% | Year-on-year revenue growth |
| Valuation | 15% | P/E vs sector peers, plus a bonus if forward P/E is well below trailing |

**Known limitation:** Yahoo does not publish a true sector median P/E on the free tier.
Valuation compares each stock against *other watchlist stocks in the same sector* — a
small sample. The dashboard labels it as such rather than dressing it up as a real
sector benchmark.

Any fundamental that is unavailable is scored neutral (5/10) and flagged on the card,
never treated as a failure.

---

## Portfolio (Trading 212)

Optional third tab showing your real holdings, cross-referenced against the watchlist:
each position carries its watchlist score, and watchlist cards show a "You hold N" badge
so a score is read knowing you already own it. Figures come straight from Trading 212;
there is deliberately no value chart, because their API exposes only a snapshot of
positions and any curve drawn from it would imply gains you did not make.

**Laptop only, deliberately.** Holdings never go near the public GitHub repo. The key
is read server-side in `src/scan.js` and never reaches the browser.

### Setting it up

1. In the Trading 212 app: **☰ → Settings → API (Beta) → Generate API key**
2. Grant **portfolio** and **account** scopes only. **Never grant `orders`** — that scope
   can place real trades.
3. Restrict it to your own IP address. Worth doing, and possible precisely because this
   only ever runs from your laptop.
4. Open the dashboard, go to the **Portfolio** tab, paste the key and press **Connect**.

The key is verified against Trading 212 before it is saved, so a typo fails immediately
rather than silently later. It is stored in `secrets.local.json` (gitignored, never sent
to the browser, never written into the scan output), and **Disconnect** deletes it.

`/api/settings` refuses any request that does not come from this machine.

Setting `T212_API_KEY` in `start-dashboard.bat` still works and takes priority; the
dashboard then shows the key as env-managed and won't let you edit it from the browser.

Only available on General Invest and Stocks & Shares ISA accounts, not SIPPs.

### Checking the connection

```bash
node scripts/t212-check.js
```

Prints field names, types and counts — never balances, quantities or prices — so the
output is safe to paste to someone for debugging.

### Notes

- Share prices show in each stock's own currency; profit and loss is in your account
  currency. No FX conversion is invented.
- Holdings inside a Pie are flagged as such.
- The API is beta and rate-limited per account. One scan a day is nowhere near the limit.
- No key, a wrong key, or Trading 212 being down all mean "no portfolio", never a failed
  scan. The rest of the dashboard carries on.

## Data sources

| What | Source | Cost | Limits |
|---|---|---|---|
| Prices, history | Yahoo Finance via `yahoo-finance2` | Free | No key. Informal throttling only |
| Fundamentals | Yahoo Finance `quoteSummary` | Free | Some fields missing for some tickers |
| News | Yahoo Finance search | Free | No key |
| News fallback | Google News RSS | Free | No key |
| Sentiment | VADER + a finance lexicon | Free | Runs locally |

**Nothing here is paid, and nothing needs an API key.**

NewsAPI.org was considered and rejected: its free tier is restricted to localhost
(so it cannot run from a deployed site) and delays articles by up to 24 hours.

### On sentiment accuracy

VADER alone is close to useless on financial headlines — it scores *"analyst upgrades,
doubles revenue forecast"* as exactly neutral. So `src/sentiment.js` adds a finance
lexicon (upgrade, beat, guidance cut, probe, recall…) that carries 75% of the weight.

It is still imperfect. Generic price words like "falls" are deliberately weighted low
because they often describe the wider market rather than the company, but a headline
such as *"AMD ascends while market falls"* can still read as mildly negative. **Treat
sentiment as a hint, and read the headline.**

Both feeds return index roundups that merely list a ticker ("Nasdaq futures edge higher:
NVDA, AAPL, TSLA…"). Those are filtered out: a headline must actually name the company,
and any title listing four or more tickers is dropped.

---

## Scheduling

`.github/workflows/daily-scan.yml` runs at **05:00 UTC, Monday to Friday** — 06:00 UK in
summer, 05:00 in winter. Every stock is US-listed, so this uses the previous US close and
is ready before the working day.

GitHub can start scheduled runs 5–20 minutes late at busy times. Scheduled workflows are
also auto-disabled after 60 days of repository inactivity, which the daily commit prevents.

You can also trigger it by hand from the **Actions** tab.

### The "Run new scan" button

The dashboard is a static page: it cannot run the scanner itself, and the browser
cannot call Yahoo directly because Yahoo sends no CORS headers. So the button asks
GitHub to run the same workflow the schedule uses, then polls the published file until
a newer scan appears. It takes 1–3 minutes, most of it Pages redeploying.

The first press asks for a **fine-grained personal access token**, scoped to this one
repository with **Actions: Read and write** and nothing else. It is kept in that
browser's `localStorage`, never in the repository and never in the encrypted file, so
it stays on the one device you set it up on.

The **Refresh** button in the header is different and needs no token: it just re-reads
whatever is currently published, which is enough after a scheduled run.

> **Free-tier prices are end-of-day.** Outside US market hours (14:30–21:00 UK) a new
> scan brings fresh news and re-scored signals, but identical prices — there is no newer
> close to fetch. The dashboard says "prices unchanged" rather than implying otherwise.
> A scan also refreshes the long-term stocks; it is one job, and it only takes ~30s.

---

## Hosting and access

GitHub Actions runs the scan; GitHub Pages serves the page. Both free.

**GitHub Pages is always public, even from a private repository.** A password box in
front of a public JSON file would be decoration. So the data file itself is encrypted:

- `src/encrypt.js` encrypts `latest.json` with AES-256-GCM
- The key comes from your password via PBKDF2, 250,000 iterations of SHA-256
- Only the ciphertext is committed; the plaintext is in `.gitignore`
- Your browser decrypts it after you type the password, using the Web Crypto API
- A wrong password fails the GCM authentication tag — that is the login check

The password never leaves your device and is never stored in the repository. It sits in
`sessionStorage` so a refresh does not re-prompt, and "Lock" clears it.

This protects the data, not the page shell — anyone can view the empty HTML. That is the
right trade-off here: the HTML is worthless, the scan results are the private part.

### One-time setup

1. Create a **private** GitHub repository and push this project.
2. **Settings → Secrets and variables → Actions → New repository secret**
   Name `DASHBOARD_PASSWORD`, value your chosen password (10+ characters).
3. **Settings → Pages → Source: GitHub Actions**.
4. **Actions** tab → *Daily scan* → **Run workflow** to publish immediately.
5. Open the Pages URL on your phone and add it to your home screen.

Changing the password later means updating the secret and re-running the workflow.

---

## Project layout

```
config/
  watchlist.json          the 30 stocks, split long_term / swing_term
  scoring.config.json     all weights and thresholds
src/
  scan.js                 orchestrator: fetch -> score -> write JSON
  yahoo.js                price history + fundamentals
  news.js                 headline fetching, dedupe, relevance filtering
  sentiment.js            VADER + finance lexicon
  indicators.js           RSI, moving averages, ATR, volume ratio
  scoreLongTerm.js        long-term scoring
  scoreSwing.js           swing scoring
  encrypt.js              AES-GCM encryption of the output
public/                   the dashboard (static, deployed to Pages)
scripts/serve.js          local preview server
```

## Tuning

Edit `config/scoring.config.json` and re-run. The scan refuses to start if the swing
weights do not total 100. Because every day's encrypted output is committed, the git
history doubles as a record of past scans.
