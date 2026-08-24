import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Profile, Strategy, VerifyCallback } from 'passport-google-oauth20';
import { GoogleOAuthConfig } from '../google-oauth.config';

/**
 * The shape handed to AuthService.handleGoogleLogin. Deliberately narrow: the
 * OAuth access/refresh tokens Google issues are for calling Google's own APIs,
 * which this app never does, so they are dropped here rather than carried
 * around (and, in #52, attached to the user object) for no purpose.
 */
export interface GoogleProfilePayload {
  googleId: string;
  email: string;
  /**
   * Google's own verification status for the address. Passed through rather
   * than assumed true -- see AuthService.handleGoogleLogin, which refuses to
   * link an unverified Google address to an existing account.
   */
  emailVerified: boolean;
  name?: string;
  avatar?: string;
}

/**
 * Takes its credentials as a constructor argument instead of reading
 * ConfigService itself, so it is impossible to construct this in a
 * half-configured state. AuthModule only builds it when
 * getGoogleOAuthConfig() returned a complete config -- which is what keeps a
 * deployment with no Google credentials from crashing at bootstrap the way
 * #52 did.
 */
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: GoogleOAuthConfig) {
    super({
      clientID: config.clientID,
      clientSecret: config.clientSecret,
      callbackURL: config.callbackURL,
      scope: ['email', 'profile'],
    });
  }

  /**
   * Forces Google to show the account chooser on every sign-in attempt.
   *
   * Without this, Google silently reuses whichever account is already signed
   * in to the browser and skips the chooser entirely. Reported: after signing
   * in once, logging out of GoalSlot and pressing "Continue with Google"
   * again immediately signed the same account back in, with no way to pick a
   * different one -- logging out of GoalSlot does not log the browser out of
   * Google, so from Google's side there was nothing to ask about.
   *
   * That is wrong for anyone with more than one Google account, and it makes
   * the button feel broken rather than merely opinionated. `select_account`
   * asks every time; it does not re-prompt for consent (that would be
   * `consent`), so an already-approved account is still one click.
   */
  authorizationParams(): Record<string, string> {
    return { prompt: 'select_account' };
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): void {
    const primaryEmail = profile.emails?.[0];

    if (!primaryEmail?.value) {
      // Google can return a profile with no email if the user declined the
      // scope. There is no account to find or create without one.
      done(new Error('Google account did not provide an email address'));
      return;
    }

    // passport-google-oauth20 types `verified` loosely; Google sends it as a
    // boolean or the string "true" depending on the response shape.
    const verifiedFlag = (primaryEmail as { verified?: boolean | string })
      .verified;

    const payload: GoogleProfilePayload = {
      googleId: profile.id,
      email: primaryEmail.value,
      emailVerified: verifiedFlag === true || verifiedFlag === 'true',
      name: profile.displayName,
      avatar: profile.photos?.[0]?.value,
    };

    done(null, payload);
  }
}
