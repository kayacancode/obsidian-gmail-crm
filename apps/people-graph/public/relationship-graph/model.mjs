const MAX_NODES = 10_000;
const MAX_EDGES = 100_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const MAX_THEMES = 200;
const MAX_SIGNALS = 5_000;
const MAX_VIA_OWNERS = 20;
const MAX_VIA_LENGTH = 320;
const NODE_TYPES = new Set(['person', 'company', 'story', 'community']);
const THEME_STATUSES = new Set(['active', 'muted', 'merged']);
const SIGNAL_VISIBILITIES = new Set(['private', 'firm', 'public']);
const SIGNAL_SOURCE_TYPES = new Set([
  'gmail_subject',
  'gmail_body_derived',
  'calendar',
  'granola',
  'obsidian_note',
  'product_activity',
  'public_url',
  'public_feed',
]);
const RELEVANCE_LENSES = new Set(['my', 'firm', 'public']);
const EVIDENCE_CLASSES = new Set(['documented', 'inferred']);
const FRESHNESS_VALUES = new Set(['recent', 'aging', 'stale', 'unknown']);
const RELATIONSHIP_UNCERTAINTIES = new Set(['documented', 'inferred', 'unknown']);
const OPAQUE_ID = /^[A-Za-z0-9:_-]{1,200}$/;
const PERSONAL_TYPES = new Set([
  'personal',
  'relationship',
  'worked_with',
  'met',
  'introduced',
  'introduced_by',
  'collaborated',
]);
const TYPE_LABELS = new Map([
  ['personal', 'personal relationship'],
  ['relationship', 'relationship'],
  ['worked_with', 'worked with'],
  ['met', 'met'],
  ['introduced', 'introduced'],
  ['introduced_by', 'introduced by'],
  ['collaborated', 'collaborated'],
  ['cooccurrence', 'co-occurrence'],
  ['co_recipient', 'co-recipient'],
  ['shared_email', 'shared email'],
  ['shared_meeting', 'shared meeting'],
  ['shared_via', 'shared via'],
  ['wiki_link', 'wiki link'],
  ['text_mention', 'text mention'],
  ['interpretation', 'interpretation'],
  ['association', 'association'],
]);

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value, fallback = null) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function optionalScore(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function boundedString(value, label, maximum, { optional = false, fallback = null } = {}) {
  if ((value === undefined || value === null) && optional) return fallback;
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > maximum) {
    throw new Error(`${label} must be ${optional ? 'a' : 'a non-empty'} string of at most ${maximum} characters`);
  }
  return value.trim();
}

function opaqueId(value, label, { optional = false } = {}) {
  if ((value === undefined || value === null) && optional) return null;
  if (typeof value !== 'string' || !OPAQUE_ID.test(value) || value.includes('@')) {
    throw new Error(`${label} must be an opaque id`);
  }
  return value;
}

function enumValue(value, allowed, label) {
  if (!allowed.has(value)) throw new Error(`${label} has an unsupported value`);
  return value;
}

function timestamp(value, label, { optional = false } = {}) {
  if ((value === undefined || value === null) && optional) return null;
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return value;
}

function rangedNumber(value, label, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function navigationUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    const safeProtocol = url.protocol === 'https:' || url.protocol === 'http:';
    return safeProtocol && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function photoUrl(value) {
  const url = navigationUrl(value);
  if (!url) return null;
  const parsed = new URL(url);
  const googlePhoto = parsed.protocol === 'https:' && (
    parsed.hostname === 'googleusercontent.com'
    || parsed.hostname.endsWith('.googleusercontent.com')
  );
  return googlePhoto ? parsed.href : null;
}

/**
 * The owners who shared this person with the viewer (`via` in the server's graph payload).
 * These are addresses the viewer is already allowed to see, but they are still producer input:
 * bound the count and the length so a bad slice cannot fill the canvas with one label.
 */
function sharedOwners(raw, index) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`Node ${index} via must be an array`);
  // `via` is server-produced and a viewer cannot correct it, so an over-long list is trimmed
  // rather than thrown: one node gaining a twenty-first owner must not lose the whole graph.
  return raw.slice(0, MAX_VIA_OWNERS).map((value, ownerIndex) => (
    boundedString(value, `Node ${index} via owner ${ownerIndex}`, MAX_VIA_LENGTH)
  ));
}

function normalizeNode(raw, index) {
  requireRecord(raw, `Node ${index}`);
  const type = raw.type === undefined || raw.type === null ? 'person' : raw.type;
  if (!NODE_TYPES.has(type)) throw new Error(`Node ${index} has an unsupported type`);

  return {
    id: requiredString(raw.id, `Node ${index} id`),
    name: requiredString(raw.name, `Node ${index} name`),
    type,
    description: optionalString(raw.description, ''),
    role: optionalString(raw.role ?? raw.tag),
    company: optionalString(raw.company),
    companySource: optionalString(raw.companySource),
    photoUrl: photoUrl(raw.photoUrl ?? raw.photo),
    sources:Array.isArray(raw.sources)?raw.sources.filter(s=>['web','obsidian'].includes(s)):[],
    photoPosition: optionalString(raw.photoPosition),
    viewerScore:raw.viewerScore&&Number.isFinite(raw.viewerScore.score)&&Number.isFinite(raw.viewerScore.base)&&[-10,0,10].includes(raw.viewerScore.delta)?{score:raw.viewerScore.score,base:raw.viewerScore.base,delta:raw.viewerScore.delta}:null,
    relationships: Array.isArray(raw.relationships)?raw.relationships.slice(0,20).map(r=>({memberId:String(r.memberId||''),memberName:String(r.memberName||''),score:Number.isFinite(r.score)?r.score:null,scoreVersion:String(r.scoreVersion||'unknown'),lastContact:optionalString(r.lastContact),evidenceCategory:optionalString(r.evidenceCategory)})):[],
    combined: optionalScore(raw.combined, `Node ${index} combined`),
    baseCombined: optionalScore(raw.baseCombined, `Node ${index} baseCombined`),
    feedbackDelta: Number.isFinite(raw.feedbackDelta)?raw.feedbackDelta:0,
    strength: optionalScore(raw.strength, `Node ${index} strength`),
    momentum: optionalScore(raw.momentum, `Node ${index} momentum`),
    scoreModel: optionalString(raw.scoreModel),
    lastContact: optionalString(raw.lastContact),
    directRelationship: typeof raw.directRelationship === 'boolean' ? raw.directRelationship : null,
    directLastContact: Object.hasOwn(raw, 'directLastContact') ? optionalString(raw.directLastContact) : raw.via?.length ? null : optionalString(raw.lastContact),
    lastMeeting: optionalString(raw.lastMeeting),
    meetings: optionalScore(raw.meetings, `Node ${index} meetings`),
    via: sharedOwners(raw.via, index),
    visibility: optionalString(raw.visibility),
    permission: optionalString(raw.permission),
    permissionConflict: raw.permissionConflict === true,
    identityStatus: optionalString(raw.identityStatus),
    identityResolved: typeof raw.identityResolved === 'boolean' ? raw.identityResolved : null,
    lastContactAt: optionalString(raw.lastContactAt ?? raw.lastContact),
    observedAt: optionalString(raw.observedAt),
    updatedAt: optionalString(raw.updatedAt),
  };
}

function legacyKind(raw) {
  const values = [raw.kind, ...(Array.isArray(raw.types) ? raw.types : [])]
    .filter((value) => typeof value === 'string')
    .map((value) => value.toLowerCase());
  if (values.some((value) => value === 'interpretation' || value === 'association')) {
    return 'interpretation';
  }
  return values.some((value) => PERSONAL_TYPES.has(value)) ? 'personal' : 'cooccurrence';
}

function normalizeEvidence(raw, edgeId, index, inheritedOwner = null) {
  requireRecord(raw, `Evidence ${index} on edge ${edgeId}`);
  return {
    id: optionalString(raw.id, `${edgeId}:evidence:${index + 1}`),
    title: optionalString(raw.title, ''),
    text: optionalString(raw.text ?? raw.context ?? raw.excerpt, ''),
    url: navigationUrl(raw.url ?? raw.sourceUrl),
    date: optionalString(raw.date ?? raw.eventDate),
    owner: optionalString(raw.owner, inheritedOwner),
  };
}

function normalizeEdge(raw, index) {
  requireRecord(raw, `Edge ${index}`);
  for (const field of ['evidence', 'types', 'contexts']) {
    if (Object.hasOwn(raw, field) && !Array.isArray(raw[field])) {
      throw new Error(`Edge ${index} ${field} must be an array`);
    }
  }
  const source = requiredString(raw.source ?? raw.a, `Edge ${index} source`);
  const target = requiredString(raw.target ?? raw.b, `Edge ${index} target`);
  if (source === target) throw new Error(`Edge ${index} endpoints must be different`);
  const id = optionalString(raw.id, `edge:${index + 1}:${source}:${target}`);
  const owner = optionalString(raw.owner ?? raw.author);
  const contexts = (raw.contexts ?? [])
    .filter((value) => typeof value === 'string' && value.trim());
  const evidenceInput = raw.evidence
    ? raw.evidence
    : contexts.map((text) => ({ text, date: raw.date ?? raw.eventDate }));
  const rawTypes = (raw.types ?? [])
    .filter((value) => typeof value === 'string' && value.trim());
  const recognizedLabel = [raw.kind, ...rawTypes]
    .filter((value) => typeof value === 'string')
    .map((value) => TYPE_LABELS.get(value.toLowerCase()))
    .find(Boolean);

  return {
    id,
    source,
    target,
    label: optionalString(raw.label, recognizedLabel ?? 'unspecified'),
    kind: legacyKind(raw),
    owner,
    visibility: optionalString(raw.visibility),
    revision: raw.revision ?? null,
    observedAt: optionalString(raw.observedAt),
    weight: optionalScore(raw.weight, `Edge ${index} weight`),
    types: [...new Set(rawTypes
      .map((value) => value.toLowerCase())
      .filter((value) => TYPE_LABELS.has(value)))],
    evidence: evidenceInput.map((item, evidenceIndex) => (
      normalizeEvidence(item, id, evidenceIndex, owner)
    )),
  };
}

function normalizeTheme(raw, index) {
  requireRecord(raw, `Theme ${index}`);
  if (Object.hasOwn(raw, 'aliases') && !Array.isArray(raw.aliases)) {
    throw new Error(`Theme ${index} aliases must be an array`);
  }
  const id = opaqueId(raw.id, `Theme ${index} id`);
  const canonicalName = boundedString(raw.canonicalName ?? raw.name, `Theme ${index} canonicalName`, 80);
  const aliases = (raw.aliases ?? []).map((value, aliasIndex) => (
    boundedString(value, `Alias ${aliasIndex} on theme ${id}`, 80)
  ));
  if (aliases.length > 20) throw new Error(`Theme ${id} exceeds 20 aliases`);
  const status = enumValue(raw.status ?? 'active', THEME_STATUSES, `Theme ${id} status`);
  const mergedInto = opaqueId(raw.mergedInto, `Theme ${id} mergedInto`, { optional: true });
  if (status === 'merged' && !mergedInto) throw new Error(`Theme ${id} mergedInto must be an opaque id`);
  return {
    id,
    name: boundedString(raw.name ?? canonicalName, `Theme ${id} name`, 80),
    canonicalName,
    aliases,
    description: boundedString(raw.description ?? '', `Theme ${id} description`, 240, { optional: true, fallback: '' }),
    status,
    mergedInto,
    createdAt: timestamp(raw.createdAt, `Theme ${id} createdAt`, { optional: true }),
    updatedAt: timestamp(raw.updatedAt, `Theme ${id} updatedAt`, { optional: true }),
  };
}

function normalizeThemeSignal(raw, index, nodeIds, themeIds) {
  requireRecord(raw, `Theme signal ${index}`);
  const id = opaqueId(raw.id, `Theme signal ${index} id`);
  const personId = opaqueId(raw.personId, `Theme signal ${id} personId`, { optional: true });
  if (personId && !nodeIds.has(personId)) throw new Error(`Theme signal ${id} personId is not a graph node`);
  const themeId = opaqueId(raw.themeId, `Theme signal ${id} themeId`);
  if (!themeIds.has(themeId)) throw new Error(`Theme signal ${id} themeId is not a graph theme`);
  return {
    id,
    personId,
    themeId,
    sourceType: enumValue(raw.sourceType, SIGNAL_SOURCE_TYPES, `Theme signal ${id} sourceType`),
    visibility: enumValue(raw.visibility, SIGNAL_VISIBILITIES, `Theme signal ${id} visibility`),
    observedAt: timestamp(raw.observedAt, `Theme signal ${id} observedAt`),
    ingestedAt: timestamp(raw.ingestedAt, `Theme signal ${id} ingestedAt`),
    confidence: rangedNumber(raw.confidence, `Theme signal ${id} confidence`, 0, 1),
    summary: boundedString(raw.summary, `Theme signal ${id} summary`, 240, { optional: true, fallback: '' }),
    evidenceRef: boundedString(raw.evidenceRef, `Theme signal ${id} evidenceRef`, 500),
    contentHash: boundedString(raw.contentHash, `Theme signal ${id} contentHash`, 128),
    extractorVersion: boundedString(raw.extractorVersion, `Theme signal ${id} extractorVersion`, 100),
    modelId: boundedString(raw.modelId, `Theme signal ${id} modelId`, 200, { optional: true }),
    provenance: normalizeSignalProvenance(raw),
  };
}

// Public sources and Granola meetings both carry provenance; only meetings carry a title.
function normalizeSignalProvenance(signal) {
  const publicSource = signal.visibility === 'public' && ['public_url', 'public_feed'].includes(signal.sourceType);
  const meeting = signal.sourceType === 'granola';
  if (!publicSource && !meeting) return null;
  const raw=signal.provenance;
  if (!raw || raw.timeBasis !== 'observed') return null;
  try {
    if (typeof raw.canonicalUrl !== 'string' || raw.canonicalUrl.length > 2048 || /[\s\\#]/.test(raw.canonicalUrl)) return null;
    const url=navigationUrl(raw.canonicalUrl);
    if (!url || raw.canonicalUrl.split('/')[2]?.includes('@')) return null;
    const title = meeting ? boundedString(raw.title, 'Meeting title', 300, {optional:true}) : null;
    return {canonicalUrl:url,publisherHost:boundedString(raw.publisherHost,'Public publisher',253),
      observedAt:timestamp(raw.observedAt,'Public observedAt'),retrievedAt:timestamp(raw.retrievedAt,'Public retrievedAt'),timeBasis:'observed',
      ...(title ? {title} : {})};
  } catch { return null; }
}

function normalizeConnector(raw, index, nodeIds) {
  requireRecord(raw, `Connector ${index}`);
  const nodeId = opaqueId(raw.nodeId, `Connector ${index} nodeId`);
  if (!nodeIds.has(nodeId)) throw new Error(`Connector ${nodeId} nodeId is not a graph node`);
  return {
    nodeId,
    score: rangedNumber(raw.score, `Connector ${nodeId} score`, 0, Number.MAX_SAFE_INTEGER),
    evidenceClass: enumValue(raw.evidenceClass, EVIDENCE_CLASSES, `Connector ${nodeId} evidenceClass`),
    documentedDegree: nonNegativeInteger(raw.documentedDegree, `Connector ${nodeId} documentedDegree`),
    inferredDegree: nonNegativeInteger(raw.inferredDegree, `Connector ${nodeId} inferredDegree`),
    sampledPathCount: nonNegativeInteger(raw.sampledPathCount, `Connector ${nodeId} sampledPathCount`),
  };
}

function normalizeRelevanceTheme(raw, index, nodeIds, themeIds, signalIds) {
  requireRecord(raw, `Relevance theme ${index}`);
  for (const field of ['nodeIds', 'components']) {
    if (!Array.isArray(raw[field])) throw new Error(`Relevance theme ${index} ${field} must be an array`);
  }
  const themeId = opaqueId(raw.themeId, `Relevance theme ${index} themeId`);
  if (!themeIds.has(themeId)) throw new Error(`Relevance theme ${themeId} is not a graph theme`);
  const memberIds = raw.nodeIds.map((value) => opaqueId(value, `Relevance theme ${themeId} nodeId`));
  if (memberIds.some((value) => !nodeIds.has(value))) throw new Error(`Relevance theme ${themeId} has an unknown nodeId`);
  const components = raw.components.map((component, componentIndex) => {
    requireRecord(component, `Component ${componentIndex} on relevance theme ${themeId}`);
    const signalId = opaqueId(component.signalId, `Component ${componentIndex} signalId`);
    if (!signalIds.has(signalId)) throw new Error(`Component ${signalId} is not a graph theme signal`);
    return {
      signalId,
      sourceType: enumValue(component.sourceType, SIGNAL_SOURCE_TYPES, `Component ${signalId} sourceType`),
      observedAt: timestamp(component.observedAt, `Component ${signalId} observedAt`),
      contribution: rangedNumber(component.contribution, `Component ${signalId} contribution`, 0, 100),
    };
  });
  return {
    themeId,
    name: boundedString(raw.name, `Relevance theme ${themeId} name`, 80),
    score: rangedNumber(raw.score, `Relevance theme ${themeId} score`, 0, 100),
    reason: boundedString(raw.reason, `Relevance theme ${themeId} reason`, 240, { optional: true, fallback: '' }),
    nodeIds: [...new Set(memberIds)],
    ...(raw.nodeScores ? {nodeScores:Object.fromEntries(memberIds.filter(id=>Object.hasOwn(raw.nodeScores,id)).map(id=>[id,rangedNumber(raw.nodeScores[id],`Person ${id} relevance score`,0,100)]))} : {}),
    components,
  };
}

function normalizeDiscovery(raw, index, nodeIds, themeIds) {
  requireRecord(raw, `Discovery ${index}`);
  for (const field of ['themeIds', 'pathNodeIds']) {
    if (!Array.isArray(raw[field])) throw new Error(`Discovery ${index} ${field} must be an array`);
  }
  const nodeId = opaqueId(raw.nodeId, `Discovery ${index} nodeId`);
  if (!nodeIds.has(nodeId)) throw new Error(`Discovery ${nodeId} nodeId is not a graph node`);
  const discoveryThemeIds = raw.themeIds.map((value) => opaqueId(value, `Discovery ${nodeId} themeId`));
  if (discoveryThemeIds.some((value) => !themeIds.has(value))) throw new Error(`Discovery ${nodeId} has an unknown themeId`);
  const pathNodeIds = raw.pathNodeIds.map((value) => opaqueId(value, `Discovery ${nodeId} pathNodeId`));
  if (pathNodeIds.some((value) => !nodeIds.has(value))) throw new Error(`Discovery ${nodeId} has an unknown pathNodeId`);
  return {
    nodeId,
    score: rangedNumber(raw.score, `Discovery ${nodeId} score`, 0, Number.MAX_SAFE_INTEGER),
    reason: boundedString(raw.reason, `Discovery ${nodeId} reason`, 240, { optional: true, fallback: '' }),
    themeIds: [...new Set(discoveryThemeIds)],
    pathNodeIds,
    freshness: enumValue(raw.freshness, FRESHNESS_VALUES, `Discovery ${nodeId} freshness`),
    relationshipUncertainty: enumValue(raw.relationshipUncertainty, RELATIONSHIP_UNCERTAINTIES, `Discovery ${nodeId} relationshipUncertainty`),
  };
}

function normalizeRelevance(raw, nodeIds, themeIds, signalIds) {
  if (raw === undefined || raw === null) return { themes: [], connectors: [], discoveries: [] };
  requireRecord(raw, 'Graph relevance');
  for (const field of ['themes', 'connectors', 'discoveries']) {
    if (!Array.isArray(raw[field])) throw new Error(`Graph relevance ${field} must be an array`);
  }
  if (raw.themes.length > MAX_THEMES) throw new Error(`Graph relevance exceeds ${MAX_THEMES} themes`);
  if (raw.connectors.length > nodeIds.size) throw new Error('Graph relevance has too many connectors');
  if (raw.discoveries.length > nodeIds.size) throw new Error('Graph relevance has too many discoveries');
  const themes = raw.themes.map((item, index) => (
    normalizeRelevanceTheme(item, index, nodeIds, themeIds, signalIds)
  ));
  const connectors = raw.connectors.map((item, index) => normalizeConnector(item, index, nodeIds));
  const discoveries = raw.discoveries.map((item, index) => normalizeDiscovery(item, index, nodeIds, themeIds));
  assertUnique(themes.map((theme) => ({ id: theme.themeId })), 'relevance theme');
  assertUnique(connectors.map((connector) => ({ id: connector.nodeId })), 'connector node');
  return {
    version: raw.version === 1 ? 1 : (() => { throw new Error('Graph relevance version must be 1'); })(),
    lens: enumValue(raw.lens, RELEVANCE_LENSES, 'Graph relevance lens'),
    calculatedAt: timestamp(raw.calculatedAt, 'Graph relevance calculatedAt'),
    scoreVersion: raw.scoreVersion === 'relevance-v1'
      ? raw.scoreVersion
      : (() => { throw new Error('Graph relevance scoreVersion is unsupported'); })(),
    themes,
    connectors,
    discoveries,
  };
}

function assertUnique(items, kind) {
  const ids = new Set();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`Duplicate ${kind} id: ${item.id}`);
    ids.add(item.id);
  }
  return ids;
}

function byteLength(input) {
  try {
    return new TextEncoder().encode(JSON.stringify(input)).byteLength;
  } catch {
    throw new Error('Graph must be serializable');
  }
}

export function normalizeGraph(input, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  requireRecord(input, 'Graph');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Graph byte limit must be a positive integer');
  }
  if (!Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    throw new Error('Graph nodes and edges must be arrays');
  }
  if (input.nodes.length > MAX_NODES) throw new Error('Graph exceeds 10,000 nodes');
  if (input.edges.length > MAX_EDGES) throw new Error('Graph exceeds 100,000 edges');
  if (byteLength(input) > maxBytes) throw new Error('Graph exceeds the configured byte limit');

  const nodes = input.nodes.map(normalizeNode);
  const edges = input.edges.map(normalizeEdge);
  const nodeIds = assertUnique(nodes, 'node');
  assertUnique(edges, 'edge');
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new Error(`Edge ${edge.id} has a dangling endpoint`);
    }
    assertUnique(edge.evidence, 'evidence');
  }

  if (input.themes !== undefined && !Array.isArray(input.themes)) {
    throw new Error('Graph themes must be an array');
  }
  if (input.themeSignals !== undefined && !Array.isArray(input.themeSignals)) {
    throw new Error('Graph themeSignals must be an array');
  }
  if (input.connectors !== undefined && !Array.isArray(input.connectors)) {
    throw new Error('Graph connectors must be an array');
  }
  const themesInput = input.themes ?? [];
  const signalsInput = input.themeSignals ?? [];
  if (themesInput.length > MAX_THEMES) throw new Error(`Graph exceeds ${MAX_THEMES} themes`);
  if (signalsInput.length > MAX_SIGNALS) throw new Error(`Graph exceeds ${MAX_SIGNALS} theme signals`);
  if ((input.connectors ?? []).length > nodes.length) throw new Error('Graph has too many connectors');
  const themes = themesInput.map(normalizeTheme);
  const themeIds = assertUnique(themes, 'theme');
  const themeSignals = signalsInput.map((item, index) => (
    normalizeThemeSignal(item, index, nodeIds, themeIds)
  ));
  const signalIds = assertUnique(themeSignals, 'theme signal');
  const relevance = normalizeRelevance(input.relevance, nodeIds, themeIds, signalIds);
  const connectors = (input.connectors ?? relevance.connectors ?? [])
    .map((item, index) => normalizeConnector(item, index, nodeIds));
  assertUnique(connectors.map((connector) => ({ id: connector.nodeId })), 'connector node');

  const suppliedMeta = input.meta === undefined ? {} : requireRecord(input.meta, 'Graph meta');
  return {
    source:input.source==='workspace'?'workspace':null,
    workspaceName:optionalString(input.workspaceName),
    introductionSuggestions:Array.isArray(input.introductionSuggestions)?input.introductionSuggestions.filter(p=>Array.isArray(p.personIds)&&p.personIds.length===2&&p.personIds.every(id=>nodeIds.has(id))&&Array.isArray(p.evidence)).slice(0,12):[],
    sourceCoverage:Array.isArray(input.coverage?.sources)?input.coverage.sources:[],
    nodes,
    edges,
    activity: (Array.isArray(input.activity) ? input.activity : []).filter(e=>e && ['email','meeting','calendar'].includes(e.kind) && Number.isFinite(Date.parse(e.at)) && Array.isArray(e.personIds)).map(e=>({id:String(e.id),kind:e.kind,at:e.at,end:optionalString(e.end),allDay:e.allDay===true,status:e.status==='accepted'?'accepted':'invited',url:typeof e.url==='string'&&e.url.startsWith('https://calendar.google.com/')?e.url:null,acceptedPersonIds:Array.isArray(e.acceptedPersonIds)?e.acceptedPersonIds.filter(id=>nodeIds.has(id)):[],title:String(e.title||''),source:String(e.source||''),personIds:e.personIds.filter(id=>nodes.some(n=>n.id===id))})),
    personFeedback:Object.fromEntries(Object.entries(input.personFeedback||{}).filter(([id,v])=>nodeIds.has(id)&&v&&['boost','suppress','snooze'].includes(v.action)&&Number.isFinite(v.at)).map(([id,v])=>[id,{action:v.action,at:v.at,until:Number.isFinite(v.until)?v.until:0,delta:[-10,0,10].includes(v.delta)?v.delta:0}])),
    activityCoverage: typeof input.activityCoverage==='string' ? input.activityCoverage : 'Only activity available in this snapshot is shown.',
    themes,
    themeSignals,
    relevance,
    connectors,
    meta: {
      ...suppliedMeta,
      revision: input.revision ?? suppliedMeta.revision ?? null,
      snapshotAt: input.pushedAt ?? suppliedMeta.snapshotAt ?? null,
    },
  };
}

function appendSearchText(searchable, id, values) {
  const existing = searchable.get(id) ?? [];
  for (const value of values) {
    if (typeof value === 'string' && value) existing.push(value.toLocaleLowerCase());
  }
  searchable.set(id, existing);
}

export function searchGraph(graph, query) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const needle = String(query ?? '').trim().toLocaleLowerCase();
  if (!needle) return nodes.slice();

  const searchable = new Map();
  for (const node of nodes) {
    appendSearchText(searchable, node.id, [
      node.id,
      node.name,
      node.type,
      node.description,
      node.role,
      node.company,
      node.companySource,
      node.scoreModel,
      node.lastContact,
    ]);
  }
  for (const edge of graph.edges ?? []) {
    const edgeText = [edge.label, edge.kind, edge.owner, edge.visibility];
    for (const evidence of edge.evidence ?? []) {
      edgeText.push(evidence.title, evidence.text, evidence.date, evidence.owner);
    }
    appendSearchText(searchable, edge.source, edgeText);
    appendSearchText(searchable, edge.target, edgeText);
  }
  const themes = new Map((graph.themes ?? []).map((theme) => [theme.id, theme]));
  const relevanceThemes = new Map((graph.relevance?.themes ?? []).map((theme) => [theme.themeId, theme]));
  for (const signal of graph.themeSignals ?? []) {
    if (!signal.personId || !searchable.has(signal.personId)) continue;
    const theme = themes.get(signal.themeId);
    const scored = relevanceThemes.get(signal.themeId);
    appendSearchText(searchable, signal.personId, [
      theme?.name,
      theme?.canonicalName,
      ...(theme?.aliases ?? []),
      theme?.description,
      signal.summary,
      signal.sourceType,
      signal.evidenceRef,
      scored?.reason,
    ]);
  }
  for (const scored of graph.relevance?.themes ?? []) {
    const theme = themes.get(scored.themeId);
    for (const nodeId of scored.nodeIds ?? []) {
      if (!searchable.has(nodeId)) continue;
      appendSearchText(searchable, nodeId, [
        scored.name,
        scored.reason,
        theme?.name,
        theme?.canonicalName,
        ...(theme?.aliases ?? []),
        theme?.description,
      ]);
    }
  }

  return nodes.filter((node) => (
    (searchable.get(node.id) ?? []).some((value) => value.includes(needle))
  ));
}
