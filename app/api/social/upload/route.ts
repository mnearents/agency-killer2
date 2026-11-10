import { handleUploadCheck } from "@/domain/social/upload-http";
import { uploadAuth } from "@/domain/social/upload-wiring";

// node:crypto for the timing-safe password check — see app/api/costs/route.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Asked before a file is chosen, so the browser prompts for the password first. */
export async function GET(request: Request) {
  return handleUploadCheck(request, uploadAuth());
}
