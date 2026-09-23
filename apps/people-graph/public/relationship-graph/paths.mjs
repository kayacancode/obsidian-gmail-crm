const DEFAULTS = Object.freeze({ maxHops: 3, maxPaths: 12, maxVisits: 20_000 });

function option(value, fallback, label, { allowZero = false } = {}) {
  const result = value ?? fallback;
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(result) || result < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}`);
  }
  return result;
}

function routeOrder(left, right) {
  return Number(left.requiresVerification) - Number(right.requiresVerification)
    || left.edgeIds.length - right.edgeIds.length
    || left.nodeIds.join('\u0000').localeCompare(right.nodeIds.join('\u0000'))
    || left.edgeIds.join('\u0000').localeCompare(right.edgeIds.join('\u0000'));
}

export function findPaths(graph, from, to, options = {}) {
  const maxHops = option(options.maxHops, DEFAULTS.maxHops, 'maxHops', { allowZero: true });
  const maxPaths = option(options.maxPaths, DEFAULTS.maxPaths, 'maxPaths');
  const maxVisits = option(options.maxVisits, DEFAULTS.maxVisits, 'maxVisits');
  const people = new Set(
    (Array.isArray(graph?.nodes) ? graph.nodes : [])
      .filter((node) => node?.type === 'person')
      .map((node) => node.id),
  );
  if (from === to || !people.has(from) || !people.has(to)) {
    return { paths: [], truncated: false };
  }

  const adjacent = new Map();
  for (const edge of Array.isArray(graph?.edges) ? graph.edges : []) {
    if (!people.has(edge?.source) || !people.has(edge?.target)) continue;
    if (edge.kind === 'interpretation') continue;
    if (edge.kind !== 'personal' && edge.kind !== 'cooccurrence') continue;
    const sourceEdges = adjacent.get(edge.source) ?? [];
    const targetEdges = adjacent.get(edge.target) ?? [];
    sourceEdges.push({ edge, next: edge.target });
    targetEdges.push({ edge, next: edge.source });
    adjacent.set(edge.source, sourceEdges);
    adjacent.set(edge.target, targetEdges);
  }
  for (const edges of adjacent.values()) {
    edges.sort((left, right) => (
      left.next.localeCompare(right.next) || left.edge.id.localeCompare(right.edge.id)
    ));
  }

  const queue = [{ nodeIds: [from], edgeIds: [], requiresVerification: false }];
  const found = [];
  let cursor = 0;
  let generated = 1;
  let truncated = false;
  while (cursor < queue.length) {
    const route = queue[cursor];
    cursor += 1;
    const current = route.nodeIds.at(-1);
    if (current === to) {
      found.push(route);
      continue;
    }
    if (route.edgeIds.length >= maxHops) continue;

    for (const { edge, next } of adjacent.get(current) ?? []) {
      if (route.nodeIds.includes(next)) continue;
      if (generated >= maxVisits) {
        truncated = true;
        break;
      }
      queue.push({
        nodeIds: [...route.nodeIds, next],
        edgeIds: [...route.edgeIds, edge.id],
        requiresVerification: route.requiresVerification || edge.kind === 'cooccurrence',
      });
      generated += 1;
    }
  }

  found.sort(routeOrder);
  const omittedPaths = found.length > maxPaths;
  return {
    paths: found.slice(0, maxPaths),
    truncated: truncated || omittedPaths,
  };
}
