# 🐻 Kuma Vault

**Lending floor + Drift basis trade alpha on Solana.**

Kuma guards your yield. A USDC vault that combines a lending floor with Drift perpetual funding rate harvesting — delivering consistent alpha with downside protection.

## Strategy

Kuma splits vault capital between two yield sources:

1. **Lending Floor (20%)** — Idle USDC earns base yield via Drift Earn (spot lending)
2. **Basis Trade Alpha (80%)** — Short perpetual positions on Drift collect positive funding rates

The keeper bot scans all 70+ Drift perp markets hourly, ranks them by annualized funding rate, and allocates capital to the top opportunities. When funding turns negative, positions are closed automatically.

### How It Works

```
User deposits USDC → Voltr Vault
                      ├── 20% → Drift Earn (lending floor)
                      └── 80% → Drift Perps (short funding)
                                 ├── Scan 70+ markets hourly
                                 ├── Rank by annualized funding
                                 ├── Enter top 5 markets
                                 └── Exit when funding < -1%
```

### Why Basis Trading

When funding rates are positive (the typical state — longs pay shorts), short perp positions earn yield without directional exposure. The vault holds USDC as the "long spot" side, making it inherently delta-neutral on each position.

Key advantages:
- **No impermanent loss** — Unlike DEX LP vaults
- **No leverage looping** — Health ratio is never at risk
- **Multi-market diversification** — Spreads risk across up to 5 markets simultaneously
- **Automatic rotation** — Exits underperforming markets, enters new opportunities

## Architecture

```
┌─────────────────────────────────────┐
│  Voltr Vault (on-chain)             │
│  Deposits, withdrawals, LP shares   │
│  Fee collection, NAV tracking       │
├─────────────────────────────────────┤
│  Drift Adaptor (on-chain)           │
│  Bridges vault ↔ Drift protocol     │
├─────────────────────────────────────┤
│  Kuma Keeper Bot (off-chain)        │
│  ├── Funding Scanner                │
│  │   └── Fetches rates for all      │
│  │       Drift perp markets         │
│  ├── Position Manager               │
│  │   └── Opens/closes basis trades  │
│  │       based on funding signals   │
│  └── Rebalancer                     │
│       └── Adjusts allocations       │
│           every 4 hours             │
└─────────────────────────────────────┘
```

### Components

| Module | File | Purpose |
|--------|------|---------|
| Funding Scanner | `src/keeper/funding-scanner.ts` | Fetches and ranks all Drift perp markets by funding rate |
| Position Manager | `src/keeper/position-manager.ts` | Computes target allocations, opens/closes positions |
| Keeper Loop | `src/keeper/index.ts` | Main event loop — scan, rebalance, monitor |
| Vault Setup | `src/scripts/` | Admin scripts to initialize Voltr vault + Drift adaptor |
| Config | `src/config/` | Strategy parameters, program IDs, vault settings |

## Risk Management

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Max drawdown | 5% | Reduces all positions if breached |
| Max leverage | 5x | Conservative — never exceeds 5x |
| Target leverage | 3x | Default operating leverage |
| Max per market | 30% | No single market concentration |
| Max simultaneous markets | 5 | Diversification across funding sources |
| Min funding to enter | 5% APY | Only trade markets with meaningful yield |
| Exit threshold | -1% funding | Close position when funding turns negative |
| Rebalance interval | 4 hours | Periodic position adjustment |
| Funding scan interval | 1 hour | Rate monitoring frequency |

### What Can Go Wrong

| Risk | Mitigation |
|------|------------|
| Funding rates turn negative across all markets | Lending floor provides ~1-5% base yield even with zero basis positions |
| Sudden funding rate spike (short squeeze) | Max position sizing limits exposure; exit triggers at -1% |
| Drift protocol risk | Drift is the largest perp DEX on Solana with $170M+ vault TVL |
| Smart contract risk | Uses battle-tested Voltr vault infrastructure and Drift adaptor |

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
- **Off-chain**: TypeScript keeper bot
- **Data**: [Drift Data API](https://data.api.drift.trade) for funding rates
- **RPC**: Helius

## Hackathon

Built for the [Ranger Build-A-Bear Hackathon](https://ranger.finance/build-a-bear-hackathon) (Mar 9 – Apr 6, 2026).

- **Track**: Main + Drift Side Track
- **Base asset**: USDC
- **Target APY**: 12-20% (lending floor + basis alpha)
- **Lock period**: 3-month rolling

## License

MIT
