import * as fs from "node:fs";
import * as path from "node:path";

export function assertPrivate(stat: fs.Stats, directory: boolean): void {
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error("Metis shared-service files must be private and owned by this user.");
  }
}

export function readPrivateFile(
  home: string,
  name: string,
): { text: string; modifiedAt: number } | null {
  const file = path.join(home, name);
  if (!fs.existsSync(file)) return null;
  // POSIX ownership is verified here. Windows attachment needs an ACL-aware
  // credential reader before enabling this opt-in mode there.
  if (process.platform === "win32") {
    throw new Error("Shared-service desktop attachment is not available on Windows yet.");
  }
  const directory = fs.lstatSync(home);
  assertPrivate(directory, true);
  const before = fs.lstatSync(file);
  assertPrivate(before, false);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const current = fs.fstatSync(fd);
    assertPrivate(current, false);
    if (before.dev !== current.dev || before.ino !== current.ino || current.size > 16_384) {
      throw new Error("Metis shared-service file changed while opening it.");
    }
    const text = fs.readFileSync(fd, "utf8");
    const after = fs.lstatSync(home);
    if (directory.dev !== after.dev || directory.ino !== after.ino) {
      throw new Error("Metis shared-service directory changed while opening it.");
    }
    return { text, modifiedAt: current.mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}
