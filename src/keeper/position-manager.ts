import {
  DriftClient,
  PositionDirection,
  OrderType,
  MarketType,
  BN,
} from "@drift-labs/sdk";
import { STRATEGY_CONFIG } from "../config/vault";
import {
  BASE_PRECISION,
  PRICE_PRECISION,
  USDC_DECIMALS,
} from "../config/constants";
import { FundingRateData } from "./funding-scanner";

export interface BasisPosition {
  marketIndex: number;
  marketName: string;
  direction: "short";
  sizeUsd: number;
  entryFundingRate: number;
  entryTimestamp: number;
}

export interface PortfolioState {
  totalEquity: number;
  lendingAllocation: number;
  basisAllocation: number;
  positions: BasisPosition[];
  unrealizedPnl: number;
}

export function computeTargetAllocations(
  totalEquity: number,
  rankedMarkets: FundingRateData[],
  currentPositions: BasisPosition[]
): {
  lendingTarget: number;
  basisTargets: { marketIndex: number; marketName: string; sizeUsd: number }[];
} {
  const { lendingFloorPct, basisTradePct, maxMarketsSimultaneous, maxPositionPctPerMarket } =
    STRATEGY_CONFIG;

  const lendingTarget = (totalEquity * lendingFloorPct) / 100;
  const basisBudget = (totalEquity * basisTradePct) / 100;

  // Select top N markets
  const selectedMarkets = rankedMarkets.slice(0, maxMarketsSimultaneous);
  if (selectedMarkets.length === 0) {
    // No good markets — put everything in lending
    return { lendingTarget: totalEquity, basisTargets: [] };
  }

  // Weight allocation by annualized funding rate
  const totalScore = selectedMarkets.reduce(
    (sum, m) => sum + m.annualizedPct,
    0
  );

  const basisTargets = selectedMarkets.map((market) => {
    const weight = market.annualizedPct / totalScore;
    const rawAllocation = basisBudget * weight;
    const maxAllocation = (totalEquity * maxPositionPctPerMarket) / 100;
    const sizeUsd = Math.min(rawAllocation, maxAllocation);

    return {
      marketIndex: market.marketIndex,
      marketName: market.market,
      sizeUsd,
    };
  });

  return { lendingTarget, basisTargets };
}

export async function openBasisPosition(
  driftClient: DriftClient,
  marketIndex: number,
  sizeUsd: number
): Promise<string> {
  // For basis trade: short perp (collect funding when positive)
  // The "long spot" side is implicit — USDC in the vault IS the spot position
  const oraclePrice = driftClient.getOracleDataForPerpMarket(marketIndex);
  const price = oraclePrice.price.toNumber() / PRICE_PRECISION;
  const baseAmount = (sizeUsd / price) * BASE_PRECISION;

  const orderParams = {
    orderType: OrderType.MARKET,
    marketType: MarketType.PERP,
    marketIndex,
    direction: PositionDirection.SHORT,
    baseAssetAmount: new BN(Math.floor(baseAmount)),
    reduceOnly: false,
  };

  const txSig = await driftClient.placePerpOrder(orderParams);
  console.log(
    `Opened SHORT ${(sizeUsd).toFixed(2)} USD on market ${marketIndex} | tx: ${txSig}`
  );
  return txSig;
}

export async function closeBasisPosition(
  driftClient: DriftClient,
  marketIndex: number
): Promise<string> {
  const user = driftClient.getUser();
  const position = user.getPerpPosition(marketIndex);
  if (!position || position.baseAssetAmount.isZero()) {
    console.log(`No position to close on market ${marketIndex}`);
    return "";
  }

  const orderParams = {
    orderType: OrderType.MARKET,
    marketType: MarketType.PERP,
    marketIndex,
    direction: PositionDirection.LONG, // Close short by going long
    baseAssetAmount: position.baseAssetAmount.abs(),
    reduceOnly: true,
  };

  const txSig = await driftClient.placePerpOrder(orderParams);
  console.log(`Closed position on market ${marketIndex} | tx: ${txSig}`);
  return txSig;
}

export function shouldExitPosition(
  position: BasisPosition,
  currentFundingRate: number
): { exit: boolean; reason: string } {
  const { exitFundingBps, maxDrawdownPct } = STRATEGY_CONFIG;
  const exitThreshold = exitFundingBps / 10000;

  // Exit if funding turned negative
  if (currentFundingRate < exitThreshold) {
    return {
      exit: true,
      reason: `Funding rate ${(currentFundingRate * 100).toFixed(4)}% below exit threshold`,
    };
  }

  return { exit: false, reason: "" };
}
