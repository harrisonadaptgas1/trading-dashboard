// Free news: Yahoo Finance (via yahoo-finance2 search) + Google News RSS fallback.
// No API keys, no rate limits to manage at 30 tickers/day.
import { XMLParser } from 'fast-xml-parser';
import { scoreHeadline, cleanTitle, aggregateSentiment } from './sentiment.js';

const parser = new XMLParser({ ignoreAttributes: false });
const UA = 'Mozilla/5.0 (compatible; personal-watchlist/1.0)';

const normalise = (t) => cleanTitle(t).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * What a stock moves on besides its own name.
 *
 * ASML fell 5.2% one morning on eight headlines about chip stocks sliding after
 * an AI slowdown call. Not one of them said "ASML", so the company-name test
 * discarded every single one and the card read "no headlines" next to the
 * biggest move on the board. A sector story is often the whole reason a stock is
 * moving, so it belongs on the card — labelled as sector news, not passed off as
 * news about the company.
 */
const INDUSTRY_THEMES = {
  semiconductor: ['chip', 'chips', 'chipmaker', 'semiconductor', 'semis', 'wafer',
    'foundry', 'euv', 'lithography', 'fab'],
  software: ['software', 'cloud', 'saas', 'cybersecurity', 'data centre', 'data center'],
  internet: ['internet', 'e-commerce', 'ecommerce', 'online retail'],
  entertainment: ['streaming', 'advertising', 'ad spend', 'media'],
  auto: ['ev', 'electric vehicle', 'carmaker', 'auto'],
  crypto: ['crypto', 'bitcoin', 'ethereum', 'digital asset', 'stablecoin'],
  bank: ['bank', 'lender', 'fintech', 'interest rate', 'rate cut', 'rate rise'],
  retail: ['retail', 'consumer spending', 'shopper'],
  energy: ['hydrogen', 'fuel cell', 'renewable', 'clean energy'],
  travel: ['travel', 'booking', 'tourism', 'airline'],
  betting: ['betting', 'gambling', 'sportsbook', 'igaming'],
};

/** Map Yahoo's industry string onto a theme. Falls back to the broad sector. */
function themesFor(industry, sector) {
  const text = `${industry ?? ''} ${sector ?? ''}`.toLowerCase();
  const themes = new Set();
  const add = (key) => INDUSTRY_THEMES[key].forEach((w) => themes.add(w));

  if (/semiconductor/.test(text)) add('semiconductor');
  if (/software|infrastructure|information technology/.test(text)) add('software');
  if (/internet|e-?commerce/.test(text)) add('internet');
  if (/entertainment|communication/.test(text)) add('entertainment');
  if (/auto|vehicle/.test(text)) add('auto');
  if (/crypto|digital asset/.test(text)) add('crypto');
  if (/bank|credit|financial data|capital markets|financial services/.test(text)) add('bank');
  if (/retail|discount stores|consumer/.test(text)) add('retail');
  if (/solar|hydrogen|renewable|utilities|energy/.test(text)) add('energy');
  if (/travel|lodging|airlines?|resorts/.test(text)) add('travel');
  if (/gambling|casino|resorts/.test(text)) add('betting');

  // Almost everything on this watchlist trades on the AI story to some degree,
  // so tech names get it too. Kept narrow: the bare word "ai" matches far too
  // much ("said", "again"), hence the word-boundary forms only.
  if (/technology|semiconductor|software|internet/.test(text)) {
    ['artificial intelligence', 'ai stocks', 'ai boom', 'ai slowdown', 'ai trade',
     'ai spending', 'ai bubble'].forEach((w) => themes.add(w));
  }
  return [...themes];
}

/**
 * Is this headline about the company, about its sector, or neither?
 * @returns {'company'|'sector'|null}
 */
function relevanceOf(title, ticker, name, themes) {
  const t = cleanTitle(title);

  // Four or more ticker-like tokens means it is a list, not a story. This still
  // catches the "Nasdaq Futures Edge Higher: NVDA, AAPL, TSLA" roundups that
  // dragged sentiment toward a meaningless neutral.
  const tickerish = t.match(/\b[A-Z]{2,5}\b/g) ?? [];
  if (tickerish.length >= 4) return null;

  // Naming the company or its ticker. The ticker test is case-SENSITIVE: several
  // tickers are ordinary words (NET, V, ALL, ON), and a case-insensitive match
  // pulled "Net Asset Value" in as Cloudflare news. One-letter tickers are too
  // weak to match on at all, so those rely on the company name.
  const lower = t.toLowerCase();
  if (ticker.length >= 2 && new RegExp(`\\b${ticker}\\b`).test(t)) return 'company';
  const firstWord = name.split(/[\s.,]/)[0].toLowerCase();
  if (lower.includes(name.toLowerCase()) || (firstWord.length >= 4 && lower.includes(firstWord))) {
    return 'company';
  }

  // Otherwise: is it about the industry this stock lives in?
  return themes.some((w) => lower.includes(w)) ? 'sector' : null;
}
async function fromYahoo(yf, ticker, maxHeadlines) {
  try {
    const res = await yf.search(ticker, { newsCount: maxHeadlines, quotesCount: 0 });
    return (res.news ?? []).map((n) => ({
      title: cleanTitle(n.title),
      link: n.link,
      publisher: n.publisher ?? 'Yahoo Finance',
      published: n.providerPublishTime ? new Date(n.providerPublishTime).toISOString() : null,
      source: 'yahoo',
    }));
  } catch (err) {
    console.warn(`  ! Yahoo news failed for ${ticker}: ${err.message}`);
    return [];
  }
}

async function fromGoogleNews(companyName, maxHeadlines) {
  // Company name, not ticker: "V stock" or "NET stock" returns junk.
  const q = encodeURIComponent(`"${companyName}" stock`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-GB&gl=GB&ceid=GB:en`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = parser.parse(await res.text())?.rss?.channel?.item ?? [];
    return (Array.isArray(items) ? items : [items]).slice(0, maxHeadlines).map((i) => ({
      title: cleanTitle(String(i.title ?? '')),
      link: i.link,
      publisher: typeof i.source === 'object' ? i.source['#text'] : (i.source ?? 'Google News'),
      published: i.pubDate ? new Date(i.pubDate).toISOString() : null,
      source: 'google',
    }));
  } catch (err) {
    console.warn(`  ! Google News failed for ${companyName}: ${err.message}`);
    return [];
  }
}

/**
 * Fetch, dedupe, time-filter and sentiment-score headlines for one stock.
 * Falls back gracefully: if both sources fail we return an empty, neutral result.
 */
/**
 * Fetch, dedupe, time-filter and sentiment-score headlines for one stock.
 *
 * Company news and sector news are gathered together but kept apart: a story
 * about chip stocks sliding explains why this one is down, without being news
 * about this company, and the card says which is which. Company news is listed
 * first, since a story naming the stock outranks one about its neighbours.
 */
export async function getNews(yf, { ticker, name, sector, industry },
                              { lookbackHours, maxHeadlines }) {
  const [yahoo, google] = await Promise.all([
    fromYahoo(yf, ticker, maxHeadlines),
    fromGoogleNews(name, maxHeadlines),
  ]);

  const themes = themesFor(industry, sector);
  const cutoff = Date.now() - lookbackHours * 3600 * 1000;
  const seen = new Set();

  const headlines = [...yahoo, ...google]
    .filter((h) => h.title && h.link)
    .filter((h) => !h.published || new Date(h.published).getTime() >= cutoff)
    .map((h) => ({ ...h, scope: relevanceOf(h.title, ticker, name, themes) }))
    .filter((h) => h.scope)
    .filter((h) => {
      const key = normalise(h.title);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((h) => ({ ...h, sentiment: scoreHeadline(h.title) }))
    .sort((a, b) => {
      if (a.scope !== b.scope) return a.scope === 'company' ? -1 : 1;
      return new Date(b.published ?? 0) - new Date(a.published ?? 0);
    })
    .slice(0, maxHeadlines);

  // Sentiment is read off company news alone where there is any. A sector-wide
  // sell-off says something about the stock, but letting it set the score would
  // mark down every tech name on the list for the same headline.
  const company = headlines.filter((h) => h.scope === 'company');
  const summary = aggregateSentiment(company.length ? company : headlines);
  summary.companyCount = company.length;
  summary.sectorCount = headlines.length - company.length;
  summary.basedOn = company.length ? 'company' : (headlines.length ? 'sector' : 'none');

  return { headlines, summary };
}
