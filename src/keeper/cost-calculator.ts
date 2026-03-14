import { STRATEGY_CONFIG } from "../config/vault";

export interface TradeEconomics {
  expectedFundingBps: number; // Annualized funding rate in bps
  holdingPeriodHours: number;
  positionSizeUsd: number;
  profitable: boolean;
  netProfitBps: number;
  roundTripCostBps: number;
  breakEvenHours: number;
}

/**
 * Compute whether a basis trade is profitable after costs.
 *
 * Gate: (funding_apy × hold_period / 8760) - (2 × (fee + slippage)) > 0
 *
 * This prevents "fee churn" — where frequent rotation eats more in
 * trading costs than the harvested funding.
 */
export function evaluateTradeEconomics(
  annualizedFundingBps: number,
  estimatedHoldHours: number = STRATEGY_CONFIG.minHoldingPeriodHours
): TradeEconomics {
  const { driftTakerFeeBps, estimatedSlippageBps } = STRATEGY_CONFIG;

  // Round-trip cost: entry fee + exit fee + entry slippage + exit slippage
  const roundTripCostBps = 2 * (driftTakerFeeBps + estimatedSlippageBps);

  // Expected funding earned over hold period
  const hoursPerYear = 8760;
  const expectedFundingEarned =
    (annualizedFundingBps * estimatedHoldHours) / hoursPerYear;

  const netProfitBps = expectedFundingEarned - roundTripCostBps;
  const profitable = netProfitBps > 0;

  // Break-even: how many hours to hold before funding covers costs
  const breakEvenHours =
    annualizedFundingBps > 0
      ? (roundTripCostBps * hoursPerYear) / annualizedFundingBps
      : Infinity;

  return {
    expectedFundingBps: annualizedFundingBps,
    holdingPeriodHours: estimatedHoldHours,
    positionSizeUsd: 0, // Set by caller
    profitable,
    netProfitBps,
    roundTripCostBps,
    breakEvenHours,
  };
}

/**
 * Filter markets that pass the cost gate.
 * Only enter positions where expected funding exceeds round-trip costs.
 */
export function passesCostGate(annualizedFundingBps: number): boolean {
  const economics = evaluateTradeEconomics(annualizedFundingBps);
  return economics.profitable;
}

/**
 * Compute the minimum annualized funding rate needed to break even
 * for a given holding period.
 */
export function minProfitableFundingBps(holdHours: number): number {
  const { driftTakerFeeBps, estimatedSlippageBps } = STRATEGY_CONFIG;
  const roundTripCostBps = 2 * (driftTakerFeeBps + estimatedSlippageBps);
  return (roundTripCostBps * 8760) / holdHours;
}
