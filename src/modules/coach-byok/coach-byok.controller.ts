import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CoachByokService } from './coach-byok.service';
import { SaveByokKeyDto } from './dto/save-byok-key.dto';
import { ByokStateDto } from './dto/byok-state.dto';
import { UpdateModelDto } from './dto/update-model.dto';
import { UpdateTokenBudgetDto } from './dto/update-token-budget.dto';
import { UsageDto } from './dto/usage.dto';

@ApiTags('coach-byok')
@Controller('coach/byok-key')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CoachByokController {
  constructor(private readonly byokService: CoachByokService) {}

  @Get()
  @ApiOperation({ summary: 'Get current BYOK key state for the user' })
  async getState(@Request() req: any): Promise<ByokStateDto> {
    return this.byokService.getState(req.user.sub);
  }

  @Post()
  @ApiOperation({ summary: 'Save or rotate the user BYOK key (encrypted at rest)' })
  async saveKey(
    @Request() req: any,
    @Body() dto: SaveByokKeyDto,
  ): Promise<ByokStateDto> {
    return this.byokService.saveKey(req.user.sub, dto);
  }

  @Delete()
  @ApiOperation({ summary: 'Delete the user BYOK key' })
  async deleteKey(@Request() req: any): Promise<{ success: true }> {
    return this.byokService.deleteKey(req.user.sub);
  }

  @Get('usage')
  @ApiOperation({ summary: 'Get token usage for the current BYOK window' })
  async getUsage(@Request() req: any): Promise<UsageDto> {
    return this.byokService.getUsage(req.user.sub);
  }

  @Patch('budget')
  @ApiOperation({
    summary:
      'Update the monthly token budget for the user BYOK key. Soft cap enforced server-side so the user controls their own spend on the underlying provider account.',
  })
  async updateBudget(
    @Request() req: any,
    @Body() dto: UpdateTokenBudgetDto,
  ): Promise<ByokStateDto> {
    return this.byokService.updateTokenBudget(req.user.sub, dto.tokensLimit);
  }

  @Patch('model')
  @ApiOperation({
    summary:
      'Update the specific provider model Coach will call. Must be on the whitelist for the current provider; otherwise the call is rejected.',
  })
  async updateModel(
    @Request() req: any,
    @Body() dto: UpdateModelDto,
  ): Promise<ByokStateDto> {
    return this.byokService.updateModel(req.user.sub, dto.model);
  }
}
