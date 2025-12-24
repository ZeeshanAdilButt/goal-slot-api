import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/categories.dto';

@Injectable()
export class CategoriesService {
  constructor(private prisma: PrismaService) {}

  /**
   * Generate a value from a category name
   * Converts to uppercase and replaces spaces/special chars with underscores
   */
  private generateValueFromName(name: string): string {
    return name
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
  }

  async create(userId: string, dto: CreateCategoryDto) {
    // Generate value from name
    const value = this.generateValueFromName(dto.name);

    // Check if category with same value already exists for this user
    const existing = await this.prisma.category.findUnique({
      where: {
        userId_value: {
          userId,
          value,
        },
      },
    });

    if (existing) {
      throw new ConflictException(`Category with name "${dto.name}" already exists`);
    }

    // Get max order for this user
    const maxOrder = await this.prisma.category.findFirst({
      where: { userId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });

    return this.prisma.category.create({
      data: {
        name: dto.name,
        value,
        color: dto.color,
        userId,
        order: dto.order ?? (maxOrder?.order ?? 0) + 1,
      },
    });
  }

  async findAll(userId: string) {
    return this.prisma.category.findMany({
      where: { userId },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async findOne(userId: string, categoryId: string) {
    const category = await this.prisma.category.findFirst({
      where: { id: categoryId, userId },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    return category;
  }

  async update(userId: string, categoryId: string, dto: UpdateCategoryDto) {
    const category = await this.prisma.category.findFirst({
      where: { id: categoryId, userId },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    // If name is being updated, generate new value and check for conflicts
    let value = category.value;
    if (dto.name && dto.name !== category.name) {
      value = this.generateValueFromName(dto.name);

      // Check if the new value conflicts with an existing category
      if (value !== category.value) {
        const existing = await this.prisma.category.findUnique({
          where: {
            userId_value: {
              userId,
              value,
            },
          },
        });

        if (existing) {
          throw new ConflictException(`Category with name "${dto.name}" already exists`);
        }
      }
    }

    // Build update data
    const dataToUpdate: any = { ...dto };
    if (dto.name && value !== category.value) {
      dataToUpdate.value = value;
    }

    return this.prisma.category.update({
      where: { id: categoryId },
      data: dataToUpdate,
    });
  }

  async delete(userId: string, categoryId: string) {
    const category = await this.prisma.category.findFirst({
      where: { id: categoryId, userId },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    // Check if category is in use
    const [goalsCount, scheduleCount, tasksCount] = await Promise.all([
      this.prisma.goal.count({ where: { userId, category: category.value } }),
      this.prisma.scheduleBlock.count({ where: { userId, category: category.value } }),
      this.prisma.task.count({ where: { userId, category: category.value } }),
    ]);

    const usageCount = goalsCount + scheduleCount + tasksCount;

    // Delete the category
    await this.prisma.category.delete({
      where: { id: categoryId },
    });

    // If category was in use, update references to null
    if (usageCount > 0) {
      // Update goals
      await this.prisma.goal.updateMany({
        where: { userId, category: category.value },
        data: { category: null },
      });

      // Update schedule blocks
      await this.prisma.scheduleBlock.updateMany({
        where: { userId, category: category.value },
        data: { category: null },
      });

      // Update tasks
      await this.prisma.task.updateMany({
        where: { userId, category: category.value },
        data: { category: null },
      });
    }

    return {
      message: 'Category deleted successfully',
      wasInUse: usageCount > 0,
      usageCount,
    };
  }

  async seedDefaultCategories(userId: string) {
    const defaultCategories = [
      // Goal categories
      { name: 'Learning', value: 'LEARNING', color: '#3B82F6', order: 1 }, // blue-500
      { name: 'Work', value: 'WORK', color: '#22D3EE', order: 2 }, // cyan-400
      { name: 'Health', value: 'HEALTH', color: '#22C55E', order: 3 }, // green-500
      { name: 'Creative', value: 'CREATIVE', color: '#EC4899', order: 4 }, // pink-500
      
      // Schedule/Task categories
      { name: 'Deep Work', value: 'DEEP_WORK', color: '#FFD700', order: 5 }, // yellow/gold
      { name: 'Exercise', value: 'EXERCISE', color: '#F97316', order: 6 }, // orange-500
      { name: 'Side Project', value: 'SIDE_PROJECT', color: '#EC4899', order: 7 }, // pink-500
      { name: 'DSA', value: 'DSA', color: '#FFD700', order: 8 }, // yellow/gold
      { name: 'Meeting', value: 'MEETING', color: '#8B5CF6', order: 9 }, // purple-500
      { name: 'Admin', value: 'ADMIN', color: '#9CA3AF', order: 10 }, // gray-400
      { name: 'Break', value: 'BREAK', color: '#D1D5DB', order: 11 }, // gray-300
      { name: 'Other', value: 'OTHER', color: '#9CA3AF', order: 12 }, // gray-400
    ];

    // Check if user already has categories
    const existingCount = await this.prisma.category.count({
      where: { userId },
    });

    if (existingCount > 0) {
      return []; // Already seeded
    }

    // Create default categories
    const created = await Promise.all(
      defaultCategories.map((cat) =>
        this.prisma.category.create({
          data: {
            ...cat,
            userId,
            isDefault: true,
          },
        }),
      ),
    );

    return created;
  }
}

