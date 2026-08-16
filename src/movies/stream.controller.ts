import { Controller, Get, Req, Res, Query, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
const torrentStream = require('torrent-stream');

@Controller('stream')
export class StreamController {
  private engines: Map<string, any> = new Map();

  @Get()
  async streamTorrent(@Query('magnet') magnet: string, @Query('title') title: string, @Query('year') year: string, @Req() req: Request, @Res() res: Response) {
    if (!magnet && (!title || !year)) {
      throw new HttpException('Magnet link or title+year is required', HttpStatus.BAD_REQUEST);
    }

    if (!magnet && title && year) {
      try {
        const query = encodeURIComponent(`${title} ${year} 1080p multi`);
        const response = await fetch(`https://apibay.org/q.php?q=${query}`);
        const data = await response.json();
        
        if (data && data.length > 0 && data[0].info_hash && data[0].info_hash !== '0000000000000000000000000000000000000000') {
          const hash = data[0].info_hash;
          magnet = `magnet:?xt=urn:btih:${hash}&tr=udp://tracker.opentrackr.org:1337/announce`;
        } else {
          // Fallback to non-multi search
          const fbQuery = encodeURIComponent(`${title} ${year} 1080p`);
          const fbResponse = await fetch(`https://apibay.org/q.php?q=${fbQuery}`);
          const fbData = await fbResponse.json();
          if (fbData && fbData.length > 0 && fbData[0].info_hash && fbData[0].info_hash !== '0000000000000000000000000000000000000000') {
            const hash = fbData[0].info_hash;
            magnet = `magnet:?xt=urn:btih:${hash}&tr=udp://tracker.opentrackr.org:1337/announce`;
          } else {
            throw new HttpException('No torrent found for this movie', HttpStatus.NOT_FOUND);
          }
        }
      } catch (e) {
        throw new HttpException('Failed to search for torrent', HttpStatus.INTERNAL_SERVER_ERROR);
      }
    }

    console.log(`Starting torrent stream for magnet: ${magnet}`);

    let engine = this.engines.get(magnet);

    if (!engine) {
      engine = torrentStream(magnet, {
        connections: 100,
        uploads: 10,
        path: '/tmp/torrent-stream',
        verify: true,
        trackers: [
          'udp://tracker.openbittorrent.com:80',
          'udp://tracker.internetwarriors.net:1337',
          'udp://tracker.leechers-paradise.org:6969',
          'udp://tracker.coppersurfer.tk:6969',
          'udp://exodus.desync.com:6969',
          'wss://tracker.btorrent.xyz',
          'wss://tracker.openwebtorrent.com'
        ]
      });

      this.engines.set(magnet, engine);

      engine.on('ready', () => {
        engine.files.forEach(file => {
          console.log('File found:', file.name);
        });
      });
    }

    // Wait for the engine to be ready with a 15-second timeout
    if (!engine.torrent) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.engines.delete(magnet);
          engine.destroy();
          reject(new HttpException('Timeout: Could not fetch torrent metadata. No seeders found.', HttpStatus.GATEWAY_TIMEOUT));
        }, 15000);
        
        engine.on('ready', () => {
          clearTimeout(timeout);
          resolve(true);
        });
      });
    }

    // Find the largest file (usually the video)
    const file = engine.files.reduce((a, b) => (a.length > b.length ? a : b));

    if (!file) {
      throw new HttpException('No suitable file found in torrent', HttpStatus.NOT_FOUND);
    }

    const fileSize = file.length;
    const range = req.headers.range;

    // We assume mp4 for simplicity, but in reality we'd check file extension
    // or use ffmpeg to transcode mkv to mp4 on the fly.
    const ext = file.name.split('.').pop();
    let contentType = 'video/mp4';
    if (ext === 'mkv') contentType = 'video/x-matroska';
    if (ext === 'webm') contentType = 'video/webm';

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      
      const stream = file.createReadStream({ start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
      };
      res.writeHead(206, head);
      stream.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': contentType,
      };
      res.writeHead(200, head);
      file.createReadStream().pipe(res);
    }
  }
}
