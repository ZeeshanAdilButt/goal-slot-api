import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateLabelDto, UpdateLabelDto } from './dto/labels.dto';

@Injectable()
export class LabelsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Generate a value from a label name
   * Converts to uppercase and replaces spaces/special chars with underscores
   */
  private generateValueFromName(name: string): string {
    return name
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
  }

  async create(userId: string, dto: CreateLabelDto) {
    const value = this.generateValueFromName(dto.name);

    // Check if label with same value already exists for this user
    const existing = await this.prisma.label.findUnique({
      where: {
        userId_value: {
          userId,
          value,
        },
      },
    });

    if (existing) {
      throw new ConflictException(`Label with name "${dto.name}" already exists`);
    }

    // Get max order for this user
    const maxOrder = await this.prisma.label.findFirst({
      where: { userId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });

    return this.prisma.label.create({
      data: {
        name: dto.name,
        value,
        color: dto.color ?? '#6B7280',
        userId,
        order: dto.order ?? (maxOrder?.order ?? 0) + 1,
      },
    });
  }

  async findAll(userId: string) {
    return this.prisma.label.findMany({
      where: { userId },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      include: {
        _count: {
          select: { goals: true },
        },
      },
    });
  }

  async findOne(userId: string, labelId: string) {
    const label = await this.prisma.label.findFirst({
      where: { id: labelId, userId },
      include: {
        _count: {
          select: { goals: true },
        },
      },
    });

    if (!label) {
      throw new NotFoundException('Label not found');
    }

    return label;
  }

  async update(userId: string, labelId: string, dto: UpdateLabelDto) {
    const label = await this.prisma.label.findFirst({
      where: { id: labelId, userId },
    });

    if (!label) {
      throw new NotFoundException('Label not found');
    }

    // If name is being updated, generate new value and check for conflicts
    let value = label.value;
    if (dto.name && dto.name !== label.name) {
      value = this.generateValueFromName(dto.name);

      if (value !== label.value) {
        const existing = await this.prisma.label.findUnique({
          where: {
            userId_value: {
              userId,
              value,
            },
          },
        });

        if (existing) {
          throw new ConflictException(`Label with name "${dto.name}" already exists`);
        }
      }
    }

    return this.prisma.label.update({
      where: { id: labelId },
      data: {
        ...dto,
        value: dto.name ? value : undefined,
      },
    });
  }

  async delete(userId: string, labelId: string) {
    const label = await this.prisma.label.findFirst({
      where: { id: labelId, userId },
    });

    if (!label) {
      throw new NotFoundException('Label not found');
    }

    // Delete all goal-label associations first, then the label
    await this.prisma.$transaction([
      this.prisma.goalLabel.deleteMany({ where: { labelId } }),
      this.prisma.label.delete({ where: { id: labelId } }),
    ]);

    return { message: 'Label deleted successfully' };
  }

  async reorder(userId: string, labelIds: string[]) {
    // Verify all labels belong to this user
    const labels = await this.prisma.label.findMany({
      where: { userId, id: { in: labelIds } },
    });

    if (labels.length !== labelIds.length) {
      throw new NotFoundException('One or more labels not found');
    }

    // Update order for each label using transaction
    await this.prisma.$transaction(
      labelIds.map((id, index) =>
        this.prisma.label.update({
          where: { id },
          data: { order: index + 1 },
        }),
      ),
    );

    return this.findAll(userId);
  }

  /**
   * Seed default labels for a new user
   */
  async seedDefaultLabels(userId: string) {
    const currentYear = new Date().getFullYear();
    
    const defaultLabels = [
      { name: 'Q1', value: 'Q1', color: '#3B82F6', order: 1 },      // blue
      { name: 'Q2', value: 'Q2', color: '#22C55E', order: 2 },      // green
      { name: 'Q3', value: 'Q3', color: '#F97316', order: 3 },      // orange
      { name: 'Q4', value: 'Q4', color: '#EC4899', order: 4 },      // pink
      { name: `${currentYear}`, value: `${currentYear}`, color: '#8B5CF6', order: 5 }, // purple
      { name: 'High Priority', value: 'HIGH_PRIORITY', color: '#EF4444', order: 6 },  // red
      { name: 'Personal', value: 'PERSONAL', color: '#06B6D4', order: 7 },   // cyan
      { name: 'Professional', value: 'PROFESSIONAL', color: '#6366F1', order: 8 }, // indigo
    ];

    // Check if user already has labels
    const existingCount = await this.prisma.label.count({
      where: { userId },
    });

    if (existingCount > 0) {
      return; // Already seeded
    }

    // Create default labels
    await this.prisma.label.createMany({
      data: defaultLabels.map((label) => ({
        ...label,
        userId,
        isDefault: true,
      })),
    });
  }

  /**
   * Assign labels to a goal
   */
  async assignLabelsToGoal(userId: string, goalId: string, labelIds: string[]) {
    // Verify goal belongs to user
    const goal = await this.prisma.goal.findFirst({
      where: { id: goalId, userId },
    });

    if (!goal) {
      throw new NotFoundException('Goal not found');
    }

    // Verify all labels belong to user
    const labels = await this.prisma.label.findMany({
      where: { userId, id: { in: labelIds } },
    });

    if (labels.length !== labelIds.length) {
      throw new NotFoundException('One or more labels not found');
    }

    // Remove existing label associations and add new ones
    await this.prisma.$transaction([
      this.prisma.goalLabel.deleteMany({ where: { goalId } }),
      ...labelIds.map((labelId) =>
        this.prisma.goalLabel.create({
          data: { goalId, labelId },
        }),
      ),
    ]);

    // Return the goal with updated labels
    return this.prisma.goal.findUnique({
      where: { id: goalId },
      include: {
        labels: {
          include: {
            label: true,
          },
        },
      },
    });
  }

  /**
   * Get labels for a specific goal
   */
  async getLabelsForGoal(userId: string, goalId: string) {
    const goal = await this.prisma.goal.findFirst({
      where: { id: goalId, userId },
      include: {
        labels: {
          include: {
            label: true,
          },
        },
      },
    });

    if (!goal) {
      throw new NotFoundException('Goal not found');
    }

    return goal.labels.map((gl) => gl.label);
  }
}
