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

  // Fees (in basis points, 1 bps = 0.01%)
  managementFee: new BN(100), // 1% annual management fee
  issuanceFee: new BN(0),
  redemptionFee: new BN(10), // 0.1% withdrawal fee
  performanceFee: new BN(2000), // 20% performance fee on profits

  withdrawalWaitingPeriod: new BN(86400), // 24 hours
  lockedProfitDegradationDuration: new BN(3600),
};

// Strategy parameters
export const STRATEGY_CONFIG = {
  // Capital allocation
  lendingFloorPct: 30, // 30% to Drift Earn (raised from 20% — bear market buffer)
  basisTradePct: 70, // 70% to basis trade positions

  // Funding rate thresholds — now includes cost-awareness
  minAnnualizedFundingBps: 500, // 5% — minimum raw funding to consider
  exitFundingBps: -50, // -0.5% — tighter exit than before (was -1%)
  maxMarketsSimultaneous: 3, // Reduced from 5 — avoid low-liquidity altcoins

  // Execution cost thresholds (HIGH PRIORITY fix)
  driftTakerFeeBps: 3.5, // Drift taker fee: 0.035%
  estimatedSlippageBps: 5, // Conservative slippage estimate
  minHoldingPeriodHours: 24, // Minimum expected hold time for cost amortization
  // Entry gate: (funding_apy × hold_period) - (2 × (fee + slippage)) > 0

  // Dynamic leverage control (HIGH PRIORITY fix)
  // Leverage scales inversely with recent volatility
  leverageByVolRegime: {
    veryLow: 2.0, // < 20% vol → comfortable 2x
    low: 1.5, // 20-35% vol → moderate
    normal: 1.0, // 35-50% vol → conservative
    high: 0.5, // 50-75% vol → minimal
    extreme: 0.0, // > 75% vol → no positions
  } as Record<string, number>,
  maxLeverage: 2, // Hard cap reduced from 5x to 2x

  // Volatility thresholds for leverage scaling (annualized, bps)
  volRegimeThresholds: {
    veryLow: 2000, // < 20%
    low: 3500, // 20-35%
    normal: 5000, // 35-50%
    high: 7500, // 50-75%
  },

  // Risk limits — tightened
  maxDrawdownPct: 3, // 3% max drawdown (was 5%)
  severeDrawdownPct: 5, // 5% → close everything
  maxPositionPctPerMarket: 40, // 40% per market (fewer markets = higher per-market ok)

  // Health ratio monitoring (NEW — addresses cross-margin risk)
  minHealthRatio: 1.15, // Start reducing at 1.15 (well above Drift's 1.0 liquidation)
  criticalHealthRatio: 1.08, // Emergency close at 1.08
  healthCheckIntervalMs: 30 * 1000, // Check every 30 seconds

  // Market quality filters (NEW — avoid low-liquidity altcoins)
  minMarketOI: 500_000, // $500K minimum open interest
  excludeMarkets: [] as string[], // Manually excluded markets

  // Rebalance — faster reaction times
  rebalanceIntervalMs: 1 * 60 * 60 * 1000, // Every 1 hour (was 4)
  fundingScanIntervalMs: 15 * 60 * 1000, // Scan every 15 min (was 60)
  emergencyCheckIntervalMs: 30 * 1000, // Health/drawdown check every 30s
};

// Set after vault initialization
export let vaultAddress = process.env.VAULT_ADDRESS
  ? new PublicKey(process.env.VAULT_ADDRESS)
  : PublicKey.default;

export let lookupTableAddress = process.env.LOOKUP_TABLE_ADDRESS
  ? new PublicKey(process.env.LOOKUP_TABLE_ADDRESS)
  : PublicKey.default;
