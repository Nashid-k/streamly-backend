/**
 * Shared types for the auth module.
 * AuthUser and JwtPayload are no longer used since authentication
 * is handled by Firebase Auth. Only ContinueWatchingItem remains
 * as a data-shape contract between the controller and service.
 */

export interface ContinueWatchingItem {
  movieId: string;
  title: string;
  posterUrl: string;
  progressSeconds: number;
  durationSeconds: number;
  platform: string;
  updatedAt: number;
}
