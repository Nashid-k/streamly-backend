import { ServiceUnavailableException } from "@nestjs/common";
import axios from "axios";

export class TmdbAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly fallbackBaseUrls: string[],
    private readonly apiKey: string,
    private readonly readToken: string,
    private readonly language: string = "en-US",
    private readonly region: string = "US",
    private readonly requestTimeoutMs: number = 5000,
  ) {}

  private isConfigured() {
    return Boolean(this.readToken || this.apiKey);
  }

  private ensureConfigured() {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        "TMDB credentials are not configured.",
      );
    }
  }

  async get(path: string, params: Record<string, string> = {}) {
    this.ensureConfigured();
    const query = new URLSearchParams({ language: this.language, ...params });
    if (this.region) query.set("region", this.region);
    if (!this.readToken && this.apiKey) query.set("api_key", this.apiKey);

    const baseUrls = Array.from(
      new Set([this.baseUrl, ...this.fallbackBaseUrls]),
    );
    let lastError: any;

    for (const base of baseUrls) {
      try {
        const url = new URL(`${base}/${path}`);
        for (const [key, value] of query) url.searchParams.set(key, value);

        const response = await axios({
          url: url.toString(),
          method: "GET",
          headers: this.readToken
            ? {
                Authorization: `Bearer ${this.readToken}`,
                Accept: "application/json",
              }
            : { Accept: "application/json" },
          timeout: this.requestTimeoutMs,
        });

        return response.data;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error(`TMDB ${path} failed on all endpoints.`);
  }
}
