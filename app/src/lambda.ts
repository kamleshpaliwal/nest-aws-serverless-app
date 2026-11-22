import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import serverlessExpress from '@codegenie/serverless-express';
import type { Handler } from 'aws-lambda';
import { AppModule } from './app.module';

/**
 * INIT-phase state. Lives as long as this execution environment lives, so a
 * warm invocation reuses the already-built Nest app instead of rebuilding it.
 */
let serverPromise: Promise<Handler> | undefined;

async function bootstrap(): Promise<Handler> {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({ json: true, colors: false }),
  });
  // init() builds everything (modules, providers, routes) but does NOT listen on a port.
  // API Gateway invokes us directly; there is no port.
  await app.init();

  const expressApp = app.getHttpAdapter().getInstance();
  return serverlessExpress({ app: expressApp });
}

function getServer(): Promise<Handler> {
  // Cache the PROMISE, not the result, so two overlapping calls share one bootstrap.
  // If bootstrap fails, clear the cache so the next invocation retries instead of
  // being stuck with a rejected promise forever.
  serverPromise ??= bootstrap().catch((err: unknown) => {
    serverPromise = undefined;
    throw err;
  });
  return serverPromise;
}

/** The function Lambda calls. Configured as "lambda.handler" in CDK. */
export const handler: Handler = async (event, context, callback) => {
  const server = await getServer();
  return server(event, context, callback);
};
