import { createReadStream } from "node:fs";
import { mkdir, rename, writeFile, access } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { config } from "../config.js";

/**
 * File storage behind a tiny interface. Local disk (a Docker volume) in dev; in production the same two
 * methods are backed by a private S3 bucket (see DEPLOYMENT.md). Files are never served directly:
 * every download goes through an authorised API route.
 */
export interface Storage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Readable>;
}

class LocalStorage implements Storage {
  private resolve(key: string) {
    if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error("invalid storage key"); // no path traversal
    return path.resolve(config.STORAGE_DIR, key);
  }
  async put(key: string, data: Buffer) {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, dest); // atomic: readers see the old or the new file, never half of one
  }
  async get(key: string) {
    const src = this.resolve(key);
    await access(src);
    return createReadStream(src);
  }
}

export const storage: Storage = new LocalStorage();
