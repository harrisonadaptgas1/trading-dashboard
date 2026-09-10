# Watchlist Dashboard

A private daily screening tool for a 30-stock watchlist. It scans once each weekday
morning, scores every stock against rules we defined, and publishes an encrypted
mobile-friendly page.

**It is a screening tool, not advice.** A score says how well a stock matches our
criteria on the day. Nothing here predicts what a price will do.

---

## Running it locally

```bash
npm install
npm run scan                              # fetch + score -> public/data/latest.json
DASHBOARD_PASSWORD=your-password npm run encrypt
npm run serve                             # http://localhost:4173
```

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

### Long-term (10 stocks)

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
