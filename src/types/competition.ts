// ─── Competition / Leaderboard Types ─────────────────────

export type CompetitionLayout =
  | 'standard'
  | 'lottery'
  | 'dailystreak'
  | 'dailystreak_v2'
  | 'dailystreak_v3'
  | 'halloffame';

export interface DailyStreakPeriod {
  name?: string;
  boostBp: number;
  superBoostBp?: number;
  superBoostStreakNeeded?: number;
  thresholdPercent?: number;
  startTime: string;
  endTime: string;
}

export interface StreakConfig {
  enabled: boolean;
  currentPeriodIndex: number;
  periods: DailyStreakPeriod[];
}

export interface PrizeMilestone {
  targetVolume: string;
  rewardPool: string;
}

export interface PrizePool {
  milestones: PrizeMilestone[];
  activeMilestone: PrizeMilestone;
}

export interface Competition {
  competitionId: string;
  slug: string;
  title: string;
  subtitle: string;
  startDate: string;
  endDate: string;
  totalTraders: number;
  totalVolume: string;
  layout: CompetitionLayout;
  marketBoosts?: Record<string, number>;
  streakConfig?: StreakConfig;
  placeholderVolumeTarget?: string;
  prizePool?: PrizePool;
}

// ─── User-specific data ──────────────────────────────────

export interface UserStreakPeriod {
  periodIndex: number;
  targetMet: boolean;
  targetVolume: string;
  volume: string;
  isComplete: boolean;
}

export interface UserStreak {
  currentPeriodIndex: number;
  superBoostEligible: boolean;
  streakCount: number;
  periods: UserStreakPeriod[];
  superBoostStatus?: string;
  superBoostStreakBrokenDay?: number;
}

export interface UserLotteryStatus {
  ticketsThisPeriod: number;
  ticketsTotal: number;
  winsCount: number;
}

export interface UserLeaderboardEntry {
  rank: number;
  score: string;
  volume: string;
  volume24h: string;
  boostedVolume?: string;
  pnl: string;
  realizedPnl: string;
  referralVolume: string;
  superBoostStatus?: string;
  streak?: UserStreak;
  lottery?: UserLotteryStatus;
}

// ─── Sub-ranking entries ─────────────────────────────────

export interface TakerSubRanking {
  rank: number;
  volume: string;
  score: string;
}

export interface MakerSubRanking {
  rank: number;
  volume: string;
  score: string;
}

export interface PnlSubRanking {
  rank: number;
  pnl: string;
  score: string;
}

export interface LotterySubRanking {
  rank: number;
  tickets: number;
  wins: number;
}

export interface SubRankings {
  taker?: TakerSubRanking;
  maker?: MakerSubRanking;
  pnl?: PnlSubRanking;
  lottery?: LotterySubRanking;
}

// ─── API response ────────────────────────────────────────

export interface LeaderboardResponse {
  title: string;
  currentUser: UserLeaderboardEntry | null;
  subRankings?: SubRankings;
  totalTraders: number;
  totalVolume: string;
  prizePool?: PrizePool;
  marketBoosts?: Record<string, number>;
  streakConfig?: StreakConfig;
}

// ─── Resolved state ──────────────────────────────────────

export interface CompetitionState {
  competition: Competition;
  userEntry: UserLeaderboardEntry | null;
  subRankings?: SubRankings;
  timeRemainingMs: number;
  isActive: boolean;
  lastUpdated: number;
}
