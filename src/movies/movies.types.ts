export interface StreamSource {
  name: string;
  url: string;
  type: "embed" | "trailer" | "stream";
}

export interface Episode {
  id: string;
  title: string;
  description: string;
  duration: string;
  episodeNumber: number;
  seasonNumber: number;
  thumbnailUrl: string;
  videoUrl: string;
  embedUrl?: string;
  sources?: StreamSource[];
  airDate?: string;
}

export interface SeasonEpisodesResponse {
  episodes: Episode[];
  totalEpisodes: number;
  releasedEpisodes: number;
  isAiring: boolean;
}

export interface Movie {
  id: string;
  tmdbId?: string;
  imdbId?: string;
  title: string;
  originalTitle?: string;
  description: string;
  longDescription?: string;
  backdropUrl: string;
  posterUrl: string;
  logoUrl?: string;
  trailerUrl: string;
  videoUrl: string;
  embedUrl?: string;
  sources?: StreamSource[];
  matchScore: number;
  releaseYear: number;
  releaseDate?: string;
  imdbRating?: number;
  isUpcoming?: boolean;
  isRecentlyAdded?: boolean;
  isLeavingSoon?: boolean;
  maturityRating: "TV-MA" | "TV-14" | "PG-13" | "PG" | "R" | "G" | "NR";
  duration: string;
  isSeries: boolean;
  isAnime?: boolean;
  seasonsCount?: number;
  episodes?: Episode[];
  nextEpisode?: Episode;
  genres: string[];
  cast: any[];
  director: string;
  isOriginal?: boolean;
  isTrending?: boolean;
  isPopular?: boolean;
  isTop10?: boolean;
  top10Rank?: number;
  popularity?: number;
  tags: string[];
  audioLanguages: string[];
  subtitleLanguages: string[];
  platform?: string;
  /** Populated by cross-platform search — which platforms carry this title */
  availablePlatforms?: string[];
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  movies: Movie[];
}
