import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CoachReflectionService } from './coach-reflection.service';
import { GetReflectionQueryDto } from './dto/get-reflection.dto';
import { UpsertGoalReflectionDto } from './dto/upsert-goal-reflection.dto';

@ApiTags('coach-reflection')
@Controller('coach/goals/:goalId/reflections')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CoachReflectionController {
  constructor(private readonly reflectionService: CoachReflectionService) {}

  @Get()
  @ApiOperation({ summary: 'Get the reflection for a goal+weekKey (defaults to current ISO week)' })
  async getOne(
    @Request() req: any,
    @Param('goalId') goalId: string,
    @Query() query: GetReflectionQueryDto,
  ) {
    return this.reflectionService.getReflection(
      req.user.sub,
      goalId,
      query.weekKey,
    );
  }

  @Get('history')
  @ApiOperation({ summary: 'Get up to 12 most-recent reflections for this goal' })
  async getHistory(
    @Request() req: any,
    @Param('goalId') goalId: string,
  ) {
    return this.reflectionService.getHistory(req.user.sub, goalId);
  }

  @Post()
  @ApiOperation({ summary: 'Upsert a weekly reflection for this goal' })
  async upsert(
    @Request() req: any,
    @Param('goalId') goalId: string,
    @Body() dto: UpsertGoalReflectionDto,
  ) {
    return this.reflectionService.upsertReflection(req.user.sub, goalId, dto);
  }
}
