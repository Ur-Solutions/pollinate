import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { cliEntryPath, daemonLogs, launchdPlist, systemdUnit } from "../src/service.js";
import { withTempStore } from "./helpers.js";

function normalizeServiceText(text: string, root: string): string {
  return text.replaceAll(process.execPath, "<node>").replaceAll(cliEntryPath(), "<cli>").replaceAll(root, "<store>");
}

describe("service templates", () => {
  test("renders launchd plist with daemon run arguments and store logs", async () => {
    await withTempStore(async (_store, root) => {
      expect(normalizeServiceText(launchdPlist(), root)).toMatchInlineSnapshot(`
        "<?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key><string>dev.pollinate.pollinated</string>
          <key>ProgramArguments</key>
          <array>
            <string><node></string>
            <string><cli></string>
            <string>daemon</string>
            <string>run</string>
            <string>--foreground</string>
          </array>
          <key>EnvironmentVariables</key>
          <dict><key>POLLINATE_STORE_ROOT</key><string><store></string></dict>
          <key>RunAtLoad</key><true/>
          <key>KeepAlive</key><true/>
          <key>StandardOutPath</key><string><store>/daemon.out.log</string>
          <key>StandardErrorPath</key><string><store>/daemon.err.log</string>
        </dict>
        </plist>
        "
      `);
    });
  });

  test("renders systemd unit with daemon run command and store env", async () => {
    await withTempStore(async (_store, root) => {
      expect(normalizeServiceText(systemdUnit(), root)).toMatchInlineSnapshot(`
        "[Unit]
        Description=pollinate trigger daemon

        [Service]
        ExecStart=<node> <cli> daemon run --foreground
        Restart=always
        Environment=POLLINATE_STORE_ROOT=<store>

        [Install]
        WantedBy=default.target
        "
      `);
    });
  });

  test("daemonLogs tails the daemon log before consulting service logs", async () => {
    await withTempStore(async (_store, root) => {
      await writeFile(join(root, "daemon.log"), "old\nrecent\nlatest\n");

      await expect(daemonLogs(2)).resolves.toMatchInlineSnapshot(`
        "recent
        latest"
      `);
    });
  });
});
