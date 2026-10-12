import {describe, expect, it, vi} from 'vitest';
import {runWorkspaceUpload} from './uploadLifecycle';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

describe('project upload lifecycle', () => {
  it('keeps completed uploads usable when refreshing artifacts fails, and releases busy', async () => {
    const uploaded = vi.fn();
    const complete = vi.fn();
    const errors = vi.fn();
    const refreshError = new Error('artifacts unavailable');
    await expect(runWorkspaceUpload(['file'], {
      isCurrent: () => true,
      upload: async (file) => `uploads/${file}`,
      onUploaded: uploaded,
      refresh: async () => { throw refreshError; },
      onError: errors,
      onComplete: complete,
    })).resolves.toBeUndefined();
    expect(uploaded).toHaveBeenCalledWith('uploads/file');
    expect(errors).toHaveBeenCalledWith(refreshError);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('discards a late upload result and its remaining files after switching projects', async () => {
    let project = 'A';
    const request = deferred<string>();
    const upload = vi.fn(() => request.promise);
    const uploaded = vi.fn();
    const refresh = vi.fn(async () => {});
    const complete = vi.fn();
    const errors = vi.fn();
    const pending = runWorkspaceUpload(['first', 'second'], {
      isCurrent: () => project === 'A', upload, onUploaded: uploaded,
      refresh, onError: errors, onComplete: complete,
    });
    project = 'B';
    request.resolve('A/uploads/first');
    await pending;
    expect(upload).toHaveBeenCalledTimes(1);
    expect(uploaded).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('keeps a failed request from the old project out of the new project error state', async () => {
    let current = true;
    const request = deferred<string>();
    const errors = vi.fn();
    const complete = vi.fn();
    const pending = runWorkspaceUpload(['file'], {
      isCurrent: () => current, upload: () => request.promise,
      onUploaded: vi.fn(), refresh: async () => {}, onError: errors, onComplete: complete,
    });
    current = false;
    request.reject(new Error('old upload failed'));
    await expect(pending).resolves.toBeUndefined();
    expect(errors).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not clear a newer batch busy flag when an old artifact refresh completes', async () => {
    let operation = 1;
    let busy = true;
    const oldRefresh = deferred<void>();
    const refreshStarted = deferred<void>();
    const newUpload = deferred<string>();
    const oldComplete = vi.fn(() => { busy = false; });
    const oldBatch = runWorkspaceUpload(['old'], {
      isCurrent: () => operation === 1, upload: async () => 'old/path', onUploaded: vi.fn(),
      refresh: () => { refreshStarted.resolve(); return oldRefresh.promise; },
      onError: vi.fn(), onComplete: oldComplete,
    });
    await refreshStarted.promise;
    operation = 2;
    const newBatch = runWorkspaceUpload(['new'], {
      isCurrent: () => operation === 2, upload: () => newUpload.promise, onUploaded: vi.fn(),
      refresh: async () => {}, onError: vi.fn(), onComplete: () => { busy = false; },
    });
    oldRefresh.resolve();
    await oldBatch;
    expect(oldComplete).not.toHaveBeenCalled();
    expect(busy).toBe(true);
    newUpload.resolve('new/path');
    await newBatch;
    expect(busy).toBe(false);
  });

  it('refreshes earlier successful files and releases busy after a later upload fails', async () => {
    const failure = new Error('second file failed');
    const uploaded = vi.fn();
    const refresh = vi.fn(async () => {});
    const errors = vi.fn();
    const complete = vi.fn();
    await runWorkspaceUpload(['first', 'second'], {
      isCurrent: () => true,
      upload: async (file) => { if (file === 'second') throw failure; return file; },
      onUploaded: uploaded, refresh, onError: errors, onComplete: complete,
    });
    expect(uploaded).toHaveBeenCalledExactlyOnceWith('first');
    expect(errors).toHaveBeenCalledWith(failure);
    expect(refresh).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
  });
});
