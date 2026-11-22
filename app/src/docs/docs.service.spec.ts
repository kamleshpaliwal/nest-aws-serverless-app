import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Doc } from './doc.model';
import { DocsRepository } from './docs.repository';
import { DocsService } from './docs.service';

describe('DocsService', () => {
  let service: DocsService;

  // Each mock lives in its own variable and the fake repository is built from them.
  // Asserting on `create` (not `repo.create`) avoids the unbound-method lint warning.
  let create: jest.Mock;
  let getById: jest.Mock;
  let listByUser: jest.Mock;

  // Fresh fakes + fresh service before EVERY test, so no test can see another's
  // call counts or return values (shared state = flaky, order-dependent tests).
  beforeEach(async () => {
    create = jest.fn();
    getById = jest.fn();
    listByUser = jest.fn();
    const repo: DocsRepository = {
      create,
      getById,
      listByUser,
      markUploaded: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [DocsService, { provide: DocsRepository, useValue: repo }],
    }).compile();

    service = moduleRef.get(DocsService);
  });

  describe('create', () => {
    it('saves a PENDING doc with generated id and timestamps', async () => {
      create.mockImplementation(async (doc: Doc) => doc); // echo what it receives

      const result = await service.create({ userId: 'u1', title: 'Hello' });

      expect(result.status).toBe('PENDING');
      expect(result.userId).toBe('u1');
      expect(result.id).toMatch(/^[0-9a-f-]{36}$/); // UUID shape
      expect(result.createdAt).toBe(result.updatedAt);
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('does not let the caller choose the status', async () => {
      create.mockImplementation(async (doc: Doc) => doc);

      // A client smuggling status through (the pipe normally blocks this).
      const dto = { userId: 'u1', title: 'x', status: 'UPLOADED' } as never;
      const result = await service.create(dto);

      expect(result.status).toBe('PENDING');
    });
  });

  describe('get', () => {
    it('returns the doc when it exists', async () => {
      const doc: Doc = {
        id: 'd1',
        userId: 'u1',
        title: 'T',
        status: 'PENDING',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      getById.mockResolvedValue(doc);

      await expect(service.get('d1')).resolves.toEqual(doc);
    });

    it('throws NotFoundException when the doc does not exist', async () => {
      getById.mockResolvedValue(undefined);

      await expect(service.get('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('list', () => {
    it('passes userId, limit and cursor to the repository unchanged', async () => {
      listByUser.mockResolvedValue({ items: [] });

      await service.list('u1', 10, 'abc');

      expect(listByUser).toHaveBeenCalledWith('u1', 10, 'abc');
    });
  });
});
