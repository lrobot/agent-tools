// build.ts: compiles core.ts to a native standalone binary. Invoked by the
// mise postinstall hook in the agent-tools mise.toml - see
// ~/.dotc/doc/design_cld_ts.md. Run directly (`bun run build.ts`), never
// compiled itself, so import.meta.dir is safe to use here.
import { spawnSync } from "child_process";
import { renameSync, rmSync, readdirSync, mkdirSync } from "fs";
import { homedir } from "os";
import path from "path";

const here = import.meta.dir;
const entry = path.join(here, "core.ts");
// Output lands in the per-machine user bin dir (~/.local/bin, i.e.
// %USERPROFILE%\.local\bin on Windows) rather than beside the sources:
// core.ts resolves its instance yamls (cld.*.yaml) relative to the binary,
// and that dir is already on PATH on every machine.
const bin = path.join(homedir(), ".local", "bin");
mkdirSync(bin, { recursive: true });
const outfile = path.join(bin, process.platform === "win32" ? "cld.exe" : "cld");

// Windows locks a running .exe against being overwritten (bun then fails with
// "failed to move executable to ...: EPERM"), which would break `mise install`
// whenever any cld session happens to be live. Renaming a running image IS
// allowed, so shunt the old one aside first and sweep the leftovers - the ones
// still in use will disappear on a later build, once their process has exited.
if (process.platform === "win32") {
  for (const f of readdirSync(bin)) {
    if (f.startsWith("cld.exe.old-")) {
      try {
        rmSync(path.join(bin, f));
      } catch {}
    }
  }
  try {
    renameSync(outfile, `${outfile}.old-${process.pid}`);
  } catch {
    // No previous binary, or nothing we can do - let bun report the real error.
  }
}

const res = spawnSync(
  "bun",
  ["build", "--bytecode", "--compile", entry, "--outfile", outfile],
  { stdio: "inherit" },
);

if (res.status !== 0) {
  console.error("cld-core build failed");
  process.exit(res.status ?? 1);
}

console.log(`built ${outfile}`);
