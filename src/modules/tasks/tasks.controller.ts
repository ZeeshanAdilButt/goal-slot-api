import { Controller, Get, Post, Put, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { TasksService } from './tasks.service';
import { CompleteTaskDto, CreateTaskDto, UpdateTaskDto } from './dto/tasks.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TaskStatus } from '@prisma/client';

@ApiTags('tasks')
@Controller('tasks')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class TasksController {
  constructor(private tasksService: TasksService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new task' })
  async create(@Request() req: any, @Body() dto: CreateTaskDto) {
    return this.tasksService.create(req.user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List tasks with optional filters' })
  @ApiQuery({ name: 'status', enum: TaskStatus, required: false })
  @ApiQuery({ name: 'scheduleBlockId', required: false })
  @ApiQuery({ name: 'goalId', required: false })
  @ApiQuery({ name: 'dayOfWeek', required: false, description: '0 (Sun) - 6 (Sat)' })
  async findAll(
    @Request() req: any,
    @Query('status') status?: TaskStatus,
    @Query('scheduleBlockId') scheduleBlockId?: string,
    @Query('goalId') goalId?: string,
    @Query('dayOfWeek') dayOfWeek?: number,
  ) {
    return this.tasksService.findAll(req.user.sub, {
      status,
      scheduleBlockId,
      goalId,
      dayOfWeek: dayOfWeek !== undefined ? Number(dayOfWeek) : undefined,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single task' })
  async findOne(@Request() req: any, @Param('id') id: string) {
    return this.tasksService.findOne(req.user.sub, id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a task' })
  async update(@Request() req: any, @Param('id') id: string, @Body() dto: UpdateTaskDto) {
    return this.tasksService.update(req.user.sub, id, dto);
  }

  @Post(':id/complete')
  @ApiOperation({ summary: 'Complete a task and log time to schedule/goal' })
  async complete(@Request() req: any, @Param('id') id: string, @Body() dto: CompleteTaskDto) {
    return this.tasksService.complete(req.user.sub, id, dto);
  }
}




