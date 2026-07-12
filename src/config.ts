import 'dotenv/config';

export const CONFIG = {
  // ── Mode ──
  PAPER_TRADE: process.env.PAPER_TRADE !== 'false',

  // ── Budget ──
  STARTING_BUDGET_USD: 1000,
  TRADE_SIZE_USD: 10,
  MAX_CONCURRENT_TRADES: 10,

  // ── Pump.fun Entry Criteria ──
  MIN_UNIQUE_BUYERS: 3,          // Excluding the developer wallet
  MIN_TOKEN_AGE_SECONDS: 10,     // Token must be at least 10 seconds old
  MAX_TOKEN_AGE_SECONDS: 600,    // Don't buy tokens older than 10 minutes
  MIN_BUY_SELL_RATIO: 1.2,       // At least 20% more buys than sells
  MIN_MCAP_GROWTH_PCT: 2,        // Market cap must have grown 2% from creation
  SKIP_IF_DEV_SOLD: true,        // Skip tokens where dev has already sold

  // ── Scanner ──
  PUMPPORTAL_API_KEY: process.env.PUMPPORTAL_API_KEY || '',
  PUMPFUN_WS_URL: 'wss://pumpportal.fun/api/data',
  PUMPFUN_API_BASE: 'https://frontend-api-v3.pump.fun',
  DEXSCREENER_API_BASE: 'https://api.dexscreener.com',
  POLL_INTERVAL_MS: 4_000,
  PRICE_CHECK_INTERVAL_MS: 3_000,
  CANDIDATE_TIMEOUT_MS: 120_000,
  WS_RECONNECT_DELAY_MS: 3_000,
  WS_MAX_RECONNECT_DELAY_MS: 30_000,

  // ── Realistic Simulation (fees, slippage, priority) ──
  PUMPFUN_FEE_PCT: 1,
  BUY_SLIPPAGE_PCT: 2,
  SELL_SLIPPAGE_PCT: 1.5,
  SOLANA_TX_FEE_SOL: 0.000005,
  PRIORITY_FEE_SOL: 0.005,

  // ── Exit Strategy (simple + smart) ──
  TAKE_PROFIT_PCT: 50,              // Sell everything at +50%
  STOP_LOSS_PCT: 25,                // Hard stop at -25%
  COLLAPSE_DROP_FROM_PEAK_PCT: 15,  // If price drops 15% from its high...
  COLLAPSE_MIN_GAIN_PCT: 5,         // ...and we were up at least 5%, sell to protect
  RAPID_DUMP_PCT: 10,               // If price drops 10% in a single update, instant sell
  STALE_EXIT_MINUTES: 10,           // Flat for 10 min with <10% gain = exit
  STALE_EXIT_MIN_GAIN_PCT: 10,
  MAX_HOLD_TIME_MINUTES: 30,        // Pump.fun tokens don't hold - 30 min max

  // ── Price Feed ──
  JUPITER_PRICE_API: 'https://api.jup.ag/price/v2',
  SOL_MINT: 'So11111111111111111111111111111111111111112',
  PUMPFUN_TOTAL_SUPPLY: 1_000_000_000,

  // ── Telegram ──
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
} as const;
