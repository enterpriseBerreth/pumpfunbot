# PUMPFUNBOT

Automated Pump.fun trading bot with paper trading, trailing exits, and Telegram alerts.

## Features

- **Real-time Pump.fun scanning** via PumpPortal WebSocket
- **Smart entry criteria**: Requires 3+ unique buyers (excluding developer) and 10s+ token age
- **Paper trading mode** with $100 starting budget
- **Structured paper-trade telemetry** for candidate decisions, missed-entry follow-ups, and exit quality
- **$10 per trade** with intelligent position sizing
- **Tiered take-profit**: Sells at +50%, +75%, +100% to lock in gains
- **Moon bag strategy**: Rides remaining 25% with trailing stops for max profit
- **Adaptive trailing stops**: Tightens as profit grows (25% -> 18% -> 15% -> 10% -> 8%)
- **Telegram alerts**: Real-time notifications for every buy, sell, and partial sell with PNL
- **Railway compatible**: Deploy and run 24/7

## Quick Start

### 1. Clone & Install

```bash
git clone <repo-url>
cd pumpfunbot
npm install
```

### 2. Configure Environment

Copy the template and fill in your values:

```bash
cp env.template .env
```

Required environment variables:
- `TELEGRAM_BOT_TOKEN` - Create a bot via [@BotFather](https://t.me/BotFather)
- `TELEGRAM_CHAT_ID` - Your chat ID (use [@userinfobot](https://t.me/userinfobot))

### 3. Run

```bash
# Paper trading (default, safe)
npm start

# Development mode with auto-reload
npm run dev
```

## Trading Strategy

### Entry Criteria
- Token launched on Pump.fun
- At least **7 unique buyers** (developer wallet excluded)
- Token is at least **15 seconds old** (avoids instant rugs)
- Token is 15 seconds to 5 minutes old (catches early momentum without entering immediately)
- At least **8% market-cap growth** and **three consecutive +3% market-cap updates**
- Buy/sell ratio of at least **1.6:1**
- Rejects tokens after more than **250% cumulative growth** or a single **20%** price spike (anti-chase protection)
- Rejects entries above **120 SOL** market cap and repeat launches by the same developer within 30 minutes
- No more than **5 concurrent positions**

### Exit Strategy
| Trigger | Action |
|---------|--------|
| 4 consecutive unique sellers | Full sell |
| +40% gain | Full sell |
| 5% rapid dump | Full sell |
| 6% decline from peak after a 12% gain | Full sell |
| 15% loss | Full sell |

### Capital Protection
- Pause new entries after **$100** of realized paper losses in a UTC day; resumes automatically at the next UTC day.
- Per-trade lesson telemetry remains on; automatic parameter experiments are disabled unless explicitly enabled.
- Uses **$10** base paper positions; only high-conviction signals qualify for the **$20** size.

### Trailing Stop Tiers
| Profit Level | Trail Distance |
|-------------|---------------|
| +30% | 25% from peak |
| +100% | 18% from peak |
| +250% | 15% from peak |
| +500% | 10% from peak |
| +1000% | 8% from peak |

### Risk Management
- **Stop loss**: -35% from entry
- **Stale exit**: Close if <10% gain after 15 minutes
- **Max hold time**: 60 minutes

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PAPER_TRADE` | No | `true` | Paper trading mode |
| `STRATEGY_VERSION` | No | Derived from parameters | Optional label for a strategy experiment in telemetry logs |
| `TELEGRAM_BOT_TOKEN` | For alerts | - | Telegram bot token |
| `TELEGRAM_CHAT_ID` | For alerts | - | Telegram chat ID |

## Deploy to Railway

1. Push to GitHub
2. Connect repo to Railway
3. Set environment variables in Railway dashboard
4. Deploy - bot starts automatically

## Architecture

```
src/
  index.ts      Main entry & orchestration
  config.ts     All configuration parameters
  types.ts      TypeScript interfaces
  scanner.ts    Pump.fun WebSocket + price feeds
  trader.ts     Paper trading engine
  telegram.ts   Telegram alert system
  logger.ts     Colored console output
```

## Disclaimer

This bot is for educational and paper trading purposes only. Cryptocurrency trading involves substantial risk. Never trade with money you cannot afford to lose.
