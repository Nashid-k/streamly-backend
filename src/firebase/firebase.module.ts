/**
 * FirebaseModule — provides FirebaseAdminService as a globally injectable
 * NestJS provider so any module can verify Firebase ID tokens without
 * importing the raw firebase-admin singleton directly.
 */
import { Module, Global, Injectable } from "@nestjs/common";
import { adminAuth, adminFirestore } from "./firebase-admin";
import type { DecodedIdToken } from "firebase-admin/auth";

@Injectable()
export class FirebaseAdminService {
  readonly auth = adminAuth;
  readonly firestore = adminFirestore;

  /**
   * Verify a Firebase ID token sent by the frontend.
   * Throws if the token is invalid or expired.
   */
  async verifyIdToken(idToken: string): Promise<DecodedIdToken> {
    return this.auth.verifyIdToken(idToken);
  }
}

@Global()
@Module({
  providers: [FirebaseAdminService],
  exports: [FirebaseAdminService],
})
export class FirebaseModule {}
