import type { PoolStats } from './health.js';

export interface PoolMonitorConfig {
  warningThreshold?: number;
  criticalThreshold?: number;
  checkIntervalMs?: number;
  onWarning?: (stats: PoolStats) => void;
  onCritical?: (stats: PoolStats) => void;
  onRecovery?: (stats: PoolStats) => void;
}

export interface PoolMonitor {
  start(): void;
  stop(): void;
  getLastLevel(): 'normal' | 'warning' | 'critical';
}

export function createPoolMonitor(
  getStats: () => PoolStats,
  config: PoolMonitorConfig = {}
): PoolMonitor {
  const warningThreshold = config.warningThreshold ?? 0.8;
  const criticalThreshold = config.criticalThreshold ?? 0.95;
  const checkIntervalMs = config.checkIntervalMs ?? 10000;

  let interval: ReturnType<typeof setInterval> | null = null;
  let lastLevel: 'normal' | 'warning' | 'critical' = 'normal';

  function checkPool(): void {
    const stats = getStats();
    if (stats.maxConnections === 0) return;

    const utilization = stats.activeConnections / stats.maxConnections;

    if (utilization >= criticalThreshold && lastLevel !== 'critical') {
      lastLevel = 'critical';
      console.error(
        `[db-engine] CRITICAL: Pool exhaustion imminent (${(utilization * 100).toFixed(1)}% utilized)`,
        stats
      );
      config.onCritical?.(stats);
    } else if (utilization >= warningThreshold && utilization < criticalThreshold && lastLevel === 'normal') {
      lastLevel = 'warning';
      console.warn(
        `[db-engine] WARNING: High pool utilization (${(utilization * 100).toFixed(1)}%)`,
        stats
      );
      config.onWarning?.(stats);
    } else if (utilization < warningThreshold && lastLevel !== 'normal') {
      lastLevel = 'normal';
      console.info(
        `[db-engine] Pool utilization returned to normal (${(utilization * 100).toFixed(1)}%)`
      );
      config.onRecovery?.(stats);
    }
  }

  return {
    start(): void {
      if (interval) return;
      interval = setInterval(checkPool, checkIntervalMs);
      checkPool();
    },

    stop(): void {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },

    getLastLevel(): 'normal' | 'warning' | 'critical' {
      return lastLevel;
    },
  };
}
