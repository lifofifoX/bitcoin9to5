import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import cron from 'node-cron'
import { DateTime } from 'luxon'
import { createNadoClient, packOrderAppendix } from '@nadohq/client'
import { createWalletClient, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ink } from 'viem/chains'

const tz = 'America/New_York'
const ZONE_CONFIG_FILE = '.zone-config.json'

const loadZoneConfig = () => {
  try {
    if (existsSync(ZONE_CONFIG_FILE)) {
      return JSON.parse(readFileSync(ZONE_CONFIG_FILE, 'utf8'))
    }
  } catch (err) {
    console.error('Failed to load zone config:', err.message)
  }
  return null
}

const zoneConfig = loadZoneConfig()
const flipToShortTime = zoneConfig?.flipToShortTime || '29 9 * * 1-5'
const flipToLongTime = zoneConfig?.flipToLongTime || '1 16 * * 1-5'

const BTC_PERP_PRODUCT_ID = 2
const QUOTE_PRODUCT_ID = 0
const TARGET_LEVERAGE = 10
const SIZE_INCREMENT_X18 = 50000000000000n
const PROFIT_TARGET_PCT = 1.0
const TP_ZONE_TRAILING_STOP_PCT = 0.5
const TP_ZONE_HOURS_THRESHOLD = 6
const POLL_INTERVAL = 30000
const STATE_FILE = '.bot-state.json'
const MARKET_DATA_FILE = '.market-data.json'
const MORNING_RANGE = { start: 7, end: 11 }
const EVENING_RANGE = { start: 14, end: 18 }

const holidays = new Set([
  '2025-12-25',
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-06',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25'
])

const loadState = () => {
  try {
    if (existsSync(STATE_FILE)) {
      const data = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
      return { ...data, processing: false, logCounter: 0, inTpZone: data.inTpZone || false, tpZonePeakPrice: data.tpZonePeakPrice || null }
    }
  } catch (err) {
    console.error('Failed to load state:', err.message)
  }
  return { entryPrice: null, zone: 'long', processing: false, logCounter: 0, inTpZone: false, tpZonePeakPrice: null }
}

const saveState = () => {
  const { processing, logCounter, ...persistedState } = state
  writeFileSync(STATE_FILE, JSON.stringify(persistedState, null, 2))
}

const loadMarketData = () => {
  try {
    if (existsSync(MARKET_DATA_FILE)) {
      return JSON.parse(readFileSync(MARKET_DATA_FILE, 'utf8'))
    }
  } catch (err) {}
  return { snapshots: [] }
}

const saveMarketData = (data) => {
  writeFileSync(MARKET_DATA_FILE, JSON.stringify(data, null, 2))
}

const saveZoneConfig = (config) => {
  writeFileSync(ZONE_CONFIG_FILE, JSON.stringify(config, null, 2))
  log('zone-config', { short: config.flipToShortReadable, long: config.flipToLongReadable })
}

let state = loadState()

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const runWithRetry = async (fn, attempts = 3, delayMs = 2000) => {
  let lastError
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      console.error(`Attempt ${i + 1} failed:`, err.message)
      if (i < attempts - 1) await sleep(delayMs)
    }
  }
  throw lastError
}

const isHoliday = () => {
  const now = DateTime.now().setZone(tz)
  return holidays.has(now.toISODate())
}

const getZone = () => {
  const now = DateTime.now().setZone(tz)
  const hour = now.hour
  const minute = now.minute
  const dayOfWeek = now.weekday

  if (dayOfWeek >= 6 || isHoliday()) return 'long'

  const afterOpen = hour > 9 || (hour === 9 && minute >= 29)
  const beforeClose = hour < 16 || (hour === 16 && minute < 1)

  return (afterOpen && beforeClose) ? 'short' : 'long'
}

const getHoursUntilShortZone = () => {
  const now = DateTime.now().setZone(tz)

  const config = loadZoneConfig()
  const shortCron = config?.flipToShortTime || '29 9 * * 1-5'
  const [minute, hour] = shortCron.split(' ').map(Number)

  let nextShort = now.set({ hour, minute, second: 0, millisecond: 0 })

  if (nextShort <= now) {
    nextShort = nextShort.plus({ days: 1 })
  }

  while (nextShort.weekday >= 6 || holidays.has(nextShort.toISODate())) {
    nextShort = nextShort.plus({ days: 1 })
  }

  return nextShort.diff(now, 'hours').hours
}

const log = (kind, details) => {
  const now = DateTime.now().setZone(tz).toISO()
  console.log(`${now} ${kind}`, details)
}

const account = privateKeyToAccount(process.env.PRIVATE_KEY)

const walletClient = createWalletClient({
  account,
  chain: ink,
  transport: http()
})

const publicClient = createPublicClient({
  chain: ink,
  transport: http()
})

const client = createNadoClient('inkMainnet', { walletClient, publicClient })

const subaccount = {
  subaccountOwner: account.address,
  subaccountName: 'default'
}

const getPosition = async () => {
  const summary = await runWithRetry(() =>
    client.subaccount.getSubaccountSummary(subaccount)
  )

  const perpBalance = summary.balances.find(b => b.productId === BTC_PERP_PRODUCT_ID)
  const quoteBalance = summary.balances.find(b => b.productId === QUOTE_PRODUCT_ID)

  const amount = perpBalance?.amount?.toString() || '0'
  const collateral = quoteBalance?.amount?.toString() || '0'
  const vQuote = perpBalance?.vQuoteBalance?.toString() || '0'

  const amountNum = Number(amount)
  let entryPrice = null
  if (amountNum !== 0 && vQuote !== '0') {
    entryPrice = Math.abs(Number(vQuote) / amountNum)
  }

  return {
    exists: summary.exists,
    health: summary.health,
    btcAmount: amount,
    collateral,
    vQuoteBalance: vQuote,
    entryPrice,
    side: amountNum > 0 ? 'long' : amountNum < 0 ? 'short' : 'flat'
  }
}

const getMarketPrice = async () => {
  const price = await runWithRetry(() =>
    client.market.getLatestMarketPrice({ productId: BTC_PERP_PRODUCT_ID })
  )
  return {
    bid: price.bid.toString(),
    ask: price.ask.toString()
  }
}

const roundToSizeIncrement = (amount) => {
  const amountX18 = BigInt(Math.round(amount * 1e18))
  return (amountX18 / SIZE_INCREMENT_X18) * SIZE_INCREMENT_X18
}

const calcPositionSize = async (side, collateralX18) => {
  const price = await getMarketPrice()
  const priceToUse = side === 'long' ? price.ask : price.bid
  const collateral = Number(collateralX18) / 1e18
  const notional = collateral * TARGET_LEVERAGE
  const rawSize = notional / Number(priceToUse)
  const sizeX18 = roundToSizeIncrement(rawSize)

  return { sizeX18, price: priceToUse, notional }
}

const placeMarketOrder = async (side, amount, slippagePrice, reduceOnly = false) => {
  const appendix = packOrderAppendix({ orderExecutionType: 'ioc', reduceOnly })
  const orderAmount = side === 'short' ? -amount : amount
  const slippageMult = side === 'short' ? 0.99 : 1.01
  const rawPrice = Number(slippagePrice) * slippageMult
  const orderPrice = (side === 'short' ? Math.floor(rawPrice) : Math.ceil(rawPrice)).toString()

  const result = await runWithRetry(() =>
    client.market.placeOrder({
      productId: BTC_PERP_PRODUCT_ID,
      order: {
        ...subaccount,
        price: orderPrice,
        amount: orderAmount,
        expiration: Math.floor(Date.now() / 1000) + 60,
        appendix: appendix.toString()
      }
    })
  )

  return result
}

const closePosition = async () => {
  const position = await getPosition()
  if (!position.exists) {
    log('close', 'no subaccount')
    return
  }

  if (position.side === 'flat') {
    log('close', 'no open position')
    return
  }

  const posAmountX18 = BigInt(position.btcAmount.replace('-', ''))
  const price = await getMarketPrice()
  const closeSide = position.side === 'long' ? 'short' : 'long'
  const priceToUse = closeSide === 'short' ? price.bid : price.ask

  const result = await placeMarketOrder(closeSide, posAmountX18, priceToUse, true)
  log('close', { side: position.side, amountX18: posAmountX18.toString(), price: priceToUse, result: result.data })
  return result
}

const enterPosition = async (side) => {
  const position = await getPosition()
  if (!position.exists) {
    log('skip', 'no subaccount - deposit collateral first')
    return
  }

  if (position.side === side) {
    log('skip', `already ${side}`)
    return
  }

  const currentPosX18 = BigInt(position.btcAmount.replace('-', '')) || 0n
  const { sizeX18, price, notional } = await calcPositionSize(side, position.collateral)
  const totalAmountX18 = currentPosX18 + sizeX18

  if (totalAmountX18 <= 0n) {
    log('skip', 'no size available')
    return
  }

  const result = await placeMarketOrder(side, totalAmountX18, price)
  const collateral = Number(position.collateral) / 1e18
  const leverage = (notional / collateral).toFixed(1)

  state.entryPrice = Number(price)
  state.inTpZone = false
  state.tpZonePeakPrice = null
  saveState()

  log(`enter-${side}`, { amountX18: totalAmountX18.toString(), price, leverage: `${leverage}x`, result: result.data })
  return result
}

const flipToShort = async () => {
  if (isHoliday()) {
    log('skip', 'holiday - staying long')
    return
  }

  try {
    state.zone = 'short'
    saveState()
    await enterPosition('short')
  } catch (err) {
    console.error('flip-to-short error:', err)
  }
}

const flipToLong = async () => {
  try {
    state.zone = 'long'
    saveState()
    await enterPosition('long')
  } catch (err) {
    console.error('flip-to-long error:', err)
  }
}

const checkProfit = async () => {
  if (state.processing) return
  state.processing = true
  state.logCounter++

  try {
    const position = await getPosition()
    const price = await getMarketPrice()
    const midPrice = (Number(price.bid) + Number(price.ask)) / 2

    if (position.side === 'flat') {
      if (state.inTpZone) {
        state.inTpZone = false
        state.tpZonePeakPrice = null
        saveState()
      }
      return
    }

    if (!state.entryPrice) {
      return
    }

    const priceDiff = position.side === 'short'
      ? state.entryPrice - midPrice
      : midPrice - state.entryPrice

    const profitPct = (priceDiff / state.entryPrice) * 100

    if (position.side === 'long' && state.inTpZone) {
      if (midPrice > state.tpZonePeakPrice) {
        state.tpZonePeakPrice = midPrice
        saveState()
      }

      const hoursUntilShort = getHoursUntilShortZone()
      const dropFromPeak = ((state.tpZonePeakPrice - midPrice) / state.tpZonePeakPrice) * 100
      const belowEntry = midPrice < state.entryPrice
      const trailingStopPrice = state.tpZonePeakPrice * (1 - TP_ZONE_TRAILING_STOP_PCT / 100)

      if (state.logCounter % 10 === 0) {
        log('tp-zone', `price: ${midPrice.toFixed(0)} | peak: ${state.tpZonePeakPrice.toFixed(0)} | closeAt: ${trailingStopPrice.toFixed(0)} | floor: ${state.entryPrice.toFixed(0)}`)
      }

      if (dropFromPeak >= TP_ZONE_TRAILING_STOP_PCT || hoursUntilShort <= TP_ZONE_HOURS_THRESHOLD || belowEntry) {
        const reason = belowEntry ? 'below-entry' : dropFromPeak >= TP_ZONE_TRAILING_STOP_PCT ? 'trailing-stop' : 'time-exit'
        log('tp-zone-exit', {
          reason,
          entry: state.entryPrice,
          peak: state.tpZonePeakPrice,
          exit: midPrice,
          profitPct: profitPct.toFixed(2),
          hoursUntilShort: hoursUntilShort.toFixed(1)
        })
        await closePosition()
        state.inTpZone = false
        state.tpZonePeakPrice = null
        saveState()
      }
      return
    }

    const targetPrice = position.side === 'long'
      ? state.entryPrice * (1 + PROFIT_TARGET_PCT / 100)
      : state.entryPrice * (1 - PROFIT_TARGET_PCT / 100)

    if (state.logCounter % 10 === 0) {
      log('monitor', `${position.side} @ ${midPrice.toFixed(0)} | entry: ${state.entryPrice.toFixed(0)} | target: ${targetPrice.toFixed(0)} | ${profitPct.toFixed(2)}%`)
    }

    if (profitPct >= PROFIT_TARGET_PCT) {
      if (position.side === 'long') {
        const hoursUntilShort = getHoursUntilShortZone()
        if (hoursUntilShort > TP_ZONE_HOURS_THRESHOLD) {
          log('tp-zone-enter', {
            entry: state.entryPrice,
            currentPrice: midPrice,
            profitPct: profitPct.toFixed(2),
            hoursUntilShort: hoursUntilShort.toFixed(1)
          })
          state.inTpZone = true
          state.tpZonePeakPrice = midPrice
          saveState()
          return
        }
      }

      log('profit-take', {
        side: position.side,
        entry: state.entryPrice,
        exit: midPrice,
        profitPct: profitPct.toFixed(2)
      })
      await closePosition()
    }
  } catch (err) {
    console.error('price check error:', err)
  } finally {
    state.processing = false
  }
}

const startPriceMonitor = () => {
  setInterval(() => {
    checkProfit().catch(err => console.error('monitor error:', err))
  }, POLL_INTERVAL)
}

const recordPriceSnapshot = async () => {
  try {
    const now = DateTime.now().setZone(tz)
    const price = await getMarketPrice()
    const mid = (Number(price.bid) + Number(price.ask)) / 2

    const data = loadMarketData()
    data.snapshots.push({
      ts: now.toISO(),
      date: now.toISODate(),
      hour: now.hour,
      min: now.minute,
      dow: now.weekday,
      price: mid
    })

    const cutoff = now.minus({ days: 10 }).toISO()
    data.snapshots = data.snapshots.filter(s => s.ts > cutoff)
    saveMarketData(data)
  } catch (err) {
    console.error('Snapshot error:', err.message)
  }
}

const analyzeAndUpdateConfig = () => {
  const data = loadMarketData()
  const snapshots = data.snapshots.filter(s => s.dow >= 1 && s.dow <= 5)

  const uniqueDates = new Set(snapshots.map(s => s.date))
  if (uniqueDates.size < 3) {
    console.log(`Not enough data yet (${uniqueDates.size}/3 days)`)
    return
  }

  const byDate = {}
  for (const s of snapshots) {
    if (!byDate[s.date]) byDate[s.date] = []
    byDate[s.date].push(s)
  }

  const morningMoves = {}
  const eveningMoves = {}

  for (const [, snaps] of Object.entries(byDate)) {
    const sorted = snaps.sort((a, b) => (a.hour * 60 + a.min) - (b.hour * 60 + b.min))

    for (const s of sorted) {
      if (s.hour >= MORNING_RANGE.start && s.hour <= MORNING_RANGE.end) {
        const key = `${String(s.hour).padStart(2, '0')}:${String(s.min).padStart(2, '0')}`
        const later = sorted.find(x =>
          (x.hour * 60 + x.min) >= (s.hour * 60 + s.min + 30) &&
          (x.hour * 60 + x.min) <= (s.hour * 60 + s.min + 35)
        )
        if (later) {
          const move = (later.price - s.price) / s.price * 100
          if (!morningMoves[key]) morningMoves[key] = []
          morningMoves[key].push(move)
        }
      }

      if (s.hour >= EVENING_RANGE.start && s.hour <= EVENING_RANGE.end) {
        const key = `${String(s.hour).padStart(2, '0')}:${String(s.min).padStart(2, '0')}`
        const later = sorted.find(x =>
          (x.hour * 60 + x.min) >= (s.hour * 60 + s.min + 30) &&
          (x.hour * 60 + x.min) <= (s.hour * 60 + s.min + 35)
        )
        if (later) {
          const move = (later.price - s.price) / s.price * 100
          if (!eveningMoves[key]) eveningMoves[key] = []
          eveningMoves[key].push(move)
        }
      }
    }
  }

  let bestShortTime = '09:29'
  let mostNegative = 0
  for (const [time, moves] of Object.entries(morningMoves)) {
    const avg = moves.reduce((a, b) => a + b, 0) / moves.length
    if (avg < mostNegative) {
      mostNegative = avg
      bestShortTime = time
    }
  }

  let bestLongTime = '16:01'
  let mostPositive = 0
  for (const [time, moves] of Object.entries(eveningMoves)) {
    const avg = moves.reduce((a, b) => a + b, 0) / moves.length
    if (avg > mostPositive) {
      mostPositive = avg
      bestLongTime = time
    }
  }

  const adjustTime = (timeStr) => {
    const [h, m] = timeStr.split(':').map(Number)
    let totalMins = h * 60 + m - 10
    return `${Math.floor(totalMins / 60)}:${String(totalMins % 60).padStart(2, '0')}`
  }

  const shortTime = adjustTime(bestShortTime)
  const longTime = adjustTime(bestLongTime)

  const toCron = (timeStr) => {
    const [h, m] = timeStr.split(':').map(Number)
    return `${m} ${h} * * 1-5`
  }

  const newShortCron = toCron(shortTime)
  const newLongCron = toCron(longTime)

  saveZoneConfig({
    updatedAt: DateTime.now().setZone(tz).toISO(),
    flipToShortTime: newShortCron,
    flipToLongTime: newLongCron,
    flipToShortReadable: shortTime,
    flipToLongReadable: longTime
  })

  scheduleFlipTasks(newShortCron, newLongCron)
  log('reschedule', { short: shortTime, long: longTime })
}

const args = process.argv.slice(2)

if (args.includes('--close')) {
  console.log('Closing position...')
  console.log('Account:', account.address)
  try {
    await closePosition()
  } catch (err) {
    console.error('Failed to close position:', err.message)
    process.exit(1)
  }
  process.exit(0)
}

let shortTask = null
let longTask = null

const scheduleFlipTasks = (shortCron, longCron) => {
  if (shortTask) shortTask.stop()
  if (longTask) longTask.stop()

  shortTask = cron.schedule(shortCron, () => {
    flipToShort().catch(err => console.error('scheduled flip-to-short error:', err))
  }, { timezone: tz })

  longTask = cron.schedule(longCron, () => {
    flipToLong().catch(err => console.error('scheduled flip-to-long error:', err))
  }, { timezone: tz })
}

scheduleFlipTasks(flipToShortTime, flipToLongTime)

cron.schedule('*/5 7-11 * * 1-5', () => {
  recordPriceSnapshot().catch(err => console.error('snapshot error:', err))
}, { timezone: tz })

cron.schedule('*/5 14-18 * * 1-5', () => {
  recordPriceSnapshot().catch(err => console.error('snapshot error:', err))
}, { timezone: tz })

cron.schedule('0 18 * * 1-5', analyzeAndUpdateConfig, { timezone: tz })

console.log('Bot running - Nado Perps (smart flip strategy)')
console.log('Account:', account.address)
log('schedule', { short: zoneConfig?.flipToShortReadable || '9:29', long: zoneConfig?.flipToLongReadable || '16:01' })
console.log(`Profit target: ${PROFIT_TARGET_PCT}% price move (~${PROFIT_TARGET_PCT * TARGET_LEVERAGE}% PnL)`)
console.log(`TP zone: trailing stop ${TP_ZONE_TRAILING_STOP_PCT}%, ${TP_ZONE_HOURS_THRESHOLD}h threshold`)
console.log(`Price check interval: ${POLL_INTERVAL / 1000}s`)
console.log('Data collection: 7-11 AM, 2-6 PM ET (every 5 min). Analysis: 6 PM ET')

try {
  const pos = await getPosition()
  console.log('Position:', pos)

  const price = await getMarketPrice()
  console.log('BTC Price:', price)

  state.zone = getZone()

  if (pos.side !== 'flat' && !state.entryPrice) {
    if (pos.entryPrice) {
      state.entryPrice = pos.entryPrice
      console.log('Entry price recovered from position:', state.entryPrice)
    } else {
      console.log('Warning: Position exists but no entry price available.')
    }
  }

  saveState()
  console.log('State:', { zone: state.zone, entryPrice: state.entryPrice, inTpZone: state.inTpZone })

  analyzeAndUpdateConfig()
} catch (err) {
  console.error('Startup check failed:', err.message)
  console.log('Will keep retrying via price monitor...')
}

startPriceMonitor()
