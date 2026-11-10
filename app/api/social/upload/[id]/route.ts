import { handleReelUpload } from "@/domain/social/upload-http";
import { uploadDeps } from "@/domain/social/upload-wiring";

// node:crypto for the password check, and ffmpeg for the analysis.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT the reel's video as the body: /api/social/upload/<media id>?song=… */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleReelUpload(request, id, uploadDeps());
}
