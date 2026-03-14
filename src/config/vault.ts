import { PublicKey } from "@solana/web3.js";
import { USDC_MINT, SPL_TOKEN_PROGRAM_ID } from "./constants";
import BN from "bn.js";

// Vault configuration
export const VAULT_CONFIG = {
  // Vault metadata
  name: "Kuma",
  description:
    "Kuma Vault — Lending floor yield + Drift basis trade alpha. Kuma guards your yield.",

  // Asset
  assetMintAddress: USDC_MINT,
  assetTokenProgram: SPL_TOKEN_PROGRAM_ID,

  // Capacity
  maxCap: new BN(1_000_000 * 1e6), // 1M USDC

  // Fees (in basis points, 1 bps = 0.01%)
  managementFee: new BN(100), // 1% annual management fee
  issuanceFee: new BN(0), // No deposit fee
  redemptionFee: new BN(10), // 0.1% withdrawal fee
  performanceFee: new BN(2000), // 20% performance fee on profits

  // Withdrawal
  withdrawalWaitingPeriod: new BN(86400), // 24 hours

  // Locked profit degradation (anti-frontrun)
  lockedProfitDegradationDuration: new BN(3600), // 1 hour
};

// Strategy parameters
export const STRATEGY_CONFIG = {
  // Capital allocation
  lendingFloorPct: 20, // 20% to Drift Earn (USDC lending)
  basisTradePct: 80, // 80% to basis trade positions

  // Funding rate thresholds
  minAnnualizedFundingBps: 500, // 5% — minimum to enter a basis position
  exitFundingBps: -100, // -1% — exit if funding goes negative
  maxMarketsSimultaneous: 5, // Trade up to 5 markets at once

  // Risk limits
  maxDrawdownPct: 5, // 5% max drawdown before reducing positions
  maxPositionPctPerMarket: 30, // No more than 30% in one market
  targetLeverage: 3, // 3x leverage (conservative)
  maxLeverage: 5, // Never exceed 5x

  // Rebalance
  rebalanceIntervalMs: 4 * 60 * 60 * 1000, // Every 4 hours
  fundingScanIntervalMs: 60 * 60 * 1000, // Scan rates every 1 hour
};

// Set after vault initialization
export let vaultAddress = process.env.VAULT_ADDRESS
  ? new PublicKey(process.env.VAULT_ADDRESS)
  : PublicKey.default;

export let lookupTableAddress = process.env.LOOKUP_TABLE_ADDRESS
  ? new PublicKey(process.env.LOOKUP_TABLE_ADDRESS)
  : PublicKey.default;
