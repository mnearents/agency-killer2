import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getReview } from "@/domain/social/review-queries";
import { ReviewView, loadReviewPage } from "../review-view";

export const dynamic = "force-dynamic";

export default async function SocialReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = db();
  const review = /^[0-9a-f-]{36}$/i.test(id) ? await getReview(d, id) : null;
  if (!review) notFound();
  return <ReviewView review={review} data={await loadReviewPage(d, review, new Date())} />;
}
