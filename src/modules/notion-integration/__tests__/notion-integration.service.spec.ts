import { NotionIntegrationService } from '../notion-integration.service';
import { NotFoundException } from '@nestjs/common';

describe('NotionIntegrationService', () => {
  let service: NotionIntegrationService;
  let prismaMock: any;
  let encryptionMock: any;
  let configMock: any;

  beforeEach(() => {
    prismaMock = {
      integrationConnection: {
        findUnique: jest.fn(),
        deleteMany: jest.fn(),
      },
      notionPageIndex: {
        findMany: jest.fn(),
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
      $transaction: jest.fn((cb) => (typeof cb === 'function' ? cb(prismaMock) : Promise.all(cb))),
    };

    encryptionMock = {
      encrypt: jest.fn(),
      decrypt: jest.fn(),
    };

    configMock = {
      get: jest.fn((key) => {
        if (key === 'INTEGRATION_STATE_SECRET') return 'state-secret';
        if (key === 'JWT_SECRET') return 'jwt-secret';
        if (key === 'CORS_ORIGIN') return 'http://localhost:3000';
        return undefined;
      }),
      getOrThrow: jest.fn((key) => {
        if (key === 'NOTION_CLIENT_ID') return 'client-id';
        if (key === 'NOTION_CLIENT_SECRET') return 'client-secret';
        if (key === 'NOTION_REDIRECT_URI') return 'http://localhost:4000/callback';
        if (key === 'JWT_SECRET') return 'jwt-secret';
        return 'mock-value';
      }),
    };

    service = new NotionIntegrationService(prismaMock, encryptionMock, configMock);
  });

  describe('getPageIndex', () => {
    it('returns stale true and triggers background refresh if no page index exists', async () => {
      prismaMock.notionPageIndex.findMany.mockResolvedValue([]);
      // Stub refreshPageIndex to not make external search call in this test
      jest.spyOn(service, 'refreshPageIndex').mockResolvedValue(undefined);

      const res = await service.getPageIndex('user-1');
      expect(res.stale).toBe(true);
      expect(res.items).toEqual([]);
      expect(service.refreshPageIndex).toHaveBeenCalledWith('user-1');
    });

    it('returns items and stale false if page index exists and is fresh', async () => {
      const freshDate = new Date();
      prismaMock.notionPageIndex.findMany.mockResolvedValue([
        {
          notionPageId: 'page-1',
          title: 'Page 1',
          pageType: 'page',
          indexedAt: freshDate,
        },
      ]);
      jest.spyOn(service, 'refreshPageIndex');

      const res = await service.getPageIndex('user-1');
      expect(res.stale).toBe(false);
      expect(res.items).toEqual([
        {
          notionPageId: 'page-1',
          title: 'Page 1',
          pageType: 'page',
          indexedAt: freshDate.toISOString(),
        },
      ]);
      expect(service.refreshPageIndex).not.toHaveBeenCalled();
    });

    it('returns items and stale true and triggers background refresh if page index exists but is older than 15 minutes', async () => {
      const oldDate = new Date(Date.now() - 20 * 60 * 1000);
      prismaMock.notionPageIndex.findMany.mockResolvedValue([
        {
          notionPageId: 'page-1',
          title: 'Page 1',
          pageType: 'page',
          indexedAt: oldDate,
        },
      ]);
      jest.spyOn(service, 'refreshPageIndex').mockResolvedValue(undefined);

      const res = await service.getPageIndex('user-1');
      expect(res.stale).toBe(true);
      expect(res.items).toEqual([
        {
          notionPageId: 'page-1',
          title: 'Page 1',
          pageType: 'page',
          indexedAt: oldDate.toISOString(),
        },
      ]);
      expect(service.refreshPageIndex).toHaveBeenCalledWith('user-1');
    });
  });
});
