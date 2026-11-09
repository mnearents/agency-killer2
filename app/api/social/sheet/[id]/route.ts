import { db } from "@/lib/db";
import { getContactSheet } from "@/domain/social/review-queries";

/**
 * A reel's contact sheet — its frames tiled into one JPEG. Kept in our own
 * database, so unlike Instagram's links it does not expire.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{5,30}$/.test(id)) return new Response("Not found", { status: 404 });
  const sheet = await getContactSheet(db(), id);
  if (!sheet) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(sheet), {
    headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" },
  });
}
