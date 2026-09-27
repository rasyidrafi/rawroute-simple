"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDownIcon, ArrowLeftRightIcon, ArrowUpIcon, CopyIcon, ListOrderedIcon, PlusIcon, Settings2Icon, Trash2Icon } from "lucide-react";
import { Confirm, copy, notify, Page } from "@/components/dashboard/page-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { memberPolicyConfigHash, normalizeComboCustomPayload, normalizeReasoning } from "@/lib/combo-reasoning";
import { routingApi, type RoutingAliasDto, type RoutingComboDto, type RoutingDto, type RoutingMemberDto } from "@/lib/routing-client";

type Editor = "alias" | "combo" | null;
type MemberDraft = RoutingMemberDto & { uiId: string; customPayloadText: string };
type ComboDraft = { combo: string; name: string; members: MemberDraft[] };
const empty: RoutingDto = { aliases: [], combos: [], models: [], sharedModels: [] };
const memberDraft = (member: RoutingMemberDto): MemberDraft => ({ ...member, uiId: member.id ?? crypto.randomUUID(), reasoning: member.reasoning ?? { mode: "inherit" }, customPayloadText: member.customPayload ? JSON.stringify(member.customPayload, null, 2) : "" });

export function Routing({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<RoutingDto>(empty);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor>(null);
  const [editing, setEditing] = useState<RoutingAliasDto | RoutingComboDto | null>(null);
  const [alias, setAlias] = useState({ alias: "", targetModelId: "", shareId: null as string | null });
  const [combo, setCombo] = useState<ComboDraft>({ combo: "", name: "", members: [] });
  const [remove, setRemove] = useState<{ kind: "alias" | "combo"; id: string; name: string } | null>(null);
  const [confirmPolicy, setConfirmPolicy] = useState(false);
  const [pending, setPending] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setPhase("loading");
    setError(null);
    try {
      const next = await routingApi(workspaceId).list(signal);
      if (!signal?.aborted) { setData(next); setPhase("ready"); }
    } catch (reason) {
      if (!signal?.aborted) { setError(reason instanceof Error ? reason.message : "Unable to load routing."); setPhase("error"); }
    }
  }, [workspaceId]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  const directModels = data.models.map((model) => model.id);
  const sharedModels = (data.sharedModels ?? []).filter((item) => item.status === "active");
  const availableAliases = data.aliases.filter((item) => directModels.includes(item.targetModelId) || Boolean(item.shareId && sharedModels.some((share) => share.id === item.shareId))).map((item) => item.alias);
  const comboTargets = [...directModels, ...availableAliases];
  const freshMembers = () => directModels.slice(0, 2).map((target) => memberDraft({ target, reasoning: { mode: "inherit" } }));

  function openAlias(value?: RoutingAliasDto) {
    setEditing(value?.id ? value : null);
    const firstShared = sharedModels[0];
    setAlias(value ? { alias: value.alias, targetModelId: value.targetModelId, shareId: value.shareId ?? null } : { alias: "", targetModelId: directModels[0] ?? firstShared?.qualifiedModelId ?? "", shareId: directModels.length ? null : firstShared?.id ?? null });
    setEditor("alias");
  }
  function openCombo(value?: RoutingComboDto) {
    setEditing(value ?? null);
    setCombo(value ? { combo: value.combo, name: value.name, members: value.members.map(memberDraft) } : { combo: "", name: "", members: freshMembers() });
    setEditor("combo");
  }
  function serializedMembers(): { members: RoutingMemberDto[]; changedPolicy: boolean } {
    let changedPolicy = false;
    const members = combo.members.map((member) => {
      let customPayload: Record<string, unknown> | undefined;
      if (member.customPayloadText.trim()) {
        const parsed: unknown = JSON.parse(member.customPayloadText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Member ${member.position === undefined ? "" : member.position + 1} custom payload must be a JSON object.`);
        customPayload = normalizeComboCustomPayload(parsed);
      }
      const reasoning = normalizeReasoning(member.reasoning);
      const hash = memberPolicyConfigHash({ target: member.target, reasoning, customPayload });
      if ((reasoning.mode !== "inherit" || customPayload) && hash !== member.policyHash) changedPolicy = true;
      return { target: member.target, reasoning, ...(customPayload ? { customPayload } : {}), policyHash: hash };
    });
    return { members, changedPolicy };
  }
  async function saveCombo(acknowledged: boolean) {
    const { members, changedPolicy } = serializedMembers();
    if (changedPolicy && !acknowledged) { setConfirmPolicy(true); return; }
    setPending(true);
    try {
      const api = routingApi(workspaceId);
      const confirmed = await Promise.all(members.map(async (member) => {
        const changed = (member.reasoning?.mode !== "inherit" || member.customPayload) && member.policyHash !== combo.members.find((item) => item.target === member.target)?.policyHash;
        if (!changed) return member;
        const tested = await api.testDraftMember(member);
        if (tested.probe.status === "invalid") throw new Error(tested.probe.message);
        return { ...member, confirmation: tested.confirmation };
      }));
      if (editing) await api.updateCombo(editing.id, { combo: combo.combo, name: combo.name, members: confirmed });
      else await api.createCombo(combo.combo, combo.name, confirmed);
      setEditor(null); setConfirmPolicy(false); await load(); notify(editing ? "Combo updated" : "Combo created");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save combo."); }
    finally { setPending(false); }
  }
  async function save() {
    setError(null);
    if (editor === "combo") { try { await saveCombo(false); } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save combo."); } return; }
    setPending(true);
    try {
      const api = routingApi(workspaceId);
      if (editing) await api.updateAlias(editing.id, alias); else await api.createAlias(alias.alias, alias.targetModelId, alias.shareId ?? undefined);
      setEditor(null); await load(); notify(editing ? "Alias updated" : "Alias created");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save alias."); }
    finally { setPending(false); }
  }
  async function confirmDelete() {
    if (!remove) return; setPending(true);
    try { const api = routingApi(workspaceId); if (remove.kind === "alias") await api.deleteAlias(remove.id); else await api.deleteCombo(remove.id); setRemove(null); await load(); notify("Route deleted"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to delete route."); }
    finally { setPending(false); }
  }
  async function testMember(comboId: string, memberId: string) {
    setPending(true); setError(null);
    try { const result = await routingApi(workspaceId).testComboMember(comboId, memberId); await load(); notify(`Policy ${result.probe.status}: ${result.probe.message}`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to test this member policy."); }
    finally { setPending(false); }
  }
  function move(index: number, direction: -1 | 1) { setCombo((current) => { const members = [...current.members]; [members[index], members[index + direction]] = [members[index + direction]!, members[index]!]; return { ...current, members }; }); }

  return <Page>
    {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    <Card><CardHeader><CardTitle><span className="flex items-center gap-2"><ArrowLeftRightIcon />Aliases</span></CardTitle><CardDescription>Stable local IDs for enabled local or owner-approved shared models.</CardDescription><CardAction><Button onClick={() => openAlias()} disabled={phase === "loading" || (!directModels.length && !sharedModels.length)}><PlusIcon />Add alias</Button></CardAction></CardHeader><CardContent><RouteTable phase={phase} empty="No aliases yet." headers={["Gateway ID", "Target model"]}>{data.aliases.map((item) => <TableRow key={item.id}><TableCell><code>{item.alias}</code></TableCell><TableCell><code>{item.targetModelId}</code></TableCell><Actions name={item.alias} onCopy={() => copy(item.alias, "Copied", { page: "routing", workspaceId })} onEdit={() => openAlias(item)} onDelete={() => setRemove({ kind: "alias", id: item.id, name: item.alias })} /></TableRow>)}</RouteTable></CardContent></Card>
    <Card><CardHeader><CardTitle><span className="flex items-center gap-2"><ListOrderedIcon />Combos</span></CardTitle><CardDescription>Try 2–8 unique enabled models or aliases in saved order.</CardDescription><CardAction><Button onClick={() => openCombo()} disabled={phase === "loading" || comboTargets.length < 2}><PlusIcon />Add combo</Button></CardAction></CardHeader><CardContent><RouteTable phase={phase} empty="No combos yet." headers={["Gateway ID", "Fallback order"]}>{data.combos.map((item) => <TableRow key={item.id}><TableCell><code>{item.combo}</code><p className="text-xs text-muted-foreground">{item.name}</p></TableCell><TableCell><ol className="flex flex-col gap-1">{item.members.map((member, index) => <li key={member.id ?? `${item.id}:${index}`}><code>{(member.position ?? index) + 1}. {member.target}</code>{member.validationState === "unverified" && <Badge className="ml-2" variant="outline">Policy unverified</Badge>}{member.validationState === "verified" && <Badge className="ml-2" variant="secondary">Policy verified</Badge>}{member.validationState === "invalid" && <Badge className="ml-2" variant="destructive">Policy invalid</Badge>}{member.id && (member.reasoning?.mode !== "inherit" || member.customPayload) && <Button className="ml-2" size="xs" variant="outline" disabled={pending} onClick={() => void testMember(item.id, member.id!)}>Test</Button>}</li>)}</ol></TableCell><Actions name={item.combo} onCopy={() => copy(item.combo, "Copied", { page: "routing", workspaceId })} onEdit={() => openCombo(item)} onDelete={() => setRemove({ kind: "combo", id: item.id, name: item.combo })} /></TableRow>)}</RouteTable></CardContent></Card>
    <Card><CardHeader><CardTitle><span className="flex items-center gap-2">Shared models</span></CardTitle><CardDescription>Owner-approved models can only be used through a local alias.</CardDescription></CardHeader><CardContent>{sharedModels.length ? <div className="flex flex-col gap-2">{sharedModels.map((share) => <div className="flex items-center justify-between gap-3" key={share.id}><span><code>{share.qualifiedModelId}</code><span className="ml-2 text-sm text-muted-foreground">{share.ownerWorkspaceName}</span></span><Button size="sm" variant="outline" onClick={() => openAlias({ id: "", workspaceId, alias: "", targetModelId: share.qualifiedModelId, shareId: share.id, createdAt: Date.now(), updatedAt: Date.now() })}>Create alias</Button></div>)}</div> : <p className="text-sm text-muted-foreground">No active model grants.</p>}</CardContent></Card>
    <RouteEditor editor={editor} editing={editing} alias={alias} setAlias={setAlias} combo={combo} setCombo={setCombo} directModels={directModels} sharedModels={sharedModels} aliases={availableAliases} pending={pending} error={error} onMove={move} onClose={() => setEditor(null)} onSave={save} />
    <Confirm open={Boolean(remove)} onOpenChange={(open) => !open && setRemove(null)} title={`Delete ${remove?.name}?`} description="This local route will no longer resolve." onConfirm={() => void confirmDelete()} pending={pending} error={error} />
    <Confirm open={confirmPolicy} onOpenChange={setConfirmPolicy} title="Save unverified policy?" description="RawRoute will store this changed policy as unverified. Upstream validation is not available until the execution slice." onConfirm={() => void saveCombo(true)} pending={pending} error={error} />
  </Page>;
}

function RouteTable({ phase, empty, headers, children }: { phase: string; empty: string; headers: string[]; children: React.ReactNode }) {
  const hasRows = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return <Table><TableHeader><TableRow>{headers.map((header) => <TableHead key={header}>{header}</TableHead>)}<TableHead className="text-right">Actions</TableHead></TableRow></TableHeader><TableBody>{phase === "loading" ? <TableRow><TableCell colSpan={headers.length + 1}>Loading routing…</TableCell></TableRow> : hasRows ? children : <TableRow><TableCell colSpan={headers.length + 1}>{empty}</TableCell></TableRow>}</TableBody></Table>;
}
function Actions({ name, onCopy, onEdit, onDelete }: { name: string; onCopy: () => void; onEdit: () => void; onDelete: () => void }) {
  return <TableCell className="text-right"><Button size="icon-sm" variant="ghost" aria-label={`Copy ${name}`} onClick={onCopy}><CopyIcon /></Button><Button size="icon-sm" variant="ghost" aria-label={`Edit ${name}`} onClick={onEdit}><Settings2Icon /></Button><Button size="icon-sm" variant="ghost" aria-label={`Delete ${name}`} onClick={onDelete}><Trash2Icon /></Button></TableCell>;
}
function RouteEditor({ editor, editing, alias, setAlias, combo, setCombo, directModels, sharedModels, aliases, pending, error, onMove, onClose, onSave }: { editor: Editor; editing: RoutingAliasDto | RoutingComboDto | null; alias: { alias: string; targetModelId: string; shareId: string | null }; setAlias: React.Dispatch<React.SetStateAction<{ alias: string; targetModelId: string; shareId: string | null }>>; combo: ComboDraft; setCombo: React.Dispatch<React.SetStateAction<ComboDraft>>; directModels: string[]; sharedModels: NonNullable<RoutingDto["sharedModels"]>; aliases: string[]; pending: boolean; error: string | null; onMove: (index: number, direction: -1 | 1) => void; onClose: () => void; onSave: () => void }) {
  const targets = [...directModels, ...aliases];
  const update = (index: number, change: Partial<MemberDraft>) => setCombo((current) => ({ ...current, members: current.members.map((member, memberIndex) => memberIndex === index ? { ...member, ...change } : member) }));
  const add = () => { const target = targets.find((value) => !combo.members.some((member) => member.target === value)); if (target) setCombo((current) => ({ ...current, members: [...current.members, memberDraft({ target, reasoning: { mode: "inherit" } })] })); };
  return <Dialog open={editor !== null} onOpenChange={() => undefined}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto"><div><DialogHeader><DialogTitle>{editing ? "Edit" : "Create"} {editor}</DialogTitle><DialogDescription>{editor === "combo" ? "Configure ordered members and their persisted reasoning/custom-payload policy." : "Aliases target an enabled local model or an owner-approved shared grant."}</DialogDescription></DialogHeader><FieldGroup className="py-4">{editor === "alias" ? <><Field><FieldLabel htmlFor="alias-id">Gateway ID</FieldLabel><Input id="alias-id" value={alias.alias} onChange={(event) => setAlias((value) => ({ ...value, alias: event.target.value }))} /></Field><Field><FieldLabel>Target model</FieldLabel><Select value={alias.targetModelId} onValueChange={(value) => { const shared = sharedModels.find((item) => item.qualifiedModelId === value); if (value) setAlias((current) => ({ ...current, targetModelId: value, shareId: shared?.id ?? null })); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{directModels.map((target) => <SelectItem value={target} key={target}>{target}</SelectItem>)}</SelectGroup>{sharedModels.length > 0 && <SelectGroup>{sharedModels.map((target) => <SelectItem value={target.qualifiedModelId} key={target.id}>{target.qualifiedModelId} · {target.ownerWorkspaceName}</SelectItem>)}</SelectGroup>}</SelectContent></Select></Field></> : <ComboFields combo={combo} directModels={directModels} aliases={aliases} update={update} add={add} onMove={onMove} setCombo={setCombo} />}</FieldGroup>{error && <p className="text-sm text-destructive" role="alert">{error}</p>}<DialogFooter><Button type="button" variant="outline" onClick={onClose} disabled={pending}>Cancel</Button><Button type="button" onClick={onSave} disabled={pending || (editor === "alias" ? !alias.alias || !alias.targetModelId : !combo.combo || !combo.name || combo.members.length < 2)}>{pending ? "Saving…" : editing ? "Save" : "Create"}</Button></DialogFooter></div></DialogContent></Dialog>;
}
function ComboFields({ combo, directModels, aliases, update, add, onMove, setCombo }: { combo: ComboDraft; directModels: string[]; aliases: string[]; update: (index: number, change: Partial<MemberDraft>) => void; add: () => void; onMove: (index: number, direction: -1 | 1) => void; setCombo: React.Dispatch<React.SetStateAction<ComboDraft>> }) {
  return <><Field><FieldLabel htmlFor="combo-id">Gateway ID</FieldLabel><Input id="combo-id" value={combo.combo} onChange={(event) => setCombo((value) => ({ ...value, combo: event.target.value }))} /></Field><Field><FieldLabel htmlFor="combo-name">Name</FieldLabel><Input id="combo-name" value={combo.name} onChange={(event) => setCombo((value) => ({ ...value, name: event.target.value }))} /></Field>{combo.members.map((member, index) => <Field key={member.uiId}><FieldLabel>Member {index + 1}</FieldLabel><div className="flex gap-2"><Select value={member.target} onValueChange={(target) => target && update(index, { target })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{directModels.map((target) => <SelectItem value={target} key={target} disabled={combo.members.some((item, itemIndex) => itemIndex !== index && item.target === target)}>{target}</SelectItem>)}</SelectGroup>{aliases.length > 0 && <SelectGroup><SelectItem value="__aliases_header" disabled>Aliases</SelectItem>{aliases.map((target) => <SelectItem value={target} key={target} disabled={combo.members.some((item, itemIndex) => itemIndex !== index && item.target === target)}>{target}</SelectItem>)}</SelectGroup>}</SelectContent></Select><Button type="button" size="icon-sm" variant="ghost" aria-label={`Move member ${index + 1} up`} disabled={index === 0} onClick={() => onMove(index, -1)}><ArrowUpIcon /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`Move member ${index + 1} down`} disabled={index === combo.members.length - 1} onClick={() => onMove(index, 1)}><ArrowDownIcon /></Button></div><Field><FieldLabel>Reasoning</FieldLabel><Select value={member.reasoning?.mode ?? "inherit"} onValueChange={(mode) => mode && update(index, { reasoning: mode === "override" ? { mode: "override", effort: member.reasoning?.effort ?? "medium" } : { mode: mode as "inherit" | "default" } })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="inherit">Inherit request</SelectItem><SelectItem value="default">Provider default</SelectItem><SelectItem value="override">Override</SelectItem></SelectGroup></SelectContent></Select></Field>{member.reasoning?.mode === "override" && <Field><FieldLabel htmlFor={`effort-${member.uiId}`}>Reasoning effort</FieldLabel><Input id={`effort-${member.uiId}`} value={member.reasoning.effort ?? ""} onChange={(event) => update(index, { reasoning: { mode: "override", effort: event.target.value } })} /></Field>}<Field><FieldLabel htmlFor={`payload-${member.uiId}`}>Custom JSON payload</FieldLabel><Textarea id={`payload-${member.uiId}`} value={member.customPayloadText} onChange={(event) => update(index, { customPayloadText: event.target.value })} placeholder='{"extra_body":{"temperature":0.2}}' /><FieldDescription>Protected request fields are rejected. Changed policies require confirmation and remain unverified.</FieldDescription></Field></Field>)}<div className="flex gap-2"><Button type="button" variant="outline" disabled={combo.members.length >= 8 || combo.members.length >= directModels.length + aliases.length} onClick={add}>Add member</Button><Button type="button" variant="ghost" disabled={combo.members.length <= 2} onClick={() => setCombo((current) => ({ ...current, members: current.members.slice(0, -1) }))}>Remove last</Button></div></>;
}
