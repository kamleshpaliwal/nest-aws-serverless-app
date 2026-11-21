import { Module } from '@nestjs/common';
import { dynamoDocClientProvider } from '../dynamo/dynamo-client.provider';
import { DocsController } from './docs.controller';
import { DocsRepository } from './docs.repository';
import { DocsService } from './docs.service';
import { DynamoDocsRepository } from './dynamo-docs.repository';

@Module({
  controllers: [DocsController],
  providers: [
    DocsService,
    dynamoDocClientProvider,
    // The one line that changed from Phase 2 (was InMemoryDocsRepository).
    { provide: DocsRepository, useClass: DynamoDocsRepository },
  ],
})
export class DocsModule {}
