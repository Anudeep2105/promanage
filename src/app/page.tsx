"use client";

import { FormEvent, ReactNode, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { SignInButton, SignUpButton, UserButton, useAuth, useUser } from "@clerk/nextjs";
import { usePathname, useRouter } from "next/navigation";

type Priority = "Urgent" | "High" | "Medium" | "Low";
type Task = {
  id: string;
  key: string;
  projectId?: string;
  title: string;
  project: string;
  status: string;
  priority: Priority;
  assignee: string;
  assigneeId?: string;
  initials: string;
  color: string;
  due: string;
  dueDate?: string | null;
  startDate?: string | null;
  sprintId?: string | null;
  tag?: string;
};
type ProjectInfo = { id: string; workspaceId: string; name: string; description?: string | null; methodology: "AGILE" | "WATERFALL" };
type WorkspaceMemberInfo = { id: string; name: string | null; email: string; role: "ADMIN" | "MEMBER" | "VIEWER" };
type WorkspaceInvitation = { id: string; email: string; role: "ADMIN" | "MEMBER" | "VIEWER"; createdAt: string };
type WorkspaceInfo = { id: string; name: string; slug: string; projects: ProjectInfo[]; members: WorkspaceMemberInfo[]; invitations: WorkspaceInvitation[] };
type Sprint = { id: string; name: string; startDate: string; endDate: string; goal?: string | null; status: "PLANNED" | "ACTIVE" | "COMPLETED"; _count?: { tasks: number } };
type Dependency = { blockerTaskId: string; blockedTaskId: string };
type TaskComment = { id: string; taskId: string; author: string; initials: string; content: string; createdAt: string };
type ActivityItem = { id: string; text: string; detail: string; createdAt: string; initials: string; color: string };

const columns = ["Todo", "In progress", "In review", "Done"];
const demoToday = new Date("2026-11-03T12:00:00.000Z");
const priorityClass: Record<Priority, string> = { Urgent: "urgent", High: "high", Medium: "medium", Low: "low" };
const apiBase = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"}/api`;
const taskStorageKey = "project-mgmt-orbit-phase3-v1";

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></>,
    inbox: <><path d="M4 4h16v16H4z"/><path d="M4 13h4l2 3h4l2-3h4"/></>,
    check: <><path d="m5 12 4 4L19 6"/></>,
    chart: <><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-5 5"/></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.8-.6a8 8 0 0 1-1.7 1l-.3 1.9h-2.8l-.3-1.9a8 8 0 0 1-1.7-1l-1.8.6-1.4-2.4L7.1 15a8 8 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.8.6a8 8 0 0 1 1.7-1l.3-1.9h2.8l.3 1.9a8 8 0 0 1 1.7 1l1.8-.6 1.4 2.4-1.4 1.1a8 8 0 0 1-.1 2z" transform="translate(-1 -1)"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    chevron: <><path d="m9 18 6-6-6-6"/></>,
    down: <><path d="m7 10 5 5 5-5"/></>,
    dots: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></>,
    filter: <><path d="M4 7h16M7 12h10m-7 5h4"/></>,
    close: <><path d="m18 6-12 12M6 6l12 12"/></>,
    sparkle: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3z"/><path d="m19 14 1 2.5 2.5 1-2.5 1L19 21l-1-2.5-2.5-1 2.5-1L19 14z"/></>,
    more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.grid}</svg>;
}

function Avatar({ initials, color, small = false }: { initials: string; color: string; small?: boolean }) {
  return <span className={`avatar avatar-${color}${small ? " avatar-small" : ""}`} aria-label={initials}>{initials}</span>;
}

function taskTimelineDates(task: Task, index: number) {
  const dueLabels: Record<string, string> = { Today: "2026-11-03" };
  const dueDate = task.dueDate
    ? new Date(task.dueDate)
    : dueLabels[task.due]
      ? new Date(`${dueLabels[task.due]}T12:00:00.000Z`)
      : /^\w{3} \d{1,2}$/.test(task.due)
        ? new Date(`${task.due} 2026 UTC`)
        : new Date(Date.UTC(2026, 10, 5 + index));
  const startDate = task.startDate
    ? new Date(task.startDate)
    : new Date(dueDate.getTime() - ((index % 3) + 2) * 86_400_000);
  return { startDate, dueDate };
}

function formatMonthDay(value: Date) {
  return value.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function WorkspaceModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="task-modal" onSubmit={onSubmit}><div className="modal-heading"><div><span className="modal-kicker">WORKSPACE SETTINGS</span><h2>Create a workspace</h2></div><button type="button" className="modal-close" aria-label="Close" onClick={onClose}><Icon name="close"/></button></div><p className="dependency-help">Workspaces keep your projects and teammates together.</p><label className="form-field">Workspace name<input name="name" placeholder="e.g. Product Studio" required autoFocus maxLength={100}/></label><div className="modal-actions"><button type="button" className="cancel-button" onClick={onClose}>Cancel</button><button className="create-button" type="submit"><Icon name="plus" size={16}/> Create workspace</button></div></form></div>;
}

function ProjectModal({ workspaces, selectedWorkspaceId, onClose, onSubmit }: { workspaces: WorkspaceInfo[]; selectedWorkspaceId: string; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="task-modal" onSubmit={onSubmit}><div className="modal-heading"><div><span className="modal-kicker">PROJECT SETUP</span><h2>Create a project</h2></div><button type="button" className="modal-close" aria-label="Close" onClick={onClose}><Icon name="close"/></button></div><label className="form-field">Project name<input name="name" placeholder="e.g. Website refresh" required autoFocus maxLength={120}/></label><label className="form-field">Workspace<select name="workspaceId" defaultValue={selectedWorkspaceId || workspaces[0]?.id} required>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label><label className="form-field">Description<textarea name="description" placeholder="What is this project about?" rows={2} maxLength={2000}/></label><label className="form-field">Methodology<select name="methodology" defaultValue="AGILE"><option value="AGILE">Agile</option><option value="WATERFALL">Waterfall</option></select></label><div className="modal-actions"><button type="button" className="cancel-button" onClick={onClose}>Cancel</button><button className="create-button" type="submit"><Icon name="plus" size={16}/> Create project</button></div></form></div>;
}

function MemberModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="task-modal" onSubmit={onSubmit}><div className="modal-heading"><div><span className="modal-kicker">WORKSPACE ACCESS</span><h2>Invite a teammate</h2></div><button type="button" className="modal-close" aria-label="Close" onClick={onClose}><Icon name="close"/></button></div><p className="dependency-help">We’ll email a secure sign-up link. They’ll join this workspace after creating their account.</p><label className="form-field">Email address<input name="email" type="email" placeholder="alex@example.com" required autoFocus maxLength={254}/></label><label className="form-field">Workspace role<select name="role" defaultValue="MEMBER"><option value="ADMIN">Admin</option><option value="MEMBER">Member</option><option value="VIEWER">Viewer</option></select></label><div className="modal-actions"><button type="button" className="cancel-button" onClick={onClose}>Cancel</button><button className="create-button" type="submit"><Icon name="plus" size={16}/> Send invitation</button></div></form></div>;
}

function TeamMemberList({ members, tasks, canManage, currentUserId, onRoleChange, onRemove }: { members: WorkspaceMemberInfo[]; tasks: Task[]; canManage: boolean; currentUserId: string; onRoleChange: (userId: string, role: WorkspaceMemberInfo["role"]) => void; onRemove: (userId: string) => void }) {
  const colors = ["profile", "coral", "blue", "lilac", "mint"];
  return <div className="team-member-list">{members.map((member, index) => <article key={member.id}><Avatar initials={member.name?.split(" ").map((part) => part[0]).join("") ?? member.email.slice(0, 2).toUpperCase()} color={colors[index % colors.length]}/><div className="member-details"><b>{member.name ?? "Workspace member"}{member.id === currentUserId ? " · You" : ""}</b><small>{member.email}</small><small>{tasks.filter((task) => task.assigneeId === member.id).length} assigned tasks in this project</small></div><select aria-label={`Role for ${member.name ?? member.email}`} value={member.role} disabled={!canManage || member.id === currentUserId} onChange={(event) => onRoleChange(member.id, event.target.value as WorkspaceMemberInfo["role"])}><option value="ADMIN">Admin</option><option value="MEMBER">Member</option><option value="VIEWER">Viewer</option></select>{canManage && member.id !== currentUserId && <button className="member-remove" onClick={() => onRemove(member.id)}>Remove</button>}</article>)}</div>;
}

function createLocalId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function HomeContent() {
  const pathname = usePathname();
  const router = useRouter();
  const { isLoaded, isSignedIn, user } = useUser();
  const { getToken } = useAuth();
  const currentUserId = user?.id ?? "";
  const actorName = user?.fullName || user?.primaryEmailAddress?.emailAddress || "Workspace member";
  const actorInitials = actorName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  const userTaskStorageKey = `${taskStorageKey}:${currentUserId || "signed-out"}`;
  const apiFetch = useCallback(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const token = await getToken();
    if (!token) throw new Error("Sign in is required");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers, credentials: "include" });
  }, [getToken]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [dependencies, setDependencies] = useState<Dependency[]>([]);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [projectId, setProjectId] = useState("");
  const [currentProject, setCurrentProject] = useState<ProjectInfo | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState("");
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [memberModalOpen, setMemberModalOpen] = useState(false);
  const [apiStatus, setApiStatus] = useState<"connecting" | "connected" | "offline">("connecting");
  const [query, setQuery] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("Everyone");
  const [priorityFilter, setPriorityFilter] = useState("All priorities");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [sprintModalOpen, setSprintModalOpen] = useState(false);
  const [dependencyModalOpen, setDependencyModalOpen] = useState(false);
  const [view, setView] = useState<"overview" | "mytasks" | "board" | "backlog" | "timeline" | "team">("board");
  const [timelineOffset, setTimelineOffset] = useState(0);
  const [toast, setToast] = useState("");
  const [activeNav, setActiveNav] = useState("Board");
  const [dragged, setDragged] = useState<string | null>(null);

  useEffect(() => {
    const parts = pathname.split("/").filter(Boolean);
    const section = parts[0] === "project" ? (parts[2] ?? "overview") : parts[0];
    const routeView: Record<string, typeof view> = {
      dashboard: "overview",
      overview: "overview",
      kanban: "board",
      board: "board",
      backlog: "backlog",
      gantt: "timeline",
      timeline: "timeline",
      team: "team",
      tasks: "mytasks",
    };
    if (!section) return;
    const nextView = routeView[section];
    if (nextView) {
      setView(nextView);
      setActiveNav(({ overview: "Overview", mytasks: "My tasks", board: "Board", backlog: "Board", timeline: "Timeline", team: "Team" } as const)[nextView]);
    }
  }, [pathname, workspaces]);

  useEffect(() => {
    if (!isLoaded) return;
    let active = true;
    if (!isSignedIn) {
      setWorkspaces([]);
      setTasks([]);
      setSprints([]);
      setDependencies([]);
      setComments([]);
      setActivity([]);
      setCurrentProject(null);
      setCurrentWorkspaceId("");
      setProjectId("");
      setApiStatus("offline");
      return () => { active = false; };
    }
    setApiStatus("connecting");
    apiFetch(`${apiBase}/workspaces`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Your workspace could not be loaded");
        return response.json() as Promise<WorkspaceInfo[]>;
      })
      .then(async (items) => {
        if (!active) return;
        setWorkspaces(items);
        const workspace = items[0];
        setCurrentWorkspaceId(workspace?.id ?? "");
        const project = workspace?.projects[0];
        setCurrentProject(project ?? null);
        setProjectId(project?.id ?? "");
        setView(project ? "board" : "overview");
        setActiveNav(project ? "Board" : "Overview");
        if (project) {
          const response = await apiFetch(`${apiBase}/projects/${encodeURIComponent(project.id)}/snapshot`);
          if (!response.ok) throw new Error("Your project data could not be loaded");
          const snapshot = await response.json() as { tasks: Task[]; sprints: Sprint[]; dependencies: Dependency[]; comments: TaskComment[]; activity: ActivityItem[] };
          if (!active) return;
          setTasks(snapshot.tasks);
          setSprints(snapshot.sprints);
          setDependencies(snapshot.dependencies);
          setComments(snapshot.comments);
          setActivity(snapshot.activity);
        } else {
          setTasks([]);
          setSprints([]);
          setDependencies([]);
          setComments([]);
          setActivity([]);
        }
        setApiStatus("connected");
      })
      .catch(() => {
        if (active) {
          setWorkspaces([]);
          setTasks([]);
          setSprints([]);
          setDependencies([]);
          setComments([]);
          setActivity([]);
          setApiStatus("offline");
        }
      });
    return () => { active = false; };
  }, [apiFetch, currentUserId, isLoaded, isSignedIn]);

  useEffect(() => {
    if (apiStatus === "connecting") return;
    try {
      if (currentUserId) window.localStorage.setItem(userTaskStorageKey, JSON.stringify({ tasks, sprints, dependencies, comments, activity }));
    } catch {
      console.warn("Task changes could not be saved to local storage");
    }
  }, [tasks, sprints, dependencies, comments, activity, apiStatus, currentUserId, userTaskStorageKey]);

  useEffect(() => {
    const syncFromAnotherTab = (event: StorageEvent) => {
      if (apiStatus !== "offline" || event.key !== userTaskStorageKey || !event.newValue) return;
      try {
        const shared = JSON.parse(event.newValue) as { tasks?: Task[]; sprints?: Sprint[]; dependencies?: Dependency[]; comments?: TaskComment[]; activity?: ActivityItem[] };
        if (Array.isArray(shared.tasks)) setTasks(shared.tasks);
        if (Array.isArray(shared.sprints)) setSprints(shared.sprints);
        if (Array.isArray(shared.dependencies)) setDependencies(shared.dependencies);
        if (Array.isArray(shared.comments)) setComments(shared.comments);
        if (Array.isArray(shared.activity)) setActivity(shared.activity);
      } catch {
        // Ignore incomplete writes and wait for the next storage update.
      }
    };
    window.addEventListener("storage", syncFromAnotherTab);
    return () => window.removeEventListener("storage", syncFromAnotherTab);
  }, [apiStatus, userTaskStorageKey]);

  useEffect(() => {
    if (apiStatus !== "connected" || !projectId) return;
    const events = new EventSource(`${apiBase}/events?projectId=${encodeURIComponent(projectId)}`, { withCredentials: true });
    let active = true;
    events.onmessage = () => {
      apiFetch(`${apiBase}/projects/${encodeURIComponent(projectId)}/snapshot`)
        .then(async (response) => {
          if (!response.ok) throw new Error("Could not refresh project updates");
          return response.json() as Promise<{ tasks: Task[]; sprints: Sprint[]; dependencies: Dependency[]; comments: TaskComment[]; activity: ActivityItem[] }>;
        })
        .then((snapshot) => {
          if (!active) return;
          setTasks(snapshot.tasks);
          setSprints(snapshot.sprints);
          setDependencies(snapshot.dependencies);
          setComments(snapshot.comments);
          setActivity(snapshot.activity);
        })
        .catch((error: unknown) => console.warn("A live project update could not be loaded", error));
    };
    return () => {
      active = false;
      events.close();
    };
  }, [apiFetch, apiStatus, projectId]);

  const filteredTasks = useMemo(() => tasks.filter((task) => {
    const matchesText = `${task.title} ${task.id} ${task.tag ?? ""}`.toLowerCase().includes(query.toLowerCase());
    const matchesAssignee = assigneeFilter === "Everyone" || task.assignee === assigneeFilter;
    const matchesPriority = priorityFilter === "All priorities" || task.priority === priorityFilter;
    return matchesText && matchesAssignee && matchesPriority;
  }), [tasks, query, assigneeFilter, priorityFilter]);
  const activeSprint = sprints.find((sprint) => sprint.status === "ACTIVE") ?? sprints[0];
  const plannedSprints = sprints.filter((sprint) => sprint.status !== "COMPLETED");
  const timelineStart = new Date(Date.UTC(2026, 10, 1 + timelineOffset));
  const timelineWidth = 14 * 48;
  const timelineItems = tasks.map((task, index) => {
    const dates = taskTimelineDates(task, index);
    const startOffset = Math.floor((dates.startDate.getTime() - timelineStart.getTime()) / 86_400_000);
    const endOffset = Math.max(startOffset + 1, Math.ceil((dates.dueDate.getTime() - timelineStart.getTime()) / 86_400_000));
    const left = Math.max(0, startOffset) * 48;
    const right = Math.min(14, endOffset) * 48;
    return { task, index, left, width: Math.max(12, right - Math.max(0, startOffset) * 48), end: left + Math.max(12, right - Math.max(0, startOffset) * 48), start: dates.startDate, due: dates.dueDate, visible: endOffset > 0 && startOffset < 14 };
  }).filter((item) => item.visible);
  const timelineDays = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(timelineStart.getTime() + index * 86_400_000);
    return { date, day: date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }), label: date.getUTCDate() };
  });
  const completedTaskCount = tasks.filter((task) => task.status === "Done").length;
  const progressPercent = tasks.length ? Math.round((completedTaskCount / tasks.length) * 100) : 0;
  const sprintTaskItems = activeSprint ? tasks.filter((task) => task.sprintId === activeSprint.id) : [];
  const sprintDay = activeSprint
    ? Math.max(1, Math.min(14, Math.floor((demoToday.getTime() - new Date(activeSprint.startDate).getTime()) / 86_400_000) + 1))
    : 0;

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  };

  const recordActivity = (text: string, detail: string) => {
    const localItem: ActivityItem = { id: createLocalId("activity"), text, detail, createdAt: new Date().toISOString(), initials: actorInitials, color: "profile" };
    setActivity((items) => [localItem, ...items].slice(0, 80));
    if (apiStatus === "connected" && projectId) {
      apiFetch(`${apiBase}/projects/${encodeURIComponent(projectId)}/activity`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: text.replace(`${actorName} `, ""), detail }),
      }).then(async (response) => {
        if (!response.ok) throw new Error("Activity could not be saved");
        const savedItem = await response.json() as ActivityItem;
        setActivity((items) => [savedItem, ...items.filter((item) => item.id !== localItem.id)].slice(0, 80));
      }).catch(() => setApiStatus("offline"));
    }
  };

  const addComment = () => {
    if (!editingTask || !commentDraft.trim()) return;
    const content = commentDraft.trim();
    setCommentDraft("");
    const localComment: TaskComment = { id: createLocalId("comment"), taskId: editingTask.id, author: actorName, initials: actorInitials, content, createdAt: new Date().toISOString() };
    if (apiStatus === "connected") {
      apiFetch(`${apiBase}/tasks/${encodeURIComponent(editingTask.id)}/comments`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }),
      }).then(async (response) => {
        if (!response.ok) throw new Error("Comment could not be saved");
        const savedComment = await response.json() as TaskComment;
        setComments((items) => [savedComment, ...items]);
      }).catch(() => {
        setApiStatus("offline");
        setComments((items) => [localComment, ...items]);
        showToast("Comment saved on this device");
      });
    } else {
      setComments((items) => [localComment, ...items]);
    }
    recordActivity(`${actorName} commented`, editingTask.key);
  };

  const addTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const assigneeId = String(data.get("assigneeId") ?? "");
    const assigneeMember = workspaceMembers.find((member) => member.id === assigneeId);
    const assignee = assigneeMember?.name ?? assigneeMember?.email ?? "Unassigned";
    const personIndex = assigneeMember ? workspaceMembers.findIndex((member) => member.id === assigneeMember.id) : -1;
    const initials = assigneeMember?.name?.split(" ").map((part) => part[0]).join("") ?? "UN";
    const dueInput = String(data.get("due") ?? "");
    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(dueInput) ? new Date(`${dueInput}T12:00:00.000Z`) : null;
    const startInput = String(data.get("start") ?? "");
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(startInput) ? new Date(`${startInput}T12:00:00.000Z`) : null;
    const dueLabel = dueDate?.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) ?? "No date";
    const nextNumber = Math.max(130, ...tasks.map((task) => Number(task.key.match(/^ORB-(\d+)$/)?.[1] ?? 0))) + 1;
    const newTask: Task = {
      id: `ORB-${nextNumber}`, key: `ORB-${nextNumber}`, projectId, sprintId: activeSprint?.id ?? null,
      startDate: startDate?.toISOString() ?? null, dueDate: dueDate?.toISOString() ?? null,
      title: String(data.get("title")), project: currentProject?.name ?? "", status: String(data.get("status")),
      priority: String(data.get("priority")) as Priority, assignee, initials,
      assigneeId: assigneeMember?.id,
      color: personIndex >= 0 ? ["coral", "blue", "lilac", "mint"][personIndex % 4] : "blue", due: dueLabel,
      tag: String(data.get("tag") || "Product"),
    };
    let savedTask = newTask;
    let persisted = false;
    if (apiStatus === "connected" && projectId) {
      try {
        const response = await apiFetch(`${apiBase}/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId,
            title: newTask.title,
            status: newTask.status,
            priority: newTask.priority,
            assigneeId: newTask.assigneeId,
            dueDate: dueDate?.toISOString() ?? null,
            startDate: startDate?.toISOString() ?? null,
            sprintId: newTask.sprintId,
            description: newTask.tag,
          }),
        });
        if (!response.ok) throw new Error("Task could not be saved");
        savedTask = await response.json();
        persisted = true;
      } catch {
        setApiStatus("offline");
      }
    }
    setTasks((current) => [savedTask, ...current]);
    recordActivity(`${actorName} created a task`, savedTask.key);
    setModalOpen(false);
    showToast(`${savedTask.key} created${persisted ? " and saved" : " on this device"}`);
  };

  const updateTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingTask) return;
    const data = new FormData(event.currentTarget);
    const assigneeId = String(data.get("assigneeId") ?? "");
    const assigneeMember = workspaceMembers.find((member) => member.id === assigneeId);
    const assignee = assigneeMember?.name ?? assigneeMember?.email ?? "Unassigned";
    const dueInput = String(data.get("due") ?? "");
    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(dueInput) ? new Date(`${dueInput}T12:00:00.000Z`) : null;
    const startInput = String(data.get("start") ?? "");
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(startInput) ? new Date(`${startInput}T12:00:00.000Z`) : null;
    const personIndex = assigneeMember ? workspaceMembers.findIndex((member) => member.id === assigneeMember.id) : -1;
    let updatedTask: Task = {
      ...editingTask,
      title: String(data.get("title")).trim(),
      status: String(data.get("status")),
      priority: String(data.get("priority")) as Priority,
      assignee,
      assigneeId: assigneeMember?.id,
      sprintId: String(data.get("sprintId") || "") || null,
      startDate: startDate?.toISOString() ?? null,
      initials: assigneeMember?.name?.split(" ").map((part) => part[0]).join("") ?? "UN",
      color: personIndex >= 0 ? ["coral", "blue", "lilac", "mint"][personIndex % 4] : "blue",
      due: dueDate?.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) ?? "No date",
      tag: String(data.get("tag") || "Product"),
    };
    let persisted = false;
    if (apiStatus === "connected") {
      try {
        const response = await apiFetch(`${apiBase}/tasks/${encodeURIComponent(editingTask.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: updatedTask.title,
            status: updatedTask.status,
            priority: updatedTask.priority,
            assigneeId: updatedTask.assigneeId,
            dueDate: dueDate?.toISOString() ?? null,
            startDate: startDate?.toISOString() ?? null,
            description: updatedTask.tag,
            sprintId: updatedTask.sprintId,
          }),
        });
        if (!response.ok) throw new Error("Task could not be saved");
        updatedTask = await response.json();
        persisted = true;
      } catch {
        setApiStatus("offline");
      }
    }
    setTasks((current) => current.map((task) => task.id === editingTask.id ? updatedTask : task));
    recordActivity(`${actorName} updated a task`, `${updatedTask.key} · ${updatedTask.title}`);
    setEditingTask(null);
    showToast(`${updatedTask.key} updated${persisted ? " and synced" : " on this device"}`);
  };

  const deleteTask = async () => {
    if (!editingTask || !window.confirm(`Delete ${editingTask.key}? This can’t be undone.`)) return;
    if (apiStatus === "connected") {
      try {
        const response = await apiFetch(`${apiBase}/tasks/${encodeURIComponent(editingTask.id)}`, { method: "DELETE" });
        if (!response.ok) throw new Error("Task could not be deleted");
      } catch {
        setApiStatus("offline");
      }
    }
    setTasks((current) => current.filter((task) => task.id !== editingTask.id));
    setComments((current) => current.filter((comment) => comment.taskId !== editingTask.id));
    recordActivity(`${actorName} deleted a task`, editingTask.key);
    setEditingTask(null);
    showToast("Task deleted");
  };

  const createSprint = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const startDate = new Date(`${String(data.get("startDate"))}T00:00:00.000Z`);
    const endDate = new Date(`${String(data.get("endDate"))}T23:59:59.000Z`);
    if (endDate <= startDate) {
      showToast("Sprint end date must be after its start date");
      return;
    }
    const draft: Sprint = {
      id: createLocalId("local-sprint"),
      name: String(data.get("name")).trim(),
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      goal: String(data.get("goal") || "").trim(),
      status: "PLANNED",
    };
    let newSprint = draft;
    if (apiStatus === "connected" && projectId) {
      try {
        const response = await apiFetch(`${apiBase}/projects/${encodeURIComponent(projectId)}/sprints`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: draft.name, startDate: draft.startDate, endDate: draft.endDate, goal: draft.goal }),
        });
        if (!response.ok) throw new Error("Sprint could not be saved");
        newSprint = await response.json();
      } catch {
        setApiStatus("offline");
      }
    }
    setSprints((current) => [...current, newSprint].sort((a, b) => a.startDate.localeCompare(b.startDate)));
    recordActivity(`${actorName} planned a sprint`, newSprint.name);
    setSprintModalOpen(false);
    showToast(`${newSprint.name} added to sprint planning`);
  };

  const changeSprintStatus = async (sprint: Sprint, status: Sprint["status"]) => {
    const previousSprints = sprints;
    const updated = sprints.map((item) => ({
      ...item,
      status: item.id === sprint.id ? status : status === "ACTIVE" && item.status === "ACTIVE" ? "COMPLETED" as const : item.status,
    }));
    setSprints(updated);
    recordActivity(status === "ACTIVE" ? `${actorName} started a sprint` : `${actorName} completed a sprint`, sprint.name);
    if (apiStatus === "connected") {
      try {
        const response = await apiFetch(`${apiBase}/sprints/${encodeURIComponent(sprint.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        if (!response.ok) throw new Error("Sprint status could not be saved");
      } catch {
        setSprints(previousSprints);
        setApiStatus("offline");
        showToast("Could not update the sprint status");
      }
    }
  };

  const createDependency = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const blockerTaskId = String(data.get("blockerTaskId"));
    const blockedTaskId = String(data.get("blockedTaskId"));
    if (blockerTaskId === blockedTaskId) {
      showToast("Choose two different tasks");
      return;
    }
    const outgoing = new Map<string, string[]>();
    for (const dependency of dependencies) outgoing.set(dependency.blockerTaskId, [...(outgoing.get(dependency.blockerTaskId) ?? []), dependency.blockedTaskId]);
    const stack = [blockedTaskId];
    const visited = new Set<string>();
    while (stack.length) {
      const current = stack.pop()!;
      if (current === blockerTaskId) {
        showToast("That dependency would create a cycle");
        return;
      }
      if (visited.has(current)) continue;
      visited.add(current);
      stack.push(...(outgoing.get(current) ?? []));
    }
    if (dependencies.some((item) => item.blockerTaskId === blockerTaskId && item.blockedTaskId === blockedTaskId)) {
      showToast("That dependency already exists");
      return;
    }

    const dependency = { blockerTaskId, blockedTaskId };
    if (apiStatus === "connected") {
      try {
        const response = await apiFetch(`${apiBase}/tasks/dependencies`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(dependency),
        });
        if (!response.ok) throw new Error("Dependency could not be saved");
      } catch {
        setApiStatus("offline");
      }
    }
    setDependencies((current) => [...current, dependency]);
    recordActivity(`${actorName} linked task dependencies`, `${tasks.find((task) => task.id === blockerTaskId)?.key ?? blockerTaskId} blocks ${tasks.find((task) => task.id === blockedTaskId)?.key ?? blockedTaskId}`);
    setDependencyModalOpen(false);
    showToast("Task dependency added");
  };

  const moveTask = (targetStatus: string) => {
    if (!dragged) return;
    const previousTasks = tasks;
    const updatedTasks = tasks.map((task) => task.id === dragged ? { ...task, status: targetStatus } : task);
    setTasks(updatedTasks);
    recordActivity(`${actorName} moved a task`, `${tasks.find((task) => task.id === dragged)?.key ?? dragged} → ${targetStatus}`);
    setDragged(null);
    if (apiStatus === "connected" && projectId) {
      const orderedTasks = columns.flatMap((status) => updatedTasks
        .filter((task) => task.status === status)
        .map((task, order) => ({ id: task.id, status, order })));
      apiFetch(`${apiBase}/tasks/reorder`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, tasks: orderedTasks }),
      }).then((response) => {
        if (!response.ok) throw new Error("Task order could not be saved");
      }).catch(() => {
        setTasks(previousTasks);
        setApiStatus("offline");
        showToast("Could not save the move. The board has been restored.");
      });
    }
  };

  const loadProject = async (workspace: WorkspaceInfo, project: ProjectInfo) => {
    setCurrentWorkspaceId(workspace.id);
    setCurrentProject(project);
    setProjectId(project.id);
    setTasks([]);
    setSprints([]);
    setDependencies([]);
    setComments([]);
    setActivity([]);
    setWorkspaceMenuOpen(false);
    setView("board");
    setActiveNav("Board");
    try {
      const response = await apiFetch(`${apiBase}/projects/${encodeURIComponent(project.id)}/snapshot`);
      if (!response.ok) throw new Error("Could not open this project");
      const snapshot = await response.json() as { project: ProjectInfo; tasks: Task[]; sprints: Sprint[]; dependencies: Dependency[]; comments: TaskComment[]; activity: ActivityItem[] };
      setCurrentProject(snapshot.project);
      setTasks(snapshot.tasks);
      setSprints(snapshot.sprints);
      setDependencies(snapshot.dependencies);
      setComments(snapshot.comments);
      setActivity(snapshot.activity);
    } catch {
      showToast("This project could not be loaded");
    }
  };

  const switchWorkspace = (workspace: WorkspaceInfo) => {
    setWorkspaceMenuOpen(false);
    if (workspace.projects.length) {
      void loadProject(workspace, workspace.projects[0]);
      return;
    }
    setCurrentWorkspaceId(workspace.id);
    setCurrentProject(null);
    setProjectId("");
    setTasks([]);
    setSprints([]);
    setDependencies([]);
    setComments([]);
    setActivity([]);
    setView("overview");
    setActiveNav("Overview");
  };

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !workspaces.length) return;
    const parts = pathname.split("/").filter(Boolean);
    if (parts[0] === "workspaces" && parts[1]) {
      const workspace = workspaces.find((item) => item.id === parts[1]);
      if (workspace && workspace.id !== currentWorkspaceId) switchWorkspace(workspace);
    }
    if (parts[0] === "project" && parts[1]) {
      for (const workspace of workspaces) {
        const project = workspace.projects.find((item) => item.id === parts[1]);
        if (project && project.id !== projectId) {
          setCurrentWorkspaceId(workspace.id);
          void loadProject(workspace, project);
          const routeView = parts[2] === "gantt" || parts[2] === "timeline" ? "timeline"
            : parts[2] === "backlog" ? "backlog"
              : parts[2] === "team" ? "team"
                : parts[2] === "tasks" ? "mytasks"
                  : parts[2] === "overview" || !parts[2] ? "overview" : "board";
          setView(routeView);
          break;
        }
      }
    }
  }, [currentWorkspaceId, isLoaded, isSignedIn, loadProject, pathname, projectId, workspaces]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    const sectionByView = { overview: "overview", mytasks: "tasks", board: "kanban", backlog: "backlog", timeline: "gantt", team: "team" } as const;
    const nextPath = pathname === "/dashboard"
      ? "/dashboard"
      : currentProject
      ? view === "overview"
        ? `/project/${encodeURIComponent(currentProject.id)}`
        : `/project/${encodeURIComponent(currentProject.id)}/${sectionByView[view]}`
      : currentWorkspaceId
        ? `/workspaces/${encodeURIComponent(currentWorkspaceId)}`
        : "/dashboard";
    if (pathname !== nextPath) router.replace(nextPath);
  }, [currentProject, currentWorkspaceId, isLoaded, isSignedIn, pathname, router, view]);

  useEffect(() => {
    const parts = pathname.split("/").filter(Boolean);
    if (parts[0] !== "project" || parts[2] !== "tasks" || !parts[3]) return;
    const task = tasks.find((item) => item.id === parts[3]);
    if (task) setEditingTask(task);
  }, [pathname, tasks]);

  const createWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const name = String(formData.get("name") ?? "").trim();
    const baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "workspace";
    const slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      const response = await apiFetch(`${apiBase}/workspaces`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, slug }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error ?? "Workspace could not be created");
      }
      const workspacesResponse = await apiFetch(`${apiBase}/workspaces`);
      if (!workspacesResponse.ok) throw new Error("Workspace was created, but the list could not be refreshed");
      const items = await workspacesResponse.json() as WorkspaceInfo[];
      setWorkspaces(items);
      const created = items.find((workspace) => workspace.slug === slug);
      if (created) switchWorkspace(created);
      setWorkspaceModalOpen(false);
      showToast("Workspace created. Add a project to get started.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Workspace could not be created");
    }
  };

  const createProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const targetWorkspace = workspaces.find((workspace) => workspace.id === String(formData.get("workspaceId")));
    if (!targetWorkspace) {
      showToast("Choose a workspace first");
      return;
    }
    try {
      const response = await apiFetch(`${apiBase}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: targetWorkspace.id,
          name: String(formData.get("name") ?? ""),
          description: String(formData.get("description") ?? ""),
          methodology: String(formData.get("methodology") ?? "AGILE"),
        }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error ?? "Project could not be created");
      }
      const project = await response.json() as ProjectInfo;
      const updatedWorkspace = { ...targetWorkspace, projects: [...targetWorkspace.projects, project] };
      const updatedWorkspaces = workspaces.map((workspace) => workspace.id === targetWorkspace.id ? updatedWorkspace : workspace);
      setWorkspaces(updatedWorkspaces);
      setProjectModalOpen(false);
      setCurrentWorkspaceId(targetWorkspace.id);
      await loadProject(updatedWorkspace, project);
      showToast("Project created");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Project could not be created");
    }
  };

  const createMember = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!currentWorkspace || currentUserRole !== "ADMIN") return showToast("Only workspace admins can add members");
    const formData = new FormData(event.currentTarget);
    try {
      const response = await apiFetch(`${apiBase}/workspaces/${encodeURIComponent(currentWorkspace.id)}/members`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: String(formData.get("email") ?? ""), role: String(formData.get("role") ?? "MEMBER") }),
      });
      const result = await response.json() as WorkspaceInvitation & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Member could not be added");
      setWorkspaces((items) => items.map((workspace) => workspace.id === currentWorkspace.id ? { ...workspace, invitations: [result, ...workspace.invitations] } : workspace));
      setMemberModalOpen(false);
      showToast(`Invitation sent to ${result.email}`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Member could not be added");
    }
  };

  const changeMemberRole = async (userId: string, role: WorkspaceMemberInfo["role"]) => {
    if (!currentWorkspace || currentUserRole !== "ADMIN") return;
    try {
      const response = await apiFetch(`${apiBase}/workspaces/${encodeURIComponent(currentWorkspace.id)}/members/${encodeURIComponent(userId)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Role could not be changed");
      setWorkspaces((items) => items.map((workspace) => workspace.id === currentWorkspace.id ? { ...workspace, members: workspace.members.map((member) => member.id === userId ? result as WorkspaceMemberInfo : member) } : workspace));
      showToast("Workspace role updated");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Role could not be changed");
    }
  };

  const removeMember = async (userId: string) => {
    if (!currentWorkspace || currentUserRole !== "ADMIN") return;
    try {
      const response = await apiFetch(`${apiBase}/workspaces/${encodeURIComponent(currentWorkspace.id)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Member could not be removed");
      setWorkspaces((items) => items.map((workspace) => workspace.id === currentWorkspace.id ? { ...workspace, members: workspace.members.filter((member) => member.id !== userId) } : workspace));
      setTasks((items) => items.map((task) => task.assigneeId === userId ? { ...task, assignee: "Unassigned", assigneeId: "", initials: "UN", color: "blue" } : task));
      showToast("Member removed and their project tasks unassigned");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Member could not be removed");
    }
  };

  const revokeInvitation = async (invitationId: string) => {
    if (!currentWorkspace || currentUserRole !== "ADMIN") return;
    try {
      const response = await apiFetch(`${apiBase}/workspaces/${encodeURIComponent(currentWorkspace.id)}/invitations/${encodeURIComponent(invitationId)}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Invitation could not be revoked");
      setWorkspaces((items) => items.map((workspace) => workspace.id === currentWorkspace.id ? { ...workspace, invitations: workspace.invitations.filter((invitation) => invitation.id !== invitationId) } : workspace));
      showToast("Invitation revoked");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Invitation could not be revoked");
    }
  };

  const myTaskCount = tasks.filter((task) => task.assigneeId === currentUserId).length;
  const navItems = [
    { label: "Overview", icon: "grid" }, { label: "My tasks", icon: "inbox", count: myTaskCount > 0 ? String(myTaskCount) : undefined },
    { label: "Board", icon: "check" }, { label: "Timeline", icon: "chart" }, { label: "Team", icon: "users" },
  ];
  const currentWorkspace = workspaces.find((workspace) => workspace.id === currentWorkspaceId) ?? null;
  const workspaceMembers = currentWorkspace?.members ?? [];
  const people = workspaceMembers.map((member) => member.name ?? member.email);
  const currentUserRole = workspaceMembers.find((member) => member.id === currentUserId)?.role ?? "VIEWER";

  if (!isLoaded) return <main className="auth-loading">Loading your account…</main>;
  if (!isSignedIn) return <main className="auth-welcome"><div className="auth-welcome-card"><span className="brand-mark"><span/><span/><span/><span/></span><p className="modal-kicker">PROMANAGE WORKSPACE</p><h1>Bring your team’s work together.</h1><p>Plan projects, track tasks, and keep everyone aligned in one place.</p><div className="auth-welcome-actions"><SignInButton mode="modal"><button className="cancel-button">Sign in</button></SignInButton><SignUpButton mode="modal"><button className="create-button">Create account</button></SignUpButton></div><small>Secure sign-in powered by Clerk.</small></div></main>;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><span/><span/><span/><span/></span><span>ProManage</span></div>
        <div className="workspace-picker"><button className="workspace-switch" aria-expanded={workspaceMenuOpen} onClick={() => setWorkspaceMenuOpen((open) => !open)}><span className="workspace-logo">{currentWorkspace?.name.slice(0, 1).toUpperCase() ?? "S"}</span><span className="workspace-copy"><b>{currentWorkspace?.name ?? "Choose workspace"}</b><small>Free workspace</small></span><Icon name="down" size={15}/></button>{workspaceMenuOpen && <div className="workspace-menu">{workspaces.map((workspace) => <button key={workspace.id} onClick={() => switchWorkspace(workspace)}><span>{workspace.name}</span><small>{workspace.projects.length} {workspace.projects.length === 1 ? "project" : "projects"}</small></button>)}<button className="workspace-menu-add" onClick={() => { setWorkspaceMenuOpen(false); setWorkspaceModalOpen(true); }}><Icon name="plus" size={14}/> Create workspace</button></div>}</div>
        <div className="side-label">WORKSPACE <button aria-label="Add workspace" onClick={() => setWorkspaceModalOpen(true)}><Icon name="plus" size={14}/></button></div>
        <nav className="side-nav" aria-label="Workspace navigation">
          {navItems.map((item) => <button key={item.label} className={`nav-link${activeNav === item.label ? " active" : ""}`} aria-current={activeNav === item.label ? "page" : undefined} onClick={() => { setActiveNav(item.label); setView(({ Overview: "overview", "My tasks": "mytasks", Board: "board", Timeline: "timeline", Team: "team" } as const)[item.label as "Overview" | "My tasks" | "Board" | "Timeline" | "Team"]); }}><Icon name={item.icon}/><span>{item.label}</span>{item.count && <small>{item.count}</small>}</button>)}
        </nav>
        <div className="side-label projects-label">YOUR PROJECTS <button aria-label="Add project" onClick={() => setProjectModalOpen(true)}><Icon name="plus" size={14}/></button></div>
        {currentWorkspace?.projects.map((project, index) => <button key={project.id} className={`project-link${currentProject?.id === project.id ? " selected" : ""}`} onClick={() => void loadProject(currentWorkspace, project)}><span className={`project-dot ${["dot-purple", "dot-yellow", "dot-green"][index % 3]}`}/>{project.name}</button>)}
        {!currentWorkspace?.projects.length && <span className="project-empty-label">No projects yet</span>}
        <button className="add-project" onClick={() => setProjectModalOpen(true)}><Icon name="plus" size={16}/> Add a project</button>
        <div className="sidebar-spacer"/>
        <div className="upgrade-card"><span className="upgrade-spark"><Icon name="sparkle" size={17}/></span><b>Make room for big ideas</b><p>Upgrade your workspace for unlimited projects and more.</p><button onClick={() => showToast("Your workspace is on the Free plan")}>Explore plans <Icon name="chevron" size={14}/></button></div>
        <div className="profile"><UserButton/><span><b>{actorName}</b><small>{user?.primaryEmailAddress?.emailAddress}</small></span></div>
      </aside>

      <main className="main-area">
        <header className="topbar"><div className="breadcrumbs"><span>{currentWorkspace?.name ?? "Workspace"}</span><Icon name="chevron" size={14}/><span>Projects</span><Icon name="chevron" size={14}/><b>{currentProject?.name ?? "No project selected"}</b></div><div className="top-actions"><label className="search-box"><Icon name="search" size={17}/><input aria-label="Search tasks" placeholder="Search anything..." value={query} onChange={(event) => setQuery(event.target.value)}/><kbd>⌘ K</kbd></label><button className="icon-button" aria-label="Notifications" onClick={() => showToast("You’re all caught up!")}><span className="notification-dot"/>◌</button><UserButton/></div></header>

        <div className="page-content">
          <section className="project-heading"><div className="heading-copy"><div className="project-eyebrow"><span className="eyebrow-dot"/> {currentProject ? currentProject.methodology === "AGILE" ? "AGILE PROJECT" : "WATERFALL PROJECT" : "WORKSPACE PROJECTS"} <span className="eyebrow-divider">/</span> Q4 2026</div><h1>{currentProject?.name ?? "Select a project"} <button aria-label="Project options" className="heading-more" onClick={() => showToast("Project options")}>⌄</button></h1><p>{currentProject?.description || (currentProject ? "Keep your team aligned and work moving forward." : "Choose a project or create one to get started.")}</p></div><div className="heading-actions"><div className="avatar-stack">{workspaceMembers.slice(0, 4).map((member, index) => <Avatar key={member.id} initials={member.name?.split(" ").map((part) => part[0]).join("") ?? member.email.slice(0, 2).toUpperCase()} color={["coral", "blue", "lilac", "mint"][index % 4]}/>)}{workspaceMembers.length > 4 && <button className="avatar-extra" onClick={() => { setActiveNav("Team"); setView("team"); }}>+{workspaceMembers.length - 4}</button>}</div><button className="share-button" onClick={() => { setActiveNav("Team"); setView("team"); }}><Icon name="users" size={16}/> Team</button><button className="more-button" aria-label="More project actions" onClick={() => showToast("More project actions")}>•••</button></div></section>

          <section className="summary-row" aria-label="Project summary"><div className="summary-card progress-summary"><div className="summary-label">PROJECT PROGRESS <span className="summary-info">i</span></div><div className="progress-line"><strong>{progressPercent}<span>%</span></strong><div className="progress-track"><span style={{ width: `${progressPercent}%` }}/></div><small>{progressPercent >= 50 ? "On track" : "In motion"}</small></div></div><div className="summary-card"><div className="summary-label">TASKS COMPLETED</div><div className="summary-value">{completedTaskCount} <span>of {tasks.length}</span><span className="summary-trend">{tasks.length ? `${Math.round((completedTaskCount / tasks.length) * 100)}%` : "0%"}</span></div><div className="mini-bars"><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/></div></div><div className="summary-card"><div className="summary-label">DUE THIS WEEK</div><div className="summary-value">{tasks.filter((task) => { const date = task.dueDate ? new Date(task.dueDate) : taskTimelineDates(task, 0).dueDate; const days = (date.getTime() - demoToday.getTime()) / 86_400_000; return days >= 0 && days <= 7 && task.status !== "Done"; }).length} <span>tasks</span><span className="due-note"><b/> {tasks.filter((task) => task.due === "Today" && task.status !== "Done").length} due today</span></div><div className="due-dots"><i/><i/><i/><i/><i/><i/><i/><i/></div></div><div className="summary-card sprint-card"><div className="summary-label">CURRENT SPRINT <span className="sprint-status">{activeSprint ? "● ACTIVE" : "— NONE"}</span></div><div className="sprint-name">{activeSprint?.name ?? "No active sprint"} <span>{activeSprint ? `· ${formatMonthDay(new Date(activeSprint.startDate))}–${formatMonthDay(new Date(activeSprint.endDate))}` : ""}</span></div><div className="sprint-foot"><div className="sprint-track"><span style={{ width: `${activeSprint ? Math.min(100, (sprintDay / 14) * 100) : 0}%` }}/></div><small>{activeSprint ? `Day ${sprintDay} of 14 · ${sprintTaskItems.filter((task) => task.status === "Done").length}/${sprintTaskItems.length} done` : "Create a sprint to begin"}</small></div></div></section>

          <section className="board-section"><div className="board-tabs"><div className="tab-list"><button className={`tab-button${view === "overview" ? " tab-current" : ""}`} onClick={() => { setView("overview"); setActiveNav("Overview"); }}>Overview</button><button className={`tab-button${view === "board" ? " tab-current" : ""}`} onClick={() => { setView("board"); setActiveNav("Board"); }}><span className="tab-icon"><Icon name="check" size={15}/></span>Board</button><button className={`tab-button${view === "timeline" ? " tab-current" : ""}`} onClick={() => { setView("timeline"); setActiveNav("Timeline"); }}>Timeline</button><button className={`tab-button${view === "backlog" ? " tab-current" : ""}`} onClick={() => { setView("backlog"); setActiveNav("Board"); }}>Backlog</button><button className="tab-add" aria-label="Add view" onClick={() => showToast("Add a project view")}>+</button></div><button className="board-menu" onClick={() => showToast("Board settings")}>•••</button></div>
            {!currentProject && !["overview", "mytasks", "team"].includes(view) && <div className="navigation-empty no-project-empty"><span><Icon name="plus" size={18}/></span><h3>No project selected</h3><p>Create a project in this workspace to manage its tasks and timeline.</p><button className="create-button" onClick={() => setProjectModalOpen(true)}><Icon name="plus" size={16}/> Create project</button></div>}
            {view === "overview" && <div className="navigation-panel"><div className="navigation-panel-heading"><div><span className="planning-kicker">PROJECT AT A GLANCE</span><h2>{currentProject?.name ?? currentWorkspace?.name ?? "Workspace overview"}</h2><p>{currentProject?.description || (currentProject ? "Keep your team aligned and work moving forward." : "Create a project to organize your team's work.")}</p></div>{currentProject ? <button className="board-add-button" onClick={() => { setView("board"); setActiveNav("Board"); }}>Open board</button> : <button className="board-add-button" onClick={() => setProjectModalOpen(true)}><Icon name="plus" size={16}/> Add project</button>}</div>{currentProject && <><div className="navigation-grid"><article><span>Progress</span><strong>{progressPercent}%</strong><small>{completedTaskCount} of {tasks.length} tasks completed</small></article><article><span>Active sprint</span><strong>{activeSprint?.name ?? "No active sprint"}</strong><small>{activeSprint?.goal ?? "Plan a sprint to organize the work."}</small></article><article><span>Upcoming work</span><strong>{tasks.filter((task) => task.status !== "Done").length} tasks</strong><small>Open tasks across the project</small></article></div><div className="navigation-panel-heading navigation-list-heading"><div><h3>Recently updated work</h3><p>Open a task to see its details and discussion.</p></div><button className="secondary-action" onClick={() => { setView("timeline"); setActiveNav("Timeline"); }}>View timeline</button></div><div className="navigation-task-list">{tasks.slice(0, 5).map((task) => <button key={task.id} onClick={() => setEditingTask(task)}><span className="navigation-task-key">{task.key}</span><b>{task.title}</b><span className={`priority-pill priority-${priorityClass[task.priority]}`}>{task.priority}</span><span className="navigation-task-status">{task.status}</span></button>)}</div></>}</div>}
            {view === "mytasks" && <div className="navigation-panel"><div className="navigation-panel-heading"><div><span className="planning-kicker">PERSONAL WORKSPACE</span><h2>My tasks</h2><p>Tasks currently assigned to {actorName}.</p></div><button className="secondary-action" onClick={() => { setView("board"); setActiveNav("Board"); }}>Browse project board</button></div>{tasks.filter((task) => task.assigneeId === currentUserId).length ? <div className="navigation-task-list">{tasks.filter((task) => task.assigneeId === currentUserId).map((task) => <button key={task.id} onClick={() => setEditingTask(task)}><span className="navigation-task-key">{task.key}</span><b>{task.title}</b><span>{task.status}</span><span>{task.due}</span></button>)}</div> : <div className="navigation-empty"><span>✓</span><h3>No tasks assigned yet</h3><p>When a task is assigned to you, it will show up here.</p><button className="secondary-action" onClick={() => { setView("board"); setActiveNav("Board"); }}>See all project tasks</button></div>}</div>}
            {view === "team" && <div className="navigation-panel"><div className="navigation-panel-heading"><div><span className="planning-kicker">{currentWorkspace?.name.toUpperCase() ?? "WORKSPACE"}</span><h2>Workspace members</h2><p>Invite people, assign tasks, and manage workspace roles.</p></div>{currentUserRole === "ADMIN" && <button className="secondary-action" onClick={() => setMemberModalOpen(true)}><Icon name="plus" size={15}/> Invite member</button>}</div>{workspaceMembers.length ? <TeamMemberList members={workspaceMembers} tasks={tasks} canManage={currentUserRole === "ADMIN"} onRoleChange={changeMemberRole} currentUserId={currentUserId} onRemove={removeMember}/> : <div className="navigation-empty"><span>✦</span><h3>No workspace members</h3><p>Add a member to start collaborating.</p></div>}{currentWorkspace?.invitations.length ? <section className="pending-invitations"><h3>Pending invitations</h3>{currentWorkspace.invitations.map((invitation) => <article key={invitation.id}><span>{invitation.email}<small>{invitation.role.toLowerCase()}</small></span>{currentUserRole === "ADMIN" && <button className="member-remove" onClick={() => void revokeInvitation(invitation.id)}>Revoke</button>}</article>)}</section> : null}<p className="admin-note">Admins can change roles and remove members. Viewers can read project work but cannot edit tasks.</p></div>}
            {view === "board" && currentProject && <>
            <div className="board-toolbar"><div className="board-title"><h2>Product backlog</h2><span className="board-count">{tasks.length}</span><button className="board-title-down" aria-label="Board options"><Icon name="down" size={14}/></button></div><div className="board-tools"><div className="filter-control"><Icon name="filter" size={16}/><select aria-label="Filter by assignee" value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.target.value)}><option>Everyone</option>{people.map((person) => <option key={person}>{person}</option>)}</select></div><div className="filter-control priority-control"><span className="filter-priority-icon">◆</span><select aria-label="Filter by priority" value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}><option>All priorities</option>{["Urgent", "High", "Medium", "Low"].map((value) => <option key={value}>{value}</option>)}</select></div><div className="toolbar-divider"/><div className="toolbar-avatars">{workspaceMembers.slice(0, 4).map((member, index) => <Avatar key={member.id} initials={member.name?.split(" ").map((part) => part[0]).join("") ?? member.email.slice(0, 2).toUpperCase()} color={["coral", "blue", "lilac", "mint"][index % 4]} small/>)}</div><button className="board-add-button" onClick={() => { setEditingTask(null); setModalOpen(true); }}><Icon name="plus" size={16}/> Add task</button><button className="toolbar-more" aria-label="More board actions" onClick={() => showToast("Board actions")}>•••</button></div></div>

            <div className="kanban-board">{columns.map((column) => {
              const columnTasks = filteredTasks.filter((task) => task.status === column);
              return <section key={column} className={`kanban-column column-${column.toLowerCase().replace(" ", "-")}`} onDragOver={(event) => event.preventDefault()} onDrop={() => moveTask(column)}><div className="column-heading"><span className="column-marker"/><h3>{column}</h3><span className="column-count">{columnTasks.length}</span><button className="column-dots" aria-label={`${column} options`} onClick={() => showToast(`${column} options`)}>•••</button><button className="column-plus" aria-label={`Add task to ${column}`} onClick={() => setModalOpen(true)}><Icon name="plus" size={16}/></button></div><div className="task-list">{columnTasks.map((task) => <article key={task.id} className="task-card" draggable onDragStart={() => setDragged(task.id)} onDragEnd={() => setDragged(null)}><div className="task-topline"><span className="task-id">{task.key}</span><button aria-label={`Edit ${task.key}`} className="task-menu" onClick={() => setEditingTask(task)}>•••</button></div><h4>{task.title}</h4><div className="task-tags"><span className={`priority-pill ${priorityClass[task.priority]}`}><i/> {task.priority}</span>{task.tag && <span className="task-tag">{task.tag}</span>}</div><div className="task-bottom"><span className={`due-date${task.due === "Today" ? " due-today" : ""}`}><Icon name="calendar" size={13}/>{task.due}</span><Avatar initials={task.initials} color={task.color} small/></div></article>)}</div><button className="add-card" onClick={() => setModalOpen(true)}><Icon name="plus" size={15}/> Add a task</button></section>;
            })}</div>
            {filteredTasks.length === 0 && <div className="empty-search">No tasks match these filters. <button onClick={() => { setQuery(""); setAssigneeFilter("Everyone"); setPriorityFilter("All priorities"); }}>Clear filters</button></div>}
            </>}
            {view === "backlog" && currentProject && <div className="sprint-planning">
              <div className="planning-toolbar"><div><span className="planning-kicker">AGILE PLANNING</span><h2>Sprint backlog</h2><p>Shape the work your team will take on next.</p></div><div className="planning-actions"><button className="secondary-action" onClick={() => setDependencyModalOpen(true)}>↗ Add dependency</button><button className="board-add-button" onClick={() => setSprintModalOpen(true)}><Icon name="plus" size={16}/> New sprint</button></div></div>
              {plannedSprints.map((sprint) => {
                const sprintTasks = tasks.filter((task) => task.sprintId === sprint.id);
                const completed = sprintTasks.filter((task) => task.status === "Done").length;
                return <section className="sprint-group" key={sprint.id}><div className="sprint-group-heading"><span className={`sprint-pulse${sprint.status === "ACTIVE" ? " active" : ""}`}/><div className="sprint-heading-copy"><h3>{sprint.name}<span className={`sprint-badge${sprint.status === "ACTIVE" ? " active" : ""}`}>{sprint.status === "ACTIVE" ? "ACTIVE" : "PLANNED"}</span></h3><p>{formatMonthDay(new Date(sprint.startDate))} – {formatMonthDay(new Date(sprint.endDate))}{sprint.goal ? ` · ${sprint.goal}` : ""}</p></div><div className="sprint-progress-count"><b>{completed}/{sprintTasks.length}</b><small>completed</small></div><div className="sprint-progress"><span style={{ width: `${sprintTasks.length ? (completed / sprintTasks.length) * 100 : 0}%` }}/></div><button className="sprint-status-action" onClick={() => changeSprintStatus(sprint, sprint.status === "ACTIVE" ? "COMPLETED" : "ACTIVE")}>{sprint.status === "ACTIVE" ? "Complete" : "Start sprint"}</button></div><div className="sprint-task-list">{sprintTasks.length ? sprintTasks.map((task) => <button className="sprint-task-row" key={task.id} onClick={() => setEditingTask(task)}><span className={`sprint-task-status status-${task.status.toLowerCase().replace(" ", "-")}`}/><span className="sprint-task-key">{task.key}</span><span className="sprint-task-title">{task.title}</span><span className={`priority-pill ${priorityClass[task.priority]}`}><i/>{task.priority}</span><Avatar initials={task.initials} color={task.color} small/><span className="sprint-row-date">{task.due}</span></button>) : <div className="sprint-empty">No tasks planned for this sprint yet.</div>}</div><button className="sprint-add-task" onClick={() => { setEditingTask(null); setModalOpen(true); }}>+ Add task to {sprint.name}</button></section>;
              })}
              <section className="sprint-group backlog-group"><div className="sprint-group-heading"><span className="backlog-icon"><Icon name="inbox" size={16}/></span><div className="sprint-heading-copy"><h3>Backlog <span className="sprint-badge">UNPLANNED</span></h3><p>Tasks waiting to be scheduled into a sprint.</p></div><span className="backlog-count">{tasks.filter((task) => !task.sprintId && task.status !== "Done").length} tasks</span></div><div className="sprint-task-list">{tasks.filter((task) => !task.sprintId && task.status !== "Done").map((task) => <button className="sprint-task-row" key={task.id} onClick={() => setEditingTask(task)}><span className={`sprint-task-status status-${task.status.toLowerCase().replace(" ", "-")}`}/><span className="sprint-task-key">{task.key}</span><span className="sprint-task-title">{task.title}</span><span className={`priority-pill ${priorityClass[task.priority]}`}><i/>{task.priority}</span><Avatar initials={task.initials} color={task.color} small/><span className="sprint-row-date">{task.due}</span></button>)}</div></section>
              <div className="planning-footnote">Sprints are planned in two week cycles. Drag tasks between sprints from a task’s edit panel.</div>
             </div>}
            {view === "timeline" && currentProject && <div className="timeline-view">
              <div className="planning-toolbar"><div><span className="planning-kicker">WATERFALL & DELIVERY</span><h2>Project timeline</h2><p>See task dates and how work connects.</p></div><div className="planning-actions"><button className="secondary-action" onClick={() => setDependencyModalOpen(true)}>↗ Add dependency</button><button className="secondary-action" onClick={() => setTimelineOffset((offset) => offset - 7)}>← Earlier</button><button className="secondary-action" onClick={() => setTimelineOffset((offset) => offset + 7)}>Later →</button></div></div>
              <div className="timeline-legend"><span><i className="legend-purple"/> In progress</span><span><i className="legend-gold"/> In review</span><span><i className="legend-green"/> Done</span><span><i className="legend-arrow"/> Dependency</span><b>{formatMonthDay(timelineStart)} – {formatMonthDay(new Date(timelineStart.getTime() + 13 * 86_400_000))}</b></div>
              <div className="timeline-scroll"><div className="timeline-layout"><div className="timeline-axis"><div className="timeline-task-header">TASK</div><div className="timeline-day-grid" style={{ width: timelineWidth }}>{timelineDays.map(({ date, day, label }) => <div className={`timeline-day${date.toISOString().slice(0, 10) === "2026-11-03" ? " today" : ""}`} key={date.toISOString()}><small>{day}</small><b>{label}</b></div>)}</div></div><div className="timeline-body" style={{ width: 224 + timelineWidth }}>
                {timelineItems.map((item) => <div className="timeline-row" key={item.task.id}><button className="timeline-task-label" onClick={() => setEditingTask(item.task)}><span className="timeline-task-key">{item.task.key}</span><b>{item.task.title}</b><Avatar initials={item.task.initials} color={item.task.color} small/></button><div className="timeline-track" style={{ width: timelineWidth }}><span className={`timeline-bar bar-${item.task.status.toLowerCase().replace(" ", "-")}`} style={{ left: item.left, width: item.width }} title={`${item.task.title}: ${formatMonthDay(item.start)} – ${formatMonthDay(item.due)}`}><span>{item.task.title}</span></span></div></div>)}
                <svg className="dependency-lines" width={224 + timelineWidth} height={timelineItems.length * 49} aria-label="Task dependency arrows"><defs><marker id="dependency-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#9c8bdc"/></marker></defs>{dependencies.map((dependency) => { const from = timelineItems.findIndex((item) => item.task.id === dependency.blockerTaskId); const to = timelineItems.findIndex((item) => item.task.id === dependency.blockedTaskId); if (from < 0 || to < 0) return null; const startX = 224 + timelineItems[from].end; const endX = 224 + timelineItems[to].left; const startY = from * 49 + 24; const endY = to * 49 + 24; const bend = Math.max(startX + 12, endX - 12); return <path key={`${dependency.blockerTaskId}-${dependency.blockedTaskId}`} d={`M ${startX} ${startY} C ${bend} ${startY}, ${bend} ${endY}, ${endX} ${endY}`} fill="none" stroke="#9c8bdc" strokeWidth="1.5" markerEnd="url(#dependency-arrow)"/>; })}</svg>
              </div><div className="timeline-footer"><span>{timelineItems.length} tasks in view</span><span>{dependencies.length} dependencies</span><button onClick={() => setDependencyModalOpen(true)}>Manage dependencies</button></div></div>
             </div></div>}
            <div className="board-footer"><span><span className={`live-dot${apiStatus === "offline" ? " offline-dot" : ""}`}/>{apiStatus === "connecting" ? "Connecting to project database…" : apiStatus === "connected" ? "Synced to project database" : "Offline · saved on this device"}</span><span>Updated just now <span className="footer-divider">·</span> <button onClick={() => setActivityOpen(true)}>View activity{activity.length ? ` (${activity.length})` : ""}</button></span></div>
          </section>
        </div>
      </main>

      {workspaceModalOpen && <WorkspaceModal onClose={() => setWorkspaceModalOpen(false)} onSubmit={createWorkspace}/>}
      {memberModalOpen && <MemberModal onClose={() => setMemberModalOpen(false)} onSubmit={createMember}/>}      {projectModalOpen && <ProjectModal workspaces={workspaces} selectedWorkspaceId={currentWorkspaceId} onClose={() => setProjectModalOpen(false)} onSubmit={createProject}/>}      {(modalOpen || editingTask) && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setModalOpen(false); setEditingTask(null); } }}><form className="task-modal" onSubmit={editingTask ? updateTask : addTask}><div className="modal-heading"><div><span className="modal-kicker">{currentProject?.name.toUpperCase() ?? "PROJECT"}{editingTask ? ` · ${editingTask.key}` : ""}</span><h2>{editingTask ? "Edit task" : "Create a task"}</h2></div><button type="button" className="modal-close" aria-label="Close" onClick={() => { setModalOpen(false); setEditingTask(null); }}><Icon name="close"/></button></div><label className="form-field">Task name<input name="title" defaultValue={editingTask?.title} placeholder="e.g. Design the settings page" required autoFocus/></label><label className="form-field">Description<textarea name="tag" defaultValue={editingTask?.tag} placeholder="Add a short label or note" rows={2}/></label><div className="form-grid"><label className="form-field">Status<select name="status" defaultValue={editingTask?.status ?? "Todo"}>{columns.map((column) => <option key={column}>{column}</option>)}</select></label><label className="form-field">Priority<select name="priority" defaultValue={editingTask?.priority ?? "Medium"}>{["Medium", "Urgent", "High", "Low"].map((value) => <option key={value}>{value}</option>)}</select></label></div><div className="form-grid"><label className="form-field">Assignee<select name="assigneeId" defaultValue={editingTask?.assigneeId ?? ""}><option value="">Unassigned</option>{workspaceMembers.map((member) => <option key={member.id} value={member.id}>{member.name ?? member.email}</option>)}</select></label><label className="form-field">Sprint<select name="sprintId" defaultValue={editingTask ? editingTask.sprintId ?? "" : activeSprint?.id ?? ""}><option value="">Backlog</option>{sprints.map((sprint) => <option value={sprint.id} key={sprint.id}>{sprint.name}</option>)}</select></label></div><div className="form-grid"><label className="form-field">Start date<input name="start" type="date" defaultValue={editingTask?.startDate?.slice(0, 10)}/></label><label className="form-field">Due date<input name="due" type="date" defaultValue={editingTask?.dueDate?.slice(0, 10)}/></label></div>{editingTask && <section className="task-comments"><h3>Discussion <span>{comments.filter((comment) => comment.taskId === editingTask.id).length}</span></h3><div className="comment-compose"><Avatar initials={actorInitials} color="profile" small/><textarea aria-label="Write a comment" placeholder="Share an update or ask a question…" value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} rows={2}/><button type="button" className="create-button" disabled={!commentDraft.trim()} onClick={addComment}>Comment</button></div><div className="comment-list">{comments.filter((comment) => comment.taskId === editingTask.id).map((comment) => <article className="comment-item" key={comment.id}><Avatar initials={comment.initials} color="profile" small/><div><b>{comment.author}</b><time>{new Date(comment.createdAt).toLocaleString()}</time><p>{comment.content}</p></div></article>)}{comments.every((comment) => comment.taskId !== editingTask.id) && <p className="comment-empty">No comments yet. Start the conversation.</p>}</div></section>}<div className="modal-actions">{editingTask && <button type="button" className="delete-button" onClick={deleteTask}>Delete</button>}<button type="button" className="cancel-button" onClick={() => { setModalOpen(false); setEditingTask(null); }}>Cancel</button><button className="create-button" type="submit"><Icon name={editingTask ? "check" : "plus"} size={16}/> {editingTask ? "Save changes" : "Create task"}</button></div></form></div>}
      {sprintModalOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSprintModalOpen(false); }}><form className="task-modal" onSubmit={createSprint}><div className="modal-heading"><div><span className="modal-kicker">{currentProject?.name.toUpperCase() ?? "PROJECT"} · {currentProject?.methodology ?? "AGILE"}</span><h2>Plan a sprint</h2></div><button type="button" className="modal-close" aria-label="Close" onClick={() => setSprintModalOpen(false)}><Icon name="close"/></button></div><label className="form-field">Sprint name<input name="name" defaultValue={`Sprint ${sprints.length + 12}`} required autoFocus/></label><label className="form-field">Sprint goal<textarea name="goal" placeholder="What should the team complete?" rows={2}/></label><div className="form-grid"><label className="form-field">Start date<input name="startDate" type="date" defaultValue="2026-11-29" required/></label><label className="form-field">End date<input name="endDate" type="date" defaultValue="2026-12-12" required/></label></div><div className="modal-actions"><button type="button" className="cancel-button" onClick={() => setSprintModalOpen(false)}>Cancel</button><button className="create-button" type="submit"><Icon name="plus" size={16}/> Create sprint</button></div></form></div>}
      {dependencyModalOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDependencyModalOpen(false); }}><form className="task-modal" onSubmit={createDependency}><div className="modal-heading"><div><span className="modal-kicker">PROJECT TIMELINE</span><h2>Link task dependencies</h2></div><button type="button" className="modal-close" aria-label="Close" onClick={() => setDependencyModalOpen(false)}><Icon name="close"/></button></div><p className="dependency-help">Choose the task that must finish first and the task it blocks.</p><label className="form-field">Blocking task<select name="blockerTaskId">{tasks.map((task) => <option value={task.id} key={task.id}>{task.key} · {task.title}</option>)}</select></label><label className="form-field">Blocked task<select name="blockedTaskId" defaultValue={tasks[1]?.id ?? tasks[0]?.id}>{tasks.map((task) => <option value={task.id} key={task.id}>{task.key} · {task.title}</option>)}</select></label><div className="modal-actions"><button type="button" className="cancel-button" onClick={() => setDependencyModalOpen(false)}>Cancel</button><button className="create-button" type="submit">Add dependency</button></div></form></div>}
      {activityOpen && <div className="modal-backdrop activity-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setActivityOpen(false); }}><section className="activity-panel"><div className="modal-heading"><div><span className="modal-kicker">{currentProject?.name.toUpperCase() ?? "PROJECT"}</span><h2>Project activity</h2></div><button type="button" className="modal-close" aria-label="Close activity" onClick={() => setActivityOpen(false)}><Icon name="close"/></button></div>{activity.length ? <div className="activity-list">{activity.map((item) => <article className="activity-item" key={item.id}><Avatar initials={item.initials} color={item.color} small/><div><b>{item.text}</b><p>{item.detail}</p><time>{new Date(item.createdAt).toLocaleString()}</time></div></article>)}</div> : <div className="activity-empty"><span>✦</span><b>Activity will appear here</b><p>Task updates, sprint changes, comments, and dependencies will be collected in this feed.</p></div>}</section></div>}
      {toast && <div className="toast"><span className="toast-check">✓</span>{toast}</div>}
    </div>
  );
}

export default function Home() {
  return <Suspense fallback={<main className="auth-loading">Loading your workspace…</main>}><HomeContent /></Suspense>;
}
