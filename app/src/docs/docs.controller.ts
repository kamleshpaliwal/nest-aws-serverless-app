import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CreateDocDto } from './dto/create-doc.dto';
import { CreateUploadUrlDto } from './dto/create-upload-url.dto';
import { ListDocsQueryDto } from './dto/list-docs-query.dto';
import { DocsService } from './docs.service';
import { UploadsService } from './uploads.service';

// No prefix here: we serve both /docs/... and /users/:userId/docs.
@Controller()
export class DocsController {
  constructor(
    private readonly docsService: DocsService,
    private readonly uploadsService: UploadsService,
  ) {}

  @Post('docs') // Nest returns 201 for POST by default
  create(@Body() dto: CreateDocDto) {
    return this.docsService.create(dto);
  }

  @Get('docs/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.docsService.get(id);
  }

  // POST because it has a side effect (mints a credential), but 200 because it creates
  // no resource on the server, so 201 would be misleading.
  @Post('docs/:id/upload-url')
  @HttpCode(HttpStatus.OK)
  createUploadUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateUploadUrlDto,
  ) {
    return this.uploadsService.createUploadUrl(id, dto.contentType);
  }

  @Get('users/:userId/docs')
  list(@Param('userId') userId: string, @Query() query: ListDocsQueryDto) {
    return this.docsService.list(userId, query.limit, query.cursor);
  }
}
