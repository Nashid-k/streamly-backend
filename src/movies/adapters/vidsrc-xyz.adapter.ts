import { StreamAdapter, ResolvedStream } from "./adapter.interface";
import { BaseAdapter } from "./base.adapter";

export class VidsrcXyzAdapter extends BaseAdapter implements StreamAdapter {
  name = "vidsrc.xyz";
  index = 2;

  async resolve(
    tmdbId: string,
    type: "movie" | "tv",
    season?: number,
    episode?: number,
  ): Promise<ResolvedStream | null> {
    try {
      const baseUrl = "https://vidsrc.xyz";
      const embedUrl =
        type === "movie"
          ? `${baseUrl}/embed/movie?tmdb=${tmdbId}`
          : `${baseUrl}/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}`;

      const html = await this.fetchHtml(embedUrl);
      const iframeMatch = html.match(
        /<iframe[^>]+src=["'](https:\/\/vidsrc\.xyz\/e\/[^"']+)["']/i,
      );

      if (!iframeMatch) return null;

      const innerUrl = iframeMatch[1];
      const innerHtml = await this.fetchHtml(innerUrl, embedUrl);

      // Look for obfuscated rc4 / atob code block
      // Example: let src = atob('...'.split('').reverse().join(''));
      const scriptMatches = [
        ...innerHtml.matchAll(/<script[^>]*>(.*?)<\/script>/gs),
      ];
      let decodedUrl = "";

      for (const script of scriptMatches) {
        const code = script[1];
        // match strings that look like base64
        const stringMatches = [
          ...code.matchAll(/["']([a-zA-Z0-9+/=]{20,})["']/g),
        ];
        for (const match of stringMatches) {
          const reversed = match[1].split("").reverse().join("");
          const decoded = this.decodeBase64(reversed);
          if (decoded.includes(".m3u8") || decoded.startsWith("http")) {
            decodedUrl = decoded;
            break;
          }
        }
        if (decodedUrl) break;
      }

      if (!decodedUrl) {
        decodedUrl = this.extractM3u8(innerHtml) || "";
      }

      if (decodedUrl) {
        if (!decodedUrl.startsWith("http") && !decodedUrl.startsWith("//")) {
          decodedUrl = this.resolveUrl(decodedUrl, baseUrl);
        } else if (decodedUrl.startsWith("//")) {
          decodedUrl = "https:" + decodedUrl;
        }

        // Follow up to 3 redirects
        let finalUrl = decodedUrl;
        for (let i = 0; i < 3; i++) {
          try {
            const res = await fetch(finalUrl, {
              method: "HEAD",
              redirect: "follow",
              headers: { "User-Agent": this.userAgent, Referer: baseUrl },
              signal: AbortSignal.timeout(10000),
            });
            finalUrl = res.url;
            if (finalUrl.includes(".m3u8")) break;
          } catch (e) {
            break;
          }
        }

        return {
          manifestUrl: finalUrl,
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
