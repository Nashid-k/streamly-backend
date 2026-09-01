import { Logger } from "@nestjs/common";
import { getFirestore, Firestore, FieldValue } from "firebase-admin/firestore";
import {
  User,
  UserPreferences,
  UserProfile,
  ContinueWatchingItem,
} from "../users.types";

export class FirestoreAdapter {
  private readonly logger = new Logger(FirestoreAdapter.name);
  private db: Firestore;

  // Hardcoded for now. In a real app, this comes from the verified JWT.
  private readonly uid = "guest";

  // Fallback state if DB fetch fails
  private user: User = {
    id: "guest",
    email: "user@netflix.com",
    name: "Streamer",
    profiles: [{ id: "prof-1", name: "Classic", avatarUrl: "", isKids: false }],
    currentProfileId: "prof-1",
    myList: [],
    continueWatching: [],
  };

  async init() {
    this.db = getFirestore();
    try {
      const doc = await this.db.collection("users").doc(this.uid).get();
      if (doc.exists) {
        const data = doc.data() as Partial<User>;
        if (data.myList) this.user.myList = data.myList;
        if (data.continueWatching)
          this.user.continueWatching = data.continueWatching;
        if (data.preferencesByProfile)
          this.user.preferencesByProfile = data.preferencesByProfile;
      } else {
        // Initialize if doesn't exist
        await this.db.collection("users").doc(this.uid).set({
          myList: [],
          continueWatching: [],
          preferencesByProfile: {},
        });
      }
    } catch (e) {
      this.logger.warn(`Firestore User init failed: ${e.message}`);
    }
  }

  getUser(): User {
    return this.user;
  }

  setCurrentProfile(profileId: string): UserProfile {
    this.user.currentProfileId = profileId;
    return this.user.profiles[0];
  }

  getMyList(): string[] {
    return this.user.myList;
  }

  toggleMyList(movieId: string): { myList: string[]; isSaved: boolean } {
    const index = this.user.myList.indexOf(movieId);
    let isSaved = false;
    if (index >= 0) {
      this.user.myList.splice(index, 1);
      this.db
        .collection("users")
        .doc(this.uid)
        .update({ myList: FieldValue.arrayRemove(movieId) })
        .catch();
    } else {
      this.user.myList.push(movieId);
      this.db
        .collection("users")
        .doc(this.uid)
        .update({ myList: FieldValue.arrayUnion(movieId) })
        .catch();
      isSaved = true;
    }
    return { myList: this.user.myList, isSaved };
  }

  updatePreferences(preferences: any): UserPreferences {
    this.user.preferencesByProfile ||= {};
    this.user.preferencesByProfile[this.user.currentProfileId] = preferences;
    this.db
      .collection("users")
      .doc(this.uid)
      .update({ preferencesByProfile: this.user.preferencesByProfile })
      .catch();
    return this.user.preferencesByProfile[this.user.currentProfileId];
  }

  getContinueWatching(): ContinueWatchingItem[] {
    return (this.user.continueWatching || []).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }

  updateContinueWatching(item: ContinueWatchingItem): ContinueWatchingItem[] {
    this.user.continueWatching = this.user.continueWatching || [];
    const idx = this.user.continueWatching.findIndex(
      (c) => c.movieId === item.movieId,
    );
    if (idx >= 0) {
      this.user.continueWatching[idx] = item;
    } else {
      this.user.continueWatching.unshift(item);
    }
    this.user.continueWatching = this.user.continueWatching
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 20);
    this.db
      .collection("users")
      .doc(this.uid)
      .update({ continueWatching: this.user.continueWatching })
      .catch();
    return this.user.continueWatching;
  }

  removeContinueWatching(movieId: string): ContinueWatchingItem[] {
    this.user.continueWatching = (this.user.continueWatching || []).filter(
      (c) => c.movieId !== movieId,
    );
    this.db
      .collection("users")
      .doc(this.uid)
      .update({ continueWatching: this.user.continueWatching })
      .catch();
    return this.user.continueWatching;
  }
}
