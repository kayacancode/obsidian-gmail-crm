const PRIVATE_STATE = { lens: 'my', relevance: null, relevanceEnvelope: null, evidence: null, retrievalPreview: null, publicPreview: null, retrievalJob: null, publicJob: null, workflowMessage: '' };
const EMPTY_STATE = Object.freeze({ phase: 'idle', account: null, graph: null, source: 'best', message: '', ...PRIVATE_STATE });
// An address safe to place inside a mailto: link without opening header injection
// (?/&/# start mailto query/fragment syntax, %<>/"' can break out of an href attribute).
// The server applies the same rule (see MAILTO_SAFE in src/mail-sync.ts) and returns
// to:null when it does not hold, but this is not trusted client input: re-check here too.
const MAILTO_SAFE = /^[^\s?&#%/<>"']+@[^\s?&#%/<>"']+$/;

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function createRelationshipController({ fetchImpl = fetch, origin = location.origin, onState = () => {}, sleep = abortableSleep } = {}) {
  let state = { ...EMPTY_STATE };
  let generation = 0;
  let controller = null;
  let tokenController = null;
  let authenticatedAccount = null;
  let relevanceGeneration = 0;
  let relevanceController = null;
  let retrievalPreviewGeneration = 0;
  let retrievalPreviewController = null;
  let workflows = new AbortController();
  const previews = new WeakMap();
  const polls = new Map();

  const publish = (next) => {
    state = { ...state, ...next };
    onState({ ...state });
  };
  const invalidate = () => {
    generation += 1;
    controller?.abort();
    tokenController?.abort();
    controller = null;
    tokenController = null;
    relevanceGeneration += 1;
    relevanceController?.abort();
    retrievalPreviewGeneration += 1;
    retrievalPreviewController?.abort();
    workflows.abort(); workflows = new AbortController();
    polls.clear();
    state = { ...state, ...PRIVATE_STATE };
  };
  const signedOut = (message = 'Sign in to explore your private relationship graph.') => {
    invalidate();
    authenticatedAccount = null;
    publish({ phase: 'signed-out', account: null, graph: null, message });
  };

  const sourceSuffix = () => state.source === 'obsidian' || state.graph?.source !== 'email_accounts' ? 'source=obsidian' : '';
  const withSource = (path, query = '') => `${path}${query || sourceSuffix() ? '?' : ''}${[query,sourceSuffix()].filter(Boolean).join('&')}`;
  const clean = input => Object.fromEntries(Object.entries(input).filter(([,value]) => value !== null && value !== undefined));
  function context() {
    if (!authenticatedAccount) throw Error('Sign in before requesting context.');
    return { run: generation, signal: workflows.signal, account: authenticatedAccount };
  }
  function current(ctx) {
    if (ctx.run !== generation || ctx.account !== authenticatedAccount || ctx.signal.aborted) throw new DOMException('Account context changed', 'AbortError');
  }
  async function request(path, { body, key, signal } = {}, ctx = context()) {
    current(ctx);
    const response = await fetchImpl(path, { cache: 'no-store', signal: signal ?? ctx.signal,
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin, ...(key ? { 'Idempotency-Key': key } : {}) } }) });
    current(ctx);
    if (response.status === 401) { signedOut('Your session expired. Sign in again to continue.'); throw Error('Your session expired.'); }
    if (!response.ok) {
      const error = Error(`Context request failed (${response.status}). Please retry.`);
      // Attach the status and, when the body carries one, the server's own message, so a
      // caller that wants readable copy (e.g. openDraftNote) can use it instead of this
      // generic text. Existing callers are unaffected: error.message is unchanged.
      error.status = response.status;
      try { const failedBody = await response.json(); if (failedBody && typeof failedBody.message === 'string') error.serverMessage = failedBody.message; } catch {}
      throw error;
    }
    const data = await response.json(); current(ctx);
    if (data.account && data.account !== ctx.account && path.startsWith('/api/graph')) throw Error('The graph account changed.');
    return data;
  }
  function envelope(snapshot, definitions = state.relevanceEnvelope ?? state.graph) {
    return { themes: definitions?.themes ?? [], themeSignals: definitions?.themeSignals ?? [], relevance: snapshot,
      connectors: definitions?.connectors ?? snapshot?.connectors ?? [] };
  }
  async function loadRelevance(lens = state.lens) {
    const ctx = context(); const run = ++relevanceGeneration;
    relevanceController?.abort(); relevanceController = new AbortController();
    const signal = AbortSignal.any([ctx.signal, relevanceController.signal]);
    publish({ lens, evidence: null, workflowMessage: '' });
    if (lens === 'off') return;
    try {
      const snapshot = await request(withSource('/api/relevance', `lens=${encodeURIComponent(lens)}`), {signal}, ctx);
      if (run !== relevanceGeneration) return;
      const value = envelope(snapshot); publish({relevance:snapshot,relevanceEnvelope:value}); return value;
    } catch (error) {
      if (run !== relevanceGeneration || error.name === 'AbortError') return;
      if (authenticatedAccount) publish({workflowMessage:error.message}); throw error;
    }
  }
  async function loadEvidence(themeId) {
    // Local meeting drafts must never be sent through persisted-theme APIs.
    if (typeof themeId === 'string' && themeId.startsWith('meeting-preview:')) return;
    const ctx = context(), run = relevanceGeneration;
    const value = await request(withSource(`/api/themes/${encodeURIComponent(themeId)}/evidence`, `lens=${state.lens === 'off' ? 'my' : state.lens}`), {}, ctx);
    if (run !== relevanceGeneration) return;
    publish({evidence:value}); return value;
  }
  async function previewRetrieval(scope) {
    const ctx = context();
    const run=++retrievalPreviewGeneration;
    retrievalPreviewController?.abort();retrievalPreviewController=new AbortController();
    const signal=AbortSignal.any([ctx.signal,retrievalPreviewController.signal]);
    publish({retrievalPreview:null});
    if (sourceSuffix()) throw Error('Deep Gmail retrieval is unavailable for this local graph: no verified Gmail person mapping exists.');
    if (!scope.personId) throw Error('Select a person before retrieving Gmail context.');
    let account = scope.account;
    if (!account) {
      const accounts = await loadRetrievalAccounts();
      if (accounts.length !== 1) throw Error('Select a mailbox before previewing retrieval.');
      account = accounts[0];
    }
    if(run!==retrievalPreviewGeneration)throw new DOMException('Preview context changed','AbortError');
    const value = await request('/api/retrieval/preview', {body:clean({...scope,account,windowDays:scope.windowDays ?? 30}),signal}, ctx);
    if(run!==retrievalPreviewGeneration)throw new DOMException('Preview context changed','AbortError');
    previews.set(value, {ctx,kind:'retrieval',key:crypto.randomUUID(),previewGeneration:run}); publish({retrievalPreview:value}); return value;
  }
  async function loadRetrievalAccounts() {
    const ctx=context();
    if(sourceSuffix())throw Error('Deep Gmail retrieval is unavailable for this local graph: no verified Gmail person mapping exists.');
    const data=await request('/api/accounts',{},ctx);
    if(data.account!==ctx.account){signedOut('The signed-in account changed. Sign in again.');throw Error('Account context changed.');}
    const accounts=(data.accounts ?? []).map(account=>account.email).filter(email=>typeof email==='string'&&email.includes('@'));
    if(!accounts.length)throw Error('No connected Gmail account is available.');
    return accounts;
  }
  async function draftNote(personId) {
    const ctx = context();
    return request('/api/people/draft', {body:{personId}}, ctx);
  }
  /** "Who can help with…" over the owner's own graph; the server decides the ranking. */
  async function searchNetwork(query) {
    const ctx = context();
    return request('/api/people/search', {body:{query}}, ctx);
  }
  async function previewPublicSource(input) {
    const ctx = context();
    const value = await request(withSource('/api/public-sources/preview'), {body:clean({url:input.url,personId:input.personId})}, ctx);
    previews.set(value, {ctx,kind:'public',key:crypto.randomUUID()}); publish({publicPreview:value}); return value;
  }
  async function confirm(preview, kind, windowDays) {
    const record = previews.get(preview);
    if (!record || record.kind !== kind) throw Error('Preview context is unavailable. Preview again.');
    current(record.ctx);
    if(kind==='retrieval'&&record.previewGeneration!==retrievalPreviewGeneration)throw Error('Preview context changed. Preview again.');
    if (kind === 'retrieval' && windowDays !== preview.windowDays) throw Error('Preview the selected time window before confirming.');
    if (record.result) return record.result;
    if (record.pending) return record.pending;
    const path = kind === 'retrieval' ? '/api/retrieval/confirm' : withSource('/api/public-sources/confirm');
    const body = kind === 'retrieval' ? preview : clean({url:preview.canonicalUrl,personId:preview.personId});
    record.pending = request(path, {body,key:record.key}, record.ctx).then(value => {
      record.result = value; publish({[kind === 'retrieval' ? 'retrievalJob' : 'publicJob']:value}); return value;
    }).finally(() => {record.pending = null;});
    return record.pending;
  }
  async function refreshDefinitions(ctx) {
    const value = await request(withSource('/api/graph'), {}, ctx);
    const next = envelope(value.graph?.relevance, value.graph);
    publish({relevanceEnvelope:next,relevance:next.relevance});
    // /api/graph includes fresh scores for My; a different active lens gets one score refresh.
    if (state.lens !== 'my' && state.lens !== 'off') await loadRelevance(state.lens);
    return state.relevanceEnvelope;
  }
  async function pollJob(id, kind) {
    const accountContext = context(), key = `${kind}:${id}`;
    if (polls.has(key)) return polls.get(key);
    const deadline = AbortSignal.timeout(300000);
    const ctx = {...accountContext,signal:AbortSignal.any([accountContext.signal,deadline])};
    const work = (async () => {
      const started=Date.now();let elapsed = 0, attempt = 0;
      while (elapsed < 300000) {
        const delay = Math.min([1000,2000,4000,8000][attempt++] ?? 15000, 300000-elapsed);
        await sleep(delay,ctx.signal); current(ctx); elapsed += delay;
        const path = kind === 'retrieval' ? `/api/retrieval/${encodeURIComponent(id)}` : withSource(`/api/public-sources/${encodeURIComponent(id)}`);
        const value = await request(path, {}, ctx);
        elapsed=Math.max(elapsed,Date.now()-started);
        if(elapsed>300000)break;
        publish({[kind === 'retrieval' ? 'retrievalJob' : 'publicJob']:value});
        if (value.status === 'failed') throw Error(value.error ?? 'Context processing failed.');
        if (value.status === 'complete') return refreshDefinitions(ctx);
      }
      throw Error('Context processing is taking longer than five minutes. Refresh later.');
    })().catch(error=>{if(deadline.aborted)throw Error('Context processing is taking longer than five minutes. Refresh later.');throw error;})
      .finally(()=>{if(polls.get(key)===work)polls.delete(key);});
    polls.set(key,work); return work;
  }
  async function submitFeedback(input) {
    const ctx = context(); const {themeId,...body} = clean(input);
    await request(withSource(`/api/themes/${encodeURIComponent(themeId)}/feedback`), {body,key:crypto.randomUUID()}, ctx);
    return loadRelevance(state.lens);
  }

  const accountFrom = (data) => typeof data?.account === 'string' && data.account.trim()
    ? data.account.trim().toLocaleLowerCase()
    : null;

  async function load(source = state.source) {
    if (!authenticatedAccount) { signedOut(); return; }
    invalidate();
    const run = generation;
    controller = new AbortController();
    publish({ phase: 'loading', account: authenticatedAccount, graph: null, source, message: '' });
    const path = source === 'obsidian' ? '/api/graph?source=obsidian' : '/api/graph';
    try {
      const response = await fetchImpl(path, { cache: 'no-store', signal: controller.signal });
      if (run !== generation) return;
      if (response.status === 401) { signedOut('Your session expired. Sign in again to continue.'); return; }
      if (!response.ok) throw new Error(`Could not load your graph (${response.status}). Please retry.`);
      const data = await response.json();
      if (run !== generation) return;
      const graphAccount = accountFrom(data);
      if (!graphAccount) throw new Error('The server did not identify the graph owner.');
      if (graphAccount !== authenticatedAccount) throw new Error('The server returned a graph for a different account. The data was hidden.');
      if (!data.graph?.nodes?.length) publish({ phase: 'empty', account: authenticatedAccount, graph: null, source, message: '' });
      else publish({ phase: 'ready', account: authenticatedAccount, graph: data.graph, source, message: '' });
    } catch (error) {
      if (run !== generation || error?.name === 'AbortError') return;
      publish({ phase: 'error', graph: null, message: error instanceof Error ? error.message : 'Could not load your graph.' });
    }
  }

  async function resume(source = state.source) {
    invalidate();
    const run = generation;
    controller = new AbortController();
    publish({ phase: 'connecting', account: null, graph: null, message: '' });
    try {
      const response = await fetchImpl('/api/accounts', { cache: 'no-store', signal: controller.signal });
      if (run !== generation) return;
      if (!response.ok) { signedOut(); return; }
      const data = await response.json();
      if (run !== generation) return;
      authenticatedAccount = accountFrom(data);
      if (!authenticatedAccount) throw new Error('The server did not identify the signed-in account.');
      await load(source);
    } catch (error) {
      if (run !== generation || error?.name === 'AbortError') return;
      publish({ phase: 'error', account: null, graph: null, message: 'Sign-in status is unavailable. Please retry.' });
    }
  }

  async function signIn(idToken) {
    if (typeof idToken !== 'string' || !idToken) throw new Error('A Google identity token is required');
    invalidate();
    const run = generation;
    controller = new AbortController();
    publish({ phase: 'connecting', account: null, graph: null, message: '' });
    try {
      const response = await fetchImpl('/api/session', {
        method: 'POST',
        headers: { authorization: `Bearer ${idToken}`, origin },
        signal: controller.signal,
      });
      if (run !== generation) return;
      if (!response.ok) { signedOut('Could not establish your session. Please sign in again.'); return; }
      const data = await response.json();
      if (run !== generation) return;
      authenticatedAccount = accountFrom(data);
      if (!authenticatedAccount) throw new Error('The server did not identify the signed-in account.');
      await load(state.source);
    } catch (error) {
      if (run !== generation || error?.name === 'AbortError') return;
      signedOut('Could not establish your session. Please sign in again.');
    }
  }

  async function signOut() {
    invalidate();
    authenticatedAccount = null;
    publish({ phase: 'signing-out', account: null, graph: null, message: '' });
    try {
      const response = await fetchImpl('/api/session', { method: 'DELETE', headers: { origin } });
      if (!response.ok) throw new Error(`Sign-out returned ${response.status}`);
      signedOut();
    } catch {
      publish({
        phase: 'sign-out-failed',
        account: null,
        graph: null,
        message: 'Your graph is hidden, but the server did not confirm sign-out. Retry before leaving this device.',
      });
    }
  }

  async function requestPushToken() {
    const expectedAccount = authenticatedAccount;
    const source = state.source;
    const run = generation;
    if (!expectedAccount) return { token: null, message: 'Sign in before generating a private push token.' };
    tokenController?.abort();
    const requestController = new AbortController();
    tokenController = requestController;
    try {
      const response = await fetchImpl('/api/token', { cache: 'no-store', signal: requestController.signal });
      if (run !== generation || expectedAccount !== authenticatedAccount) {
        return { token: null, message: 'The account context changed. Generate the token again.' };
      }
      if (response.status === 401) {
        signedOut('Your session expired. Sign in again before generating a push token.');
        return { token: null, message: 'Your session expired. Sign in again before generating a push token.' };
      }
      if (!response.ok) return { token: null, message: 'A push token could not be generated. Please retry.' };
      const data = await response.json();
      if (run !== generation || expectedAccount !== authenticatedAccount) {
        return { token: null, message: 'The account context changed. Generate the token again.' };
      }
      const tokenAccount = accountFrom({ account: data?.email });
      if (tokenAccount !== expectedAccount) {
        tokenController = null;
        await resume(source);
        return { token: null, message: 'The signed-in account changed. The stale token was discarded and the graph was refreshed.' };
      }
      if (typeof data?.token !== 'string' || !data.token) return { token: null, message: 'A push token could not be generated. Please retry.' };
      return { token: data.token, message: `Token generated for ${expectedAccount}.` };
    } catch (error) {
      if (error?.name === 'AbortError' || run !== generation) return { token: null, message: 'The account context changed. Generate the token again.' };
      return { token: null, message: 'A push token could not be generated. Please retry.' };
    } finally {
      if (tokenController === requestController) tokenController = null;
    }
  }

  return {
    getState: () => ({ ...state }),
    load,
    resume,
    signIn,
    signOut,
    requestPushToken,
    loadRelevance, loadEvidence, loadRetrievalAccounts, previewRetrieval, previewPublicSource, submitFeedback, draftNote, searchNetwork,
    confirmRetrieval: (preview, windowDays = 30) => confirm(preview, 'retrieval', windowDays),
    confirmPublicSource: preview => confirm(preview, 'public'),
    pollRetrieval: id => pollJob(id, 'retrieval'),
    pollPublicSource: id => pollJob(id, 'public'),
    invalidate,
  };
}

async function startBrowserApp() {
  const { mountGraph } = await import('./relationship-graph/graph.mjs');
  const $ = (selector) => document.querySelector(selector);
  const gate = $('#gate');
  const workspace = $('#workspace');
  const accountLabel = $('#account');
  const signin = $('#signin');
  const source = $('#source');
  const status = $('#viewer-status');
  const trailsPanel = $('#session-trails');
  const trailsList = $('#session-trails-list');
  let graphInstance = null;
  let mountedAccount = null;
  let mountedGraph = null;
  let trailOwner = null;
  let signInSetup = null;
  let renderedEnvelope = null;
  let activeDialog = null;
  const sessionTrails = new Map();
  const networkSearch = $('#network-search');
  const networkQuery = $('#network-query');
  const networkStatus = $('#network-search-status');
  const networkResults = $('#network-search-results');
  const networkLabel = $('#network-search-label');
  let networkRun = 0;
  const meetingPreviewButton = document.createElement('button');
  meetingPreviewButton.id = 'meeting-preview';meetingPreviewButton.type = 'button';meetingPreviewButton.textContent = 'Meeting preview';meetingPreviewButton.hidden = true;
  $('#refresh').after(meetingPreviewButton);
  meetingPreviewButton.onclick = openMeetingPreview;

  function closeDialog() { activeDialog?.remove(); activeDialog = null; }
  function dialog(title) {
    closeDialog();
    const element = document.createElement(typeof HTMLDialogElement === 'function' ? 'dialog' : 'section');
    element.className = 'workflow-dialog'; element.setAttribute('role','dialog'); element.setAttribute('aria-label',title);
    element.setAttribute('aria-modal','true'); element.tabIndex = -1;
    const heading = document.createElement('h2'); heading.textContent = title;
    const content = document.createElement('div');
    const message = document.createElement('p'); message.setAttribute('role','status');
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = closeDialog;
    element.append(heading,content,message,cancel); document.body.append(element); activeDialog = element;
    element.addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
    element.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();closeDialog();}
      if(event.key==='Tab'){
        const focusable=[...element.querySelectorAll('button:not(:disabled),input,select')];
        const first=focusable[0],last=focusable.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    });
    element.showModal?.(); element.focus();
    // Some dialogs only learn their real title once the server answers (an intro request, say),
    // so the title stays changeable: aria-label and the heading always move together.
    const retitle=next=>{element.setAttribute('aria-label',next);heading.textContent=next;};
    return {element,content,message,cancel,retitle};
  }
  function paragraph(parent,text) { const p=document.createElement('p');p.textContent=text;parent.append(p);return p; }
  function action(parent,label,handler) { const button=document.createElement('button');button.type='button';button.textContent=label;button.onclick=handler;parent.append(button);return button; }
  function errorMessage(error) { if(error.name!=='AbortError')status.textContent=error.message; }
  function openMeetingPreview() {
    if (!graphInstance || !mountedAccount) return;
    const instance = graphInstance, account = mountedAccount;
    const view = dialog('Private meeting preview');
    paragraph(view.content,'Load a reviewed batch of up to 5 Granola notes. The file is read locally in this tab, not uploaded to the server. It must belong to the signed-in graph account.');
    paragraph(view.content,'This is a manual distillation preview, not automatic Granola sync. Refresh, source changes, and sign-out clear the preview and review choices. Original notes and graph data are unchanged.');
    const input = document.createElement('input');input.type = 'file';input.accept = '.json,application/json';input.setAttribute('aria-label','Reviewed meeting batch');view.content.append(input);
    const load = action(view.content,'Load private preview',async()=>{
      const file = input.files?.[0];if (!file) {view.message.textContent='Choose a reviewed meeting batch first.';return;}
      if (file.size > 100_000) {view.message.textContent='Meeting preview file is too large.';return;}
      if (controller.getState().lens !== 'my') {view.message.textContent='Switch Relevance now to My mind before loading this private preview.';return;}
      load.disabled = true;input.disabled = true;
      try {
        const contents = await file.text();
        if (!view.element.isConnected || instance !== graphInstance || account !== mountedAccount) return;
        instance.setMeetingPreview(contents);closeDialog();status.textContent='Private Granola preview loaded · this tab only · no automatic actions';
      } catch(error) {if (view.element.isConnected) view.message.textContent=error.message;}
      finally {load.disabled = false;input.disabled = false;}
    });
  }
  async function openRetrieval(scope) {
    const view=dialog('Retrieve more context');
    const person=mountedGraph?.nodes.find(node=>node.id===scope.personId);
    paragraph(view.content,`Person: ${person?.name ?? 'Select a person'} · Theme: ${scope.themeId ?? 'All themes'}`);
    paragraph(view.content,'50 messages maximum · 1 MB maximum. Bodies are analyzed ephemerally and not retained.');
    const mailboxLabel=document.createElement('label');mailboxLabel.textContent='Mailbox';
    const mailbox=document.createElement('select');mailbox.setAttribute('aria-label','Mailbox');mailbox.disabled=true;
    mailboxLabel.append(mailbox);view.content.append(mailboxLabel);
    const label=document.createElement('label');label.textContent='Time window';
    const select=document.createElement('select');select.setAttribute('aria-label','Time window');
    for(const days of [30,90]){const option=document.createElement('option');option.value=String(days);option.textContent=`${days} days`;select.append(option);}
    label.append(select);view.content.append(label);
    const account=paragraph(view.content,'Preparing preview…');let preview,version=0;
    const confirm=action(view.content,'Confirm retrieval',async()=>{
      confirm.disabled=true;mailbox.disabled=true;select.disabled=true;
      try {
        const job=await controller.confirmRetrieval(preview,Number(select.value));
        if(!view.element.isConnected)return;
        view.message.textContent='Retrieval queued…';
        await controller.pollRetrieval(job.id);
        if(!view.element.isConnected)return;
        closeDialog();status.textContent='Retrieval complete. Relevance updated.';
      }catch(error){if(view.element.isConnected){view.message.textContent=error.message;confirm.disabled=!preview;mailbox.disabled=false;select.disabled=false;}}
    });confirm.disabled=true;select.disabled=true;
    const update=async()=>{
      const run=++version;confirm.disabled=true;preview=null;view.message.textContent='';account.textContent='Preparing preview…';
      try{const value=await controller.previewRetrieval({...scope,account:mailbox.value,windowDays:Number(select.value)});if(!view.element.isConnected||run!==version)return;preview=value;account.textContent=`Account: ${preview.account}`;confirm.disabled=false;}
      catch(error){if(view.element.isConnected&&run===version)view.message.textContent=error.message;}
    };
    select.onchange=mailbox.onchange=()=>void update();
    try{
      const accounts=await controller.loadRetrievalAccounts();if(!view.element.isConnected)return;
      for(const email of accounts){const option=document.createElement('option');option.value=email;option.textContent=email;mailbox.append(option);}
      if(scope.account&&accounts.includes(scope.account))mailbox.value=scope.account;
      mailbox.disabled=false;select.disabled=false;await update();
    }catch(error){if(view.element.isConnected)view.message.textContent=error.message;}
  }
  function openPublicSource(scope) {
    const view=dialog('Add public source');
    paragraph(view.content,`Account: ${controller.getState().account} · Visibility: Public`);
    const label=document.createElement('label');label.textContent='Public URL';
    const input=document.createElement('input');input.type='url';input.setAttribute('aria-label','Public URL');label.append(input);view.content.append(label);
    const details=paragraph(view.content,'Preview a public page or feed before adding it.');let preview;
    const confirm=action(view.content,'Confirm public source',async()=>{
      confirm.disabled=true;
      try{
        const job=await controller.confirmPublicSource(preview);
        if(!view.element.isConnected)return;
        view.message.textContent='Public source queued…';
        await controller.pollPublicSource(job.id);
        if(!view.element.isConnected)return;
        closeDialog();status.textContent=`Public source complete · ${preview.canonicalUrl} · Public`;
      }catch(error){if(view.element.isConnected){view.message.textContent=error.message;confirm.disabled=false;}}
    });confirm.hidden=true;
    input.oninput=()=>{preview=null;confirm.hidden=true;};
    action(view.content,'Preview source',async()=>{
      confirm.hidden=true;const url=input.value;
      try{const value=await controller.previewPublicSource({url,personId:scope.personId});if(!view.element.isConnected||url!==input.value)return;preview=value;details.textContent=`${preview.canonicalUrl} · ${preview.contentType ?? 'Content type checked during fetch'} · Visibility: Public`;confirm.hidden=false;confirm.disabled=false;}
      catch(error){if(view.element.isConnected)view.message.textContent=error.message;}
    });input.focus();
  }

  /** The draft is model-written, labelled, editable, and never sent by this app. */
  async function openDraftNote(personId) {
    const view=dialog('Draft a note');
    const person=mountedGraph?.nodes.find(node=>node.id===personId);
    const intro=paragraph(view.content,`Draft for ${person?.name ?? 'this person'} \u00b7 written from your own evidence \u00b7 review and edit it before sending`);
    paragraph(view.content,'Nothing is sent until you send it from your mail client.');
    view.message.textContent='Writing a draft\u2026';
    let draft;
    try{draft=await controller.draftNote(personId);}
    catch(error){
      if(!view.element.isConnected)return;
      // request() throws a generic "Context request failed (503)." for every non-OK
      // response; when it also carried the server's own message (see request()), show
      // that instead so a drafting failure reads as something the owner can act on.
      view.message.textContent=error.status?(error.serverMessage||'Could not draft a note right now. Try again in a moment.'):error.message;
      return;
    }
    if(!view.element.isConnected)return;
    view.message.textContent='';
    // A person the owner only knows through a share has no address here: the server drafts an
    // intro request to the owner who shared them, so the dialog has to say who it is written to.
    const introVia=typeof draft.introVia==='string'&&draft.introVia.trim().length<=320?draft.introVia.trim():'';
    if(introVia){
      view.retitle(`Intro request to ${introVia}`);
      intro.textContent=`${introVia} shared ${draft.name||'this person'} with you. This draft asks ${introVia} for an introduction; it is not a note to ${draft.name||'them'}.`;
    }
    paragraph(view.content,'Based on:');
    const list=document.createElement('ul');
    for(const item of draft.basedOn ?? []){
      const entry=document.createElement('li');
      entry.textContent=[item.summary,item.title,String(item.observedAt ?? '').slice(0,10)].filter(Boolean).join(' \u00b7 ');
      list.append(entry);
    }
    view.content.append(list);
    if (draft.checked) {
      if (draft.warnings?.length) {
        const warnings = document.createElement('ul');
        for (const warning of draft.warnings) { const entry = document.createElement('li'); entry.textContent = warning; warnings.append(entry); }
        view.content.append(warnings);
      } else {
        paragraph(view.content, 'Checked against your notes.');
      }
    }
    const subjectLabel=document.createElement('label');subjectLabel.textContent='Subject';
    const subject=document.createElement('input');subject.type='text';subject.setAttribute('aria-label','Subject');subject.value=draft.subject;
    subjectLabel.append(subject);
    const bodyLabel=document.createElement('label');bodyLabel.textContent='Draft body';
    const body=document.createElement('textarea');body.setAttribute('aria-label','Draft body');body.rows=10;body.value=draft.body;
    bodyLabel.append(body);
    view.content.append(subjectLabel,bodyLabel);
    action(view.content,'Copy',async()=>{
      try{await navigator.clipboard.writeText(`${subject.value}\n\n${body.value}`);view.message.textContent='Copied';}
      catch{view.message.textContent='Copy failed. Select the draft and copy it yourself.';}
    });
    if(draft.to&&MAILTO_SAFE.test(draft.to)){
      const mail=document.createElement('a');mail.textContent='Open in email \u2197';mail.rel='noopener';
      const rebuild=()=>{mail.href=`mailto:${draft.to}?subject=${encodeURIComponent(subject.value)}&body=${encodeURIComponent(body.value)}`;};
      rebuild();subject.oninput=body.oninput=rebuild;view.content.append(mail);
    }
    subject.focus();
  }

  /**
   * Search my network. The field sits above the graph; the server ranks the owner's own people
   * (with Jev when it is configured) and every line here is set with textContent. Choosing a
   * result hands the person to the graph's own node selection and closes the list.
   */
  function clearNetworkSearch({ input = true } = {}) {
    networkRun += 1;
    if (input) networkQuery.value = '';
    networkStatus.textContent = '';
    networkLabel.textContent = '';
    networkResults.replaceChildren();
    networkResults.hidden = true;
  }
  function networkResultButton(person) {
    const choose = document.createElement('button'); choose.type = 'button';
    const name = document.createElement('strong'); name.textContent = person.name || 'Unnamed person';
    const meta = document.createElement('small');
    meta.textContent = [person.company, `${Math.round(Math.max(0, Math.min(1, Number(person.score) || 0)) * 100)}% match`,
      person.lastContact ? `Last contact ${String(person.lastContact).slice(0,10)}` : null].filter(Boolean).join(' \u00b7 ');
    choose.append(name, meta);
    for (const reason of person.reasons ?? []) {
      const line = document.createElement('small');
      line.textContent = [reason.summary, reason.title, String(reason.observedAt ?? '').slice(0,10)].filter(Boolean).join(' \u00b7 ');
      choose.append(line);
    }
    choose.onclick = () => {
      // Reuse the graph's own selection path, so the trail, camera and panel behave exactly as
      // they do for a click on the canvas. A person who is not on this view is never selected.
      if (!graphInstance || !mountedGraph?.nodes.some(node => node.id === person.personId)) {
        networkStatus.textContent = `${person.name || 'That person'} is not on this view of the graph.`;
        return;
      }
      graphInstance.select(person.personId);
      clearNetworkSearch();
    };
    return choose;
  }
  async function runNetworkSearch() {
    const query = networkQuery.value.trim();
    if (!query) { clearNetworkSearch({ input: false }); return; }
    const run = ++networkRun;
    networkResults.replaceChildren(); networkResults.hidden = true; networkLabel.textContent = '';
    networkStatus.textContent = 'Searching\u2026';
    let value;
    try { value = await controller.searchNetwork(query); }
    catch (error) {
      if (run !== networkRun) return;
      // request() throws generic "Context request failed (503)." copy; prefer the server's own
      // message when it sent one, exactly as the draft dialog does.
      networkStatus.textContent = error.name === 'AbortError' ? ''
        : error.status ? (error.serverMessage || 'Could not search your network right now. Try again in a moment.') : error.message;
      return;
    }
    if (run !== networkRun) return;
    const results = Array.isArray(value.results) ? value.results : [];
    networkStatus.textContent = results.length
      ? `${results.length} ${results.length === 1 ? 'person' : 'people'} in your network`
      : 'No one in your network matches yet.';
    networkLabel.textContent = value.checked ? 'Ranked by Jev' : 'Keyword match only';
    if (!results.length) return;
    for (const person of results) { const item = document.createElement('li'); item.append(networkResultButton(person)); networkResults.append(item); }
    networkResults.hidden = false;
  }

  function setAuthenticatedControls(visible) {
    for (const id of ['source-wrap', 'refresh', 'setup', 'signout', 'meeting-preview']) $(`#${id}`).hidden = !visible;
    signin.hidden = visible;
  }

  function showGate(title, message, action) {
    workspace.hidden = true;
    gate.hidden = false;
    gate.replaceChildren();
    const eyebrow = document.createElement('p'); eyebrow.className = 'eyebrow'; eyebrow.textContent = 'PRIVATE RELATIONSHIP INTELLIGENCE';
    const heading = document.createElement('h1'); heading.textContent = title;
    gate.append(eyebrow, heading);
    if (message) { const copy = document.createElement('p'); copy.textContent = message; gate.append(copy); }
    if (action) gate.append(action);
  }

  function graphSourceLabel(graph) {
    const sourceName = graph?.source === 'email_accounts' ? 'Email metadata and automatic scores' : 'Recorded graph snapshot';
    const updated = graph?.pushedAt ? new Date(graph.pushedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'date not included';
    return `${sourceName} · ${updated}`;
  }

  function saveBrowserTrail(trail) {
    if (!mountedAccount) return;
    if (trailOwner && trailOwner !== mountedAccount) clearSessionTrails();
    trailOwner = mountedAccount;
    const nodes = new Map((mountedGraph?.nodes ?? []).map((node) => [node.id, node]));
    const title = trail.nodeIds.map((id) => nodes.get(id)?.name ?? 'Unavailable').join(' → ');
    const current = sessionTrails.get(mountedAccount) ?? [];
    sessionTrails.set(mountedAccount, [{ trail, title }, ...current].slice(0, 20));
    renderSessionTrails();
    status.textContent = `Saved this exact path for this session for ${mountedAccount}. Use BetaworksOS to keep, title, and share trails.`;
  }

  function clearSessionTrails() {
    sessionTrails.clear();
    trailOwner = null;
    trailsList.replaceChildren();
    trailsPanel.hidden = true;
  }

  function renderSessionTrails() {
    trailsList.replaceChildren();
    const items = mountedAccount === trailOwner ? sessionTrails.get(mountedAccount) ?? [] : [];
    for (const item of items) {
      const restore = document.createElement('button'); restore.type = 'button'; restore.textContent = item.title; restore.setAttribute('aria-label', `Restore ${item.title}`);
      restore.onclick = () => {
        try { graphInstance?.restoreTrail(item.trail); }
        catch { status.textContent = 'That session path is no longer available in the refreshed graph.'; }
      };
      trailsList.append(restore);
    }
    trailsPanel.hidden = items.length === 0;
  }

  async function installSignIn(message) {
    if (message) status.textContent = message;
    if (signInSetup) return signInSetup;
    signInSetup = (async () => {
      const response = await fetch('/api/config', { cache: 'no-store' });
      if (!response.ok) throw new Error('Sign-in configuration is unavailable.');
      const config = await response.json();
      if (!config.googleClientId) throw new Error('Google sign-in is not configured.');
      const started = Date.now();
      while (!window.google?.accounts?.id && Date.now() - started < 10_000) await new Promise((resolve) => setTimeout(resolve, 100));
      if (!window.google?.accounts?.id) throw new Error('Google sign-in could not load. Check your connection or content blocker.');
      window.google.accounts.id.initialize({ client_id: config.googleClientId, callback: (result) => void controller.signIn(result.credential) });
      signin.replaceChildren();
      window.google.accounts.id.renderButton(signin, { theme: 'outline', size: 'medium' });
    })().catch((error) => {
      signInSetup = null;
      status.textContent = error instanceof Error ? error.message : 'Sign-in is unavailable.';
    });
    return signInSetup;
  }

  function mountAuthorizedGraph(state) {
    gate.hidden = true;
    workspace.hidden = false;
    if (mountedAccount !== state.account) {
      if (trailOwner && trailOwner !== state.account) clearSessionTrails();
      graphInstance?.destroy();
      graphInstance = null;
      $('#graph').replaceChildren();
      mountedAccount = state.account;
      clearNetworkSearch();
    }
    if (!graphInstance) graphInstance = mountGraph($('#graph'), { graph: state.graph, title: 'People relationships', previewAccount: state.account, onSaveTrail: saveBrowserTrail,
      onLensChange: lens => controller.loadRelevance(lens), onThemeFeedback: input => controller.submitFeedback(input),
      onRetrievePreview: scope => openRetrieval(scope), onOpenPublicSource: scope => openPublicSource(scope),
      onDraftNote: personId => openDraftNote(personId) });
    else if (mountedGraph !== state.graph) graphInstance.setGraph(state.graph);
    mountedGraph = state.graph;
    if(state.relevanceEnvelope && renderedEnvelope !== state.relevanceEnvelope){renderedEnvelope=state.relevanceEnvelope;graphInstance.setRelevance(renderedEnvelope,state.lens);}
    renderSessionTrails();
    status.textContent = state.workflowMessage || (state.retrievalJob?.status === 'running' ? `Retrieving context · ${state.retrievalJob.processed ?? 0} messages processed` : graphSourceLabel(state.graph));
  }

  function render(state) {
    if(state.phase!=='ready'){closeDialog();clearNetworkSearch();renderedEnvelope=null;}
    source.value = state.source;
    if (state.phase === 'ready') {
      accountLabel.textContent = state.account;
      setAuthenticatedControls(true);
      mountAuthorizedGraph(state);
      return;
    }
    if (state.phase === 'empty') {
      if (trailOwner && trailOwner !== state.account) clearSessionTrails();
      graphInstance?.destroy(); graphInstance = null; mountedAccount = state.account;
      mountedGraph = null;
      accountLabel.textContent = state.account;
      setAuthenticatedControls(true);
      renderSessionTrails();
      const accounts = document.createElement('a'); accounts.className = 'primary-action'; accounts.href = '/accounts.html'; accounts.textContent = 'Connect email accounts ↗';
      showGate('Your graph is ready for its first source.', 'Connect an email account to build from message metadata, or connect the existing Obsidian graph snapshot.', accounts);
      return;
    }
    graphInstance?.destroy(); graphInstance = null; mountedAccount = null; mountedGraph = null;
    trailsPanel.hidden = true;
    accountLabel.textContent = 'YOUR PRIVATE NETWORK';
    if (['signed-out', 'signing-out', 'sign-out-failed'].includes(state.phase)) clearSessionTrails();
    if (state.phase === 'signed-out') {
      setAuthenticatedControls(false);
      showGate('Your relationships, in context.', state.message);
      void installSignIn(state.message);
    } else if (state.phase === 'sign-out-failed') {
      setAuthenticatedControls(false);
      signin.hidden = true;
      const retry = document.createElement('button'); retry.className = 'primary-action'; retry.type = 'button'; retry.textContent = 'Retry sign out ↗'; retry.onclick = () => void controller.signOut();
      showGate('Sign-out could not be confirmed.', state.message, retry);
    } else if (state.phase === 'error') {
      setAuthenticatedControls(Boolean(state.account));
      const retry = document.createElement('button'); retry.className = 'primary-action'; retry.type = 'button'; retry.textContent = 'Retry ↗'; retry.onclick = () => void (state.account ? controller.load(state.source) : controller.resume(state.source));
      showGate('We couldn’t load your graph.', state.message, retry);
    } else {
      setAuthenticatedControls(false);
      if (state.phase === 'signing-out') signin.hidden = true;
      showGate(state.phase === 'loading' ? 'Loading your private graph…' : state.phase === 'signing-out' ? 'Signing out…' : 'Checking your session…', 'Only records authorized for the signed-in account will appear.');
    }
  }

  const initialSource = new URLSearchParams(location.search).get('source') === 'obsidian' ? 'obsidian' : 'best';
  const controller = createRelationshipController({ onState: render });
  $('#graph').addEventListener('click',event=>{
    const target=event.target.closest('[data-action="inspect-theme"]');
    if(target)void controller.loadEvidence(target.dataset.themeId).catch(errorMessage);
  });
  source.value = initialSource;
  source.onchange = () => {
    const chosen = source.value === 'obsidian' ? 'obsidian' : 'best';
    const url = new URL(location.href);
    if (chosen === 'obsidian') url.searchParams.set('source', 'obsidian'); else url.searchParams.delete('source');
    history.replaceState(null, '', url);
    void controller.load(chosen);
  };
  networkSearch.addEventListener('submit', event => { event.preventDefault(); void runNetworkSearch(); });
  networkSearch.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); clearNetworkSearch(); networkQuery.focus(); } });
  $('#network-clear').onclick = () => { clearNetworkSearch(); networkQuery.focus(); };
  $('#refresh').onclick = () => void controller.load(source.value);
  $('#signout').onclick = async () => { window.google?.accounts?.id?.disableAutoSelect?.(); signInSetup = null; signin.replaceChildren(); await controller.signOut(); };
  $('#setup').onclick = async () => {
    showGate('Connect the Obsidian Gmail CRM.', 'Generate a private push token here, then paste this site URL and token into the plugin’s Graph push settings.');
    const actions = document.createElement('div'); actions.className = 'gate-actions';
    const tokenButton = document.createElement('button'); tokenButton.type = 'button'; tokenButton.textContent = 'Generate private push token';
    const back = document.createElement('button'); back.type = 'button'; back.textContent = 'Back to graph';
    const output = document.createElement('textarea'); output.hidden = true; output.readOnly = true; output.setAttribute('aria-label', 'Private graph push token');
    tokenButton.onclick = async () => {
      output.value = ''; output.hidden = true;
      const result = await controller.requestPushToken();
      if (!result.token) { status.textContent = result.message; return; }
      output.value = result.token; output.hidden = false; output.focus(); output.select();
      status.textContent = 'Token shown once here. Keep it private; it can replace this account’s graph snapshot.';
    };
    back.onclick = () => void controller.load(source.value);
    actions.append(tokenButton, back, output); gate.append(actions);
  };
  await controller.resume(initialSource);
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  startBrowserApp().catch((error) => {
    const gate = document.querySelector('#gate');
    if (gate) gate.textContent = error instanceof Error ? error.message : 'The relationship viewer could not start.';
  });
}
