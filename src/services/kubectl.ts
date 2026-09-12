/** The current-main manifest fallback. No shell and no Kubernetes client dependency. */
import { execFile } from "child_process";
import { AdminOptions, buildAdminOptionArgs } from "./jmpProtocol";

export function buildKubectlApplyArgs(
  files: readonly string[],
  options: AdminOptions = {},
  dryRun = false,
): string[] {
  if (files.length === 0) {
    throw new Error("kubectl apply requires at least one manifest file");
  }
  const args = ["apply"];
  for (const file of files) {
    args.push("-f", file);
  }
  args.push(...buildAdminOptionArgs(options));
  if (dryRun) {
    args.push("--dry-run=server");
  }
  // Never collect entire objects: they may contain credentials. Resource names
  // also work consistently for single documents and multi-document manifests.
  return [...args, "-o", "name"];
}

export function runKubectlApply(
  executable: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1" },
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const message = code === "ENOENT"
          ? "kubectl was not found. Install it in the extension host environment or set jumpstarter.kubectlPath."
          : error.killed
            ? "kubectl apply timed out or exceeded its output limit; check the cluster before retrying."
            : stderr.trim() || error.message;
        reject(new Error(message));
      } else {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
    child.stdin?.end();
  });
}
