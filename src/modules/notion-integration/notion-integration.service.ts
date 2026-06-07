import { Injectable, Logger, NotFoundException, ForbiddenException, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client as NotionClient } from '@notionhq/client';
import type {
  PageObjectResponse,
  DatabaseObjectResponse,
  RichTextItemResponse,
  BlockObjectResponse,
} from '@notionhq/client/build/src/api-endpoints';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../shared/services/encryption.service';
import { NotionStatusDto } from './dto/notion-status.dto';
import { NotionPageDto } from './dto/notion-page.dto';
import { NotionPageIndexDto, NotionPageIndexItemDto } from './dto/notion-page-index.dto';
import { NotionBlockDto } from './dto/notion-block.dto';
import { NotionPageContentDto } from './dto/notion-page-content.dto';
import * as crypto from 'crypto';

interface OAuthStateData {
  userId: string;
  expiresAt: number;
}

interface NotionOAuthTokenResponse {
  access_token: string;
  workspace_id: string;
  workspace_name?: string;
  workspace_icon?: string;
  bot_id?: string;
}


@Injectable()
export class NotionIntegrationService {
  private readonly logger = new Logger(NotionIntegrationService.name);

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly frontendUrl: string;
  private readonly integrationStateSecret: string;

  private readonly STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly INDEX_STALE_MS = 15 * 60 * 1000; // 15 minutes

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
  ) {
    this.clientId = this.config.get<string>('NOTION_CLIENT_ID') ?? '';
    this.clientSecret = this.config.get<string>('NOTION_CLIENT_SECRET') ?? '';
    this.redirectUri = this.config.get<string>('NOTION_REDIRECT_URI') ?? '';
    // State signing secret falls back to JWT_SECRET to keep dev envs working.
    this.integrationStateSecret =
      this.config.get<string>('INTEGRATION_STATE_SECRET') ??
      this.config.getOrThrow<string>('JWT_SECRET');

    // Uses first origin from CORS_ORIGIN as the frontend redirect base URL.
    // Single-origin assumption is acceptable for now — a dedicated FRONTEND_URL
    // env var should be introduced if multiple origins are ever needed.
    const corsOrigin = this.config.getOrThrow<string>('CORS_ORIGIN');
    this.frontendUrl = corsOrigin.split(',')[0].trim();
  }



  // Generate signed HMAC state token (HMAC-SHA256 + expiry).
  private generateSignedState(userId: string): string {
    const expiresAt = Date.now() + this.STATE_TTL_MS;
    const payload = JSON.stringify({ userId, expiresAt });
    const payloadB64 = Buffer.from(payload).toString('base64url');
    const signature = crypto
      .createHmac('sha256', this.integrationStateSecret)
      .update(payloadB64)
      .digest('base64url');
    return `${payloadB64}.${signature}`;
  }

  private verifyAndExtractState(state: string): { userId: string } | null {
    try {
      const parts = state.split('.');
      if (parts.length !== 2) return null;
      const [payloadB64, signature] = parts;
      
      const expectedSignature = crypto
        .createHmac('sha256', this.integrationStateSecret)
        .update(payloadB64)
        .digest('base64url');
      const sigBuffer = Buffer.from(signature, 'base64url');
      const expectedSigBuffer = Buffer.from(expectedSignature, 'base64url');

      if (sigBuffer.length !== expectedSigBuffer.length) {
        return null;
      }
      if (!crypto.timingSafeEqual(sigBuffer, expectedSigBuffer)) {
        return null;
      }

      const payloadStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
      const { userId, expiresAt } = JSON.parse(payloadStr);

      if (typeof userId !== 'string' || typeof expiresAt !== 'number') return null;
      if (expiresAt < Date.now()) return null;

      return { userId };
    } catch {
      return null;
    }
  }

  private isConfigured(): boolean {
    return !!(this.clientId && this.clientSecret && this.redirectUri);
  }

  getAuthorizationUrl(userId: string): string {
    if (!this.isConfigured()) {
      throw new HttpException(
        'Notion integration is not configured on this server',
        503,
      );
    }
    const stateToken = this.generateSignedState(userId);
    return `https://api.notion.com/v1/oauth/authorize?client_id=${this.clientId}&response_type=code&owner=user&redirect_uri=${encodeURIComponent(this.redirectUri)}&state=${stateToken}`;
  }

  async handleCallback(code: string, state: string, error?: string): Promise<string> {
    // 1. Verify state parameter
    const stateData = this.verifyAndExtractState(state);
    if (!stateData) {
      return `${this.frontendUrl}/dashboard/settings?tab=integrations&notion=error&message=${encodeURIComponent('Invalid or expired state session')}`;
    }

    const userId = stateData.userId;

    if (error) {
      return `${this.frontendUrl}/dashboard/settings?tab=integrations&notion=error&message=${encodeURIComponent(error)}`;
    }

    try {
      const response = await fetch('https://api.notion.com/v1/oauth/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.redirectUri,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Notion token exchange failed: ${errorText}`);
      }

      const responseData = (await response.json()) as NotionOAuthTokenResponse;
      const { access_token, workspace_id, workspace_name, workspace_icon, bot_id } = responseData;

      const enc = this.encryption.encrypt(access_token);

      const existingConnection = await this.prisma.integrationConnection.findUnique({
        where: {
          userId_provider: {
            userId,
            provider: 'notion',
          },
        },
      });
      const status = existingConnection ? 'updated' : 'connected';

      await this.prisma.integrationConnection.upsert({
        where: {
          userId_provider: {
            userId,
            provider: 'notion',
          },
        },
        create: {
          userId,
          provider: 'notion',
          workspaceId: workspace_id,
          workspaceName: workspace_name || 'Notion Workspace',
          workspaceIcon: workspace_icon || null,
          botId: bot_id || null,
          accessTokenCiphertext: new Uint8Array(enc.ciphertext),
          accessTokenIv: new Uint8Array(enc.iv),
          accessTokenAuthTag: new Uint8Array(enc.authTag),
          accessTokenKeyVersion: enc.keyVersion,
        },
        update: {
          workspaceName: workspace_name || 'Notion Workspace',
          workspaceIcon: workspace_icon || null,
          botId: bot_id || null,
          accessTokenCiphertext: new Uint8Array(enc.ciphertext),
          accessTokenIv: new Uint8Array(enc.iv),
          accessTokenAuthTag: new Uint8Array(enc.authTag),
          accessTokenKeyVersion: enc.keyVersion,
        },
      });

      // Synchronously build hot page index before frontend redirect.
      await this.refreshPageIndex(userId);

      return `${this.frontendUrl}/dashboard/settings?tab=integrations&notion=${status}`;
    } catch (err: any) {
      this.logger.error('[NotionIntegration] handleCallback error:', err.message);
      return `${this.frontendUrl}/dashboard/settings?tab=integrations&notion=error&message=${encodeURIComponent('Notion declined the connection. Please try again or contact support.')}`;
    }
  }

  async getStatus(userId: string): Promise<NotionStatusDto> {
    const connection = await this.prisma.integrationConnection.findUnique({
      where: {
        userId_provider: {
          userId,
          provider: 'notion',
        },
      },
    });

    if (!connection) {
      return { connected: false, workspaceName: null, workspaceIcon: null, connectedAt: null };
    }

    return {
      connected: true,
      workspaceName: connection.workspaceName,
      workspaceIcon: connection.workspaceIcon,
      connectedAt: connection.createdAt.toISOString(),
    };
  }

  async disconnect(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.notionPageIndex.deleteMany({
        where: { userId },
      }),
      this.prisma.integrationConnection.deleteMany({
        where: { userId, provider: 'notion' },
      }),
    ]);
  }

  async getDecryptedToken(userId: string): Promise<string> {
    const connection = await this.prisma.integrationConnection.findUnique({
      where: {
        userId_provider: {
          userId,
          provider: 'notion',
        },
      },
    });
    if (!connection) {
      throw new NotFoundException('Notion connection not found');
    }
    return this.encryption.decrypt({
      ciphertext: Buffer.from(connection.accessTokenCiphertext),
      iv: Buffer.from(connection.accessTokenIv),
      authTag: Buffer.from(connection.accessTokenAuthTag),
      keyVersion: connection.accessTokenKeyVersion,
    });
  }



  private getNotionClient(accessToken: string): NotionClient {
    return new NotionClient({ auth: accessToken });
  }

  // Extract plain text from Notion rich_text array.
  private extractPlainText(richText: RichTextItemResponse[]): string {
    return richText.map((rt) => rt.plain_text).join('');
  }

  // Extract title from search result.
  private getTitleFromSearchResult(
    result: PageObjectResponse | DatabaseObjectResponse,
  ): string {
    if (result.object === 'database') {
      const db = result as DatabaseObjectResponse;
      return this.extractPlainText(db.title);
    }
    const page = result as PageObjectResponse;
    // Find and extract title property.
    for (const prop of Object.values(page.properties)) {
      if (prop.type === 'title') {
        return this.extractPlainText(prop.title);
      }
    }
    return 'Untitled';
  }

  private handleNotionError(err: any): never {
    const status = err?.status;
    const message = err?.message || 'Notion API error';

    if (status === 404) {
      throw new NotFoundException(`Notion resource not found: ${message}`);
    }
    if (status === 401 || status === 403) {
      throw new ForbiddenException(`Notion authorization failed: ${message}`);
    }
    if (status === 429) {
      throw new HttpException('Notion rate limit exceeded. Please try again later.', 429);
    }
    throw err;
  }

  async getAccessiblePages(userId: string): Promise<NotionPageDto[]> {
    try {
      const token = await this.getDecryptedToken(userId);
      const notion = this.getNotionClient(token);

      const standalonePagesResults: any[] = [];
      const explicitDatabases: any[] = [];
      const databaseIdsToFetch = new Set<string>();
      let cursor: string | undefined;

      do {
        const res = await notion.search({
          ...(cursor ? { start_cursor: cursor } : {}),
          page_size: 100,
          sort: { direction: 'descending', timestamp: 'last_edited_time' },
        });

        for (const item of res.results) {
          const obj = item.object as string;
          if (obj === 'database') {
            explicitDatabases.push(item);
          } else if (obj === 'page') {
            const page = item as any;
            const parentType = page.parent?.type;
            if (parentType === 'workspace' || parentType === 'page_id') {
              standalonePagesResults.push(page);
            } else if (parentType === 'data_source_id' || parentType === 'database_id') {
              const dbId = page.parent.database_id;
              if (dbId) {
                databaseIdsToFetch.add(dbId);
              }
            }
          }
        }
        cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
      } while (cursor);

      // Avoid duplicate database queries for databases already returned in explicitDatabases
      const explicitDbIds = new Set(explicitDatabases.map((db) => db.id));
      const filteredDbIdsToFetch = Array.from(databaseIdsToFetch).filter(
        (id) => !explicitDbIds.has(id),
      );

      let fetchedDatabases: any[] = [];
      if (filteredDbIdsToFetch.length > 0) {
        try {
          fetchedDatabases = await Promise.all(
            filteredDbIdsToFetch.map((dbId) =>
              notion.databases.retrieve({ database_id: dbId }),
            ),
          );
        } catch (err) {
          this.handleNotionError(err);
        }
      }

      const allResults = [
        ...standalonePagesResults,
        ...explicitDatabases,
        ...fetchedDatabases,
      ];

      return allResults.map((r) => ({
        notionPageId: r.id,
        title: this.getTitleFromSearchResult(r),
        pageType: r.object as 'page' | 'database',
      }));
    } catch (err) {
      this.handleNotionError(err);
    }
  }

  async getPageIndex(userId: string): Promise<NotionPageIndexDto> {
    const rows = await this.prisma.notionPageIndex.findMany({
      where: { userId },
      orderBy: { indexedAt: 'desc' },
    });

    const mostRecent = rows[0];
    const isStale =
      rows.length === 0 ||
      Date.now() - mostRecent.indexedAt.getTime() > this.INDEX_STALE_MS;

    if (isStale) {
      // Async background rebuild to prevent blocking the query.
      this.refreshPageIndex(userId).catch((err) =>
        this.logger.error(`[NotionPageIndex] background refresh failed for user ${userId}: ${err?.message}`, err?.stack)
      );
    }

    const items: NotionPageIndexItemDto[] = rows.map((r) => ({
      notionPageId: r.notionPageId,
      title: r.title,
      pageType: r.pageType as 'page' | 'database',
      indexedAt: r.indexedAt.toISOString(),
    }));

    return { items, stale: isStale };
  }

  async refreshPageIndex(userId: string): Promise<void> {
    try {
      const pages = await this.getAccessiblePages(userId);

      await this.prisma.$transaction([
        this.prisma.notionPageIndex.deleteMany({ where: { userId } }),
        this.prisma.notionPageIndex.createMany({
          data: pages.map((p) => ({
            userId,
            notionPageId: p.notionPageId,
            title: p.title,
            pageType: p.pageType,
          })),
        }),
      ]);
    } catch (err: any) {
      this.logger.error(
        `[NotionPageIndex] failed to refresh index for user ${userId}: ${err?.message}`,
        err?.stack,
      );
      throw err;
    }
  }

  // Map Notion block to standard DTO.
  private mapBlock(block: BlockObjectResponse): NotionBlockDto {
    const type = block.type;
    const blockData = (block as any)[type];
    const richText: RichTextItemResponse[] = blockData?.rich_text ?? [];
    const text = this.extractPlainText(richText);

    return { id: block.id, type, text };
  }

  // Cap recursion at depth 3 to avoid latency spikes.
  private async fetchBlockChildrenRecursive(
    notion: NotionClient,
    blockId: string,
    currentDepth: number,
  ): Promise<NotionBlockDto[]> {
    const blocks: NotionBlockDto[] = [];
    let cursor: string | undefined;

    do {
      const res = await notion.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });

      for (const block of res.results) {
        if ('type' in block) {
          const fullBlock = block as BlockObjectResponse;
          const mapped = this.mapBlock(fullBlock);

          if (fullBlock.has_children && currentDepth < 3) {
            mapped.children = await this.fetchBlockChildrenRecursive(
              notion,
              fullBlock.id,
              currentDepth + 1,
            );
          }
          blocks.push(mapped);
        }
      }
      cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    } while (cursor);

    return blocks;
  }

  async getPageContent(userId: string, pageId: string): Promise<NotionPageContentDto> {
    try {
      const token = await this.getDecryptedToken(userId);
      const notion = this.getNotionClient(token);

      let page: PageObjectResponse | null = null;
      let isDatabase = false;

      try {
        page = await notion.pages.retrieve({ page_id: pageId }) as PageObjectResponse;
      } catch (err: any) {
        if (err.status === 400 && err.message?.includes('is a database')) {
          isDatabase = true;
        } else {
          throw err;
        }
      }

      if (isDatabase) {
        const db = await notion.databases.retrieve({ database_id: pageId }) as DatabaseObjectResponse;
        const title = this.getTitleFromSearchResult(db);

        const dataSourceId = (db as any).data_sources?.[0]?.id;
        let pages: any[] = [];

        if (dataSourceId) {
          let cursor: string | undefined;
          do {
            const queryResult = await notion.dataSources.query({
              data_source_id: dataSourceId,
              page_size: 100,
              ...(cursor ? { start_cursor: cursor } : {}),
            });
            for (const r of queryResult.results) {
              pages.push({
                notionPageId: r.id,
                title: this.getTitleFromSearchResult(r as any),
              });
            }
            cursor = queryResult.has_more ? (queryResult.next_cursor ?? undefined) : undefined;
          } while (cursor);
        }

        return {
          contentType: 'database',
          pageId,
          title,
          pages,
        };
      }

      const title = this.getTitleFromSearchResult(page!);
      const blocks = await this.fetchBlockChildrenRecursive(notion, pageId, 1);

      return {
        contentType: 'page',
        pageId,
        title,
        blocks,
      };
    } catch (err) {
      this.handleNotionError(err);
    }
  }
}
