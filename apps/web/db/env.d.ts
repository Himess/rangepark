declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    RETURN_MONITOR_TOKEN?: string;
    RETURN_MONITOR_ENABLED?: string;
  }
}
