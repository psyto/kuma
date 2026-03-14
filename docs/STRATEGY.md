# Kuma Vault — Strategy Documentation

## Thesis

Perpetual futures funding rates on Solana are structurally positive. Leveraged long demand from retail and systematic traders creates persistent yield for short positions. Kuma captures this yield systematically while maintaining a lending floor that provides base yield even when funding compresses.

**Core insight**: The basis trade is well-understood, but most implementations use fixed leverage, ignore execution costs, and react too slowly to regime changes. Kuma differentiates through **dynamic leverage scaling**, **cost-aware market selection**, and **30-second health monitoring** — treating risk management as the primary product, not an afterthought.

## How It Works

### Capital Allocation

```
Total Vault Capital
├── 30% → Lending Floor (Drift Earn — USDC spot lending)
│         Provides ~1-5% APY base yield regardless of funding environment
│         Acts as buffer during bear markets
│
└── 70% → Basis Trade Pool
          ├── Funding Scanner (every 15 min)
          │   ├── Fetches rates for all Drift perp markets
          │   ├── Filters: positive funding in ≥2 of 3 timeframes (24h, 7d, 30d)
          │   └── Ranks by weighted score: 40% × 24h + 35% × 7d + 25% × 30d
          │
          ├── Cost Gate
          │   ├── Computes: (funding × hold_period) - 2 × (fee + slippage)
          │   └── Rejects markets where round-trip costs exceed expected funding
          │
          ├── Leverage Controller (every 15 min)
          │   ├── Computes realized vol from SOL-PERP candles (Parkinson estimator)
          │   └── Scales leverage: 2x in low vol → 0x in extreme vol
          │
          ├── Allocation Engine
          │   ├── Selects top 3 cost-viable markets
          │   ├── Weights allocation proportional to annualized funding
          │   └── Caps any single market at 40% of total equity
          │
          └── Position Manager
              ├── Opens SHORT perps via Drift SDK (scaled by dynamic leverage)
              ├── Monitors funding rate and health ratio continuously
              └── Exits when funding < -0.5% or health ratio < 1.15
```

### Entry Criteria

A market is eligible for a basis position when ALL of the following are met:
1. Annualized funding rate ≥ 5% (500 bps)
2. Funding is positive in at least 2 of 3 timeframes (24h, 7d, 30d)
3. **Cost gate passes**: Expected funding over 24h hold > round-trip trading costs (0.17%)
4. Current vol regime allows leverage > 0 (not extreme)
5. Portfolio health ratio > 1.15 after the new position

### Exit Criteria

A position is closed when ANY of the following occur:
1. 24h funding rate drops below -0.5% (annualized) — tighter than typical basis vaults
2. Portfolio drawdown exceeds 3% (reduce) or 5% (close all)
3. Health ratio drops below 1.15 (reduce largest position) or 1.08 (emergency close all)
4. Vol regime transitions to extreme (0x leverage = all positions closed)
5. A cost-viable higher-yielding market displaces this market from top 3

### Rebalancing

Every 1 hour, the keeper:
1. Checks health ratio and drawdown (emergency path if critical)
2. Updates realized vol and dynamic leverage target
3. Fetches current funding rates and applies cost gate
4. Closes positions in markets that fail the cost gate or turned negative
5. Opens new positions in markets that entered top 3 (scaled by leverage)

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

| Market Condition | Vol Regime | Leverage | Expected APY | Components |
|-----------------|-----------|----------|-------------|------------|
| Bull (strong positive funding) | Low | 1.5x | 12-20% | Lending 3% + Basis 9-17% |
| Neutral (moderate funding) | Normal | 1.0x | 8-12% | Lending 3% + Basis 5-9% |
| Bear (compressed/negative funding) | High | 0.5x | 3-6% | Lending 3% + Basis 0-3% |
| Crisis (extreme vol) | Extreme | 0x | 1-3% | Lending only |

**The lending floor ensures Kuma never returns zero.** Even in the worst environment, idle USDC earns lending yield. The dynamic leverage prevents the basis trade from becoming a liability during turbulent markets.

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
