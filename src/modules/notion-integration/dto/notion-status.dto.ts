import { ApiProperty } from '@nestjs/swagger';

export class NotionStatusDto {
  @ApiProperty({ example: true })
  connected: boolean;

  @ApiProperty({ example: 'My Workspace', nullable: true })
  workspaceName: string | null;

  @ApiProperty({ example: 'https://example.com/icon.png', nullable: true })
  workspaceIcon: string | null;

  @ApiProperty({ example: '2026-06-03T05:00:00.000Z', nullable: true })
  connectedAt: string | null;
}
