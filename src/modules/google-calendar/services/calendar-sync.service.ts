import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { calendar_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { PrismaService } from '../../../prisma/prisma.service';
import { EncryptionService } from '../../../shared/services/encryption.service';
import {
  errMessage,
  GoogleApiService,
  isGoneError,
  isInvalidGrant,
} from './google-api.service';

// Bound a full re-pull (first sync, or after a 410) to a sensible window so we
// don't drag a decade of history onto the grid.
const FULL_SYNC_WINDOW_DAYS = 90;

@Injectable()
export class CalendarSyncService {
  private readonly logger = new Logger(CalendarSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly googleApi: GoogleApiService,
  ) {}

  // 5-minute cron over every active connection. In-process (no queue infra in
  // this codebase yet); per-user quota is 1000 req/100s so this cadence is far
  // under. Errors are isolated per connection so one bad grant can't stall the
  // rest.
  @Cron('*/5 * * * *')
  async syncAllActive(): Promise<void> {
    if (!this.googleApi.isConfigured) return;
    const connections = await this.prisma.calendarConnection.findMany({
      where: { status: 'active' },
      select: { id: true },
    });
    for (const { id } of connections) {
      try {
        await this.syncConnection(id);
      } catch (err) {
        this.logger.error(`Cron sync failed for connection ${id}: ${errMessage(err)}`);
      }
    }
  }

  // Pull every inbound selection on a connection. Marks the connection stale
  // on invalid_grant instead of throwing, so the cron keeps moving.
  async syncConnection(connectionId: string): Promise<void> {
    const connection = await this.prisma.calendarConnection.findUnique({
      where: { id: connectionId },
      include: { selections: true },
    });
    if (!connection || connection.status !== 'active') return;

    // Prisma v7 returns Bytes columns as Uint8Array; EncryptionService wants
    // Node Buffers, so wrap on the way out (mirrors coach-ai's decrypt path).
    const refreshToken = this.encryption.decrypt({
      ciphertext: Buffer.from(connection.refreshCiphertext),
      iv: Buffer.from(connection.refreshIv),
      authTag: Buffer.from(connection.refreshAuthTag),
    });
    const client = this.googleApi.clientFromRefreshToken(refreshToken);

    const inbound = connection.selections.filter(
      (s) => s.syncDirection === 'in' || s.syncDirection === 'both',
    );

    for (const selection of inbound) {
      try {
        await this.syncSelection(connection.userId, connectionId, selection, client);
      } catch (err) {
        if (isInvalidGrant(err)) {
          await this.markStale(connectionId);
          return;
        }
        this.logger.error(
          `Sync failed for calendar ${selection.externalCalId}: ${errMessage(err)}`,
        );
      }
    }
  }

  private async syncSelection(
    userId: string,
    connectionId: string,
    selection: { id: string; externalCalId: string; syncToken: string | null },
    client: OAuth2Client,
  ): Promise<void> {
    let syncToken = selection.syncToken ?? undefined;
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;

    const { timeMin, timeMax } = this.fullSyncWindow();

    do {
      let page: calendar_v3.Schema$Events;
      try {
        page = await this.googleApi.listEventsPage(client, {
          calendarId: selection.externalCalId,
          syncToken,
          pageToken,
          timeMin,
          timeMax,
        });
      } catch (err) {
        if (isGoneError(err)) {
          // Expired token: clear it and restart this calendar with a full pull.
          await this.prisma.calendarSelection.update({
            where: { id: selection.id },
            data: { syncToken: null },
          });
          syncToken = undefined;
          pageToken = undefined;
          continue;
        }
        throw err;
      }

      for (const event of page.items ?? []) {
        await this.upsertEvent(userId, connectionId, selection.externalCalId, event);
      }

      pageToken = page.nextPageToken ?? undefined;
      nextSyncToken = page.nextSyncToken ?? nextSyncToken;
    } while (pageToken);

    if (nextSyncToken) {
      await this.prisma.calendarSelection.update({
        where: { id: selection.id },
        data: { syncToken: nextSyncToken },
      });
    }
  }

  private async upsertEvent(
    userId: string,
    connectionId: string,
    externalCalId: string,
    event: calendar_v3.Schema$Event,
  ): Promise<void> {
    if (!event.id) return;

    // Cancelled instances arrive on incremental syncs — delete the local row.
    if (event.status === 'cancelled') {
      await this.prisma.externalEvent.deleteMany({
        where: { connectionId, externalEventId: event.id },
      });
      return;
    }

    const isAllDay = Boolean(event.start?.date);
    const startsAt = this.eventInstant(event.start);
    const endsAt = this.eventInstant(event.end);
    if (!startsAt || !endsAt) return;

    const data = {
      userId,
      connectionId,
      externalCalId,
      externalEventId: event.id,
      title: event.summary ?? '(No title)',
      startsAt,
      endsAt,
      isAllDay,
      status: event.status ?? 'confirmed',
      raw: event as unknown as Prisma.InputJsonValue,
    };

    await this.prisma.externalEvent.upsert({
      where: { connectionId_externalEventId: { connectionId, externalEventId: event.id } },
      create: data,
      update: data,
    });
  }

  // All-day events carry `date` (midnight, calendar-local); timed events carry
  // `dateTime` with an offset that Date parses correctly.
  private eventInstant(
    point: calendar_v3.Schema$EventDateTime | undefined,
  ): Date | null {
    if (!point) return null;
    if (point.dateTime) return new Date(point.dateTime);
    if (point.date) return new Date(`${point.date}T00:00:00`);
    return null;
  }

  private fullSyncWindow(): { timeMin: string; timeMax: string } {
    const now = new Date();
    const min = new Date(now);
    min.setDate(min.getDate() - FULL_SYNC_WINDOW_DAYS);
    const max = new Date(now);
    max.setDate(max.getDate() + FULL_SYNC_WINDOW_DAYS);
    return { timeMin: min.toISOString(), timeMax: max.toISOString() };
  }

  private async markStale(connectionId: string): Promise<void> {
    await this.prisma.calendarConnection.update({
      where: { id: connectionId },
      data: { status: 'stale' },
    });
    this.logger.warn(`Connection ${connectionId} marked stale (invalid_grant)`);
  }
}
