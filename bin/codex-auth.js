#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const rootPackageJsonPath = path.join(__dirname, "..", "package.json");

const packageMap = {
  "linux:x64": "@loongphy/codex-auth-linux-x64",
  "linux:arm64": "@loongphy/codex-auth-linux-arm64",
  "darwin:x64": "@loongphy/codex-auth-darwin-x64",
  "darwin:arm64": "@loongphy/codex-auth-darwin-arm64",
  "win32:x64": "@loongphy/codex-auth-win32-x64",
  "win32:arm64": "@loongphy/codex-auth-win32-arm64"
};

function readRootPackage() {
  try {
    return JSON.parse(fs.readFileSync(rootPackageJsonPath, "utf8"));
  } catch {
    return null;
  }
}

function maybePrintPreviewVersion(argv) {
  if (argv.length !== 1) return false;
  if (argv[0] !== "--version" && argv[0] !== "-V") return false;

  const rootPackage = readRootPackage();
  if (!rootPackage) return false;

  const previewLabel = rootPackage.codexAuthPreviewLabel;
  if (typeof previewLabel !== "string" || previewLabel.length === 0) return false;
  if (typeof rootPackage.version !== "string" || rootPackage.version.length === 0) return false;

  process.stdout.write(`codex-auth ${rootPackage.version} (preview ${previewLabel})\n`);
  return true;
}

if (maybePrintPreviewVersion(process.argv.slice(2))) {
  process.exit(0);
}

function resolveBinary() {
  if (process.env.CODEX_AUTH_BINARY) {
    const overridePath = path.resolve(process.env.CODEX_AUTH_BINARY);
    if (fs.existsSync(overridePath)) return overridePath;
    console.error(`CODEX_AUTH_BINARY does not exist: ${overridePath}`);
    process.exit(1);
  }

  const key = `${process.platform}:${process.arch}`;
  const packageName = packageMap[key];
  if (!packageName) {
    console.error(`Unsupported platform: ${process.platform}/${process.arch}`);
    process.exit(1);
  }

  try {
    const packageRoot = path.dirname(require.resolve(`${packageName}/package.json`));
    const binaryName = process.platform === "win32" ? "codex-auth.exe" : "codex-auth";
    const binaryPath = path.join(packageRoot, "bin", binaryName);
    if (!fs.existsSync(binaryPath)) {
      console.error(`Missing binary inside ${packageName}: ${binaryPath}`);
      process.exit(1);
    }
    return binaryPath;
  } catch (error) {
    const binaryName = process.platform === "win32" ? "codex-auth.exe" : "codex-auth";
    const localDevBinary = path.join(__dirname, "..", "zig-out", "bin", binaryName);
    if (fs.existsSync(localDevBinary)) return localDevBinary;

    console.error(
      `Missing platform package ${packageName}. Reinstall @loongphy/codex-auth on ${process.platform}/${process.arch}.`
    );
    if (error && error.message) {
      console.error(error.message);
    }
    process.exit(1);
  }
}

function parseGuiArgs(argv) {
  const options = {
    host: "127.0.0.1",
    port: 0,
    open: true,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--no-open") {
      options.open = false;
      continue;
    }
    if (arg === "--host") {
      const value = argv[i + 1];
      if (!value) {
        console.error("Missing value for --host.");
        process.exit(1);
      }
      options.host = value;
      i += 1;
      continue;
    }
    if (arg === "--port") {
      const value = argv[i + 1];
      if (!value) {
        console.error("Missing value for --port.");
        process.exit(1);
      }
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error(`Invalid --port value: ${value}`);
        process.exit(1);
      }
      options.port = port;
      i += 1;
      continue;
    }
    console.error(`Unknown gui argument: ${arg}`);
    process.exit(1);
  }

  return options;
}

function printGuiHelp() {
  process.stdout.write(`codex-auth gui

Launch a local web interface for switching stored Codex accounts.

Usage:
  codex-auth gui [--host <host>] [--port <port>] [--no-open]

Options:
  --host <host>  Host to bind. Defaults to 127.0.0.1.
  --port <port>  Port to bind. Defaults to an available random port.
  --no-open      Print the URL without opening a browser.
  -h, --help     Show this help.
`);
}

function resolveCodexHome() {
  if (process.env.CODEX_HOME && process.env.CODEX_HOME.length !== 0) {
    return path.resolve(process.env.CODEX_HOME);
  }
  if (process.env.HOME && process.env.HOME.length !== 0) {
    return path.join(process.env.HOME, ".codex");
  }
  if (process.env.USERPROFILE && process.env.USERPROFILE.length !== 0) {
    return path.join(process.env.USERPROFILE, ".codex");
  }
  throw new Error("Unable to resolve CODEX_HOME because HOME and USERPROFILE are unset.");
}

function runCodexAuth(binaryPath, args, codexHome) {
  const child = spawnSync(binaryPath, args, {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: codexHome },
    windowsHide: true
  });
  if (child.error) throw child.error;
  if (child.signal) throw new Error(`codex-auth was terminated by ${child.signal}.`);
  if ((child.status ?? 1) !== 0) {
    const output = `${child.stderr ?? ""}${child.stdout ?? ""}`.trim();
    throw new Error(output || `codex-auth exited with status ${child.status}.`);
  }
  return child.stdout ?? "";
}

function refreshRegistry(binaryPath, codexHome) {
  const listOutput = runCodexAuth(binaryPath, ["list"], codexHome);
  return {
    registry: readRegistry(codexHome),
    table: parseListTable(listOutput)
  };
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function parseListTable(output) {
  const lines = stripAnsi(output).split(/\r?\n/);
  const headerIndex = lines.findIndex((line) =>
    line.includes("ACCOUNT") &&
    line.includes("PLAN") &&
    line.includes("5H") &&
    line.includes("WEEKLY") &&
    line.includes("LAST ACTIVITY")
  );
  if (headerIndex < 0) return new Map();

  const header = lines[headerIndex];
  const planStart = header.indexOf("PLAN");
  const fiveHourStart = header.indexOf("5H");
  const weeklyStart = header.indexOf("WEEKLY");
  const lastActivityStart = header.indexOf("LAST ACTIVITY");
  if (planStart < 0 || fiveHourStart < 0 || weeklyStart < 0 || lastActivityStart < 0) {
    return new Map();
  }

  const overlays = new Map();
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim() || line.trim().startsWith("-")) continue;
    const match = line.match(/^\s*\*?\s*(\d+)\s+/);
    if (!match) continue;
    const displayNumber = Number(match[1]);
    if (!Number.isInteger(displayNumber)) continue;
    overlays.set(displayNumber, {
      fiveHour: line.slice(fiveHourStart, weeklyStart).trim(),
      weekly: line.slice(weeklyStart, lastActivityStart).trim(),
      lastActivity: line.slice(lastActivityStart).trim()
    });
  }
  return overlays;
}

function readRegistry(codexHome) {
  const registryPath = path.join(codexHome, "accounts", "registry.json");
  if (!fs.existsSync(registryPath)) {
    return {
      schema_version: 4,
      active_account_key: null,
      previous_active_account_key: null,
      accounts: []
    };
  }
  return JSON.parse(fs.readFileSync(registryPath, "utf8"));
}

function planLabel(plan) {
  const labels = {
    free: "Free",
    plus: "Plus",
    prolite: "Pro Lite",
    pro: "Pro",
    team: "Business",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Edu",
    unknown: "Unknown"
  };
  return labels[plan] ?? "Unknown";
}

function resolveDisplayPlan(record) {
  return record?.last_usage?.plan_type ?? record?.plan ?? null;
}

function planSortRank(plan) {
  switch (plan ?? "unknown") {
    case "team":
    case "business":
    case "enterprise":
    case "edu":
      return 0;
    case "free":
    case "plus":
    case "prolite":
    case "pro":
      return 1;
    default:
      return 2;
  }
}

function displayPlan(record) {
  if (record.auth_mode === "apikey") return "API_KEY";
  const plan = resolveDisplayPlan(record);
  return plan ? planLabel(plan) : "-";
}

function compareText(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function isActive(registry, index) {
  return registry.active_account_key === registry.accounts[index]?.account_key;
}

function sortAccountIndices(registry) {
  const indices = registry.accounts.map((_, index) => index);
  indices.sort((left, right) => {
    const a = registry.accounts[left];
    const b = registry.accounts[right];
    const emailCmp = compareText(a.email ?? "", b.email ?? "");
    if (emailCmp !== 0) return emailCmp;

    const aActive = isActive(registry, left);
    const bActive = isActive(registry, right);
    if (aActive !== bActive) return aActive ? -1 : 1;

    const aRank = planSortRank(resolveDisplayPlan(a));
    const bRank = planSortRank(resolveDisplayPlan(b));
    if (aRank !== bRank) return aRank - bRank;

    const planCmp = compareText(displayPlan(a), displayPlan(b));
    if (planCmp !== 0) return planCmp;

    return compareText(a.account_key ?? "", b.account_key ?? "");
  });
  return indices;
}

function apiKeyLabel(accountKey) {
  if (!accountKey?.startsWith("apikey::")) return null;
  const sep = accountKey.lastIndexOf("::");
  if (sep < 0) return null;
  const fingerprint = accountKey.slice(sep + 2);
  if (fingerprint.length < 9) return null;
  return `sk-${fingerprint.slice(0, 5)}***${fingerprint.slice(-4)}`;
}

function normalizedAccountName(record) {
  return record.account_name && record.account_name.length !== 0 ? record.account_name : null;
}

function preferredAccountLabel(record, fallback) {
  const alias = record.alias && record.alias.length !== 0 ? record.alias : null;
  const accountName = normalizedAccountName(record);
  if (record.auth_mode === "apikey") {
    const keyLabel = apiKeyLabel(record.account_key);
    if (alias && keyLabel) return `${alias}(${keyLabel})`;
    if (alias) return alias;
    if (keyLabel) return keyLabel;
    if (accountName) return accountName;
    return fallback;
  }
  if (alias && accountName) return `${alias}(${accountName})`;
  if (alias) return alias;
  if (accountName) return accountName;
  return fallback;
}

function accountIdentityLabel(record) {
  const alias = record.alias && record.alias.length !== 0 ? record.alias : null;
  const accountName = normalizedAccountName(record);
  if (alias && accountName) return `${alias}(${accountName}, ${record.email})`;
  if (alias) return `${alias}(${record.email})`;
  if (accountName) return `${accountName}(${record.email})`;
  return record.email;
}

function groupedAccountLabel(registry, group, accountIndex) {
  const record = registry.accounts[accountIndex];
  const base = displayPlan(record);
  let totalSame = 0;
  let ordinal = 1;
  for (const candidateIndex of group) {
    const candidate = registry.accounts[candidateIndex];
    if (candidate.alias && candidate.alias.length !== 0) continue;
    if (displayPlan(candidate) !== base) continue;
    totalSame += 1;
    if (candidateIndex !== accountIndex && compareText(candidate.account_key, record.account_key) < 0) {
      ordinal += 1;
    }
  }
  const fallback = totalSame <= 1 ? base : `${base} #${ordinal}`;
  return preferredAccountLabel(record, fallback);
}

function resolveRateWindow(snapshot, minutes, fallbackPrimary) {
  if (!snapshot) return null;
  if (snapshot.primary?.window_minutes === minutes) return snapshot.primary;
  if (snapshot.secondary?.window_minutes === minutes) return snapshot.secondary;
  return fallbackPrimary ? snapshot.primary ?? null : snapshot.secondary ?? null;
}

function remainingPercent(window, nowSeconds) {
  if (!window) return null;
  if (typeof window.resets_at === "number" && window.resets_at <= nowSeconds) return 100;
  if (typeof window.used_percent !== "number") return null;
  const remaining = 100 - window.used_percent;
  if (remaining <= 0) return 0;
  if (remaining >= 100) return 100;
  return Math.trunc(remaining);
}

function usageFromTableText(text, fallback) {
  if (!text || text === "-") return fallback;
  const percentMatch = text.match(/^(\d+)%/);
  return {
    ...fallback,
    label: text,
    state: /token_|^\d{3}\b|MissingAuth|TimedOut|Forbidden|Unauthorized/i.test(text)
      ? "error"
      : percentMatch
        ? "ok"
        : "info"
  };
}

function projectAccount(registry, accountIndex, displayNumber, label, depth, tableOverlay) {
  const record = registry.accounts[accountIndex];
  const nowSeconds = Math.floor(Date.now() / 1000);
  const rate5h = resolveRateWindow(record.last_usage, 300, true);
  const rateWeekly = resolveRateWindow(record.last_usage, 10080, false);
  const usage5h = usageFromTableText(tableOverlay?.fiveHour, {
    remaining: remainingPercent(rate5h, nowSeconds),
    resetsAt: rate5h?.resets_at ?? null,
    label: null,
    state: "stored"
  });
  const usageWeekly = usageFromTableText(tableOverlay?.weekly, {
    remaining: remainingPercent(rateWeekly, nowSeconds),
    resetsAt: rateWeekly?.resets_at ?? null,
    label: null,
    state: "stored"
  });
  return {
    accountKey: record.account_key,
    displayNumber,
    label,
    depth,
    active: registry.active_account_key === record.account_key,
    email: record.email ?? "",
    alias: record.alias ?? "",
    accountName: record.account_name ?? "",
    plan: displayPlan(record),
    authMode: record.auth_mode ?? "",
    lastUsedAt: record.last_used_at ?? null,
    lastUsageAt: record.last_usage_at ?? null,
    lastActivityLabel: tableOverlay?.lastActivity ?? null,
    usage5h,
    usageWeekly
  };
}

function buildAccountView(registry, tableOverlays = new Map()) {
  const accounts = Array.isArray(registry.accounts) ? registry.accounts : [];
  const normalized = { ...registry, accounts };
  const ordered = sortAccountIndices(normalized);
  const rows = [];
  let displayNumber = 1;

  for (let i = 0; i < ordered.length; ) {
    const email = accounts[ordered[i]]?.email ?? "";
    const start = i;
    while (i < ordered.length && (accounts[ordered[i]]?.email ?? "") === email) i += 1;
    const group = ordered.slice(start, i);
    if (group.length === 1) {
      const accountIndex = group[0];
      rows.push(projectAccount(
        normalized,
        accountIndex,
        displayNumber,
        accountIdentityLabel(accounts[accountIndex]),
        0,
        tableOverlays.get(displayNumber)
      ));
      displayNumber += 1;
      continue;
    }
    for (const accountIndex of group) {
      rows.push(projectAccount(
        normalized,
        accountIndex,
        displayNumber,
        groupedAccountLabel(normalized, group, accountIndex),
        1,
        tableOverlays.get(displayNumber)
      ));
      displayNumber += 1;
    }
  }

  const active = rows.find((account) => account.active) ?? null;
  return {
    codexHome: resolveCodexHome(),
    activeAccountKey: normalized.active_account_key ?? null,
    activeAccount: active,
    accounts: rows,
    refreshedAt: Date.now()
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body.length === 0 ? {} : JSON.parse(body));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function createGuiServer(binaryPath, codexHome) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store"
        });
        response.end(guiHtml);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/accounts") {
        const refreshed = refreshRegistry(binaryPath, codexHome);
        sendJson(response, 200, buildAccountView(refreshed.registry, refreshed.table));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/switch") {
        const body = await readRequestJson(request);
        const accountKey = typeof body.accountKey === "string" ? body.accountKey : "";
        const refreshed = refreshRegistry(binaryPath, codexHome);
        const view = buildAccountView(refreshed.registry, refreshed.table);
        const target = view.accounts.find((account) => account.accountKey === accountKey);
        if (!target) {
          sendJson(response, 404, { error: "Account not found." });
          return;
        }
        runCodexAuth(binaryPath, ["switch", String(target.displayNumber)], codexHome);
        const updated = refreshRegistry(binaryPath, codexHome);
        sendJson(response, 200, buildAccountView(updated.registry, updated.table));
        return;
      }
      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      sendJson(response, 500, { error: error.message ?? String(error) });
    }
  });
}

function openBrowser(url) {
  const command =
    process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawnSync(command, args, {
    stdio: "ignore",
    windowsHide: true
  });
  return !child.error && (child.status ?? 0) === 0;
}

async function runGui(argv) {
  const options = parseGuiArgs(argv);
  if (options.help) {
    printGuiHelp();
    return;
  }

  const binaryPath = resolveBinary();
  const codexHome = resolveCodexHome();
  const server = createGuiServer(binaryPath, codexHome);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });

  const address = server.address();
  const hostForUrl = options.host.includes(":") ? `[${options.host}]` : options.host;
  const url = `http://${hostForUrl}:${address.port}/`;
  process.stdout.write(`Codex Auth GUI is running at ${url}\n`);
  process.stdout.write(`CODEX_HOME: ${codexHome}\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");

  if (options.open && !openBrowser(url)) {
    process.stdout.write(`Open this URL in your browser: ${url}\n`);
  }
}

const guiHtml = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Auth</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f3;
      --ink: #19201c;
      --muted: #667068;
      --line: #dce1d9;
      --panel: #ffffff;
      --panel-soft: #eef3ee;
      --accent: #127c72;
      --accent-strong: #0c5e56;
      --amber: #b7791f;
      --rose: #b84b5a;
      --shadow: 0 18px 45px rgba(21, 36, 29, 0.11);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(135deg, rgba(18, 124, 114, 0.12), transparent 34%),
        linear-gradient(315deg, rgba(183, 121, 31, 0.12), transparent 30%),
        var(--bg);
      color: var(--ink);
    }
    .app {
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0 34px;
    }
    header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px;
      align-items: end;
      padding: 14px 0 22px;
      border-bottom: 1px solid var(--line);
    }
    h1 {
      margin: 0;
      font-size: 32px;
      line-height: 1.1;
      font-weight: 760;
      letter-spacing: 0;
    }
    .sub {
      margin-top: 8px;
      color: var(--muted);
      font-size: 14px;
      overflow-wrap: anywhere;
    }
    .toolbar {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    input {
      width: min(320px, 100%);
      height: 40px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.82);
      color: var(--ink);
      padding: 0 12px;
      font: inherit;
      outline: none;
    }
    input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(18, 124, 114, 0.16);
    }
    button {
      height: 40px;
      border: 0;
      border-radius: 8px;
      padding: 0 14px;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
      color: #ffffff;
      background: var(--accent);
      transition: transform 120ms ease, background 120ms ease, opacity 120ms ease;
      white-space: nowrap;
    }
    button:hover { background: var(--accent-strong); }
    button:active { transform: translateY(1px); }
    button:disabled {
      cursor: default;
      opacity: 0.45;
      transform: none;
    }
    .ghost {
      background: #26302b;
    }
    .ghost:hover {
      background: #111815;
    }
    .status {
      min-height: 34px;
      margin: 18px 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      font-size: 13px;
    }
    .status strong {
      color: var(--ink);
      font-weight: 700;
    }
    .error {
      color: var(--rose);
      font-weight: 650;
    }
    .table-wrap {
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.78);
      box-shadow: var(--shadow);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 860px;
    }
    th, td {
      padding: 13px 14px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      font-size: 14px;
      vertical-align: middle;
    }
    th {
      position: sticky;
      top: 0;
      background: #f9fbf8;
      color: #445049;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0;
      z-index: 1;
    }
    tr:last-child td { border-bottom: 0; }
    tr.active {
      background: linear-gradient(90deg, rgba(18, 124, 114, 0.12), rgba(255, 255, 255, 0.64));
    }
    .account {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 260px;
    }
    .number {
      width: 34px;
      height: 28px;
      display: inline-grid;
      place-items: center;
      border-radius: 7px;
      background: var(--panel-soft);
      color: #3f4b44;
      font-variant-numeric: tabular-nums;
      font-size: 12px;
      font-weight: 760;
      flex: 0 0 auto;
    }
    .identity {
      min-width: 0;
    }
    .label {
      font-weight: 720;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 420px;
    }
    .email {
      color: var(--muted);
      font-size: 12px;
      margin-top: 3px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 420px;
    }
    .badge {
      display: inline-flex;
      min-height: 24px;
      align-items: center;
      border-radius: 999px;
      padding: 0 9px;
      background: #e1eee9;
      color: var(--accent-strong);
      font-size: 12px;
      font-weight: 760;
      white-space: nowrap;
    }
    .muted { color: var(--muted); }
    .usage {
      font-variant-numeric: tabular-nums;
      font-weight: 680;
    }
    .usage.low { color: var(--rose); }
    .usage.medium { color: var(--amber); }
    .usage.high { color: var(--accent-strong); }
    .usage.error { color: var(--rose); }
    .usage.info { color: var(--muted); }
    .empty {
      padding: 42px 20px;
      text-align: center;
      color: var(--muted);
    }
    @media (max-width: 760px) {
      .app {
        width: min(100vw - 20px, 1180px);
        padding-top: 16px;
      }
      header {
        grid-template-columns: 1fr;
        align-items: start;
      }
      h1 {
        font-size: 26px;
      }
      .toolbar {
        justify-content: stretch;
      }
      input {
        width: 100%;
      }
      button {
        flex: 1 1 auto;
      }
      .status {
        align-items: flex-start;
        flex-direction: column;
      }
    }
  </style>
</head>
<body>
  <main class="app">
    <header>
      <div>
        <h1>Codex Auth</h1>
        <div id="codexHome" class="sub"></div>
      </div>
      <div class="toolbar">
        <input id="search" type="search" placeholder="Search accounts" autocomplete="off">
        <button id="refresh" class="ghost" type="button">Refresh</button>
      </div>
    </header>
    <div class="status">
      <div id="summary">Loading accounts...</div>
      <div id="updated"></div>
    </div>
    <section class="table-wrap" aria-label="Accounts">
      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th>Plan</th>
            <th>5H</th>
            <th>Weekly</th>
            <th>Last Activity</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
      <div id="empty" class="empty" hidden>No accounts found.</div>
    </section>
  </main>
  <script>
    const rowsEl = document.querySelector("#rows");
    const emptyEl = document.querySelector("#empty");
    const searchEl = document.querySelector("#search");
    const summaryEl = document.querySelector("#summary");
    const updatedEl = document.querySelector("#updated");
    const codexHomeEl = document.querySelector("#codexHome");
    const refreshEl = document.querySelector("#refresh");
    let model = null;
    let switchingKey = null;

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[ch]));
    }

    function formatUsage(usage) {
      if (usage && usage.label) {
        return '<span class="usage ' + escapeHtml(usage.state || "info") + '">' + escapeHtml(usage.label) + '</span>';
      }
      if (!usage || usage.remaining === null || usage.remaining === undefined) return '<span class="muted">-</span>';
      const value = Number(usage.remaining);
      const tone = value < 25 ? "low" : value < 60 ? "medium" : "high";
      return '<span class="usage ' + tone + '">' + value + '%</span>';
    }

    function formatTime(seconds) {
      if (!seconds) return '<span class="muted">-</span>';
      const date = new Date(seconds * 1000);
      if (Number.isNaN(date.getTime())) return '<span class="muted">-</span>';
      return escapeHtml(date.toLocaleString());
    }

    function matchesSearch(account, query) {
      if (!query) return true;
      const haystack = [
        account.label,
        account.email,
        account.alias,
        account.accountName,
        account.plan,
        account.authMode
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    }

    function render() {
      if (!model) return;
      const query = searchEl.value.trim().toLowerCase();
      const accounts = model.accounts.filter((account) => matchesSearch(account, query));
      rowsEl.innerHTML = accounts.map((account) => {
        const active = account.active;
        const busy = switchingKey === account.accountKey;
        const status = active ? '<span class="badge">Active</span>' : '<span class="muted">Stored</span>';
        const action = active
          ? '<button type="button" disabled>Active</button>'
          : '<button type="button" data-switch="' + escapeHtml(account.accountKey) + '"' + (busy ? " disabled" : "") + '>' + (busy ? "Switching..." : "Switch") + '</button>';
        return '<tr class="' + (active ? "active" : "") + '">' +
          '<td><div class="account"><span class="number">' + String(account.displayNumber).padStart(2, "0") + '</span><div class="identity"><div class="label">' + escapeHtml(account.label) + '</div><div class="email">' + escapeHtml(account.email) + '</div></div></div></td>' +
          '<td>' + escapeHtml(account.plan) + '</td>' +
          '<td>' + formatUsage(account.usage5h) + '</td>' +
          '<td>' + formatUsage(account.usageWeekly) + '</td>' +
          '<td>' + (account.lastActivityLabel ? escapeHtml(account.lastActivityLabel) : formatTime(account.lastUsedAt || account.lastUsageAt)) + '</td>' +
          '<td>' + status + '</td>' +
          '<td>' + action + '</td>' +
        '</tr>';
      }).join("");
      emptyEl.hidden = accounts.length !== 0;
      summaryEl.innerHTML = model.activeAccount
        ? '<strong>' + escapeHtml(model.activeAccount.label) + '</strong> is active across ' + model.accounts.length + ' stored account(s).'
        : model.accounts.length + ' stored account(s).';
      updatedEl.textContent = "Updated " + new Date(model.refreshedAt).toLocaleTimeString();
      codexHomeEl.textContent = "CODEX_HOME: " + model.codexHome;
    }

    async function loadAccounts() {
      refreshEl.disabled = true;
      summaryEl.textContent = "Loading accounts...";
      try {
        const response = await fetch("/api/accounts");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to load accounts.");
        model = data;
        render();
      } catch (error) {
        summaryEl.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
      } finally {
        refreshEl.disabled = false;
      }
    }

    async function switchAccount(accountKey) {
      switchingKey = accountKey;
      render();
      try {
        const response = await fetch("/api/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountKey })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to switch account.");
        model = data;
      } catch (error) {
        summaryEl.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
      } finally {
        switchingKey = null;
        render();
      }
    }

    rowsEl.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-switch]");
      if (!button) return;
      switchAccount(button.dataset.switch);
    });
    searchEl.addEventListener("input", render);
    refreshEl.addEventListener("click", loadAccounts);
    loadAccounts();
  </script>
</body>
</html>`;

const argv = process.argv.slice(2);
if (argv[0] === "gui") {
  await runGui(argv.slice(1));
} else {
  const binaryPath = resolveBinary();
  const child = spawnSync(binaryPath, argv, {
    stdio: "inherit"
  });

  if (child.error) {
    console.error(child.error.message);
    process.exit(1);
  }

  if (child.signal) {
    process.kill(process.pid, child.signal);
  } else {
    process.exit(child.status ?? 1);
  }
}
