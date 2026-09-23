"use client";

import { KeyRoundIcon } from "lucide-react";
import { Page } from "@/components/dashboard/page-ui";
import { PasswordChangeForm } from "@/components/dashboard/password-change-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Props = {
  onPasswordChanged: () => void | Promise<void>;
};

export function Settings({ onPasswordChanged }: Props) {
  return (
    <Page>
      <div className="max-w-2xl">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <KeyRoundIcon className="size-5" />
              <CardTitle>Admin password</CardTitle>
            </div>
            <CardDescription>
              Change the password used to sign in to this administrator
              account. You will need to authenticate again after it changes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PasswordChangeForm onPasswordChanged={onPasswordChanged} />
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}
