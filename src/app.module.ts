import { Module, Logger } from "@nestjs/common";
import { CacheModule } from "@nestjs/cache-manager";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { MoviesModule } from "./movies/movies.module";
import { AppController } from "./app.controller";

import * as Joi from "joi";
import { ConfigModule, ConfigService } from "@nestjs/config";

import KeyvRedis from "@keyv/redis";

const cacheConfig = CacheModule.registerAsync({
  isGlobal: true,
  inject: [ConfigService],
  useFactory: async (configService: ConfigService) => {
    const redisUrl = configService.get<string>("REDIS_URL");
    if (redisUrl) {
      try {
        const store = new KeyvRedis(redisUrl);
        // Error listener allows it to gracefully degrade if Redis crashes mid-flight
        store.on("error", (err) =>
          Logger.warn(
            `Redis connection error: ${err.message}. Falling back to memory cache.`,
          ),
        );
        Logger.log("Successfully initialized Distributed Redis Cache");
        return {
          store: store,
          ttl: 4 * 60 * 60 * 1000,
        };
      } catch (error) {
        Logger.warn(
          `Failed to connect to Redis: ${error.message}. Falling back to in-memory cache.`,
        );
      }
    }
    // Fallback to in-memory cache
    Logger.log("Initialized Local Memory Cache");
    return {
      ttl: 4 * 60 * 60 * 1000, // 4 hours
    };
  },
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
        FRONTEND_URL: Joi.string().default("http://localhost:3000"),
        // Firebase is used by the frontend directly; the backend no longer
        // requires credentials. Kept optional for compatibility with existing env.
        FIREBASE_PROJECT_ID: Joi.string().optional(),
        FIREBASE_CLIENT_EMAIL: Joi.string().optional(),
        FIREBASE_PRIVATE_KEY: Joi.string().optional(),
      }),
    }),
    // Rate Limiting: Max 30 requests per 10 seconds per IP
    ThrottlerModule.forRoot([
      {
        ttl: 10000,
        limit: 30,
      },
    ]),
    cacheConfig,
    MoviesModule,
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
