import { db } from "@/lib/db";
import { getLatestReview } from "@/domain/social/review-queries";
import { ReviewView, NoReview, loadReviewPage } from "./review-view";

export const dynamic = "force-dynamic";

export default async function LatestSocialReviewPage() {
  const d = db();
  const review = await getLatestReview(d);
  if (!review) return <NoReview />;
  return <ReviewView review={review} data={await loadReviewPage(d, review, new Date())} />;
}
