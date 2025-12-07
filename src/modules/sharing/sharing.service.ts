import { Injectable, NotFoundException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';
import { InviteUserDto } from './dto/sharing.dto';

@Injectable()
export class SharingService {
  constructor(private prisma: PrismaService) {}

  async inviteUser(ownerId: string, dto: InviteUserDto) {
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
        sharedWithId: invitedUser?.id || ownerId, // Temp: use owner if user doesn't exist yet
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

    // In production, send email invitation here
    // await this.emailService.sendShareInvitation(dto.email, inviteToken, owner);

    return {
      ...sharedAccess,
      inviteLink: invitedUser ? null : `/share/accept?token=${inviteToken}`,
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

    // Find shares where inviteEmail matches user's email and not yet accepted
    return this.prisma.sharedAccess.findMany({
      where: {
        OR: [
          { inviteEmail: user.email },
          { sharedWithId: userId, isAccepted: false },
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

    return this.prisma.sharedAccess.update({
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
  }

  async declineInvite(userId: string, inviteId: string) {
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

    await this.prisma.sharedAccess.delete({ where: { id: inviteId } });
    return { message: 'Invite declined' };
  }
}
