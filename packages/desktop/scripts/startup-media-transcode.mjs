import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

/** 只在维护素材时转码；普通构建仍只读取仓库内已校验的不可变资源。 */
export async function transcodeStartupPlaybackVideo(
  source,
  destination,
  ffmpeg = process.env.FFMPEG_PATH || "ffmpeg",
) {
  const temporary = join(dirname(destination), `${randomUUID()}.mp4`);
  try {
    await promisify(execFile)(
      ffmpeg,
      [
        "-nostdin",
        "-y",
        "-i",
        source,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-vf",
        "scale=1920:1080:flags=lanczos,fps=30",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-threads",
        "4",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        temporary,
      ],
      { windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
    );
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function generateStartupFillImage(
  source,
  destination,
  ffmpeg = process.env.FFMPEG_PATH || "ffmpeg",
) {
  const temporary = join(dirname(destination), `${randomUUID()}.jpg`);
  try {
    await promisify(execFile)(
      ffmpeg,
      [
        "-nostdin",
        "-y",
        "-ss",
        "14",
        "-i",
        source,
        "-frames:v",
        "1",
        "-vf",
        "scale=480:270:flags=area,gblur=sigma=18,eq=brightness=-0.1:saturation=0.6",
        "-q:v",
        "4",
        "-threads",
        "1",
        "-update",
        "1",
        temporary,
      ],
      { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
