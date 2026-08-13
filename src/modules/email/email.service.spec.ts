import { EmailService } from './email.service';

// ---------- Fakes ----------

class FakeConfigService {
  private values: Record<string, string> = {
    RESEND_API_KEY: 're_test_key',
    APP_URL: 'https://app.goalslot.io',
    ONBOARDING_EMAIL: 'onboarding@goalslot.io',
    NOTIFICATION_EMAIL: 'notify@goalslot.io',
  };

  getOrThrow<T = string>(key: string): T {
    const value = this.values[key];
    if (value === undefined) {
      throw new Error(`Missing config value: ${key}`);
    }
    return value as unknown as T;
  }
}

function buildService() {
  const service = new EmailService(new FakeConfigService() as any);
  const sendMock = jest
    .fn()
    .mockResolvedValue({ data: { id: 'email_1' }, error: null });
  // Resend itself talks to the network; swap the client's emails.send
  // for a spy so tests only inspect the html/subject/text we generate.
  (service as any).resend = { emails: { send: sendMock } };
  return { service, sendMock };
}

const MALICIOUS_NAME =
  'GoalSlot Security<a href="https://evil.tld">Verify your account</a>';
const SCRIPT_PAYLOAD = '<script>document.location="https://evil.tld"</script>';

function lastCallArgs(sendMock: jest.Mock) {
  expect(sendMock).toHaveBeenCalledTimes(1);
  return sendMock.mock.calls[0][0];
}

function expectNoRawMarkup(value: string) {
  expect(value).not.toContain('<a href="https://evil.tld"');
  expect(value).not.toContain('<script>');
}

describe('EmailService HTML escaping', () => {
  it('escapes a malicious inviterName in sendShareInvitation (html + subject)', async () => {
    const { service, sendMock } = buildService();

    await service.sendShareInvitation({
      toEmail: 'victim@example.com',
      inviterName: MALICIOUS_NAME,
      inviterEmail: 'attacker@example.com',
      inviteToken: 'tok-123',
      isExistingUser: false,
    });

    const { html, subject } = lastCallArgs(sendMock);
    expectNoRawMarkup(html);
    expectNoRawMarkup(subject);
    expect(html).toContain('&lt;a href=&quot;https://evil.tld&quot;&gt;');
  });

  it('escapes a malicious inviterName and noteTitle in sendNoteShareInvitation', async () => {
    const { service, sendMock } = buildService();

    await service.sendNoteShareInvitation({
      toEmail: 'victim@example.com',
      inviterName: MALICIOUS_NAME,
      inviterEmail: 'attacker@example.com',
      noteTitle: SCRIPT_PAYLOAD,
      noteId: 'note-1',
      isExistingUser: true,
    });

    const { html, subject } = lastCallArgs(sendMock);
    expectNoRawMarkup(html);
    expectNoRawMarkup(subject);
    // noteTitle used to only escape "<"; confirm "&" and quotes are now
    // fully escaped too via the shared helper.
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes a malicious inviterName and whiteboardTitle in sendWhiteboardShareInvitation', async () => {
    const { service, sendMock } = buildService();

    await service.sendWhiteboardShareInvitation({
      toEmail: 'victim@example.com',
      inviterName: MALICIOUS_NAME,
      inviterEmail: 'attacker@example.com',
      whiteboardTitle: SCRIPT_PAYLOAD,
      whiteboardId: 'wb-1',
      isExistingUser: true,
    });

    const { html, subject } = lastCallArgs(sendMock);
    expectNoRawMarkup(html);
    expectNoRawMarkup(subject);
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes a malicious inviterName in sendBulkInviteWelcome', async () => {
    const { service, sendMock } = buildService();

    await service.sendBulkInviteWelcome({
      toEmail: 'victim@example.com',
      inviterName: MALICIOUS_NAME,
      inviterEmail: 'attacker@example.com',
      role: 'USER',
    });

    const { html, subject } = lastCallArgs(sendMock);
    expectNoRawMarkup(html);
    expectNoRawMarkup(subject);
  });

  it('escapes a malicious display name in sendWelcomeEmail', async () => {
    const { service, sendMock } = buildService();

    await service.sendWelcomeEmail({
      toEmail: 'victim@example.com',
      userName: MALICIOUS_NAME,
    });

    const { html, subject } = lastCallArgs(sendMock);
    expectNoRawMarkup(html);
    expectNoRawMarkup(subject);
  });

  it('escapes a malicious accepterName in sendShareAcceptedNotification', async () => {
    const { service, sendMock } = buildService();

    await service.sendShareAcceptedNotification({
      toEmail: 'owner@example.com',
      accepterName: MALICIOUS_NAME,
      accepterEmail: 'attacker@example.com',
    });

    const { html, subject } = lastCallArgs(sendMock);
    expectNoRawMarkup(html);
    expectNoRawMarkup(subject);
  });

  it('leaves an ordinary name untouched', async () => {
    const { service, sendMock } = buildService();

    await service.sendShareInvitation({
      toEmail: 'victim@example.com',
      inviterName: 'Jane Doe',
      inviterEmail: 'jane@example.com',
      inviteToken: 'tok-456',
      isExistingUser: false,
    });

    const { html, subject } = lastCallArgs(sendMock);
    expect(html).toContain('Jane Doe');
    expect(subject).toContain('Jane Doe');
  });
});

// Reminder titles/bodies come from user-controlled data (an
// AssignInstructionDto.title set by another user's mentor/mentee, fanned
// out by ReminderDispatchService two days later) and are rendered live
// into a real GoalSlot-branded HTML email. sendReminderEmail must escape
// them the same way sendNoteShareInvitation already escapes noteTitle.
describe('EmailService.sendReminderEmail', () => {
  it('HTML-escapes a malicious title and body instead of rendering them live', async () => {
    const { service, sendMock } = buildService();

    await service.sendReminderEmail({
      toEmail: 'mentee@example.com',
      title: 'Reminder: <img src=x onerror=alert(1)>',
      body: 'Click <a href="https://evil.example/phish">here</a> & "verify" your account',
    });

    const call = lastCallArgs(sendMock);

    // No raw tag or attribute survives into the HTML part.
    expect(call.html).not.toContain('<img src=x onerror=alert(1)>');
    expect(call.html).not.toContain(
      '<a href="https://evil.example/phish">here</a>',
    );

    // The escaped, inert form is present instead.
    expect(call.html).toContain('Reminder: &lt;img src=x onerror=alert(1)&gt;');
    expect(call.html).toContain(
      'Click &lt;a href=&quot;https://evil.example/phish&quot;&gt;here&lt;/a&gt; &amp; &quot;verify&quot; your account',
    );
  });

  it('escapes the hidden preheader too, not just the visible body', async () => {
    const { service, sendMock } = buildService();

    await service.sendReminderEmail({
      toEmail: 'mentee@example.com',
      title: 'Reminder',
      body: '<script>alert(1)</script>',
    });

    const call = lastCallArgs(sendMock);
    expect(call.html).not.toContain('<script>alert(1)</script>');
  });

  it('leaves an ordinary title and body unchanged', async () => {
    const { service, sendMock } = buildService();

    await service.sendReminderEmail({
      toEmail: 'mentee@example.com',
      title: 'Reminder: Log time daily this week',
      body: 'Your mentor is waiting on: Log time daily this week',
    });

    const call = lastCallArgs(sendMock);
    expect(call.html).toContain('Reminder: Log time daily this week');
    expect(call.html).toContain(
      'Your mentor is waiting on: Log time daily this week',
    );
  });

  it('sends the subject and Resend call with the expected recipient', async () => {
    const { service, sendMock } = buildService();

    await service.sendReminderEmail({
      toEmail: 'mentee@example.com',
      title: 'Reminder: Log time daily this week',
      body: 'Body copy',
    });

    const call = lastCallArgs(sendMock);
    expect(call.to).toBe('mentee@example.com');
    expect(call.subject).toBe('Reminder: Log time daily this week');
    expect(call.from).toBe('notify@goalslot.io');
  });
});
