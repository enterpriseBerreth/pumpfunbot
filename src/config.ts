import 'dotenv/config';

const ENTRY_PARAMETERS = {
  MIN_UNIQUE_BUYERS: 5,
  MIN_TOKEN_AGE_SECONDS: 20,
  MAX_TOKEN_AGE_SECONDS: 180,
  MIN_BUY_SELL_RATIO: 1.5,
  MIN_MCAP_GROWTH_PCT: 10,
  MIN_MOMENTUM_STEP_PCT: 3,
  MIN_CONSECUTIVE_MOMENTUM_UPDATES: 2,
  SKIP_IF_DEV_SOLD: true,
};

const EXIT_PARAMETERS = {
  TAKE_PROFIT_PCT: 25,
  STOP_LOSS_PCT: 15,
  COLLAPSE_DROP_FROM_PEAK_PCT: 8,
  COLLAPSE_MIN_GAIN_PCT: 12,
  RAPID_DUMP_PCT: 7,
  STALE_EXIT_MINUTES: 4,
  STALE_EXIT_MIN_GAIN_PCT: 8,
  MAX_HOLD_TIME_MINUTES: 15,
};

function configFingerprint(value: unknown): string {
  const source = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `cfg-${(hash >>> 0).toString(36)}`;
}

export const CONFIG = {
  // ── Mode ──
  PAPER_TRADE: process.env.PAPER_TRADE !== 'false',

  // Every telemetry event identifies both the strategy parameters and deployment.
  STRATEGY_CONFIG_VERSION: process.env.STRATEGY_VERSION || configFingerprint({ entry: ENTRY_PARAMETERS, exit: EXIT_PARAMETERS }),
  DEPLOYMENT_VERSION: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GITHUB_SHA || 'unknown',
  REJECTION_FOLLOWUP_MINUTES: [1, 3, 5, 10] as const,
  REJECTION_FOLLOWUP_CHECK_INTERVAL_MS: 5_000,

  // ── Budget ──
  STARTING_BUDGET_USD: 1000,
  TRADE_SIZE_USD: 20,
  MAX_CONCURRENT_TRADES: 10,
  DAILY_PROFITABLE_TRADE_TARGET: 10,
  EXPERIMENT_ENABLED: process.env.PAPER_TRADE !== 'false',
  EXPERIMENT_SAMPLE_SIZE: 20,
  EXPERIMENT_MAX_WIN_RATE_DROP_PCT: 5,

  // ── Pump.fun Entry Criteria ──
  ...ENTRY_PARAMETERS,

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
  ...EXIT_PARAMETERS,

  // ── Price Feed ──
  JUPITER_PRICE_API: 'https://api.jup.ag/price/v2',
  SOL_MINT: 'So11111111111111111111111111111111111111112',
  PUMPFUN_TOTAL_SUPPLY: 1_000_000_000,

  // ── Telegram ──
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
};

export type AdaptiveEntryParameter =
  | 'MIN_UNIQUE_BUYERS'
  | 'MIN_MOMENTUM_STEP_PCT'
  | 'MIN_CONSECUTIVE_MOMENTUM_UPDATES';

const defaultAdaptiveValues: Record<AdaptiveEntryParameter, number> = {
  MIN_UNIQUE_BUYERS: CONFIG.MIN_UNIQUE_BUYERS as number,
  MIN_MOMENTUM_STEP_PCT: CONFIG.MIN_MOMENTUM_STEP_PCT as number,
  MIN_CONSECUTIVE_MOMENTUM_UPDATES: CONFIG.MIN_CONSECUTIVE_MOMENTUM_UPDATES as number,
};

export function setAdaptiveEntryParameter(parameter: AdaptiveEntryParameter, value: number, experimentId: string): void {
  CONFIG[parameter] = value;
  CONFIG.STRATEGY_CONFIG_VERSION = `adaptive-${experimentId}-${configFingerprint({ entry: {
    MIN_UNIQUE_BUYERS: CONFIG.MIN_UNIQUE_BUYERS,
    MIN_MOMENTUM_STEP_PCT: CONFIG.MIN_MOMENTUM_STEP_PCT,
    MIN_CONSECUTIVE_MOMENTUM_UPDATES: CONFIG.MIN_CONSECUTIVE_MOMENTUM_UPDATES,
  }, exit: EXIT_PARAMETERS })}`;
}

export function resetAdaptiveEntryParameter(parameter: AdaptiveEntryParameter, experimentId: string): void {
  setAdaptiveEntryParameter(parameter, defaultAdaptiveValues[parameter], experimentId);
}
