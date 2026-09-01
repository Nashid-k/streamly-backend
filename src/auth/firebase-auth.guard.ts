import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from "@nestjs/common";
import { FirebaseAdminService } from "../firebase/firebase.module";

@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(FirebaseAuthGuard.name);

  constructor(private readonly firebase: FirebaseAdminService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new UnauthorizedException(
        "Missing or invalid Authorization header.",
      );
    }
    const token = authHeader.slice(7);
    try {
      const decoded = await this.firebase.verifyIdToken(token);
      request.user = decoded;
      return true;
    } catch (err: any) {
      this.logger.warn(`Auth guard rejected token: ${err?.message}`);
      throw new UnauthorizedException("Invalid or expired Firebase token.");
    }
  }
}
