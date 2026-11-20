import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  // Liveness only: "the process is up and routing works". Deliberately does NOT
  // touch DynamoDB, so a database blip can't make the health check flap.
  @Get()
  check() {
    return { status: 'ok' };
  }
}
