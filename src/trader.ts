import { CONFIG } from './config.js';
import { Position, TradeEvent, BotState, TokenCandidate } from './types.js';
import { fetchMultipleTokenPrices, getSolPrice } from './scanner.js';
import { TelegramAlert } from './telegram.js';
import { log } from './logger.js';

const MODULE = 'TRADER';

export class PaperTrader {
  private state: BotState;
  private telegram: TelegramAlert;
  private priceInterval: ReturnType<typeof setInterval> | null = null;
  private tradeLog: TradeEvent[] = [];
  private wins = 0;
  private losses = 0;

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

  canTrade(): boolean {
    return (
      this.openPositionCount < CONFIG.MAX_CONCURRENT_TRADES &&
      this.state.budgetRemaining >= CONFIG.TRADE_SIZE_USD
    );
  }

  hasPosition(mint: string): boolean {
    const pos = this.state.positions.get(mint);
    return !!pos && (pos.status === 'open' || pos.status === 'partial');
  }

  getOpenMints(): string[] {
    return Array.from(this.state.positions.values())
      .filter((p) => p.status === 'open' || p.status === 'partial')
      .map((p) => p.mint);
  }

  // ── Buy Execution ──

  async executeBuy(candidate: TokenCandidate): Promise<void> {
    const sizeUsd = CONFIG.TRADE_SIZE_USD;

    if (!this.canTrade()) {
      log.warn(MODULE, 'Cannot trade - limit reached or insufficient budget');
      return;
    }

    if (this.hasPosition(candidate.mint)) {
      log.warn(MODULE, `Already have position in ${candidate.symbol}`);
      return;
    }

    // Deduct from budget
    this.state.budgetRemaining -= sizeUsd;

    const position: Position = {
      id: `${candidate.mint}-${Date.now()}`,
      mint: candidate.mint,
      symbol: candidate.symbol,
      name: candidate.name,

      entryPriceSol: candidate.latestPriceSol,
      entryPriceUsd: candidate.latestPriceUsd,
      currentPriceSol: candidate.latestPriceSol,
      currentPriceUsd: candidate.latestPriceUsd,
      highestPriceSol: candidate.latestPriceSol,
      highestPriceUsd: candidate.latestPriceUsd,

      initialSizeUsd: sizeUsd,
      remainingSizeUsd: sizeUsd,
      soldUsd: 0,

      entryTime: Date.now(),
      lastUpdate: Date.now(),

      status: 'open',
      pnlUsd: 0,
      pnlPct: 0,

      uniqueBuyersAtEntry: candidate.uniqueBuyers.size,
      capitalBeforeBuy: this.state.budgetRemaining + sizeUsd,

      takeProfitLevelsHit: [],
      trailingStopPriceSol: candidate.latestPriceSol * (1 - CONFIG.INITIAL_STOP_LOSS_PCT / 100),
    };

    this.state.positions.set(candidate.mint, position);
    this.state.tradesExecuted++;

    const event: TradeEvent = {
      action: 'BUY',
      position,
      amountUsd: sizeUsd,
      priceUsd: candidate.latestPriceUsd,
      reason: `${candidate.uniqueBuyers.size} unique buyers | MCap: ${candidate.latestMarketCapSol.toFixed(2)} SOL`,
      timestamp: Date.now(),
    };
    this.tradeLog.push(event);

    const mCapUsd = candidate.latestMarketCapSol * getSolPrice();

    log.trade(
      MODULE,
      `BUY ${candidate.symbol} @ $${this.fmtPrice(candidate.latestPriceUsd)} | Size: $${sizeUsd.toFixed(2)} | Buyers: ${candidate.uniqueBuyers.size} | MCap: $${mCapUsd.toFixed(0)} | Budget: $${this.state.budgetRemaining.toFixed(2)}`
    );

    // Send Telegram buy alert
    await this.telegram.sendBuyAlert({
      tokenName: `${candidate.symbol} (${candidate.name})`,
      mint: candidate.mint,
      priceUsd: candidate.latestPriceUsd,
      sizeUsd,
      uniqueBuyers: candidate.uniqueBuyers.size,
      marketCapUsd: mCapUsd,
      budgetRemaining: this.state.budgetRemaining,
      capitalBeforeBuy: this.state.budgetRemaining + sizeUsd,
    });
  }

  // ── Price Update (called from WebSocket trade events) ──

  updatePrice(mint: string, priceSol: number, priceUsd: number): void {
    const position = this.state.positions.get(mint);
    if (!position || position.status === 'closed') return;

    position.currentPriceSol = priceSol;
    position.currentPriceUsd = priceUsd;
    position.lastUpdate = Date.now();

    // Track highest price
    if (priceSol > position.highestPriceSol) {
      position.highestPriceSol = priceSol;
      position.highestPriceUsd = priceUsd;
    }

    // Recalculate PNL
    const priceChangePct = ((priceSol - position.entryPriceSol) / position.entryPriceSol) * 100;
    position.pnlPct = priceChangePct;
    position.pnlUsd = position.remainingSizeUsd * (priceChangePct / 100);

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

  // ── Exit Logic ──

  private async checkExits(position: Position): Promise<void> {
    if (position.status === 'closed') return;

    const pricePctFromEntry = ((position.currentPriceSol - position.entryPriceSol) / position.entryPriceSol) * 100;
    const holdTimeMs = Date.now() - position.entryTime;
    const holdTimeMin = holdTimeMs / 60_000;

    // ── 1. Take-profit levels ──
    for (const level of CONFIG.TAKE_PROFIT_LEVELS) {
      if (position.takeProfitLevelsHit.includes(level.triggerPct)) continue;
      if (pricePctFromEntry >= level.triggerPct) {
        const sellAmount = position.initialSizeUsd * (level.sellPct / 100);
        const actualSell = Math.min(sellAmount, position.remainingSizeUsd);
        if (actualSell <= 0) continue;

        position.takeProfitLevelsHit.push(level.triggerPct);
        await this.executePartialSell(
          position,
          actualSell,
          `Take profit @ +${level.triggerPct}%`
        );

        // After all take-profit levels hit, tighten trailing stop for remaining "moon bag"
        if (position.takeProfitLevelsHit.length >= CONFIG.TAKE_PROFIT_LEVELS.length) {
          const tightStop = position.highestPriceSol * 0.85; // 15% trail for moon bag
          if (tightStop > position.trailingStopPriceSol) {
            position.trailingStopPriceSol = tightStop;
            log.info(MODULE, `${position.symbol} - Moon bag trailing stop set @ $${this.fmtPrice(tightStop * getSolPrice())}`);
          }
        }
      }
    }

    // ── 2. Update trailing stop ──
    this.updateTrailingStop(position, pricePctFromEntry);

    // ── 3. Check trailing stop hit ──
    if (position.currentPriceSol <= position.trailingStopPriceSol && position.remainingSizeUsd > 0) {
      await this.executeSell(position, `Trailing stop hit (price dropped to $${this.fmtPrice(position.currentPriceUsd)})`);
      return;
    }

    // ── 4. Initial stop loss (before any profit taken) ──
    if (pricePctFromEntry <= -CONFIG.INITIAL_STOP_LOSS_PCT && position.takeProfitLevelsHit.length === 0) {
      await this.executeSell(position, `Stop loss: ${pricePctFromEntry.toFixed(1)}%`);
      return;
    }

    // ── 5. Stale exit ──
    if (holdTimeMin >= CONFIG.STALE_EXIT_MINUTES && pricePctFromEntry < CONFIG.STALE_EXIT_MIN_GAIN_PCT) {
      await this.executeSell(position, `Stale exit: +${pricePctFromEntry.toFixed(1)}% after ${holdTimeMin.toFixed(0)}m`);
      return;
    }

    // ── 6. Max hold time ──
    if (holdTimeMin >= CONFIG.MAX_HOLD_TIME_MINUTES) {
      await this.executeSell(position, `Max hold time (${CONFIG.MAX_HOLD_TIME_MINUTES}m)`);
      return;
    }
  }

  private updateTrailingStop(position: Position, pricePctFromEntry: number): void {
    let bestTier = null;
    for (const tier of CONFIG.TRAILING_STOP_TIERS) {
      if (pricePctFromEntry >= tier.activateAbovePct) {
        bestTier = tier;
      }
    }

    if (!bestTier) return;

    const newStop = position.highestPriceSol * (1 - bestTier.trailDistancePct / 100);
    if (newStop > position.trailingStopPriceSol) {
      const oldStopUsd = position.trailingStopPriceSol * getSolPrice();
      const newStopUsd = newStop * getSolPrice();
      position.trailingStopPriceSol = newStop;
      log.info(
        MODULE,
        `${position.symbol} - Trail raised: $${this.fmtPrice(oldStopUsd)} -> $${this.fmtPrice(newStopUsd)} (${bestTier.trailDistancePct}% from peak at +${pricePctFromEntry.toFixed(0)}%)`
      );
    }
  }

  // ── Sell Execution ──

  private async executeSell(position: Position, reason: string): Promise<void> {
    if (position.remainingSizeUsd <= 0) return;

    const sellAmount = position.remainingSizeUsd;
    const pnlOnSell = sellAmount * (position.pnlPct / 100);
    const proceeds = sellAmount + pnlOnSell;

    position.soldUsd += proceeds;
    position.remainingSizeUsd = 0;
    position.status = 'closed';
    position.exitReason = reason;

    // Return proceeds to budget
    this.state.budgetRemaining += proceeds;

    // Calculate total PNL for this position
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
      `SELL ${position.symbol} @ $${this.fmtPrice(position.currentPriceUsd)} | PNL: ${sign}$${totalPnl.toFixed(2)} (${sign}${totalPnlPct.toFixed(1)}%) | ${reason} | Hold: ${holdTime}`
    );

    const event: TradeEvent = {
      action: 'SELL',
      position,
      amountUsd: sellAmount,
      priceUsd: position.currentPriceUsd,
      reason,
      timestamp: Date.now(),
    };
    this.tradeLog.push(event);

    // Telegram alert
    await this.telegram.sendSellAlert({
      tokenName: `${position.symbol} (${position.name})`,
      mint: position.mint,
      entryPriceUsd: position.entryPriceUsd,
      exitPriceUsd: position.currentPriceUsd,
      pnlUsd: totalPnl,
      pnlPct: totalPnlPct,
      holdTime,
      reason,
      capitalBefore: position.capitalBeforeBuy,
      capitalAfter: this.state.budgetRemaining,
      totalBotPnl: this.state.totalPnl,
      winRate: this.getWinRate(),
    });
  }

  private async executePartialSell(position: Position, amountUsd: number, reason: string): Promise<void> {
    const pnlOnSell = amountUsd * (position.pnlPct / 100);
    const proceeds = amountUsd + pnlOnSell;

    position.soldUsd += proceeds;
    position.remainingSizeUsd -= amountUsd;
    position.status = position.remainingSizeUsd > 0 ? 'partial' : 'closed';

    // Return proceeds to budget
    this.state.budgetRemaining += proceeds;
    this.state.totalPnl += pnlOnSell;

    const holdTime = this.formatHoldTime(Date.now() - position.entryTime);
    const sign = pnlOnSell >= 0 ? '+' : '';

    log.trade(
      MODULE,
      `PARTIAL SELL ${position.symbol} ($${amountUsd.toFixed(2)}) @ $${this.fmtPrice(position.currentPriceUsd)} | PNL: ${sign}$${pnlOnSell.toFixed(2)} | Remaining: $${position.remainingSizeUsd.toFixed(2)} | ${reason}`
    );

    const event: TradeEvent = {
      action: 'PARTIAL_SELL',
      position,
      amountUsd,
      priceUsd: position.currentPriceUsd,
      reason,
      timestamp: Date.now(),
    };
    this.tradeLog.push(event);

    // Telegram alert for partial sell
    await this.telegram.sendPartialSellAlert({
      tokenName: `${position.symbol} (${position.name})`,
      mint: position.mint,
      entryPriceUsd: position.entryPriceUsd,
      soldUsd: amountUsd,
      proceedsUsd: proceeds,
      pnlOnSell,
      remainingUsd: position.remainingSizeUsd,
      currentPriceUsd: position.currentPriceUsd,
      pnlPctFromEntry: position.pnlPct,
      reason,
      capitalBefore: position.capitalBeforeBuy,
      capitalAfter: this.state.budgetRemaining,
    });
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
    const sign = this.state.totalPnl >= 0 ? '+' : '';

    log.banner('PUMPFUNBOT STATUS');
    console.log(`  Mode:            ${CONFIG.PAPER_TRADE ? 'PAPER TRADE' : 'LIVE'}`);
    console.log(`  Runtime:         ${runtime}`);
    console.log(`  Budget:          $${this.state.budgetRemaining.toFixed(2)} / $${CONFIG.STARTING_BUDGET_USD}`);
    console.log(`  Total PNL:       ${sign}$${this.state.totalPnl.toFixed(2)}`);
    console.log(`  Trades:          ${this.state.tradesExecuted} (W: ${this.wins} / L: ${this.losses} | ${winRate.toFixed(0)}%)`);
    console.log(`  Open positions:  ${open.length} / ${CONFIG.MAX_CONCURRENT_TRADES}`);
    console.log(`  SOL Price:       $${getSolPrice().toFixed(2)}`);

    if (open.length > 0) {
      console.log(`\n  Open Positions:`);
      for (const p of open) {
        const sign = p.pnlPct >= 0 ? '+' : '';
        const holdTime = this.formatHoldTime(Date.now() - p.entryTime);
        const tpHit = p.takeProfitLevelsHit.length;
        console.log(
          `    ${p.symbol.padEnd(10)} | Entry: $${this.fmtPrice(p.entryPriceUsd)} | Now: $${this.fmtPrice(p.currentPriceUsd)} | PNL: ${sign}${p.pnlPct.toFixed(1)}% | TP: ${tpHit}/${CONFIG.TAKE_PROFIT_LEVELS.length} | Hold: ${holdTime}`
        );
      }
    }
    console.log('');
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
