import {
  Body,
  Controller,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UserThrottlerGuard } from '../coach-ai/user-throttler.guard';
import {
  ApplyProposalsDto,
  CoachActionResult,
} from './dto/apply-proposals.dto';
import { CoachProposalsService } from './coach-proposals.service';

// Kept in step with the ThrottlerModule.forRoot registration in
// coach-proposals.module.ts. Declared locally rather than imported from the
// module because the module already imports this controller, and the same
// duplication is what coach-ai.controller.ts does.
const PROPOSALS_APPLY_TTL_MS = 3_600_000;
const PROPOSALS_APPLY_LIMIT = 60;

@ApiTags('coach-proposals')
@Controller('coach/proposals')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CoachProposalsController {
  constructor(private readonly proposals: CoachProposalsService) {}

  @Post('apply')
  @UseGuards(UserThrottlerGuard)
  @Throttle({
    'coach-proposals': {
      limit: PROPOSALS_APPLY_LIMIT,
      ttl: PROPOSALS_APPLY_TTL_MS,
    },
  })
  @ApiOperation({
    summary:
      'Apply a batch of Coach-proposed mutations to the user’s data. Each action is dispatched against the existing domain service so plan limits, conflict checks, and ownership enforcement are reused. Returns per-action success/error so the UI can render partial results.',
  })
  async apply(
    @Request() req: any,
    @Body() body: ApplyProposalsDto,
  ): Promise<{ results: CoachActionResult[] }> {
    const results = await this.proposals.apply(req.user.sub, body.actions, {
      confirmedDeleteIds: body.confirmDeletions,
    });
    return { results };
  }
}
