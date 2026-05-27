import { Global, Module } from '@nestjs/common';

import { EncryptionService } from '../services/encryption.service';

@Global()
@Module({
  providers: [EncryptionService],
  exports: [EncryptionService],
})
export class EncryptionModule {}
