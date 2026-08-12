import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { EncryptionModule } from '../../shared/modules/encryption.module';
import { NotionIntegrationController } from './notion-integration.controller';
import { NotionIntegrationService } from './notion-integration.service';

@Module({
  imports: [AuthModule, PrismaModule, EncryptionModule],
  controllers: [NotionIntegrationController],
  providers: [NotionIntegrationService],
  exports: [NotionIntegrationService],
})
export class NotionIntegrationModule {}
