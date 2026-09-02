import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  UseInterceptors,
} from "@nestjs/common";
import { Response } from "express";
import { CacheInterceptor } from "@nestjs/cache-manager";
import { MoviesService } from "./movies.service";
import { Movie, Category } from "./movies.types";

/** Set Cache-Control header. staleWhileRevalidate is in seconds. */
function setCache(
  res: Response,
  maxAgeSeconds: number,
  staleWhileRevalidateSeconds = 60,
) {
  res.setHeader(
    "Cache-Control",
    `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}, must-revalidate`,
  );
  res.setHeader("Vary", "Accept, Accept-Encoding, Origin");
}

/** No-cache for critical dynamic data */
function setNoCache(res: Response) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Vary", "Accept, Accept-Encoding, Origin");
}

@Controller("api/movies")
export class MoviesController {
  constructor(private readonly moviesService: MoviesService) {}

  @Get()
  async getAllMovies(
    @Res({ passthrough: true }) res: Response,
    @Query("platform")
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ): Promise<Movie[]> {
    setCache(res, 120);
    return this.moviesService.getAllMovies(platform);
  }

  @Get("featured")
  async getFeatured(
    @Res({ passthrough: true }) res: Response,
    @Query("platform")
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio"
      | "all" = "netflix",
  ): Promise<Movie[]> {
    setCache(res, 120);
    if (platform === "all") return this.moviesService.getAllFeaturedMovies();
    return this.moviesService.getFeaturedMovie(platform as any);
  }

  @Get("categories")
  async getCategories(
    @Res({ passthrough: true }) res: Response,
    @Query("platform")
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio"
      | "all" = "netflix",
  ): Promise<Category[]> {
    setCache(res, 120);
    return this.moviesService.getCategories(platform as any);
  }

  @Get("top10")
  async getTop10(
    @Res({ passthrough: true }) res: Response,
    @Query("platform")
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ): Promise<Movie[]> {
    setCache(res, 120);
    return this.moviesService.getTop10Movies(platform);
  }

  @Get("search")
  async searchMovies(
    @Res({ passthrough: true }) res: Response,
    @Query("q") query?: string,
    @Query("genre") genre?: string,
    @Query("platform")
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ): Promise<{ movies: Movie[]; actor?: any }> {
    res.setHeader("Cache-Control", "public, max-age=3600");
    const safeQuery = (query || "").slice(0, 200);
    const result = await this.moviesService.searchMovies(
      safeQuery,
      genre,
      platform,
    );
    return result;
  }

  @Get("person/:personId")
  async getPerson(
    @Res({ passthrough: true }) res: Response,
    @Param("personId") personId: string,
  ) {
    setCache(res, 86400); // 24-hour cache
    return this.moviesService.getPersonDetails(personId);
  }

  @Get(":id/stream-url")
  async getStreamUrl(
    @Res({ passthrough: true }) res: Response,
    @Param("id") id: string,
    @Query("server") server?: string,
    @Query("season") season?: string,
    @Query("episode") episode?: string,
    @Query("platform")
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ): Promise<{ url: string; error?: string }> {
    const result = await this.moviesService.getStreamUrl(
      id,
      server ? parseInt(server, 10) : 0,
      season ? parseInt(season, 10) : undefined,
      episode ? parseInt(episode, 10) : undefined,
      platform,
    );
    if (result.error) {
      res.status(403);
    } else {
      setCache(res, 3600);
    }
    return result;
  }

  @Get(":id")
  async getMovieById(
    @Res({ passthrough: true }) res: Response,
    @Param("id") id: string,
    @Query("platform")
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ): Promise<Movie> {
    setCache(res, 300, 60); // 5-min browser cache with 60s stale-while-revalidate
    return this.moviesService.getMovieById(id, platform);
  }

  @Get(":id/similar")
  async getSimilar(
    @Res({ passthrough: true }) res: Response,
    @Param("id") id: string,
    @Query("platform")
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ): Promise<Movie[]> {
    const validPlatforms = [
      "netflix",
      "prime",
      "hotstar",
      "appletv",
      "zee5",
      "sonyliv",
      "jio",
    ];
    if (!validPlatforms.includes(platform)) platform = "netflix";
    setCache(res, 600, 120); // 10-min cache for similar movies
    return this.moviesService.getSimilarMovies(id, platform);
  }

  @Get(":id/season/:seasonNumber")
  async getSeasonEpisodes(
    @Res({ passthrough: true }) res: Response,
    @Param("id") id: string,
    @Param("seasonNumber") seasonNumber: string,
    @Query("platform")
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ) {
    setCache(res, 60, 30); // 1-min browser cache with 30s stale-while-revalidate for episodes
    // Clamp season number to a sane range to prevent abuse
    const season = Math.min(
      Math.max(Number.parseInt(seasonNumber, 10) || 1, 1),
      50,
    );
    const result = await this.moviesService.getSeasonEpisodes(id, season, platform);
    // Add metadata as response headers (episodes body stays a plain array for compat)
    if (result && typeof result === 'object' && 'episodes' in result) {
      const r = result as any;
      res.setHeader('X-Total-Episodes', String(r.totalEpisodes ?? 0));
      res.setHeader('X-Released-Episodes', String(r.releasedEpisodes ?? 0));
      res.setHeader('X-Is-Airing', String(r.isAiring ?? false));
      return r.episodes;
    }
    return result;
  }

  @Get(":id/recommendations")
  async getRecommendations(
    @Res({ passthrough: true }) res: Response,
    @Param("id") id: string,
    @Query("platform")
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ): Promise<Movie[]> {
    setCache(res, 300);
    return this.moviesService.getRecommendations(id, platform);
  }

  @Get(":id/intro")
  async getIntroTimings(
    @Res({ passthrough: true }) res: Response,
    @Param("id") id: string,
    @Query("season") season?: string,
    @Query("episode") episode?: string,
    @Query("platform")
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ) {
    setCache(res, 86400); // 24-hour cache for intro timings
    const s = season ? parseInt(season, 10) : undefined;
    const e = episode ? parseInt(episode, 10) : undefined;
    return this.moviesService.getIntroTimings(id, s, e, platform);
  }

  @Get(":id/external_ids")
  async getExternalIds(
    @Res({ passthrough: true }) res: Response,
    @Param("id") id: string,
    @Query("platform")
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ) {
    setCache(res, 86400); // 24-hour browser cache
    return this.moviesService.getExternalIds(id, platform);
  }

  @Get("airing")
  async getAiringThisWeek(
    @Res({ passthrough: true }) res: Response,
    @Query("platform")
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio"
      | "all" = "all",
  ) {
    setCache(res, 300, 60);
    return this.moviesService.getAiringThisWeek(platform as any);
  }

}
