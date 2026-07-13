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

  // ── TRADE CLOSED Alert (only alert per trade) ──

  async sendTradeClosedAlert(data: {
    tokenName: string;
    capitalBefore: number;
    capitalAfter: number;
    pnlUsd: number;
    pnlPct: number;
    exitReason: string;
    peakPnlPct: number;
    worstPnlPct: number;
    holdTime: string;
    totalFeesUsd: number;
    entryBuyers: number;
  }): Promise<void> {
    const pnlEmoji = data.pnlUsd >= 0 ? '🟢' : '🔴';
    const sign = data.pnlUsd >= 0 ? '+' : '';

    const msg = [
      `${pnlEmoji} *PUMPFUNBOT — TRADE CLOSED*`,
      ``,
      `*Token:* ${this.esc(data.tokenName)}`,
      `*Capital Before Buy:* $${data.capitalBefore.toFixed(2)}`,
      `*Capital After Sell:* $${data.capitalAfter.toFixed(2)}`,
      `*PNL:* ${sign}${data.pnlPct.toFixed(1)}%`,
      `*PNL:* ${sign}$${data.pnlUsd.toFixed(2)}`,
      ``,
      `${CONFIG.PAPER_TRADE ? '📝 Paper Trade' : '💰 LIVE'}`,
    ].join('\n');

    await this.send(msg);

    await this.sendTradeReview(data);
  }

  private async sendTradeReview(data: {
    tokenName: string;
    pnlUsd: number;
    exitReason: string;
    peakPnlPct: number;
    worstPnlPct: number;
    holdTime: string;
    totalFeesUsd: number;
    entryBuyers: number;
  }): Promise<void> {
    const won = data.pnlUsd >= 0;
    const result = won ? 'Succeeded' : 'Did not succeed';
    const reason = this.explainOutcome(data, won);
    const nextTest = this.suggestNextTest(data, won);

    const msg = [
      `*TRADE REVIEW — ${this.esc(data.tokenName)}*`,
      '',
      `*Result:* ${result}`,
      `*Why:* ${this.esc(reason)}`,
      `*Trade facts:* peak ${data.peakPnlPct >= 0 ? '+' : ''}${data.peakPnlPct.toFixed(1)}% | worst ${data.worstPnlPct.toFixed(1)}% | ${data.holdTime} | $${data.totalFeesUsd.toFixed(2)} fees`,
      `*Entry context:* ${data.entryBuyers} unique buyers`,
      `*Next test:* ${this.esc(nextTest)}`,
      '',
      'Paper-trade learning note: test one change at a time; this is not a profit guarantee.',
    ].join('\n');

    await this.send(msg);
  }

  private explainOutcome(data: { pnlUsd: number; exitReason: string; peakPnlPct: number }, won: boolean): string {
    if (won) {
      if (data.exitReason.startsWith('Take profit')) return 'Momentum reached the planned profit target before the exit.';
      if (data.exitReason.startsWith('Collapse')) return `The position was profitable, then retraced from a ${data.peakPnlPct.toFixed(1)}% peak and triggered protection.`;
      return `The exit rule protected a net gain after the position reached a ${data.peakPnlPct.toFixed(1)}% peak.`;
    }

    if (data.exitReason.startsWith('Stop loss')) return 'The entry lost momentum and reached the defined loss limit.';
    if (data.exitReason.startsWith('Rapid dump')) return 'A sharp one-update selloff triggered the protective exit.';
    if (data.exitReason.startsWith('Stale')) return 'Price failed to produce sufficient follow-through during the stale-exit window.';
    if (data.exitReason.startsWith('Max hold')) return 'The position did not resolve before the maximum holding time.';
    return 'The exit rule closed the position after adverse price action.';
  }

  private suggestNextTest(data: { pnlUsd: number; exitReason: string; peakPnlPct: number; entryBuyers: number }, won: boolean): string {
    if (won && data.exitReason.startsWith('Take profit')) {
      return 'Keep the entry and exit rules unchanged until several similar winners show whether gains continue after exit.';
    }
    if (won && data.exitReason.startsWith('Collapse')) {
      return 'Compare post-exit prices before testing a tighter or looser collapse threshold.';
    }
    if (!won && (data.exitReason.startsWith('Stop loss') || data.exitReason.startsWith('Rapid dump'))) {
      return 'Test a stricter entry confirmation, such as one additional positive momentum update, before changing the stop.';
    }
    if (!won && (data.exitReason.startsWith('Stale') || data.exitReason.startsWith('Max hold'))) {
      return 'Test stronger initial momentum or buyer participation; do not lengthen the hold time until follow-through data supports it.';
    }
    if (!won && data.peakPnlPct > 0) {
      return 'Review similar trades for post-exit movement before adjusting the trailing-collapse exit.';
    }
    return `Collect more examples around entries with ${data.entryBuyers} buyers before changing one parameter at a time.`;
  }

  // ── DAILY SUMMARY (8pm MST) ──

  async sendDailySummary(stats: import('./types.js').DailyStats): Promise<void> {
    const sign = stats.pnlUsd >= 0 ? '+' : '';
    const winRate = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(0) : '0';
    const avgHold = stats.avgHoldTimeSec < 60
      ? `${stats.avgHoldTimeSec.toFixed(0)}s`
      : `${(stats.avgHoldTimeSec / 60).toFixed(1)}m`;

    // Generate insight based on today's data
    const insight = this.generateInsight(stats);

    const lines = [
      `📊 *PUMPFUNBOT — DAILY SUMMARY*`,
      ``,
      `*Trades:* ${stats.trades}`,
      `*PNL:* ${sign}$${stats.pnlUsd.toFixed(2)}`,
      `*PNL:* ${sign}${stats.pnlPct.toFixed(2)}%`,
      ``,
      `*Wins:* ${stats.wins} | *Losses:* ${stats.losses} | *Win Rate:* ${winRate}%`,
      `*Avg PNL/Trade:* ${sign}$${stats.avgPnlPerTrade.toFixed(2)}`,
      `*Avg Hold Time:* ${avgHold}`,
      `*Fees Paid:* $${stats.totalFeesUsd.toFixed(2)}`,
    ];

    if (stats.bestTrade) {
      lines.push(`*Best Trade:* ${this.esc(stats.bestTrade.symbol)} (${stats.bestTrade.pnlPct >= 0 ? '+' : ''}${stats.bestTrade.pnlPct.toFixed(1)}%)`);
    }
    if (stats.worstTrade) {
      lines.push(`*Worst Trade:* ${this.esc(stats.worstTrade.symbol)} (${stats.worstTrade.pnlPct >= 0 ? '+' : ''}${stats.worstTrade.pnlPct.toFixed(1)}%)`);
    }

    lines.push(
      ``,
      `*Capital:* $${stats.capitalStart.toFixed(2)} → $${stats.capitalEnd.toFixed(2)}`,
      `*Tokens Scanned:* ${stats.tokensScanned}`,
      ``,
      `💡 *Insight:*`,
      insight,
      ``,
      `${CONFIG.PAPER_TRADE ? '📝 Paper Trade' : '💰 LIVE'}`,
    );

    await this.send(lines.join('\n'));
  }

  async sendExperimentAlert(message: string): Promise<void> {
    await this.send([`*PAPER EXPERIMENT*`, '', this.esc(message), '', 'Paper trading only — one parameter is tested at a time.'].join('\n'));
  }

  private generateInsight(stats: import('./types.js').DailyStats): string {
    if (stats.trades === 0) {
      return 'No trades executed today. Consider lowering MIN\\_UNIQUE\\_BUYERS from 3 to 2, or increasing MAX\\_TOKEN\\_AGE to capture more candidates.';
    }

    const tips: string[] = [];
    const winRate = stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 0;

    // Win rate analysis
    if (winRate < 30) {
      tips.push('Win rate is below 30%. Entry criteria may be too loose — consider requiring more unique buyers or a higher minimum market cap before entering.');
    } else if (winRate < 50) {
      tips.push('Win rate is below 50%. The stop loss may be triggering too early — consider widening it slightly, or waiting for stronger buy signals before entering.');
    } else if (winRate >= 70) {
      tips.push('Strong win rate above 70%. Strategy is filtering well — consider increasing trade size to capitalize on the edge.');
    }

    // Hold time analysis
    if (stats.avgHoldTimeSec < 30) {
      tips.push('Average hold time is very short. Positions may be getting stopped out too quickly — consider a wider initial stop loss or waiting for more price confirmation before buying.');
    } else if (stats.avgHoldTimeSec > 1800) {
      tips.push('Average hold time exceeds 30 minutes. Positions may be stagnating — consider tightening the stale exit timer to free up capital faster.');
    }

    // PNL analysis
    if (stats.pnlUsd < 0 && stats.totalFeesUsd > Math.abs(stats.pnlUsd) * 0.5) {
      tips.push('Fees are eating a large portion of PNL. Reducing trade frequency or increasing trade size could improve net returns.');
    }

    // Exit reason analysis
    const reasons = stats.exitReasons;
    const stopLosses = (reasons['Stop loss'] || 0) + (reasons['Trailing stop hit'] || 0);
    if (stopLosses > stats.trades * 0.6) {
      tips.push('Most exits are from stop losses. The tokens being selected may be too volatile — consider adding a minimum market cap filter or waiting for more buyers before entry.');
    }
    const staleExits = reasons['Stale exit'] || 0;
    if (staleExits > stats.trades * 0.4) {
      tips.push('Many stale exits. Tokens are not moving after entry — consider requiring stronger initial momentum (e.g., higher buy volume in the first 10 seconds).');
    }

    if (tips.length === 0) {
      tips.push('Performance looks solid. Continue monitoring and consider gradually increasing position sizes if the win rate holds steady.');
    }

    return tips.join(' ');
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
      `*Take Profit:* +${CONFIG.TAKE_PROFIT_PCT}%`,
      `*Stop Loss:* -${CONFIG.STOP_LOSS_PCT}%`,
      `*Collapse Exit:* -${CONFIG.COLLAPSE_DROP_FROM_PEAK_PCT}% from peak`,
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
