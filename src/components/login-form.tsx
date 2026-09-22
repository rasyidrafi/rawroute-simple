import { cn } from "cn"
import * as React from "react"

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
import { Input } from "@/components/ui/input"

export function LoginForm({
  password,
  error,
  isLoading,
  defaultPasswordHint,
  onPasswordChange,
  onSubmit,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "onSubmit"> & {
  password: string
  error?: string | null
  isLoading?: boolean
  defaultPasswordHint?: string | null
  onPasswordChange: React.ChangeEventHandler<HTMLInputElement>
  onSubmit: React.FormEventHandler<HTMLFormElement>
}) {
  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader>
          <CardTitle>Welcome back</CardTitle>
          <CardDescription>Enter your password to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="auth-password">Password</FieldLabel>
                <Input
                  id="auth-password"
                  type="password"
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
                <Button type="submit" disabled={isLoading}>
                  {isLoading ? "Signing in..." : "Sign in"}
                </Button>
                {error && <FieldError>{error}</FieldError>}
                {defaultPasswordHint && (
                  <p className="text-center text-xs text-amber-600 dark:text-amber-400">
                    Default password: <code className="rounded bg-muted px-1">{defaultPasswordHint}</code>
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
