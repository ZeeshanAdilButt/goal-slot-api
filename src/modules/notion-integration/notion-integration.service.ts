import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../shared/services/encryption.service';
import { NotionStatusDto } from './dto/notion-status.dto';
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
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly frontendUrl: string;
  private readonly integrationStateSecret: string;

  private readonly STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
  ) {
    this.clientId = this.config.getOrThrow<string>('NOTION_CLIENT_ID');
    this.clientSecret = this.config.getOrThrow<string>('NOTION_CLIENT_SECRET');
    this.redirectUri = this.config.getOrThrow<string>('NOTION_REDIRECT_URI');
    // Use a dedicated key for signing OAuth state tokens so JWT secret rotation
    // does not invalidate pending Notion connect flows. Falls back to JWT_SECRET
    // if INTEGRATION_STATE_SECRET is not set (keeps existing dev envs working).
    this.integrationStateSecret =
      this.config.get<string>('INTEGRATION_STATE_SECRET') ??
      this.config.getOrThrow<string>('JWT_SECRET');

    // SINGLE-ORIGIN NOTE: picks the first origin from CORS_ORIGIN for OAuth redirects.
    // If production ever has multiple origins, introduce a dedicated FRONTEND_URL env var.
    const corsOrigin = this.config.getOrThrow<string>('CORS_ORIGIN');
    this.frontendUrl = corsOrigin.split(',')[0].trim();
  }

  getFrontendUrl(): string {
    return this.frontendUrl;
  }

  // Generates a signed OAuth state token (HMAC-SHA256 + expiry).
  // The HMAC + expiry is sufficient for forgery protection; no nonce is needed
  // unless we add a single-use check (a future concern for higher-sensitivity providers).
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

  // Helper to verify signed state token and extract payload
  private verifyAndExtractState(state: string): { userId: string } | null {
    try {
      const parts = state.split('.');
      if (parts.length !== 2) return null;
      const [payloadB64, signature] = parts;
      
      // Verify signature
      const expectedSignature = crypto
        .createHmac('sha256', this.integrationStateSecret)
        .update(payloadB64)
        .digest('base64url');
      if (signature !== expectedSignature) return null;

      // Parse payload
      const payloadStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
      const { userId, expiresAt } = JSON.parse(payloadStr);

      if (typeof userId !== 'string' || typeof expiresAt !== 'number') return null;
      if (expiresAt < Date.now()) return null;

      return { userId };
    } catch {
      return null;
    }
  }

  getAuthorizationUrl(userId: string): string {
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
      // 2. Exchange code for token using native fetch
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

      // 3. Encrypt access token
      const enc = this.encryption.encrypt(access_token);

      // 4. Save connection
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
        },
        update: {
          workspaceName: workspace_name || 'Notion Workspace',
          workspaceIcon: workspace_icon || null,
          botId: bot_id || null,
          accessTokenCiphertext: new Uint8Array(enc.ciphertext),
          accessTokenIv: new Uint8Array(enc.iv),
          accessTokenAuthTag: new Uint8Array(enc.authTag),
        },
      });

      return `${this.frontendUrl}/dashboard/settings?tab=integrations&notion=connected`;
    } catch (err: any) {
      console.error('[NotionIntegration] handleCallback error:', err.message);
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
    // Idempotent: deleteMany is a no-op when no record exists, so clicking
    // disconnect twice (or after an already-disconnected state) is always safe.
    // Cascades to NotionTarget entries via schema `onDelete: Cascade`.
    await this.prisma.integrationConnection.deleteMany({
      where: { userId, provider: 'notion' },
    });
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

}
