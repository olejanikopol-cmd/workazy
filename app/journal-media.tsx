"use client";

// Медиа дневника: запись аудио и видео, черновики с загрузкой на сервер,
// статус расшифровки, плееры и редактирование транскриптов.
import { useEffect, useRef, useState } from "react";
import type { JournalEntry, JournalMedia } from "@/lib/types";
import type { PlannerApiConfig } from "@/lib/planner-api";
import { deleteMediaRemote, fetchMediaPlaybackUrl, requestTranscription, updateMediaTranscriptRemote } from "@/lib/planner-api";
import { extensionForMime, formatDuration, formatFileSize } from "@/lib/media-limits";
import {
  AUDIO_RECORDER_MIME_CANDIDATES,
  VIDEO_RECORDER_MIME_CANDIDATES,
  mediaAccessMessage,
  pickRecorderMimeType,
  recorderIsSupported,
  startMediaRecorder,
  stopStreamTracks,
  switchCameraFacing,
  type MediaRecorderHandle,
  type RecordedResult,
} from "@/lib/media-recorder";
import { Icon } from "./planner-app";

export type MediaDraftStatus =
  | { phase: "local" }
  | { phase: "uploading"; percent: number }
  | { phase: "transcribing" }
  | { phase: "ready" }
  | { phase: "error"; message: string };

export type MediaDraft = {
  key: string;
  type: "audio" | "video";
  blob: Blob;
  audioTrack: Blob | null;
  mimeType: string;
  durationMs: number;
  width?: number;
  height?: number;
  previewUrl: string;
  mediaId?: string;
  // Метаданные с сервера после загрузки/расшифровки — попадут в запись при сохранении.
  server?: JournalMedia;
  status: MediaDraftStatus;
};

export function draftFileName(draft: MediaDraft): string {
  return `recording-${draft.key.slice(-5)}.${extensionForMime(draft.mimeType)}`;
}

export function entrySearchText(entry: JournalEntry): string {
  return `${entry.title ?? ""} ${entry.body ?? ""} ${entry.tags.join(" ")} ${(entry.media ?? []).map((media) => media.transcript ?? "").join(" ")}`;
}

export function EntryMediaBadges({ entry }: { entry: JournalEntry }) {
  const media = entry.media ?? [];
  if (!media.length) return null;
  const audio = media.filter((item) => item.type === "audio").length;
  const video = media.filter((item) => item.type === "video").length;
  return <span className="entry-media-badges">
    {audio > 0 && <span className="media-badge"><Icon name="mic" size={12} />{audio}</span>}
    {video > 0 && <span className="media-badge"><Icon name="video" size={12} />{video}</span>}
  </span>;
}

export type RecordingDoneResult = RecordedResult & { audioTrack: Blob | null; width?: number; height?: number };


function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// Панель активной записи: доступ к устройствам, пауза, остановка, отмена.
// Видео дополнительно пишет лёгкую аудиодорожку отдельным рекордером —
// она уходит в Whisper, а оригинальное видео сохраняется как есть.
export function MediaRecorderPanel({ kind, onDone, onCancel }: {
  kind: "audio" | "video";
  onDone: (result: RecordingDoneResult) => void;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<"requesting" | "recording" | "paused">("requesting");
  const [error, setError] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [canPause, setCanPause] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const handleRef = useRef<MediaRecorderHandle | null>(null);
  const trackRef = useRef<{ recorder: MediaRecorder; chunks: Blob[] } | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stoppingRef = useRef(false);
  const doneRef = useRef(false);
  const setupRef = useRef(false);

  const maxSeconds = kind === "audio" ? 15 * 60 : 10 * 60;

  useEffect(() => {
    if (setupRef.current) return;
    setupRef.current = true;
    let cancelled = false;

    async function setup() {
      if (!recorderIsSupported()) {
        setError("Браузер не поддерживает запись медиа.");
        return;
      }
      try {
        const constraints: MediaStreamConstraints = kind === "audio"
          ? { audio: true }
          : { audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (cancelled) {
          stopStreamTracks(stream);
          return;
        }
        streamRef.current = stream;

        const mimeType = pickRecorderMimeType(kind === "audio" ? AUDIO_RECORDER_MIME_CANDIDATES : VIDEO_RECORDER_MIME_CANDIDATES);
        const handle = startMediaRecorder(stream, kind, mimeType);
        handleRef.current = handle;
        setCanPause(handle.canPause);

        if (kind === "video") {
          try {
            const audioOnly = new MediaStream(stream.getAudioTracks());
            const audioMime = pickRecorderMimeType(AUDIO_RECORDER_MIME_CANDIDATES);
            const trackRecorder = new MediaRecorder(audioOnly, audioMime ? { mimeType: audioMime } : undefined);
            const chunks: Blob[] = [];
            trackRecorder.addEventListener("dataavailable", (event) => {
              if (event.data && event.data.size > 0) chunks.push(event.data);
            });
            trackRecorder.start(1000);
            trackRef.current = { recorder: trackRecorder, chunks };
          } catch {
            // Некоторые версии Safari не дают запустить второй MediaRecorder.
            // Само видео сохраняем; сервер не станет отправлять его целиком в ASR.
            trackRef.current = null;
          }
          if (videoRef.current) videoRef.current.srcObject = stream;
        }
        setPhase("recording");
      } catch (err) {
        handleRef.current?.cancel();
        const track = trackRef.current;
        if (track && track.recorder.state !== "inactive") {
          try {
            track.recorder.stop();
          } catch {
            // ignore
          }
        }
        stopStreamTracks(streamRef.current);
        setError(mediaAccessMessage(err, kind));
      }
    }

    void setup();
    return () => {
      cancelled = true;
    };
  }, [kind]);

  // Таймер интерфейса. На паузе не тикает; точная длительность всё равно
  // берётся из рекордера при остановке.
  useEffect(() => {
    if (phase !== "recording") return;
    const timer = window.setInterval(() => {
      setElapsedSec((seconds) => {
        if (seconds + 1 >= maxSeconds) {
          window.setTimeout(() => void finishRecording(false), 0);
          return seconds;
        }
        return seconds + 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, maxSeconds]);

  // Если компонент размонтировали во время записи — глушим устройства.
  useEffect(() => () => {
    if (!doneRef.current) {
      handleRef.current?.cancel();
      const track = trackRef.current;
      if (track && track.recorder.state !== "inactive") {
        try {
          track.recorder.stop();
        } catch {
          // ignore
        }
      }
      stopStreamTracks(streamRef.current);
    }
  }, []);

  async function finishRecording(save: boolean) {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    const stream = streamRef.current;
    const videoSettings = stream?.getVideoTracks()[0]?.getSettings();

    const stopTrackRecorder = async () => {
      const track = trackRef.current;
      if (!track) return null;
      if (track.recorder.state !== "inactive") {
        await new Promise<void>((resolve) => {
          track.recorder.addEventListener("stop", () => resolve(), { once: true });
          track.recorder.stop();
        });
      }
      return track.chunks.length ? new Blob(track.chunks, { type: track.recorder.mimeType || "audio/webm" }) : null;
    };

    try {
      if (!save) {
        handleRef.current?.cancel();
        await stopTrackRecorder();
        stopStreamTracks(stream);
        doneRef.current = true;
        onCancel();
        return;
      }
      const result = await handleRef.current?.stop();
      const audioTrack = await stopTrackRecorder();
      stopStreamTracks(stream);
      if (doneRef.current) return;
      doneRef.current = true;
      if (!result || result.blob.size === 0) {
        setError("Не удалось сохранить запись. Попробуй ещё раз.");
        return;
      }
      onDone({
        ...result,
        audioTrack,
        width: kind === "video" ? videoSettings?.width : undefined,
        height: kind === "video" ? videoSettings?.height : undefined,
      });
    } catch {
      setError("Запись прервалась. Попробуй ещё раз.");
    }
  }

  async function toggleCamera() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = facing === "user" ? "environment" : "user";
    const switched = await switchCameraFacing(track, next);
    if (switched) setFacing(next);
  }

  function pauseRecording() {
    handleRef.current?.pause();
    const track = trackRef.current?.recorder;
    if (track?.state === "recording") {
      try {
        track.pause();
      } catch {
        // Основная запись всё равно остаётся на паузе.
      }
    }
    setPhase("paused");
  }

  function resumeRecording() {
    handleRef.current?.resume();
    const track = trackRef.current?.recorder;
    if (track?.state === "paused") {
      try {
        track.resume();
      } catch {
        // Расшифровка может быть неполной, но видео не теряется.
      }
    }
    setPhase("recording");
  }

  if (error) {
    return <div className="recorder-error">
      <p>{error}</p>
      <button className="ghost-action" onClick={onCancel}>Закрыть</button>
    </div>;
  }

  return <div className="recorder-panel">
    {kind === "video" && <video ref={videoRef} className="recorder-preview" muted autoPlay playsInline aria-label="Предпросмотр камеры" />}
    <div className="recorder-row">
      <span className={`recorder-dot ${phase === "paused" ? "paused" : ""}`} aria-hidden="true" />
      <strong className="recorder-timer">{formatClock(elapsedSec)}</strong>
      <span className="recorder-hint">
        {phase === "requesting" ? "Запрашиваю доступ…" : kind === "audio" ? "Аудио, до 15 минут" : "Видео, до 10 минут"}
      </span>
    </div>
    <div className="recorder-controls">
      <button className="icon-button" onClick={() => void finishRecording(false)} aria-label="Отменить запись"><Icon name="close" /></button>
      <button className="primary-action recorder-stop" onClick={() => void finishRecording(true)} disabled={phase === "requesting"} aria-label="Остановить и сохранить">
        <Icon name="stop" size={20} />
      </button>
      {canPause && phase !== "requesting" && (
        phase === "recording"
          ? <button className="icon-button" onClick={pauseRecording} aria-label="Пауза"><Icon name="pause" /></button>
          : <button className="icon-button" onClick={resumeRecording} aria-label="Продолжить запись"><Icon name="play" /></button>
      )}
      {kind === "video" && phase !== "requesting" && (
        <button className="icon-button" onClick={() => void toggleCamera()} aria-label="Переключить камеру"><Icon name="refresh" /></button>
      )}
    </div>
  </div>;
}

// Карточка черновика: локальный плеер на objectURL + статус загрузки.
export function MediaDraftCard({ draft, onRemove, onRetry }: {
  draft: MediaDraft;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const status = draft.status;
  return <div className="draft-media-card">
    <div className="draft-media-head">
      <span className="draft-media-title">
        <Icon name={draft.type === "audio" ? "mic" : "video"} size={16} />
        {draft.type === "audio" ? "Голосовая запись" : "Видеозапись"} · {formatDuration(draft.durationMs)} · {formatFileSize(draft.blob.size)}
      </span>
      <button className="icon-button" onClick={onRemove} aria-label="Убрать запись"><Icon name="close" size={16} /></button>
    </div>
    {draft.type === "video"
      ? <video src={draft.previewUrl} controls playsInline className="media-player" />
      : <audio src={draft.previewUrl} controls className="media-player" />}
    {status.phase === "uploading" && <div className="media-status"><div className="media-progress"><span style={{ width: `${status.percent}%` }} /></div><em>Загрузка {status.percent}%</em></div>}
    {status.phase === "transcribing" && <div className="media-status"><em>Расшифровываю речь…</em></div>}
    {status.phase === "ready" && <div className="media-status ready"><em>Готово: файл в дневнике</em></div>}
    {status.phase === "local" && <div className="media-status"><em>Ждёт включения синхронизации</em></div>}
    {status.phase === "error" && <div className="media-status error">
      <em>{status.message}</em>
      <button className="ghost-action" onClick={onRetry}><Icon name="refresh" size={14} />Повторить</button>
    </div>}
  </div>;
}


// Вложение сохранённой записи: плеер по короткоживущей подписанной ссылке,
// статус расшифровки, редактирование транскрипта, повтор и удаление.
function EntryMediaItem({ config, media, onUpdated, onDeleted }: {
  config: PlannerApiConfig;
  media: JournalMedia;
  onUpdated: (media: JournalMedia) => void;
  onDeleted: () => void;
}) {
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [transcriptDraft, setTranscriptDraft] = useState(media.transcript ?? "");
  const [busy, setBusy] = useState(false);

  async function loadPlaybackUrl() {
    setNotice(null);
    try {
      setPlaybackUrl(await fetchMediaPlaybackUrl(config, media.id));
    } catch (error) {
      setPlaybackUrl(null);
      setNotice(error instanceof Error ? error.message : "Не удалось получить ссылку на файл");
    }
  }

  useEffect(() => {
    void loadPlaybackUrl();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.id]);

  // Внешнее обновление транскрипта (повтор расшифровки, опрос) подтягиваем в поле.
  useEffect(() => {
    setTranscriptDraft(media.transcript ?? "");
  }, [media.id, media.transcript]);

  async function retryTranscription() {
    setBusy(true);
    setNotice(null);
    try {
      onUpdated(await requestTranscription(config, media.id));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось запустить расшифровку");
    } finally {
      setBusy(false);
    }
  }

  async function saveTranscript() {
    setBusy(true);
    setNotice(null);
    try {
      onUpdated(await updateMediaTranscriptRemote(config, media.id, transcriptDraft));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось сохранить транскрипт");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("Удалить файл из записи? Файл будет удалён и из облака.")) return;
    setBusy(true);
    try {
      await deleteMediaRemote(config, media.id);
      onDeleted();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось удалить файл");
      setBusy(false);
    }
  }

  const dirty = transcriptDraft.trim() !== (media.transcript ?? "").trim();

  return <div className="entry-media-item">
    <div className="draft-media-head">
      <span className="draft-media-title">
        <Icon name={media.type === "audio" ? "mic" : "video"} size={16} />
        {media.type === "audio" ? "Голосовая запись" : "Видеозапись"} · {formatDuration(media.durationMs)}
      </span>
      <button className="icon-button" onClick={() => void remove()} disabled={busy} aria-label="Удалить файл"><Icon name="close" size={16} /></button>
    </div>
    {playbackUrl
      ? media.type === "video"
        ? <video src={playbackUrl} controls playsInline className="media-player" onError={() => setPlaybackUrl(null)} />
        : <audio src={playbackUrl} controls className="media-player" onError={() => setPlaybackUrl(null)} />
      : <button className="ghost-action" onClick={() => void loadPlaybackUrl()}><Icon name="refresh" size={14} />{notice ?? "Загрузить плеер"}</button>}

    {media.transcriptionStatus === "pending" && <div className="media-status">
      <em>Расшифровка ещё не запускалась.</em>
      <button className="ghost-action" onClick={() => void retryTranscription()} disabled={busy}><Icon name="mic" size={14} />Расшифровать сейчас</button>
    </div>}
    {media.transcriptionStatus === "processing" && <div className="media-status"><em>Расшифровываю речь…</em></div>}
    {media.transcriptionStatus === "error" && <div className="media-status error">
      <em>Не удалось расшифровать{media.transcriptionError ? `: ${media.transcriptionError}` : ""}</em>
      <button className="ghost-action" onClick={() => void retryTranscription()} disabled={busy}><Icon name="refresh" size={14} />Повторить расшифровку</button>
    </div>}

    {(media.transcriptionStatus === "ready" || media.transcript) && <div className="transcript-block">
      <span className="transcript-label">{media.transcriptEdited ? "Транскрипт (изменён)" : "Транскрипт"}</span>
      <textarea
        className="transcript-input"
        value={transcriptDraft}
        onChange={(event) => setTranscriptDraft(event.target.value)}
        placeholder="Текст не распознан. Можешь написать его вручную."
        aria-label="Транскрипт записи"
      />
      {dirty && <button className="ghost-action" onClick={() => void saveTranscript()} disabled={busy}><Icon name="check" size={14} />Сохранить транскрипт</button>}
    </div>}

    {notice && <div className="media-status error"><em>{notice}</em></div>}
  </div>;
}

export function EntryMediaBlock({ config, entry, onMediaUpdated }: {
  config: PlannerApiConfig;
  entry: JournalEntry;
  onMediaUpdated: (media: JournalMedia[]) => void;
}) {
  const media = entry.media ?? [];
  if (!media.length) return null;
  return <div className="entry-media-block">
    <h3>Аудио и видео</h3>
    {media.map((item) => <EntryMediaItem
      key={item.id}
      config={config}
      media={item}
      onUpdated={(updated) => onMediaUpdated(media.map((m) => (m.id === updated.id ? updated : m)))}
      onDeleted={() => onMediaUpdated(media.filter((m) => m.id !== item.id))}
    />)}
  </div>;
}
