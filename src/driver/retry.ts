export interface RetryConfig {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableErrors?: string[];
}

const DEFAULT_RETRYABLE_ERRORS = [
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'ENOTCONN',
  '57P01',
  '57P02',
  '57P03',
  'PROTOCOL_CONNECTION_LOST',
  'ER_CON_COUNT_ERROR',
];

export function isRetryableError(error: unknown, customErrors: string[] = []): boolean {
  const allErrors = [...DEFAULT_RETRYABLE_ERRORS, ...customErrors];

  if (error instanceof Error) {
    const errorCode = (error as Error & { code?: string }).code;
    const errorMessage = error.message;

    return allErrors.some((code) => errorCode === code || errorMessage.includes(code));
  }
  return false;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig = {}
): Promise<T> {
  const maxRetries = config.maxRetries ?? 3;
  const baseDelayMs = config.baseDelayMs ?? 100;
  const maxDelayMs = config.maxDelayMs ?? 5000;
  const retryableErrors = config.retryableErrors ?? [];

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxRetries || !isRetryableError(error, retryableErrors)) {
        throw error;
      }

      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const jitter = Math.random() * delay * 0.1;

      console.warn(
        `[db-engine] Connection error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms:`,
        lastError.message
      );

      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    }
  }

  throw lastError;
}

export function createTimeoutPromise<T>(timeoutMs: number): Promise<T> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Health check timeout')), timeoutMs)
  );
}
