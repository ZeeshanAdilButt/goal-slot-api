import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { FeedbackService } from './feedback.service';
import { CreateFeedbackDto, ArchiveFeedbackDto } from './dto/feedback.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('feedback')
@Controller('feedback')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class FeedbackController {
  constructor(private feedbackService: FeedbackService) {}

  @Post()
  @ApiOperation({ summary: 'Submit feedback' })
  async create(@Request() req: any, @Body() dto: CreateFeedbackDto) {
    return this.feedbackService.create(req.user.sub, dto);
  }

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get all feedback (Admin only)' })
  @ApiQuery({ name: 'isArchived', required: false, type: Boolean })
  @ApiQuery({ name: 'userId', required: false })
  async findAll(
    @Query('isArchived') isArchived?: string,
    @Query('userId') userId?: string,
  ) {
    const filters: { isArchived?: boolean; userId?: string } = {};

    if (isArchived !== undefined) {
      filters.isArchived = isArchived === 'true';
    }

    if (userId) {
      filters.userId = userId;
    }

    return this.feedbackService.findAll(filters);
  }

  @Get(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get a single feedback (Admin only)' })
  async findOne(@Param('id') id: string) {
    return this.feedbackService.findOne(id);
  }

  @Put(':id/archive')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Archive or unarchive feedback (Admin only)' })
  async archive(@Request() req: any, @Param('id') id: string, @Body() dto: ArchiveFeedbackDto) {
    return this.feedbackService.archive(id, req.user.sub, dto);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Delete feedback (Admin only)' })
  async delete(@Param('id') id: string) {
    return this.feedbackService.delete(id);
  }
}
