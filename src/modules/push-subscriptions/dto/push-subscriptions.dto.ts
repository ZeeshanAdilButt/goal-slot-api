import {
  IsOptional,
  IsString,
  IsUrl,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

// A web push endpoint is minted by the browser's Push API and only ever
// points at the browser vendor's own push relay. The reminder cron later
// feeds this value straight into `webpush.sendNotification`
// (web-push-channel.provider.ts), which makes an outbound HTTPS request to
// whatever host is stored here — so an endpoint we didn't validate is a
// stored-SSRF vector, not just a data-quality issue. Keep this list to real
// push-service hosts only; extend it if this app starts supporting a
// browser vendor that isn't covered yet.
const ALLOWED_PUSH_ENDPOINT_HOST_SUFFIXES = [
  'fcm.googleapis.com', // Chrome / Chromium-based browsers (Edge, Brave, Opera, ...)
  'updates.push.services.mozilla.com', // Firefox
  'push.apple.com', // Safari Web Push
  'notify.windows.com', // Legacy Edge / WNS
];

function isAllowedPushEndpointHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ALLOWED_PUSH_ENDPOINT_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

// Local to this DTO rather than a shared decorators module — there is
// exactly one field in the codebase that needs it. Deliberately re-parses
// the URL instead of trusting @IsUrl's own parsing so this still rejects
// correctly even if that decorator is ever removed above.
function IsAllowedPushEndpoint(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isAllowedPushEndpoint',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') return false;
          try {
            return isAllowedPushEndpointHost(new URL(value).hostname);
          } catch {
            return false;
          }
        },
        defaultMessage(): string {
          return 'endpoint must be an https URL on a known push service (fcm.googleapis.com, updates.push.services.mozilla.com, push.apple.com, notify.windows.com)';
        },
      },
    });
  };
}

// A subscription is either a web push registration (endpoint + keys) or an
// Expo push token — never both, never neither. The DTO stays permissive
// (everything optional) so the shape check can live in the service and
// produce one clear error message instead of class-validator's generic one.
export class RegisterPushSubscriptionDto {
  @ApiProperty({
    required: false,
    description: 'Web push subscription endpoint URL',
  })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @IsAllowedPushEndpoint()
  endpoint?: string;

  @ApiProperty({ required: false, description: 'Web push p256dh key' })
  @IsOptional()
  @IsString()
  p256dh?: string;

  @ApiProperty({ required: false, description: 'Web push auth secret' })
  @IsOptional()
  @IsString()
  auth?: string;

  @ApiProperty({ required: false, description: 'Expo push token' })
  @IsOptional()
  @IsString()
  expoToken?: string;
}
