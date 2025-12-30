import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolStats } from './health.js';
import { createPoolMonitor } from './pool-monitor.js';

describe('Pool Monitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createMockStats(active: number, max: number): PoolStats {
    return {
      totalConnections: max,
      activeConnections: active,
      idleConnections: max - active,
      waitingRequests: 0,
      maxConnections: max,
    };
  }

  describe('createPoolMonitor', () => {
    it('should create a pool monitor with default thresholds', () => {
      const getStats = () => createMockStats(5, 20);
      const monitor = createPoolMonitor(getStats);

      expect(monitor.start).toBeDefined();
      expect(monitor.stop).toBeDefined();
      expect(monitor.getLastLevel).toBeDefined();
    });

    it('should start with normal level', () => {
      const getStats = () => createMockStats(5, 20);
      const monitor = createPoolMonitor(getStats);

      expect(monitor.getLastLevel()).toBe('normal');
    });
  });

  describe('threshold detection', () => {
    it('should detect warning level at 80% utilization', () => {
      const getStats = () => createMockStats(16, 20);
      const onWarning = vi.fn();
      const monitor = createPoolMonitor(getStats, { onWarning });

      monitor.start();
      vi.advanceTimersByTime(0);

      expect(monitor.getLastLevel()).toBe('warning');
      expect(onWarning).toHaveBeenCalled();
    });

    it('should detect critical level at 95% utilization', () => {
      const getStats = () => createMockStats(19, 20);
      const onCritical = vi.fn();
      const monitor = createPoolMonitor(getStats, { onCritical });

      monitor.start();
      vi.advanceTimersByTime(0);

      expect(monitor.getLastLevel()).toBe('critical');
      expect(onCritical).toHaveBeenCalled();
    });

    it('should remain normal below 80% utilization', () => {
      const getStats = () => createMockStats(15, 20);
      const onWarning = vi.fn();
      const onCritical = vi.fn();
      const monitor = createPoolMonitor(getStats, { onWarning, onCritical });

      monitor.start();
      vi.advanceTimersByTime(0);

      expect(monitor.getLastLevel()).toBe('normal');
      expect(onWarning).not.toHaveBeenCalled();
      expect(onCritical).not.toHaveBeenCalled();
    });

    it('should use custom thresholds', () => {
      const getStats = () => createMockStats(12, 20);
      const onWarning = vi.fn();
      const monitor = createPoolMonitor(getStats, {
        warningThreshold: 0.5,
        onWarning,
      });

      monitor.start();
      vi.advanceTimersByTime(0);

      expect(monitor.getLastLevel()).toBe('warning');
      expect(onWarning).toHaveBeenCalled();
    });

    it('should trigger recovery callback when returning to normal', () => {
      let active = 19;
      const getStats = () => createMockStats(active, 20);
      const onRecovery = vi.fn();
      const monitor = createPoolMonitor(getStats, {
        checkIntervalMs: 1000,
        onRecovery,
      });

      monitor.start();
      vi.advanceTimersByTime(0);
      expect(monitor.getLastLevel()).toBe('critical');

      active = 5;
      vi.advanceTimersByTime(1000);

      expect(monitor.getLastLevel()).toBe('normal');
      expect(onRecovery).toHaveBeenCalled();
    });
  });

  describe('start and stop', () => {
    it('should check pool at specified interval', () => {
      let checkCount = 0;
      const getStats = () => {
        checkCount++;
        return createMockStats(5, 20);
      };
      const monitor = createPoolMonitor(getStats, { checkIntervalMs: 1000 });

      monitor.start();
      expect(checkCount).toBe(1);

      vi.advanceTimersByTime(1000);
      expect(checkCount).toBe(2);

      vi.advanceTimersByTime(1000);
      expect(checkCount).toBe(3);
    });

    it('should stop checking when stopped', () => {
      let checkCount = 0;
      const getStats = () => {
        checkCount++;
        return createMockStats(5, 20);
      };
      const monitor = createPoolMonitor(getStats, { checkIntervalMs: 1000 });

      monitor.start();
      expect(checkCount).toBe(1);

      vi.advanceTimersByTime(1000);
      expect(checkCount).toBe(2);

      monitor.stop();

      vi.advanceTimersByTime(2000);
      expect(checkCount).toBe(2);
    });

    it('should not start multiple intervals', () => {
      let checkCount = 0;
      const getStats = () => {
        checkCount++;
        return createMockStats(5, 20);
      };
      const monitor = createPoolMonitor(getStats, { checkIntervalMs: 1000 });

      monitor.start();
      monitor.start();
      monitor.start();

      expect(checkCount).toBe(1);

      vi.advanceTimersByTime(1000);
      expect(checkCount).toBe(2);
    });
  });

  describe('edge cases', () => {
    it('should handle zero max connections gracefully', () => {
      const getStats = () => createMockStats(0, 0);
      const onWarning = vi.fn();
      const onCritical = vi.fn();
      const monitor = createPoolMonitor(getStats, { onWarning, onCritical });

      monitor.start();
      vi.advanceTimersByTime(0);

      expect(monitor.getLastLevel()).toBe('normal');
      expect(onWarning).not.toHaveBeenCalled();
      expect(onCritical).not.toHaveBeenCalled();
    });

    it('should skip directly from normal to critical', () => {
      let active = 5;
      const getStats = () => createMockStats(active, 20);
      const onWarning = vi.fn();
      const onCritical = vi.fn();
      const monitor = createPoolMonitor(getStats, {
        checkIntervalMs: 1000,
        onWarning,
        onCritical,
      });

      monitor.start();
      expect(monitor.getLastLevel()).toBe('normal');

      active = 19;
      vi.advanceTimersByTime(1000);

      expect(monitor.getLastLevel()).toBe('critical');
      expect(onCritical).toHaveBeenCalled();
      expect(onWarning).not.toHaveBeenCalled();
    });

    it('should not trigger warning callback when already in warning', () => {
      const getStats = () => createMockStats(16, 20);
      const onWarning = vi.fn();
      const monitor = createPoolMonitor(getStats, {
        checkIntervalMs: 1000,
        onWarning,
      });

      monitor.start();
      expect(onWarning).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(1000);

      expect(onWarning).toHaveBeenCalledTimes(1);
    });
  });

  describe('console logging', () => {
    it('should log warning message at warning threshold', () => {
      const getStats = () => createMockStats(16, 20);
      const monitor = createPoolMonitor(getStats);

      monitor.start();

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('WARNING: High pool utilization'),
        expect.any(Object)
      );
    });

    it('should log error message at critical threshold', () => {
      const getStats = () => createMockStats(19, 20);
      const monitor = createPoolMonitor(getStats);

      monitor.start();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('CRITICAL: Pool exhaustion imminent'),
        expect.any(Object)
      );
    });

    it('should log info message when returning to normal', () => {
      let active = 19;
      const getStats = () => createMockStats(active, 20);
      const monitor = createPoolMonitor(getStats, { checkIntervalMs: 1000 });

      monitor.start();
      active = 5;
      vi.advanceTimersByTime(1000);

      expect(console.info).toHaveBeenCalledWith(
        expect.stringContaining('Pool utilization returned to normal')
      );
    });
  });
});
