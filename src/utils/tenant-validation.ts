import type { TenantContext } from '../types/index.js';

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

export function validateTenantContext(ctx: TenantContext | undefined, tableName: string): void {
  if (!ctx) {
    throw new TenantContextError(
      `Missing tenant context for table "${tableName}". ` +
        'Provide a valid TenantContext with appId and organizationId, ' +
        'or use tableWithoutTenant() for system tables.'
    );
  }

  if (typeof ctx.appId !== 'string' || ctx.appId.trim() === '') {
    throw new TenantContextError(
      `Invalid tenant context for table "${tableName}": ` +
        'appId must be a non-empty string.'
    );
  }

  if (typeof ctx.organizationId !== 'string' || ctx.organizationId.trim() === '') {
    throw new TenantContextError(
      `Invalid tenant context for table "${tableName}": ` +
        'organizationId must be a non-empty string.'
    );
  }
}

export function validateTenantContextOrWarn(
  ctx: TenantContext | undefined,
  tableName: string
): void {
  if (!ctx) {
    console.warn(
      `[WARNING] Missing tenant context for table "${tableName}". ` +
        'This query will not be filtered by tenant. ' +
        'Use tableWithoutTenant() explicitly if this is intended.'
    );
    return;
  }

  if (typeof ctx.appId !== 'string' || ctx.appId.trim() === '') {
    console.warn(
      `[WARNING] Invalid appId in tenant context for table "${tableName}". ` +
        'This may result in unfiltered queries.'
    );
  }

  if (typeof ctx.organizationId !== 'string' || ctx.organizationId.trim() === '') {
    console.warn(
      `[WARNING] Invalid organizationId in tenant context for table "${tableName}". ` +
        'This may result in unfiltered queries.'
    );
  }
}
