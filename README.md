# 🐻 Kuma Vault

**Drift AMM Imbalance Arbitrage + Lending Floor on Solana.**

Kuma guards your yield. A USDC vault that captures three Drift-native inefficiencies — OI imbalance, mark/oracle premium convergence, and funding rate harvesting — while maintaining a 30% lending floor for downside protection.

## Strategy

Kuma splits vault capital between two yield sources:

1. **Lending Floor (30%)** — Idle USDC earns base yield via Drift Earn (spot lending)
2. **Imbalance Arbitrage (70%)** — Captures three Drift-native inefficiencies:
   - **OI Imbalance** → positions ahead of funding rate changes
   - **Mark/Oracle Premium** → convergence trades (premium mean-reverts to zero)
   - **Funding Rate** → direct collection (bidirectional — SHORT or LONG)

The keeper bot scans Drift market data every 30 minutes, computes a weighted composite signal from all three sources, determines entry direction (SHORT when mark > oracle + long-heavy OI, LONG when mark < oracle + short-heavy OI), and scales position size by dynamic leverage.

### How It Works

```
User deposits USDC → Voltr Vault
                      ├── 30% → Drift Earn (lending floor)
                      └── 70% → Drift Perps (imbalance arbitrage)
                                 ├── Scan OI, premium, funding (30 min)
                                 ├── Composite signal: 50% funding + 30% premium + 20% OI
                                 ├── Direction: SHORT if mark > oracle, LONG if mark < oracle
                                 ├── Cost gate: maker orders (rebate, not fee)
                                 ├── Dynamic leverage by vol regime
                                 ├── Health check every 30 seconds
                                 └── Low turnover: 7-day min hold, max 2 rotations/week
```

### Why AMM Imbalance Arbitrage

Drift's hybrid AMM creates three structural inefficiencies that mean-revert:

1. **OI Imbalance** — When longs dominate, funding rises. Positioning ahead captures the funding before it normalizes.
2. **Mark/Oracle Premium** — When mark price deviates from oracle, it converges back. A short when mark > oracle profits from convergence AND earns funding.
3. **Funding Rate** — Direct payment from the dominant side to the minority side. Bidirectional — SHORT when positive, LONG when negative.

Key advantages:
- **Three revenue sources** — Not dependent on a single variable (funding alone)
- **Drift-native** — Uses on-chain data only available on Drift (OI, mark price, AMM state)
- **Bidirectional** — Earns in bull AND bear markets
- **Maker orders** — Earns fee rebates (-0.002%) instead of paying taker fees (0.035%)

## Architecture

![Kuma Architecture](docs/architecture.svg)

### Components

| Module | File | Purpose |
|--------|------|---------|
| Imbalance Detector | `src/keeper/imbalance-detector.ts` | Reads OI, mark/oracle spread, funding — computes composite signal and direction |
| Funding Scanner | `src/keeper/funding-scanner.ts` | Fetches and ranks all Drift perp markets by funding rate |
| Cost Calculator | `src/keeper/cost-calculator.ts` | Evaluates trade economics with maker fee model |
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

A position is only opened if `net_profit > 0` over the minimum holding period. This prevents **fee churn** — where frequent rotation eats more in trading costs than the harvested funding.

| Cost Component | Taker (v1) | Maker (v2) |
|----------------|-----------|-----------|
| Drift fee | 0.035% (pay) | -0.002% (rebate) |
| Estimated slippage | 0.05% | 0.01% |
| Round-trip cost | 0.17% | **0.016%** |
| Break-even (24h hold) | 62% APY | 5.8% APY |
| Break-even (7-day hold) | 8.9% APY | **0.83% APY** |

v2 uses `postOnly` limit orders to ensure maker execution. The cost gate threshold drops by 10x, making most positive-funding markets profitable.

## Risk Management

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Max drawdown | 3% / 5% severe | Reduces positions at 3%, closes all at 5% |
| Max leverage | 2x hard cap | Dynamic: 2x in low vol → 0x in extreme vol |
| Leverage by regime | 2x/1.5x/1x/0.5x/0x | Scales inversely with realized volatility |
| Max per market | 40% | Concentrated in high-quality markets only |
| Max simultaneous markets | 3 | Top 3 only — avoids illiquid altcoins |
| Min funding to enter | 5% APY + cost gate | Must exceed round-trip fees over hold period |
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

## Bear Market Resilience

Unlike simple basis trade vaults that only short perps, Kuma v3 trades **both directions** based on the composite imbalance signal:

| Market Condition | OI Imbalance | Premium | Funding | Kuma Direction | Revenue Sources |
|-----------------|-------------|---------|---------|---------------|----------------|
| Bull (longs dominant) | Long-heavy | Mark > Oracle | Positive | **SHORT** | Funding + premium convergence |
| Bear (shorts dominant) | Short-heavy | Mark < Oracle | Negative | **LONG** | Funding + discount convergence |
| Sideways | Balanced | ~0 | Low | **None or small** | Lending floor only |
| Extreme vol | Any | Volatile | Any | **None** | Lending floor (30%) |

The lending floor (30%) ensures base yield even when the imbalance signals are neutral.

## Backtest Results

32-day backtest (Feb 12 – Mar 15, 2026) — hostile period with negative SOL funding:

| Metric | v1 (Taker, short only) | v2 (Maker, short only) | v3 (Maker, multi-signal) |
|--------|----------------------|----------------------|------------------------|
| Total return | -1.02% | +0.61% | **+0.61%** |
| Annualized APY | -11.67% | +6.97% | **+6.97%** |
| Max drawdown | 1.02% | 0.01% | **0.01%** |
| Trading costs | $2,014 | $210 | **$210** |
| Sharpe ratio | -7.53 | 28.09 | **28.09** |
| Entry signals | Funding only | Funding only | **Funding + OI + premium** |
| Direction | Short only | Short only | **Bidirectional** |

v3 adds the imbalance detector for **smarter entry timing and direction** — the composite signal determines whether to SHORT (mark > oracle + long-heavy OI) or LONG (mark < oracle + short-heavy OI).

**Backtest limitation**: The Drift Data API provides historical funding rates but not historical OI or mark/oracle snapshots. The backtest therefore reflects funding-based entry only. The imbalance signals (OI + premium) are validated via live devnet testing against real-time Drift market data, but cannot be historically backtested with available data sources.

**Target APY: 20-30%** in normal conditions with three active revenue sources. The backtest's 6.97% APY reflects funding-only revenue in a hostile period — with OI and premium convergence signals active, returns are expected to be higher.

See [docs/STRATEGY.md](docs/STRATEGY.md) for detailed analysis.

## Fees

| Fee | Amount |
|-----|--------|
| Management fee | 1% annual |
| Performance fee | 20% of profits |
| Deposit fee | None |
| Withdrawal fee | 0.1% |
| Withdrawal period | 24 hours |

## Testing

**24 unit tests** covering all strategy modules:

```bash
npm test
```

Tests validate:
- **Cost calculator** — Maker fee model (1.6 bps round-trip), break-even analysis, cost gate
- **Leverage controller** — Regime classification, leverage scaling, boundary conditions
- **Funding scanner** — Market filtering with whitelist/blacklist, ranking, exclusion

Additional modules (imbalance detector, position manager with bidirectional entry) are validated via devnet integration tests.

**Devnet integration tests** validate end-to-end against live Drift:

```bash
npm run test:devnet      # Basic connection + funding scan
node dist/scripts/test-devnet-trading.js  # Full trading flow
```

## Demo & Dashboard

- **Pitch video**: `demo/kuma-demo.mp4` — 80-second presentation (8 slides × 10s) covering strategy, architecture, risk controls, and backtest results
- **Live dashboard**: Open `demo/dashboard.html` in any browser — fetches real Drift funding rates and displays regime, cost gate status, and keeper log. No server required.

```bash
# Preview
open demo/dashboard.html
open demo/kuma-demo.mp4
```

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
# Edit .env with your RPC URL and keypair paths
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

## Tech Stack

- **On-chain**: [Voltr Vault](https://docs.ranger.finance) + [Drift Protocol v2](https://docs.drift.trade)
- **Off-chain**: TypeScript keeper bot with dynamic risk controls
- **Data**: [Drift Data API](https://data.api.drift.trade) for funding rates and OHLC candles
- **RPC**: QuickNode (or any Solana RPC provider)

## Hackathon

Built for the [Ranger Build-A-Bear Hackathon](https://ranger.finance/build-a-bear-hackathon) (Mar 9 – Apr 6, 2026).

- **Track**: Main + Drift Side Track
- **Base asset**: USDC
- **Target APY**: 20-30% (Drift AMM imbalance arbitrage)
- **Edge**: Three Drift-native signals (OI + premium + funding), bidirectional, bear resilient
- **Revenue**: Funding + premium convergence + OI rebalancing + lending floor
- **Lock period**: 3-month rolling

## License

MIT
