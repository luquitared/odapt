// Starts a runner for a session. The runner is the same program everywhere;
// only how it gets started differs.

import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { controlEnv } from "./account";
import { DATA_DIR, LAUNCHER, PUBLIC_URL, ROOT, RUNNER_TOKEN, selfCommand } from "./config";

export async function launchRunner(sessionId: string): Promise<void> {
  if (LAUNCHER === "cloudrun") return launchCloudRun(sessionId);
  return launchLocal(sessionId);
}

function launchLocal(sessionId: string) {
  const logs = join(DATA_DIR, "logs");
  mkdirSync(logs, { recursive: true });
  const out = openSync(join(logs, `${sessionId}.runner.log`), "a");
  const [bin, ...args] = selfCommand("runner");
  const child = spawn(bin, [...args, sessionId], {
    cwd: ROOT,
    detached: true, // outlive a server restart; the runner parks itself when idle
    stdio: ["ignore", out, out],
    // The signed-in user's token is read at each launch, so a new sign-in reaches the next wake-up.
    env: { ...process.env, ...controlEnv(), SNAP_API: PUBLIC_URL, SNAP_TOKEN: RUNNER_TOKEN, SNAP_SESSION: sessionId },
  });
  child.unref();
}

// UNTESTED — written from the Cloud Run docs, not yet run against a project.
// One Job execution per wake-up; the session id rides in as an env override so
// prompts never appear in args. Needs: SNAP_CLOUDRUN_JOB, SNAP_CLOUDRUN_REGION,
// and gcloud authenticated as something with run.jobs.run.
async function launchCloudRun(sessionId: string) {
  const job = process.env.SNAP_CLOUDRUN_JOB ?? "snappy-runner";
  const region = process.env.SNAP_CLOUDRUN_REGION ?? "us-west1";
  const p = Bun.spawn(
    ["gcloud", "run", "jobs", "execute", job, "--region", region, "--async",
      "--update-env-vars", `SNAP_SESSION=${sessionId},SNAP_API=${PUBLIC_URL}`],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await p.exited) !== 0) throw new Error(`gcloud run jobs execute failed for ${sessionId}`);
}
