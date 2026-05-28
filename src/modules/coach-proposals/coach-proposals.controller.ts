import {
  Body,
  Controller,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  ApplyProposalsDto,
  CoachActionResult,
} from './dto/apply-proposals.dto';
import { CoachProposalsService } from './coach-proposals.service';

@ApiTags('coach-proposals')
@Controller('coach/proposals')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CoachProposalsController {
  constructor(private readonly proposals: CoachProposalsService) {}

  @Post('apply')
  @ApiOperation({
    summary:
      'Apply a batch of Coach-proposed mutations to the user’s data. Each action is dispatched against the existing domain service so plan limits, conflict checks, and ownership enforcement are reused. Returns per-action success/error so the UI can render partial results.',
  })
  async apply(
    @Request() req: any,
    @Body() body: ApplyProposalsDto,
  ): Promise<{ results: CoachActionResult[] }> {
    const results = await this.proposals.apply(req.user.sub, body.actions);
    return { results };
  }
}
