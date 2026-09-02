import { config } from "dotenv";
import { join } from "path";
import { NestFactory } from "@nestjs/core";
import compression = require("compression");
import helmet from "helmet";
import { AppModule } from "./app.module";

import { ConfigService } from "@nestjs/config";

// Resolve this relative to the backend source/build directory so `npm --prefix
// backend ...` and a root-level process both load backend/.env.
config({ path: join(__dirname, "..", ".env") });

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  app.use(compression());
  app.use(helmet());

  const defaultOrigins = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:5173",
    "http://localhost",       // Capacitor Android
    "capacitor://localhost",  // Capacitor iOS
  ];
  const frontendUrl = configService.get<string>("FRONTEND_URL");

  // Sanitize FRONTEND_URL to ensure users who forget to type "https://" in Render dashboard don't get blocked
  const envOrigins = frontendUrl
    ? frontendUrl
        .split(",")
        .map((url) => url.trim())
        .filter(Boolean)
        .map((url) => (url.startsWith("http") ? url : `https://${url}`))
    : [];

  const allowedOrigins = Array.from(
    new Set([...defaultOrigins, ...envOrigins]),
  );

  // Keep browser access scoped to this application's frontend.
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Allow requests with no origin (mobile apps, curl, server-to-server)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS blocked for origin: ${origin}`));
      }
    },
    methods: "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
    exposedHeaders: ["Cache-Control"],
  });

  const port = configService.get<number>("PORT") || 4000;
  await app.listen(port, "0.0.0.0");
  console.log(`🚀 NestJS Backend running on port: ${port}`);
}
bootstrap();
