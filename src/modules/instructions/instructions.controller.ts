import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { InstructionsService } from './instructions.service';
import { AssignInstructionDto } from './dto/instructions.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedRequest } from '../../shared/types/authenticated-request.interface';

@ApiTags('instructions')
@Controller('instructions')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class InstructionsController {
  constructor(private instructionsService: InstructionsService) {}

  @Post()
  @ApiOperation({ summary: 'Assign an instruction to a mentee' })
  async assign(
    @Request() req: AuthenticatedRequest,
    @Body() dto: AssignInstructionDto,
  ) {
    return this.instructionsService.assign(req.user.sub, dto);
  }

  @Get('assigned-by-me')
  @ApiOperation({ summary: 'List instructions I have assigned' })
  async listAssignedByMe(@Request() req: AuthenticatedRequest) {
    return this.instructionsService.listAssignedByMe(req.user.sub);
  }

  @Get('assigned-to-me')
  @ApiOperation({ summary: 'List instructions assigned to me' })
  async listAssignedToMe(@Request() req: AuthenticatedRequest) {
    return this.instructionsService.listAssignedToMe(req.user.sub);
  }

  @Patch(':id/complete')
  @ApiOperation({ summary: 'Mark an instruction done' })
  async complete(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.instructionsService.complete(id, req.user.sub);
  }
}
