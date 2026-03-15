import { PublicKey } from "@solana/web3.js";
import { USDC_MINT, SPL_TOKEN_PROGRAM_ID } from "./constants";
import BN from "bn.js";

// Vault configuration
export const VAULT_CONFIG = {
  name: "Kuma",
  description:
    "Kuma Vault — Lending floor yield + Drift basis trade alpha. Kuma guards your yield.",

  assetMintAddress: USDC_MINT,
  assetTokenProgram: SPL_TOKEN_PROGRAM_ID,

  maxCap: new BN(1_000_000 * 1e6), // 1M USDC

  managementFee: new BN(100), // 1% annual
  issuanceFee: new BN(0),
  redemptionFee: new BN(10), // 0.1% withdrawal fee
  performanceFee: new BN(2000), // 20% performance fee on profits

  withdrawalWaitingPeriod: new BN(86400),
  lockedProfitDegradationDuration: new BN(3600),
};

// Strategy parameters
export const STRATEGY_CONFIG = {
  // Capital allocation
  lendingFloorPct: 30,
  basisTradePct: 70,

  // Funding rate thresholds
  minAnnualizedFundingBps: 500, // 5% minimum
  exitFundingBps: -50, // -0.5% exit

  // === ORDER EXECUTION (v2 — addresses fee-disbursement critique) ===
  // Use LIMIT orders (maker) instead of MARKET orders (taker)
  // Drift maker fee: -0.002% (REBATE) vs taker: 0.035% (PAY)
  // This transforms the fee structure from cost to income
  useLimitOrders: true,
  driftMakerFeeBps: -0.2, // Maker REBATE: -0.002% (we get paid)
  driftTakerFeeBps: 3.5, // Taker fee: 0.035% (fallback only)
  limitOrderSpreadBps: 2, // Place limit 0.02% from oracle (ensures fill)
  limitOrderTimeoutMs: 60_000, // Cancel unfilled limits after 60s, retry as taker
  estimatedSlippageBps: 1, // Lower slippage with limits (was 5)

  // === LOW-TURNOVER MODEL (v2 — addresses cost-induced loss critique) ===
  // Hold positions for days, not hours. Only rotate when conviction is high.
  minHoldingPeriodHours: 168, // 7 days minimum hold (was 24h)
  minFundingAdvantageToRotateBps: 200, // New market must beat current by 2% APY to justify rotation
  maxRotationsPerWeek: 2, // Hard cap on weekly position changes

  // Cost gate now reflects maker fees (much lower threshold)
  // With maker rebates, round-trip cost ≈ 2 × (slippage - rebate) ≈ 1.6 bps
  // vs old taker model: 17 bps round-trip

  // === MARKET QUALITY FILTERS (v2 — addresses 1MBONK liquidity critique) ===
  maxMarketsSimultaneous: 3,
  minMarketOI: 5_000_000, // $5M minimum OI (was $500K — raised 10x)
  minMarketVolume24h: 10_000_000, // $10M minimum 24h volume
  // Only trade assets with deep order books where limit fills are reliable
  allowedMarkets: [
    "SOL-PERP", "BTC-PERP", "ETH-PERP", // Tier 1: always allowed
    "DOGE-PERP", "SUI-PERP", "AVAX-PERP", // Tier 2: if OI/volume pass
  ] as string[],
  // Explicitly block low-liquidity alts that appeared in backtest
  excludeMarkets: [
    "1MBONK-PERP", "1KPUMP-PERP", "1KMON-PERP", "MET-PERP",
    "CLOUD-PERP", "2Z-PERP", "TNSR-PERP", "KMNO-PERP",
  ] as string[],

  // Dynamic leverage control
  leverageByVolRegime: {
    veryLow: 2.0,
    low: 1.5,
    normal: 1.0,
    high: 0.5,
    extreme: 0.0,
  } as Record<string, number>,
  maxLeverage: 2,

  volRegimeThresholds: {
    veryLow: 2000,
    low: 3500,
    normal: 5000,
    high: 7500,
  },

  // Risk limits
  maxDrawdownPct: 3,
  severeDrawdownPct: 5,
  maxPositionPctPerMarket: 40,

  // Health ratio monitoring
  minHealthRatio: 1.15,
  criticalHealthRatio: 1.08,
  healthCheckIntervalMs: 30 * 1000,

  // === TIMING (v2 — lower frequency to reduce turnover) ===
  rebalanceIntervalMs: 4 * 60 * 60 * 1000, // Every 4 hours (was 1h — reduce unnecessary churn)
  fundingScanIntervalMs: 30 * 60 * 1000, // Scan every 30 min (was 15 — less reactive, more stable)
  emergencyCheckIntervalMs: 30 * 1000, // Health still at 30s (safety-critical)
};

export let vaultAddress = process.env.VAULT_ADDRESS
  ? new PublicKey(process.env.VAULT_ADDRESS)
  : PublicKey.default;

export let lookupTableAddress = process.env.LOOKUP_TABLE_ADDRESS
  ? new PublicKey(process.env.LOOKUP_TABLE_ADDRESS)
  : PublicKey.default;
