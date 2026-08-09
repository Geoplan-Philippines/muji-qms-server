import { NestFactory } from '@nestjs/core';
import { Logger, VersioningType } from '@nestjs/common';

import helmet from 'helmet';

import { AppModule } from './app.module';
import { env } from './core/config/env.config';
import {
  CORS_METHODS,
  corsOriginDelegate,
  describeCorsPolicy,
} from './core/config/cors.config';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });
  app.enableShutdownHooks();

  app.use(
    helmet({
      // This API is consumed cross-origin by design — the frontend is served
      // from a different port on this same machine. Helmet's default
      // `same-origin` resource policy is written for a site serving its own
      // assets and only gets in the way here.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // No browsable HTML is served from this origin, so the default CSP would
      // only ever apply to error bodies.
      contentSecurityPolicy: false,
    }),
  );

  app.enableCors({
    origin: corsOriginDelegate,
    methods: CORS_METHODS,
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  await app.listen(env.PORT, '0.0.0.0');

  // Printed every boot so a CORS or binding misconfiguration is visible in the
  // service log instead of being diagnosed from a blank screen in the shop.
  logger.log(`Listening on http://0.0.0.0:${env.PORT} (env=${env.NODE_ENV})`);
  logger.log(`REST base /api/v1 · socket.io namespace /orders`);
  logger.log(`CORS ${describeCorsPolicy()}`);
}

bootstrap().catch((error) => {
  // Without this an async failure here is an unhandled rejection: the process
  // exits with a code the service manager reads as success and never restarts.
  new Logger('Bootstrap').error(`Failed to start: ${(error as Error).message}`, (error as Error).stack);
  process.exit(1);
});
