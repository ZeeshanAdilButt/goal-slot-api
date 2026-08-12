import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { SupabaseService } from '../../supabase/supabase.service';

export interface HealthCheckResult {
  status: 'ok' | 'degraded' | 'down';
  timestamp: string;
  checks: {
    database: { ok: boolean; latencyMs: number };
    supabase: { ok: boolean; configured: boolean };
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
          ok: true,
          configured: false,
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
   *
   * Public so the readiness endpoint can call it directly. Readiness must not
   * go through getDetailedHealth(), whose 10-second cache would let a probe
   * pass on a result gathered before the process under test even started.
   */
  async checkDatabase(): Promise<{
    ok: boolean;
    latencyMs: number;
  }> {
    const startTime = Date.now();
    try {
      // Prisma does not cancel the underlying query when this timeout wins;
      // the DB connection is released only after the query eventually returns.
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Database check timeout')), 2000),
      );

      await Promise.race([this.prisma.$queryRaw`SELECT 1`, timeoutPromise]);

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
   * Check Supabase configuration and, only if it looks like a real project,
   * API connectivity without depending on application tables.
   *
   * Production runs on Neon now; SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are
   * still required at boot (see env.validation.ts) purely because
   * SupabaseService.verifySSOToken backs SSO login, but the deployed .env
   * carries a localhost placeholder for them until a real Supabase project
   * is wired up for SSO. Dialing that placeholder hits our own reverse
   * proxy and always fails, so treat it the same way checkResend/
   * checkGeminiShared treat a missing key: not configured, not a failure.
   */
  private async checkSupabase(): Promise<{
    ok: boolean;
    configured: boolean;
  }> {
    const url = this.configService.get<string>('SUPABASE_URL');
    const serviceRoleKey = this.configService.get<string>(
      'SUPABASE_SERVICE_ROLE_KEY',
    );
    const configured = this.isSupabaseConfigured(url, serviceRoleKey);

    if (!configured) {
      this.logger.debug(
        'Supabase is not configured with real project credentials (placeholder), skipping connectivity check',
      );
      return { ok: true, configured: false };
    }

    const result = await this.supabase.checkConnectivity();

    if (result.ok) {
      this.logger.debug(`Supabase check passed in ${result.latencyMs}ms`);
    } else {
      this.logger.warn(`Supabase check failed after ${result.latencyMs}ms`);
    }

    return { ok: result.ok, configured: true };
  }

  /**
   * Mirrors the configured-detection pattern used by checkResend/
   * checkGeminiShared (non-empty value = configured), plus a check for the
   * known localhost placeholder that satisfies Joi's required() validation
   * without pointing at a real Supabase project.
   */
  private isSupabaseConfigured(
    url: string | undefined,
    serviceRoleKey: string | undefined,
  ): boolean {
    if (!url || !serviceRoleKey) {
      return false;
    }

    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return false;
    }

    const isPlaceholderHost =
      hostname === 'localhost' || hostname === '127.0.0.1';

    return !isPlaceholderHost;
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
   * - 'ok': database passes, AND Supabase and email (Resend) are configured/reachable
   * - 'degraded': database passes, BUT Supabase and/or email is missing/unreachable
   * - 'down': database failed
   *
   * Database is the only dependency that can take the whole report down.
   * Supabase currently only backs SSO login (see SupabaseService.verifySSOToken)
   * and production doesn't have a real project wired up for it yet, so an
   * unconfigured or unreachable Supabase degrades the report instead of
   * paging anyone.
   */
  private calculateStatus(
    databaseCheck: { ok: boolean },
    supabaseCheck: { ok: boolean; configured: boolean },
    resendCheck: { ok: boolean; configured: boolean },
  ): 'ok' | 'degraded' | 'down' {
    // If the critical dependency fails, status is 'down'
    if (!databaseCheck.ok) {
      return 'down';
    }

    // Non-critical dependencies missing or unreachable degrade the report
    if (!supabaseCheck.configured || !supabaseCheck.ok || !resendCheck.configured) {
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
