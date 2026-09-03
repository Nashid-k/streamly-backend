import {
  Controller,
  Get,
  Query,
  Res,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { Response } from "express";
import { StreamResolverService } from "./stream-resolver.service";

@Controller("api/stream")
export class HlsProxyController {
  constructor(private readonly streamResolver: StreamResolverService) {}

  @Get("resolve")
  async resolve(
    @Query("tmdbId") tmdbId: string,
    @Query("type") type: "movie" | "tv",
    @Query("season") season?: string,
    @Query("episode") episode?: string,
    @Query("serverIndex") serverIndex?: string,
  ) {
    if (!tmdbId || !type) {
      throw new HttpException("Missing tmdbId or type", HttpStatus.BAD_REQUEST);
    }

    const parsedSeason = season ? parseInt(season, 10) : undefined;
    const parsedEpisode = episode ? parseInt(episode, 10) : undefined;
    const parsedServerIndex = serverIndex
      ? parseInt(serverIndex, 10)
      : undefined;

    const result = await this.streamResolver.resolve(
      tmdbId,
      type,
      parsedSeason,
      parsedEpisode,
      parsedServerIndex,
    );

    return {
      proxyManifestUrl: result.manifestUrl,
      serverName: result.serverName,
      serverIndex: result.serverIndex,
      cached: true,
    };
  }

  @Get("proxy")
  async proxy(
    @Query("url") url: string,
    @Query("ref") ref: string,
    @Res() res: Response,
  ) {
    if (!url) {
      throw new HttpException("Missing url", HttpStatus.BAD_REQUEST);
    }

    // SSRF protection: block requests to private/internal IPs and non-HTTP protocols
    try {
      const parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new HttpException('Only HTTP/HTTPS URLs are allowed', HttpStatus.BAD_REQUEST);
      }
      const hostname = parsedUrl.hostname;
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '169.254.169.254' ||
        hostname.startsWith('10.') ||
        hostname.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
        /^0\./.test(hostname)
      ) {
        throw new HttpException('Requests to private/internal networks are blocked', HttpStatus.FORBIDDEN);
      }
    } catch (e) {
      if (e instanceof HttpException) throw e;
      throw new HttpException('Invalid URL', HttpStatus.BAD_REQUEST);
    }

    try {
      const upstreamRes = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Referer: ref || "",
        },
      });

      if (!upstreamRes.ok) {
        throw new HttpException("Upstream error", upstreamRes.status);
      }

      const contentType =
        upstreamRes.headers.get("content-type") || "application/octet-stream";
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", contentType);

      if (url.includes(".m3u8") || contentType.includes("mpegurl")) {
        let text = await upstreamRes.text();
        const baseUrl = new URL(url);

        const lines = text.split("\n");
        const rewrittenLines = lines.map((line) => {
          line = line.trim();
          if (line && !line.startsWith("#")) {
            let absoluteUrl = line;
            if (!line.startsWith("http")) {
              absoluteUrl = new URL(line, baseUrl.href).href;
            }
            return `/api/stream/proxy?url=${encodeURIComponent(absoluteUrl)}&ref=${encodeURIComponent(ref)}`;
          }
          // handle URI in EXT-X-KEY
          if (line.startsWith("#EXT-X-KEY")) {
            return line.replace(/URI="([^"]+)"/, (match, keyUrl) => {
              let absoluteKeyUrl = keyUrl;
              if (!keyUrl.startsWith("http")) {
                absoluteKeyUrl = new URL(keyUrl, baseUrl.href).href;
              }
              return `URI="/api/stream/proxy?url=${encodeURIComponent(absoluteKeyUrl)}&ref=${encodeURIComponent(ref)}"`;
            });
          }
          return line;
        });

        res.send(rewrittenLines.join("\n"));
      } else {
        if (upstreamRes.body) {
          // Node fetch body is a ReadableStream or similar, pipe it
          // for Node 18+ fetch
          const { Readable } = require("stream");
          const readable = Readable.fromWeb(upstreamRes.body);
          readable.pipe(res);
        } else {
          const arrayBuf = await upstreamRes.arrayBuffer();
          res.send(Buffer.from(arrayBuf));
        }
      }
    } catch (error) {
      res.status(500).send("Proxy error");
    }
  }
}
