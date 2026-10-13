// S3 is the durable store for per-user career-ops data dirs.
// Pattern: download prefix -> run scripts against a local temp dir
// (CAREER_OPS_ROOT) -> upload back. S3 is not a filesystem, so the
// scripts always run against real local disk.
import {
  S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand,
  HeadBucketCommand, CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

export const s3 = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  },
});

const Bucket = config.s3.bucket;
export const prefixFor = (userId) => `users/${userId}/`;

// Never persisted: the core's SQLite file is a derived index (rebuilt from
// the markdown files), plus the usual junk.
const SKIP = [/\.sqlite(-journal|-wal|-shm)?$/i, /(^|\/)node_modules\//, /(^|\/)\.git\//];

export async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
  } catch (e) {
    const code = e.$metadata?.httpStatusCode;
    if (code === 404 || e.name === 'NotFound' || e.name === 'NoSuchBucket') {
      await s3.send(new CreateBucketCommand({ Bucket }));
    } else throw e;
  }
}

export async function downloadUserDir(userId, localDir) {
  await fs.mkdir(localDir, { recursive: true });
  const prefix = prefixFor(userId);
  let token;
  let count = 0;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
    for (const obj of res.Contents ?? []) {
      const rel = obj.Key.slice(prefix.length);
      if (!rel) continue;
      const dest = path.join(localDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const got = await s3.send(new GetObjectCommand({ Bucket, Key: obj.Key }));
      const chunks = [];
      for await (const c of got.Body) chunks.push(c);
      await fs.writeFile(dest, Buffer.concat(chunks));
      count++;
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return count;
}

async function* walk(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

export async function uploadUserDir(userId, localDir) {
  const prefix = prefixFor(userId);
  let count = 0;
  let skipped = 0;
  for await (const file of walk(localDir)) {
    const rel = path.relative(localDir, file);
    if (SKIP.some((re) => re.test(rel))) { skipped++; continue; }
    const body = await fs.readFile(file);
    await s3.send(new PutObjectCommand({
      Bucket,
      Key: prefix + rel.split(path.sep).join('/'),
      Body: body,
    }));
    count++;
  }
  return { count, skipped };
}

export async function listUserFiles(userId) {
  const prefix = prefixFor(userId);
  let token;
  const keys = [];
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of res.Contents ?? []) keys.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}
