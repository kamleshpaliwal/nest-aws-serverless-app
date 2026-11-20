import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { validateEnv } from './config/validate-env';
import { DocsModule } from './docs/docs.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    // isGlobal: any module can inject ConfigService without importing ConfigModule.
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    DocsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Registered here (not in main.ts) so they apply no matter how the app is
    // bootstrapped: main.ts locally, the Lambda handler in production.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true, // strip properties that have no validation decorator
        forbidNonWhitelisted: true, // ...and reject instead of silently dropping
        transform: true, // real DTO instances with converted types
      }),
    },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
