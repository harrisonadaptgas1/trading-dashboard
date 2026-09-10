// Free news: Yahoo Finance (via yahoo-finance2 search) + Google News RSS fallback.
// No API keys, no rate limits to manage at 30 tickers/day.
import { XMLParser } from 'fast-xml-parser';
import { scoreHeadline, cleanTitle, aggregateSentiment } from './sentiment.js';

const parser = new XMLParser({ ignoreAttributes: false });
const UA = 'Mozilla/5.0 (compatible; personal-watchlist/1.0)';

const normalise = (t) => cleanTitle(t).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Both feeds return market roundups that merely list the ticker
 * ("Nasdaq Futures Edge Higher: NVDA, AAPL, TSLA..."). Those are not news about
 * the company and they drag sentiment toward a meaningless neutral, so drop them.
 */
function isRelevant(title, ticker, name) {
  const t = cleanTitle(title);

  // Four or more ticker-like tokens means it is a list, not a story.
  const tickerish = t.match(/\b[A-Z]{2,5}\b/g) ?? [];
  if (tickerish.length >= 4) return false;

  // Must actually name the company or its ticker. The ticker test is
  // case-SENSITIVE: several tickers are ordinary words (NET, V, ALL, ON), and a
  // case-insensitive match pulled "Net Asset Value" and "Net zero" in as Cloudflare
  // news. One-letter tickers are too weak to match on at all, so those rely on the
  // company name.
  const lower = t.toLowerCase();
  if (ticker.length >= 2 && new RegExp(`\\b${ticker}\\b`).test(t)) return true;
  const firstWord = name.split(/[\s.,]/)[0].toLowerCase();
  return lower.includes(name.toLowerCase()) || (firstWord.length >= 4 && lower.includes(firstWord));
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
export async function getNews(yf, { ticker, name }, { lookbackHours, maxHeadlines }) {
  const [yahoo, google] = await Promise.all([
    fromYahoo(yf, ticker, maxHeadlines),
    fromGoogleNews(name, maxHeadlines),
  ]);

  const cutoff = Date.now() - lookbackHours * 3600 * 1000;
  const seen = new Set();
  const headlines = [...yahoo, ...google]
    .filter((h) => h.title && h.link)
    .filter((h) => !h.published || new Date(h.published).getTime() >= cutoff)
    .filter((h) => isRelevant(h.title, ticker, name))
    .filter((h) => {
      const key = normalise(h.title);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((h) => ({ ...h, sentiment: scoreHeadline(h.title) }))
    .sort((a, b) => new Date(b.published ?? 0) - new Date(a.published ?? 0))
    .slice(0, maxHeadlines);

  return { headlines, summary: aggregateSentiment(headlines) };
}
