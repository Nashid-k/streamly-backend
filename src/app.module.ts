import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { MoviesModule } from './movies/movies.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { AppController } from './app.controller';

import * as Joi from 'joi';
import { ConfigModule } from '@nestjs/config';

/**
 * Cache configuration:
 * - In-memory (default): 4-hour TTL for TMDB catalog responses
 * - Redis (production): Set REDIS_URL env var and install @keyv/redis:
 *   npm install @keyv/redis && npm install cacheable
 *   Then update this module to use KeyvRedis store.
 */
const cacheConfig = CacheModule.register({
  isGlobal: true,
  ttl: 4 * 60 * 60 * 1000, // 4 hours in ms
});

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        PORT: Joi.number().default(4000),
        TMDB_API_KEY: Joi.string().required(),
        TMDB_READ_TOKEN: Joi.string().optional(),
        RAPIDAPI_KEY: Joi.string().optional(),
        FRONTEND_URL: Joi.string().default('http://localhost:3000'),
      }),
    }),
    cacheConfig,
    MoviesModule,
    UsersModule,
    AuthModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
