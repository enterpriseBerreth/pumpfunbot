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
  latestMarketCapSol: number;
  latestPriceSol: number;
  latestPriceUsd: number;
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

  entryPriceSol: number;
  entryPriceUsd: number;
  currentPriceSol: number;
  currentPriceUsd: number;
  highestPriceSol: number;
  highestPriceUsd: number;

  initialSizeUsd: number;
  remainingSizeUsd: number;
  soldUsd: number;

  entryTime: number;
  lastUpdate: number;

  status: PositionStatus;
  pnlUsd: number;
  pnlPct: number;

  uniqueBuyersAtEntry: number;
  capitalBeforeBuy: number;

  takeProfitLevelsHit: number[];
  trailingStopPriceSol: number;

  exitReason?: string;
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

// ── Bot State ──

export interface BotState {
  budgetRemaining: number;
  totalPnl: number;
  tradesExecuted: number;
  positions: Map<string, Position>;
  startTime: number;
  solPriceUsd: number;
}
