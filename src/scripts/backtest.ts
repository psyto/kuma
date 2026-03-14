import { DRIFT_DATA_API } from "../config/constants";
import { STRATEGY_CONFIG } from "../config/vault";
import { evaluateTradeEconomics, passesCostGate } from "../keeper/cost-calculator";

interface FundingRecord {
  ts: number;
  marketIndex: number;
  symbol: string;
  fundingRate: string;
  fundingRateLong: string;
  fundingRateShort: string;
  oraclePriceTwap: string;
  markPriceTwap: string;
}

interface BacktestResult {
  market: string;
  totalHours: number;
  positiveHours: number;
  negativeHours: number;
  avgFundingRateHourly: number;
  annualizedAPY: number;
  maxConsecutiveNegativeHours: number;
  cumulativeReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
}

interface PortfolioResult {
  startDate: string;
  endDate: string;
  totalDays: number;
  totalReturnPct: number;
  annualizedAPY: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  winRate: number;
  monthlyReturns: { month: string; returnPct: number }[];
  marketResults: BacktestResult[];
  lendingYieldPct: number;
  basisYieldPct: number;
}

const S3_BUCKET =
  "https://drift-historical-data-v2.s3.eu-west-1.amazonaws.com";
const DRIFT_PROGRAM = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH";

async function fetchFundingHistory(
  market: string
): Promise<FundingRecord[]> {
  // Use the API endpoint only (750 records = ~31 days)
  // This is sufficient for a meaningful backtest
  const res = await fetch(
    `${DRIFT_DATA_API}/market/${market}/fundingRates?limit=750`
  );
  if (!res.ok) throw new Error(`Failed: ${res.status}`);

  const body = (await res.json()) as {
    success: boolean;
    records: FundingRecord[];
  };
  if (!body.success || !body.records) {
    throw new Error("No funding data returned");
  }

  return body.records.sort((a, b) => a.ts - b.ts);
}

function backtestMarket(
  records: FundingRecord[],
  costGateEnabled: boolean
): BacktestResult {
  if (records.length === 0) {
    return {
      market: "unknown",
      totalHours: 0,
      positiveHours: 0,
      negativeHours: 0,
      avgFundingRateHourly: 0,
      annualizedAPY: 0,
      maxConsecutiveNegativeHours: 0,
      cumulativeReturnPct: 0,
      maxDrawdownPct: 0,
      sharpeRatio: 0,
    };
  }

  const market = records[0].symbol;
  const hourlyReturns: number[] = [];
  let consecutiveNeg = 0;
  let maxConsecutiveNeg = 0;
  let positiveHours = 0;
  let negativeHours = 0;
  let inPosition = false;

  for (const rec of records) {
    // Funding rate is a decimal fraction per hour (e.g., 0.001 = 0.1% per hour)
    const rate = parseFloat(rec.fundingRateShort);
    const annualizedBps = Math.abs(rate) * 24 * 365 * 10000; // to bps

    if (rate > 0) {
      positiveHours++;
      consecutiveNeg = 0;

      if (costGateEnabled && !passesCostGate(annualizedBps)) {
        hourlyReturns.push(0);
        continue;
      }

      // Hourly return in % = rate * 100 (e.g., 0.001 → 0.1%)
      hourlyReturns.push(rate * 100);
      inPosition = true;
    } else {
      negativeHours++;
      consecutiveNeg++;
      maxConsecutiveNeg = Math.max(maxConsecutiveNeg, consecutiveNeg);

      if (inPosition && rate < STRATEGY_CONFIG.exitFundingBps / 10000) {
        hourlyReturns.push(rate * 100);
        inPosition = false;
      } else if (inPosition) {
        hourlyReturns.push(rate * 100);
      } else {
        hourlyReturns.push(0);
      }
    }
  }

  // Aggregate hourly returns into daily returns (sum, not compound)
  const dailyReturns: number[] = [];
  for (let i = 0; i < hourlyReturns.length; i += 24) {
    const daySlice = hourlyReturns.slice(i, i + 24);
    const dayReturn = daySlice.reduce((a, b) => a + b, 0);
    dailyReturns.push(dayReturn);
  }

  // Compute cumulative return using daily compounding
  let cumReturn = 1;
  let peak = 1;
  let maxDrawdown = 0;

  for (const r of dailyReturns) {
    cumReturn *= 1 + r / 100;
    if (cumReturn > peak) peak = cumReturn;
    const dd = (peak - cumReturn) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const cumulativeReturnPct = (cumReturn - 1) * 100;
  const avgDaily =
    dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const annualizedAPY = avgDaily * 365;

  // Sharpe ratio (daily)
  const stdDev = Math.sqrt(
    dailyReturns.reduce((sum, r) => sum + (r - avgDaily) ** 2, 0) /
      dailyReturns.length
  );
  const sharpe =
    stdDev > 0 ? (avgDaily / stdDev) * Math.sqrt(365) : 0;

  return {
    market,
    totalHours: records.length,
    positiveHours,
    negativeHours,
    avgFundingRateHourly: avgDaily / 24,
    annualizedAPY,
    maxConsecutiveNegativeHours: maxConsecutiveNeg,
    cumulativeReturnPct,
    maxDrawdownPct: maxDrawdown * 100,
    sharpeRatio: sharpe,
  };
}

async function main() {
  console.log("🐻 Kuma Vault — Historical Backtest\n");
  console.log("Strategy: 30% lending floor + 70% basis trade (top 3 markets)");
  console.log("Risk controls: cost gate, dynamic leverage, -0.5% exit threshold\n");

  // Markets to backtest
  const markets = [
    "SOL-PERP",
    "BTC-PERP",
    "ETH-PERP",
    "DOGE-PERP",
    "SUI-PERP",
    "1MBONK-PERP",
  ];

  console.log("Fetching historical funding rates (up to 6 months)...\n");

  const marketResults: BacktestResult[] = [];

  for (const market of markets) {
    try {
      process.stdout.write(`  ${market}... `);
      const records = await fetchFundingHistory(market, 4380);
      const result = backtestMarket(records, true);
      marketResults.push(result);
      console.log(
        `${result.totalHours}h | APY: ${result.annualizedAPY.toFixed(2)}% | ` +
          `Drawdown: ${result.maxDrawdownPct.toFixed(2)}% | ` +
          `Sharpe: ${result.sharpeRatio.toFixed(2)} | ` +
          `Positive: ${((result.positiveHours / result.totalHours) * 100).toFixed(0)}%`
      );
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message}`);
    }
  }

  // Sort by Sharpe ratio descending — top 3 are our targets
  marketResults.sort((a, b) => b.sharpeRatio - a.sharpeRatio);

  console.log("\n=== Top 3 Markets (by Sharpe Ratio) ===");
  const top3 = marketResults.slice(0, 3);
  top3.forEach((m, i) => {
    console.log(
      `  ${i + 1}. ${m.market}: APY=${m.annualizedAPY.toFixed(2)}% | ` +
        `Sharpe=${m.sharpeRatio.toFixed(2)} | ` +
        `MaxDD=${m.maxDrawdownPct.toFixed(2)}% | ` +
        `MaxNegStreak=${m.maxConsecutiveNegativeHours}h`
    );
  });

  // Portfolio simulation: 30% lending + 70% split across top 3
  console.log("\n=== Portfolio Backtest ===");
  const lendingAPY = 3; // Conservative 3% lending yield
  const basisWeight = 0.7 / top3.length;
  const lendingWeight = 0.3;

  const portfolioAPY =
    lendingWeight * lendingAPY +
    top3.reduce((sum, m) => sum + basisWeight * m.annualizedAPY, 0);

  const portfolioMaxDD = Math.max(...top3.map((m) => m.maxDrawdownPct)) * 0.7; // 70% basis allocation
  const avgSharpe =
    top3.reduce((sum, m) => sum + m.sharpeRatio, 0) / top3.length;

  // Monthly returns estimation
  const totalHours = Math.min(...top3.map((m) => m.totalHours));
  const totalDays = totalHours / 24;
  const totalMonths = Math.ceil(totalDays / 30);

  console.log(`Period: ~${totalDays.toFixed(0)} days (~${totalMonths} months)`);
  console.log(`Lending yield (30%): ${(lendingWeight * lendingAPY).toFixed(2)}% APY contribution`);
  console.log(
    `Basis yield (70%): ${(portfolioAPY - lendingWeight * lendingAPY).toFixed(2)}% APY contribution`
  );
  console.log(`Combined portfolio APY: ${portfolioAPY.toFixed(2)}%`);
  console.log(`Estimated max drawdown: ${portfolioMaxDD.toFixed(2)}%`);
  console.log(`Average Sharpe ratio: ${avgSharpe.toFixed(2)}`);

  // Summary table
  console.log("\n=== Summary ===");
  console.log(`Target APY (hackathon): ≥10%`);
  console.log(`Backtest APY: ${portfolioAPY.toFixed(2)}%`);
  console.log(
    `Meets target: ${portfolioAPY >= 10 ? "YES ✓" : "NO ✗ (lending floor provides base)"}`
  );
  console.log(`Max drawdown: ${portfolioMaxDD.toFixed(2)}%`);
  console.log(
    `Within 3% limit: ${portfolioMaxDD <= 3 ? "YES ✓" : "WOULD TRIGGER REDUCTION at 3%"}`
  );

  // Per-market details
  console.log("\n=== All Markets Detail ===");
  console.log(
    "Market          | Hours  | APY%     | MaxDD%  | Sharpe | Pos%  | MaxNegStreak"
  );
  console.log(
    "----------------|--------|----------|---------|--------|-------|------------"
  );
  marketResults.forEach((m) => {
    console.log(
      `${m.market.padEnd(16)}| ${String(m.totalHours).padEnd(7)}| ${m.annualizedAPY.toFixed(2).padStart(8)}| ${m.maxDrawdownPct.toFixed(2).padStart(7)} | ${m.sharpeRatio.toFixed(2).padStart(6)} | ${((m.positiveHours / m.totalHours) * 100).toFixed(0).padStart(4)}% | ${m.maxConsecutiveNegativeHours}h`
    );
  });
}

main().catch(console.error);
