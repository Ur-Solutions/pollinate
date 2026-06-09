import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { execShell, shellQuote } from "./process.js";

const LAUNCHD_LABEL = "dev.pollinate.pollinated";

export function cliEntryPath(): string {
  return new URL("../dist/cli.js", import.meta.url).pathname;
}

export function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function systemdUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", "pollinated.service");
}

export async function installDaemon(): Promise<string> {
  if (platform() === "darwin") {
    const path = launchdPlistPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, launchdPlist(), { mode: 0o600 });
    await chmod(path, 0o600);
    await execShell(`launchctl bootout gui/$(id -u) ${shellQuote(path)} >/dev/null 2>&1 || true`);
    const result = await execShell(`launchctl bootstrap gui/$(id -u) ${shellQuote(path)}`);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "launchctl bootstrap failed");
    return path;
  }
  if (platform() === "linux") {
    const path = systemdUnitPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, systemdUnit(), { mode: 0o600 });
    await execShell("systemctl --user daemon-reload");
    const result = await execShell("systemctl --user enable --now pollinated.service");
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "systemctl enable failed");
    return path;
  }
  throw new Error(`daemon install is not supported on ${platform()}`);
}

export async function uninstallDaemon(): Promise<void> {
  if (platform() === "darwin") {
    const path = launchdPlistPath();
    await execShell(`launchctl bootout gui/$(id -u) ${shellQuote(path)} >/dev/null 2>&1 || true`);
    await rm(path, { force: true });
    return;
  }
  if (platform() === "linux") {
    await execShell("systemctl --user disable --now pollinated.service >/dev/null 2>&1 || true");
    await rm(systemdUnitPath(), { force: true });
    await execShell("systemctl --user daemon-reload >/dev/null 2>&1 || true");
    return;
  }
  throw new Error(`daemon uninstall is not supported on ${platform()}`);
}

export async function startDaemon(): Promise<void> {
  await serviceCommand("start");
}

export async function stopDaemon(): Promise<void> {
  await serviceCommand("stop");
}

export async function restartDaemon(): Promise<void> {
  await serviceCommand("restart");
}

export async function daemonStatus(): Promise<string> {
  if (platform() === "darwin") {
    const result = await execShell(`launchctl print gui/$(id -u)/${LAUNCHD_LABEL}`);
    return result.stdout || result.stderr;
  }
  if (platform() === "linux") {
    const result = await execShell("systemctl --user status pollinated.service --no-pager");
    return result.stdout || result.stderr;
  }
  throw new Error(`daemon status is not supported on ${platform()}`);
}

export async function daemonLogs(lines = 100): Promise<string> {
  if (platform() === "darwin") {
    const out = join(process.env.POLLINATE_STORE_ROOT || join(homedir(), ".pollinate"), "daemon.out.log");
    const err = join(process.env.POLLINATE_STORE_ROOT || join(homedir(), ".pollinate"), "daemon.err.log");
    const [stdout, stderr] = await Promise.all([
      readFile(out, "utf8").catch(() => ""),
      readFile(err, "utf8").catch(() => ""),
    ]);
    return [...stdout.split(/\n/), ...stderr.split(/\n/)].filter(Boolean).slice(-lines).join("\n");
  }
  if (platform() === "linux") {
    const result = await execShell(`journalctl --user -u pollinated.service -n ${lines} --no-pager`);
    return result.stdout || result.stderr;
  }
  throw new Error(`daemon logs are not supported on ${platform()}`);
}

async function serviceCommand(command: "start" | "stop" | "restart"): Promise<void> {
  if (platform() === "darwin") {
    const path = launchdPlistPath();
    if (command === "start") {
      const result = await execShell(`launchctl bootstrap gui/$(id -u) ${shellQuote(path)}`);
      if (result.exitCode !== 0 && !result.stderr.includes("already bootstrapped")) throw new Error(result.stderr.trim());
      return;
    }
    if (command === "stop") {
      await execShell(`launchctl bootout gui/$(id -u) ${shellQuote(path)}`);
      return;
    }
    await serviceCommand("stop").catch(() => undefined);
    await serviceCommand("start");
    return;
  }
  if (platform() === "linux") {
    const result = await execShell(`systemctl --user ${command} pollinated.service`);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `systemctl ${command} failed`);
    return;
  }
  throw new Error(`daemon ${command} is not supported on ${platform()}`);
}

function launchdPlist(): string {
  const root = process.env.POLLINATE_STORE_ROOT || join(homedir(), ".pollinate");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${cliEntryPath()}</string>
    <string>daemon</string>
    <string>run</string>
    <string>--foreground</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>POLLINATE_STORE_ROOT</key><string>${root}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(root, "daemon.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(root, "daemon.err.log")}</string>
</dict>
</plist>
`;
}

function systemdUnit(): string {
  return `[Unit]
Description=pollinate trigger daemon

[Service]
ExecStart=${process.execPath} ${cliEntryPath()} daemon run --foreground
Restart=always
Environment=POLLINATE_STORE_ROOT=${process.env.POLLINATE_STORE_ROOT || join(homedir(), ".pollinate")}

[Install]
WantedBy=default.target
`;
}
