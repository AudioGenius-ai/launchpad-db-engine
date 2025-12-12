import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Column, Entity, PrimaryKey } from './decorators.js';
import { TenantEntity, WithTenantColumns } from './entity.js';
import { Repository } from './repository.js';

@WithTenantColumns()
@Entity('users')
class User extends TenantEntity {
  @PrimaryKey()
  @Column('uuid')
  id!: string;

  @Column('string')
  email!: string;

  @Column('string')
  firstName!: string;

  @Column('datetime')
  createdAt!: Date;
}

const mockDbClient = {
  table: vi.fn(),
  tableWithoutTenant: vi.fn(),
};

const mockTransactionContext = {
  table: vi.fn(),
};

const mockTableBuilder = {
  select: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(),
  delete: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  offset: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
  returning: vi.fn().mockReturnThis(),
  execute: vi.fn(),
  count: vi.fn(),
};

describe('Repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbClient.table.mockReturnValue(mockTableBuilder);
  });

  const tenantContext = {
    appId: 'app-123',
    organizationId: 'org-456',
  };

  describe('find', () => {
    it('should find all records', async () => {
      mockTableBuilder.execute.mockResolvedValueOnce([
        { id: '1', email: 'test@example.com', first_name: 'John', created_at: new Date() },
        { id: '2', email: 'test2@example.com', first_name: 'Jane', created_at: new Date() },
      ]);

      const repo = new Repository(User, mockDbClient as never, tenantContext);
      const users = await repo.find();

      expect(mockDbClient.table).toHaveBeenCalledWith('users', tenantContext);
      expect(mockTableBuilder.select).toHaveBeenCalledWith('*');
      expect(users).toHaveLength(2);
    });

    it('should find with where conditions', async () => {
      mockTableBuilder.execute.mockResolvedValueOnce([
        { id: '1', email: 'test@example.com', first_name: 'John', created_at: new Date() },
      ]);

      const repo = new Repository(User, mockDbClient as never, tenantContext);
      await repo.find({ where: { email: 'test@example.com' } });

      expect(mockTableBuilder.where).toHaveBeenCalledWith('email', '=', 'test@example.com');
    });

    it('should find with array where conditions', async () => {
      mockTableBuilder.execute.mockResolvedValueOnce([]);

      const repo = new Repository(User, mockDbClient as never, tenantContext);
      await repo.find({
        where: [
          ['email', 'LIKE', '%@example.com'],
          ['firstName', '!=', 'Admin'],
        ],
      });

      expect(mockTableBuilder.where).toHaveBeenCalledWith('email', 'LIKE', '%@example.com');
      expect(mockTableBuilder.where).toHaveBeenCalledWith('first_name', '!=', 'Admin');
    });

    it('should find with orderBy', async () => {
      mockTableBuilder.execute.mockResolvedValueOnce([]);

      const repo = new Repository(User, mockDbClient as never, tenantContext);
      await repo.find({ orderBy: { createdAt: 'desc' } });

      expect(mockTableBuilder.orderBy).toHaveBeenCalledWith('created_at', 'desc');
    });

    it('should find with limit and offset', async () => {
      mockTableBuilder.execute.mockResolvedValueOnce([]);

      const repo = new Repository(User, mockDbClient as never, tenantContext);
      await repo.find({ limit: 10, offset: 20 });

      expect(mockTableBuilder.limit).toHaveBeenCalledWith(10);
      expect(mockTableBuilder.offset).toHaveBeenCalledWith(20);
    });

    it('should find with select columns', async () => {
      mockTableBuilder.execute.mockResolvedValueOnce([]);

      const repo = new Repository(User, mockDbClient as never, tenantContext);
      await repo.find({ select: ['id', 'email'] });

      expect(mockTableBuilder.select).toHaveBeenCalledWith('id', 'email');
    });
  });

  describe('findOne', () => {
    it('should return single record', async () => {
      mockTableBuilder.execute.mockResolvedValueOnce([
        { id: '1', email: 'test@example.com', first_name: 'John', created_at: new Date() },
      ]);

      const repo = new Repository(User, mockDbClient as never, tenantContext);
      const user = await repo.findOne({ where: { id: '1' } });

      expect(mockTableBuilder.limit).toHaveBeenCalledWith(1);
      expect(user).not.toBeNull();
      expect(user!.id).toBe('1');
    });

    it('should return null when not found', async () => {
      mockTableBuilder.execute.mockResolvedValueOnce([]);

      const repo = new Repository(User, mockDbClient as never, tenantContext);
      const user = await repo.findOne({ where: { id: 'not-exists' } });

      expect(user).toBeNull();
    });
  });

  describe('findById', () => {
    it('should find by id', async () => {
      mockTableBuilder.execute.mockResolvedValueOnce([
        { id: '123', email: 'test@example.com', first_name: 'John', created_at: new Date() },
      ]);

      const repo = new Repository(User, mockDbClient as never, tenantContext);
      const user = await repo.findById('123');

      expect(mockTableBuilder.where).toHaveBeenCalledWith('id', '=', '123');
      expect(user).not.toBeNull();
    });
  });

  describe('create', () => {
    it('should create record', async () => {
      const now = new Date();
      mockTableBuilder.execute.mockResolvedValueOnce([
        { id: '1', email: 'new@example.com', first_name: 'New', created_at: now },
      ]);

      const repo = new Repository(User, mockDbClient as never, tenantContext);
      const user = await repo.create({
        id: '1',
        email: 'new@example.com',
        firstName: 'New',
        createdAt: now,
      });

      expect(mockTableBuilder.insert).toHaveBeenCalled();
      expect(mockTableBuilder.values).toHaveBeenCalledWith({
        id: '1',
        email: 'new@example.com',
        first_name: 'New',
        created_at: now,
      });
      expect(mockTableBuilder.returning).toHaveBeenCalledWith('*');
      expect(user.email).toBe('new@example.com');
    });

    it('should throw when insert returns no rows', async () => {
      mockTableBuilder.execute.mockResolvedValueOnce([]);

      const repo = new Repository(User, mockDbClient as never, tenantContext);

      await expect(repo.create({ email: 'test@example.com' })).rejects.toThrow(
        'Insert did not return any rows'
      );
    });
  });

  describe('update', () => {
    it('should update records', async () => {
      mockTableBuilder.execute.mockResolvedValueOnce([
        { id: '1', email: 'updated@example.com', first_name: 'Updated', created_at: new Date() },
      ]);

      const repo = new Repository(User, mockDbClient as never, tenantContext);
      const users = await repo.update({ id: '1' }, { email: 'updated@example.com' });

      expect(mockTableBuilder.update).toHaveBeenCalled();
      expect(mockTableBuilder.set).toHaveBeenCalledWith({ email: 'updated@example.com' });
      expect(mockTableBuilder.where).toHaveBeenCalledWith('id', '=', '1');
      expect(users).toHaveLength(1);
    });
  });

  describe('updateById', () => {
    it('should update by id', async () => {
      mockTableBuilder.execute.mockResolvedValueOnce([
        { id: '1', email: 'updated@example.com', first_name: 'Updated', created_at: new Date() },
      ]);

      const repo = new Repository(User, mockDbClient as never, tenantContext);
      const user = await repo.updateById('1', { email: 'updated@example.com' });

      expect(user).not.toBeNull();
      expect(user!.email).toBe('updated@example.com');
    });
  });

  describe('delete', () => {
    it('should delete records', async () => {
      mockTableBuilder.execute.mockResolvedValueOnce([{}]);

      const repo = new Repository(User, mockDbClient as never, tenantContext);
      const count = await repo.delete({ id: '1' });

      expect(mockTableBuilder.delete).toHaveBeenCalled();
      expect(mockTableBuilder.where).toHaveBeenCalledWith('id', '=', '1');
      expect(count).toBe(1);
    });
  });

  describe('deleteById', () => {
    it('should delete by id and return true', async () => {
      mockTableBuilder.execute.mockResolvedValueOnce([{}]);

      const repo = new Repository(User, mockDbClient as never, tenantContext);
      const deleted = await repo.deleteById('1');

      expect(deleted).toBe(true);
    });

    it('should return false when not found', async () => {
      mockTableBuilder.execute.mockResolvedValueOnce([]);

      const repo = new Repository(User, mockDbClient as never, tenantContext);
      const deleted = await repo.deleteById('not-exists');

      expect(deleted).toBe(false);
    });
  });

  describe('count', () => {
    it('should count all records', async () => {
      mockTableBuilder.count.mockResolvedValueOnce(42);

      const repo = new Repository(User, mockDbClient as never, tenantContext);
      const count = await repo.count();

      expect(mockTableBuilder.select).toHaveBeenCalled();
      expect(mockTableBuilder.count).toHaveBeenCalled();
      expect(count).toBe(42);
    });

    it('should count with where conditions', async () => {
      mockTableBuilder.count.mockResolvedValueOnce(5);

      const repo = new Repository(User, mockDbClient as never, tenantContext);
      const count = await repo.count({ email: 'test@example.com' });

      expect(mockTableBuilder.where).toHaveBeenCalledWith('email', '=', 'test@example.com');
      expect(count).toBe(5);
    });
  });

  describe('exists', () => {
    it('should return true when records exist', async () => {
      mockTableBuilder.count.mockResolvedValueOnce(1);

      const repo = new Repository(User, mockDbClient as never, tenantContext);
      const exists = await repo.exists({ email: 'test@example.com' });

      expect(exists).toBe(true);
    });

    it('should return false when no records', async () => {
      mockTableBuilder.count.mockResolvedValueOnce(0);

      const repo = new Repository(User, mockDbClient as never, tenantContext);
      const exists = await repo.exists({ email: 'nonexistent@example.com' });

      expect(exists).toBe(false);
    });
  });

  describe('tenant context validation', () => {
    it('should throw error when using DbClient without tenantContext', async () => {
      const repo = new Repository(User, mockDbClient as never);

      await expect(repo.find()).rejects.toThrow(
        'TenantContext is required when using Repository with DbClient'
      );
    });

    it('should work with TransactionContext without explicit tenantContext', async () => {
      mockTransactionContext.table.mockReturnValue(mockTableBuilder);
      mockTableBuilder.execute.mockResolvedValueOnce([]);

      const repo = new Repository(User, mockTransactionContext as never);
      const users = await repo.find();

      expect(mockTransactionContext.table).toHaveBeenCalledWith('users');
      expect(users).toHaveLength(0);
    });
  });
});
