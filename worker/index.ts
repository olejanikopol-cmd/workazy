/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  MEDIA: R2Bucket;
  WORKAZY_API_TOKEN?: string;
  WORKAZY_TIME_ZONE?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Run exact-time reminders inside the Worker. This avoids relying on the
    // public Sites URL (or a long-lived GitHub job) for minute-by-minute ticks.
    const headers = new Headers();
    if (env.WORKAZY_API_TOKEN) {
      headers.set("Authorization", `Bearer ${env.WORKAZY_API_TOKEN}`);
    }

    const timeZone = env.WORKAZY_TIME_ZONE ?? "Europe/Kyiv";
    const minute = new Intl.DateTimeFormat("en", {
      timeZone,
      minute: "2-digit",
    }).format(new Date());
    const dueOnly = minute !== "55";

    const response = await this.fetch(
      new Request(`https://workazy.internal/api/v1/reminders/tick${dueOnly ? "?dueOnly=true" : ""}`, {
        method: "POST",
        headers,
      }),
      env,
      ctx,
    );

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(`Workazy reminder tick failed (${response.status}): ${details.slice(0, 500)}`);
    }
  },
};

export default worker;
