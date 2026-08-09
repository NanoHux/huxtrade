export function scanningPaused(globalState:Record<string,unknown>|undefined,riskState:Record<string,unknown>|undefined){
  return Boolean(globalState?.paused)||Boolean(riskState?.autoPaused);
}

// A pause is only safe to retry automatically when it came from a transient
// data-fetch failure, tagged with one of these prefixes at the point of
// pausing. Every other pause reason (missing protection, ambiguous
// reconciliation state, a human's manual pause) reflects real trading-state
// risk and must stay paused until someone clears it deliberately.
const retryablePausePrefixes=["DATA_ERROR:","PREWARM_ERROR:"];
export function isRetryablePause(pauseReason:string|null|undefined){
  return retryablePausePrefixes.some((prefix)=>(pauseReason??"").startsWith(prefix));
}

export interface CvdCandle{openTime:number;quoteVolume?:number;takerBuyQuoteVolume?:number}

/**
 * Signed taker flow for a 15-minute scan, split into the three 5-minute bins
 * cvdAnomaly needs for its 2-of-3 direction confirmation.
 *
 * `2 * takerBuyQuote - quoteVolume` is exactly taker-buy minus taker-sell:
 * with B the taker-buy quote volume and S the taker-sell, quoteVolume is B+S,
 * so 2B - (B+S) = B - S. That is the same quantity the previous
 * implementation summed trade by trade (+1 when the buyer was the taker, -1
 * when the seller was), and the same formula prewarmAsset uses to build the
 * 30-day CVD_15M baseline — so the live value and the baseline it is scored
 * against are now measured with one ruler instead of two.
 */
export function cvdBinsFromCandles(candles:CvdCandle[],windowStart:number,windowEnd:number):number[]{
  const bins=[0,0,0];
  for(const candle of candles){
    if(candle.openTime<windowStart||candle.openTime>=windowEnd)continue;
    const index=Math.min(2,Math.max(0,Math.floor((candle.openTime-windowStart)/(5*60_000))));
    bins[index]=(bins[index]??0)+2*(candle.takerBuyQuoteVolume??0)-(candle.quoteVolume??0);
  }
  return bins;
}
