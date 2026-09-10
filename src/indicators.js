// Technical indicator helpers. All take arrays ordered oldest -> newest.
import { RSI, SMA, EMA, ATR } from 'technicalindicators';

export const last = (a) => (a && a.length ? a[a.length - 1] : null);

export function sma(values, period) {
  if (values.length < period) return [];
  return SMA.calculate({ period, values });
}

export function ema(values, period) {
  if (values.length < period) return [];
  return EMA.calculate({ period, values });
}

export function rsi(values, period = 14) {
  if (values.length < period + 1) return [];
  return RSI.calculate({ period, values });
}

export function atr(high, low, close, period = 14) {
  if (close.length < period + 1) return [];
  return ATR.calculate({ period, high, low, close });
}

/** Percentage return over `days` sessions, e.g. pctReturn(closes, 5). */
export function pctReturn(closes, days) {
  if (closes.length <= days) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - days];
  if (!then) return null;
  return ((now - then) / then) * 100;
}

/** Latest volume as a multiple of the trailing average (excluding today). */
export function volumeRatio(volumes, period = 20) {
  if (volumes.length < period + 1) return null;
  const recent = volumes.slice(-period - 1, -1);
  const avg = recent.reduce((s, v) => s + v, 0) / recent.length;
  if (!avg) return null;
  return volumes[volumes.length - 1] / avg;
}

/**
 * Detect a moving-average crossover in the last `lookback` sessions.
 * Returns 'bullish', 'bearish' or null.
 *
 * Scans newest-first and returns the MOST RECENT cross. Scanning oldest-first
 * would report a stale cross that has since reversed: a stock can cross up and
 * then straight back down inside the window, and only the latest one is true now.
 */
export function recentCross(fastSeries, slowSeries, lookback = 10) {
  const n = Math.min(fastSeries.length, slowSeries.length);
  if (n < lookback + 2) return null;
  const f = fastSeries.slice(-n);
  const s = slowSeries.slice(-n);
  const diffs = f.map((v, i) => v - s[i]);
  const window = diffs.slice(-(lookback + 1));
  for (let i = window.length - 1; i >= 1; i--) {
    if (window[i - 1] <= 0 && window[i] > 0) return 'bullish';
    if (window[i - 1] >= 0 && window[i] < 0) return 'bearish';
  }
  return null;
}

/** Align a shorter indicator series to the end of the price series. */
export function alignTail(series, targetLength) {
  const pad = targetLength - series.length;
  return pad > 0 ? [...Array(pad).fill(null), ...series] : series;
}
