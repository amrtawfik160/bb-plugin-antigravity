// Download the shubzkothekar/antigravity-acp stdio adapter into ~/.local/bin.
//
// agy has no ACP mode of its own. This binary is the missing piece, and it is
// the one users otherwise have to hunt for on GitHub Releases.

import { createWriteStream } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { isExecutable } from "./config.js";

export const ADAPTER_REPO = "shubzkothekar/antigravity-acp";
/** Used when the live "latest" redirect is unreachable. */
export const ADAPTER_PINNED_TAG = "v1.1.0";
export const ADAPTER_RELEASES =
  `https://github.com/${ADAPTER_REPO}/releases`;

export interface AdapterTarget {
  platform: string;
  arch: string;
  asset: string;
  fileName: string;
}

export interface AdapterInstallResult {
  path: string;
  downloaded: boolean;
  asset: string;
  source: string;
}

const DOWNLOAD_TIMEOUT_MS = 120_000;

export function adapterFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "agy-acp.exe" : "agy-acp";
}

export function defaultAdapterPath(
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(home, ".local", "bin", adapterFileName(platform));
}

/**
 * Map Node's platform/arch onto the release asset names.
 * Returns undefined for OS/arch combinations the project does not ship.
 */
export function adapterTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): AdapterTarget | undefined {
  const osPart =
    platform === "linux"
      ? "linux"
      : platform === "darwin"
        ? "darwin"
        : platform === "win32"
          ? "windows"
          : undefined;
  const archPart =
    arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : undefined;
  if (!osPart || !archPart) return undefined;
  const asset =
    platform === "win32"
      ? `agy-acp-${osPart}-${archPart}.exe`
      : `agy-acp-${osPart}-${archPart}`;
  return {
    platform,
    arch,
    asset,
    fileName: adapterFileName(platform),
  };
}

function releaseUrl(tag: string, asset: string): string {
  if (tag === "latest") {
    return `${ADAPTER_RELEASES}/latest/download/${asset}`;
  }
  return `${ADAPTER_RELEASES}/download/${tag}/${asset}`;
}

function looksLikeBinary(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  // ELF
  if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
    return true;
  }
  // Mach-O 64-bit (little/big endian) and Mach-O fat
  if (bytes[0] === 0xcf && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe) {
    return true;
  }
  if (bytes[0] === 0xce && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe) {
    return true;
  }
  if (bytes[0] === 0xca && bytes[1] === 0xfe && bytes[2] === 0xba && bytes[3] === 0xbe) {
    return true;
  }
  // PE
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return true;
  return false;
}

async function downloadToFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  }
  const tmp = `${destination}.${process.pid}.download`;
  try {
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      createWriteStream(tmp),
    );
    const handle = await open(tmp, "r");
    try {
      const header = new Uint8Array(4);
      const { bytesRead } = await handle.read(header, 0, 4, 0);
      if (bytesRead < 4 || !looksLikeBinary(header)) {
        throw new Error(
          `Downloaded ${url} but the file is not an executable (GitHub may have returned an HTML error page).`,
        );
      }
    } finally {
      await handle.close();
    }
    await chmod(tmp, 0o755);
    await rename(tmp, destination);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

/**
 * Put `agy-acp` on disk if it is not already there. Existing executables are
 * left alone unless `force` is set.
 */
export async function installAdapter(options: {
  dest?: string;
  force?: boolean;
} = {}): Promise<AdapterInstallResult> {
  const target = adapterTarget();
  if (!target) {
    throw new Error(
      `No agy-acp build for ${process.platform}/${process.arch}. ${ADAPTER_RELEASES} lists the supported ones.`,
    );
  }

  const dest = options.dest ?? defaultAdapterPath();
  await mkdir(path.dirname(dest), { recursive: true });

  if (!options.force && (await isExecutable(dest))) {
    return {
      path: dest,
      downloaded: false,
      asset: target.asset,
      source: dest,
    };
  }

  const sources = [
    releaseUrl("latest", target.asset),
    releaseUrl(ADAPTER_PINNED_TAG, target.asset),
  ];
  let lastError: Error | undefined;
  for (const source of sources) {
    try {
      await downloadToFile(source, dest);
      return {
        path: dest,
        downloaded: true,
        asset: target.asset,
        source,
      };
    } catch (error) {
      lastError = error as Error;
    }
  }
  throw new Error(
    `Could not download ${target.asset}. ${lastError?.message ?? "unknown error"}. ` +
      `Get it from ${ADAPTER_RELEASES} and place it at ${dest}.`,
  );
}
