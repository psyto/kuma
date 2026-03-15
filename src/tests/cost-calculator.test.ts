import {
  evaluateTradeEconomics,
  passesCostGate,
  minProfitableFundingBps,
} from "../keeper/cost-calculator";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  PASS: ${msg}`);
  }
}

console.log("=== Cost Calculator Tests ===\n");

// Round-trip cost is 17 bps. For 24h hold:
// Break-even APY = 17 * 8760 / 24 = 6,205 bps = 62% APY
// This means only markets with >62% APY are profitable for 24h holds
// This is realistic — high-funding markets on Drift often exceed this

// Test 1: Very high funding should be profitable
console.log("Trade economics:");
const veryHigh = evaluateTradeEconomics(10000); // 100% APY
assert(veryHigh.profitable, "100% APY should be profitable over 24h");
assert(veryHigh.netProfitBps > 0, "Net profit should be positive");

// Test 2: Moderate funding NOT profitable in 24h (but ok for longer holds)
const moderate = evaluateTradeEconomics(2000); // 20% APY
assert(!moderate.profitable, "20% APY should NOT be profitable for 24h hold (costs too high)");

// Test 3: Moderate funding profitable over 7 days
const moderateLong = evaluateTradeEconomics(2000, 168); // 20% APY, 7-day hold
assert(moderateLong.profitable, "20% APY should be profitable over 7-day hold");

// Test 4: Very low funding should fail
const lowFunding = evaluateTradeEconomics(50); // 0.5% APY
assert(!lowFunding.profitable, "0.5% APY should NOT be profitable");

// Test 5: Break-even calculation
console.log("\nBreak-even analysis:");
const minBps24h = minProfitableFundingBps(24);
const minBps168h = minProfitableFundingBps(168);
console.log(`  Min for 24h hold: ${minBps24h.toFixed(0)} bps (${(minBps24h / 100).toFixed(1)}% APY)`);
console.log(`  Min for 7-day hold: ${minBps168h.toFixed(0)} bps (${(minBps168h / 100).toFixed(1)}% APY)`);
assert(minBps24h > minBps168h, "Shorter holds need higher funding rates");
assert(minBps168h < 1000, "7-day hold should require < 10% APY");

// Test 6: Round-trip cost should be ~17 bps
const econ = evaluateTradeEconomics(1000);
console.log(`\n  Round-trip cost: ${econ.roundTripCostBps.toFixed(1)} bps`);
assert(
  Math.abs(econ.roundTripCostBps - 17) < 1,
  "Round-trip cost should be ~17 bps (2 × (3.5 + 5))"
);

// Test 7: Cost gate (uses minHoldingPeriodHours from config = 24h)
console.log("\nCost gate:");
assert(passesCostGate(10000), "100% APY should pass cost gate");
assert(!passesCostGate(500), "5% APY should NOT pass 24h cost gate");
assert(!passesCostGate(10), "0.1% APY should NOT pass cost gate");

console.log("\n=== Cost Calculator Tests Complete ===");
