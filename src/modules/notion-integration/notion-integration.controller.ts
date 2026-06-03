import { Controller, Get, Delete, Query, UseGuards, Request, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotionIntegrationService } from './notion-integration.service';
import { NotionStatusDto } from './dto/notion-status.dto';

@ApiTags('notion-integration')
@Controller('integrations/notion')
export class NotionIntegrationController {
  constructor(private readonly service: NotionIntegrationService) {}

  @Get('connect')
  @ApiOperation({ summary: 'Initiate Notion OAuth flow and redirect browser' })
  async connect(@Query('userId') userId: string, @Res() res: Response) {
    if (!userId) {
      return res.redirect(`${this.service.getFrontendUrl()}/dashboard/settings?tab=integrations&notion=error&message=Missing+user+ID`);
    }
    const url = this.service.getAuthorizationUrl(userId);
    return res.redirect(url);
  }

  @Get('callback')
  @ApiOperation({ summary: 'Notion OAuth callback redirect handler' })
  async callback(
    @Query('code') code: string,
    @Query('state') state: string, // state is the short-lived secure token
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const frontendUrl = await this.service.handleCallback(code, state, error);
    return res.redirect(frontendUrl);
  }

  @Get('status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user Notion connection status' })
  async getStatus(@Request() req: any): Promise<NotionStatusDto> {
    return this.service.getStatus(req.user.sub);
  }

  @Delete('disconnect')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Disconnect Notion connection' })
  async disconnect(@Request() req: any): Promise<{ success: boolean }> {
    await this.service.disconnect(req.user.sub);
    return { success: true };
  }
}
