import type { components } from './openapi.generated.js';
import { decodeRunEvents, readUtf8Stream, StreamProtocolError, validCursor } from './sse.js';

type Schemas = components['schemas'];
type AccountSession = Schemas['AccountSession'];
type Credentials = { token: string; userId: string; workspaceId: string };
type RunEvent = Schemas['RunEvent'];

const API_PREFIX = '/api/assistant/v1';

export interface AssistantClientOptions {
  origin: string;
  fetch?: typeof fetch;
  readStream?: (response: Response) => AsyncIterable<string>;
  clearAccountData?: () => void | Promise<void>;
}

export interface PageQuery {
  cursor?: string;
  limit?: number;
}

export interface ConversationQuery extends PageQuery {
  q?: string;
  archived?: boolean;
  projectId?: string;
  unfiled?: boolean;
}

export class AssistantApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AssistantApiError';
  }
}

async function checkResponse(response: Response): Promise<void> {
  if (response.ok) return;
  const body: unknown = await response.json().catch(() => undefined);
  if (typeof body === 'object' && body && 'code' in body && 'message' in body) {
    if (typeof body.code === 'string' && typeof body.message === 'string') {
      throw new AssistantApiError(response.status, body.code, body.message);
    }
  }
  throw new AssistantApiError(response.status, 'HTTP_ERROR', 'The service returned an unexpected error response');
}

function pathId(value: string): string {
  if (!value || value === '.' || value === '..') throw new TypeError('Invalid resource ID');
  return encodeURIComponent(value);
}

function memoryPath(projectId?: string): string {
  return projectId === undefined ? '/memory' : `/projects/${pathId(projectId)}/memory`;
}

function artifactMediaType(format: Schemas['ArtifactFormat']): string {
  if (format === 'sheet') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (format === 'slides') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (format === 'webpage') return 'text/html';
  return format === 'markdown' ? 'text/markdown' : 'text/plain';
}

const sandboxConnector = '/automations/sandbox-connector';
const sandboxEventReminders = '/automations/event-reminders';
const syntheticCatalogue = '/commerce/catalogue';
const currentOrganization = '/organizations/current';
const proactiveAssistant = '/automations/proactive';
const catalogItems = '/catalog/items';
const catalogAuthor = '/catalog/author';
const desktopCompanion = '/desktop-companion';

function queryString(query: PageQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

function ensureActive(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('The request was cancelled');
  error.name = 'AbortError';
  throw error;
}

function linkAbortSignals(accountSignal: AbortSignal, requestSignal?: AbortSignal) {
  if (!requestSignal) return { signal: accountSignal, dispose() {} };

  const controller = new AbortController();
  const abort = () => controller.abort();
  accountSignal.addEventListener('abort', abort, { once: true });
  requestSignal.addEventListener('abort', abort, { once: true });
  if (accountSignal.aborted || requestSignal.aborted) abort();

  return {
    signal: controller.signal,
    dispose() {
      accountSignal.removeEventListener('abort', abort);
      requestSignal.removeEventListener('abort', abort);
    },
  };
}

export class AssistantClient {
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  private readonly readStream: NonNullable<AssistantClientOptions['readStream']>;
  private readonly clearAccountData: AssistantClientOptions['clearAccountData'];
  private accountController = new AbortController();
  private accountCleanup = Promise.resolve();
  private credentials?: Credentials;

  constructor(options: AssistantClientOptions) {
    const origin = new URL(options.origin);
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash ||
      origin.username ||
      origin.password
    ) {
      throw new TypeError('An HTTP(S) API origin is required');
    }
    this.origin = origin.origin;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.readStream = options.readStream ?? readUtf8Stream;
    this.clearAccountData = options.clearAccountData;
  }

  async replaceSession(session: AccountSession | null): Promise<void> {
    await this.activate(session ? { token: session.accessToken, userId: session.user.id, workspaceId: session.user.workspaceId } : undefined);
  }

  private async activate(next?: Credentials): Promise<void> {
    this.accountController.abort();
    const controller = new AbortController();
    this.accountController = controller;
    this.credentials = undefined;
    const cleanup = this.accountCleanup.catch(() => undefined).then(() => this.clearAccountData?.());
    this.accountCleanup = cleanup;
    await cleanup;
    ensureActive(controller.signal);
    this.credentials = next;
  }

  register(input: Schemas['Registration']): Promise<AccountSession> {
    return this.send('POST', '/auth/register', input, { guest: true });
  }

  login(input: Schemas['Login']): Promise<AccountSession> {
    return this.send('POST', '/auth/login', input, { guest: true });
  }

  getAccount(): Promise<Schemas['User']> {
    return this.send('GET', '/auth/me');
  }

  listWorkspaces(query: PageQuery = {}): Promise<Schemas['WorkspacePage']> {
    return this.send('GET', `/auth/workspaces${queryString(query)}`, undefined, { workspace: null });
  }

  previewWorkspaceDeparture(workspaceId: string, signal?: AbortSignal): Promise<Schemas['WorkspaceDeparturePreview']> {
    return this.send('GET', `/auth/workspaces/${pathId(workspaceId)}/leave-preview`, undefined, { workspace: null, signal });
  }

  leaveWorkspace(workspaceId: string, input: Schemas['WorkspaceDeparture'], signal?: AbortSignal): Promise<void> {
    return this.send('POST', `/auth/workspaces/${pathId(workspaceId)}/leave`, input, { workspace: null, signal });
  }

  switchWorkspace(workspaceId: string): Promise<Schemas['User']> {
    return this.selectWorkspace(workspaceId);
  }

  returnToPersonalWorkspace(): Promise<Schemas['User']> {
    return this.selectWorkspace(null);
  }

  private async selectWorkspace(workspaceId: string | null): Promise<Schemas['User']> {
    const current = this.credentials;
    if (!current) throw new AssistantApiError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    const signal = this.accountController.signal;
    const user = await this.send<Schemas['User']>('GET', '/auth/me', undefined, { workspace: workspaceId });
    ensureActive(signal);
    if (user.id !== current.userId || (workspaceId !== null && user.workspaceId !== workspaceId)) {
      throw new AssistantApiError(409, 'CONFLICT', 'The service did not confirm the selected workspace');
    }
    if (current.workspaceId !== user.workspaceId) await this.activate({ ...current, workspaceId: user.workspaceId });
    return user;
  }

  updatePreferences(input: Schemas['PreferencesPatch']): Promise<Schemas['User']> {
    return this.send('PATCH', '/auth/me/preferences', input);
  }

  listDevices(): Promise<Schemas['DeviceSession'][]> {
    return this.send('GET', '/auth/devices');
  }

  revokeDevice(deviceId: string): Promise<void> {
    return this.send('DELETE', `/auth/devices/${pathId(deviceId)}`);
  }

  async logout(): Promise<void> {
    const active = this.accountController;
    await this.send<void>('POST', '/auth/logout', undefined, { workspace: null });
    if (active === this.accountController) await this.replaceSession(null);
  }

  getCapabilities(signal?: AbortSignal): Promise<Schemas['Capabilities']> {
    return this.send('GET', '/capabilities', undefined, { signal });
  }

  replyToTemporaryChat(content: string, signal?: AbortSignal): Promise<Schemas['TemporaryChatReply']> {
    return this.send('POST', '/temporary-chat', { content }, { signal });
  }

  getMemorySettings(projectId?: string, signal?: AbortSignal): Promise<Schemas['PersonalMemorySettings'] | Schemas['ProjectMemorySettings']> {
    return this.send('GET', memoryPath(projectId) + '/settings', undefined, { signal });
  }

  updateMemorySettings(
    patch: Schemas['PersonalMemorySettingsPatch'],
    projectId?: string,
    signal?: AbortSignal,
  ): Promise<Schemas['PersonalMemorySettings'] | Schemas['ProjectMemorySettings']> {
    return this.send('PATCH', memoryPath(projectId) + '/settings', patch, { signal });
  }

  listMemories(projectId?: string, query: PageQuery = {}, signal?: AbortSignal): Promise<Schemas['ManualMemoryPage']> {
    return this.send('GET', memoryPath(projectId) + '/entries' + queryString(query), undefined, { signal });
  }

  createMemory(content: string, projectId?: string, signal?: AbortSignal): Promise<Schemas['ManualMemory']> {
    return this.send('POST', memoryPath(projectId) + '/entries', { content }, { signal });
  }

  getMemory(entryId: string, projectId?: string, signal?: AbortSignal): Promise<Schemas['ManualMemory']> {
    return this.send('GET', memoryPath(projectId) + '/entries/' + pathId(entryId), undefined, { signal });
  }

  replaceMemory(entryId: string, content: string, projectId?: string, signal?: AbortSignal): Promise<Schemas['ManualMemory']> {
    return this.send('PATCH', memoryPath(projectId) + '/entries/' + pathId(entryId), { content }, { signal });
  }

  deleteMemory(entryId: string, projectId?: string, signal?: AbortSignal): Promise<void> {
    return this.send('DELETE', memoryPath(projectId) + '/entries/' + pathId(entryId), undefined, { signal });
  }

  listModels(): Promise<Schemas['ModelCatalog']> {
    return this.send('GET', '/models');
  }

  retrieveAnswer(query: string): Promise<Schemas['RetrievalAnswer']> {
    return this.send('POST', '/retrieval/answers', { query });
  }

  getRetrievalAnswer(answerId: string): Promise<Schemas['RetrievalAnswer']> {
    return this.send('GET', `/retrieval/answers/${pathId(answerId)}`);
  }

  listArtifacts(query: PageQuery & { projectId?: string } = {}, signal?: AbortSignal): Promise<Schemas['ArtifactPage']> {
    return this.send('GET', `/artifacts${queryString(query)}`, undefined, { signal });
  }

  createArtifact(input: Schemas['ArtifactCreate'], idempotencyKey: string, signal?: AbortSignal): Promise<Schemas['Artifact']> {
    return this.send('POST', '/artifacts', input, { headers: { 'Idempotency-Key': idempotencyKey }, signal });
  }

  getArtifact(id: string, signal?: AbortSignal): Promise<Schemas['Artifact']> {
    return this.send('GET', `/artifacts/${pathId(id)}`, undefined, { signal });
  }

  listArtifactVersions(id: string, query: PageQuery = {}, signal?: AbortSignal): Promise<Schemas['ArtifactVersionPage']> {
    return this.send('GET', `/artifacts/${pathId(id)}/versions${queryString(query)}`, undefined, { signal });
  }

  getArtifactVersion(id: string, versionId: string, signal?: AbortSignal): Promise<Schemas['ArtifactVersion']> {
    return this.send('GET', `/artifacts/${pathId(id)}/versions/${pathId(versionId)}`, undefined, { signal });
  }

  createArtifactVersion(id: string, input: Schemas['ArtifactVersionWrite'], signal?: AbortSignal): Promise<Schemas['Artifact']> {
    return this.send('POST', `/artifacts/${pathId(id)}/versions`, input, { signal });
  }

  rollbackArtifact(id: string, input: Schemas['ArtifactRollback'], signal?: AbortSignal): Promise<Schemas['Artifact']> {
    return this.send('POST', `/artifacts/${pathId(id)}/rollback`, input, { signal });
  }

  downloadArtifactVersion(id: string, versionId: string, format: Schemas['ArtifactFormat'], signal?: AbortSignal): Promise<Blob> {
    const path = `/artifacts/${pathId(id)}/versions/${pathId(versionId)}`;
    if (format === 'image') return this.downloadGrantedAttachment(path, 'image/png', signal);
    return this.downloadArtifact(`${path}/download`, artifactMediaType(format), undefined, signal);
  }

  previewWebpageArtifact(id: string, versionId: string, signal?: AbortSignal): Promise<Blob> {
    return this.downloadArtifact(`/artifacts/${pathId(id)}/versions/${pathId(versionId)}/preview`, 'text/html', undefined, signal);
  }

  getHostedSite(projectId: string, artifactId: string, signal?: AbortSignal): Promise<Schemas['HostedSiteStatus']> {
    return this.send('GET', `/projects/${pathId(projectId)}/artifacts/${pathId(artifactId)}/hosting`, undefined, { signal });
  }

  previewHostedSite(projectId: string, artifactId: string, versionId: string,
    signal?: AbortSignal): Promise<Schemas['HostedSitePreview']> {
    return this.send('GET', `/projects/${pathId(projectId)}/artifacts/${pathId(artifactId)}/hosting/preview/${pathId(versionId)}`, undefined, { signal });
  }

  publishHostedSite(projectId: string, artifactId: string, input: Schemas['HostedSiteWrite'],
    signal?: AbortSignal): Promise<Schemas['HostedSiteRelease']> {
    return this.send('PUT', `/projects/${pathId(projectId)}/artifacts/${pathId(artifactId)}/hosting`, input, { signal });
  }

  revokeHostedSite(projectId: string, artifactId: string, revision: string, signal?: AbortSignal): Promise<void> {
    return this.send('DELETE', `/projects/${pathId(projectId)}/artifacts/${pathId(artifactId)}/hosting/${pathId(revision)}`, undefined, { signal });
  }

  deleteArtifact(id: string, signal?: AbortSignal): Promise<void> {
    return this.send('DELETE', `/artifacts/${pathId(id)}`, undefined, { signal });
  }

  listReviewedCatalog(query: PageQuery & { kind?: Schemas['ReviewedCatalogKind'] } = {},
    signal?: AbortSignal): Promise<Schemas['ReviewedCatalogPage']> {
    return this.send('GET', catalogItems + queryString(query), undefined, { signal });
  }

  getReviewedCatalogItem(id: string, signal?: AbortSignal): Promise<Schemas['ReviewedCatalogItem']> {
    return this.send('GET', `${catalogItems}/${pathId(id)}`, undefined, { signal });
  }

  reportReviewedCatalogItem(id: string, input: Schemas['ReviewedCatalogReportWrite'],
    signal?: AbortSignal): Promise<Schemas['ReviewedCatalogReport']> {
    return this.send('POST', `${catalogItems}/${pathId(id)}/reports`, input, { signal });
  }

  previewCatalogRelease(input: Schemas['CatalogReleaseSource'],
    signal?: AbortSignal): Promise<Schemas['CatalogReleasePreview']> {
    return this.send('POST', `${catalogAuthor}/preview`, input, { signal });
  }

  listCatalogAuthorReleases(query: PageQuery = {}, signal?: AbortSignal): Promise<Schemas['CatalogReleasePage']> {
    return this.send('GET', `${catalogAuthor}/releases${queryString(query)}`, undefined, { signal });
  }

  submitCatalogRelease(input: Schemas['CatalogReleaseWrite'], idempotencyKey: string,
    signal?: AbortSignal): Promise<Schemas['CatalogRelease']> {
    return this.send('POST', `${catalogAuthor}/releases`, input, { headers: { 'Idempotency-Key': idempotencyKey }, signal });
  }

  withdrawCatalogRelease(id: string, signal?: AbortSignal): Promise<Schemas['CatalogRelease']> {
    return this.send('POST', `${catalogAuthor}/releases/${pathId(id)}/withdraw`, { confirm: true }, { signal });
  }

  listCustomAssistants(query: PageQuery = {}, signal?: AbortSignal): Promise<Schemas['CustomAssistantPage']> {
    return this.send('GET', '/custom-assistants' + queryString(query), undefined, { signal });
  }

  getCustomAssistant(id: string, signal?: AbortSignal): Promise<Schemas['CustomAssistant']> {
    return this.send('GET', `/custom-assistants/${pathId(id)}`, undefined, { signal });
  }

  createCustomAssistant(input: Schemas['CustomAssistantCreate'], idempotencyKey: string, signal?: AbortSignal): Promise<Schemas['CustomAssistant']> {
    return this.send('POST', '/custom-assistants', input, { headers: { 'Idempotency-Key': idempotencyKey }, signal });
  }

  deleteCustomAssistant(id: string, signal?: AbortSignal): Promise<void> {
    return this.send('DELETE', `/custom-assistants/${pathId(id)}`, undefined, { signal });
  }

  listCustomAssistantVersions(id: string, query: PageQuery = {}, signal?: AbortSignal): Promise<Schemas['CustomAssistantVersionPage']> {
    return this.send('GET', `/custom-assistants/${pathId(id)}/versions` + queryString(query), undefined, { signal });
  }

  getCustomAssistantVersion(id: string, versionId: string, signal?: AbortSignal): Promise<Schemas['CustomAssistantVersion']> {
    return this.send('GET', `/custom-assistants/${pathId(id)}/versions/${pathId(versionId)}`, undefined, { signal });
  }

  createCustomAssistantVersion(id: string, input: Schemas['CustomAssistantVersionWrite'], signal?: AbortSignal): Promise<Schemas['CustomAssistant']> {
    return this.send('POST', `/custom-assistants/${pathId(id)}/versions`, input, { signal });
  }

  rollbackCustomAssistant(id: string, input: Schemas['CustomAssistantRollback'], signal?: AbortSignal): Promise<Schemas['CustomAssistant']> {
    return this.send('POST', `/custom-assistants/${pathId(id)}/rollback`, input, { signal });
  }

  listReminders(query: PageQuery = {}, signal?: AbortSignal): Promise<Schemas['ReminderPage']> {
    return this.send('GET', '/automations/reminders' + queryString(query), undefined, { signal });
  }

  getReminder(id: string, signal?: AbortSignal): Promise<Schemas['Reminder']> {
    return this.send('GET', `/automations/reminders/${pathId(id)}`, undefined, { signal });
  }

  createReminder(input: Schemas['ReminderInput'], idempotencyKey: string, signal?: AbortSignal): Promise<Schemas['Reminder']> {
    return this.send('POST', '/automations/reminders', input, { headers: { 'Idempotency-Key': idempotencyKey }, signal });
  }

  updateReminderState(id: string, active: boolean, signal?: AbortSignal): Promise<Schemas['Reminder']> {
    return this.send('PATCH', `/automations/reminders/${pathId(id)}`, { active }, { signal });
  }

  deleteReminder(id: string, signal?: AbortSignal): Promise<void> {
    return this.send('DELETE', `/automations/reminders/${pathId(id)}`, undefined, { signal });
  }

  previewReminderShare(id: string, signal?: AbortSignal): Promise<Schemas['ReminderSharePreview']> {
    return this.send('POST', `/automations/reminders/${pathId(id)}/share-preview`, undefined, { signal });
  }

  listReminderShares(id: string, signal?: AbortSignal): Promise<{ items: Schemas['ReminderShareInfo'][] }> {
    return this.send('GET', `/automations/reminders/${pathId(id)}/shares`, undefined, { signal });
  }

  publishReminderShare(id: string, revision: string, signal?: AbortSignal): Promise<Schemas['ReminderSharePublished']> {
    return this.send('POST', `/automations/reminders/${pathId(id)}/shares`, { revision }, { signal });
  }

  revokeReminderShare(id: string, signal?: AbortSignal): Promise<void> {
    return this.send('DELETE', `/automations/reminder-shares/${pathId(id)}`, undefined, { signal });
  }

  readReminderShare(token: string, signal?: AbortSignal): Promise<Schemas['ReminderShareView']> {
    return this.send('POST', '/automations/reminder-shares/read', { token }, { signal });
  }

  applyReminderShare(input: Schemas['ReminderShareApply'], signal?: AbortSignal): Promise<Schemas['Reminder']> {
    return this.send('POST', '/automations/reminder-shares/apply', input, { signal });
  }

  listReminderOccurrences(query: PageQuery & { reminderId?: string } = {}, signal?: AbortSignal): Promise<Schemas['ReminderOccurrencePage']> {
    return this.send('GET', '/automations/reminder-occurrences' + queryString(query), undefined, { signal });
  }

  markReminderOccurrenceRead(id: string, signal?: AbortSignal): Promise<Schemas['ReminderOccurrence']> {
    return this.send('PATCH', `/automations/reminder-occurrences/${pathId(id)}`, { read: true }, { signal });
  }

  getSandboxConnectorAuthorization(signal?: AbortSignal): Promise<Schemas['SandboxConnectorAuthorization']> {
    return this.send('GET', sandboxConnector + '/authorization', undefined, { signal });
  }

  authorizeSandboxConnector(signal?: AbortSignal): Promise<Schemas['SandboxConnectorAuthorization']> {
    return this.send('POST', sandboxConnector + '/authorization', { confirm: true }, { signal });
  }

  revokeSandboxConnectorAuthorization(id: string, signal?: AbortSignal): Promise<void> {
    return this.send('DELETE', sandboxConnector + '/authorization/' + pathId(id), undefined, { signal });
  }

  listSandboxConnectorActions(query: PageQuery = {}, signal?: AbortSignal): Promise<Schemas['SandboxConnectorActionPage']> {
    return this.send('GET', sandboxConnector + '/actions' + queryString(query), undefined, { signal });
  }

  getSandboxConnectorAction(id: string, signal?: AbortSignal): Promise<Schemas['SandboxConnectorAction']> {
    return this.send('GET', sandboxConnector + '/actions/' + pathId(id), undefined, { signal });
  }

  createSandboxConnectorAction(input: Schemas['SandboxConnectorActionCreate'], idempotencyKey: string,
    signal?: AbortSignal): Promise<Schemas['SandboxConnectorAction']> {
    return this.send('POST', sandboxConnector + '/actions', input, { headers: { 'Idempotency-Key': idempotencyKey }, signal });
  }

  approveSandboxConnectorAction(id: string, approvalRevision: string,
    signal?: AbortSignal): Promise<Schemas['SandboxConnectorAction']> {
    return this.send('POST', sandboxConnector + '/actions/' + pathId(id) + '/approve',
      { confirm: true, approvalRevision }, { signal });
  }

  cancelSandboxConnectorAction(id: string, signal?: AbortSignal): Promise<Schemas['SandboxConnectorAction']> {
    return this.send('POST', sandboxConnector + '/actions/' + pathId(id) + '/cancel', undefined, { signal });
  }

  reconcileSandboxConnectorAction(id: string, signal?: AbortSignal): Promise<Schemas['SandboxConnectorAction']> {
    return this.send('POST', sandboxConnector + '/actions/' + pathId(id) + '/reconcile', undefined, { signal });
  }

  listSandboxEventReminders(signal?: AbortSignal): Promise<Schemas['SandboxEventReminders']> {
    return this.send('GET', sandboxEventReminders, undefined, { signal });
  }

  createSandboxEventReminder(input: Schemas['SandboxEventReminderCreate'],
    signal?: AbortSignal): Promise<Schemas['SandboxEventReminder']> {
    return this.send('POST', sandboxEventReminders, input, { signal });
  }

  setSandboxEventReminderActive(id: string, active: boolean, signal?: AbortSignal): Promise<Schemas['SandboxEventReminder']> {
    return this.send('PATCH', sandboxEventReminders + '/' + pathId(id) + '/state', { active }, { signal });
  }

  deleteSandboxEventReminder(id: string, signal?: AbortSignal): Promise<void> {
    return this.send('DELETE', sandboxEventReminders + '/' + pathId(id), undefined, { signal });
  }

  listSandboxEventReminderOccurrences(id: string, query: PageQuery = {},
    signal?: AbortSignal): Promise<Schemas['SandboxEventReminderOccurrencePage']> {
    return this.send('GET', sandboxEventReminders + '/' + pathId(id) + '/occurrences' + queryString(query), undefined, { signal });
  }

  markSandboxEventReminderRead(id: string, occurrenceId: string,
    signal?: AbortSignal): Promise<Schemas['SandboxEventReminderOccurrence']> {
    return this.send('POST', sandboxEventReminders + '/' + pathId(id) + '/occurrences/' + pathId(occurrenceId) + '/read',
      undefined, { signal });
  }

  receiveSandboxReminderEvent(input: Schemas['SandboxReminderEventInput'],
    signal?: AbortSignal): Promise<Schemas['SandboxReminderEventResult']> {
    return this.send('POST', sandboxEventReminders + '/receive', input, { signal });
  }

  searchSyntheticProducts(query: PageQuery & { q?: string } = {},
    signal?: AbortSignal): Promise<Schemas['SyntheticProductPage']> {
    return this.send('GET', syntheticCatalogue + '/products' + queryString(query), undefined, { signal });
  }

  getSyntheticProduct(id: string, signal?: AbortSignal): Promise<Schemas['SyntheticProduct']> {
    return this.send('GET', syntheticCatalogue + '/products/' + pathId(id), undefined, { signal });
  }

  compareSyntheticProducts(productIds: string[], signal?: AbortSignal): Promise<Schemas['SyntheticProductComparison']> {
    return this.send('POST', syntheticCatalogue + '/compare', { productIds }, { signal });
  }

  recheckSyntheticProductSource(id: string, snapshotId: string,
    signal?: AbortSignal): Promise<Schemas['SyntheticProductSource']> {
    const query = new URLSearchParams({ snapshotId });
    return this.send('GET', syntheticCatalogue + '/products/' + pathId(id) + '/source?' + query, undefined, { signal });
  }

  getCurrentOrganization(signal?: AbortSignal): Promise<Schemas['Organization']> {
    return this.send('GET', currentOrganization, undefined, { signal });
  }

  getOrganizationPolicy(signal?: AbortSignal): Promise<Schemas['OrganizationPolicy']> {
    return this.send('GET', currentOrganization + '/policy', undefined, { signal });
  }

  getOrganizationUsage(days: Schemas['OrganizationUsage']['periodDays'] = 7,
    signal?: AbortSignal): Promise<Schemas['OrganizationUsage']> {
    return this.send('GET', `${currentOrganization}/usage?days=${days}`, undefined, { signal });
  }

  updateOrganizationPolicy(input: Schemas['OrganizationPolicyWrite'],
    signal?: AbortSignal): Promise<Schemas['OrganizationPolicy']> {
    return this.send('PUT', currentOrganization + '/policy', input, { signal });
  }

  getOrganizationModelBudget(signal?: AbortSignal): Promise<Schemas['OrganizationModelBudget']> {
    return this.send('GET', currentOrganization + '/model-budget', undefined, { signal });
  }

  updateOrganizationModelBudget(input: Schemas['OrganizationModelBudgetWrite'],
    signal?: AbortSignal): Promise<Schemas['OrganizationModelBudget']> {
    return this.send('PUT', currentOrganization + '/model-budget', input, { signal });
  }

  bindOrganizationDirectoryMember(input: Schemas['OrganizationDirectoryBindingWrite'],
    signal?: AbortSignal): Promise<Schemas['OrganizationDirectoryBinding']> {
    const { accountId, membershipRevision, externalId, confirm } = input;
    return this.send('POST', currentOrganization + '/directory-bindings',
      { accountId, membershipRevision, externalId, confirm }, { signal });
  }

  getOrganizationSsoLink(signal?: AbortSignal): Promise<{ eligible: boolean; linked: boolean }> {
    return this.send('GET', '/organization-sso/link', undefined, { signal });
  }

  startOrganizationSsoLink(currentPassword: string, signal?: AbortSignal): Promise<{ authorizationUrl: string }> {
    return this.send('POST', '/organization-sso/link/start', { currentPassword, confirm: true },
      { signal, sameOriginCookie: true });
  }

  revokeOrganizationSsoLink(currentPassword: string, signal?: AbortSignal): Promise<void> {
    return this.send('POST', '/organization-sso/link/revoke', { currentPassword, confirm: true }, { signal });
  }

  listOrganizationMembers(query: PageQuery = {}, signal?: AbortSignal): Promise<Schemas['OrganizationMemberPage']> {
    return this.send('GET', currentOrganization + '/members' + queryString(query), undefined, { signal });
  }

  addOrganizationMember(input: Schemas['OrganizationMemberAdd'],
    signal?: AbortSignal): Promise<Schemas['OrganizationMember']> {
    return this.send('POST', currentOrganization + '/members', input, { signal });
  }

  changeOrganizationMemberRole(accountId: string, input: Schemas['OrganizationRoleChange'],
    signal?: AbortSignal): Promise<Schemas['OrganizationMember']> {
    return this.send('PUT', currentOrganization + '/members/' + pathId(accountId) + '/role', input, { signal });
  }

  revokeOrganizationMember(accountId: string, input: Schemas['OrganizationRevoke'], signal?: AbortSignal): Promise<void> {
    return this.send('POST', currentOrganization + '/members/' + pathId(accountId) + '/revoke', input, { signal });
  }

  listOrganizationAudit(query: PageQuery = {}, signal?: AbortSignal): Promise<Schemas['OrganizationAuditPage']> {
    return this.send('GET', currentOrganization + '/audit' + queryString(query), undefined, { signal });
  }

  getProactivePreferences(signal?: AbortSignal): Promise<Schemas['ProactivePreferences']> {
    return this.send('GET', proactiveAssistant + '/preferences', undefined, { signal });
  }

  updateProactivePreferences(input: Schemas['ProactivePreferencesWrite'],
    signal?: AbortSignal): Promise<Schemas['ProactivePreferences']> {
    return this.send('PUT', proactiveAssistant + '/preferences', input, { signal });
  }

  listProactiveSuggestions(signal?: AbortSignal): Promise<Schemas['ProactiveSuggestions']> {
    return this.send('GET', proactiveAssistant + '/suggestions', undefined, { signal });
  }

  dismissProactiveSuggestion(id: string, signal?: AbortSignal): Promise<void> {
    return this.send('POST', proactiveAssistant + '/suggestions/' + pathId(id) + '/dismiss', undefined, { signal });
  }

  getDesktopCompanionState(signal?: AbortSignal): Promise<Schemas['DesktopCompanionState']> {
    return this.send('GET', desktopCompanion, undefined, { signal });
  }

  getEligibility(signal?: AbortSignal): Promise<Schemas['PilotEligibility']> {
    return this.send('GET', '/eligibility', undefined, { signal });
  }

  listGuardianConsents(signal?: AbortSignal): Promise<Schemas['GuardianConsentList']> {
    return this.send('GET', '/eligibility/guardian/consents', undefined, { signal });
  }

  updateGuardianConsent(id: string, input: Schemas['GuardianConsentWrite'], signal?: AbortSignal): Promise<Schemas['GuardianConsent']> {
    return this.send('PUT', `/eligibility/guardian/consents/${pathId(id)}`, input, { signal });
  }

  createDesktopCompanionOffer(signal?: AbortSignal): Promise<Schemas['DesktopCompanionOffer']> {
    return this.send('POST', `${desktopCompanion}/offers`, undefined, { signal });
  }

  claimDesktopCompanionOffer(input: Schemas['DesktopCompanionClaim'], signal?: AbortSignal): Promise<Schemas['DesktopCompanionState']> {
    return this.send('POST', `${desktopCompanion}/offers/claim`, input, { signal });
  }

  confirmDesktopCompanionPair(pairId: string, signal?: AbortSignal): Promise<Schemas['DesktopCompanionState']> {
    return this.send('POST', `${desktopCompanion}/pairs/${pathId(pairId)}/confirm`, { confirm: true }, { signal });
  }

  revokeDesktopCompanionPair(pairId: string, signal?: AbortSignal): Promise<void> {
    return this.send('DELETE', `${desktopCompanion}/pairs/${pathId(pairId)}`, undefined, { signal });
  }

  publishDesktopCompanionTask(pairId: string, input: Schemas['DesktopCompanionTaskBinding'],
    signal?: AbortSignal): Promise<Schemas['DesktopCompanionState']> {
    return this.send('PUT', `${desktopCompanion}/pairs/${pathId(pairId)}/task`, input, { signal });
  }

  withdrawDesktopCompanionTask(pairId: string, taskId: string, signal?: AbortSignal): Promise<void> {
    return this.send('DELETE', `${desktopCompanion}/pairs/${pathId(pairId)}/task/${pathId(taskId)}`, undefined, { signal });
  }

  decideDesktopCompanionTask(pairId: string, taskId: string, input: Schemas['DesktopCompanionDecision'],
    signal?: AbortSignal): Promise<Schemas['DesktopCompanionState']> {
    return this.send('POST', `${desktopCompanion}/pairs/${pathId(pairId)}/task/${pathId(taskId)}/decision`, input, { signal });
  }

  consumeDesktopCompanionTask(pairId: string, taskId: string, input: Schemas['DesktopCompanionTaskBinding'],
    signal?: AbortSignal): Promise<void> {
    return this.send('POST', `${desktopCompanion}/pairs/${pathId(pairId)}/task/${pathId(taskId)}/consume`, input, { signal });
  }

  listResearchSources(query: PageQuery = {}, signal?: AbortSignal): Promise<Schemas['ResearchSourcePage']> {
    return this.send('GET', '/research/sources' + queryString(query), undefined, { signal });
  }

  listResearchTasks(query: PageQuery = {}, signal?: AbortSignal): Promise<Schemas['ResearchTaskPage']> {
    return this.send('GET', '/research' + queryString(query), undefined, { signal });
  }

  getResearchTask(id: string, signal?: AbortSignal): Promise<Schemas['ResearchTask']> {
    return this.send('GET', `/research/${pathId(id)}`, undefined, { signal });
  }

  createResearchTask(plan: Schemas['ResearchPlan'], idempotencyKey: string, signal?: AbortSignal): Promise<Schemas['ResearchTask']> {
    return this.send('POST', '/research', plan, { headers: { 'Idempotency-Key': idempotencyKey }, signal });
  }

  reviseResearchTask(id: string, plan: Schemas['ResearchPlanRevision'], signal?: AbortSignal): Promise<Schemas['ResearchTask']> {
    return this.send('PATCH', `/research/${pathId(id)}`, plan, { signal });
  }

  approveResearchTask(id: string, revision: number, signal?: AbortSignal): Promise<Schemas['ResearchTask']> {
    return this.send('POST', `/research/${pathId(id)}/approve`, { revision }, { signal });
  }

  cancelResearchTask(id: string, revision: number, signal?: AbortSignal): Promise<Schemas['ResearchTask']> {
    return this.send('POST', `/research/${pathId(id)}/cancel`, { revision }, { signal });
  }

  downloadResearchReport(id: string, revision: number, signal?: AbortSignal): Promise<Blob> {
    const query = new URLSearchParams({ revision: String(revision) });
    return this.downloadArtifact(`/research/${pathId(id)}/report?${query}`, 'text/plain', undefined, signal);
  }

  getUsage(): Promise<Schemas['AccountUsage']> {
    return this.send('GET', '/usage');
  }

  getExportPage(cursor?: string): Promise<Schemas['ExportPage']> {
    return this.send('GET', `/privacy/export${queryString({ cursor })}`);
  }

  async eraseAccount(input: Schemas['AccountErasureRequest']): Promise<void> {
    const active = this.accountController;
    await this.send<void>('POST', '/privacy/account-erasure', {
      currentPassword: input.currentPassword,
      confirmation: input.confirmation,
    });
    if (active === this.accountController) await this.replaceSession(null);
  }

  listProjectInvitations(projectId: string, signal?: AbortSignal): Promise<{ items: Schemas['ProjectInvitation'][] }> {
    return this.send('GET', `/projects/${pathId(projectId)}/collaboration/invitations`, undefined, { signal });
  }

  inviteProjectMember(projectId: string, input: Schemas['ProjectInvitationCreate'], signal?: AbortSignal): Promise<Schemas['ProjectInvitation']> {
    return this.send('POST', `/projects/${pathId(projectId)}/collaboration/invitations`, input, { signal });
  }

  revokeProjectInvitation(projectId: string, id: string, signal?: AbortSignal): Promise<void> {
    return this.send('DELETE', `/projects/${pathId(projectId)}/collaboration/invitations/${pathId(id)}`, undefined, { signal });
  }

  listReceivedProjectInvitations(signal?: AbortSignal): Promise<{ items: Schemas['ProjectInvitation'][] }> {
    return this.send('GET', '/collaboration/invitations', undefined, { signal });
  }

  acceptProjectInvitation(id: string, signal?: AbortSignal): Promise<Schemas['ProjectInvitation']> {
    return this.send('POST', `/collaboration/invitations/${pathId(id)}/accept`, { confirm: true }, { signal });
  }

  declineProjectInvitation(id: string, signal?: AbortSignal): Promise<void> {
    return this.send('DELETE', `/collaboration/invitations/${pathId(id)}`, undefined, { signal });
  }

  listSharedProjects(signal?: AbortSignal): Promise<{ items: Schemas['SharedProject'][] }> {
    return this.send('GET', '/collaboration/projects', undefined, { signal });
  }

  leaveSharedProject(projectId: string, signal?: AbortSignal): Promise<void> {
    return this.send('DELETE', `/collaboration/projects/${pathId(projectId)}/membership`, undefined, { signal });
  }

  listSharedProjectMaterials(projectId: string, signal?: AbortSignal): Promise<{ items: Schemas['SharedProjectMaterialSummary'][] }> {
    return this.send('GET', `/collaboration/projects/${pathId(projectId)}/materials`, undefined, { signal });
  }

  listProjectArtifactPublications(projectId: string, signal?: AbortSignal): Promise<{ items: Schemas['ArtifactPublicationSummary'][] }> {
    return this.send('GET', `/collaboration/projects/${pathId(projectId)}/artifact-publications`, undefined, { signal });
  }

  publishProjectArtifact(projectId: string, input: Schemas['ArtifactPublicationCreate'], signal?: AbortSignal): Promise<Schemas['ArtifactPublicationSummary']> {
    return this.send('POST', `/collaboration/projects/${pathId(projectId)}/artifact-publications`, input, { signal });
  }

  getProjectArtifactPublication(projectId: string, id: string, signal?: AbortSignal): Promise<Schemas['ArtifactPublication']> {
    return this.send('GET', `/collaboration/projects/${pathId(projectId)}/artifact-publications/${pathId(id)}`, undefined, { signal });
  }

  revokeProjectArtifactPublication(projectId: string, id: string, signal?: AbortSignal): Promise<void> {
    return this.send('DELETE', `/collaboration/projects/${pathId(projectId)}/artifact-publications/${pathId(id)}`, undefined, { signal });
  }

  downloadProjectArtifactPublication(projectId: string, id: string, format: Schemas['ArtifactPublishedFormat'],
    signal?: AbortSignal): Promise<Blob> {
    const path = `/collaboration/projects/${pathId(projectId)}/artifact-publications/${pathId(id)}`;
    if (format === 'image') return this.downloadGrantedAttachment(path, 'image/png', signal);
    return this.downloadArtifact(path + '/download', artifactMediaType(format), undefined, signal);
  }

  previewProjectWebpagePublication(projectId: string, id: string, signal?: AbortSignal): Promise<Blob> {
    return this.downloadArtifact(`/collaboration/projects/${pathId(projectId)}/artifact-publications/${pathId(id)}/preview`,
      'text/html', undefined, signal);
  }

  listArtifactPublicationComments(projectId: string, publicationId: string,
    signal?: AbortSignal): Promise<{ items: Schemas['ArtifactPublicationComment'][] }> {
    return this.send('GET', `/collaboration/projects/${pathId(projectId)}/artifact-publications/${pathId(publicationId)}/comments`,
      undefined, { signal });
  }

  createArtifactPublicationComment(projectId: string, publicationId: string, content: string, idempotencyKey: string,
    signal?: AbortSignal): Promise<Schemas['ArtifactPublicationComment']> {
    return this.send('POST', `/collaboration/projects/${pathId(projectId)}/artifact-publications/${pathId(publicationId)}/comments`,
      { content }, { headers: { 'Idempotency-Key': idempotencyKey }, signal });
  }

  deleteArtifactPublicationComment(projectId: string, publicationId: string, commentId: string,
    signal?: AbortSignal): Promise<void> {
    return this.send('DELETE',
      `/collaboration/projects/${pathId(projectId)}/artifact-publications/${pathId(publicationId)}/comments/${pathId(commentId)}`,
      undefined, { signal });
  }

  listProjectSharedDrafts(projectId: string, signal?: AbortSignal): Promise<{ items: Schemas['ProjectSharedDraftSummary'][] }> {
    return this.send('GET', this.sharedDraftsPath(projectId), undefined, { signal });
  }

  createProjectSharedDraft(projectId: string, input: Schemas['ProjectSharedDraftCreate'],
    signal?: AbortSignal): Promise<Schemas['ProjectSharedDraft']> {
    return this.send('POST', this.sharedDraftsPath(projectId), input, { signal });
  }

  getProjectSharedDraft(projectId: string, draftId: string, signal?: AbortSignal): Promise<Schemas['ProjectSharedDraft']> {
    return this.send('GET', this.sharedDraftsPath(projectId, draftId), undefined, { signal });
  }

  deleteProjectSharedDraft(projectId: string, draftId: string, signal?: AbortSignal): Promise<void> {
    return this.send('DELETE', this.sharedDraftsPath(projectId, draftId), undefined, { signal });
  }

  listProjectSharedDraftRevisions(projectId: string, draftId: string,
    signal?: AbortSignal): Promise<{ items: Schemas['ProjectSharedDraftRevisionSummary'][] }> {
    return this.send('GET', `${this.sharedDraftsPath(projectId, draftId)}/revisions`, undefined, { signal });
  }

  reviseProjectSharedDraft(projectId: string, draftId: string, input: Schemas['ProjectSharedDraftEdit'],
    signal?: AbortSignal): Promise<Schemas['ProjectSharedDraft']> {
    return this.send('POST', `${this.sharedDraftsPath(projectId, draftId)}/revisions`, input, { signal });
  }

  restoreProjectSharedDraftRevision(projectId: string, draftId: string, input: Schemas['ProjectSharedDraftRestore'],
    signal?: AbortSignal): Promise<Schemas['ProjectSharedDraft']> {
    return this.send('POST', `${this.sharedDraftsPath(projectId, draftId)}/rollback`, input, { signal });
  }

  getProjectSharedDraftRevision(projectId: string, draftId: string, revisionId: string,
    signal?: AbortSignal): Promise<Schemas['ProjectSharedDraftRevision']> {
    return this.send('GET', `${this.sharedDraftsPath(projectId, draftId)}/revisions/${pathId(revisionId)}`, undefined, { signal });
  }

  downloadProjectSharedDraftRevision(projectId: string, draftId: string, revisionId: string,
    signal?: AbortSignal): Promise<Blob> {
    return this.downloadArtifact(`${this.sharedDraftsPath(projectId, draftId)}/revisions/${pathId(revisionId)}/download`,
      'text/markdown', undefined, signal);
  }

  private sharedDraftsPath(projectId: string, draftId?: string): string {
    const base = `/collaboration/projects/${pathId(projectId)}/shared-drafts`;
    return draftId === undefined ? base : `${base}/${pathId(draftId)}`;
  }

  getSharedProjectMaterial(projectId: string, id: string, signal?: AbortSignal): Promise<Schemas['SharedProjectMaterial']> {
    return this.send('GET', `/collaboration/projects/${pathId(projectId)}/materials/${pathId(id)}`, undefined, { signal });
  }

  createSharedProjectMaterial(projectId: string, input: Schemas['ProjectResourceCreate'], signal?: AbortSignal): Promise<Schemas['SharedProjectMaterial']> {
    return this.send('POST', `/collaboration/projects/${pathId(projectId)}/materials`, input, { signal });
  }

  deleteSharedProjectMaterial(projectId: string, id: string, signal?: AbortSignal): Promise<void> {
    return this.send('DELETE', `/collaboration/projects/${pathId(projectId)}/materials/${pathId(id)}`, undefined, { signal });
  }

  listProjects(query: PageQuery = {}, signal?: AbortSignal): Promise<Schemas['ProjectPage']> {
    return this.send('GET', `/projects${queryString(query)}`, undefined, { signal });
  }

  createProject(input: Schemas['ProjectCreate']): Promise<Schemas['Project']> {
    return this.send('POST', '/projects', input);
  }

  getProject(projectId: string): Promise<Schemas['Project']> {
    return this.send('GET', `/projects/${pathId(projectId)}`);
  }

  updateProject(projectId: string, input: Schemas['ProjectPatch']): Promise<Schemas['Project']> {
    return this.send('PATCH', `/projects/${pathId(projectId)}`, input);
  }

  listProjectAttachments(projectId: string, signal?: AbortSignal): Promise<{ items: Schemas['ProjectAttachment'][] }> {
    return this.send('GET', `/projects/${pathId(projectId)}/attachments`, undefined, { signal });
  }

  uploadProjectAttachment(
    projectId: string,
    image: Blob,
    idempotencyKey: string,
    requestSignal?: AbortSignal,
  ): Promise<Schemas['ProjectAttachment']> {
    return this.uploadAttachment(`/projects/${pathId(projectId)}/attachments`, image, 'image/png', idempotencyKey, requestSignal);
  }

  deleteProjectAttachment(projectId: string, attachmentId: string, signal?: AbortSignal): Promise<void> {
    return this.send('DELETE', `/projects/${pathId(projectId)}/attachments/${pathId(attachmentId)}`, undefined, { signal });
  }

  editProjectPng(projectId: string, sourceId: string, input: Schemas['LocalImageEditWrite'], idempotencyKey: string,
    signal?: AbortSignal): Promise<Schemas['ProjectAttachment']> {
    return this.send('POST', `/projects/${pathId(projectId)}/attachments/${pathId(sourceId)}/local-image-edits`, input,
      { headers: { 'Idempotency-Key': idempotencyKey }, signal });
  }

  downloadProjectAttachment(projectId: string, attachmentId: string, requestSignal?: AbortSignal): Promise<Blob> {
    return this.downloadGrantedAttachment(`/projects/${pathId(projectId)}/attachments/${pathId(attachmentId)}`, 'image/png', requestSignal);
  }

  listProjectAudioAttachments(projectId: string, signal?: AbortSignal): Promise<{ items: Schemas['ProjectAudioAttachment'][] }> {
    return this.send('GET', `/projects/${pathId(projectId)}/audio-attachments`, undefined, { signal });
  }

  uploadProjectAudioAttachment(projectId: string, audio: Blob, idempotencyKey: string,
    signal?: AbortSignal): Promise<Schemas['ProjectAudioAttachment']> {
    return this.uploadAttachment(`/projects/${pathId(projectId)}/audio-attachments`, audio, 'audio/wav', idempotencyKey, signal);
  }

  deleteProjectAudioAttachment(projectId: string, attachmentId: string, signal?: AbortSignal): Promise<void> {
    return this.send('DELETE', `/projects/${pathId(projectId)}/audio-attachments/${pathId(attachmentId)}`, undefined, { signal });
  }

  downloadProjectAudioAttachment(projectId: string, attachmentId: string, signal?: AbortSignal): Promise<Blob> {
    return this.downloadGrantedAttachment(`/projects/${pathId(projectId)}/audio-attachments/${pathId(attachmentId)}`, 'audio/wav', signal);
  }

  listProjectPdfAttachments(projectId: string, signal?: AbortSignal): Promise<{ items: Schemas['ProjectPdfAttachment'][] }> {
    return this.send('GET', `/projects/${pathId(projectId)}/pdf-attachments`, undefined, { signal });
  }

  uploadProjectPdfAttachment(projectId: string, pdf: Blob, idempotencyKey: string,
    signal?: AbortSignal): Promise<Schemas['ProjectPdfAttachment']> {
    return this.uploadAttachment(`/projects/${pathId(projectId)}/pdf-attachments`, pdf, 'application/pdf', idempotencyKey, signal);
  }

  getProjectPdfAttachmentText(projectId: string, attachmentId: string, signal?: AbortSignal): Promise<Schemas['ProjectPdfText']> {
    return this.send('GET', `/projects/${pathId(projectId)}/pdf-attachments/${pathId(attachmentId)}/text`, undefined, { signal });
  }

  deleteProjectPdfAttachment(projectId: string, attachmentId: string, signal?: AbortSignal): Promise<void> {
    return this.send('DELETE', `/projects/${pathId(projectId)}/pdf-attachments/${pathId(attachmentId)}`, undefined, { signal });
  }

  downloadProjectPdfAttachment(projectId: string, attachmentId: string, signal?: AbortSignal,
    acknowledgeOcr = false): Promise<Blob> {
    const reviewHeaders = acknowledgeOcr ? { 'X-Assistant-OCR-Reviewed': 'true' } : undefined;
    return this.downloadGrantedAttachment(`/projects/${pathId(projectId)}/pdf-attachments/${pathId(attachmentId)}`,
      'text/plain', signal, reviewHeaders);
  }

  private async uploadAttachment<T>(path: string, file: Blob, mediaType: string, idempotencyKey: string,
    requestSignal?: AbortSignal): Promise<T> {
    const { signal, dispose } = linkAbortSignals(this.accountController.signal, requestSignal);
    try {
      const headers = this.headers({ 'Content-Type': mediaType, 'Idempotency-Key': idempotencyKey, Accept: 'application/json' });
      const response = await this.request('POST', path, headers, signal, file);
      const attachment = await response.json() as T;
      ensureActive(signal);
      return attachment;
    } finally {
      dispose();
    }
  }

  private async downloadGrantedAttachment(path: string, mediaType: string, requestSignal?: AbortSignal,
    grantHeaders?: Record<string, string>): Promise<Blob> {
    const { signal, dispose } = linkAbortSignals(this.accountController.signal, requestSignal);
    try {
      const grant = await this.send<Schemas['AttachmentDownloadGrant']>('POST', path + '/download-grant', undefined,
        { signal, headers: grantHeaders });
      return await this.downloadArtifact(path + '/download', mediaType, { 'X-Attachment-Grant': grant.token }, signal);
    } finally {
      dispose();
    }
  }

  listProjectResources(projectId: string, query: PageQuery & { q?: string } = {},
    signal?: AbortSignal): Promise<Schemas['ProjectResourcePage']> {
    return this.send('GET', `/projects/${pathId(projectId)}/resources${queryString(query)}`, undefined, { signal });
  }

  createProjectResource(projectId: string, input: Schemas['ProjectResourceCreate']): Promise<Schemas['ProjectResource']> {
    return this.send('POST', `/projects/${pathId(projectId)}/resources`, input);
  }

  getProjectResource(projectId: string, resourceId: string): Promise<Schemas['ProjectResource']> {
    return this.send('GET', `/projects/${pathId(projectId)}/resources/${pathId(resourceId)}`);
  }

  deleteProjectResource(projectId: string, resourceId: string): Promise<void> {
    return this.send('DELETE', `/projects/${pathId(projectId)}/resources/${pathId(resourceId)}`);
  }

  analyzeProjectResource(projectId: string, resourceId: string, input: Schemas['AnalysisInput']): Promise<Schemas['AnalysisSummary']> {
    return this.send('POST', `/projects/${pathId(projectId)}/resources/${pathId(resourceId)}/analysis`, input);
  }

  getAnalysis(analysisId: string): Promise<Schemas['AnalysisSummary']> {
    return this.send('GET', `/analysis/${pathId(analysisId)}`);
  }

  downloadAnalysis(analysisId: string): Promise<Blob> {
    return this.downloadArtifact(`/analysis/${pathId(analysisId)}/artifact`, 'text/csv');
  }

  listConversations(query: ConversationQuery = {}, signal?: AbortSignal): Promise<Schemas['ConversationPage']> {
    return this.send('GET', `/conversations${queryString(query)}`, undefined, { signal });
  }

  createConversation(input: Schemas['ConversationCreate'] = {}): Promise<Schemas['Conversation']> {
    return this.send('POST', '/conversations', input);
  }

  getConversation(conversationId: string, signal?: AbortSignal): Promise<Schemas['Conversation']> {
    return this.send('GET', `/conversations/${pathId(conversationId)}`, undefined, { signal });
  }

  updateConversation(conversationId: string, input: Schemas['ConversationPatch']): Promise<Schemas['Conversation']> {
    return this.send('PATCH', `/conversations/${pathId(conversationId)}`, input);
  }

  moveConversation(conversationId: string, projectId: string | null): Promise<Schemas['Conversation']> {
    return this.send('PUT', `/conversations/${pathId(conversationId)}/project`, { projectId });
  }

  setConversationSharingRestriction(conversationId: string, restricted: boolean): Promise<Schemas['Conversation']> {
    return this.send('PUT', `/conversations/${pathId(conversationId)}/sharing-restriction`, { restricted });
  }

  listLockedConversations(query: PageQuery = {}, signal?: AbortSignal): Promise<Schemas['LockedConversationPage']> {
    return this.send('GET', `/conversations/read-locked${queryString(query)}`, undefined, { signal });
  }

  lockConversationReading(conversationId: string, signal?: AbortSignal): Promise<void> {
    return this.send('POST', `/conversations/${pathId(conversationId)}/read-lock`, { confirm: true }, { signal });
  }

  unlockConversationReading(conversationId: string, currentPassword: string, signal?: AbortSignal): Promise<void> {
    return this.send('POST', `/conversations/${pathId(conversationId)}/read-unlock`, { currentPassword }, { signal });
  }

  deleteConversation(conversationId: string): Promise<void> {
    return this.send('DELETE', `/conversations/${pathId(conversationId)}`);
  }

  listMessages(conversationId: string, query: PageQuery = {}): Promise<Schemas['MessagePage']> {
    return this.send('GET', `/conversations/${pathId(conversationId)}/messages${queryString(query)}`);
  }

  getMessageHistoryReference(conversationId: string, messageId: string,
    signal?: AbortSignal): Promise<Schemas['HistoryReferenceReceipt']> {
    return this.send('GET', `/conversations/${pathId(conversationId)}/messages/${pathId(messageId)}/history-reference`,
      undefined, { signal });
  }

  getMessageProjectMemorySources(conversationId: string, messageId: string,
    signal?: AbortSignal): Promise<Schemas['ProjectMemorySources']> {
    return this.send('GET', `/conversations/${pathId(conversationId)}/messages/${pathId(messageId)}/project-memory-sources`,
      undefined, { signal });
  }

  previewShare(conversationId: string, input: Schemas['ShareSelection']): Promise<Schemas['SharePreview']> {
    return this.send('POST', `/conversations/${pathId(conversationId)}/share-previews`, input);
  }

  createShare(conversationId: string, input: Schemas['ShareCreate']): Promise<Schemas['SharePublished']> {
    return this.send('POST', `/conversations/${pathId(conversationId)}/shares`, input);
  }

  listShares(conversationId: string, query: PageQuery = {}): Promise<Schemas['SharePage']> {
    return this.send('GET', `/conversations/${pathId(conversationId)}/shares${queryString(query)}`);
  }

  revokeShare(shareId: string): Promise<void> {
    return this.send('DELETE', `/shares/${pathId(shareId)}`);
  }

  readShare(token: string): Promise<Schemas['ShareView']> {
    return this.send('POST', '/shares/read', { token });
  }

  copyShare(token: string): Promise<Schemas['Conversation']> {
    return this.send('POST', '/shares/copy', { token });
  }

  queueConversationExport(
    conversationId: string,
    sourceMessageId: string,
    idempotencyKey: string,
  ): Promise<Schemas['Job']> {
    return this.send('POST', `/conversations/${pathId(conversationId)}/exports`, { sourceMessageId }, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  }

  listJobs(query: PageQuery = {}): Promise<Schemas['JobPage']> {
    return this.send('GET', `/jobs${queryString(query)}`);
  }

  getJob(id: string): Promise<Schemas['Job']> {
    return this.send('GET', `/jobs/${pathId(id)}`);
  }

  cancelJob(id: string): Promise<Schemas['Job']> {
    return this.send('POST', `/jobs/${pathId(id)}/cancel`);
  }

  downloadJobArtifact(id: string): Promise<Blob> {
    return this.downloadArtifact(`/jobs/${pathId(id)}/artifact`, 'text/markdown');
  }

  private async downloadArtifact(
    path: string,
    expectedMediaType: string,
    additionalHeaders?: HeadersInit,
    requestSignal?: AbortSignal,
  ): Promise<Blob> {
    const { signal, dispose } = linkAbortSignals(this.accountController.signal, requestSignal);
    try {
      const headers = this.headers(additionalHeaders);
      headers.set('Accept', `${expectedMediaType}, application/json`);
      const response = await this.request('GET', path, headers, signal);
      const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (mediaType !== expectedMediaType) {
        throw new AssistantApiError(response.status, 'HTTP_ERROR', 'The service did not return the requested export format');
      }
      const artifact = await response.blob();
      ensureActive(signal);
      return artifact;
    } finally {
      dispose();
    }
  }

  submitReport(input: Schemas['ReportRequest'], signal?: AbortSignal): Promise<Schemas['ReportReceipt']> {
    const { reason } = input;
    switch (input.targetType) {
      case 'shared_reply':
        return this.send('POST', '/reports', { targetType: input.targetType, shareToken: input.shareToken,
          replyIndex: input.replyIndex, reason }, { signal });
      case 'reminder_share':
        return this.send('POST', '/reports', { targetType: input.targetType, shareToken: input.shareToken,
          revision: input.revision, reason }, { signal });
      case 'hosted_site':
        return this.send('POST', '/reports', { targetType: input.targetType, targetId: input.targetId,
          revision: input.revision, reason }, { signal });
      case 'assistant_reply':
        return this.send('POST', '/reports', { targetType: input.targetType, targetId: input.targetId, reason }, { signal });
    }
  }

  getHostedSiteReportTarget(siteId: string, signal?: AbortSignal): Promise<Schemas['HostedSiteReportTarget']> {
    return this.send('GET', '/hosted-sites/' + pathId(siteId) + '/report-target', undefined, { signal });
  }

  startRun(conversationId: string, input: Schemas['RunRequest'], idempotencyKey: string): Promise<Schemas['RunSnapshot']> {
    return this.send('POST', `/conversations/${pathId(conversationId)}/runs`, input, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  }

  getRunSnapshot(runId: string): Promise<Schemas['RunSnapshot']> {
    return this.send('GET', `/runs/${pathId(runId)}`);
  }

  cancelRun(runId: string): Promise<Schemas['RunSnapshot']> {
    return this.send('POST', `/runs/${pathId(runId)}/cancel`);
  }

  async *openRunEvents(
    runId: string,
    { afterSequence = 0, signal: requestSignal }: { afterSequence?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<RunEvent> {
    if (!validCursor(afterSequence)) throw new RangeError('Invalid run event sequence');
    const request = linkAbortSignals(this.accountController.signal, requestSignal);
    const headers = this.headers({ Accept: 'text/event-stream' });
    if (afterSequence) headers.set('Last-Event-ID', String(afterSequence));

    try {
      const response = await this.request('GET', `/runs/${pathId(runId)}/events`, headers, request.signal);
      const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (mediaType !== 'text/event-stream') throw new StreamProtocolError('The service did not return an SSE stream');

      for await (const event of decodeRunEvents(this.readStream(response), { runId, afterSequence })) {
        ensureActive(request.signal);
        yield event;
      }
      ensureActive(request.signal);
    } finally {
      request.dispose();
    }
  }

  private headers(extra?: HeadersInit, guest = false, workspace?: string | null): Headers {
    const headers = new Headers(extra);
    if (!guest && this.credentials) {
      headers.set('Authorization', `Bearer ${this.credentials.token}`);
      if (workspace !== null) headers.set('X-Workspace-Id', workspace ?? this.credentials.workspaceId);
    }
    return headers;
  }

  private async send<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { headers?: HeadersInit; guest?: boolean; workspace?: string | null; signal?: AbortSignal;
      sameOriginCookie?: boolean } = {},
  ): Promise<T> {
    const { signal, dispose } = linkAbortSignals(this.accountController.signal, options.signal);
    try {
      const headers = this.headers(options.headers, options.guest, options.workspace);
      headers.set('Accept', 'application/json');
      const payload = body === undefined ? undefined : JSON.stringify(body);
      if (payload !== undefined) headers.set('Content-Type', 'application/json');
      const response = await this.request(method, path, headers, signal, payload, options.sameOriginCookie);
      const value = response.status === 204 ? undefined : await response.json();
      ensureActive(signal);
      return value as T;
    } finally {
      dispose();
    }
  }

  private async request(method: string, path: string, headers: Headers, signal: AbortSignal, body?: BodyInit,
    sameOriginCookie = false): Promise<Response> {
    ensureActive(signal);
    const response = await this.fetcher(this.origin + API_PREFIX + path, {
      method,
      headers,
      signal,
      body,
      credentials: sameOriginCookie ? 'same-origin' : 'omit',
      redirect: 'error',
    });
    ensureActive(signal);
    await checkResponse(response);
    ensureActive(signal);
    return response;
  }
}
