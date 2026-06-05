import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

type FetchFailureCause = {
  code?: string;
  hostname?: string;
  syscall?: string;
  message?: string;
};

@Injectable()
export class SupabaseService {
  private readonly logger = new Logger(SupabaseService.name);
  private supabase: SupabaseClient;
  private readonly supabaseUrl: string;
  private readonly serviceRoleKey: string;

  constructor(private configService: ConfigService) {
    this.supabaseUrl = this.configService
      .getOrThrow<string>('SUPABASE_URL')
      .trim()
      .replace(/\/+$/, '');
    this.serviceRoleKey = this.configService
      .getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY')
      .trim();

    this.supabase = createClient(this.supabaseUrl, this.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  getClient(): SupabaseClient {
    return this.supabase;
  }

  async checkConnectivity(timeoutMs = 2000): Promise<{
    ok: boolean;
    latencyMs: number;
  }> {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.supabaseUrl}/auth/v1/health`, {
        method: 'GET',
        headers: {
          apikey: this.serviceRoleKey,
          Authorization: `Bearer ${this.serviceRoleKey}`,
        },
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        this.logger.warn(
          `Supabase health endpoint returned ${response.status} after ${latencyMs}ms`,
        );
        return { ok: false, latencyMs };
      }

      return { ok: true, latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startTime;

      this.logger.warn(
        `Supabase connectivity check failed after ${latencyMs}ms: ${this.formatConnectivityError(error)}`,
      );
      return { ok: false, latencyMs };
    } finally {
      clearTimeout(timeout);
    }
  }

  private formatConnectivityError(error: unknown): string {
    if (!(error instanceof Error)) {
      return String(error);
    }

    const cause = (error as Error & { cause?: FetchFailureCause }).cause;

    if (!cause) {
      return error.message;
    }

    const details = [
      cause.code,
      cause.syscall,
      cause.hostname,
      cause.message,
    ].filter(Boolean);

    return details.length > 0
      ? `${error.message} (${details.join(' ')})`
      : error.message;
  }

  // Verify SSO token from platform
  async verifySSOToken(token: string): Promise<{ valid: boolean; user?: any }> {
    try {
      // In production, this would validate against the DW platform
      // For now, we'll decode and verify the JWT structure
      const { data, error } = await this.supabase.auth.getUser(token);
      
      if (error || !data.user) {
        return { valid: false };
      }

      return {
        valid: true,
        user: {
          id: data.user.id,
          email: data.user.email,
          name: data.user.user_metadata?.name || data.user.email?.split('@')[0],
        },
      };
    } catch {
      return { valid: false };
    }
  }
}
