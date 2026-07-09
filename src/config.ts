import 'dotenv/config';

export const CONFIG = {
  // ── Mode ──
  PAPER_TRADE: process.env.PAPER_TRADE !== 'false',

  // ── Budget ──
  STARTING_BUDGET_USD: 100,
  TRADE_SIZE_USD: 10,
  MAX_CONCURRENT_TRADES: 5,

  // ── Pump.fun Entry Criteria ──
  MIN_UNIQUE_BUYERS: 3,          // Excluding the developer wallet
  MIN_TOKEN_AGE_SECONDS: 10,     // Token must be at least 10 seconds old
  MAX_TOKEN_AGE_SECONDS: 300,    // Don't buy tokens older than 5 minutes

  // ── Scanner ──
  PUMPFUN_WS_URL: 'wss://pumpportal.fun/api/data',
  PRICE_CHECK_INTERVAL_MS: 3_000,
  CANDIDATE_TIMEOUT_MS: 120_000, // Stop tracking unqualified candidates after 2 min
  WS_RECONNECT_DELAY_MS: 3_000,
  WS_MAX_RECONNECT_DELAY_MS: 30_000,

  // ── Realistic Simulation (fees, slippage, priority) ──
  PUMPFUN_FEE_PCT: 1,             // Pump.fun charges 1% per trade
  BUY_SLIPPAGE_PCT: 2,            // Buying into bonding curve pushes price up ~2%
  SELL_SLIPPAGE_PCT: 1.5,         // Selling into bonding curve pushes price down ~1.5%
  SOLANA_TX_FEE_SOL: 0.000005,    // Base Solana transaction fee
  PRIORITY_FEE_SOL: 0.005,        // Typical Jito/priority fee for fast inclusion

  // ── Exit Strategy ──
  // Sell at +50% to +100%, ride big winners
  TAKE_PROFIT_LEVELS: [
    { triggerPct: 50, sellPct: 30 },    // At +50%, sell 30% of position
    { triggerPct: 75, sellPct: 25 },    // At +75%, sell 25% of position
    { triggerPct: 100, sellPct: 20 },   // At +100%, sell 20% of position
    // Remaining 25% rides with trailing stop for big winners
  ],
  TRAILING_STOP_TIERS: [
    { activateAbovePct: 30,  trailDistancePct: 25 },  // Early profit: wide trail
    { activateAbovePct: 100, trailDistancePct: 18 },   // Solid gain: tighten
    { activateAbovePct: 250, trailDistancePct: 15 },   // Big winner: tighter
    { activateAbovePct: 500, trailDistancePct: 10 },   // Moonshot: lock in
    { activateAbovePct: 1000, trailDistancePct: 8 },   // Parabolic: very tight
  ],
  INITIAL_STOP_LOSS_PCT: 35,
  MAX_HOLD_TIME_MINUTES: 60,
  STALE_EXIT_MINUTES: 15,
  STALE_EXIT_MIN_GAIN_PCT: 10,

  // ── Price Feed ──
  JUPITER_PRICE_API: 'https://api.jup.ag/price/v2',
  SOL_MINT: 'So11111111111111111111111111111111111111112',
  PUMPFUN_TOTAL_SUPPLY: 1_000_000_000, // All pump.fun tokens have 1B supply

  // ── Telegram ──
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
} as const;
