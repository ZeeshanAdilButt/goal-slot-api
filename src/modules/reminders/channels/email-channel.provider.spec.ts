import { EmailReminderChannel } from "./email-channel.provider";

describe("EmailReminderChannel", () => {
  const input = {
    userId: "user-1",
    title: "Your mentee's report is going stale",
    body: "It has been a week since you last checked in.",
  };

  function buildChannel(opts: {
    findUnique?: jest.Mock;
    sendReminderEmail?: jest.Mock;
  }) {
    const prisma = {
      user: {
        findUnique:
          opts.findUnique ??
          jest.fn().mockResolvedValue({
            id: "user-1",
            email: "mentor@example.com",
            name: "Mentor Name",
          }),
      },
    };
    const emailService = {
      sendReminderEmail:
        opts.sendReminderEmail ??
        jest.fn().mockResolvedValue({ success: true, id: "email-1" }),
    };

    const channel = new EmailReminderChannel(
      prisma as any,
      emailService as any,
    );

    return { channel, prisma, emailService };
  }

  it("has the name 'email'", () => {
    const { channel } = buildChannel({});
    expect(channel.name).toBe("email");
  });

  it("sends successfully when the user and email service both work", async () => {
    const { channel, prisma, emailService } = buildChannel({});

    const result = await channel.send(input);

    expect(result).toEqual({ ok: true });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: input.userId },
      select: { id: true, email: true, name: true },
    });
    expect(emailService.sendReminderEmail).toHaveBeenCalledWith({
      toEmail: "mentor@example.com",
      title: input.title,
      body: input.body,
    });
  });

  it("returns ok:false and does not throw when the user is not found", async () => {
    const { channel, emailService } = buildChannel({
      findUnique: jest.fn().mockResolvedValue(null),
    });

    const result = await channel.send(input);

    expect(result).toEqual({ ok: false });
    expect(emailService.sendReminderEmail).not.toHaveBeenCalled();
  });

  it("returns ok:false and does not throw when EmailService.send rejects", async () => {
    const { channel } = buildChannel({
      sendReminderEmail: jest.fn().mockRejectedValue(new Error("Resend down")),
    });

    await expect(channel.send(input)).resolves.toEqual({ ok: false });
  });

  it("returns ok:false and does not throw when the user lookup rejects", async () => {
    const { channel } = buildChannel({
      findUnique: jest.fn().mockRejectedValue(new Error("DB unreachable")),
    });

    await expect(channel.send(input)).resolves.toEqual({ ok: false });
  });
});
