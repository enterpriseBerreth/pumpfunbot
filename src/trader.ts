import { CONFIG } from './config.js';
import { Position, TradeEvent, BotState, TokenCandidate, DailyStats } from './types.js';
import { fetchMultipleTokenPrices, getSolPrice } from './scanner.js';
import { TelegramAlert } from './telegram.js';
import { log } from './logger.js';

const MODULE = 'TRADER';

type ExecutionProfile = {
  route: 'public_rpc_simulated' | 'private_bundle_simulated';
  priorityFeeSol: number;
  privateTipSol: number;
  priorityFeeSource: 'rpc_recent_fees' | 'static_fallback';
};

export class PaperTrader {
  onTradeClosed?: (position: Position) => Promise<void> | void;
  private state: BotState;
  private telegram: TelegramAlert;
  private priceInterval: ReturnType<typeof setInterval> | null = null;
  private tradeLog: TradeEvent[] = [];
  private wins = 0;
  private losses = 0;
  private uniqueSellers = new Map<string, Set<string>>();

  constructor(telegram: TelegramAlert) {
    this.telegram = telegram;
    this.state = {
      budgetRemaining: CONFIG.STARTING_BUDGET_USD,
      totalPnl: 0,
      tradesExecuted: 0,
      positions: new Map(),
      startTime: Date.now(),
      solPriceUsd: getSolPrice(),
    };
  }

  // ── Getters ──

  get openPositionCount(): number {
    let count = 0;
    for (const p of this.state.positions.values()) {
      if (p.status === 'open' || p.status === 'partial') count++;
    }
    return count;
  }

  canTrade(requiredSizeUsd = CONFIG.TRADE_SIZE_USD): boolean {
    return (
      this.openPositionCount < CONFIG.MAX_CONCURRENT_TRADES &&
      this.getTodayRealizedPnl() > -CONFIG.DAILY_LOSS_LIMIT_USD &&
      this.state.budgetRemaining >= requiredSizeUsd
    );
  }

  private getTodayRealizedPnl(): number {
    const todayStart = new Date().setUTCHours(0, 0, 0, 0);
    return Array.from(this.state.positions.values())
      .filter((position) => position.status === 'closed' && position.entryTime >= todayStart)
      .reduce((sum, position) => sum + position.pnlUsd, 0);
  }

  hasPosition(mint: string): boolean {
    const pos = this.state.positions.get(mint);
    return !!pos && (pos.status === 'open' || pos.status === 'partial');
  }

  recordTokenTrade(mint: string, side: 'buy' | 'sell', traderPublicKey: string): void {
    const position = this.state.positions.get(mint);
    if (!position || position.status === 'closed') return;

    if (side === 'buy') return;

    const sellers = this.uniqueSellers.get(mint) ?? new Set<string>();
    sellers.add(traderPublicKey);
    this.uniqueSellers.set(mint, sellers);

    if (sellers.size >= CONFIG.CONSECUTIVE_UNIQUE_SELLS_TO_EXIT) {
      void this.executeSell(position, `Order-flow exit: 100% sold after ${sellers.size} unique sellers`);
    }
  }

  getOpenMints(): string[] {
    return Array.from(this.state.positions.values())
      .filter((p) => p.status === 'open' || p.status === 'partial')
      .map((p) => p.mint);
  }

  // ── Realistic Fill Simulation ──

  private async getExecutionProfile(): Promise<ExecutionProfile> {
    let priorityFeeSol = CONFIG.PRIORITY_FEE_SOL;
    let priorityFeeSource: ExecutionProfile['priorityFeeSource'] = 'static_fallback';

    if (CONFIG.DYNAMIC_PRIORITY_FEE_ENABLED && CONFIG.SOLANA_RPC_URL) {
      try {
        const response = await fetch(CONFIG.SOLANA_RPC_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getRecentPrioritizationFees', params: [] }),
          signal: AbortSignal.timeout(5_000),
        });
        const payload = await response.json() as { result?: Array<{ prioritizationFee?: number }> };
        const fees = (payload.result ?? [])
          .map((item) => item.prioritizationFee)
          .filter((fee): fee is number => typeof fee === 'number' && Number.isFinite(fee) && fee >= 0)
          .sort((left, right) => left - right);

        if (fees.length > 0) {
          const percentileFeeLamports = fees[Math.floor((fees.length - 1) * 0.75)];
          priorityFeeSol = Math.min(
            CONFIG.PRIORITY_FEE_MAX_SOL,
            Math.max(CONFIG.PRIORITY_FEE_MIN_SOL, percentileFeeLamports / 1_000_000_000),
          );
          priorityFeeSource = 'rpc_recent_fees';
        }
      } catch (error) {
        log.warn(MODULE, `Priority-fee sample unavailable; using static fallback: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      route: CONFIG.PRIVATE_SUBMISSION_SIMULATION ? 'private_bundle_simulated' : 'public_rpc_simulated',
      priorityFeeSol,
      privateTipSol: CONFIG.PRIVATE_SUBMISSION_SIMULATION ? CONFIG.PRIVATE_SUBMISSION_TIP_SOL : 0,
      priorityFeeSource,
    };
  }

  private simulateBuyFill(marketPriceSol: number, sizeUsd: number, execution: ExecutionProfile): {
    fillPriceSol: number;
    fillPriceUsd: number;
    tokensAcquired: number;
    netInvestedUsd: number;
    totalFeeUsd: number;
  } {
    const solPrice = getSolPrice();

    // 1. Pump.fun 1% platform fee
    const platformFeeUsd = sizeUsd * (CONFIG.PUMPFUN_FEE_PCT / 100);

    // 2. Solana network fee + priority fee
    const networkFeeUsd = (CONFIG.SOLANA_TX_FEE_SOL + execution.priorityFeeSol + execution.privateTipSol) * solPrice;

    // 3. Total fees
    const totalFeeUsd = platformFeeUsd + networkFeeUsd;

    // 4. Net USD that actually buys tokens
    const netUsd = sizeUsd - totalFeeUsd;

    // 5. Slippage: buying into bonding curve pushes price up
    const fillPriceSol = marketPriceSol * (1 + CONFIG.BUY_SLIPPAGE_PCT / 100);
    const fillPriceUsd = fillPriceSol * solPrice;

    // 6. Tokens acquired at fill price
    const tokensAcquired = netUsd / fillPriceUsd;

    return {
      fillPriceSol,
      fillPriceUsd,
      tokensAcquired,
      netInvestedUsd: netUsd,
      totalFeeUsd,
    };
  }

  private simulateSellFill(marketPriceSol: number, tokensToSell: number, execution: ExecutionProfile): {
    fillPriceSol: number;
    fillPriceUsd: number;
    grossProceedsUsd: number;
    netProceedsUsd: number;
    feeUsd: number;
  } {
    const solPrice = getSolPrice();

    // 1. Slippage: selling into bonding curve pushes price down
    const fillPriceSol = marketPriceSol * (1 - CONFIG.SELL_SLIPPAGE_PCT / 100);
    const fillPriceUsd = fillPriceSol * solPrice;

    // 2. Gross proceeds
    const grossProceedsUsd = tokensToSell * fillPriceUsd;

    // 3. Pump.fun platform fee
    const platformFeeUsd = grossProceedsUsd * (CONFIG.PUMPFUN_FEE_PCT / 100);

    // 4. Network fee
    const networkFeeUsd = (CONFIG.SOLANA_TX_FEE_SOL + execution.priorityFeeSol + execution.privateTipSol) * solPrice;

    // 5. Net proceeds
    const feeUsd = platformFeeUsd + networkFeeUsd;
    const netProceedsUsd = grossProceedsUsd - feeUsd;

    return {
      fillPriceSol,
      fillPriceUsd,
      grossProceedsUsd,
      netProceedsUsd,
      feeUsd,
    };
  }

  // ── Buy Execution ──

  async executeBuy(candidate: TokenCandidate): Promise<void> {
    const sizeUsd = this.getTradeSize(candidate);

    if (!this.canTrade(sizeUsd)) {
      log.warn(MODULE, 'Cannot trade - limit reached or insufficient budget');
      return;
    }

    if (this.hasPosition(candidate.mint)) {
      log.warn(MODULE, `Already have position in ${candidate.symbol}`);
      return;
    }

    const capitalBefore = this.state.budgetRemaining;
    const solPrice = getSolPrice();
    const buySellRatio = candidate.sellCount > 0
      ? candidate.buyCount / candidate.sellCount
      : candidate.buyCount;
    const marketCapGrowthPct = candidate.initialMarketCapSol > 0
      ? ((candidate.latestMarketCapSol - candidate.initialMarketCapSol) / candidate.initialMarketCapSol) * 100
      : 0;

    // Simulate realistic buy fill
    const execution = await this.getExecutionProfile();
    const fill = this.simulateBuyFill(candidate.latestPriceSol, sizeUsd, execution);

    // Deduct full trade size from budget (user pays $10 total)
    this.state.budgetRemaining -= sizeUsd;

    const position: Position = {
      id: `${candidate.mint}-${Date.now()}`,
      mint: candidate.mint,
      symbol: candidate.symbol,
      name: candidate.name,

      entryPriceSol: fill.fillPriceSol,
      entryPriceUsd: fill.fillPriceUsd,
      entryMarketPriceSol: candidate.latestPriceSol,
      entryMarketPriceUsd: candidate.latestPriceUsd,
      currentPriceSol: candidate.latestPriceSol,
      currentPriceUsd: candidate.latestPriceUsd,
      highestPriceSol: candidate.latestPriceSol,
      highestPriceUsd: candidate.latestPriceUsd,

      tokenAmount: fill.tokensAcquired,
      remainingTokens: fill.tokensAcquired,

      initialSizeUsd: sizeUsd,
      netInvestedUsd: fill.netInvestedUsd,
      remainingSizeUsd: fill.netInvestedUsd,
      soldUsd: 0,
      totalFeesUsd: fill.totalFeeUsd,

      entryTime: Date.now(),
      lastUpdate: Date.now(),

      status: 'open',
      pnlUsd: -fill.totalFeeUsd, // Start negative (fees already paid)
      pnlPct: (-fill.totalFeeUsd / sizeUsd) * 100,

      uniqueBuyersAtEntry: candidate.uniqueBuyers.size,
      marketCapAtEntry: candidate.latestMarketCapSol,
      buySellRatioAtEntry: buySellRatio,
      marketCapGrowthPctAtEntry: marketCapGrowthPct,
      momentumStepPctAtEntry: candidate.lastMomentumStepPct,
      momentumConfirmationsAtEntry: candidate.momentumConfirmations,
      momentumWindowGrowthPctAtEntry: candidate.momentumWindowGrowthPct,
      developerLaunchesAtEntry: candidate.developerLaunchesAtEntry,
      capitalBeforeBuy: capitalBefore,
      strategyConfigVersionAtEntry: CONFIG.STRATEGY_CONFIG_VERSION,
      entryExecutionRoute: execution.route,
      entryPriorityFeeSol: execution.priorityFeeSol,
      entryPrivateTipSol: execution.privateTipSol,
      entryPriorityFeeSource: execution.priorityFeeSource,

      previousPriceSol: candidate.latestPriceSol,
      peakGainPct: 0,
      peakPnlPct: (-fill.totalFeeUsd / sizeUsd) * 100,
      worstPnlPct: (-fill.totalFeeUsd / sizeUsd) * 100,
    };

    this.state.positions.set(candidate.mint, position);
    this.state.tradesExecuted++;

    const event: TradeEvent = {
      action: 'BUY',
      position,
      amountUsd: sizeUsd,
      priceUsd: fill.fillPriceUsd,
      reason: `${candidate.uniqueBuyers.size} verified unique buyers | MCap: ${candidate.latestMarketCapSol.toFixed(2)} SOL`,
      timestamp: Date.now(),
    };
    this.tradeLog.push(event);

    const mCapUsd = candidate.latestMarketCapSol * solPrice;

    log.trade(
      MODULE,
      `BUY ${candidate.symbol} @ $${this.fmtPrice(fill.fillPriceUsd)} (mkt $${this.fmtPrice(candidate.latestPriceUsd)} +${CONFIG.BUY_SLIPPAGE_PCT}% slip) | $${sizeUsd.toFixed(2)} - $${fill.totalFeeUsd.toFixed(2)} fees = ${fill.tokensAcquired.toFixed(0)} tokens | MCap: $${mCapUsd.toFixed(0)} | Budget: $${this.state.budgetRemaining.toFixed(2)}`
    );

    log.telemetry(MODULE, 'PAPER_TRADE_OPENED', {
      configVersion: position.strategyConfigVersionAtEntry,
      deploymentVersion: CONFIG.DEPLOYMENT_VERSION,
      paperTrade: CONFIG.PAPER_TRADE,
      positionId: position.id,
      mint: position.mint,
      symbol: position.symbol,
      entryTime: new Date(position.entryTime).toISOString(),
      entryMarketPriceUsd: position.entryMarketPriceUsd,
      entryFillPriceUsd: position.entryPriceUsd,
      entryMarketCapSol: position.marketCapAtEntry,
      entryUniqueBuyers: position.uniqueBuyersAtEntry,
      entryBuySellRatio: position.buySellRatioAtEntry,
      entryMarketCapGrowthPct: position.marketCapGrowthPctAtEntry,
      entryMomentumStepPct: position.momentumStepPctAtEntry,
      entryMomentumConfirmations: position.momentumConfirmationsAtEntry,
      entryMomentumWindowGrowthPct: position.momentumWindowGrowthPctAtEntry,
      entryDeveloperLaunches: position.developerLaunchesAtEntry,
      tradeSizeUsd: position.initialSizeUsd,
      buyFeesUsd: fill.totalFeeUsd,
      buySlippagePct: CONFIG.BUY_SLIPPAGE_PCT,
      entryExecutionRoute: position.entryExecutionRoute,
      entryPriorityFeeSol: position.entryPriorityFeeSol,
      entryPrivateTipSol: position.entryPrivateTipSol,
      entryPriorityFeeSource: position.entryPriorityFeeSource,
    });

    // No Telegram alert on buy — only alert after final sell
  }

  // ── Price Update (called from WebSocket trade events) ──

  private getTradeSize(candidate: TokenCandidate): number {
    const marketCapGrowthPct = candidate.initialMarketCapSol > 0
      ? ((candidate.latestMarketCapSol - candidate.initialMarketCapSol) / candidate.initialMarketCapSol) * 100
      : 0;
    const isHighConviction = candidate.uniqueBuyers.size >= CONFIG.HIGH_CONVICTION_MIN_UNIQUE_BUYERS
      && marketCapGrowthPct >= CONFIG.HIGH_CONVICTION_MIN_MCAP_GROWTH_PCT
      && candidate.momentumConfirmations >= CONFIG.HIGH_CONVICTION_MIN_MOMENTUM_CONFIRMATIONS
      && candidate.developerLaunchesAtEntry <= CONFIG.MAX_DEVELOPER_LAUNCHES_IN_WINDOW;
    if (isHighConviction) return CONFIG.HIGH_CONVICTION_TRADE_SIZE_USD;
    if (candidate.momentumConfirmations >= CONFIG.MIN_CONSECUTIVE_MOMENTUM_UPDATES + 1
      && candidate.developerLaunchesAtEntry <= CONFIG.MAX_DEVELOPER_LAUNCHES_IN_WINDOW) return CONFIG.TRADE_SIZE_USD;
    return CONFIG.PROBE_TRADE_SIZE_USD;
  }

  updatePrice(mint: string, priceSol: number, priceUsd: number): void {
    const position = this.state.positions.get(mint);
    if (!position || position.status === 'closed') return;

    // Save previous price for velocity detection
    position.previousPriceSol = position.currentPriceSol;

    position.currentPriceSol = priceSol;
    position.currentPriceUsd = priceUsd;
    position.lastUpdate = Date.now();

    // Track highest price
    if (priceSol > position.highestPriceSol) {
      position.highestPriceSol = priceSol;
      position.highestPriceUsd = priceUsd;
    }

    // Track peak gain %
    const gainPct = ((priceSol - position.entryPriceSol) / position.entryPriceSol) * 100;
    if (gainPct > position.peakGainPct) {
      position.peakGainPct = gainPct;
    }

    // Recalculate position value and PNL
    const currentValueUsd = position.remainingTokens * priceUsd;
    position.remainingSizeUsd = currentValueUsd;
    const totalValueUsd = position.soldUsd + currentValueUsd;
    position.pnlUsd = totalValueUsd - position.initialSizeUsd;
    position.pnlPct = (position.pnlUsd / position.initialSizeUsd) * 100;
    position.peakPnlPct = Math.max(position.peakPnlPct, position.pnlPct);
    position.worstPnlPct = Math.min(position.worstPnlPct, position.pnlPct);

    // Check exit conditions
    this.checkExits(position);
  }

  // ── Fallback price monitor (Jupiter API) ──

  startPriceMonitor(): void {
    log.info(MODULE, `Starting fallback price monitor (every ${CONFIG.PRICE_CHECK_INTERVAL_MS / 1000}s)`);
    this.priceInterval = setInterval(() => this.pollPrices(), CONFIG.PRICE_CHECK_INTERVAL_MS);
  }

  stopPriceMonitor(): void {
    if (this.priceInterval) {
      clearInterval(this.priceInterval);
      this.priceInterval = null;
    }
  }

  private async pollPrices(): Promise<void> {
    const openMints = this.getOpenMints();
    if (openMints.length === 0) return;

    const prices = await fetchMultipleTokenPrices(openMints);
    const solPrice = getSolPrice();

    for (const [mint, priceUsd] of prices) {
      const priceSol = priceUsd / solPrice;
      this.updatePrice(mint, priceSol, priceUsd);
    }
  }

  // ── Smart Exit Logic ──

  private async checkExits(position: Position): Promise<void> {
    if (position.status === 'closed') return;

    const gainPct = ((position.currentPriceSol - position.entryPriceSol) / position.entryPriceSol) * 100;
    const holdTimeMin = (Date.now() - position.entryTime) / 60_000;

    // How far has price dropped from its peak?
    const dropFromPeakPct = position.highestPriceSol > 0
      ? ((position.highestPriceSol - position.currentPriceSol) / position.highestPriceSol) * 100
      : 0;

    // Rapid dump detection: how much did price drop since last update?
    const lastMovePct = position.previousPriceSol > 0
      ? ((position.previousPriceSol - position.currentPriceSol) / position.previousPriceSol) * 100
      : 0;

    // ── 1. Take profit at +50% → full sell ──
    if (gainPct >= CONFIG.TAKE_PROFIT_PCT) {
      await this.executeSell(position, `Take profit: +${gainPct.toFixed(1)}%`);
      return;
    }

    // ── 2. Rapid dump: price dropped 10%+ in a single update → instant sell ──
    if (lastMovePct >= CONFIG.RAPID_DUMP_PCT) {
      await this.executeSell(position, `Rapid dump: -${lastMovePct.toFixed(1)}% in one update`);
      return;
    }

    // ── 3. Collapse detection: price dropped 15% from peak while we were up 5%+ ──
    if (dropFromPeakPct >= CONFIG.COLLAPSE_DROP_FROM_PEAK_PCT && position.peakGainPct >= CONFIG.COLLAPSE_MIN_GAIN_PCT) {
      await this.executeSell(position, `Collapse: -${dropFromPeakPct.toFixed(1)}% from peak (was +${position.peakGainPct.toFixed(1)}%)`);
      return;
    }

    // ── 4. Hard stop loss at -25% ──
    if (gainPct <= -CONFIG.STOP_LOSS_PCT) {
      await this.executeSell(position, `Stop loss: ${gainPct.toFixed(1)}%`);
      return;
    }

    // ── 5. Stale exit: flat for 10 min with <10% gain ──
    if (holdTimeMin >= CONFIG.STALE_EXIT_MINUTES && gainPct < CONFIG.STALE_EXIT_MIN_GAIN_PCT) {
      await this.executeSell(position, `Stale: ${holdTimeMin.toFixed(0)}m with only ${gainPct.toFixed(1)}%`);
      return;
    }

    // ── 6. Max hold time ──
    if (holdTimeMin >= CONFIG.MAX_HOLD_TIME_MINUTES) {
      await this.executeSell(position, `Max hold (${CONFIG.MAX_HOLD_TIME_MINUTES}m)`);
      return;
    }
  }

  // ── Full Sell ──

  private async executeSell(position: Position, reason: string): Promise<void> {
    if (position.remainingTokens <= 0) return;

    const tokensToSell = position.remainingTokens;

    // Simulate realistic sell fill
    const execution = await this.getExecutionProfile();
    const fill = this.simulateSellFill(position.currentPriceSol, tokensToSell, execution);

    position.soldUsd += fill.netProceedsUsd;
    position.totalFeesUsd += fill.feeUsd;
    position.remainingTokens = 0;
    position.remainingSizeUsd = 0;
    position.status = 'closed';
    position.exitReason = reason;
    this.uniqueSellers.delete(position.mint);

    // Return net proceeds to budget
    this.state.budgetRemaining += fill.netProceedsUsd;

    // Final PNL = all proceeds - initial investment
    const totalPnl = position.soldUsd - position.initialSizeUsd;
    const totalPnlPct = (totalPnl / position.initialSizeUsd) * 100;
    position.pnlUsd = totalPnl;
    position.pnlPct = totalPnlPct;

    this.state.totalPnl += totalPnl;

    if (totalPnl >= 0) this.wins++;
    else this.losses++;

    const holdTime = this.formatHoldTime(Date.now() - position.entryTime);
    const sign = totalPnl >= 0 ? '+' : '';

    log.trade(
      MODULE,
      `SELL ${position.symbol} @ $${this.fmtPrice(fill.fillPriceUsd)} (mkt $${this.fmtPrice(position.currentPriceUsd)} -${CONFIG.SELL_SLIPPAGE_PCT}% slip) | Fees: $${fill.feeUsd.toFixed(2)} | PNL: ${sign}$${totalPnl.toFixed(2)} (${sign}${totalPnlPct.toFixed(1)}%) | ${reason} | Hold: ${holdTime}`
    );

    log.telemetry(MODULE, 'PAPER_TRADE_CLOSED', {
      configVersion: position.strategyConfigVersionAtEntry,
      deploymentVersion: CONFIG.DEPLOYMENT_VERSION,
      paperTrade: CONFIG.PAPER_TRADE,
      positionId: position.id,
      mint: position.mint,
      symbol: position.symbol,
      entryTime: new Date(position.entryTime).toISOString(),
      exitTime: new Date().toISOString(),
      entryMarketPriceUsd: position.entryMarketPriceUsd,
      entryFillPriceUsd: position.entryPriceUsd,
      exitMarketPriceUsd: position.currentPriceUsd,
      exitFillPriceUsd: fill.fillPriceUsd,
      pnlUsd: totalPnl,
      pnlPct: totalPnlPct,
      peakPnlPct: position.peakPnlPct,
      worstPnlPct: position.worstPnlPct,
      peakMarketGainPct: position.peakGainPct,
      entryUniqueBuyers: position.uniqueBuyersAtEntry,
      entryBuySellRatio: position.buySellRatioAtEntry,
      entryMarketCapGrowthPct: position.marketCapGrowthPctAtEntry,
      entryMomentumStepPct: position.momentumStepPctAtEntry,
      entryMomentumConfirmations: position.momentumConfirmationsAtEntry,
      entryMomentumWindowGrowthPct: position.momentumWindowGrowthPctAtEntry,
      entryDeveloperLaunches: position.developerLaunchesAtEntry,
      holdTimeSec: Math.round((Date.now() - position.entryTime) / 1000),
      totalFeesUsd: position.totalFeesUsd,
      exitTrigger: reason,
      sellSlippagePct: CONFIG.SELL_SLIPPAGE_PCT,
      entryExecutionRoute: position.entryExecutionRoute,
      entryPriorityFeeSol: position.entryPriorityFeeSol,
      entryPrivateTipSol: position.entryPrivateTipSol,
      entryPriorityFeeSource: position.entryPriorityFeeSource,
      exitExecutionRoute: execution.route,
      exitPriorityFeeSol: execution.priorityFeeSol,
      exitPrivateTipSol: execution.privateTipSol,
      exitPriorityFeeSource: execution.priorityFeeSource,
    });

    const event: TradeEvent = {
      action: 'SELL',
      position,
      amountUsd: fill.netProceedsUsd,
      priceUsd: fill.fillPriceUsd,
      reason,
      timestamp: Date.now(),
    };
    this.tradeLog.push(event);

    await this.telegram.sendTradeClosedAlert({
      tokenName: `${position.symbol} (${position.name})`,
      capitalBefore: position.capitalBeforeBuy,
      capitalAfter: this.state.budgetRemaining,
      pnlUsd: totalPnl,
      pnlPct: totalPnlPct,
      exitReason: reason,
      peakPnlPct: position.peakPnlPct,
      worstPnlPct: position.worstPnlPct,
      holdTime,
      totalFeesUsd: position.totalFeesUsd,
      entryBuyers: position.uniqueBuyersAtEntry,
    });
    await this.onTradeClosed?.(position);
  }

  // ── Status & Reporting ──

  getOpenPositions(): Position[] {
    return Array.from(this.state.positions.values()).filter(
      (p) => p.status === 'open' || p.status === 'partial'
    );
  }

  getWinRate(): number {
    const total = this.wins + this.losses;
    return total > 0 ? (this.wins / total) * 100 : 0;
  }

  printStatus(): void {
    const open = this.getOpenPositions();
    const runtime = this.formatHoldTime(Date.now() - this.state.startTime);
    const winRate = this.getWinRate();
    const todayStart = new Date().setUTCHours(0, 0, 0, 0);
    const todayWins = Array.from(this.state.positions.values()).filter(
      (position) => position.status === 'closed' && position.entryTime >= todayStart && position.pnlUsd >= 0
    ).length;
    const sign = this.state.totalPnl >= 0 ? '+' : '';

    log.banner('PUMPFUNBOT STATUS');
    console.log(`  Mode:            ${CONFIG.PAPER_TRADE ? 'PAPER TRADE (realistic sim)' : 'LIVE'}`);
    console.log(`  Runtime:         ${runtime}`);
    console.log(`  Budget:          $${this.state.budgetRemaining.toFixed(2)} / $${CONFIG.STARTING_BUDGET_USD}`);
    console.log(`  Total PNL:       ${sign}$${this.state.totalPnl.toFixed(2)}`);
    console.log(`  Today realized:  $${this.getTodayRealizedPnl().toFixed(2)} (circuit breaker: -$${CONFIG.DAILY_LOSS_LIMIT_USD})`);
    console.log(`  Trades:          ${this.state.tradesExecuted} (W: ${this.wins} / L: ${this.losses} | ${winRate.toFixed(0)}%)`);
    console.log(`  Win Target:      ${todayWins} / ${CONFIG.DAILY_PROFITABLE_TRADE_TARGET} profitable trades today`);
    console.log(`  Open positions:  ${open.length} / ${CONFIG.MAX_CONCURRENT_TRADES}`);
    console.log(`  SOL Price:       $${getSolPrice().toFixed(2)}`);
    console.log(`  Sim fees:        ${CONFIG.PUMPFUN_FEE_PCT}% + ${CONFIG.BUY_SLIPPAGE_PCT}% buy slip / ${CONFIG.SELL_SLIPPAGE_PCT}% sell slip`);

    if (open.length > 0) {
      console.log(`\n  Open Positions:`);
      for (const p of open) {
        const sign = p.pnlPct >= 0 ? '+' : '';
        const holdTime = this.formatHoldTime(Date.now() - p.entryTime);
        const tokenVal = (p.remainingTokens * p.currentPriceUsd).toFixed(2);
        const peakStr = p.peakGainPct > 0 ? ` | Peak: +${p.peakGainPct.toFixed(1)}%` : '';
        console.log(
          `    ${p.symbol.padEnd(10)} | Entry: $${this.fmtPrice(p.entryPriceUsd)} | Now: $${this.fmtPrice(p.currentPriceUsd)} | Val: $${tokenVal} | PNL: ${sign}${p.pnlPct.toFixed(1)}%${peakStr} | Hold: ${holdTime}`
        );
      }
    }
    console.log('');
  }

  // ── Daily Stats ──

  getDailyStats(tokensScanned: number): DailyStats {
    const now = Date.now();
    const dayStart = new Date().setUTCHours(0, 0, 0, 0); // UTC midnight

    // Closed trades from today
    const todayTrades = Array.from(this.state.positions.values()).filter(
      (p) => p.status === 'closed' && p.entryTime >= dayStart
    );

    const wins = todayTrades.filter((t) => t.pnlUsd >= 0).length;
    const losses = todayTrades.filter((t) => t.pnlUsd < 0).length;
    const pnlUsd = todayTrades.reduce((s, t) => s + t.pnlUsd, 0);
    const totalFees = todayTrades.reduce((s, t) => s + t.totalFeesUsd, 0);

    const holdTimes = todayTrades.map((t) => (t.lastUpdate - t.entryTime) / 1000);
    const avgHold = holdTimes.length > 0 ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length : 0;

    let best: { symbol: string; pnlPct: number } | null = null;
    let worst: { symbol: string; pnlPct: number } | null = null;
    for (const t of todayTrades) {
      if (!best || t.pnlPct > best.pnlPct) best = { symbol: t.symbol, pnlPct: t.pnlPct };
      if (!worst || t.pnlPct < worst.pnlPct) worst = { symbol: t.symbol, pnlPct: t.pnlPct };
    }

    const exitReasons: Record<string, number> = {};
    for (const t of todayTrades) {
      const reason = t.exitReason || 'unknown';
      const key = reason.replace(/[:\-].*/, '').trim(); // Normalize
      exitReasons[key] = (exitReasons[key] || 0) + 1;
    }

    const capitalStart = CONFIG.STARTING_BUDGET_USD;
    const capitalEnd = this.state.budgetRemaining;
    const pnlPct = capitalStart > 0 ? (pnlUsd / capitalStart) * 100 : 0;

    return {
      trades: todayTrades.length,
      wins,
      losses,
      pnlUsd,
      pnlPct,
      totalFeesUsd: totalFees,
      avgHoldTimeSec: avgHold,
      avgPnlPerTrade: todayTrades.length > 0 ? pnlUsd / todayTrades.length : 0,
      bestTrade: best,
      worstTrade: worst,
      exitReasons,
      tokensScanned,
      capitalStart,
      capitalEnd,
    };
  }

  // ── Helpers ──

  private fmtPrice(price: number): string {
    if (price === 0) return '0';
    if (price < 0.0000001) return price.toExponential(4);
    if (price < 0.00001) return price.toFixed(10);
    if (price < 0.001) return price.toFixed(8);
    if (price < 0.01) return price.toFixed(6);
    if (price < 1) return price.toFixed(4);
    return price.toFixed(2);
  }

  private formatHoldTime(ms: number): string {
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ${secs % 60}s`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m`;
  }
}
