const mockSend = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: mockSend },
  })),
}));

import { EmailService } from "./email.service";

function buildConfigService() {
  const values: Record<string, string> = {
    RESEND_API_KEY: "test-key",
    APP_URL: "https://app.goalslot.io",
    ONBOARDING_EMAIL: "onboarding@goalslot.io",
    NOTIFICATION_EMAIL: "notifications@goalslot.io",
  };
  return {
    getOrThrow: (key: string) => values[key],
  };
}

// Reminder titles/bodies come from user-controlled data (an
// AssignInstructionDto.title set by another user's mentor/mentee, fanned
// out by ReminderDispatchService two days later) and are rendered live
// into a real GoalSlot-branded HTML email. sendReminderEmail must escape
// them the same way sendNoteShareInvitation already escapes noteTitle.
describe("EmailService.sendReminderEmail", () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({ data: { id: "email_1" }, error: null });
  });

  it("HTML-escapes a malicious title and body instead of rendering them live", async () => {
    const service = new EmailService(buildConfigService() as any);

    await service.sendReminderEmail({
      toEmail: "mentee@example.com",
      title: "Reminder: <img src=x onerror=alert(1)>",
      body: 'Click <a href="https://evil.example/phish">here</a> & "verify" your account',
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const call = mockSend.mock.calls[0][0];

    // No raw tag or attribute survives into the HTML part.
    expect(call.html).not.toContain("<img src=x onerror=alert(1)>");
    expect(call.html).not.toContain('<a href="https://evil.example/phish">here</a>');

    // The escaped, inert form is present instead.
    expect(call.html).toContain("Reminder: &lt;img src=x onerror=alert(1)&gt;");
    expect(call.html).toContain(
      "Click &lt;a href=&quot;https://evil.example/phish&quot;&gt;here&lt;/a&gt; &amp; &quot;verify&quot; your account",
    );
  });

  it("escapes the hidden preheader too, not just the visible body", async () => {
    const service = new EmailService(buildConfigService() as any);

    await service.sendReminderEmail({
      toEmail: "mentee@example.com",
      title: "Reminder",
      body: '<script>alert(1)</script>',
    });

    const call = mockSend.mock.calls[0][0];
    expect(call.html).not.toContain("<script>alert(1)</script>");
  });

  it("leaves an ordinary title and body unchanged", async () => {
    const service = new EmailService(buildConfigService() as any);

    await service.sendReminderEmail({
      toEmail: "mentee@example.com",
      title: "Reminder: Log time daily this week",
      body: "Your mentor is waiting on: Log time daily this week",
    });

    const call = mockSend.mock.calls[0][0];
    expect(call.html).toContain("Reminder: Log time daily this week");
    expect(call.html).toContain("Your mentor is waiting on: Log time daily this week");
  });

  it("sends the subject and Resend call with the expected recipient", async () => {
    const service = new EmailService(buildConfigService() as any);

    await service.sendReminderEmail({
      toEmail: "mentee@example.com",
      title: "Reminder: Log time daily this week",
      body: "Body copy",
    });

    const call = mockSend.mock.calls[0][0];
    expect(call.to).toBe("mentee@example.com");
    expect(call.subject).toBe("Reminder: Log time daily this week");
    expect(call.from).toBe("notifications@goalslot.io");
  });
});
