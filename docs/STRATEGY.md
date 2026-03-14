# Kuma Vault — Strategy Documentation

## Thesis

Perpetual futures funding rates on Solana are structurally positive. Leveraged long demand from retail and systematic traders creates persistent yield for short positions. Kuma captures this yield systematically across all Drift perp markets while maintaining a lending floor that provides base yield even when funding compresses.

**Core insight**: The basis trade (long spot + short perp) is the simplest form of delta-neutral yield on-chain. What makes Kuma different is the **multi-market rotation** — instead of statically shorting SOL-PERP, Kuma dynamically allocates across 70+ markets, always chasing the highest risk-adjusted funding.

## How It Works

### Capital Allocation

```
Total Vault Capital
├── 20% → Lending Floor (Drift Earn — USDC spot lending)
│         Provides ~1-5% APY base yield regardless of funding environment
│
└── 80% → Basis Trade Pool
          ├── Funding Scanner (hourly)
          │   └── Fetches rates for all 70+ Drift perp markets
          │   └── Filters: positive 24h + 7d + 30d funding (≥2 of 3)
          │   └── Ranks by weighted score: 40% × 24h + 35% × 7d + 25% × 30d
          │
          ├── Allocation Engine
          │   └── Selects top 5 markets by score
          │   └── Weights allocation proportional to annualized funding
          │   └── Caps any single market at 30% of total equity
          │
          └── Position Manager
              └── Opens SHORT perps via Drift SDK
              └── Monitors funding rate per position
              └── Exits when 24h funding < -1% (annualized)
```

### Entry Criteria

A market is eligible for a basis position when:
1. Annualized funding rate ≥ 5% (500 bps)
2. Funding is positive in at least 2 of 3 timeframes (24h, 7d, 30d)
3. Total portfolio wouldn't exceed 5x leverage after the new position

### Exit Criteria

A position is closed when:
1. 24h funding rate drops below -1% (annualized)
2. Portfolio drawdown exceeds 5%
3. A higher-yielding market becomes available and the position's market drops out of top 5

### Rebalancing

Every 4 hours, the keeper:
1. Fetches current funding rates for all markets
2. Re-ranks markets by the weighted score
3. Closes positions in markets that fell out of top 5 or turned negative
4. Opens new positions in markets that entered top 5
5. Adjusts position sizes to match target allocation weights

## Risk Management

### Position Sizing

| Parameter | Value | Description |
|-----------|-------|-------------|
| Lending floor | 20% | Always allocated — provides base yield |
| Basis pool | 80% | Dynamically allocated to short perps |
| Max per market | 30% | Concentration limit per single market |
| Max markets | 5 | Diversification across funding sources |
| Target leverage | 3x | Default operating leverage |
| Max leverage | 5x | Hard ceiling — never exceeded |

### Drawdown Management

- **5% drawdown trigger**: All basis positions reduced by 50%
- **8% drawdown trigger**: All basis positions closed, 100% to lending
- **Recovery**: Positions re-entered gradually after 24h recovery period

### Funding Rate Monitoring

- Rates scanned hourly across all 70+ markets
- Position-level exit at -1% annualized funding
- Portfolio-level pause when >50% of active markets turn negative
- Historical rate analysis (7d, 30d) used to filter out noisy short-term spikes

### What We Don't Do

- **No leverage looping** — Health ratio is never at risk (no borrowing against positions)
- **No DEX LP** — No impermanent loss exposure
- **No yield-bearing stables** — No circular yield dependencies
- **No concentrated positions** — 30% cap per market, 5 market maximum

## Expected Returns

| Market Condition | Expected APY | Components |
|-----------------|-------------|------------|
| Bull market (strong positive funding) | 15-25% | Lending 3% + Basis 12-22% |
| Neutral market (moderate funding) | 10-15% | Lending 3% + Basis 7-12% |
| Bear market (compressed/negative funding) | 3-8% | Lending 3-5% + Basis 0-3% |
| Worst case (all funding negative) | 1-5% | Lending only |

**The lending floor ensures Kuma never returns zero.** Even in the worst funding environment, idle USDC earns lending yield.

## Implementation Details

### Technology

- **Vault infrastructure**: Voltr (Ranger Earn) — handles deposits, LP shares, fee collection
- **Trading**: Drift Protocol v2 — perpetual futures execution
- **Keeper**: TypeScript bot running on dedicated server
- **Data feed**: Drift Data API — funding rates, market data
- **RPC**: Helius — transaction submission

### Execution Flow

1. **Deposit**: User deposits USDC → Voltr vault mints LP tokens
2. **Allocation**: Manager deposits USDC to Drift via adaptor
3. **Trading**: Keeper places SHORT perp orders via DriftClient SDK
4. **Funding**: Short positions accumulate funding payments hourly
5. **NAV update**: Vault NAV reflects Drift account equity
6. **Withdrawal**: User requests withdrawal → 24h cooldown → receives USDC

### Monitoring

- Keeper logs heartbeat every 60 seconds
- Funding rate scan results logged hourly
- Position changes logged with market, size, and reason
- Error handling with automatic retry on transient failures
