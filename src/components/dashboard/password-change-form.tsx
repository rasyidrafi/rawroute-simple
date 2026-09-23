"use client";

import { useId, useState, type FormEvent } from "react";
import { LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { PasswordInput } from "@/components/password-input";

type PasswordChangeResponse = {
  success?: boolean;
  error?: string;
};

type Props = {
  mode?: "dialog" | "settings";
  onPasswordChanged: () => void | Promise<void>;
  onLogout?: () => Promise<void>;
  logoutError?: string | null;
};

export function PasswordChangeForm({
  mode = "settings",
  onPasswordChanged,
  onLogout,
  logoutError,
}: Props) {
  const fieldId = useId();
  const currentPasswordId = `${fieldId}-current-password`;
  const newPasswordId = `${fieldId}-new-password`;
  const confirmPasswordId = `${fieldId}-confirm-password`;
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [localLogoutError, setLocalLogoutError] = useState<string | null>(null);
  const isBusy = isSubmitting || isSigningOut;
  const displayedLogoutError = localLogoutError ?? logoutError;

  async function submitPasswordChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (newPassword.length < 12 || newPassword.length > 128) {
      setError("The new password must be between 12 and 128 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("The new passwords do not match.");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const payload = (await response.json().catch(() => null)) as
        | PasswordChangeResponse
        | null;

      if (!response.ok || payload?.success !== true) {
        throw new Error(
          payload?.error ?? `Unable to change password (HTTP ${response.status}).`,
        );
      }

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      await onPasswordChanged();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to change password. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function signOut() {
    if (!onLogout) return;
    setLocalLogoutError(null);
    setIsSigningOut(true);
    try {
      await onLogout();
    } catch {
      setLocalLogoutError("Unable to sign out. Please try again.");
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={submitPasswordChange}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={currentPasswordId}>Current password</FieldLabel>
          <PasswordInput
            id={currentPasswordId}
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            maxLength={128}
            required
            disabled={isBusy}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={newPasswordId}>New password</FieldLabel>
          <PasswordInput
            id={newPasswordId}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
            disabled={isBusy}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={confirmPasswordId}>Confirm new password</FieldLabel>
          <PasswordInput
            id={confirmPasswordId}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
            disabled={isBusy}
          />
        </Field>
      </FieldGroup>
      <p className="text-xs text-muted-foreground">
        Choose a password between 12 and 128 characters.
      </p>
      {error && (
        <p id="password-change-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {displayedLogoutError && (
        <p role="alert" className="text-sm text-destructive">
          {displayedLogoutError}
        </p>
      )}
      {mode === "dialog" ? (
        <DialogFooter className="mt-1 sm:justify-between">
          {onLogout && (
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              disabled={isBusy}
              onClick={() => void signOut()}
            >
              {isSigningOut ? <LoaderCircleIcon className="animate-spin" /> : null}
              {isSigningOut ? "Signing out..." : "Sign out"}
            </Button>
          )}
          <Button type="submit" className="w-full sm:w-auto" disabled={isBusy}>
            {isSubmitting ? <LoaderCircleIcon className="animate-spin" /> : null}
            {isSubmitting ? "Changing password..." : "Change password"}
          </Button>
        </DialogFooter>
      ) : (
        <div>
          <Button type="submit" disabled={isBusy}>
            {isSubmitting ? <LoaderCircleIcon className="animate-spin" /> : null}
            {isSubmitting ? "Updating password..." : "Update password"}
          </Button>
        </div>
      )}
    </form>
  );
}
