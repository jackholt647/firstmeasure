import { once } from "node:events";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { crc32, createDeflateRaw } from "node:zlib";

const MAX_32 = 0xffffffff;

type CentralEntry = { name: Buffer; crc: number; compressed: number; size: number; offset: number; time: number; date: number };

/**
 * Writes a ZIP archive to `output` one deflated entry at a time, so an export
 * far larger than memory streams straight to the response. Entries use data
 * descriptors (sizes after the data) and must each stay under 4 GiB, as must
 * the archive: callers split big files into parts (no ZIP64).
 */
export class ZipStream {
  readonly output = new PassThrough();
  private readonly entries: CentralEntry[] = [];
  private offset = 0;
  private open = false;
  // A reader that goes away (the browser closed) must not leave the writer waiting for "drain" forever.
  private readonly gone = new AbortController();
  private deflating: ReturnType<typeof createDeflateRaw> | null = null;

  constructor() {
    this.output.on("close", () => {
      const reason = new Error("The download was closed.");
      this.gone.abort(reason);
      this.deflating?.destroy(reason);
    });
  }

  /** Starts an entry; write its content with `write` and finish it with `close` before the next. */
  async entry(name: string) {
    if (this.open) throw new Error("A zip entry is still open.");
    this.open = true;
    const nameBytes = Buffer.from(name, "utf8");
    const { time, date } = dosDateTime(new Date());
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0808, 6); // sizes in a data descriptor; UTF-8 names
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt16LE(nameBytes.length, 26);
    const offset = this.offset;
    await this.raw(Buffer.concat([header, nameBytes]));

    const deflate = createDeflateRaw({ level: 6 });
    this.deflating = deflate;
    let crc = 0;
    let size = 0;
    let compressed = 0;
    deflate.on("data", (chunk: Buffer) => { compressed += chunk.length; });
    deflate.pipe(this.output, { end: false });
    const done = finished(deflate);
    done.catch(() => undefined);
    return {
      bytes: () => size,
      write: async (text: string) => {
        this.gone.signal.throwIfAborted();
        const chunk = Buffer.from(text, "utf8");
        crc = crc32(chunk, crc);
        size += chunk.length;
        if (size > MAX_32) throw new Error(`${name} is larger than a zip entry can hold.`);
        if (!deflate.write(chunk)) await once(deflate, "drain", { signal: this.gone.signal });
      },
      close: async () => {
        this.gone.signal.throwIfAborted();
        deflate.end();
        await done;
        deflate.unpipe(this.output);
        this.offset += compressed;
        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptor.writeUInt32LE(crc >>> 0, 4);
        descriptor.writeUInt32LE(compressed, 8);
        descriptor.writeUInt32LE(size, 12);
        await this.raw(descriptor);
        this.deflating = null;
        this.entries.push({ name: nameBytes, crc: crc >>> 0, compressed, size, offset, time, date });
        this.open = false;
      }
    };
  }

  /** Writes the central directory and ends the output. */
  async finish() {
    if (this.open) throw new Error("A zip entry is still open.");
    const start = this.offset;
    for (const entry of this.entries) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x0808, 8);
      record.writeUInt16LE(8, 10);
      record.writeUInt16LE(entry.time, 12);
      record.writeUInt16LE(entry.date, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(entry.compressed, 20);
      record.writeUInt32LE(entry.size, 24);
      record.writeUInt16LE(entry.name.length, 28);
      record.writeUInt32LE(entry.offset, 42);
      await this.raw(Buffer.concat([record, entry.name]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    await this.raw(end);
    this.output.end();
  }

  private async raw(bytes: Buffer) {
    this.gone.signal.throwIfAborted();
    if (this.offset + bytes.length > MAX_32) throw new Error("The export is larger than a zip archive can hold.");
    this.offset += bytes.length;
    if (!this.output.write(bytes)) await once(this.output, "drain", { signal: this.gone.signal });
  }
}

function dosDateTime(value: Date) {
  return {
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
    date: ((Math.max(1980, value.getFullYear()) - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate()
  };
}
