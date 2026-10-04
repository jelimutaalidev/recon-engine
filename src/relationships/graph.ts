import type { Relationship } from './relationship.js';
import type { RelationshipType } from './types.js';

export interface GraphIndex {
  getRelationshipsFrom(entityId: string): Relationship[];
  getRelationshipsTo(entityId: string): Relationship[];
  findRelationshipsByType(type: RelationshipType): Relationship[];
  getRelatedEntities(entityId: string, depth: number): string[];
}

function sortById(relationships: readonly Relationship[]): Relationship[] {
  return [...relationships].sort((a, b) => a.id.localeCompare(b.id));
}

export function buildGraphIndex(relationships: readonly Relationship[]): GraphIndex {
  const unique = new Map<string, Relationship>();
  for (const relationship of relationships) {
    unique.set(relationship.id, relationship);
  }

  const outgoing = new Map<string, Relationship[]>();
  const incoming = new Map<string, Relationship[]>();
  const byType = new Map<string, Relationship[]>();

  for (const relationship of unique.values()) {
    const fromList = outgoing.get(relationship.source_id);
    if (fromList === undefined) {
      outgoing.set(relationship.source_id, [relationship]);
    } else {
      fromList.push(relationship);
    }
    const toList = incoming.get(relationship.target_id);
    if (toList === undefined) {
      incoming.set(relationship.target_id, [relationship]);
    } else {
      toList.push(relationship);
    }
    const typeList = byType.get(relationship.type);
    if (typeList === undefined) {
      byType.set(relationship.type, [relationship]);
    } else {
      typeList.push(relationship);
    }
  }

  for (const list of outgoing.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  for (const list of incoming.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  for (const list of byType.values()) list.sort((a, b) => a.id.localeCompare(b.id));

  function otherEnd(relationship: Relationship, nodeId: string): string {
    return relationship.source_id === nodeId ? relationship.target_id : relationship.source_id;
  }

  return {
    getRelationshipsFrom(entityId) {
      return sortById(outgoing.get(entityId) ?? []);
    },
    getRelationshipsTo(entityId) {
      return sortById(incoming.get(entityId) ?? []);
    },
    findRelationshipsByType(type) {
      return sortById(byType.get(type) ?? []);
    },
    getRelatedEntities(entityId, depth) {
      if (depth <= 0) return [];
      const visited = new Set<string>([entityId]);
      const related = new Set<string>();
      let frontier = [entityId];
      for (let level = 0; level < depth && frontier.length > 0; level += 1) {
        const next: string[] = [];
        for (const node of frontier) {
          const incident = [
            ...(outgoing.get(node) ?? []),
            ...(incoming.get(node) ?? []),
          ];
          for (const relationship of incident) {
            const neighbour = otherEnd(relationship, node);
            if (!visited.has(neighbour)) {
              visited.add(neighbour);
              related.add(neighbour);
              next.push(neighbour);
            }
          }
        }
        frontier = next;
      }
      return [...related].sort();
    },
  };
}
