// Headline sentiment: VADER for general tone + a finance lexicon for market language.
// VADER alone is near-useless on financial headlines (it scores "analyst upgrades,
// doubles revenue forecast" as 0.0), so the finance lexicon carries most of the weight.
import vaderPkg from 'vader-sentiment';

const vader = vaderPkg.default ?? vaderPkg;

const POSITIVE = {
  upgrade: 2.5, upgrades: 2.5, upgraded: 2.5, outperform: 2, overweight: 1.8,
  'buy rating': 2, 'price target raised': 2.5, 'raises price target': 2.5,
  'target hike': 2, bullish: 1.8, 'initiated with a buy': 2,
  beat: 2.2, beats: 2.2, 'topped estimates': 2.5, tops: 1.5, surpassed: 2, surpasses: 2,
  'raises guidance': 3, 'raised guidance': 3, 'lifts outlook': 2.8, 'boosts forecast': 2.5,
  'doubles': 1.5, 'record revenue': 2.5, 'record profit': 2.5, 'record high': 2,
  surge: 1.2, surges: 1.2, soars: 1.4, soar: 1.4, rally: 1, rallies: 1, ascends: 1,
  jumps: 1, jumped: 1, climbs: 0.8, gains: 0.6, rises: 0.6,
  buyback: 2, 'share repurchase': 2, 'dividend increase': 2, 'raises dividend': 2,
  approval: 2, approved: 2, 'wins contract': 2.5, 'awarded': 1.8, partnership: 1.5,
  breakthrough: 2, 'strong demand': 2.2, 'better than expected': 2.5,
  expansion: 1.2, milestone: 1.5, 'all-time high': 2,
};

const NEGATIVE = {
  downgrade: -2.5, downgrades: -2.5, downgraded: -2.5, underperform: -2, underweight: -1.8,
  'sell rating': -2, 'price target cut': -2.5, 'cuts price target': -2.5, bearish: -1.8,
  miss: -2.2, misses: -2.2, missed: -2, 'below estimates': -2.5, 'short of expectations': -2.5,
  'cuts guidance': -3, 'lowers guidance': -3, 'slashes outlook': -3, 'cuts forecast': -2.8,
  'warns': -2.2, warning: -1.8, 'profit warning': -3,
  slump: -1.4, slumps: -1.4, plunge: -1.8, plunges: -1.8, plummet: -1.8, plummets: -1.8,
  tumble: -1.2, tumbles: -1.2, sinks: -1.1, sank: -1.1, drops: -0.8, falls: -0.6, slides: -0.8,
  layoffs: -2, 'job cuts': -2, restructuring: -1.2,
  lawsuit: -2, 'class action': -2.2, probe: -2.2, investigation: -2.2, subpoena: -2.5,
  antitrust: -2, fine: -1.8, fined: -2, penalty: -1.8, 'sec charges': -3, fraud: -3,
  recall: -2.5, delay: -1.8, delayed: -1.8, halted: -2.5, suspension: -2.2,
  bankruptcy: -3.5, 'going concern': -3, 'short seller': -2.5, 'short report': -2.5,
  'weak demand': -2.2, 'worse than expected': -2.5, 'data breach': -2.5, hack: -2,
  'steps down': -1.5, resignation: -1.5, 'ceo departs': -2,
};

const CATALYSTS = [
  { tag: 'Earnings',   terms: ['earnings', 'quarterly results', 'q1 ', 'q2 ', 'q3 ', 'q4 ', 'eps', 'guidance', 'outlook', 'revenue'] },
  { tag: 'Analyst',    terms: ['upgrade', 'downgrade', 'price target', 'initiated coverage', 'rating', 'analyst'] },
  { tag: 'Regulatory', terms: ['fda', 'sec ', 'doj', 'antitrust', 'probe', 'investigation', 'lawsuit', 'ruling', 'regulator', 'approval'] },
  { tag: 'Product',    terms: ['launch', 'unveils', 'announces', 'releases', 'debut', 'rollout'] },
  { tag: 'Deal',       terms: ['acquisition', 'acquires', 'merger', 'buyout', 'stake', 'partnership', 'contract'] },
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Strip the " - publisher.com" suffix Google News appends to titles. */
export function cleanTitle(title = '') {
  return title.replace(/\s+-\s+[^-]{2,40}$/, '').trim();
}

function lexiconScore(text) {
  const t = ` ${text.toLowerCase()} `;
  let sum = 0;
  const hits = [];
  for (const [term, weight] of Object.entries({ ...POSITIVE, ...NEGATIVE })) {
    if (t.includes(term)) {
      sum += weight;
      hits.push(term);
    }
  }
  return { raw: sum, normalised: clamp(sum / 3, -1, 1), hits };
}

/** Score one headline. Returns { compound, label, catalyst, hits }. */
export function scoreHeadline(title) {
  const text = cleanTitle(title);
  const vaderScore = vader.SentimentIntensityAnalyzer.polarity_scores(text).compound;
  const lex = lexiconScore(text);

  // Finance lexicon dominates; VADER only fills in where it found nothing.
  const compound = clamp(lex.normalised * 0.75 + vaderScore * 0.25, -1, 1);

  const lower = text.toLowerCase();
  const catalyst = CATALYSTS.find((c) => c.terms.some((term) => lower.includes(term)))?.tag ?? null;

  let label = 'neutral';
  if (compound >= 0.15) label = 'positive';
  else if (compound <= -0.15) label = 'negative';

  return { compound: Number(compound.toFixed(3)), label, catalyst, hits: lex.hits };
}

/** Aggregate sentiment across a list of headlines. */
export function aggregateSentiment(headlines) {
  if (!headlines.length) {
    return { net: 0, label: 'no recent news', positive: 0, negative: 0, neutral: 0, catalysts: [] };
  }
  const scored = headlines.map((h) => h.sentiment);
  const net = scored.reduce((s, x) => s + x.compound, 0) / scored.length;
  const catalysts = [...new Set(scored.map((s) => s.catalyst).filter(Boolean))];

  let label = 'mixed / neutral';
  if (net >= 0.25) label = 'clearly positive';
  else if (net >= 0.1) label = 'mildly positive';
  else if (net <= -0.25) label = 'clearly negative';
  else if (net <= -0.1) label = 'mildly negative';

  return {
    net: Number(net.toFixed(3)),
    label,
    positive: scored.filter((s) => s.label === 'positive').length,
    negative: scored.filter((s) => s.label === 'negative').length,
    neutral: scored.filter((s) => s.label === 'neutral').length,
    catalysts,
  };
}
