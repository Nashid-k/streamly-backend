import { config } from 'dotenv';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import compression = require('compression');
import { AppModule } from './app.module';

import { ConfigService } from '@nestjs/config';

// Resolve this relative to the backend source/build directory so `npm --prefix
// backend ...` and a root-level process both load backend/.env.
config({ path: join(__dirname, '..', '.env') });

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  
  app.use(compression());
  
  const frontendUrl = configService.get<string>('FRONTEND_URL');
  const allowedOrigins = frontendUrl 
    ? frontendUrl.split(',').map(url => url.trim()).filter(Boolean)
    : ['http://localhost:3000', 'http://localhost:3001', 'https://streamly-gules.vercel.app', 'https://streamlyvercelin.vercel.app'];

  // Keep browser access scoped to this application's frontend.
  app.enableCors({
    origin: allowedOrigins,
    methods: 'GET,HEAD,POST,DELETE,OPTIONS',
    exposedHeaders: ['Cache-Control'],
  });

  const port = configService.get<number>('PORT') || 4000;
  await app.listen(port, '0.0.0.0');
  console.log(`🚀 NestJS Backend running on port: ${port}`);
}
bootstrap();
