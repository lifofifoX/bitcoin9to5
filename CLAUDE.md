# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A minimal Bitcoin trading bot that implements the "10am slam" strategy via Coinbase Advanced Trade API. Sells all BTC at 9:29 AM ET on weekdays and buys back at 4:01 PM ET.

## Commands

```bash
# Install dependencies
npm install

# Run locally
CB_API_KEY="..." CB_API_SECRET="..." node bot.js

# Deploy to remote server (rsyncs code, installs deps, restarts pm2)
./scripts/push_rsync.sh

# View remote logs
./scripts/remote_logs.sh
```

## Architecture

Single-file bot (`bot.js`) using ES modules:
- **Scheduling**: `node-cron` with America/New_York timezone
- **Time handling**: `luxon` for date/timezone operations
- **API client**: `coinbase-api` (CBAdvancedTradeClient)
- **Retry logic**: Built-in 3-attempt retry with 2s delay for API calls
- **Holiday handling**: Hardcoded Set of market holidays to skip trading

Key schedules:
- `sellTime`: 9:29 AM ET weekdays - sells all BTC for USDC
- `buyTime`: 4:01 PM ET weekdays - buys BTC with all USDC

## Environment Variables

- `CB_API_KEY` - Coinbase API key
- `CB_API_SECRET` - Coinbase API secret

## Deployment

Uses pm2 for process management on remote server. The pm2 config is in `ecosystem.config.cjs` (CommonJS for pm2 compatibility with ES module project).
