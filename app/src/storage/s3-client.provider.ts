import { S3Client } from '@aws-sdk/client-s3';
import { Provider } from '@nestjs/common';

export const S3_CLIENT = Symbol('S3_CLIENT');

export const s3ClientProvider: Provider = {
  provide: S3_CLIENT,
  // No config needed: on Lambda the SDK takes region and credentials from the
  // environment (AWS_REGION + the execution role's temporary credentials).
  useFactory: (): S3Client => new S3Client({}),
};
