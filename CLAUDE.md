# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BTC perpetual futures trading bot for Nado exchange. Premise: BTC tends to drop during US market hours and rise overnight. The bot shorts 9-to-5 and goes long the rest of the time, taking profits at 1% moves and re-entering if price returns to the original entry.

## Commands

```bash
npm install                    # Install dependencies
PRIVATE_KEY="0x..." node bot.js # Run locally
node bot.js --close            # Close any open position
./scripts/push_rsync.sh        # Deploy to remote server
./scripts/remote_logs.sh       # View remote logs
```

## Architecture

Single-file bot (`bot.js`) using ES modules:
- **Scheduling**: `node-cron` for zone transitions (9:29 AM / 4:01 PM ET)
- **Price monitoring**: 30s polling via REST API
- **API client**: `@nadohq/client` (Nado TypeScript SDK)
- **Wallet**: `viem` for Ethereum wallet/signing (EIP-712)

Zones (direction the bot trades):
- **Short zone**: 9:29 AM - 4:01 PM ET weekdays
- **Long zone**: Overnight, weekends, holidays
- At each zone change, bot flips: closes existing position and opens in new direction
- Times auto-adjust based on collected market data

Profit-taking:
- Close at 1% price move in favor (~10% PnL at 10x leverage)

Take-profit zone (longs only):
- When long hits profit target with 6+ hours until short zone, enters TP zone instead of closing
- Tracks peak price and uses 0.5% trailing stop to protect gains
- Exits if price drops below original entry or 6 hours before short zone

Adaptive learning:
- Records prices every 5 min during 7-11 AM and 2-6 PM ET
- Analyzes last 3 days to find times with largest price moves
- Morning: finds time with biggest drop (optimal short entry)
- Evening: finds time with biggest rise (optimal long entry)
- Auto-reschedules cron jobs at 6 PM ET daily

Key constants:
- `BTC_PERP_PRODUCT_ID = 2`
- `TARGET_LEVERAGE = 10`
- `PROFIT_TARGET_PCT = 1.0`
- `TP_ZONE_TRAILING_STOP_PCT = 0.5`
- `TP_ZONE_HOURS_THRESHOLD = 6`

State files (gitignored):
- `.bot-state.json` - Entry price, zone, TP zone state
- `.market-data.json` - Price snapshots for analysis
- `.zone-config.json` - Current optimal zone times

## Environment Variables

- `PRIVATE_KEY` - Ethereum private key (with 0x prefix)

## Nado API

- Docs: https://docs.nado.xyz/developer-resources/api
- Uses wallet-based auth via EIP-712 signing

## Deployment

Uses pm2 for process management. Config in `ecosystem.config.cjs`.
