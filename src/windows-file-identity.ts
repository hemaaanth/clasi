import { dlopen, ptr } from "bun:ffi";
import type { Pointer } from "bun:ffi";

const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_ATTRIBUTE_TAG_INFO = 9;
const FILE_ID_INFO = 18;
const FILE_SHARE_READ = 0x1;
const FILE_SHARE_WRITE = 0x2;
const FILE_SHARE_DELETE = 0x4;
const GENERIC_READ = 0x8000_0000;
const OPEN_EXISTING = 3;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000;

const kernel32 = dlopen("kernel32.dll", {
  CreateFileW: {
    args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "ptr"],
    returns: "ptr",
  },
  GetFileInformationByHandleEx: {
    args: ["ptr", "i32", "ptr", "u32"],
    returns: "bool",
  },
  GetFileSizeEx: {
    args: ["ptr", "ptr"],
    returns: "bool",
  },
  ReadFile: {
    args: ["ptr", "ptr", "u32", "ptr", "ptr"],
    returns: "bool",
  },
  CloseHandle: {
    args: ["ptr"],
    returns: "bool",
  },
});

export interface WindowsFileIdentity {
  readonly volumeSerial: string;
  readonly fileId: string;
}

export interface WindowsIdentityFile {
  readonly identity: WindowsFileIdentity;
  readonly size: number;
  readUtf8(maximumBytes: number): string;
  close(): void;
}

export function readWindowsPathIdentity(path: string): WindowsFileIdentity {
  const handle = openPath(path, 0);
  try {
    return readHandleIdentity(handle);
  } finally {
    kernel32.symbols.CloseHandle(handle);
  }
}

export function openWindowsIdentityFile(path: string): WindowsIdentityFile {
  const handle = openPath(path, GENERIC_READ);
  try {
    const identity = readHandleIdentity(handle);
    const size = readHandleSize(handle);
    let closed = false;
    return {
      identity,
      size,
      readUtf8(maximumBytes: number): string {
        if (closed) throw new Error("windows-file-handle-closed");
        if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || size > maximumBytes) {
          throw new Error("windows-file-too-large");
        }
        const bytes = new Uint8Array(maximumBytes + 1);
        const bytesRead = new Uint8Array(4);
        if (!kernel32.symbols.ReadFile(
          handle,
          ptr(bytes),
          bytes.byteLength,
          ptr(bytesRead),
          null,
        )) {
          throw new Error("windows-file-read-failed");
        }
        const length = new DataView(bytesRead.buffer).getUint32(0, true);
        if (length > maximumBytes) throw new Error("windows-file-too-large");
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
      },
      close(): void {
        if (closed) return;
        closed = true;
        kernel32.symbols.CloseHandle(handle);
      },
    };
  } catch (error) {
    kernel32.symbols.CloseHandle(handle);
    throw error;
  }
}

export function sameWindowsFileIdentity(
  left: WindowsFileIdentity,
  right: WindowsFileIdentity,
): boolean {
  return left.volumeSerial === right.volumeSerial && left.fileId === right.fileId;
}

function openPath(path: string, desiredAccess: number): Pointer {
  const encodedPath = Buffer.from(`${path}\0`, "utf16le");
  const handle = kernel32.symbols.CreateFileW(
    ptr(encodedPath),
    desiredAccess,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    null,
    OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT,
    null,
  );
  if (!validHandle(handle)) throw new Error("windows-file-open-failed");
  return handle;
}

function readHandleIdentity(handle: Pointer): WindowsFileIdentity {
  const attributes = new Uint8Array(8);
  if (!kernel32.symbols.GetFileInformationByHandleEx(
    handle,
    FILE_ATTRIBUTE_TAG_INFO,
    ptr(attributes),
    attributes.byteLength,
  )) {
    throw new Error("windows-file-attributes-unavailable");
  }
  const attributeBits = new DataView(attributes.buffer).getUint32(0, true);
  if ((attributeBits & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) !== 0) {
    throw new Error("windows-file-not-regular");
  }

  const identity = new Uint8Array(24);
  if (!kernel32.symbols.GetFileInformationByHandleEx(
    handle,
    FILE_ID_INFO,
    ptr(identity),
    identity.byteLength,
  )) {
    throw new Error("windows-file-identity-unavailable");
  }
  const view = new DataView(identity.buffer);
  const volumeSerial = view.getBigUint64(0, true).toString(16).padStart(16, "0");
  const fileId = Buffer.from(identity.subarray(8)).toString("hex");
  return { volumeSerial, fileId };
}

function readHandleSize(handle: Pointer): number {
  const output = new Uint8Array(8);
  if (!kernel32.symbols.GetFileSizeEx(handle, ptr(output))) {
    throw new Error("windows-file-size-unavailable");
  }
  const size = new DataView(output.buffer).getBigInt64(0, true);
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("windows-file-too-large");
  }
  return Number(size);
}

function validHandle(handle: Pointer | null): handle is Pointer {
  return handle !== null && handle !== 0 && handle !== -1 && Number.isSafeInteger(handle);
}
