# PostgreSQL schema

Apply the migrations in timestamp order:

1. `20261103000000_initial_schema` creates the application tables, enums, foreign keys, and query indexes.
2. `20261103010000_workspace_rls` enables workspace scoped row security, role policies, and task/dependency integrity triggers.
3. `20261111010000_workspace_invitations` adds pending workspace invitations linked to Clerk invitation emails.

The first migration is a full initial schema for an empty database. If the target database already contains application tables, reconcile its schema and migration history before applying it; do not run it as an incremental migration.

The row policies expect Clerk session JWTs to be configured as a Supabase third party auth provider, with `sub` set to the Clerk user ID and `role` set to `authenticated`. The Hono API independently verifies Clerk bearer tokens using `CLERK_SECRET_KEY` before workspace-scoped database access. Keep that key server side; database RLS remains valuable defense in depth for privileged database connections.

## Local PostgreSQL

The development database runs on PostgreSQL 17 at `127.0.0.1:55432` in the ignored `.local-postgres` directory. Its connection string is kept in the ignored `.env.local` file; the hosted Supabase URL remains in `.env` and is not changed.

- Start the API against the local database with `npm run dev:local`.
- Push Prisma schema changes to this local development database with `npm run db:local:push`.
- The invitation migration is additive and can be applied to an existing app database; do not rerun the initial schema migration against an existing database.
- The local API role owns its database and is restricted to the loopback interface. The `workspace_rls` migration is Supabase specific and is not applied to the standalone local cluster.
