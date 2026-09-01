import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Headers,
  UnauthorizedException,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { AuthService } from "./auth.service";
import { ContinueWatchingItem } from "./auth.types";

/** Extracts Bearer token from Authorization header */
function extractToken(authorization?: string): string | null {
  if (!authorization) return null;
  const [scheme, token] = authorization.split(" ");
  return scheme === "Bearer" && token ? token : null;
}

@Controller("api/auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ─── Profile ─────────────────────────────────────────────────────────────────

  /**
   * GET /api/auth/me
   * Verifies the Firebase ID token and returns the Firebase Auth user profile.
   */
  @Get("me")
  async getMe(@Headers("authorization") authorization?: string) {
    const token = extractToken(authorization);
    if (!token) throw new UnauthorizedException("No token provided.");
    const decoded = await this.authService.verifyToken(token);
    return this.authService.getProfile(decoded.uid);
  }

  // ─── My List ─────────────────────────────────────────────────────────────────

  /**
   * GET /api/auth/mylist
   * Returns the authenticated user's My List from Firestore.
   */
  @Get("mylist")
  async getMyList(@Headers("authorization") authorization?: string) {
    const token = extractToken(authorization);
    if (!token) return [];
    try {
      const decoded = await this.authService.verifyToken(token);
      return this.authService.getMyList(decoded.uid);
    } catch {
      return [];
    }
  }

  /**
   * POST /api/auth/mylist/toggle
   * Toggles a movie in/out of the user's My List in Firestore.
   * Body: { movie: <full movie object> }
   */
  @Post("mylist/toggle")
  @HttpCode(HttpStatus.OK)
  async toggleMyList(
    @Headers("authorization") authorization: string,
    @Body("movie") movie: any,
  ) {
    const token = extractToken(authorization);
    if (!token) throw new UnauthorizedException("Authentication required.");
    const decoded = await this.authService.verifyToken(token);
    return this.authService.toggleMyList(decoded.uid, movie);
  }

  // ─── Continue Watching ───────────────────────────────────────────────────────

  /**
   * GET /api/auth/continue-watching
   * Returns the user's Continue Watching list from Firestore (auth-gated).
   * Returns [] silently for guests / invalid tokens.
   */
  @Get("continue-watching")
  async getContinueWatching(@Headers("authorization") authorization?: string) {
    const token = extractToken(authorization);
    if (!token) return [];
    try {
      const decoded = await this.authService.verifyToken(token);
      return this.authService.getContinueWatching(decoded.uid);
    } catch {
      return [];
    }
  }

  /**
   * POST /api/auth/continue-watching
   * Upserts a progress entry for the authenticated user in Firestore.
   */
  @Post("continue-watching")
  @HttpCode(HttpStatus.OK)
  async updateContinueWatching(
    @Headers("authorization") authorization: string,
    @Body() item: ContinueWatchingItem,
  ) {
    const token = extractToken(authorization);
    if (!token) throw new UnauthorizedException("Authentication required.");
    const decoded = await this.authService.verifyToken(token);
    return this.authService.updateContinueWatching(decoded.uid, item);
  }

  /**
   * DELETE /api/auth/continue-watching/:movieId
   * Removes one entry from the user's Continue Watching list in Firestore.
   */
  @Delete("continue-watching/:movieId")
  async removeContinueWatching(
    @Headers("authorization") authorization: string,
    @Param("movieId") movieId: string,
  ) {
    const token = extractToken(authorization);
    if (!token) throw new UnauthorizedException("Authentication required.");
    const decoded = await this.authService.verifyToken(token);
    return this.authService.removeContinueWatching(decoded.uid, movieId);
  }
}
