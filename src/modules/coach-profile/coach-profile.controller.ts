import { Body, Controller, Get, Put, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CoachProfileService } from './coach-profile.service';
import { HabitsProfileDto } from './dto/habits-profile.dto';
import { UpsertHabitsProfileDto } from './dto/upsert-habits-profile.dto';

@ApiTags('coach-profile')
@Controller('coach/habits-profile')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CoachProfileController {
  constructor(private readonly profileService: CoachProfileService) {}

  @Get()
  @ApiOperation({ summary: 'Get the current users HabitsProfile (defaults if unset)' })
  async getProfile(@Request() req: any): Promise<HabitsProfileDto> {
    return this.profileService.getProfile(req.user.sub);
  }

  @Put()
  @ApiOperation({ summary: 'Upsert the current users HabitsProfile' })
  async upsertProfile(
    @Request() req: any,
    @Body() dto: UpsertHabitsProfileDto,
  ): Promise<HabitsProfileDto> {
    return this.profileService.upsertProfile(req.user.sub, dto);
  }
}
