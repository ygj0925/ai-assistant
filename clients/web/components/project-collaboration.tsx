"use client";

import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";
import { downloadBlob } from "@/lib/assistant";
import { ArtifactPublicationComments } from "./artifact-publication-comments";
import { codeDownloadName, CodeDraftView } from "./code-draft-editor";
import { ImageAssetView } from "./image-asset-editor";
import { Modal } from "./modal";
import { PresentationView } from "./presentation-editor";
import { ProjectSharedDrafts } from "./project-shared-drafts";
import { SpreadsheetView } from "./spreadsheet-editor";
import { useWebsiteSandboxSupport, WebsiteDraftView, WebsiteSandbox } from "./website-draft-editor";

type Schemas = components["schemas"];
type Role = Schemas["SharedProjectRole"];
type Selection = { id: string; name: string; role: "owner" | Role };
const labels = { owner: "所有者", viewer: "查看者", editor: "编辑者" };

function PublicationContent({ value }: { value: Schemas["ArtifactPublication"] }) {
  if ("website" in value) return <WebsiteDraftView website={value.website} />;
  if ("image" in value) return <ImageAssetView image={value.image} />;
  if ("sheet" in value) return <SpreadsheetView sheet={value.sheet} />;
  if ("presentation" in value) return <PresentationView deck={value.presentation} />;
  if ("code" in value) return <CodeDraftView code={value.code} />;
  return <pre className="resource-text">{value.content}</pre>;
}

function publicationFilename(value: Schemas["ArtifactPublication"]) {
  if ("code" in value) return codeDownloadName(value.code);
  switch (value.format) {
    case "image": return "image.png";
    case "webpage": return "artifact.html";
    case "markdown": return "artifact.md";
    case "sheet": return "artifact.xlsx";
    case "slides": return "artifact.pptx";
    default: return "artifact.txt";
  }
}

export function ProjectCollaboration({ client, offline, canPublish, showComments, showSharedDrafts, close, opener, describeError }: {
  client: AssistantClient;
  offline: boolean;
  canPublish: boolean;
  showComments: boolean;
  showSharedDrafts: boolean;
  close: () => void;
  opener: RefObject<HTMLElement | null>;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [owned, setOwned] = useState<Schemas["ProjectPage"]>({ items: [], nextCursor: null });
  const [received, setReceived] = useState<Schemas["ProjectInvitation"][]>([]);
  const [shared, setShared] = useState<Schemas["SharedProject"][]>([]);
  const [selection, setSelection] = useState<Selection>();
  const [members, setMembers] = useState<Schemas["ProjectInvitation"][]>([]);
  const [materials, setMaterials] = useState<Schemas["SharedProjectMaterialSummary"][]>([]);
  const [material, setMaterial] = useState<Schemas["SharedProjectMaterial"]>();
  const [publications, setPublications] = useState<Schemas["ArtifactPublicationSummary"][]>([]);
  const [publication, setPublication] = useState<Schemas["ArtifactPublication"]>();
  const [preview, setPreview] = useState<string>();
  const [imagePreview, setImagePreview] = useState<{ id: string; url: string }>();
  const sandboxSupported = useWebsiteSandboxSupport();
  const [recipient, setRecipient] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(true);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => () => { if (imagePreview) URL.revokeObjectURL(imagePreview.url); }, [imagePreview]);

  const protectedPublicationId = publication && ["image", "sheet", "slides", "code"].includes(publication.format)
    ? publication.id : undefined;
  const projectId = selection?.id;
  useEffect(() => {
    if (!protectedPublicationId || !projectId || offline) return;
    const selectedProject = projectId;
    const selectedVersion = protectedPublicationId;
    const request = new AbortController();
    let checking = false;
    async function check() {
      if (checking || document.hidden || request.signal.aborted) return;
      checking = true;
      try {
        await client.getProjectArtifactPublication(selectedProject, selectedVersion, request.signal);
      } catch (failure) {
        if (!request.signal.aborted) {
          setPublication((active) => active?.id === selectedVersion ? undefined : active);
          setImagePreview((active) => active?.id === selectedVersion ? undefined : active);
          setPublications((items) => items.filter(({ id }) => id !== selectedVersion));
          setError(describeError(failure, "暂时无法核对已发布版本的权限。"));
        }
      } finally { checking = false; }
    }
    function visibilityChanged() {
      if (document.hidden) {
        setPublication((active) => active?.id === selectedVersion ? undefined : active);
        setImagePreview(undefined);
      }
      else void check();
    }
    const interval = window.setInterval(() => void check(), 10_000);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      request.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [client, describeError, offline, projectId, protectedPublicationId]);

  async function lists(signal: AbortSignal) {
    const [mine, invitations, available] = await Promise.all([
      client.listProjects({ limit: 20 }, signal), client.listReceivedProjectInvitations(signal), client.listSharedProjects(signal),
    ]);
    if (signal.aborted) return;
    setOwned(mine);
    setReceived(invitations.items);
    setShared(available.items);
  }

  useEffect(() => {
    const request = new AbortController();
    setBusy(!offline);
    if (offline) {
      setMaterial(undefined);
      setPublication(undefined);
      setPreview(undefined);
      setImagePreview(undefined);
    }
    if (!offline) {
      pending.current = request;
      setError("");
      void lists(request.signal).catch((failure) => {
        if (!request.signal.aborted) setError(describeError(failure, "暂时无法读取项目协作。"));
      }).finally(() => {
        if (pending.current === request) {
          pending.current = null;
          setBusy(false);
        }
      });
    }
    return () => {
      request.abort();
      pending.current?.abort();
      pending.current = null;
    };
  }, [client, describeError, offline]);

  async function work(action: (signal: AbortSignal) => Promise<void>, fallback: string) {
    if (pending.current || offline) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action(request.signal);
    } catch (failure) {
      if (!request.signal.aborted) {
        if (failure instanceof AssistantApiError && [401, 403, 404, 410, 423].includes(failure.status)) {
          setPublication(undefined);
          setPreview(undefined);
          setImagePreview(undefined);
        }
        setError(describeError(failure, fallback));
      }
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  function clearSelection() {
    setSelection(undefined);
    setMaterial(undefined);
    setPublication(undefined);
    setPreview(undefined);
    setImagePreview(undefined);
    setPublications([]);
    setMaterials([]);
    setMembers([]);
    setConfirm("");
    setName("");
    setBody("");
    setRecipient("");
  }

  async function open(selected: Selection, signal: AbortSignal) {
    setMaterial(undefined);
    setPublication(undefined);
    setPreview(undefined);
    setImagePreview(undefined);
    setConfirm("");
    try {
      const [records, roster, documents] = await Promise.all([
        client.listSharedProjectMaterials(selected.id, signal),
        selected.role === "owner" ? client.listProjectInvitations(selected.id, signal) : undefined,
        canPublish ? client.listProjectArtifactPublications(selected.id, signal) : undefined,
      ]);
      if (signal.aborted) return;
      setSelection(selected);
      setMaterials(records.items);
      setMembers(roster?.items ?? []);
      setPublications(documents?.items ?? []);
    } catch (failure) {
      if (!signal.aborted && failure instanceof AssistantApiError && [403, 404].includes(failure.status)) clearSelection();
      throw failure;
    }
  }

  function invite(event: FormEvent) {
    event.preventDefault();
    if (selection?.role !== "owner") return;
    void work(async (signal) => {
      const invitation = await client.inviteProjectMember(selection.id, { recipientUsername: recipient.trim(), role }, signal);
      if (signal.aborted) return;
      setMembers((prior) => [invitation, ...prior.filter(({ id }) => id !== invitation.id)]);
      setRecipient("");
      setNotice("邀请已发出。");
    }, "无法邀请该账号，请核对对方是否属于当前工作空间。");
  }

  function add(event: FormEvent) {
    event.preventDefault();
    if (!selection || selection.role === "viewer") return;
    void work(async (signal) => {
      const stored = await client.createSharedProjectMaterial(selection.id, { name: name.trim(), content: body }, signal);
      if (signal.aborted) return;
      const summary = { id: stored.id, name: stored.name, createdAt: stored.createdAt, canDelete: stored.canDelete };
      setMaterials((prior) => [summary, ...prior.filter(({ id }) => id !== stored.id)]);
      setName("");
      setBody("");
      setNotice("资料已加入协作区。");
    }, "暂时无法保存共享资料。");
  }

  const locked = offline || busy;
  return <Modal label="项目协作" className="action-dialog resource-dialog" close={close} returnFocus={opener}>
    <h2>项目协作</h2>
    {error && <p className="error-box" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {offline && <p role="status">联网后可核对当前项目的协作权限。</p>}
    <button type="button" className="button secondary" disabled={locked} onClick={() => void work(async (signal) => {
      await lists(signal);
      if (selection && !signal.aborted) await open(selection, signal);
    }, "暂时无法刷新协作项目。")}>刷新项目协作</button>
    {!!received.length && <section className="account-data-section" aria-label="收到的邀请">
      <h3>收到的邀请</h3>
      <ul className="private-record-list">{received.map((invitation) => <li key={invitation.id}>
        <p>{invitation.projectName} · {labels[invitation.role]}</p>
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={locked} onClick={() => void work(async (signal) => {
            await client.declineProjectInvitation(invitation.id, signal);
            if (!signal.aborted) setReceived((prior) => prior.filter(({ id }) => id !== invitation.id));
          }, "暂时无法拒绝邀请。")}>拒绝邀请</button>
          <button type="button" className="button primary" disabled={locked} onClick={() => void work(async (signal) => {
            const accepted = await client.acceptProjectInvitation(invitation.id, signal);
            await lists(signal);
            if (!signal.aborted) await open({ id: accepted.projectId, name: accepted.projectName, role: accepted.role }, signal);
          }, "暂时无法接受邀请。")}>接受邀请</button>
        </div>
      </li>)}</ul>
    </section>}
    <section className="account-data-section" aria-label="可协作项目">
      <h3>可协作项目</h3>
      {!owned.items.length && !shared.length && !busy && <p>当前工作空间没有可协作项目。</p>}
      <ul className="private-record-list">{[
        ...owned.items.map(({ id, name }) => ({ id, name, role: "owner" as const })), ...shared,
      ].map((target) => <li key={target.id}>
        <button type="button" className="button secondary" disabled={locked} aria-pressed={selection?.id === target.id}
          onClick={() => { clearSelection(); void work((signal) => open(target, signal), "暂时无法打开协作项目。"); }}>
          {target.name} · {labels[target.role]}
        </button>
      </li>)}</ul>
      {owned.nextCursor && <button type="button" className="button secondary" disabled={locked} onClick={() => void work(async (signal) => {
        const page = await client.listProjects({ limit: 20, cursor: owned.nextCursor ?? undefined }, signal);
        if (!signal.aborted) setOwned((prior) => ({ items: [...prior.items, ...page.items], nextCursor: page.nextCursor }));
      }, "暂时无法读取更多项目。")}>更多自有项目</button>}
    </section>
    {selection && <section className="account-data-section" aria-label="当前协作项目">
      <h3>{selection.name} · {labels[selection.role]}</h3>
      {selection.role === "owner" && <>
        <form onSubmit={invite} className="account-data-section">
          <label className="dialog-field">同工作空间用户名<input value={recipient} required readOnly={locked} maxLength={32}
            onChange={(event) => setRecipient(event.target.value)} /></label>
          <label className="dialog-field">授予角色<select value={role} disabled={locked} onChange={(event) => {
            setRole(event.target.value === "editor" ? "editor" : "viewer");
          }}><option value="viewer">查看者</option><option value="editor">编辑者</option></select></label>
          <button type="submit" className="button primary" disabled={locked || recipient.trim().length < 3}>发出邀请</button>
        </form>
        {!!members.length && <ul className="private-record-list" aria-label="邀请和成员">
          {members.map((member) => <li key={member.id}>
            <p>{member.recipientUsername} · {labels[member.role]} · {member.state === "accepted" ? "已加入" : "待接受"}</p>
            {confirm === member.id ? <div className="dialog-actions">
              <button type="button" className="button secondary" disabled={busy} onClick={() => setConfirm("")}>取消</button>
              <button type="button" className="button secondary danger-text" disabled={locked} onClick={() => void work(async (signal) => {
                await client.revokeProjectInvitation(selection.id, member.id, signal);
                if (!signal.aborted) {
                  setConfirm("");
                  setMembers((prior) => prior.filter(({ id }) => id !== member.id));
                }
              }, "暂时无法撤销项目授权。")}>确认撤销授权</button>
            </div> : <button type="button" className="button secondary" disabled={locked} onClick={() => setConfirm(member.id)}>撤销授权</button>}
          </li>)}
        </ul>}
      </>}
      {showSharedDrafts && !offline && <ProjectSharedDrafts key={selection.id} client={client} projectId={selection.id}
        role={selection.role} describeError={describeError} />}
      <h4>共享文字资料</h4>
      {selection.role !== "viewer" && <form onSubmit={add}>
        <p>新增文字将对本项目的协作成员可见。</p>
        <label className="dialog-field">共享资料名称<input value={name} readOnly={locked} maxLength={120}
          onChange={(event) => setName(event.target.value)} /></label>
        <label className="dialog-field">共享资料正文<textarea rows={5} value={body} readOnly={locked}
          onChange={(event) => setBody(event.target.value)} /></label>
        <button type="submit" className="button primary" disabled={locked || !name.trim() || !body.trim() ||
          new TextEncoder().encode(body).byteLength > 16384}>新增共享资料</button>
      </form>}
      {!materials.length && <p>暂无共享资料。</p>}
      <ul className="private-record-list">{materials.map((item) => <li key={item.id}>
        <button type="button" className="button secondary" disabled={locked} onClick={() => {
          setMaterial(undefined);
          void work(async (signal) => {
            const record = await client.getSharedProjectMaterial(selection.id, item.id, signal);
            if (!signal.aborted) { setMaterial(record); setConfirm(""); }
          }, "暂时无法查看此共享资料。");
        }}>{item.name}</button>
      </li>)}</ul>
      {material && <section className="resource-detail" aria-label="共享资料内容">
        <h4>{material.name}</h4>
        <pre className="resource-text">{material.content}</pre>
        {material.canDelete && (confirm === material.id ? <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={() => setConfirm("")}>取消</button>
          <button type="button" className="button secondary danger-text" disabled={locked} onClick={() => void work(async (signal) => {
            await client.deleteSharedProjectMaterial(selection.id, material.id, signal);
            if (!signal.aborted) {
              setMaterials((prior) => prior.filter(({ id }) => id !== material.id));
              setMaterial(undefined);
              setConfirm("");
            }
          }, "暂时无法删除共享资料。")}>确认删除共享资料</button>
        </div> : <button type="button" className="button secondary" disabled={locked} onClick={() => setConfirm(material.id)}>删除共享资料</button>)}
      </section>}
      {canPublish && <section className="account-data-section" aria-label="已发布文稿">
        <h4>已发布文稿</h4>
        {!publications.length && <p>当前项目还没有已发布版本。</p>}
        <ul className="private-record-list">{publications.map((item) => <li key={item.id}>
          <button type="button" className="button secondary" disabled={locked} aria-pressed={publication?.id === item.id}
            onClick={() => {
              setPublication(undefined);
              setPreview(undefined);
              setImagePreview(undefined);
              void work(async (signal) => {
                const record = await client.getProjectArtifactPublication(selection.id, item.id, signal);
                if (!signal.aborted) { setPublication(record); setConfirm(""); }
              }, "暂时无法读取此已发布版本。");
            }}>{item.title} · 版本 {item.versionNumber}</button>
        </li>)}</ul>
        {publication && <section className="resource-detail" aria-label="已发布文稿内容">
          <h5>{publication.title} · 版本 {publication.versionNumber}</h5>
          <PublicationContent value={publication} />
          {preview && <div className="account-data-section">
            <WebsiteSandbox title="已发布网页预览" html={preview} />
            <button type="button" className="button secondary" onClick={() => setPreview(undefined)}>关闭网页预览</button>
          </div>}
          {imagePreview?.id === publication.id && "image" in publication && !offline && <figure className="attachment-preview">
            {/* eslint-disable-next-line @next/next/no-img-element -- a protected local object URL */}
            <img src={imagePreview.url} alt={publication.image.altText || "已发布图片预览"} />
            <button type="button" className="button secondary" onClick={() => setImagePreview(undefined)}>关闭已发布图片预览</button>
          </figure>}
          <div className="dialog-actions">
            <button type="button" className="button secondary" disabled={locked} onClick={() => void work(async (signal) => {
              const blob = await client.downloadProjectArtifactPublication(selection.id, publication.id, publication.format, signal);
              if (!signal.aborted) downloadBlob(publicationFilename(publication), blob);
            }, "暂时无法下载此已发布版本。")}>下载已发布版本</button>
            {"image" in publication && !imagePreview && <button type="button" className="button secondary" disabled={locked}
              onClick={() => void work(async (signal) => {
                const blob = await client.downloadProjectArtifactPublication(selection.id, publication.id, "image", signal);
                if (!signal.aborted && !document.hidden) {
                  setImagePreview({ id: publication.id, url: URL.createObjectURL(blob) });
                }
              }, "暂时无法打开本版图片预览。")}>预览已发布图片</button>}
            {publication.format === "webpage" && sandboxSupported && <button type="button" className="button secondary" disabled={locked}
              onClick={() => void work(async (signal) => {
                const body = await client.previewProjectWebpagePublication(selection.id, publication.id, signal);
                const html = await body.text();
                if (!signal.aborted) setPreview(html);
              }, "暂时无法打开本版网页预览。")}>预览已发布网页</button>}
            {selection.role === "owner" && (confirm === publication.id ? <>
              <button type="button" className="button secondary" disabled={busy} onClick={() => setConfirm("")}>取消撤回</button>
              <button type="button" className="button secondary danger-text" disabled={locked} onClick={() => void work(async (signal) => {
                await client.revokeProjectArtifactPublication(selection.id, publication.id, signal);
                if (!signal.aborted) {
                  setPublications((prior) => prior.filter(({ id }) => id !== publication.id));
                  setPublication(undefined);
                  setPreview(undefined);
                  setImagePreview(undefined);
                  setConfirm("");
                  setNotice("已撤回文稿版本。");
                }
              }, "暂时无法撤回版本。")}>确认撤回版本</button>
            </> : <button type="button" className="button secondary" disabled={locked}
              onClick={() => setConfirm(publication.id)}>撤回已发布版本</button>)}
          </div>
          {showComments && <ArtifactPublicationComments key={publication.id} client={client} projectId={selection.id}
            publicationId={publication.id} offline={offline} canWrite={selection.role !== "viewer"} describeError={describeError} />}
        </section>}
      </section>}
      {selection.role !== "owner" && (confirm === "leave" ? <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={() => setConfirm("")}>取消退出</button>
        <button type="button" className="button secondary danger-text" disabled={locked} onClick={() => void work(async (signal) => {
          await client.leaveSharedProject(selection.id, signal);
          if (!signal.aborted) { clearSelection(); await lists(signal); }
        }, "暂时无法退出协作项目。")}>确认退出协作</button>
      </div> : <button type="button" className="button secondary" disabled={locked} onClick={() => setConfirm("leave")}>退出协作</button>)}
    </section>}
    <div className="dialog-actions"><button type="button" className="button secondary" onClick={close}>关闭</button></div>
  </Modal>;
}
