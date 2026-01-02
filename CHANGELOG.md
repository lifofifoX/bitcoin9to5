# Changelog

## 2026-01-02

### Added: Take-Profit Zone for Longs

When a long position hits the 1% profit target, the bot now checks how much time remains until the next short zone. If there are 6+ hours remaining, instead of closing immediately, the bot enters a "TP zone" that lets profits run while protecting gains.

**TP zone behavior:**
- Tracks the peak price since entering TP zone
- Closes if price drops 0.5% from peak (trailing stop)
- Closes if price falls below original entry (capital protection)
- Closes when 6 hours from short zone (time-based exit)

**New constants:**
- `TP_ZONE_TRAILING_STOP_PCT = 0.5`
- `TP_ZONE_HOURS_THRESHOLD = 6`

**Example scenario:**

```
Friday 6:00 PM ET - Enter long at $100,000
Friday 9:00 PM ET - Price hits $101,000 (1% profit target)

OLD BEHAVIOR: Close for 1% profit (~10% PnL). Done.

NEW BEHAVIOR:
  -> Hours until Monday 9:29 AM short zone: ~63 hours
  -> 63h > 6h threshold, so enter TP zone
  -> Peak price = $101,000

Saturday 2:00 AM - Price rises to $101,800
  -> New peak = $101,800

Saturday 6:00 AM - Price drops to $101,400
  -> Drop from peak: 0.39% (< 0.5% threshold)
  -> Stay in TP zone

Saturday 10:00 AM - Price drops to $101,290
  -> Drop from peak: 0.50%
  -> TRAILING STOP TRIGGERED -> Close position
  -> Profit: 1.29% (~12.9% PnL) vs 1% if closed immediately
```

### Removed: Re-entry Logic

Previously, after taking profit, the bot would re-enter the same direction if price returned to the original entry. This has been removed to simplify the strategy.

- Removed `tookProfit` state field
- Removed re-entry check from price monitor
- Renamed `checkProfitAndReentry` to `checkProfit`
