import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Modal, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AssistantApiError, type AssistantClient, type components } from '../../../packages/contracts/dist/index.js';
import { PublishedArtifact, publicationFormats, supportsPublication, type PublicationFormat } from './published-artifact';
import { Action, styles } from './ui';

type Data = components['schemas'];
type ProjectRoute = { projectId: string; owned: boolean };
type DraftRoute = ProjectRoute & { draftId: string };
type BrowseRoute = { kind: 'home' } | { kind: 'workspaces' } | ({ kind: 'project' } & ProjectRoute)
  | ({ kind: 'draft' | 'versions' } & DraftRoute) | ({ kind: 'revision'; revisionId: string } & DraftRoute);
type Route = BrowseRoute | ({ kind: 'publication'; publicationId: string; format: PublicationFormat } & ProjectRoute);
type Mode = 'drafts' | 'publications';
type PublicationSummary = Data['ArtifactPublicationSummary'] & { format: PublicationFormat };
type Snapshot = { kind: 'home'; owned: Data['ProjectPage']; shared: Data['SharedProject'][]; invitations: Data['ProjectInvitation'][] }
  | { kind: 'workspaces'; page: Data['WorkspacePage'] }
  | ({ kind: 'project'; name: string; role: 'owner' | Data['SharedProjectRole']; drafts: Data['ProjectSharedDraftSummary'][];
    publications: PublicationSummary[] } & ProjectRoute)
  | ({ kind: 'draft'; draft: Data['ProjectSharedDraft'] } & DraftRoute)
  | ({ kind: 'versions'; versions: Data['ProjectSharedDraftRevisionSummary'][] } & DraftRoute)
  | { kind: 'revision'; revision: Data['ProjectSharedDraftRevision'] };

const home: BrowseRoute = { kind: 'home' };
const roleLabels = { owner: '所有者', editor: '编辑者', viewer: '查看者' };
const accessMessage = '协作权限已失效或文稿不可访问。';

async function readSnapshot(client: AssistantClient, route: BrowseRoute, mode: Mode, signal: AbortSignal): Promise<Snapshot> {
  switch (route.kind) {
    case 'home': {
      const [owned, shared, invitations] = await Promise.all([
        client.listProjects({ limit: 30 }, signal), client.listSharedProjects(signal), client.listReceivedProjectInvitations(signal),
      ]);
      return { kind: 'home', owned, shared: shared.items, invitations: invitations.items.filter(({ state }) => state === 'pending') };
    }
    case 'workspaces':
      return { kind: 'workspaces', page: await client.listWorkspaces({ limit: 30 }) };
    case 'project': {
      const project = route.owned ? await client.getProject(route.projectId)
        : (await client.listSharedProjects(signal)).items.find(({ id }) => id === route.projectId);
      if (!project) throw new AssistantApiError(404, 'NOT_FOUND', accessMessage);
      const access = { ...route, name: project.name, role: 'role' in project ? project.role : 'owner' as const };
      if (mode === 'publications') {
        const { items } = await client.listProjectArtifactPublications(route.projectId, signal);
        return { ...access, drafts: [], publications: items.filter((item): item is PublicationSummary => supportsPublication(item.format)) };
      }
      const { items } = await client.listProjectSharedDrafts(route.projectId, signal);
      return { ...access, drafts: items, publications: [] };
    }
    case 'draft':
      return { ...route, kind: 'draft', draft: await client.getProjectSharedDraft(route.projectId, route.draftId, signal) };
    case 'versions':
      return { ...route, kind: 'versions', versions: (await client.listProjectSharedDraftRevisions(route.projectId, route.draftId, signal)).items };
    case 'revision':
      return { kind: 'revision', revision: await client.getProjectSharedDraftRevision(route.projectId, route.draftId, route.revisionId, signal) };
  }
}

function workspaceLabel(item: Data['WorkspaceSummary']) {
  return item.kind === 'personal' ? '个人空间' : `工作空间 ${item.id.slice(0, 8)}`;
}

function titleOf(route: Route, mode: Mode) {
  if (route.kind === 'workspaces') return '切换工作空间';
  if (route.kind === 'versions') return '版本记录';
  if (route.kind === 'revision') return '历史版本';
  return mode === 'publications' ? '项目发布' : '共享文稿';
}

export function SharedDrafts({ client, workspaceId, mode, close, chooseWorkspace, onSessionExpired }: {
  client: AssistantClient;
  workspaceId: string;
  mode: Mode;
  close: () => void;
  chooseWorkspace: (id: string) => Promise<void>;
  onSessionExpired: (failure: AssistantApiError) => void;
}) {
  const route = useRef<Route>(home);
  const mounted = useRef(false);
  const foreground = useRef(false);
  const pending = useRef<{ controller: AbortController; timeout: ReturnType<typeof setTimeout> } | null>(null);
  const switching = useRef(false);
  const [location, setLocation] = useState<Route>(home);
  const [view, setView] = useState<Snapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const abort = useCallback(() => {
    if (pending.current) {
      clearTimeout(pending.current.timeout);
      pending.current.controller.abort();
      pending.current = null;
    }
  }, []);

  const protect = useCallback(async (load: (signal: AbortSignal) => Promise<Snapshot>, retain = false) => {
    if (!mounted.current || !foreground.current || switching.current) return;
    abort();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      if (pending.current?.controller !== controller) return;
      abort();
      setView(undefined);
      setBusy(false);
      setError('暂时无法核对访问权限。请连接网络后重新读取。');
    }, 8_000);
    pending.current = { controller, timeout };
    if (!retain) setView(undefined);
    setBusy(!retain);
    setError('');
    try {
      const next = await load(controller.signal);
      if (pending.current?.controller === controller) setView(next);
    } catch (failure) {
      if (pending.current?.controller !== controller) return;
      setView(undefined);
      if (failure instanceof AssistantApiError && failure.status === 401) {
        onSessionExpired(failure);
      } else if (failure instanceof AssistantApiError && (failure.status === 403 || failure.status === 404)) {
        route.current = home;
        setLocation(home);
        setError(mode === 'publications' ? '协作权限已失效或项目发布不可访问。' : accessMessage);
      } else {
        setError('暂时无法核对访问权限。请重新读取。');
      }
    } finally {
      if (pending.current?.controller === controller) {
        abort();
        setBusy(false);
      }
    }
  }, [abort, mode, onSessionExpired]);

  const navigate = useCallback((next: Route, retain = false) => {
    route.current = next;
    setLocation(next);
    if (next.kind === 'publication') {
      abort();
      setView(undefined);
      setBusy(false);
      setError('');
      return;
    }
    void protect((signal) => readSnapshot(client, next, mode, signal), retain);
  }, [abort, client, mode, protect]);

  useEffect(() => {
    mounted.current = true;
    const update = (active: boolean) => {
      foreground.current = active;
      if (active) navigate(route.current);
      else {
        abort();
        setView(undefined);
        setBusy(false);
        setError('');
      }
    };
    const subscription = AppState.addEventListener('change', (next) => update(next === 'active'));
    update(AppState.currentState === 'active');
    return () => {
      subscription.remove();
      mounted.current = false;
      foreground.current = false;
      abort();
    };
  }, [abort, navigate]);

  const verifying = view?.kind === 'draft' || view?.kind === 'versions' || view?.kind === 'revision' || view?.kind === 'project';
  useEffect(() => {
    if (!verifying) return;
    const timer = setInterval(() => {
      if (foreground.current && !pending.current) navigate(route.current, true);
    }, 15_000);
    return () => clearInterval(timer);
  }, [navigate, verifying]);

  function back() {
    if (switching.current) return;
    const here = route.current;
    if (here.kind === 'home') close();
    else if (here.kind === 'publication') navigate({ kind: 'project', projectId: here.projectId, owned: here.owned });
    else if (here.kind === 'revision') navigate({ ...here, kind: 'versions' });
    else if (here.kind === 'versions') navigate({ ...here, kind: 'draft' });
    else if (here.kind === 'draft') navigate({ ...here, kind: 'project' });
    else navigate(home);
  }

  function accept(id: string) {
    void protect(async (signal) => {
      await client.acceptProjectInvitation(id, signal);
      return readSnapshot(client, home, mode, signal);
    });
  }

  async function selectWorkspace(id: string) {
    if (switching.current || id === workspaceId) return;
    abort();
    switching.current = true;
    setBusy(true);
    setError('');
    try {
      await chooseWorkspace(id);
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof AssistantApiError && failure.status === 401) onSessionExpired(failure);
      else setError('无法切换工作空间。请重新读取。');
    } finally {
      switching.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function moreProjects(previous: Extract<Snapshot, { kind: 'home' }>) {
    const cursor = previous.owned.nextCursor;
    if (!cursor) return;
    void protect(async (signal) => {
      const page = await client.listProjects({ limit: 30, cursor }, signal);
      return { ...previous, owned: { ...page, items: [...previous.owned.items, ...page.items] } };
    });
  }

  function moreWorkspaces(previous: Extract<Snapshot, { kind: 'workspaces' }>) {
    const cursor = previous.page.nextCursor;
    if (!cursor) return;
    void protect(async () => {
      const page = await client.listWorkspaces({ limit: 30, cursor });
      return { ...previous, page: { ...page, items: [...previous.page.items, ...page.items] } };
    });
  }

  if (location.kind === 'publication') return <Modal visible onRequestClose={back}>
    <PublishedArtifact key={location.publicationId} client={client} projectId={location.projectId} publicationId={location.publicationId}
      format={location.format} back={back} onSessionExpired={onSessionExpired} />
  </Modal>;

  return <Modal visible onRequestClose={back}>
    <SafeAreaView style={styles.safe} accessibilityViewIsModal>
      <View style={styles.toolbar}>
        <Text accessibilityRole="header" style={[styles.heading, styles.flexibleHeading]}>{titleOf(location, mode)}</Text>
        <Action title={location.kind === 'home' ? mode === 'publications' ? '关闭项目发布' : '关闭共享文稿' : '返回'}
          disabled={switching.current} onPress={back} />
      </View>
      <ScrollView contentContainerStyle={styles.thread} keyboardShouldPersistTaps="handled">
        <View style={styles.actions}>
          <Action title="重新读取" disabled={busy} onPress={() => navigate(route.current)} />
          {location.kind === 'home' && <Action title="切换工作空间" disabled={busy} onPress={() => navigate({ kind: 'workspaces' })} />}
        </View>
        {busy && <Text accessibilityLiveRegion="polite" style={styles.muted}>
          {switching.current ? '正在切换工作空间…' : '正在核对访问权限…'}
        </Text>}
        {!!error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
        {view?.kind === 'workspaces' && <>
          {view.page.items.map((item) => <View key={item.id} style={styles.message}>
            <Text style={styles.label}>{workspaceLabel(item)}</Text>
            <Action title={item.id === workspaceId ? '当前工作空间' : '切换至此空间'}
              accessibilityLabel={`${workspaceLabel(item)} ${item.id === workspaceId ? '当前工作空间' : '切换至此空间'}`}
              disabled={busy || item.id === workspaceId} onPress={() => void selectWorkspace(item.id)} />
          </View>)}
          {!view.page.items.length && <Text style={styles.muted}>暂无可选工作空间。</Text>}
          {view.page.nextCursor && <Action title="加载更多工作空间" disabled={busy} onPress={() => moreWorkspaces(view)} />}
        </>}
        {view?.kind === 'home' && <>
          {!!view.invitations.length && <Text accessibilityRole="header" style={styles.label}>协作邀请</Text>}
          {view.invitations.map((item) => <View key={item.id} style={styles.message}>
            <Text style={styles.label}>{item.projectName}</Text>
            <Text style={styles.muted}>{roleLabels[item.role]}</Text>
            <Action title="接受邀请" accessibilityLabel={`接受 ${item.projectName} 邀请`} disabled={busy} onPress={() => accept(item.id)} />
          </View>)}
          {[...view.shared.map((item) => ({ ...item, owned: false })),
            ...view.owned.items.map((item) => ({ ...item, role: 'owner' as const, owned: true }))].map((item) =>
            <View key={item.id} style={styles.message}>
              <Text style={styles.label}>{item.name}</Text>
              <Text style={styles.muted}>{roleLabels[item.role]}</Text>
              <Action title={mode === 'publications' ? '查看项目发布' : '查看项目文稿'}
                accessibilityLabel={`查看 ${item.name} ${mode === 'publications' ? '发布' : '文稿'}`} disabled={busy}
                onPress={() => navigate({ kind: 'project', projectId: item.id, owned: item.owned })} />
            </View>)}
          {!view.shared.length && !view.owned.items.length && !view.invitations.length && <Text style={styles.muted}>暂无项目或邀请。</Text>}
          {view.owned.nextCursor && <Action title="加载更多自有项目" disabled={busy} onPress={() => moreProjects(view)} />}
        </>}
        {view?.kind === 'project' && <>
          <Text accessibilityRole="header" style={styles.label}>{view.name}</Text>
          <Text style={styles.muted}>{roleLabels[view.role]}</Text>
          {view.drafts.map((item) => <View key={item.id} style={styles.message}>
            <Text style={styles.label}>{item.title}</Text>
            <Text style={styles.muted}>第 {item.versionNumber} 版</Text>
            <Action title="打开文稿" accessibilityLabel={`打开 ${item.title}`} disabled={busy}
              onPress={() => navigate({ kind: 'draft', projectId: view.projectId, owned: view.owned, draftId: item.id })} />
          </View>)}
          {mode === 'drafts' && !view.drafts.length && <Text style={styles.muted}>暂无共享文稿。</Text>}
          {mode === 'publications' && !view.publications.length && <Text style={styles.muted}>暂无可查看的项目发布。</Text>}
          {view.publications.map((item) => <View key={item.id} style={styles.message}>
            <Text style={styles.label}>{item.title}</Text>
            <Text style={styles.muted}>第 {item.versionNumber} 版 · {publicationFormats[item.format].label}</Text>
            <Action title={`查看发布${publicationFormats[item.format].type}`}
              accessibilityLabel={`查看${publicationFormats[item.format].type} ${item.title}`} disabled={busy} onPress={() => navigate({
              kind: 'publication', projectId: view.projectId, owned: view.owned, publicationId: item.id, format: item.format,
            })} />
          </View>)}
        </>}
        {view?.kind === 'draft' && <>
          <Text accessibilityRole="header" style={styles.heading}>{view.draft.title}</Text>
          <Text style={styles.muted}>第 {view.draft.versionNumber} 版</Text>
          <Text style={styles.muted}>{view.draft.canEdit ? '可在桌面网页版编辑此文稿。' : '当前角色可查看文稿。'}</Text>
          <Action title="版本记录" disabled={busy}
            onPress={() => navigate({ kind: 'versions', projectId: view.projectId, owned: view.owned, draftId: view.draftId })} />
          <PlainDraft content={view.draft.content} />
        </>}
        {view?.kind === 'versions' && <>
          {view.versions.map((item) => <View key={item.id} style={styles.message}>
            <Text style={styles.label}>{item.title}</Text>
            <Action title={`查看第 ${item.versionNumber} 版`} disabled={busy}
              onPress={() => navigate({ kind: 'revision', projectId: view.projectId, owned: view.owned, draftId: view.draftId, revisionId: item.id })} />
          </View>)}
          {!view.versions.length && <Text style={styles.muted}>暂无版本记录。</Text>}
        </>}
        {view?.kind === 'revision' && <>
          <Text accessibilityRole="header" style={styles.heading}>{view.revision.title}</Text>
          <Text style={styles.muted}>第 {view.revision.versionNumber} 版</Text>
          <PlainDraft content={view.revision.content} />
        </>}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

function PlainDraft({ content }: { content: string }) {
  return <View style={styles.message}><Text selectable style={styles.body}>{content || '文稿暂无正文。'}</Text></View>;
}
