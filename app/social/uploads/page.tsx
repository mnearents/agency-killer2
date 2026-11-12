import { db } from "@/lib/db";
import { getPeerPosts, getUploadableReels } from "@/domain/social/review-queries";
import { peerReelsForUpload } from "@/domain/social/peers";
import { createInstagramApiClient } from "@/integrations/instagram-api";
import { UploadsView } from "./uploads-view";

export const dynamic = "force-dynamic";

/**
 * Reels Instagram's API will not give the video of — it withholds reels with
 * licensed music — waiting for Matt to upload the copy Instagram's own
 * download gives, so they get the same visual analysis as every other reel.
 * Each links to the reel on Instagram, where the download is. Below them,
 * tracked peers' reels — never given with video — for any worth uploading.
 */

const DAYS = 90;
/** Peer reels are judged against their account's usual over 90 days. */
const PEER_HISTORY_DAYS = 90;

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
  const now = new Date();
  const [reels, peerPosts] = await Promise.all([
    getUploadableReels(db(), new Date(now.getTime() - DAYS * 86_400_000)),
    getPeerPosts(db(), new Date(now.getTime() - PEER_HISTORY_DAYS * 86_400_000)),
  ]);
  // Only reels still waiting show a cover. A peer's comes from the daily sync.
  const covers = await freshCovers(reels.filter((r) => !r.upload).map((r) => r.id));
  return <UploadsView reels={reels} covers={covers} days={DAYS} peers={peerReelsForUpload(peerPosts, now)} />;
}
