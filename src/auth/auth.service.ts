/**
 * AuthService — Firebase-backed user auth.
 *
 * All authentication is now handled by Firebase on the client.
 * The backend only:
 *  1. Verifies Firebase ID tokens (via Admin SDK).
 *  2. Reads / writes per-user data (myList, continueWatching) in Firestore.
 *
 * The legacy JSON-file user store (users.json) is retained for the legacy
 * /api/user guest-mode endpoints but is no longer used for authentication.
 */
import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { FirebaseAdminService } from "../firebase/firebase.module";
import type { DecodedIdToken } from "firebase-admin/auth";
import { ContinueWatchingItem } from "./auth.types";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly firebase: FirebaseAdminService) {}

  // ─── Token Verification ─────────────────────────────────────────────────────

  /**
   * Verify a Firebase ID token.
   * Returns the decoded token payload (uid, email, name, …).
   * Throws UnauthorizedException on invalid / expired tokens.
   */
  async verifyToken(idToken: string): Promise<DecodedIdToken> {
    try {
      return await this.firebase.verifyIdToken(idToken);
    } catch (err: any) {
      this.logger.warn(`Token verification failed: ${err?.message}`);
      throw new UnauthorizedException("Invalid or expired Firebase token.");
    }
  }

  /**
   * Return the Firebase Auth user record for a given UID.
   * Strips sensitive fields — safe to return to the client.
   */
  async getProfile(uid: string) {
    const user = await this.firebase.auth.getUser(uid);
    return {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      createdAt: user.metadata.creationTime,
    };
  }

  // ─── Continue Watching (Firestore) ───────────────────────────────────────────

  private userRef(uid: string) {
    return this.firebase.firestore.collection("users").doc(uid);
  }

  async getContinueWatching(uid: string): Promise<ContinueWatchingItem[]> {
    const snap = await this.userRef(uid).get();
    if (!snap.exists) return [];
    const data = snap.data() ?? {};
    const list: ContinueWatchingItem[] = data["continueWatching"] ?? [];
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async updateContinueWatching(
    uid: string,
    item: ContinueWatchingItem,
  ): Promise<ContinueWatchingItem[]> {
    const ref = this.userRef(uid);
    const snap = await ref.get();
    const existing: ContinueWatchingItem[] = snap.exists
      ? (snap.data()?.["continueWatching"] ?? [])
      : [];

    const filtered = existing.filter((c) => c.movieId !== item.movieId);
    const updated = [item, ...filtered]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 20);

    await ref.set({ continueWatching: updated }, { merge: true });
    return updated;
  }

  async removeContinueWatching(
    uid: string,
    movieId: string,
  ): Promise<ContinueWatchingItem[]> {
    const ref = this.userRef(uid);
    const snap = await ref.get();
    const existing: ContinueWatchingItem[] = snap.exists
      ? (snap.data()?.["continueWatching"] ?? [])
      : [];

    const updated = existing.filter((c) => c.movieId !== movieId);
    await ref.set({ continueWatching: updated }, { merge: true });
    return updated;
  }

  // ─── My List (Firestore) ─────────────────────────────────────────────────────

  async getMyList(uid: string): Promise<any[]> {
    const snap = await this.userRef(uid).get();
    if (!snap.exists) return [];
    return snap.data()?.["myList"] ?? [];
  }

  async toggleMyList(
    uid: string,
    movie: any,
  ): Promise<{ myList: any[]; isSaved: boolean }> {
    const ref = this.userRef(uid);
    const snap = await ref.get();
    const existing: any[] = snap.exists ? (snap.data()?.["myList"] ?? []) : [];

    const idx = existing.findIndex((m) => m.id === movie.id);
    const isSaved = idx === -1;
    const updated = isSaved
      ? [...existing, movie]
      : existing.filter((m) => m.id !== movie.id);

    await ref.set({ myList: updated }, { merge: true });
    return { myList: updated, isSaved };
  }
}
