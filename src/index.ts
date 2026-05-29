import { handleContribute, type Env } from "./routes/contribute";
import { handleForget } from "./routes/forget";
import { handleIdentify } from "./routes/identify";
import { handlePack } from "./routes/pack";
import { runPromotion } from "./workers/promotion";
import { runPackBuilder } from "./workers/pack_builder";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/v1/contribute") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      return handleContribute(request, env);
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

    const packMatch = url.pathname.match(/^\/v1\/pack\/(\d+)$/);
    if (packMatch) {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      return handlePack(env, Number(packMatch[1]), request.headers.get("If-None-Match"));
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === "0 3 * * *") ctx.waitUntil(runPromotion(env));
    if (event.cron === "0 4 * * *") ctx.waitUntil(runPackBuilder(env));
  },
} satisfies ExportedHandler<Env>;
