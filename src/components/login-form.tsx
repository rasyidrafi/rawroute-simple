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
      <Card className="border-border/70 shadow-2xl shadow-slate-950/10">
        <CardHeader className="space-y-5">
          <div className="flex size-11 items-center justify-center rounded-xl bg-slate-950 text-white dark:bg-slate-100 dark:text-slate-950">
            <RouteIcon className="size-5" />
          </div>
          <div>
            <CardTitle className="text-2xl">RawRoute</CardTitle>
            <CardDescription className="mt-2">
              A protocol-preserving gateway for your model providers.
            </CardDescription>
          </div>
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
                <Button className="w-full" type="submit" disabled={isLoading}>
                  {isLoading ? null : <KeyRoundIcon />}
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
