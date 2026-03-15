# Kuma Vault — Strategy Documentation

## Thesis

Drift's hybrid AMM architecture creates three structural inefficiencies that mean-revert: OI imbalance, mark/oracle premium, and funding rate skew. Kuma captures all three simultaneously using a weighted composite signal that determines both entry direction and position sizing.

**Core insight**: Most basis trade vaults use a single signal (funding rate) and only trade one direction (short). Kuma uses **three Drift-native signals** to determine the **optimal direction** (SHORT in bull, LONG in bear) and captures **premium convergence alpha** that funding-only strategies miss entirely.

**Revenue sources**: Funding payments + mark/oracle premium convergence + OI rebalancing + lending floor. Four sources active across all market conditions.

## How It Works

### Capital Allocation

```
Total Vault Capital
├── 30% → Lending Floor (Drift Earn — USDC spot lending)
│         Provides ~1-5% APY base yield regardless of market conditions
│         Acts as buffer during extreme vol
│
└── 70% → Imbalance Arbitrage Pool
          ├── Imbalance Detector (every 30 min)
          │   ├── Reads OI imbalance (long vs short open interest)
          │   ├── Reads Mark/Oracle premium (mark price vs oracle deviation)
          │   ├── Reads Funding rate (24h average)
          │   └── Composite signal: 50% funding + 30% premium + 20% OI
          │
          ├── Signal Scoring
          │   ├── strong_short: composite > 0.6 (bullish imbalance)
          │   ├── moderate_short: composite 0.2-0.6
          │   ├── neutral: -0.2 to 0.2 (conflicting signals → skip)
          │   ├── moderate_long: composite -0.6 to -0.2
          │   └── strong_long: composite < -0.6 (bearish imbalance)
          │
          ├── Cost Gate (maker orders)
          │   ├── Maker fee: -0.002% rebate (not 0.035% taker fee)
          │   ├── Round-trip cost: 1.6 bps (not 17 bps)
          │   └── 7-day min hold, max 2 rotations/week
          │
          ├── Leverage Controller
          │   ├── Parkinson vol from SOL-PERP candles
          │   └── 2x in low vol → 0x in extreme vol
          │
          └── Position Manager (bidirectional)
              ├── SHORT when signal is short (mark > oracle + long-heavy OI)
              ├── LONG when signal is long (mark < oracle + short-heavy OI)
              ├── Flip direction when signals change
              └── 30-second health monitoring
```

### Entry Criteria

A market is eligible for a position when ALL of the following are met:
1. **Composite signal strength ≥ 20%** (not neutral — clear directional conviction)
2. Market is on the allowed whitelist (SOL/BTC/ETH/DOGE/SUI/AVAX) and not excluded
3. **Cost gate passes**: Expected |funding| over 7-day hold > round-trip maker costs (1.6 bps)
4. Current vol regime allows leverage > 0 (not extreme)
5. Portfolio health ratio > 1.15 after the new position

### Direction Logic

```
IF funding > 0 AND mark > oracle AND long-heavy OI → SHORT (collect funding + premium convergence)
IF funding < 0 AND mark < oracle AND short-heavy OI → LONG (collect funding + discount convergence)
IF signals conflict → SKIP (composite near zero = no conviction)
```

### Exit Criteria

A position is closed when ANY of the following occur:
1. Composite signal flips direction → close and re-enter opposite side
2. Signal strength drops below 20% (conviction lost)
3. Portfolio drawdown exceeds 3% (reduce) or 5% (close all)
4. Health ratio drops below 1.15 (reduce) or 1.08 (emergency close all)
5. Vol regime transitions to extreme (0x leverage = all positions closed)
6. Position held > 7 days and a stronger market becomes available (max 2 rotations/week)

### Rebalancing

Every 4 hours, the keeper:
1. Checks health ratio and drawdown (emergency path if critical — every 30s)
2. Updates realized vol and dynamic leverage target
3. Fetches OI, mark/oracle, and funding data → computes composite signals
4. Determines entry direction per market (SHORT or LONG)
5. Flips positions where direction has changed
6. Opens new positions in top 3 by signal strength (scaled by leverage)

## Risk Management

### Dynamic Leverage

| Vol Regime | Realized Vol | Leverage | Rationale |
|------------|-------------|----------|-----------|
| Very Low | < 20% | 2.0x | Calm markets, safe for moderate leverage |
| Low | 20-35% | 1.5x | Normal conditions |
| Normal | 35-50% | 1.0x | Elevated — conservative |
| High | 50-75% | 0.5x | Turbulent — minimal exposure |
| Extreme | > 75% | 0x | Shut down |

**Why dynamic leverage matters**: During a short squeeze, fixed 3-5x leverage causes rapid health ratio deterioration as unrealized PnL grows against you. Dynamic scaling ensures leverage is lowest precisely when the risk of squeeze is highest.

### Execution Cost Control

| Component | Value |
|-----------|-------|
| Drift taker fee | 0.035% per trade |
| Estimated slippage | 0.05% per trade |
| Round-trip cost | 0.17% (2 × (fee + slippage)) |
| Min hold period for cost amortization | 24 hours |
| Break-even at 10% APY funding | ~15 hours |
| Break-even at 5% APY funding | ~30 hours |

**Why cost gates matter**: Without them, the bot can enter a 6% APY market, pay 0.17% round-trip costs, exit when funding drops after 4 hours (earning 0.003%), and repeat — losing money on every rotation.

### Health Ratio Monitoring

| Level | Health Ratio | Action |
|-------|-------------|--------|
| Healthy | > 1.15 | Normal operation |
| Warning | 1.08 – 1.15 | Reduce largest position |
| Critical | < 1.08 | Emergency close all |
| Liquidatable | < 1.0 | Drift liquidates (should never reach this) |

Monitored every **30 seconds** — 240x more frequent than the hourly rebalance. This catches rapid deterioration from price spikes before the next scheduled rebalance.

### Position Sizing

| Parameter | Value | Description |
|-----------|-------|-------------|
| Lending floor | 30% | Always allocated — bear market buffer |
| Basis pool | 70% | Dynamically allocated (scaled by leverage) |
| Max per market | 40% | Fewer markets = higher concentration ok |
| Max markets | 3 | Top 3 cost-viable only |
| Max leverage | 2x | Hard ceiling |

### Drawdown Management

- **3% drawdown**: Reduce positions — close the worst-performing
- **5% drawdown**: Emergency close all — 100% to lending
- **Recovery**: Positions re-entered after drawdown recovers and regime permits

### What We Don't Do

- **No leverage looping** — No borrowing against collateral recursively
- **No DEX LP** — No impermanent loss exposure
- **No yield-bearing stables** — No circular yield dependencies
- **No illiquid altcoins** — Max 3 markets, all must pass liquidity filters
- **No fixed leverage** — Leverage adapts to market conditions

## Expected Returns

| Market Condition | Vol Regime | Leverage | Direction | Expected APY | Revenue Sources |
|-----------------|-----------|----------|-----------|-------------|----------------|
| Bull (longs dominant) | Low | 1.5x | SHORT | 20-30% | Funding + premium convergence + OI + lending |
| Neutral | Normal | 1.0x | Signal-based | 12-18% | Funding + lending |
| Bear (shorts dominant) | High | 0.5x | LONG | 8-12% | Funding + discount convergence + lending |
| Crisis (extreme vol) | Extreme | 0x | None | 1-3% | Lending only |

**Kuma v3 earns in all market conditions.** In bull markets, the composite signal triggers SHORT positions that collect funding and earn premium convergence. In bear markets, the signal flips to LONG — collecting negative funding from shorts. The lending floor (30%) provides base yield even when all signals are neutral.

### Backtest Limitation

The Drift Data API provides historical funding rates per market, but does not provide historical OI snapshots or mark/oracle price series at the same granularity. The backtest therefore reflects **funding-based revenue only**.

The OI imbalance and mark/oracle premium signals are:
- **Implemented and validated** via live devnet testing against real-time Drift market data
- **Not historically backtestable** with available data sources
- **Expected to increase returns** beyond the funding-only backtest numbers by capturing premium convergence alpha

The backtest's 6.97% APY should be viewed as a **conservative lower bound** — the full multi-signal strategy targets 20-30% APY.

## Backtest Results (Feb 12 – Mar 15, 2026)

32-day backtest comparing v1 (taker orders) and v2 (maker limit orders):

| Metric | v1 (Taker) | v2 (Maker) |
|--------|-----------|-----------|
| Starting equity | $100,000 | $100,000 |
| Ending equity | $98,977 | **$100,611** |
| Total return | -1.02% | **+0.61%** |
| Annualized APY | -11.67% | **+6.97%** |
| Max drawdown | 1.02% | **0.01%** |
| Sharpe ratio | -7.53 | **28.09** |
| Trading costs | $2,014 | **$210** (-90%) |
| Basis earnings | $913 | $742 |
| Lending earnings | $79 | $79 |

**What changed in v2**: Switched from market orders (0.035% taker fee) to limit orders (-0.002% maker rebate). Round-trip cost dropped from 17 bps to 1.6 bps. Also blocked low-liquidity alts (1MBONK, CLOUD, MET) and added strict market whitelist (SOL/BTC/ETH/DOGE/SUI/AVAX with $5M OI minimum).

**Why v2 is profitable in the same hostile period**: The funding earned ($742) now exceeds trading costs ($210) because maker orders eliminate the fee drag that destroyed v1's returns. The strategy generates alpha even with SOL-PERP negative funding throughout.

**Market selection (v2)**: DOGE-PERP 63%, SUI-PERP 41%, AVAX-PERP 41% — the bot correctly shifted to Tier 2 markets with positive funding while avoiding SOL-PERP.

**6.97% APY is below the 10% target** — this reflects a hostile period with high vol (0.5x leverage) and negative SOL funding. In normal conditions with low/moderate vol (1.5-2x leverage) and positive funding across major markets, the strategy targets 10-20% APY.

## Implementation Details

### Technology

- **Vault infrastructure**: Voltr (Ranger Earn) — deposits, LP shares, fee collection
- **Trading**: Drift Protocol v2 — perpetual futures execution
- **Keeper**: TypeScript bot with 30-second tick loop
- **Vol computation**: Parkinson estimator on SOL-PERP hourly candles
- **Data feed**: Drift Data API — funding rates, OHLC candles
- **RPC**: QuickNode

### Keeper Loop Architecture

```
Main Loop (30-second tick)
├── Every 30s:  Emergency checks (health ratio + drawdown)
├── Every 15m:  Funding scan + leverage update
├── Every 1h:   Full rebalance cycle
│   ├── Apply cost gate to ranked markets
│   ├── Scale targets by dynamic leverage
│   ├── Close underperforming positions
│   └── Open new positions in top 3
└── Every 30s:  Heartbeat log (equity, positions, regime)
```

### Execution Flow

1. **Deposit**: User deposits USDC → Voltr vault mints LP tokens
2. **Allocation**: Manager deposits USDC to Drift via adaptor
3. **Leverage check**: Keeper computes current vol → determines leverage multiplier
4. **Cost check**: Keeper evaluates each market's funding vs. trading costs
5. **Trading**: Keeper places SHORT perp orders (size = allocation × leverage)
6. **Monitoring**: 30-second health + drawdown checks; 15-minute funding scans
7. **Funding**: Short positions accumulate funding payments hourly
8. **NAV update**: Vault NAV reflects Drift account equity
9. **Withdrawal**: User requests → 24h cooldown → receives USDC
