const KNOWN_MIRRORS = [
  "https://net77.cc",
  "https://net22.cc",
  "https://net52.cc",
];

const DISCOVERY_URL = "https://netmirror.gg/";
const DISCOVERY_TIMEOUT_MS = 10000;
const PROBE_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_LIVE_MIRRORS = 3;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface NetmirrorDomainCache {
  bases: string[];
  discoveredAt: number;
}

export class NetmirrorDomainResolver {
  private cache: NetmirrorDomainCache | null = null;

  async liveBases(): Promise<string[]> {
    const envBases = this.envBases();
    if (envBases.length > 0) return envBases;

    if (this.cache && Date.now() - this.cache.discoveredAt < CACHE_TTL_MS) {
      return this.cache.bases;
    }

    const candidates = await this.discover();
    const alive = await this.filterLive(candidates);
    this.cache = { bases: alive, discoveredAt: Date.now() };
    return alive;
  }

  private envBases(): string[] {
    const raw = process.env.NETMIRROR_DOMAINS || "";
    return raw
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => (d.startsWith("http") ? d.replace(/\/+$/, "") : `https://${d}`));
  }

  private async discover(): Promise<string[]> {
    const candidates = new Set<string>();
    try {
      const res = await fetch(DISCOVERY_URL, {
        headers: { "User-Agent": BROWSER_USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      const html = await res.text();
      const mirrorLinks = html.match(/https:\/\/net[a-z0-9]+\.cc\//gi) || [];
      for (const link of mirrorLinks) {
        try {
          candidates.add(new URL(link).origin);
        } catch {}
      }
    } catch {}

    for (const base of KNOWN_MIRRORS) {
      candidates.add(base);
    }
    return [...candidates];
  }

  private async filterLive(bases: string[]): Promise<string[]> {
    const alive: string[] = [];
    for (const base of bases) {
      try {
        const res = await fetch(`${base}/`, {
          headers: { "User-Agent": BROWSER_USER_AGENT },
          redirect: "follow",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (res.status > 0 && res.status < 500) {
          alive.push(base);
          if (alive.length >= MAX_LIVE_MIRRORS) break;
        }
      } catch {}
    }
    return alive;
  }
}