"use client";

import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";
import { downloadBlob, type AccountErasureRequest } from "@/lib/assistant";
import { AccountErasure } from "./account-erasure";
import { HostedSiteReport } from "./hosted-site-report";
import { WorkspaceSwitch } from "./workspace-switch";

type Usage = components["schemas"]["AccountUsage"];

const countFormat = new Intl.NumberFormat("zh-CN");

function formatCount(value: Usage["limit"]) {
  return countFormat.format(typeof value === "string" ? BigInt(value) : value);
}

export function AccountData({ client, workspaceId, offline, attachmentsAvailable, close, describeError, onErase,
  onSwitchWorkspace, onReturnPersonalWorkspace, onExpire }: {
  client: AssistantClient;
  workspaceId: string;
  offline: boolean;
  attachmentsAvailable: boolean;
  close: () => void;
  describeError: (error: unknown, fallback: string) => string;
  onErase: (input: AccountErasureRequest) => Promise<void>;
  onSwitchWorkspace: (workspaceId: string) => Promise<void>;
  onReturnPersonalWorkspace?: () => Promise<void>;
  onExpire: () => void;
}) {
  const [usage, setUsage] = useState<Usage>();
  const [usageError, setUsageError] = useState("");
  const [usageAttempt, setUsageAttempt] = useState(0);
  const [position, setPosition] = useState<{ cursor?: string | null; count: number }>({ count: 0 });
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [erasureAvailable, setErasureAvailable] = useState(false);
  const [siteReportingAvailable, setSiteReportingAvailable] = useState(false);
  const alive = useRef(true);
  const exportLock = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    setUsageError("");
    client.getUsage().then((result) => {
      if (current) setUsage(result);
    }).catch((error) => {
      if (current) setUsageError(describeError(error, "暂时无法读取用量。"));
    });
    return () => { current = false; };
  }, [client, describeError, usageAttempt]);

  useEffect(() => {
    let current = true;
    client.getCapabilities().then(({ capabilities }) => {
      if (current) {
        const available = new Set(capabilities.filter((capability) => capability.available).map(({ id }) => id));
        setErasureAvailable(available.has("account-erasure"));
        setSiteReportingAvailable(available.has("hosted_site_reporting"));
      }
    }).catch((error: unknown) => {
      if (current && error instanceof AssistantApiError && error.status === 401) describeError(error, "");
    });
    return () => { current = false; };
  }, [client, describeError]);

  const hasMore = typeof position.cursor === "string";
  const done = position.cursor === null;

  async function exportPage() {
    if (exportLock.current || offline) return;
    exportLock.current = true;
    setExporting(true);
    setExportError("");
    try {
      const page = await client.getExportPage(position.cursor ?? undefined);
      if (!alive.current) return;
      const count = hasMore ? position.count + 1 : 1;
      const blob = new Blob([JSON.stringify(page)], { type: "application/json;charset=utf-8" });
      downloadBlob(`assistant-data-${count}.json`, blob);
      setPosition({ cursor: page.nextCursor, count });
    } catch (error) {
      if (alive.current) setExportError(error instanceof AssistantApiError && error.status === 413
        ? "有历史记录超出导出大小限制。"
        : describeError(error, "暂时无法导出数据，请稍后重试。"));
    } finally {
      exportLock.current = false;
      if (alive.current) setExporting(false);
    }
  }

  return <>
    <h2>账号与数据</h2>
    <section className="account-data-section" aria-label="工作空间">
      <WorkspaceSwitch client={client} selectedId={workspaceId} offline={offline} onSwitch={onSwitchWorkspace}
        onReturnPersonal={onReturnPersonalWorkspace} onExpire={onExpire} />
    </section>
    <section className="account-data-section" aria-label="输出额度">
      <h3>输出额度（Unicode 码点）</h3>
      {usage ? <dl className="account-usage">
        <div><dt>可用额度</dt><dd>{formatCount(usage.available)}</dd></div>
        <div><dt>已预留</dt><dd>{formatCount(usage.reserved)}</dd></div>
        <div><dt>已结算</dt><dd>{formatCount(usage.used)}</dd></div>
        <div><dt>总额度</dt><dd>{formatCount(usage.limit)}</dd></div>
      </dl> : usageError ? <>
        <p className="error-box" role="alert">{usageError}</p>
        <button type="button" className="button link-button" disabled={offline}
          onClick={() => setUsageAttempt((attempt) => attempt + 1)}>重试读取</button>
      </> : <p role="status">正在读取用量…</p>}
    </section>
    <section className="account-data-section" aria-label="个人数据导出">
      <h3>个人数据导出</h3>
      <p>下载当前账号在此工作空间的个人数据。每次下载一份 JSON 文件。{attachmentsAvailable && "项目图像文件可从对应项目单独下载。"}</p>
      {exportError && <p className="error-box" role="alert">{exportError}</p>}
      <p className="download-status" role="status">{position.count > 0 &&
        (hasMore ? `已下载第 ${position.count} 份。还有数据可继续下载。` : `已下载第 ${position.count} 份。导出已完成。`)}</p>
      <button type="button" className="button secondary" disabled={offline || exporting} onClick={() => void exportPage()}>
        <Download size={17} aria-hidden="true" />
        {exporting ? "正在准备下载…" : hasMore ? "下载下一份" : done ? "重新导出" : "下载个人数据"}
      </button>
    </section>
    {siteReportingAvailable && <HostedSiteReport client={client} offline={offline} describeError={describeError} />}
    {erasureAvailable && <AccountErasure disabled={offline || exporting} onErase={onErase} describeError={describeError} />}
    <div className="dialog-actions">
      <button type="button" className="button secondary" onClick={close}>关闭</button>
    </div>
  </>;
}
