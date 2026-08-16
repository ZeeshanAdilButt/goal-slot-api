import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { v4 as uuidv4 } from 'uuid';
import {
  InviteUserDto,
  CreatePublicLinkDto,
  PublicLinkResponse,
  AccessLevel,
} from './dto/sharing.dto';

@Injectable()
export class SharingService {
  private readonly logger = new Logger(SharingService.name);

  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
  ) {}

  async inviteUser(ownerId: string, dto: InviteUserDto) {
    // Get owner info for the email
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { id: true, email: true, name: true },
    });

    if (!owner) {
      throw new NotFoundException('Owner not found');
    }

    // Check if already shared
    const existingShare = await this.prisma.sharedAccess.findFirst({
      where: {
        ownerId,
        OR: [{ inviteEmail: dto.email }, { sharedWith: { email: dto.email } }],
      },
    });

    if (existingShare) {
      throw new ConflictException(
        'User already has access or pending invitation',
      );
    }

    // Check if user exists
    const invitedUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    const inviteToken = uuidv4();
    const inviteExpires = new Date();
    inviteExpires.setDate(inviteExpires.getDate() + 7); // 7 days expiry

    const sharedAccess = await this.prisma.sharedAccess.create({
      data: {
        ownerId,
        sharedWithId: invitedUser?.id || null, // Set if user exists, so we know who the invite is for
        inviteEmail: dto.email, // Always set invite email for both existing and non-existing users
        inviteToken: inviteToken, // Always set invite token for both existing and non-existing users
        inviteExpires: inviteExpires, // Always set expiry for both existing and non-existing users
        accessLevel: dto.accessLevel || 'VIEW',
        isAccepted: false, // Always require explicit acceptance, even for existing users
      },
      include: {
        sharedWith: {
          select: { id: true, email: true, name: true },
        },
      },
    });

    // Send email invitation (don't fail the share if email fails)
    let emailSent = false;
    try {
      await this.emailService.sendShareInvitation({
        toEmail: dto.email,
        inviterName: owner.name,
        inviterEmail: owner.email,
        inviteToken: inviteToken, // Always use invite token for both existing and non-existing users
        isExistingUser: !!invitedUser,
      });
      emailSent = true;
    } catch {
      // Swallow send failures: the share itself still succeeds even if the
      // invite email doesn't go out, so there's nothing to handle here.
    }

    return {
      ...sharedAccess,
      inviteLink: `/share/accept?token=${inviteToken}`, // Always return invite link for both existing and non-existing users
      emailSent,
    };
  }

  async acceptInvitation(userId: string, token: string) {
    const invitation = await this.prisma.sharedAccess.findUnique({
      where: { inviteToken: token },
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.inviteExpires && invitation.inviteExpires < new Date()) {
      throw new ForbiddenException('Invitation has expired');
    }

    if (invitation.isAccepted) {
      throw new ConflictException('This invitation has already been accepted');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Check if the invitation is for this user:
    // 1. If sharedWithId is set, it must match the userId
    // 2. If inviteEmail is set, it must match the user's email
    const isForThisUser =
      (invitation.sharedWithId && invitation.sharedWithId === userId) ||
      (invitation.inviteEmail &&
        invitation.inviteEmail.toLowerCase() === user.email.toLowerCase());

    if (!isForThisUser) {
      throw new ForbiddenException('This invitation is not for you');
    }

    return this.prisma.sharedAccess.update({
      where: { id: invitation.id },
      data: {
        sharedWithId: userId,
        isAccepted: true,
        inviteToken: null,
        inviteEmail: null,
        inviteExpires: null,
      },
      include: {
        owner: { select: { id: true, email: true, name: true } },
      },
    });
  }

  async getMySharedAccess(userId: string) {
    const [sharedWithMe, sharedByMe] = await Promise.all([
      this.prisma.sharedAccess.findMany({
        where: { sharedWithId: userId, isAccepted: true },
        include: {
          owner: {
            select: { id: true, email: true, name: true, avatar: true },
          },
        },
      }),
      this.prisma.sharedAccess.findMany({
        where: { ownerId: userId },
        include: {
          sharedWith: {
            select: { id: true, email: true, name: true, avatar: true },
          },
        },
      }),
    ]);

    return { sharedWithMe, sharedByMe };
  }

  async getSharedUserData(accessorId: string, ownerId: string) {
    // Verify access
    const hasAccess = await this.prisma.sharedAccess.findFirst({
      where: {
        ownerId,
        sharedWithId: accessorId,
        isAccepted: true,
      },
    });

    if (!hasAccess) {
      throw new ForbiddenException(
        "You do not have access to this user's data",
      );
    }

    // Get owner's data. Private schedule blocks (and time entries
    // linked to them) are hidden from the accessor; the owner controls
    // which blocks count as private via the isPrivate flag on each block.
    const [goals, recentEntries, scheduleBlocks] = await Promise.all([
      this.prisma.goal.findMany({
        where: { userId: ownerId },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.timeEntry.findMany({
        where: {
          userId: ownerId,
          OR: [
            { scheduleBlockId: null },
            { scheduleBlock: { isPrivate: false } },
          ],
        },
        orderBy: { date: 'desc' },
        take: 20,
        include: { goal: { select: { id: true, title: true, color: true } } },
      }),
      this.prisma.scheduleBlock.findMany({
        where: { userId: ownerId, isPrivate: false },
        orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
      }),
    ]);

    return { goals, recentEntries, scheduleBlocks };
  }

  // revokeAccess and removeMyAccess both delete the SharedAccess row
  // outright, with nothing else to do for messaging: MessagingService's
  // canMessage (and the internal conversation-gate endpoint it backs) both
  // query this same table live, so any existing jiffy-messaging
  // conversation between these two users stops accepting new messages the
  // next time either of them tries to send one — jiffy-messaging re-runs
  // the gate check on every send, not only when the conversation was
  // created. No explicit "close the conversation" call is needed here.
  async revokeAccess(ownerId: string, shareId: string) {
    const share = await this.prisma.sharedAccess.findFirst({
      where: { id: shareId, ownerId },
    });

    if (!share) {
      throw new NotFoundException('Share not found');
    }

    await this.prisma.sharedAccess.delete({ where: { id: shareId } });
    return { message: 'Access revoked successfully' };
  }

  async removeMyAccess(userId: string, shareId: string) {
    const share = await this.prisma.sharedAccess.findFirst({
      where: { id: shareId, sharedWithId: userId },
    });

    if (!share) {
      throw new NotFoundException('Share not found');
    }

    await this.prisma.sharedAccess.delete({ where: { id: shareId } });
    return { message: 'Access removed successfully' };
  }

  async getMyShares(ownerId: string) {
    return this.prisma.sharedAccess.findMany({
      where: { ownerId },
      include: {
        sharedWith: {
          select: { id: true, email: true, name: true, avatar: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getPendingInvites(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return [];

    // Find pending invites FOR this user (not BY this user)
    // Must NOT be the owner, and either:
    // 1. inviteEmail matches their email, OR
    // 2. sharedWithId is their ID and not yet accepted
    return this.prisma.sharedAccess.findMany({
      where: {
        ownerId: { not: userId }, // Exclude invites created BY this user
        isAccepted: false,
        OR: [{ inviteEmail: user.email }, { sharedWithId: userId }],
      },
      include: {
        owner: { select: { id: true, email: true, name: true, avatar: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async acceptInvite(userId: string, inviteId: string) {
    // Get user info first to verify email
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const invite = await this.prisma.sharedAccess.findFirst({
      where: {
        id: inviteId,
        isAccepted: false, // Must not be already accepted
        OR: [
          { sharedWithId: userId },
          { inviteEmail: user.email }, // Verify invite email matches user's email
        ],
      },
    });

    if (!invite) {
      throw new NotFoundException('Invite not found or already accepted');
    }

    const updatedShare = await this.prisma.sharedAccess.update({
      where: { id: inviteId },
      data: {
        sharedWithId: userId,
        isAccepted: true,
        inviteToken: null,
        inviteEmail: null,
        inviteExpires: null,
      },
      include: {
        owner: { select: { id: true, email: true, name: true } },
      },
    });

    // Notify the owner that their invite was accepted.
    // Email is best-effort: a notification failure (Resend unreachable, key
    // misconfigured, sandbox restriction) must not roll back the user's
    // already-completed accept, which would surface as "Failed to accept invite"
    // even though the DB row is already flipped.
    if (user && updatedShare.owner) {
      try {
        await this.emailService.sendShareAcceptedNotification({
          toEmail: updatedShare.owner.email,
          accepterName: user.name,
          accepterEmail: user.email,
        });
      } catch (err) {
        // Logged here, swallowed for the request.
        this.logger.warn(
          `acceptInvite: notification email failed (accept succeeded): ${err?.message ?? err}`,
        );
      }
    }

    return updatedShare;
  }

  async declineInvite(userId: string, inviteId: string) {
    // Get the current user's email
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Find the invite - must belong to this user
    const invite = await this.prisma.sharedAccess.findFirst({
      where: {
        id: inviteId,
        OR: [{ sharedWithId: userId }, { inviteEmail: user.email }],
      },
    });

    if (!invite) {
      throw new NotFoundException('Invite not found');
    }

    await this.prisma.sharedAccess.delete({ where: { id: inviteId } });
    return { success: true, message: 'Invite declined' };
  }

  async getSharedWithMe(userId: string) {
    return this.prisma.sharedAccess.findMany({
      where: {
        sharedWithId: userId,
        isAccepted: true,
      },
      select: {
        id: true,
        ownerId: true,
        createdAt: true,
        accessLevel: true,
        owner: {
          select: {
            id: true,
            email: true,
            name: true,
            avatar: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getSharedUserTimeEntries(
    accessorId: string,
    ownerId: string,
    startDate: string,
    endDate: string,
  ) {
    // Verify access
    const hasAccess = await this.prisma.sharedAccess.findFirst({
      where: {
        ownerId,
        sharedWithId: accessorId,
        isAccepted: true,
      },
    });

    if (!hasAccess) {
      throw new ForbiddenException(
        "You do not have access to this user's data",
      );
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    // Drop entries linked to a private schedule block. Entries with no
    // schedule block linkage stay visible (they were tracked manually).
    const entries = await this.prisma.timeEntry.findMany({
      where: {
        userId: ownerId,
        date: { gte: start, lte: end },
        OR: [
          { scheduleBlockId: null },
          { scheduleBlock: { isPrivate: false } },
        ],
      },
      include: {
        goal: {
          select: { id: true, title: true, color: true, category: true },
        },
        task: { select: { id: true, title: true } },
      },
      orderBy: { date: 'desc' },
    });

    return entries;
  }

  async getSharedUserGoals(accessorId: string, ownerId: string) {
    // Verify access
    const hasAccess = await this.prisma.sharedAccess.findFirst({
      where: {
        ownerId,
        sharedWithId: accessorId,
        isAccepted: true,
      },
    });

    if (!hasAccess) {
      throw new ForbiddenException(
        "You do not have access to this user's data",
      );
    }

    return this.prisma.goal.findMany({
      where: { userId: ownerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ============ PUBLIC ACCESS METHODS (No auth required) ============

  // Looks up a SharedAccess row by inviteToken with no isPublicLink
  // filter, for the metadata-only view (getPublicSharedData). That
  // response carries no goals/time entries - just the owner's
  // name/email/avatar and the invite's status flags - so it's safe to
  // resolve for a personal email invite too. The web /share/accept page
  // depends on this succeeding for personal invites specifically: that's
  // what lets it render the "create an account or log in to accept"
  // prompt instead of a dead end. Anyone resolving this already holds the
  // token (a UUID emailed only to the invitee), so this doesn't add a new
  // exposure - the two endpoints below are where actual owner data lives,
  // and they keep the stricter check.
  private async lookupShareByToken(token: string) {
    const share = await this.prisma.sharedAccess.findUnique({
      where: { inviteToken: token },
      include: {
        owner: { select: { id: true, email: true, name: true, avatar: true } },
      },
    });

    if (!share) {
      throw new NotFoundException('Invalid or expired share link');
    }

    if (share.inviteExpires && share.inviteExpires < new Date()) {
      throw new ForbiddenException('This share link has expired');
    }

    return share;
  }

  private async verifyPublicToken(token: string) {
    // inviteToken is also set on personal email invitations (see
    // inviteUser above), not just genuine public share links. Without the
    // isPublicLink filter, a personal invite token would resolve through
    // this unauthenticated path before the invite was ever accepted -
    // exposing the owner's goals/time entries to anyone holding the
    // token (forwarded mail, mail-scanning proxies, browser history).
    // getPublicSharedData does NOT go through this check anymore - see
    // lookupShareByToken above for why the metadata view is exempt.
    const share = await this.lookupShareByToken(token);

    if (!share.isPublicLink) {
      throw new NotFoundException('Invalid or expired share link');
    }

    return share;
  }

  async getPublicSharedData(token: string) {
    const share = await this.lookupShareByToken(token);

    return {
      owner: share.owner,
      shareId: share.id,
      createdAt: share.createdAt,
      expiresAt: share.inviteExpires,
      accessType: 'VIEW_ONLY',
      isAccepted: share.isAccepted,
      inviteEmail: share.inviteEmail,
      isPublicLink: share.isPublicLink || false,
    };
  }

  async getPublicSharedTimeEntries(
    token: string,
    startDate: string,
    endDate: string,
  ) {
    const share = await this.verifyPublicToken(token);

    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    // Public-link viewers also do not see entries tied to private blocks.
    const entries = await this.prisma.timeEntry.findMany({
      where: {
        userId: share.ownerId,
        date: { gte: start, lte: end },
        OR: [
          { scheduleBlockId: null },
          { scheduleBlock: { isPrivate: false } },
        ],
      },
      include: {
        goal: {
          select: { id: true, title: true, color: true, category: true },
        },
        task: { select: { id: true, title: true } },
      },
      orderBy: { date: 'desc' },
    });

    return entries;
  }

  async getPublicSharedGoals(token: string) {
    const share = await this.verifyPublicToken(token);

    return this.prisma.goal.findMany({
      where: { userId: share.ownerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ============ PUBLIC LINK MANAGEMENT ============

  async createPublicLink(
    ownerId: string,
    dto: CreatePublicLinkDto,
  ): Promise<PublicLinkResponse> {
    const token = uuidv4();
    const expiresInDays = dto.expiresInDays || 30;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    const sharedAccess = await this.prisma.sharedAccess.create({
      data: {
        ownerId,
        inviteToken: token,
        inviteExpires: expiresAt,
        accessLevel: dto.accessLevel || 'VIEW',
        isPublicLink: true,
        isAccepted: false, // Public links don't need acceptance
      },
    });

    return {
      id: sharedAccess.id,
      publicLink: `/share/accept?token=${token}`,
      token,
      expiresAt,
      accessLevel: dto.accessLevel || AccessLevel.VIEW,
      createdAt: sharedAccess.createdAt,
    };
  }

  async getMyPublicLinks(ownerId: string) {
    const links = await this.prisma.sharedAccess.findMany({
      where: {
        ownerId,
        isPublicLink: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return links.map((link) => ({
      id: link.id,
      publicLink: `/share/accept?token=${link.inviteToken}`,
      token: link.inviteToken,
      expiresAt: link.inviteExpires,
      accessLevel: link.accessLevel,
      createdAt: link.createdAt,
      isExpired: link.inviteExpires ? link.inviteExpires < new Date() : false,
    }));
  }

  async markViewed(sharedAccessId: string, callerId: string) {
    const share = await this.prisma.sharedAccess.findUnique({
      where: { id: sharedAccessId },
    });

    if (!share) {
      throw new NotFoundException('Share not found');
    }

    // Only the mentor holding access can mark a view - not the mentee who
    // owns the data, not an unrelated user.
    if (share.sharedWithId !== callerId) {
      throw new ForbiddenException('You do not have access to this share');
    }

    return this.prisma.sharedAccess.update({
      where: { id: sharedAccessId },
      data: { lastViewedAt: new Date() },
    });
  }

  async deletePublicLink(ownerId: string, shareId: string) {
    const link = await this.prisma.sharedAccess.findFirst({
      where: {
        id: shareId,
        ownerId,
        isPublicLink: true,
      },
    });

    if (!link) {
      throw new NotFoundException('Public link not found');
    }

    await this.prisma.sharedAccess.delete({ where: { id: shareId } });
    return { message: 'Public link deleted successfully' };
  }
}
