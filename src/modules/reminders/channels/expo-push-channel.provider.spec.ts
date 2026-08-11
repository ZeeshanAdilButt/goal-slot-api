const isExpoPushToken = jest.fn();
const chunkPushNotifications = jest.fn();
const sendPushNotificationsAsync = jest.fn();

jest.mock("expo-server-sdk", () => ({
  Expo: Object.assign(
    jest.fn().mockImplementation(() => ({
      chunkPushNotifications,
      sendPushNotificationsAsync,
    })),
    { isExpoPushToken },
  ),
}));

import { ExpoPushReminderChannel } from "./expo-push-channel.provider";

describe("ExpoPushReminderChannel", () => {
  const input = {
    userId: "user-1",
    title: "Reminder: check in",
    body: "It has been two days since this instruction was assigned.",
  };

  function buildChannel(opts: {
    findMany?: jest.Mock;
    deleteMock?: jest.Mock;
  }) {
    const prisma = {
      pushSubscription: {
        findMany: opts.findMany ?? jest.fn().mockResolvedValue([]),
        delete: opts.deleteMock ?? jest.fn().mockResolvedValue({}),
      },
    };

    const channel = new ExpoPushReminderChannel(prisma as any);

    return { channel, prisma };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: every message is treated as one chunk, in order - matches
    // the real SDK's behavior for single-token (non-array `to`) messages.
    chunkPushNotifications.mockImplementation((messages: any[]) => [messages]);
    isExpoPushToken.mockReturnValue(true);
  });

  it("has the name 'expo-push'", () => {
    const { channel } = buildChannel({});
    expect(channel.name).toBe("expo-push");
  });

  it("returns ok:false without calling the SDK when there are no subscriptions", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const { channel, prisma } = buildChannel({ findMany });

    const result = await channel.send(input);

    expect(result).toEqual({ ok: false });
    expect(prisma.pushSubscription.findMany).toHaveBeenCalledWith({
      where: { userId: input.userId, kind: "EXPO" },
    });
    expect(chunkPushNotifications).not.toHaveBeenCalled();
    expect(sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it("returns ok:true on a successful send", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: "sub-1", userId: "user-1", kind: "EXPO", expoToken: "ExponentPushToken[abc]" },
    ]);
    sendPushNotificationsAsync.mockResolvedValue([{ status: "ok", id: "receipt-1" }]);
    const { channel } = buildChannel({ findMany });

    const result = await channel.send(input);

    expect(result).toEqual({ ok: true });
    expect(sendPushNotificationsAsync).toHaveBeenCalledWith([
      {
        to: "ExponentPushToken[abc]",
        title: input.title,
        body: input.body,
        data: undefined,
      },
    ]);
  });

  it("deletes the subscription row when its ticket comes back DeviceNotRegistered", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: "sub-1", userId: "user-1", kind: "EXPO", expoToken: "ExponentPushToken[dead]" },
    ]);
    const deleteMock = jest.fn().mockResolvedValue({});
    sendPushNotificationsAsync.mockResolvedValue([
      {
        status: "error",
        message: "device not registered",
        details: { error: "DeviceNotRegistered" },
      },
    ]);
    const { channel, prisma } = buildChannel({ findMany, deleteMock });

    const result = await channel.send(input);

    expect(prisma.pushSubscription.delete).toHaveBeenCalledWith({ where: { id: "sub-1" } });
    // It was the user's only subscription and it died, so the caller is
    // told there is nothing left to reach them on via this channel.
    expect(result).toEqual({ ok: false, subscriptionGone: true });
  });

  it("does not set subscriptionGone when other subscriptions remain", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: "sub-1", userId: "user-1", kind: "EXPO", expoToken: "ExponentPushToken[dead]" },
      { id: "sub-2", userId: "user-1", kind: "EXPO", expoToken: "ExponentPushToken[alive]" },
    ]);
    sendPushNotificationsAsync.mockResolvedValue([
      { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
      { status: "ok", id: "receipt-2" },
    ]);
    const { channel, prisma } = buildChannel({ findMany });

    const result = await channel.send(input);

    expect(prisma.pushSubscription.delete).toHaveBeenCalledWith({ where: { id: "sub-1" } });
    expect(prisma.pushSubscription.delete).not.toHaveBeenCalledWith({ where: { id: "sub-2" } });
    expect(result).toEqual({ ok: true });
  });

  it("skips a stored token that fails Expo's format validation rather than sending it", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: "sub-1", userId: "user-1", kind: "EXPO", expoToken: "not-a-real-token" },
    ]);
    isExpoPushToken.mockReturnValue(false);
    const { channel, prisma } = buildChannel({ findMany });

    const result = await channel.send(input);

    expect(result).toEqual({ ok: false });
    expect(sendPushNotificationsAsync).not.toHaveBeenCalled();
    expect(prisma.pushSubscription.delete).not.toHaveBeenCalled();
  });

  it("catches an SDK throw and returns ok:false instead of propagating", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: "sub-1", userId: "user-1", kind: "EXPO", expoToken: "ExponentPushToken[abc]" },
    ]);
    sendPushNotificationsAsync.mockRejectedValue(new Error("Expo API unreachable"));
    const { channel } = buildChannel({ findMany });

    await expect(channel.send(input)).resolves.toEqual({ ok: false });
  });

  it("returns ok:false and does not throw when the subscription lookup rejects", async () => {
    const findMany = jest.fn().mockRejectedValue(new Error("DB unreachable"));
    const { channel } = buildChannel({ findMany });

    await expect(channel.send(input)).resolves.toEqual({ ok: false });
  });
});
