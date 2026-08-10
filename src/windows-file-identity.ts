import { dlopen, ptr } from "bun:ffi";

const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_ATTRIBUTE_TAG_INFO = 9;
const FILE_ID_INFO = 18;
const FILE_SHARE_READ = 0x1;
const FILE_SHARE_WRITE = 0x2;
const FILE_SHARE_DELETE = 0x4;
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
  CloseHandle: {
    args: ["ptr"],
    returns: "bool",
  },
});

const ucrt = dlopen("ucrtbase.dll", {
  _get_osfhandle: {
    args: ["i32"],
    returns: "ptr",
  },
});

export interface WindowsFileIdentity {
  readonly volumeSerial: string;
  readonly fileId: string;
}

export function readWindowsPathIdentity(path: string): WindowsFileIdentity {
  const encodedPath = Buffer.from(`${path}\0`, "utf16le");
  const handle = kernel32.symbols.CreateFileW(
    ptr(encodedPath),
    0,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    null,
    OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT,
    null,
  );
  if (!validHandle(handle)) throw new Error("windows-file-open-failed");
  try {
    return readHandleIdentity(handle);
  } finally {
    kernel32.symbols.CloseHandle(handle);
  }
}

export function readWindowsFileDescriptorIdentity(fileDescriptor: number): WindowsFileIdentity {
  const handle = ucrt.symbols._get_osfhandle(fileDescriptor);
  if (!validHandle(handle)) throw new Error("windows-file-handle-unavailable");
  return readHandleIdentity(handle);
}

export function sameWindowsFileIdentity(
  left: WindowsFileIdentity,
  right: WindowsFileIdentity,
): boolean {
  return left.volumeSerial === right.volumeSerial && left.fileId === right.fileId;
}

function readHandleIdentity(handle: number): WindowsFileIdentity {
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

function validHandle(handle: number | null): handle is number {
  return handle !== null && handle !== 0 && handle !== -1 && Number.isSafeInteger(handle);
}
