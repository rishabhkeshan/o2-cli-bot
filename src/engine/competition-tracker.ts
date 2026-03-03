import { EventEmitter } from 'events';
import type { O2RestClient } from '../api/rest-client.js';
import type {
  Competition,
  CompetitionState,
  UserLeaderboardEntry,
  SubRankings,
  UserLotteryStatus,
} from '../types/competition.js';

export class CompetitionTracker extends EventEmitter {
  private restClient: O2RestClient;
  private ownerAddress: string = '';
  private state: CompetitionState | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;
  private previousSuperBoostStatus: string | undefined = undefined;

  constructor(restClient: O2RestClient, pollIntervalMs = 60_000) {
    super();
    this.restClient = restClient;
    this.pollIntervalMs = pollIntervalMs;
  }

  init(ownerAddress: string): void {
    this.ownerAddress = ownerAddress;
  }

  startPolling(intervalMs?: number): void {
    this.stopPolling();
    const ms = intervalMs ?? this.pollIntervalMs;
    // Initial fetch
    this.fetchCompetitionData().catch(() => {});
    this.pollInterval = setInterval(() => {
      this.fetchCompetitionData().catch(() => {});
    }, ms);
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  shutdown(): void {
    this.stopPolling();
  }

  // ─── Typed getters ─────────────────────────────────────

  getState(): CompetitionState | null {
    return this.state;
  }

  getCompetition(): Competition | null {
    return this.state?.competition ?? null;
  }

  getUserEntry(): UserLeaderboardEntry | null {
    return this.state?.userEntry ?? null;
  }

  getMarketBoosts(): Record<string, number> {
    return this.state?.competition.marketBoosts ?? {};
  }

  /** Look up boost by contract_id (native key) or market_id (fallback) */
  getBoostForMarket(id: string): number {
    const boosts = this.state?.competition.marketBoosts;
    if (!boosts) return 0;
    // Try direct match first (contract_id), then case-insensitive
    if (boosts[id] != null) return boosts[id];
    const lower = id.toLowerCase();
    for (const [k, v] of Object.entries(boosts)) {
      if (k.toLowerCase() === lower) return v;
    }
    return 0;
  }

  getTimeRemainingMs(): number {
    if (!this.state?.competition) return 0;
    const end = new Date(this.state.competition.endDate).getTime();
    return Math.max(0, end - Date.now());
  }

  getStreakInfo(): {
    streakCount: number;
    currentPeriodIndex: number;
    superBoostStatus: string | undefined;
    superBoostStreakBrokenDay: number | undefined;
    currentPeriodProgress: { volume: string; target: string; met: boolean } | null;
    periods: import('../types/competition.js').UserStreakPeriod[];
    totalPeriods: number;
  } | null {
    const streak = this.state?.userEntry?.streak;
    const config = this.state?.competition.streakConfig;
    if (!streak) return null;

    const currentPeriod = streak.periods?.find(
      (p) => p.periodIndex === streak.currentPeriodIndex
    );

    return {
      streakCount: streak.streakCount,
      currentPeriodIndex: streak.currentPeriodIndex,
      superBoostStatus: streak.superBoostStatus,
      superBoostStreakBrokenDay: streak.superBoostStreakBrokenDay,
      currentPeriodProgress: currentPeriod
        ? {
            volume: currentPeriod.volume,
            target: currentPeriod.targetVolume,
            met: currentPeriod.targetMet,
          }
        : null,
      periods: streak.periods || [],
      totalPeriods: config?.periods.length ?? 0,
    };
  }

  getLotteryInfo(): UserLotteryStatus | null {
    return this.state?.userEntry?.lottery ?? null;
  }

  getSubRankings(): SubRankings | undefined {
    return this.state?.subRankings;
  }

  async refresh(): Promise<void> {
    await this.fetchCompetitionData();
  }

  // ─── Polling logic ─────────────────────────────────────

  private stripHtmlTags(str: string): string {
    return str.replace(/<[^>]*>/g, '');
  }

  private async fetchCompetitionData(): Promise<void> {
    if (!this.ownerAddress) return;

    try {
      const competitions = await this.restClient.getCompetitions();
      const now = Date.now();

      // Find active competition (exclude halloffame)
      let active = competitions.find((c) => {
        if (c.layout === 'halloffame') return false;
        const plainTitle = this.stripHtmlTags(c.title || '');
        if (plainTitle.includes('Hall of Fame')) return false;
        const start = new Date(c.startDate).getTime();
        const end = c.endDate ? new Date(c.endDate).getTime() : Infinity;
        return start <= now && end >= now;
      });

      if (!active) {
        this.state = null;
        return;
      }

      // Fetch leaderboard for user
      const lb = await this.restClient.getLeaderboard(
        active.competitionId,
        this.ownerAddress
      );

      // Merge richer data from leaderboard response into competition
      if (lb) {
        if (lb.marketBoosts) active.marketBoosts = lb.marketBoosts;
        if (lb.streakConfig) active.streakConfig = lb.streakConfig;
        if (lb.prizePool) active.prizePool = lb.prizePool;
        if (lb.totalTraders) active.totalTraders = lb.totalTraders;
        if (lb.totalVolume) active.totalVolume = lb.totalVolume;
      }

      const endTime = new Date(active.endDate).getTime();
      const timeRemainingMs = Math.max(0, endTime - now);

      this.state = {
        competition: active,
        userEntry: lb?.currentUser ?? null,
        subRankings: lb?.subRankings,
        timeRemainingMs,
        isActive: timeRemainingMs > 0,
        lastUpdated: now,
      };

      this.emit('update', this.state);

      // Check streak alerts
      this.checkStreakAlerts(active);

      // Check super boost status change
      this.checkSuperBoostStatus();
    } catch {
      // silently ignore fetch errors
    }
  }

  private checkStreakAlerts(competition: Competition): void {
    const streak = this.state?.userEntry?.streak;
    const config = competition.streakConfig;
    if (!streak || !config?.enabled || !config.periods.length) return;

    const currentPeriod = config.periods[streak.currentPeriodIndex];
    if (!currentPeriod) return;

    const periodStart = new Date(currentPeriod.startTime).getTime();
    const periodEnd = new Date(currentPeriod.endTime).getTime();
    const periodDuration = periodEnd - periodStart;
    const elapsed = Date.now() - periodStart;

    if (elapsed <= 0 || periodDuration <= 0) return;

    const progress = elapsed / periodDuration;

    // Find user's period progress
    const userPeriod = streak.periods?.find(
      (p) => p.periodIndex === streak.currentPeriodIndex
    );

    if (progress > 0.5 && userPeriod && !userPeriod.targetMet) {
      this.emit('streakAtRisk', {
        streakCount: streak.streakCount,
        periodIndex: streak.currentPeriodIndex,
        progress: Math.round(progress * 100),
        volume: userPeriod.volume,
        target: userPeriod.targetVolume,
      });
    }
  }

  private checkSuperBoostStatus(): void {
    const currentStatus = this.state?.userEntry?.superBoostStatus;
    if (
      this.previousSuperBoostStatus &&
      this.previousSuperBoostStatus !== 'lost' &&
      currentStatus === 'lost'
    ) {
      this.emit('superBoostLost', {
        previousStatus: this.previousSuperBoostStatus,
      });
    }
    this.previousSuperBoostStatus = currentStatus;
  }
}
