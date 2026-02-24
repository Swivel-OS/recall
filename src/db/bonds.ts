import { getDb } from './init.js';

export type BondType = 'causal' | 'semantic' | 'temporal' | 'contradictory';

export interface Bond {
  bond_id: string;
  encode_id_a: string;
  encode_id_b: string;
  bond_type: BondType;
  strength: number;
  created_at: string;
}

export interface CreateBondInput {
  encode_id_a: string;
  encode_id_b: string;
  bond_type: BondType;
  strength: number;
}

export function createBond(input: CreateBondInput): Bond {
  const db = getDb();
  const bondId = `${input.encode_id_a}_${input.encode_id_b}_${input.bond_type}`;
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO bonds (
      bond_id, encode_id_a, encode_id_b, bond_type, strength, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    bondId,
    input.encode_id_a,
    input.encode_id_b,
    input.bond_type,
    input.strength,
    now
  );

  return {
    bond_id: bondId,
    encode_id_a: input.encode_id_a,
    encode_id_b: input.encode_id_b,
    bond_type: input.bond_type,
    strength: input.strength,
    created_at: now
  };
}

export function getBondsForEncode(encodeId: string): Bond[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM bonds 
    WHERE encode_id_a = ? OR encode_id_b = ?
    ORDER BY strength DESC
  `);

  const rows = stmt.all(encodeId, encodeId) as any[];
  return rows.map(rowToBond);
}

export function getBondsBetweenEncodes(encodeIdA: string, encodeIdB: string): Bond[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM bonds 
    WHERE (encode_id_a = ? AND encode_id_b = ?) OR (encode_id_a = ? AND encode_id_b = ?)
  `);

  const rows = stmt.all(encodeIdA, encodeIdB, encodeIdB, encodeIdA) as any[];
  return rows.map(rowToBond);
}

export function getRelatedEncodes(encodeId: string, minStrength: number = 0.5): Array<{ encode_id: string; bond_type: BondType; strength: number }> {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT 
      CASE 
        WHEN encode_id_a = ? THEN encode_id_b 
        ELSE encode_id_a 
      END as related_encode_id,
      bond_type,
      strength
    FROM bonds 
    WHERE (encode_id_a = ? OR encode_id_b = ?) AND strength >= ?
    ORDER BY strength DESC
    LIMIT 10
  `);

  return stmt.all(encodeId, encodeId, encodeId, minStrength) as any[];
}

export function getEncodeCluster(encodeId: string, depth: number = 1): Array<{ encode_id: string; distance: number }> {
  const db = getDb();
  const cluster = new Map<string, number>();
  cluster.set(encodeId, 0);

  let currentDepth = 0;
  let currentIds = [encodeId];

  while (currentDepth < depth && currentIds.length > 0) {
    const placeholders = currentIds.map(() => '?').join(',');
    const stmt = db.prepare(`
      SELECT 
        CASE 
          WHEN encode_id_a IN (${placeholders}) THEN encode_id_b 
          ELSE encode_id_a 
        END as related_encode_id,
        strength
      FROM bonds 
      WHERE (encode_id_a IN (${placeholders}) OR encode_id_b IN (${placeholders}))
        AND strength >= 0.5
    `);

    const params = [...currentIds, ...currentIds, ...currentIds];
    const rows = stmt.all(...params) as any[];

    const nextIds: string[] = [];
    for (const row of rows) {
      if (!cluster.has(row.related_encode_id)) {
        cluster.set(row.related_encode_id, currentDepth + 1);
        nextIds.push(row.related_encode_id);
      }
    }

    currentIds = nextIds;
    currentDepth++;
  }

  return Array.from(cluster.entries()).map(([encode_id, distance]) => ({
    encode_id,
    distance
  }));
}

export function deleteBondsForEncode(encodeId: string): void {
  const db = getDb();
  const stmt = db.prepare(`
    DELETE FROM bonds WHERE encode_id_a = ? OR encode_id_b = ?
  `);
  stmt.run(encodeId, encodeId);
}

function rowToBond(row: any): Bond {
  return {
    bond_id: row.bond_id,
    encode_id_a: row.encode_id_a,
    encode_id_b: row.encode_id_b,
    bond_type: row.bond_type as BondType,
    strength: row.strength,
    created_at: row.created_at
  };
}
