import { Module } from '@nestjs/common';
import { WhiteboardsController } from './whiteboards.controller';
import { PublicWhiteboardsController } from './public-whiteboards.controller';
import { WhiteboardsService } from './whiteboards.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [PrismaModule, EmailModule],
  controllers: [WhiteboardsController, PublicWhiteboardsController],
  providers: [WhiteboardsService],
  exports: [WhiteboardsService],
})
export class WhiteboardsModule {}