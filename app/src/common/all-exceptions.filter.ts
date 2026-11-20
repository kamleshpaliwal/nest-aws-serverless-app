import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  DocAlreadyExistsError,
  InvalidCursorError,
} from '../docs/docs.errors';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

/** @Catch() with no arguments = catch EVERYTHING that is thrown. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const body = this.toBody(exception);

    // 5xx = our fault: log full detail server-side. 4xx = client's fault: no noise.
    if (body.statusCode >= 500) {
      const stack = exception instanceof Error ? exception.stack : undefined;
      this.logger.error(`${req.method} ${req.url} -> ${body.statusCode}`, stack);
    }

    res.status(body.statusCode).json({
      ...body,
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }

  private toBody(exception: unknown): ErrorBody {
    // 1. Errors Nest already understands (ValidationPipe 400, NotFoundException 404, ...)
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const r = exception.getResponse();
      if (typeof r === 'string') {
        return { statusCode, error: HttpStatus[statusCode] ?? 'Error', message: r };
      }
      const obj = r as Partial<ErrorBody>;
      return {
        statusCode,
        error: obj.error ?? HttpStatus[statusCode] ?? 'Error',
        message: obj.message ?? exception.message,
      };
    }

    // 2. Our domain errors -> HTTP codes
    if (exception instanceof DocAlreadyExistsError) {
      return { statusCode: 409, error: 'Conflict', message: exception.message };
    }
    if (exception instanceof InvalidCursorError) {
      return { statusCode: 400, error: 'Bad Request', message: exception.message };
    }

    // 3. Anything unexpected: generic message. NEVER leak internals to the client.
    return {
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal server error',
    };
  }
}
