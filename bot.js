import cron from 'node-cron'
import { DateTime } from 'luxon'
import { CBAdvancedTradeClient } from 'coinbase-api'

const client = new CBAdvancedTradeClient({
  apiKey: process.env.CB_API_KEY,
  apiSecret: process.env.CB_API_SECRET
})

const tz = 'America/New_York'
const sellTime = '29 9 * * 1-5'
const buyTime = '1 16 * * 1-5'

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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const runWithRetry = async (fn, attempts = 3, delayMs = 2000) => {
  let lastError

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (i < attempts - 1) await sleep(delayMs)
    }
  }

  throw lastError
}

const isHoliday = () => {
  const now = DateTime.now().setZone(tz)
  if (now.weekday >= 6) return true
  return holidays.has(now.toISODate())
}

const getBalances = async () => {
  const res = await runWithRetry(() => client.getAccounts({ limit: 250 }))
  const list = res.accounts || []

  const btc = list.find(a => a.currency === 'BTC')?.available_balance?.value || '0'
  const usdc = list.find(a => a.currency === 'USDC')?.available_balance?.value || '0'

  return { btc, usdc }
}

const sellAllBtcForUsdc = async () => {
  if (isHoliday()) return

  const { btc } = await getBalances()
  if (Number(btc) <= 0) return

  const res = await runWithRetry(() => client.submitOrder({
    client_order_id: client.generateNewOrderId(),
    product_id: 'BTC-USDC',
    side: 'SELL',
    order_configuration: {
      market_market_ioc: { base_size: btc }
    }
  }))

  if (!res.success) throw new Error(res.error_response?.message || 'sell failed')

  log('sell', btc)
}

const buyBtcWithAllUsdc = async () => {
  if (isHoliday()) return

  const { usdc } = await getBalances()
  if (Number(usdc) <= 0) return

  const res = await runWithRetry(() => client.submitOrder({
    client_order_id: client.generateNewOrderId(),
    product_id: 'BTC-USDC',
    side: 'BUY',
    order_configuration: {
      market_market_ioc: { quote_size: Math.floor(Number(usdc)).toString() }
    }
  }))

  if (!res.success) throw new Error(res.error_response?.message || 'buy failed')

  log('buy', usdc)
}

const log = (kind, amt) => {
  const now = DateTime.now().setZone(tz).toISO()
  console.log(`${now} ${kind} ${amt}`)
}

cron.schedule(sellTime, () => {
  sellAllBtcForUsdc().catch(err => console.error('sell error', err))
}, { timezone: tz })

cron.schedule(buyTime, () => {
  buyBtcWithAllUsdc().catch(err => console.error('buy error', err))
}, { timezone: tz })

console.log('Bot running')

console.log(await getBalances())
