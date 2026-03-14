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
import { evaluateTradeEconomics, passesCostGate } from "./cost-calculator";
import {
  fetchReferenceVol,
  computeTargetLeverage,
  LeverageState,
} from "./leverage-controller";
import { computeHealthState, computeDrawdown } from "./health-monitor";

const activePositions: BasisPosition[] = [];
let peakEquity = 0;
let currentLeverage: LeverageState | undefined;

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

async function updateLeverage(): Promise<void> {
  try {
    const volBps = await fetchReferenceVol();
    currentLeverage = computeTargetLeverage(volBps);
    console.log(
      `Leverage: ${currentLeverage.targetLeverage}x (${currentLeverage.regime} regime, vol=${(currentLeverage.currentVol * 100).toFixed(1)}%)`
    );
  } catch (err) {
    console.error("Failed to update leverage:", err);
  }
}

async function runEmergencyChecks(driftClient: DriftClient): Promise<boolean> {
  // Health ratio check
  const health = computeHealthState(driftClient);
  if (health.action !== "none") {
    console.log(
      `HEALTH ${health.status.toUpperCase()}: ratio=${health.healthRatio.toFixed(3)} collateral=$${health.totalCollateral.toFixed(2)} pnl=$${health.unrealizedPnl.toFixed(2)}`
    );

    if (health.action === "close_all") {
      console.log("EMERGENCY: Closing all positions — health critical");
      for (let i = activePositions.length - 1; i >= 0; i--) {
        await closeBasisPosition(driftClient, activePositions[i].marketIndex);
        activePositions.splice(i, 1);
      }
      return true; // Signal to skip normal rebalance
    }

    if (health.action === "reduce") {
      console.log("WARNING: Reducing positions — health declining");
      // Close the largest position
      if (activePositions.length > 0) {
        const largest = activePositions.reduce((a, b) =>
          a.sizeUsd > b.sizeUsd ? a : b
        );
        await closeBasisPosition(driftClient, largest.marketIndex);
        const idx = activePositions.indexOf(largest);
        activePositions.splice(idx, 1);
      }
    }
  }

  // Drawdown check
  const equity =
    driftClient.getUser().getTotalCollateral().toNumber() / 1e6;
  if (equity > peakEquity) peakEquity = equity;

  const drawdown = computeDrawdown(equity, peakEquity);
  if (drawdown.action !== "none") {
    console.log(
      `DRAWDOWN ${drawdown.drawdownPct.toFixed(2)}%: equity=$${equity.toFixed(2)} peak=$${peakEquity.toFixed(2)}`
    );

    if (drawdown.action === "close_all") {
      console.log("EMERGENCY: Closing all positions — severe drawdown");
      for (let i = activePositions.length - 1; i >= 0; i--) {
        await closeBasisPosition(driftClient, activePositions[i].marketIndex);
        activePositions.splice(i, 1);
      }
      return true;
    }

    if (drawdown.action === "reduce") {
      console.log("WARNING: Reducing positions — drawdown limit");
      if (activePositions.length > 0) {
        const worst = activePositions[activePositions.length - 1];
        await closeBasisPosition(driftClient, worst.marketIndex);
        activePositions.splice(activePositions.length - 1, 1);
      }
    }
  }

  return false;
}

async function runFundingScan(driftClient: DriftClient): Promise<void> {
  console.log("\n--- Funding Rate Scan ---");
  const rates = await fetchAllFundingRates();
  const ranked = rankMarketsByFunding(
    rates,
    STRATEGY_CONFIG.minAnnualizedFundingBps
  );

  // Apply cost gate — filter out markets where fees eat the funding
  const costFiltered = ranked.filter((m) => {
    const passes = passesCostGate(m.annualizedPct * 100); // Convert % to bps
    if (!passes && m.annualizedPct > 5) {
      console.log(
        `  Filtered: ${m.market} (${m.annualizedPct.toFixed(2)}% APY — below cost threshold)`
      );
    }
    return passes;
  });

  console.log(
    `Markets: ${rates.length} total → ${ranked.length} positive funding → ${costFiltered.length} cost-viable`
  );
  costFiltered.slice(0, 5).forEach((m, i) => {
    const econ = evaluateTradeEconomics(m.annualizedPct * 100);
    console.log(
      `  ${i + 1}. ${m.market}: ${m.annualizedPct.toFixed(2)}% APY (net after costs: ${econ.netProfitBps.toFixed(1)} bps/day, break-even: ${econ.breakEvenHours.toFixed(0)}h)`
    );
  });
}

async function runRebalance(driftClient: DriftClient): Promise<void> {
  console.log("\n--- Rebalance Cycle ---");

  // Check leverage regime
  if (!currentLeverage || currentLeverage.targetLeverage === 0) {
    console.log(
      `Leverage is ${currentLeverage?.targetLeverage ?? "unknown"}x — closing all positions`
    );
    for (let i = activePositions.length - 1; i >= 0; i--) {
      await closeBasisPosition(driftClient, activePositions[i].marketIndex);
      activePositions.splice(i, 1);
    }
    return;
  }

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

  // 2. Compute target allocations with cost-filtered markets and dynamic leverage
  const ranked = rankMarketsByFunding(
    rates,
    STRATEGY_CONFIG.minAnnualizedFundingBps
  ).filter((m) => passesCostGate(m.annualizedPct * 100));

  const user = driftClient.getUser();
  const totalEquity = user.getTotalCollateral().toNumber() / 1e6;
  console.log(
    `Equity: $${totalEquity.toFixed(2)} | Leverage: ${currentLeverage.targetLeverage}x (${currentLeverage.regime})`
  );

  const { lendingTarget, basisTargets } = computeTargetAllocations(
    totalEquity,
    ranked,
    activePositions
  );

  // Scale basis targets by dynamic leverage
  const scaledTargets = basisTargets.map((t) => ({
    ...t,
    sizeUsd: t.sizeUsd * currentLeverage!.targetLeverage,
  }));

  console.log(`Lending target: $${lendingTarget.toFixed(2)}`);
  console.log(`Basis targets: ${scaledTargets.length} markets`);

  // 3. Open new positions
  const activeMarkets = new Set(activePositions.map((p) => p.marketIndex));

  for (const target of scaledTargets) {
    if (activeMarkets.has(target.marketIndex)) continue;
    if (target.sizeUsd < 10) continue; // Skip trivial positions

    try {
      await openBasisPosition(driftClient, target.marketIndex, target.sizeUsd);

      activePositions.push({
        marketIndex: target.marketIndex,
        marketName: target.marketName,
        direction: "short",
        sizeUsd: target.sizeUsd,
        entryFundingRate: rateMap.get(target.marketIndex)?.rate24h ?? 0,
        entryTimestamp: Date.now(),
      });
    } catch (err) {
      console.error(`Failed to open position on ${target.marketName}:`, err);
    }
  }
}

async function main(): Promise<void> {
  console.log("🐻 Kuma Keeper Starting...");
  console.log("Strategy: Lending floor + Drift basis trade alpha");
  console.log("Risk controls: Dynamic leverage, cost gates, health monitoring\n");

  const connection = getConnection();
  const managerKeypair = loadKeypair("MANAGER_KEYPAIR_PATH");

  console.log(`Manager: ${managerKeypair.publicKey.toBase58()}`);

  const driftClient = await initDriftClient(connection, managerKeypair);
  console.log("Drift client connected.\n");

  // Initialize leverage from current vol
  await updateLeverage();
  await runFundingScan(driftClient);

  let lastScan = Date.now();
  let lastRebalance = 0;
  let lastEmergencyCheck = 0;
  let lastLeverageUpdate = Date.now();

  while (true) {
    const now = Date.now();

    // Emergency checks (every 30s) — health ratio + drawdown
    if (now - lastEmergencyCheck >= STRATEGY_CONFIG.emergencyCheckIntervalMs) {
      try {
        const emergency = await runEmergencyChecks(driftClient);
        if (emergency) {
          console.log("Emergency triggered — pausing rebalance for 5 minutes");
          lastRebalance = now; // Delay next rebalance
        }
      } catch (err) {
        console.error("Emergency check error:", err);
      }
      lastEmergencyCheck = now;
    }

    // Leverage update (every 15 min, same as funding scan)
    if (now - lastLeverageUpdate >= STRATEGY_CONFIG.fundingScanIntervalMs) {
      await updateLeverage();
      lastLeverageUpdate = now;
    }

    // Funding scan (every 15 min)
    if (now - lastScan >= STRATEGY_CONFIG.fundingScanIntervalMs) {
      try {
        await runFundingScan(driftClient);
      } catch (err) {
        console.error("Funding scan error:", err);
      }
      lastScan = now;
    }

    // Rebalance (every 1 hour)
    if (now - lastRebalance >= STRATEGY_CONFIG.rebalanceIntervalMs) {
      try {
        await runRebalance(driftClient);
      } catch (err) {
        console.error("Rebalance error:", err);
      }
      lastRebalance = now;
    }

    // Heartbeat
    const equity = driftClient.getUser().getTotalCollateral().toNumber() / 1e6;
    console.log(
      `[${new Date().toISOString()}] Positions: ${activePositions.length} | Equity: $${equity.toFixed(2)} | Leverage: ${currentLeverage?.targetLeverage ?? "?"}x (${currentLeverage?.regime ?? "?"}) | Next rebalance: ${Math.round((STRATEGY_CONFIG.rebalanceIntervalMs - (now - lastRebalance)) / 60000)}min`
    );

    await sleep(30_000); // Tick every 30s (aligned with emergency checks)
  }
}

main().catch((err) => {
  console.error("Kuma keeper fatal error:", err);
  process.exit(1);
});
