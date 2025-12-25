import { Module } from '@nestjs/common';
import { SharingController } from './sharing.controller';
import { PublicSharingController } from './public-sharing.controller';
import { SharingService } from './sharing.service';

@Module({
  controllers: [SharingController, PublicSharingController],
  providers: [SharingService],
  exports: [SharingService],
})
export class SharingModule {}
