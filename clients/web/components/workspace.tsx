"use client";

import {
  Archive, ArchiveRestore, Bell, BookOpen, Brain, Building2, ChevronDown, CircleAlert, Download, FilePenLine, FileText, FolderOpen, GraduationCap, History, Leaf, LogOut, Menu, MessageCircle,
  Lightbulb, Link2, Lock, LockOpen, MessageCircleDashed, Pin, PinOff, Plug, Plus, RefreshCw, Search, Send, Settings2, ShoppingBag, Square, Trash2, Users, X,
} from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";
import {
  downloadConversation, errorText, isActive, messagePath, readHistory, type AccountErasureRequest, type Conversation,
  type ConversationPatch, type Message, type RunRequest, type TextModel, type User,
} from "@/lib/assistant";
import { useRun } from "@/lib/use-run";
import { AccountData } from "./account-data";
import { ArtifactsPanel } from "./artifacts-panel";
import { ContentReport } from "./content-report";
import { CustomAssistantsPanel } from "./custom-assistants-panel";
import { EventReminders } from "./event-reminders";
import { GuardianEligibility } from "./guardian-eligibility";
import { LearningPanel } from "./learning-panel";
import { LockedConversations } from "./locked-conversations";
import { Wordmark } from "./assistant";
import { BackgroundJobs } from "./background-jobs";
import { HistoryReferenceDetails, HistoryReferencePicker } from "./history-reference";
import { LocalReadAloud, useLocalReadAloud } from "./local-read-aloud";
import { MemorySettings } from "./memory-settings";
import { MessageContent } from "./message-content";
import { Modal } from "./modal";
import { OrganizationPanel } from "./organization-panel";
import { ProjectMemorySources } from "./project-memory-sources";
import { ProductCatalogue } from "./product-catalogue";
import { ProactiveAssistant } from "./proactive-assistant";
import { ProjectsPanel } from "./projects-panel";
import { ProjectCollaboration } from "./project-collaboration";
import { RemindersPanel } from "./reminders-panel";
import { ResearchPanel } from "./research-panel";
import { RetrievalPanel } from "./retrieval-panel";
import { ReviewedCatalog } from "./reviewed-catalog";
import { SandboxConnector } from "./sandbox-connector";
import { ManageShares, PublishShare } from "./share-panel";
import { TemporaryChat } from "./temporary-chat";
import type { ShareSelection } from "@/lib/sharing";

const NEW_TITLE = "新对话";
const PROMPT_LIMIT = 8_000;
const prompts = ["把一个想法整理成行动计划", "帮我梳理一份会议纪要", "解释一个我不熟悉的概念"];
const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" });

type DialogKind = "rename" | "delete" | "restrict-sharing" | "read-lock";
type Project = components["schemas"]["Project"];
type CustomAssistantOption = components["schemas"]["CustomAssistantListItem"];
type HistoryReference = components["schemas"]["HistoryReferenceSelection"];
type ShareDialog = { conversation: Conversation } & (
  { mode: "manage" } | ({ mode: "publish" } & Pick<ShareSelection, "sourceMessageId" | "scope">)
);

function dateText(value: string) {
  return dateFormat.format(new Date(value));
}

type WorkspaceProps = {
  client: AssistantClient;
  user: User;
  onExpire: () => void;
  onLogout: () => Promise<void>;
  onErase: (input: AccountErasureRequest) => Promise<void>;
  onSwitchWorkspace: (workspaceId: string) => Promise<void>;
  onReturnPersonalWorkspace: () => Promise<void>;
  initialConversation?: Conversation | null;
};

export function Workspace({ client, user, onExpire, onLogout, onErase, onSwitchWorkspace, onReturnPersonalWorkspace,
  initialConversation }: WorkspaceProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationCursor, setConversationCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Conversation | null>(initialConversation ?? null);
  const selectedNow = useRef(selected?.id);
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim());
  const [archived, setArchived] = useState(false);
  const [listVersion, setListVersion] = useState(0);
  const [listBusy, setListBusy] = useState(true);
  const [listError, setListError] = useState("");
  const listRequest = useRef(0);
  const [history, setHistory] = useState<Message[]>([]);
  const [historyBusy, setHistoryBusy] = useState(!!initialConversation);
  const [historyError, setHistoryError] = useState("");
  const historyRequest = useRef<AbortController | null>(null);
  const [leafId, setLeafId] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ id: string; content: string }>();
  const [models, setModels] = useState<TextModel[]>([]);
  const [modelId, setModelId] = useState("");
  const [modelError, setModelError] = useState("");
  const [modelVersion, setModelVersion] = useState(0);
  const [drawer, setDrawer] = useState(false);
  const drawerTrigger = useRef<HTMLButtonElement>(null);
  const menuTrigger = useRef<HTMLElement>(null);
  const projectsTrigger = useRef<HTMLButtonElement>(null);
  const jobsTrigger = useRef<HTMLButtonElement>(null);
  const featureOpener = useRef<HTMLElement | null>(null);
  const [features, setFeatures] = useState({
    projects: false, jobs: false, sharing: false, retrieval: false, projectResources: false,
    analysis: false, temporaryChat: false, memory: false, attachments: false, research: false, reminders: false,
    audioAttachments: false, audioUploads: false, pdfAttachments: false, pdfUploads: false, generalPdf: false, pdfOcr: false, localPngEdits: false,
    customAssistants: false, customRuns: false, reminderTemplates: false, artifacts: false,
    collaboration: false, artifactPublications: false,
    spreadsheets: false, slides: false, codeDrafts: false, webpages: false, hostedWebpages: false, imageAssets: false,
    artifactComments: false, sharedDrafts: false, workspaceDeparture: false, webpagePublications: false, imagePublications: false,
    sheetPublications: false, slidesPublications: false, codePublications: false, typedReplyArtifacts: false,
    conversationReadLock: false, lockedConversations: false,
    historyReferences: false, sandboxConnector: false, eventReminders: false, syntheticCatalogue: false, organizations: false,
    organizationPolicies: false, organizationUsage: false, organizationModelBudget: false, organizationDirectory: false, proactiveAssistant: false,
    reviewedCatalog: false, catalogConnectorSubmission: false, guardianEligibility: false,
  });
  const [sharing, setSharing] = useState<ShareDialog>();
  const [projectScope, setProjectScope] = useState<Project | null>();
  const [projectsOpen, setProjectsOpen] = useState<"browse" | "move">();
  const [jobsOpen, setJobsOpen] = useState<{ source?: { conversationId: string; messageId: string; title: string } }>();
  const [retrievalOpen, setRetrievalOpen] = useState(false);
  const retrievalTrigger = useRef<HTMLButtonElement>(null);
  const [researchOpen, setResearchOpen] = useState(false);
  const researchTrigger = useRef<HTMLButtonElement>(null);
  const [sandboxConnectorOpen, setSandboxConnectorOpen] = useState(false);
  const sandboxConnectorTrigger = useRef<HTMLButtonElement>(null);
  const [eventRemindersOpen, setEventRemindersOpen] = useState(false);
  const eventRemindersTrigger = useRef<HTMLButtonElement>(null);
  const [catalogueOpen, setCatalogueOpen] = useState(false);
  const catalogueTrigger = useRef<HTMLButtonElement>(null);
  const [organizationOpen, setOrganizationOpen] = useState(false);
  const [reviewedCatalogOpen, setReviewedCatalogOpen] = useState(false);
  const reviewedCatalogTrigger = useRef<HTMLButtonElement>(null);
  const [guardianEligibilityOpen, setGuardianEligibilityOpen] = useState(false);
  const guardianEligibilityTrigger = useRef<HTMLButtonElement>(null);
  const organizationTrigger = useRef<HTMLButtonElement>(null);
  const [proactiveOpen, setProactiveOpen] = useState(false);
  const proactiveTrigger = useRef<HTMLButtonElement>(null);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [unreadReminders, setUnreadReminders] = useState(0);
  const remindersTrigger = useRef<HTMLButtonElement>(null);
  const [customAssistantsOpen, setCustomAssistantsOpen] = useState(false);
  const customAssistantsTrigger = useRef<HTMLButtonElement>(null);
  const [customOptions, setCustomOptions] = useState<CustomAssistantOption[]>([]);
  const [customVersionId, setCustomVersionId] = useState("");
  const [learningOpen, setLearningOpen] = useState(false);
  const learningTrigger = useRef<HTMLButtonElement>(null);
  const [artifactPanel, setArtifactPanel] = useState<{ source?: { id: string; title: string; content: string }; project?: string | null }>();
  const artifactsTrigger = useRef<HTMLButtonElement>(null);
  const [collaborationOpen, setCollaborationOpen] = useState(false);
  const collaborationTrigger = useRef<HTMLButtonElement>(null);
  const temporaryTrigger = useRef<HTMLButtonElement>(null);
  const [temporaryOpen, setTemporaryOpen] = useState(false);
  const memoryTrigger = useRef<HTMLButtonElement>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [lockedConversationsOpen, setLockedConversationsOpen] = useState(false);
  const lockedConversationsTrigger = useRef<HTMLButtonElement>(null);
  const [readChecking, setReadChecking] = useState(false);
  const [readNotice, setReadNotice] = useState("");
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const [historyReference, setHistoryReference] = useState<HistoryReference>();
  const [memorySourceMessage, setMemorySourceMessage] = useState<string>();
  const accountTrigger = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState<DialogKind>();
  const [actionBusy, setActionBusy] = useState(false);
  const actionLock = useRef(false);
  const [actionError, setActionError] = useState("");
  const [sendError, setSendError] = useState("");
  const [offline, setOffline] = useState(false);
  const messageList = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const composerId = useId();
  const selectedId = selected?.id;
  const draftKey = selectedId ?? "";
  const draft = editing?.content ?? drafts[draftKey] ?? "";
  const generation = useRun(client, onExpire);
  const discardRun = generation.discardConversation;
  const protectConversation = features.conversationReadLock || features.lockedConversations;
  const discardLockedConversation = useCallback((id: string) => {
    if (selectedNow.current !== id) return;
    selectedNow.current = undefined;
    historyRequest.current?.abort();
    listRequest.current += 1;
    discardRun(id);
    setSelected(null);
    setHistory([]);
    setLeafId(undefined);
    setDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setConversations((current) => current.filter((entry) => entry.id !== id));
    setEditing(undefined);
    setSharing(undefined);
    setArtifactPanel(undefined);
    setJobsOpen(undefined);
    setReferencePickerOpen(false);
    setHistoryReference(undefined);
    setMemorySourceMessage(undefined);
    setDialog(undefined);
    setHistoryBusy(false);
    setHistoryError("");
    setSendError("");
    setReadChecking(false);
    setReadNotice("此对话已加锁。可在加锁列表中恢复阅读。");
    setListVersion((version) => version + 1);
  }, [discardRun]);
  const snapshot = generation.run?.snapshot;
  const active = isActive(snapshot ?? null);
  const currentRun = snapshot?.conversationId === selectedId ? snapshot : undefined;
  const runBusy = generation.starting || generation.stopping || active;
  const model = models.find((item) => item.id === modelId);
  const branch = useMemo(() => messagePath(history, leafId), [history, leafId]);
  const branchEnd = branch.at(-1);
  const readAloud = useLocalReadAloud(selectedId, branchEnd?.id, user.preferences.locale);
  const projectId = projectScope?.id ?? (projectScope === null ? null : undefined);
  const customProjectId = selected ? selected.projectId ?? null : projectScope?.id ?? null;
  const allowCustomRun = features.customRuns && modelId === "local-echo";
  const scopedCustomOptions = customOptions.filter((item) => item.status === "active"
    && (item.projectId ?? null) === customProjectId);
  const chosenCustom = scopedCustomOptions.find((item) => item.headVersionId === customVersionId);
  const staleCustom = allowCustomRun && !!customVersionId && !chosenCustom;
  const customAssistant = allowCustomRun && chosenCustom
    ? { id: chosenCustom.id, versionId: chosenCustom.headVersionId } : undefined;
  const canReferenceHistory = features.historyReferences && modelId === "local-echo" && !customVersionId &&
    !selected?.projectId && !projectScope?.id && !editing;
  const leaves = useMemo(() => {
    const parents = new Set(history.map((message) => message.parentId));
    return history.filter((message) => !parents.has(message.id));
  }, [history]);
  const knownRunInput = generation.run?.input;
  const pendingContent = currentRun && knownRunInput && knownRunInput.action !== "regenerate" &&
    !history.some((message) => message.role === "user" && message.content === knownRunInput.content &&
      message.parentId === (knownRunInput.action === "send" ? (knownRunInput.parentId ?? null) :
        history.find((candidate) => candidate.id === knownRunInput.messageId)?.parentId))
    ? knownRunInput.content : "";

  const describeError = useCallback((error: unknown, fallback: string) => {
    if (error instanceof AssistantApiError && error.status === 401) {
      onExpire();
      return "";
    }
    return errorText(error, fallback);
  }, [onExpire]);

  useEffect(() => {
    if (offline) return;
    let current = true;
    client.getCapabilities().then(({ capabilities }) => {
      if (!current) return;
      const available = new Set(capabilities.filter((capability) => capability.available).map(({ id }) => id));
      setFeatures({
        projects: available.has("projects"),
        jobs: available.has("background_tasks"),
        sharing: available.has("conversation_sharing"),
        retrieval: available.has("source_retrieval"),
        projectResources: available.has("project_resources"),
        analysis: available.has("data_analysis"),
        temporaryChat: available.has("temporary_chat"),
        memory: available.has("manual_memory"),
        attachments: available.has("project_attachments"),
        audioAttachments: available.has("project_audio_attachments"),
        audioUploads: available.has("project_audio_uploads"),
        pdfAttachments: available.has("project_pdf_attachments"),
        pdfUploads: available.has("project_pdf_uploads"),
        generalPdf: available.has("project_general_pdf"),
        pdfOcr: available.has("project_pdf_ocr"),
        localPngEdits: available.has("project_local_image_edits"),
        research: available.has("curated_research"),
        reminders: available.has("scheduled_reminders"),
        reminderTemplates: available.has("reminder_templates"),
        customAssistants: available.has("custom_assistants"),
        customRuns: available.has("local_custom_assistant_runs"),
        artifacts: available.has("private_artifacts"),
        collaboration: available.has("project_collaboration"),
        artifactPublications: available.has("project_artifact_publications"),
        spreadsheets: available.has("private_spreadsheets"),
        slides: available.has("private_slides"),
        codeDrafts: available.has("private_code_drafts"),
        webpages: available.has("private_webpages"),
        hostedWebpages: available.has("public_webpage_hosting"),
        imageAssets: available.has("private_image_assets"),
        webpagePublications: available.has("project_webpage_publications"),
        imagePublications: available.has("project_image_publications"),
        sheetPublications: available.has("project_spreadsheet_publications"),
        slidesPublications: available.has("project_slide_publications"),
        codePublications: available.has("project_code_publications"),
        typedReplyArtifacts: available.has("typed_reply_artifacts"),
        conversationReadLock: available.has("conversation_read_lock"),
        lockedConversations: available.has("locked_conversations"),
        historyReferences: available.has("explicit_history_references"),
        sandboxConnector: available.has("sandbox_connector"),
        eventReminders: available.has("sandbox_event_reminders"),
        syntheticCatalogue: available.has("synthetic_product_catalogue"),
        organizations: available.has("organizations"),
        organizationPolicies: available.has("organization_policies"),
        organizationUsage: available.has("organization_usage"),
        organizationModelBudget: available.has("organization_model_budget"),
        organizationDirectory: available.has("organization_directory"),
        proactiveAssistant: available.has("local_proactive_assistant"),
        reviewedCatalog: available.has("reviewed_catalog"),
        catalogConnectorSubmission: available.has("reviewed_catalog_connector_submission"),
        guardianEligibility: available.has("local_guardian_eligibility"),
        artifactComments: available.has("project_artifact_comments"),
        sharedDrafts: available.has("project_shared_drafts"),
        workspaceDeparture: available.has("workspace_departure"),
      });
    }).catch(() => {});
    return () => { current = false; };
  }, [client, offline, modelVersion]);

  useEffect(() => {
    if (!features.customRuns || offline || customAssistantsOpen) return;
    const request = new AbortController();
    client.listCustomAssistants({ limit: 16 }, request.signal).then(({ items }) => {
      if (!request.signal.aborted) setCustomOptions(items);
    }).catch(() => {});
    return () => request.abort();
  }, [client, features.customRuns, offline, customAssistantsOpen]);

  useEffect(() => {
    if (!canReferenceHistory) { setHistoryReference(undefined); setReferencePickerOpen(false); }
  }, [canReferenceHistory]);

  useEffect(() => {
    if (!features.reminders) {
      setUnreadReminders(0);
      return;
    }
    if (offline || remindersOpen) return;
    const request = new AbortController();
    let loading = false;
    async function updateUnread() {
      if (document.visibilityState !== "visible" || loading) return;
      loading = true;
      try {
        const { items } = await client.listReminderOccurrences({ limit: 20 }, request.signal);
        if (!request.signal.aborted) setUnreadReminders(items.filter((item) => item.outcome === "delivered" && !item.readAt).length);
      } catch {
        // The reminder panel can retry on demand and show request errors.
      } finally {
        loading = false;
      }
    }
    void updateUnread();
    const timer = window.setInterval(() => void updateUnread(), 30_000);
    document.addEventListener("visibilitychange", updateUnread);
    return () => {
      request.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", updateUnread);
    };
  }, [client, features.reminders, offline, remindersOpen]);

  useEffect(() => {
    function updateConnectivity() { setOffline(!navigator.onLine); }
    const desktop = window.matchMedia("(min-width: 701px)");
    function closeDrawer() { if (desktop.matches) setDrawer(false); }
    updateConnectivity();
    window.addEventListener("online", updateConnectivity);
    window.addEventListener("offline", updateConnectivity);
    desktop.addEventListener("change", closeDrawer);
    return () => {
      window.removeEventListener("online", updateConnectivity);
      window.removeEventListener("offline", updateConnectivity);
      desktop.removeEventListener("change", closeDrawer);
    };
  }, []);

  async function loadList(cursor?: string) {
    const requestNumber = ++listRequest.current;
    setListBusy(true);
    setListError("");
    try {
      const page = await client.listConversations({ q: query || undefined, archived, cursor, limit: 30,
        projectId: projectId ?? undefined, unfiled: projectId === null || undefined });
      if (requestNumber !== listRequest.current) return;
      setConversations((current) => cursor ? [...current, ...page.items.filter((item) => !current.some((known) => known.id === item.id))] : page.items);
      setConversationCursor(page.nextCursor);
    } catch (error) {
      if (requestNumber === listRequest.current) setListError(describeError(error, "暂时无法读取对话列表。"));
    } finally {
      if (requestNumber === listRequest.current) setListBusy(false);
    }
  }

  useEffect(() => {
    setConversationCursor(null);
    void loadList();
    return () => { listRequest.current += 1; };
  }, [query, archived, listVersion, projectId]); // The current query is captured for each request.

  const loadHistory = useCallback(async (id: string, reset: boolean, latestLeaf?: string) => {
    historyRequest.current?.abort();
    const request = new AbortController();
    historyRequest.current = request;
    setHistoryBusy(true);
    setHistoryError("");
    if (reset) {
      setHistory([]);
      setLeafId(undefined);
    }
    try {
      const messages = await readHistory(client, id, request.signal);
      setHistory(messages);
      if (latestLeaf) setLeafId(latestLeaf);
    } catch (error) {
      if (!request.signal.aborted) {
        if (error instanceof AssistantApiError && error.status === 423) discardLockedConversation(id);
        else setHistoryError(describeError(error, "暂时无法加载消息。"));
      }
    } finally {
      if (!request.signal.aborted) setHistoryBusy(false);
    }
  }, [client, describeError, discardLockedConversation]);

  useEffect(() => {
    if (selectedId) void loadHistory(selectedId, true);
    else {
      setHistory([]);
      setHistoryBusy(false);
      setHistoryError("");
    }
    return () => historyRequest.current?.abort();
  }, [selectedId, loadHistory]);

  useEffect(() => {
    if (!selectedId || !protectConversation) { setReadChecking(false); return; }
    const id = selectedId;
    const request = new AbortController();
    let checking = false;
    async function verify() {
      if (request.signal.aborted || document.hidden || checking) return;
      checking = true;
      try {
        await client.getConversation(id, request.signal);
        if (!request.signal.aborted && !document.hidden) setReadChecking(false);
      } catch (failure) {
        if (request.signal.aborted) return;
        if (failure instanceof AssistantApiError && failure.status === 423) discardLockedConversation(id);
        else if (failure instanceof AssistantApiError && failure.status === 401) onExpire();
      } finally {
        checking = false;
      }
    }
    function visibilityChanged() {
      if (document.hidden) {
        setReadChecking(true);
        setSharing(undefined);
        setArtifactPanel(undefined);
        setJobsOpen(undefined);
        setReferencePickerOpen(false);
        setMemorySourceMessage(undefined);
        setDialog(undefined);
        listRequest.current += 1;
        setConversations([]);
      } else {
        setListVersion((version) => version + 1);
        void verify();
      }
    }
    function pageHidden() { setReadChecking(true); }
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("pagehide", pageHidden);
    window.addEventListener("pageshow", visibilityChanged);
    window.addEventListener("online", visibilityChanged);
    const refresh = window.setInterval(() => void verify(), 15_000);
    return () => {
      request.abort();
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("pagehide", pageHidden);
      window.removeEventListener("pageshow", visibilityChanged);
      window.removeEventListener("online", visibilityChanged);
      window.clearInterval(refresh);
    };
  }, [client, discardLockedConversation, onExpire, protectConversation, selectedId]);

  const terminalSequence = currentRun && !isActive(currentRun) ? currentRun.lastSequence : undefined;
  const terminalMessage = currentRun && !isActive(currentRun) ? currentRun.messageId : undefined;
  const terminalId = currentRun && !isActive(currentRun) ? currentRun.runId : undefined;
  useEffect(() => {
    if (selectedId && terminalId && terminalSequence !== undefined) {
      void loadHistory(selectedId, false, terminalMessage);
      setListVersion((version) => version + 1);
    }
  }, [selectedId, terminalId, terminalSequence, terminalMessage, loadHistory]);

  useEffect(() => {
    if (followBottom.current && messageList.current) messageList.current.scrollTop = messageList.current.scrollHeight;
  }, [history, snapshot?.content, selectedId, leafId, pendingContent]);

  useEffect(() => {
    let subscribed = true;
    setModelError("");
    client.listModels().then(({ models: available }) => {
      if (!subscribed) return;
      setModels(available);
      setModelId((current) => available.some((item) => item.id === current) ? current : available[0]?.id ?? "");
      if (!available.length) setModelError("目前没有可用的模型。");
    }).catch((error: unknown) => {
      if (subscribed) setModelError(describeError(error, "暂时无法读取模型目录。"));
    });
    return () => { subscribed = false; };
  }, [client, describeError, modelVersion]);

  function choose(conversation: Conversation | null, keepCustom = false) {
    selectedNow.current = conversation?.id;
    if (conversation?.id !== selectedId) {
      setHistoryReference(undefined);
      setReferencePickerOpen(false);
      setMemorySourceMessage(undefined);
      if (!keepCustom) setCustomVersionId("");
      historyRequest.current?.abort();
      setHistoryBusy(Boolean(conversation));
      setHistory([]);
      setHistoryError("");
      setLeafId(undefined);
    }
    setSelected(conversation);
    setReadChecking(false);
    setReadNotice("");
    setDrawer(false);
    setActionError("");
    setSendError("");
    setEditing(undefined);
    followBottom.current = true;
  }

  function changeDraft(value: string) {
    if (editing) setEditing({ ...editing, content: value });
    else setDrafts((current) => ({ ...current, [draftKey]: value }));
  }

  async function create(select = true) {
    if (actionLock.current) return;
    actionLock.current = true;
    setActionBusy(true);
    setActionError("");
    try {
      const added = await client.createConversation({ title: NEW_TITLE, projectId: projectId ?? undefined });
      if (select) choose(added);
      setSearch("");
      setArchived(false);
      setListVersion((version) => version + 1);
      return added;
    } catch (error) {
      setActionError(describeError(error, "暂时无法创建对话。"));
    } finally {
      actionLock.current = false;
      setActionBusy(false);
    }
  }

  async function update(input: ConversationPatch) {
    if (!selected || actionLock.current) return;
    const id = selected.id;
    actionLock.current = true;
    setActionBusy(true);
    setActionError("");
    try {
      const updated = await client.updateConversation(id, input);
      setSelected((current) => current?.id === id ? updated : current);
      setDialog(undefined);
      if (input.archived !== undefined) setArchived(input.archived);
      setListVersion((version) => version + 1);
    } catch (error) {
      setActionError(describeError(error, "暂时无法更新对话。"));
    } finally {
      actionLock.current = false;
      setActionBusy(false);
    }
  }

  async function remove() {
    if (!selected || actionLock.current) return;
    const id = selected.id;
    actionLock.current = true;
    setActionBusy(true);
    setActionError("");
    try {
      await client.deleteConversation(id);
      setDrafts((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      choose(null);
      setDialog(undefined);
      setListVersion((version) => version + 1);
    } catch (error) {
      setActionError(describeError(error, "暂时无法删除对话。"));
    } finally {
      actionLock.current = false;
      setActionBusy(false);
    }
  }

  async function restrictSharing() {
    if (!selected || actionLock.current) return;
    const { id, sharingRestricted } = selected;
    actionLock.current = true;
    setActionBusy(true);
    setActionError("");
    try {
      const updated = await client.setConversationSharingRestriction(id, !sharingRestricted);
      setSelected((current) => current?.id === id ? updated : current);
      setListVersion((version) => version + 1);
      setDialog(undefined);
    } catch (error) {
      setActionError(describeError(error, "暂时无法更新分享权限。"));
    } finally {
      actionLock.current = false;
      setActionBusy(false);
    }
  }

  async function lockReading() {
    if (!selected || actionLock.current || offline || !features.conversationReadLock) return;
    const id = selected.id;
    actionLock.current = true;
    setActionBusy(true);
    setActionError("");
    try {
      await client.lockConversationReading(id);
      discardLockedConversation(id);
    } catch (failure) {
      setActionError(describeError(failure, "暂时无法加锁。"));
    } finally {
      actionLock.current = false;
      setActionBusy(false);
    }
  }

  async function downloadCurrentConversation() {
    if (!selected || !branch.length || readChecking) return;
    const id = selected.id;
    try {
      const current = protectConversation ? await client.getConversation(id) : selected;
      if (selectedNow.current === id && (!protectConversation || !document.hidden)) downloadConversation(current.title, branch);
    } catch (failure) {
      if (failure instanceof AssistantApiError && failure.status === 423) discardLockedConversation(id);
      else setActionError(describeError(failure, "暂时无法确认下载权限。"));
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft;
    const reference = canReferenceHistory ? historyReference : undefined;
    if (!content.trim() || !modelId || selected?.archived || runBusy || offline || historyBusy || historyError ||
      actionLock.current || staleCustom) return;
    if ([...content].length > PROMPT_LIMIT) {
      setSendError("消息最多可包含 8,000 个字符。");
      return;
    }
    let target = selected;
    if (!target) {
      const created = await create(false);
      if (!created) return;
      target = created;
      setDrafts((current) => ({ ...current, "": "", [created.id]: draft }));
      choose(created, true);
    }
    const input: RunRequest = editing ? { action: "edit", messageId: editing.id, content, modelId, customAssistant } :
      { action: "send", content, parentId: branchEnd?.id, modelId, customAssistant, historyReference: reference };
    await start(target.id, input, () => {
      if (editing) setEditing((current) => current?.id === editing.id && current.content === content ? undefined : current);
      else setDrafts((current) => current[target.id] === content ? { ...current, [target.id]: "" } : current);
      if (reference) setHistoryReference((current) => current === reference ? undefined : current);
    });
  }

  async function start(id: string, input: RunRequest, onSuccess?: () => void) {
    setSendError("");
    followBottom.current = true;
    try {
      const accepted = await generation.start(id, input);
      if (accepted) onSuccess?.();
    } catch (error) {
      setSendError(describeError(error, "消息未确认发送。请保留内容并重试。"));
    }
  }

  async function stop() {
    setSendError("");
    try {
      await generation.stop();
    } catch (error) {
      setSendError(describeError(error, "暂时无法停止生成。"));
    }
  }

  function renderSidebar(mobile: boolean) {
    return <>
      <div className="sidebar-heading">
        <Wordmark />
        {mobile && <button type="button" className="button icon-button" aria-label="关闭对话列表" onClick={() => setDrawer(false)}><X size={20} aria-hidden="true" /></button>}
      </div>
      <button className="button primary new-conversation" type="button" disabled={actionBusy || offline} onClick={() => void create()}>
        <Plus size={18} aria-hidden="true" /> 新建对话
      </button>
      <div className="sidebar-tools">
        {features.reminders && <button ref={mobile ? undefined : remindersTrigger} type="button" className="button" aria-haspopup="dialog"
          aria-label={unreadReminders ? `定时提醒，最近 20 条中有 ${unreadReminders} 条未读` : "定时提醒"} onClick={() => {
          featureOpener.current = mobile ? drawerTrigger.current : remindersTrigger.current;
          setDrawer(false);
          setRemindersOpen(true);
        }}><Bell size={17} aria-hidden="true" /> <span>定时提醒{unreadReminders > 0 && ` · ${unreadReminders}`}</span></button>}
        {features.research && <button ref={mobile ? undefined : researchTrigger} type="button" className="button" aria-haspopup="dialog" onClick={() => {
          featureOpener.current = mobile ? drawerTrigger.current : researchTrigger.current;
          setDrawer(false);
          setResearchOpen(true);
        }}><BookOpen size={17} aria-hidden="true" /> <span>研究任务</span></button>}
        {features.sandboxConnector && <button ref={mobile ? undefined : sandboxConnectorTrigger} type="button"
          className="button" aria-haspopup="dialog" onClick={() => {
            featureOpener.current = mobile ? drawerTrigger.current : sandboxConnectorTrigger.current;
            setDrawer(false);
            setSandboxConnectorOpen(true);
          }}><Plug size={17} aria-hidden="true" /> <span>连接器沙箱</span></button>}
        {features.eventReminders && <button ref={mobile ? undefined : eventRemindersTrigger} type="button"
          className="button" aria-haspopup="dialog" onClick={() => {
            featureOpener.current = mobile ? drawerTrigger.current : eventRemindersTrigger.current;
            setDrawer(false);
            setEventRemindersOpen(true);
          }}><Bell size={17} aria-hidden="true" /> <span>连接器事件提醒</span></button>}
        {features.syntheticCatalogue && <button ref={mobile ? undefined : catalogueTrigger} type="button"
          className="button" aria-haspopup="dialog" onClick={() => {
            featureOpener.current = mobile ? drawerTrigger.current : catalogueTrigger.current;
            setDrawer(false);
            setCatalogueOpen(true);
          }}><ShoppingBag size={17} aria-hidden="true" /> <span>合成商品目录</span></button>}
        {features.organizations && <button ref={mobile ? undefined : organizationTrigger} type="button"
          className="button" aria-haspopup="dialog" onClick={() => {
            featureOpener.current = mobile ? drawerTrigger.current : organizationTrigger.current;
            setDrawer(false);
            setOrganizationOpen(true);
          }}><Building2 size={17} aria-hidden="true" /> <span>组织与座席</span></button>}
        {features.reviewedCatalog && <button ref={mobile ? undefined : reviewedCatalogTrigger} type="button"
          className="button" aria-haspopup="dialog" onClick={() => {
            featureOpener.current = mobile ? drawerTrigger.current : reviewedCatalogTrigger.current;
            setDrawer(false);
            setReviewedCatalogOpen(true);
          }}><BookOpen size={17} aria-hidden="true" /> <span>已审核目录</span></button>}
        {features.guardianEligibility && <button ref={mobile ? undefined : guardianEligibilityTrigger} type="button"
          className="button" aria-haspopup="dialog" onClick={() => {
            featureOpener.current = mobile ? drawerTrigger.current : guardianEligibilityTrigger.current;
            setDrawer(false);
            setGuardianEligibilityOpen(true);
          }}><Settings2 size={17} aria-hidden="true" /> <span>使用资格与监护</span></button>}
        {features.proactiveAssistant && <button ref={mobile ? undefined : proactiveTrigger} type="button"
          className="button" aria-haspopup="dialog" onClick={() => {
            featureOpener.current = mobile ? drawerTrigger.current : proactiveTrigger.current;
            setDrawer(false);
            setProactiveOpen(true);
          }}><Lightbulb size={17} aria-hidden="true" /> <span>主动建议</span></button>}
        <button ref={mobile ? undefined : learningTrigger} type="button" className="button" aria-haspopup="dialog" onClick={() => {
          featureOpener.current = mobile ? drawerTrigger.current : learningTrigger.current;
          setDrawer(false);
          setLearningOpen(true);
        }}><GraduationCap size={17} aria-hidden="true" /> <span>学习模式</span></button>
        {features.customAssistants && <button ref={mobile ? undefined : customAssistantsTrigger} type="button"
          className="button" aria-haspopup="dialog" onClick={() => {
          featureOpener.current = mobile ? drawerTrigger.current : customAssistantsTrigger.current;
          setDrawer(false);
          setCustomAssistantsOpen(true);
        }}><Settings2 size={17} aria-hidden="true" /> <span>定制助手</span></button>}
        {features.artifacts && <button ref={mobile ? undefined : artifactsTrigger} type="button" className="button" aria-haspopup="dialog"
          onClick={() => {
            featureOpener.current = mobile ? drawerTrigger.current : artifactsTrigger.current;
            setDrawer(false);
            setArtifactPanel({ project: projectId });
          }}><FileText size={17} aria-hidden="true" /> <span>文稿</span></button>}
        {features.lockedConversations && <button ref={mobile ? undefined : lockedConversationsTrigger} type="button"
          className="button" aria-haspopup="dialog" onClick={() => {
            featureOpener.current = mobile ? drawerTrigger.current : lockedConversationsTrigger.current;
            setDrawer(false);
            setLockedConversationsOpen(true);
          }}><Lock size={17} aria-hidden="true" /> 加锁的对话</button>}
        {features.collaboration && <button ref={mobile ? undefined : collaborationTrigger} type="button" className="button" aria-haspopup="dialog"
          onClick={() => {
            featureOpener.current = mobile ? drawerTrigger.current : collaborationTrigger.current;
            setDrawer(false);
            setCollaborationOpen(true);
          }}><Users size={17} aria-hidden="true" /> <span>项目协作</span></button>}
        {features.projects && <button ref={mobile ? undefined : projectsTrigger} type="button" className="button" aria-haspopup="dialog" onClick={() => {
          featureOpener.current = mobile ? drawerTrigger.current : projectsTrigger.current;
          setDrawer(false);
          setProjectsOpen("browse");
        }}><FolderOpen size={17} aria-hidden="true" /> <span>{projectScope?.name ?? (projectScope === null ? "未归类" : "项目")}</span></button>}
        {features.jobs && <button ref={mobile ? undefined : jobsTrigger} type="button" className="button" aria-haspopup="dialog" onClick={() => {
          featureOpener.current = mobile ? drawerTrigger.current : jobsTrigger.current;
          setDrawer(false);
          setJobsOpen({});
        }}><History size={17} aria-hidden="true" /> <span>后台任务</span></button>}
        {features.retrieval && <button ref={mobile ? undefined : retrievalTrigger} type="button" className="button" aria-haspopup="dialog" onClick={() => {
          featureOpener.current = mobile ? drawerTrigger.current : retrievalTrigger.current;
          setDrawer(false);
          setRetrievalOpen(true);
        }}><Search size={17} aria-hidden="true" /> <span>来源检索</span></button>}
        {features.temporaryChat && <button ref={mobile ? undefined : temporaryTrigger} type="button" className="button" aria-haspopup="dialog" onClick={() => {
          featureOpener.current = mobile ? drawerTrigger.current : temporaryTrigger.current;
          setDrawer(false);
          setTemporaryOpen(true);
        }}><MessageCircleDashed size={17} aria-hidden="true" /> <span>临时对话</span></button>}
        {features.memory && <button ref={mobile ? undefined : memoryTrigger} type="button" className="button" aria-haspopup="dialog" onClick={() => {
          featureOpener.current = mobile ? drawerTrigger.current : memoryTrigger.current;
          setDrawer(false);
          setMemoryOpen(true);
        }}><Brain size={17} aria-hidden="true" /> <span>个人记忆</span></button>}
      </div>
      <label className="search-box">
        <Search size={18} aria-hidden="true" />
        <span className="visually-hidden">搜索对话</span>
        <input type="search" placeholder="搜索对话" value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
      <div className="archive-filter" aria-label="对话筛选">
        <button type="button" className="button" aria-pressed={!archived} onClick={() => setArchived(false)}>进行中</button>
        <button type="button" className="button" aria-pressed={archived} onClick={() => setArchived(true)}>已归档</button>
      </div>
      <nav className="conversation-nav" aria-label="对话列表">
        {listError && <div className="list-notice">
          <p role="alert">{listError}</p>
          <button type="button" className="button link-button" onClick={() => setListVersion((version) => version + 1)}>重试</button>
        </div>}
        {!listError && !conversations.length && <p className="list-notice" role="status">
          {listBusy ? "正在读取对话…" : query ? "没有匹配的对话。" : archived ? "暂无归档对话。" : "暂无对话。"}
        </p>}
        {conversations.map((conversation) => (
          <button key={conversation.id} className="button conversation" type="button"
            aria-current={selectedId === conversation.id ? "true" : undefined} onClick={() => choose(conversation)} disabled={actionBusy}>
            {conversation.pinned ? <Pin size={17} aria-hidden="true" /> : <MessageCircle size={17} aria-hidden="true" />}
            <span className="conversation-content"><span>{conversation.title}</span><small>{dateText(conversation.updatedAt)}</small></span>
          </button>
        ))}
        {conversationCursor && <button type="button" className="button load-more" onClick={() => void loadList(conversationCursor)} disabled={listBusy}>
          {listBusy ? "正在加载…" : "加载更多对话"}
        </button>}
      </nav>
      <div className="sidebar-account">
        <button type="button" className="button account-trigger" aria-haspopup="dialog"
          aria-label={`账号与数据 · ${user.username}`} title="账号与数据" onClick={(event) => {
            accountTrigger.current = event.currentTarget;
            setAccountOpen(true);
          }}>
          <span className="avatar" aria-hidden="true">{user.username.slice(0, 2).toUpperCase()}</span>
          <span className="account-name">{user.username}</span>
        </button>
        <button className="button icon-button" type="button" aria-label="退出登录" title="退出登录" onClick={() => void onLogout()}>
          <LogOut size={19} aria-hidden="true" />
        </button>
      </div>
    </>;
  }

  function renderMessage(message: Message) {
    return <article key={message.id} className={`message message-${message.role}`} aria-label={message.role === "user" ? "你的消息" : "助手回复"}>
      <header className="message-author">
        {message.role === "assistant" && <Leaf size={18} aria-hidden="true" />}
        <h2>{message.role === "user" ? "你" : "青屿助手"}</h2>
      </header>
      {message.role === "assistant" ? <MessageContent content={message.content} /> : <p className="message-plain">{message.content}</p>}
      {message.generation && <GenerationDetails generation={message.generation} />}
      <div className="message-actions">
        {!selected?.archived && (message.role === "user" ? <button type="button" className="button compact-button"
          disabled={runBusy || historyBusy || !modelId || offline} onClick={() => {
            setEditing({ id: message.id, content: message.content });
            composer.current?.focus();
          }}><FilePenLine size={16} aria-hidden="true" /> 编辑</button> :
          message.parentId != null && <button type="button" className="button compact-button"
            disabled={runBusy || historyBusy || !modelId || offline || staleCustom}
            onClick={() => selected && !staleCustom && void start(selected.id, {
              action: "regenerate", messageId: message.id, modelId, customAssistant,
            })}>
            <RefreshCw size={16} aria-hidden="true" /> 重新生成
          </button>)}
        {message.role === "assistant" && <>
          <LocalReadAloud id={message.id} text={message.content} playback={readAloud} />
          {selected && message.generation?.historyReferenceUsed && <HistoryReferenceDetails client={client}
            conversationId={selected.id} messageId={message.id} offline={offline} describeError={describeError}
            openSource={async (id) => choose(await client.getConversation(id))} />}
          {selected?.projectId && message.generation?.projectMemorySourcesUsed && <button type="button"
            className="button compact-button" disabled={offline || historyBusy} onClick={(event) => {
              featureOpener.current = event.currentTarget;
              setMemorySourceMessage(message.id);
            }}>查看项目记忆来源</button>}
          {features.artifacts && selected && message.generation && <button type="button" className="button compact-button"
            disabled={offline || historyBusy} onClick={(event) => {
              featureOpener.current = event.currentTarget;
              setArtifactPanel({
                project: selected.projectId,
                source: { id: message.id, title: selected.title, content: message.content },
              });
            }}><FileText size={16} aria-hidden="true" /> 保存为文稿</button>}
          {features.sharing && selected && !selected.sharingRestricted && <button type="button" className="button compact-button" disabled={offline || historyBusy}
            onClick={(event) => {
              featureOpener.current = event.currentTarget;
              setSharing({ mode: "publish", conversation: selected, sourceMessageId: message.id, scope: "reply" });
            }}><Link2 size={16} aria-hidden="true" /> 分享回复</button>}
          <ContentReport title="举报回复" disabled={offline} describeError={describeError}
            submit={(reason, signal) => client.submitReport({ targetType: "assistant_reply", targetId: message.id, reason }, signal)} />
        </>}
      </div>
    </article>;
  }

  const statusLabel = generation.streamError && active ? "连接已中断。" : generation.reconnecting ? "正在接续生成…" :
    currentRun?.state === "queued" ? "正在排队…" : currentRun?.state === "running" ? "正在生成…" :
    currentRun?.state === "cancelled" ? "已停止生成。" : currentRun?.state === "failed" ? "生成失败，请重新发送或编辑上一条消息。" : "";

  function closeAccount() {
    setAccountOpen(false);
  }

  return <div className="workspace">
    <a href="#conversation-main" className="skip-link">跳转到对话</a>
    <aside className="sidebar">{renderSidebar(false)}</aside>
    {drawer && <Modal label="对话列表" close={() => setDrawer(false)} className="mobile-drawer">
      <aside className="drawer-content">{renderSidebar(true)}</aside>
    </Modal>}
    <main className={`main-pane${readChecking ? " rechecking-conversation" : ""}`} id="conversation-main" tabIndex={-1} inert={readChecking}>
      <header className="main-header">
        <div className="header-title">
          <button ref={drawerTrigger} type="button" className="button icon-button open-drawer" aria-label="打开对话列表" aria-expanded={drawer} onClick={() => setDrawer(true)}>
            <Menu size={22} aria-hidden="true" />
          </button>
          <h1>{selected?.title ?? "对话工作区"}</h1>
          {selected?.archived && <span className="archive-label">已归档</span>}
          {selected?.sharingRestricted && <span className="archive-label">分享受限</span>}
        </div>
        {selected && <details className="conversation-menu" onKeyDown={(event) => {
          if (event.key === "Escape" && event.currentTarget.open) {
            event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }
        }}>
          <summary ref={menuTrigger} className="button">对话操作 <ChevronDown size={16} aria-hidden="true" /></summary>
          <div className="menu-lines" onClick={(event) => {
            if ((event.target as HTMLElement).closest("button:enabled")) event.currentTarget.closest("details")?.removeAttribute("open");
          }}>
            <button type="button" className="button" disabled={actionBusy || offline} onClick={() => setDialog("rename")}><FilePenLine size={17} aria-hidden="true" /> 重命名</button>
            <button type="button" className="button" disabled={actionBusy || offline} onClick={() => void update({ pinned: !selected.pinned })}>
              {selected.pinned ? <PinOff size={17} aria-hidden="true" /> : <Pin size={17} aria-hidden="true" />} {selected.pinned ? "取消置顶" : "置顶"}
            </button>
            <button type="button" className="button" disabled={actionBusy || offline || active && !!currentRun} onClick={() => void update({ archived: !selected.archived })}>
              {selected.archived ? <ArchiveRestore size={17} aria-hidden="true" /> : <Archive size={17} aria-hidden="true" />} {selected.archived ? "恢复对话" : "归档"}
            </button>
            <button type="button" className="button" disabled={!branch.length || historyBusy || (protectConversation && offline)}
              onClick={() => void downloadCurrentConversation()}><Download size={17} aria-hidden="true" /> 下载对话</button>
            {features.conversationReadLock && <button type="button" className="button" disabled={actionBusy || offline || generation.starting}
              onClick={() => { setActionError(""); setDialog("read-lock"); }}><Lock size={17} aria-hidden="true" /> 加锁对话</button>}
            {features.sharing && <>
              <button type="button" className="button" disabled={!branchEnd || historyBusy || !!historyError || offline || selected.sharingRestricted} onClick={() => {
                if (!branchEnd) return;
                featureOpener.current = menuTrigger.current;
                setSharing({ mode: "publish", conversation: selected, sourceMessageId: branchEnd.id, scope: "branch" });
              }}><Link2 size={17} aria-hidden="true" /> 分享当前分支</button>
              <button type="button" className="button" disabled={offline} onClick={() => {
                featureOpener.current = menuTrigger.current;
                setSharing({ mode: "manage", conversation: selected });
              }}><Link2 size={17} aria-hidden="true" /> 管理分享</button>
              {selected.sharingRestricted !== undefined && <button type="button" className="button" disabled={actionBusy || offline}
                onClick={() => { setActionError(""); setDialog("restrict-sharing"); }}>
                {selected.sharingRestricted ? <LockOpen size={17} aria-hidden="true" /> : <Lock size={17} aria-hidden="true" />}
                {selected.sharingRestricted ? "允许新分享" : "限制分享"}
              </button>}
            </>}
            {features.projects && <button type="button" className="button" disabled={actionBusy || offline} onClick={() => {
              featureOpener.current = menuTrigger.current;
              setProjectsOpen("move");
            }}><FolderOpen size={17} aria-hidden="true" /> 移动到项目</button>}
            {features.jobs && <button type="button" className="button" disabled={!branchEnd || historyBusy || !!historyError || offline} onClick={() => {
              if (!branchEnd) return;
              featureOpener.current = menuTrigger.current;
              setJobsOpen({ source: { conversationId: selected.id, messageId: branchEnd.id, title: selected.title } });
            }}><History size={17} aria-hidden="true" /> 后台导出</button>}
            <button type="button" className="button danger-text" disabled={actionBusy || offline || active && !!currentRun}
              onClick={() => setDialog("delete")}><Trash2 size={17} aria-hidden="true" /> 删除对话</button>
          </div>
        </details>}
      </header>

      {offline && <p className="status-banner" role="status"><CircleAlert size={17} aria-hidden="true" /> 网络已断开。恢复连接后可以继续对话。</p>}
      {readNotice && <p className="status-banner" role="status">{readNotice}</p>}
      {actionError && !dialog && <p className="status-banner error-box" role="alert">{actionError}</p>}
      {active && !currentRun && <div className="status-banner" role="status">
        另一条对话正在生成。<button type="button" className="button link-button" disabled={generation.stopping || offline} onClick={() => void stop()}>
          {generation.stopping ? "正在停止…" : "停止生成"}
        </button>
      </div>}

      {leaves.length > 1 && <div className="branches">
        <label>对话分支 <select value={branchEnd?.id ?? ""} disabled={runBusy || historyBusy} onChange={(event) => setLeafId(event.target.value)}>
          {leaves.map((message, index) => <option key={message.id} value={message.id}>
            {`分支 ${index + 1} · ${message.content.slice(0, 26)}`}
          </option>)}
        </select></label>
      </div>}
      <div className="message-list" ref={messageList} onScroll={(event) => {
        const { scrollHeight, clientHeight, scrollTop } = event.currentTarget;
        followBottom.current = scrollHeight - clientHeight - scrollTop < 90;
      }}>
        <div className="transcript">
          {historyBusy && !branch.length && <p className="history-notice" role="status">正在读取消息…</p>}
          {historyError && <div className="error-box" role="alert">
            {historyError} <button type="button" className="button link-button" onClick={() => selectedId && void loadHistory(selectedId, false, terminalMessage)}>重试</button>
          </div>}
          {!historyBusy && !historyError && !branch.length && !currentRun && <section className="empty-state" aria-labelledby="empty-heading">
            <span className="empty-mark"><MessageCircle size={30} aria-hidden="true" /></span>
            <h2 id="empty-heading">从一个问题开始</h2>
            <p>{selected?.archived ? "这条归档对话没有消息。恢复后即可继续。" : "输入问题，或选一个示例作为起点。"}</p>
            {!selected?.archived && <div className="prompts">{prompts.map((prompt) => (
              <button key={prompt} type="button" className="button prompt" onClick={() => {
                changeDraft(prompt);
                composer.current?.focus();
              }}>{prompt}</button>
            ))}</div>}
          </section>}
          {branch.map(renderMessage)}
          {pendingContent && <article className="message message-user" aria-label="你的消息"><header className="message-author"><h2>你</h2></header>
            <p className="message-plain">{pendingContent}</p></article>}
          {currentRun && (isActive(currentRun) || currentRun.content && !history.some((message) => message.id === currentRun.messageId)) && <>
            <article className="message message-assistant" aria-label="助手回复">
              <header className="message-author"><Leaf size={18} aria-hidden="true" /><h2>青屿助手</h2></header>
              <MessageContent content={currentRun.content} streaming={isActive(currentRun)} />
              {currentRun.modelId && currentRun.modelVersion && <GenerationDetails generation={{
                modelId: currentRun.modelId,
                modelVersion: currentRun.modelVersion,
                context: currentRun.context,
                fallbackFromModelId: currentRun.fallbackFromModelId,
              }} />}
            </article>
          </>}
          {currentRun && statusLabel && <div className="run-status" role="status">
            {statusLabel}
            {generation.streamError && active &&
              <button type="button" className="button link-button" disabled={offline} onClick={generation.resume}>尝试接续</button>}
            {currentRun.state === "failed" && knownRunInput && !selected?.archived &&
              <button type="button" className="button link-button" disabled={offline || runBusy || historyBusy || !!historyError}
                onClick={() => void start(currentRun.conversationId, knownRunInput)}>重试生成</button>}
          </div>}
        </div>
      </div>

      {!selected?.archived && <div className="composer-section">
        <form className="composer" onSubmit={submit}>
          {editing && <div className="editing-label">
            编辑消息并创建新分支
            <button type="button" className="button icon-button" aria-label="取消编辑" onClick={() => {
              setEditing(undefined);
            }}><X size={17} aria-hidden="true" /></button>
          </div>}
          <label className="visually-hidden" htmlFor={composerId}>消息</label>
          <textarea ref={composer} id={composerId} value={draft} rows={3} placeholder="输入你的消息…" aria-describedby="composer-hint"
            onChange={(event) => changeDraft(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                event.preventDefault();
                if (!runBusy && !actionBusy && !historyBusy && !historyError && !offline && modelId) event.currentTarget.form?.requestSubmit();
              }
            }} />
          {canReferenceHistory && <div className="composer-reference" aria-label="附加历史回复">
            {historyReference ? <>
              <span>已选择一条历史回复</span>
              <button type="button" className="button compact-button" disabled={runBusy}
                onClick={() => setHistoryReference(undefined)}>移除引用</button>
            </> : <button type="button" className="button compact-button" disabled={offline || runBusy || actionBusy}
              onClick={(event) => {
                featureOpener.current = event.currentTarget;
                setReferencePickerOpen(true);
              }}><Link2 size={16} aria-hidden="true" /> 引用历史回复</button>}
          </div>}
          <div className="composer-toolbar">
            <label className="model-label">模型 <select value={modelId} disabled={runBusy || !models.length} onChange={(event) => {
              setModelId(event.target.value);
              setCustomVersionId("");
            }}>
              {!models.length && <option value="">未就绪</option>}
              {models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
            </select></label>
            {allowCustomRun && (scopedCustomOptions.length > 0 || staleCustom) && <label className="model-label">
              定制助手 <select value={customVersionId} disabled={runBusy || offline}
                onChange={(event) => setCustomVersionId(event.target.value)}>
                <option value="">通用对话</option>
                {staleCustom && <option value={customVersionId} disabled>定制助手版本已变化</option>}
                {scopedCustomOptions.map((item) => <option key={item.headVersionId} value={item.headVersionId}>
                  {item.name} · 版本 {item.headVersionNumber}
                </option>)}
              </select>
            </label>}
            {active && currentRun ? <button type="button" className="button stop-button" disabled={generation.stopping || offline} onClick={() => void stop()}>
              <Square size={16} aria-hidden="true" /> {generation.stopping ? "正在停止…" : "停止"}
            </button> : <button type="submit" className="button primary" disabled={!draft.trim() || !modelId ||
              offline || runBusy || actionBusy || historyBusy || !!historyError || staleCustom}>
              <Send size={17} aria-hidden="true" /> {generation.starting ? "正在发送…" : "发送"}
            </button>}
          </div>
        </form>
        {sendError && <p className="error-box composer-error" role="alert">{sendError}</p>}
        {modelError && <div className="error-box composer-error" role="alert">
          {modelError} <button type="button" className="button link-button" disabled={offline} onClick={() => setModelVersion((version) => version + 1)}>重试</button>
        </div>}
        {model && <p className="model-details">
          版本 {model.version}{model.tier && " · " + model.tier}
          {model.contextBudget !== undefined && " · 上下文上限 " + model.contextBudget.toLocaleString("zh-CN") + " 字符"}
          {currentRun?.customAssistant && " · 已选用定制助手"}
        </p>}
        <p className="composer-hint" id="composer-hint">Enter 发送 · Shift + Enter 换行</p>
      </div>}
    </main>

    {accountOpen && <Modal label="账号与数据" close={closeAccount} className="action-dialog" returnFocus={accountTrigger}>
      <AccountData client={client} workspaceId={user.workspaceId} offline={offline}
        attachmentsAvailable={features.attachments} close={closeAccount}
        describeError={describeError} onErase={onErase} onSwitchWorkspace={onSwitchWorkspace}
        onReturnPersonalWorkspace={features.workspaceDeparture ? onReturnPersonalWorkspace : undefined} onExpire={onExpire} />
    </Modal>}

    {projectsOpen && <ProjectsPanel client={client} offline={offline} selectedProjectId={projectId}
      resourcesAvailable={features.projectResources} analysisAvailable={features.analysis}
      memoryAvailable={features.memory} attachmentsAvailable={features.attachments}
      audioAttachmentsAvailable={features.audioAttachments} audioUploadsAvailable={features.audioUploads}
      pdfAttachmentsAvailable={features.pdfAttachments} pdfUploadsAvailable={features.pdfUploads}
      generalPdfAvailable={features.generalPdf}
      pdfOcrAvailable={features.pdfOcr}
      localImageEditsAvailable={features.localPngEdits}
      conversation={projectsOpen === "move" ? selected : null} mode={projectsOpen} returnFocus={featureOpener}
      close={() => setProjectsOpen(undefined)} describeError={describeError} onSelect={(project) => {
        const changed = project?.id !== projectScope?.id || (project === null) !== (projectScope === null);
        setProjectScope(project);
        if (changed && project !== undefined && selected?.projectId !== project?.id) choose(null);
        if (changed) setSearch("");
      }} onMoved={(conversation) => {
        setSelected((current) => current?.id === conversation.id ? conversation : current);
        setListVersion((version) => version + 1);
      }} />}

    {jobsOpen && <BackgroundJobs client={client} offline={offline} returnFocus={featureOpener} source={jobsOpen.source}
      close={() => setJobsOpen(undefined)} describeError={describeError} />}
    {retrievalOpen && <RetrievalPanel client={client} offline={offline} returnFocus={featureOpener}
      close={() => setRetrievalOpen(false)} describeError={describeError} />}
    {researchOpen && <ResearchPanel client={client} offline={offline} returnFocus={featureOpener}
      close={() => setResearchOpen(false)} describeError={describeError} />}
    {sandboxConnectorOpen && features.sandboxConnector && <SandboxConnector client={client} offline={offline} opener={featureOpener}
      close={() => setSandboxConnectorOpen(false)} describeError={describeError} />}
    {eventRemindersOpen && features.eventReminders && <EventReminders client={client} offline={offline} opener={featureOpener}
      close={() => setEventRemindersOpen(false)} describeError={describeError} />}
    {catalogueOpen && features.syntheticCatalogue && <ProductCatalogue client={client} offline={offline} opener={featureOpener}
      close={() => setCatalogueOpen(false)} describeError={describeError} />}
    {organizationOpen && features.organizations && <OrganizationPanel client={client} offline={offline} opener={featureOpener}
      policiesAvailable={features.organizationPolicies} usageAvailable={features.organizationUsage}
      modelBudgetAvailable={features.organizationModelBudget}
      directoryAvailable={features.organizationDirectory}
      onPolicySaved={() => setModelVersion((current) => current + 1)}
      close={() => setOrganizationOpen(false)} describeError={describeError} />}
    {reviewedCatalogOpen && features.reviewedCatalog && <ReviewedCatalog client={client} offline={offline} opener={featureOpener}
      canSubmitAssistant={features.customAssistants} canSubmitConnector={features.catalogConnectorSubmission}
      close={() => setReviewedCatalogOpen(false)} describeError={describeError} />}
    {guardianEligibilityOpen && features.guardianEligibility && <GuardianEligibility client={client} offline={offline} opener={featureOpener}
      close={() => setGuardianEligibilityOpen(false)} describeError={describeError}
      onRefresh={() => setModelVersion((current) => current + 1)} />}
    {proactiveOpen && features.proactiveAssistant && <ProactiveAssistant client={client} offline={offline} opener={featureOpener}
      close={() => setProactiveOpen(false)} openReminders={() => { setProactiveOpen(false); setRemindersOpen(true); }}
      describeError={describeError} />}
    {remindersOpen && <RemindersPanel client={client} offline={offline} canShare={features.reminderTemplates} returnFocus={featureOpener}
      close={() => setRemindersOpen(false)} describeError={describeError} />}
    {customAssistantsOpen && <CustomAssistantsPanel client={client} offline={offline} returnFocus={featureOpener}
      close={() => setCustomAssistantsOpen(false)} describeError={describeError} />}
    {learningOpen && <LearningPanel close={() => setLearningOpen(false)} returnFocus={featureOpener} />}
    {artifactPanel && <ArtifactsPanel client={client} offline={offline} canPublish={features.artifactPublications} currentProject={artifactPanel.project}
      canPublishWebpages={features.webpagePublications} canPublishImages={features.imagePublications} canHostWebpages={features.hostedWebpages}
      typedPublications={{ sheet: features.sheetPublications, slides: features.slidesPublications, code: features.codePublications }}
      typedFromReply={features.typedReplyArtifacts}
      canEditSheets={features.spreadsheets} canEditSlides={features.slides} canEditCode={features.codeDrafts}
      canEditWebsites={features.webpages} canEditImages={features.imageAssets} source={artifactPanel.source} opener={featureOpener}
      close={() => setArtifactPanel(undefined)} describeError={describeError} />}
    {collaborationOpen && <ProjectCollaboration client={client} offline={offline} canPublish={features.artifactPublications} opener={featureOpener}
      showComments={features.artifactComments} showSharedDrafts={features.sharedDrafts}
      close={() => setCollaborationOpen(false)} describeError={describeError} />}
    {temporaryOpen && <TemporaryChat client={client} offline={offline} returnFocus={featureOpener}
      close={() => setTemporaryOpen(false)} describeError={describeError} />}
    {memoryOpen && <MemorySettings client={client} offline={offline} returnFocus={featureOpener}
      close={() => setMemoryOpen(false)} describeError={describeError} />}
    {selectedId && memorySourceMessage && !readChecking && <ProjectMemorySources client={client}
      conversationId={selectedId} messageId={memorySourceMessage} offline={offline} opener={featureOpener}
      close={() => setMemorySourceMessage(undefined)} describeError={describeError} />}

    {sharing && (sharing.mode === "publish"
      ? <PublishShare client={client} conversation={sharing.conversation} sourceMessageId={sharing.sourceMessageId}
        scope={sharing.scope} offline={offline} returnFocus={featureOpener} close={() => setSharing(undefined)} describeError={describeError} />
      : <ManageShares client={client} conversation={sharing.conversation} offline={offline}
        returnFocus={featureOpener} close={() => setSharing(undefined)} describeError={describeError} />)}

    {referencePickerOpen && <HistoryReferencePicker client={client} targetId={selectedId} offline={offline}
      opener={featureOpener} close={() => setReferencePickerOpen(false)} describeError={describeError}
      select={(reference) => { setHistoryReference(reference); setReferencePickerOpen(false); }} />}
    {readChecking && <div className="status-banner read-checking-banner" role="status">
      <span>{offline ? "联网后核对对话阅读权限。" : "正在重新核对对话阅读权限…"}</span>
      <button type="button" className="button link-button" onClick={() => {
        choose(null);
        if (window.matchMedia("(max-width: 700px)").matches) setDrawer(true);
      }}>返回列表</button>
    </div>}
    {lockedConversationsOpen && <LockedConversations client={client} offline={offline} opener={featureOpener}
      close={() => setLockedConversationsOpen(false)} describeError={describeError} onUnlock={async (id) => {
        setLockedConversationsOpen(false);
        setListVersion((version) => version + 1);
        try { choose(await client.getConversation(id)); }
        catch (failure) { setActionError(describeError(failure, "对话已解锁，暂时无法加载。可从对话列表重新打开。")); }
      }} />}
    {dialog === "read-lock" && selected && <Modal label="加锁对话" className="action-dialog" returnFocus={menuTrigger}
      close={() => { if (!actionBusy) setDialog(undefined); }}>
      <h2>加锁对话</h2>
      <p>加锁后会隐藏此对话并撤回旧分享，正在生成的内容会停止。输入当前账号密码可恢复阅读。</p>
      {actionError && <p className="error-box" role="alert">{actionError}</p>}
      <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={actionBusy} onClick={() => setDialog(undefined)}>取消</button>
        <button type="button" className="button primary" disabled={actionBusy || offline} onClick={() => void lockReading()}>确认加锁</button>
      </div>
    </Modal>}
    {dialog === "restrict-sharing" && selected && <Modal label={selected.sharingRestricted ? "允许新分享" : "限制分享"} close={() => {
      if (!actionBusy) setDialog(undefined);
    }} className="action-dialog" returnFocus={menuTrigger}>
      <form onSubmit={(event) => { event.preventDefault(); void restrictSharing(); }}>
        <h2>{selected.sharingRestricted ? "允许新分享" : "限制分享"}</h2>
        <p>{selected.sharingRestricted ? "允许为此对话创建新链接。以前撤回的链接仍不可用。" : "立即撤回此对话的全部分享链接。接收人已经创建的独立副本会保留。"}</p>
        {actionError && <p className="error-box" role="alert">{actionError}</p>}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={actionBusy} onClick={() => setDialog(undefined)}>取消</button>
          <button type="submit" className="button primary" disabled={actionBusy || offline}>确认</button>
        </div>
      </form>
    </Modal>}
    {(dialog === "rename" || dialog === "delete") && selected && <Modal label={dialog === "rename" ? "重命名对话" : "删除对话"} close={() => {
      if (!actionBusy) { setDialog(undefined); setActionError(""); }
    }} className="action-dialog">
      <form onSubmit={(event) => {
        event.preventDefault();
        if (dialog === "delete") void remove();
        else {
          const title = String(new FormData(event.currentTarget).get("title")).trim();
          if (title) void update({ title });
          else setActionError("请输入一个标题。");
        }
      }}>
        <h2>{dialog === "rename" ? "重命名对话" : "删除对话"}</h2>
        {dialog === "rename" ? <label className="dialog-field">对话名称
          <input name="title" autoFocus defaultValue={selected.title} maxLength={256} required disabled={actionBusy} />
        </label> : <p>删除「{selected.title}」及其中的消息？此操作无法撤销。</p>}
        {actionError && <p className="error-box" role="alert">{actionError}</p>}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={actionBusy} onClick={() => { setDialog(undefined); setActionError(""); }}>取消</button>
          <button type="submit" className={`button ${dialog === "delete" ? "danger" : "primary"}`} disabled={actionBusy}>
            {actionBusy ? "正在处理…" : dialog === "rename" ? "保存" : "删除"}
          </button>
        </div>
      </form>
    </Modal>}
  </div>;
}

function GenerationDetails({ generation }: { generation: NonNullable<Message["generation"]> }) {
  const { modelId, modelVersion, context, fallbackFromModelId } = generation;
  return <div className="model-details">
    <p>{modelId} · {modelVersion}{context && " · 上下文 " + context.used.toLocaleString("zh-CN") + " / " + context.budget.toLocaleString("zh-CN") + " 字符"}</p>
    {context?.trimmed && <p>较早的消息超出了本次回答的上下文上限。</p>}
    {fallbackFromModelId && <p>模型 {fallbackFromModelId} 已替换为 {modelId}。</p>}
  </div>;
}
