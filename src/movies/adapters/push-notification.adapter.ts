import { Logger } from "@nestjs/common";
import { getMessaging, Messaging } from "firebase-admin/messaging";
import { getApps } from "firebase-admin/app";

export class PushNotificationAdapter {
  private readonly logger = new Logger(PushNotificationAdapter.name);
  private messaging: Messaging;
  private initialized = false;

  constructor() {
    try {
      if (getApps().length > 0) {
        this.messaging = getMessaging();
        this.initialized = true;
      }
    } catch (e) {
      this.logger.warn(
        "Firebase admin not initialized, push notifications disabled.",
      );
    }
  }

  /**
   * Send a notification to a specific user (by FCM token or topic).
   */
  async sendToUser(
    fcmToken: string,
    title: string,
    body: string,
    imageUrl?: string,
    deepLink?: string,
  ) {
    if (!this.initialized) return;

    try {
      await this.messaging.send({
        token: fcmToken,
        notification: {
          title,
          body,
          ...(imageUrl && { imageUrl }),
        },
        data: {
          click_action: "FLUTTER_NOTIFICATION_CLICK",
          ...(deepLink && { deepLink }),
        },
        android: {
          priority: "high",
          notification: {
            sound: "default",
            channelId: "new_releases",
          },
        },
        apns: {
          payload: {
            aps: {
              sound: "default",
              badge: 1,
            },
          },
        },
      });
      this.logger.log(`Push notification sent to ${fcmToken}`);
    } catch (e) {
      this.logger.error(`Failed to send push notification: ${e.message}`);
    }
  }

  /**
   * Broadcast a notification to all users subscribed to a specific topic (e.g. 'new_releases').
   */
  async broadcastNewRelease(
    movieTitle: string,
    platform: string,
    movieId: string,
  ) {
    if (!this.initialized) return;

    try {
      await this.messaging.send({
        topic: "new_releases",
        notification: {
          title: `New on ${platform}!`,
          body: `${movieTitle} is now streaming on ${platform}. Tap to watch now!`,
        },
        data: {
          movieId: movieId.toString(),
          action: "open_movie",
        },
      });
      this.logger.log(
        `Broadcasted new release push notification for ${movieTitle}`,
      );
    } catch (e) {
      this.logger.error(`Failed to broadcast push notification: ${e.message}`);
    }
  }
}
