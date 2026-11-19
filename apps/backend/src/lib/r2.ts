import { S3Client } from "@aws-sdk/client-s3";

let client: S3Client | null = null;

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} environment variable`);
  }
  return value;
}

export function getR2Client() {
  if (client) return client;

  const endpoint = process.env.R2_ENDPOINT?.trim();
  const accountId = endpoint ? null : requiredEnv("R2_ACCOUNT_ID");
  client = new S3Client({
    region: "auto",
    endpoint: endpoint ?? `https://${accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: !!endpoint,
    credentials: {
      accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
    },
  });

  return client;
}

export function getR2Bucket() {
  return requiredEnv("R2_BUCKET");
}
