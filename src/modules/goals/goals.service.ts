import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { CreateGoalDto, UpdateGoalDto, LabelInput } from './dto/goals.dto';
import { GoalStatus, Prisma } from '@prisma/client';

// Notion-style label colors (soft pastels)
const LABEL_COLORS = [
  '#FEE2E2', // Light red
  '#FEF3C7', // Light yellow
  '#D1FAE5', // Light green
  '#DBEAFE', // Light blue
  '#E9D5FF', // Light purple
  '#FCE7F3', // Light pink
  '#FED7AA', // Light orange
  '#E5E7EB', // Light gray
  '#CFFAFE', // Light cyan
  '#F3E8FF', // Light violet
];

interface FindAllOptions {
  status?: GoalStatus;
  category?: string;
  categories?: string[];
  labelIds?: string[];
}

@Injectable()
export class GoalsService {
  constructor(
    private prisma: PrismaService,
    private authService: AuthService,
  ) {}

  /**
   * Ensure a category with the given value exists for the user. If not,
   * create it with a sensible color so Coach-proposed goals referencing
   * categories like "SPIRITUAL" or "COMMUNITY" (that may not be on every
   * legacy user's default list) don't drop into a missing-category limbo.
   */
  private async ensureCategoryExists(userId: string, value: string): Promise<void> {
    const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (!normalized) return;
    const existing = await this.prisma.category.findFirst({
      where: { userId, value: normalized },
    });
    if (existing) return;
    const displayName = value
      .toLowerCase()
      .replace(/_+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
    const PRESET_COLORS: Record<string, string> = {
      SPIRITUAL: '#10B981',
      COMMUNITY: '#A855F7',
      LEARNING: '#3B82F6',
      WORK: '#22D3EE',
      HEALTH: '#22C55E',
      EXERCISE: '#F97316',
    };
    const color = PRESET_COLORS[normalized] || LABEL_COLORS[Math.floor(Math.random() * LABEL_COLORS.length)];
    await this.prisma.category.create({
      data: {
        userId,
        name: displayName || normalized,
        value: normalized,
        color,
        isDefault: false,
      },
    });
  }

  /**
   * Get or create a label by name for a user
   */
  private async getOrCreateLabel(
    userId: string,
    labelInput: LabelInput,
    tx?: Prisma.TransactionClient,
  ): Promise<string> {
    const prisma = tx || this.prisma;
    const { name: labelName, color: providedColor } = labelInput;
    const value = labelName.toUpperCase().replace(/[^A-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    
    // Check if label exists
    let label = await prisma.label.findFirst({
      where: { userId, value },
    });
    
    if (!label) {
      // Auto-create the label with provided color or random Notion color
      const maxOrder = await prisma.label.findFirst({
        where: { userId },
        orderBy: { order: 'desc' },
        select: { order: true },
      });
      
      const color = providedColor || LABEL_COLORS[Math.floor(Math.random() * LABEL_COLORS.length)];
      
      label = await prisma.label.create({
        data: {
          name: labelName.trim(),
          value,
          color,
          userId,
          order: (maxOrder?.order ?? 0) + 1,
          isDefault: false,
        },
      });
    } else if (providedColor && label.color !== providedColor) {
      // Update color if provided and different
      label = await prisma.label.update({
        where: { id: label.id },
        data: { color: providedColor },
      });
    }
    
    return label.id;
  }

  async create(userId: string, dto: CreateGoalDto) {
    // Check plan limits
    const currentGoals = await this.prisma.goal.count({
      where: { userId, status: { not: GoalStatus.COMPLETED } },
    });
    await this.authService.checkPlanLimit(userId, 'goals', currentGoals);

    const { labels, ...goalData } = dto;

    // Auto-assign a soft random color when the caller (e.g. Coach proposal)
    // didn't pick one, so new goals look distinct on the dashboard.
    const color =
      goalData.color && goalData.color.trim()
        ? goalData.color
        : LABEL_COLORS[Math.floor(Math.random() * LABEL_COLORS.length)];

    // Ensure the category exists for this user. Coach can propose SPIRITUAL,
    // COMMUNITY, or any category name; if it's not on the user's list yet
    // we create it on the fly so the goal doesn't end up orphaned.
    if (goalData.category) {
      await this.ensureCategoryExists(userId, goalData.category);
    }

    const goal = await this.prisma.goal.create({
      data: {
        ...goalData,
        color,
        userId,
        deadline: dto.deadline ? new Date(dto.deadline) : null,
      },
    });

    // Assign labels if provided (auto-create if needed)
    if (labels && labels.length > 0) {
      // Use transaction to ensure data integrity when creating labels and associations
      await this.prisma.$transaction(async (tx) => {
        const labelIds = await Promise.all(
          labels.map((labelInput) => this.getOrCreateLabel(userId, labelInput, tx))
        );
        
        if (labelIds.length > 0) {
          await tx.goalLabel.createMany({
            data: labelIds.map((labelId) => ({
              goalId: goal.id,
              labelId,
            })),
          });
        }
      });
    }

    return this.findOne(userId, goal.id);
  }

  async findAll(userId: string, options: FindAllOptions = {}) {
    const { status, category, categories, labelIds } = options;
    
    const where: any = { userId };
    if (status) where.status = status;
    
    // Support both single category and multiple categories
    if (categories && categories.length > 0) {
      where.category = { in: categories };
    } else if (category) {
      where.category = category;
    }

    // If filtering by labels, we need to find goals that have ALL the specified labels
    if (labelIds && labelIds.length > 0) {
      where.labels = {
        some: {
          labelId: { in: labelIds },
        },
      };
    }

    return this.prisma.goal.findMany({
      where,
      // @ts-ignore
      orderBy: [{ order: 'asc' }, { createdAt: 'desc' }],
      include: {
        _count: {
          select: { timeEntries: true },
        },
        labels: {
          include: {
            label: true,
          },
        },
      },
    });
  }

  async findOne(userId: string, goalId: string) {
    const goal = await this.prisma.goal.findFirst({
      where: { id: goalId, userId },
      include: {
        timeEntries: {
          orderBy: { date: 'desc' },
          take: 10,
        },
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

    return goal;
  }

  async update(userId: string, goalId: string, dto: UpdateGoalDto) {
    const goal = await this.prisma.goal.findFirst({
      where: { id: goalId, userId },
    });

    if (!goal) {
      throw new NotFoundException('Goal not found');
    }

    const { labels, ...updateData } = dto;

    await this.prisma.goal.update({
      where: { id: goalId },
      data: {
        ...updateData,
        deadline: dto.deadline ? new Date(dto.deadline) : undefined,
      },
    });

    // Update labels if provided
    if (labels !== undefined) {
      // Remove all existing labels
      await this.prisma.goalLabel.deleteMany({ where: { goalId } });
      
      // Add new labels (auto-create if needed)
      if (labels.length > 0) {
        // Use transaction to ensure data integrity when creating labels and associations
        await this.prisma.$transaction(async (tx) => {
          const labelIds = await Promise.all(
            labels.map((labelInput) => this.getOrCreateLabel(userId, labelInput, tx))
          );
          
          if (labelIds.length > 0) {
            await tx.goalLabel.createMany({
              data: labelIds.map((labelId) => ({
                goalId,
                labelId,
              })),
            });
          }
        });
      }
    }

    return this.findOne(userId, goalId);
  }

  async delete(userId: string, goalId: string) {
    const goal = await this.prisma.goal.findFirst({
      where: { id: goalId, userId },
    });

    if (!goal) {
      throw new NotFoundException('Goal not found');
    }

    await this.prisma.goal.delete({ where: { id: goalId } });
    return { message: 'Goal deleted successfully' };
  }

  async updateProgress(goalId: string, additionalMinutes: number) {
    const goal = await this.prisma.goal.findUnique({ where: { id: goalId } });
    if (!goal) return;

    const additionalHours = additionalMinutes / 60;
    const newLoggedHours = goal.loggedHours + additionalHours;

    await this.prisma.goal.update({
      where: { id: goalId },
      data: {
        loggedHours: newLoggedHours,
        status: newLoggedHours >= goal.targetHours ? GoalStatus.COMPLETED : goal.status,
      },
    });
  }

  async getStats(userId: string) {
    const [active, completed, paused] = await Promise.all([
      this.prisma.goal.count({ where: { userId, status: GoalStatus.ACTIVE } }),
      this.prisma.goal.count({ where: { userId, status: GoalStatus.COMPLETED } }),
      this.prisma.goal.count({ where: { userId, status: GoalStatus.PAUSED } }),
    ]);

    return { active, completed, paused, total: active + completed + paused };
  }

  async reorder(userId: string, ids: string[]) {
    return this.prisma.$transaction(
      ids.map((id, index) =>
        // @ts-ignore
        this.prisma.goal.updateMany({
          where: { id, userId },
          data: { order: index },
        }),
      ),
    );
  }
}
