import { query, pool } from "@huxtrade/database";

const H = 3_600_000;
const THREE_YEARS = 3 * 365 * 24 * H;
const BATCH_INSERT = 500;

async function fetchSymbols(): Promise<string[]> {
  const res = await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo");
  if (!res.ok) throw new Error(`exchangeInfo ${res.status}`);
  const info = (await res.json()) as { symbols: Array<{ symbol: string; quoteAsset: string; contractType: string; status: string }> };
  return info.symbols
    .filter((s) => s.quoteAsset === "USDT" && s.contractType === "PERPETUAL" && s.status === "TRADING")
    .map((s) => s.symbol);
}

type Bar = [number, number, number, number, number, number];

async function fetchKlines(symbol: string, startTime: number, endTime: number): Promise<Bar[]> {
  const bars: Bar[] = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&startTime=${cursor}&limit=1500`;
    const res = await fetch(url);
    if (res.status === 429 || res.status === 418) {
      console.log(`  ${symbol} rate-limited (${res.status}), waiting 5s...`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (!res.ok) break;
    const data = (await res.json()) as number[][];
    if (!data.length) break;
    for (const k of data) bars.push([k[0]!, Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[7]!)]);
    cursor = data[data.length - 1]![0]! + H;
    if (data.length < 1500) break;
  }
  return bars;
}

async function insertBars(symbol: string, bars: Bar[]) {
  for (let i = 0; i < bars.length; i += BATCH_INSERT) {
    const chunk = bars.slice(i, i + BATCH_INSERT);
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (let j = 0; j < chunk.length; j++) {
      const b = chunk[j]!;
      const off = j * 7;
      placeholders.push(`($${off + 1},$${off + 2},$${off + 3},$${off + 4},$${off + 5},$${off + 6},$${off + 7})`);
      values.push(symbol, b[0], b[1], b[2], b[3], b[4], b[5]);
    }
    await query(
      `INSERT INTO klines_1h(symbol,open_time,open,high,low,close,quote_volume) VALUES ${placeholders.join(",")} ON CONFLICT(symbol,open_time) DO NOTHING`,
      values,
    );
  }
}

async function main() {
  const symbols = await fetchSymbols();
  console.log(`${symbols.length} USDT perpetuals to backfill\n`);

  const endTime = Date.now();
  const startTime = endTime - THREE_YEARS;

  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i]!;
    const existing = await query<{ max: string | null }>("SELECT MAX(open_time)::text AS max FROM klines_1h WHERE symbol=$1", [s]);
    const resumeFrom = existing.rows[0]?.max ? Number(existing.rows[0].max) + H : startTime;

    if (resumeFrom >= endTime) {
      if ((i + 1) % 50 === 0) process.stdout.write(`  ${i + 1}/${symbols.length} ${s} already up to date\n`);
      continue;
    }

    const bars = await fetchKlines(s, resumeFrom, endTime);
    if (bars.length) await insertBars(s, bars);

    if ((i + 1) % 10 === 0 || i + 1 === symbols.length)
      process.stdout.write(`  ${i + 1}/${symbols.length} ${s} +${bars.length} bars\n`);

    await new Promise((r) => setTimeout(r, 300));
  }

  const total = await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM klines_1h");
  console.log(`\nbackfill complete, ${total.rows[0]?.count} total bars in klines_1h`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
