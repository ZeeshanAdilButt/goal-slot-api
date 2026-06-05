import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Resend } from "resend";

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  private maskEmail(email: string): string {
    const [local, domain] = email.split("@");
    if (!local || !domain) return "***";
    return `${local.slice(0, 2)}***@${domain}`;
  }
  private resend: Resend;
  private onboardingEmail: string;
  private notificationEmail: string;
  private appUrl = "";

  constructor(private readonly configService: ConfigService) {
    this.resend = new Resend(
      this.configService.getOrThrow<string>("RESEND_API_KEY"),
    );
    this.appUrl = this.configService.getOrThrow<string>("APP_URL");
    this.onboardingEmail =
      this.configService.getOrThrow<string>("ONBOARDING_EMAIL");
    this.notificationEmail =
      this.configService.getOrThrow<string>("NOTIFICATION_EMAIL");
  }

  // -----------------------------------------------------------------
  // Shared email layout. Every transactional email goes through this
  // wrapper so the brand stays consistent and we only have to update
  // one place. Matches the app theme: brand-yellow accents (#f2cc0d),
  // soft zinc borders, rounded corners, light-text-on-cream header
  // strip — not the previous heavy neo-brutalist 3px-black-border
  // look.
  // -----------------------------------------------------------------
  private renderLayout(opts: { bodyHtml: string; preheader?: string }): string {
    const { bodyHtml, preheader } = opts;
    const hiddenPreheader = preheader
      ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${preheader}</div>`
      : "";
    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>GoalSlot</title>
    <style>
      body { margin: 0; padding: 0; background: #fafafa; }
      a { color: #8a7307; text-decoration: underline; text-underline-offset: 2px; }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;line-height:1.55;color:#18181b;">
    ${hiddenPreheader}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fafafa;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e4e7;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="background:linear-gradient(135deg,#fffbea 0%,#ffffff 100%);padding:24px 28px;border-bottom:1px solid #f4e6a4;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td>
                      <div style="display:inline-block;font-weight:800;letter-spacing:0.04em;color:#18181b;font-size:18px;">
                        <span style="display:inline-block;width:10px;height:10px;background:#f2cc0d;border-radius:3px;margin-right:8px;vertical-align:middle;"></span>GoalSlot
                      </div>
                    </td>
                    <td align="right" style="font-size:11px;color:#8a7307;text-transform:uppercase;letter-spacing:0.1em;font-weight:700;">
                      Master your focus
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 28px 24px;color:#18181b;font-size:15px;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px 22px;background:#fafafa;border-top:1px solid #f4f4f5;font-size:12px;color:#71717a;text-align:center;">
                <div style="margin-bottom:4px;font-weight:600;color:#52525b;">GoalSlot</div>
                <div>Goals, schedule, time, tasks, notes, journal &mdash; one place.</div>
                <div style="margin-top:8px;">
                  <a href="${this.appUrl}" style="color:#71717a;text-decoration:none;">${this.appUrl.replace(/^https?:\/\//, "")}</a>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  }

  // Primary CTA button. Inline styles only because email clients ignore
  // most stylesheets. Centered by default; pass align: 'left' to opt out.
  private renderButton(href: string, label: string, align: "center" | "left" = "center"): string {
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}" style="margin:${align === "center" ? "20px auto" : "20px 0"};">
      <tr>
        <td style="border-radius:8px;background:#f2cc0d;">
          <a href="${href}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:700;color:#18181b;text-decoration:none;border-radius:8px;letter-spacing:0.02em;">
            ${label}
          </a>
        </td>
      </tr>
    </table>`;
  }

  // Soft-tinted callout box used for security notes, step rows, info
  // panels, etc. tone controls the background + accent color.
  private renderCallout(opts: {
    tone?: "info" | "warning" | "success";
    title?: string;
    html: string;
  }): string {
    const tone = opts.tone ?? "info";
    const palette =
      tone === "warning"
        ? { bg: "#fff7d1", border: "#f4e6a4", accent: "#8a7307" }
        : tone === "success"
          ? { bg: "#ecfdf5", border: "#a7f3d0", accent: "#047857" }
          : { bg: "#fafafa", border: "#e4e4e7", accent: "#52525b" };
    const titleHtml = opts.title
      ? `<div style="font-weight:700;font-size:13px;color:${palette.accent};text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;">${opts.title}</div>`
      : "";
    return `<div style="background:${palette.bg};border:1px solid ${palette.border};border-radius:10px;padding:14px 16px;margin:18px 0;font-size:13.5px;color:#27272a;">
      ${titleHtml}${opts.html}
    </div>`;
  }

  // Card used to highlight a piece of metadata in the body (note title,
  // whiteboard title, OTP code, etc).
  private renderTitleCard(title: string): string {
    return `<div style="background:#fffbea;border:1px solid #f4e6a4;border-left:4px solid #f2cc0d;border-radius:8px;padding:14px 16px;margin:18px 0;font-weight:700;font-size:15px;color:#18181b;">
      ${title}
    </div>`;
  }

  async sendShareInvitation(params: {
    toEmail: string;
    inviterName: string;
    inviterEmail: string;
    inviteToken: string;
    isExistingUser: boolean;
  }) {
    const { toEmail, inviterName, inviterEmail, inviteToken, isExistingUser } =
      params;

    const viewLink = `${this.appUrl}/share/accept?token=${inviteToken}`;

    const html = this.renderLayout({
      preheader: `${inviterName} shared their focus reports with you on GoalSlot.`,
      bodyHtml: `
        <h1 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#18181b;">You have been invited to view focus reports</h1>
        <p style="margin:0 0 12px;color:#3f3f46;">
          <strong>${inviterName}</strong> (${inviterEmail}) shared their GoalSlot focus reports and productivity data with you.
        </p>
        <p style="margin:0 0 4px;color:#3f3f46;">Click below to open the shared view:</p>
        ${this.renderButton(viewLink, "View shared reports")}
        ${this.renderCallout({
          tone: "info",
          title: "What this link does",
          html: `<ul style="margin:6px 0 0;padding-left:18px;color:#3f3f46;">
            <li>Secure, unique, view-only access.</li>
            <li>No account required to view.</li>
            <li>Expires in 7 days.</li>
            ${!isExistingUser ? "<li>Sign up to track your own focus time and unlock the rest of GoalSlot.</li>" : ""}
          </ul>`,
        })}
        <p style="margin:18px 0 6px;font-size:12px;color:#71717a;">If the button does not work, copy this link into your browser:</p>
        <p style="margin:0;font-size:12px;color:#52525b;word-break:break-all;">${viewLink}</p>
      `,
    });

    const text = `You have been invited to view focus reports on GoalSlot.

${inviterName} (${inviterEmail}) shared their focus reports and productivity data with you.

Open the shared view:
${viewLink}

What this link does:
- Secure, unique, view-only access.
- No account required to view.
- Expires in 7 days.
${!isExistingUser ? "- Sign up to track your own focus time and unlock the rest of GoalSlot.\n" : ""}
If you did not expect this invitation, you can safely ignore it.

GoalSlot`;

    const result = await this.resend.emails.send({
      from: this.notificationEmail,
      to: toEmail,
      subject: `${inviterName} shared their focus reports with you`,
      html,
      text,
    });

    if (result.error) {
      this.logger.error(
        `Resend API error for ${this.maskEmail(toEmail)}: ${result.error.message}`,
      );
      throw new InternalServerErrorException(
        `Failed to send share invitation email: ${result.error.message}`,
      );
    }

    this.logger.log(
      `Share invitation email sent to ${this.maskEmail(toEmail)}, id: ${result.data?.id}`,
    );
    return { success: true, id: result.data?.id };
  }

  // Note share invitation. Recipients land on the dashboard with the
  // shared note pre-selected; signing in (or signing up with the same
  // email) auto-resolves the share to their user account.
  async sendNoteShareInvitation(params: {
    toEmail: string;
    inviterName: string;
    inviterEmail: string;
    noteTitle: string;
    noteId: string;
    isExistingUser: boolean;
  }) {
    const {
      toEmail,
      inviterName,
      inviterEmail,
      noteTitle,
      noteId,
      isExistingUser,
    } = params;
    const viewLink = `${this.appUrl}/dashboard/notes?shared=${noteId}`;
    const safeTitle = (noteTitle || "Untitled").replace(/</g, "&lt;");

    const html = this.renderLayout({
      preheader: `${inviterName} shared a note with you on GoalSlot.`,
      bodyHtml: `
        <h1 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#18181b;">A note has been shared with you</h1>
        <p style="margin:0 0 6px;color:#3f3f46;">
          <strong>${inviterName}</strong> (${inviterEmail}) shared a note with you on GoalSlot.
        </p>
        ${this.renderTitleCard(safeTitle)}
        <p style="margin:0 0 4px;color:#3f3f46;">${
          isExistingUser
            ? "Open it from Notes &rsaquo; Shared with me, or click below."
            : "You will need to sign up with this email to view it. Sign up is quick and free."
        }</p>
        ${this.renderButton(viewLink, isExistingUser ? "Open the note" : "Sign up and view")}
        <p style="margin:18px 0 6px;font-size:12px;color:#71717a;">If the button does not work, copy this link into your browser:</p>
        <p style="margin:0;font-size:12px;color:#52525b;word-break:break-all;">${viewLink}</p>
      `,
    });

    const text = `${inviterName} (${inviterEmail}) shared a GoalSlot note with you: "${safeTitle}".

Open it: ${viewLink}

If you did not expect this email, you can safely ignore it.

GoalSlot`;

    const result = await this.resend.emails.send({
      from: this.notificationEmail,
      to: toEmail,
      subject: `${inviterName} shared a note with you on GoalSlot`,
      html,
      text,
    });

    if (result.error) {
      this.logger.error(
        `Resend API error for note share to ${this.maskEmail(toEmail)}: ${result.error.message}`,
      );
      throw new InternalServerErrorException(
        `Failed to send note share email: ${result.error.message}`,
      );
    }

    this.logger.log(
      `Note share invitation sent to ${this.maskEmail(toEmail)}, id: ${result.data?.id}`,
    );
    return { success: true, id: result.data?.id };
  }

  async sendWhiteboardShareInvitation(params: {
    toEmail: string;
    inviterName: string;
    inviterEmail: string;
    whiteboardTitle: string;
    whiteboardId: string;
    isExistingUser: boolean;
  }) {
    const {
      toEmail,
      inviterName,
      inviterEmail,
      whiteboardTitle,
      whiteboardId,
      isExistingUser,
    } = params;
    const viewLink = `${this.appUrl}/dashboard/whiteboards?shared=${whiteboardId}`;
    const safeTitle = (whiteboardTitle || "Untitled").replace(/</g, "&lt;");

    const html = this.renderLayout({
      preheader: `${inviterName} shared a whiteboard with you on GoalSlot.`,
      bodyHtml: `
        <h1 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#18181b;">A whiteboard has been shared with you</h1>
        <p style="margin:0 0 6px;color:#3f3f46;">
          <strong>${inviterName}</strong> (${inviterEmail}) shared a whiteboard with you on GoalSlot.
        </p>
        ${this.renderTitleCard(safeTitle)}
        <p style="margin:0 0 4px;color:#3f3f46;">${
          isExistingUser
            ? "Open it from Whiteboards &rsaquo; Shared with me, or click below."
            : "You will need to sign up with this email to view it. Sign up is quick and free."
        }</p>
        ${this.renderButton(viewLink, isExistingUser ? "Open the whiteboard" : "Sign up and view")}
        <p style="margin:18px 0 6px;font-size:12px;color:#71717a;">If the button does not work, copy this link into your browser:</p>
        <p style="margin:0;font-size:12px;color:#52525b;word-break:break-all;">${viewLink}</p>
      `,
    });

    const text = `${inviterName} (${inviterEmail}) shared a GoalSlot whiteboard with you: "${safeTitle}".

Open it: ${viewLink}

GoalSlot`;

    const result = await this.resend.emails.send({
      from: this.notificationEmail,
      to: toEmail,
      subject: `${inviterName} shared a whiteboard with you on GoalSlot`,
      html,
      text,
    });

    if (result.error) {
      this.logger.error(
        `Resend API error for whiteboard share to ${this.maskEmail(toEmail)}: ${result.error.message}`,
      );
      throw new InternalServerErrorException(
        `Failed to send whiteboard share email: ${result.error.message}`,
      );
    }

    this.logger.log(
      `Whiteboard share invitation sent to ${this.maskEmail(toEmail)}, id: ${result.data?.id}`,
    );
    return { success: true, id: result.data?.id };
  }

  async sendBulkInviteWelcome(params: {
    toEmail: string;
    inviterName: string;
    inviterEmail: string;
    role: string;
  }) {
    const { toEmail, inviterName, inviterEmail, role } = params;
    const setPasswordLink = `${this.appUrl}/forgot-password?email=${encodeURIComponent(toEmail)}`;
    const loginLink = `${this.appUrl}/login`;
    const roleLine =
      role === "ADMIN"
        ? "You have been added as an admin."
        : "Your free Fellowship account is ready.";

    const html = this.renderLayout({
      preheader: `${inviterName} invited you to GoalSlot.`,
      bodyHtml: `
        <h1 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#18181b;">Welcome to GoalSlot</h1>
        <p style="margin:0 0 12px;color:#3f3f46;">
          <strong>${inviterName}</strong> (${inviterEmail}) invited you to join GoalSlot. ${roleLine}
        </p>
        ${this.renderCallout({
          tone: "info",
          title: "Step 1 &ndash; Set your password",
          html: `<p style="margin:0 0 4px;color:#3f3f46;">Use this email address (${toEmail}) when prompted.</p>
            ${this.renderButton(setPasswordLink, "Set my password", "left")}`,
        })}
        ${this.renderCallout({
          tone: "info",
          title: "Step 2 &ndash; Log in",
          html: `<p style="margin:0;color:#3f3f46;">Once your password is set, log in at <a href="${loginLink}">${loginLink}</a>.</p>`,
        })}
        <p style="margin:18px 0 6px;font-size:12px;color:#71717a;">If the button does not work, copy this link into your browser:</p>
        <p style="margin:0;font-size:12px;color:#52525b;word-break:break-all;">${setPasswordLink}</p>
      `,
    });

    const text = `${inviterName} (${inviterEmail}) invited you to GoalSlot. ${roleLine}

Step 1: set your password at ${setPasswordLink}
Step 2: log in at ${loginLink}

Use this email address when prompted: ${toEmail}

GoalSlot`;

    const result = await this.resend.emails.send({
      from: this.onboardingEmail,
      to: toEmail,
      subject: `${inviterName} invited you to GoalSlot`,
      html,
      text,
    });

    if (result.error) {
      this.logger.error(
        `Resend API error for bulk invite to ${this.maskEmail(toEmail)}: ${result.error.message}`,
      );
      throw new InternalServerErrorException(
        `Failed to send bulk invite email: ${result.error.message}`,
      );
    }

    this.logger.log(
      `Bulk invite email sent to ${this.maskEmail(toEmail)}, id: ${result.data?.id}`,
    );
    return { success: true, id: result.data?.id };
  }

  async sendOTPEmail(params: {
    toEmail: string;
    otp: string;
    purpose: "signup" | "forgot-password";
  }) {
    const { toEmail, otp, purpose } = params;

    const purposeText =
      purpose === "signup" ? "Email verification" : "Password reset";
    const purposeDescription =
      purpose === "signup"
        ? "to complete your registration"
        : "to reset your password";

    const html = this.renderLayout({
      preheader: `Your GoalSlot ${purposeText.toLowerCase()} code: ${otp}`,
      bodyHtml: `
        <h1 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#18181b;">${purposeText}</h1>
        <p style="margin:0 0 12px;color:#3f3f46;">Your verification code ${purposeDescription} is:</p>
        <div style="background:#fffbea;border:1px solid #f4e6a4;border-radius:12px;padding:22px;margin:18px 0;text-align:center;">
          <div style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:0.4em;color:#18181b;">
            ${otp}
          </div>
        </div>
        ${this.renderCallout({
          tone: "warning",
          title: "Security",
          html: `<ul style="margin:6px 0 0;padding-left:18px;color:#3f3f46;">
            <li>Expires in <strong>5 minutes</strong>.</li>
            <li>One use only.</li>
            <li>Never share this code with anyone.</li>
            <li>If you did not request this, you can ignore the email.</li>
          </ul>`,
        })}
      `,
    });

    const text = `GoalSlot - ${purposeText}

Your verification code ${purposeDescription} is:

${otp}

Security:
- Expires in 5 minutes
- One use only
- Never share this code
- If you did not request this, ignore the email

GoalSlot`;

    this.logger.log(
      `Attempting to send OTP email (${purpose}) to ${this.maskEmail(toEmail)} from ${this.onboardingEmail}`,
    );
    const start = Date.now();
    const result = await this.resend.emails.send({
      from: this.onboardingEmail,
      to: toEmail,
      subject: `Your GoalSlot verification code: ${otp}`,
      html,
      text,
    });
    this.logger.log(
      `Resend send for OTP to ${this.maskEmail(toEmail)} took ${Date.now() - start} ms`,
    );

    if (result.error) {
      this.logger.error(
        `Resend API error for OTP email to ${this.maskEmail(toEmail)}: ${result.error.message}`,
      );
      throw new InternalServerErrorException(
        `Failed to send OTP email: ${result.error.message}`,
      );
    }

    this.logger.log(
      `OTP email sent to ${this.maskEmail(toEmail)}, id: ${result.data?.id}`,
    );
    return { success: true, id: result.data?.id };
  }

  async sendWelcomeEmail(params: { toEmail: string; userName: string }) {
    const { toEmail, userName } = params;

    const dashboardLink = `${this.appUrl}/dashboard`;
    const libraryLink = `${this.appUrl}/dashboard/library`;
    const firstName = userName.split(" ")[0];

    const html = this.renderLayout({
      preheader: `Welcome to GoalSlot, ${firstName}. Set up your first goal in two minutes.`,
      bodyHtml: `
        <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#18181b;">Welcome, ${firstName}.</h1>
        <p style="margin:0 0 12px;color:#3f3f46;">
          GoalSlot ties your goals, weekly schedule, time tracking, tasks, notes, and journal into one place. The fastest way to feel it: import a curated schedule from the Library, edit what you do not like, and start tracking.
        </p>
        ${this.renderButton(libraryLink, "Browse the Library")}
        ${this.renderCallout({
          tone: "info",
          title: "Three places to start",
          html: `<ul style="margin:6px 0 0;padding-left:18px;color:#3f3f46;">
            <li><a href="${this.appUrl}/dashboard/goals">Add your first goal</a> &ndash; what you are working on this month.</li>
            <li><a href="${this.appUrl}/dashboard/schedule">Block one weekly slot</a> &ndash; when that goal gets attention.</li>
            <li><a href="${this.appUrl}/dashboard/time-tracker">Start a 15-minute tracker</a> &ndash; the timer that learns your week.</li>
          </ul>`,
        })}
        <p style="margin:18px 0 4px;color:#3f3f46;">Or jump straight into the dashboard:</p>
        ${this.renderButton(dashboardLink, "Open my dashboard", "left")}
        <p style="margin:18px 0 0;color:#3f3f46;">Consistency beats intensity. Small daily focus sessions compound.</p>
      `,
    });

    const text = `Welcome to GoalSlot, ${firstName}.

GoalSlot ties your goals, schedule, time tracking, tasks, notes, and journal into one place.

Browse curated schedules: ${libraryLink}
Add your first goal:     ${this.appUrl}/dashboard/goals
Block a weekly slot:     ${this.appUrl}/dashboard/schedule
Start a 15-min tracker:  ${this.appUrl}/dashboard/time-tracker
Open the dashboard:      ${dashboardLink}

Consistency beats intensity.

GoalSlot`;

    const result = await this.resend.emails.send({
      from: this.onboardingEmail,
      to: toEmail,
      subject: `Welcome to GoalSlot, ${firstName}`,
      html,
      text,
    });

    if (result.error) {
      this.logger.error(
        `Resend API error for welcome email to ${this.maskEmail(toEmail)}: ${result.error.message}`,
      );
      throw new InternalServerErrorException(
        `Failed to send welcome email: ${result.error.message}`,
      );
    }

    this.logger.log(
      `Welcome email sent to ${this.maskEmail(toEmail)}, id: ${result.data?.id}`,
    );
    return { success: true, id: result.data?.id };
  }

  async sendShareAcceptedNotification(params: {
    toEmail: string;
    accepterName: string;
    accepterEmail: string;
  }) {
    const { toEmail, accepterName, accepterEmail } = params;

    const html = this.renderLayout({
      preheader: `${accepterName} accepted your share invitation.`,
      bodyHtml: `
        <h1 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#18181b;">Invitation accepted</h1>
        <p style="margin:0 0 12px;color:#3f3f46;">
          <strong>${accepterName}</strong> (${accepterEmail}) accepted your invitation and can now view your focus reports on GoalSlot.
        </p>
        ${this.renderCallout({
          tone: "success",
          title: "What they can see",
          html: `<ul style="margin:6px 0 0;padding-left:18px;color:#3f3f46;">
            <li>Your focus time reports and analytics.</li>
            <li>Your goals and progress.</li>
            <li>Your productivity trends.</li>
          </ul>`,
        })}
        <p style="margin:0;color:#3f3f46;">You can manage shared access anytime from the Sharing section in your dashboard.</p>
        ${this.renderButton(`${this.appUrl}/dashboard/sharing`, "Manage sharing", "left")}
      `,
    });

    const text = `${accepterName} (${accepterEmail}) accepted your GoalSlot share invitation.

They can now view your focus reports, goals, and productivity trends.

Manage shared access: ${this.appUrl}/dashboard/sharing

GoalSlot`;

    const result = await this.resend.emails.send({
      from: this.notificationEmail,
      to: toEmail,
      subject: `${accepterName} accepted your share invitation`,
      html,
      text,
    });

    if (result.error) {
      this.logger.error(
        `Resend API error for share accepted notification to ${this.maskEmail(toEmail)}: ${result.error.message}`,
      );
      throw new InternalServerErrorException(
        `Failed to send share accepted notification: ${result.error.message}`,
      );
    }

    this.logger.log(
      `Share accepted notification sent to ${this.maskEmail(toEmail)}, id: ${result.data?.id}`,
    );
  }
}
