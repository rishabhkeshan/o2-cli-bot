import { EventEmitter } from 'events';
import type { FillEvent } from './order-manager.js';
import * as dbQueries from '../db/queries.js';

export interface PnLSnapshot {
  realizedPnl: number;
  unrealizedPnl: number;
  totalVolume: number;
  totalFees: number;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  totalBuyValue: number;
  totalSellValue: number;
  totalBoughtQty: number;
  totalSoldQty: number;
  averageBuyPrice: number;
  averageSellPrice: number;
}

export class PnLCalculator extends EventEmitter {
  private snapshots: Map<string, PnLSnapshot> = new Map();
  private snapshotInterval: ReturnType<typeof setInterval> | null = null;

  getSnapshot(marketId?: string): PnLSnapshot {
    if (marketId) {
      return this.snapshots.get(marketId) || this.emptySnapshot();
    }
    // Aggregate across all markets
    const aggregate = this.emptySnapshot();
    for (const snap of this.snapshots.values()) {
      aggregate.realizedPnl += snap.realizedPnl;
      aggregate.unrealizedPnl += snap.unrealizedPnl;
      aggregate.totalVolume += snap.totalVolume;
      aggregate.totalFees += snap.totalFees;
      aggregate.tradeCount += snap.tradeCount;
      aggregate.buyCount += snap.buyCount;
      aggregate.sellCount += snap.sellCount;
      aggregate.totalBuyValue += snap.totalBuyValue;
      aggregate.totalSellValue += snap.totalSellValue;
    }
    return aggregate;
  }

  recordFill(fill: FillEvent, baseDecimals: number, quoteDecimals: number): void {
    const marketId = fill.marketId;
    const snap = this.snapshots.get(marketId) || this.emptySnapshot();

    // Price is scaled by quote decimals, size by base decimals
    const priceHuman = fill.price / 10 ** quoteDecimals;
    const sizeHuman = fill.sizeBase / 10 ** baseDecimals;
    const value = priceHuman * sizeHuman;

    snap.tradeCount++;
    snap.totalVolume += value;
    snap.totalFees += fill.fee;

    let tradePnl: number | undefined;

    if (fill.side === 'Buy' || fill.side === 'buy') {
      snap.buyCount++;
      snap.totalBuyValue += value;
      snap.totalBoughtQty += sizeHuman;
      snap.averageBuyPrice = snap.totalBuyValue / snap.totalBoughtQty;
    } else {
      snap.sellCount++;
      snap.totalSellValue += value;
      snap.totalSoldQty += sizeHuman;
      snap.averageSellPrice = snap.totalSellValue / snap.totalSoldQty;

      // Calculate realized PnL on sells (incremental, not cumulative)
      if (snap.averageBuyPrice > 0) {
        tradePnl = (priceHuman - snap.averageBuyPrice) * sizeHuman - fill.fee;
        snap.realizedPnl += tradePnl;
      }
    }

    this.snapshots.set(marketId, snap);

    // Record trade in DB with incremental P&L (not cumulative)
    dbQueries.insertTrade({
      orderId: fill.orderId,
      marketId: fill.marketId,
      side: fill.side,
      price: priceHuman,
      size: sizeHuman,
      fee: fill.fee,
      timestamp: fill.timestamp,
      pnlUsdc: tradePnl,
    });

    this.emit('pnlUpdate', marketId, snap);
  }

  startSnapshotting(intervalMs = 30000): void {
    this.stopSnapshotting();
    this.snapshotInterval = setInterval(() => {
      for (const [marketId, snap] of this.snapshots) {
        dbQueries.insertSnapshot({
          marketId,
          baseBalance: 0,
          quoteBalance: 0,
          currentPrice: 0,
          realizedPnl: snap.realizedPnl,
          unrealizedPnl: snap.unrealizedPnl,
          sessionPnl: snap.realizedPnl + snap.unrealizedPnl,
        });
      }
    }, intervalMs);
  }

  stopSnapshotting(): void {
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
    }
  }

  private emptySnapshot(): PnLSnapshot {
    return {
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalVolume: 0,
      totalFees: 0,
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      totalBuyValue: 0,
      totalSellValue: 0,
      totalBoughtQty: 0,
      totalSoldQty: 0,
      averageBuyPrice: 0,
      averageSellPrice: 0,
    };
  }

  shutdown(): void {
    this.stopSnapshotting();
  }
}
