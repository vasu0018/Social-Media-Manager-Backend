ALTER TABLE "Content" ADD COLUMN "coverMediaId" TEXT;
ALTER TABLE "Content" ADD COLUMN "thumbOffsetMs" INTEGER;

ALTER TABLE "Content" ADD CONSTRAINT "Content_coverMediaId_fkey" FOREIGN KEY ("coverMediaId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
