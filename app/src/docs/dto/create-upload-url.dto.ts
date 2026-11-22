import { IsIn } from 'class-validator';

// Allow-list, not free text: the signed Content-Type decides what S3 stores and serves.
export const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/plain',
] as const;

export class CreateUploadUrlDto {
  @IsIn(ALLOWED_CONTENT_TYPES)
  contentType: (typeof ALLOWED_CONTENT_TYPES)[number];
}
