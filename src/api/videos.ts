import { respondWithJSON } from "./json";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getVideo, updateVideo } from "../db/videos";
import type { Video } from "../db/videos";
import { getBearerToken, validateJWT } from "../auth";
import { type ApiConfig } from "../config";
import type { BunRequest, S3File, s3 } from "bun";
import path from "path";
import { randomBytes } from "crypto";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 * 1024 * 1024 * 1024;
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video_metadata = getVideo(cfg.db, videoId);
  if (!video_metadata) {
    throw new NotFoundError("Couldn't find video");
  }

  if (video_metadata.userID !== userID) {
    throw new UserForbiddenError("You are not the owner of this video");
  }

  const videoData = await req.formData();
  const video_file = videoData.get("video");
  if (!(video_file instanceof File)) {
    throw new BadRequestError("Video is not a file");
  }
  if (video_file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video exceeds maximum size");
  }

  const allowedTypes = ["video/mp4"];
  const media_Type = video_file.type;
  if (!media_Type || !allowedTypes.includes(media_Type)) {
    throw new BadRequestError("Media type not provided or not allowed");
  }

  const video_data = await video_file.arrayBuffer();
  const videoPath = `/${randomBytes(32).toString("base64url")}.${media_Type.split("/")[1]}`;
  const mainPath = path.join(cfg.assetsRoot, videoPath);
  await Bun.write(mainPath, video_data);
  const Video_AspectRatio = await getVideoAspectRatio(mainPath);
  const Video_URL = `${Video_AspectRatio}${videoPath}`;
  const processedVideoPath = await processVideoForFastStart(mainPath);
  const original_videoinSystem = Bun.file(mainPath);
  await original_videoinSystem.delete();
  const processed_videoinSystem = Bun.file(processedVideoPath);

  const s3file: S3File = cfg.s3Client.file(Video_URL, { type: media_Type });
  await Bun.write(s3file, processed_videoinSystem);

  video_metadata.videoURL = `${Video_URL}`;
  await processed_videoinSystem.delete();

  const updatedVideo = await updateVideo(cfg.db, video_metadata);
  const signedVideo = await dbVideoToSignedVideo(cfg, video_metadata);
  return respondWithJSON(200, signedVideo);
}

export async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn([
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    filePath,
  ]);
  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`ffprobe exited with code ${stderrText}`);
  }

  const result = JSON.parse(stdoutText);
  const width = result.streams[0].width;
  const height = result.streams[0].height;
  const aspectRatio = width / height;
  if (aspectRatio > 1) {
    return "landscape";
  }
  if (aspectRatio < 1) {
    return "portrait";
  }
  return "other";
}

export async function processVideoForFastStart(
  inputFilePath: string,
): Promise<string> {
  const outputFilePath = `${inputFilePath}.processed`;
  const proc = Bun.spawn([
    "ffmpeg",
    "-i",
    inputFilePath,
    "-movflags",
    "faststart",
    "-map_metadata",
    "0",
    "-codec",
    "copy",
    "-f",
    "mp4",
    outputFilePath,
  ]);
  const exitCode = await proc.exited;
  const stderrText = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new Error(`ffprobe exited with code ${stderrText}`);
  }

  return outputFilePath;
}

export async function generatePresignedURL(
  cfg: ApiConfig,
  key: string,
  expireTime: number,
): Promise<string> {
  const upload = cfg.s3Client.presign(key, {
    expiresIn: expireTime,
  });
  return upload;
}

export async function dbVideoToSignedVideo(
  cfg: ApiConfig,
  video: Video,
): Promise<Video> {
  const videoURL = video.videoURL;
  if (!videoURL) {
    throw new Error("videoURL is required");
  }
  const signedVideoURL = await generatePresignedURL(cfg, videoURL, 3600);
  video.videoURL = signedVideoURL;
  return video;
}
