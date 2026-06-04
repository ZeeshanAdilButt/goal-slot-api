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

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: 'Arial', sans-serif; line-height: 1.6; color: #1a1a1a; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #FFD700; padding: 20px; border: 3px solid #1a1a1a; margin-bottom: 20px; }
            .header h1 { margin: 0; font-size: 24px; text-transform: uppercase; }
            .content { background: #fff; padding: 20px; border: 3px solid #1a1a1a; }
            .button { 
              display: inline-block; 
              background: #FFD700; 
              color: #1a1a1a; 
              padding: 12px 24px; 
              text-decoration: none; 
              font-weight: bold; 
              text-transform: uppercase;
              border: 3px solid #1a1a1a;
              margin: 20px 0;
            }
            .button:hover { background: #e6c200; }
            .security-note { 
              background: #f0f0f0; 
              padding: 15px; 
              border: 2px solid #1a1a1a; 
              margin: 20px 0;
              font-size: 14px;
            }
            .footer { margin-top: 20px; font-size: 12px; color: #666; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Goal Slot</h1>
            </div>
            <div class="content">
              <h2>You've Been Invited to View Focus Reports!</h2>
              
              <p>Hi there!</p>
              
              <p><strong>${inviterName}</strong> (${inviterEmail}) has invited you to view their focus time reports and productivity data on Goal Slot.</p>
              
              <p>Click the button below to access their shared reports:</p>
              
              <a href="${viewLink}" class="button">View Shared Reports →</a>
              
              <div class="security-note">
                <strong>🔒 Security Note:</strong>
                <ul style="margin: 10px 0; padding-left: 20px;">
                  <li>This link contains a secure, unique code for <strong>view-only access</strong></li>
                  <li>You can view reports without creating an account</li>
                  <li>The link expires in 7 days for security</li>
                  ${!isExistingUser ? "<li>Sign up for a free account to track your own focus time and unlock full features!</li>" : ""}
                </ul>
              </div>
              
              <p>If the button doesn't work, copy and paste this link into your browser:</p>
              <p style="word-break: break-all; font-size: 12px; color: #666;">${viewLink}</p>
              
              <p>Happy focusing! 🎯</p>
            </div>
            <div class="footer">
              <p>This email was sent by Goal Slot. If you didn't expect this invitation, you can safely ignore it.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const text = `
You've Been Invited to View Focus Reports!

Hi there!

${inviterName} (${inviterEmail}) has invited you to view their focus time reports and productivity data on Goal Slot.

Click the link below to access their shared reports:
${viewLink}

🔒 Security Note:
- This link contains a secure, unique code for view-only access
- You can view reports without creating an account
- The link expires in 7 days for security
${!isExistingUser ? "- Sign up for a free account to track your own focus time and unlock full features!" : ""}

If you didn't expect this invitation, you can safely ignore it.

Happy focusing! 🎯
- Goal Slot
    `;

    const result = await this.resend.emails.send({
      from: this.notificationEmail,
      to: toEmail,
      subject: `${inviterName} shared their focus reports with you`,
      html,
      text,
    });

    if (result.error) {
      this.logger.error(
        `Resend API error for ${toEmail}: ${result.error.message}`,
      );
      throw new InternalServerErrorException(
        `Failed to send share invitation email: ${result.error.message}`,
      );
    }

    this.logger.log(
      `Share invitation email sent to ${toEmail}, id: ${result.data?.id}`,
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

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: 'Arial', sans-serif; line-height: 1.6; color: #1a1a1a; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #FFD700; padding: 20px; border: 3px solid #1a1a1a; margin-bottom: 20px; }
            .header h1 { margin: 0; font-size: 24px; text-transform: uppercase; }
            .content { background: #fff; padding: 20px; border: 3px solid #1a1a1a; }
            .button { display: inline-block; background: #FFD700; color: #1a1a1a; padding: 12px 24px; text-decoration: none; font-weight: bold; text-transform: uppercase; border: 3px solid #1a1a1a; margin: 20px 0; }
            .note-title { background: #fafafa; border: 2px solid #1a1a1a; padding: 12px; font-weight: bold; margin: 16px 0; }
            .footer { margin-top: 20px; font-size: 12px; color: #666; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header"><h1>Goal Slot</h1></div>
            <div class="content">
              <h2>A note has been shared with you</h2>
              <p><strong>${inviterName}</strong> (${inviterEmail}) shared a note with you on Goal Slot.</p>
              <div class="note-title">${safeTitle}</div>
              <p>${
                isExistingUser
                  ? "Open it from your Shared with me section in Notes, or click below."
                  : "You will need to sign up with this email address to view it. Sign up is quick and free."
              }</p>
              <a href="${viewLink}" class="button">${isExistingUser ? "Open the note" : "Sign up and view"}</a>
              <p style="font-size: 12px; color: #666;">If the button does not work, copy and paste this URL: ${viewLink}</p>
              <div class="footer">
                <p>You received this because someone shared a Goal Slot note with you. If this looks wrong, you can safely ignore this email.</p>
              </div>
            </div>
          </div>
        </body>
      </html>
    `;
    const text = `${inviterName} (${inviterEmail}) shared a Goal Slot note with you: "${safeTitle}".\nOpen it: ${viewLink}`;

    const result = await this.resend.emails.send({
      from: this.notificationEmail,
      to: toEmail,
      subject: `${inviterName} shared a note with you on Goal Slot`,
      html,
      text,
    });

    if (result.error) {
      this.logger.error(
        `Resend API error for note share to ${toEmail}: ${result.error.message}`,
      );
      throw new InternalServerErrorException(
        `Failed to send note share email: ${result.error.message}`,
      );
    }

    this.logger.log(
      `Note share invitation sent to ${toEmail}, id: ${result.data?.id}`,
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

    const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body { font-family: 'Arial', sans-serif; line-height: 1.6; color: #1a1a1a; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #FFD700; padding: 20px; border: 3px solid #1a1a1a; margin-bottom: 20px; }
          .header h1 { margin: 0; font-size: 24px; text-transform: uppercase; }
          .content { background: #fff; padding: 20px; border: 3px solid #1a1a1a; }
          .button { display: inline-block; background: #FFD700; color: #1a1a1a; padding: 12px 24px; text-decoration: none; font-weight: bold; text-transform: uppercase; border: 3px solid #1a1a1a; margin: 20px 0; }
          .board-title { background: #fafafa; border: 2px solid #1a1a1a; padding: 12px; font-weight: bold; margin: 16px 0; }
          .footer { margin-top: 20px; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header"><h1>Goal Slot</h1></div>
          <div class="content">
            <h2>A whiteboard has been shared with you</h2>
            <p><strong>${inviterName}</strong> (${inviterEmail}) shared a whiteboard with you on Goal Slot.</p>
            <div class="board-title">${safeTitle}</div>
            <p>${
              isExistingUser
                ? "Open it from your Shared with me section in Whiteboards, or click below."
                : "You will need to sign up with this email address to view it. Sign up is quick and free."
            }</p>
            <a href="${viewLink}" class="button">${isExistingUser ? "Open the whiteboard" : "Sign up and view"}</a>
            <p style="font-size: 12px; color: #666;">If the button does not work, copy and paste this URL: ${viewLink}</p>
            <div class="footer">
              <p>You received this because someone shared a Goal Slot whiteboard with you. If this looks wrong, you can safely ignore this email.</p>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;

    const text = `${inviterName} (${inviterEmail}) shared a Goal Slot whiteboard with you: "${safeTitle}".\nOpen it: ${viewLink}`;

    const result = await this.resend.emails.send({
      from: this.notificationEmail,
      to: toEmail,
      subject: `${inviterName} shared a whiteboard with you on Goal Slot`,
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
  // Bulk-invite welcome. Sent after an admin pre-creates the account.
  // The recipient already has a User row (email-verified, PRO access),
  // so the email's job is to (a) tell them they were invited, (b) point
  // them at the forgot-password flow so they can set a password and log
  // in. We deliberately do not include the temp random password.
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

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: 'Arial', sans-serif; line-height: 1.6; color: #1a1a1a; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #FFD700; padding: 20px; border: 3px solid #1a1a1a; margin-bottom: 20px; }
            .header h1 { margin: 0; font-size: 24px; text-transform: uppercase; }
            .content { background: #fff; padding: 20px; border: 3px solid #1a1a1a; }
            .button { display: inline-block; background: #FFD700; color: #1a1a1a; padding: 12px 24px; text-decoration: none; font-weight: bold; text-transform: uppercase; border: 3px solid #1a1a1a; margin: 12px 0; }
            .step { background: #fafafa; border: 2px solid #1a1a1a; padding: 14px; margin: 14px 0; }
            .footer { margin-top: 20px; font-size: 12px; color: #666; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header"><h1>Goal Slot</h1></div>
            <div class="content">
              <h2>Welcome to Goal Slot</h2>
              <p>${inviterName} (${inviterEmail}) invited you to join Goal Slot. ${roleLine}</p>
              <div class="step">
                <p style="margin: 0;"><strong>Step 1.</strong> Set your password by clicking the button below. Use this email address (${toEmail}) when prompted.</p>
                <p style="text-align: center;"><a href="${setPasswordLink}" class="button">Set my password</a></p>
              </div>
              <div class="step">
                <p style="margin: 0;"><strong>Step 2.</strong> Once your password is set, log in here: <a href="${loginLink}">${loginLink}</a></p>
              </div>
              <p style="font-size: 12px; color: #666;">Your account already exists, you just need a password to log in. If the button does not work, paste this URL into your browser: ${setPasswordLink}</p>
              <div class="footer">
                <p>You received this because an admin added you to Goal Slot. If you were not expecting this, you can ignore the email and the pre-created account will sit unused.</p>
              </div>
            </div>
          </div>
        </body>
      </html>
    `;
    const text = `${inviterName} (${inviterEmail}) invited you to Goal Slot. ${roleLine}\n\nStep 1: set your password at ${setPasswordLink}\nStep 2: log in at ${loginLink}\n\nUse this email address when prompted: ${toEmail}`;

    const result = await this.resend.emails.send({
      from: this.onboardingEmail,
      to: toEmail,
      subject: `${inviterName} invited you to Goal Slot`,
      html,
      text,
    });

    if (result.error) {
      this.logger.error(
        `Resend API error for bulk invite to ${toEmail}: ${result.error.message}`,
      );
      throw new InternalServerErrorException(
        `Failed to send bulk invite email: ${result.error.message}`,
      );
    }

    this.logger.log(
      `Bulk invite email sent to ${toEmail}, id: ${result.data?.id}`,
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
      purpose === "signup" ? "Email Verification" : "Password Reset";
    const purposeDescription =
      purpose === "signup"
        ? "to complete your registration"
        : "to reset your password";

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: 'Arial', sans-serif; line-height: 1.6; color: #1a1a1a; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #FFD700; padding: 20px; border: 3px solid #1a1a1a; margin-bottom: 20px; text-align: center; }
            .header h1 { margin: 0; font-size: 24px; text-transform: uppercase; }
            .content { background: #fff; padding: 30px; border: 3px solid #1a1a1a; }
            .otp-box { 
              background: #FFD700; 
              border: 3px solid #1a1a1a; 
              padding: 25px; 
              text-align: center; 
              margin: 25px 0;
            }
            .otp-code { 
              font-size: 36px; 
              font-weight: bold; 
              letter-spacing: 8px; 
              color: #1a1a1a;
              font-family: monospace;
            }
            .security-note { 
              background: #f0f0f0; 
              padding: 15px; 
              border: 2px solid #1a1a1a; 
              margin: 20px 0;
              font-size: 14px;
            }
            .footer { margin-top: 20px; font-size: 12px; color: #666; text-align: center; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🎯 Goal Slot</h1>
            </div>
            <div class="content">
              <h2>${purposeText}</h2>
              
              <p>Your verification code ${purposeDescription} is:</p>
              
              <div class="otp-box">
                <div class="otp-code">${otp}</div>
              </div>
              
              <div class="security-note">
                <strong>🔒 Security Information:</strong>
                <ul style="margin: 10px 0; padding-left: 20px;">
                  <li>This code expires in <strong>5 minutes</strong></li>
                  <li>Do not share this code with anyone</li>
                  <li>If you didn't request this code, you can safely ignore this email</li>
                  <li>This code can only be used once</li>
                </ul>
              </div>
              
              <p>Having trouble? Contact us at Goal Slot for support.</p>
            </div>
            <div class="footer">
              <p>This email was sent by Goal Slot. If you didn't request this verification code, please ignore this email.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const text = `
Goal Slot - ${purposeText}

Your verification code ${purposeDescription} is:

${otp}

🔒 Security Information:
- This code expires in 5 minutes
- Do not share this code with anyone
- If you didn't request this code, you can safely ignore this email
- This code can only be used once

Having trouble? Contact us at Goal Slot for support.
    `;

    this.logger.log(
      `Attempting to send OTP email (${purpose}) to ${toEmail} from ${this.onboardingEmail}`,
    );
    const start = Date.now();
    const result = await this.resend.emails.send({
      from: this.onboardingEmail,
      to: toEmail,
      subject: `Your Goal Slot verification code: ${otp}`,
      html,
      text,
    });
    this.logger.log(
      `Resend send for OTP to ${toEmail} took ${Date.now() - start} ms`,
    );

    if (result.error) {
      this.logger.error(
        `Resend API error for OTP email to ${toEmail}: ${result.error.message}`,
      );
      throw new InternalServerErrorException(
        `Failed to send OTP email: ${result.error.message}`,
      );
    }

    this.logger.log(`OTP email sent to ${toEmail}, id: ${result.data?.id}`);
    return { success: true, id: result.data?.id };
  }

  async sendWelcomeEmail(params: { toEmail: string; userName: string }) {
    const { toEmail, userName } = params;

    const dashboardLink = `${this.appUrl}/dashboard`;
    const firstName = userName.split(" ")[0];

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: 'Arial', sans-serif; line-height: 1.6; color: #1a1a1a; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #FFD700; padding: 30px 20px; border: 3px solid #1a1a1a; margin-bottom: 20px; text-align: center; }
            .header h1 { margin: 0; font-size: 28px; text-transform: uppercase; }
            .header p { margin: 10px 0 0; font-size: 14px; }
            .content { background: #fff; padding: 30px; border: 3px solid #1a1a1a; }
            .welcome-badge { 
              background: #4ECDC4; 
              color: #1a1a1a; 
              padding: 10px 20px; 
              display: inline-block; 
              font-weight: bold; 
              border: 2px solid #1a1a1a;
              text-transform: uppercase;
              font-size: 12px;
            }
            .feature-grid { margin: 25px 0; }
            .feature { 
              background: #f8f8f8; 
              border: 2px solid #1a1a1a; 
              padding: 15px; 
              margin-bottom: 10px;
            }
            .feature h3 { margin: 0 0 5px; font-size: 16px; }
            .feature p { margin: 0; font-size: 14px; color: #666; }
            .button { 
              display: inline-block; 
              background: #FFD700; 
              color: #1a1a1a; 
              padding: 15px 30px; 
              text-decoration: none; 
              font-weight: bold; 
              text-transform: uppercase;
              border: 3px solid #1a1a1a;
              margin: 25px 0;
              font-size: 16px;
            }
            .tips { 
              background: #f0f0f0; 
              padding: 20px; 
              border: 2px solid #1a1a1a; 
              margin: 20px 0;
            }
            .tips h3 { margin: 0 0 10px; font-size: 14px; text-transform: uppercase; }
            .tips ul { margin: 0; padding-left: 20px; }
            .tips li { margin-bottom: 8px; font-size: 14px; }
            .footer { margin-top: 20px; font-size: 12px; color: #666; text-align: center; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🎯 Goal Slot</h1>
              <p>Master Your Focus. Own Your Time.</p>
            </div>
            <div class="content">
              <span class="welcome-badge">🎉 Welcome Aboard!</span>
              
              <h2 style="margin-top: 20px;">Hey ${firstName}!</h2>
              
              <p>Welcome to <strong>Goal Slot</strong> — your new companion for deep focus and intentional time management. We're excited to have you on this journey toward mastering your productivity!</p>
              
              <div class="feature-grid">
                <div class="feature">
                  <h3>⏱️ Track Focus Time</h3>
                  <p>Log your focus sessions and see exactly where your time goes</p>
                </div>
                <div class="feature">
                  <h3>🎯 Set Goals</h3>
                  <p>Create weekly goals and track your progress toward mastery</p>
                </div>
                <div class="feature">
                  <h3>📊 View Reports</h3>
                  <p>Beautiful charts and insights to understand your productivity patterns</p>
                </div>
                <div class="feature">
                  <h3>🤝 Share Progress</h3>
                  <p>Share reports with mentors, coaches, or accountability partners</p>
                </div>
              </div>
              
              <div style="text-align: center;">
                <a href="${dashboardLink}" class="button">Start Tracking →</a>
              </div>
              
              <div class="tips">
                <h3>💡 Pro Tips to Get Started</h3>
                <ul>
                  <li><strong>Create your first goal</strong> — What skill do you want to master?</li>
                  <li><strong>Log a focus session</strong> — Even 15 minutes counts!</li>
                  <li><strong>Set up your schedule</strong> — Block time for deep work</li>
                  <li><strong>Check your reports weekly</strong> — Progress fuels motivation</li>
                </ul>
              </div>
              
              <p>Remember: Consistency beats intensity. Small daily focus sessions add up to massive results over time. 🚀</p>
              
              <p>Happy focusing!</p>
              <p><strong>The Goal Slot Team</strong></p>
            </div>
            <div class="footer">
              <p>You're receiving this because you signed up for Goal Slot.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const text = `
Welcome to Goal Slot, ${firstName}! 🎯

We're excited to have you on this journey toward mastering your productivity!

Here's what you can do with Goal Slot:

⏱️ Track Focus Time - Log your focus sessions and see exactly where your time goes
🎯 Set Goals - Create weekly goals and track your progress toward mastery
📊 View Reports - Beautiful charts and insights to understand your productivity patterns
🤝 Share Progress - Share reports with mentors, coaches, or accountability partners

💡 Pro Tips to Get Started:
• Create your first goal — What skill do you want to master?
• Log a focus session — Even 15 minutes counts!
• Set up your schedule — Block time for deep work
• Check your reports weekly — Progress fuels motivation

Start tracking: ${dashboardLink}

Remember: Consistency beats intensity. Small daily focus sessions add up to massive results over time. 🚀

Happy focusing!
The Goal Slot Team
    `;

    const result = await this.resend.emails.send({
      from: this.onboardingEmail,
      to: toEmail,
      subject: `Welcome to Goal Slot, ${firstName}! 🎯`,
      html,
      text,
    });

    if (result.error) {
      this.logger.error(
        `Resend API error for welcome email to ${toEmail}: ${result.error.message}`,
      );
      throw new InternalServerErrorException(
        `Failed to send welcome email: ${result.error.message}`,
      );
    }

    this.logger.log(`Welcome email sent to ${toEmail}, id: ${result.data?.id}`);
    return { success: true, id: result.data?.id };
  }

  async sendShareAcceptedNotification(params: {
    toEmail: string;
    accepterName: string;
    accepterEmail: string;
  }) {
    const { toEmail, accepterName, accepterEmail } = params;

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: 'Arial', sans-serif; line-height: 1.6; color: #1a1a1a; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #4ECDC4; padding: 20px; border: 3px solid #1a1a1a; margin-bottom: 20px; }
            .header h1 { margin: 0; font-size: 24px; text-transform: uppercase; color: #1a1a1a; }
            .content { background: #fff; padding: 20px; border: 3px solid #1a1a1a; }
            .success-badge { background: #4ECDC4; color: #1a1a1a; padding: 10px 20px; display: inline-block; font-weight: bold; border: 2px solid #1a1a1a; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Goal Slot</h1>
            </div>
            <div class="content">
              <span class="success-badge">✓ Invitation Accepted</span>
              
              <h2 style="margin-top: 20px;">Good news!</h2>
              
              <p><strong>${accepterName}</strong> (${accepterEmail}) has accepted your invitation and can now view your focus reports.</p>
              
              <p>They now have access to:</p>
              <ul>
                <li>Your focus time reports and analytics</li>
                <li>Your goals and progress</li>
                <li>Your productivity trends</li>
              </ul>
              
              <p>You can manage your shared access anytime from the Sharing section in your dashboard.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const result = await this.resend.emails.send({
      from: this.notificationEmail,
      to: toEmail,
      subject: `${accepterName} accepted your share invitation`,
      html,
    });

    if (result.error) {
      this.logger.error(
        `Resend API error for share accepted notification to ${toEmail}: ${result.error.message}`,
      );
      throw new InternalServerErrorException(
        `Failed to send share accepted notification: ${result.error.message}`,
      );
    }

    this.logger.log(
      `Share accepted notification sent to ${toEmail}, id: ${result.data?.id}`,
    );
  }
}
