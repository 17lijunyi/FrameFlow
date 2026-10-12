/** Keep an upload batch bound to its originating project and release its UI state. */
export async function runWorkspaceUpload<TFile, TResult>(files: readonly TFile[], handlers: {
  isCurrent: () => boolean;
  upload: (file: TFile) => Promise<TResult>;
  onUploaded: (result: TResult) => void;
  refresh: () => Promise<void>;
  onError: (error: unknown) => void;
  onComplete: () => void;
}) {
  let uploadedAny = false;
  try {
    for (const file of files) {
      if (!handlers.isCurrent()) return;
      const result = await handlers.upload(file);
      uploadedAny = true;
      if (!handlers.isCurrent()) return;
      handlers.onUploaded(result);
    }
  } catch (error) {
    if (handlers.isCurrent()) handlers.onError(error);
  } finally {
    try {
      if (uploadedAny && handlers.isCurrent()) await handlers.refresh();
    } catch (error) {
      if (handlers.isCurrent()) handlers.onError(error);
    } finally {
      if (handlers.isCurrent()) handlers.onComplete();
    }
  }
}
