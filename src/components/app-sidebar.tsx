"use client";

import { useState, type ComponentProps } from "react";
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

export type DashboardRoute =
  | "endpoint"
  | "providers"
  | "codex"
  | "routing"
  | "usage"
  | "budgets"
  | "pricing"
  | "logs"
  | "cliproxy"
  | "settings"
  | "tool-overview"
  | "tool-tools"
  | "tool-connections"
  | "tool-policies"
  | "tool-activity"
  | "tool-settings";

type Item = { route: DashboardRoute; title: string; icon: LucideIcon };
type Group = { label: string; items: Item[] };

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
  {
    label: "System",
    items: [
      { route: "cliproxy", title: "CLIProxyAPI", icon: TerminalIcon },
      { route: "logs", title: "Console Log", icon: LogsIcon },
      { route: "settings", title: "Settings", icon: SettingsIcon },
    ],
  },
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
];

type Workspace = { id: string; name: string; default?: boolean };

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
  const [app, setApp] = useState<"ai" | "tool">(
    route.startsWith("tool-") ? "tool" : "ai",
  );
  const [workspaces, setWorkspaces] = useState<Workspace[]>([
    { id: "default", name: "Default", default: true },
    { id: "growth", name: "Growth Lab" },
  ]);
  const [workspaceId, setWorkspaceId] = useState("default");
  const [workspaceDialog, setWorkspaceDialog] = useState<
    "create" | "rename" | "delete" | null
  >(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const workspace =
    workspaces.find((item) => item.id === workspaceId) ?? workspaces[0];
  const groups = app === "ai" ? aiGroups : toolGroups;

  function navigate(next: DashboardRoute) {
    setApp(next.startsWith("tool-") ? "tool" : "ai");
    onNavigate(next);
    if (isMobile) setOpenMobile(false);
  }

  function saveWorkspace() {
    const name = workspaceName.trim();
    if (!name) return;
    if (workspaceDialog === "create") {
      const id = `workspace-${Date.now()}`;
      setWorkspaces((current) => [...current, { id, name }]);
      setWorkspaceId(id);
      toast.add({ title: "Workspace created", type: "success" });
    }
    if (workspaceDialog === "rename") {
      setWorkspaces((current) =>
        current.map((item) =>
          item.id === workspace.id ? { ...item, name } : item,
        ),
      );
      toast.add({ title: "Workspace renamed", type: "success" });
    }
    setWorkspaceDialog(null);
  }

  function deleteWorkspace() {
    setWorkspaces((current) =>
      current.filter((item) => item.id !== workspace.id),
    );
    setWorkspaceId("default");
    setWorkspaceDialog(null);
    navigate("endpoint");
    toast.add({ title: "Workspace deleted", type: "success" });
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
                      tooltip={`${workspace.name} - ${app === "ai" ? "AI Gateway" : "Tool Gateway"}`}
                    >
                    <span className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                      <RouteIcon className="size-4" />
                    </span>
                    <span className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-semibold">RawRoute</span>
                      <span className="truncate text-xs">
                        {workspace.name} ·{" "}
                        {app === "ai" ? "AI Gateway" : "Tool Gateway"}
                      </span>
                    </span>
                    <ChevronDownIcon className="ml-auto size-4 text-muted-foreground" />
                    </SidebarMenuButton>
                  }
                />
                <DropdownMenuContent
                  className="w-64"
                  align="start"
                  side={isMobile ? "bottom" : "right"}
                >
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={workspaceId}
                      onValueChange={setWorkspaceId}
                    >
                      {workspaces.map((item) => (
                        <DropdownMenuRadioItem key={item.id} value={item.id}>
                          <span className="flex size-7 items-center justify-center rounded-md border bg-background">
                            <RouteIcon className="size-3.5" />
                          </span>
                          <span>{item.name}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    <DropdownMenuItem
                      onClick={() => {
                        setWorkspaceName("");
                        setWorkspaceDialog("create");
                      }}
                    >
                      <span className="flex size-7 items-center justify-center rounded-md border bg-background">
                        <PlusIcon className="size-4" />
                      </span>
                      Add New Workspace
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={workspace.default}
                      onClick={() => {
                        setWorkspaceName(workspace.name);
                        setWorkspaceDialog("rename");
                      }}
                    >
                      <span className="flex size-7 items-center justify-center rounded-md border bg-background">
                        <PencilIcon className="size-4" />
                      </span>
                      Rename Workspace
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={workspace.default}
                      variant="destructive"
                      onClick={() => {
                        setDeleteConfirmation("");
                        setWorkspaceDialog("delete");
                      }}
                    >
                      <span className="flex size-7 items-center justify-center rounded-md border bg-background">
                        <Trash2Icon className="size-4" />
                      </span>
                      Delete Workspace
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Apps</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={app}
                      onValueChange={(value) =>
                        navigate(
                          value === "tool" ? "tool-overview" : "endpoint",
                        )
                      }
                    >
                      <DropdownMenuRadioItem value="ai">
                        <span className="flex size-7 items-center justify-center rounded-md border bg-background">
                          <RouteIcon className="size-3.5" />
                        </span>
                        <span className="min-w-0 flex-1 truncate">AI Gateway</span>
                        <span className="text-[10px] text-muted-foreground">Mock</span>
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="tool">
                        <span className="flex size-7 items-center justify-center rounded-md border bg-background">
                          <WrenchIcon className="size-3.5" />
                        </span>
                        <span className="min-w-0 flex-1 truncate">Tool Gateway</span>
                        <span className="text-[10px] text-muted-foreground">No proxy</span>
                      </DropdownMenuRadioItem>
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
                        onClick={() => navigate(item.route)}
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
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Sign out"
                onClick={() => setLogoutOpen(true)}
              >
                <LogOutIcon />
                <span>Sign out</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <Dialog
        open={workspaceDialog === "create" || workspaceDialog === "rename"}
        onOpenChange={(open) => !open && setWorkspaceDialog(null)}
      >
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              saveWorkspace();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {workspaceDialog === "create"
                  ? "Create workspace"
                  : "Rename workspace"}
              </DialogTitle>
              <DialogDescription>
                {workspaceDialog === "create"
                  ? "Add a local workspace label for this dashboard session. Mock data is shared across workspace labels."
                  : "Update the workspace label shown in the dashboard."}
              </DialogDescription>
            </DialogHeader>
            <div className="py-5">
              <label className="text-sm font-medium" htmlFor="workspace-name">
                Workspace name
              </label>
              <Input
                id="workspace-name"
                className="mt-2"
                autoFocus
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setWorkspaceDialog(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!workspaceName.trim()}>
                {workspaceDialog === "create" ? "Create" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={workspaceDialog === "delete"}
        onOpenChange={(open) => !open && setWorkspaceDialog(null)}
      >
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (deleteConfirmation === workspace.name) deleteWorkspace();
            }}
          >
            <DialogHeader>
              <DialogTitle>Delete {workspace.name}?</DialogTitle>
              <DialogDescription>
                This removes the local mock workspace from this dashboard
                session. Type the workspace name to confirm.
              </DialogDescription>
            </DialogHeader>
            <div className="py-5">
              <label className="text-sm font-medium" htmlFor="workspace-delete-confirmation">
                Type {workspace.name}
              </label>
              <Input
                id="workspace-delete-confirmation"
                className="mt-2"
                autoFocus
                value={deleteConfirmation}
                onChange={(event) => setDeleteConfirmation(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setWorkspaceDialog(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={deleteConfirmation !== workspace.name}
              >
                Delete permanently
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={logoutOpen} onOpenChange={setLogoutOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out?</AlertDialogTitle>
            <AlertDialogDescription>
              Your dashboard password session will end in this browser.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loggingOut}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={loggingOut}
              onClick={() => {
                setLoggingOut(true);
                void onLogout().finally(() => setLoggingOut(false));
              }}
            >
              {loggingOut ? "Signing out..." : "Sign out"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
