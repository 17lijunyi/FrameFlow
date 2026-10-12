import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';

// A single byte range lets the native player seek without downloading the film again.
export function parseByteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  let start;
  let end;
  if (!match[1]) {
    const count = Number(match[2]);
    if (!Number.isSafeInteger(count) || count <= 0) return false;
    start = Math.max(0, size - count);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return {start, end};
}

export async function streamFile(request, response, filePath, contentType) {
  const info = await stat(filePath);
  if (!info.isFile()) throw Object.assign(new Error('作品文件不存在'), {statusCode: 404});
  const range = parseByteRange(request.headers.range, info.size);
  const headers = {'Content-Type': contentType, 'Cache-Control': 'private, max-age=60', 'Accept-Ranges': 'bytes'};
  if (range === false) {
    response.writeHead(416, {...headers, 'Content-Range': `bytes */${info.size}`, 'Content-Length': 0});
    response.end();
    return;
  }
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`;
    headers['Content-Length'] = range.end - range.start + 1;
  } else headers['Content-Length'] = info.size;
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === 'HEAD') return response.end();
  const stream = createReadStream(filePath, range || {});
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}
