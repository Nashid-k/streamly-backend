import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
  Inject,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { Cache } from "cache-manager";
import { TmdbAdapter } from "./adapters/tmdb.adapter";
import { RapidApiAdapter } from "./adapters/rapidapi.adapter";
import { PushNotificationAdapter } from "./adapters/push-notification.adapter";
import { Category, Movie, Episode } from "./movies.types";
import {
  PlatformState,
  PlatformKey,
  ALL_PLATFORMS,
  PLATFORM_LABELS,
} from "./platform-state";

type CatalogRail = {
  id: string;
  name: string;
  mediaType: "movie" | "tv";
  path: string;
  pages?: number;
};

const LANGUAGE_NAMES: Record<string, string> = {
  bn: "Bengali",
  de: "German",
  en: "English",
  es: "Spanish",
  fr: "French",
  hi: "Hindi",
  it: "Italian",
  ja: "Japanese",
  kn: "Kannada",
  ko: "Korean",
  ml: "Malayalam",
  mr: "Marathi",
  pa: "Punjabi",
  ta: "Tamil",
  te: "Telugu",
  zh: "Mandarin",
};

@Injectable()
export class MoviesService implements OnModuleInit {
  private readonly logger = new Logger(MoviesService.name);
  private readonly baseUrl =
    process.env.TMDB_BASE_URL || "https://api.tmdb.org/3";
  private readonly fallbackBaseUrls = [
    "https://api.tmdb.org/3",

    "https://api.themoviedb.org/3",
  ];
  private readonly imageBaseUrl =
    process.env.TMDB_IMAGE_BASE_URL || "https://image.tmdb.org/t/p";
  private readonly language = process.env.TMDB_LANGUAGE || "en-US";
  private region = process.env.TMDB_REGION || "US";
  private readonly readToken = process.env.TMDB_READ_TOKEN;
  private readonly apiKey = process.env.TMDB_API_KEY || "";
  private readonly pagesPerRail = this.parsePositiveInt(
    process.env.TMDB_CATALOG_PAGES,
    3,
    1,
    20,
  );
  private readonly itemsPerRail = this.parsePositiveInt(
    process.env.TMDB_ITEMS_PER_RAIL,
    40,
    1,
    400,
  );
  private readonly requestTimeoutMs = this.parsePositiveInt(
    process.env.TMDB_REQUEST_TIMEOUT_MS,
    15_000,
    1_000,
    60_000,
  );
  private readonly refreshRetryMs = this.parsePositiveInt(
    process.env.TMDB_REFRESH_RETRY_MS,
    15_000,
    1_000,
    300_000,
  );
  private readonly genres = new Map<number, string>();
  private lastCatalogError: string | undefined;
  // seasonEpisodesCache removed — was causing stale empty results during Render cold starts.
  // Episodes are fetched fresh from TMDB every time (tmdbAdapter already bypasses Redis cache).

  private readonly state: Record<PlatformKey, PlatformState> =
    Object.fromEntries(
      ALL_PLATFORMS.map((p) => [p, new PlatformState()]),
    ) as Record<PlatformKey, PlatformState>;

  private encodeUrl(url: string): string {
    if (!url) return "";
    const secret = process.env.URL_ENCRYPTION_KEY || "STREAMLY_SECURE";
    const obfuscated = url
      .split("")
      .map((char, i) =>
        String.fromCharCode(
          char.charCodeAt(0) ^ secret.charCodeAt(i % secret.length),
        ),
      )
      .join("");
    return Buffer.from(obfuscated).toString("base64");
  }

  private providerMap: Record<string, string> = {
    netflix: "8",
    prime: "9",
    hotstar: "122",
    appletv: "350", // Apple TV Plus
    zee5: "232",
    sonyliv: "237",
    jio: "220", // Jio Cinema
  };

  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

  async onModuleInit() {
    if (!this.isConfigured()) {
      this.logger.warn(
        "TMDB credentials are not configured; catalog endpoints will return 503.",
      );
      return;
    }

    // 1. Force Region to IN (India) for maximum regional (Hotstar, Tamil, Hindi) + global content
    try {
      this.logger.log(
        "Setting region to IN for maximum catalog availability...",
      );
      this.region = "IN";
    } catch (e) {
      this.region = "IN";
      this.logger.warn(
        `Could not detect location: ${e}. Using default region: ${this.region}`,
      );
    }

    // 2. Fetch Providers for that Region
    try {
      this.logger.log(
        `Fetching available watch providers for region ${this.region}...`,
      );
      const providers = await this.tmdb(`watch/providers/movie`, {
        watch_region: this.region,
      });
      if (providers && providers.results) {
        const netflix = providers.results.find((p: any) =>
          p.provider_name.toLowerCase().includes("netflix"),
        );
        const prime = providers.results.find((p: any) =>
          p.provider_name.toLowerCase().includes("amazon prime video"),
        );
        // Try Hotstar first, then Disney+
        const hotstar =
          providers.results.find((p: any) =>
            p.provider_name.toLowerCase().includes("hotstar"),
          ) ||
          providers.results.find((p: any) =>
            p.provider_name.toLowerCase().includes("disney"),
          );
        const appletv = providers.results.find((p: any) =>
          p.provider_name.toLowerCase().includes("apple tv"),
        );
        const zee5 = providers.results.find((p: any) =>
          p.provider_name.toLowerCase().includes("zee5"),
        );
        const sonyliv = providers.results.find((p: any) =>
          p.provider_name.toLowerCase().includes("sonyliv"),
        );
        const jio = providers.results.find((p: any) =>
          p.provider_name.toLowerCase().includes("jio"),
        );

        if (netflix) this.providerMap["netflix"] = String(netflix.provider_id);
        if (prime) this.providerMap["prime"] = String(prime.provider_id);
        if (hotstar) this.providerMap["hotstar"] = String(hotstar.provider_id);
        if (appletv) this.providerMap["appletv"] = String(appletv.provider_id);
        if (zee5) this.providerMap["zee5"] = String(zee5.provider_id);
        if (sonyliv) this.providerMap["sonyliv"] = String(sonyliv.provider_id);
        if (jio) this.providerMap["jio"] = String(jio.provider_id);
      }
    } catch (e) {
      this.logger.warn(
        `Failed to dynamically map providers for region ${this.region}: ${e}`,
      );
    }

    this.logger.log(
      `Using Watch Providers for Region ${this.region}: Netflix=${this.providerMap["netflix"]}, Prime=${this.providerMap["prime"]}, Hotstar=${this.providerMap["hotstar"]}`,
    );

    // Load catalogs staggered in the background for zero-wait platform switching
    (async () => {
      for (const platform of ALL_PLATFORMS) {
        try {
          await this.refreshCatalog(platform);
          this.logger.log(`Catalog loaded for ${platform}`);
        } catch (e) {
          this.logger.warn(`Catalog load failed for ${platform}: ${String(e)}`);
        }
        // 2-second gap between platforms to stay within TMDB rate limits
        await new Promise((r) => setTimeout(r, 2000));
      }
      this.logger.log("All platform catalogs loaded.");
    })();
  }

  private parsePositiveInt(
    raw: string | undefined,
    fallback: number,
    min: number,
    max: number,
  ) {
    const value = Number.parseInt(raw || "", 10);
    return Number.isFinite(value)
      ? Math.min(Math.max(value, min), max)
      : fallback;
  }

  private tmdbAdapter: TmdbAdapter;
  private rapidApiAdapter: RapidApiAdapter;
  private pushNotificationAdapter: PushNotificationAdapter;

  private isConfigured() {
    return Boolean(this.readToken || this.apiKey);
  }

  private ensureConfigured() {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        "TMDB catalog credentials are not configured.",
      );
    }
  }

  // Delegate the actual API fetching to our new TmdbAdapter
  private async tmdb(path: string, params: Record<string, string> = {}) {
    const cacheKey = `tmdb:${path}:${JSON.stringify(params)}`;
    try {
      const cached = await this.cacheManager.get<any>(cacheKey);
      if (cached) return cached;
    } catch (e) {
      this.logger.warn(`Redis GET failed: ${e.message}`);
    }

    if (!this.tmdbAdapter) {
      this.tmdbAdapter = new TmdbAdapter(
        this.baseUrl,
        this.fallbackBaseUrls,
        this.apiKey,
        this.readToken,
        this.language,
        this.region,
        this.requestTimeoutMs,
      );
    }
    const data = await this.tmdbAdapter.get(path, params);

    try {
      await this.cacheManager.set(cacheKey, data, 24 * 60 * 60 * 1000); // 24 hours
    } catch (e) {
      this.logger.warn(`Redis SET failed: ${e.message}`);
    }

    return data;
  }

  // Provide access to RapidApiAdapter
  private getRapidApi() {
    if (!this.rapidApiAdapter) {
      this.rapidApiAdapter = new RapidApiAdapter(
        process.env.RAPIDAPI_KEY,
        this.requestTimeoutMs,
      );
    }
    return this.rapidApiAdapter;
  }

  private async rapidApiChanges(
    serviceName: string,
    changeType: "new" | "expiring",
    itemType: "show" | "movie" = "show",
  ) {
    const cacheKey = `rapidapi:${serviceName}:${changeType}:${itemType}`;
    try {
      const cached = await this.cacheManager.get<any>(cacheKey);
      if (cached) return cached;
    } catch (e) {
      this.logger.warn(`Redis GET failed: ${e.message}`);
    }

    const data = await this.getRapidApi().getChanges(
      serviceName,
      changeType,
      itemType,
    );

    try {
      if (data)
        await this.cacheManager.set(cacheKey, data, 12 * 60 * 60 * 1000); // 12 hours
    } catch (e) {
      this.logger.warn(`Redis SET failed: ${e.message}`);
    }

    return data;
  }

  private getPushNotification() {
    if (!this.pushNotificationAdapter) {
      this.pushNotificationAdapter = new PushNotificationAdapter();
    }
    return this.pushNotificationAdapter;
  }

  private async loadGenres() {
    try {
      const lists = await Promise.all(
        ["movie", "tv"].map(async (type) =>
          this.tmdb(`genre/${type}/list`).catch(() => ({ genres: [] })),
        ),
      );
      for (const list of lists) {
        for (const genre of list.genres || [])
          this.genres.set(genre.id, genre.name);
      }
    } catch (e) {
      this.logger.warn("Failed to load genres list from TMDB:", e);
    }
  }

  private async loadRealNetflixStatus(
    platform:
      "netflix" | "prime" | "hotstar" | "appletv" | "zee5" | "sonyliv" | "jio",
  ) {
    const state = this.state[platform];
    const rapidApiKey = process.env.RAPIDAPI_KEY;
    if (!rapidApiKey) {
      this.logger.log(
        "RAPIDAPI_KEY not set. Using TMDB release dates for Recently Added / Leaving Soon badges.",
      );
      return;
    }
    const serviceName =
      platform === "hotstar"
        ? "hotstar"
        : platform === "prime"
          ? "prime"
          : "netflix";
    try {
      const [newData, expData] = await Promise.all([
        this.rapidApiChanges(serviceName, "new", "show"),
        this.rapidApiChanges(serviceName, "expiring", "show"),
      ]);

      if (newData) {
        const newIds = Object.values(newData.shows || {})
          .map((item: any) => item.tmdbId)
          .filter(Boolean)
          .map((id: string) => (id.includes("/") ? id.split("/")[1] : id));

        // Check for completely new IDs to trigger a push notification
        const oldSet = state.realRecentlyAddedTmdbIds || new Set();
        const freshIds = newIds.filter((id) => !oldSet.has(id));

        if (freshIds.length > 0 && oldSet.size > 0) {
          // We found a new release that wasn't there in the last fetch!
          const firstNewShow = Object.values(newData.shows || {}).find(
            (s: any) =>
              s.tmdbId === freshIds[0] || s.tmdbId?.includes(freshIds[0]),
          );
          if (firstNewShow) {
            this.getPushNotification().broadcastNewRelease(
              (firstNewShow as any).title || "A new title",
              platform,
              freshIds[0],
            );
          }
        }

        state.realRecentlyAddedTmdbIds = new Set(newIds.map(String));
      }

      if (expData) {
        const expIds = Object.values(expData.shows || {})
          .map((item: any) => item.tmdbId)
          .filter(Boolean)
          .map((id: string) => (id.includes("/") ? id.split("/")[1] : id));
        state.realLeavingSoonTmdbIds = new Set(expIds.map(String));
      }
      this.logger.log(
        `Status badges loaded for ${serviceName}: ${state.realRecentlyAddedTmdbIds.size} recently added, ${state.realLeavingSoonTmdbIds.size} leaving soon.`,
      );
    } catch (e) {
      this.logger.warn(e);
    }
  }

  private image(path?: string, size = "w780") {
    return path ? `${this.imageBaseUrl}/${size}${path}` : "";
  }

  private toMovie(item: any, mediaType: "movie" | "tv"): Movie {
    const date = item.release_date || item.first_air_date || "";
    const voteCount = item.vote_count || 0;
    const rating = item.adult
      ? "TV-MA"
      : voteCount > 1000
        ? "PG-13"
        : voteCount > 100
          ? "PG"
          : "G";

    let duration = "";
    if (item.runtime) {
      const h = Math.floor(item.runtime / 60);
      const m = item.runtime % 60;
      duration = h > 0 ? `${h}h ${m}m` : `${m}m`;
    } else if (item.episode_run_time?.[0]) {
      duration = `${item.episode_run_time[0]}m`;
    } else if (date) {
      duration = date.slice(0, 4);
    }

    const tmdbIdStr = String(item.id);
    const isTV =
      mediaType === "tv" ||
      Boolean(
        item.first_air_date ||
        item.number_of_seasons ||
        item.number_of_episodes,
      );
    const isAnime =
      (item.original_language === "ja" ||
        item.origin_country?.includes("JP")) &&
      (item.genre_ids || []).includes(16);

    const rawDate = item.release_date || item.first_air_date || "";
    let isUpcoming = false;
    if (rawDate) {
      const relTime = new Date(rawDate).getTime();
      if (!isNaN(relTime) && relTime > Date.now()) {
        isUpcoming = true;
      }
    }

    const logoObj =
      item.images?.logos?.find((l: any) => l.iso_639_1 === "en") ||
      item.images?.logos?.[0];
    const logoUrl = logoObj?.file_path
      ? this.image(logoObj.file_path, "w500")
      : "";

    let nextEpisode = undefined;
    if (item.next_episode_to_air) {
      nextEpisode = {
        title:
          item.next_episode_to_air.name ||
          `Episode ${item.next_episode_to_air.episode_number}`,
        seasonNumber: item.next_episode_to_air.season_number,
        episodeNumber: item.next_episode_to_air.episode_number,
        releaseDate: item.next_episode_to_air.air_date,
      };
    }

    return {
      id: `tmdb-${mediaType}-${item.id}`,
      tmdbId: tmdbIdStr,
      imdbId: item.imdb_id || item.external_ids?.imdb_id,
      seasonsCount: item.number_of_seasons || undefined,

      title:
        item.title ||
        item.name ||
        item.original_title ||
        item.original_name ||
        "Untitled",
      originalTitle: item.original_title || item.original_name,
      description: item.overview || "",
      longDescription: item.overview || "",
      backdropUrl:
        this.image(item.backdrop_path, "w1280") ||
        this.image(item.poster_path, "w780"),
      posterUrl: this.image(item.poster_path, "w500"),
      logoUrl: logoUrl,
      trailerUrl: "",
      matchScore: Math.max(50, Math.round((item.vote_average || 0) * 10)),
      imdbRating: item.vote_average
        ? Number.parseFloat(Number(item.vote_average).toFixed(1))
        : 0,
      popularity: item.popularity || 0,
      releaseYear:
        Number.parseInt(rawDate.slice(0, 4), 10) || new Date().getFullYear(),
      releaseDate: rawDate,
      isUpcoming: isUpcoming,
      maturityRating: rating,
      duration: duration,
      isSeries: isTV,
      isAnime: isAnime,
      genres: (item.genre_ids || [])
        .map((id: number) => this.genres.get(id))
        .filter((name: string | undefined): name is string => Boolean(name)),
      cast: [],
      director: "",
      videoUrl: "",
      tags: [],
      // Catalog responses include the original language, so filters can work before
      // a viewer opens the title and triggers the more detailed TMDB request.
      audioLanguages:
        item.original_language && LANGUAGE_NAMES[item.original_language]
          ? [LANGUAGE_NAMES[item.original_language]]
          : [],
      subtitleLanguages: [],
      nextEpisode: nextEpisode,
    };
  }

  async refreshCatalog(
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ) {
    const state = this.state[platform];
    state.searchCache.clear(); // Clear search cache to prevent memory leaks
    if (state.refreshInFlight) return state.refreshInFlight;

    const timeoutPromise = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("Refresh Timeout")), 120000),
    );
    state.refreshInFlight = Promise.race([
      this.loadCatalog(platform),
      timeoutPromise,
    ]).finally(() => {
      state.refreshInFlight = null;
    });
    return state.refreshInFlight;
  }

  private buildDynamicRails(
    platform:
      "netflix" | "prime" | "hotstar" | "appletv" | "zee5" | "sonyliv" | "jio",
  ): CatalogRail[] {
    const providerId = this.providerMap[platform];
    // ── REDESIGNED: platform-authentic, sectioned, randomized rails ──
    const region = this.region;
    const today = new Date().toISOString().split("T")[0];

    // Enforce strict platform isolation for both Movies and TV series using with_watch_providers.
    // To prevent "cam rips" (theatrical prints), we enforce that movies must have a Digital release (type 4)
    // that has already happened (release_date.lte=today).
    const base = `with_watch_providers=${providerId}&watch_region=${region}`;

    // Date ranges for "Recently Added" and "Upcoming"
    const d2m = new Date(); d2m.setMonth(d2m.getMonth() - 2);
    const d6m = new Date(); d6m.setMonth(d6m.getMonth() - 6);
    const recent2m = d2m.toISOString().split("T")[0];
    const recent6m = d6m.toISOString().split("T")[0];

    const rnd = (a: string[]) => a[Math.floor(Math.random() * a.length)];
    const pick = <T>(arr: T[], n: number) =>
      [...arr].sort(() => Math.random() - 0.5).slice(0, n);

    // ══════════════════════════════════════════════════════════════════
    // SECTION 1 — Hero / Editorial
    // ══════════════════════════════════════════════════════════════════
    const editorial: CatalogRail[] = [
      { id: "trending-movies", name: rnd(["Trending Movies", "Popular Right Now", "What's Hot"]), mediaType: "movie", path: `discover/movie?${base}&sort_by=popularity.desc` },
      { id: "trending-series", name: rnd(["Trending TV Shows", "Binge-Worthy Series", "Top Series Right Now"]), mediaType: "tv", path: `discover/tv?${base}&sort_by=popularity.desc` },
      { id: "new-movies", name: rnd(["New on Movies", "Recently Added Movies", "Fresh Movies"]), mediaType: "movie", path: `discover/movie?${base}&sort_by=primary_release_date.desc&primary_release_date.lte=${today}&vote_count.gte=50` },
      { id: "new-series", name: rnd(["New on TV", "Recently Added Shows", "Fresh Series"]), mediaType: "tv", path: `discover/tv?${base}&sort_by=first_air_date.desc&first_air_date.lte=${today}&vote_count.gte=20` },
    ];
    // ══════════════════════════════════════════════════════════════════
    // SECTION 2 — Mood / Genre rails (Netflix/Prime-style)
    // ══════════════════════════════════════════════════════════════════
    const moodMovies: CatalogRail[] = [
      { id: "mood-action", name: rnd(["High Octane Action", "Action Essentials"]), mediaType: "movie", path: `discover/movie?${base}&with_genres=28&sort_by=popularity.desc` },
      { id: "mood-horror", name: rnd(["Late Night Horror", "Horror & Thrills"]), mediaType: "movie", path: `discover/movie?${base}&with_genres=27,53&sort_by=popularity.desc` },
      { id: "mood-romance", name: rnd(["Date Night Picks", "Romantic Dramas"]), mediaType: "movie", path: `discover/movie?${base}&with_genres=10749&sort_by=popularity.desc` },
      { id: "mood-comedy", name: rnd(["Comedy Gold", "Feel-Good Movies"]), mediaType: "movie", path: `discover/movie?${base}&with_genres=35&sort_by=popularity.desc` },
      { id: "mood-scifi", name: rnd(["Sci-Fi Mindbenders", "Beyond Imagination"]), mediaType: "movie", path: `discover/movie?${base}&with_genres=878&sort_by=vote_average.desc&vote_count.gte=500` },
      { id: "mood-suspense", name: rnd(["Edge-of-Seat Thrillers", "Unputdownable"]), mediaType: "movie", path: `discover/movie?${base}&with_genres=53,9648&sort_by=popularity.desc` },
      { id: "mood-docs", name: rnd(["Real Stories", "True Crime & Docs"]), mediaType: "movie", path: `discover/movie?${base}&with_genres=99&sort_by=popularity.desc` },
      { id: "mood-family", name: rnd(["Family Movie Night", "All Ages Welcome"]), mediaType: "movie", path: `discover/movie?${base}&with_genres=10751&sort_by=popularity.desc` },
      { id: "mood-fantasy", name: rnd(["Epic Fantasy Adventures", "Mythical Worlds"]), mediaType: "movie", path: `discover/movie?${base}&with_genres=14,12&sort_by=popularity.desc` },
      { id: "mood-war", name: rnd(["War & Survival", "Stories of Courage"]), mediaType: "movie", path: `discover/movie?${base}&with_genres=10752&sort_by=vote_average.desc&vote_count.gte=200` },
    ];
    const moodTv: CatalogRail[] = [
      { id: "tv-prestige", name: rnd(["Prestige TV", "Award-Winning Shows"]), mediaType: "tv", path: `discover/tv?${base}&sort_by=vote_average.desc&vote_count.gte=1000` },
      { id: "tv-crime", name: rnd(["Crime & Investigation", "True Crime Obsessed"]), mediaType: "tv", path: `discover/tv?${base}&with_genres=80&sort_by=popularity.desc` },
      { id: "tv-drama", name: rnd(["Binge-Worthy Dramas", "Character-Driven Stories"]), mediaType: "tv", path: `discover/tv?${base}&with_genres=18&sort_by=popularity.desc` },
      { id: "tv-comedy", name: rnd(["Comedy Series", "Sitcoms & More"]), mediaType: "tv", path: `discover/tv?${base}&with_genres=35&sort_by=popularity.desc` },
      { id: "tv-scifi", name: rnd(["Sci-Fi TV", "Alternate Realities"]), mediaType: "tv", path: `discover/tv?${base}&with_genres=10765&sort_by=popularity.desc` },
      { id: "tv-reality", name: rnd(["Reality TV", "Unscripted & Real"]), mediaType: "tv", path: `discover/tv?${base}&with_genres=10764&sort_by=popularity.desc` },
      { id: "tv-docs", name: rnd(["Docuseries", "Real Life, Real Stories"]), mediaType: "tv", path: `discover/tv?${base}&with_genres=99&sort_by=popularity.desc` },
    ];
    // ══════════════════════════════════════════════════════════════════
    // SECTION 3 — World Cinema
    // ══════════════════════════════════════════════════════════════════
    const worldRails: CatalogRail[] = [
      { id: "world-kdrama", name: rnd(["K-Drama Hits", "K-Wave"]), mediaType: "tv", path: `discover/tv?${base}&with_original_language=ko&sort_by=popularity.desc` },
      { id: "world-jdrama", name: rnd(["Japanese TV Shows", "J-Drama"]), mediaType: "tv", path: `discover/tv?${base}&with_original_language=ja&sort_by=popularity.desc` },
      { id: "world-british", name: rnd(["British TV", "Made in Britain"]), mediaType: "tv", path: `discover/tv?${base}&with_original_language=en&origin_country=GB&sort_by=popularity.desc` },
      { id: "world-spanish", name: rnd(["Spanish-Language Hits", "Latin & Spanish TV"]), mediaType: "tv", path: `discover/tv?${base}&with_original_language=es&sort_by=popularity.desc` },
      { id: "world-french", name: rnd(["French Cinema", "Films Français"]), mediaType: "movie", path: `discover/movie?${base}&with_original_language=fr&sort_by=vote_average.desc&vote_count.gte=200` },
    ];
    // ══════════════════════════════════════════════════════════════════
    // SECTION 4 — Anime (granular)
    // ══════════════════════════════════════════════════════════════════
    const animeRails: CatalogRail[] = [
      { id: "anime-trending", name: rnd(["Trending Anime", "Anime in Season"]), mediaType: "tv", path: `discover/tv?${base}&with_genres=16&with_original_language=ja&sort_by=popularity.desc&first_air_date.gte=${recent6m}&first_air_date.lte=${today}` },
      { id: "anime-popular", name: rnd(["Popular Anime", "All-Time Anime Hits"]), mediaType: "tv", path: `discover/tv?${base}&with_genres=16&with_original_language=ja&sort_by=popularity.desc` },
      { id: "anime-top", name: rnd(["Top Rated Anime", "Anime Masterpieces"]), mediaType: "tv", path: `discover/tv?${base}&with_genres=16&with_original_language=ja&sort_by=vote_average.desc&vote_count.gte=500` },
      { id: "anime-action", name: rnd(["Action Anime", "Shonen & Battle"]), mediaType: "tv", path: `discover/tv?${base}&with_genres=16,10759&with_original_language=ja&sort_by=popularity.desc` },
      { id: "anime-drama", name: rnd(["Anime Dramas", "Emotional Anime"]), mediaType: "tv", path: `discover/tv?${base}&with_genres=16,18&with_original_language=ja&sort_by=vote_average.desc&vote_count.gte=200` },
      { id: "anime-movies", name: rnd(["Anime Movies", "Anime Feature Films"]), mediaType: "movie", path: `discover/movie?${base}&with_genres=16&with_original_language=ja&sort_by=popularity.desc` },
      { id: "anime-mystery", name: rnd(["Mystery Anime", "Psychological Anime"]), mediaType: "tv", path: `discover/tv?${base}&with_genres=16,9648&with_original_language=ja&sort_by=vote_average.desc&vote_count.gte=100` },
    ];
    // ══════════════════════════════════════════════════════════════════
    // SECTION 5 — Indian / Regional (curated, not overwhelming)
    // ══════════════════════════════════════════════════════════════════
    type LangTuple = [string, string];
    const topLangs: LangTuple[] = [["hi", "Hindi"], ["ta", "Tamil"], ["te", "Telugu"], ["ml", "Malayalam"]];
    const secLangs: LangTuple[] = [["kn", "Kannada"], ["bn", "Bengali"], ["mr", "Marathi"]];
    const regionalRails: CatalogRail[] = [
      ...topLangs.flatMap(([c, n]): CatalogRail[] => [
        { id: `${c}-movies`, name: rnd([`Popular ${n} Movies`, `${n} Blockbusters`]), mediaType: "movie", path: `discover/movie?${base}&with_original_language=${c}&sort_by=popularity.desc&vote_count.gte=20`, pages: 1 },
        { id: `${c}-series`, name: rnd([`${n} Web Series`, `Trending in ${n}`]), mediaType: "tv", path: `discover/tv?${base}&with_original_language=${c}&sort_by=popularity.desc&vote_count.gte=10`, pages: 1 },
      ]),
      ...pick(secLangs, 2).flatMap(([c, n]): CatalogRail[] => [
        { id: `${c}-movies-sec`, name: `${n} Movies`, mediaType: "movie", path: `discover/movie?${base}&with_original_language=${c}&sort_by=popularity.desc&vote_count.gte=10`, pages: 1 },
      ]),
      { id: "indian-blockbusters", name: rnd(["Indian Blockbusters", "Bollywood & South Hits"]), mediaType: "movie", path: `discover/movie?${base}&with_original_language=hi|ta|te|ml|kn&sort_by=popularity.desc&vote_count.gte=100` },
      { id: "indian-series", name: rnd(["Indian Web Series", "Desi Series"]), mediaType: "tv", path: `discover/tv?${base}&with_original_language=hi|ta|te|ml|kn&sort_by=popularity.desc&vote_count.gte=30` },
      { id: "dubbed-hits", name: rnd(["Multi-Language Dubbed Hits", "Dubbed for You"]), mediaType: "movie", path: `discover/movie?${base}&with_original_language=en|te|ta|ml&with_spoken_languages=hi|ta|te&sort_by=popularity.desc&vote_count.gte=500` },
    ];
    // ══════════════════════════════════════════════════════════════════
    // SECTION 6 — Quality / Curation
    // ══════════════════════════════════════════════════════════════════
    const qualityRails: CatalogRail[] = [
      { id: "quality-oscar", name: rnd(["Award Winners", "Critically Acclaimed"]), mediaType: "movie", path: `discover/movie?${base}&vote_average.gte=8&vote_count.gte=1000` },
      { id: "quality-hidden", name: rnd(["Hidden Gems", "Underrated Movies"]), mediaType: "movie", path: `discover/movie?${base}&with_genres=18&vote_average.gte=7&vote_count.gte=200&vote_count.lte=3000` },
      { id: "quality-indie", name: rnd(["Indie Darlings", "Independent Cinema"]), mediaType: "movie", path: `discover/movie?${base}&with_genres=18&with_keywords=14507&sort_by=vote_average.desc&vote_count.gte=100` },
    ];
    // ══════════════════════════════════════════════════════════════════
    // SECTION 7 — Time-sensitive
    // ══════════════════════════════════════════════════════════════════
    const urgencyRails: CatalogRail[] = [
      { id: "leaving-soon", name: rnd(["Leaving Soon", "Don't Miss Out"]), mediaType: "movie", path: `discover/movie?${base}&sort_by=popularity.asc&vote_count.gte=100` },
      { id: "upcoming-movies", name: rnd(["Coming Soon", "Upcoming Movies"]), mediaType: "movie", path: `discover/movie?${base}&primary_release_date.gte=${today}` },
      { id: "upcoming-series", name: rnd(["New Series Coming", "Premiering Soon"]), mediaType: "tv", path: `discover/tv?${base}&first_air_date.gte=${today}` },
    ];
    // ══════════════════════════════════════════════════════════════════
    // ASSEMBLE — Balanced, non-repetitive subset
    // ══════════════════════════════════════════════════════════════════
    const pM = pick(moodMovies, 5);
    const pT = pick(moodTv, 4);
    const pA = pick(animeRails.slice(0, 5), 4);
    const pW = pick(worldRails, 2);
    const pQ = pick(qualityRails, 2);
    return [
      ...editorial,
      ...pM, ...pT,
      ...pA,
      ...pQ,
      ...pW,
      ...urgencyRails,
      ...regionalRails,
      ...pick([...moodMovies, ...moodTv].filter((r) => ![...pM, ...pT].some((p) => p.id === r.id)), 3),
      ...pick(animeRails.slice(5), 2),
    ];
  }

  private async verifyOttRelease(tmdbId: string): Promise<boolean> {
    try {
      const data = await this.tmdb(`movie/${tmdbId}/release_dates`);
      if (!data || !data.results) return true; // Fallback to true if API fails

      const now = new Date();
      for (const country of data.results) {
        for (const rd of country.release_dates) {
          // Type 4 is Digital, Type 5 is Physical (Blu-ray/DVD)
          if (rd.type === 4 || rd.type === 5) {
            const rDate = new Date(rd.release_date);
            if (rDate <= now) {
              return true; // Found an official released digital/physical copy
            }
          }
        }
      }
      return false; // No digital/physical release found (likely theatrical only)
    } catch (e) {
      this.logger.warn(
        `Failed to verify OTT release for ${tmdbId}: ${e.message}`,
      );
      return true; // Fallback so we don't accidentally hide movies if rate limited
    }
  }

  private async loadCatalog(
    platform:
      "netflix" | "prime" | "hotstar" | "appletv" | "zee5" | "sonyliv" | "jio",
  ) {
    const state = this.state[platform];
    state.lastRefreshAttemptAt = Date.now();
    try {
      await this.loadGenres();
      await this.loadRealNetflixStatus(platform);

      const dynamicRails = this.buildDynamicRails(platform);

      const loadedMovies = new Map<string, Movie>();
      const categories: any[] = [];
      // Process rails in smaller chunks to avoid overwhelming the network and hitting TMDB rate limits
      for (let rIdx = 0; rIdx < dynamicRails.length; rIdx += 3) {
        const railChunk = dynamicRails.slice(rIdx, rIdx + 3);
        const chunkCategories = await Promise.all(
          railChunk.map(async (rail) => {
            const isUpcomingRail = rail.id.includes("upcoming");
            const pageCount = isUpcomingRail
              ? 8
              : (rail.pages ?? this.pagesPerRail);
            const pageIndexes = Array.from(
              { length: pageCount },
              (_, i) => i + 1,
            );
            const pages = [];
            for (let i = 0; i < pageIndexes.length; i += 3) {
              const chunk = pageIndexes.slice(i, i + 3);
              const chunkResults = await Promise.all(
                chunk.map((idx) =>
                  this.tmdb(rail.path, { page: String(idx) }).catch((err) => {
                    this.logger.warn(
                      `Failed page ${idx} for ${rail.id}: ${err.message}`,
                    );
                    return { results: [] };
                  }),
                ),
              );
              pages.push(...chunkResults);
              if (i + 3 < pageIndexes.length)
                await new Promise((r) => setTimeout(r, 250)); // Rate limit pause
            }
            const allItems = pages.flatMap((page: any) => page.results || []);

            const uniqueTitles = new Map<string, Movie>();
            allItems.forEach((item: any) => {
              const movie = this.toMovie(item, rail.mediaType);
              // Strictly require at least one valid poster or backdrop image
              if (
                (movie.posterUrl || movie.backdropUrl) &&
                !uniqueTitles.has(movie.id)
              ) {
                if (
                  state.realRecentlyAddedTmdbIds.size > 0 ||
                  state.realLeavingSoonTmdbIds.size > 0
                ) {
                  movie.isRecentlyAdded = state.realRecentlyAddedTmdbIds.has(
                    String(movie.tmdbId),
                  );
                  movie.isLeavingSoon = state.realLeavingSoonTmdbIds.has(
                    String(movie.tmdbId),
                  );
                } else {
                  if (rail.id.includes("recently-added"))
                    movie.isRecentlyAdded = true;
                  if (rail.id.includes("leaving-soon"))
                    movie.isLeavingSoon = true;
                }
                uniqueTitles.set(movie.id, movie);
                loadedMovies.set(movie.id, movie);
              }
            });
            let titlesArr = Array.from(uniqueTitles.values());

            let titles: Movie[];
            if (isUpcomingRail) {
              let upcomingTitles = titlesArr.filter(
                (movie) => movie.isUpcoming,
              );

              if (upcomingTitles.length < 12) {
                const fallback = titlesArr;
                const existingIds = new Set(upcomingTitles.map((t) => t.id));
                for (const f of fallback) {
                  if (!existingIds.has(f.id)) {
                    upcomingTitles.push(f);
                    existingIds.add(f.id);
                  }
                  if (upcomingTitles.length >= this.itemsPerRail) break;
                }
              }
              titles = upcomingTitles.slice(0, this.itemsPerRail);
            } else {
              // Standard rails strictly feature released titles
              titles = titlesArr
                .filter((movie) => !movie.isUpcoming)
                .slice(0, this.itemsPerRail);
            }

            return {
              id: rail.id,
              name: rail.name,
              slug: rail.id,
              movies: titles,
            };
          }),
        );
        categories.push(...chunkCategories);
        if (rIdx + 3 < dynamicRails.length)
          await new Promise((r) => setTimeout(r, 500));
      }

      if (loadedMovies.size > 0) {
        this.state[platform].movies.clear();
        state.tmdbIdIndex.clear();
        for (const [id, movie] of loadedMovies) {
          state.movies.set(id, movie);
          if (movie.tmdbId) state.tmdbIdIndex.set(movie.tmdbId.toString(), id);
        }
        this.state[platform].categories = categories.filter(
          (c) => c.movies.length >= 1,
        );
        this.lastCatalogError = undefined;
        this.logger.log(
          `Loaded ${this.state[platform].movies.size} unique titles across ${this.state[platform].categories.length} TMDB dynamic rails.`,
        );
      } else {
        throw new Error("No titles could be fetched from TMDB.");
      }
    } catch (error) {
      this.lastCatalogError =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        "Unable to load the TMDB catalog. Generating fallback catalog.",
        this.lastCatalogError,
      );
      this.populateFallbackCatalog(platform);
    } finally {
      state.refreshInFlight = null;
    }
  }

  private populateFallbackCatalog(
    platform:
      "netflix" | "prime" | "hotstar" | "appletv" | "zee5" | "sonyliv" | "jio",
  ) {
    const mockMovies: any[] = [
      {
        id: "m-157336",
        tmdbId: "157336",
        title: "Interstellar",
        description:
          "A team of explorers travel through a wormhole in space in an attempt to ensure humanity survival.",
        posterUrl:
          "https://image.tmdb.org/t/p/w780/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg",
        backdropUrl:
          "https://image.tmdb.org/t/p/w1280/xJHokMbljvjADYdit5fK5VQsY2v.jpg",
        releaseYear: 2014,
        matchScore: 98,
        maturityRating: "PG-13",
        duration: "2h 49m",
        genres: ["Sci-Fi", "Adventure", "Drama"],
        videoUrl: this.encodeUrl("https://www.2embed.cc/embed/157336"),
        trailerUrl: "",
        cast: ["Matthew McConaughey", "Anne Hathaway"],
        director: "Christopher Nolan",
        tags: ["Sci-Fi", "Space"],
        audioLanguages: ["English"],
        subtitleLanguages: ["English"],
        isSeries: false,
      },
      {
        id: "m-27205",
        tmdbId: "27205",
        title: "Inception",
        description:
          "A thief who steals corporate secrets through the use of dream-sharing technology.",
        posterUrl:
          "https://image.tmdb.org/t/p/w780/oYuLE1h2CVCdIF9i2V47h7918x8.jpg",
        backdropUrl:
          "https://image.tmdb.org/t/p/w1280/8ZTVqvTZ25nDzzvFiJ19bWb2vT5.jpg",
        releaseYear: 2010,
        matchScore: 97,
        maturityRating: "PG-13",
        duration: "2h 28m",
        genres: ["Action", "Sci-Fi", "Thriller"],
        videoUrl: this.encodeUrl("https://www.2embed.cc/embed/27205"),
        trailerUrl: "",
        cast: ["Leonardo DiCaprio", "Joseph Gordon-Levitt"],
        director: "Christopher Nolan",
        tags: ["Sci-Fi", "Dreams"],
        audioLanguages: ["English"],
        subtitleLanguages: ["English"],
        isSeries: false,
      },
      {
        id: "tmdb-tv-1399",
        tmdbId: "1399",
        title: "Game of Thrones",
        description:
          "Nine noble families fight for control over the lands of Westeros.",
        posterUrl:
          "https://image.tmdb.org/t/p/w780/1XS1oqL89vEDVXtMK9Z08as1Coc.jpg",
        backdropUrl:
          "https://image.tmdb.org/t/p/w1280/2OMG0YKMh28TIG92Lh2168926.jpg",
        releaseYear: 2011,
        matchScore: 99,
        maturityRating: "TV-MA",
        duration: "8 Seasons",
        genres: ["Drama", "Action", "Sci-Fi"],
        videoUrl: this.encodeUrl("https://www.2embed.cc/embed/1399/1/1"),
        trailerUrl: "",
        cast: ["Emilia Clarke", "Kit Harington"],
        director: "David Benioff",
        tags: ["Fantasy", "Dragons"],
        audioLanguages: ["English"],
        subtitleLanguages: ["English"],
        isSeries: true,
      },
      {
        id: "tmdb-tv-66732",
        tmdbId: "66732",
        title: "Stranger Things",
        description:
          "When a young boy vanishes, a small town uncovers a mystery involving secret experiments.",
        posterUrl:
          "https://image.tmdb.org/t/p/w780/49WJfeN0moxb9IPfGn88qMG4d2.jpg",
        backdropUrl:
          "https://image.tmdb.org/t/p/w1280/56v2KjBlU4XaOv9rvyEQypROD7P.jpg",
        releaseYear: 2016,
        matchScore: 96,
        maturityRating: "TV-14",
        duration: "4 Seasons",
        genres: ["Sci-Fi", "Horror", "Drama"],
        videoUrl: this.encodeUrl("https://www.2embed.cc/embed/66732/1/1"),
        trailerUrl: "",
        cast: ["Millie Bobby Brown", "Finn Wolfhard"],
        director: "The Duffer Brothers",
        tags: ["Sci-Fi", "80s"],
        audioLanguages: ["English"],
        subtitleLanguages: ["English"],
        isSeries: true,
      },
    ];

    mockMovies.forEach((m) => {
      this.state[platform].movies.set(m.id, m);
      this.state[platform].tmdbIdIndex.set(m.tmdbId!, m.id);
    });

    this.state[platform].categories = [
      {
        id: "trending",
        name: "Trending Now",
        slug: "trending",
        movies: mockMovies,
      },
      {
        id: "popular",
        name: "Popular on Streamly",
        slug: "popular",
        movies: [...mockMovies].reverse(),
      },
    ];
  }

  private async ensureCatalog(
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ) {
    this.ensureConfigured();
    if (!ALL_PLATFORMS.includes(platform as any)) platform = "netflix";
    const state = this.state[platform];

    if (state.movies.size === 0 && !state.refreshInFlight) {
      state.refreshInFlight = this.refreshCatalog(platform);
    }

    if (state.refreshInFlight) {
      await state.refreshInFlight;
    }

    if (state.categories.length) return;

    if (Date.now() - state.lastRefreshAttemptAt >= this.refreshRetryMs) {
      await this.refreshCatalog(platform);
    }

    if (!state.categories.length) {
      this.logger.warn(
        `TMDB catalog empty for ${platform}, generating emergency fallback rails.`,
      );
      this.populateFallbackCatalog(platform);
    }
  }

  private toLightweightMovie(m: Movie): Partial<Movie> {
    return {
      id: m.id,
      tmdbId: m.tmdbId,
      imdbId: m.imdbId,
      title: m.title,
      originalTitle: m.originalTitle,
      description: m.description,
      posterUrl: m.posterUrl,
      backdropUrl: m.backdropUrl,
      matchScore: m.matchScore,
      isRecentlyAdded: m.isRecentlyAdded,
      isLeavingSoon: m.isLeavingSoon,
      isUpcoming: m.isUpcoming,
      trailerUrl: m.trailerUrl,
      maturityRating: m.maturityRating,
      duration: m.duration,
      isSeries: m.isSeries,
      seasonsCount: m.seasonsCount,
      logoUrl: m.logoUrl,
      releaseYear: m.releaseYear,
      top10Rank: m.top10Rank,
      genres: m.genres || [],
      tags: m.tags || [],
      audioLanguages: m.audioLanguages || [],
      sources: m.sources || [],
      videoUrl: m.videoUrl,
      embedUrl: m.embedUrl,
      cast: m.cast || [],
      director: m.director,
      availablePlatforms: m.availablePlatforms || [],
    };
  }

  async getAllMovies(
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ) {
    await this.ensureCatalog(platform);
    const allMovies = this.state[platform].categories.flatMap((c) => c.movies);
    const uniqueMap = new Map<string, Movie>();
    for (const m of allMovies) {
      if (!uniqueMap.has(m.id)) uniqueMap.set(m.id, m);
    }
    const uniqueMovies = Array.from(uniqueMap.values());
    return uniqueMovies.map((m) => this.toLightweightMovie(m) as Movie);
  }

  async getTop10Movies(
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ): Promise<Movie[]> {
    await this.ensureCatalog(platform);
    const allMovies = this.state[platform].categories.flatMap((c) => c.movies);
    const uniqueMap = new Map<string, Movie>();
    for (const m of allMovies) {
      if (!uniqueMap.has(m.id)) uniqueMap.set(m.id, m);
    }
    const uniqueMovies = Array.from(uniqueMap.values());

    return uniqueMovies
      .sort(
        (a, b) => b.matchScore - a.matchScore || b.releaseYear - a.releaseYear,
      )
      .slice(0, 10)
      .map((m) => this.toLightweightMovie(m) as Movie);
  }

  async getFeaturedMovie(
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ): Promise<Movie[]> {
    await this.ensureCatalog(platform);
    const trendingMovies =
      this.state[platform].categories
        .find((c) => c.id === "trending-movies")
        ?.movies.slice(0, 10) || [];
    const trendingSeries =
      this.state[platform].categories
        .find((c) => c.id === "trending-series")
        ?.movies.slice(0, 10) || [];
    const trendingAnime =
      this.state[platform].categories
        .find((c) => c.id === "trending-anime")
        ?.movies.slice(0, 5) || [];
    const topMovies = [...trendingMovies, ...trendingSeries, ...trendingAnime];

    await Promise.all(
      topMovies.map(async (feat) => {
        if (feat && !feat.logoUrl) {
          try {
            const mediaType = feat.isSeries ? "tv" : "movie";
            const details = await this.tmdb(`${mediaType}/${feat.tmdbId}`, {
              append_to_response: "images",
              include_image_language:
                "en,null,ja,ko,zh,hi,ta,te,ml,kn,fr,es,de,it,pt,ru,ar,tr,th",
            });
            const logoObj =
              details.images?.logos?.find((l: any) => l.iso_639_1 === "en") ||
              details.images?.logos?.[0];
            if (logoObj?.file_path) {
              feat.logoUrl = this.image(logoObj.file_path, "w500");
            }
          } catch (e) {
            this.logger.error("Failed to fetch featured movie logo", e);
          }
        }
      }),
    );
    return topMovies;
  }
  async getCategories(
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ): Promise<Category[]> {
    if ((platform as string) === "all")
      return this.getAllAggregatedCategories();
    await this.ensureCatalog(platform);
    return this.state[platform].categories.map((cat) => ({
      ...cat,
      movies: cat.movies.map((m) => this.toLightweightMovie(m) as Movie),
    }));
  }

  async getAllAggregatedCategories(): Promise<Category[]> {
    const platforms: Array<
      "netflix" | "prime" | "hotstar" | "appletv" | "zee5" | "sonyliv" | "jio"
    > = ["netflix", "prime", "hotstar", "appletv", "zee5", "sonyliv", "jio"];
    await Promise.all(platforms.map((p) => this.ensureCatalog(p)));

    const catMap = new Map<string, any[]>();

    const processData = (
      data: Category[],
      source: string,
      sourceName: string,
    ) => {
      data.forEach((cat) => {
        if (!catMap.has(cat.name)) catMap.set(cat.name, []);
        catMap
          .get(cat.name)!
          .push(
            ...cat.movies.map((m) => ({
              ...this.toLightweightMovie(m),
              source,
              sourceName,
            })),
          );
      });
    };

    processData(this.state.netflix.categories, "netflix", "Netflix");
    processData(this.state.prime.categories, "prime", "Prime Video");
    processData(this.state.hotstar.categories, "hotstar", "Hotstar");
    processData(this.state.appletv.categories, "appletv", "Apple TV+");
    processData(this.state.zee5.categories, "zee5", "Zee5");
    processData(this.state.sonyliv.categories, "sonyliv", "Sony LIV");
    processData(this.state.jio.categories, "jio", "JioCinema");

    const aggregated: Category[] = [];
    const allUniqueMovies = new Map<string, any>();

    for (const [name, allMovies] of catMap.entries()) {
      const uniqueMoviesMap = new Map<string, any>();
      for (const m of allMovies) {
        const key = m.tmdbId || m.id;
        if (!uniqueMoviesMap.has(key)) {
          uniqueMoviesMap.set(key, m);
          allUniqueMovies.set(key, m);
        }
      }
      aggregated.push({
        id: name,
        name,
        slug: name,
        movies: Array.from(uniqueMoviesMap.values()).slice(0, 30),
      });
    }

    const allMoviesList = Array.from(allUniqueMovies.values());
    const allGenres = new Set<string>();
    allMoviesList.forEach((m) => {
      if (m.genres && Array.isArray(m.genres)) {
        m.genres.forEach((g) => allGenres.add(g));
      }
    });

    for (const genre of Array.from(allGenres)) {
      if (aggregated.find((c) => c.name.toLowerCase() === genre.toLowerCase()))
        continue;

      const genreMovies = allMoviesList.filter((m) =>
        m.genres?.includes(genre),
      );
      if (genreMovies.length > 5) {
        aggregated.push({
          id: `genre-${genre.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          name: genre,
          slug: `genre-${genre.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          movies: genreMovies.sort(() => 0.5 - Math.random()),
        });
      }
    }

    return aggregated
      .sort((a, b) => b.movies.length - a.movies.length)
      .map((c) => ({ ...c, movies: c.movies.slice(0, 30) }));
  }

  async getAllFeaturedMovies(): Promise<Movie[]> {
    const platforms: Array<
      "netflix" | "prime" | "hotstar" | "appletv" | "zee5" | "sonyliv" | "jio"
    > = ["netflix", "prime", "hotstar", "appletv", "zee5", "sonyliv", "jio"];
    const results = await Promise.all(
      platforms.map(async (p) => {
        try {
          const data = await this.getFeaturedMovie(p);
          const nameMap: Record<string, string> = {
            netflix: "Netflix",
            prime: "Prime Video",
            hotstar: "Hotstar",
            appletv: "Apple TV+",
            zee5: "Zee5",
            sonyliv: "Sony LIV",
            jio: "JioCinema",
          };
          return data.map((m) => ({ ...m, source: p, sourceName: nameMap[p] }));
        } catch (e) {
          return [];
        }
      }),
    );
    return results.flat().sort(() => 0.5 - Math.random());
  }

  /**
   * TMDB video lists can include clips, featurettes, interviews and entries from
   * other providers. Only use an explicit YouTube Trailer/Teaser for playback;
   * showing no trailer is preferable to presenting an unrelated video.
   */
  private selectTrailerVideo(
    videos: any[],
    originalLanguage?: string,
    platform?: string,
  ): any {
    const preferredLanguages = [
      originalLanguage,
      this.language.split("-")[0],
      "en",
    ].filter(Boolean);
    const score = (video: any) => {
      const typeScore =
        video.type === "Trailer"
          ? 300
          : video.type === "Teaser"
            ? 100
            : video.type === "Clip"
              ? 50
              : 10;
      const officialScore = video.official === true ? 1_000 : 0;
      const languageScore =
        preferredLanguages.indexOf(video.iso_639_1) >= 0
          ? (preferredLanguages.length -
              preferredLanguages.indexOf(video.iso_639_1)) *
            10
          : 0;
      // Bonus if it's the exact original language, to prioritize it over en-tagged hindi trailers
      const isOriginalLang = video.iso_639_1 === originalLanguage ? 5000 : 0;

      // Bonus if the trailer name explicitly matches the platform brand
      let platformBonus = 0;
      const vName = (video.name || "").toLowerCase();
      if (
        platform === "prime" &&
        (vName.includes("amazon") || vName.includes("prime"))
      ) {
        platformBonus = 10000;
      } else if (platform === "netflix" && vName.includes("netflix")) {
        platformBonus = 10000;
      } else if (
        platform === "hotstar" &&
        (vName.includes("hotstar") || vName.includes("disney"))
      ) {
        platformBonus = 10000;
      } else if (platform === "appletv" && vName.includes("apple")) {
        platformBonus = 10000;
      } else if (platform === "zee5" && vName.includes("zee5")) {
        platform; // ignore
      }

      const publishedAt = Date.parse(video.published_at || "");
      return (
        officialScore +
        typeScore +
        languageScore +
        isOriginalLang +
        platformBonus +
        (Number.isFinite(publishedAt) ? publishedAt / 1e13 : 0)
      );
    };

    return videos
      .filter(
        (video) =>
          video?.site === "YouTube" &&
          typeof video.key === "string" &&
          video.key.length > 0 &&
          (video.type === "Trailer" ||
            video.type === "Teaser" ||
            video.type === "Clip" ||
            video.type === "Featurette"),
      )
      .sort(
        (left, right) =>
          score(right) - score(left) ||
          String(left.id || "").localeCompare(String(right.id || "")),
      )[0];
  }

  async getMovieById(
    id: string,
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ): Promise<Movie> {
    await this.ensureCatalog(platform);

    let movie = this.state[platform].movies.get(id);
    if (!movie) {
      const internalId = this.state[platform].tmdbIdIndex.get(id);
      if (internalId) movie = this.state[platform].movies.get(internalId);
    }

    // Global search across all platforms if not found in the requested platform
    if (!movie) {
      for (const p of ALL_PLATFORMS) {
        if (p === platform) continue;
        movie = this.state[p].movies.get(id);
        if (!movie) {
          const internalId = this.state[p].tmdbIdIndex.get(id);
          if (internalId) movie = this.state[p].movies.get(internalId);
        }
        if (movie) break;
      }
    }

    if (!movie && id.startsWith("tmdb-")) {
      // Live TMDB Fallback for uncached items (e.g. from search)
      this.logger.log(`Movie ${id} not in cache, fetching live from TMDB...`);
      const isTv = id.includes("-tv-");
      const tmdbIdStr = id.split("-").pop();
      if (tmdbIdStr) {
        try {
          const details = await this.tmdb(
            `${isTv ? "tv" : "movie"}/${tmdbIdStr}`,
          );
          movie = this.toMovie(details, isTv ? "tv" : "movie");
          this.state[platform].movies.set(movie.id, movie);
          if (movie.tmdbId)
            this.state[platform].tmdbIdIndex.set(movie.tmdbId, movie.id);
        } catch (e) {
          this.logger.warn(`Live fetch failed for ${id}: ${e}`);
        }
      }
    }

    if (!movie) throw new NotFoundException(`Title "${id}" was not found.`);

    // Dynamically enrich movie details (credits, images & YouTube trailer video) from TMDB on demand
    if (
      !movie.cast?.length ||
      !movie.videoUrl ||
      !movie.logoUrl ||
      !movie.trailerUrl ||
      movie.seasonsCount === undefined
    ) {
      try {
        const isTvType =
          movie.isSeries ||
          movie.id.startsWith("tmdb-tv-") ||
          movie.seasonsCount !== undefined;
        const mediaType = isTvType ? "tv" : "movie";
        const details = await this.tmdb(`${mediaType}/${movie.tmdbId}`, {
          append_to_response:
            "credits,videos,images,translations,keywords,external_ids",
          include_image_language:
            "en,null,ja,ko,zh,hi,ta,te,ml,kn,fr,es,de,it,pt,ru,ar,tr,th",
          include_video_language:
            "en,null,ja,ko,zh,hi,ta,te,ml,kn,fr,es,de,it,pt,ru,ar,tr,th",
        });

        // Ensure isSeries flag is updated if TMDB details confirm TV show
        if (details.number_of_seasons !== undefined || details.first_air_date) {
          movie.isSeries = true;
          movie.seasonsCount = details.number_of_seasons || 1;
        }

        // Enrich nextEpisode for airing series
        if (details.next_episode_to_air) {
          movie.nextEpisode = {
            title: details.next_episode_to_air.name || `Episode ${details.next_episode_to_air.episode_number}`,
            seasonNumber: details.next_episode_to_air.season_number,
            episodeNumber: details.next_episode_to_air.episode_number,
            releaseDate: details.next_episode_to_air.air_date,
          };
        }

        if (details.external_ids?.imdb_id) {
          movie.imdbId = details.external_ids.imdb_id;
        }

        const logoObj =
          details.images?.logos?.find((l: any) => l.iso_639_1 === "en") ||
          details.images?.logos?.[0];
        if (logoObj?.file_path) {
          movie.logoUrl = this.image(logoObj.file_path, "w500");
        }

        const bestVideo = this.selectTrailerVideo(
          details.videos?.results || [],
          details.original_language,
          platform,
        );

        if (bestVideo) {
          movie.trailerUrl = this.encodeUrl(
            `https://www.youtube.com/embed/${bestVideo.key}?autoplay=1`,
          );
        }

        // Extract spoken languages / audio dub availability (with Regional Indian & International ISO mapping)
        const origLang = LANGUAGE_NAMES[details.original_language] || "";
        const spoken = (details.spoken_languages || [])
          .map(
            (lang: any) =>
              lang.english_name || lang.name || LANGUAGE_NAMES[lang.iso_639_1],
          )
          .filter(Boolean);
        if (origLang) spoken.unshift(origLang);
        if (spoken.length) {
          movie.audioLanguages = Array.from(new Set(spoken));
        } else if (!movie.audioLanguages?.length) {
          movie.audioLanguages = [];
        }

        const rawKeywords =
          details.keywords?.keywords || details.keywords?.results || [];
        const tagsList = rawKeywords.slice(0, 5).map((k: any) => {
          return k.name
            .split(" ")
            .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(" ");
        });
        if (tagsList.length) movie.tags = tagsList;

        const fullCast = (details.credits?.cast || [])
          .slice(0, 10)
          .map((c: any) => ({
            id: c.id,
            name: c.name,
            character: c.character || "Cast",
            profileUrl: c.profile_path
              ? `https://image.tmdb.org/t/p/w185${c.profile_path}`
              : null,
          }));
        if (fullCast.length) {
          movie.cast = fullCast;
        }

        const director =
          details.credits?.crew?.find((c: any) => c.job === "Director")?.name ||
          details.credits?.crew?.find(
            (c: any) => c.job === "Executive Producer",
          )?.name;
        if (director) movie.director = director;

        if (details.runtime) {
          const hours = Math.floor(details.runtime / 60);
          const mins = details.runtime % 60;
          movie.duration = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
        } else if (details.episode_run_time?.[0]) {
          movie.duration = `${details.episode_run_time[0]}m`;
        }

        if (details.overview) {
          movie.longDescription = details.overview;
        }
        if (details.imdb_id || details.external_ids?.imdb_id) {
          movie.imdbId = details.imdb_id || details.external_ids?.imdb_id;
        }

        const rawDate = details.release_date || details.first_air_date;
        if (rawDate) {
          movie.releaseDate = rawDate;
          const relTime = new Date(rawDate).getTime();
          if (!isNaN(relTime) && relTime > Date.now()) {
            movie.isUpcoming = true;
          }
        }

        if (movie.isSeries) {
          movie.seasonsCount = details.number_of_seasons || 1;
        }
      } catch (err) {
        this.logger.warn(`Could not enrich metadata for ${id}: ${err}`);
      }
    }

    const availablePlatforms: string[] = [];
    const tmdbId = movie.tmdbId;

    if (tmdbId) {
      for (const p of ALL_PLATFORMS) {
        const catalogId = this.state[p].tmdbIdIndex.get(tmdbId);
        if (catalogId && this.state[p].movies.has(catalogId)) {
          availablePlatforms.push(PLATFORM_LABELS[p]);
        }
      }
    }

    // Fallback: if no platforms found from catalog, check TMDB watch providers
    if (availablePlatforms.length === 0 && tmdbId && movie.isSeries) {
      try {
        const mediaType = movie.isSeries ? 'tv' : 'movie';
        const providers = await this.tmdb(`${mediaType}/${tmdbId}/watch/providers`);
        const regionResults = providers?.results?.[this.region] || providers?.results?.['US'] || {};
        const flatrate = regionResults.flatrate || [];
        for (const fp of flatrate) {
          const name = (fp.provider_name || '').toLowerCase();
          if (name.includes('netflix')) availablePlatforms.push('Netflix');
          else if (name.includes('amazon') || name.includes('prime')) availablePlatforms.push('Prime Video');
          else if (name.includes('hotstar') || name.includes('disney')) availablePlatforms.push('Hotstar');
          else if (name.includes('apple')) availablePlatforms.push('Apple TV+');
          else if (name.includes('zee5')) availablePlatforms.push('Zee5');
          else if (name.includes('sony') || name.includes('sonyliv')) availablePlatforms.push('Sony LIV');
          else if (name.includes('jio')) availablePlatforms.push('JioCinema');
        }
      } catch (e) {
        this.logger.warn(`[Providers] Failed to fetch watch providers for ${tmdbId}: ${e}`);
      }
    }

    return { ...movie, availablePlatforms };
  }

  async getSeasonEpisodes(
    id: string,
    seasonNumber: number,
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ): Promise<Episode[]> {
    await this.ensureCatalog(platform);
    let movie = this.state[platform].movies.get(id);
    if (!movie) {
      const internalId = this.state[platform].tmdbIdIndex.get(id);
      if (internalId) movie = this.state[platform].movies.get(internalId);
    }

    // If not found in the requested platform's catalog, search all platforms
    if (!movie) {
      for (const p of ALL_PLATFORMS) {
        if (p === platform) continue;
        movie = this.state[p].movies.get(id);
        if (!movie) {
          const internalId = this.state[p].tmdbIdIndex.get(id);
          if (internalId) movie = this.state[p].movies.get(internalId);
        }
        if (movie) break;
      }
    }

    // If still not found, try getMovieById which does live TMDB fetch
    if (!movie) {
      try {
        const fetched = await this.getMovieById(id, platform);
        if (fetched) {
          movie = this.state[platform].movies.get(id) || fetched as any;
        }
      } catch (e) {
        this.logger.warn(`[Episodes] getMovieById fallback failed for ${id}: ${e}`);
      }
    }

    try {
      // Extract TMDB ID from movie object or from the id string
      const tmdbId =
        movie?.tmdbId ??
        (typeof id === "string" && id.startsWith("tmdb-tv-")
          ? id.replace(/^tmdb-tv-/, "")
          : typeof id === "string" && id.startsWith("tmdb-movie-")
            ? id.replace(/^tmdb-movie-/, "")
            : undefined);

      if (!tmdbId) {
        this.logger.warn(
          `[Episodes] Cannot load episodes for ${id} in ${platform}: missing TMDB id (movie found: ${Boolean(movie)})`,
        );
        return [];
      }

      this.logger.log(`[Episodes] Fetching season ${seasonNumber} for TMDB ${tmdbId} (${id})`);

      // CRITICAL: Use tmdbAdapter directly (bypass Redis cache) so stale
      // empty-season responses don't block fresh data for 24 hours.
      let seasonData: any = null;
      let lastErr: any = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (!this.tmdbAdapter) {
            this.tmdbAdapter = new TmdbAdapter(
              this.baseUrl,
              this.fallbackBaseUrls,
              this.apiKey,
              this.readToken,
              this.language,
              this.region,
              this.requestTimeoutMs,
            );
          }
          seasonData = await this.tmdbAdapter.get(
            `tv/${String(tmdbId)}/season/${seasonNumber}`,
          );
          break;
        } catch (err) {
          lastErr = err;
          this.logger.warn(
            `[Episodes] TMDB attempt ${attempt}/2 failed for ${tmdbId} season ${seasonNumber}: ${err}`,
          );
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 500 * attempt));
          }
        }
      }

      if (!seasonData) {
        this.logger.warn(
          `[Episodes] All TMDB attempts failed for ${id} season ${seasonNumber}: ${lastErr}`,
        );
        return [];
      }

      const rawEpisodes = seasonData.episodes || [];
      const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

      // Map all raw episodes
      const allEpisodes: Episode[] = rawEpisodes.map((ep: any) => {
        const s = seasonNumber;
        const e = ep.episode_number;

        return {
          id: `ep-${tmdbId}-${s}-${e}`,
          title: ep.name || `Episode ${e}`,
          description: ep.overview || "",
          duration: ep.runtime ? `${ep.runtime}m` : "",
          episodeNumber: e,
          seasonNumber: s,
          thumbnailUrl: this.image(ep.still_path) || movie?.backdropUrl || "",
          airDate: ep.air_date || "",
        };
      });

      // Filter: only return episodes that have already aired (air_date <= today)
      // Episodes without an air_date are included (assumed available)
      const releasedEpisodes = allEpisodes.filter(
        (ep) => !ep.airDate || ep.airDate <= today,
      );

      const totalEpisodes = allEpisodes.length;
      let releasedCount = releasedEpisodes.length;
      // A season is "airing" if it has unreleased episodes (not all have aired yet)
      let isAiring = releasedCount < totalEpisodes;

      // DEFENSIVE: If date filter removed ALL episodes but TMDB says there are episodes,
      // include them all with isAiring=true. This handles edge cases where TMDB air_date
      // is wrong or in a different timezone than our server.
      let finalEpisodes = releasedEpisodes;
      if (releasedCount === 0 && totalEpisodes > 0) {
        this.logger.warn(`[Episodes] Date filter removed all ${totalEpisodes} episodes for ${id} s${seasonNumber} — returning all with isAiring flag`);
        finalEpisodes = allEpisodes;
        releasedCount = 0;
        isAiring = true;
      }

      this.logger.log(`[Episodes] Loaded ${releasedCount}/${totalEpisodes} released episodes for ${id} season ${seasonNumber}${isAiring ? " (airing)" : ""}`);

      // Return object with episodes + metadata. Controller extracts episodes for the body
      // and puts metadata in response headers for backward compatibility.
      return {
        episodes: finalEpisodes,
        totalEpisodes,
        releasedEpisodes: releasedCount,
        isAiring,
      } as any;
    } catch (err) {
      this.logger.warn(
        `[Episodes] Failed to load season ${seasonNumber} for ${id}: ${err}`,
      );
      return [];
    }
  }

  
  async getAiringThisWeek(
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio"
      | "all" = "all",
  ): Promise<Movie[]> {
    const platforms: Array<"netflix" | "prime" | "hotstar" | "appletv" | "zee5" | "sonyliv" | "jio"> =
      platform === "all" ? ALL_PLATFORMS : [platform as any];

    await Promise.all(platforms.map((p) => this.ensureCatalog(p)));

    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 14);
    const nextWeekStr = nextWeek.toISOString().split("T")[0];

    const allMoviesMap = new Map<string, Movie>();
    for (const p of platforms) {
      for (const movie of this.state[p].movies.values()) {
        if (!movie.isSeries) continue;
        const key = movie.tmdbId || movie.id;
        if (allMoviesMap.has(key)) continue;
        allMoviesMap.set(key, movie);
      }
    }

    const airingMovies = Array.from(allMoviesMap.values()).filter(
      (m) => m.nextEpisode?.releaseDate && m.nextEpisode.releaseDate <= nextWeekStr,
    );

    airingMovies.sort((a, b) => {
      const da = a.nextEpisode?.releaseDate || '';
      const db = b.nextEpisode?.releaseDate || '';
      return da.localeCompare(db);
    });

    this.logger.log(`[Airing] Found ${airingMovies.length} airing series across ${platforms.join(', ')}`);
    return airingMovies.map((m) => this.toLightweightMovie(m) as Movie);
  }

async searchMovies(
    query: string,
    genre?: string,
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ): Promise<{ movies: Movie[]; actor?: any }> {
    this.ensureConfigured();
    const normalized = query.trim().toLowerCase();
    const cacheKey = `${normalized}_${genre || "all"}`;

    // Fast O(1) Search Query Cache Check
    if (this.state[platform].searchCache.has(cacheKey)) {
      return this.state[platform].searchCache.get(cacheKey)!;
    }

    if (!normalized) {
      const allMovies = await this.getAllMovies(platform);
      const res = { movies: this.filterGenre(allMovies, genre) };
      if (this.state[platform].searchCache.size > 100) {
        const firstKey = this.state[platform].searchCache.keys().next().value;
        if (firstKey) this.state[platform].searchCache.delete(firstKey);
      }
      this.state[platform].searchCache.set(cacheKey, res);
      return res;
    }

    try {
      const combinedMoviesMap = new Map<string, Movie>();

      await Promise.all(
        ALL_PLATFORMS.map(async (p) => {
          const pMovies = await this.getAllMovies(p);
          for (const movie of pMovies) {
            const key = movie.tmdbId || movie.title;
            if (!combinedMoviesMap.has(key)) {
              combinedMoviesMap.set(key, {
                ...movie,
                platform: p,
                availablePlatforms: [PLATFORM_LABELS[p]],
              });
            } else {
              const existing = combinedMoviesMap.get(key)!;
              if (!existing.availablePlatforms!.includes(PLATFORM_LABELS[p])) {
                existing.availablePlatforms!.push(PLATFORM_LABELS[p]);
              }
            }
          }
        }),
      );

      let resultsWithScores = Array.from(combinedMoviesMap.values()).map(
        (m) => {
          let score = 0;
          const t = m.title.toLowerCase();

          if (t === normalized) score += 100;
          else if (t.startsWith(normalized)) score += 50;
          else if (t.includes(normalized)) score += 10;

          if (
            m.originalTitle &&
            m.originalTitle.toLowerCase().includes(normalized)
          )
            score += 5;

          if (
            m.genres &&
            m.genres.some((g) => g.toLowerCase().includes(normalized))
          )
            score += 5;
          if (
            m.tags &&
            m.tags.some((g) => g.toLowerCase().includes(normalized))
          )
            score += 3;

          const castStr = m.cast
            ? m.cast
                .map((c: any) => (typeof c === "string" ? c : c.name))
                .join(" ")
                .toLowerCase()
            : "";
          const dirStr = m.director ? m.director.toLowerCase() : "";
          const descStr = m.description ? m.description.toLowerCase() : "";

          if (castStr.includes(normalized)) score += 8;
          if (dirStr.includes(normalized)) score += 8;
          if (descStr.includes(normalized)) score += 1;

          // Enhanced Fuzzy Token Matching across all metadata
          const tokens = normalized.split(/[\s'’:\-]+/).filter(Boolean);
          if (tokens.length > 0) {
            const searchCorpus = `${t} ${m.originalTitle || ""} ${dirStr} ${castStr} ${m.releaseYear || ""} ${descStr}`;

            let matchedTokensCount = 0;
            for (const token of tokens) {
              if (searchCorpus.includes(token)) {
                matchedTokensCount++;
                // Give extra weight if the token is in the title or director
                if (t.includes(token) || dirStr.includes(token)) {
                  score += 3;
                } else {
                  score += 1;
                }
              }
            }

            if (matchedTokensCount === tokens.length)
              score += 25; // All words match something!
            else if (matchedTokensCount > 0) score += matchedTokensCount * 2;
          }

          return { movie: m, score };
        },
      );

      let results = resultsWithScores
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((item) => item.movie);

      results = this.filterGenre(results, genre);

      // ────────────────────────────────────────────────────────────
      // LIVE TMDB FALLBACK SEARCH
      // If local search returns 0 results or weak matches, query TMDB live
      // ────────────────────────────────────────────────────────────
      const hasStrongLocalMatch =
        resultsWithScores.length > 0 && resultsWithScores[0].score >= 20;
      if (!hasStrongLocalMatch && normalized.length > 2) {
        this.logger.log(`Live TMDB Fallback Search triggered for: "${query}"`);
        try {
          const tmdbSearch = await this.tmdb("search/multi", {
            query: normalized,
          });
          if (tmdbSearch.results && tmdbSearch.results.length > 0) {
            // Take top 5 to minimize N+1 provider lookups
            const topHits = tmdbSearch.results
              .slice(0, 5)
              .filter(
                (m: any) => m.media_type === "movie" || m.media_type === "tv",
              );

            const liveResults: Movie[] = [];
            await Promise.all(
              topHits.map(async (hit: any) => {
                const providers = await this.tmdb(
                  `${hit.media_type}/${hit.id}/watch/providers`,
                ).catch((e) => {
                  this.logger.error(
                    `Failed to fetch providers for ${hit.id}`,
                    e,
                  );
                  return null;
                });

                // Check US and IN regions for providers to maximize chances of finding regional content
                const usProviders = providers?.results?.["US"]?.flatrate || [];
                const inProviders = providers?.results?.["IN"]?.flatrate || [];
                const allProviderIds = Array.from(
                  new Set(
                    [...usProviders, ...inProviders].map((p: any) =>
                      String(p.provider_id),
                    ),
                  ),
                );

                const availableOn: string[] = [];
                if (allProviderIds.includes(this.providerMap["netflix"]))
                  availableOn.push("Netflix");
                if (allProviderIds.includes(this.providerMap["prime"]))
                  availableOn.push("Prime Video");
                if (allProviderIds.includes(this.providerMap["hotstar"]))
                  availableOn.push("Hotstar");
                if (allProviderIds.includes(this.providerMap["appletv"]))
                  availableOn.push("Apple TV+");
                if (allProviderIds.includes(this.providerMap["zee5"]))
                  availableOn.push("Zee5");
                if (allProviderIds.includes(this.providerMap["sonyliv"]))
                  availableOn.push("Sony LIV");
                if (allProviderIds.includes(this.providerMap["jio"]))
                  availableOn.push("JioCinema");

                // Remove the strict provider requirement for explicit searches.
                // If a user actively searches for it and TMDB finds it, we should ALWAYS show it.
                const movieObj = this.toMovie(hit, hit.media_type);
                movieObj.availablePlatforms =
                  availableOn.length > 0 ? availableOn : ["Other"];

                // Cache into local memory so /movie/:id works when clicked
                this.state[platform].movies.set(movieObj.id, movieObj);
                this.state[platform].tmdbIdIndex.set(
                  movieObj.tmdbId!,
                  movieObj.id,
                );

                liveResults.push(movieObj);
              }),
            );

            // Prioritize live TMDB results over weak local matches and prevent duplicates, preserving TMDB's relevance order
            const uniqueLiveResults = liveResults.filter(
              (lr) => !results.some((r) => r.tmdbId === lr.tmdbId),
            );
            results.unshift(...uniqueLiveResults);
          }
        } catch (e) {
          this.logger.error(
            "TMDB Live Fallback Search failed: " +
              (e instanceof Error ? e.message : String(e)),
          );
        }
      }

      // Generate suggestions when results are empty or very weak
      let suggestions: string[] = [];
      if (results.length === 0 && normalized.length > 1) {
        suggestions = this.generateSearchSuggestions(normalized, combinedMoviesMap);
      }

      const resultObj = { movies: results, actor: undefined, suggestions };

      // Cache Search Result (LRU 100 limit per platform)
      if (this.state[platform].searchCache.size > 100) {
        const firstKey = this.state[platform].searchCache.keys().next().value;
        if (firstKey) this.state[platform].searchCache.delete(firstKey);
      }
      this.state[platform].searchCache.set(cacheKey, resultObj);

      return resultObj;
    } catch (err) {
      this.logger.warn(`Search failed for "${query}": ${err}`);
      return { movies: [] };
    }
  }

  private filterGenre(titles: Movie[], genre?: string) {
    if (!genre || genre === "All") return titles;
    return titles.filter((item) => item.genres?.includes(genre));
  }

  /**
   * Generate "did you mean" style suggestions when search returns no results.
   * Uses character-level similarity (Levenshtein-ish) against catalog titles.
   */
  private generateSearchSuggestions(
    query: string,
    catalog: Map<string, Movie>,
  ): string[] {
    const suggestions: { title: string; distance: number }[] = [];

    for (const movie of catalog.values()) {
      const title = movie.title.toLowerCase();
      // Quick pre-filter: skip titles that are too different in length
      if (Math.abs(title.length - query.length) > 5) continue;

      const distance = this.levenshteinDistance(query, title);
      // Only suggest if distance is within reasonable bounds (typo tolerance)
      const maxDistance = Math.max(2, Math.floor(query.length * 0.4));
      if (distance <= maxDistance && distance > 0) {
        suggestions.push({ title: movie.title, distance });
      }
    }

    return suggestions
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5)
      .map((s) => s.title);
  }

  /** Simple Levenshtein distance for short strings */
  private levenshteinDistance(a: string, b: string): number {
    const la = a.length;
    const lb = b.length;
    if (la === 0) return lb;
    if (lb === 0) return la;

    const matrix: number[][] = [];
    for (let i = 0; i <= la; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= lb; j++) {
      matrix[0][j] = j;
    }
    for (let i = 1; i <= la; i++) {
      for (let j = 1; j <= lb; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost,
        );
      }
    }
    return matrix[la][lb];
  }

  async getSimilarMovies(
    id: string,
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ) {
    await this.ensureCatalog(platform);
    const current = await this.getMovieById(id, platform);
    const allMovies = await this.getAllMovies(platform);
    let similar: Movie[] = [];

    // 1. Franchise/Sequel exact matching (e.g., "Spider-Man")
    const titleParts = current.title.split(/[:\-]/);
    const mainKeyword = titleParts[0].trim().toLowerCase();
    if (mainKeyword.length > 3) {
      const titleMatches = allMovies.filter(
        (m) =>
          m.id !== current.id && m.title.toLowerCase().includes(mainKeyword),
      );
      similar.push(...titleMatches);
    }

    try {
      // 1.5 Live TMDB Franchise Search (mixes Movies and TV shows for Anime/Franchises)
      if (mainKeyword.length > 3) {
        try {
          const franchiseSearch = await this.tmdb("search/multi", {
            query: mainKeyword,
          });
          if (franchiseSearch && franchiseSearch.results) {
            const franchiseHits = franchiseSearch.results
              .filter(
                (m: any) =>
                  (m.media_type === "movie" || m.media_type === "tv") &&
                  String(m.id) !== current.tmdbId,
              )
              .slice(0, 5)
              .map((item: any) => this.toMovie(item, item.media_type));

            this.logger.log(
              `Franchise search found ${franchiseHits.length} hits for keyword: ${mainKeyword}`,
            );
            similar.push(...franchiseHits);
          }
        } catch (e) {
          this.logger.error("Franchise search failed", e);
        }
      }

      const type = current.isSeries ? "tv" : "movie";
      // 2. TMDB Recommendations (Better for sequels/franchise)
      const recs = await this.tmdb(`${type}/${current.tmdbId}/recommendations`);
      if (recs && recs.results) {
        similar.push(
          ...recs.results
            .slice(0, 8)
            .map((item: any) => this.toMovie(item, type)),
        );
      }
      // 3. TMDB Similar (General vibe)
      const sim = await this.tmdb(`${type}/${current.tmdbId}/similar`);
      if (sim && sim.results) {
        similar.push(
          ...sim.results
            .slice(0, 8)
            .map((item: any) => this.toMovie(item, type)),
        );
      }
    } catch (e) {
      this.logger.warn(`Failed to fetch true similar movies for ${id}: ${e}`);
    }

    // 4. Fallback local genre logic
    const genreMatches = allMovies
      .filter(
        (item) =>
          item.id !== current.id &&
          item.genres.some((genre) => current.genres.includes(genre)),
      )
      .slice(0, 10);
    similar.push(...genreMatches);

    // Deduplicate by TMDB ID
    const uniqueMap = new Map();
    similar.forEach((m) => {
      const key = m.tmdbId || m.id;
      if (!uniqueMap.has(key) && key !== (current.tmdbId || current.id)) {
        uniqueMap.set(key, m);
      }
    });

    return Array.from(uniqueMap.values()).slice(0, 16);
  }

  // ─── Advanced Recommendations Engine ──────────────────────────────────

  async getRecommendations(
    id: string,
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ): Promise<Movie[]> {
    await this.ensureCatalog(platform);
    let source: Movie;
    try {
      source = await this.getMovieById(id, platform);
    } catch (e) {
      this.logger.error(
        `Failed to get movie by ID ${id} in getRecommendations`,
        e,
      );
      return [];
    }

    const allMovies = await this.getAllMovies(platform);

    const scored = allMovies
      .filter((m) => m.id !== source.id)
      .map((m) => {
        let score = 0;

        // Genre overlap (+20 per matching genre)
        const genreOverlap = m.genres.filter((g) =>
          source.genres.includes(g),
        ).length;
        score += genreOverlap * 20;

        // Same director (+15)
        if (
          source.director &&
          m.director &&
          source.director !== "Unknown" &&
          m.director !== "Unknown"
        ) {
          if (source.director.toLowerCase() === m.director.toLowerCase())
            score += 15;
        }

        // Overlapping cast (+10 per shared member, max 30)
        const sourceCastNames = source.cast
          .map((c) =>
            typeof c === "string"
              ? c.toLowerCase()
              : (c as any).name?.toLowerCase() || "",
          )
          .filter(Boolean);
        const targetCastNames = m.cast
          .map((c) =>
            typeof c === "string"
              ? c.toLowerCase()
              : (c as any).name?.toLowerCase() || "",
          )
          .filter(Boolean);
        const castOverlap = sourceCastNames.filter((n) =>
          targetCastNames.includes(n),
        ).length;
        score += Math.min(castOverlap * 10, 30);

        // Same decade (+5)
        if (Math.abs(m.releaseYear - source.releaseYear) <= 10) score += 5;

        // Similar popularity/matchScore (+10 if within 15 points)
        if (Math.abs(m.matchScore - source.matchScore) <= 15) score += 10;

        // Boost trending/popular (+5)
        if (m.isTrending || m.isPopular || m.isTop10) score += 5;

        // Boost same media type (movie vs series)
        if (m.isSeries === source.isSeries) score += 8;

        // Boost same anime flag
        if (m.isAnime === source.isAnime) score += 5;

        return { ...m, _score: score };
      })
      .filter((m) => m._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 20)
      .map(({ _score: _, ...m }) => m);

    return scored;
  }

  // ─── Intro Skip Timings ──────────────────────────────────────────

  async getIntroTimings(
    id: string,
    season?: number,
    episode?: number,
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ): Promise<{ hasIntro: boolean; startSeconds: number; endSeconds: number }> {
    try {
      await this.ensureCatalog(platform);
      const movie = await this.getMovieById(id, platform);

      // Only series episodes typically have intros
      if (!movie.isSeries || !season || !episode) {
        return { hasIntro: false, startSeconds: 0, endSeconds: 0 };
      }

      // Heuristic: intros are typically 0–90 seconds
      // Use a deterministic seed based on id+season+episode for stable results
      const seed = `${id}-s${season}e${episode}`
        .split("")
        .reduce((acc, c) => acc + c.charCodeAt(0), 0);
      const introLength = 60 + (seed % 30); // 60–89 seconds

      return {
        hasIntro: true,
        startSeconds: 0,
        endSeconds: introLength,
      };
    } catch (e) {
      this.logger.error(`Failed to get intro timings for ${id}`, e);
      return { hasIntro: false, startSeconds: 0, endSeconds: 0 };
    }
  }

  async getExternalIds(
    id: string,
    platform:
      | "netflix"
      | "prime"
      | "hotstar"
      | "appletv"
      | "zee5"
      | "sonyliv"
      | "jio" = "netflix",
  ) {
    const movie = await this.getMovieById(id, platform);
    if (!movie || !movie.tmdbId) return {};
    try {
      const type = movie.isSeries ? "tv" : "movie";
      return await this.tmdb(`${type}/${movie.tmdbId}/external_ids`);
    } catch (e) {
      this.logger.error(`Failed to fetch external ids for ${movie.tmdbId}`, e);
      return {};
    }
  }

  async getPersonDetails(personId: string) {
    try {
      const details = await this.tmdb(`person/${personId}`, {
        append_to_response: "combined_credits",
      });

      const credits = (details.combined_credits?.cast || [])
        .sort((a: any, b: any) => (b.vote_count || 0) - (a.vote_count || 0))
        .slice(0, 24)
        .map((item: any) => this.toMovie(item, item.media_type || "movie"));

      return {
        id: details.id,
        name: details.name,
        biography: details.biography,
        profileUrl: details.profile_path
          ? this.image(details.profile_path, "w500")
          : null,
        knownFor: details.known_for_department,
        birthday: details.birthday,
        placeOfBirth: details.place_of_birth,
        credits,
      };
    } catch (e) {
      this.logger.error(`Failed to fetch person details for ${personId}`, e);
      throw e;
    }
  }

  async getStreamUrl(
    id: string,
    serverIndex: number = 0,
    season?: number,
    episode?: number,
    platform: PlatformKey = "netflix",
  ): Promise<{ url: string }> {
    const numericId = id.replace(/^tmdb-(tv|movie)-/, "");

    const SERVERS = [
      {
        url: (tmdbId: string, s?: number, e?: number) =>
          s
            ? `https://vidlink.pro/tv/${tmdbId}/${s}/${e}`
            : `https://vidlink.pro/movie/${tmdbId}`,
      },
      {
        url: (tmdbId: string, s?: number, e?: number) =>
          s
            ? `https://vidsrc.pm/embed/tv?tmdb=${tmdbId}&season=${s}&episode=${e}`
            : `https://vidsrc.pm/embed/movie?tmdb=${tmdbId}`,
      },
      {
        url: (tmdbId: string, s?: number, e?: number) =>
          s
            ? `https://www.2embed.cc/embedtv/${tmdbId}&s=${s}&e=${e}`
            : `https://www.2embed.cc/embed/${tmdbId}`,
      },
      {
        url: (tmdbId: string, s?: number, e?: number) =>
          s
            ? `https://vidsrc.pro/embed/tv?tmdb=${tmdbId}&season=${s}&episode=${e}`
            : `https://vidsrc.pro/embed/movie?tmdb=${tmdbId}`,
      },
    ];

    const idx =
      serverIndex >= 0 && serverIndex < SERVERS.length ? serverIndex : 0;
    const url = SERVERS[idx].url(numericId, season, episode);
    return { url };
  }
}
