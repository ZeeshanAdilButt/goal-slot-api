import { Injectable, NotFoundException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { v4 as uuidv4 } from 'uuid';
import { InviteUserDto } from './dto/sharing.dto';

@Injectable()
export class SharingService {
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
        OR: [
          { inviteEmail: dto.email },
          { sharedWith: { email: dto.email } },
        ],
      },
    });

    if (existingShare) {
      throw new ConflictException('User already has access or pending invitation');
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
        sharedWithId: invitedUser?.id || null, // Temp: use owner if user doesn't exist yet
        inviteEmail: invitedUser ? null : dto.email,
        inviteToken: invitedUser ? null : inviteToken,
        inviteExpires: invitedUser ? null : inviteExpires,
        isAccepted: !!invitedUser, // Auto-accept if user exists
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
        inviteToken: invitedUser ? sharedAccess.id : inviteToken, // Use share ID for existing users
        isExistingUser: !!invitedUser,
      });
      emailSent = true;
    } catch (error) {}

    return {
      ...sharedAccess,
      inviteLink: invitedUser ? null : `/share/accept?token=${inviteToken}`,
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

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.email !== invitation.inviteEmail) {
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
          owner: { select: { id: true, email: true, name: true, avatar: true } },
        },
      }),
      this.prisma.sharedAccess.findMany({
        where: { ownerId: userId },
        include: {
          sharedWith: { select: { id: true, email: true, name: true, avatar: true } },
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
      throw new ForbiddenException('You do not have access to this user\'s data');
    }

    // Get owner's data
    const [goals, recentEntries, scheduleBlocks] = await Promise.all([
      this.prisma.goal.findMany({
        where: { userId: ownerId },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.timeEntry.findMany({
        where: { userId: ownerId },
        orderBy: { date: 'desc' },
        take: 20,
        include: { goal: { select: { id: true, title: true, color: true } } },
      }),
      this.prisma.scheduleBlock.findMany({
        where: { userId: ownerId },
        orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
      }),
    ]);

    return { goals, recentEntries, scheduleBlocks };
  }

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
        sharedWith: { select: { id: true, email: true, name: true, avatar: true } },
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
        OR: [
          { inviteEmail: user.email },
          { sharedWithId: userId },
        ],
      },
      include: {
        owner: { select: { id: true, email: true, name: true, avatar: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async acceptInvite(userId: string, inviteId: string) {
    const invite = await this.prisma.sharedAccess.findFirst({
      where: {
        id: inviteId,
        OR: [
          { sharedWithId: userId },
          { inviteEmail: { not: null } },
        ],
      },
    });

    if (!invite) {
      throw new NotFoundException('Invite not found');
    }

    // Get user info for notification
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true },
    });

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

    // Notify the owner that their invite was accepted
    if (user && updatedShare.owner) {
      await this.emailService.sendShareAcceptedNotification({
        toEmail: updatedShare.owner.email,
        accepterName: user.name,
        accepterEmail: user.email,
      });
    }

    return updatedShare;
  }

  async declineInvite(userId: string, inviteId: string) {
    // Get the current user's email
    const user = await this.prisma.user.findUnique({ 
      where: { id: userId },
      select: { email: true } 
    });
    
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Find the invite - must belong to this user
    const invite = await this.prisma.sharedAccess.findFirst({
      where: {
        id: inviteId,
        OR: [
          { sharedWithId: userId },
          { inviteEmail: user.email },
        ],
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
        isAccepted: true 
      },
      include: {
        owner: { 
          select: { 
            id: true, 
            email: true, 
            name: true, 
            avatar: true 
          } 
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getSharedUserTimeEntries(
    accessorId: string, 
    ownerId: string, 
    startDate: string, 
    endDate: string
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
      throw new ForbiddenException('You do not have access to this user\'s data');
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const entries = await this.prisma.timeEntry.findMany({
      where: {
        userId: ownerId,
        date: { gte: start, lte: end },
      },
      include: {
        goal: { select: { id: true, title: true, color: true, category: true } },
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
      throw new ForbiddenException('You do not have access to this user\'s data');
    }

    return this.prisma.goal.findMany({
      where: { userId: ownerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ============ PUBLIC ACCESS METHODS (No auth required) ============

  private async verifyPublicToken(token: string) {
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

  async getPublicSharedData(token: string) {
    const share = await this.verifyPublicToken(token);
    
    return {
      owner: share.owner,
      shareId: share.id,
      createdAt: share.createdAt,
      expiresAt: share.inviteExpires,
      accessType: 'VIEW_ONLY',
    };
  }

  async getPublicSharedTimeEntries(token: string, startDate: string, endDate: string) {
    const share = await this.verifyPublicToken(token);
    
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const entries = await this.prisma.timeEntry.findMany({
      where: {
        userId: share.ownerId,
        date: { gte: start, lte: end },
      },
      include: {
        goal: { select: { id: true, title: true, color: true, category: true } },
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
}
