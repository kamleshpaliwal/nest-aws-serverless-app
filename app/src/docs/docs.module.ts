import { Module } from '@nestjs/common';
import { DocsController } from './docs.controller';
import { DocsRepository } from './docs.repository';
import { DocsService } from './docs.service';
import { InMemoryDocsRepository } from './in-memory-docs.repository';

@Module({
  controllers: [DocsController],
  providers: [
    DocsService,
    // "When someone asks for DocsRepository, give them InMemoryDocsRepository."
    // In Phase 3 only this line changes (useClass: DynamoDocsRepository).
    { provide: DocsRepository, useClass: InMemoryDocsRepository },
  ],
})
export class DocsModule {}
