import { cn } from "cn"
import * as React from "react"
import { KeyRoundIcon, RouteIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { PasswordInput } from "@/components/password-input"

export function LoginForm({
  password,
  error,
  isLoading,
  isDefaultPassword,
  defaultPasswordHint,
  onPasswordChange,
  onSubmit,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "onSubmit"> & {
  password: string
  error?: string | null
  isLoading?: boolean
  isDefaultPassword?: boolean
  defaultPasswordHint?: string | null
  onPasswordChange: React.ChangeEventHandler<HTMLInputElement>
  onSubmit: React.FormEventHandler<HTMLFormElement>
}) {
  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card variant="elevated">
        <CardHeader>
          <div className="flex flex-col gap-5">
            <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <RouteIcon className="size-5" />
            </div>
            <div>
              <CardTitle variant="display">RawRoute</CardTitle>
              <CardDescription className="mt-2">
                A protocol-preserving gateway for your model providers.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="auth-password">Password</FieldLabel>
                <PasswordInput
                  id="auth-password"
                  value={password}
                  onChange={onPasswordChange}
                  autoComplete="current-password"
                  minLength={8}
                  maxLength={128}
                  required
                  disabled={isLoading}
                />
              </Field>
              <Field>
                <Button className="w-full" type="submit" disabled={isLoading}>
                  {isLoading ? null : <KeyRoundIcon />}
                  {isLoading ? "Signing in..." : "Sign in"}
                </Button>
                {error && <FieldError>{error}</FieldError>}
                {isDefaultPassword && (
                  <p className="text-center text-xs text-amber-600 dark:text-amber-400">
                    {defaultPasswordHint ? (
                      <>Initial password: <code className="rounded bg-muted px-1">{defaultPasswordHint}</code></>
                    ) : (
                      <>Use the initial password from <code className="rounded bg-muted px-1">AUTH_DEFAULT_PASSWORD</code> in your deployment settings.</>
                    )}
                  </p>
                )}
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
