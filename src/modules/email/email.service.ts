import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private resend: Resend;
  private fromEmail = 'DW Time Master <onboarding@resend.dev>';
  private appUrl = process.env.APP_URL || 'http://localhost:3000';

  constructor() {
    this.resend = new Resend(process.env.RESEND_API_KEY || 're_d9RuCzwu_4pwg4XzPY4hz3qCcgDgR8swx');
  }

  async sendShareInvitation(params: {
    toEmail: string;
    inviterName: string;
    inviterEmail: string;
    inviteToken: string;
    isExistingUser: boolean;
  }) {
    const { toEmail, inviterName, inviterEmail, inviteToken, isExistingUser } = params;
    
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
              <h1>📊 DW Time Master</h1>
            </div>
            <div class="content">
              <h2>You've Been Invited to View Focus Reports!</h2>
              
              <p>Hi there!</p>
              
              <p><strong>${inviterName}</strong> (${inviterEmail}) has invited you to view their focus time reports and productivity data on DW Time Master.</p>
              
              <p>Click the button below to access their shared reports:</p>
              
              <a href="${viewLink}" class="button">View Shared Reports →</a>
              
              <div class="security-note">
                <strong>🔒 Security Note:</strong>
                <ul style="margin: 10px 0; padding-left: 20px;">
                  <li>This link contains a secure, unique code for <strong>view-only access</strong></li>
                  <li>You can view reports without creating an account</li>
                  <li>The link expires in 7 days for security</li>
                  ${!isExistingUser ? '<li>Sign up for a free account to track your own focus time and unlock full features!</li>' : ''}
                </ul>
              </div>
              
              <p>If the button doesn't work, copy and paste this link into your browser:</p>
              <p style="word-break: break-all; font-size: 12px; color: #666;">${viewLink}</p>
              
              <p>Happy focusing! 🎯</p>
            </div>
            <div class="footer">
              <p>This email was sent by DW Time Master. If you didn't expect this invitation, you can safely ignore it.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const text = `
You've Been Invited to View Focus Reports!

Hi there!

${inviterName} (${inviterEmail}) has invited you to view their focus time reports and productivity data on DW Time Master.

Click the link below to access their shared reports:
${viewLink}

🔒 Security Note:
- This link contains a secure, unique code for view-only access
- You can view reports without creating an account
- The link expires in 7 days for security
${!isExistingUser ? '- Sign up for a free account to track your own focus time and unlock full features!' : ''}

If you didn't expect this invitation, you can safely ignore it.

Happy focusing! 🎯
- DW Time Master
    `;

    try {
      this.logger.log(`Attempting to send share invitation email to ${toEmail} from ${this.fromEmail}`);
      const result = await this.resend.emails.send({
        from: this.fromEmail,
        to: toEmail,
        subject: `${inviterName} shared their focus reports with you`,
        html,
        text,
      });
      
      if (result.error) {
        this.logger.error(`Resend API error for ${toEmail}:`, result.error);
        return { success: false, error: result.error.message };
      }
      
      this.logger.log(`Share invitation email sent to ${toEmail}, id: ${result.data?.id}`);
      return { success: true, id: result.data?.id };
    } catch (error) {
      this.logger.error(`Failed to send share invitation email to ${toEmail}:`, error);
      // Don't throw - we don't want to fail the share if email fails
      return { success: false, error: error.message };
    }
  }

  async sendWelcomeEmail(params: {
    toEmail: string;
    userName: string;
  }) {
    const { toEmail, userName } = params;

    const dashboardLink = `${this.appUrl}/dashboard`;
    const firstName = userName.split(' ')[0];

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
              <h1>🎯 DW Time Master</h1>
              <p>Master Your Focus. Own Your Time.</p>
            </div>
            <div class="content">
              <span class="welcome-badge">🎉 Welcome Aboard!</span>
              
              <h2 style="margin-top: 20px;">Hey ${firstName}!</h2>
              
              <p>Welcome to <strong>DW Time Master</strong> — your new companion for deep focus and intentional time management. We're excited to have you on this journey toward mastering your productivity!</p>
              
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
              <p><strong>The DW Time Master Team</strong></p>
            </div>
            <div class="footer">
              <p>You're receiving this because you signed up for DW Time Master.</p>
              <p>Questions? Just reply to this email — we're here to help!</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const text = `
Welcome to DW Time Master, ${firstName}! 🎯

We're excited to have you on this journey toward mastering your productivity!

Here's what you can do with DW Time Master:

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
The DW Time Master Team
    `;

    try {
      const result = await this.resend.emails.send({
        from: this.fromEmail,
        to: toEmail,
        subject: `Welcome to DW Time Master, ${firstName}! 🎯`,
        html,
        text,
      });
      
      this.logger.log(`Welcome email sent to ${toEmail}, id: ${result.data?.id}`);
      return { success: true, id: result.data?.id };
    } catch (error) {
      this.logger.error(`Failed to send welcome email to ${toEmail}:`, error);
      return { success: false, error: error.message };
    }
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
              <h1>📊 DW Time Master</h1>
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

    try {
      await this.resend.emails.send({
        from: this.fromEmail,
        to: toEmail,
        subject: `${accepterName} accepted your share invitation`,
        html,
      });
      
      this.logger.log(`Share accepted notification sent to ${toEmail}`);
    } catch (error) {
      this.logger.error(`Failed to send share accepted notification to ${toEmail}:`, error);
    }
  }
}
