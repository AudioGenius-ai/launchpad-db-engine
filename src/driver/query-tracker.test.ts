import { describe, it, expect, beforeEach } from 'vitest';
import { QueryTracker } from './query-tracker.js';

describe('QueryTracker', () => {
  let tracker: QueryTracker;

  beforeEach(() => {
    tracker = new QueryTracker();
  });

  describe('trackQuery', () => {
    it('should track a new query', () => {
      tracker.trackQuery('q1', 'SELECT * FROM users');
      expect(tracker.getActiveCount()).toBe(1);
    });

    it('should track multiple queries', () => {
      tracker.trackQuery('q1', 'SELECT * FROM users');
      tracker.trackQuery('q2', 'SELECT * FROM posts');
      expect(tracker.getActiveCount()).toBe(2);
    });

    it('should truncate query text to 200 characters', () => {
      const longQuery = 'SELECT '.padEnd(300, 'x');
      tracker.trackQuery('q1', longQuery);
      const queries = tracker.getActiveQueries();
      expect(queries[0].query.length).toBe(200);
    });

    it('should throw when tracking new query while draining', async () => {
      tracker.trackQuery('q1', 'SELECT 1');
      tracker.startDrain(1000);

      expect(() => tracker.trackQuery('q2', 'SELECT 2')).toThrow(
        'Driver is draining - new queries are not accepted'
      );
    });
  });

  describe('untrackQuery', () => {
    it('should untrack a completed query', () => {
      tracker.trackQuery('q1', 'SELECT * FROM users');
      tracker.untrackQuery('q1');
      expect(tracker.getActiveCount()).toBe(0);
    });

    it('should increment completed count', () => {
      tracker.trackQuery('q1', 'SELECT 1');
      tracker.untrackQuery('q1');
      expect(tracker.getStats().completed).toBe(1);
    });

    it('should handle untracking non-existent query gracefully', () => {
      tracker.untrackQuery('nonexistent');
      expect(tracker.getStats().completed).toBe(0);
    });
  });

  describe('getActiveQueries', () => {
    it('should return all active queries with info', () => {
      tracker.trackQuery('q1', 'SELECT * FROM users', 123);
      tracker.trackQuery('q2', 'SELECT * FROM posts', 456);

      const queries = tracker.getActiveQueries();
      expect(queries).toHaveLength(2);
      expect(queries[0].id).toBe('q1');
      expect(queries[0].backendPid).toBe(123);
      expect(queries[1].id).toBe('q2');
      expect(queries[1].backendPid).toBe(456);
    });

    it('should include startedAt timestamp', () => {
      const before = new Date();
      tracker.trackQuery('q1', 'SELECT 1');
      const after = new Date();

      const queries = tracker.getActiveQueries();
      expect(queries[0].startedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(queries[0].startedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('startDrain', () => {
    it('should return immediately if no active queries', async () => {
      const result = await tracker.startDrain(1000);
      expect(result.timedOut).toBe(false);
    });

    it('should wait for active queries to complete', async () => {
      tracker.trackQuery('q1', 'SELECT 1');

      const drainPromise = tracker.startDrain(1000);

      setTimeout(() => {
        tracker.untrackQuery('q1');
      }, 50);

      const result = await drainPromise;
      expect(result.timedOut).toBe(false);
    });

    it('should timeout if queries do not complete', async () => {
      tracker.trackQuery('q1', 'SELECT 1');

      const result = await tracker.startDrain(50);
      expect(result.timedOut).toBe(true);
    });

    it('should set draining state', async () => {
      expect(tracker.isDraining()).toBe(false);
      tracker.startDrain(100);
      expect(tracker.isDraining()).toBe(true);
    });
  });

  describe('markCancelled', () => {
    it('should mark query as cancelled', () => {
      tracker.trackQuery('q1', 'SELECT 1');
      tracker.markCancelled('q1');
      expect(tracker.getActiveCount()).toBe(0);
      expect(tracker.getStats().cancelled).toBe(1);
    });

    it('should resolve drain when all cancelled', async () => {
      tracker.trackQuery('q1', 'SELECT 1');
      tracker.trackQuery('q2', 'SELECT 2');

      const drainPromise = tracker.startDrain(1000);

      setTimeout(() => {
        tracker.markCancelled('q1');
        tracker.markCancelled('q2');
      }, 50);

      const result = await drainPromise;
      expect(result.timedOut).toBe(false);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      tracker.trackQuery('q1', 'SELECT 1');
      tracker.trackQuery('q2', 'SELECT 2');
      tracker.trackQuery('q3', 'SELECT 3');

      tracker.untrackQuery('q1');
      tracker.markCancelled('q2');

      const stats = tracker.getStats();
      expect(stats.completed).toBe(1);
      expect(stats.cancelled).toBe(1);
      expect(stats.active).toBe(1);
    });
  });

  describe('reset', () => {
    it('should reset all state', () => {
      tracker.trackQuery('q1', 'SELECT 1');
      tracker.untrackQuery('q1');
      tracker.trackQuery('q2', 'SELECT 2');
      tracker.startDrain(1000);

      tracker.reset();

      expect(tracker.getActiveCount()).toBe(0);
      expect(tracker.getStats().completed).toBe(0);
      expect(tracker.getStats().cancelled).toBe(0);
      expect(tracker.isDraining()).toBe(false);
    });
  });
});
