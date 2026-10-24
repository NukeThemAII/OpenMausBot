// The Local VM's website sign-ins live in browser profiles. These run the image's real start-up script and the real rescue
// against a fake home, workspace and container runtime, so "sign-ins survive replacing the desktop" is checked, not assumed.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { VM_WORKSPACE_GUEST, managedImageDockerfile, type LocalVmTarget } from "./container-computer.ts";
import { rescueFirefoxProfile } from "./local-vm-profiles.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-vm-profiles-"));
  temporary.push(dir);
  return dir;
};

/** The exact printf the image runs to write prepare-openmausbot-workspace.sh, pointed at a scratch workspace. */
function prepareScript(dir: string, workspace: string): string {
  const dockerfile = managedImageDockerfile();
  const end = dockerfile.indexOf("> /usr/local/bin/prepare-openmausbot-workspace.sh");
  const start = dockerfile.lastIndexOf("RUN printf", end);
  expect(start).toBeGreaterThan(-1);
  const script = join(dir, "prepare.sh");
  const printf = dockerfile.slice(start + "RUN ".length, end).replaceAll(VM_WORKSPACE_GUEST, workspace);
  execFileSync("/bin/sh", ["-c", `${printf} > '${script}'`]);
  return script;
}

const runPrepare = (script: string, home: string) => execFileSync("/bin/sh", [script], { env: { PATH: process.env.PATH, HOME: home } });

describe.skipIf(process.platform === "win32")("the image's start-up script keeps Firefox's profile in the workspace", () => {
  it("moves a first-run Firefox profile into the workspace and points ~/.mozilla at it", () => {
    const dir = scratch();
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    mkdirSync(join(home, ".mozilla", "firefox"), { recursive: true });
    writeFileSync(join(home, ".mozilla", "firefox", "profiles.ini"), "[Profile0]\nPath=abc.default-esr\n");
    mkdirSync(workspace);
    runPrepare(prepareScript(dir, workspace), home);
    const durable = join(workspace, ".browser-profiles", "mozilla");
    expect(lstatSync(join(home, ".mozilla")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(home, ".mozilla"))).toBe(durable);
    expect(readFileSync(join(durable, "firefox", "profiles.ini"), "utf8")).toContain("abc.default-esr");
    // Chrome and Chromium keep working as before.
    expect(readlinkSync(join(home, ".config", "google-chrome"))).toBe(join(workspace, ".browser-profiles", "google-chrome"));
    expect(readlinkSync(join(home, ".config", "chromium"))).toBe(join(workspace, ".browser-profiles", "chromium"));
  });

  it("keeps a durable profile over the image's empty one and clears the old desktop's Firefox locks", () => {
    const dir = scratch();
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    // A new container: the image's own empty ~/.mozilla/firefox, and the profile rescued from the old desktop.
    mkdirSync(join(home, ".mozilla", "firefox"), { recursive: true });
    const profile = join(workspace, ".browser-profiles", "mozilla", "firefox", "abc.default-esr");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "cookies.sqlite"), "signed in");
    // Firefox's lock names the old container's address, so a new container would think another machine holds the profile.
    symlinkSync("172.17.0.5:+123", join(profile, "lock"));
    writeFileSync(join(profile, ".parentlock"), "");
    writeFileSync(join(profile, "lockfile.json"), "{}");
    runPrepare(prepareScript(dir, workspace), home);
    expect(readlinkSync(join(home, ".mozilla"))).toBe(join(workspace, ".browser-profiles", "mozilla"));
    expect(readFileSync(join(home, ".mozilla", "firefox", "abc.default-esr", "cookies.sqlite"), "utf8")).toBe("signed in");
    expect(existsSync(join(profile, ".parentlock"))).toBe(false);
    expect(() => lstatSync(join(profile, "lock"))).toThrow();
    expect(existsSync(join(profile, "lockfile.json"))).toBe(true);
    // A second start changes nothing.
    runPrepare(prepareScript(dir, workspace), home);
    expect(readFileSync(join(profile, "cookies.sqlite"), "utf8")).toBe("signed in");
  });
});

/** A container runtime whose `cp` copies out of a fixture "container" tree, as docker cp does for a stopped container. */
function fakeRuntime(dir: string, container: string, opts: { fail?: string } = {}) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "runtime.log");
  const runtime = join(bin, "docker");
  writeFileSync(runtime, `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
[ "$1" = cp ] || { echo "unexpected: $*" >&2; exit 64; }
${opts.fail ? `echo '${opts.fail}' >&2; exit 1` : ""}
src="\${2#*:}"
[ -e "${container}$src" ] || [ -L "${container}$src" ] || { echo "Error response from daemon: Could not find the file $src in container omb" >&2; exit 1; }
[ -e "$3" ] && { echo "destination exists" >&2; exit 1; }
cp -RP "${container}$src" "$3"
`);
  chmodSync(runtime, 0o755);
  return { runtime, log };
}

const target = (workspaceDir: string): LocalVmTarget => ({ key: "bot:x", containerName: "openmausbot-computer-x", workspaceDir, viewerPort: null, label: "x" });

describe.skipIf(process.platform === "win32")("rescueFirefoxProfile", () => {
  it("copies an old desktop's Firefox profile into the workspace before the desktop is removed", async () => {
    const dir = scratch();
    const container = join(dir, "container");
    mkdirSync(join(container, "home", "cua", ".mozilla", "firefox", "abc.default-esr"), { recursive: true });
    writeFileSync(join(container, "home", "cua", ".mozilla", "firefox", "abc.default-esr", "cookies.sqlite"), "signed in");
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    const { runtime, log } = fakeRuntime(dir, container);
    expect(await rescueFirefoxProfile(runtime, target(workspace))).toBe("rescued");
    expect(readFileSync(join(workspace, ".browser-profiles", "mozilla", "firefox", "abc.default-esr", "cookies.sqlite"), "utf8")).toBe("signed in");
    const [copy] = readFileSync(log, "utf8").trim().split("\n");
    expect(copy).toMatch(/^cp openmausbot-computer-x:\/home\/cua\/\.mozilla \S+\/\.browser-profiles\/\.mozilla-rescue-[0-9a-f]+$/);
    expect(copy.startsWith(`cp openmausbot-computer-x:/home/cua/.mozilla ${join(workspace, ".browser-profiles")}/`)).toBe(true);
    expect(readdirSync(join(workspace, ".browser-profiles"))).toEqual(["mozilla"]);
  });

  it("never overwrites a profile already in the workspace, and leaves a desktop whose ~/.mozilla is already a link alone", async () => {
    const dir = scratch();
    const container = join(dir, "container");
    mkdirSync(join(container, "home", "cua"), { recursive: true });
    symlinkSync("/home/cua/workspace/.browser-profiles/mozilla", join(container, "home", "cua", ".mozilla"));
    const workspace = join(dir, "workspace");
    const { runtime } = fakeRuntime(dir, container);
    mkdirSync(workspace);
    expect(await rescueFirefoxProfile(runtime, target(workspace))).toBe("none");
    expect(existsSync(join(workspace, ".browser-profiles", "mozilla"))).toBe(false);
    expect(readdirSync(join(workspace, ".browser-profiles"))).toEqual([]);
    mkdirSync(join(workspace, ".browser-profiles", "mozilla", "firefox"), { recursive: true });
    writeFileSync(join(workspace, ".browser-profiles", "mozilla", "firefox", "profiles.ini"), "kept");
    expect(await rescueFirefoxProfile(runtime, target(workspace))).toBe("kept");
    expect(readFileSync(join(workspace, ".browser-profiles", "mozilla", "firefox", "profiles.ini"), "utf8")).toBe("kept");
  });

  it("reports a desktop that never ran Firefox as nothing to rescue, and fails loudly on any other copy error", async () => {
    const dir = scratch();
    const container = join(dir, "container");
    mkdirSync(join(container, "home", "cua"), { recursive: true });
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    expect(await rescueFirefoxProfile(fakeRuntime(dir, container).runtime, target(workspace))).toBe("none");
    const broken = scratch();
    await expect(rescueFirefoxProfile(fakeRuntime(broken, container, { fail: "permission denied" }).runtime, target(workspace)))
      .rejects.toThrow(/permission denied/);
    expect(readdirSync(join(workspace, ".browser-profiles"))).toEqual([]);
  });
});
