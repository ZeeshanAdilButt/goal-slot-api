jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
}));

import * as webpush from 'web-push';
import { WebPushReminderChannel } from './web-push-channel.provider';

const ORIGINAL_ENV = process.env;

describe('WebPushReminderChannel', () => {
  let prisma: { pushSubscription: { findMany: jest.Mock } };
  let pushSubscriptionsService: { deleteByEndpoint: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    prisma = { pushSubscription: { findMany: jest.fn() } };
    pushSubscriptionsService = { deleteByEndpoint: jest.fn() };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  function buildChannel(config: { publicKey?: string; privateKey?: string; subject?: string } = {}) {
    const withDefaults = {
      publicKey: 'public-key',
      privateKey: 'private-key',
      subject: 'mailto:ops@example.com',
      ...config,
    };

    if ('publicKey' in config && config.publicKey === undefined) {
      delete process.env.VAPID_PUBLIC_KEY;
    } else {
      process.env.VAPID_PUBLIC_KEY = withDefaults.publicKey;
    }
    if ('privateKey' in config && config.privateKey === undefined) {
      delete process.env.VAPID_PRIVATE_KEY;
    } else {
      process.env.VAPID_PRIVATE_KEY = withDefaults.privateKey;
    }
    if ('subject' in config && config.subject === undefined) {
      delete process.env.VAPID_SUBJECT;
    } else {
      process.env.VAPID_SUBJECT = withDefaults.subject;
    }

    return new WebPushReminderChannel(prisma as any, pushSubscriptionsService as any);
  }

  it('short-circuits without throwing when VAPID keys are missing', async () => {
    const channel = buildChannel({ publicKey: undefined, privateKey: undefined });

    const result = await channel.send({ userId: 'user_1', title: 'Hi', body: 'Body' });

    expect(result).toEqual({ ok: false });
    expect(prisma.pushSubscription.findMany).not.toHaveBeenCalled();
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('returns ok:false without calling web-push when the user has no WEB subscriptions', async () => {
    const channel = buildChannel();
    prisma.pushSubscription.findMany.mockResolvedValue([]);

    const result = await channel.send({ userId: 'user_1', title: 'Hi', body: 'Body' });

    expect(result).toEqual({ ok: false });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('returns ok:true when the send succeeds', async () => {
    const channel = buildChannel();
    prisma.pushSubscription.findMany.mockResolvedValue([
      { id: 's1', userId: 'user_1', kind: 'WEB', endpoint: 'https://push.example/1', p256dh: 'p', auth: 'a' },
    ]);
    (webpush.sendNotification as jest.Mock).mockResolvedValue({ statusCode: 201 });

    const result = await channel.send({ userId: 'user_1', title: 'Hi', body: 'Body' });

    expect(result).toEqual({ ok: true });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(pushSubscriptionsService.deleteByEndpoint).not.toHaveBeenCalled();
  });

  it('deletes the subscription and reports subscriptionGone on a 410 from the sole subscription', async () => {
    const channel = buildChannel();
    const subscription = {
      id: 's1',
      userId: 'user_1',
      kind: 'WEB',
      endpoint: 'https://push.example/1',
      p256dh: 'p',
      auth: 'a',
    };
    prisma.pushSubscription.findMany.mockResolvedValue([subscription]);
    const error: any = new Error('gone');
    error.statusCode = 410;
    (webpush.sendNotification as jest.Mock).mockRejectedValue(error);

    const result = await channel.send({ userId: 'user_1', title: 'Hi', body: 'Body' });

    expect(result).toEqual({ ok: false, subscriptionGone: true });
    expect(pushSubscriptionsService.deleteByEndpoint).toHaveBeenCalledWith('user_1', subscription.endpoint);
  });

  it('deletes the subscription on a 404 response too', async () => {
    const channel = buildChannel();
    const subscription = {
      id: 's1',
      userId: 'user_1',
      kind: 'WEB',
      endpoint: 'https://push.example/1',
      p256dh: 'p',
      auth: 'a',
    };
    prisma.pushSubscription.findMany.mockResolvedValue([subscription]);
    const error: any = new Error('not found');
    error.statusCode = 404;
    (webpush.sendNotification as jest.Mock).mockRejectedValue(error);

    const result = await channel.send({ userId: 'user_1', title: 'Hi', body: 'Body' });

    expect(result).toEqual({ ok: false, subscriptionGone: true });
    expect(pushSubscriptionsService.deleteByEndpoint).toHaveBeenCalledWith('user_1', subscription.endpoint);
  });

  it('returns ok:false without deleting anything when a send fails for a non-gone reason', async () => {
    const channel = buildChannel();
    const subscription = {
      id: 's1',
      userId: 'user_1',
      kind: 'WEB',
      endpoint: 'https://push.example/1',
      p256dh: 'p',
      auth: 'a',
    };
    prisma.pushSubscription.findMany.mockResolvedValue([subscription]);
    const error: any = new Error('server error');
    error.statusCode = 500;
    (webpush.sendNotification as jest.Mock).mockRejectedValue(error);

    const result = await channel.send({ userId: 'user_1', title: 'Hi', body: 'Body' });

    expect(result).toEqual({ ok: false });
    expect(pushSubscriptionsService.deleteByEndpoint).not.toHaveBeenCalled();
  });

  it('returns ok:true when one of several subscriptions succeeds', async () => {
    const channel = buildChannel();
    prisma.pushSubscription.findMany.mockResolvedValue([
      { id: 's1', userId: 'user_1', kind: 'WEB', endpoint: 'https://push.example/1', p256dh: 'p', auth: 'a' },
      { id: 's2', userId: 'user_1', kind: 'WEB', endpoint: 'https://push.example/2', p256dh: 'p', auth: 'a' },
    ]);
    const gone: any = new Error('gone');
    gone.statusCode = 410;
    (webpush.sendNotification as jest.Mock).mockRejectedValueOnce(gone).mockResolvedValueOnce({ statusCode: 201 });

    const result = await channel.send({ userId: 'user_1', title: 'Hi', body: 'Body' });

    expect(result).toEqual({ ok: true });
    expect(pushSubscriptionsService.deleteByEndpoint).toHaveBeenCalledWith('user_1', 'https://push.example/1');
  });
});
