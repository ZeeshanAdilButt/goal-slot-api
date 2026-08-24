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
import { ScheduleService } from '../../schedule/schedule.service';
import { resolveFrontendUrl } from '../../auth/google-oauth.config';
import {
  ImportEventDto,
  ImportEventsDto,
  PreviewEventsQueryDto,
} from '../dto/google-calendar.dto';
import {
  buildCandidates,
  ImportCandidate,
  normalizeTimeZone,
  overlaps,
} from '../utils/event-mapping';
import {
  errMessage,
  GoogleCalendarApiService,
  GoogleGrantRevokedError,
} from './google-calendar-api.service';

const PROVIDER = 'google';
const STATE_PURPOSE = 'google_calendar_oauth';
const STATE_TTL = '10m';

/**
 * Calendar imports land in the Meeting category by default — it is one of the
 * default categories every user gets (categories.service.ts) and it is what a
 * Google Calendar entry usually is. The review screen can override it.
 */
const DEFAULT_CATEGORY = 'MEETING';
const DEFAULT_COLOR = '#8B5CF6';

/** Refuse to walk more than a quarter of a year in one preview. */
const MAX_PREVIEW_WINDOW_DAYS = 92;

export interface PreviewCandidate extends ImportCandidate {
  /**
   * Already sitting in ImportedCalendarEvent, so the block exists. Rendered as
   * a badge and unticked by default — re-importing would just collide with the
   * block the last import created.
   */
  alreadyImported: boolean;
  /** Title of an existing block this would overlap, if any. */
  conflictsWith: string | null;
}

export type ImportOutcome = 'imported' | 'skipped' | 'conflict' | 'error';

export interface ImportResultItem {
  externalEventId: string;
  title: string;
  status: ImportOutcome;
  scheduleBlockId?: string;
  message?: string;
}

@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly googleApi: GoogleCalendarApiService,
    private readonly schedule: ScheduleService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  // --- connect ---

  /**
   * The OAuth callback arrives as a bare browser redirect with no
   * Authorization header, so the caller's identity has to survive the round
   * trip through Google. It rides in `state` as a short-lived JWT signed with
   * the app's own secret — which also makes `state` do its actual job of
   * defeating CSRF, since an attacker cannot mint one.
   */
  getConsentUrl(userId: string): string {
    const state = this.jwt.sign(
      { sub: userId, purpose: STATE_PURPOSE },
      { expiresIn: STATE_TTL },
    );
    return this.googleApi.buildConsentUrl(state);
  }

  /**
   * Returns the URL to redirect the browser to; never throws.
   *
   * A user who denied consent, or whose state expired, must land back on
   * Settings with a toast. Throwing here would render Nest's JSON error page
   * in the middle of an OAuth flow, stranding them on an API domain.
   */
  async handleCallback(
    code?: string,
    state?: string,
    error?: string,
  ): Promise<string> {
    // resolveFrontendUrl is shared with Google sign-in and reads FRONTEND_URL
    // with an APP_URL fallback. It is deliberately NOT CORS_ORIGIN: that
    // variable holds a comma-separated allow-list, so using it here would
    // build a redirect like "https://a.com,https://b.com/dashboard/..." on any
    // deployment that allows more than one origin.
    const frontendUrl = resolveFrontendUrl(this.config);
    const settings = `${frontendUrl}/dashboard/settings?tab=integrations`;
    const ok = `${settings}&google_calendar=connected`;
    const fail = (reason: string) =>
      `${settings}&google_calendar=error&reason=${encodeURIComponent(reason)}`;

    if (error) return fail(error === 'access_denied' ? 'denied' : 'oauth');
    if (!code || !state) return fail('missing_code');

    let userId: string;
    try {
      const payload = this.jwt.verify<{ sub?: string; purpose?: string }>(
        state,
      );
      // Checking `purpose` stops a JWT minted for some other flow — a session
      // access token, or the sign-in state — from being replayed here to bind
      // a Google account to whoever that token belongs to.
      if (payload.purpose !== STATE_PURPOSE || !payload.sub) {
        return fail('bad_state');
      }
      userId = payload.sub;
    } catch {
      return fail('bad_state');
    }

    try {
      const { tokens, email } = await this.googleApi.exchangeCode(code);
      const encrypted = this.encryption.encrypt(tokens.refreshToken);

      // Prisma types Bytes columns as Uint8Array while EncryptionService deals
      // in Node Buffers; copy across the boundary the same way coach-byok does.
      const refreshCiphertext = new Uint8Array(encrypted.ciphertext);
      const refreshIv = new Uint8Array(encrypted.iv);
      const refreshAuthTag = new Uint8Array(encrypted.authTag);

      await this.prisma.calendarConnection.upsert({
        where: { userId_provider: { userId, provider: PROVIDER } },
        create: {
          userId,
          provider: PROVIDER,
          accountEmail: email,
          refreshCiphertext,
          refreshIv,
          refreshAuthTag,
          keyVersion: encrypted.keyVersion,
          scopes: tokens.scopes,
          status: 'active',
        },
        // Reconnecting with a different Google account is allowed and simply
        // replaces the grant. ImportedCalendarEvent rows are keyed by
        // connection id, not account, so the "already imported" history stays
        // attached to the blocks it created rather than being orphaned.
        update: {
          accountEmail: email,
          refreshCiphertext,
          refreshIv,
          refreshAuthTag,
          keyVersion: encrypted.keyVersion,
          scopes: tokens.scopes,
          status: 'active',
        },
      });

      return ok;
    } catch (err) {
      // The message can contain fragments of Google's response; log it, but
      // hand the browser only a stable reason code.
      this.logger.error(`Google Calendar OAuth failed: ${errMessage(err)}`);
      return fail('exchange_failed');
    }
  }

  // --- status ---

  async getConnectionStatus(userId: string) {
    const connection = await this.prisma.calendarConnection.findUnique({
      where: { userId_provider: { userId, provider: PROVIDER } },
    });

    if (!connection) {
      return {
        available: this.googleApi.isConfigured,
        connected: false,
        accountEmail: null,
        status: null,
        importedCount: 0,
      };
    }

    const importedCount = await this.prisma.importedCalendarEvent.count({
      where: { connectionId: connection.id },
    });

    return {
      available: this.googleApi.isConfigured,
      connected: true,
      accountEmail: connection.accountEmail,
      status: connection.status,
      importedCount,
    };
  }

  // --- calendars ---

  async listCalendars(userId: string) {
    const { connection, accessToken } = await this.authorize(userId);
    try {
      return await this.googleApi.listCalendars(accessToken);
    } catch (err) {
      await this.handleGrantError(connection.id, err);
      throw err;
    }
  }

  // --- preview (the review step) ---

  /**
   * Reads straight from Google rather than from a local cache.
   *
   * The alternative — mirroring every event into a table on a cron and
   * previewing that — buys nothing here and costs a lot: a background job
   * holding a live OAuth grant for every user, a sync-token state machine, and
   * a review list that can be stale at the exact moment the user is deciding
   * what to import. A review screen is inherently interactive and infrequent,
   * so it can afford to ask Google directly and always show the truth.
   */
  async previewEvents(
    userId: string,
    query: PreviewEventsQueryDto,
  ): Promise<{ timeZone: string; candidates: PreviewCandidate[] }> {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Invalid from/to date');
    }
    if (to <= from) {
      throw new BadRequestException('`to` must be after `from`');
    }
    const windowDays = (to.getTime() - from.getTime()) / 86_400_000;
    if (windowDays > MAX_PREVIEW_WINDOW_DAYS) {
      throw new BadRequestException(
        `Preview window cannot exceed ${MAX_PREVIEW_WINDOW_DAYS} days`,
      );
    }

    const timeZone = normalizeTimeZone(query.timeZone);
    const { connection, accessToken } = await this.authorize(userId);

    let calendars: Awaited<
      ReturnType<GoogleCalendarApiService['listCalendars']>
    >;
    try {
      calendars = await this.googleApi.listCalendars(accessToken);
    } catch (err) {
      await this.handleGrantError(connection.id, err);
      throw err;
    }

    // Only ids the account actually has are accepted, so an arbitrary string
    // cannot be used to probe Google for calendars this user cannot read.
    const nameById = new Map(calendars.map((c) => [c.id, c.name]));
    const requested = query.calendarIds.filter((id) => nameById.has(id));
    if (requested.length === 0) {
      throw new BadRequestException(
        'None of the requested calendars are available on this Google account',
      );
    }

    const candidates: ImportCandidate[] = [];
    for (const calendarId of requested) {
      try {
        const events = await this.googleApi.listEvents(accessToken, {
          calendarId,
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
        });
        candidates.push(
          ...buildCandidates(events, {
            externalCalId: calendarId,
            calendarName: nameById.get(calendarId) ?? calendarId,
            timeZone,
          }),
        );
      } catch (err) {
        await this.handleGrantError(connection.id, err);
        if (err instanceof GoogleGrantRevokedError) throw err;
        // One unreadable calendar (deleted between listing and reading, a
        // sharing change mid-flight) must not empty the whole review list.
        this.logger.warn(`Skipping calendar ${calendarId}: ${errMessage(err)}`);
      }
    }

    const [imported, existingBlocks] = await Promise.all([
      this.prisma.importedCalendarEvent.findMany({
        where: { connectionId: connection.id },
        select: { externalEventId: true },
      }),
      this.prisma.scheduleBlock.findMany({
        where: { userId },
        select: {
          title: true,
          dayOfWeek: true,
          startTime: true,
          endTime: true,
        },
      }),
    ]);

    const importedIds = new Set(imported.map((row) => row.externalEventId));

    return {
      timeZone,
      candidates: candidates.map((candidate) => ({
        ...candidate,
        alreadyImported: importedIds.has(candidate.externalEventId),
        conflictsWith:
          existingBlocks.find(
            (block) =>
              block.dayOfWeek === candidate.dayOfWeek &&
              overlaps(block, candidate),
          )?.title ?? null,
      })),
    };
  }

  // --- import ---

  /**
   * Creates one ScheduleBlock per selected candidate, routed through
   * ScheduleService.create rather than writing rows directly.
   *
   * That routing is the important part. `create` is where plan limits are
   * enforced and where the serializable conflict guard lives; a bulk importer
   * that inserted straight through Prisma would be a way to overshoot a FREE
   * plan's schedule cap and to manufacture the overlapping blocks that guard
   * exists to prevent.
   *
   * Every event gets its own outcome instead of the batch failing as a unit:
   * one conflicting event out of forty should not discard the other
   * thirty-nine, and the user needs to see *which* ones did not land.
   */
  async importEvents(
    userId: string,
    dto: ImportEventsDto,
  ): Promise<{ imported: number; results: ImportResultItem[] }> {
    const connection = await this.getConnectionOrThrow(userId);

    const alreadyImported = new Set(
      (
        await this.prisma.importedCalendarEvent.findMany({
          where: {
            connectionId: connection.id,
            externalEventId: { in: dto.events.map((e) => e.externalEventId) },
          },
          select: { externalEventId: true },
        })
      ).map((row) => row.externalEventId),
    );

    const results: ImportResultItem[] = [];
    // Guards against the same event appearing twice in one payload, which the
    // per-request database check above cannot see.
    const seen = new Set<string>();

    for (const event of dto.events) {
      const result = await this.importOne(
        userId,
        connection.id,
        event,
        alreadyImported,
        seen,
      );
      results.push(result);
    }

    return {
      imported: results.filter((r) => r.status === 'imported').length,
      results,
    };
  }

  private async importOne(
    userId: string,
    connectionId: string,
    event: ImportEventDto,
    alreadyImported: Set<string>,
    seen: Set<string>,
  ): Promise<ImportResultItem> {
    const base = { externalEventId: event.externalEventId, title: event.title };

    if (
      seen.has(event.externalEventId) ||
      alreadyImported.has(event.externalEventId)
    ) {
      return { ...base, status: 'skipped', message: 'Already imported' };
    }
    seen.add(event.externalEventId);

    try {
      const block = await this.schedule.create(userId, {
        title: event.title,
        dayOfWeek: event.dayOfWeek,
        startTime: event.startTime,
        endTime: event.endTime,
        category: event.category?.trim() || DEFAULT_CATEGORY,
        color: event.color?.trim() || DEFAULT_COLOR,
        isRecurring: true,
      });

      // Written after the block exists so a failed create leaves no record
      // claiming the event was imported. `create` here rather than `upsert`:
      // the unique constraint is the backstop if two import requests race, and
      // the catch below turns that into a clean "already imported".
      await this.prisma.importedCalendarEvent.create({
        data: {
          connectionId,
          externalCalId: event.externalCalId,
          externalEventId: event.externalEventId,
          scheduleBlockId: block.id,
        },
      });

      return { ...base, status: 'imported', scheduleBlockId: block.id };
    } catch (err) {
      if (isUniqueViolation(err)) {
        return { ...base, status: 'skipped', message: 'Already imported' };
      }
      // ScheduleService signals an overlap with a BadRequestException, not a
      // ConflictException (see createWithConflictGuard), so the distinction has
      // to be made on the message. It is worth making: a conflict is an
      // expected, explainable outcome the review screen shows inline, whereas
      // an "error" row means something went wrong that the user cannot fix by
      // picking a different slot.
      const message = errMessage(err);
      if (message.includes('conflicts with an existing schedule block')) {
        return { ...base, status: 'conflict', message };
      }
      if (err instanceof BadRequestException) {
        // Plan limit reached, or a range the service rejected. A real answer
        // for this event rather than a bug, so it is not logged as noise.
        return { ...base, status: 'error', message };
      }
      this.logger.warn(
        `Import failed for event ${event.externalEventId}: ${message}`,
      );
      return { ...base, status: 'error', message };
    }
  }

  // --- disconnect ---

  /**
   * Removes the grant and the import history, but deliberately leaves the
   * imported ScheduleBlocks alone: once imported, a block is the user's own
   * schedule entry, not a mirror of Google. Deleting a user's schedule because
   * they detached an integration would be a nasty surprise.
   *
   * The consequence — re-importing after a disconnect can recreate a block the
   * user still has — is caught by the conflict guard, which reports it as a
   * conflict rather than duplicating.
   */
  async disconnect(userId: string) {
    const connection = await this.prisma.calendarConnection.findUnique({
      where: { userId_provider: { userId, provider: PROVIDER } },
    });
    if (!connection) return { success: true };

    try {
      await this.googleApi.revoke(this.decryptRefreshToken(connection));
    } catch (err) {
      this.logger.warn(`Revoke skipped: ${errMessage(err)}`);
    }

    await this.prisma.calendarConnection.delete({
      where: { id: connection.id },
    });
    return { success: true };
  }

  // --- helpers ---

  private async getConnectionOrThrow(userId: string) {
    const connection = await this.prisma.calendarConnection.findUnique({
      where: { userId_provider: { userId, provider: PROVIDER } },
    });
    if (!connection) {
      throw new NotFoundException('No Google Calendar connected');
    }
    return connection;
  }

  private async authorize(userId: string) {
    const connection = await this.getConnectionOrThrow(userId);
    try {
      const accessToken = await this.googleApi.getAccessToken(
        this.decryptRefreshToken(connection),
      );
      // A grant that starts working again (the user reconnected elsewhere)
      // clears the stale flag without needing a separate repair path.
      if (connection.status !== 'active') {
        await this.prisma.calendarConnection.update({
          where: { id: connection.id },
          data: { status: 'active' },
        });
      }
      return { connection, accessToken };
    } catch (err) {
      await this.handleGrantError(connection.id, err);
      throw err;
    }
  }

  /**
   * A revoked grant is permanent until the user reconnects, so it is recorded
   * on the connection. The Settings card reads `status` and shows a reconnect
   * prompt instead of letting every subsequent click fail the same way.
   */
  private async handleGrantError(connectionId: string, err: unknown) {
    if (!(err instanceof GoogleGrantRevokedError)) return;
    await this.prisma.calendarConnection.updateMany({
      where: { id: connectionId, status: { not: 'stale' } },
      data: { status: 'stale' },
    });
    this.logger.warn(`Connection ${connectionId} marked stale (grant revoked)`);
  }

  private decryptRefreshToken(connection: {
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

/** Prisma's unique-constraint code, without importing the client namespace. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === 'P2002';
}
