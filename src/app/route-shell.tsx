import { Suspense } from "react";
import Home from "./page";

export default function RouteShell() {
  return <Suspense fallback={<main className="auth-loading">Loading your workspace…</main>}><Home /></Suspense>;
}
