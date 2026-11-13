# ProManage project workspace

ProManage is a full-stack project management app with a Next.js web UI, a Hono API, Prisma, and PostgreSQL.

## What's included

- Workspace creation and switching; project creation, selection, and Agile/Waterfall setup
- Clerk sign-in and sign-up, verified API sessions, workspace member roles, and email invitations
- Project overview, task board, timeline, backlog, and team views
- Task creation and editing, status and priority, assignment to workspace members, dates, sprint planning, and task dependencies
- Task comments, project activity, and live project event updates
- PostgreSQL schema and versioned SQL migrations in `server/server/prisma/migrations`

The root `src/app` is the active web application. The active API and Prisma schema are under `server/server`.

## Run with Docker

Install Docker Desktop, then start the full stack from the project root. If Clerk is configured in the root `.env.local`, use it to supply the Clerk keys at build and runtime:

```powershell
docker compose --env-file .env.local up --build
```

Open `http://localhost:3000`. PostgreSQL is available on port `5432` and the API on port `3001`. The API waits for PostgreSQL, applies the Prisma schema on startup, then starts. PostgreSQL data persists in the `postgres_data` volume. Stop the services with `Ctrl+C`; use `docker compose down` to remove the containers while keeping the database volume, or `docker compose down -v` to remove the database data too.

For a different setup, provide `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` in the environment or a Compose env file. The publishable key is embedded in the frontend image at build time, so rebuild after changing it.

## Run on a new machine

Install Node.js, npm, and PostgreSQL. Create a local database and login, for example from `psql` as a PostgreSQL administrator:

```sql
CREATE USER project_app WITH PASSWORD 'set-a-local-password';
CREATE DATABASE project_mgmt OWNER project_app;
```

Copy `server/server/.env.local.example` to `server/server/.env.local` and set its `DATABASE_URL` to match your local PostgreSQL host, port, username, password, and database. The example uses PostgreSQL's default port `5432`. The existing development setup on the original machine uses port `55432`.

From the project root, run `npx -y clerk@latest init` to create a signed-out Clerk development application and configure sign-in. Run `npx -y clerk@latest doctor` to inspect the setup. Keep the generated root `.env.local` private; the local API reads the Clerk secret from it without logging it.

Install and start the API in one terminal:

```powershell
cd server/server
npm ci
npm run db:local:push
npm run dev:local
```

Start the web app from the project root in another terminal:

```powershell
npm ci
npm run dev
```

Open `http://localhost:3000`, create or sign in to a Clerk account, and start with your personal workspace. The API listens on `http://localhost:3001`.

The local helper reads `DATABASE_URL` from `server/server/.env.local` and the development Clerk secret from the root `.env.local`. Keep both private; they are ignored by Git. In production, configure `CLERK_SECRET_KEY`, `DATABASE_URL`, and the web origin allowlist (`WEB_ORIGINS`) in the API environment. Configure the Clerk publishable key in the Next.js environment.

## Workspace access

Clerk provides sign-in, sign-up, and the account menu. The API validates Clerk session tokens, synchronizes verified account profiles to PostgreSQL, and scopes workspace permissions to the authenticated user. New accounts receive a personal workspace. Admins can email workspace invitations, select a role, revoke pending invitations, change member roles, and remove members. An invited user joins the workspace after completing sign-up with the invited verified email. Task assignments use workspace members; Viewers have read-only access.

An accountless Clerk development application is configured for local use and can be claimed later with the Clerk CLI. Existing synthetic `local_` member profiles are linked to a verified Clerk account the first time that same email signs in. The old seeded demo workspace is not automatically reassigned to a new account.

## Database migrations

For a fresh standalone PostgreSQL development database, `npm run db:local:push` applies the Prisma schema, including `WorkspaceInvitation`. The `20261103010000_workspace_rls` migration is specific to Supabase and Clerk JWT integration; do not apply it to vanilla PostgreSQL. For Supabase, review `server/server/prisma/README.md` and configure Clerk third-party auth before applying the RLS migration.

## Build

Build the web app with `npm run build` from the project root. Build or type-check the API from `server/server` with `npm run typecheck`.
