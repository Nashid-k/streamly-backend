import { Controller, Get } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";

@Controller()
export class AppController {
  // Health checks must never count against the per-IP rate limit — the
  // frontend health monitor probes on cold starts and visibility changes,
  // and a flapping poller must not starve real users' request quota.
  @SkipThrottle()
  @Get("health")
  healthCheck() {
    return {
      status: "ok",
      service: "streamly-api",
      uptimeSec: Math.round(process.uptime()),
      timestamp: Date.now(),
    };
  }
}
