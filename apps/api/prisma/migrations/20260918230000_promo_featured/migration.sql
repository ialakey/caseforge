-- Whether a promo code is advertised on the landing page. A separate decision
-- from being active: a code handed to one streamer's audience, or to a player
-- as an apology, is active and must never appear on the front page. Defaults
-- to false, so nothing that exists today starts being published.
ALTER TABLE "promo_codes" ADD COLUMN "isFeatured" BOOLEAN NOT NULL DEFAULT false;
