import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  DriftClient,
  Wallet,
  initialize,
  BulkAccountLoader,
} from "@drift-labs/sdk";
import { getConnection, loadKeypair, sleep } from "../utils/helpers";
import { STRATEGY_CONFIG } from "../config/vault";
import { DRIFT_PROGRAM_ID } from "../config/constants";
import {
  fetchAllFundingRates,
  rankMarketsByFunding,
  FundingRateData,
} from "./funding-scanner";
import {
  computeTargetAllocations,
  openBasisPosition,
  closeBasisPosition,
  shouldExitPosition,
  BasisPosition,
} from "./position-manager";

const activePositions: BasisPosition[] = [];

async function initDriftClient(
  connection: Connection,
  keypair: Keypair
): Promise<DriftClient> {
  const wallet = new Wallet(keypair);
  const accountLoader = new BulkAccountLoader(connection, "confirmed", 5000);

  const driftClient = new DriftClient({
    connection,
    wallet,
    programID: DRIFT_PROGRAM_ID,
    accountSubscription: {
      type: "polling",
      accountLoader,
    },
  });

  await driftClient.subscribe();
  return driftClient;
}

async function runFundingScan(driftClient: DriftClient): Promise<void> {
  console.log("\n--- Funding Rate Scan ---");
  const rates = await fetchAllFundingRates();
  const ranked = rankMarketsByFunding(
    rates,
    STRATEGY_CONFIG.minAnnualizedFundingBps
  );

  console.log(`Found ${ranked.length} markets above ${STRATEGY_CONFIG.minAnnualizedFundingBps / 100}% threshold:`);
  ranked.slice(0, 10).forEach((m, i) => {
    console.log(
      `  ${i + 1}. ${m.market}: ${m.annualizedPct.toFixed(2)}% APY (24h: ${(m.rate24h * 100).toFixed(4)}%)`
    );
  });
}

async function runRebalance(driftClient: DriftClient): Promise<void> {
  console.log("\n--- Rebalance Cycle ---");

  // 1. Check existing positions for exit signals
  const rates = await fetchAllFundingRates();
  const rateMap = new Map(rates.map((r) => [r.marketIndex, r]));

  for (let i = activePositions.length - 1; i >= 0; i--) {
    const pos = activePositions[i];
    const currentRate = rateMap.get(pos.marketIndex);
    if (!currentRate) continue;

    const { exit, reason } = shouldExitPosition(pos, currentRate.rate24h);
    if (exit) {
      console.log(`Exiting ${pos.marketName}: ${reason}`);
      await closeBasisPosition(driftClient, pos.marketIndex);
      activePositions.splice(i, 1);
    }
  }

  // 2. Compute target allocations
  const ranked = rankMarketsByFunding(
    rates,
    STRATEGY_CONFIG.minAnnualizedFundingBps
  );

  // Get total equity from Drift account
  const user = driftClient.getUser();
  const totalEquity = user.getTotalCollateral().toNumber() / 1e6;
  console.log(`Total equity: $${totalEquity.toFixed(2)}`);

  const { lendingTarget, basisTargets } = computeTargetAllocations(
    totalEquity,
    ranked,
    activePositions
  );

  console.log(`Lending target: $${lendingTarget.toFixed(2)}`);
  console.log(`Basis targets: ${basisTargets.length} markets`);

  // 3. Open new positions for markets we're not already in
  const activeMarkets = new Set(activePositions.map((p) => p.marketIndex));

  for (const target of basisTargets) {
    if (activeMarkets.has(target.marketIndex)) {
      continue; // Already positioned
    }

    try {
      await openBasisPosition(
        driftClient,
        target.marketIndex,
        target.sizeUsd
      );

      activePositions.push({
        marketIndex: target.marketIndex,
        marketName: target.marketName,
        direction: "short",
        sizeUsd: target.sizeUsd,
        entryFundingRate:
          rateMap.get(target.marketIndex)?.rate24h ?? 0,
        entryTimestamp: Date.now(),
      });
    } catch (err) {
      console.error(
        `Failed to open position on ${target.marketName}:`,
        err
      );
    }
  }
}

async function main(): Promise<void> {
  console.log("🐻 Kuma Keeper Starting...");
  console.log("Strategy: Lending floor + Drift basis trade alpha");

  const connection = getConnection();
  const managerKeypair = loadKeypair("MANAGER_KEYPAIR_PATH");

  console.log(`Manager: ${managerKeypair.publicKey.toBase58()}`);
  console.log(`RPC: ${process.env.HELIUS_RPC_URL?.slice(0, 40)}...`);

  const driftClient = await initDriftClient(connection, managerKeypair);
  console.log("Drift client connected.\n");

  // Initial scan
  await runFundingScan(driftClient);

  // Main loop
  let lastScan = Date.now();
  let lastRebalance = 0;

  while (true) {
    const now = Date.now();

    // Periodic funding scan
    if (now - lastScan >= STRATEGY_CONFIG.fundingScanIntervalMs) {
      await runFundingScan(driftClient);
      lastScan = now;
    }

    // Periodic rebalance
    if (now - lastRebalance >= STRATEGY_CONFIG.rebalanceIntervalMs) {
      try {
        await runRebalance(driftClient);
      } catch (err) {
        console.error("Rebalance error:", err);
      }
      lastRebalance = now;
    }

    // Log heartbeat
    console.log(
      `[${new Date().toISOString()}] Active positions: ${activePositions.length} | Next rebalance in ${Math.round(
        (STRATEGY_CONFIG.rebalanceIntervalMs - (now - lastRebalance)) / 60000
      )}min`
    );

    await sleep(60_000); // Check every minute
  }
}

main().catch((err) => {
  console.error("Kuma keeper fatal error:", err);
  process.exit(1);
});
