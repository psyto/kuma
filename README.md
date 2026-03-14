# 🐻 Kuma Vault

**Lending floor + Drift basis trade alpha on Solana.**

Kuma guards your yield. A USDC vault that combines a lending floor with Drift perpetual funding rate harvesting — delivering consistent alpha with downside protection through dynamic leverage control and 30-second health monitoring.

## Strategy

Kuma splits vault capital between two yield sources:

1. **Lending Floor (30%)** — Idle USDC earns base yield via Drift Earn (spot lending)
2. **Basis Trade Alpha (70%)** — Short perpetual positions on Drift collect positive funding rates

The keeper bot scans Drift perp markets every 15 minutes, applies a cost gate to filter out unprofitable rotations, scales leverage dynamically with market volatility, and monitors health ratio every 30 seconds.

### How It Works

```
User deposits USDC → Voltr Vault
                      ├── 30% → Drift Earn (lending floor)
                      └── 70% → Drift Perps (basis trades)
                                 ├── Scan markets every 15 min
                                 ├── Cost gate: funding > fees
                                 ├── Enter top 3 cost-viable markets
                                 ├── Dynamic leverage by vol regime
                                 ├── Health check every 30 seconds
                                 └── Exit when funding < -0.5%
```

### Why Basis Trading

When funding rates are positive (the typical state — longs pay shorts), short perp positions earn yield without directional exposure. The vault holds USDC as the "long spot" side, making it inherently delta-neutral on each position.

Key advantages:
- **No impermanent loss** — Unlike DEX LP vaults
- **No leverage looping** — Health ratio actively monitored, never at risk
- **Cost-aware rotation** — Only enters markets where expected funding exceeds round-trip trading costs
- **Volatility-adaptive** — Leverage scales inversely with market volatility

## Architecture

```
┌──────────────────────────────────────────┐
│  Voltr Vault (on-chain)                  │
│  Deposits, withdrawals, LP shares        │
│  Fee collection, NAV tracking            │
├──────────────────────────────────────────┤
│  Drift Adaptor (on-chain)                │
│  Bridges vault ↔ Drift protocol          │
├──────────────────────────────────────────┤
│  Kuma Keeper Bot (off-chain)             │
│  ├── Emergency Monitor (30s loop)        │
│  │   ├── Health ratio check              │
│  │   └── Drawdown check                  │
│  ├── Leverage Controller (15 min)        │
│  │   ├── Fetch SOL realized vol          │
│  │   └── Scale leverage by regime        │
│  ├── Funding Scanner (15 min)            │
│  │   ├── Fetch rates for all markets     │
│  │   └── Cost gate: filter unprofitable  │
│  ├── Position Manager (1 hour)           │
│  │   ├── Compute target allocations      │
│  │   ├── Open/close basis positions      │
│  │   └── Apply leverage scaling          │
│  └── Rebalancer (1 hour)                 │
│       └── Rotate between top markets     │
└──────────────────────────────────────────┘
```

### Components

| Module | File | Purpose |
|--------|------|---------|
| Funding Scanner | `src/keeper/funding-scanner.ts` | Fetches and ranks all Drift perp markets by funding rate |
| Cost Calculator | `src/keeper/cost-calculator.ts` | Evaluates trade economics — filters markets where fees exceed funding |
| Leverage Controller | `src/keeper/leverage-controller.ts` | Dynamic leverage scaling based on realized volatility regime |
| Health Monitor | `src/keeper/health-monitor.ts` | 30-second health ratio and drawdown checks |
| Position Manager | `src/keeper/position-manager.ts` | Computes target allocations, opens/closes positions |
| Keeper Loop | `src/keeper/index.ts` | Main event loop — emergency checks, scan, rebalance |
| Vault Setup | `src/scripts/` | Admin scripts to initialize Voltr vault + Drift adaptor |
| Config | `src/config/` | Strategy parameters, program IDs, vault settings |

## Dynamic Leverage Control

Leverage scales inversely with realized volatility, computed from SOL-PERP hourly candles using the Parkinson estimator:

| Vol Regime | Realized Vol | Leverage | Rationale |
|------------|-------------|----------|-----------|
| Very Low | < 20% | 2.0x | Calm markets — safe to use moderate leverage |
| Low | 20-35% | 1.5x | Normal conditions |
| Normal | 35-50% | 1.0x | Elevated activity — conservative |
| High | 50-75% | 0.5x | Turbulent — minimal exposure |
| Extreme | > 75% | 0x | Shut down — no positions |

This addresses the critical finding that fixed leverage (3-5x) is reckless during volatility spikes. During a short squeeze, lower leverage preserves health ratio margin.

## Execution Cost Gate

Every market rotation is evaluated against trading costs before entry:

```
Net profit = (annualized_funding × hold_period / 8760) - 2 × (taker_fee + slippage)
```

A position is only opened if `net_profit > 0` over the minimum 24-hour holding period. This prevents **fee churn** — where frequent rotation eats more in trading costs than the harvested funding.

| Cost Component | Value |
|----------------|-------|
| Drift taker fee | 0.035% per trade |
| Estimated slippage | 0.05% per trade |
| Round-trip cost | 0.17% (2 × fees + slippage) |
| Break-even at 10% APY | ~15 hours |
| Break-even at 5% APY | ~30 hours |

## Risk Management

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Max drawdown | 3% / 5% severe | Reduces positions at 3%, closes all at 5% |
| Max leverage | 2x hard cap | Dynamic: 2x in low vol → 0x in extreme vol |
| Leverage by regime | 2x/1.5x/1x/0.5x/0x | Scales inversely with realized volatility |
| Max per market | 40% | Concentrated in high-quality markets only |
| Max simultaneous markets | 3 | Top 3 only — avoids illiquid altcoins |
| Min funding to enter | 5% APY + cost gate | Must exceed round-trip fees over 24h hold |
| Exit threshold | -0.5% funding | Tighter exit — early response to reversals |
| Health ratio warning | 1.15 | Start reducing positions |
| Health ratio critical | 1.08 | Emergency close all |
| Health check interval | 30 seconds | Near real-time monitoring |
| Rebalance interval | 1 hour | Position adjustment |
| Funding scan interval | 15 minutes | Rate monitoring |

### What Can Go Wrong

| Risk | Mitigation |
|------|------------|
| Funding rates turn negative (bear market) | Lending floor (30%) provides base yield; cost gate prevents entering negative-yield markets |
| Short squeeze (sudden price surge) | Dynamic leverage reduces exposure as vol rises; health monitor triggers emergency close at 1.08 |
| Fee churn from rotation | Cost gate ensures expected funding exceeds round-trip costs before entry |
| Illiquid altcoin price deviation | Max 3 markets, filtered by open interest — only high-liquidity pairs |
| Drift protocol / smart contract risk | Uses battle-tested Voltr vault infrastructure and Drift adaptor |
| Correlated market crash | All crypto moves together — drawdown limits (3%/5%) force position closure before catastrophic loss |

## Fees

| Fee | Amount |
|-----|--------|
| Management fee | 1% annual |
| Performance fee | 20% of profits |
| Deposit fee | None |
| Withdrawal fee | 0.1% |
| Withdrawal period | 24 hours |

## Setup

### Prerequisites

- Node.js 18+
- Solana CLI
- Funded wallets (SOL for gas, USDC for vault deposits)

### Installation

```bash
git clone https://github.com/psyto/kuma.git
cd kuma
npm install
cp .env.example .env
# Edit .env with your keypair paths and RPC URL
```

### Deploy Vault

```bash
# 1. Initialize Voltr vault
npm run admin:init-vault

# 2. Add Drift adaptor
npm run admin:add-adaptor

# 3. Initialize Drift trading strategy
npm run manager:init-strategy

# 4. Start the keeper bot
npm run keeper
```

### Development

```bash
# Build TypeScript
npm run build

# Run devnet tests
npm run test:devnet

# Watch mode for keeper development
npm run keeper:dev
```

## Tech Stack

- **On-chain**: [Voltr Vault](https://docs.ranger.finance) + [Drift Protocol v2](https://docs.drift.trade)
- **Off-chain**: TypeScript keeper bot with dynamic risk controls
- **Data**: [Drift Data API](https://data.api.drift.trade) for funding rates and OHLC candles
- **RPC**: Helius

## Hackathon

Built for the [Ranger Build-A-Bear Hackathon](https://ranger.finance/build-a-bear-hackathon) (Mar 9 – Apr 6, 2026).

- **Track**: Main + Drift Side Track
- **Base asset**: USDC
- **Target APY**: 10-20% (lending floor + basis alpha)
- **Lock period**: 3-month rolling

## License

MIT
