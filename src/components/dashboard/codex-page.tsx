"use client";

import { useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, ExternalLinkIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Confirm, notify, Page } from "@/components/dashboard/page-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CodexModel } from "@/mock/dashboard-data";

export function CodexProviders({
  models,
  setModels,
}: {
  models: CodexModel[];
  setModels: React.Dispatch<React.SetStateAction<CodexModel[]>>;
}) {
  const [accounts, setAccounts] = useState([
    {
      id: "codex-work",
      name: "Work Codex",
      plan: "Team",
      enabled: true,
      quota: 62,
    },
    {
      id: "codex-personal",
      name: "Personal Codex",
      plan: "Plus",
      enabled: true,
      quota: 28,
    },
  ]);
  const [connect, setConnect] = useState(false);
  const [remove, setRemove] = useState<string | null>(null);
  return (
    <Page>
      <Card>
        <CardHeader>
          <CardTitle>Codex Providers</CardTitle>
          <CardDescription>
            OAuth-backed Codex accounts use fill-first priority and report mock
            quota windows.
          </CardDescription>
          <CardAction>
            <Button onClick={() => setConnect(true)}>
              <PlusIcon />
              Add Codex account
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Priority</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Quota</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((account, index) => (
                <TableRow
                  key={account.id}
                  style={!account.enabled ? { opacity: 0.6 } : undefined}
                >
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Move ${account.name} up`}
                        disabled={index === 0}
                        onClick={() =>
                          setAccounts((items) => {
                            const next = [...items];
                            [next[index - 1], next[index]] = [
                              next[index],
                              next[index - 1],
                            ];
                            return next;
                          })
                        }
                      >
                        <ArrowUpIcon />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Move ${account.name} down`}
                        disabled={index === accounts.length - 1}
                        onClick={() =>
                          setAccounts((items) => {
                            const next = [...items];
                            [next[index + 1], next[index]] = [
                              next[index],
                              next[index + 1],
                            ];
                            return next;
                          })
                        }
                      >
                        <ArrowDownIcon />
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="font-medium">{account.name}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{account.plan}</Badge>
                  </TableCell>
                  <TableCell className="min-w-36">
                    <div className="mb-1 flex justify-between text-xs">
                      <span>Weekly</span>
                      <span>{account.quota}% left</span>
                    </div>
                    <Progress value={account.quota} />
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={account.enabled}
                      onCheckedChange={(enabled) =>
                        setAccounts((items) =>
                          items.map((item) =>
                            item.id === account.id
                              ? { ...item, enabled }
                              : item,
                          ),
                        )
                      }
                      aria-label={`Enable ${account.name}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={account.quota > 0}
                        onClick={() =>
                          notify("Codex reset credit redeemed")
                        }
                      >
                        Redeem
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove ${account.name}`}
                        onClick={() => setRemove(account.id)}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Built-in Codex models</CardTitle>
          <CardDescription>
            Toggle default model mappings used by connected accounts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {models.slice(0, 3).map((model) => (
              <div
                className="flex items-center justify-between rounded-lg border p-3"
                key={model.id}
              >
                <span>
                  <span className="block font-medium">{model.name}</span>
                  <code className="text-xs text-muted-foreground">
                    {model.id}
                  </code>
                </span>
                <Switch
                  checked={model.enabled}
                  onCheckedChange={(checked) =>
                    setModels((items) =>
                      items.map((item) =>
                        item.id === model.id
                          ? { ...item, enabled: checked }
                          : item,
                      ),
                    )
                  }
                  aria-label={`Enable ${model.name}`}
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Dialog open={connect} onOpenChange={setConnect}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect Codex account</DialogTitle>
            <DialogDescription>
              No external OAuth session is opened. Complete this action to add a
              demo account to the local mock list.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Button
              variant="outline"
              onClick={() => notify("Mock device authorization started", "info")}
            >
              <ExternalLinkIcon />
              Open Codex sign-in
            </Button>
            <Input
              aria-label="Optional redirect URL reference"
              placeholder="http://localhost:1455/auth/callback?code=..."
            />
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setConnect(false);
                setAccounts((items) => [
                  ...items,
                  {
                    id: crypto.randomUUID(),
                    name: "New Codex account",
                    plan: "Plus",
                    enabled: true,
                    quota: 100,
                  },
                ]);
                notify("Codex account connected");
              }}
            >
              Add demo account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Confirm
        open={Boolean(remove)}
        onOpenChange={(open) => !open && setRemove(null)}
        title="Remove Codex account?"
        description="This removes only local mock account data."
        onConfirm={() => {
          if (remove)
            setAccounts((items) => items.filter((item) => item.id !== remove));
          setRemove(null);
          notify("Codex account removed");
        }}
      />
    </Page>
  );
}
