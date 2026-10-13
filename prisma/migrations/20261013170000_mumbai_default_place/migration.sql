INSERT INTO "SavedPlace" ("id", "name", "address", "isDefault", "createdAt", "updatedAt")
SELECT '103091303064541', 'Mumbai', 'Mumbai, Maharashtra, India', NOT EXISTS (SELECT 1 FROM "SavedPlace" WHERE "isDefault"), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
ON CONFLICT ("id") DO NOTHING;
