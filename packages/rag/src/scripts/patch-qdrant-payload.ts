/**
 * v1.66 — One-shot migration: adds `packageName` payload field to existing
 * Qdrant points that were indexed before v1.66 (they only have `filePath`/`kind`).
 *
 * Usage:
 *   QDRANT_URL=http://localhost:6333 npx tsx packages/rag/src/scripts/patch-qdrant-payload.ts
 *
 * Idempotent: points that already have `packageName` are skipped.
 * Safe: uses Qdrant `set_payload` (merge), never replaces the full payload.
 */

import { QdrantClient } from '@qdrant/js-client-rest';

const QDRANT_URL = process.env['QDRANT_URL'] ?? 'http://localhost:6333';
const BATCH_SIZE = 100;
// Mirror of GraphRetriever.SCOPE_SKIP — keep in sync.
const SCOPE_SKIP = new Set(['shared', 'utils', 'types', 'common', 'helpers']);

function extractPackageName(filePath: string): string | undefined {
  const m = filePath.match(/\bpackages\/([\w.-]+)/);
  if (!m) return undefined;
  const name = m[1]!;
  return SCOPE_SKIP.has(name) ? undefined : name;
}

async function patchCollection(client: QdrantClient, collectionName: string): Promise<void> {
  console.log(`\nPatching collection: ${collectionName}`);

  // next_page_offset can be string | number | Record<string,unknown> | null per Qdrant types
  let offset: string | number | Record<string, unknown> | null = null;
  let totalScanned = 0;
  let totalPatched = 0;
  let totalSkipped = 0;

  do {
    const response = await client.scroll(collectionName, {
      limit: BATCH_SIZE,
      offset: offset ?? undefined,
      with_payload: true,
      with_vector: false,
    });

    const points = response.points;
    offset = response.next_page_offset ?? null;
    totalScanned += points.length;

    const toUpdate: Array<{ id: string | number; packageName: string }> = [];

    for (const point of points) {
      const payload = point.payload as Record<string, unknown> | undefined;
      if (!payload) continue;

      // Already patched — skip
      if (payload['packageName']) {
        totalSkipped++;
        continue;
      }

      const filePath = payload['filePath'] as string | undefined;
      if (!filePath) {
        totalSkipped++;
        continue;
      }

      const packageName = extractPackageName(filePath);
      if (!packageName) {
        totalSkipped++;
        continue;
      }

      toUpdate.push({ id: point.id, packageName });
    }

    if (toUpdate.length > 0) {
      // Group by packageName — each setPayload call sets one value for N points.
      // set_payload merges into existing payload, never replaces the full document.
      const byPackage = new Map<string, Array<string | number>>();
      for (const { id, packageName } of toUpdate) {
        const ids = byPackage.get(packageName) ?? [];
        ids.push(id);
        byPackage.set(packageName, ids);
      }
      for (const [pkgName, ids] of byPackage) {
        await client.setPayload(collectionName, {
          payload: { packageName: pkgName },
          points: ids,
        });
      }
      totalPatched += toUpdate.length;
    }

    process.stdout.write(`  scanned=${totalScanned} patched=${totalPatched} skipped=${totalSkipped}\r`);
  } while (offset !== null);

  console.log(`\n  done — scanned=${totalScanned} patched=${totalPatched} skipped=${totalSkipped}`);
}

async function main(): Promise<void> {
  const client = new QdrantClient({ url: QDRANT_URL });

  let collections: string[];
  try {
    const result = await client.getCollections();
    collections = result.collections.map(c => c.name);
  } catch (err) {
    console.error('Failed to connect to Qdrant:', String(err));
    process.exit(1);
  }

  if (collections.length === 0) {
    console.log('No collections found — nothing to migrate.');
    return;
  }

  console.log(`Found ${collections.length} collection(s): ${collections.join(', ')}`);

  for (const name of collections) {
    await patchCollection(client, name);
  }

  console.log('\nMigration complete.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
