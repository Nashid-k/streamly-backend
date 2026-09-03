import { StreamAdapter, ResolvedStream } from "./adapter.interface";
import { BaseAdapter } from "./base.adapter";

export class EmbedSuAdapter extends BaseAdapter implements StreamAdapter {
  name = "embed.su";
  index = 6;

  async resolve(
    tmdbId: string,
    type: "movie" | "tv",
    season?: number,
    episode?: number,
  ): Promise<ResolvedStream | null> {
    try {
      const baseUrl = "https://embed.su";
      const embedPath =
        type === "movie"
          ? `/embed/movie/${tmdbId}`
          : `/embed/tv/${tmdbId}/${season}/${episode}`;
      const embedUrl = `${baseUrl}${embedPath}`;

      const html = await this.fetchHtml(embedUrl);
      let m3u8 = this.extractM3u8(html);

      if (!m3u8) {
        const sourceMatch = html.match(/"file"\s*:\s*"([^"]+\.m3u8[^"]*)"/i);
        if (sourceMatch) {
          m3u8 = sourceMatch[1];
        }
      }

      if (!m3u8) {
        const apiMatch = html.match(/\/api\/source\/[a-zA-Z0-9_-]+/i);
        if (apiMatch) {
          try {
            const apiUrl = `${baseUrl}${apiMatch[0]}`;
            const res = await fetch(apiUrl, {
              headers: {
                "User-Agent": this.userAgent,
                Referer: embedUrl,
                Accept: "application/json",
              },
              signal: AbortSignal.timeout(10000),
            });
            if (res.ok) {
              const data = await res.json();
              if (data?.source) {
                m3u8 = data.source;
              }
            }
          } catch (e) {}
        }
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
