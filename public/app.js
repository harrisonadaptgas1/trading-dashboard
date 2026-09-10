'use strict';

// Data arrives encrypted; the password never leaves the browser and is only held
// in sessionStorage so a phone refresh does not ask again within the same session.
const DATA_URL = 'data/latest.enc.json';
const SESSION_KEY = 'watchlist-pw';
const GH_KEY = 'watchlist-gh';

const $ = (id) => document.getElementById(id);
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtWhen = (d) => new Date(d).toLocaleString('en-GB',
  { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

let current = null; // last decrypted payload, so Refresh can compare

async function decrypt(payload, password) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: fromB64(payload.salt), iterations: payload.kdf.iterations, hash: payload.kdf.hash },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  // A wrong password fails the GCM auth tag and throws, which is our auth check.
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(payload.iv) }, key, fromB64(payload.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

const fetchPayload = () => fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' })
  .then((r) => { if (!r.ok) throw new Error(`Could not load data (HTTP ${r.status})`); return r.json(); });

/* ---------- rendering ---------- */

function sparkline(values) {
  if (!values || values.length < 2) return '';
  const w = 300, h = 40, pad = 2;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const colour = values[values.length - 1] >= values[0] ? 'var(--good)' : 'var(--bad)';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${pts.join(' ')}" fill="none" stroke="${colour}" stroke-width="1.8"
      stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

/**
 * Entry levels. Deliberately framed as levels the rules flag, with the arithmetic
 * shown, rather than as a recommendation to buy at a price.
 */
function entryHtml(e) {
  if (!e) return '';
  if (e.status === 'none') {
    return `<div class="entry none">
      <div class="entry-head">Entry levels</div>
      <p class="entry-note">${esc(e.note)}</p>
    </div>`;
  }
  const state = e.status === 'in-zone'
    ? '<span class="pill in">Price is in the zone now</span>'
    : `<span class="pill wait">Would need to fall ${e.fallToZonePct}% to reach it</span>`;

  return `<div class="entry">
    <div class="entry-head">Entry levels ${state}</div>
    <div class="entry-grid">
      <div><span>Zone our rules flag</span><strong>$${e.low} &ndash; $${e.high}</strong></div>
      <div><span>Setup breaks below</span><strong class="bad-t">$${e.breaksBelow}</strong></div>
      <div><span>Recent 20-day high</span><strong>$${e.recentHigh}</strong></div>
      <div><span>Zone top to break level</span><strong>${e.riskPct}%</strong></div>
    </div>
    <p class="entry-note">${esc(e.note)} These are calculated from past prices, not a forecast.</p>
  </div>`;
}

function headlineHtml(h) {
  const when = h.published
    ? new Date(h.published).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';
  const tag = h.catalyst ? `<span class="tag">${esc(h.catalyst)}</span>` : '';
  return `<a class="headline" href="${esc(h.link)}" target="_blank" rel="noopener noreferrer">
    <span class="h-meta"><span class="dot ${esc(h.label)}"></span>${tag}</span>
    <span class="h-title">${esc(h.title)}</span>
    <span class="tag" style="margin-left:5px">${esc(h.publisher)}${when ? ' &middot; ' + esc(when) : ''}</span>
  </a>`;
}

// Plain-English names for the scoring components, rather than the raw keys.
const LABELS = {
  rsi: 'Momentum gauge', trend: 'Trend', volume: 'Volume', momentum: 'Recent moves',
  news: 'News', earningsGrowth: 'Profit growth', revenueGrowth: 'Sales growth', valuation: 'Valuation',
};

function breakdownHtml(breakdown) {
  const rows = Object.entries(breakdown).map(([key, v]) => `<div class="bar-row">
      <div class="bar-top"><span>${esc(LABELS[key] ?? key)} &middot; ${v.weight}% of score</span><span>${v.score}/10</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${v.score * 10}%"></div></div>
      <div class="bar-note">${esc(v.note)}</div>
    </div>`).join('');
  return `<details><summary>Why this score</summary><div class="bars">${rows}</div></details>`;
}

function cardHtml(s) {
  const tier = s.score >= 7 ? 'high' : s.score >= 5 ? 'mid' : 'low';
  const dir = s.changePct >= 0 ? 'up' : 'down';
  const sign = s.changePct >= 0 ? '+' : '';
  const warnings = s.warnings.length
    ? `<div class="warn">${s.warnings.map((w) => `<div>${esc(w)}</div>`).join('')}</div>` : '';
  const news = s.headlines.length
    ? s.headlines.map(headlineHtml).join('')
    : '<p class="no-news">No company-specific headlines in the last 48 hours.</p>';

  return `<article class="card">
    <div class="row">
      <div class="badge ${tier}">${s.score}</div>
      <div class="ident">
        <div class="ticker">${esc(s.ticker)}</div>
        <div class="company">${esc(s.name)}</div>
      </div>
      <div class="px">
        <div class="px-val">$${s.price.toFixed(2)}</div>
        <div class="px-chg ${dir}">${sign}${s.changePct.toFixed(2)}%</div>
      </div>
    </div>
    ${sparkline(s.sparkline)}
    <p class="reason">${esc(s.reason)}</p>
    ${warnings}
    ${entryHtml(s.entry)}
    ${breakdownHtml(s.breakdown)}
    <div class="news">${news}</div>
  </article>`;
}

function render(data) {
  current = data;
  $('long-cards').innerHTML = data.longTerm.map(cardHtml).join('') || '<p class="no-news">No long-term results.</p>';
  $('swing-cards').innerHTML = data.swingTerm.map(cardHtml).join('') || '<p class="no-news">No swing-term results.</p>';

  $('stamp').textContent = `Scanned ${fmtWhen(data.generatedAt)}` +
    (data.dataAsOf ? ` · prices to ${data.dataAsOf}` : '');

  const box = $('errors');
  if (data.errors?.length) {
    box.hidden = false;
    box.textContent = `Could not fetch: ${data.errors.map((e) => e.ticker).join(', ')}. They are missing from today's list.`;
  } else {
    box.hidden = true;
  }

  $('gate').hidden = true;
  $('app').hidden = false;
}

/* ---------- gate ---------- */

async function unlock(password, { silent = false } = {}) {
  const btn = $('unlock');
  const err = $('gate-error');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Decrypting…';
  try {
    render(await decrypt(await fetchPayload(), password));
    sessionStorage.setItem(SESSION_KEY, password);
  } catch (e) {
    sessionStorage.removeItem(SESSION_KEY);
    if (!silent) {
      err.textContent = e.message.startsWith('Could not load') ? e.message : 'Wrong password.';
      err.hidden = false;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unlock';
  }
}

/* ---------- refresh: re-read whatever is published now ---------- */

async function refresh() {
  const password = sessionStorage.getItem(SESSION_KEY);
  if (!password) return;
  const btn = $('refresh');
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const payload = await fetchPayload();
    if (current && payload.generatedAt === current.generatedAt) {
      btn.textContent = 'No change';
    } else {
      render(await decrypt(payload, password));
      btn.textContent = 'Updated';
    }
  } catch {
    btn.textContent = 'Failed';
  } finally {
    setTimeout(() => { btn.textContent = 'Refresh'; btn.disabled = false; }, 2000);
  }
}

/* ---------- run a new scan via GitHub Actions ----------
 * The dashboard is a static page, so it cannot run the scanner itself and the
 * browser cannot call Yahoo directly (no CORS). Instead this asks GitHub to run
 * the same workflow the daily schedule uses, then waits for the new file.
 * The token lives in this browser's localStorage only, never in the repository.
 */

const ghConfig = () => { try { return JSON.parse(localStorage.getItem(GH_KEY)) || null; } catch { return null; } };

/** Guess owner/repo from a github.io URL so the setup form is mostly pre-filled. */
function guessRepo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  if (!m) return { owner: '', repo: '' };
  const seg = location.pathname.split('/').filter(Boolean)[0];
  return { owner: m[1], repo: seg || `${m[1]}.github.io` };
}

const status = (msg, kind = '') => {
  const el = $('scan-status');
  el.textContent = msg;
  el.className = `scan-status ${kind}`;
};

function showSetup(message = '') {
  // Clear any previous error, otherwise a stale "token rejected" sits above an
  // empty form and looks like a fresh failure.
  status(message);
  const cfg = ghConfig() ?? guessRepo();
  $('gh-owner').value = cfg.owner ?? '';
  $('gh-repo').value = cfg.repo ?? '';
  $('gh-token').value = '';
  $('gh-setup').hidden = false;
  $('gh-owner').focus();
}

async function triggerWorkflow(cfg) {
  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/actions/workflows/daily-scan.yml/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ ref: cfg.ref || 'main' }),
  });
  if (res.status === 204) return;
  if (res.status === 401) throw new Error('Token rejected. It may have expired.');
  if (res.status === 403) throw new Error('Token lacks permission. It needs Actions: Read and write.');
  if (res.status === 404) throw new Error('Repository or workflow not found. Check the username and repo name.');
  if (res.status === 422) throw new Error('Branch not found. Your default branch may not be "main".');
  throw new Error(`GitHub returned ${res.status}.`);
}

/** Poll the published file until generatedAt moves past what we already have. */
async function waitForNewData(previousGeneratedAt, password) {
  const deadline = Date.now() + 5 * 60 * 1000;
  const started = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 6000));
    const secs = Math.round((Date.now() - started) / 1000);
    status(`Scanning on GitHub… ${secs}s. This usually takes 1–3 minutes.`);
    try {
      const payload = await fetchPayload();
      if (payload.generatedAt !== previousGeneratedAt) {
        return await decrypt(payload, password);
      }
    } catch { /* Pages can 404 briefly mid-deploy; keep waiting. */ }
  }
  throw new Error('Timed out waiting for the new scan. Check the Actions tab on GitHub.');
}

async function runScan() {
  const password = sessionStorage.getItem(SESSION_KEY);
  if (!password) return;

  const cfg = ghConfig();
  if (!cfg?.token) { showSetup(); return; }

  const btn = $('scan-btn');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  const previous = current?.generatedAt;
  const previousAsOf = current?.dataAsOf;

  try {
    status('Asking GitHub to start the scan…');
    await triggerWorkflow(cfg);
    const data = await waitForNewData(previous, password);
    render(data);

    // Yahoo is end-of-day on the free tier, so outside US market hours a rescan
    // brings fresh news but identical prices. Say so rather than implying new prices.
    status(data.dataAsOf === previousAsOf
      ? `Updated. News refreshed; prices unchanged (still the ${data.dataAsOf} close).`
      : `Updated. Prices now to ${data.dataAsOf}.`, 'ok');
  } catch (e) {
    if (/Token|permission|expired|not found/i.test(e.message)) showSetup(e.message);
    else status(e.message, 'err');
    if ($('gh-setup').hidden === false) $('scan-status').className = 'scan-status err';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run new scan';
  }
}

/* ---------- wiring ---------- */

$('gate-form').addEventListener('submit', (e) => { e.preventDefault(); unlock($('password').value); });
$('refresh').addEventListener('click', refresh);
$('scan-btn').addEventListener('click', runScan);
$('gh-cancel').addEventListener('click', () => { $('gh-setup').hidden = true; status(''); });

$('gh-setup').addEventListener('submit', (e) => {
  e.preventDefault();
  const cfg = {
    owner: $('gh-owner').value.trim(),
    repo: $('gh-repo').value.trim(),
    token: $('gh-token').value.trim(),
    ref: 'main',
  };
  if (!cfg.owner || !cfg.repo || !cfg.token) { status('Fill in all three fields.', 'err'); return; }
  localStorage.setItem(GH_KEY, JSON.stringify(cfg));
  $('gh-setup').hidden = true;
  runScan();
});

$('lock').addEventListener('click', () => {
  sessionStorage.removeItem(SESSION_KEY);
  location.reload();
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('long').hidden = tab.dataset.target !== 'long';
    $('swing').hidden = tab.dataset.target !== 'swing';
  });
});

// Show when the data was generated before the user commits to typing a password.
fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : null))
  .then((p) => {
    if (p?.generatedAt) {
      $('gate-sub').textContent = `Scan from ${fmtWhen(p.generatedAt)}. Enter your password to decrypt.`;
    }
  })
  .catch(() => {});

const saved = sessionStorage.getItem(SESSION_KEY);
if (saved) unlock(saved, { silent: true });
