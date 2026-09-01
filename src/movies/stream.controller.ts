import {
  Controller,
  Get,
  Req,
  Res,
  Query,
  HttpException,
  HttpStatus,
  UseGuards,
  Logger,
} from "@nestjs/common";
import { Request, Response } from "express";
import { FirebaseAuthGuard } from "../auth/firebase-auth.guard";
const torrentStream = require("torrent-stream");

interface EngineEntry {
  engine: any;
  lastAccessed: number;
  timer: NodeJS.Timeout;
}

@Controller("stream")
export class StreamController {
  private readonly logger = new Logger(StreamController.name);
  private engines: Map<string, EngineEntry> = new Map();
  private readonly ENGINE_TTL_MS = 30 * 60 * 1000; // 30 minutes

  private destroyEngine(magnet: string) {
    const entry = this.engines.get(magnet);
    if (entry) {
      clearTimeout(entry.timer);
      try {
        entry.engine.destroy();
      } catch {}
      this.engines.delete(magnet);
      this.logger.log(`Engine destroyed for magnet: ${magnet.slice(0, 40)}...`);
    }
  }

  private getOrCreateEngine(magnet: string): any {
    const existing = this.engines.get(magnet);
    if (existing) {
      // Reset TTL on access
      clearTimeout(existing.timer);
      existing.timer = setTimeout(
        () => this.destroyEngine(magnet),
        this.ENGINE_TTL_MS,
      );
      existing.lastAccessed = Date.now();
      return existing.engine;
    }

    const engine = torrentStream(magnet, {
      connections: 50,
      uploads: 5,
      path: "/tmp/torrent-stream",
      verify: true,
      trackers: [
        "udp://tracker.openbittorrent.com:80",
        "udp://tracker.opentrackr.org:1337",
        "udp://tracker.leechers-paradise.org:6969",
        "udp://tracker.coppersurfer.tk:6969",
      ],
    });

    const timer = setTimeout(
      () => this.destroyEngine(magnet),
      this.ENGINE_TTL_MS,
    );
    this.engines.set(magnet, { engine, lastAccessed: Date.now(), timer });
    return engine;
  }

  @Get()
  @UseGuards(FirebaseAuthGuard)
  async streamTorrent(
    @Query("magnet") magnet: string,
    @Query("title") title: string,
    @Query("year") year: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!magnet && (!title || !year)) {
      throw new HttpException(
        "Magnet link or title+year is required",
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!magnet && title && year) {
      try {
        const query = encodeURIComponent(`${title} ${year}`);
        const response = await fetch(`https://apibay.org/q.php?q=${query}`);
        let data = await response.json();

        if (
          data &&
          data.length > 0 &&
          data[0].info_hash &&
          data[0].info_hash !== "0000000000000000000000000000000000000000"
        ) {
          data = data.filter(
            (d: any) =>
              d.info_hash !== "0000000000000000000000000000000000000000",
          );
          data.sort(
            (a: any, b: any) => parseInt(b.seeders) - parseInt(a.seeders),
          );
          const hash = data[0].info_hash;
          magnet = `magnet:?xt=urn:btih:${hash}&tr=udp://tracker.opentrackr.org:1337/announce`;
        } else {
          throw new HttpException(
            "No torrent found for this movie",
            HttpStatus.NOT_FOUND,
          );
        }
      } catch (e: any) {
        if (e instanceof HttpException) throw e;
        throw new HttpException(
          "Failed to search for torrent",
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    }

    this.logger.log(`Streaming torrent for: ${magnet.slice(0, 60)}...`);
    const engine = this.getOrCreateEngine(magnet);

    if (!engine.torrent) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.destroyEngine(magnet);
          reject(
            new HttpException(
              "Timeout: Could not fetch torrent metadata. No seeders found.",
              HttpStatus.GATEWAY_TIMEOUT,
            ),
          );
        }, 15000);

        engine.on("ready", () => {
          clearTimeout(timeout);
          resolve(true);
        });
      });
    }

    const file = engine.files.reduce((a: any, b: any) =>
      a.length > b.length ? a : b,
    );
    if (!file) {
      throw new HttpException(
        "No suitable file found in torrent",
        HttpStatus.NOT_FOUND,
      );
    }

    const fileSize = file.length;
    const range = req.headers.range;
    const ext = file.name.split(".").pop()?.toLowerCase();
    let contentType = "video/mp4";
    if (ext === "mkv") contentType = "video/x-matroska";
    if (ext === "webm") contentType = "video/webm";

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = end - start + 1;
      const stream = file.createReadStream({ start, end });
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunksize,
        "Content-Type": contentType,
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": contentType,
      });
      file.createReadStream().pipe(res);
    }

    req.on("close", () => {
      this.logger.log(`Client disconnected from torrent stream`);
      // Don't immediately destroy — let TTL handle it so concurrent viewers can reuse
    });
  }
}
