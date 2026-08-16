import { Module } from '@nestjs/common';
import { MoviesController } from './movies.controller';
import { StreamController } from './stream.controller';
import { MoviesService } from './movies.service';

@Module({
  controllers: [MoviesController, StreamController],
  providers: [MoviesService],
  exports: [MoviesService],
})
export class MoviesModule {}
