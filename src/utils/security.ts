import { URL } from "url";

export function isSafeUrl(targetUrl: string): boolean {
  if (!targetUrl) return false;
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    const hostname = parsed.hostname;

    // Block localhost and loopback
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    ) {
      return false;
    }

    // Block AWS metadata IP
    if (hostname === "169.254.169.254") {
      return false;
    }

    // Block private IP ranges (basic check)
    if (
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)
    ) {
      return false;
    }

    return true;
  } catch (e) {
    return false; // Invalid URL
  }
}
