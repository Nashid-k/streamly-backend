import { Injectable, HttpException, HttpStatus } from "@nestjs/common";
import { StreamAdapter, ResolvedStream } from "./adapters/adapter.interface";
import { VidlinkAdapter } from "./adapters/vidlink.adapter";
import { VidsrcXyzAdapter } from "./adapters/vidsrc-xyz.adapter";
import { EmbedSuAdapter } from "./adapters/embed-su.adapter";
import { VidsrcInAdapter } from "./adapters/vidsrc-in.adapter";
import { TwoEmbedAdapter } from "./adapters/twoembed.adapter";
import { NetmirrorAdapter } from "./adapters/netmirror.adapter";

@Injectable()
export class StreamResolverService {
  private adapters: StreamAdapter[] = [];
  private cache: Map<string, ResolvedStream> = new Map();

  constructor() {
    this.adapters = [
      new NetmirrorAdapter(),
      new VidlinkAdapter(),
      new VidsrcXyzAdapter(),
      new TwoEmbedAdapter(),
      new VidsrcInAdapter(),
      new EmbedSuAdapter(),
    ].sort((a, b) => a.index - b.index);
  }

  async resolve(
    tmdbId: string,
    type: "movie" | "tv",
    season?: number,
    episode?: number,
    preferredServerIndex?: number,
  ): Promise<ResolvedStream> {
    const cacheKey = `${tmdbId}-${type}-${season}-${episode}`;
    const cached = this.cache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return cached;
    }

    let adaptersToTry = [...this.adapters];
    if (preferredServerIndex !== undefined) {
      const prefIndex = adaptersToTry.findIndex(
        (a) => a.index === preferredServerIndex,
      );
      if (prefIndex !== -1) {
        const pref = adaptersToTry.splice(prefIndex, 1)[0];
        adaptersToTry.unshift(pref);
      }
    }

    for (const adapter of adaptersToTry) {
      try {
        const result = await Promise.race([
          adapter.resolve(tmdbId, type, season, episode),
          new Promise<null>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 12000),
          ),
        ]);

        if (result) {
          if (result.type === "hls" || result.type === "mp4") {
            // proxy the url
            result.manifestUrl = `/api/stream/proxy?url=${encodeURIComponent(result.manifestUrl)}&ref=${encodeURIComponent(result.referer)}`;
          }
          this.cache.set(cacheKey, result);
          return result;
        }
      } catch (e) {
        continue;
      }
    }

    throw new HttpException(
      "No streams available",
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
