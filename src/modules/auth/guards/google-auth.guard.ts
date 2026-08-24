import {
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { isGoogleOAuthConfigured } from '../google-oauth.config';

/**
 * Guards the two Google routes so they behave sanely on a deployment that has
 * no Google credentials.
 *
 * Without this check, AuthModule would (correctly) not have registered the
 * 'google' strategy, and passport would throw "Unknown authentication strategy"
 * -- surfacing to the user as a 500 on a route that is not broken, just turned
 * off. A 404 says the honest thing: this endpoint does not exist here.
 */
@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {
  constructor(private readonly configService: ConfigService) {
    super();
  }

  canActivate(context: ExecutionContext) {
    if (!isGoogleOAuthConfigured(this.configService)) {
      throw new NotFoundException('Google sign-in is not configured');
    }
    return super.canActivate(context);
  }
}
