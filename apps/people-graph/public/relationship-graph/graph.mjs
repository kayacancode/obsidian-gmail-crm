import { normalizeGraph, searchGraph } from './model.mjs';
import { findPaths } from './paths.mjs';
import { filterRelevance, themeFields } from './relevance.mjs';
import { rankSerendipity } from './discoveries.mjs';

const CANVAS_NODE_LIMIT = 80;
const DIRECTORY_PAGE_SIZE = 50;
// Includes portrait, two-line label and the occasional Why now control at 75% zoom.
const CANVAS_ROW_PITCH = 210;
const SVG_NS = 'http://www.w3.org/2000/svg';

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2)
    .map((part) => part[0]).join('').toLocaleUpperCase() || '?';
}

function cloneTrail(trail) {
  return { nodeIds: [...trail.nodeIds], edgeIds: [...trail.edgeIds] };
}

function hash(value) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function positionFor(node, index, total, layout) {
  const seed = hash(node.id);
  const columns = Math.min(layout.columns, total);
  const column = index % columns;
  const row = Math.floor(index / columns);
  const cellWidth = layout.usableWidth / Math.max(1, columns);
  return {
    x: 32 + cellWidth * (column + .5) + ((seed & 255) / 255 - .5) * 12,
    y: layout.top + 54 + row * CANVAS_ROW_PITCH + (((seed >>> 8) & 255) / 255 - .5) * 10,
    size: 72 + (seed % 19),
    labelWidth: Math.min(136, cellWidth - 24),
  };
}

export function mountGraph(element, options = {}) {
  if (!element?.ownerDocument || typeof element.replaceChildren !== 'function') {
    throw new Error('mountGraph requires a DOM element');
  }

  const document = element.ownerDocument;
  const view = document.defaultView;
  const callbacks = {
    onSelect: typeof options.onSelect === 'function' ? options.onSelect : () => {},
    onSaveTrail: typeof options.onSaveTrail === 'function' ? options.onSaveTrail : () => {},
    onInspectEdge: typeof options.onInspectEdge === 'function' ? options.onInspectEdge : () => {},
    requestPaths: typeof options.requestPaths === 'function' ? options.requestPaths : null,
    onLensChange: options.onLensChange,
    onThemeFeedback: options.onThemeFeedback,
    onRetrievePreview: options.onRetrievePreview,
    onOpenPublicSource: options.onOpenPublicSource,
  };
  let graph = normalizeGraph(options.graph ?? { nodes: [], edges: [] });
  const demoEnabled = () => options.demo === true && graph.meta.fictional === true;
  let byId;
  let edgesByNode;
  let selectedId = null;
  let selectedEdgeId = null;
  let panelMode = null;
  let trail = { nodeIds: [], edgeIds: [] };
  let query = '';
  let page = 0;
  let directoryOpen = false;
  let pathState = null;
  let pathRequest = 0;
  let destroyed = false;
  let drag = null;
  let camera = { x: 0, y: 0, zoom: 1 };
  let lens = validLens(options.lens ?? 'my');
  let activeThemeId = null;
  let canvasThemeMembers = [];
  let relevancePersonId = null;
  let relevanceRequest = 0;
  let relevancePending = false;
  let relevanceStatus = '';
  let correctionOpen = false;
  let relevanceGraph;

  function validLens(value) {
    if (!['my', 'firm', 'public', 'off'].includes(value)) throw new Error('Relevance lens is unsupported');
    return value;
  }

  function invalidateRelevance() {
    relevanceRequest += 1;
    relevancePending = false;
    relevanceStatus = '';
    correctionOpen = false;
  }

  function refreshRelevance() {
    relevanceGraph = lens === 'off'
      ? { ...graph, themes: [], themeSignals: [], relevance: { themes: [], connectors: [], discoveries: [] }, connectors: [] }
      : filterRelevance(graph, lens);
    // A stored score without visible, active evidence must never create a glow.
    const activeIds = new Set(relevanceGraph.themes.filter(theme => theme.status === 'active').map(theme => theme.id));
    relevanceGraph = { ...relevanceGraph, relevance: { ...relevanceGraph.relevance,
      themes: relevanceGraph.relevance.themes.filter(theme => activeIds.has(theme.themeId) && theme.score > 0 && theme.components.length),
    } };
    if (activeThemeId && !relevanceGraph.relevance.themes.some(theme => theme.themeId === activeThemeId)) {
      activeThemeId = null;
      relevancePersonId = null;
      if (panelMode === 'why') panelMode = selectedId ? 'node' : null;
    }
  }

  function personThemes(id) {
    return relevanceGraph.relevance.themes.filter(theme => theme.nodeIds.includes(id)
      && (!activeThemeId || theme.themeId === activeThemeId))
      .map(theme=>({...theme,score:theme.nodeScores?.[id]??theme.score}));
  }

  function applyRelevance(snapshot, nextLens = lens) {
    const checkedLens = validLens(nextLens);
    const nextGraph = snapshot?.relevance
      ? normalizeGraph({ ...graph, themes: snapshot.themes ?? graph.themes, themeSignals: snapshot.themeSignals ?? graph.themeSignals,
        relevance: snapshot.relevance, connectors: snapshot.connectors ?? snapshot.relevance.connectors })
      : normalizeGraph({ ...graph, relevance: snapshot, connectors: snapshot?.connectors ?? [] });
    graph = nextGraph;
    lens = checkedLens;
    refreshRelevance();
  }

  async function requestRelevance(callback, payload, message) {
    if (typeof callback !== 'function') return;
    const request = ++relevanceRequest;
    relevancePending = true;
    relevanceStatus = 'Updating relevance…';
    render();
    try {
      const result = await callback(payload);
      if (destroyed || request !== relevanceRequest) return;
      if (result) applyRelevance(result.snapshot ?? result, lens);
      relevancePending = false;
      correctionOpen = false;
      relevanceStatus = message;
      render();
    } catch {
      if (destroyed || request !== relevanceRequest) return;
      relevancePending = false;
      relevanceStatus = 'Could not update relevance. Your previous view is still available. Try again.';
      render();
    }
  }

  const root = document.createElement('section');
  root.className = 'rg-shell';
  root.dataset.demo = String(demoEnabled());
  root.setAttribute('aria-label', options.title || 'Relationship graph');
  element.replaceChildren(root);

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, action, className) {
    const node = make('button', className, text);
    node.type = 'button';
    node.dataset.action = action;
    return node;
  }

  function rebuildIndexes() {
    byId = new Map(graph.nodes.map((node) => [node.id, node]));
    edgesByNode = new Map(graph.nodes.map((node) => [node.id, []]));
    for (const edge of graph.edges) {
      edgesByNode.get(edge.source).push(edge);
      edgesByNode.get(edge.target).push(edge);
    }
    for (const edges of edgesByNode.values()) edges.sort((a, b) => a.id.localeCompare(b.id));
  }

  const other = (edge, id) => edge.source === id ? edge.target : edge.source;
  const currentRoute = () => pathState?.result?.paths?.[pathState.index] ?? null;

  function canvasLayout() {
    const width = element.clientWidth || 1000;
    const height = Math.max(800, (view?.innerHeight || 900) - 133);
    // Reserve the detail rail on wide screens, and a real text/portrait gutter.
    const usableWidth = Math.max(132, width - (width >= 1100 ? 380 : 64));
    const top = width <= 700 ? 365 : 260;
    const columns = Math.max(1, Math.floor(usableWidth / 140));
    // First center + largest lower label footprint + bottom controls; count the
    // first row explicitly so narrow screens still use the available second row.
    const rows = Math.max(1, 1 + Math.floor((height - top - 54 - 96 - 72) / CANVAS_ROW_PITCH));
    return { width, height, usableWidth, top, columns, capacity: Math.min(CANVAS_NODE_LIMIT, columns * rows) };
  }

  function rankedThemes() {
    return relevanceGraph.relevance.themes.slice().sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  function promotedThemes() {
    // Calendar boilerplate stays inspectable in the complete picker, but does not
    // masquerade as a substantive topic on the map. Never invent replacement names.
    return rankedThemes().filter(theme => !theme.components.every(c => c.sourceType === 'gmail_subject')
      || !/^(?:updated invitation|invitation|accepted|declined|canceled|cancelled|reminder|new registration|thank you|hey|can t|you ve|would love|following up|got my|notes kaya|kaya s|today s|see what|how install|how enable|just fyi|time talk|time chat|finding time|nice chatting|great connecting|my apologies|week has|you guys|meet w|30 min|id\b)\b/i.test(theme.name))
      .slice(0, 5);
  }

  function themeColor(id) {
    return ['238 129 61', '53 153 142', '143 113 192'][hash(id) % 3];
  }

  function themeSource(theme) {
    const types = new Set(theme.components.map(component => component.sourceType));
    if (types.size === 1 && types.has('gmail_subject')) return 'Email subject';
    if (types.has('gmail_body_derived')) return 'AI-extracted topic';
    if (types.has('granola') || types.has('obsidian_note')) return 'Meeting / note theme';
    if ([...types].every(type => type.startsWith('public_'))) return 'Public-source theme';
    return 'Recorded theme';
  }

  function renderTopics() {
    if (lens === 'off' || pathState) return null;
    const themes = rankedThemes();
    const section = make('section', 'rg-topic-bar');
    section.setAttribute('aria-label', 'Topics and themes');
    const heading = make('div', 'rg-topic-heading');
    heading.append(make('h2', '', 'Topics & themes'));
    const reset = button('All themes', 'clear-theme', 'rg-topic-reset');
    reset.setAttribute('aria-pressed', String(!activeThemeId));
    heading.append(reset);
    const picker = make('select');
    picker.dataset.action = 'browse-theme';
    picker.setAttribute('aria-label', 'Browse all themes');
    const placeholder = make('option', '', `Browse all ${themes.length} themes…`);
    placeholder.value = '';picker.append(placeholder);
    for (const theme of themes) {
      const option = make('option', '', `${theme.name} · ${themeSource(theme)}`);
      option.value = theme.themeId;option.selected = activeThemeId === theme.themeId;picker.append(option);
    }
    heading.append(picker);section.append(heading);
    const onlySubjects = themes.length && themes.every(theme => theme.components.every(c => c.sourceType === 'gmail_subject'));
    section.append(make('p', 'rg-topic-explanation', themes.length
      ? onlySubjects ? 'Based on email subjects. Deeper topics need approved body analysis or synced meeting notes.' : 'Themes from your permitted sources. Choose one to see its people and evidence.'
      : `No ${lens === 'firm' ? 'firm-shared' : lens === 'public' ? 'public-source' : 'evidence-backed'} themes yet in this view.`));
    section.querySelector('.rg-topic-explanation').append(make('span', 'rg-heat-legend', 'Color = theme · Glow = recent relevance, not closeness'));
    const chips = make('div', 'rg-topic-chips');
    const promoted = promotedThemes();
    const active = themes.find(theme => theme.themeId === activeThemeId);
    if (active && !promoted.some(theme => theme.themeId === activeThemeId)) promoted.splice(4, 1, active);
    for (const theme of promoted) {
      const chip = button('', 'inspect-theme', 'rg-theme-label');
      chip.dataset.themeId = theme.themeId;
      chip.style.setProperty('--field-color', themeColor(theme.themeId));
      chip.setAttribute('aria-label', `Why ${theme.name} is hot now`);
      chip.setAttribute('aria-pressed', String(theme.themeId === activeThemeId));
      chip.append(make('span', '', theme.name), make('small', '', `${themeSource(theme)} · ${theme.nodeIds.length} people`));
      chips.append(chip);
    }
    section.append(chips);
    return section;
  }

  function visibleCanvasData() {
    const limit = canvasLayout().capacity;
    const members = new Set(canvasThemeMembers);
    const prioritize = nodes => nodes.slice(limit).some(node => members.has(node.id))
      ? nodes.sort((a,b) => Number(members.has(b.id)) - Number(members.has(a.id))) : nodes;
    if (currentRoute()) {
      const route = currentRoute();
      return {
        nodes: route.nodeIds.map((id) => byId.get(id)).filter(Boolean),
        edges: route.edgeIds.map((id) => graph.edges.find((edge) => edge.id === id)).filter(Boolean),
        total: route.nodeIds.length,
        isPath: true,
      };
    }
    if (selectedId) {
      const allEdges = edgesByNode.get(selectedId) ?? [];
      const visibleEdges = allEdges.slice(0, limit - 1);
      const relatedIds = new Set([selectedId, ...members, ...visibleEdges.map((edge) => other(edge, selectedId))]);
      const matches = searchGraph(relevanceGraph, query);
      const visibleNodes = prioritize(matches
        .filter((node) => relatedIds.has(node.id))
        .concat(matches.filter((node) => !relatedIds.has(node.id))))
        .slice(0, limit);
      const visibleIds = new Set(visibleNodes.map((node) => node.id));
      return {
        nodes: visibleNodes,
        edges: visibleEdges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)),
        total: matches.length,
        isPath: false,
        relatedIds,
      };
    }
    const matches = searchGraph(relevanceGraph, query);
    return { nodes: prioritize(matches).slice(0, limit), edges: [], total: matches.length, isPath: false };
  }

  function renderPortrait(node, index) {
    const portrait = make('span', 'rg-portrait');
    const fallback = make('span', 'rg-initials', initials(node.name));
    if (demoEnabled() && node.photoPosition) {
      const photo = make('span', 'rg-photo rg-atlas');
      photo.style.backgroundPosition = node.photoPosition;
      portrait.append(photo);
    } else if (node.photoUrl) {
      const photo = make('img', 'rg-photo');
      photo.src = node.photoUrl;
      photo.alt = '';
      photo.loading = index < 12 ? 'eager' : 'lazy';
      fallback.hidden = true;
      portrait.append(photo, fallback);
    } else portrait.append(fallback);
    return portrait;
  }

  function renderCanvas() {
    const layout = canvasLayout();
    const canvas = make('div', 'rg-canvas');
    if (!currentRoute()) canvas.style.height = `${layout.height}px`;
    canvas.dataset.path = String(Boolean(currentRoute()));
    canvas.dataset.action = 'canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', 'Relationship canvas. Drag or use arrow keys to move; use plus and minus to zoom.');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', currentRoute() ? '0 0 1000 780' : `0 0 ${layout.width} ${layout.height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const lines = document.createElementNS(SVG_NS, 'g');
    svg.append(lines);
    const nodeLayer = make('div', 'rg-nodes');
    const edgeLayer = make('div', 'rg-edge-labels');
    edgeLayer.setAttribute('aria-label', 'Visible relationship evidence');
    const data = visibleCanvasData();
    const positions = new Map();
    const pulseIds = new Set(data.nodes.filter(node => node.type === 'person')
      .map(node => ({ id: node.id, score: Math.max(0, ...personThemes(node.id).map(theme => theme.score)) }))
      .filter(item => item.score >= 80).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, 3).map(item => item.id));
    const badgeIds = new Set(data.nodes.filter(node => personThemes(node.id).length)
      .sort((a,b) => Number(b.id === selectedId) - Number(a.id === selectedId)
        || Math.max(...personThemes(b.id).map(t=>t.score)) - Math.max(...personThemes(a.id).map(t=>t.score)) || a.id.localeCompare(b.id))
      .slice(0, 3).map(node=>node.id));
    data.nodes.forEach((node, index) => {
      const base = data.isPath
        ? { x: 120 + (index * 760) / Math.max(1, data.nodes.length - 1), y: 300, size: 106 }
        : positionFor(node, index, data.nodes.length, layout);
      const position = {
        x: base.x * camera.zoom + camera.x,
        y: data.isPath ? base.y * camera.zoom + camera.y
          : layout.top + 54 + (base.y - layout.top - 54) * camera.zoom + camera.y,
        size: Math.max(54, base.size * camera.zoom),
      };
      positions.set(node.id, position);
      const nodeButton = button('', 'select-node', 'rg-node');
      nodeButton.dataset.nodeId = node.id;
      nodeButton.dataset.active = String(node.id === selectedId);
      nodeButton.dataset.pathNode = String(data.isPath);
      nodeButton.dataset.related = String(Boolean(data.relatedIds?.has(node.id)));
      nodeButton.dataset.context = String(Boolean(selectedId && !data.isPath && !data.relatedIds?.has(node.id)));
      if (lens !== 'off' && node.type === 'person') {
        const themes = personThemes(node.id);
        const heat = Math.max(0, ...themes.map(theme => theme.score));
        const connector = relevanceGraph.connectors.find(item => item.nodeId === node.id);
        if (heat > 0) {
          nodeButton.dataset.hot = 'true';
          nodeButton.dataset.heatLevel = String(heat >= 80 ? 3 : heat >= 50 ? 2 : 1);
          if (pulseIds.has(node.id)) nodeButton.dataset.pulse = 'true';
          nodeButton.title = themes.map(theme => `${theme.name}: ${theme.reason}`).join('\n');
        }
        if (connector?.score > 0) nodeButton.dataset.connector = connector.evidenceClass;
      }
      nodeButton.style.left = data.isPath ? `${position.x / 10}%` : `${position.x}px`;
      nodeButton.style.top = data.isPath ? `${position.y / 7.8}%` : `${position.y}px`;
      nodeButton.style.width = `${position.size}px`;
      nodeButton.style.height = `${position.size}px`;
      nodeButton.style.setProperty('--route-index', String(index));
      nodeButton.style.setProperty('--route-y', `${195 + index * 160}px`);
      nodeButton.style.setProperty('--label-width', `${(base.labelWidth || 136) * camera.zoom}px`);
      nodeButton.setAttribute('aria-label', `Explore ${node.name}`);
      nodeButton.setAttribute('aria-pressed', String(node.id === selectedId));
      nodeButton.append(renderPortrait(node, index));
      const label = make('span', 'rg-node-label', node.name);
      label.append(make('small', '', [node.role, node.company].filter(Boolean).join(' · ') || node.type));
      nodeButton.append(label);
      nodeLayer.append(nodeButton);
      if (lens !== 'off' && node.type === 'person' && badgeIds.has(node.id)) {
        const theme = personThemes(node.id).slice().sort((a, b) => b.score - a.score)[0];
        const badge = button('Why now', 'inspect-theme', 'rg-person-heat');
        badge.dataset.themeId = theme.themeId;
        badge.dataset.personId = node.id;
        badge.style.left = data.isPath ? `${position.x / 10}%` : `${position.x}px`;
        badge.style.top = data.isPath ? `${position.y / 7.8}%` : `${position.y}px`;
        badge.dataset.context = nodeButton.dataset.context;
        badge.style.setProperty('--portrait-half', `${position.size / 2}px`);
        badge.setAttribute('aria-label', `Why ${node.name} is relevant to ${theme.name}`);
        nodeLayer.append(badge);
      }
    });
    data.edges.forEach((edge, edgeIndex) => {
      const source = positions.get(edge.source);
      const target = positions.get(edge.target);
      if (!source || !target) return;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(source.x));
      line.setAttribute('y1', String(source.y));
      line.setAttribute('x2', String(target.x));
      line.setAttribute('y2', String(target.y));
      line.dataset.kind = edge.kind;
      lines.append(line);
      const edgeButton = button(edge.label, 'inspect-edge', 'rg-edge-label');
      edgeButton.dataset.edgeId = edge.id;
      edgeButton.dataset.uncertain = String(edge.kind !== 'personal');
      edgeButton.style.left = data.isPath ? `${((source.x + target.x) / 2) / 10}%` : `${(source.x + target.x) / 2}px`;
      edgeButton.style.top = data.isPath ? `${((source.y + target.y) / 2) / 7.8}%` : `${(source.y + target.y) / 2}px`;
      edgeButton.style.setProperty('--route-edge-y', `${275 + edgeIndex * 160}px`);
      edgeButton.setAttribute('aria-label', `${edge.label}: ${byId.get(edge.source).name} and ${byId.get(edge.target).name} — inspect source`);
      edgeButton.setAttribute('aria-pressed', String(edge.id === selectedEdgeId));
      edgeLayer.append(edgeButton);
    });
    const hiddenCount = Math.max(0, data.total - data.nodes.length);
    if (lens !== 'off' && !data.isPath) {
      const fields = make('div', 'rg-theme-fields');
      const scoredIds = new Set(activeThemeId ? [activeThemeId] : promotedThemes().slice(0, 3).map(theme => theme.themeId));
      themeFields(relevanceGraph, data.nodes.map(node => ({ id: node.id, ...positions.get(node.id) })), lens)
        .filter(field => scoredIds.has(field.themeId)).forEach((field) => {
          const area = make('div', 'rg-theme-field');
          area.dataset.themeId = field.themeId;
          area.dataset.active = String(field.themeId === activeThemeId);
          // Each topic paints local patches around its members, not one huge wash
          // across everyone between them. Per-layer opacity bounds accumulation.
          const color = themeColor(field.themeId);
          area.style.opacity = String(.18 + field.score / 100 * .28);
          area.style.backgroundImage = field.nodeIds.map(id => {
            const point = positions.get(id);
            return `radial-gradient(ellipse 125px 105px at ${point.x}px ${point.y}px, rgb(${color} / .95) 0%, rgb(${color} / .6) 48%, rgb(${color} / 0) 100%)`;
          }).join(',');
          fields.append(area);
        });
      canvas.append(fields);
    }
    canvas.append(svg, nodeLayer, edgeLayer, make('p', 'rg-canvas-note', hiddenCount
      ? `${data.nodes.length} spaced on canvas · ${hiddenCount} more in search & All results`
      : `${data.nodes.length} shown on canvas`));
    return canvas;
  }

  function renderTrail() {
    const nav = make('nav', 'rg-trail');
    nav.setAttribute('aria-label', 'Exploration history');
    const back = button('← Back', 'trail-back');
    back.disabled = trail.nodeIds.length < 2;
    nav.append(back);
    trail.nodeIds.forEach((id, index) => {
      const step = button(byId.get(id)?.name ?? 'Unavailable', 'trail-step');
      step.dataset.trailIndex = String(index);
      if (index === trail.nodeIds.length - 1) step.setAttribute('aria-current', 'step');
      nav.append(step);
    });
    return nav;
  }

  function renderNavigation() {
    const nav = make('div', 'rg-navigation');
    nav.setAttribute('aria-label', 'Canvas navigation');
    nav.append(button('−', 'zoom-out'), make('span', 'rg-zoom-value', `${Math.round(camera.zoom * 100)}%`), button('+', 'zoom-in'), button('Fit', 'fit'));
    nav.children[0].setAttribute('aria-label', 'Zoom out');
    nav.children[2].setAttribute('aria-label', 'Zoom in');
    return nav;
  }

  function renderNodePanel() {
    const node = byId.get(selectedId);
    if (!node) return null;
    const panel = make('section', 'rg-context-panel');
    panel.setAttribute('aria-label', 'Selected item and connections');
    panel.append(button('×', 'close-panel', 'rg-close'));
    panel.lastElementChild.setAttribute('aria-label', 'Close details');
    panel.append(make('p', 'rg-eyebrow', node.type), make('h2', '', node.name));
    if (node.description) panel.append(make('p', 'rg-copy', node.description));
    const profile = [node.role, node.company].filter(Boolean).join(' · ');
    if (profile) panel.append(make('p', 'rg-source', profile));
    if (node.type === 'person') {
      panel.append(button(`Find a path from ${node.name.split(/\s+/)[0]} ↗`, 'start-path', 'rg-person-action'));
      if (typeof callbacks.onRetrievePreview === 'function') panel.append(button('Retrieve more context', 'retrieve-person-context', 'rg-theme-action'));
      if (typeof callbacks.onOpenPublicSource === 'function') panel.append(button('Add public source', 'open-person-public-source', 'rg-theme-action'));
    }
    if (lens !== 'off') {
      const connector = relevanceGraph.connectors.find(item => item.nodeId === node.id);
      if (connector) panel.append(make('p', 'rg-source', `${connector.evidenceClass === 'documented' ? 'Solid' : 'Dashed'} connector ring · ${connector.evidenceClass} bridge · ${connector.documentedDegree} documented links · ${connector.inferredDegree} inferred links. Connector leverage ${connector.score.toFixed(1)}; closeness and willingness unknown.`));
      for (const theme of personThemes(node.id)) {
        const badge = button(`${theme.name} · why now ↗`, 'inspect-theme', 'rg-theme-action');
        badge.dataset.themeId = theme.themeId;
        badge.dataset.personId = node.id;
        panel.append(badge);
      }
    }
    const next = make('div', 'rg-next');
    const seen = new Set();
    for (const edge of edgesByNode.get(node.id) ?? []) {
      const id = other(edge, node.id);
      if (seen.has(id) || seen.size >= 8) continue;
      seen.add(id);
      const nextButton = button('', 'select-node');
      nextButton.dataset.nodeId = id;
      const text = make('span');
      text.append(make('strong', '', byId.get(id).name), make('small', '', edge.label));
      nextButton.append(text, make('span', '', '↗'));
      next.append(nextButton);
    }
    panel.append(next);
    const actions = make('div', 'rg-actions');
    actions.append(button('Save trail', 'save-trail'), button('Canvas ↗', 'close-panel'));
    panel.append(actions);
    return panel;
  }

  function renderWhyPanel() {
    const theme = relevanceGraph.relevance.themes.find(item => item.themeId === activeThemeId);
    if (!theme) return null;
    const panel = make('section', 'rg-context-panel rg-why-panel');
    panel.setAttribute('aria-label', 'Why this is hot now');
    const close = button('×', 'close-panel', 'rg-close');
    close.setAttribute('aria-label', 'Close relevance details');
    panel.append(close, make('p', 'rg-eyebrow', 'Why this is hot now'), make('h2', '', theme.name));
    if (relevancePersonId) panel.append(make('p', 'rg-source', byId.get(relevancePersonId)?.name));
    const score=relevancePersonId ? theme.nodeScores?.[relevancePersonId]??theme.score : theme.score;
    panel.append(make('p', 'rg-copy', theme.reason), make('p', 'rg-source', `Theme heat ${Math.round(score)}/100 · advisory relevance, not relationship strength.`));
    const components = new Map(theme.components.map(component => [component.signalId, component]));
    const signals = relevanceGraph.themeSignals.filter(signal => components.has(signal.id)
      && (!relevancePersonId || !signal.personId || signal.personId === relevancePersonId));
    for (const visibility of ['private', 'firm', 'public']) {
      const group = signals.filter(signal => signal.visibility === visibility);
      if (!group.length) continue;
      panel.append(make('h3', 'rg-eyebrow', `${visibility.toUpperCase()} EVIDENCE`));
      for (const signal of group) {
        const item = make('article', 'rg-evidence-item');
        const component = components.get(signal.id);
        item.append(make('p', 'rg-copy', signal.summary || 'Source summary unavailable'),
          make('p', 'rg-source', `${signal.sourceType.replaceAll('_', ' ')} · observed ${signal.observedAt.slice(0, 10)} · ${Math.round(signal.confidence * 100)}% confidence`),
          make('p', 'rg-source', `Contribution ${component.contribution.toFixed(2)} · ingested ${signal.ingestedAt.slice(0, 10)}`),
          make('p', 'rg-source', `Extraction: ${signal.extractorVersion}${signal.modelId ? ` · ${signal.modelId}` : ''}`),
          // Evidence refs are opaque. Rendering as text avoids inventing a navigation URL.
          make('p', 'rg-source rg-evidence-ref', signal.evidenceRef));
        if(signal.provenance){
          const provenance=signal.provenance;
          const link=make('a','rg-source',`Open source: ${provenance.publisherHost}`);
          link.href=provenance.canonicalUrl;link.target='_blank';link.rel='noopener noreferrer';
          item.append(make('p','rg-source',`Publisher: ${provenance.publisherHost}`),
            make('p','rg-source',`Observed ${provenance.observedAt.slice(0,10)} · Retrieved ${provenance.retrievedAt.slice(0,10)} · publication date unavailable`),link);
        }
        panel.append(item);
      }
    }
    panel.append(make('p', 'rg-source', 'Source summaries and inferred relevance are not verified claims about a person.'));
    const actions = make('div', 'rg-actions');
    for (const action of ['Pin', 'Mute', 'Correct', 'Expire']) {
      const control = button(action, `theme-${action.toLowerCase()}`);
      control.disabled = relevancePending || typeof callbacks.onThemeFeedback !== 'function';
      actions.append(control);
    }
    panel.append(actions);
    if (correctionOpen) {
      const label = make('label', 'rg-correction', 'Replacement theme');
      const select = make('select');
      select.name = 'replacementThemeId';
      select.disabled = relevancePending;
      for (const replacement of relevanceGraph.themes.filter(item => item.id !== theme.themeId && item.status === 'active')) {
        const option = make('option', '', replacement.name);
        option.value = replacement.id;
        select.append(option);
      }
      label.append(select);
      const save = button('Save correction', 'theme-save-correction', 'rg-theme-action');
      save.disabled = relevancePending || !select.options.length;
      panel.append(label, save);
    }
    const context = button('Retrieve more context', 'retrieve-context', 'rg-theme-action');
    context.disabled = relevancePending || typeof callbacks.onRetrievePreview !== 'function';
    const publicSource = button('Add public source', 'open-public-source', 'rg-theme-action');
    publicSource.disabled = relevancePending || typeof callbacks.onOpenPublicSource !== 'function';
    panel.append(context, publicSource);
    return panel;
  }

  function renderDiscoveries() {
    const permittedNodes = graph.nodes.filter(node => node.type === 'person'
      && node.permission !== 'denied' && node.permission !== 'conflicted' && !node.permissionConflict
      && node.identityStatus !== 'unresolved' && node.identityResolved !== false
      && (lens === 'my' || node.visibility === lens));
    const permittedIds = new Set(permittedNodes.map(node => node.id));
    const scored = { ...relevanceGraph.relevance,
      themes: relevanceGraph.relevance.themes.filter(theme => !activeThemeId || theme.themeId === activeThemeId) };
    const candidates = selectedId
      ? rankSerendipity({ nodes: permittedNodes, edges: graph.edges, relevance: scored,
        selectedNodeIds: [...new Set([...trail.nodeIds, selectedId])], mutedNodeIds: [], lens })
      : scored.discoveries;
    const items = candidates.filter(item => permittedIds.has(item.nodeId)
      && item.pathNodeIds.every(id => permittedIds.has(id))
      && item.themeIds.some(id => scored.themes.some(theme => theme.themeId === id)))
      .slice().sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId)).slice(0, 5);
    if (!items.length) return null;
    const section = make('section', 'rg-discoveries');
    section.setAttribute('aria-label', 'Adjacent discoveries');
    section.append(make('h2', 'rg-eyebrow', 'Adjacent discoveries'));
    for (const item of items) {
      const row = button('', 'select-node', 'rg-discovery');
      row.dataset.nodeId = item.nodeId;
      const theme = scored.themes.find(theme => item.themeIds.includes(theme.themeId));
      const bridge = item.pathNodeIds.slice(1, -1).map(id => byId.get(id)?.name).filter(Boolean).join(' → ');
      row.append(make('strong', '', byId.get(item.nodeId).name),
        make('span', '', `${theme?.name ?? ''} · Why now: ${item.reason}`),
        make('small', '', `${bridge ? `${item.relationshipUncertainty === 'documented' ? 'Documented' : 'Possible'} bridge: ${bridge} · ` : ''}${item.freshness} evidence · ${item.relationshipUncertainty} relationship · willingness unknown`));
      section.append(row);
    }
    return section;
  }

  function renderEvidencePanel() {
    const edge = graph.edges.find((item) => item.id === selectedEdgeId);
    if (!edge) return null;
    const panel = make('section', 'rg-context-panel rg-evidence-panel');
    panel.setAttribute('aria-label', 'Relationship evidence');
    panel.append(button('×', 'close-panel', 'rg-close'));
    panel.lastElementChild.setAttribute('aria-label', 'Close evidence');
    panel.append(make('p', 'rg-eyebrow', 'Relationship evidence'), make('h2', '', edge.label));
    panel.append(make('p', 'rg-copy', `${byId.get(edge.source).name} ↔ ${byId.get(edge.target).name}`));
    const status = edge.kind === 'personal'
      ? 'Recorded personal relationship · closeness and willingness unknown'
      : edge.kind === 'cooccurrence'
        ? 'Co-occurrence only · personal relationship unverified'
        : 'Attributed interpretation · not an introduction relationship';
    panel.append(make('p', 'rg-evidence-status', status));
    if (!edge.evidence.length) panel.append(make('p', 'rg-source', 'Evidence not included'));
    edge.evidence.forEach((evidence) => {
      const item = make('article', 'rg-evidence-item');
      item.append(make('h3', '', evidence.title || 'Recorded evidence'));
      if (evidence.text) item.append(make('p', 'rg-copy', evidence.text));
      item.append(make('p', 'rg-source', evidence.date || 'Date not included'));
      item.append(make('p', 'rg-source', evidence.owner ? `Recorded by ${evidence.owner}` : 'Recorder not included'));
      if (evidence.url) {
        const link = make('a', 'rg-source-link', 'Open source ↗');
        link.href = evidence.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        item.append(link);
      } else item.append(make('p', 'rg-source', 'Source link not included'));
      panel.append(item);
    });
    panel.append(make('p', 'rg-source', edge.owner ? `Relationship recorded by ${edge.owner}` : 'Relationship owner not included'));
    if (edge.visibility) panel.append(make('p', 'rg-source', `Visibility: ${edge.visibility}`));
    return panel;
  }

  function routeLabel(route) {
    const middle = route.nodeIds.slice(1, -1).map((id) => byId.get(id)?.name);
    return middle.length ? `Via ${middle.join(' → ')}` : 'Direct';
  }

  function renderPathControls() {
    if (!pathState) return [];
    const bar = make('div', 'rg-path-bar');
    bar.setAttribute('aria-label', 'Choose people for a path');
    for (const [key, labelText] of [['from', 'From'], ['to', 'To']]) {
      const label = make('label', '', labelText);
      const select = make('select');
      select.dataset.action = key === 'from' ? 'path-from' : 'path-to';
      select.setAttribute('aria-label', key === 'from' ? 'Path starting person' : 'Path destination person');
      if (key === 'to') {
        const placeholder = make('option', '', 'Choose a person');
        placeholder.value = '';
        if (!pathState.to) placeholder.setAttribute('selected', '');
        select.append(placeholder);
      }
      graph.nodes.filter((node) => node.type === 'person' && (key === 'from' || node.id !== pathState.from)).forEach((node) => {
        const option = make('option', '', node.name);
        option.value = node.id;
        if (node.id === pathState[key]) option.setAttribute('selected', '');
        select.append(option);
      });
      label.append(select);
      bar.append(label);
    }
    bar.append(button('← Canvas', 'close-path'));
    const summary = make('section', 'rg-path-summary');
    summary.setAttribute('aria-label', 'Compare introduction paths');
    if (!pathState.to) summary.append(make('p', 'rg-copy', 'Choose another person above, or select their photograph.'));
    else if (pathState.loading) summary.append(make('p', 'rg-copy', 'Finding permitted paths…'));
    else if (pathState.error) summary.append(make('p', 'rg-copy', 'Paths are unavailable right now. Try again.'));
    else if (!pathState.result?.paths?.length) {
      summary.append(
        make('p', 'rg-copy', `No recorded people path between ${byId.get(pathState.from).name} and ${byId.get(pathState.to).name}.`),
        make('p', 'rg-source', pathState.result?.truncated
          ? 'The bounded search was truncated; this is not proof that no connection exists.'
          : 'Shared interests and stories are not evidence that two people know one another.'),
      );
    } else {
      summary.append(make('p', 'rg-path-heading', `${byId.get(pathState.from).name} → ${byId.get(pathState.to).name}`));
      const switcher = make('div', 'rg-route-switch');
      pathState.result.paths.forEach((route, index) => {
        const routeButton = button('', 'route-option', 'rg-route-option');
        routeButton.dataset.routeIndex = String(index);
        routeButton.setAttribute('aria-pressed', String(index === pathState.index));
        routeButton.append(make('span', '', routeLabel(route)), make('small', '', route.requiresVerification ? 'Needs verification' : 'Recorded personal links'));
        switcher.append(routeButton);
      });
      summary.append(switcher);
      const route = currentRoute();
      summary.append(make('p', 'rg-copy', route.requiresVerification
        ? 'This route includes co-occurrence evidence. Verify that the people know one another before requesting an introduction.'
        : 'Follow the route one introduction at a time, checking closeness and willingness at every step.'));
      summary.append(make('p', 'rg-source', pathState.result.truncated
        ? 'More paths may exist; the bounded search omitted additional alternatives.'
        : 'No path confirms willingness or consent.'));
      summary.append(button('Save this path', 'save-route', 'rg-save-route'));
    }
    return [bar, summary];
  }

  function renderDirectory() {
    const members = activeThemeId ? relevanceGraph.relevance.themes.find(theme => theme.themeId === activeThemeId)?.nodeIds : null;
    const matches = searchGraph(relevanceGraph, query).filter(node => !members || members.includes(node.id));
    const totalPages = Math.max(1, Math.ceil(matches.length / DIRECTORY_PAGE_SIZE));
    page = Math.min(page, totalPages - 1);
    const details = make('details', 'rg-directory');
    if (query || directoryOpen || activeThemeId) details.setAttribute('open', '');
    details.append(make('summary', '', `All results (${matches.length})`));
    const body = make('div', 'rg-directory-body');
    if (!matches.length) body.append(make('p', 'rg-empty', query ? `No results for “${query}”.` : 'No people or organizations are available.'));
    else {
      const list = make('ol', 'rg-directory-list');
      matches.slice(page * DIRECTORY_PAGE_SIZE, (page + 1) * DIRECTORY_PAGE_SIZE).forEach((node) => {
        const item = make('li');
        const itemButton = button('', 'select-node', 'rg-directory-item');
        itemButton.dataset.nodeId = node.id;
        itemButton.append(
          make('strong', '', node.name),
          make('small', '', [query ? 'Literal recorded-text match' : null, node.role, node.company, node.type].filter(Boolean).join(' · ')),
        );
        item.append(itemButton);
        list.append(item);
      });
      body.append(list);
      const paging = make('nav', 'rg-pagination');
      paging.setAttribute('aria-label', 'Result pages');
      const previous = button('Previous results', 'previous-page');
      previous.disabled = page === 0;
      const next = button('Next results', 'next-page');
      next.disabled = page >= totalPages - 1;
      paging.append(previous, make('span', 'rg-page-status', `Page ${page + 1} of ${totalPages}`), next);
      body.append(paging);
    }
    details.append(body);
    return details;
  }

  function render(focusAction = null) {
    if (destroyed) return;
    // Off removes the relevance layer without moving the last chosen people.
    if (lens !== 'off') canvasThemeMembers = relevanceGraph.relevance.themes
      .find(theme => theme.themeId === activeThemeId)?.nodeIds ?? [];
    root.dataset.demo = String(demoEnabled());
    root.replaceChildren();
    const header = make('header', 'rg-header');
    header.append(button(options.title || 'Relationships', 'overview', 'rg-wordmark'));
    const searchWrap = make('label', 'rg-search-wrap');
    searchWrap.append(make('span', 'rg-visually-hidden', 'Search recorded relationship data'));
    const search = make('input', 'rg-search');
    search.type = 'search';
    search.placeholder = 'Find a person, company, story…';
    search.value = query;
    search.dataset.action = 'search';
    searchWrap.append(search);
    header.append(searchWrap);
    const actions = make('nav', 'rg-header-actions');
    actions.setAttribute('aria-label', 'Relationship tools');
    const lensLabel = make('label', 'rg-lens', 'Relevance now');
    const select = make('select');
    select.dataset.action = 'relevance-lens';
    for (const [value, name] of [['my', 'My mind'], ['firm', 'Firm'], ['public', 'Public momentum'], ['off', 'Off']]) {
      const option = make('option', '', name);
      option.value = value;
      option.selected = value === lens;
      select.append(option);
    }
    lensLabel.append(select);
    actions.append(lensLabel);
    const pathButton = button('Find a path ↗', 'start-path', 'rg-text-button');
    pathButton.disabled = !graph.nodes.some((node) => node.type === 'person');
    pathButton.setAttribute('aria-pressed', String(Boolean(pathState)));
    actions.append(pathButton);
    header.append(actions);
    const [pathBar, pathSummary] = renderPathControls();
    root.append(header);
    if (pathBar) root.append(pathBar);
    const topics = renderTopics();
    if (topics) root.append(topics);
    const canvas = renderCanvas();
    root.append(canvas);
    if (pathSummary) root.append(pathSummary);
    const bottom = make('div', 'rg-bottom');
    if (!pathState) bottom.append(renderTrail());
    bottom.append(renderNavigation());
    canvas.append(bottom);
    if (panelMode === 'why' && lens !== 'off') {
      const panel = renderWhyPanel();
      if (panel) root.append(panel);
    } else if (panelMode === 'edge') root.append(renderEvidencePanel());
    else if (panelMode === 'node' && !pathState) root.append(renderNodePanel());
    if (lens !== 'off' && !pathState) {
      const discoveries = renderDiscoveries();
      if (discoveries) root.append(discoveries);
    }
    root.append(renderDirectory());
    const meta = make('footer', 'rg-meta');
    meta.append(
      make('span', '', demoEnabled() ? 'Explicitly fictional demo network' : 'Authorized records supplied by this workspace'),
      make('span', 'rg-status', selectedId ? `${byId.get(selectedId)?.name ?? 'Selection'} selected` : 'Select a photograph or initial to explore'),
    );
    meta.lastElementChild.setAttribute('role', 'status');
    meta.lastElementChild.setAttribute('aria-live', 'polite');
    root.append(meta);
    if (lens !== 'off') {
      const status = make('p', 'rg-relevance-status', relevanceStatus);
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      root.append(status);
    }
    if (focusAction) root.querySelector(`[data-action="${focusAction}"]`)?.focus();
  }

  function selectNode(id, { notify = true } = {}) {
    if (destroyed || !byId.has(id)) return;
    invalidateRelevance();
    activeThemeId = null;
    canvasThemeMembers = [];
    relevancePersonId = null;
    if (pathState && !pathState.to && id !== pathState.from && byId.get(id).type === 'person') {
      pathState.to = id;
      requestCurrentPaths();
      return;
    }
    if (pathState) closePath();
    if (!trail.nodeIds.length) trail = { nodeIds: [id], edgeIds: [] };
    else if (trail.nodeIds.at(-1) !== id) {
      const previous = trail.nodeIds.at(-1);
      const edge = (edgesByNode.get(previous) ?? []).find((item) => other(item, previous) === id);
      trail = edge
        ? { nodeIds: [...trail.nodeIds, id], edgeIds: [...trail.edgeIds, edge.id] }
        : { nodeIds: [id], edgeIds: [] };
    }
    selectedId = id;
    selectedEdgeId = null;
    panelMode = 'node';
    query = '';
    page = 0;
    render();
    if (notify) callbacks.onSelect({ node: byId.get(id), trail: cloneTrail(trail) });
  }

  function inspectEdge(id) {
    const edge = graph.edges.find((item) => item.id === id);
    if (!edge) return;
    invalidateRelevance();
    selectedEdgeId = id;
    panelMode = 'edge';
    render();
    callbacks.onInspectEdge(edge);
  }

  function startPath() {
    const people = graph.nodes.filter((node) => node.type === 'person');
    if (!people.length) return;
    invalidateRelevance();
    activeThemeId = null;
    canvasThemeMembers = [];
    const from = byId.get(selectedId)?.type === 'person' ? selectedId : people[0].id;
    pathRequest += 1;
    pathState = { from, to: '', result: null, index: 0, loading: false, error: null, camera: { ...camera } };
    panelMode = null;
    selectedEdgeId = null;
    render();
  }

  function closePath() {
    if (!pathState) return;
    invalidateRelevance();
    pathRequest += 1;
    camera = pathState.camera;
    pathState = null;
    selectedEdgeId = null;
    panelMode = selectedId ? 'node' : null;
    render();
  }

  function requestCurrentPaths() {
    if (!pathState?.to) {
      pathRequest += 1;
      pathState.result = null;
      pathState.loading = false;
      render();
      return;
    }
    const requestId = ++pathRequest;
    const { from, to } = pathState;
    pathState.loading = true;
    pathState.error = null;
    pathState.result = null;
    pathState.index = 0;
    const summary = root.querySelector('.rg-path-summary');
    if (summary) summary.replaceChildren(make('p', 'rg-copy', 'Finding permitted paths…'));
    let requested;
    try {
      requested = callbacks.requestPaths
        ? callbacks.requestPaths(from, to, { maxHops: 3, maxPaths: 12, maxVisits: 20_000 })
        : findPaths(graph, from, to);
    } catch {
      requested = Promise.reject(new Error('Path request failed'));
    }
    Promise.resolve(requested).then((result) => {
      if (destroyed || requestId !== pathRequest || pathState?.from !== from || pathState?.to !== to) return;
      if (!result || !Array.isArray(result.paths) || typeof result.truncated !== 'boolean') throw new Error('Path service returned an invalid result');
      pathState.result = result;
      pathState.loading = false;
      render();
    }).catch(() => {
      if (destroyed || requestId !== pathRequest || pathState?.from !== from || pathState?.to !== to) return;
      pathState.loading = false;
      pathState.error = true;
      render();
    });
  }

  function zoom(multiplier, focusAction = null) {
    camera.zoom = Math.max(0.75, Math.min(1.65, camera.zoom * multiplier));
    render(focusAction);
  }

  function onClick(event) {
    if (destroyed) return;
    const target = event.target.closest?.('[data-action]');
    if (!target || !root.contains(target)) return;
    const action = target.dataset.action;
    if (action === 'clear-theme') {
      invalidateRelevance();activeThemeId = null;relevancePersonId = null;
      canvasThemeMembers = [];
      panelMode = selectedId ? 'node' : null;render();
    } else if (action === 'inspect-theme') {
      invalidateRelevance();
      activeThemeId = target.dataset.themeId;
      relevancePersonId = target.dataset.personId ?? null;
      panelMode = 'why';
      render();
    } else if (action === 'theme-correct') {
      correctionOpen = true;
      render();
    } else if (['theme-pin', 'theme-mute', 'theme-expire', 'theme-save-correction'].includes(action)) {
      if (relevancePending) return;
      const payload = { themeId: activeThemeId, personId: relevancePersonId,
        action: action === 'theme-save-correction' ? 'correct' : action.slice(6) };
      if (payload.action === 'correct') payload.replacementThemeId = root.querySelector('[name="replacementThemeId"]')?.value;
      requestRelevance(callbacks.onThemeFeedback, payload, 'Relevance updated.');
    } else if (action === 'retrieve-person-context' || action === 'open-person-public-source') {
      if (relevancePending || !selectedId) return;
      requestRelevance(action === 'retrieve-person-context' ? callbacks.onRetrievePreview : callbacks.onOpenPublicSource,
        { personId: selectedId }, 'Context request completed.');
    } else if (action === 'retrieve-context' || action === 'open-public-source') {
      if (relevancePending) return;
      requestRelevance(action === 'retrieve-context' ? callbacks.onRetrievePreview : callbacks.onOpenPublicSource,
        { themeId: activeThemeId, personId: relevancePersonId }, 'Context request completed.');
    } else if (action === 'select-node') selectNode(target.dataset.nodeId);
    else if (action === 'inspect-edge') inspectEdge(target.dataset.edgeId);
    else if (action === 'start-path') startPath();
    else if (action === 'close-path') closePath();
    else if (action === 'close-panel') { invalidateRelevance(); activeThemeId = null; canvasThemeMembers = []; panelMode = null; selectedEdgeId = null; render(); }
    else if (action === 'save-trail' && trail.nodeIds.length) callbacks.onSaveTrail(cloneTrail(trail));
    else if (action === 'save-route' && currentRoute()) callbacks.onSaveTrail(cloneTrail(currentRoute()));
    else if (action === 'overview') {
      invalidateRelevance();
      activeThemeId = null;
      canvasThemeMembers = [];
      pathRequest += 1;
      selectedId = null;
      selectedEdgeId = null;
      panelMode = null;
      pathState = null;
      query = '';
      camera = { x: 0, y: 0, zoom: 1 };
      render();
    } else if (action === 'trail-back' && trail.nodeIds.length > 1) {
      invalidateRelevance();
      activeThemeId = null;
      canvasThemeMembers = [];
      trail = { nodeIds: trail.nodeIds.slice(0, -1), edgeIds: trail.edgeIds.slice(0, -1) };
      selectedId = trail.nodeIds.at(-1);
      panelMode = 'node';
      render();
      callbacks.onSelect({ node: byId.get(selectedId), trail: cloneTrail(trail) });
    } else if (action === 'trail-step') {
      invalidateRelevance();
      activeThemeId = null;
      canvasThemeMembers = [];
      const index = Number(target.dataset.trailIndex);
      trail = { nodeIds: trail.nodeIds.slice(0, index + 1), edgeIds: trail.edgeIds.slice(0, index) };
      selectedId = trail.nodeIds.at(-1);
      panelMode = 'node';
      render();
      callbacks.onSelect({ node: byId.get(selectedId), trail: cloneTrail(trail) });
    } else if (action === 'route-option') {
      invalidateRelevance();
      pathState.index = Number(target.dataset.routeIndex);
      selectedEdgeId = null;
      panelMode = null;
      render();
    } else if (action === 'previous-page') { page -= 1; render(); }
    else if (action === 'next-page') { page += 1; render(); }
    else if (action === 'zoom-in') zoom(1.18, 'zoom-in');
    else if (action === 'zoom-out') zoom(1 / 1.18, 'zoom-out');
    else if (action === 'fit') { camera = { x: 0, y: 0, zoom: 1 }; render('fit'); }
  }

  function onInput(event) {
    if (event.target.dataset?.action !== 'search') return;
    query = event.target.value;
    page = 0;
    render();
    const nextSearch = root.querySelector('[data-action="search"]');
    nextSearch?.focus();
    nextSearch?.setSelectionRange?.(query.length, query.length);
  }

  function onChange(event) {
    const action = event.target.dataset?.action;
    if (action === 'browse-theme') {
      invalidateRelevance();activeThemeId = event.target.value || null;relevancePersonId = null;
      panelMode = activeThemeId ? 'why' : selectedId ? 'node' : null;render('browse-theme');return;
    }
    if (action === 'relevance-lens') {
      invalidateRelevance();
      lens = validLens(event.target.value);
      refreshRelevance();
      render();
      requestRelevance(callbacks.onLensChange, lens, 'Relevance lens updated.');
      return;
    }
    if (!pathState || (action !== 'path-from' && action !== 'path-to')) return;
    invalidateRelevance();
    if (action === 'path-from') {
      pathState.from = event.target.value;
      if (pathState.from === pathState.to) pathState.to = '';
    } else pathState.to = event.target.value;
    requestCurrentPaths();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      if (pathState) closePath();
      else if (panelMode) { invalidateRelevance(); activeThemeId = null; canvasThemeMembers = []; panelMode = null; selectedEdgeId = null; render(); }
      return;
    }
    if (!event.target.closest?.('.rg-canvas')) return;
    const movement = 28;
    if (event.key === 'ArrowLeft') camera.x -= movement;
    else if (event.key === 'ArrowRight') camera.x += movement;
    else if (event.key === 'ArrowUp') camera.y -= movement;
    else if (event.key === 'ArrowDown') camera.y += movement;
    else if (event.key === '+' || event.key === '=') { zoom(1.18, 'canvas'); event.preventDefault(); return; }
    else if (event.key === '-') { zoom(1 / 1.18, 'canvas'); event.preventDefault(); return; }
    else if (event.key === 'Home') camera = { x: 0, y: 0, zoom: 1 };
    else return;
    event.preventDefault();
    render('canvas');
  }

  function onPointerDown(event) {
    if (!event.target.closest?.('.rg-canvas') || event.target.closest('button,input,select')) return;
    drag = { x: event.clientX, y: event.clientY, camera: { ...camera } };
    root.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event) {
    if (!drag) return;
    camera.x = drag.camera.x + event.clientX - drag.x;
    camera.y = drag.camera.y + event.clientY - drag.y;
    render();
  }

  const onPointerUp = (event) => {
    drag = null;
    if (root.hasPointerCapture?.(event.pointerId)) root.releasePointerCapture(event.pointerId);
  };
  function onWheel(event) {
    if (!event.target.closest?.('.rg-canvas') || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    zoom(Math.exp(-event.deltaY * 0.006));
  }
  function onImageError(event) {
    if (!event.target.matches?.('img.rg-photo')) return;
    event.target.hidden = true;
    if (event.target.nextElementSibling) event.target.nextElementSibling.hidden = false;
  }
  function onToggle(event) {
    if (event.target.matches?.('.rg-directory')) directoryOpen = event.target.hasAttribute('open');
  }

  rebuildIndexes();
  refreshRelevance();
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('keydown', onKeyDown);
  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', onPointerUp);
  root.addEventListener('pointercancel', onPointerUp);
  root.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('error', onImageError, true);
  root.addEventListener('toggle', onToggle, true);
  let lastSize = `${element.clientWidth}:${view?.innerHeight}`;
  function onResize() {
    const size = `${element.clientWidth}:${view?.innerHeight}`;
    // Expanding evidence/directory changes height, not the layout budget. Replacing
    // controls in that case would discard the keyboard focus we just restored.
    if (size === lastSize) return;
    lastSize = size;
    render();
  }
  const resizeObserver = typeof view?.ResizeObserver === 'function' ? new view.ResizeObserver(onResize) : null;
  resizeObserver?.observe(element);
  view?.addEventListener('resize', onResize);
  render();

  return {
    setGraph(nextGraph) {
      if (destroyed) return;
      graph = normalizeGraph(nextGraph);
      invalidateRelevance();
      refreshRelevance();
      pathRequest += 1;
      rebuildIndexes();
      if (selectedId && !byId.has(selectedId)) {
        selectedId = null;
        panelMode = null;
      }
      if (selectedEdgeId && !graph.edges.some((edge) => edge.id === selectedEdgeId)) {
        selectedEdgeId = null;
        if (panelMode === 'edge') panelMode = selectedId ? 'node' : null;
      }
      const trailAvailable = trail.nodeIds.every((id) => byId.has(id))
        && trail.edgeIds.length === Math.max(0, trail.nodeIds.length - 1)
        && trail.edgeIds.every((edgeId, index) => {
          const edge = graph.edges.find((item) => item.id === edgeId);
          if (!edge) return false;
          const endpoints = [trail.nodeIds[index], trail.nodeIds[index + 1]];
          return endpoints.includes(edge.source) && endpoints.includes(edge.target);
        });
      if (!trailAvailable) trail = selectedId ? { nodeIds: [selectedId], edgeIds: [] } : { nodeIds: [], edgeIds: [] };
      if (pathState) {
        const endpointsAvailable = byId.get(pathState.from)?.type === 'person'
          && (!pathState.to || byId.get(pathState.to)?.type === 'person');
        if (!endpointsAvailable) pathState = null;
        else if (pathState.result?.paths) {
          const paths = pathState.result.paths.filter((route) => route.nodeIds.every((id) => byId.has(id))
            && route.edgeIds.every((id) => graph.edges.some((edge) => edge.id === id)));
          pathState.result = { ...pathState.result, paths };
          pathState.index = Math.min(pathState.index, Math.max(0, paths.length - 1));
        }
      }
      const refreshPath = Boolean(pathState?.to);
      render();
      if (refreshPath) requestCurrentPaths();
    },
    setRelevance(snapshot, nextLens = lens) {
      if (destroyed) return;
      applyRelevance(snapshot, nextLens);
      invalidateRelevance();
      render();
    },
    select(id) { selectNode(id); },
    restoreTrail(nextTrail) {
      if (destroyed) return;
      if (!nextTrail || !Array.isArray(nextTrail.nodeIds) || !Array.isArray(nextTrail.edgeIds)) throw new Error('A trail needs nodeIds and edgeIds');
      if (!nextTrail.nodeIds.length || nextTrail.nodeIds.some((id) => !byId.has(id))) throw new Error('Trail contains an unavailable node');
      if (nextTrail.edgeIds.length !== nextTrail.nodeIds.length - 1) throw new Error('Trail edges must connect each node step');
      nextTrail.edgeIds.forEach((edgeId, index) => {
        const edge = graph.edges.find((item) => item.id === edgeId);
        const endpoints = [nextTrail.nodeIds[index], nextTrail.nodeIds[index + 1]];
        if (!edge || !endpoints.includes(edge.source) || !endpoints.includes(edge.target)) throw new Error('Trail contains an unavailable edge');
      });
      pathRequest += 1;
      invalidateRelevance();
      activeThemeId = null;
      canvasThemeMembers = [];
      pathState = null;
      trail = cloneTrail(nextTrail);
      selectedId = trail.nodeIds.at(-1);
      selectedEdgeId = null;
      panelMode = 'node';
      render();
      callbacks.onSelect({ node: byId.get(selectedId), trail: cloneTrail(trail) });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      invalidateRelevance();
      pathRequest += 1;
      resizeObserver?.disconnect();
      view?.removeEventListener('resize', onResize);
      root.removeEventListener('click', onClick);
      root.removeEventListener('input', onInput);
      root.removeEventListener('change', onChange);
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerup', onPointerUp);
      root.removeEventListener('pointercancel', onPointerUp);
      root.removeEventListener('wheel', onWheel);
      root.removeEventListener('error', onImageError, true);
      root.removeEventListener('toggle', onToggle, true);
      element.replaceChildren();
    },
  };
}
