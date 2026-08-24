import { Controller, Get, Post, Delete, Query, Param, UseGuards, Request, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotionIntegrationService } from './notion-integration.service';
import { NotionStatusDto } from './dto/notion-status.dto';
import { NotionPageIndexDto } from './dto/notion-page-index.dto';
import { NotionPageContentDto } from './dto/notion-page-content.dto';

@ApiTags('notion-integration')
@Controller('integrations/notion')
export class NotionIntegrationController {
  constructor(private readonly service: NotionIntegrationService) {}

  @Get('connect')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Initiate Notion OAuth flow and get authorize URL' })
  async connect(@Request() req: any) {
    const url = this.service.getAuthorizationUrl(req.user.sub);
    return { url };
  }

  @Get('callback')
  @ApiOperation({ summary: 'Notion OAuth callback redirect handler' })
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
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

  @Get('index')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Return cached Notion page index. Triggers a background refresh when stale (>15 min).',
  })
  async getIndex(@Request() req: any): Promise<NotionPageIndexDto> {
    return this.service.getPageIndex(req.user.sub);
  }

  @Post('index/refresh')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Force a foreground rebuild of the Notion page index cache' })
  async refreshIndex(@Request() req: any): Promise<{ success: boolean }> {
    await this.service.refreshPageIndex(req.user.sub);
    return { success: true };
  }

  @Get('pages/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Fetch block children of a Notion page by ID' })
  async getPageContent(
    @Request() req: any,
    @Param('id') id: string,
  ): Promise<NotionPageContentDto> {
    return this.service.getPageContent(req.user.sub, id);
  }
}
