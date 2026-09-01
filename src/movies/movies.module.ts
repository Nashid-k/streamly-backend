import { Module } from "@nestjs/common";
import { MoviesController } from "./movies.controller";
import { StreamController } from "./stream.controller";
import { MoviesService } from "./movies.service";
import { StreamResolverService } from "./stream-resolver.service";
import { HlsProxyController } from "./hls-proxy.controller";
import { FirebaseModule } from "../firebase/firebase.module";
import { FirebaseAuthGuard } from "../auth/firebase-auth.guard";

@Module({
  imports: [FirebaseModule],
  controllers: [MoviesController, StreamController, HlsProxyController],
  providers: [MoviesService, StreamResolverService, FirebaseAuthGuard],
  exports: [MoviesService],
})
export class MoviesModule {}
