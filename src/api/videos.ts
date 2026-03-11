import { respondWithJSON } from "./json";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getVideo, updateVideo } from "../db/videos";
import { getBearerToken, validateJWT } from "../auth";
import { type ApiConfig } from "../config";
import type { BunRequest, S3File } from "bun";
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

  const s3file: S3File = cfg.s3Client.file(videoPath, { type: media_Type });
  const videoinSystem = Bun.file(mainPath);
  await Bun.write(s3file, videoinSystem);

  video_metadata.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com${videoPath}`;
  await videoinSystem.delete();

  const update_Video = updateVideo(cfg.db, video_metadata);
  return respondWithJSON(200, video_metadata);
}
