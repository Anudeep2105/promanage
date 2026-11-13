import { serve } from '@hono/node-server';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { Prisma } from '@prisma/client';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import prisma from './db';

type ApiEnv = { Variables: { userId: string } };
const app = new Hono<ApiEnv>();
const statuses = ['Todo', 'In progress', 'In review', 'Done'];
const priorities = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const userRoles = ['ADMIN', 'MEMBER', 'VIEWER'] as const;
const authorizedParties = [...new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  ...(process.env.WEB_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
])];
app.use('/api/*', cors({
  origin: authorizedParties,
  credentials: true,
  allowHeaders: ['Authorization', 'Content-Type'],
}));

const clerkSecretKey = process.env.CLERK_SECRET_KEY;
const clerkClient = clerkSecretKey ? createClerkClient({ secretKey: clerkSecretKey }) : null;
const profileCache = new Map<string, { email: string; name: string; avatarUrl: string | null; workspaceInvitationId: string | null; expiresAt: number }>();

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health') return next();
  if (!clerkSecretKey || !clerkClient) return c.json({ error: 'Authentication is not configured on the API' }, 503);

  const authorization = c.req.header('Authorization');
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const cookie = c.req.header('Cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith('__session='))?.slice('__session='.length);
  const token = bearer ?? (cookie ? decodeURIComponent(cookie) : undefined);
  if (!token) return c.json({ error: 'Sign in is required' }, 401);

  try {
    const claims = await verifyToken(token, {
      secretKey: clerkSecretKey,
      authorizedParties,
    });
    let profile = profileCache.get(claims.sub);
    if (!profile || profile.expiresAt < Date.now()) {
      const clerkUser = await clerkClient.users.getUser(claims.sub);
      const primaryEmail = clerkUser.emailAddresses.find((email) => email.id === clerkUser.primaryEmailAddressId);
      if (!primaryEmail || primaryEmail.verification?.status !== 'verified') {
        return c.json({ error: 'A verified email address is required' }, 403);
      }
      profile = {
        email: primaryEmail.emailAddress.toLowerCase(),
        name: [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || primaryEmail.emailAddress,
        avatarUrl: clerkUser.imageUrl || null,
        workspaceInvitationId: typeof clerkUser.publicMetadata.workspaceInvitationId === 'string' ? clerkUser.publicMetadata.workspaceInvitationId : null,
        expiresAt: Date.now() + 5 * 60_000,
      };
      profileCache.set(claims.sub, profile);
    }

    const existingEmailUser = await prisma.user.findUnique({ where: { email: profile.email } });
    let user;
    if (existingEmailUser && existingEmailUser.id !== claims.sub && existingEmailUser.id.startsWith('local_')) {
      user = await prisma.$transaction(async (tx) => {
        const migratedUser = await tx.user.update({
          where: { id: existingEmailUser.id },
          data: { id: claims.sub, email: profile.email, name: profile.name, avatarUrl: profile.avatarUrl },
        });
        await tx.workspace.updateMany({ where: { ownerId: existingEmailUser.id }, data: { ownerId: claims.sub } });
        return migratedUser;
      });
    } else if (existingEmailUser && existingEmailUser.id !== claims.sub) {
      return c.json({ error: 'This email is already linked to another application profile' }, 409);
    } else {
      user = await prisma.user.upsert({
        where: { id: claims.sub },
        update: { email: profile.email, name: profile.name, avatarUrl: profile.avatarUrl },
        create: { id: claims.sub, email: profile.email, name: profile.name, avatarUrl: profile.avatarUrl },
      });
    }
    if (profile.workspaceInvitationId) {
      const invitation = await prisma.workspaceInvitation.findUnique({ where: { id: profile.workspaceInvitationId } });
      if (invitation?.status === 'PENDING' && invitation.email === profile.email) {
        await prisma.$transaction([
          prisma.workspaceMember.upsert({
            where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId: user.id } },
            update: { role: invitation.role },
            create: { workspaceId: invitation.workspaceId, userId: user.id, role: invitation.role },
          }),
          prisma.workspaceInvitation.update({ where: { id: invitation.id }, data: { status: 'ACCEPTED' } }),
        ]);
      }
    }
    const membership = await prisma.workspaceMember.findFirst({ where: { userId: user.id }, select: { workspaceId: true } });
    if (!membership) {
      const workspaceName = `${profile.name.split(' ')[0] || 'My'} workspace`;
      const slug = `personal-${user.id.replace(/[^a-zA-Z0-9-]/g, '-')}`;
      await prisma.workspace.upsert({
        where: { slug },
        update: {},
        create: {
          name: workspaceName,
          slug,
          ownerId: user.id,
          members: { create: { userId: user.id, role: 'ADMIN' } },
        },
      });
    }
    c.set('userId', user.id);
    return next();
  } catch (error) {
    console.warn('Clerk session validation failed', error instanceof Error ? error.message : 'Unknown error');
    return c.json({ error: 'Your sign-in session is invalid or expired' }, 401);
  }
});

type EventSubscriber = { projectId: string; send: (message: string) => void };
const eventSubscribers = new Set<EventSubscriber>();

function publishProjectEvent(projectId: string, type: string) {
  const message = JSON.stringify({ projectId, type, occurredAt: new Date().toISOString() });
  for (const subscriber of eventSubscribers) {
    if (subscriber.projectId === projectId) subscriber.send(`data: ${message}\n\n`);
  }
}

app.get('/api/events', (c) => {
  const projectId = c.req.query('projectId');
  if (!projectId) return c.json({ error: 'projectId is required' }, 400);
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let subscriber: EventSubscriber | undefined;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (message: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(message)); } catch { cleanup(); }
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (subscriber) eventSubscribers.delete(subscriber);
      };
      subscriber = { projectId, send: enqueue };
      eventSubscribers.add(subscriber);
      enqueue(': connected\n\n');
      heartbeat = setInterval(() => enqueue(': heartbeat\n\n'), 20000);
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (subscriber) eventSubscribers.delete(subscriber);
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
});

type TaskRecord = {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  order: number;
  dueDate: Date | null;
  startDate: Date | null;
  sprintId: string | null;
  assignee: { id: string; name: string | null } | null;
};

function serializeTask(task: TaskRecord) {
  const initials = task.assignee?.name?.split(' ').map((part) => part[0]).join('') ?? 'UN';
  const colors: Record<string, string> = { demo_maya: 'coral', demo_noah: 'blue', demo_ava: 'lilac', demo_ethan: 'mint' };
  const due = task.dueDate
    ? task.dueDate.toISOString().slice(0, 10) === '2026-11-03'
      ? 'Today'
      : task.dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    : '';

  return {
    id: task.id,
    key: /^ORB-\d+$/.test(task.id) ? task.id : `ORB-${task.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`,
    projectId: task.projectId,
    title: task.title,
    project: 'Orbit website',
    status: task.status,
    priority: task.priority.toLowerCase().replace(/^./, (letter) => letter.toUpperCase()),
    assignee: task.assignee?.name ?? 'Unassigned',
    assigneeId: task.assignee?.id ?? '',
    initials,
    color: task.assignee ? colors[task.assignee.id] ?? 'blue' : 'blue',
    due,
    dueDate: task.dueDate?.toISOString() ?? null,
    startDate: task.startDate?.toISOString() ?? null,
    sprintId: task.sprintId,
    tag: task.description ?? undefined,
    order: task.order,
  };
}

async function workspaceRole(workspaceId: string, userId: string) {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  return membership?.role ?? null;
}

app.get('/api/health', async (c) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return c.json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Database health check failed', error);
    return c.json({ status: 'degraded', database: 'disconnected', timestamp: new Date().toISOString() }, 503);
  }
});

app.get('/api/projects/:projectId/snapshot', async (c) => {
  const projectId = c.req.param('projectId');
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, workspaceId: true, description: true, methodology: true } });
    if (!project) return c.json({ error: 'Project not found' }, 404);
    if (!await workspaceRole(project.workspaceId, c.get('userId'))) return c.json({ error: 'Workspace access is required' }, 403);
    const [tasks, sprints, dependencies, comments, activity] = await Promise.all([
      prisma.task.findMany({ where: { projectId }, include: { assignee: { select: { id: true, name: true } } }, orderBy: [{ status: 'asc' }, { order: 'asc' }] }),
      prisma.sprint.findMany({ where: { projectId }, orderBy: { startDate: 'asc' } }),
      prisma.taskDependency.findMany({ where: { blocker: { projectId } }, select: { blockerTaskId: true, blockedTaskId: true } }),
      prisma.comment.findMany({ where: { task: { projectId } }, include: { user: { select: { name: true } } }, orderBy: { createdAt: 'desc' } }),
      prisma.activity.findMany({ where: { projectId }, include: { actor: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 80 }),
    ]);
    return c.json({
      project, tasks: tasks.map(serializeTask), sprints, dependencies,
      comments: comments.map((comment) => ({
        id: comment.id, taskId: comment.taskId, author: comment.user.name ?? 'Workspace member',
        initials: comment.user.name?.split(' ').map((part) => part[0]).join('') ?? 'WM',
        content: comment.content, createdAt: comment.createdAt.toISOString(),
      })),
      activity: activity.map((item) => ({
        id: item.id, text: item.actor.name ? `${item.actor.name} ${item.action}` : item.action,
        detail: item.detail, createdAt: item.createdAt.toISOString(), initials: item.actor.name?.split(' ').map((part) => part[0]).join('') ?? 'WM', color: 'profile',
      })),
    });
  } catch (error) {
    console.error('Project snapshot failed', error);
    return c.json({ error: 'Could not load project updates' }, 500);
  }
});

app.get('/api/projects/:projectId/activity', async (c) => {
  try {
    const projectId = c.req.param('projectId');
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
    if (!project) return c.json({ error: 'Project not found' }, 404);
    if (!await workspaceRole(project.workspaceId, c.get('userId'))) return c.json({ error: 'Workspace access is required' }, 403);
    const activity = await prisma.activity.findMany({
      where: { projectId }, include: { actor: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }, take: 80,
    });
    return c.json(activity.map((item) => ({
      id: item.id, text: item.actor.name ? `${item.actor.name} ${item.action}` : item.action,
      detail: item.detail, createdAt: item.createdAt.toISOString(), initials: item.actor.name?.split(' ').map((part) => part[0]).join('') ?? 'WM', color: 'profile',
    })));
  } catch (error) {
    console.error('Activity list failed', error);
    return c.json({ error: 'Could not load project activity' }, 500);
  }
});

app.post('/api/projects/:projectId/activity', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.action !== 'string' || !body.action.trim() || typeof body.detail !== 'string') {
    return c.json({ error: 'An activity action and detail are required' }, 400);
  }
  if (body.action.length > 120 || body.detail.length > 500) return c.json({ error: 'Activity text is too long' }, 400);
  try {
    const projectId = c.req.param('projectId');
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, workspaceId: true } });
    if (!project) return c.json({ error: 'Project not found' }, 404);
    const actorRole = await workspaceRole(project.workspaceId, c.get('userId'));
    if (!actorRole || actorRole === 'VIEWER') return c.json({ error: 'You do not have permission to edit project activity' }, 403);
    const actor = await prisma.user.findUnique({ where: { id: c.get('userId') }, select: { id: true, name: true } });
    if (!actor) return c.json({ error: 'Your account profile could not be loaded' }, 503);
    const item = await prisma.activity.create({
      data: { projectId, actorId: actor.id, action: body.action.trim(), detail: body.detail.trim() },
      include: { actor: { select: { name: true } } },
    });
    publishProjectEvent(projectId, 'activity.created');
    return c.json({
      id: item.id, text: item.actor.name ? `${item.actor.name} ${item.action}` : item.action,
      detail: item.detail, createdAt: item.createdAt.toISOString(), initials: actor.name?.split(' ').map((part) => part[0]).join('') ?? 'WM', color: 'profile',
    }, 201);
  } catch (error) {
    console.error('Activity creation failed', error);
    return c.json({ error: 'Could not record project activity' }, 500);
  }
});

app.get('/api/tasks/:taskId/comments', async (c) => {
  try {
    const taskId = c.req.param('taskId');
    const task = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true, projectId: true, project: { select: { workspaceId: true } } } });
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (!await workspaceRole(task.project.workspaceId, c.get('userId'))) return c.json({ error: 'Workspace access is required' }, 403);
    const comments = await prisma.comment.findMany({
      where: { taskId }, include: { user: { select: { name: true } } }, orderBy: { createdAt: 'desc' },
    });
    return c.json(comments.map((comment) => ({
      id: comment.id, taskId: comment.taskId, author: comment.user.name ?? 'Workspace member',
      initials: comment.user.name?.split(' ').map((part) => part[0]).join('') ?? 'WM',
      content: comment.content, createdAt: comment.createdAt.toISOString(),
    })));
  } catch (error) {
    console.error('Comment list failed', error);
    return c.json({ error: 'Could not load comments' }, 500);
  }
});

app.post('/api/tasks/:taskId/comments', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.content !== 'string' || !body.content.trim()) return c.json({ error: 'Comment text is required' }, 400);
  if (body.content.trim().length > 2000) return c.json({ error: 'Comments must be 2000 characters or fewer' }, 400);
  try {
    const taskId = c.req.param('taskId');
    const task = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true, projectId: true, project: { select: { workspaceId: true } } } });
    if (!task) return c.json({ error: 'Task not found' }, 404);
    const actorRole = await workspaceRole(task.project.workspaceId, c.get('userId'));
    if (!actorRole || actorRole === 'VIEWER') return c.json({ error: 'You do not have permission to comment in this workspace' }, 403);
    const user = await prisma.user.findUnique({ where: { id: c.get('userId') }, select: { id: true, name: true } });
    if (!user) return c.json({ error: 'Your account profile could not be loaded' }, 503);
    const comment = await prisma.comment.create({
      data: { taskId, userId: user.id, content: body.content.trim() },
      include: { user: { select: { name: true } } },
    });
    publishProjectEvent(task.projectId, 'comment.created');
    return c.json({
      id: comment.id, taskId: comment.taskId, author: comment.user.name ?? 'Workspace member',
      initials: comment.user.name?.split(' ').map((part) => part[0]).join('') ?? 'WM',
      content: comment.content, createdAt: comment.createdAt.toISOString(),
    }, 201);
  } catch (error) {
    console.error('Comment creation failed', error);
    return c.json({ error: 'Could not save comment' }, 500);
  }
});

app.get('/api/projects/:projectId/tasks', async (c) => {
  const { projectId } = c.req.param();
  const priority = c.req.query('priority')?.toUpperCase();
  const assigneeId = c.req.query('assigneeId');
  const status = c.req.query('status');
  if (priority && !priorities.includes(priority)) return c.json({ error: 'Invalid priority filter' }, 400);
  if (status && !statuses.includes(status)) return c.json({ error: 'Invalid status filter' }, 400);

  try {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
    if (!project) return c.json({ error: 'Project not found' }, 404);
    if (!await workspaceRole(project.workspaceId, c.get('userId'))) return c.json({ error: 'Workspace access is required' }, 403);
    const tasks = await prisma.task.findMany({
      where: {
        projectId,
        ...(priority ? { priority: priority as 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT' } : {}),
        ...(assigneeId ? { assigneeId } : {}),
        ...(status ? { status } : {}),
      },
      include: { assignee: { select: { id: true, name: true } } },
      orderBy: [{ status: 'asc' }, { order: 'asc' }],
    });
    return c.json(tasks.map(serializeTask));
  } catch (error) {
    console.error('Task list failed', error);
    return c.json({ error: 'Could not load tasks' }, 500);
  }
});

app.post('/api/tasks', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.projectId !== 'string' || typeof body.title !== 'string' || !body.title.trim()) {
    return c.json({ error: 'projectId and a non-empty title are required' }, 400);
  }
  if (body.status !== undefined && !statuses.includes(body.status)) return c.json({ error: 'Invalid task status' }, 400);
  const priority = typeof body.priority === 'string' ? body.priority.toUpperCase() : 'MEDIUM';
  if (!priorities.includes(priority)) return c.json({ error: 'Invalid task priority' }, 400);
  if (body.dueDate !== undefined && body.dueDate !== null
    && (typeof body.dueDate !== 'string' || Number.isNaN(Date.parse(body.dueDate)))) {
    return c.json({ error: 'Invalid due date' }, 400);
  }
  if (body.startDate !== undefined && body.startDate !== null
    && (typeof body.startDate !== 'string' || Number.isNaN(Date.parse(body.startDate)))) {
    return c.json({ error: 'Invalid start date' }, 400);
  }

  try {
    const project = await prisma.project.findUnique({ where: { id: body.projectId }, select: { id: true, workspaceId: true } });
    if (!project) return c.json({ error: 'Project not found' }, 404);
    const actorRole = await workspaceRole(project.workspaceId, c.get('userId'));
    if (!actorRole || actorRole === 'VIEWER') return c.json({ error: 'You do not have permission to edit tasks in this workspace' }, 403);
    const reporter = await prisma.user.findUnique({ where: { id: c.get('userId') }, select: { id: true } });
    if (!reporter) return c.json({ error: 'Your account profile could not be loaded' }, 503);
    const assigneeId = typeof body.assigneeId === 'string' && body.assigneeId ? body.assigneeId : null;
    if (assigneeId && !await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: project.workspaceId, userId: assigneeId } }, select: { userId: true },
    })) {
      return c.json({ error: 'Assignee must be a member of this workspace' }, 400);
    }
    const sprintId = typeof body.sprintId === 'string' && body.sprintId ? body.sprintId : null;
    if (sprintId && !await prisma.sprint.findFirst({ where: { id: sprintId, projectId: project.id }, select: { id: true } })) {
      return c.json({ error: 'Sprint not found in this project' }, 400);
    }
    const status = typeof body.status === 'string' ? body.status : 'Todo';
    const lastTask = await prisma.task.findFirst({ where: { projectId: project.id, status }, orderBy: { order: 'desc' }, select: { order: true } });
    const task = await prisma.task.create({
      data: {
        projectId: project.id,
        title: body.title.trim().slice(0, 240),
        description: typeof body.description === 'string' ? body.description.trim().slice(0, 2000) || null : null,
        priority: priority as 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT',
        status,
        assigneeId,
        reporterId: reporter.id,
        dueDate: typeof body.dueDate === 'string' && body.dueDate ? new Date(body.dueDate) : null,
        startDate: typeof body.startDate === 'string' && body.startDate ? new Date(body.startDate) : null,
        sprintId,
        order: (lastTask?.order ?? -1) + 1,
      },
      include: { assignee: { select: { id: true, name: true } } },
    });
    publishProjectEvent(project.id, 'task.created');
    return c.json(serializeTask(task), 201);
  } catch (error) {
    console.error('Task creation failed', error);
    return c.json({ error: 'Could not create task' }, 500);
  }
});

app.patch('/api/tasks/:taskId', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'A task update is required' }, 400);
  const data: Record<string, unknown> = {};
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim()) return c.json({ error: 'Task title cannot be empty' }, 400);
    data.title = body.title.trim().slice(0, 240);
  }
  if (body.status !== undefined) {
    if (typeof body.status !== 'string' || !statuses.includes(body.status)) return c.json({ error: 'Invalid task status' }, 400);
    data.status = body.status;
  }
  if (body.priority !== undefined) {
    const priority = typeof body.priority === 'string' ? body.priority.toUpperCase() : '';
    if (!priorities.includes(priority)) return c.json({ error: 'Invalid task priority' }, 400);
    data.priority = priority;
  }
  if (body.assigneeId !== undefined) {
    if (body.assigneeId !== null && typeof body.assigneeId !== 'string') return c.json({ error: 'Invalid assignee' }, 400);
    data.assigneeId = body.assigneeId;
  }
  if (body.dueDate !== undefined) {
    if (body.dueDate !== null && (typeof body.dueDate !== 'string' || Number.isNaN(Date.parse(body.dueDate)))) return c.json({ error: 'Invalid due date' }, 400);
    data.dueDate = body.dueDate ? new Date(body.dueDate) : null;
  }
  if (body.startDate !== undefined) {
    if (body.startDate !== null && (typeof body.startDate !== 'string' || Number.isNaN(Date.parse(body.startDate)))) return c.json({ error: 'Invalid start date' }, 400);
    data.startDate = body.startDate ? new Date(body.startDate) : null;
  }
  if (body.sprintId !== undefined) {
    if (body.sprintId !== null && typeof body.sprintId !== 'string') return c.json({ error: 'Invalid sprint' }, 400);
    data.sprintId = body.sprintId;
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') return c.json({ error: 'Invalid description' }, 400);
    data.description = typeof body.description === 'string' ? body.description.slice(0, 2000) : null;
  }
  if (Object.keys(data).length === 0) return c.json({ error: 'No supported task fields were supplied' }, 400);

  try {
    const existing = await prisma.task.findUnique({ where: { id: c.req.param('taskId') }, select: { id: true, projectId: true, project: { select: { workspaceId: true } } } });
    if (!existing) return c.json({ error: 'Task not found' }, 404);
    const actorRole = await workspaceRole(existing.project.workspaceId, c.get('userId'));
    if (!actorRole || actorRole === 'VIEWER') return c.json({ error: 'You do not have permission to edit tasks in this workspace' }, 403);
    if (typeof data.sprintId === 'string' && !await prisma.sprint.findFirst({
      where: { id: data.sprintId, projectId: existing.projectId }, select: { id: true },
    })) return c.json({ error: 'Sprint not found in this project' }, 400);
    if (typeof data.assigneeId === 'string' && !await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: existing.project.workspaceId, userId: data.assigneeId } }, select: { userId: true },
    })) return c.json({ error: 'Assignee must be a member of this workspace' }, 400);
    const task = await prisma.task.update({
      where: { id: existing.id },
      data,
      include: { assignee: { select: { id: true, name: true } } },
    });
    publishProjectEvent(existing.projectId, 'task.updated');
    return c.json(serializeTask(task));
  } catch (error) {
    console.error('Task update failed', error);
    return c.json({ error: 'Could not update task' }, 500);
  }
});

app.put('/api/tasks/reorder', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.projectId !== 'string' || !Array.isArray(body.tasks) || body.tasks.length > 500) {
    return c.json({ error: 'projectId and a task order list are required' }, 400);
  }
  const valid = body.tasks.every((item: unknown) => {
    if (!item || typeof item !== 'object') return false;
    const task = item as Record<string, unknown>;
    return typeof task.id === 'string' && typeof task.status === 'string' && statuses.includes(task.status)
      && typeof task.order === 'number' && Number.isFinite(task.order);
  });
  if (!valid) return c.json({ error: 'Each task needs an id, valid status, and numeric order' }, 400);
  const ids = body.tasks.map((task: { id: string }) => task.id);
  if (new Set(ids).size !== ids.length) return c.json({ error: 'Duplicate task ids are not allowed' }, 400);

  try {
    const project = await prisma.project.findUnique({ where: { id: body.projectId }, select: { workspaceId: true } });
    if (!project) return c.json({ error: 'Project not found' }, 404);
    const actorRole = await workspaceRole(project.workspaceId, c.get('userId'));
    if (!actorRole || actorRole === 'VIEWER') return c.json({ error: 'You do not have permission to reorder tasks' }, 403);
    const matchingCount = await prisma.task.count({ where: { projectId: body.projectId, id: { in: ids } } });
    if (matchingCount !== ids.length) return c.json({ error: 'One or more tasks do not belong to this project' }, 400);
    await prisma.$transaction(body.tasks.map((task: { id: string; status: string; order: number }) =>
      prisma.task.update({ where: { id: task.id }, data: { status: task.status, order: task.order } }),
    ));
    publishProjectEvent(body.projectId, 'task.reordered');
    return c.json({ updated: ids.length });
  } catch (error) {
    console.error('Task reorder failed', error);
    return c.json({ error: 'Could not save task order' }, 500);
  }
});

app.delete('/api/tasks/:taskId', async (c) => {
  try {
    const taskId = c.req.param('taskId');
    const task = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true, projectId: true, project: { select: { workspaceId: true } } } });
    if (!task) return c.json({ error: 'Task not found' }, 404);
    const actorRole = await workspaceRole(task.project.workspaceId, c.get('userId'));
    if (!actorRole || actorRole === 'VIEWER') return c.json({ error: 'You do not have permission to delete tasks' }, 403);
    await prisma.$transaction([
      prisma.comment.deleteMany({ where: { taskId } }),
      prisma.taskDependency.deleteMany({ where: { OR: [{ blockerTaskId: taskId }, { blockedTaskId: taskId }] } }),
      prisma.task.delete({ where: { id: taskId } }),
    ]);
    publishProjectEvent(task.projectId, 'task.deleted');
    return c.body(null, 204);
  } catch (error) {
    console.error('Task deletion failed', error);
    return c.json({ error: 'Could not delete task' }, 500);
  }
});

app.get('/api/projects/:projectId/sprints', async (c) => {
  try {
    const project = await prisma.project.findUnique({ where: { id: c.req.param('projectId') }, select: { workspaceId: true } });
    if (!project) return c.json({ error: 'Project not found' }, 404);
    if (!await workspaceRole(project.workspaceId, c.get('userId'))) return c.json({ error: 'Workspace access is required' }, 403);
    const sprints = await prisma.sprint.findMany({
      where: { projectId: c.req.param('projectId') },
      include: { _count: { select: { tasks: true } } },
      orderBy: { startDate: 'asc' },
    });
    return c.json(sprints);
  } catch (error) {
    console.error('Sprint list failed', error);
    return c.json({ error: 'Could not load sprints' }, 500);
  }
});

app.post('/api/projects/:projectId/sprints', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.name !== 'string' || !body.name.trim()
    || typeof body.startDate !== 'string' || typeof body.endDate !== 'string'
    || Number.isNaN(Date.parse(body.startDate)) || Number.isNaN(Date.parse(body.endDate))) {
    return c.json({ error: 'A sprint name, start date, and end date are required' }, 400);
  }
  const startDate = new Date(body.startDate);
  const endDate = new Date(body.endDate);
  if (endDate <= startDate) return c.json({ error: 'Sprint end date must be after its start date' }, 400);
  if (typeof body.goal !== 'undefined' && typeof body.goal !== 'string') return c.json({ error: 'Sprint goal must be text' }, 400);

  try {
    const projectId = c.req.param('projectId');
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, workspaceId: true } });
    if (!project) return c.json({ error: 'Project not found' }, 404);
    const actorRole = await workspaceRole(project.workspaceId, c.get('userId'));
    if (!actorRole || actorRole === 'VIEWER') return c.json({ error: 'You do not have permission to manage sprints' }, 403);
    const sprint = await prisma.sprint.create({
      data: {
        projectId,
        name: body.name.trim().slice(0, 100),
        startDate,
        endDate,
        goal: typeof body.goal === 'string' ? body.goal.trim().slice(0, 1000) || null : null,
      },
    });
    publishProjectEvent(projectId, 'sprint.created');
    return c.json(sprint, 201);
  } catch (error) {
    console.error('Sprint creation failed', error);
    return c.json({ error: 'Could not create sprint' }, 500);
  }
});

app.patch('/api/sprints/:sprintId', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !['PLANNED', 'ACTIVE', 'COMPLETED'].includes(body.status)) {
    return c.json({ error: 'Sprint status must be PLANNED, ACTIVE, or COMPLETED' }, 400);
  }
  try {
    const sprint = await prisma.sprint.findUnique({ where: { id: c.req.param('sprintId') }, select: { id: true, projectId: true, project: { select: { workspaceId: true } } } });
    if (!sprint) return c.json({ error: 'Sprint not found' }, 404);
    const actorRole = await workspaceRole(sprint.project.workspaceId, c.get('userId'));
    if (!actorRole || actorRole === 'VIEWER') return c.json({ error: 'You do not have permission to manage sprints' }, 403);
    if (body.status === 'ACTIVE') {
      await prisma.sprint.updateMany({
        where: { projectId: sprint.projectId, status: 'ACTIVE', id: { not: sprint.id } },
        data: { status: 'COMPLETED' },
      });
    }
    const updatedSprint = await prisma.sprint.update({ where: { id: sprint.id }, data: { status: body.status } });
    publishProjectEvent(sprint.projectId, 'sprint.updated');
    return c.json(updatedSprint);
  } catch (error) {
    console.error('Sprint status update failed', error);
    return c.json({ error: 'Could not update sprint status' }, 500);
  }
});

app.get('/api/projects/:projectId/timeline', async (c) => {
  const projectId = c.req.param('projectId');
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
    if (!project) return c.json({ error: 'Project not found' }, 404);
    if (!await workspaceRole(project.workspaceId, c.get('userId'))) return c.json({ error: 'Workspace access is required' }, 403);
    const [tasks, dependencies] = await Promise.all([
      prisma.task.findMany({
        where: { projectId },
        include: { assignee: { select: { id: true, name: true } } },
        orderBy: [{ startDate: 'asc' }, { order: 'asc' }],
      }),
      prisma.taskDependency.findMany({
        where: { blocker: { projectId } },
        select: { id: true, blockerTaskId: true, blockedTaskId: true },
      }),
    ]);
    return c.json({ tasks: tasks.map(serializeTask), dependencies });
  } catch (error) {
    console.error('Timeline load failed', error);
    return c.json({ error: 'Could not load timeline' }, 500);
  }
});

app.post('/api/tasks/dependencies', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.blockerTaskId !== 'string' || typeof body.blockedTaskId !== 'string') {
    return c.json({ error: 'Both task ids are required' }, 400);
  }
  if (body.blockerTaskId === body.blockedTaskId) return c.json({ error: 'A task cannot depend on itself' }, 400);

  try {
    const [blocker, blocked] = await Promise.all([
      prisma.task.findUnique({ where: { id: body.blockerTaskId }, select: { id: true, projectId: true } }),
      prisma.task.findUnique({ where: { id: body.blockedTaskId }, select: { id: true, projectId: true } }),
    ]);
    if (!blocker || !blocked) return c.json({ error: 'Task not found' }, 404);
    if (blocker.projectId !== blocked.projectId) return c.json({ error: 'Dependencies must stay within one project' }, 400);
    const project = await prisma.project.findUnique({ where: { id: blocker.projectId }, select: { workspaceId: true } });
    if (!project) return c.json({ error: 'Project not found' }, 404);
    const actorRole = await workspaceRole(project.workspaceId, c.get('userId'));
    if (!actorRole) return c.json({ error: 'Workspace access is required' }, 403);
    if (actorRole === 'VIEWER') return c.json({ error: 'Viewers cannot change project dependencies' }, 403);

    const edges = await prisma.taskDependency.findMany({
      where: { blocker: { projectId: blocker.projectId } },
      select: { blockerTaskId: true, blockedTaskId: true },
    });
    const outgoing = new Map<string, string[]>();
    for (const edge of edges) outgoing.set(edge.blockerTaskId, [...(outgoing.get(edge.blockerTaskId) ?? []), edge.blockedTaskId]);
    const visited = new Set<string>();
    const stack = [blocked.id];
    while (stack.length) {
      const current = stack.pop()!;
      if (current === blocker.id) return c.json({ error: 'This dependency would create a cycle' }, 409);
      if (visited.has(current)) continue;
      visited.add(current);
      stack.push(...(outgoing.get(current) ?? []));
    }

    const dependency = await prisma.taskDependency.create({
      data: { blockerTaskId: blocker.id, blockedTaskId: blocked.id },
    });
    publishProjectEvent(blocker.projectId, 'dependency.created');
    return c.json(dependency, 201);
  } catch (error) {
    console.error('Dependency creation failed', error);
    return c.json({ error: 'Could not create dependency' }, 409);
  }
});

app.get('/api/workspaces', async (c) => {
  try {
    const workspaces = await prisma.workspace.findMany({
      where: { members: { some: { userId: c.get('userId') } } },
      include: {
        projects: { where: { status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } },
        members: { include: { user: { select: { id: true, name: true, email: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const invitationsByWorkspace = new Map<string, Array<{
      id: string;
      email: string;
      role: (typeof userRoles)[number];
      createdAt: Date;
    }>>();
    if (workspaces.length) {
      try {
        const invitations = await prisma.workspaceInvitation.findMany({
          where: { workspaceId: { in: workspaces.map((workspace) => workspace.id) }, status: 'PENDING' },
          orderBy: { createdAt: 'desc' },
          select: { id: true, workspaceId: true, email: true, role: true, createdAt: true },
        });
        for (const invitation of invitations) {
          invitationsByWorkspace.set(invitation.workspaceId, [...(invitationsByWorkspace.get(invitation.workspaceId) ?? []), {
            id: invitation.id, email: invitation.email, role: invitation.role, createdAt: invitation.createdAt,
          }]);
        }
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2021')) throw error;
      }
    }
    return c.json(workspaces.map((workspace) => ({
      ...workspace,
      members: workspace.members.map((member) => ({ id: member.user.id, name: member.user.name, email: member.user.email, role: member.role })),
      invitations: invitationsByWorkspace.get(workspace.id) ?? [],
    })));
  } catch (error) {
    console.error('Workspace list failed', error);
    return c.json({ error: 'Failed to fetch workspaces' }, 500);
  }
});

app.post('/api/workspaces/:workspaceId/members', async (c) => {
  const workspaceId = c.req.param('workspaceId');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.email !== 'string') {
    return c.json({ error: 'An email address is required' }, 400);
  }
  const email = body.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'Enter a valid email address' }, 400);
  const role = body.role ?? 'MEMBER';
  if (!userRoles.includes(role)) return c.json({ error: 'Choose a valid workspace role' }, 400);
  try {
    if (await workspaceRole(workspaceId, c.get('userId')) !== 'ADMIN') return c.json({ error: 'Only workspace admins can add members' }, 403);
    if (!clerkClient) return c.json({ error: 'Email invitations are not configured' }, 503);
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
    if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
    const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existingUser && await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: existingUser.id } } })) {
      return c.json({ error: 'This user is already a workspace member' }, 409);
    }
    const previousInvitation = await prisma.workspaceInvitation.findUnique({ where: { workspaceId_email: { workspaceId, email } } });
    if (previousInvitation?.status === 'PENDING') return c.json({ error: 'An invitation is already pending for this email address' }, 409);
    const invitation = previousInvitation
      ? await prisma.workspaceInvitation.update({ where: { id: previousInvitation.id }, data: { role, invitedById: c.get('userId'), status: 'PENDING', clerkInvitationId: null } })
      : await prisma.workspaceInvitation.create({ data: { workspaceId, email, role, invitedById: c.get('userId') } });
    try {
      const sent = await clerkClient.invitations.createInvitation({
        emailAddress: email,
        redirectUrl: `${process.env.APP_URL ?? 'http://localhost:3000'}/sign-up`,
        publicMetadata: { workspaceInvitationId: invitation.id },
      });
      const updated = await prisma.workspaceInvitation.update({ where: { id: invitation.id }, data: { clerkInvitationId: sent.id } });
      return c.json({ id: updated.id, email: updated.email, role: updated.role, createdAt: updated.createdAt, status: updated.status }, 201);
    } catch (error) {
      await prisma.workspaceInvitation.update({ where: { id: invitation.id }, data: { status: 'REVOKED' } });
      throw error;
    }
  } catch (error) {
    console.error('Workspace invitation failed', error instanceof Error ? error.message : 'Unknown error');
    return c.json({ error: 'Could not send this invitation. Check Clerk email settings and try again.' }, 502);
  }
});

app.delete('/api/workspaces/:workspaceId/invitations/:invitationId', async (c) => {
  const workspaceId = c.req.param('workspaceId');
  const invitationId = c.req.param('invitationId');
  try {
    if (await workspaceRole(workspaceId, c.get('userId')) !== 'ADMIN') return c.json({ error: 'Only workspace admins can revoke invitations' }, 403);
    const invitation = await prisma.workspaceInvitation.findFirst({ where: { id: invitationId, workspaceId } });
    if (!invitation || invitation.status !== 'PENDING') return c.json({ error: 'Pending invitation not found' }, 404);
    if (!clerkClient || !invitation.clerkInvitationId) return c.json({ error: 'Invitation service is not configured' }, 503);
    await clerkClient.invitations.revokeInvitation(invitation.clerkInvitationId);
    await prisma.workspaceInvitation.update({ where: { id: invitation.id }, data: { status: 'REVOKED' } });
    return c.json({ success: true });
  } catch (error) {
    console.error('Invitation revocation failed', error instanceof Error ? error.message : 'Unknown error');
    return c.json({ error: 'Could not revoke this invitation' }, 502);
  }
});

app.patch('/api/workspaces/:workspaceId/members/:userId', async (c) => {
  const workspaceId = c.req.param('workspaceId');
  const userId = c.req.param('userId');
  const body = await c.req.json().catch(() => null);
  if (!body || !userRoles.includes(body.role)) return c.json({ error: 'Choose a valid workspace role' }, 400);
  try {
    if (await workspaceRole(workspaceId, c.get('userId')) !== 'ADMIN') return c.json({ error: 'Only workspace admins can change roles' }, 403);
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { ownerId: true } });
    if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
    if (userId === workspace.ownerId) return c.json({ error: 'The workspace owner must remain an admin' }, 409);
    const membership = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
    if (!membership) return c.json({ error: 'Workspace member not found' }, 404);
    if (membership.role === 'ADMIN' && body.role !== 'ADMIN'
      && await prisma.workspaceMember.count({ where: { workspaceId, role: 'ADMIN' } }) === 1) {
      return c.json({ error: 'A workspace must keep at least one admin' }, 409);
    }
    const updated = await prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId } }, data: { role: body.role },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    return c.json({ id: updated.user.id, name: updated.user.name, email: updated.user.email, role: updated.role });
  } catch (error) {
    console.error('Workspace role update failed', error);
    return c.json({ error: 'Could not update this workspace role' }, 500);
  }
});

app.delete('/api/workspaces/:workspaceId/members/:userId', async (c) => {
  const workspaceId = c.req.param('workspaceId');
  const userId = c.req.param('userId');
  try {
    if (await workspaceRole(workspaceId, c.get('userId')) !== 'ADMIN') return c.json({ error: 'Only workspace admins can remove members' }, 403);
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { ownerId: true } });
    if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
    if (userId === workspace.ownerId) return c.json({ error: 'The workspace owner cannot be removed' }, 409);
    const membership = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
    if (!membership) return c.json({ error: 'Workspace member not found' }, 404);
    if (membership.role === 'ADMIN' && await prisma.workspaceMember.count({ where: { workspaceId, role: 'ADMIN' } }) === 1) {
      return c.json({ error: 'A workspace must keep at least one admin' }, 409);
    }
    await prisma.$transaction([
      prisma.task.updateMany({ where: { project: { is: { workspaceId } }, assigneeId: userId }, data: { assigneeId: null } }),
      prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId } } }),
    ]);
    return c.json({ success: true });
  } catch (error) {
    console.error('Workspace member removal failed', error);
    return c.json({ error: 'Could not remove this workspace member' }, 500);
  }
});

app.post('/api/projects', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.workspaceId !== 'string' || typeof body.name !== 'string' || !body.name.trim()) {
    return c.json({ error: 'A workspace and project name are required' }, 400);
  }
  if (body.methodology !== undefined && body.methodology !== 'AGILE' && body.methodology !== 'WATERFALL') {
    return c.json({ error: 'Methodology must be AGILE or WATERFALL' }, 400);
  }
  if (body.description !== undefined && typeof body.description !== 'string') {
    return c.json({ error: 'Description must be text' }, 400);
  }
  try {
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: body.workspaceId, userId: c.get('userId') } },
      select: { role: true },
    });
    if (!membership || membership.role === 'VIEWER') return c.json({ error: 'You cannot add projects to this workspace' }, 403);
    const project = await prisma.project.create({
      data: {
        workspaceId: body.workspaceId,
        name: body.name.trim().slice(0, 120),
        description: typeof body.description === 'string' ? body.description.trim().slice(0, 2000) : null,
        methodology: body.methodology === 'WATERFALL' ? 'WATERFALL' : 'AGILE',
      },
    });
    return c.json(project, 201);
  } catch (error) {
    console.error('Project creation failed', error);
    return c.json({ error: 'Could not create project' }, 500);
  }
});

app.post('/api/workspaces', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.name !== 'string' || !body.name.trim() || typeof body.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug)) {
    return c.json({ error: 'A workspace name and valid slug are required' }, 400);
  }
  try {
    const workspace = await prisma.workspace.create({
      data: {
        name: body.name.trim().slice(0, 100),
        slug: body.slug,
        ownerId: c.get('userId'),
        members: { create: { userId: c.get('userId'), role: 'ADMIN' } },
      },
    });
    return c.json(workspace, 201);
  } catch (error) {
    console.error('Workspace creation failed', error);
    return c.json({ error: 'Failed to create workspace' }, 409);
  }
});

serve({ fetch: app.fetch, hostname: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 3001) }, (info) => {
  console.log(`Project API is running on http://localhost:${info.port}`);
});

export default app;
