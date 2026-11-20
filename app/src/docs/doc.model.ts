export type DocStatus = 'PENDING' | 'UPLOADED';

export interface Doc {
  id: string;
  userId: string;
  title: string;
  description?: string;
  status: DocStatus;
  createdAt: string; // ISO-8601, e.g. 2026-11-21T10:15:00.000Z (sorts correctly as text)
  updatedAt: string;
}
