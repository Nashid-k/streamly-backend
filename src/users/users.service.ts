import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import {
  User,
  UserProfile,
  ContinueWatchingItem,
  UserPreferences,
} from "./users.types";
import { FirestoreAdapter } from "./adapters/firestore.adapter";
import { JsonAdapter } from "./adapters/json.adapter";

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);
  private adapter: any;

  async onModuleInit() {
    // Determine which adapter to use based on environment
    const useFirestore =
      process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL;

    if (useFirestore) {
      this.logger.log("Initializing Firestore User Adapter");
      this.adapter = new FirestoreAdapter();
    } else {
      this.logger.log("Initializing Legacy JSON User Adapter");
      this.adapter = new JsonAdapter();
    }

    await this.adapter.init();
  }

  getUser(): User {
    return this.adapter.getUser();
  }

  setCurrentProfile(profileId: string): UserProfile {
    return this.adapter.setCurrentProfile(profileId);
  }

  getMyList(): string[] {
    return this.adapter.getMyList();
  }

  toggleMyList(movieId: string): { myList: string[]; isSaved: boolean } {
    return this.adapter.toggleMyList(movieId);
  }

  updatePreferences(preferences: any): UserPreferences {
    return this.adapter.updatePreferences(preferences);
  }

  getContinueWatching(): ContinueWatchingItem[] {
    return this.adapter.getContinueWatching();
  }

  updateContinueWatching(item: ContinueWatchingItem): ContinueWatchingItem[] {
    return this.adapter.updateContinueWatching(item);
  }

  removeContinueWatching(movieId: string): ContinueWatchingItem[] {
    return this.adapter.removeContinueWatching(movieId);
  }
}
