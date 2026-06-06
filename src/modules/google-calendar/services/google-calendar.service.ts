import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../../prisma/prisma.service';
import { EncryptionService } from '../../../shared/services/encryption.service';
import { SaveSelectionsDto } from '../dto/google-calendar.dto';
import { CalendarSyncService } from './calendar-sync.service';
import { errMessage, GoogleApiService } from './google-api.service';

const PROVIDER = 'google';
const STATE_PURPOSE = 'google_oauth';
const STATE_TTL = '10m';

@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly googleApi: GoogleApiService,
    private readonly sync: CalendarSyncService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  // --- connect ---

  // Signs a short-lived state JWT carrying the userId, since the OAuth
  // callback arrives without an Authorization header.
  getConsentUrl(userId: string): string {
    const state = this.jwt.sign(
      { sub: userId, purpose: STATE_PURPOSE },
      { expiresIn: STATE_TTL },
    );
    return this.googleApi.buildConsentUrl(state);
  }

  // Handles the OAuth return. Returns the web URL to redirect the browser to.
  // Never throws to the browser — failures resolve to ?google=error so the
  // user lands back on Settings with a toast instead of a stack trace.
  async handleCallback(code?: string, state?: string): Promise<string> {
    const frontendUrl = this.config.getOrThrow<string>('CORS_ORIGIN');
    const ok = `${frontendUrl}/dashboard/settings?tab=integrations&google=connected`;
    const fail = (reason?: string) =>
      `${frontendUrl}/dashboard/settings?tab=integrations&google=error${reason ? `&reason=${reason}` : ''}`;

    if (!code || !state) return fail();

    let userId: string;
    try {
      const payload = this.jwt.verify(state);
      if (payload.purpose !== STATE_PURPOSE || !payload.sub) return fail();
      userId = payload.sub;
    } catch {
      return fail();
    }

    try {
      const { tokens, email } = await this.googleApi.exchangeCode(code);

      // One Google account per user (enforced at the API per maintainer).
      const existing = await this.prisma.calendarConnection.findFirst({
        where: { userId, provider: PROVIDER },
      });
      if (existing && existing.accountEmail !== email) {
        return fail('already_connected');
      }

      const enc = this.encryption.encrypt(tokens.refreshToken);
      // Prisma v7 Bytes columns expect Uint8Array<ArrayBuffer>; Node Buffers
      // don't satisfy the stricter type, so copy into fresh Uint8Arrays
      // (same approach as coach-byok).
      const refreshCiphertext = new Uint8Array(enc.ciphertext);
      const refreshIv = new Uint8Array(enc.iv);
      const refreshAuthTag = new Uint8Array(enc.authTag);

      const connection = await this.prisma.calendarConnection.upsert({
        where: {
          userId_provider_accountEmail: { userId, provider: PROVIDER, accountEmail: email },
        },
        create: {
          userId,
          provider: PROVIDER,
          accountEmail: email,
          refreshCiphertext,
          refreshIv,
          refreshAuthTag,
          scopes: tokens.scopes,
          status: 'active',
        },
        update: {
          refreshCiphertext,
          refreshIv,
          refreshAuthTag,
          scopes: tokens.scopes,
          status: 'active',
        },
      });

      // First sync is fire-and-forget so the redirect is snappy.
      void this.sync.syncConnection(connection.id).catch((err) =>
        this.logger.error(`Initial sync failed: ${errMessage(err)}`),
      );

      return ok;
    } catch (err) {
      this.logger.error(`Google OAuth callback failed: ${errMessage(err)}`);
      return fail();
    }
  }

  // --- status ---

  async getConnectionStatus(userId: string) {
    const connection = await this.prisma.calendarConnection.findFirst({
      where: { userId, provider: PROVIDER },
      include: { selections: true },
    });

    if (!connection) {
      return { connected: false, accountEmail: null, status: null };
    }

    return {
      connected: true,
      accountEmail: connection.accountEmail,
      status: connection.status,
      scopes: connection.scopes,
      selections: connection.selections.map((s) => ({
        externalCalId: s.externalCalId,
        displayName: s.displayName,
        color: s.color,
        syncDirection: s.syncDirection,
      })),
    };
  }

  // --- calendars (picker) ---

  async listCalendars(userId: string) {
    const connection = await this.getActiveConnectionOrThrow(userId);
    const client = this.googleApi.clientFromRefreshToken(
      this.decryptRefresh(connection),
    );
    const calendars = await this.googleApi.listCalendars(client);
    return calendars.map((c) => ({
      id: c.id,
      name: c.summaryOverride ?? c.summary ?? c.id,
      color: c.backgroundColor ?? null,
      primary: c.primary ?? false,
    }));
  }

  // --- selections ---

  // Replace the selection set: upsert the provided calendars (preserving any
  // existing syncToken so we don't force a full re-pull), drop the rest.
  async saveSelections(userId: string, dto: SaveSelectionsDto) {
    const connection = await this.getActiveConnectionOrThrow(userId);
    const keepIds = dto.selections.map((s) => s.externalCalId);

    await this.prisma.calendarSelection.deleteMany({
      where: { connectionId: connection.id, externalCalId: { notIn: keepIds.length ? keepIds : ['__none__'] } },
    });

    for (const s of dto.selections) {
      await this.prisma.calendarSelection.upsert({
        where: {
          connectionId_externalCalId: {
            connectionId: connection.id,
            externalCalId: s.externalCalId,
          },
        },
        create: {
          connectionId: connection.id,
          externalCalId: s.externalCalId,
          displayName: s.displayName,
          color: s.color,
          syncDirection: s.syncDirection,
        },
        update: {
          displayName: s.displayName,
          color: s.color,
          syncDirection: s.syncDirection,
        },
      });
    }

    // Pull events for any newly added calendars without blocking the response.
    void this.sync.syncConnection(connection.id).catch((err) =>
      this.logger.error(`Post-selection sync failed: ${errMessage(err)}`),
    );

    return { success: true };
  }

  // --- manual sync ---

  async triggerSync(userId: string) {
    const connection = await this.getActiveConnectionOrThrow(userId);
    await this.sync.syncConnection(connection.id);
    return { success: true };
  }

  // --- events (grid overlay) ---

  async getEvents(userId: string, from: string, to: string) {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      throw new BadRequestException('Invalid from/to date');
    }

    const connection = await this.prisma.calendarConnection.findFirst({
      where: { userId, provider: PROVIDER },
      include: { selections: true },
    });
    if (!connection) return [];

    const nameByCal = new Map(
      connection.selections.map((s) => [s.externalCalId, { name: s.displayName, color: s.color }]),
    );

    const events = await this.prisma.externalEvent.findMany({
      where: {
        userId,
        connectionId: connection.id,
        status: { not: 'cancelled' },
        // Overlap with the visible window.
        startsAt: { lt: toDate },
        endsAt: { gt: fromDate },
      },
      orderBy: { startsAt: 'asc' },
    });

    return events.map((e) => {
      const cal = nameByCal.get(e.externalCalId);
      return {
        id: e.id,
        title: e.title,
        startsAt: e.startsAt.toISOString(),
        endsAt: e.endsAt.toISOString(),
        isAllDay: e.isAllDay,
        status: e.status,
        calendarName: cal?.name ?? 'Google Calendar',
        color: cal?.color ?? null,
      };
    });
  }

  // --- disconnect ---

  async disconnect(userId: string) {
    const connection = await this.prisma.calendarConnection.findFirst({
      where: { userId, provider: PROVIDER },
    });
    if (!connection) return { success: true };

    // Best-effort revoke at Google; local cascade delete proceeds regardless.
    await this.googleApi.revoke(this.decryptRefresh(connection));
    await this.prisma.calendarConnection.delete({ where: { id: connection.id } });
    return { success: true };
  }

  // --- helpers ---

  private async getActiveConnectionOrThrow(userId: string) {
    const connection = await this.prisma.calendarConnection.findFirst({
      where: { userId, provider: PROVIDER },
    });
    if (!connection) throw new NotFoundException('No Google Calendar connected');
    if (connection.status !== 'active') {
      throw new BadRequestException('Google Calendar connection needs to be reconnected');
    }
    return connection;
  }

  // Prisma v7 returns Bytes as Uint8Array; EncryptionService wants Buffers.
  private decryptRefresh(connection: {
    refreshCiphertext: Uint8Array;
    refreshIv: Uint8Array;
    refreshAuthTag: Uint8Array;
  }): string {
    return this.encryption.decrypt({
      ciphertext: Buffer.from(connection.refreshCiphertext),
      iv: Buffer.from(connection.refreshIv),
      authTag: Buffer.from(connection.refreshAuthTag),
    });
  }
}
