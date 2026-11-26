import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const accounts = new Map();
const sessions = new Map();
const conversations = new Map();
const history = new Map();
const runs = new Map();
const reports = new Map();
const shares = new Map();
const now = () => new Date().toISOString();
const prefix = "/api/assistant/v1";
const initial = "首段回答。";
const resumed = "流式接续成功。\n\n";
const markdown = [
  "| 键 | 值 |", "| --- | --- |", "| 示例 | 生效 |", "", "```js", "const value = 1;", "```", "",
  "[可访问链接](https://example.com) [无效链接](javascript:alert%281%29)",
].join("\n");

function response(res, status, value) {
  if (status === 204) {
    res.writeHead(status).end();
  } else {
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
  }
}

function error(res, status, code, message) {
  return response(res, status, { code, message });
}

async function body(req) {
  let buffer = "";
  for await (const chunk of req) buffer += chunk;
  return buffer ? JSON.parse(buffer) : {};
}

function signal(res, run, type, sequence, data = {}) {
  res.write(`id: ${sequence}\nevent: ${type}\ndata: ${JSON.stringify({ type, runId: run.runId, sequence, ...data })}\n\n`);
}

function message(conversationId, role, content, parentId) {
  const row = { id: randomUUID(), parentId: parentId ?? null, role, content, createdAt: now() };
  history.get(conversationId).push(row);
  return row.id;
}

function snapshotFor(conversation, rows, { sourceMessageId, scope, audience }) {
  const source = rows.find((row) => row.id === sourceMessageId);
  if (!source || !["branch", "reply"].includes(scope) || !["workspace", "link"].includes(audience) ||
      scope === "reply" && source.role !== "assistant") return null;
  const selected = [source];
  let parent = source.parentId;
  while (scope === "branch" && parent) {
    const row = rows.find((entry) => entry.id === parent);
    if (!row) return null;
    selected.unshift(row);
    parent = row.parentId;
  }
  return { title: conversation.title, scope, audience, includesAttachments: false,
    messages: selected.map(({ role, content }) => ({ role, content })) };
}

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://127.0.0.1:3101");
    const method = req.method;
    if (path.pathname === "/health") return response(res, 200, { status: "ok" });
    if (!path.pathname.startsWith(prefix + "/")) return error(res, 404, "NOT_FOUND", "Not found");

    const segments = path.pathname.slice(prefix.length + 1).split("/");
    const [resource, id, action] = segments;
    if (resource === "auth" && ["register", "login"].includes(id) && method === "POST") {
      const { username, password } = await body(req);
      if (id === "register" && accounts.has(username)) return error(res, 409, "CONFLICT", "Username is taken");
      if (id === "register") {
        accounts.set(username, { password, user: { id: randomUUID(), workspaceId: randomUUID(), username, preferences: { locale: "zh-CN", theme: "system" } } });
      }
      const account = accounts.get(username);
      if (account?.password !== password) return error(res, 401, "UNAUTHENTICATED", "Invalid credentials");
      const accessToken = "fixture-" + randomUUID();
      sessions.set(accessToken, account.user);
      return response(res, id === "register" ? 201 : 200, { accessToken, expiresAt: now(), user: account.user });
    }
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    const user = sessions.get(token);
    if (resource === "shares" && ["read", "copy"].includes(id) && method === "POST") {
      if (!user && (token || id === "copy")) return error(res, 401, "UNAUTHENTICATED", "Authentication required");
      if (user && req.headers["x-workspace-id"] !== user.workspaceId) {
        return error(res, 403, "FORBIDDEN", "Workspace mismatch");
      }
      const input = await body(req);
      const share = [...shares.values()].find((entry) => entry.token === input.token);
      if (!share || share.record.revokedAt || Date.parse(share.record.expiresAt) <= Date.now() ||
          share.view.audience === "workspace" && share.workspaceId !== user?.workspaceId) {
        return error(res, 404, "NOT_FOUND", "Share unavailable");
      }
      if (id === "read") return response(res, 200, share.view);
      const conversation = { id: randomUUID(), title: share.view.title, pinned: false, archived: false, updatedAt: now() };
      conversations.set(conversation.id, { conversation, userId: user.id });
      history.set(conversation.id, []);
      let parentId;
      for (const { role, content } of share.view.messages) parentId = message(conversation.id, role, content, parentId);
      return response(res, 201, conversation);
    }
    if (!user) return error(res, 401, "UNAUTHENTICATED", "Authentication required");
    if (req.headers["x-workspace-id"] !== user.workspaceId) return error(res, 403, "FORBIDDEN", "Workspace mismatch");

    if (resource === "auth" && id === "logout" && method === "POST") {
      sessions.delete(token);
      return response(res, 204);
    }
    if (resource === "models") {
      return response(res, 200, { models: [{ id: "local-echo", version: "fixture-v1", tier: "standard", contextBudget: 8_000 }] });
    }
    if (resource === "capabilities" && !id && method === "GET") {
      return response(res, 200, { capabilities: [
        { id: "account-erasure", available: !user.username.startsWith("disabled-") },
        { id: "conversation_sharing", available: true },
      ] });
    }
    if (resource === "shares" && id && method === "DELETE") {
      const share = shares.get(id);
      if (share?.ownerId !== user.id) return error(res, 404, "NOT_FOUND", "Share not found");
      share.record.revokedAt ??= now();
      return response(res, 204);
    }
    if (resource === "usage" && !id && method === "GET") {
      return response(res, 200, { limit: 100_000, reserved: 300, used: 45, available: 99_655, unit: "output_code_points" });
    }
    if (resource === "privacy" && id === "export" && method === "GET") {
      const cursor = path.searchParams.get("cursor");
      const pageTwo = `${user.id}-next`;
      if (cursor !== null && cursor !== pageTwo) return error(res, 400, "VALIDATION_ERROR", "Invalid cursor");
      const exportedAt = now();
      res.setHeader("Content-Disposition", 'attachment; filename="assistant-data.json"');
      return response(res, 200, {
        schemaVersion: 1, exportedAt, workspaceId: user.workspaceId,
        account: { id: user.id, username: user.username, preferences: user.preferences, createdAt: exportedAt },
        conversations: [], messages: [], runs: [], nextCursor: cursor === null ? pageTwo : null,
      });
    }
    if (resource === "privacy" && id === "account-erasure" && method === "POST") {
      if (user.username.startsWith("disabled-")) return error(res, 403, "CAPABILITY_UNAVAILABLE", "Erasure unavailable");
      const { currentPassword, confirmation } = await body(req);
      if (confirmation !== "DELETE") return error(res, 400, "VALIDATION_ERROR", "Confirmation is required");
      if (currentPassword !== accounts.get(user.username)?.password) {
        return error(res, 401, "INVALID_CURRENT_PASSWORD", "Current password incorrect");
      }
      accounts.delete(user.username);
      for (const [tokenId, session] of sessions) {
        if (session.id === user.id) sessions.delete(tokenId);
      }
      return response(res, 204);
    }
    if (resource === "reports" && !id && method === "POST") {
      const { targetType, targetId, reason } = await body(req);
      if (targetType !== "assistant_reply" || !["safety", "privacy", "spam", "other"].includes(reason)) {
        return error(res, 400, "VALIDATION_ERROR", "Invalid report");
      }
      const available = [...conversations].some(([conversationId, row]) => row.userId === user.id &&
        history.get(conversationId).some((message) => message.role === "assistant" && message.id === targetId));
      if (!available) return error(res, 404, "NOT_FOUND", "Report target not found");
      const key = `${user.id}:${targetId}`;
      const prior = reports.get(key);
      if (prior) {
        if (prior.reason !== reason) return error(res, 409, "CONFLICT", "Already reported");
        return response(res, 200, prior);
      }
      const report = { id: randomUUID(), targetType, targetId, reason, status: "open", createdAt: now() };
      reports.set(key, report);
      return response(res, 201, report);
    }
    if (resource === "conversations" && !id) {
      if (method === "POST") {
        const { title } = await body(req);
        const conversation = { id: randomUUID(), title, pinned: false, archived: false, updatedAt: now() };
        conversations.set(conversation.id, { conversation, userId: user.id });
        history.set(conversation.id, []);
        return response(res, 201, conversation);
      }
      const archived = path.searchParams.get("archived") === "true";
      const search = path.searchParams.get("q") ?? "";
      const items = [...conversations.values()].filter((row) => row.userId === user.id &&
        row.conversation.archived === archived && row.conversation.title.includes(search)).map((row) => row.conversation);
      return response(res, 200, { items, nextCursor: null });
    }
    if (resource === "conversations" && id) {
      const found = conversations.get(id);
      if (found?.userId !== user.id) return error(res, 404, "NOT_FOUND", "Conversation not found");
      if (action === "shares" && method === "GET") {
        const items = [...shares.values()].filter((entry) => entry.conversationId === id).map((entry) => entry.record);
        return response(res, 200, { items, nextCursor: null });
      }
      if (["share-previews", "shares"].includes(action) && method === "POST") {
        const input = await body(req);
        const view = snapshotFor(found.conversation, history.get(id), input);
        if (!view) return error(res, 400, "VALIDATION_ERROR", "Invalid share selection");
        if (input.audience === "link" && found.conversation.projectId) return error(res, 403, "FORBIDDEN", "Project share restricted");
        const revision = createHash("sha256").update(`${id}:${input.sourceMessageId}:${JSON.stringify(view)}`).digest("base64url");
        if (action === "share-previews") return response(res, 200, { ...view, revision });
        if (revision !== input.revision) return error(res, 409, "CONFLICT", "Snapshot changed");
        const shareToken = `sh_${randomBytes(32).toString("base64url")}`;
        const record = { id: randomUUID(), scope: view.scope, audience: view.audience, createdAt: now(),
          expiresAt: new Date(Date.now() + 86400_000).toISOString() };
        shares.set(record.id, { record, token: shareToken, view: { ...view, expiresAt: record.expiresAt },
          conversationId: id, ownerId: user.id, workspaceId: user.workspaceId });
        return response(res, 201, { ...record, token: shareToken });
      }
      if (!action && method === "PATCH") {
        Object.assign(found.conversation, await body(req));
        return response(res, 200, found.conversation);
      }
      if (!action && method === "DELETE") {
        conversations.delete(id);
        history.delete(id);
        return response(res, 204);
      }
      if (action === "messages") {
        return response(res, 200, { items: history.get(id), nextCursor: null });
      }
      if (action === "runs" && method === "POST") {
        if (!req.headers["idempotency-key"]) return error(res, 400, "VALIDATION_ERROR", "Missing idempotency key");
        const input = await body(req);
        const source = history.get(id).find((row) => row.id === input.messageId);
        const parentId = input.action === "regenerate" ? source.parentId :
          message(id, "user", input.content, input.action === "edit" ? source.parentId : input.parentId);
        const snapshot = {
          runId: randomUUID(), conversationId: id, state: "queued", lastSequence: 0, content: "", modelId: input.modelId,
          modelVersion: "fixture-v1",
        };
        runs.set(snapshot.runId, { userId: user.id, snapshot, parentId, cancelledPrompt: input.content === "请停止" });
        return response(res, 202, snapshot);
      }
    }
    if (resource === "runs" && id) {
      const run = runs.get(id);
      if (run?.userId !== user.id) return error(res, 404, "NOT_FOUND", "Run not found");
      const { snapshot } = run;
      if (!action && method === "GET") {
        if (!run.cancelledPrompt && snapshot.state === "running") {
          Object.assign(snapshot, { lastSequence: 3, content: initial + resumed });
        }
        return response(res, 200, snapshot);
      }
      if (action === "cancel" && method === "POST") {
        Object.assign(snapshot, { state: "cancelled", lastSequence: 3 });
        if (run.stream && !run.stream.destroyed) {
          signal(run.stream, snapshot, "run.cancelled", 3);
          run.stream.end();
        }
        return response(res, 200, snapshot);
      }
      if (action === "events") {
        const cursor = Number(req.headers["last-event-id"] ?? 0);
        if (!run.cancelledPrompt && snapshot.state === "running" && cursor < 3) {
          return error(res, 409, "CURSOR_EXPIRED", "Cursor expired");
        }
        res.writeHead(200, { "Content-Type": "text/event-stream", "X-Accel-Buffering": "no", "Cache-Control": "no-store" });
        if (cursor === 0) {
          Object.assign(snapshot, { state: "running", lastSequence: 2, content: initial });
          signal(res, snapshot, "run.started", 1);
          signal(res, snapshot, "message.delta", 2, { delta: initial });
          if (!run.cancelledPrompt) {
            setTimeout(() => { if (!res.destroyed) res.end(); }, 600);
          } else {
            run.stream = res;
          }
          return;
        }
        if (cursor === 3) {
          const messageId = message(snapshot.conversationId, "assistant", initial + resumed + markdown, run.parentId);
          Object.assign(snapshot, { state: "completed", lastSequence: 5, content: initial + resumed + markdown, messageId });
          signal(res, snapshot, "message.delta", 4, { delta: markdown });
          signal(res, snapshot, "run.completed", 5, { messageId });
        }
        res.end();
        return;
      }
    }
    return error(res, 404, "NOT_FOUND", "Not found");
  } catch {
    if (!res.headersSent) error(res, 500, "INTERNAL_ERROR", "Fixture request failed");
    else res.destroy();
  }
});
server.listen(3101, "127.0.0.1");
