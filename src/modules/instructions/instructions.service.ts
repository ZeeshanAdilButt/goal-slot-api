import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ReminderDispatchService } from '../reminders/reminder-dispatch.service';
import { AssignInstructionDto } from './dto/instructions.dto';

const BASIC_USER_SELECT = { id: true, name: true, email: true };

@Injectable()
export class InstructionsService {
  private readonly logger = new Logger(InstructionsService.name);

  constructor(
    private prisma: PrismaService,
    private reminderDispatchService: ReminderDispatchService,
  ) {}

  async assign(assignerId: string, dto: AssignInstructionDto) {
    // Same direction as viewing reports: the assigner must be the sharedWith
    // side of an accepted share on the assignee's data. accessLevel is not
    // checked - assigning an instruction doesn't touch the mentee's own
    // records, so VIEW-only access is sufficient.
    const share = await this.prisma.sharedAccess.findFirst({
      where: {
        ownerId: dto.assigneeId,
        sharedWithId: assignerId,
        isAccepted: true,
      },
    });

    if (!share) {
      throw new ForbiddenException('You do not have accepted access to this user');
    }

    const instruction = await this.prisma.instruction.create({
      data: {
        assignerId,
        assigneeId: dto.assigneeId,
        title: dto.title,
        note: dto.note,
        status: 'PENDING',
      },
    });

    // Notify the assignee right away rather than making them wait for the
    // next daily sweep. sendInstructionReminder already isolates its own
    // failures and never throws, but it is wrapped here too - a hiccup in
    // notification delivery must never fail instruction creation, which has
    // already committed by this point. The sweep remains the safety net.
    try {
      await this.reminderDispatchService.sendInstructionReminder(instruction, new Date());
    } catch (error) {
      this.logger.error(
        `Failed to send immediate reminder for instruction ${instruction.id}: ${(error as Error).message}`,
      );
    }

    return instruction;
  }

  async listAssignedByMe(assignerId: string) {
    return this.prisma.instruction.findMany({
      where: { assignerId },
      orderBy: { createdAt: 'desc' },
      include: {
        assignee: { select: BASIC_USER_SELECT },
      },
    });
  }

  async listAssignedToMe(assigneeId: string) {
    return this.prisma.instruction.findMany({
      where: { assigneeId },
      orderBy: { createdAt: 'desc' },
      include: {
        assigner: { select: BASIC_USER_SELECT },
      },
    });
  }

  async complete(id: string, callerId: string) {
    const instruction = await this.prisma.instruction.findUnique({
      where: { id },
    });

    if (!instruction) {
      throw new NotFoundException('Instruction not found');
    }

    if (instruction.assigneeId !== callerId) {
      throw new ForbiddenException('Only the assignee can complete this instruction');
    }

    return this.prisma.instruction.update({
      where: { id },
      data: {
        status: 'DONE',
        completedAt: new Date(),
      },
    });
  }
}
