export interface PoolStats {
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  waitingRequests: number;
  maxConnections: number;
}

export interface HealthCheckResult {
  healthy: boolean;
  latencyMs: number;
  lastCheckedAt: Date;
  error?: string;
}

export interface HealthCheckConfig {
  enabled?: boolean;
  intervalMs?: number;
  timeoutMs?: number;
  onHealthChange?: (healthy: boolean, result: HealthCheckResult) => void;
}

export function createHealthCheckResult(
  healthy: boolean,
  latencyMs: number,
  error?: string
): HealthCheckResult {
  return {
    healthy,
    latencyMs,
    lastCheckedAt: new Date(),
    ...(error && { error }),
  };
}

export function getDefaultHealthCheckConfig(
  overrides?: Partial<HealthCheckConfig>
): HealthCheckConfig {
  return {
    enabled: overrides?.enabled ?? false,
    intervalMs: overrides?.intervalMs ?? 30000,
    timeoutMs: overrides?.timeoutMs ?? 5000,
    onHealthChange: overrides?.onHealthChange,
  };
}
