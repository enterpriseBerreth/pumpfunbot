// ── Pump.fun WebSocket Events ──

export interface PumpFunNewToken {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  traderPublicKey: string; // Dev/creator wallet
  initialBuy: number;
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
}

export interface PumpFunTrade {
  signature: string;
  mint: string;
  traderPublicKey: string;
  txType: 'buy' | 'sell';
  tokenAmount: number;
  newTokenBalance: number;
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
}

// ── Token Candidate (pre-buy tracking) ──

export interface TokenCandidate {
  mint: string;
  name: string;
  symbol: string;
  devWallet: string;
  createdAt: number;
  uniqueBuyers: Set<string>;
  buyCount: number;
  sellCount: number;
  devSold: boolean;              // True if dev wallet has sold
  initialMarketCapSol: number;   // Market cap at creation
  latestMarketCapSol: number;
  latestPriceSol: number;
  latestPriceUsd: number;
  lastMomentumStepPct: number;
  momentumConfirmations: number;
  momentumWindowGrowthPct: number;
  momentumSamples: Array<{ at: number; marketCapSol: number }>;
  developerLaunchesAtEntry: number;
  totalBuyVolumeSol: number;
  lastTradeAt: number;
  qualified: boolean;
}

// ── Position / Trade ──

export type PositionStatus = 'open' | 'partial' | 'closed';

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  name: string;

  // Prices (fill prices include slippage)
  entryPriceSol: number;       // Actual fill price (market + slippage)
  entryPriceUsd: number;
  entryMarketPriceSol: number; // Raw market price at time of buy
  entryMarketPriceUsd: number;
  currentPriceSol: number;
  currentPriceUsd: number;
  highestPriceSol: number;
  highestPriceUsd: number;

  // Token quantities (realistic tracking)
  tokenAmount: number;         // Tokens acquired after fees+slippage
  remainingTokens: number;     // Tokens still held

  // USD tracking
  initialSizeUsd: number;      // Gross amount spent ($10)
  netInvestedUsd: number;      // Net after buy fees+slippage (what actually bought tokens)
  remainingSizeUsd: number;    // Current USD value of remaining tokens
  soldUsd: number;             // Total net proceeds from sells
  totalFeesUsd: number;        // Total fees paid (buy + sell)

  entryTime: number;
  lastUpdate: number;

  status: PositionStatus;
  pnlUsd: number;
  pnlPct: number;

  uniqueBuyersAtEntry: number;
  marketCapAtEntry: number;
  buySellRatioAtEntry: number;
  marketCapGrowthPctAtEntry: number;
  momentumStepPctAtEntry: number;
  momentumConfirmationsAtEntry: number;
  momentumWindowGrowthPctAtEntry: number;
  developerLaunchesAtEntry: number;
  capitalBeforeBuy: number;
  strategyConfigVersionAtEntry: string;
  entryExecutionRoute: 'public_rpc_simulated' | 'private_bundle_simulated';
  entryPriorityFeeSol: number;
  entryPrivateTipSol: number;
  entryPriorityFeeSource: 'rpc_recent_fees' | 'static_fallback';

  // Smart tracking
  previousPriceSol: number;      // Previous price update (for velocity)
  peakGainPct: number;           // Highest PNL % reached
  peakPnlPct: number;            // Best net PNL % after simulated fees/slippage
  worstPnlPct: number;           // Worst net PNL % after simulated fees/slippage

  exitReason?: string;
}

export interface CandidateCheck {
  actual: number | boolean;
  threshold: number | boolean | { min: number; max: number };
  passed: boolean;
}

export interface CandidateEvaluation {
  score: number;
  checks: Record<string, CandidateCheck>;
  rejectionReasons: string[];
}

export type TradeAction = 'BUY' | 'SELL' | 'PARTIAL_SELL';

export interface TradeEvent {
  action: TradeAction;
  position: Position;
  amountUsd: number;
  priceUsd: number;
  reason: string;
  timestamp: number;
}

// ── Daily Summary ──

export interface DailyStats {
  trades: number;
  wins: number;
  losses: number;
  pnlUsd: number;
  pnlPct: number;
  totalFeesUsd: number;
  avgHoldTimeSec: number;
  avgPnlPerTrade: number;
  bestTrade: { symbol: string; pnlPct: number } | null;
  worstTrade: { symbol: string; pnlPct: number } | null;
  exitReasons: Record<string, number>;
  tokensScanned: number;
  capitalStart: number;
  capitalEnd: number;
}

// ── Bot State ──

export interface BotState {
  budgetRemaining: number;
  totalPnl: number;
  tradesExecuted: number;
  positions: Map<string, Position>;
  startTime: number;
  solPriceUsd: number;
}
