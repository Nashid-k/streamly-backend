export interface ResolvedStream {
  manifestUrl: string; // absolute URL to .m3u8, .mp4, or direct stream
  type: "hls" | "mp4" | "raw";
  headers: Record<string, string>; // required request headers for segments
  referer: string; // referer to pass when proxying
  expiresAt: number; // Unix ms timestamp
  serverName: string;
  serverIndex: number;
}

export interface StreamAdapter {
  name: string;
  index: number;
  resolve(
    tmdbId: string,
    type: "movie" | "tv",
    season?: number,
    episode?: number,
  ): Promise<ResolvedStream | null>;
}
