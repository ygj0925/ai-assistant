import { useId, useRef, useState, type FormEvent } from "react";
import { AssistantApiError } from "@ai-assistant/contracts";
import type { AccountErasureRequest } from "@/lib/assistant";
import { Modal } from "./modal";

export function AccountErasure({ disabled, onErase, describeError }: {
  disabled: boolean;
  onErase: (input: AccountErasureRequest) => Promise<void>;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [hasPassword, setHasPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; password?: boolean }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const errorId = useId();

  function close() {
    if (lock.current) return;
    setOpen(false);
    setConfirmation("");
    setHasPassword(false);
    setError(undefined);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const currentPassword = password.current?.value ?? "";
    if (lock.current || disabled || !currentPassword || confirmation !== "DELETE") return;
    if (new TextEncoder().encode(currentPassword).length > 72) {
      setError({ message: "密码最多可使用 72 字节。", password: true });
      password.current?.focus();
      return;
    }

    lock.current = true;
    setPending(true);
    setError(undefined);
    try {
      await onErase({ currentPassword, confirmation });
    } catch (failure) {
      if (failure instanceof AssistantApiError && failure.code === "INVALID_CURRENT_PASSWORD") {
        setError({ message: "当前密码不正确，请重新输入。", password: true });
        if (password.current) {
          password.current.value = "";
          setHasPassword(false);
          password.current.focus();
        }
      } else {
        setError({ message: describeError(failure, "暂时无法确认注销结果，请稍后重试。") });
      }
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  return <section className="account-data-section account-erasure" aria-label="账号注销">
    <h3>账号注销</h3>
    <button type="button" ref={trigger} className="button secondary danger-text" aria-haspopup="dialog"
      disabled={disabled} onClick={() => setOpen(true)}>注销账号</button>
    {open && <Modal label="确认注销账号" className="action-dialog" returnFocus={trigger} close={close}>
      <form onSubmit={(event) => void submit(event)}>
        <h2>确认注销账号</h2>
        <p>注销会清除该账号的个人数据，并退出所有设备。此操作无法撤销。</p>
        <label className="dialog-field">当前密码
          <input ref={password} name="currentPassword" type="password" autoComplete="current-password"
            required readOnly={pending} autoFocus aria-invalid={error?.password || undefined}
            aria-describedby={error?.password ? errorId : undefined} onChange={(event) => {
              setHasPassword(event.target.value.length > 0);
              if (error?.password) setError(undefined);
            }} />
        </label>
        <label className="dialog-field">输入 DELETE 确认
          <input name="confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off" autoCapitalize="none" spellCheck={false} required readOnly={pending} />
        </label>
        {error?.message && <p id={errorId} role="alert" className="error-box">{error.message}</p>}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={pending} onClick={close}>返回账号与数据</button>
          <button type="submit" className="button danger"
            disabled={disabled || pending || !hasPassword || confirmation !== "DELETE"}>
            {pending ? "正在注销…" : "永久注销账号"}
          </button>
        </div>
      </form>
    </Modal>}
  </section>;
}
