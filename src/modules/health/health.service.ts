import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { SupabaseService } from '../../supabase/supabase.service';

export interface HealthCheckResult {
  status: 'ok' | 'degraded' | 'down';
  timestamp: string;
  checks: {
    database: { ok: boolean; latencyMs: number };
    supabase: { ok: boolean; latencyMs: number };
    resend: { ok: boolean; configured: boolean };
    geminiShared: { ok: boolean; configured: boolean };
  };
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  // In-memory cache with TTL (10 seconds)
  private cachedResponse: HealthCheckResult | null = null;
  private cacheTimestamp: number = 0;
  private refreshPromise: Promise<HealthCheckResult> | null = null;
  private readonly CACHE_TTL_MS = 10000; // 10 seconds

  constructor(
    private prisma: PrismaService,
    private supabase: SupabaseService,
    private configService: ConfigService,
  ) {}

  /**
   * Get detailed health check with caching
   * Returns cached response if available and not expired
   */
  async getDetailedHealth(): Promise<HealthCheckResult> {
    const now = Date.now();

    // Return cached response if still valid
    if (this.cachedResponse && now - this.cacheTimestamp < this.CACHE_TTL_MS) {
      this.logger.debug(
        `Returning cached health check (${now - this.cacheTimestamp}ms old)`,
      );
      return this.cachedResponse;
    }

    if (this.refreshPromise) {
      this.logger.debug('Returning in-flight health check refresh');
      return this.refreshPromise;
    }

    this.refreshPromise = this.runHealthChecks().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  private async runHealthChecks(): Promise<HealthCheckResult> {
    this.logger.debug('Running fresh health checks');

    // Run all checks in parallel. Each check is isolated so one dependency
    // cannot crash the detailed health endpoint.
    const [databaseCheck, supabaseCheck, resendCheck, geminiCheck] =
      await Promise.all([
        this.safeCheck('database', () => this.checkDatabase(), {
          ok: false,
          latencyMs: 0,
        }),
        this.safeCheck('supabase', () => this.checkSupabase(), {
          ok: false,
          latencyMs: 0,
        }),
        this.safeCheck('resend', () => this.checkResend(), {
          ok: true,
          configured: false,
        }),
        this.safeCheck('geminiShared', () => this.checkGeminiShared(), {
          ok: true,
          configured: false,
        }),
      ]);

    // Determine overall status based on checks
    const status = this.calculateStatus(
      databaseCheck,
      supabaseCheck,
      resendCheck,
    );

    const result: HealthCheckResult = {
      status,
      timestamp: new Date().toISOString(),
      checks: {
        database: databaseCheck,
        supabase: supabaseCheck,
        resend: resendCheck,
        geminiShared: geminiCheck,
      },
    };

    // Cache the response
    this.cachedResponse = result;
    this.cacheTimestamp = Date.now();

    return result;
  }

  /**
   * Check database connectivity with 2-second timeout
   * Measures latency in milliseconds
   */
  private async checkDatabase(): Promise<{
    ok: boolean;
    latencyMs: number;
  }> {
    const startTime = Date.now();
    try {
      // Prisma does not cancel the underlying query when this timeout wins;
      // the DB connection is released only after the query eventually returns.
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Database check timeout')),
          2000,
        ),
      );

      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        timeoutPromise,
      ]);

      const latencyMs = Date.now() - startTime;
      this.logger.debug(`Database check passed in ${latencyMs}ms`);
      return { ok: true, latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      this.logger.warn(
        `Database check failed after ${latencyMs}ms: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: false, latencyMs };
    }
  }

  /**
   * Check Supabase API connectivity without depending on application tables.
   * Measures latency in milliseconds.
   */
  private async checkSupabase(): Promise<{
    ok: boolean;
    latencyMs: number;
  }> {
    const result = await this.supabase.checkConnectivity();

    if (result.ok) {
      this.logger.debug(`Supabase check passed in ${result.latencyMs}ms`);
    } else {
      this.logger.warn(`Supabase check failed after ${result.latencyMs}ms`);
    }

    return result;
  }

  /**
   * Check Resend API key configuration
   * Does NOT call Resend API (to avoid usage costs)
   */
  private async checkResend(): Promise<{ ok: boolean; configured: boolean }> {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    const configured = !!apiKey && apiKey.length > 0;

    if (configured) {
      this.logger.debug('Resend API key is configured');
    } else {
      this.logger.warn('Resend API key is not configured');
    }

    return { ok: true, configured };
  }

  /**
   * Check Gemini shared API key configuration
   * Missing key is not a failure (feature is optional)
   */
  private async checkGeminiShared(): Promise<{
    ok: boolean;
    configured: boolean;
  }> {
    const apiKey = this.configService.get<string>('GOOGLE_AI_SHARED_API_KEY');
    const configured = !!apiKey && apiKey.length > 0;

    if (configured) {
      this.logger.debug('Gemini shared API key is configured');
    } else {
      this.logger.debug('Gemini shared API key is not configured (optional)');
    }

    // Always ok: missing Gemini key is not a failure
    return { ok: true, configured };
  }

  /**
   * Calculate overall status based on health checks
   * - 'ok': database and supabase pass, AND email (Resend) is configured
   * - 'degraded': database and supabase pass, BUT email is missing
   * - 'down': database or supabase failed
   */
  private calculateStatus(
    databaseCheck: { ok: boolean },
    supabaseCheck: { ok: boolean },
    resendCheck: { ok: boolean; configured: boolean },
  ): 'ok' | 'degraded' | 'down' {
    // If critical dependencies fail, status is 'down'
    if (!databaseCheck.ok || !supabaseCheck.ok) {
      return 'down';
    }

    // If critical dependencies pass but email is not configured, status is 'degraded'
    if (!resendCheck.configured) {
      return 'degraded';
    }

    // All checks passed
    return 'ok';
  }

  private async safeCheck<T>(
    name: string,
    check: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await check();
    } catch (error) {
      this.logger.warn(
        `${name} health check crashed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return fallback;
    }
  }
}

