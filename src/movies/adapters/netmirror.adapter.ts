import { StreamAdapter, ResolvedStream } from "./adapter.interface";
import { BaseAdapter } from "./base.adapter";

export class NetmirrorAdapter extends BaseAdapter implements StreamAdapter {
  name = "netmirror";
  index = 4; // Prioritize this since it supports multi-audio!

  async resolve(
    tmdbId: string,
    type: "movie" | "tv",
    season?: number,
    episode?: number,
  ): Promise<ResolvedStream | null> {
    try {
      // NOTE: Netmirror domain frequently changes (net52.cc, netmirror.app, etc.)
      const baseUrl = "https://net52.cc";

      // Attempt to hit their standard embed route (this may need adjustment if they use IMDB IDs instead of TMDB)
      const embedUrl =
        type === "movie"
          ? `${baseUrl}/e/movie/${tmdbId}`
          : `${baseUrl}/e/tv/${tmdbId}/${season}/${episode}`;

      const html = await this.fetchHtml(embedUrl);

      // Extract tokens from HTML
      const timeMatch = html.match(/data-time="([^"]+)"/);
      const hashMatch = html.match(/data-h="([^"]+)"/);
      const titleMatch = html.match(/data-title="([^"]+)"/);
      const videoIdMatch = html.match(/playerstart\("([^"]+)"\)/);

      if (!timeMatch || !hashMatch || !videoIdMatch) {
        console.error("Netmirror: Failed to extract tokens from HTML");
        return null;
      }

      const time = timeMatch[1];
      const hash = hashMatch[1];
      const title = titleMatch ? encodeURIComponent(titleMatch[1]) : "";
      const videoId = videoIdMatch[1];

      // Construct the playlist API url
      const playlistUrl = `${baseUrl}/playlist.php?id=${videoId}&t=${title}&tm=${time}&h=${hash}`;

      // Fetch the JWPlayer playlist JSON
      const res = await fetch(playlistUrl, {
        headers: {
          "User-Agent": this.userAgent,
          Referer: embedUrl,
          Accept: "application/json",
        },
      });

      if (!res.ok) return null;
      const playlistData = await res.json();

      // Parse JWPlayer playlist format (usually an array with a "sources" array)
      // Example: [{ sources: [{ file: "https://...m3u8" }] }]
      let m3u8Url = "";
      if (Array.isArray(playlistData) && playlistData.length > 0) {
        const item = playlistData[0];
        if (item.sources && item.sources.length > 0) {
          m3u8Url = item.sources[0].file;
        }
      }

      if (m3u8Url) {
        return {
          manifestUrl: m3u8Url,
          type: "hls",
          headers: {
            "User-Agent": this.userAgent,
            Referer: baseUrl,
          },
          referer: baseUrl,
          expiresAt: Date.now() + 60 * 60 * 1000,
          serverName: this.name,
          serverIndex: this.index,
        };
      }

      return null;
    } catch (e) {
      console.error("Netmirror adapter failed:", e);
      return null;
    }
  }
}
