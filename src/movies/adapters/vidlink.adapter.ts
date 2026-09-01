import { StreamAdapter, ResolvedStream } from "./adapter.interface";
import { BaseAdapter } from "./base.adapter";

export class VidlinkAdapter extends BaseAdapter implements StreamAdapter {
  name = "vidlink.pro";
  index = 1;

  async resolve(
    tmdbId: string,
    type: "movie" | "tv",
    season?: number,
    episode?: number,
  ): Promise<ResolvedStream | null> {
    try {
      const baseUrl = "https://vidlink.pro";
      const embedPath =
        type === "movie"
          ? `/movie/${tmdbId}`
          : `/tv/${tmdbId}/${season}/${episode}`;
      const embedUrl = `${baseUrl}${embedPath}`;

      let html = await this.fetchHtml(embedUrl);
      let m3u8 = this.extractM3u8(html);

      if (!m3u8) {
        const apiPath =
          type === "movie"
            ? `/api/b/movie/${tmdbId}`
            : `/api/b/tv/${tmdbId}/${season}/${episode}`;
        const apiUrl = `${baseUrl}${apiPath}`;

        try {
          const res = await fetch(apiUrl, {
            headers: {
              "User-Agent": this.userAgent,
              Referer: embedUrl,
            },
            signal: AbortSignal.timeout(10000),
          });

          if (res.ok) {
            const data = await res.json();
            const possibleStreams = [
              data?.stream?.playlist,
              data?.playlist,
              data?.file,
              data?.src,
              data?.url,
            ];

            for (const s of possibleStreams) {
              if (s && typeof s === "string" && s.includes(".m3u8")) {
                m3u8 = s;
                break;
              }
            }
          }
        } catch (e) {}
      }

      if (m3u8) {
        return {
          manifestUrl: this.resolveUrl(m3u8, baseUrl),
          type: "hls",
          headers: {
            "User-Agent": this.userAgent,
            Referer: baseUrl,
          },
          referer: baseUrl,
          expiresAt: Date.now() + 15 * 60 * 1000,
          serverName: this.name,
          serverIndex: this.index,
        };
      }

      return null;
    } catch (e) {
      return null;
    }
  }
}
