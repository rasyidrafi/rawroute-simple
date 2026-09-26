"use client";

import { toast } from "@/components/ui/toast";
import { reportEvent } from "@/lib/logging/client";
import type { BrowserLogDetails } from "@/lib/logging/client";
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
import { Spinner } from "@/components/ui/spinner";

export async function copy(value: string, label = "Copied", scope: BrowserLogDetails = {}) {
  try {
    if (!navigator.clipboard) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(value);
    toast.add({ title: label, type: "success" });
    reportEvent("dashboard.copy", scope);
    return true;
  } catch {
    toast.add({ title: "Clipboard access failed. Please try again.", type: "error" });
    reportEvent("dashboard.copy-failed", scope);
    return false;
  }
}

export function notify(message: string, type: "success" | "info" | "error" = "success") {
  toast.add({ title: message, type });
}

export function Page({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-8">{children}</div>
    </main>
  );
}

export function Confirm({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  pending = false,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => void;
  pending?: boolean;
  error?: string | null;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => !pending && onOpenChange(nextOpen)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={onConfirm}>{pending && <Spinner data-icon="inline-start" />}Confirm</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function Metadata({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-medium">{value}</div>
    </div>
  );
}
