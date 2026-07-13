import { AdaptiveEntryParameter, CONFIG, setAdaptiveEntryParameter } from './config.js';
import { Position } from './types.js';
import { TelegramAlert } from './telegram.js';
import { log } from './logger.js';

const MODULE = 'EXPERIMENT';

type TradeResult = { pnlPct: number; won: boolean; exitReason: string };
type SampleStats = { averagePnlPct: number; winRatePct: number; trades: number };

export class PaperExperimentManager {
  private baseline: SampleStats | null = null;
  private sample: TradeResult[] = [];
  private active: { id: string; parameter: AdaptiveEntryParameter; originalValue: number; testValue: number } | null = null;
  private experimentNumber = 0;

  constructor(private telegram: TelegramAlert) {}

  async recordClosedTrade(position: Position): Promise<void> {
    if (!CONFIG.EXPERIMENT_ENABLED || !CONFIG.PAPER_TRADE) return;

    this.sample.push({ pnlPct: position.pnlPct, won: position.pnlUsd >= 0, exitReason: position.exitReason || 'unknown' });
    if (this.sample.length < CONFIG.EXPERIMENT_SAMPLE_SIZE) return;

    const completedSample = this.sample;
    const result = this.summarize(completedSample);
    this.sample = [];

    if (!this.baseline) {
      this.baseline = result;
      log.telemetry(MODULE, 'EXPERIMENT_BASELINE_READY', { configVersion: CONFIG.STRATEGY_CONFIG_VERSION, ...result });
      await this.telegram.sendExperimentAlert(`Baseline recorded from ${result.trades} paper trades: ${result.winRatePct.toFixed(0)}% wins, ${result.averagePnlPct >= 0 ? '+' : ''}${result.averagePnlPct.toFixed(2)}% average PNL. The next 20 closed trades will test one entry filter.`);
      this.startExperiment(completedSample);
      return;
    }

    if (!this.active) {
      this.baseline = result;
      this.startExperiment(completedSample);
      return;
    }

    const winRateChange = result.winRatePct - this.baseline.winRatePct;
    const pnlImproved = result.averagePnlPct >= this.baseline.averagePnlPct;
    const winRateHeld = winRateChange >= -CONFIG.EXPERIMENT_MAX_WIN_RATE_DROP_PCT;
    const accepted = pnlImproved && winRateHeld;
    const experiment = this.active;

    if (!accepted) setAdaptiveEntryParameter(experiment.parameter, experiment.originalValue, `${experiment.id}-rollback`);
    this.active = null;
    log.telemetry(MODULE, 'EXPERIMENT_COMPLETED', {
      experimentId: experiment.id,
      parameter: experiment.parameter,
      originalValue: experiment.originalValue,
      testValue: experiment.testValue,
      accepted,
      baseline: this.baseline,
      result,
      winRateChangePct: winRateChange,
      configVersion: CONFIG.STRATEGY_CONFIG_VERSION,
    });
    await this.telegram.sendExperimentAlert(`${experiment.id}: ${experiment.parameter} ${experiment.originalValue} → ${experiment.testValue} was ${accepted ? 'kept' : 'rolled back'}. Test: ${result.winRatePct.toFixed(0)}% wins, ${result.averagePnlPct >= 0 ? '+' : ''}${result.averagePnlPct.toFixed(2)}% avg PNL; baseline: ${this.baseline.winRatePct.toFixed(0)}% wins, ${this.baseline.averagePnlPct >= 0 ? '+' : ''}${this.baseline.averagePnlPct.toFixed(2)}% avg PNL.`);
    this.baseline = accepted ? result : this.baseline;
    this.startExperiment(completedSample);
  }

  private startExperiment(previousSample: TradeResult[]): void {
    if (!this.baseline || this.active) return;
    const { parameter, testValue } = this.chooseNextTest(previousSample);
    const originalValue = CONFIG[parameter] as number;
    const id = `paper-exp-${++this.experimentNumber}`;
    setAdaptiveEntryParameter(parameter, testValue, id);
    this.active = { id, parameter, originalValue, testValue };
    log.telemetry(MODULE, 'EXPERIMENT_STARTED', { experimentId: id, parameter, originalValue, testValue, baseline: this.baseline, configVersion: CONFIG.STRATEGY_CONFIG_VERSION });
    void this.telegram.sendExperimentAlert(`${id} started: testing ${parameter} ${originalValue} → ${testValue} for the next ${CONFIG.EXPERIMENT_SAMPLE_SIZE} paper trades. Only this entry filter changed.`);
  }

  private chooseNextTest(sample: TradeResult[]): { parameter: AdaptiveEntryParameter; testValue: number } {
    const reasons = sample.reduce<Record<string, number>>((counts, trade) => {
      counts[trade.exitReason] = (counts[trade.exitReason] || 0) + 1;
      return counts;
    }, {});
    const stopOrDump = Object.entries(reasons).filter(([reason]) => reason.startsWith('Stop loss') || reason.startsWith('Rapid dump')).reduce((sum, [, count]) => sum + count, 0);
    const stale = Object.entries(reasons).filter(([reason]) => reason.startsWith('Stale') || reason.startsWith('Max hold')).reduce((sum, [, count]) => sum + count, 0);
    if (stopOrDump >= stale) return { parameter: 'MIN_CONSECUTIVE_MOMENTUM_UPDATES', testValue: (CONFIG.MIN_CONSECUTIVE_MOMENTUM_UPDATES as number) + 1 };
    if (stale > 0) return { parameter: 'MIN_MOMENTUM_STEP_PCT', testValue: (CONFIG.MIN_MOMENTUM_STEP_PCT as number) + 1 };
    return { parameter: 'MIN_UNIQUE_BUYERS', testValue: (CONFIG.MIN_UNIQUE_BUYERS as number) + 1 };
  }

  private summarize(sample: TradeResult[]): SampleStats {
    return {
      trades: sample.length,
      averagePnlPct: sample.reduce((sum, trade) => sum + trade.pnlPct, 0) / sample.length,
      winRatePct: (sample.filter((trade) => trade.won).length / sample.length) * 100,
    };
  }
}
