import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CreateDocDto } from './dto/create-doc.dto';
import { ListDocsQueryDto } from './dto/list-docs-query.dto';
import { DocsService } from './docs.service';

// No prefix here: we serve both /docs/... and /users/:userId/docs.
@Controller()
export class DocsController {
  constructor(private readonly docsService: DocsService) {}

  @Post('docs') // Nest returns 201 for POST by default
  create(@Body() dto: CreateDocDto) {
    return this.docsService.create(dto);
  }

  @Get('docs/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.docsService.get(id);
  }

  @Get('users/:userId/docs')
  list(@Param('userId') userId: string, @Query() query: ListDocsQueryDto) {
    return this.docsService.list(userId, query.limit, query.cursor);
  }
}
