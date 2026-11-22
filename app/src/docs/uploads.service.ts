import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3_CLIENT } from '../storage/s3-client.provider';
import { DocsService } from './docs.service';

const URL_TTL_SECONDS = 300; // 5 minutes: long enough to start an upload, short enough to limit leaks

export interface UploadUrl {
  url: string;
  method: 'PUT';
  headers: { 'Content-Type': string };
  key: string;
  expiresIn: number;
}

@Injectable()
export class UploadsService {
  private readonly bucket: string;

  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    private readonly docs: DocsService,
    config: ConfigService,
  ) {
    this.bucket = config.getOrThrow<string>('BUCKET_NAME');
  }

  async createUploadUrl(docId: string, contentType: string): Promise<UploadUrl> {
    await this.docs.get(docId); // throws NotFoundException (404) if the doc does not exist

    // The key is derived from the doc id, so the S3-event Lambda can map object -> doc
    // WITHOUT trusting anything the client sent. One file per doc; re-upload overwrites.
    const key = `uploads/${docId}`;

    const url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType, // only enforced because of signableHeaders below
      }),
      {
        expiresIn: URL_TTL_SECONDS,
        // The SDK does NOT sign Content-Type by default, so without this S3 accepts any
        // type through the URL. Listing it here puts it in X-Amz-SignedHeaders, and S3
        // then rejects a mismatching Content-Type with 403 SignatureDoesNotMatch.
        signableHeaders: new Set(['content-type']),
      },
    );

    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      key,
      expiresIn: URL_TTL_SECONDS,
    };
  }
}
