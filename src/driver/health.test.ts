import { describe, expect, it } from 'vitest';
import {
  type HealthCheckConfig,
  type HealthCheckResult,
  createHealthCheckResult,
  getDefaultHealthCheckConfig,
} from './health.js';

describe('Health Check Utilities', () => {
  describe('createHealthCheckResult', () => {
    it('should create a healthy result with latency', () => {
      const result = createHealthCheckResult(true, 15);

      expect(result.healthy).toBe(true);
      expect(result.latencyMs).toBe(15);
      expect(result.lastCheckedAt).toBeInstanceOf(Date);
      expect(result.error).toBeUndefined();
    });

    it('should create an unhealthy result with error', () => {
      const result = createHealthCheckResult(false, 5000, 'Connection timeout');

      expect(result.healthy).toBe(false);
      expect(result.latencyMs).toBe(5000);
      expect(result.lastCheckedAt).toBeInstanceOf(Date);
      expect(result.error).toBe('Connection timeout');
    });

    it('should not include error property when no error provided', () => {
      const result = createHealthCheckResult(true, 10);

      expect('error' in result).toBe(false);
    });

    it('should set lastCheckedAt to current time', () => {
      const before = new Date();
      const result = createHealthCheckResult(true, 1);
      const after = new Date();

      expect(result.lastCheckedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.lastCheckedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should handle zero latency', () => {
      const result = createHealthCheckResult(true, 0);

      expect(result.latencyMs).toBe(0);
    });
  });

  describe('getDefaultHealthCheckConfig', () => {
    it('should return default values when no overrides provided', () => {
      const config = getDefaultHealthCheckConfig();

      expect(config.enabled).toBe(false);
      expect(config.intervalMs).toBe(30000);
      expect(config.timeoutMs).toBe(5000);
      expect(config.onHealthChange).toBeUndefined();
    });

    it('should override enabled when provided', () => {
      const config = getDefaultHealthCheckConfig({ enabled: true });

      expect(config.enabled).toBe(true);
      expect(config.intervalMs).toBe(30000);
      expect(config.timeoutMs).toBe(5000);
    });

    it('should override intervalMs when provided', () => {
      const config = getDefaultHealthCheckConfig({ intervalMs: 60000 });

      expect(config.enabled).toBe(false);
      expect(config.intervalMs).toBe(60000);
      expect(config.timeoutMs).toBe(5000);
    });

    it('should override timeoutMs when provided', () => {
      const config = getDefaultHealthCheckConfig({ timeoutMs: 10000 });

      expect(config.enabled).toBe(false);
      expect(config.intervalMs).toBe(30000);
      expect(config.timeoutMs).toBe(10000);
    });

    it('should set onHealthChange callback when provided', () => {
      const callback = (healthy: boolean, result: HealthCheckResult) => {
        console.log(healthy, result);
      };
      const config = getDefaultHealthCheckConfig({ onHealthChange: callback });

      expect(config.onHealthChange).toBe(callback);
    });

    it('should allow all overrides at once', () => {
      const callback = (healthy: boolean, result: HealthCheckResult) => {
        console.log(healthy, result);
      };
      const config = getDefaultHealthCheckConfig({
        enabled: true,
        intervalMs: 15000,
        timeoutMs: 3000,
        onHealthChange: callback,
      });

      expect(config.enabled).toBe(true);
      expect(config.intervalMs).toBe(15000);
      expect(config.timeoutMs).toBe(3000);
      expect(config.onHealthChange).toBe(callback);
    });

    it('should handle empty override object', () => {
      const config = getDefaultHealthCheckConfig({});

      expect(config.enabled).toBe(false);
      expect(config.intervalMs).toBe(30000);
      expect(config.timeoutMs).toBe(5000);
      expect(config.onHealthChange).toBeUndefined();
    });
  });
});
