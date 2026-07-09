import { CONFIG } from './config.js';
import { PumpFunScanner } from './scanner.js';
import { PaperTrader } from './trader.js';
import { TelegramAlert } from './telegram.js';
import { TokenCandidate } from './types.js';
import { log } from './logger.js';

const MODULE = 'PUMPFUNBOT';
const STATUS_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  log.banner('PUMPFUNBOT - Pump.fun Trading Bot');

  console.log(`  Mode:              ${CONFIG.PAPER_TRADE ? 'PAPER TRADE' : 'LIVE TRADING'}`);
  console.log(`  Budget:            $${CONFIG.STARTING_BUDGET_USD}`);
  console.log(`  Trade Size:        $${CONFIG.TRADE_SIZE_USD}`);
  console.log(`  Max Concurrent:    ${CONFIG.MAX_CONCURRENT_TRADES}`);
  console.log(`  Min Buyers:        ${CONFIG.MIN_UNIQUE_BUYERS} (excl. dev)`);
  console.log(`  Min Token Age:     ${CONFIG.MIN_TOKEN_AGE_SECONDS}s`);
  console.log(`  Take Profit:       ${CONFIG.TAKE_PROFIT_LEVELS.map((l) => `+${l.triggerPct}%`).join(', ')}`);
  console.log(`  Stop Loss:         -${CONFIG.INITIAL_STOP_LOSS_PCT}%`);
  console.log(`  Trailing Stops:    ${CONFIG.TRAILING_STOP_TIERS.map((t) => `+${t.activateAbovePct}%/${t.trailDistancePct}%`).join(', ')}`);
  console.log('');

  if (!CONFIG.PAPER_TRADE) {
    log.warn(MODULE, '*** LIVE TRADING MODE - Real money at risk! ***');
    log.warn(MODULE, 'Press Ctrl+C within 10 seconds to abort...');
    await sleep(10_000);
  }

  // Initialize components
  const telegram = new TelegramAlert();
  const trader = new PaperTrader(telegram);
  const scanner = new PumpFunScanner();

  // Wire up: when scanner finds a qualified token, trader buys it
  scanner.onQualifiedToken = async (candidate: TokenCandidate) => {
    if (!trader.canTrade()) {
      log.info(MODULE, `Skipping ${candidate.symbol} - trade limit reached or insufficient budget`);
      return;
    }

    if (trader.hasPosition(candidate.mint)) {
      return;
    }

    log.success(MODULE, `${candidate.symbol} APPROVED - Executing buy...`);
    await trader.executeBuy(candidate);

    // Keep subscription active for price monitoring
    scanner.subscribeToToken(candidate.mint);
  };

  // Wire up: scanner price updates flow to trader
  scanner.onPriceUpdate = (mint: string, priceSol: number, priceUsd: number) => {
    trader.updatePrice(mint, priceSol, priceUsd);

    // If position is closed, unsubscribe
    if (!trader.hasPosition(mint)) {
      scanner.unsubscribeFromToken(mint);
    }
  };

  // Start all systems
  await scanner.start();
  trader.startPriceMonitor();

  // Send startup alert
  await telegram.sendStartedAlert(CONFIG.STARTING_BUDGET_USD);

  // ── 8pm MST Daily Summary Scheduler ──
  // MST = UTC-7, so 8pm MST = 03:00 UTC next day
  const scheduleDailySummary = () => {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(3, 0, 0, 0); // 03:00 UTC = 8pm MST
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1); // Already past 8pm MST today, schedule tomorrow
    }
    const msUntil = next.getTime() - now.getTime();
    log.info(MODULE, `Daily summary scheduled in ${(msUntil / 3_600_000).toFixed(1)}h (8pm MST / 03:00 UTC)`);

    setTimeout(async () => {
      try {
        const stats = trader.getDailyStats(scanner.getTotalScanned());
        await telegram.sendDailySummary(stats);
        log.success(MODULE, 'Daily summary sent to Telegram');
      } catch (err) {
        log.error(MODULE, `Failed to send daily summary: ${err}`);
      }
      // Re-schedule for the next day
      scheduleDailySummary();
    }, msUntil);
  };
  scheduleDailySummary();

  // Periodic status display
  const statusInterval = setInterval(() => {
    trader.printStatus();
    log.info(MODULE, `Tracking ${scanner.getCandidateCount()} candidate(s)`);
  }, STATUS_INTERVAL_MS);

  // Graceful shutdown
  const shutdown = async (reason: string) => {
    log.info(MODULE, 'Shutting down...');
    scanner.stop();
    trader.stopPriceMonitor();
    clearInterval(statusInterval);

    trader.printStatus();
    await telegram.sendStoppedAlert(reason);

    log.banner('PUMPFUNBOT - Shutdown Complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('Manual stop (SIGINT)'));
  process.on('SIGTERM', () => shutdown('Process terminated (SIGTERM)'));

  // Crash protection for Railway
  process.on('uncaughtException', async (err) => {
    log.error(MODULE, `Uncaught exception: ${err.message}`);
    log.error(MODULE, err.stack ?? '');
    await telegram.sendStoppedAlert(`Crash: ${err.message}`);
  });
  process.on('unhandledRejection', async (reason) => {
    log.error(MODULE, `Unhandled rejection: ${reason}`);
    await telegram.sendStoppedAlert(`Crash: unhandled rejection - ${reason}`);
  });

  log.success(MODULE, 'All systems online - scanning Pump.fun for new tokens...');

  // Keep the process alive
  await new Promise(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Launch
main().catch(async (err) => {
  log.error(MODULE, `Fatal error: ${err}`);
  try {
    const telegram = new TelegramAlert();
    await telegram.sendStoppedAlert(`Fatal: ${err}`);
  } catch (_) { /* best-effort */ }
  process.exit(1);
});
