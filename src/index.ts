import { withSunsetHeaders } from "./deprecation";
import { type Env, handleContribute } from "./routes/contribute";
import { handleContributeDisc } from "./routes/contribute_disc";
import { handleDevSeed } from "./routes/dev_seed";
import { handleForget } from "./routes/forget";
import { handleIdentify } from "./routes/identify";
import { handleIdentifyDisc } from "./routes/identify_disc";
import { handlePack } from "./routes/pack";
import { runPackBuilder, runSketchBuilder } from "./workers/pack_builder";
import { runPromotion } from "./workers/promotion";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Every response served on the legacy *.workers.dev host carries the
    // migration deprecation signal; requests on the canonical host pass through.
    return withSunsetHeaders(url, await routeRequest(request, env, url), env);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === "0 3 * * *") ctx.waitUntil(runPromotion(env));
    if (controller.cron === "0 4 * * *") ctx.waitUntil(runPackBuilder(env));
    // Hourly sketch sweep: ~63 sketches/run within the 30s budget keeps identify
    // coverage ahead of intake without coupling to the daily promotion/pack crons.
    if (controller.cron === "0 * * * *") ctx.waitUntil(runSketchBuilder(env));
  },
} satisfies ExportedHandler<Env>;

async function routeRequest(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/v1/contribute") {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    return handleContribute(request, env, url);
  }
  if (url.pathname === "/v1/contribute-disc") {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    return handleContributeDisc(request, env, url);
  }
  if (url.pathname === "/v1/forget") {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    return handleForget(request, env);
  }

  if (url.pathname === "/v1/identify") {
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    return handleIdentify(request, env);
  }

  if (url.pathname === "/v1/identify-disc") {
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    return handleIdentifyDisc(request, env);
  }

  const packMatch = url.pathname.match(/^\/v1\/pack\/(\d+)$/);
  if (packMatch) {
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    return handlePack(env, Number(packMatch[1]), request.headers.get("If-None-Match"));
  }

  if (url.pathname === "/v1/_dev/seed" && env.ALLOW_DEV_SEED === "1") {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    return handleDevSeed(request, env);
  }

  return new Response("Not Found", { status: 404 });
}
