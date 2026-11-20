import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateDocDto } from './dto/create-doc.dto';
import { Doc } from './doc.model';
import { DocsPage, DocsRepository } from './docs.repository';

@Injectable()
export class DocsService {
  // DocsRepository is an abstract class, so Nest can use it as the DI token.
  constructor(private readonly repo: DocsRepository) {}

  create(dto: CreateDocDto): Promise<Doc> {
    const now = new Date().toISOString();
    return this.repo.create({
      id: randomUUID(),
      userId: dto.userId,
      title: dto.title,
      description: dto.description,
      status: 'PENDING', // business rule: every new doc starts as PENDING
      createdAt: now,
      updatedAt: now,
    });
  }

  async get(id: string): Promise<Doc> {
    const doc = await this.repo.getById(id);
    if (!doc) throw new NotFoundException(`Doc ${id} not found`);
    return doc;
  }

  list(userId: string, limit: number, cursor?: string): Promise<DocsPage> {
    return this.repo.listByUser(userId, limit, cursor);
  }
}
