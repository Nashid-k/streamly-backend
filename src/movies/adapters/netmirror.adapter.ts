import { StreamAdapter, ResolvedStream } from "./adapter.interface";
import { BaseAdapter } from "./base.adapter";
import { NetmirrorDomainResolver } from "./netmirror-domains";

const PLAYLIST_TM = "1724829817";
const HLSCLIENT_ID = "unknown::ni";

interface NetmirrorTrack {
  kind?: string;
  file?: string;
  label?: string;
  language?: string;
}

interface NetmirrorPlaylistItem {
  sources?: Array<{ file?: string; label?: string; type?: string; default?: string }>;
  tracks?: NetmirrorTrack[];
}

export class NetmirrorAdapter extends BaseAdapter implements StreamAdapter {
  name = "netmirror";
  index = 4; // Prioritize this since it supports multi-audio!

  private readonly resolver = new NetmirrorDomainResolver();

  async resolve(
    tmdbId: string,
    type: "movie" | "tv",
    season?: number,
    episode?: number,
    title?: string,
  ): Promise<ResolvedStream | null> {
    if (type === "tv" && (season !== undefined || episode !== undefined)) {
      console.error("Netmirror: per-episode ids require the CF-gated web UI; cannot resolve");
      return null;
    }

    const searchQuery = title || tmdbId;
    if (!searchQuery) return null;

    const bases = await this.resolver.liveBases();
    if (bases.length === 0) {
      console.error("Netmirror: no live mirror domains found");
      return null;
    }

    for (const baseUrl of bases) {
      try {
        const contentId = await this.searchContentId(baseUrl, searchQuery);
        if (!contentId) continue;

        const playlistUrl = `${baseUrl}/playlist.php?id=${contentId}&t=&tm=${PLAYLIST_TM}`;
        const res = await fetch(playlistUrl, {
          headers: {
            "User-Agent": this.userAgent,
            Referer: `${baseUrl}/`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) continue;
        const playlistData = (await res.json()) as NetmirrorPlaylistItem[];
        if (!Array.isArray(playlistData) || playlistData.length === 0) continue;

        const fullHdSource = this.fullHdSource(playlistData);
        if (!fullHdSource) continue;

        return {
          manifestUrl: this.absolutize(fullHdSource, baseUrl),
          type: "hls",
          headers: {
            "User-Agent": this.userAgent,
            Referer: `${baseUrl}/`,
          },
          referer: `${baseUrl}/`,
          expiresAt: Date.now() + 12 * 60 * 60 * 1000,
          serverName: this.name,
          serverIndex: this.index,
        };
      } catch {
        continue;
      }
    }

    return null;
  }

  private async searchContentId(baseUrl: string, query: string): Promise<string | null> {
    const searchUrl = `${baseUrl}/search.php?s=${encodeURIComponent(query)}`;
    const res = await fetch(searchUrl, {
      headers: {
        "User-Agent": this.userAgent,
        Referer: `${baseUrl}/`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { type?: number; searchResult?: Array<{ id?: string; t?: string }> };
    if (!data || !Array.isArray(data.searchResult) || data.searchResult.length === 0) {
      return null;
    }

    return data.searchResult[0]?.id || null;
  }

  private fullHdSource(items: NetmirrorPlaylistItem[]): string | null {
    for (const item of items) {
      if (!item || !Array.isArray(item.sources)) continue;
      const hd = item.sources.find((s) => s && typeof s.file === "string" && !s.file.includes("q="));
      if (hd && hd.file) return hd.file;
      const first = item.sources.find((s) => s && typeof s.file === "string");
      if (first && first.file) return first.file;
    }
    return null;
  }

  private absolutize(path: string, baseUrl: string): string {
    try {
      return new URL(path, baseUrl).toString();
    } catch {
      return path;
    }
  }
}