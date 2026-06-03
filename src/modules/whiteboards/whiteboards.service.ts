import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  PayloadTooLargeException,
} from "@nestjs/common";
import { randomBytes } from "crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import {
  CreateWhiteboardDto,
  UpdateWhiteboardDto,
} from "./dto/whiteboards.dto";

@Injectable()
export class WhiteboardsService {
  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
  ) {}

  async findAll(userId: string) {
    return this.prisma.whiteboard.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ createdAt: "desc" }],
    });
  }

  async findOne(id: string, userId: string) {
    const whiteboard = await this.prisma.whiteboard.findUnique({
      where: { id },
    });

    if (!whiteboard || whiteboard.deletedAt) {
      throw new NotFoundException("Whiteboard not found");
    }

    if (whiteboard.userId !== userId) {
      throw new ForbiddenException("You do not have access to this whiteboard");
    }

    return whiteboard;
  }

  async findOneAccessible(id: string, userId: string) {
    const whiteboard = await this.prisma.whiteboard.findUnique({
      where: { id },
    });

    if (!whiteboard || whiteboard.deletedAt) {
      throw new NotFoundException("Whiteboard not found");
    }

    if (whiteboard.userId === userId) {
      return { whiteboard, readOnly: false };
    }

    const share = await this.prisma.whiteboardShare.findFirst({
      where: {
        whiteboardId: id,
        recipientUserId: userId,
        revokedAt: null,
      },
    });

    if (!share) {
      throw new NotFoundException("Whiteboard not found");
    }

    if (!share.acceptedAt) {
      await this.prisma.whiteboardShare.update({
        where: { id: share.id },
        data: { acceptedAt: new Date() },
      });
    }

    return { whiteboard, readOnly: true };
  }

  async create(userId: string, dto: CreateWhiteboardDto) {
    return this.prisma.whiteboard.create({
      data: {
        title: dto.title,
        icon: dto.icon,
        color: dto.color,
        userId,
      },
    });
  }

  async update(id: string, userId: string, dto: UpdateWhiteboardDto) {
    // Reject oversized scene payloads
    if (dto.content && JSON.stringify(dto.content).length > 2_000_000) {
      throw new PayloadTooLargeException(
        "Whiteboard content exceeds the 2 MB limit. Try removing large images.",
      );
    }
    await this.findOne(id, userId);

    return this.prisma.whiteboard.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.content !== undefined && { content: dto.content as any }),
        ...(dto.icon !== undefined && { icon: dto.icon }),
        ...(dto.color !== undefined && { color: dto.color }),
        ...(dto.isFavorite !== undefined && { isFavorite: dto.isFavorite }),
      },
    });
  }

  async delete(id: string, userId: string) {
    await this.findOne(id, userId);

    return this.prisma.$transaction([
      // soft delete the whiteboard + clear public token
      this.prisma.whiteboard.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          deletedReason: "User deleted",
          deletedByUserId: userId,
          publicShareToken: null, // token can't be used after deletion
        },
      }),
      // revoke all active shares
      this.prisma.whiteboardShare.updateMany({
        where: { whiteboardId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }

  // Sharing

  async enablePublicLink(whiteboardId: string, userId: string) {
    await this.findOne(whiteboardId, userId);
    const existing = await this.prisma.whiteboard.findUnique({
      where: { id: whiteboardId },
      select: { publicShareToken: true },
    });
    const token = existing?.publicShareToken ?? this.generateToken();
    if (!existing?.publicShareToken) {
      await this.prisma.whiteboard.update({
        where: { id: whiteboardId },
        data: { publicShareToken: token },
      });
    }
    return { token };
  }

  async revokePublicLink(whiteboardId: string, userId: string) {
    await this.findOne(whiteboardId, userId);
    await this.prisma.whiteboard.update({
      where: { id: whiteboardId },
      data: { publicShareToken: null },
    });
    return { success: true };
  }

  async getShareState(whiteboardId: string, userId: string) {
    await this.findOne(whiteboardId, userId);
    const [whiteboard, shares] = await Promise.all([
      this.prisma.whiteboard.findUnique({
        where: { id: whiteboardId },
        select: { publicShareToken: true },
      }),
      this.prisma.whiteboardShare.findMany({
        where: { whiteboardId, revokedAt: null },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          recipientEmail: true,
          recipientUserId: true,
          permission: true,
          acceptedAt: true,
          createdAt: true,
        },
      }),
    ]);
    return {
      publicShareToken: whiteboard?.publicShareToken ?? null,
      shares,
    };
  }

  async invite(whiteboardId: string, ownerId: string, rawEmail: string) {
    const email = rawEmail.trim().toLowerCase();
    if (!email) {
      throw new BadRequestException("Email is required");
    }
    await this.findOne(whiteboardId, ownerId);

    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { email: true, name: true },
    });
    if (!owner) {
      throw new NotFoundException("Owner not found");
    }
    if (owner.email.toLowerCase() === email) {
      throw new BadRequestException(
        "You cannot share a whiteboard with yourself",
      );
    }

    const recipientUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    const share = await this.prisma.whiteboardShare.upsert({
  where: {
    whiteboardId_recipientEmail: { whiteboardId, recipientEmail: email },
  },
  update: {
    revokedAt: null,
    acceptedAt: null,
    recipientUserId: recipientUser?.id ?? null,
  },
  create: {
    whiteboardId,
    ownerId,
    recipientEmail: email,
    recipientUserId: recipientUser?.id ?? null,
  },
});

// Best-effort email. If Resend is misconfigured we still want the
// share record to exist so the recipient can find it in-app.
let emailSent = false;
let emailError: string | null = null;
try {
  const whiteboard = await this.prisma.whiteboard.findUnique({
    where: { id: whiteboardId },
    select: { title: true },
  });
  await this.emailService.sendWhiteboardShareInvitation({
    toEmail: email,
    inviterName: owner.name,
    inviterEmail: owner.email,
    whiteboardTitle: whiteboard?.title || 'Untitled',
    whiteboardId,
    isExistingUser: !!recipientUser,
  });
  emailSent = true;
} catch (err) {
  emailError = err instanceof Error ? err.message : 'Unknown error';
  // swallow: share record still works in-app
}

return { ...share, emailSent, emailError };
  }

  async revokeInvite(whiteboardId: string, ownerId: string, shareId: string) {
    await this.findOne(whiteboardId, ownerId);
    const share = await this.prisma.whiteboardShare.findUnique({
      where: { id: shareId },
    });
    if (!share || share.whiteboardId !== whiteboardId) {
      throw new NotFoundException("Share not found");
    }
    await this.prisma.whiteboardShare.update({
      where: { id: shareId },
      data: { revokedAt: new Date() },
    });
    return { success: true };
  }

  async findSharedWithMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) {
      throw new NotFoundException("User not found");
    }
    const email = user.email.toLowerCase();

    await this.prisma.whiteboardShare.updateMany({
      where: {
        recipientEmail: email,
        recipientUserId: null,
        revokedAt: null,
      },
      data: { recipientUserId: userId },
    });

    const shares = await this.prisma.whiteboardShare.findMany({
      where: { recipientUserId: userId, revokedAt: null },
      orderBy: { createdAt: "desc" },
      include: {
        whiteboard: {
          select: {
            id: true,
            title: true,
            icon: true,
            color: true,
            updatedAt: true,
          },
        },
        owner: {
          select: { id: true, name: true, email: true, avatar: true },
        },
      },
    });

    return shares.map((s) => ({
      shareId: s.id,
      whiteboard: s.whiteboard,
      owner: s.owner,
      acceptedAt: s.acceptedAt,
      createdAt: s.createdAt,
      permission: s.permission,
    }));
  }

  async findByPublicToken(token: string) {
    if (!token || token.length < 16) {
      throw new NotFoundException("Whiteboard not found");
    }
    const whiteboard = await this.prisma.whiteboard.findFirst({
      where: { publicShareToken: token, deletedAt: null },
      select: {
        id: true,
        title: true,
        content: true,
        icon: true,
        color: true,
        updatedAt: true,
        user: { select: { name: true } },
      },
    });
    if (!whiteboard) {
      throw new NotFoundException("Whiteboard not found");
    }
    return whiteboard;
  }

  private generateToken(): string {
    return randomBytes(24).toString("base64url");
  }
}
