"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { uploadVoiceAction } from "@/lib/capture/actions";
import type { CaptureFormState } from "@/lib/capture/form-state";
import { CSRF_FIELD } from "@/lib/security/constants";

export function VoiceRecorder({ csrfToken }: { csrfToken: string }) {
  const [state, action] = useActionState<CaptureFormState, FormData>(uploadVoiceAction, {});
  const [recording, setRecording] = useState(false);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const previewUrl = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function start(): Promise<void> {
    setError(null);
    setBlob(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const mime = recorder.mimeType || "audio/webm";
        setBlob(new Blob(chunksRef.current, { type: mime }));
      };
      mediaRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setError("The microphone was not available. You can still upload a file.");
    }
  }

  function stop(): void {
    mediaRef.current?.stop();
    mediaRef.current = null;
    setRecording(false);
  }

  function onSubmit(formData: FormData): void {
    if (blob && fileRef.current) {
      const file = new File([blob], "memo.webm", { type: blob.type || "audio/webm" });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      fileRef.current.files = transfer.files;
      formData.set("audio", file);
    }
    action(formData);
  }

  return (
    <form action={onSubmit} className="card space-y-4">
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <div>
        <h2 className="font-medium">Voice memo</h2>
        <p className="mt-1 text-sm text-ink-400">
          Record here, or upload an existing file. Whisper transcribes it on
          this machine; you confirm the text before it becomes an entry.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {recording ? (
          <button type="button" className="btn btn-primary" onClick={stop}>
            Stop recording
          </button>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={() => void start()}>
            Start recording
          </button>
        )}
        {blob && !recording && (
          <span className="self-center text-sm text-ok-500">Recording ready</span>
        )}
      </div>

      {previewUrl && <audio controls src={previewUrl} className="w-full" />}

      <div>
        <label className="label" htmlFor="audio-file">
          Or choose a file
        </label>
        <input
          id="audio-file"
          ref={fileRef}
          name="audio"
          type="file"
          accept="audio/*,.webm,.mp3,.m4a,.wav,.ogg,.flac"
          className="field file:mr-3 file:rounded-md file:border-0 file:bg-ink-800 file:px-3 file:py-1.5 file:text-sm file:text-ink-100"
        />
      </div>

      <FormError message={state.error ?? error ?? undefined} />
      <SubmitButton pendingLabel="Uploading…">Transcribe</SubmitButton>
    </form>
  );
}
