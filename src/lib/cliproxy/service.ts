import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import * as lockfile from "proper-lockfile";
import {
  extractVerifiedBinary,
  fetchVerifiedBinary,
  getAvailableVersions,
  normalizeVersion,
  type AvailableVersions,
} from "./release";

export const CLIPROXY_HOST = "127.0.0.1";
export const CLIPROXY_PORT = 8317;
const EXECUTABLE_NAME = "cli-proxy-api";
const TERM_TIMEOUT_MS = 5_000;
const STARTUP_TIMEOUT_MS = 30_000;
const MAX_RESTARTS = 5;
const RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
export const CLIPROXY_LOCK_TIMING = {
  staleMs: 120_000,
  updateMs: 10_000,
  retryIntervalMs: 500,
  recoveryMarginMs: 30_000,
  retryAttempts: 300,
} as const;

interface PersistentState {
  schemaVersion: 1;
  desiredRunning: boolean;
  installedVersion: string | null;
  pinnedVersion: string | null;
}

interface ProcessRecord {
  pid: number;
  startTime: string;
  executablePath: string;
  version: string;
  managerPid: number;
  managerStartTime: string;
  managerExecutablePath: string;
  startedAt: string;
}

interface ManagerRecord {
  pid: number;
  startTime: string;
  executablePath: string;
}

interface UpdateTransaction {
  fromVersion: string | null;
  toVersion: string;
  previousPin: string | null;
  previousDesiredRunning?: boolean;
}

interface ServicePaths {
  root: string;
  versions: string;
  current: string;
  config: string;
  auth: string;
  apiKey: string;
  managementKey: string;
  state: string;
  process: string;
  manager: string;
  transaction: string;
  lock: string;
}

export type CliproxyOperationName =
  | "initializing"
  | "installing"
  | "starting"
  | "stopping"
  | "restarting";

export interface CliproxyOperation {
  name: CliproxyOperationName;
  startedAt: string;
}

export interface CliproxyStatus {
  installed: boolean;
  version: string | null;
  pinnedVersion: string | null;
  desiredRunning: boolean;
  processRunning: boolean;
  healthy: boolean;
  conflict: boolean;
  operation: CliproxyOperation | null;
  restartAttempts: number;
  lastError: string | null;
}

export interface CliproxyVersions extends AvailableVersions {
  current: string | null;
  pinned: string | null;
}

export type CliproxyStartupAction = "idle" | "start" | "missing-install";

interface PortListeners {
  ownersByInode: Map<string, Set<number>>;
  addressesByInode: Map<string, Set<string>>;
}

type ChildProcess = Bun.Subprocess;

const dataRoot = getDataRoot();
const paths = getServicePaths(dataRoot);
let activeProcess: ChildProcess | undefined;
let activeRecord: ProcessRecord | undefined;
const operationQueue: CliproxyOperation[] = [];
let lastError: string | null = null;
let shuttingDown = false;
let restartAttempts = 0;
let restartGeneration = 0;
let restartTask: Promise<void> | undefined;
let pendingRestart: { record: ProcessRecord; exitCode: number; generation: number } | undefined;
const intentionalExits = new Set<number>();

export function getDataRoot(rawRouteDataDir = process.env.RAWROUTE_DATA_DIR): string {
  return path.resolve(rawRouteDataDir || path.join(homedir(), ".local/share/rawroute"));
}

export function getStartupAction(
  desiredRunning: boolean,
  hasInstalledVersion: boolean
): CliproxyStartupAction {
  if (!desiredRunning) return "idle";
  return hasInstalledVersion ? "start" : "missing-install";
}

export function shouldStartAfterInstall(
  desiredRunning: boolean,
  previouslyInstalled: boolean
): boolean {
  return desiredRunning || !previouslyInstalled;
}

function getServicePaths(root: string): ServicePaths {
  const serviceRoot = path.join(root, "cliproxy");
  return {
    root: serviceRoot,
    versions: path.join(serviceRoot, "versions"),
    current: path.join(serviceRoot, "current"),
    config: path.join(serviceRoot, "config.yaml"),
    auth: path.join(serviceRoot, "auth"),
    apiKey: path.join(serviceRoot, "secrets", "api-key"),
    managementKey: path.join(serviceRoot, "secrets", "management-key"),
    state: path.join(serviceRoot, "state.json"),
    process: path.join(serviceRoot, "child.json"),
    manager: path.join(serviceRoot, "manager.json"),
    transaction: path.join(serviceRoot, "update-transaction.json"),
    lock: path.join(serviceRoot, "lifecycle-lock"),
  };
}

export function renderConfig(apiKey: string, managementKey: string, authDir: string): string {
  const quote = (value: string) => JSON.stringify(value);
  return [
    `host: ${quote(CLIPROXY_HOST)}`,
    `port: ${CLIPROXY_PORT}`,
    "debug: false",
    "remote-management:",
    "  allow-remote: false",
    `  secret-key: ${quote(managementKey)}`,
    "  disable-control-panel: true",
    "api-keys:",
    `  - ${quote(apiKey)}`,
    `auth-dir: ${quote(authDir)}`,
    "",
  ].join("\n");
}

export function parseProcStartTime(statContents: string): string | null {
  const closingParen = statContents.lastIndexOf(")");
  if (closingParen < 0) return null;
  const fieldsAfterCommand = statContents.slice(closingParen + 1).trim().split(/\s+/);
  return fieldsAfterCommand[19] || null;
}

export function parseListeningSockets(
  contents: string,
  port: number,
  family: "ipv4" | "ipv6"
): Array<{ inode: string; address: string }> {
  const listeners: Array<{ inode: string; address: string }> = [];
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  for (const line of contents.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== "0A") continue;
    const separator = fields[1].lastIndexOf(":");
    const addressHex = fields[1].slice(0, separator).toUpperCase();
    const localPort = fields[1].slice(separator + 1).toUpperCase();
    if (localPort !== portHex || !/^\d+$/.test(fields[9])) continue;
    const address = family === "ipv4" ? decodeProcIpv4Address(addressHex) : `ipv6:${addressHex}`;
    listeners.push({ inode: fields[9], address });
  }
  return listeners;
}

export function areAllLoopbackListeners(addresses: Iterable<string>): boolean {
  const listenerAddresses = [...addresses];
  return listenerAddresses.length > 0 && listenerAddresses.every((address) => address === CLIPROXY_HOST);
}

export function validateLoopbackConfig(contents: string): void {
  const rootHostLines = contents.split(/\r?\n/).filter(isRootHostSetting);
  if (rootHostLines.length !== 1) {
    throw new Error("CLIProxy config must contain exactly one root host setting");
  }
  const scalar = rootHostLines[0].slice(rootHostLines[0].indexOf(":") + 1);
  const match = scalar.match(
    /^\s*(?:"([^"\\]*)"|'([^']*)'|([^#\s]+))\s*(?:#.*)?$/
  );
  const configuredHost = match?.[1] ?? match?.[2] ?? match?.[3];
  if (configuredHost !== CLIPROXY_HOST) {
    throw new Error(`CLIProxy config host must be ${CLIPROXY_HOST}`);
  }
}

function isRootHostSetting(line: string): boolean {
  if (/^---(?:\s|$)/.test(line) || /^\s*(?:#|$)/.test(line)) return false;
  if (/^[?!*&]/.test(line)) {
    throw new Error("CLIProxy config uses unsupported root mapping key syntax");
  }
  if (/^host\s*:/.test(line)) return true;
  const doubleQuoted = line.match(/^"((?:[^"\\]|\\.)*)"\s*:/);
  if (doubleQuoted) {
    if (doubleQuoted[1].includes("\\")) {
      throw new Error("CLIProxy config uses an escaped root mapping key");
    }
    return doubleQuoted[1] === "host";
  }
  const singleQuoted = line.match(/^'((?:[^']|'')*)'\s*:/);
  return singleQuoted?.[1].replace(/''/g, "'") === "host";
}

function decodeProcIpv4Address(addressHex: string): string {
  if (!/^[a-f\d]{8}$/i.test(addressHex)) return `invalid:${addressHex}`;
  const bytes = addressHex.match(/../g);
  return bytes ? bytes.reverse().map((byte) => Number.parseInt(byte, 16)).join(".") : "invalid";
}

function ensureLayout(): void {
  for (const directory of [paths.root, paths.versions, path.dirname(paths.apiKey), paths.auth]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const metadata = fs.lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`CLIProxy state directory is not a private directory: ${path.basename(directory)}`);
    }
    fs.chmodSync(directory, 0o700);
  }
}

function writeAtomic(filePath: string, contents: string, mode = 0o600): void {
  if (fs.existsSync(filePath) || isSymlink(filePath)) {
    const metadata = fs.lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Refusing to replace a non-regular CLIProxy state file: ${path.basename(filePath)}`);
    }
  }
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, contents, { encoding: "utf8", mode });
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, filePath);
}

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const metadata = fs.lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("not a regular file");
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    throw new Error(`CLIProxy state file is invalid: ${path.basename(filePath)}`);
  }
}

function defaultState(): PersistentState {
  return {
    schemaVersion: 1,
    desiredRunning: false,
    installedVersion: null,
    pinnedVersion: null,
  };
}

function readState(): PersistentState {
  const state = readJson<PersistentState>(paths.state);
  if (!state) return defaultState();
  if (
    state.schemaVersion !== 1 ||
    typeof state.desiredRunning !== "boolean" ||
    !(state.installedVersion === null || typeof state.installedVersion === "string") ||
    !(state.pinnedVersion === null || typeof state.pinnedVersion === "string")
  ) {
    throw new Error("CLIProxy state file has an unsupported format");
  }
  if (state.installedVersion) state.installedVersion = normalizeVersion(state.installedVersion);
  if (state.pinnedVersion) state.pinnedVersion = normalizeVersion(state.pinnedVersion);
  return state;
}

function writeState(state: PersistentState): void {
  writeAtomic(paths.state, `${JSON.stringify(state, null, 2)}\n`);
}

function createSecret(filePath: string): string {
  if (fs.existsSync(filePath)) {
    const metadata = fs.lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("CLIProxy secret path is not a regular file");
    }
    fs.chmodSync(filePath, 0o600);
    const secret = fs.readFileSync(filePath, "utf8").trim();
    if (secret.length < 32) throw new Error("CLIProxy persisted secret is invalid");
    return secret;
  }
  const secret = randomBytes(32).toString("base64url");
  writeAtomic(filePath, `${secret}\n`);
  return secret;
}

function ensureConfig(): void {
  const configExists = fs.existsSync(paths.config);
  if (configExists) {
    const metadata = fs.lstatSync(paths.config);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("CLIProxy config path is not a regular file");
    }
  }
  const apiKeyExists = fs.existsSync(paths.apiKey);
  const managementKeyExists = fs.existsSync(paths.managementKey);
  if (configExists && (!apiKeyExists || !managementKeyExists)) {
    throw new Error("CLIProxy config exists but its persisted secrets are missing");
  }
  const apiKey = createSecret(paths.apiKey);
  const managementKey = createSecret(paths.managementKey);
  if (!configExists) {
    writeAtomic(paths.config, renderConfig(apiKey, managementKey, paths.auth));
  } else {
    fs.chmodSync(paths.config, 0o600);
  }
  validateLoopbackConfig(fs.readFileSync(paths.config, "utf8"));
}

function currentVersion(): string | null {
  if (!fs.existsSync(paths.current) && !isSymlink(paths.current)) return null;
  const target = fs.readlinkSync(paths.current);
  const match = target.match(/^versions\/(.+)$/);
  if (!match) throw new Error("CLIProxy current link points outside its version directory");
  const version = normalizeVersion(match[1]);
  return isInstalledVersion(version) ? version : null;
}

function isSymlink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function isInstalledVersion(version: string): boolean {
  try {
    const versionDir = path.join(paths.versions, version);
    const directory = fs.lstatSync(versionDir);
    const executable = fs.lstatSync(path.join(versionDir, EXECUTABLE_NAME));
    return directory.isDirectory() && !directory.isSymbolicLink() && executable.isFile();
  } catch {
    return false;
  }
}

function setCurrentVersion(version: string): void {
  const normalized = normalizeVersion(version);
  if (!isInstalledVersion(normalized)) throw new Error("CLIProxy version is not installed");
  if (fs.existsSync(paths.current) && !isSymlink(paths.current)) {
    throw new Error("CLIProxy current path exists and is not an owned symlink");
  }
  const temporary = path.join(paths.root, `current.${randomUUID()}`);
  fs.symlinkSync(path.join("versions", normalized), temporary);
  fs.renameSync(temporary, paths.current);
}

function removeCurrentVersion(expectedVersion: string): void {
  if (!isSymlink(paths.current)) return;
  if (fs.readlinkSync(paths.current) === path.join("versions", expectedVersion)) {
    fs.unlinkSync(paths.current);
  }
}

function readProcIdentity(pid: number): { startTime: string; executablePath: string } | null {
  try {
    const startTime = parseProcStartTime(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
    const executablePath = fs.readlinkSync(`/proc/${pid}/exe`);
    if (!startTime || executablePath.endsWith(" (deleted)")) return null;
    return { startTime, executablePath: path.resolve(executablePath) };
  } catch {
    return null;
  }
}

function getSelfIdentity(): ManagerRecord {
  const identity = readProcIdentity(process.pid);
  if (!identity) throw new Error("Unable to fingerprint the Bun process through /proc");
  return { pid: process.pid, ...identity };
}

function recordIdentityMatches(record: Pick<ProcessRecord, "pid" | "startTime" | "executablePath">): boolean {
  const actual = readProcIdentity(record.pid);
  return Boolean(
    actual &&
      actual.startTime === record.startTime &&
      actual.executablePath === path.resolve(record.executablePath)
  );
}

function managerIsAlive(record: ManagerRecord): boolean {
  return recordIdentityMatches(record);
}

function isManagedBinaryPath(executablePath: string): boolean {
  const relative = path.relative(paths.versions, executablePath);
  const parts = relative.split(path.sep);
  if (parts.length !== 2 || parts[1] !== EXECUTABLE_NAME) return false;
  try {
    return normalizeVersion(parts[0]) === parts[0];
  } catch {
    return false;
  }
}

function readPortListeners(port = CLIPROXY_PORT): PortListeners {
  const addressesByInode = new Map<string, Set<string>>();
  for (const [table, family] of [
    ["/proc/net/tcp", "ipv4"],
    ["/proc/net/tcp6", "ipv6"],
  ] as const) {
    try {
      const contents = fs.readFileSync(table, "utf8");
      for (const listener of parseListeningSockets(contents, port, family)) {
        const addresses = addressesByInode.get(listener.inode) ?? new Set<string>();
        addresses.add(listener.address);
        addressesByInode.set(listener.inode, addresses);
      }
    } catch {
      continue;
    }
  }

  const ownersByInode = new Map<string, Set<number>>(
    [...addressesByInode.keys()].map((inode) => [inode, new Set<number>()])
  );
  if (addressesByInode.size === 0) return { ownersByInode, addressesByInode };

  let processEntries: fs.Dirent[];
  try {
    processEntries = fs.readdirSync("/proc", { withFileTypes: true });
  } catch {
    return { ownersByInode, addressesByInode };
  }
  for (const entry of processEntries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    let descriptors: string[];
    try {
      descriptors = fs.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const descriptor of descriptors) {
      try {
        const target = fs.readlinkSync(`/proc/${pid}/fd/${descriptor}`);
        const match = target.match(/^socket:\[(\d+)\]$/);
        const owners = match ? ownersByInode.get(match[1]) : undefined;
        owners?.add(pid);
      } catch {
        continue;
      }
    }
  }
  return { ownersByInode, addressesByInode };
}

function listenersOwnedBy(record: ProcessRecord, listeners = readPortListeners()): boolean {
  const inodes = [...listeners.ownersByInode.entries()];
  return (
    inodes.length > 0 &&
    inodes.every((entry) => entry[1].size === 1 && entry[1].has(record.pid))
  );
}

function listenersLoopbackOnly(listeners = readPortListeners()): boolean {
  const addresses = [...listeners.addressesByInode.entries()];
  return (
    addresses.length > 0 &&
    addresses.every((entry) => entry[1].size === 1 && areAllLoopbackListeners(entry[1]))
  );
}

function listenersSecurelyOwnedBy(record: ProcessRecord, listeners = readPortListeners()): boolean {
  return listenersOwnedBy(record, listeners) && listenersLoopbackOnly(listeners);
}

function listenerPortIsBusy(listeners = readPortListeners()): boolean {
  return listeners.ownersByInode.size > 0;
}

function readProcessRecord(): ProcessRecord | null {
  const record = readJson<ProcessRecord>(paths.process);
  if (!record) return null;
  if (
    !Number.isSafeInteger(record.pid) ||
    typeof record.startTime !== "string" ||
    typeof record.executablePath !== "string" ||
    typeof record.version !== "string" ||
    !isManagedBinaryPath(record.executablePath)
  ) {
    throw new Error("CLIProxy child ownership record is invalid");
  }
  record.version = normalizeVersion(record.version);
  return record;
}

function readManagerRecord(): ManagerRecord | null {
  const record = readJson<ManagerRecord>(paths.manager);
  if (!record) return null;
  if (
    !Number.isSafeInteger(record.pid) ||
    typeof record.startTime !== "string" ||
    typeof record.executablePath !== "string"
  ) {
    throw new Error("CLIProxy manager ownership record is invalid");
  }
  return record;
}

function removeProcessRecord(record: ProcessRecord): void {
  const latest = readProcessRecord();
  if (latest?.pid === record.pid && latest.startTime === record.startTime) {
    fs.rmSync(paths.process, { force: true });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPidExit(record: ProcessRecord, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!recordIdentityMatches(record)) return true;
    await delay(100);
  }
  return !recordIdentityMatches(record);
}

async function stopRecord(record: ProcessRecord, requirePortOwnership: boolean): Promise<void> {
  if (!recordIdentityMatches(record) || !isManagedBinaryPath(record.executablePath)) return;
  if (requirePortOwnership && !listenersOwnedBy(record)) {
    throw new Error("Refusing to stop a CLIProxy process without verified port ownership");
  }
  try {
    process.kill(record.pid, "SIGTERM");
  } catch (error) {
    if (!isMissingProcessError(error)) throw error;
  }
  if (await waitForPidExit(record, TERM_TIMEOUT_MS)) return;
  if (!recordIdentityMatches(record)) return;
  try {
    process.kill(record.pid, "SIGKILL");
  } catch (error) {
    if (!isMissingProcessError(error)) throw error;
  }
  if (!(await waitForPidExit(record, TERM_TIMEOUT_MS))) {
    throw new Error("CLIProxy process did not exit after SIGKILL");
  }
}

function isMissingProcessError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
}

async function reconcileStaleChild(): Promise<void> {
  const record = readProcessRecord();
  if (!record) return;
  if (!recordIdentityMatches(record)) {
    removeProcessRecord(record);
    return;
  }

  let listeners = readPortListeners();
  if (!listenersOwnedBy(record, listeners) && !listenerPortIsBusy(listeners)) {
    const settleUntil = Date.now() + 2_000;
    while (Date.now() < settleUntil && recordIdentityMatches(record)) {
      await delay(100);
      listeners = readPortListeners();
      if (listenersOwnedBy(record, listeners) || listenerPortIsBusy(listeners)) break;
    }
  }
  if (listenersOwnedBy(record, listeners)) {
    await stopRecord(record, true);
    removeProcessRecord(record);
    return;
  }
  if (listenerPortIsBusy(listeners)) {
    throw new Error("CLIProxy port 8317 is owned by another process; recorded child was not signaled");
  }
  throw new Error("A recorded CLIProxy process is alive but its port ownership is ambiguous");
}

function assertManagerIsSelf(): void {
  const manager = readManagerRecord();
  const self = getSelfIdentity();
  if (manager && managerIsAlive(manager) && manager.pid !== self.pid) {
    throw new Error("CLIProxy is managed by another live Bun process");
  }
  if (
    manager &&
    managerIsAlive(manager) &&
    manager.pid === self.pid &&
    manager.startTime !== self.startTime
  ) {
    throw new Error("CLIProxy manager PID fingerprint changed");
  }
}

async function withLifecycleLock<T>(callback: () => Promise<T>): Promise<T> {
  ensureLayout();
  const release = await lockfile.lock(paths.root, {
    lockfilePath: paths.lock,
    stale: CLIPROXY_LOCK_TIMING.staleMs,
    update: CLIPROXY_LOCK_TIMING.updateMs,
    retries: {
      retries: CLIPROXY_LOCK_TIMING.retryAttempts,
      factor: 1,
      minTimeout: CLIPROXY_LOCK_TIMING.retryIntervalMs,
      maxTimeout: CLIPROXY_LOCK_TIMING.retryIntervalMs,
    },
  });
  try {
    return await callback();
  } finally {
    await release();
  }
}

function currentOperation(): CliproxyOperation | null {
  return operationQueue[0] ?? null;
}

async function withOperation<T>(name: CliproxyOperationName, callback: () => Promise<T>): Promise<T> {
  const operation: CliproxyOperation = { name, startedAt: new Date().toISOString() };
  operationQueue.push(operation);
  lastError = null;
  try {
    return await callback();
  } catch (error) {
    lastError = error instanceof Error ? error.message : "CLIProxy operation failed";
    throw error;
  } finally {
    const index = operationQueue.indexOf(operation);
    if (index >= 0) operationQueue.splice(index, 1);
  }
}

function registerShutdownSignals(): void {
  const signalProcess = process as typeof process & { __rawrouteCliproxySignals?: boolean };
  if (signalProcess.__rawrouteCliproxySignals) return;
  signalProcess.__rawrouteCliproxySignals = true;
  const shutdownFor = (signal: "SIGINT" | "SIGTERM", exitCode: number) => {
    process.once(signal, () => {
      void shutdownCliproxy()
        .then(() => process.exit(exitCode))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "shutdown failed";
          process.stderr.write(`[cliproxy] ${message}\n`);
          process.exit(1);
        });
    });
  };
  shutdownFor("SIGINT", 130);
  shutdownFor("SIGTERM", 143);
}

function readTransaction(): UpdateTransaction | null {
  const transaction = readJson<UpdateTransaction>(paths.transaction);
  if (!transaction) return null;
  if (
    !(transaction.fromVersion === null || typeof transaction.fromVersion === "string") ||
    typeof transaction.toVersion !== "string" ||
    !(transaction.previousPin === null || typeof transaction.previousPin === "string") ||
    !(transaction.previousDesiredRunning === undefined ||
      typeof transaction.previousDesiredRunning === "boolean")
  ) {
    throw new Error("CLIProxy update recovery marker is invalid");
  }
  if (transaction.fromVersion) transaction.fromVersion = normalizeVersion(transaction.fromVersion);
  transaction.toVersion = normalizeVersion(transaction.toVersion);
  if (transaction.previousPin) transaction.previousPin = normalizeVersion(transaction.previousPin);
  return transaction;
}

async function recoverInterruptedUpdate(): Promise<void> {
  const transaction = readTransaction();
  if (!transaction) return;
  await stopActiveChild();
  await reconcileStaleChild();
  if (transaction.fromVersion) {
    if (!isInstalledVersion(transaction.fromVersion)) {
      throw new Error("CLIProxy recovery version is missing; refusing to discard the update marker");
    }
    setCurrentVersion(transaction.fromVersion);
  } else {
    removeCurrentVersion(transaction.toVersion);
  }
  const state = readState();
  state.installedVersion = transaction.fromVersion;
  state.pinnedVersion = transaction.previousPin;
  state.desiredRunning = transaction.previousDesiredRunning ?? state.desiredRunning;
  writeState(state);
  fs.rmSync(paths.transaction, { force: true });
}

function cleanupStagingVersions(): void {
  for (const entry of fs.readdirSync(paths.versions, { withFileTypes: true })) {
    if (!entry.name.startsWith(".staging-")) continue;
    const stagingPath = path.join(paths.versions, entry.name);
    const metadata = fs.lstatSync(stagingPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
    fs.chmodSync(stagingPath, 0o700);
    fs.rmSync(stagingPath, { recursive: true, force: true });
  }
}

async function prepareVersion(version: string): Promise<void> {
  const finalDir = path.join(paths.versions, version);
  if (fs.existsSync(finalDir)) {
    if (!isInstalledVersion(version)) throw new Error("Existing CLIProxy version directory is invalid");
    return;
  }

  const archive = await fetchVerifiedBinary(version);
  const stagingDir = path.join(paths.versions, `.staging-${version}-${randomUUID()}`);
  const extractDir = path.join(stagingDir, "extract");
  fs.mkdirSync(extractDir, { recursive: true, mode: 0o700 });
  try {
    await extractVerifiedBinary(archive, extractDir);
    const extractedBinary = path.join(extractDir, EXECUTABLE_NAME);
    const metadata = fs.lstatSync(extractedBinary);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
      throw new Error("CLIProxy archive did not produce a regular executable");
    }
    const stagedBinary = path.join(stagingDir, EXECUTABLE_NAME);
    fs.renameSync(extractedBinary, stagedBinary);
    fs.chmodSync(stagedBinary, 0o555);
    writeAtomic(path.join(stagingDir, ".version"), `${version}\n`, 0o444);
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.chmodSync(stagingDir, 0o555);
    fs.renameSync(stagingDir, finalDir);
  } catch (error) {
    fs.chmodSync(stagingDir, 0o700);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function readSecret(filePath: string): string {
  const secret = fs.readFileSync(filePath, "utf8").trim();
  if (secret.length < 32) throw new Error("CLIProxy persisted secret is invalid");
  return secret;
}

async function probeApiHealth(): Promise<boolean> {
  try {
    const response = await fetch(`http://${CLIPROXY_HOST}:${CLIPROXY_PORT}/v1/models`, {
      headers: { Authorization: `Bearer ${readSecret(paths.apiKey)}` },
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { data?: unknown };
    return Array.isArray(payload.data);
  } catch {
    return false;
  }
}

async function waitUntilHealthy(record: ProcessRecord, timeoutMs = STARTUP_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!recordIdentityMatches(record)) throw new Error("CLIProxy exited before becoming healthy");
    const listeners = readPortListeners();
    if (listenersSecurelyOwnedBy(record, listeners) && (await probeApiHealth())) {
      const confirmedListeners = readPortListeners();
      if (listenersSecurelyOwnedBy(record, confirmedListeners)) return;
      if (listenerPortIsBusy(confirmedListeners)) {
        throw new Error(`CLIProxy listener is not exclusively bound to ${CLIPROXY_HOST}:${CLIPROXY_PORT}`);
      }
    }
    if (listenerPortIsBusy(listeners) && !listenersSecurelyOwnedBy(record, listeners)) {
      throw new Error(`CLIProxy listener is not exclusively bound to ${CLIPROXY_HOST}:${CLIPROXY_PORT}`);
    }
    await delay(250);
  }
  throw new Error("CLIProxy did not pass its authenticated health check before timeout");
}

function writeProcessRecord(record: ProcessRecord): void {
  writeAtomic(paths.process, `${JSON.stringify(record, null, 2)}\n`);
}

async function stopActiveChild(): Promise<void> {
  const child = activeProcess;
  const record = activeRecord;
  if (!child || !record) return;
  intentionalExits.add(child.pid);
  if (child.exitCode === null) child.kill("SIGTERM");
  const exited = await Promise.race([
    child.exited.then(() => true),
    delay(TERM_TIMEOUT_MS).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    const killed = await Promise.race([
      child.exited.then(() => true),
      delay(TERM_TIMEOUT_MS).then(() => false),
    ]);
    if (!killed) throw new Error("CLIProxy process did not exit after SIGKILL");
  }
  if (activeProcess === child) activeProcess = undefined;
  if (activeRecord === record) activeRecord = undefined;
  removeProcessRecord(record);
}

function monitorChild(child: ChildProcess, record: ProcessRecord): void {
  const generation = restartGeneration;
  void child.exited.then((exitCode) => {
    if (activeProcess === child) activeProcess = undefined;
    if (activeRecord === record) activeRecord = undefined;
    let recordWasCurrent = false;
    try {
      const latest = readProcessRecord();
      recordWasCurrent = latest?.pid === record.pid && latest.startTime === record.startTime;
      removeProcessRecord(record);
    } catch (error) {
      lastError = error instanceof Error ? error.message : "CLIProxy process record could not be cleared";
    }
    const wasIntentional = intentionalExits.delete(child.pid);
    if (!recordWasCurrent || wasIntentional || shuttingDown) return;
    try {
      if (!readState().desiredRunning || generation !== restartGeneration) return;
      void scheduleRestart(record, exitCode, generation);
    } catch (error) {
      lastError = error instanceof Error ? error.message : "CLIProxy state could not be read";
    }
  });
}

async function scheduleRestart(
  exitedRecord: ProcessRecord,
  exitCode: number,
  generation: number
): Promise<void> {
  if (shuttingDown) return;
  if (generation !== restartGeneration) return;
  if (restartTask) {
    pendingRestart = { record: exitedRecord, exitCode, generation };
    return;
  }
  const operation: CliproxyOperation = { name: "restarting", startedAt: new Date().toISOString() };
  operationQueue.push(operation);
  restartTask = (async () => {
    const uptime = Date.now() - Date.parse(exitedRecord.startedAt);
    if (uptime >= 60_000) restartAttempts = 0;
    while (restartAttempts < MAX_RESTARTS && !shuttingDown && generation === restartGeneration) {
      await delay(RESTART_BACKOFF_MS[restartAttempts++]);
      let desiredRunning = false;
      try {
        desiredRunning = readState().desiredRunning;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "CLIProxy state could not be read";
        return;
      }
      if (shuttingDown || generation !== restartGeneration || !desiredRunning) return;
      try {
        let attemptedStart = false;
        await withLifecycleLock(async () => {
          assertManagerIsSelf();
          if (activeProcess || !readState().desiredRunning || shuttingDown) return;
          const listeners = readPortListeners();
          if (listenerPortIsBusy(listeners)) {
            throw new Error("CLIProxy port 8317 is owned by another process");
          }
          attemptedStart = true;
          await startCurrentVersion();
        });
        if (!attemptedStart || activeProcess) return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "CLIProxy restart failed";
      }
    }
    if (restartAttempts >= MAX_RESTARTS && !activeProcess) {
      lastError = `CLIProxy exited with code ${exitCode}; restart limit reached`;
    }
  })().finally(() => {
    const operationIndex = operationQueue.indexOf(operation);
    if (operationIndex >= 0) operationQueue.splice(operationIndex, 1);
    restartTask = undefined;
    const next = pendingRestart;
    pendingRestart = undefined;
    if (next) void scheduleRestart(next.record, next.exitCode, next.generation);
  });
  await restartTask;
}

async function startCurrentVersion(): Promise<void> {
  const version = currentVersion();
  if (!version) throw new Error("No valid CLIProxy version is installed");
  ensureConfig();
  const listeners = readPortListeners();
  if (listenerPortIsBusy(listeners)) {
    throw new Error("CLIProxy port 8317 is owned by another process");
  }

  const executablePath = fs.realpathSync(path.join(paths.current, EXECUTABLE_NAME));
  const manager = getSelfIdentity();
  const child = Bun.spawn([executablePath, "-config", paths.config], {
    cwd: paths.root,
    env: {
      ...process.env,
      HOME: paths.root,
      XDG_CONFIG_HOME: path.join(paths.root, ".config"),
      XDG_DATA_HOME: path.join(paths.root, ".local/share"),
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });

  const identity = readProcIdentity(child.pid);
  if (!identity || identity.executablePath !== executablePath) {
    child.kill("SIGKILL");
    throw new Error("Unable to verify the spawned CLIProxy executable identity");
  }
  const record: ProcessRecord = {
    pid: child.pid,
    ...identity,
    version,
    managerPid: manager.pid,
    managerStartTime: manager.startTime,
    managerExecutablePath: manager.executablePath,
    startedAt: new Date().toISOString(),
  };
  try {
    writeProcessRecord(record);
  } catch (error) {
    child.kill("SIGTERM");
    await Promise.race([child.exited, delay(TERM_TIMEOUT_MS)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    throw error;
  }
  activeProcess = child;
  activeRecord = record;
  monitorChild(child, record);

  try {
    await waitUntilHealthy(record);
    restartAttempts = 0;
    lastError = null;
  } catch (error) {
    await stopActiveChild();
    throw error;
  }
}

async function installLocked(input: string): Promise<string> {
  const desiredVersion = input === "latest" ? (await getAvailableVersions()).latest : normalizeVersion(input);
  const state = readState();
  const oldVersion = currentVersion();
  if (oldVersion === desiredVersion) {
    state.installedVersion = oldVersion;
    state.pinnedVersion = input === "latest" ? null : desiredVersion;
    writeState(state);
    if (state.desiredRunning && !activeProcess) {
      await reconcileStaleChild();
      await startCurrentVersion();
    }
    return desiredVersion;
  }

  const previouslyInstalled = Boolean(oldVersion || state.installedVersion);
  const runAfterInstall = shouldStartAfterInstall(state.desiredRunning, previouslyInstalled);
  await prepareVersion(desiredVersion);
  const transaction: UpdateTransaction = {
    fromVersion: oldVersion,
    toVersion: desiredVersion,
    previousPin: state.pinnedVersion,
    previousDesiredRunning: state.desiredRunning,
  };
  writeAtomic(paths.transaction, `${JSON.stringify(transaction, null, 2)}\n`);

  try {
    await stopActiveChild();
    if (!activeProcess) await reconcileStaleChild();
    setCurrentVersion(desiredVersion);
    if (runAfterInstall) {
      if (!state.desiredRunning) {
        const startingState = readState();
        startingState.desiredRunning = true;
        writeState(startingState);
      }
      await startCurrentVersion();
    }

    const committed = readState();
    committed.installedVersion = desiredVersion;
    committed.pinnedVersion = input === "latest" ? null : desiredVersion;
    committed.desiredRunning = runAfterInstall;
    writeState(committed);
    fs.rmSync(paths.transaction, { force: true });
    return desiredVersion;
  } catch (error) {
    let rollbackError: unknown;
    try {
      await stopActiveChild();
      if (oldVersion) setCurrentVersion(oldVersion);
      else removeCurrentVersion(desiredVersion);
      const restored = readState();
      restored.installedVersion = oldVersion;
      restored.pinnedVersion = transaction.previousPin;
      restored.desiredRunning = transaction.previousDesiredRunning ?? state.desiredRunning;
      writeState(restored);
      if (restored.desiredRunning && oldVersion) await startCurrentVersion();
      fs.rmSync(paths.transaction, { force: true });
    } catch (failure) {
      rollbackError = failure;
    }
    if (rollbackError) {
      throw new Error(
        `CLIProxy update failed and rollback needs startup recovery: ${
          error instanceof Error ? error.message : "unknown update error"
        }`
      );
    }
    throw error;
  }
}

export async function initCliproxy(): Promise<void> {
  await withOperation("initializing", () =>
    withLifecycleLock(async () => {
      ensureLayout();
      cleanupStagingVersions();
      const initialState = readState();
      if (!fs.existsSync(paths.state)) writeState(initialState);
      assertManagerIsSelf();
      await recoverInterruptedUpdate();
      if (
        !activeProcess ||
        !activeRecord ||
        !recordIdentityMatches(activeRecord) ||
        !listenersSecurelyOwnedBy(activeRecord)
      ) {
        await reconcileStaleChild();
      }
      ensureConfig();
      writeAtomic(paths.manager, `${JSON.stringify(getSelfIdentity(), null, 2)}\n`);
      shuttingDown = false;
      restartGeneration++;
      registerShutdownSignals();

      const state = readState();
      const startupAction = getStartupAction(state.desiredRunning, currentVersion() !== null);
      if (startupAction === "start") {
        if (activeProcess && activeRecord) await waitUntilHealthy(activeRecord);
        else await startCurrentVersion();
      } else if (startupAction === "missing-install") {
        lastError = "CLIProxy is marked to run but no version is installed; install a version manually";
      }
    })
  );
}

export async function shutdownCliproxy(): Promise<void> {
  shuttingDown = true;
  restartGeneration++;
  await withLifecycleLock(async () => {
    assertManagerIsSelf();
    await recoverInterruptedUpdate();
    await stopActiveChild();
    await reconcileStaleChild();
    const manager = readManagerRecord();
    const self = getSelfIdentity();
    if (manager?.pid === self.pid && manager.startTime === self.startTime) {
      fs.rmSync(paths.manager, { force: true });
    }
  });
}

export async function getStatus(): Promise<CliproxyStatus> {
  let state = defaultState();
  let processRecord: ProcessRecord | null = null;
  let version: string | null = null;
  let statusError = lastError;
  try {
    state = readState();
    processRecord = readProcessRecord();
    version = currentVersion();
  } catch (error) {
    statusError = error instanceof Error ? error.message : "CLIProxy status could not be read";
  }

  let listeners = readPortListeners();
  let processRunning = Boolean(
    processRecord &&
      recordIdentityMatches(processRecord) &&
      listenersOwnedBy(processRecord, listeners)
  );
  let loopbackOnly = listenersLoopbackOnly(listeners);
  let conflict = listenerPortIsBusy(listeners) && (!processRunning || !loopbackOnly);
  let healthy = false;
  if (processRunning && loopbackOnly && (await probeApiHealth())) {
    listeners = readPortListeners();
    processRunning = Boolean(
      processRecord &&
        recordIdentityMatches(processRecord) &&
        listenersOwnedBy(processRecord, listeners)
    );
    loopbackOnly = listenersLoopbackOnly(listeners);
    conflict = listenerPortIsBusy(listeners) && (!processRunning || !loopbackOnly);
    healthy = processRunning && loopbackOnly;
  }
  const installed = Boolean(version && isInstalledVersion(version));
  return {
    installed,
    version,
    pinnedVersion: state.pinnedVersion,
    desiredRunning: state.desiredRunning,
    processRunning,
    healthy,
    conflict,
    operation: currentOperation(),
    restartAttempts,
    lastError: statusError,
  };
}

export async function getVersions(): Promise<CliproxyVersions> {
  const available = await getAvailableVersions();
  let state = defaultState();
  let current: string | null = null;
  try {
    state = readState();
    current = currentVersion();
  } catch {
    // Release discovery remains useful even if local state needs repair.
  }
  return { ...available, current, pinned: state.pinnedVersion };
}

export async function install(version: string): Promise<string> {
  const normalizedInput = version === "latest" ? version : normalizeVersion(version);
  return withOperation("installing", () =>
    withLifecycleLock(async () => {
      assertManagerIsSelf();
      await recoverInterruptedUpdate();
      const state = readState();
      if (!fs.existsSync(paths.state)) writeState(state);
      ensureConfig();
      const manager = getSelfIdentity();
      const previousManager = readManagerRecord();
      if (
        !previousManager ||
        previousManager.pid !== manager.pid ||
        previousManager.startTime !== manager.startTime
      ) {
        writeAtomic(paths.manager, `${JSON.stringify(manager, null, 2)}\n`);
      }
      return installLocked(normalizedInput);
    })
  );
}

export async function start(): Promise<void> {
  await withOperation("starting", () =>
    withLifecycleLock(async () => {
      assertManagerIsSelf();
      await recoverInterruptedUpdate();
      if (!currentVersion()) {
        throw new Error("No CLIProxy version is installed; install a version before starting");
      }
      const manager = getSelfIdentity();
      const previousManager = readManagerRecord();
      if (
        !previousManager ||
        previousManager.pid !== manager.pid ||
        previousManager.startTime !== manager.startTime
      ) {
        writeAtomic(paths.manager, `${JSON.stringify(manager, null, 2)}\n`);
      }
      const state = readState();
      state.desiredRunning = true;
      writeState(state);
      shuttingDown = false;
      restartGeneration++;
      restartAttempts = 0;
      if (activeProcess) {
        if (
          activeRecord &&
          recordIdentityMatches(activeRecord) &&
          listenersSecurelyOwnedBy(activeRecord)
        ) {
          await waitUntilHealthy(activeRecord);
          return;
        }
        await stopActiveChild();
      } else {
        await reconcileStaleChild();
      }
      await startCurrentVersion();
    })
  );
}

export async function stop(): Promise<void> {
  await withOperation("stopping", () =>
    withLifecycleLock(async () => {
      assertManagerIsSelf();
      await recoverInterruptedUpdate();
      const state = readState();
      state.desiredRunning = false;
      writeState(state);
      restartGeneration++;
      restartAttempts = 0;
      if (activeProcess) {
        await stopActiveChild();
      } else {
        const record = readProcessRecord();
        if (record && recordIdentityMatches(record) && listenersOwnedBy(record)) {
          await stopRecord(record, true);
          removeProcessRecord(record);
        }
      }
    })
  );
}

export async function restart(): Promise<void> {
  await withOperation("restarting", () =>
    withLifecycleLock(async () => {
      assertManagerIsSelf();
      await recoverInterruptedUpdate();
      if (!currentVersion()) {
        throw new Error("No CLIProxy version is installed; install a version before restarting");
      }
      const state = readState();
      state.desiredRunning = true;
      writeState(state);
      restartGeneration++;
      restartAttempts = 0;
      shuttingDown = false;
      await stopActiveChild();
      await reconcileStaleChild();
      await startCurrentVersion();
    })
  );
}

export function getApiKey(): string {
  return readSecret(paths.apiKey);
}
