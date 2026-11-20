import { ConsoleLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // One JSON object per log line: CloudWatch Logs Insights can query fields.
    logger: new ConsoleLogger({ json: true, colors: false }),
  });
  const port = app.get(ConfigService).get<number>('PORT', 3000);
  await app.listen(port);
}
void bootstrap();
