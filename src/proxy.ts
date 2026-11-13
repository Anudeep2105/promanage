import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware();

export const config = {
  // The UI uses Clerk's client hooks, while workspace data is served by the
  // separately authenticated Hono API. Keep Next middleware for Next API routes.
  matcher: ["/api/(.*)"],
};
