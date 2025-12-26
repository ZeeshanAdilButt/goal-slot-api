import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private supabase: SupabaseClient;

  constructor(private configService: ConfigService) {
    this.supabase = createClient(
      this.configService.get<string>('SUPABASE_URL') || '',
      this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY') || '',
    );
  }

  getClient(): SupabaseClient {
    return this.supabase;
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
