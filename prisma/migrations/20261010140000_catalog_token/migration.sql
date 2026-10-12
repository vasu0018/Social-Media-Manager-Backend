ALTER TABLE "OauthState" ADD COLUMN "returnTo" TEXT NOT NULL DEFAULT '';
ALTER TABLE "SocialAccount" ADD COLUMN "catalogTokenCipher" TEXT;
