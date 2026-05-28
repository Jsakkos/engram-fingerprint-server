import { handleContribute, type Env } from "./routes/contribute";
import { handleForget } from "./routes/forget";
import { runPromotion } from "./workers/promotion";

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

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === "0 3 * * *") {
      ctx.waitUntil(runPromotion(env));
    }
    // PackBuilder cron lands in Task S6.2
  },
} satisfies ExportedHandler<Env>;
