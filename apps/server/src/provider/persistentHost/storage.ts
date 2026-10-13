import {
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/** Reject permissive/symlinked capability storage instead of trusting a pathname or PID. */
export function privateDirectory(directory: string): void {
  if (!path.isAbsolute(directory)) throw new Error("Persistent host directory must be absolute");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error("Persistent host directory must be owner-only and not a symlink");
  }
}

export function readPrivateFile(file: string, maxBytes = 4 * 1024 * 1024): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > maxBytes ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new Error("Unsafe persistent host capability file");
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Same-directory atomic replacement with file and directory durability. */
export function writePrivateFile(file: string, contents: string): void {
  const temporary = `${file}.next`;
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new Error("Unsafe persistent host temporary file");
    }
    ftruncateSync(fd, 0);
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  const directoryFd = openSync(path.dirname(file), constants.O_RDONLY);
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

export function removePrivateFile(file: string): void {
  if (existsSync(file)) unlinkSync(file);
}
