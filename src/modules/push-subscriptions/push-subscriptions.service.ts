import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RegisterPushSubscriptionDto } from './dto/push-subscriptions.dto';

@Injectable()
export class PushSubscriptionsService {
  constructor(private prisma: PrismaService) {}

  async register(userId: string, dto: RegisterPushSubscriptionDto) {
    const isWebShape = Boolean(dto.endpoint || dto.p256dh || dto.auth);
    const isExpoShape = Boolean(dto.expoToken);

    if (isWebShape && isExpoShape) {
      throw new BadRequestException(
        'Provide either a web push subscription or an Expo token, not both',
      );
    }

    if (isWebShape) {
      if (!dto.endpoint || !dto.p256dh || !dto.auth) {
        throw new BadRequestException(
          'A web push subscription requires endpoint, p256dh, and auth',
        );
      }

      return this.prisma.pushSubscription.upsert({
        where: { userId_endpoint: { userId, endpoint: dto.endpoint } },
        create: {
          userId,
          kind: 'WEB',
          endpoint: dto.endpoint,
          p256dh: dto.p256dh,
          auth: dto.auth,
        },
        update: {
          p256dh: dto.p256dh,
          auth: dto.auth,
        },
      });
    }

    if (isExpoShape) {
      return this.prisma.pushSubscription.upsert({
        where: { userId_expoToken: { userId, expoToken: dto.expoToken! } },
        create: {
          userId,
          kind: 'EXPO',
          expoToken: dto.expoToken,
        },
        update: {},
      });
    }

    throw new BadRequestException(
      'Provide either a web push subscription (endpoint, p256dh, auth) or an expoToken',
    );
  }

  async unregister(id: string, userId: string) {
    const subscription = await this.prisma.pushSubscription.findUnique({
      where: { id },
    });
    if (!subscription) {
      throw new NotFoundException('Push subscription not found');
    }
    if (subscription.userId !== userId) {
      throw new ForbiddenException('You cannot remove this push subscription');
    }

    return this.prisma.pushSubscription.delete({ where: { id } });
  }

  // Called by channel providers to clean up a subscription the push
  // service reports as dead (e.g. web push 404/410). Deliberately not
  // scoped to throw if nothing matches — the row may already be gone.
  async deleteByEndpoint(userId: string, endpoint: string) {
    await this.prisma.pushSubscription.deleteMany({
      where: { userId, endpoint },
    });
  }

  async deleteByExpoToken(userId: string, expoToken: string) {
    await this.prisma.pushSubscription.deleteMany({
      where: { userId, expoToken },
    });
  }
}
