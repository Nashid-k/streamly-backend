import axios from "axios";

export class RapidApiAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly requestTimeoutMs: number = 8000,
  ) {}

  async getChanges(
    serviceName: string,
    changeType: "new" | "expiring",
    itemType: "show" | "movie" = "show",
  ) {
    if (!this.apiKey) return null;

    try {
      const response = await axios({
        url: `https://streaming-availability.p.rapidapi.com/changes?country=us&services=${serviceName}&change_type=${changeType}&item_type=${itemType}`,
        method: "GET",
        headers: {
          "x-rapidapi-key": this.apiKey,
          "x-rapidapi-host": "streaming-availability.p.rapidapi.com",
          Accept: "application/json",
        },
        timeout: this.requestTimeoutMs,
      });
      return response.data;
    } catch (err) {
      console.warn(`RapidAPI ${serviceName} ${changeType} fetch failed.`);
      return null;
    }
  }
}
