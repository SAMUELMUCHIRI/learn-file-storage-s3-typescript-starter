import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const videoThumbnails: Map<string, Thumbnail> = new Map();

export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const thumbnail = videoThumbnails.get(videoId);
  if (!thumbnail) {
    throw new NotFoundError("Thumbnail not found");
  }

  return new Response(thumbnail.data, {
    headers: {
      "Content-Type": thumbnail.mediaType,
      "Cache-Control": "no-store",
    },
  });
}

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const thumbnailData = await req.formData();
  const thumbnail_file = thumbnailData.get("thumbnail");
  if (!(thumbnail_file instanceof File)) {
    throw new BadRequestError("Thumbnail is not a file");
  }

  const MAX_UPLOAD_SIZE = 10 << 20;
  if (thumbnail_file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail exceeds maximum size");
  }

  const media_Type = thumbnail_file.type;
  if (!media_Type) {
    throw new BadRequestError("Media type not provided");
  }
  const imagedata = await thumbnail_file.arrayBuffer();
  const video_metadata = getVideo(cfg.db, videoId);
  if (!video_metadata) {
    throw new NotFoundError("Couldn't find video");
  }

  if (video_metadata.userID !== userID) {
    throw new UserForbiddenError("You are not the owner of this video");
  }

  videoThumbnails.set(videoId, {
    data: imagedata,
    mediaType: media_Type,
  });

  const url = `http://localhost:${cfg.port}/api/thumbnails/${videoId}`;
  video_metadata.thumbnailURL = url;

  const update_Video = updateVideo(cfg.db, video_metadata);

  return respondWithJSON(200, video_metadata);
}
