"use client";

import { useState, type ComponentProps, type Dispatch, type SetStateAction } from "react";
import { Link, useLocation } from "react-router";
import { useWorkspace } from "@/components/workspace-provider";
import { dashboardPaths, type DashboardRoute } from "@/lib/dashboard-routes";
import type { Workspace } from "@/lib/workspace-api";
import {
  ActivityIcon,
  ArrowLeftRightIcon,
  ChartNoAxesCombinedIcon,
  ChevronDownIcon,
  DollarSignIcon,
  KeyRoundIcon,
  LogOutIcon,
  LogsIcon,
  PencilIcon,
  PlusIcon,
  RouteIcon,
  ServerIcon,
  SettingsIcon,
  ShieldCheckIcon,
  TerminalIcon,
  Trash2Icon,
  WalletCardsIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { toast } from "@/components/ui/toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";

type Item = { route: DashboardRoute; title: string; icon: LucideIcon };
type Group = { label: string; items: Item[] };

const globalItems: Item[] = [
  { route: "cliproxy", title: "CLIProxyAPI", icon: TerminalIcon },
  { route: "settings", title: "Settings", icon: SettingsIcon },
];

const aiGroups: Group[] = [
  {
    label: "Gateway",
    items: [
      { route: "endpoint", title: "Endpoint & Key", icon: KeyRoundIcon },
      { route: "providers", title: "Providers", icon: ServerIcon },
      { route: "codex", title: "Codex Providers", icon: ShieldCheckIcon },
      { route: "routing", title: "Model routing", icon: ArrowLeftRightIcon },
    ],
  },
  {
    label: "Analytics",
    items: [
      { route: "usage", title: "Usage", icon: ChartNoAxesCombinedIcon },
      { route: "budgets", title: "Budgets", icon: WalletCardsIcon },
      { route: "pricing", title: "Model Pricing", icon: DollarSignIcon },
    ],
  },
  { label: "System", items: [{ route: "logs", title: "Console Log", icon: LogsIcon }] },
  { label: "Global", items: globalItems },
];

const toolGroups: Group[] = [
  {
    label: "Tool Gateway",
    items: [
      { route: "tool-overview", title: "Overview", icon: WrenchIcon },
      { route: "tool-tools", title: "Tools", icon: WrenchIcon },
      { route: "tool-connections", title: "Connections", icon: ActivityIcon },
      { route: "tool-policies", title: "Policies", icon: ShieldCheckIcon },
      { route: "tool-activity", title: "Activity", icon: ActivityIcon },
      { route: "tool-settings", title: "Settings", icon: SettingsIcon },
    ],
  },
  { label: "System", items: [{ route: "logs", title: "Console Log", icon: LogsIcon }] },
  { label: "Global", items: globalItems },
];

type WorkspaceDialog = "create" | "rename" | "delete" | null;

export function AppSidebar({
  route,
  onNavigate,
  onLogout,
  ...props
}: ComponentProps<typeof Sidebar> & {
  route: DashboardRoute;
  onNavigate: (route: DashboardRoute) => void;
  onLogout: () => Promise<void>;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const location = useLocation();
  const app = location.pathname.startsWith("/dashboard/tools/") ? "tool" : "ai";
  const {
    workspaces,
    activeWorkspaceId,
    activeWorkspace,
    isLoading,
    error,
    selectWorkspace,
    reload,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
  } = useWorkspace();
  const [workspaceDialog, setWorkspaceDialog] = useState<WorkspaceDialog>(null);
  const [workspaceTarget, setWorkspaceTarget] = useState<Workspace | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const groups = app === "ai" ? aiGroups : toolGroups;
  const workspaceLabel = activeWorkspace?.name ?? (isLoading ? "Loading workspaces…" : "Workspaces unavailable");

  function navigate(next: DashboardRoute) {
    onNavigate(next);
    if (isMobile) setOpenMobile(false);
  }

  function openWorkspaceDialog(dialog: Exclude<WorkspaceDialog, null>) {
    const target = dialog === "create" ? null : activeWorkspace;
    if (dialog !== "create" && !target) return;
    setWorkspaceTarget(target);
    setWorkspaceName(dialog === "rename" ? target?.name ?? "" : "");
    setDeleteConfirmation("");
    setWorkspaceError(null);
    setWorkspaceDialog(dialog);
  }

  async function saveWorkspace() {
    const name = workspaceName.trim();
    if (!name) return;
    const targetId = workspaceTarget?.id;
    setSavingWorkspace(true);
    setWorkspaceError(null);
    try {
      if (workspaceDialog === "create") {
        await createWorkspace(name);
        toast.add({ title: "Workspace created", type: "success" });
      } else if (workspaceDialog === "rename" && targetId) {
        await renameWorkspace(targetId, name);
        toast.add({ title: "Workspace renamed", type: "success" });
      }
      setWorkspaceDialog(null);
    } catch (saveError) {
      setWorkspaceError(saveError instanceof Error ? saveError.message : "Unable to save workspace.");
    } finally {
      setSavingWorkspace(false);
    }
  }

  async function removeWorkspace() {
    const target = workspaceTarget;
    if (!target || deleteConfirmation !== target.name) return;
    setSavingWorkspace(true);
    setWorkspaceError(null);
    try {
      await deleteWorkspace(target.id, deleteConfirmation);
      setWorkspaceDialog(null);
      toast.add({ title: "Workspace deleted", type: "success" });
    } catch (deleteError) {
      setWorkspaceError(deleteError instanceof Error ? deleteError.message : "Unable to delete workspace.");
    } finally {
      setSavingWorkspace(false);
    }
  }

  return (
    <>
      <Sidebar collapsible="icon" variant="inset" {...props}>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuButton
                      size="lg"
                      tooltip={`${workspaceLabel} - ${app === "ai" ? "AI Gateway" : "Tool Gateway"}`}
                    >
                      <span className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                        <RouteIcon />
                      </span>
                      <span className="grid flex-1 text-left text-sm leading-tight">
                        <span className="truncate font-semibold">RawRoute</span>
                        <span className="truncate text-xs">{workspaceLabel} · {app === "ai" ? "AI Gateway" : "Tool Gateway"}</span>
                      </span>
                      <ChevronDownIcon className="ml-auto text-muted-foreground" />
                    </SidebarMenuButton>
                  }
                />
                <DropdownMenuContent className="w-64" align="start" side={isMobile ? "bottom" : "right"}>
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
                    {isLoading ? (
                      <DropdownMenuItem disabled><Spinner data-icon="inline-start" />Loading workspaces…</DropdownMenuItem>
                    ) : error ? (
                      <DropdownMenuItem onClick={() => void reload()}>Retry loading workspaces</DropdownMenuItem>
                    ) : (
                      <DropdownMenuRadioGroup value={activeWorkspaceId ?? ""} onValueChange={selectWorkspace}>
                        {workspaces.map((workspace) => (
                          <DropdownMenuRadioItem key={workspace.id} value={workspace.id} disabled={workspace.status !== "active"}>
                            <RouteIcon data-icon="inline-start" />
                            <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                            {workspace.status === "deleting" && <span className="text-xs text-muted-foreground">Deleting…</span>}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    )}
                    <DropdownMenuItem disabled={isLoading} onClick={() => openWorkspaceDialog("create")}>
                      <PlusIcon data-icon="inline-start" />Add New Workspace
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!activeWorkspace || activeWorkspace.isDefault || isLoading} onClick={() => openWorkspaceDialog("rename")}>
                      <PencilIcon data-icon="inline-start" />Rename Workspace
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!activeWorkspace || activeWorkspace.isDefault || isLoading} variant="destructive" onClick={() => openWorkspaceDialog("delete")}>
                      <Trash2Icon data-icon="inline-start" />Delete Workspace
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Apps</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={app} onValueChange={(value) => navigate(value === "tool" ? "tool-overview" : "endpoint")}>
                      <DropdownMenuRadioItem value="ai"><RouteIcon data-icon="inline-start" />AI Gateway</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="tool"><WrenchIcon data-icon="inline-start" />Tool Gateway</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          {groups.map((group) => (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.route}>
                      <SidebarMenuButton
                        tooltip={item.title}
                        isActive={route === item.route}
                        render={<Link to={dashboardPaths[item.route]} onClick={() => { if (isMobile) setOpenMobile(false); }} />}
                      >
                        <item.icon />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu><SidebarMenuItem><SidebarMenuButton tooltip="Sign out" onClick={() => setLogoutOpen(true)}><LogOutIcon /><span>Sign out</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <WorkspaceDialogs
        dialog={workspaceDialog}
        target={workspaceTarget}
        workspaceName={workspaceName}
        setWorkspaceName={setWorkspaceName}
        deleteConfirmation={deleteConfirmation}
        setDeleteConfirmation={setDeleteConfirmation}
        error={workspaceError}
        saving={savingWorkspace}
        onClose={() => !savingWorkspace && setWorkspaceDialog(null)}
        onSave={() => void saveWorkspace()}
        onDelete={() => void removeWorkspace()}
        logoutOpen={logoutOpen}
        setLogoutOpen={setLogoutOpen}
        loggingOut={loggingOut}
        setLoggingOut={setLoggingOut}
        onLogout={onLogout}
      />
    </>
  );
}

function WorkspaceDialogs({
  dialog, target, workspaceName, setWorkspaceName, deleteConfirmation,
  setDeleteConfirmation, error, saving, onClose, onSave, onDelete, logoutOpen,
  setLogoutOpen, loggingOut, setLoggingOut, onLogout,
}: {
  dialog: WorkspaceDialog;
  target: Workspace | null;
  workspaceName: string;
  setWorkspaceName: Dispatch<SetStateAction<string>>;
  deleteConfirmation: string;
  setDeleteConfirmation: Dispatch<SetStateAction<string>>;
  error: string | null;
  saving: boolean;
  onClose: () => void;
  onSave: () => void;
  onDelete: () => void;
  logoutOpen: boolean;
  setLogoutOpen: Dispatch<SetStateAction<boolean>>;
  loggingOut: boolean;
  setLoggingOut: Dispatch<SetStateAction<boolean>>;
  onLogout: () => Promise<void>;
}) {
  const editing = dialog === "rename";
  return (
    <>
      <Dialog open={dialog === "create" || editing} onOpenChange={(open) => !open && onClose()}>
        <DialogContent>
          <form onSubmit={(event) => { event.preventDefault(); onSave(); }}>
            <DialogHeader>
              <DialogTitle>{editing ? "Rename workspace" : "Create workspace"}</DialogTitle>
              <DialogDescription>
                Workspace names are persisted. Provider, OAuth, routing, and pricing controls remain browser-only mock fixtures until their workspace APIs are added.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup className="mt-5">
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="workspace-name">Workspace name</FieldLabel>
                <Input id="workspace-name" autoFocus value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} aria-invalid={Boolean(error)} disabled={saving} />
                {error && <FieldError>{error}</FieldError>}
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={saving} onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={saving || !workspaceName.trim()}>{saving && <Spinner data-icon="inline-start" />}{editing ? "Save" : "Create"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={dialog === "delete"} onOpenChange={(open) => !open && onClose()}>
        <DialogContent>
          <form onSubmit={(event) => { event.preventDefault(); onDelete(); }}>
            <DialogHeader>
              <DialogTitle>Delete {target?.name}?</DialogTitle>
              <DialogDescription>
                This permanently removes the workspace. Type its current name to confirm; Default is protected.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup className="mt-5">
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="workspace-delete-confirmation">Type {target?.name}</FieldLabel>
                <Input id="workspace-delete-confirmation" autoFocus value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} aria-invalid={Boolean(error)} disabled={saving} />
                {error && <FieldError>{error}</FieldError>}
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={saving} onClick={onClose}>Cancel</Button>
              <Button type="submit" variant="destructive" disabled={saving || deleteConfirmation !== target?.name}>{saving && <Spinner data-icon="inline-start" />}Delete permanently</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={logoutOpen} onOpenChange={setLogoutOpen}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Sign out?</AlertDialogTitle><AlertDialogDescription>Your dashboard password session will end in this browser.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loggingOut}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={loggingOut} onClick={() => { setLoggingOut(true); void onLogout().finally(() => setLoggingOut(false)); }}>
              {loggingOut && <Spinner data-icon="inline-start" />}Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
