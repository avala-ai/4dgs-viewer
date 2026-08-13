import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SDK_REPOSITORY = "https://github.com/avala-ai/4dgs.git";
const SDK_COMMIT = "5fca7545783974ed0b227ed144688926f6976f86";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packsDirectory = join(repositoryRoot, ".sdk-packs");
const sourceDirectory = mkdtempSync(join(tmpdir(), "4dgs-viewer-sdk-"));
const environment = {
  ...process.env,
  CI: "1",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
};

function run(command, args, cwd = sourceDirectory) {
  execFileSync(command, args, { cwd, env: environment, stdio: "inherit" });
}

try {
  rmSync(packsDirectory, { force: true, recursive: true });
  mkdirSync(packsDirectory, { recursive: true });

  run("git", ["init", "--quiet"]);
  run("git", ["remote", "add", "origin", SDK_REPOSITORY]);
  run("git", ["fetch", "--depth=1", "origin", SDK_COMMIT]);
  run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);

  const checkedOutCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceDirectory,
    encoding: "utf8",
  }).trim();
  if (checkedOutCommit !== SDK_COMMIT) {
    throw new Error(
      `Expected 4dgs ${SDK_COMMIT}, checked out ${checkedOutCommit}`,
    );
  }

  run("corepack", [
    "yarn",
    "workspaces",
    "focus",
    "4dgs-workspace",
    "@4dgs/core",
    "@4dgs/browser",
  ]);
  // Invoke the repository-pinned compiler from the workspace root. Running the package
  // scripts through `yarn workspace` changes executable lookup to the package directory
  // and can select an unrelated host `tsc` instead of the root's TypeScript 5.6.3.
  run("corepack", [
    "yarn",
    "exec",
    "tsc",
    "-b",
    "typescript/core",
    "typescript/browser",
  ]);
  run("corepack", [
    "yarn",
    "workspace",
    "@4dgs/core",
    "pack",
    "--out",
    join(packsDirectory, "4dgs-core.tgz"),
  ]);
  run("corepack", [
    "yarn",
    "workspace",
    "@4dgs/browser",
    "pack",
    "--out",
    join(packsDirectory, "4dgs-browser.tgz"),
  ]);

  console.log(`Packed @4dgs/core and @4dgs/browser from ${SDK_COMMIT}`);
} finally {
  rmSync(sourceDirectory, { force: true, recursive: true });
}
