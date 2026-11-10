import { db } from "@/lib/db";
import { getUploadableReels } from "@/domain/social/review-queries";
import { createInstagramApiClient } from "@/integrations/instagram-api";
import { UploadsView } from "./uploads-view";

export const dynamic = "force-dynamic";

/**
 * Reels Instagram's API will not give the video of — it withholds reels with
 * licensed music — waiting for Matt to upload the copy Instagram's own
 * download gives, so they get the same visual analysis as every other reel.
 * Each links to the reel on Instagram, where the download is.
 */

const DAYS = 90;

/** Instagram's cover links expire, so they are fetched fresh for the page. */
async function freshCovers(ids: string[]): Promise<Map<string, string>> {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token || ids.length === 0) return new Map();
  const client = createInstagramApiClient(token);
  const found = await Promise.all(ids.map(async (id) => {
    try {
      return [id, (await client.getMediaAssets(id)).coverUrl] as const;
    } catch {
      return [id, null] as const;
    }
  }));
  return new Map(found.filter((f): f is readonly [string, string] => f[1] !== null));
}

export default async function ReelUploadsPage() {
  const reels = await getUploadableReels(db(), new Date(Date.now() - DAYS * 86_400_000));
  return <UploadsView reels={reels} covers={await freshCovers(reels.map((r) => r.id))} days={DAYS} />;
}
