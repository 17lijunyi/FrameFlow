import {describe, expect, it} from 'vitest';
import {parseByteRange} from './artifact-stream.mjs';

describe('video player byte ranges', () => {
  it('serves explicit, open and suffix seeks', () => {
    expect(parseByteRange('bytes=5-10', 20)).toEqual({start: 5, end: 10});
    expect(parseByteRange('bytes=5-', 20)).toEqual({start: 5, end: 19});
    expect(parseByteRange('bytes=-5', 20)).toEqual({start: 15, end: 19});
    expect(parseByteRange('bytes=10-40', 20)).toEqual({start: 10, end: 19});
    expect(parseByteRange('bytes=-40', 20)).toEqual({start: 0, end: 19});
  });
  it('rejects empty, out of range, reversed and multipart ranges', () => {
    for (const header of ['bytes=-', 'bytes=-0', 'bytes=20-', 'bytes=10-5', 'bytes=1-2,4-5', 'bytes=NaN-', 'bytes=999999999999999999999-']) {
      expect(parseByteRange(header, 20)).toBe(false);
    }
    expect(parseByteRange('bytes=0-', 0)).toBe(false);
    expect(parseByteRange(undefined, 20)).toBe(null);
  });
});
