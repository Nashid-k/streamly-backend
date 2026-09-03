import { Movie } from "./movies.types";

export type PlatformKey =
  "netflix" | "prime" | "hotstar" | "appletv" | "zee5" | "sonyliv" | "jio";

export class PlatformState {
  movies = new Map<string, Movie>();
  tmdbIdIndex = new Map<string, string>();
  categories: any[] = [];
  realRecentlyAddedTmdbIds = new Set<string>();
  realLeavingSoonTmdbIds = new Set<string>();
  lastRefreshAttemptAt = 0;
  refreshInFlight: Promise<void> | null = null;
  searchCache = new Map<string, { movies: Movie[]; actor?: any }>();
}

export const PLATFORM_LABELS: Record<PlatformKey, string> = {
  netflix: "Netflix",
  prime: "Prime Video",
  hotstar: "Hotstar",
  appletv: "Apple TV+",
  zee5: "Zee5",
  sonyliv: "Sony LIV",
  jio: "JioCinema",
};

export const ALL_PLATFORMS: PlatformKey[] = [
  "netflix",
  "prime",
  "hotstar",
  "appletv",
  "zee5",
  "sonyliv",
  "jio",
];
