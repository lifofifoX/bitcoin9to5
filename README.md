# bitcoin9to5

BTC perpetual futures trading bot for Nado exchange.

**Premise:** BTC tends to drop during US market hours and rise overnight. The bot exploits this by shorting 9-to-5 and going long the rest of the time.

**Zones:**
- **Short zone**: 9:29 AM - 4:01 PM ET weekdays
- **Long zone**: Overnight, weekends, and holidays

At each zone change, the bot flips direction—closing any existing position and opening a new one in the zone's direction.

**Profit-taking:** When price moves 1% in your favor, the bot closes for profit (~10% gain at 10x leverage).

**Take-profit zone (longs only):** When a long hits the profit target with 6+ hours until short zone, the bot enters a "TP zone" instead of closing immediately. This lets profits run while protecting gains:
- Tracks the peak price since entering TP zone
- Closes if price drops 0.5% from peak (trailing stop)
- Closes if price falls below original entry
- Closes when 6 hours from short zone (time-based exit)

## Requirements

- Node.js
- Ethereum wallet with private key
- Collateral deposited on [Nado](https://nado.xyz)

## Install

```bash
npm install
```

## Run

```bash
PRIVATE_KEY="0x..." node bot.js
node bot.js --close  # Close any open position
```

## Configuration

Edit `bot.js` to adjust:
- `TARGET_LEVERAGE` - Leverage multiplier (default: 10)
- `PROFIT_TARGET_PCT` - Price move % to take profit (default: 1.0)
- `TP_ZONE_TRAILING_STOP_PCT` - Trailing stop % for TP zone (default: 0.5)
- `TP_ZONE_HOURS_THRESHOLD` - Hours before short zone to enter/exit TP zone (default: 6)
- `holidays` - Market holidays to skip trading

## Adaptive Learning

The bot learns optimal zone transition times from price data:
- Collects prices every 5 min during transition windows
- Finds the time with the biggest drop (morning) or rise (evening)
- Auto-reschedules daily at 6 PM ET
- State files: `.market-data.json`, `.zone-config.json`
