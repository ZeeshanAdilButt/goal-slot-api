import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CoachCheckinService } from './coach-checkin.service';
import { ListCheckinsDto } from './dto/list-checkins.dto';
import { UpsertDailyCheckinDto } from './dto/upsert-daily-checkin.dto';

@ApiTags('coach-checkin')
@Controller('coach/checkins')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CoachCheckinController {
  constructor(private readonly checkinService: CoachCheckinService) {}

  @Get()
  @ApiOperation({ summary: 'List daily check-ins for the user (default last 30 days)' })
  async list(@Request() req: any, @Query() query: ListCheckinsDto) {
    return this.checkinService.listCheckins(req.user.sub, query);
  }

  @Get('today')
  @ApiOperation({ summary: "Get today's check-in (server-local) or null" })
  async getToday(@Request() req: any) {
    return this.checkinService.getToday(req.user.sub);
  }

  @Post()
  @ApiOperation({ summary: "Upsert today's (or any date's) daily check-in" })
  async upsert(@Request() req: any, @Body() dto: UpsertDailyCheckinDto) {
    return this.checkinService.upsertCheckin(req.user.sub, dto);
  }
}
