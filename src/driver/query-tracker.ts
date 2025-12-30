export interface QueryInfo {
  id: string;
  query: string;
  startedAt: Date;
  backendPid?: number;
}

export class QueryTracker {
  private activeQueries = new Map<string, QueryInfo>();
  private completedCount = 0;
  private cancelledCount = 0;
  private draining = false;
  private drainResolve: (() => void) | null = null;

  trackQuery(id: string, query: string, backendPid?: number): void {
    if (this.draining) {
      throw new Error('Driver is draining - new queries are not accepted');
    }
    this.activeQueries.set(id, {
      id,
      query: query.slice(0, 200),
      startedAt: new Date(),
      backendPid,
    });
  }

  untrackQuery(id: string): void {
    if (this.activeQueries.delete(id)) {
      this.completedCount++;
      if (this.draining && this.activeQueries.size === 0 && this.drainResolve) {
        this.drainResolve();
      }
    }
  }

  getActiveCount(): number {
    return this.activeQueries.size;
  }

  getActiveQueries(): QueryInfo[] {
    return Array.from(this.activeQueries.values());
  }

  async startDrain(timeoutMs: number): Promise<{ timedOut: boolean }> {
    this.draining = true;

    if (this.activeQueries.size === 0) {
      return { timedOut: false };
    }

    const drainPromise = new Promise<void>((resolve) => {
      this.drainResolve = resolve;
    });

    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), timeoutMs);
    });

    const result = await Promise.race([
      drainPromise.then(() => 'drained' as const),
      timeoutPromise,
    ]);

    return { timedOut: result === 'timeout' };
  }

  markCancelled(id: string): void {
    if (this.activeQueries.delete(id)) {
      this.cancelledCount++;
      if (this.draining && this.activeQueries.size === 0 && this.drainResolve) {
        this.drainResolve();
      }
    }
  }

  getStats(): { completed: number; cancelled: number; active: number } {
    return {
      completed: this.completedCount,
      cancelled: this.cancelledCount,
      active: this.activeQueries.size,
    };
  }

  isDraining(): boolean {
    return this.draining;
  }

  reset(): void {
    this.activeQueries.clear();
    this.completedCount = 0;
    this.cancelledCount = 0;
    this.draining = false;
    this.drainResolve = null;
  }
}
