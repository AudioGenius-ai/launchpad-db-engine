import { describe, expect, it } from 'vitest';
import { TenantContextError, validateTenantContext, validateTenantContextOrWarn } from '../../src/utils/tenant-validation.js';
import type { TenantContext } from '../../src/types/index.js';

describe('Tenant Context Validation', () => {
  describe('validateTenantContext', () => {
    it('should pass with valid tenant context', () => {
      const ctx: TenantContext = {
        appId: 'app123',
        organizationId: 'org456',
      };

      expect(() => validateTenantContext(ctx, 'users')).not.toThrow();
    });

    it('should throw when tenant context is undefined', () => {
      expect(() => validateTenantContext(undefined, 'users')).toThrow(TenantContextError);
      expect(() => validateTenantContext(undefined, 'users')).toThrow(
        'Missing tenant context for table "users"'
      );
    });

    it('should throw when appId is missing', () => {
      const ctx = {
        appId: '',
        organizationId: 'org456',
      } as TenantContext;

      expect(() => validateTenantContext(ctx, 'users')).toThrow(TenantContextError);
      expect(() => validateTenantContext(ctx, 'users')).toThrow(
        'appId must be a non-empty string'
      );
    });

    it('should throw when appId is whitespace only', () => {
      const ctx = {
        appId: '   ',
        organizationId: 'org456',
      } as TenantContext;

      expect(() => validateTenantContext(ctx, 'users')).toThrow(TenantContextError);
    });

    it('should throw when organizationId is missing', () => {
      const ctx = {
        appId: 'app123',
        organizationId: '',
      } as TenantContext;

      expect(() => validateTenantContext(ctx, 'users')).toThrow(TenantContextError);
      expect(() => validateTenantContext(ctx, 'users')).toThrow(
        'organizationId must be a non-empty string'
      );
    });

    it('should throw when organizationId is whitespace only', () => {
      const ctx = {
        appId: 'app123',
        organizationId: '   ',
      } as TenantContext;

      expect(() => validateTenantContext(ctx, 'users')).toThrow(TenantContextError);
    });

    it('should throw when both appId and organizationId are missing', () => {
      const ctx = {
        appId: '',
        organizationId: '',
      } as TenantContext;

      expect(() => validateTenantContext(ctx, 'users')).toThrow(TenantContextError);
    });

    it('should include table name in error message', () => {
      expect(() => validateTenantContext(undefined, 'products')).toThrow(
        'table "products"'
      );
    });

    it('should accept tenant context with optional userId', () => {
      const ctx: TenantContext = {
        appId: 'app123',
        organizationId: 'org456',
        userId: 'user789',
      };

      expect(() => validateTenantContext(ctx, 'users')).not.toThrow();
    });
  });

  describe('validateTenantContextOrWarn', () => {
    it('should not warn with valid tenant context', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const ctx: TenantContext = {
        appId: 'app123',
        organizationId: 'org456',
      };

      validateTenantContextOrWarn(ctx, 'users');
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should warn when tenant context is undefined', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      validateTenantContextOrWarn(undefined, 'users');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Missing tenant context for table "users"')
      );

      consoleSpy.mockRestore();
    });

    it('should warn when appId is invalid', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const ctx = {
        appId: '',
        organizationId: 'org456',
      } as TenantContext;

      validateTenantContextOrWarn(ctx, 'users');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid appId')
      );

      consoleSpy.mockRestore();
    });

    it('should warn when organizationId is invalid', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const ctx = {
        appId: 'app123',
        organizationId: '',
      } as TenantContext;

      validateTenantContextOrWarn(ctx, 'users');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid organizationId')
      );

      consoleSpy.mockRestore();
    });
  });
});
