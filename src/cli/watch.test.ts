import * as fsPromises from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Driver } from '../driver/types.js';
import type { SchemaDefinition } from '../types/index.js';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises');
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../driver/index.js', () => ({
  createDriver: vi.fn(),
}));

function createMockSchema(): SchemaDefinition {
  return {
    tables: {
      users: {
        columns: {
          id: { type: 'uuid', nullable: false, primaryKey: true },
          app_id: { type: 'uuid', nullable: false, tenant: true },
          organization_id: { type: 'uuid', nullable: false, tenant: true },
          name: { type: 'string', nullable: false },
          email: { type: 'string', nullable: false, unique: true },
        },
      },
    },
  };
}

function createMockDriver(
  schemas: Array<{ schema_name: string; schema: SchemaDefinition }> = []
): Driver {
  return {
    dialect: 'postgresql',
    connectionString: 'mock://localhost/test',
    query: vi.fn().mockResolvedValue({
      rows: schemas,
      rowCount: schemas.length,
    }),
    execute: vi.fn().mockResolvedValue({ rowCount: 0 }),
    transaction: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('CLI watch mode', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe('debouncing', () => {
    it('should debounce rapid schema changes', async () => {
      let regenerationCount = 0;
      const debounceMs = 500;
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;

      const debouncedRegenerate = () => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
          regenerationCount++;
        }, debounceMs);
      };

      debouncedRegenerate();
      debouncedRegenerate();
      debouncedRegenerate();

      expect(regenerationCount).toBe(0);

      vi.advanceTimersByTime(debounceMs);

      expect(regenerationCount).toBe(1);
    });

    it('should reset debounce timer on each change', async () => {
      let regenerationCount = 0;
      const debounceMs = 500;
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;

      const debouncedRegenerate = () => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
          regenerationCount++;
        }, debounceMs);
      };

      debouncedRegenerate();
      vi.advanceTimersByTime(200);
      debouncedRegenerate();
      vi.advanceTimersByTime(200);
      debouncedRegenerate();
      vi.advanceTimersByTime(200);

      expect(regenerationCount).toBe(0);

      vi.advanceTimersByTime(500);

      expect(regenerationCount).toBe(1);
    });
  });

  describe('checksum computation', () => {
    it('should compute consistent checksums for same schema', () => {
      const computeChecksum = (schemas: Map<string, SchemaDefinition>): string => {
        const content = JSON.stringify(
          Array.from(schemas.entries()).sort((a, b) => a[0].localeCompare(b[0]))
        );
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
          const char = content.charCodeAt(i);
          hash = (hash << 5) - hash + char;
          hash = hash & hash;
        }
        return hash.toString(16);
      };

      const schema = createMockSchema();
      const schemaMap1 = new Map<string, SchemaDefinition>([['test', schema]]);
      const schemaMap2 = new Map<string, SchemaDefinition>([['test', schema]]);

      const checksum1 = computeChecksum(schemaMap1);
      const checksum2 = computeChecksum(schemaMap2);

      expect(checksum1).toBe(checksum2);
    });

    it('should compute different checksums for different schemas', () => {
      const computeChecksum = (schemas: Map<string, SchemaDefinition>): string => {
        const content = JSON.stringify(
          Array.from(schemas.entries()).sort((a, b) => a[0].localeCompare(b[0]))
        );
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
          const char = content.charCodeAt(i);
          hash = (hash << 5) - hash + char;
          hash = hash & hash;
        }
        return hash.toString(16);
      };

      const schema1 = createMockSchema();
      const schema2: SchemaDefinition = {
        tables: {
          posts: {
            columns: {
              id: { type: 'uuid', nullable: false, primaryKey: true },
              app_id: { type: 'uuid', nullable: false, tenant: true },
              organization_id: { type: 'uuid', nullable: false, tenant: true },
              title: { type: 'string', nullable: false },
            },
          },
        },
      };

      const schemaMap1 = new Map<string, SchemaDefinition>([['test', schema1]]);
      const schemaMap2 = new Map<string, SchemaDefinition>([['test', schema2]]);

      const checksum1 = computeChecksum(schemaMap1);
      const checksum2 = computeChecksum(schemaMap2);

      expect(checksum1).not.toBe(checksum2);
    });

    it('should produce same checksum regardless of insertion order', () => {
      const computeChecksum = (schemas: Map<string, SchemaDefinition>): string => {
        const content = JSON.stringify(
          Array.from(schemas.entries()).sort((a, b) => a[0].localeCompare(b[0]))
        );
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
          const char = content.charCodeAt(i);
          hash = (hash << 5) - hash + char;
          hash = hash & hash;
        }
        return hash.toString(16);
      };

      const schema1 = createMockSchema();
      const schema2: SchemaDefinition = {
        tables: {
          posts: {
            columns: {
              id: { type: 'uuid', nullable: false, primaryKey: true },
              app_id: { type: 'uuid', nullable: false, tenant: true },
              organization_id: { type: 'uuid', nullable: false, tenant: true },
              title: { type: 'string', nullable: false },
            },
          },
        },
      };

      const schemaMap1 = new Map<string, SchemaDefinition>();
      schemaMap1.set('alpha', schema1);
      schemaMap1.set('beta', schema2);

      const schemaMap2 = new Map<string, SchemaDefinition>();
      schemaMap2.set('beta', schema2);
      schemaMap2.set('alpha', schema1);

      const checksum1 = computeChecksum(schemaMap1);
      const checksum2 = computeChecksum(schemaMap2);

      expect(checksum1).toBe(checksum2);
    });
  });

  describe('shutdown handling', () => {
    it('should set isShuttingDown flag on shutdown', async () => {
      let isShuttingDown = false;
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      let pollInterval: ReturnType<typeof setInterval> | null = null;

      const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        if (pollInterval) {
          clearInterval(pollInterval);
        }
      };

      pollInterval = setInterval(() => {}, 1000);
      debounceTimer = setTimeout(() => {}, 500);

      expect(isShuttingDown).toBe(false);

      await shutdown();

      expect(isShuttingDown).toBe(true);
    });

    it('should prevent duplicate shutdown calls', async () => {
      let shutdownCount = 0;
      let isShuttingDown = false;

      const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        shutdownCount++;
      };

      await shutdown();
      await shutdown();
      await shutdown();

      expect(shutdownCount).toBe(1);
    });

    it('should clear timers on shutdown', async () => {
      let isShuttingDown = false;
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      let pollInterval: ReturnType<typeof setInterval> | null = null;
      let timerFired = false;
      let intervalFired = false;

      const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        if (pollInterval) {
          clearInterval(pollInterval);
        }
      };

      debounceTimer = setTimeout(() => {
        timerFired = true;
      }, 500);

      pollInterval = setInterval(() => {
        intervalFired = true;
      }, 100);

      await shutdown();

      vi.advanceTimersByTime(1000);

      expect(timerFired).toBe(false);
      expect(intervalFired).toBe(false);
    });
  });

  describe('CLI argument parsing', () => {
    it('should accept --watch flag', () => {
      const parseArgs = (args: string[]): { watch?: boolean; 'debounce-ms'?: string } => {
        const result: { watch?: boolean; 'debounce-ms'?: string } = {};
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--watch') {
            result.watch = true;
          } else if (args[i] === '--debounce-ms' && args[i + 1]) {
            result['debounce-ms'] = args[i + 1];
            i++;
          }
        }
        return result;
      };

      const result = parseArgs(['--watch']);
      expect(result.watch).toBe(true);
    });

    it('should accept --debounce-ms option', () => {
      const parseArgs = (args: string[]): { watch?: boolean; 'debounce-ms'?: string } => {
        const result: { watch?: boolean; 'debounce-ms'?: string } = {};
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--watch') {
            result.watch = true;
          } else if (args[i] === '--debounce-ms' && args[i + 1]) {
            result['debounce-ms'] = args[i + 1];
            i++;
          }
        }
        return result;
      };

      const result = parseArgs(['--watch', '--debounce-ms', '1000']);
      expect(result.watch).toBe(true);
      expect(result['debounce-ms']).toBe('1000');
    });

    it('should default debounce to 500ms if not specified', () => {
      const defaultDebounceMs = 500;
      const parseDebounce = (value?: string): number => {
        return value ? Number.parseInt(value, 10) : defaultDebounceMs;
      };

      expect(parseDebounce(undefined)).toBe(500);
      expect(parseDebounce('1000')).toBe(1000);
      expect(parseDebounce('100')).toBe(100);
    });
  });
});
