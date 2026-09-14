const LENSES = new Set(['my', 'firm', 'public']);

function accepts(lens, visibility) {
  if (lens === 'my') return visibility === 'private' || visibility === 'firm' || visibility === 'public';
  return visibility === lens;
}

function lensValue(lens) {
  if (!LENSES.has(lens)) throw new Error('Relevance lens is unsupported');
  return lens;
}

function themeReason(components) {
  const strongest = components.slice().sort((left, right) => (
    right.contribution - left.contribution || left.signalId.localeCompare(right.signalId)
  ))[0];
  if (!strongest) return 'No visible evidence';
  const source = strongest.sourceType.replace(/_/g, ' ');
  return `${source[0].toLocaleUpperCase()}${source.slice(1)} evidence`;
}

function filteredSnapshot(relevance, signals, retainedThemeIds, lens) {
  if (!relevance || !Array.isArray(relevance.themes)) {
    return { themes: [], connectors: [], discoveries: [] };
  }
  if (lens === 'my') {
    return {
      ...relevance,
      lens,
      themes: relevance.themes.map((theme) => ({
        ...theme,
        nodeIds: theme.nodeIds.slice(),
        components: theme.components.slice(),
      })),
      connectors: (relevance.connectors ?? []).slice(),
      discoveries: (relevance.discoveries ?? []).map((item) => ({
        ...item,
        themeIds: item.themeIds.slice(),
        pathNodeIds: item.pathNodeIds.slice(),
      })),
    };
  }

  const signalById = new Map(signals.map((signal) => [signal.id, signal]));
  const themes = relevance.themes.flatMap((theme) => {
    if (!retainedThemeIds.has(theme.themeId)) return [];
    const components = theme.components.filter((component) => signalById.has(component.signalId));
    if (!components.length) return [];
    const nodeIds = [...new Set(components.flatMap((component) => {
      const personId = signalById.get(component.signalId)?.personId;
      return personId ? [personId] : [];
    }))].sort();
    return [{ ...theme, reason: themeReason(components), nodeIds, components }];
  });

  const totals = new Map(themes.map((theme) => [
    theme.themeId,
    theme.components.reduce((sum, component) => sum + component.contribution, 0),
  ]));
  const maximum = Math.max(0, ...totals.values());
  const rescoredThemes = themes.map((theme) => ({
    ...theme,
    score: relevance.lens === lens ? theme.score : maximum ? Math.min(100, (totals.get(theme.themeId) / maximum) * 100) : 0,
    nodeScores: relevance.lens === lens && theme.nodeScores
      ? Object.fromEntries(theme.nodeIds.filter(id=>Object.hasOwn(theme.nodeScores,id)).map(id=>[id,theme.nodeScores[id]])) : undefined,
  }));
  const scoredThemeIds = new Set(rescoredThemes.map((theme) => theme.themeId));
  const scoredThemeById = new Map(rescoredThemes.map((theme) => [theme.themeId, theme]));
  const discoveries = (relevance.discoveries ?? []).flatMap((item) => {
    const themeIds = item.themeIds.filter((themeId) => scoredThemeIds.has(themeId));
    if (!themeIds.length) return [];
    const name = scoredThemeById.get(themeIds[0]).name;
    const reason = item.relationshipUncertainty === 'documented'
      ? `${name} via documented bridge`
      : `${name} through relevant connections`;
    return [{ ...item, reason, themeIds, pathNodeIds: item.pathNodeIds.slice() }];
  });
  return {
    ...relevance,
    lens,
    themes: rescoredThemes,
    connectors: (relevance.connectors ?? []).slice(),
    discoveries,
  };
}

/**
 * Applies the selected lens again in the browser. `my` trusts every record already
 * authorized by the owner response; the shared lenses match only their exact visibility.
 */
export function filterRelevance(graph, lens) {
  lensValue(lens);
  const signals = (graph?.themeSignals ?? []).filter((signal) => accepts(lens, signal.visibility));
  const retainedThemeIds = new Set(signals.map((signal) => signal.themeId));
  const signalIds=new Set(signals.map(signal=>signal.id));
  for(const theme of graph?.relevance?.themes??[])if(theme.components.some(component=>signalIds.has(component.signalId)))retainedThemeIds.add(theme.themeId);
  const themes = (graph?.themes ?? []).filter((theme) => retainedThemeIds.has(theme.id));
  return {
    ...graph,
    nodes: (graph?.nodes ?? []).slice(),
    edges: (graph?.edges ?? []).slice(),
    themes,
    themeSignals: signals,
    relevance: filteredSnapshot(graph?.relevance, signals, retainedThemeIds, lens),
    connectors: (graph?.connectors ?? []).slice(),
  };
}

function position(node) {
  const x = Number(node?.x ?? node?.position?.x);
  const y = Number(node?.y ?? node?.position?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function stableUnit(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0) / 0xffffffff;
}

/** Returns stable theme overlays without modifying the positioned node records. */
export function themeFields(graph, visibleNodes, lens) {
  const filtered = filterRelevance(graph, lensValue(lens));
  const positioned = new Map((Array.isArray(visibleNodes) ? visibleNodes : [])
    .map((node) => [node?.id, position(node)])
    .filter(([id, point]) => typeof id === 'string' && point));
  const scoredByTheme = new Map((filtered.relevance?.themes ?? [])
    .map((theme) => [theme.themeId, theme]));
  const signalsByTheme = new Map();
  for (const signal of filtered.themeSignals) {
    const bucket = signalsByTheme.get(signal.themeId) ?? [];
    bucket.push(signal);
    signalsByTheme.set(signal.themeId, bucket);
  }

  return filtered.themes.flatMap((theme) => {
    const scored = scoredByTheme.get(theme.id);
    const memberIds = [...new Set(scored ? scored.nodeIds
      : (signalsByTheme.get(theme.id) ?? []).flatMap((signal) => signal.personId ? [signal.personId] : []))]
      .filter((id) => positioned.has(id)).sort();
    if (!memberIds.length) return [];
    const points = memberIds.map((id) => positioned.get(id));
    const center = points.reduce((total, point) => ({
      x: total.x + point.x,
      y: total.y + point.y,
    }), { x: 0, y: 0 });
    center.x /= points.length;
    center.y /= points.length;
    const unit = stableUnit(theme.id);
    const angle = unit * Math.PI * 2;
    const jitter = points.length === 1 ? 18 : 10;
    const score = scored?.score ?? Math.max(0, ...((signalsByTheme.get(theme.id) ?? [])
      .map((signal) => signal.confidence * 100)));
    const spread = Math.max(0, ...points.map((point) => Math.hypot(point.x - center.x, point.y - center.y)));
    return [{
      id: `theme-field:${theme.id}`,
      themeId: theme.id,
      name: scored?.name ?? theme.name,
      score,
      nodeIds: memberIds,
      x: center.x + Math.cos(angle) * jitter,
      y: center.y + Math.sin(angle) * jitter,
      radius: Math.max(72, spread + 64),
    }];
  }).sort((left, right) => left.themeId.localeCompare(right.themeId));
}
