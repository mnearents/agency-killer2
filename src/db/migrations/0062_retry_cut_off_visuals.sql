-- Visual answers were capped at 1,200 tokens, and a text-heavy carousel was
-- cut off mid-JSON on every attempt, recorded as "unreadable". The limit is
-- now 4,096; give those posts their three attempts again.
UPDATE "social_post_visuals" SET "attempts" = 0 WHERE "status" = 'error' AND "detail" LIKE 'unreadable answer%';
