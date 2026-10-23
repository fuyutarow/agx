// Internal, flag-free transport: argv and its canonical job envelope must agree.
// FAIL CLOSED: never exec the target if kernel write denial cannot be installed.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { open, realpath, stat } from "node:fs/promises";
// This helper is embedded as text and evaluated in a separate Bun process.
// Keep it standalone: the restricted exec must never load repository modules.
const fatal = (message: string): never => {
  process.stderr.write(
    `FATAL: read-only VCS isolation: ${message}; target was not started\n`,
  );
  process.exit(2);
};

async function main(): Promise<void> {
  // argv-forwarding: native execv (no flag interpretation). Comparing the envelope
  // validates the entire string tuple without loading a repository JSON decoder.
  const [, cwd, ...argv] = process.argv;
  if (
    cwd === undefined ||
    process.env.AGX_READONLY_COMMAND_JOB !== JSON.stringify({ argv, cwd })
  )
    return fatal("missing or invalid internal job");
  const [requested, ...args] = argv;
  if (requested === undefined) return fatal("empty command");
  // These variables belong to the helper, not the target executable.
  delete process.env.AGX_READONLY_COMMAND_JOB;
  delete process.env.BUN_BE_BUN;
  const found = Bun.which(requested);
  if (found === null) return fatal(`executable unavailable: ${requested}`);
  const executable = await realpath(found);
  process.chdir(cwd);
  const targetArgv = [executable, ...args];
  let execArgv = targetArgv;
  let libPath: string;
  if (process.platform === "linux") libPath = "libc.so.6";
  else if (process.platform === "darwin") {
    libPath = "/usr/lib/libSystem.B.dylib";
    if (Bun.which("/usr/bin/sandbox-exec") === null)
      return fatal("sandbox-exec is unavailable");
    // All paths are read-only, including shared stores reached through symlinks.
    execArgv = [
      "/usr/bin/sandbox-exec",
      "-p",
      '(version 1)(allow default)(deny file-write* (require-not (literal "/dev/null")))',
      ...targetArgv,
    ];
  } else return fatal(`unsupported platform ${process.platform}`);

  const native = dlopen(libPath, {
    execv: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    unsetenv: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  // execv inherits libc's environment, which Bun's process.env deletion does not
  // update. Clear the native transport too, especially before executing a compiled target.
  for (const name of ["BUN_BE_BUN", "AGX_READONLY_COMMAND_JOB"]) {
    const key = Buffer.from(`${name}\0`);
    if (native.symbols.unsetenv(ptr(key)) !== 0)
      return fatal(`cannot clear internal environment ${name}`);
  }
  // Prepare every exec argument BEFORE restricting the current native thread.
  // Direct execv is essential: a multithreaded runtime must not dispatch spawn
  // through a different, unrestricted thread. Exec replaces all runtime threads.
  const strings = execArgv.map((arg) => Buffer.from(`${arg}\0`));
  const executableString = strings[0];
  if (executableString === undefined) return fatal("empty exec command");
  const pointers = new BigUint64Array([
    ...strings.map((value) => BigInt(ptr(value))),
    0n,
  ]);
  if (process.platform === "linux") {
    if (process.arch !== "x64" && process.arch !== "arm64")
      return fatal(`unsupported Linux architecture ${process.arch}`);
    const linux = dlopen("libc.so.6", {
      syscall: {
        args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64],
        returns: FFIType.i64,
      },
      prctl: {
        args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
      },
    });
    const { syscall, prctl } = linux.symbols;
    const abi = Number(syscall(444, 0, 0, 1, 0));
    if (abi < 3) return fatal(`Landlock ABI >=3 required, found ${abi}`);
    // UAPI bits: WRITE_FILE=1, REMOVE_DIR..TRUNCATE=4..14, IOCTL_DEV=15.
    // Deny filesystem mutation, not just one spelling of .jj. Git opens /dev/null
    // read/write even for reads; that character device is the sole write exception.
    const writeMask = 2 | 0x7ff0 | (abi >= 5 ? 0x8000 : 0);
    const attr = new BigUint64Array([BigInt(writeMask)]);
    const fd = Number(syscall(444, ptr(attr), attr.byteLength, 0, 0));
    if (fd < 0) return fatal("landlock_create_ruleset failed");
    if (!(await stat("/dev/null")).isCharacterDevice()) {
      native.symbols.close(fd);
      return fatal("/dev/null must be a character device");
    }
    // Linux UAPI O_PATH | O_CLOEXEC. No writable file descriptor is inherited.
    const nullFile = await open("/dev/null", 0x200000 | 0x80000);
    const nullRule = new BigUint64Array([
      BigInt(2 | (abi >= 5 ? 0x8000 : 0)),
      BigInt(nullFile.fd),
    ]);
    const added = Number(syscall(445, fd, 1, ptr(nullRule), 0));
    await nullFile.close();
    if (added !== 0) {
      native.symbols.close(fd);
      return fatal("landlock_add_rule for /dev/null failed");
    }
    if (prctl(38, 1, 0, 0, 0) !== 0) {
      native.symbols.close(fd);
      return fatal("PR_SET_NO_NEW_PRIVS failed");
    }
    const restricted = Number(syscall(446, fd, 0, 0, 0));
    native.symbols.close(fd);
    if (restricted !== 0) return fatal("landlock_restrict_self failed");
  }
  native.symbols.execv(ptr(executableString), ptr(pointers));
  fatal(`execv failed for ${execArgv[0]}`);
}

await main().catch((error: unknown) => fatal(String(error)));
