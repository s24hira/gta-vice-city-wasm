function shouldIgnoreEntry(name) {
    const parts = name.split('/');
    const base = parts[parts.length - 1];
    return !name || base === '.DS_Store' || base.startsWith('._');
}

class ByteQueue {
    constructor() {
        this.chunks = [];
        this.headOffset = 0;
        this.totalLength = 0;
    }

    push(chunk) {
        if (chunk && chunk.byteLength > 0) {
            this.chunks.push(chunk);
            this.totalLength += chunk.byteLength;
        }
    }

    read(n) {
        if (n > this.totalLength) return null;
        if (n === 0) return new Uint8Array(0);

        const first = this.chunks[0];
        const availableInFirst = first.byteLength - this.headOffset;

        if (availableInFirst === n) {
            const result = first.subarray(this.headOffset, this.headOffset + n);
            this.chunks.shift();
            this.headOffset = 0;
            this.totalLength -= n;
            return result;
        }

        if (availableInFirst > n) {
            const result = first.subarray(this.headOffset, this.headOffset + n);
            this.headOffset += n;
            this.totalLength -= n;
            return result;
        }

        const result = new Uint8Array(n);
        let written = 0;
        while (written < n) {
            const cur = this.chunks[0];
            const avail = cur.byteLength - this.headOffset;
            const take = Math.min(avail, n - written);
            result.set(cur.subarray(this.headOffset, this.headOffset + take), written);
            written += take;
            this.headOffset += take;
            this.totalLength -= take;
            if (this.headOffset === cur.byteLength) {
                this.chunks.shift();
                this.headOffset = 0;
            }
        }
        return result;
    }

    skip(n) {
        if (n > this.totalLength) return false;
        let remaining = n;
        while (remaining > 0) {
            const cur = this.chunks[0];
            const avail = cur.byteLength - this.headOffset;
            const take = Math.min(avail, remaining);
            this.headOffset += take;
            this.totalLength -= take;
            remaining -= take;
            if (this.headOffset === cur.byteLength) {
                this.chunks.shift();
                this.headOffset = 0;
            }
        }
        return true;
    }

    takeAvailable(maxBytes) {
        if (this.totalLength === 0) return null;
        const toTake = Math.min(maxBytes, this.totalLength);
        return this.read(toTake);
    }
}

const dirCache = new Map();

async function getDirHandleCached(root, pathParts) {
    let current = root;
    let accumulatedPath = "";
    for (const part of pathParts) {
        accumulatedPath += "/" + part;
        let handle = dirCache.get(accumulatedPath);
        if (!handle) {
            handle = await current.getDirectoryHandle(part, { create: true });
            dirCache.set(accumulatedPath, handle);
        }
        current = handle;
    }
    return current;
}

async function openFileForWriting(root, name) {
    const parts = name.split('/');
    const dirParts = parts.slice(0, parts.length - 1);
    const fileName = parts[parts.length - 1];

    const dir = await getDirHandleCached(root, dirParts);
    const fh = await dir.getFileHandle(fileName, { create: true });

    if (fh.createSyncAccessHandle) {
        const handle = await fh.createSyncAccessHandle();
        handle.truncate(0);
        let offset = 0;
        return {
            write: (chunk) => {
                handle.write(chunk, { at: offset });
                offset += chunk.byteLength;
            },
            close: () => {
                handle.flush();
                handle.close();
            }
        };
    }

    const writable = await fh.createWritable();
    return {
        write: async (chunk) => {
            await writable.write(chunk);
        },
        close: async () => {
            await writable.close();
        }
    };
}

async function writeMarkerFile(root, name, text) {
    const fileWriter = await openFileForWriting(root, name);
    const data = new TextEncoder().encode(text);
    await fileWriter.write(data);
    await fileWriter.close();
}

self.onmessage = async (event) => {
    const { file } = event.data;
    try {
        self.postMessage({ type: 'progress', phase: 'extracting', pct: 0, done: 0 });

        const root = await navigator.storage.getDirectory();
        dirCache.clear();

        // Track progress using compressed stream bytes read
        let loadedCompressedBytes = 0;
        let lastReportedPct = 0;
        const fileSize = file.size || 1;

        const progressTrackingStream = new TransformStream({
            transform(chunk, controller) {
                loadedCompressedBytes += chunk.byteLength;
                const pct = Math.min(99, Math.round((loadedCompressedBytes / fileSize) * 100));
                if (pct > lastReportedPct) {
                    lastReportedPct = pct;
                    self.postMessage({
                        type: 'progress',
                        phase: 'extracting',
                        pct,
                        done: filesExtracted,
                    });
                }
                controller.enqueue(chunk);
            }
        });

        // Decompress GZIP on the fly
        const decompressedStream = file.stream()
            .pipeThrough(progressTrackingStream)
            .pipeThrough(new DecompressionStream('gzip'));

        const reader = decompressedStream.getReader();
        const queue = new ByteQueue();
        const dec = new TextDecoder();

        let filesExtracted = 0;
        let pendingLongName = null;

        // Current entry extraction state
        let currentEntry = null; // { name, size, bytesWritten, padding, fileWriter, isDir, ignore }
        let isEOF = false;

        async function processQueue() {
            while (true) {
                if (currentEntry) {
                    // We are streaming file contents
                    const needed = currentEntry.size - currentEntry.bytesWritten;
                    if (needed > 0) {
                        const chunk = queue.takeAvailable(needed);
                        if (!chunk) return; // need more data from stream

                        if (currentEntry.isLongName) {
                            currentEntry.longNameBuffer.set(chunk, currentEntry.bytesWritten);
                        } else if (!currentEntry.ignore && currentEntry.fileWriter) {
                            await currentEntry.fileWriter.write(chunk);
                        }
                        currentEntry.bytesWritten += chunk.byteLength;
                    }

                    // Done with file payload; now consume tar 512-byte block padding
                    if (currentEntry.bytesWritten >= currentEntry.size) {
                        if (currentEntry.padding > 0) {
                            if (queue.totalLength < currentEntry.padding) {
                                return; // wait for padding bytes
                            }
                            queue.skip(currentEntry.padding);
                        }

                        if (currentEntry.isLongName) {
                            pendingLongName = dec.decode(currentEntry.longNameBuffer).replace(/\0/g, '');
                        } else if (!currentEntry.ignore && currentEntry.fileWriter) {
                            await currentEntry.fileWriter.close();
                            filesExtracted++;
                            if (filesExtracted % 100 === 0) {
                                self.postMessage({
                                    type: 'progress',
                                    phase: 'extracting',
                                    pct: lastReportedPct,
                                    done: filesExtracted,
                                });
                            }
                        }

                        currentEntry = null;
                    }
                    continue;
                }

                // Need 512 bytes for header
                if (queue.totalLength < 512) return;

                const header = queue.read(512);

                // Check for two consecutive all-zero blocks or end of archive
                let allZero = true;
                for (let i = 0; i < 512; i++) {
                    if (header[i] !== 0) {
                        allZero = false;
                        break;
                    }
                }

                if (allZero) {
                    isEOF = true;
                    return;
                }

                const readStr = (start, len) => {
                    let end = start;
                    while (end < start + len && header[end] !== 0) end++;
                    return dec.decode(header.subarray(start, end));
                };

                const typeflag = String.fromCharCode(header[156]);
                const rawName = readStr(0, 100);
                const prefix = readStr(345, 155);
                const size = parseInt(readStr(124, 12).trim(), 8) || 0;
                const paddedSize = Math.ceil(size / 512) * 512;
                const padding = paddedSize - size;

                if (typeflag === 'L') {
                    // Long name entry: read long name from next bytes
                    if (queue.totalLength < paddedSize) {
                        // Put header back or wait
                        // Since we already read 512 bytes, we can wait for paddedSize
                        // by creating a temporary pending object
                        currentEntry = {
                            name: '__long_name__',
                            size,
                            bytesWritten: 0,
                            padding,
                            fileWriter: null,
                            ignore: false,
                            isLongName: true,
                            longNameBuffer: new Uint8Array(size),
                        };
                        continue;
                    }
                    const nameBytes = queue.read(size);
                    queue.skip(padding);
                    pendingLongName = dec.decode(nameBytes).replace(/\0/g, '');
                    continue;
                }

                // Ignore non-regular entries (symlinks, devices, etc.) except directories
                const isDir = typeflag === '5' || rawName.endsWith('/');
                const isRegularFile = typeflag === '0' || typeflag === '' || typeflag === '\0';

                let name = pendingLongName || (prefix ? prefix + '/' + rawName : rawName);
                pendingLongName = null;
                name = name.replace(/\0/g, '').replace(/\/$/, '');

                const ignore = shouldIgnoreEntry(name) || (!isRegularFile && !isDir);

                if (ignore || isDir) {
                    if (isDir && !shouldIgnoreEntry(name)) {
                        const dirParts = name.split('/').filter(Boolean);
                        if (dirParts.length > 0) {
                            await getDirHandleCached(root, dirParts);
                        }
                    }
                    if (size > 0) {
                        currentEntry = {
                            name,
                            size,
                            bytesWritten: 0,
                            padding,
                            fileWriter: null,
                            ignore: true,
                        };
                    }
                    continue;
                }

                // Regular file: open writer
                let writer = null;
                try {
                    writer = await openFileForWriting(root, name);
                } catch (err) {
                    console.warn(`[extract-worker] Failed to open ${name} for writing:`, err);
                }

                currentEntry = {
                    name,
                    size,
                    bytesWritten: 0,
                    padding,
                    fileWriter: writer,
                    ignore: !writer,
                };
            }
        }

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            queue.push(value);
            await processQueue();
            if (isEOF) break;
        }

        // Finish processing any remaining entries
        await processQueue();

        // Write marker file to indicate success
        await writeMarkerFile(root, '_game_ready', 'v4');

        self.postMessage({ type: 'progress', phase: 'extracting', pct: 100, done: filesExtracted });
        self.postMessage({ type: 'done' });
    } catch (err) {
        console.error('[extract-worker] Extraction failed:', err);
        self.postMessage({ type: 'error', message: err.message });
    }
};
