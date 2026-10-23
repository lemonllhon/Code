import type { MediaCodeViewerSource } from "@/lib/codeViewer.js";
import type { Ref, SyntheticEvent } from "react";
import { useEffect, useRef } from "react";
import { releaseMediaDecoder } from "@/lib/releaseMediaDecoder.js";

interface PreviewPaneMediaContentProps {
  source: MediaCodeViewerSource;
  loading: boolean;
  url: string | null;
  error: string | null;
  labels: {
    loading: string;
    unavailable: string;
    unsupported: string;
  };
  onMediaError?: (event: SyntheticEvent<HTMLMediaElement>) => void;
  onMediaLoadedMetadata?: (event: SyntheticEvent<HTMLMediaElement>) => void;
}

export function PreviewPaneMediaContent({
  source,
  loading,
  url,
  error,
  labels,
  onMediaError,
  onMediaLoadedMetadata,
}: PreviewPaneMediaContentProps) {
  const mediaRef = useRef<HTMLMediaElement>(null);
  useEffect(() => {
    const element = mediaRef.current;
    // StrictMode 会重跑 effect；恢复同一消费者的 src，不能把试探清理变成空播放器。
    if (element && url && element.getAttribute("src") !== url) element.setAttribute("src", url);
    return () => {
      if (element) releaseMediaDecoder(element);
    };
  }, [source.kind, url, loading, error]);

  if (loading || (!error && !url)) {
    return <div className="p-3 text-ui-base text-foreground-subtle">{labels.loading}</div>;
  }

  if (error || !url) {
    return (
      <div className="p-3 text-ui-base text-destructive" role="alert">
        {error ?? labels.unavailable}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-background p-6">
      {source.kind === "video" ? (
        <video
          key={url}
          ref={mediaRef as Ref<HTMLVideoElement>}
          controls
          playsInline
          className="max-h-full max-w-full rounded-lg"
          preload="metadata"
          src={url}
          onError={onMediaError}
          onLoadedMetadata={onMediaLoadedMetadata}
        >
          {labels.unsupported}
        </video>
      ) : (
        <audio
          key={url}
          ref={mediaRef as Ref<HTMLAudioElement>}
          controls
          className="w-full max-w-2xl"
          preload="metadata"
          src={url}
          onError={onMediaError}
          onLoadedMetadata={onMediaLoadedMetadata}
        >
          {labels.unsupported}
        </audio>
      )}
    </div>
  );
}
