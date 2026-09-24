"use client";

import { useId, useState, type FormEvent } from "react";
import { LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { PasswordInput } from "@/components/password-input";

type PasswordChangeResponse = {
  success?: boolean;
  error?: string;
};

type Props = {
  mode?: "dialog" | "settings";
  requireCurrentPassword?: boolean;
  onPasswordChanged: () => void | Promise<void>;
  onLogout?: () => Promise<void>;
  logoutError?: string | null;
};

type PasswordField = "currentPassword" | "newPassword" | "confirmPassword";
type PasswordFieldErrors = Partial<Record<PasswordField, string>>;

function getPasswordFieldErrors(
  currentPassword: string,
  newPassword: string,
  confirmPassword: string,
  requireCurrentPassword: boolean,
): PasswordFieldErrors {
  const errors: PasswordFieldErrors = {};

  if (requireCurrentPassword && !currentPassword) {
    errors.currentPassword = "Enter your current password.";
  }
  if (newPassword.length < 12) {
    errors.newPassword =
      newPassword.length === 0
        ? "Enter a new password."
        : "Use at least 12 characters.";
  } else if (newPassword.length > 128) {
    errors.newPassword = "Use no more than 128 characters.";
  }
  if (!confirmPassword) {
    errors.confirmPassword = "Confirm your new password.";
  } else if (newPassword !== confirmPassword) {
    errors.confirmPassword = "The passwords do not match.";
  }

  return errors;
}

export function PasswordChangeForm({
  mode = "settings",
  requireCurrentPassword = true,
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
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [serverFieldErrors, setServerFieldErrors] =
    useState<PasswordFieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [localLogoutError, setLocalLogoutError] = useState<string | null>(null);
  const isBusy = isSubmitting || isSigningOut;
  const displayedLogoutError = localLogoutError ?? logoutError;
  const validationErrors = hasSubmitted
    ? getPasswordFieldErrors(
        currentPassword,
        newPassword,
        confirmPassword,
        requireCurrentPassword,
      )
    : {};
  const fieldErrors = {
    currentPassword:
      serverFieldErrors.currentPassword ?? validationErrors.currentPassword,
    newPassword: serverFieldErrors.newPassword ?? validationErrors.newPassword,
    confirmPassword:
      serverFieldErrors.confirmPassword ?? validationErrors.confirmPassword,
  };

  async function submitPasswordChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setHasSubmitted(true);
    setServerFieldErrors({});
    setError(null);

    const validationErrors = getPasswordFieldErrors(
      currentPassword,
      newPassword,
      confirmPassword,
      requireCurrentPassword,
    );
    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(requireCurrentPassword ? { currentPassword } : {}),
          newPassword,
        }),
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
      setHasSubmitted(false);
      setServerFieldErrors({});
      await onPasswordChanged();
    } catch (requestError) {
      const message =
        requestError instanceof Error
          ? requestError.message
          : "Unable to change password. Please try again.";

      if (/^new password/i.test(message)) {
        setServerFieldErrors({ newPassword: message });
      } else if (/^current password/i.test(message)) {
        setServerFieldErrors({ currentPassword: message });
      } else {
        setError(message);
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  function clearServerFieldError(field: PasswordField) {
    setServerFieldErrors((currentErrors) => {
      const nextErrors = { ...currentErrors };
      delete nextErrors[field];
      return nextErrors;
    });
    setError(null);
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
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={submitPasswordChange}
    >
      <FieldGroup>
        {requireCurrentPassword && (
          <Field data-invalid={!!fieldErrors.currentPassword}>
            <FieldLabel htmlFor={currentPasswordId}>Current password</FieldLabel>
            <PasswordInput
              id={currentPasswordId}
              value={currentPassword}
              onChange={(event) => {
                setCurrentPassword(event.target.value);
                clearServerFieldError("currentPassword");
              }}
              autoComplete="current-password"
              maxLength={128}
              aria-invalid={!!fieldErrors.currentPassword}
              aria-describedby={
                fieldErrors.currentPassword
                  ? `${currentPasswordId}-error`
                  : undefined
              }
              required
              disabled={isBusy}
            />
            {fieldErrors.currentPassword && (
              <FieldError id={`${currentPasswordId}-error`}>
                {fieldErrors.currentPassword}
              </FieldError>
            )}
          </Field>
        )}
        <Field data-invalid={!!fieldErrors.newPassword}>
          <FieldLabel htmlFor={newPasswordId}>New password</FieldLabel>
          <PasswordInput
            id={newPasswordId}
            value={newPassword}
            onChange={(event) => {
              setNewPassword(event.target.value);
              clearServerFieldError("newPassword");
            }}
            autoComplete="new-password"
            maxLength={128}
            aria-invalid={!!fieldErrors.newPassword}
            aria-describedby={`${newPasswordId}-description${
              fieldErrors.newPassword ? ` ${newPasswordId}-error` : ""
            }`}
            required
            disabled={isBusy}
          />
          <FieldDescription id={`${newPasswordId}-description`}>
            Use 12–128 characters, without spaces or common passwords.
          </FieldDescription>
          {fieldErrors.newPassword && (
            <FieldError id={`${newPasswordId}-error`}>
              {fieldErrors.newPassword}
            </FieldError>
          )}
        </Field>
        <Field data-invalid={!!fieldErrors.confirmPassword}>
          <FieldLabel htmlFor={confirmPasswordId}>Confirm new password</FieldLabel>
          <PasswordInput
            id={confirmPasswordId}
            value={confirmPassword}
            onChange={(event) => {
              setConfirmPassword(event.target.value);
              clearServerFieldError("confirmPassword");
            }}
            autoComplete="new-password"
            maxLength={128}
            aria-invalid={!!fieldErrors.confirmPassword}
            aria-describedby={
              fieldErrors.confirmPassword
                ? `${confirmPasswordId}-error`
                : undefined
            }
            required
            disabled={isBusy}
          />
          {fieldErrors.confirmPassword && (
            <FieldError id={`${confirmPasswordId}-error`}>
              {fieldErrors.confirmPassword}
            </FieldError>
          )}
        </Field>
      </FieldGroup>
      {error && (
        <FieldError id="password-change-error">{error}</FieldError>
      )}
      {displayedLogoutError && (
        <FieldError>{displayedLogoutError}</FieldError>
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
              {isSigningOut ? (
                <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
              ) : null}
              {isSigningOut ? "Signing out..." : "Sign out"}
            </Button>
          )}
          <Button type="submit" className="w-full sm:w-auto" disabled={isBusy}>
            {isSubmitting ? (
              <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
            ) : null}
            {isSubmitting ? "Changing password..." : "Change password"}
          </Button>
        </DialogFooter>
      ) : (
        <div>
          <Button type="submit" disabled={isBusy}>
            {isSubmitting ? (
              <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
            ) : null}
            {isSubmitting ? "Updating password..." : "Update password"}
          </Button>
        </div>
      )}
    </form>
  );
}
