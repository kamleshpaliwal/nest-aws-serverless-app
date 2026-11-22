import { Module } from '@nestjs/common';
import { dynamoDocClientProvider } from '../dynamo/dynamo-client.provider';
import { s3ClientProvider } from '../storage/s3-client.provider';
import { DocsController } from './docs.controller';
import { DocsRepository } from './docs.repository';
import { DocsService } from './docs.service';
import { DynamoDocsRepository } from './dynamo-docs.repository';
import { UploadsService } from './uploads.service';

@Module({
  controllers: [DocsController],
  providers: [
    DocsService,
    UploadsService,
    dynamoDocClientProvider,
    s3ClientProvider,
    { provide: DocsRepository, useClass: DynamoDocsRepository },
  ],
})
export class DocsModule {}
