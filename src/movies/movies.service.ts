import { Injectable, Logger, NotFoundException, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Category, Movie, Episode } from './movies.types';

type CatalogRail = { id: string; name: string; mediaType: 'movie' | 'tv'; path: string; pages?: number };

const LANGUAGE_NAMES: Record<string, string> = {
  bn: 'Bengali', de: 'German', en: 'English', es: 'Spanish', fr: 'French', hi: 'Hindi',
  it: 'Italian', ja: 'Japanese', kn: 'Kannada', ko: 'Korean', ml: 'Malayalam', mr: 'Marathi',
  pa: 'Punjabi', ta: 'Tamil', te: 'Telugu', zh: 'Mandarin',
};

@Injectable()
export class MoviesService implements OnModuleInit {
  private readonly logger = new Logger(MoviesService.name);
  private readonly baseUrl = process.env.TMDB_BASE_URL || 'https://api.tmdb.org/3';
  private readonly fallbackBaseUrls = [
    'https://api.tmdb.org/3',
    
    
    'https://api.themoviedb.org/3',
  ];
  private readonly imageBaseUrl = process.env.TMDB_IMAGE_BASE_URL || 'https://image.tmdb.org/t/p';
  private readonly language = process.env.TMDB_LANGUAGE || 'en-US';
  private region = process.env.TMDB_REGION || 'US';
  private readonly readToken = process.env.TMDB_READ_TOKEN;
  private readonly apiKey = process.env.TMDB_API_KEY || '';
  private readonly pagesPerRail = this.parsePositiveInt(process.env.TMDB_CATALOG_PAGES, 3, 1, 20);
  private readonly itemsPerRail = this.parsePositiveInt(process.env.TMDB_ITEMS_PER_RAIL, 40, 1, 400);
  private readonly requestTimeoutMs = this.parsePositiveInt(process.env.TMDB_REQUEST_TIMEOUT_MS, 15_000, 1_000, 60_000);
  private readonly refreshRetryMs = this.parsePositiveInt(process.env.TMDB_REFRESH_RETRY_MS, 15_000, 1_000, 300_000);
  private readonly genres = new Map<number, string>();
  private lastCatalogError: string | undefined;

  private state = {
    nflix: { movies: new Map<string, Movie>(), tmdbIdIndex: new Map<string, string>(), titleIndex: new Map<string, string[]>(), genreIndex: new Map<string, string[]>(), categories: [] as Category[], realRecentlyAddedTmdbIds: new Set<string>(), realLeavingSoonTmdbIds: new Set<string>(), lastRefreshAttemptAt: 0, refreshInFlight: null as Promise<void> | null, searchCache: new Map<string, { movies: Movie[]; actor?: any }>() },
    nprime: { movies: new Map<string, Movie>(), tmdbIdIndex: new Map<string, string>(), titleIndex: new Map<string, string[]>(), genreIndex: new Map<string, string[]>(), categories: [] as Category[], realRecentlyAddedTmdbIds: new Set<string>(), realLeavingSoonTmdbIds: new Set<string>(), lastRefreshAttemptAt: 0, refreshInFlight: null as Promise<void> | null, searchCache: new Map<string, { movies: Movie[]; actor?: any }>() },
    hotstar: { movies: new Map<string, Movie>(), tmdbIdIndex: new Map<string, string>(), titleIndex: new Map<string, string[]>(), genreIndex: new Map<string, string[]>(), categories: [] as Category[], realRecentlyAddedTmdbIds: new Set<string>(), realLeavingSoonTmdbIds: new Set<string>(), lastRefreshAttemptAt: 0, refreshInFlight: null as Promise<void> | null, searchCache: new Map<string, { movies: Movie[]; actor?: any }>() },
  };

  private encodeUrl(url: string): string {
    if (!url) return '';
    const secret = process.env.URL_ENCRYPTION_KEY || 'STREAMLY_SECURE';
    const obfuscated = url.split('').map((char, i) => String.fromCharCode(char.charCodeAt(0) ^ secret.charCodeAt(i % secret.length))).join('');
    return Buffer.from(obfuscated).toString('base64');
  }

  private providerMap: Record<string, string> = {
    'nflix': '8',
    'nprime': '9',
    'hotstar': '122' // Fallbacks
  };

  async onModuleInit() {
    if (!this.isConfigured()) {
      this.logger.warn('TMDB credentials are not configured; catalog endpoints will return 503.');
      return;
    }
    
    // 1. Force Region to IN (India) for maximum regional (Hotstar, Tamil, Hindi) + global content
    try {
      this.logger.log('Setting region to IN for maximum catalog availability...');
      this.region = 'IN';
    } catch (e) {
      this.region = 'IN';
      this.logger.warn(`Could not detect location: ${e}. Using default region: ${this.region}`);
    }

    // 2. Fetch Providers for that Region
    try {
      this.logger.log(`Fetching available watch providers for region ${this.region}...`);
      const providers = await this.tmdb(`watch/providers/movie`, { watch_region: this.region });
      if (providers && providers.results) {
        const nflix = providers.results.find((p: any) => p.provider_name.toLowerCase().includes('netflix'));
        const nprime = providers.results.find((p: any) => p.provider_name.toLowerCase().includes('amazon prime video'));
        // Try Hotstar first, then Disney+
        const hotstar = providers.results.find((p: any) => p.provider_name.toLowerCase().includes('hotstar')) || 
                        providers.results.find((p: any) => p.provider_name.toLowerCase().includes('disney'));
        
        if (nflix) this.providerMap['nflix'] = String(nflix.provider_id);
        if (nprime) this.providerMap['nprime'] = String(nprime.provider_id);
        if (hotstar) this.providerMap['hotstar'] = String(hotstar.provider_id);
      }
    } catch (e) {
      this.logger.warn(`Failed to dynamically map providers for region ${this.region}: ${e}`);
    }
    
    this.logger.log(`Using Watch Providers for Region ${this.region}: Netflix=${this.providerMap['nflix']}, Prime=${this.providerMap['nprime']}, Hotstar=${this.providerMap['hotstar']}`);

    // Load all 3 platform catalogs concurrently in the background for zero-wait platform switching
    (async () => {
      try {
        await Promise.allSettled([
          this.refreshCatalog("nflix"),
          this.refreshCatalog("nprime"),
          this.refreshCatalog("hotstar"),
        ]);
        this.logger.log('All platform catalogs (Netflix, Prime Video, Hotstar) loaded into memory.');
      } catch (e) {
        this.logger.warn('Catalog background load failed: ' + String(e));
      }
    })();
  }

  private parsePositiveInt(raw: string | undefined, fallback: number, min: number, max: number) {
    const value = Number.parseInt(raw || '', 10);
    return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
  }

  private isConfigured() {
    return Boolean(this.readToken || this.apiKey);
  }

  private ensureConfigured() {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('TMDB catalog credentials are not configured.');
    }
  }

  private async tmdb(path: string, params: Record<string, string> = {}) {
    this.ensureConfigured();
    const query = new URLSearchParams({ language: this.language, ...params });
    if (this.region) query.set('region', this.region);
    if (!this.readToken && this.apiKey) query.set('api_key', this.apiKey);

    const baseUrls = Array.from(new Set([this.baseUrl, ...this.fallbackBaseUrls]));
    let lastError: any;

    for (const base of baseUrls) {
      try {
        // Discovery rails already have query parameters. Use URL instead of
        // appending a second `?`, which otherwise turns the later filters into
        // part of the first parameter value.
        const url = new URL(`${base}/${path}`);
        for (const [key, value] of query) url.searchParams.set(key, value);
        const response = await fetch(url, {
          headers: this.readToken ? { Authorization: `Bearer ${this.readToken}`, Accept: 'application/json' } : { Accept: 'application/json' },
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        if (!response.ok) throw new Error(`TMDB ${path} failed with ${response.status}`);
        return await response.json();
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error(`TMDB ${path} failed on all endpoints.`);
  }

  private async loadGenres() {
    try {
      const lists = await Promise.all(['movie', 'tv'].map(async (type) => this.tmdb(`genre/${type}/list`).catch(() => ({ genres: [] }))));
      for (const list of lists) {
        for (const genre of list.genres || []) this.genres.set(genre.id, genre.name);
      }
    } catch (e) {
      this.logger.warn('Failed to load genres list from TMDB:', e);
    }
  }

  private async loadRealNetflixStatus(platform: "nflix" | "nprime" | "hotstar") {
    const state = this.state[platform];
    const rapidApiKey = process.env.RAPIDAPI_KEY;
    if (!rapidApiKey) {
      this.logger.log('RAPIDAPI_KEY not set. Using TMDB release dates for Recently Added / Leaving Soon badges.');
      return;
    }
    const serviceName = platform === 'hotstar' ? 'hotstar' : (platform === 'nprime' ? 'prime' : 'netflix');
    try {
      const headers = {
        'X-RapidAPI-Key': rapidApiKey,
        'X-RapidAPI-Host': 'streaming-availability.p.rapidapi.com',
      };

      const [newRes, expRes] = await Promise.all([
        fetch(`https://streaming-availability.p.rapidapi.com/changes?country=us&services=${serviceName}&change_type=new&item_type=show`, { headers }).catch(() => null),
        fetch(`https://streaming-availability.p.rapidapi.com/changes?country=us&services=${serviceName}&change_type=expiring&item_type=show`, { headers }).catch(() => null),
      ]);

      if (newRes && newRes.ok) {
        const newData = await newRes.json();
        const newIds = Object.values(newData.shows || {})
          .map((item: any) => item.tmdbId)
          .filter(Boolean)
          .map((id: string) => id.includes('/') ? id.split('/')[1] : id);
        state.realRecentlyAddedTmdbIds = new Set(newIds.map(String));
      }

      if (expRes && expRes.ok) {
        const expData = await expRes.json();
        const expIds = Object.values(expData.shows || {})
          .map((item: any) => item.tmdbId)
          .filter(Boolean)
          .map((id: string) => id.includes('/') ? id.split('/')[1] : id);
        state.realLeavingSoonTmdbIds = new Set(expIds.map(String));
      }
      this.logger.log(`Status badges loaded for ${serviceName}: ${state.realRecentlyAddedTmdbIds.size} recently added, ${state.realLeavingSoonTmdbIds.size} leaving soon.`);
    } catch (e) {
      this.logger.log('RapidAPI status badge fetch skipped, using TMDB release dates fallback.');
    }
  }

  private image(path?: string, size = 'w780') {
    return path ? `${this.imageBaseUrl}/${size}${path}` : '';
  }

  private toMovie(item: any, mediaType: 'movie' | 'tv'): Movie {
    const date = item.release_date || item.first_air_date || '';
    const voteCount = item.vote_count || 0;
    const rating = item.adult ? 'TV-MA' : voteCount > 1000 ? 'PG-13' : voteCount > 100 ? 'PG' : 'G';
    
    let duration = '';
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
    const isTV = mediaType === 'tv' || Boolean(item.first_air_date || item.number_of_seasons || item.number_of_episodes);
    const rawEmbedUrl = isTV
      ? `https://www.2embed.cc/embed/${tmdbIdStr}/1/1`
      : `https://www.2embed.cc/embed/${tmdbIdStr}`;
    const embedUrl = this.encodeUrl(rawEmbedUrl);

    const isAnime = (item.original_language === 'ja' || item.origin_country?.includes('JP')) && (item.genre_ids || []).includes(16);

    // VidLink params: brand it red like Netflix, show next-episode button, show title
    const vl = 'primaryColor=E50914&secondaryColor=141414&iconColor=FFFFFF&nextButton=true&title=false&poster=false&autoplay=true';

    const rawSources = isTV ? [
      { name: 'VidLink',     url: `https://vidlink.pro/tv/${tmdbIdStr}/1/1?${vl}`,                                           type: 'stream' as const },
      { name: 'AutoEmbed',   url: `https://autoembed.co/tv/tmdb/${tmdbIdStr}-1-1`,                                           type: 'stream' as const },
      { name: 'VidSrc.pro',  url: `https://vidsrc.pro/embed/tv/${tmdbIdStr}/1/1`,                                            type: 'stream' as const },
      { name: 'VidSrc.cc',   url: `https://vidsrc.cc/v2/embed/tv/${tmdbIdStr}/1/1`,                                          type: 'stream' as const },
      { name: 'Embed.su',    url: `https://embed.su/embed/tv/${tmdbIdStr}/1/1`,                                              type: 'stream' as const },
      { name: '2Embed (Cineby)', url: `https://www.2embed.cc/embed/${tmdbIdStr}/1/1`,                                       type: 'stream' as const },
      { name: 'VidSrc',      url: `https://vidsrc.pm/embed/tv/${tmdbIdStr}/1/1`,                                            type: 'stream' as const },
      { name: 'Mapple (4KHD)',   url: `https://www.2embed.cc/embed/${tmdbIdStr}/1/1#mapple`,                                type: 'stream' as const },
      { name: 'Main',        url: `https://multiembed.mov/directstream.php?video_id=${tmdbIdStr}&tmdb=1&s=1&e=1`,            type: 'stream' as const },
      { name: 'Prime',       url: `https://primestream.io/embed/tv/${tmdbIdStr}/1/1`,                                        type: 'stream' as const }
    ] : [
      { name: 'VidLink',     url: `https://vidlink.pro/movie/${tmdbIdStr}?${vl}`,                                            type: 'stream' as const },
      { name: 'AutoEmbed',   url: `https://autoembed.co/movie/tmdb/${tmdbIdStr}`,                                            type: 'stream' as const },
      { name: 'VidSrc.pro',  url: `https://vidsrc.pro/embed/movie/${tmdbIdStr}`,                                             type: 'stream' as const },
      { name: 'VidSrc.cc',   url: `https://vidsrc.cc/v2/embed/movie/${tmdbIdStr}`,                                           type: 'stream' as const },
      { name: 'Embed.su',    url: `https://embed.su/embed/movie/${tmdbIdStr}`,                                               type: 'stream' as const },
      { name: '2Embed (Cineby)', url: `https://www.2embed.cc/embed/${tmdbIdStr}`,                                          type: 'stream' as const },
      { name: 'VidSrc',      url: `https://vidsrc.pm/embed/movie/${tmdbIdStr}`,                                            type: 'stream' as const },
      { name: 'Mapple (4KHD)',   url: `https://www.2embed.cc/embed/${tmdbIdStr}#mapple`,                                   type: 'stream' as const },
      { name: 'Main',        url: `https://multiembed.mov/directstream.php?video_id=${tmdbIdStr}&tmdb=1`,                   type: 'stream' as const },
      { name: 'Prime',       url: `https://primestream.io/embed/movie/${tmdbIdStr}`,                                        type: 'stream' as const },
      { name: 'Torrent Web (Multi-Audio)', url: `${process.env.BACKEND_URL || 'https://streamly-backend-9q7i.onrender.com'}/stream?title=${encodeURIComponent(item.title || item.name)}&year=${(item.release_date || item.first_air_date || '').substring(0, 4)}`, type: 'stream' as const }
    ];
    const sources = rawSources.map(s => ({ ...s, url: s.name.includes('Torrent') ? s.url : this.encodeUrl(s.url) }));

    const rawDate = item.release_date || item.first_air_date || '';
    let isUpcoming = false;
    if (rawDate) {
      const relTime = new Date(rawDate).getTime();
      if (!isNaN(relTime) && relTime > Date.now()) {
        isUpcoming = true;
      }
    }

    const logoObj = item.images?.logos?.find((l: any) => l.iso_639_1 === 'en') || item.images?.logos?.[0];
    const logoUrl = logoObj?.file_path ? this.image(logoObj.file_path, 'w500') : '';

    return {
      id: `tmdb-${mediaType}-${item.id}`,
      tmdbId: tmdbIdStr,
      title: item.title || item.name || item.original_title || item.original_name || 'Untitled',
      originalTitle: item.original_title || item.original_name,
      description: item.overview || '',
      longDescription: item.overview || '',
      backdropUrl: this.image(item.backdrop_path, 'w1280') || this.image(item.poster_path),
      posterUrl: this.image(item.poster_path),
      logoUrl: logoUrl,
      trailerUrl: '',
      videoUrl: embedUrl,
      embedUrl: embedUrl,
      sources: sources,
      matchScore: Math.max(50, Math.round((item.vote_average || 0) * 10)),
      releaseYear: Number.parseInt(rawDate.slice(0, 4), 10) || new Date().getFullYear(),
      releaseDate: rawDate,
      isUpcoming: isUpcoming,
      maturityRating: rating,
      duration: duration,
      isSeries: isTV,
      isAnime: isAnime,
      genres: (item.genre_ids || []).map((id: number) => this.genres.get(id)).filter((name: string | undefined): name is string => Boolean(name)),
      cast: [],
      director: '',
      tags: [],
      // Catalog responses include the original language, so filters can work before
      // a viewer opens the title and triggers the more detailed TMDB request.
      audioLanguages: item.original_language && LANGUAGE_NAMES[item.original_language]
        ? [LANGUAGE_NAMES[item.original_language]]
        : [],
      subtitleLanguages: [],
    };
  }

  async refreshCatalog(platform: "nflix" | "nprime" | "hotstar" = "nflix") {
    const state = this.state[platform];
    state.searchCache.clear(); // Clear search cache to prevent memory leaks
    if (state.refreshInFlight) return state.refreshInFlight;

    const timeoutPromise = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Refresh Timeout')), 120000));
    state.refreshInFlight = Promise.race([this.loadCatalog(platform), timeoutPromise]).finally(() => {
      state.refreshInFlight = null;
    });
    return state.refreshInFlight;
  }

  private buildDynamicRails(platform: "nflix" | "nprime" | "hotstar"): CatalogRail[] {
    const providerId = this.providerMap[platform];
    const monetization = 'flatrate';
    const region = this.region;
    
    // Enforce strict platform isolation for both Movies and TV series using with_watch_providers
    const baseDiscoverMovie = `with_watch_providers=${providerId}&watch_region=${region}&with_watch_monetization_types=${monetization}`;
    const baseDiscoverTv = `with_watch_providers=${providerId}&watch_region=${region}&with_watch_monetization_types=${monetization}`;
    
    // Date ranges for "Recently Added" and "Upcoming"
    const today = new Date().toISOString().split('T')[0];
    const d = new Date();
    d.setMonth(d.getMonth() - 2);
    const recentDateIso = d.toISOString().split('T')[0];
    const regionalLanguages = [
      ['hi', 'Hindi'], ['ta', 'Tamil'], ['te', 'Telugu'], ['ml', 'Malayalam'],
      ['kn', 'Kannada'], ['mr', 'Marathi'], ['bn', 'Bengali'], ['ar', 'Arabic'],
    ] as const;

    const regionalRails = regionalLanguages.flatMap(([code, name]) => [
      { id: `${code}-movies`, name: `Popular ${name} Movies`, mediaType: 'movie' as const, path: `discover/movie?${baseDiscoverMovie}&with_original_language=${code}&sort_by=popularity.desc`, pages: 1 },
      { id: `${code}-series`, name: `Popular ${name} Series`, mediaType: 'tv' as const, path: `discover/tv?${baseDiscoverTv}&with_original_language=${code}&sort_by=popularity.desc`, pages: 1 },
    ]);

    const getRandomName = (names: string[]) => names[Math.floor(Math.random() * names.length)];

    const curatedRails = [
      { id: 'scifi-hits', name: getRandomName(['Sci-Fi Mindbenders', 'Imaginative Sci-Fi', 'Out of This World']), mediaType: 'movie' as const, path: `discover/movie?${baseDiscoverMovie}&with_genres=878&sort_by=vote_average.desc&vote_count.gte=500` },
      { id: 'horror-nights', name: getRandomName(['Horror & Thrills', 'Chilling Horror Movies', 'Ominous Thrillers', 'Scary Movies']), mediaType: 'movie' as const, path: `discover/movie?${baseDiscoverMovie}&with_genres=27,53&sort_by=popularity.desc` },
      { id: 'family-time', name: getRandomName(['Family Favorites', 'Movies for the Whole Family', 'Kids & Family']), mediaType: 'movie' as const, path: `discover/movie?${baseDiscoverMovie}&with_genres=10751&sort_by=popularity.desc` },
      { id: 'documentary', name: getRandomName(['Documentary Features', 'Critically Acclaimed Documentaries', 'Real Life Stories']), mediaType: 'movie' as const, path: `discover/movie?${baseDiscoverMovie}&with_genres=99&sort_by=popularity.desc` },
      { id: 'comedy-gold', name: getRandomName(['Comedy Gold', 'Feel-Good Comedies', 'Laugh-Out-Loud Movies']), mediaType: 'movie' as const, path: `discover/movie?${baseDiscoverMovie}&with_genres=35&sort_by=popularity.desc` },
      { id: 'action-packed', name: getRandomName(['High Octane Action', 'Action & Adventure', 'Explosive Action Movies']), mediaType: 'movie' as const, path: `discover/movie?${baseDiscoverMovie}&with_genres=28&sort_by=popularity.desc` },
      { id: 'romance-picks', name: getRandomName(['Romantic Dramas', 'Heartfelt Movies', 'Romance']), mediaType: 'movie' as const, path: `discover/movie?${baseDiscoverMovie}&with_genres=10749&sort_by=popularity.desc` },
      { id: 'thriller-tv', name: getRandomName(['Gripping TV Thrillers', 'Suspenseful TV Shows', 'Crime Thrillers']), mediaType: 'tv' as const, path: `discover/tv?${baseDiscoverTv}&with_genres=80,53&sort_by=popularity.desc` },
      { id: 'crime-series', name: getRandomName(['Crime & Investigation', 'True Crime Inspired', 'Gritty Crime TV Shows']), mediaType: 'tv' as const, path: `discover/tv?${baseDiscoverTv}&with_genres=80&sort_by=popularity.desc` },
      { id: 'mystery-box', name: getRandomName(['Mystery & Suspense', 'Whodunit TV Shows', 'Mind-Bending Mysteries']), mediaType: 'tv' as const, path: `discover/tv?${baseDiscoverTv}&with_genres=9648&sort_by=popularity.desc` },
      { id: 'award-winners', name: getRandomName(['Award-Winning Cinema', 'Critically Acclaimed Movies', 'Oscar Winners']), mediaType: 'movie' as const, path: `discover/movie?${baseDiscoverMovie}&vote_average.gte=8&vote_count.gte=1000` },
      { id: 'classic-rewind', name: getRandomName(['Classic Rewind', 'Nostalgic Movies', 'Throwback Movies']), mediaType: 'movie' as const, path: `discover/movie?${baseDiscoverMovie}&release_date.lte=1990-12-31&sort_by=popularity.desc` },
      { id: 'indie-gems', name: getRandomName(['Indie & Art House', 'Independent Movies', 'Critically Acclaimed Indie']), mediaType: 'movie' as const, path: `discover/movie?${baseDiscoverMovie}&with_genres=18&vote_average.gte=7&vote_count.gte=200` },
      { id: 'k-drama', name: getRandomName(['K-Drama Hits', 'Korean TV Shows', 'Binge-Worthy K-Dramas']), mediaType: 'tv' as const, path: `discover/tv?${baseDiscoverTv}&with_original_language=ko&sort_by=popularity.desc` },
      { id: 'british-tv', name: getRandomName(['British TV Dramas', 'Acclaimed British Shows', 'Made in the UK']), mediaType: 'tv' as const, path: `discover/tv?${baseDiscoverTv}&with_original_language=en&origin_country=GB&sort_by=popularity.desc` },
      { id: 'fantasy-realms', name: getRandomName(['Fantasy Worlds', 'Epic Fantasy Series', 'Magical TV']), mediaType: 'tv' as const, path: `discover/tv?${baseDiscoverTv}&with_genres=10765&sort_by=popularity.desc` },
      { id: 'animation-tv', name: getRandomName(['Animated Series', 'Adult Animation', 'Toons for Everyone']), mediaType: 'tv' as const, path: `discover/tv?${baseDiscoverTv}&with_genres=16&sort_by=popularity.desc` },
      { id: 'reality-tv', name: getRandomName(['Reality TV', 'Unscripted TV', 'Binge-Worthy Reality']), mediaType: 'tv' as const, path: `discover/tv?${baseDiscoverTv}&with_genres=10764&sort_by=popularity.desc` },
    ];
    
    // Shuffle the curated rails so the homepage looks dynamic
    const shuffledCurated = curatedRails.sort(() => Math.random() - 0.5).slice(0, 10);
    // Increased regional rails from 3 to 8 to ensure Tamil, Malayalam, Hindi, etc., always show up
    const shuffledRegional = regionalRails.sort(() => Math.random() - 0.5).slice(0, 8);

    const indianCinemaRail = {
      id: 'indian-cinema-hits',
      name: 'South Indian & Bollywood Hits',
      mediaType: 'movie' as const,
      path: `discover/movie?${baseDiscoverMovie}&with_original_language=hi|ta|te|ml|kn&sort_by=popularity.desc&vote_count.gte=100`
    };

    return [
      // 1. Movies Domain
      { id: 'trending-movies', name: 'Trending Movies', mediaType: 'movie', path: `discover/movie?${baseDiscoverMovie}&sort_by=popularity.desc` },
      { id: 'recently-added-movies', name: 'Recently Added Movies', mediaType: 'movie', path: `discover/movie?${baseDiscoverMovie}&sort_by=primary_release_date.desc&primary_release_date.lte=${today}` },
      { id: 'leaving-soon-movies', name: 'Leaving Soon', mediaType: 'movie', path: `discover/movie?${baseDiscoverMovie}&sort_by=popularity.asc` },
      { id: 'upcoming-movies', name: 'Upcoming Movies', mediaType: 'movie', path: `discover/movie?${baseDiscoverMovie}&primary_release_date.gte=${today}` },
      { id: 'popular-movies', name: 'Popular Movies', mediaType: 'movie', path: `discover/movie?${baseDiscoverMovie}&sort_by=popularity.desc` },
      { id: 'top-rated-movies', name: 'Top Rated Movies', mediaType: 'movie', path: `discover/movie?${baseDiscoverMovie}&sort_by=vote_average.desc&vote_count.gte=1000` },

      // 2. TV Series Domain
      { id: 'trending-series', name: 'Trending Series', mediaType: 'tv', path: `discover/tv?${baseDiscoverTv}&sort_by=popularity.desc` },
      { id: 'recently-added-series', name: 'Recently Added Series', mediaType: 'tv', path: `discover/tv?${baseDiscoverTv}&sort_by=first_air_date.desc&first_air_date.lte=${today}` },
      { id: 'upcoming-series', name: 'Upcoming Series', mediaType: 'tv', path: `discover/tv?${baseDiscoverTv}&first_air_date.gte=${today}` },
      { id: 'popular-series', name: 'Popular Series', mediaType: 'tv', path: `discover/tv?${baseDiscoverTv}&sort_by=popularity.desc` },

      // 3. Anime Domain
      { id: 'trending-anime', name: 'Trending Anime', mediaType: 'tv', path: `discover/tv?${baseDiscoverTv}&with_genres=16&with_original_language=ja&sort_by=popularity.desc&first_air_date.gte=${recentDateIso}&first_air_date.lte=${today}` },
      
      // 4. Dynamic Editorial Genres
      ...shuffledCurated,

      // 5. Massive Indian Cinema Rail (Combined)
      indianCinemaRail,
      
      // 6. Multi-Language / Dubbed Hits
      { id: 'multi-language-dubs', name: 'Available in Multiple Languages', mediaType: 'movie', path: `discover/movie?${baseDiscoverMovie}&with_original_language=en|te|ta|ml&with_spoken_languages=hi|ta|te&sort_by=popularity.desc&vote_count.gte=500` },

      // 7. Dynamic Regional Specific Rails
      ...shuffledRegional,
    ];
  }

  private async loadCatalog(platform: "nflix" | "nprime" | "hotstar") {
    const state = this.state[platform];
    state.lastRefreshAttemptAt = Date.now();
    try {
      await this.loadGenres();
      await this.loadRealNetflixStatus(platform);

      const dynamicRails = this.buildDynamicRails(platform);

      const loadedMovies = new Map<string, Movie>();
      const categories = await Promise.all(dynamicRails.map(async (rail) => {
        const isUpcomingRail = rail.id.includes('upcoming');
        const pageCount = isUpcomingRail ? 8 : rail.pages ?? this.pagesPerRail;
        const pageIndexes = Array.from({ length: pageCount }, (_, i) => i + 1);
        const pages = [];
        for (let i = 0; i < pageIndexes.length; i += 3) {
          const chunk = pageIndexes.slice(i, i + 3);
          const chunkResults = await Promise.all(chunk.map(idx => 
            this.tmdb(rail.path, { page: String(idx) }).catch((err) => {
              this.logger.warn(`Failed page ${idx} for ${rail.id}: ${err.message}`);
              return { results: [] };
            })
          ));
          pages.push(...chunkResults);
          if (i + 3 < pageIndexes.length) await new Promise(r => setTimeout(r, 250)); // Rate limit pause
        }
        const allItems = pages.flatMap((page: any) => page.results || []);

        const uniqueTitles = new Map<string, Movie>();
        allItems.forEach((item: any) => {
          const movie = this.toMovie(item, rail.mediaType);
          // Strictly require at least one valid poster or backdrop image
          if ((movie.posterUrl || movie.backdropUrl) && !uniqueTitles.has(movie.id)) {
            if (state.realRecentlyAddedTmdbIds.size > 0 || state.realLeavingSoonTmdbIds.size > 0) {
              movie.isRecentlyAdded = state.realRecentlyAddedTmdbIds.has(String(movie.tmdbId));
              movie.isLeavingSoon = state.realLeavingSoonTmdbIds.has(String(movie.tmdbId));
            } else {
              if (rail.id.includes('recently-added')) movie.isRecentlyAdded = true;
              if (rail.id.includes('leaving-soon')) movie.isLeavingSoon = true;
            }
            uniqueTitles.set(movie.id, movie);
            loadedMovies.set(movie.id, movie);
          }
        });
        const titlesArr = Array.from(uniqueTitles.values());

        let titles: Movie[];
        if (isUpcomingRail) {
          let upcomingTitles = titlesArr.filter((movie) => movie.isUpcoming);

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

        return { id: rail.id, name: rail.name, slug: rail.id, movies: titles };
      }));

      if (loadedMovies.size > 0) {
        this.state[platform].movies.clear();
        state.tmdbIdIndex.clear();
        for (const [id, movie] of loadedMovies) {
          state.movies.set(id, movie);
          if (movie.tmdbId) state.tmdbIdIndex.set(movie.tmdbId.toString(), id);
        }
        this.state[platform].categories = categories.filter((c) => c.movies.length >= 1);
        this.lastCatalogError = undefined;
        this.logger.log(`Loaded ${this.state[platform].movies.size} unique titles across ${this.state[platform].categories.length} TMDB dynamic rails.`);
      } else {
        throw new Error('No titles could be fetched from TMDB.');
      }
    } catch (error) {
      this.lastCatalogError = error instanceof Error ? error.message : String(error);
      this.logger.error('Unable to load the TMDB catalog. Generating fallback catalog.', this.lastCatalogError);
      this.populateFallbackCatalog(platform);
    } finally {
      state.refreshInFlight = null;
    }
  }

  private populateFallbackCatalog(platform: 'nflix' | 'nprime' | 'hotstar') {
    const mockMovies: any[] = [
      { id: 'm-157336', tmdbId: '157336', title: 'Interstellar', description: 'A team of explorers travel through a wormhole in space in an attempt to ensure humanity survival.', posterUrl: 'https://image.tmdb.org/t/p/w780/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg', backdropUrl: 'https://image.tmdb.org/t/p/w1280/xJHokMbljvjADYdit5fK5VQsY2v.jpg', releaseYear: 2014, matchScore: 98, maturityRating: 'PG-13', duration: '2h 49m', genres: ['Sci-Fi', 'Adventure', 'Drama'], videoUrl: this.encodeUrl('https://www.2embed.cc/embed/157336'), trailerUrl: '', cast: ['Matthew McConaughey', 'Anne Hathaway'], director: 'Christopher Nolan', tags: ['Sci-Fi', 'Space'], audioLanguages: ['English'], subtitleLanguages: ['English'], isSeries: false },
      { id: 'm-27205', tmdbId: '27205', title: 'Inception', description: 'A thief who steals corporate secrets through the use of dream-sharing technology.', posterUrl: 'https://image.tmdb.org/t/p/w780/oYuLE1h2CVCdIF9i2V47h7918x8.jpg', backdropUrl: 'https://image.tmdb.org/t/p/w1280/8ZTVqvTZ25nDzzvFiJ19bWb2vT5.jpg', releaseYear: 2010, matchScore: 97, maturityRating: 'PG-13', duration: '2h 28m', genres: ['Action', 'Sci-Fi', 'Thriller'], videoUrl: this.encodeUrl('https://www.2embed.cc/embed/27205'), trailerUrl: '', cast: ['Leonardo DiCaprio', 'Joseph Gordon-Levitt'], director: 'Christopher Nolan', tags: ['Sci-Fi', 'Dreams'], audioLanguages: ['English'], subtitleLanguages: ['English'], isSeries: false },
      { id: 'm-1399', tmdbId: '1399', title: 'Game of Thrones', description: 'Nine noble families fight for control over the lands of Westeros.', posterUrl: 'https://image.tmdb.org/t/p/w780/1XS1oqL89vEDVXtMK9Z08as1Coc.jpg', backdropUrl: 'https://image.tmdb.org/t/p/w1280/2OMG0YKMh28TIG92Lh2168926.jpg', releaseYear: 2011, matchScore: 99, maturityRating: 'TV-MA', duration: '8 Seasons', genres: ['Drama', 'Action', 'Sci-Fi'], videoUrl: this.encodeUrl('https://www.2embed.cc/embed/1399/1/1'), trailerUrl: '', cast: ['Emilia Clarke', 'Kit Harington'], director: 'David Benioff', tags: ['Fantasy', 'Dragons'], audioLanguages: ['English'], subtitleLanguages: ['English'], isSeries: true },
      { id: 'm-66732', tmdbId: '66732', title: 'Stranger Things', description: 'When a young boy vanishes, a small town uncovers a mystery involving secret experiments.', posterUrl: 'https://image.tmdb.org/t/p/w780/49WJfeN0moxb9IPfGn88qMG4d2.jpg', backdropUrl: 'https://image.tmdb.org/t/p/w1280/56v2KjBlU4XaOv9rvyEQypROD7P.jpg', releaseYear: 2016, matchScore: 96, maturityRating: 'TV-14', duration: '4 Seasons', genres: ['Sci-Fi', 'Horror', 'Drama'], videoUrl: this.encodeUrl('https://www.2embed.cc/embed/66732/1/1'), trailerUrl: '', cast: ['Millie Bobby Brown', 'Finn Wolfhard'], director: 'The Duffer Brothers', tags: ['Sci-Fi', '80s'], audioLanguages: ['English'], subtitleLanguages: ['English'], isSeries: true }
    ];

    mockMovies.forEach(m => {
      this.state[platform].movies.set(m.id, m);
      this.state[platform].tmdbIdIndex.set(m.tmdbId!, m.id);
    });

    this.state[platform].categories = [
      { id: 'trending', name: 'Trending Now', slug: 'trending', movies: mockMovies },
      { id: 'popular', name: 'Popular on Streamly', slug: 'popular', movies: [...mockMovies].reverse() }
    ];
  }

  private async ensureCatalog(platform: 'nflix' | 'nprime' | 'hotstar' = 'nflix') {
    this.ensureConfigured();
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
      this.logger.warn(`TMDB catalog empty for ${platform}, generating emergency fallback rails.`);
      this.populateFallbackCatalog(platform);
    }
  }

  private toLightweightMovie(m: Movie): Partial<Movie> {
    return {
      id: m.id,
      tmdbId: m.tmdbId,
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

  async getAllMovies(platform: 'nflix' | 'nprime' | 'hotstar' = 'nflix') { 
    await this.ensureCatalog(platform); 
    const allMovies = this.state[platform].categories.flatMap(c => c.movies);
    const uniqueMap = new Map<string, Movie>();
    for (const m of allMovies) { if (!uniqueMap.has(m.id)) uniqueMap.set(m.id, m); }
    const uniqueMovies = Array.from(uniqueMap.values());
    return uniqueMovies.map(m => this.toLightweightMovie(m) as Movie);
  }

  async getTop10Movies(platform: 'nflix' | 'nprime' | 'hotstar' = 'nflix'): Promise<Movie[]> {
    await this.ensureCatalog(platform);
    const allMovies = this.state[platform].categories.flatMap(c => c.movies);
    const uniqueMap = new Map<string, Movie>();
    for (const m of allMovies) { if (!uniqueMap.has(m.id)) uniqueMap.set(m.id, m); }
    const uniqueMovies = Array.from(uniqueMap.values());
    
    return uniqueMovies
      .sort((a, b) => b.matchScore - a.matchScore || b.releaseYear - a.releaseYear)
      .slice(0, 10)
      .map(m => this.toLightweightMovie(m) as Movie);
  }
  async getFeaturedMovie(platform: 'nflix' | 'nprime' | 'hotstar' = 'nflix'): Promise<Movie | null> {
    await this.ensureCatalog(platform);
    const feat = this.state[platform].categories[0]?.movies[0] || null;
    if (feat && !feat.logoUrl) {
      try {
        const mediaType = feat.isSeries ? 'tv' : 'movie';
        const details = await this.tmdb(`${mediaType}/${feat.tmdbId}`, { 
          append_to_response: 'images',
          include_image_language: 'en,null,ja,ko,zh,hi,ta,te,ml,kn,fr,es,de,it,pt,ru,ar,tr,th'
        });
        const logoObj = details.images?.logos?.find((l: any) => l.iso_639_1 === 'en') || details.images?.logos?.[0];
        if (logoObj?.file_path) {
          feat.logoUrl = this.image(logoObj.file_path, 'w500');
        }
      } catch (e) { this.logger.error('Failed to fetch featured movie logo', e); }
    }
    return feat;
  }
  async getCategories(platform: 'nflix' | 'nprime' | 'hotstar' = 'nflix'): Promise<Category[]> {
    await this.ensureCatalog(platform);
    return this.state[platform].categories.map(cat => ({
      ...cat,
      movies: cat.movies.map(m => this.toLightweightMovie(m) as Movie)
    }));
  }

  /**
   * TMDB video lists can include clips, featurettes, interviews and entries from
   * other providers. Only use an explicit YouTube Trailer/Teaser for playback;
   * showing no trailer is preferable to presenting an unrelated video.
   */
  private selectTrailerVideo(videos: any[], originalLanguage?: string, platform?: string): any {
    const preferredLanguages = [originalLanguage, this.language.split('-')[0], 'en'].filter(Boolean);
    const score = (video: any) => {
      const typeScore = video.type === 'Trailer' ? 300 : video.type === 'Teaser' ? 100 : video.type === 'Clip' ? 50 : 10;
      const officialScore = video.official === true ? 1_000 : 0;
      const languageScore = preferredLanguages.indexOf(video.iso_639_1) >= 0
        ? (preferredLanguages.length - preferredLanguages.indexOf(video.iso_639_1)) * 10
        : 0;
      // Bonus if it's the exact original language, to prioritize it over en-tagged hindi trailers
      const isOriginalLang = video.iso_639_1 === originalLanguage ? 5000 : 0;
      
      // Bonus if the trailer name explicitly matches the platform brand
      let platformBonus = 0;
      const vName = (video.name || '').toLowerCase();
      if (platform === 'nprime' && (vName.includes('amazon') || vName.includes('prime'))) {
        platformBonus = 10000;
      } else if (platform === 'nflix' && vName.includes('netflix')) {
        platformBonus = 10000;
      } else if (platform === 'hotstar' && (vName.includes('hotstar') || vName.includes('disney'))) {
        platformBonus = 10000;
      }

      const publishedAt = Date.parse(video.published_at || '');
      return officialScore + typeScore + languageScore + isOriginalLang + platformBonus + (Number.isFinite(publishedAt) ? publishedAt / 1e13 : 0);
    };

    return videos
      .filter((video) =>
        video?.site === 'YouTube' &&
        typeof video.key === 'string' &&
        video.key.length > 0 &&
        (video.type === 'Trailer' || video.type === 'Teaser' || video.type === 'Clip' || video.type === 'Featurette'),
      )
      .sort((left, right) => score(right) - score(left) || String(left.id || '').localeCompare(String(right.id || '')))[0];
  }

  async getMovieById(id: string, platform: 'nflix' | 'nprime' | 'hotstar' = 'nflix'): Promise<Movie> {
    await this.ensureCatalog(platform);
    
    // O(1) Index Lookup (Primary ID -> TMDB ID -> Secondary Title Index)
    let movie = this.state[platform].movies.get(id);
    if (!movie) {
      const internalId = this.state[platform].tmdbIdIndex.get(id);
      if (internalId) movie = this.state[platform].movies.get(internalId);
    }
    

    if (!movie) throw new NotFoundException(`Title "${id}" was not found.`);

    // Dynamically enrich movie details (credits, images & YouTube trailer video) from TMDB on demand
    if (!movie.cast?.length || !movie.videoUrl || !movie.logoUrl || !movie.trailerUrl || movie.seasonsCount === undefined) {
      try {
        const isTvType = movie.isSeries || movie.id.startsWith('tmdb-tv-') || movie.seasonsCount !== undefined;
        const mediaType = isTvType ? 'tv' : 'movie';
        const details = await this.tmdb(`${mediaType}/${movie.tmdbId}`, { 
          append_to_response: 'credits,videos,images,translations,keywords',
          include_image_language: 'en,null,ja,ko,zh,hi,ta,te,ml,kn,fr,es,de,it,pt,ru,ar,tr,th',
          include_video_language: 'en,null,ja,ko,zh,hi,ta,te,ml,kn,fr,es,de,it,pt,ru,ar,tr,th'
        });

        // Ensure isSeries flag is updated if TMDB details confirm TV show
        if (details.number_of_seasons !== undefined || details.first_air_date) {
          movie.isSeries = true;
          movie.seasonsCount = details.number_of_seasons || 1;
        }
        
        const logoObj = details.images?.logos?.find((l: any) => l.iso_639_1 === 'en') || details.images?.logos?.[0];
        if (logoObj?.file_path) {
          movie.logoUrl = this.image(logoObj.file_path, 'w500');
        }

        const bestVideo = this.selectTrailerVideo(details.videos?.results || [], details.original_language, platform);
        
        // If TMDB doesn't have a trailer, OR if the trailer isn't in the original language (for non-English movies)
        const isMissingOrWrongLang = !bestVideo || (details.original_language !== 'en' && bestVideo.iso_639_1 !== details.original_language);

        if (isMissingOrWrongLang) {
          try {
            const ytSearch = require('yt-search');
            const origLangName = LANGUAGE_NAMES[details.original_language] || details.original_language;
            const query = `${movie.title} official trailer ${origLangName}`;
            this.logger.log(`TMDB lacks original language trailer. Fallback YT Search: ${query}`);
            const ytResult = await ytSearch(query);
            if (ytResult?.videos?.length > 0) {
              movie.trailerUrl = this.encodeUrl(`https://www.youtube.com/embed/${ytResult.videos[0].videoId}?autoplay=1`);
            } else if (bestVideo) {
              movie.trailerUrl = this.encodeUrl(`https://www.youtube.com/embed/${bestVideo.key}?autoplay=1`);
            }
          } catch (e) {
            this.logger.warn(`yt-search failed for ${movie.title}: ` + e.message);
            if (bestVideo) movie.trailerUrl = this.encodeUrl(`https://www.youtube.com/embed/${bestVideo.key}?autoplay=1`);
          }
        } else if (bestVideo) {
          movie.trailerUrl = this.encodeUrl(`https://www.youtube.com/embed/${bestVideo.key}?autoplay=1`);
        }
        if (!movie.embedUrl) {
          movie.embedUrl = this.encodeUrl(movie.isSeries
            ? `https://www.2embed.cc/embed/${movie.tmdbId}/1/1`
            : `https://www.2embed.cc/embed/${movie.tmdbId}`);
        }
        if (!movie.videoUrl) {
          movie.videoUrl = movie.embedUrl;
        }

        // Extract spoken languages / audio dub availability (with Regional Indian & International ISO mapping)
        const origLang = LANGUAGE_NAMES[details.original_language] || '';
        const spoken = (details.spoken_languages || [])
          .map((lang: any) => lang.english_name || lang.name || LANGUAGE_NAMES[lang.iso_639_1])
          .filter(Boolean);
        if (origLang) spoken.unshift(origLang);
        if (spoken.length) {
          movie.audioLanguages = Array.from(new Set(spoken));
        } else if (!movie.audioLanguages?.length) {
          movie.audioLanguages = [];
        }
        
        const rawKeywords = details.keywords?.keywords || details.keywords?.results || [];
        const tagsList = rawKeywords.slice(0, 5).map((k: any) => {
          return k.name.split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        });
        if (tagsList.length) movie.tags = tagsList;
        
        const fullCast = (details.credits?.cast || []).slice(0, 10).map((c: any) => ({
          name: c.name,
          character: c.character || 'Cast',
          profileUrl: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null
        }));
        if (fullCast.length) {
          movie.cast = fullCast;
        }

        const director = details.credits?.crew?.find((c: any) => c.job === 'Director')?.name || details.credits?.crew?.find((c: any) => c.job === 'Executive Producer')?.name;
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

    const allPlatforms: Array<'nflix' | 'nprime' | 'hotstar'> = ['nflix', 'nprime', 'hotstar'];
    const platformLabel: Record<string, string> = { nflix: 'Netflix', nprime: 'Prime Video', hotstar: 'Hotstar' };
    const availablePlatforms: string[] = [];
    const tmdbId = movie.tmdbId;
    
    if (tmdbId) {
      for (const p of allPlatforms) {
        const catalogId = this.state[p].tmdbIdIndex.get(tmdbId);
        if (catalogId && this.state[p].movies.has(catalogId)) {
          availablePlatforms.push(platformLabel[p]);
        }
      }
    }

    return { ...movie, availablePlatforms };
  }

  async getSeasonEpisodes(id: string, seasonNumber: number, platform: 'nflix' | 'nprime' | 'hotstar' = 'nflix'): Promise<Episode[]> {
    await this.ensureCatalog(platform);
    let movie = this.state[platform].movies.get(id);
    if (!movie) {
      const internalId = this.state[platform].tmdbIdIndex.get(id);
      if (internalId) movie = this.state[platform].movies.get(internalId);
    }
    if (!movie) return [];

    // Ensure TV metadata is loaded
    if (movie.isSeries === undefined || movie.seasonsCount === undefined) {
      try {
        await this.getMovieById(id, platform);
        movie = this.state[platform].movies.get(id) || movie;
      } catch (e) { this.logger.error('Failed to fetch featured movie logo', e); }
    }

    try {
      const seasonData = await this.tmdb(`tv/${movie.tmdbId}/season/${seasonNumber}`);
      const episodes: Episode[] = (seasonData.episodes || []).map((ep: any) => {
        const vl = 'primaryColor=E50914&secondaryColor=141414&iconColor=FFFFFF&nextButton=true&title=false&poster=false&autoplay=true';
        const vidLinkUrl = `https://vidlink.pro/tv/${movie.tmdbId}/${seasonNumber}/${ep.episode_number}?${vl}`;
        
        return {
          id: `ep-${movie.tmdbId}-${seasonNumber}-${ep.episode_number}`,
          title: ep.name || `Episode ${ep.episode_number}`,
          description: ep.overview || '',
          duration: ep.runtime ? `${ep.runtime}m` : '45m',
          episodeNumber: ep.episode_number,
          seasonNumber: seasonNumber,
          thumbnailUrl: this.image(ep.still_path) || movie.backdropUrl,
          videoUrl: this.encodeUrl(`https://vidsrc.pm/embed/tv/${movie.tmdbId}/${seasonNumber}/${ep.episode_number}`),
          embedUrl: this.encodeUrl(`https://vidsrc.pm/embed/tv/${movie.tmdbId}/${seasonNumber}/${ep.episode_number}`),
          sources: [
            { name: 'VidLink',     url: vidLinkUrl,                                                                                                              type: 'stream' as const },
            { name: 'AutoEmbed',   url: `https://autoembed.co/tv/tmdb/${movie.tmdbId}-${seasonNumber}-${ep.episode_number}`,                                     type: 'stream' as const },
            { name: 'VidSrc.pro',  url: `https://vidsrc.pro/embed/tv/${movie.tmdbId}/${seasonNumber}/${ep.episode_number}`,                                      type: 'stream' as const },
            { name: 'VidSrc.cc',   url: `https://vidsrc.cc/v2/embed/tv/${movie.tmdbId}/${seasonNumber}/${ep.episode_number}`,                                    type: 'stream' as const },
            { name: 'Embed.su',    url: `https://embed.su/embed/tv/${movie.tmdbId}/${seasonNumber}/${ep.episode_number}`,                                        type: 'stream' as const },
            { name: '2Embed (Cineby)', url: `https://www.2embed.cc/embed/${movie.tmdbId}/${seasonNumber}/${ep.episode_number}`,                                  type: 'stream' as const },
            { name: 'VidSrc',      url: `https://vidsrc.pm/embed/tv/${movie.tmdbId}/${seasonNumber}/${ep.episode_number}`,                                       type: 'stream' as const },
            { name: 'Mapple (4KHD)',   url: `https://www.2embed.cc/embed/${movie.tmdbId}/${seasonNumber}/${ep.episode_number}#mapple`,                           type: 'stream' as const },
            { name: 'Main',        url: `https://multiembed.mov/directstream.php?video_id=${movie.tmdbId}&tmdb=1&s=${seasonNumber}&e=${ep.episode_number}`,      type: 'stream' as const },
            { name: 'Prime',       url: `https://primestream.io/embed/tv/${movie.tmdbId}/${seasonNumber}/${ep.episode_number}`,                                  type: 'stream' as const }
        ].map(s => ({ ...s, url: this.encodeUrl(s.url) }))
      };
    });
      return episodes;
    } catch (err) {
      this.logger.warn(`Failed to load season ${seasonNumber} for ${id}: ${err}`);
      return movie.episodes || [];
    }
  }

  async searchMovies(query: string, genre?: string, platform: 'nflix' | 'nprime' | 'hotstar' = 'nflix'): Promise<{ movies: Movie[], actor?: any }> {
    this.ensureConfigured();
    const normalized = query.trim().toLowerCase();
    const cacheKey = `${normalized}_${genre || 'all'}`;

    // Fast O(1) Search Query Cache Check
    if (this.state[platform].searchCache.has(cacheKey)) {
      return this.state[platform].searchCache.get(cacheKey)!;
    }

    if (!normalized) {
      const allMovies = await this.getAllMovies(platform);
      const res = { movies: this.filterGenre(allMovies, genre) };
      this.state[platform].searchCache.set(cacheKey, res);
      return res;
    }
    
    try {
      const combinedMoviesMap = new Map<string, Movie>();
      const allPlatforms: Array<'nflix' | 'nprime' | 'hotstar'> = ['nflix', 'nprime', 'hotstar'];
      const platformLabel: Record<string, string> = { nflix: 'Netflix', nprime: 'Prime Video', hotstar: 'Hotstar' };
      
      for (const p of allPlatforms) {
          const pMovies = await this.getAllMovies(p); 
          for (const movie of pMovies) {
              const key = movie.tmdbId || movie.title; 
              if (!combinedMoviesMap.has(key)) {
                  combinedMoviesMap.set(key, { ...movie, platform: p, availablePlatforms: [platformLabel[p]] });
              } else {
                  const existing = combinedMoviesMap.get(key)!;
                  if (!existing.availablePlatforms!.includes(platformLabel[p])) {
                       existing.availablePlatforms!.push(platformLabel[p]);
                  }
              }
          }
      }
      
      let resultsWithScores = Array.from(combinedMoviesMap.values()).map(m => {
          let score = 0;
          const t = m.title.toLowerCase();
          
          if (t === normalized) score += 100;
          else if (t.startsWith(normalized)) score += 50;
          else if (t.includes(normalized)) score += 10;
          
          if (m.originalTitle && m.originalTitle.toLowerCase().includes(normalized)) score += 5;
          
          if (m.genres && m.genres.some(g => g.toLowerCase().includes(normalized))) score += 5;
          if (m.tags && m.tags.some(g => g.toLowerCase().includes(normalized))) score += 3;
          
          if (m.cast && m.cast.some((c: any) => typeof c === 'string' ? c.toLowerCase().includes(normalized) : c.name?.toLowerCase().includes(normalized))) score += 8;
          if (m.director && m.director.toLowerCase().includes(normalized)) score += 8;
          if (m.description && m.description.toLowerCase().includes(normalized)) score += 1;
          
          // Fuzzy token matching
          const tokens = normalized.split(/[\s-]+/).filter(Boolean);
          if (tokens.length > 0) {
             const titleTokens = t.split(/[\s-]+/);
             const matchedTokens = tokens.filter(tk => titleTokens.some(ttk => ttk.includes(tk)));
             if (matchedTokens.length === tokens.length) score += 15;
             else if (matchedTokens.length > 0) score += (matchedTokens.length * 2);
          }

          return { movie: m, score };
      });
      
      let results = resultsWithScores
          .filter(item => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .map(item => item.movie);
      
      results = this.filterGenre(results, genre);

      // ────────────────────────────────────────────────────────────
      // LIVE TMDB FALLBACK SEARCH
      // If local search returns 0 results, query TMDB live for niche/regional content
      // ────────────────────────────────────────────────────────────
      if (results.length === 0 && normalized.length > 2) {
        this.logger.log(`Live TMDB Fallback Search triggered for: "${query}"`);
        try {
          const tmdbSearch = await this.tmdb('search/multi', { query: normalized });
          if (tmdbSearch.results && tmdbSearch.results.length > 0) {
            // Take top 5 to minimize N+1 provider lookups
            const topHits = tmdbSearch.results.slice(0, 5).filter((m: any) => m.media_type === 'movie' || m.media_type === 'tv');
            
            for (const hit of topHits) {
              const providers = await this.tmdb(`${hit.media_type}/${hit.id}/watch/providers`).catch(() => null);
              
              // Check US and IN regions for providers to maximize chances of finding regional content
              const usProviders = providers?.results?.['US']?.flatrate || [];
              const inProviders = providers?.results?.['IN']?.flatrate || [];
              const allProviderIds = Array.from(new Set([...usProviders, ...inProviders].map((p: any) => String(p.provider_id))));
              
              const availableOn: string[] = [];
              if (allProviderIds.includes(this.providerMap['nflix'])) availableOn.push('Netflix');
              if (allProviderIds.includes(this.providerMap['nprime'])) availableOn.push('Prime Video');
              if (allProviderIds.includes(this.providerMap['hotstar'])) availableOn.push('Hotstar');

              // If it's available on at least one tracked platform OR if we just want to force it to show up 
              // (Since users want to find it, we can show it and state where it's available)
              if (availableOn.length > 0 || allProviderIds.length > 0) {
                const movieObj = this.toMovie(hit, hit.media_type);
                movieObj.availablePlatforms = availableOn.length > 0 ? availableOn : ['Other'];
                
                // Cache into local memory so /movie/:id works when clicked
                this.state[platform].movies.set(movieObj.id, movieObj);
                this.state[platform].tmdbIdIndex.set(movieObj.tmdbId!, movieObj.id);
                
                results.push(movieObj);
              }
            }
          }
        } catch (e) {
          this.logger.error('TMDB Live Fallback Search failed: ' + (e instanceof Error ? e.message : String(e)));
        }
      }

      const resultObj = { movies: results, actor: undefined };
      
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
    return genre && genre !== 'All' ? titles.filter((item) => item.genres.includes(genre)) : titles;
  }

  async getSimilarMovies(id: string, platform: 'nflix' | 'nprime' | 'hotstar' = 'nflix') {
    await this.ensureCatalog(platform);
    const current = await this.getMovieById(id, platform);
    return (await this.getAllMovies(platform)).filter((item) => item.id !== current.id && item.genres.some((genre) => current.genres.includes(genre))).slice(0, 6);
  }

  // ─── Advanced Recommendations Engine ──────────────────────────────────

  async getRecommendations(id: string, platform: 'nflix' | 'nprime' | 'hotstar' = 'nflix'): Promise<Movie[]> {
    await this.ensureCatalog(platform);
    let source: Movie;
    try {
      source = await this.getMovieById(id, platform);
    } catch {
      return [];
    }

    const allMovies = await this.getAllMovies(platform);

    const scored = allMovies
      .filter((m) => m.id !== source.id)
      .map((m) => {
        let score = 0;

        // Genre overlap (+20 per matching genre)
        const genreOverlap = m.genres.filter((g) => source.genres.includes(g)).length;
        score += genreOverlap * 20;

        // Same director (+15)
        if (source.director && m.director && source.director !== 'Unknown' && m.director !== 'Unknown') {
          if (source.director.toLowerCase() === m.director.toLowerCase()) score += 15;
        }

        // Overlapping cast (+10 per shared member, max 30)
        const sourceCastNames = source.cast.map((c) =>
          typeof c === 'string' ? c.toLowerCase() : (c as any).name?.toLowerCase() || '',
        ).filter(Boolean);
        const targetCastNames = m.cast.map((c) =>
          typeof c === 'string' ? c.toLowerCase() : (c as any).name?.toLowerCase() || '',
        ).filter(Boolean);
        const castOverlap = sourceCastNames.filter((n) => targetCastNames.includes(n)).length;
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
    platform: 'nflix' | 'nprime' | 'hotstar' = 'nflix',
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
      const seed = `${id}-s${season}e${episode}`.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
      const introLength = 60 + (seed % 30); // 60–89 seconds

      return {
        hasIntro: true,
        startSeconds: 0,
        endSeconds: introLength,
      };
    } catch {
      return { hasIntro: false, startSeconds: 0, endSeconds: 0 };
    }
  }
}

