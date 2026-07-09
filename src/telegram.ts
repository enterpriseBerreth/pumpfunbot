import { CONFIG } from './config.js';
import { log } from './logger.js';

const MODULE = 'TELEGRAM';

export class TelegramAlert {
  private botToken: string;
  private chatId: string;
  private enabled: boolean;

  constructor() {
    this.botToken = CONFIG.TELEGRAM_BOT_TOKEN;
    this.chatId = CONFIG.TELEGRAM_CHAT_ID;
    this.enabled = !!(this.botToken && this.chatId);

    if (!this.enabled) {
      log.warn(MODULE, 'Telegram not configured - alerts will only show in console');
    } else {
      log.success(MODULE, 'Telegram alerts enabled');
    }
  }

  // ── BUY Alert ──

  async sendBuyAlert(data: {
    tokenName: string;
    mint: string;
    priceUsd: number;
    sizeUsd: number;
    uniqueBuyers: number;
    marketCapUsd: number;
    budgetRemaining: number;
    capitalBeforeBuy: number;
  }): Promise<void> {
    const msg = [
      `🟢 *PUMPFUNBOT — BUY*`,
      ``,
      `*Token:* ${this.esc(data.tokenName)}`,
      `*Mint:* \`${data.mint.slice(0, 12)}...\``,
      `*Price Bought At:* $${this.fmtPrice(data.priceUsd)}`,
      `*Size:* $${data.sizeUsd.toFixed(2)}`,
      `*Unique Buyers:* ${data.uniqueBuyers} (excl. dev)`,
      `*Market Cap:* $${data.marketCapUsd.toFixed(0)}`,
      `*Capital Before Buy:* $${data.capitalBeforeBuy.toFixed(2)}`,
      `*Capital After Buy:* $${data.budgetRemaining.toFixed(2)}`,
      ``,
      `${CONFIG.PAPER_TRADE ? '📝 Paper Trade' : '💰 LIVE'}`,
    ].join('\n');

    await this.send(msg);
  }

  // ── SELL Alert (full close) ──

  async sendSellAlert(data: {
    tokenName: string;
    mint: string;
    entryPriceUsd: number;
    exitPriceUsd: number;
    pnlUsd: number;
    pnlPct: number;
    holdTime: string;
    reason: string;
    capitalBefore: number;
    capitalAfter: number;
    totalBotPnl: number;
    winRate: number;
  }): Promise<void> {
    const pnlEmoji = data.pnlUsd >= 0 ? '🟢' : '🔴';
    const sign = data.pnlUsd >= 0 ? '+' : '';

    const msg = [
      `${pnlEmoji} *PUMPFUNBOT — TRADE CLOSED*`,
      ``,
      `*Token:* ${this.esc(data.tokenName)}`,
      `*Price Bought At:* $${this.fmtPrice(data.entryPriceUsd)}`,
      `*Price Sold At:* $${this.fmtPrice(data.exitPriceUsd)}`,
      `*PNL:* ${sign}$${data.pnlUsd.toFixed(2)}`,
      `*PNL:* ${sign}${data.pnlPct.toFixed(1)}%`,
      `*Capital Before Buy:* $${data.capitalBefore.toFixed(2)}`,
      `*Capital After Sell:* $${data.capitalAfter.toFixed(2)}`,
      ``,
      `*Hold Time:* ${data.holdTime}`,
      `*Reason:* ${this.esc(data.reason)}`,
      `*Total Bot PNL:* ${data.totalBotPnl >= 0 ? '+' : ''}$${data.totalBotPnl.toFixed(2)}`,
      `*Win Rate:* ${data.winRate.toFixed(0)}%`,
      ``,
      `${CONFIG.PAPER_TRADE ? '📝 Paper Trade' : '💰 LIVE'}`,
    ].join('\n');

    await this.send(msg);
  }

  // ── PARTIAL SELL Alert ──

  async sendPartialSellAlert(data: {
    tokenName: string;
    mint: string;
    entryPriceUsd: number;
    soldUsd: number;
    proceedsUsd: number;
    pnlOnSell: number;
    remainingUsd: number;
    currentPriceUsd: number;
    pnlPctFromEntry: number;
    reason: string;
    capitalBefore: number;
    capitalAfter: number;
  }): Promise<void> {
    const sign = data.pnlOnSell >= 0 ? '+' : '';

    const msg = [
      `📤 *PUMPFUNBOT — PARTIAL SELL*`,
      ``,
      `*Token:* ${this.esc(data.tokenName)}`,
      `*Price Bought At:* $${this.fmtPrice(data.entryPriceUsd)}`,
      `*Price Sold At:* $${this.fmtPrice(data.currentPriceUsd)}`,
      `*PNL:* ${sign}$${data.pnlOnSell.toFixed(2)}`,
      `*PNL:* ${sign}${data.pnlPctFromEntry.toFixed(1)}%`,
      `*Capital Before Buy:* $${data.capitalBefore.toFixed(2)}`,
      `*Capital After Sell:* $${data.capitalAfter.toFixed(2)}`,
      ``,
      `*Sold:* $${data.soldUsd.toFixed(2)} → $${data.proceedsUsd.toFixed(2)}`,
      `*Remaining:* $${data.remainingUsd.toFixed(2)} (riding for max profit)`,
      `*Reason:* ${this.esc(data.reason)}`,
      ``,
      `${CONFIG.PAPER_TRADE ? '📝 Paper Trade' : '💰 LIVE'}`,
    ].join('\n');

    await this.send(msg);
  }

  // ── BOT STARTED Alert ──

  async sendStartedAlert(budget: number): Promise<void> {
    const msg = [
      `🚀 *PUMPFUNBOT — STARTED*`,
      ``,
      `*Mode:* ${CONFIG.PAPER_TRADE ? '📝 Paper Trade' : '💰 LIVE'}`,
      `*Budget:* $${budget.toFixed(2)}`,
      `*Trade Size:* $${CONFIG.TRADE_SIZE_USD}`,
      `*Min Buyers:* ${CONFIG.MIN_UNIQUE_BUYERS} (excl. dev)`,
      `*Min Age:* ${CONFIG.MIN_TOKEN_AGE_SECONDS}s`,
      `*Take Profit:* ${CONFIG.TAKE_PROFIT_LEVELS.map((l) => `+${l.triggerPct}%`).join(', ')}`,
      `*Stop Loss:* -${CONFIG.INITIAL_STOP_LOSS_PCT}%`,
    ].join('\n');

    await this.send(msg);
  }

  // ── BOT STOPPED Alert ──

  async sendStoppedAlert(reason: string): Promise<void> {
    const msg = [
      `🛑 *PUMPFUNBOT — STOPPED*`,
      ``,
      `*Reason:* ${this.esc(reason)}`,
      `*Mode:* ${CONFIG.PAPER_TRADE ? '📝 Paper Trade' : '💰 LIVE'}`,
    ].join('\n');

    await this.send(msg);
  }

  // ── Internal ──

  private async send(text: string): Promise<void> {
    if (!this.enabled) return;

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const err = await res.text();
        log.error(MODULE, `Failed to send: ${err}`);
      }
    } catch (err) {
      log.error(MODULE, `Send error: ${err}`);
    }
  }

  private esc(text: string): string {
    return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
  }

  private fmtPrice(price: number): string {
    if (price === 0) return '0';
    if (price < 0.0000001) return price.toExponential(4);
    if (price < 0.00001) return price.toFixed(10);
    if (price < 0.001) return price.toFixed(8);
    if (price < 0.01) return price.toFixed(6);
    if (price < 1) return price.toFixed(4);
    return price.toFixed(2);
  }
}
