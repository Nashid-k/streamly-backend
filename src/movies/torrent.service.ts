import { Injectable } from '@nestjs/common';

@Injectable()
export class TorrentService {
  async getMagnetForMovie(title: string, year: string): Promise<string | null> {
    try {
      // Search apibay for a 1080p multi-audio release
      const query = encodeURIComponent(`${title} ${year} 1080p multi`);
      const response = await fetch(`https://apibay.org/q.php?q=${query}`);
      const data = await response.json();
      
      if (data && data.length > 0 && data[0].info_hash && data[0].info_hash !== '0000000000000000000000000000000000000000') {
        const hash = data[0].info_hash;
        return `magnet:?xt=urn:btih:${hash}&tr=udp://tracker.opentrackr.org:1337/announce`;
      }
      
      // Fallback to non-multi search
      const fbQuery = encodeURIComponent(`${title} ${year} 1080p`);
      const fbResponse = await fetch(`https://apibay.org/q.php?q=${fbQuery}`);
      const fbData = await fbResponse.json();
      
      if (fbData && fbData.length > 0 && fbData[0].info_hash && fbData[0].info_hash !== '0000000000000000000000000000000000000000') {
        const hash = fbData[0].info_hash;
        return `magnet:?xt=urn:btih:${hash}&tr=udp://tracker.opentrackr.org:1337/announce`;
      }
      
      return null;
    } catch (e) {
      console.error('Failed to fetch torrent', e);
      return null;
    }
  }
}
