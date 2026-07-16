import 'dotenv/config';

const ENTRY_PARAMETERS = {
  // Broader discovery, while every entry still requires verified upward momentum.
  MIN_UNIQUE_BUYERS: 7,
  MIN_TOKEN_AGE_SECONDS: 15,
  MAX_TOKEN_AGE_SECONDS: 300,
  MIN_BUY_SELL_RATIO: 1.6,
  MIN_MCAP_GROWTH_PCT: 8,
  MAX_MCAP_GROWTH_PCT: 250,
  MAX_ENTRY_MARKET_CAP_SOL: 120,
  MIN_MOMENTUM_STEP_PCT: 3,
  MAX_MOMENTUM_STEP_PCT: 20,
  MIN_CONSECUTIVE_MOMENTUM_UPDATES: 3,
  SKIP_IF_DEV_SOLD: true,
};

const EXIT_PARAMETERS = {
  CONSECUTIVE_UNIQUE_SELLS_TO_EXIT: 4,
  TAKE_PROFIT_PCT: 40,
  STOP_LOSS_PCT: 15,
  COLLAPSE_DROP_FROM_PEAK_PCT: 6,
  COLLAPSE_MIN_GAIN_PCT: 12,
  RAPID_DUMP_PCT: 5,
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
  PROBE_TRADE_SIZE_USD: 5,
  TRADE_SIZE_USD: 10,
  HIGH_CONVICTION_TRADE_SIZE_USD: 20,
  HIGH_CONVICTION_MIN_UNIQUE_BUYERS: 15,
  HIGH_CONVICTION_MIN_BUY_SELL_RATIO: 2.2,
  HIGH_CONVICTION_MIN_MCAP_GROWTH_PCT: 15,
  HIGH_CONVICTION_MIN_MOMENTUM_CONFIRMATIONS: 4,
  MAX_CONCURRENT_TRADES: 5,
  DAILY_LOSS_LIMIT_USD: 100,
  DAILY_PROFITABLE_TRADE_TARGET: 7,
  // Keep learning telemetry on, but require explicit opt-in before parameters
  // are automatically changed by paper-trade experiments.
  EXPERIMENT_ENABLED: process.env.EXPERIMENT_ENABLED === 'true' && process.env.PAPER_TRADE !== 'false',
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
  // Keep candidates for the entire configured entry window so late-forming
  // positive momentum is observable before a rejection is recorded.
  CANDIDATE_TIMEOUT_MS: 120_000,
  MAX_ACTIVE_CANDIDATES: 250,
  CANDIDATE_POLL_BATCH_SIZE: 20,
  DEVELOPER_LAUNCH_WINDOW_MS: 30 * 60_000,
  MAX_DEVELOPER_LAUNCHES_IN_WINDOW: 1,
  WS_RECONNECT_DELAY_MS: 3_000,
  WS_MAX_RECONNECT_DELAY_MS: 30_000,
  WS_DISABLE_AFTER_FORBIDDEN: true,

  // ── Realistic Simulation (fees, slippage, priority) ──
  PUMPFUN_FEE_PCT: 1,
  BUY_SLIPPAGE_PCT: 2,
  SELL_SLIPPAGE_PCT: 1.5,
  SOLANA_TX_FEE_SOL: 0.000005,
  PRIORITY_FEE_SOL: 0.005,
  // Optional RPC-backed fee sampling for paper-fill realism. The static fee
  // remains the safe fallback when no RPC endpoint is configured.
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || '',
  DYNAMIC_PRIORITY_FEE_ENABLED: process.env.DYNAMIC_PRIORITY_FEE_ENABLED !== 'false',
  PRIORITY_FEE_MIN_SOL: 0.001,
  PRIORITY_FEE_MAX_SOL: 0.02,
  // This only models the additional tip/cost of a private route. It never
  // signs, broadcasts, or submits a real transaction.
  PRIVATE_SUBMISSION_SIMULATION: process.env.PRIVATE_SUBMISSION_SIMULATION === 'true',
  PRIVATE_SUBMISSION_TIP_SOL: 0.001,
  MOMENTUM_WINDOW_MS: 30_000,
  MAX_MOMENTUM_WINDOW_GROWTH_PCT: 80,

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
