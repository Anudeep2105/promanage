-- Workspace boundary helpers. SECURITY DEFINER avoids recursive RLS checks
-- when a policy needs to inspect WorkspaceMember.
CREATE OR REPLACE FUNCTION public.has_workspace_role(_workspace_id text, _roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."WorkspaceMember" wm
    WHERE wm."workspaceId" = _workspace_id
      AND wm."userId" = ((select auth.jwt()) ->> 'sub')
      AND wm."role"::text = ANY(_roles)
  ) OR (
    'ADMIN' = ANY(_roles)
    AND EXISTS (
      SELECT 1 FROM public."Workspace" ws
      WHERE ws.id = _workspace_id AND ws."ownerId" = ((select auth.jwt()) ->> 'sub')
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.owns_workspace(_workspace_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."Workspace" ws
    WHERE ws.id = _workspace_id
      AND ws."ownerId" = ((select auth.jwt()) ->> 'sub')
  );
$$;

CREATE OR REPLACE FUNCTION public.has_project_role(_project_id text, _roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."Project" p
    JOIN public."WorkspaceMember" wm ON wm."workspaceId" = p."workspaceId"
    WHERE p.id = _project_id
      AND (
        (wm."userId" = ((select auth.jwt()) ->> 'sub') AND wm."role"::text = ANY(_roles))
        OR ('ADMIN' = ANY(_roles) AND EXISTS (
          SELECT 1 FROM public."Workspace" ws
          WHERE ws.id = p."workspaceId" AND ws."ownerId" = ((select auth.jwt()) ->> 'sub')
        ))
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.has_task_role(_task_id text, _roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."Task" t
    JOIN public."Project" p ON p.id = t."projectId"
    JOIN public."WorkspaceMember" wm ON wm."workspaceId" = p."workspaceId"
    WHERE t.id = _task_id
      AND (
        (wm."userId" = ((select auth.jwt()) ->> 'sub') AND wm."role"::text = ANY(_roles))
        OR ('ADMIN' = ANY(_roles) AND EXISTS (
          SELECT 1 FROM public."Workspace" ws
          WHERE ws.id = p."workspaceId" AND ws."ownerId" = ((select auth.jwt()) ->> 'sub')
        ))
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.can_view_user(_target_user_id text)
RETURNS boolean
LANGUAGE sql
 STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."WorkspaceMember" viewer
    JOIN public."WorkspaceMember" peer ON peer."workspaceId" = viewer."workspaceId"
    WHERE viewer."userId" = ((select auth.jwt()) ->> 'sub')
      AND peer."userId" = _target_user_id
  );
$$;

REVOKE ALL ON FUNCTION public.has_workspace_role(text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.owns_workspace(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_project_role(text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_task_role(text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_view_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_workspace_role(text, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.owns_workspace(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_project_role(text, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_task_role(text, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_view_user(text) TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;

GRANT SELECT ON public."User" TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public."Workspace" TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public."WorkspaceMember" TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public."Project" TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public."Sprint" TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public."Task" TO authenticated;
GRANT SELECT, INSERT, DELETE ON public."TaskDependency" TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public."Comment" TO authenticated;
GRANT SELECT, INSERT ON public."Activity" TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public."Label" TO authenticated;

ALTER TABLE public."User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Workspace" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."WorkspaceMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Project" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Sprint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."TaskDependency" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Comment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Activity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Label" ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.enforce_task_sprint_project()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW."sprintId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public."Sprint" sprint
    WHERE sprint.id = NEW."sprintId" AND sprint."projectId" = NEW."projectId"
  ) THEN
    RAISE EXCEPTION 'Task sprint must belong to the same project'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Task_sprint_project_check"
  BEFORE INSERT OR UPDATE OF "sprintId", "projectId" ON public."Task"
  FOR EACH ROW EXECUTE FUNCTION public.enforce_task_sprint_project();

CREATE OR REPLACE FUNCTION public.enforce_dependency_project_and_acyclic()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  blocker_project_id text;
  blocked_project_id text;
  exclude_dependency_id text;
  creates_cycle boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    exclude_dependency_id := OLD.id;
  END IF;
  SELECT task."projectId" INTO blocker_project_id
  FROM public."Task" task WHERE task.id = NEW."blockerTaskId";
  SELECT task."projectId" INTO blocked_project_id
  FROM public."Task" task WHERE task.id = NEW."blockedTaskId";

  IF blocker_project_id IS NULL OR blocked_project_id IS NULL THEN
    RAISE EXCEPTION 'Dependency tasks must exist' USING ERRCODE = '23503';
  END IF;
  IF blocker_project_id <> blocked_project_id THEN
    RAISE EXCEPTION 'Dependency tasks must belong to the same project' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(blocker_project_id, 0));
  WITH RECURSIVE reachable(task_id) AS (
    SELECT NEW."blockedTaskId"
    UNION
    SELECT dependency."blockedTaskId"
    FROM public."TaskDependency" dependency
    JOIN reachable ON dependency."blockerTaskId" = reachable.task_id
    WHERE exclude_dependency_id IS NULL OR dependency.id <> exclude_dependency_id
  )
  SELECT EXISTS (SELECT 1 FROM reachable WHERE task_id = NEW."blockerTaskId") INTO creates_cycle;

  IF creates_cycle THEN
    RAISE EXCEPTION 'Task dependency would create a cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_task_sprint_project() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_dependency_project_and_acyclic() FROM PUBLIC;

CREATE TRIGGER "TaskDependency_project_cycle_check"
  BEFORE INSERT OR UPDATE OF "blockerTaskId", "blockedTaskId" ON public."TaskDependency"
  FOR EACH ROW EXECUTE FUNCTION public.enforce_dependency_project_and_acyclic();

CREATE POLICY "user_read_self_or_workspace_peers" ON public."User"
  FOR SELECT TO authenticated
  USING (id = ((select auth.jwt()) ->> 'sub') OR public.can_view_user(id));

CREATE POLICY "workspace_read_member" ON public."Workspace"
  FOR SELECT TO authenticated
  USING (public.has_workspace_role(id, ARRAY['ADMIN','MEMBER','VIEWER']) OR public.owns_workspace(id));
CREATE POLICY "workspace_create_owner" ON public."Workspace"
  FOR INSERT TO authenticated
  WITH CHECK ("ownerId" = ((select auth.jwt()) ->> 'sub'));
CREATE POLICY "workspace_update_admin" ON public."Workspace"
  FOR UPDATE TO authenticated
  USING (public.has_workspace_role(id, ARRAY['ADMIN']) OR public.owns_workspace(id))
  WITH CHECK (public.has_workspace_role(id, ARRAY['ADMIN']) OR public.owns_workspace(id));
CREATE POLICY "workspace_delete_admin" ON public."Workspace"
  FOR DELETE TO authenticated
  USING (public.has_workspace_role(id, ARRAY['ADMIN']) OR public.owns_workspace(id));

CREATE POLICY "membership_read_workspace" ON public."WorkspaceMember"
  FOR SELECT TO authenticated
  USING (public.has_workspace_role("workspaceId", ARRAY['ADMIN','MEMBER','VIEWER']) OR public.owns_workspace("workspaceId"));
CREATE POLICY "membership_add_admin_or_owner" ON public."WorkspaceMember"
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_workspace_role("workspaceId", ARRAY['ADMIN'])
    OR ("userId" = ((select auth.jwt()) ->> 'sub') AND "role" = 'ADMIN' AND public.owns_workspace("workspaceId"))
  );
CREATE POLICY "membership_change_admin" ON public."WorkspaceMember"
  FOR UPDATE TO authenticated
  USING (public.has_workspace_role("workspaceId", ARRAY['ADMIN']) OR public.owns_workspace("workspaceId"))
  WITH CHECK (public.has_workspace_role("workspaceId", ARRAY['ADMIN']) OR public.owns_workspace("workspaceId"));
CREATE POLICY "membership_remove_admin" ON public."WorkspaceMember"
  FOR DELETE TO authenticated
  USING (public.has_workspace_role("workspaceId", ARRAY['ADMIN']) OR public.owns_workspace("workspaceId"));

CREATE POLICY "project_read_member" ON public."Project"
  FOR SELECT TO authenticated
  USING (public.has_workspace_role("workspaceId", ARRAY['ADMIN','MEMBER','VIEWER']));
CREATE POLICY "project_create_admin" ON public."Project"
  FOR INSERT TO authenticated
  WITH CHECK (public.has_workspace_role("workspaceId", ARRAY['ADMIN']));
CREATE POLICY "project_update_admin" ON public."Project"
  FOR UPDATE TO authenticated
  USING (public.has_workspace_role("workspaceId", ARRAY['ADMIN']))
  WITH CHECK (public.has_workspace_role("workspaceId", ARRAY['ADMIN']));
CREATE POLICY "project_delete_admin" ON public."Project"
  FOR DELETE TO authenticated
  USING (public.has_workspace_role("workspaceId", ARRAY['ADMIN']));

CREATE POLICY "sprint_read_member" ON public."Sprint"
  FOR SELECT TO authenticated
  USING (public.has_project_role("projectId", ARRAY['ADMIN','MEMBER','VIEWER']));
CREATE POLICY "sprint_write_member" ON public."Sprint"
  FOR INSERT TO authenticated
  WITH CHECK (public.has_project_role("projectId", ARRAY['ADMIN','MEMBER']));
CREATE POLICY "sprint_update_member" ON public."Sprint"
  FOR UPDATE TO authenticated
  USING (public.has_project_role("projectId", ARRAY['ADMIN','MEMBER']))
  WITH CHECK (public.has_project_role("projectId", ARRAY['ADMIN','MEMBER']));
CREATE POLICY "sprint_delete_admin" ON public."Sprint"
  FOR DELETE TO authenticated
  USING (public.has_project_role("projectId", ARRAY['ADMIN']));

CREATE POLICY "task_read_member" ON public."Task"
  FOR SELECT TO authenticated
  USING (public.has_project_role("projectId", ARRAY['ADMIN','MEMBER','VIEWER']));
CREATE POLICY "task_create_member" ON public."Task"
  FOR INSERT TO authenticated
  WITH CHECK (public.has_project_role("projectId", ARRAY['ADMIN','MEMBER']));
CREATE POLICY "task_update_member" ON public."Task"
  FOR UPDATE TO authenticated
  USING (public.has_project_role("projectId", ARRAY['ADMIN','MEMBER']))
  WITH CHECK (public.has_project_role("projectId", ARRAY['ADMIN','MEMBER']));
CREATE POLICY "task_delete_member" ON public."Task"
  FOR DELETE TO authenticated
  USING (public.has_project_role("projectId", ARRAY['ADMIN','MEMBER']));

CREATE POLICY "dependency_read_member" ON public."TaskDependency"
  FOR SELECT TO authenticated
  USING (public.has_task_role("blockerTaskId", ARRAY['ADMIN','MEMBER','VIEWER']));
CREATE POLICY "dependency_create_member" ON public."TaskDependency"
  FOR INSERT TO authenticated
  WITH CHECK (public.has_task_role("blockerTaskId", ARRAY['ADMIN','MEMBER']) AND public.has_task_role("blockedTaskId", ARRAY['ADMIN','MEMBER']));
CREATE POLICY "dependency_delete_member" ON public."TaskDependency"
  FOR DELETE TO authenticated
  USING (public.has_task_role("blockerTaskId", ARRAY['ADMIN','MEMBER']));

CREATE POLICY "comment_read_member" ON public."Comment"
  FOR SELECT TO authenticated
  USING (public.has_task_role("taskId", ARRAY['ADMIN','MEMBER','VIEWER']));
CREATE POLICY "comment_create_member" ON public."Comment"
  FOR INSERT TO authenticated
  WITH CHECK ("userId" = ((select auth.jwt()) ->> 'sub') AND public.has_task_role("taskId", ARRAY['ADMIN','MEMBER']));
CREATE POLICY "comment_update_author" ON public."Comment"
  FOR UPDATE TO authenticated
  USING ("userId" = ((select auth.jwt()) ->> 'sub') AND public.has_task_role("taskId", ARRAY['ADMIN','MEMBER']))
  WITH CHECK ("userId" = ((select auth.jwt()) ->> 'sub') AND public.has_task_role("taskId", ARRAY['ADMIN','MEMBER']));
CREATE POLICY "comment_delete_author_or_admin" ON public."Comment"
  FOR DELETE TO authenticated
  USING (("userId" = ((select auth.jwt()) ->> 'sub') AND public.has_task_role("taskId", ARRAY['ADMIN','MEMBER'])) OR public.has_task_role("taskId", ARRAY['ADMIN']));

CREATE POLICY "activity_read_member" ON public."Activity"
  FOR SELECT TO authenticated
  USING (public.has_project_role("projectId", ARRAY['ADMIN','MEMBER','VIEWER']));
CREATE POLICY "activity_create_member" ON public."Activity"
  FOR INSERT TO authenticated
  WITH CHECK ("actorId" = ((select auth.jwt()) ->> 'sub') AND public.has_project_role("projectId", ARRAY['ADMIN','MEMBER']));

CREATE POLICY "label_read_member" ON public."Label"
  FOR SELECT TO authenticated
  USING (public.has_project_role("projectId", ARRAY['ADMIN','MEMBER','VIEWER']));
CREATE POLICY "label_create_member" ON public."Label"
  FOR INSERT TO authenticated
  WITH CHECK (public.has_project_role("projectId", ARRAY['ADMIN','MEMBER']));
CREATE POLICY "label_update_member" ON public."Label"
  FOR UPDATE TO authenticated
  USING (public.has_project_role("projectId", ARRAY['ADMIN','MEMBER']))
  WITH CHECK (public.has_project_role("projectId", ARRAY['ADMIN','MEMBER']));
CREATE POLICY "label_delete_admin" ON public."Label"
  FOR DELETE TO authenticated
  USING (public.has_project_role("projectId", ARRAY['ADMIN']));
