import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { installGithubWebhook } from "../src/index.js";
import { installCommandStub, withTempStore } from "./helpers.js";

describe("GitHub provider setup", () => {
  test("creates a PR router webhook through gh api", async () => {
    await withTempStore(async (_store, root) => {
      const argsLog = `${root}/gh-args.log`;
      const inputLog = `${root}/gh-input.json`;
      const gh = await installCommandStub(
        root,
        "gh",
        `#!/bin/sh
echo "$@" >> "${argsLog}"
if echo "$@" | grep -q -- "--method GET"; then
  printf '[]'
  exit 0
fi
cat > "${inputLog}"
printf '{"id":321}'
`,
        argsLog,
      );
      try {
        const result = await installGithubWebhook({
          repo: "trmd/pollinate",
          url: "https://hooks.example.com/hook/github/pr",
          secret: "top-secret",
          timeoutMs: 1_000,
        });

        expect(result).toMatchObject({
          provider: "github",
          action: "created",
          hookId: 321,
          secretConfigured: true,
        });
        expect(result.request.config.secret).toBe("<redacted>");
        const input = JSON.parse(await readFile(inputLog, "utf8"));
        expect(input).toMatchObject({
          name: "web",
          active: true,
          config: { url: "https://hooks.example.com/hook/github/pr", content_type: "json", secret: "top-secret" },
        });
        expect(input.events).toContain("pull_request");
        expect(input.events).toContain("issue_comment");
        expect(await gh.log()).toContain("repos/trmd/pollinate/hooks");
      } finally {
        gh.restore();
      }
    });
  });

  test("dry-run does not shell out to gh", async () => {
    const result = await installGithubWebhook({
      repo: "trmd/pollinate",
      url: "https://hooks.example.com/hook/github/pr",
      secret: "env:GITHUB_WEBHOOK_SECRET",
      dryRun: true,
    });

    expect(result.action).toBe("dry-run");
    expect(result.request.config.secret).toBe("<redacted>");
  });
});
