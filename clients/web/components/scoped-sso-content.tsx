"use client";

import { useEffect, useState, type ReactNode } from "react";

export function ScopedSsoContent({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    let pending: AbortController | undefined;
    const verify = () => {
      pending?.abort();
      if (document.hidden) {
        setVisible(false);
        return;
      }
      const request = new AbortController();
      pending = request;
      void fetch("/organization-sso/session", { cache: "no-store", signal: request.signal })
        .then((response) => {
          if (request.signal.aborted) return;
          const active = response.status === 204;
          setVisible(active && !document.hidden);
          if (!active) window.location.replace("/organization-sso");
        }).catch(() => { if (!request.signal.aborted) setVisible(false); });
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setVisible(false);
        verify();
      }
    };
    document.addEventListener("visibilitychange", verify);
    window.addEventListener("pageshow", restore);
    const timer = window.setInterval(verify, 10_000);
    return () => {
      pending?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", verify);
      window.removeEventListener("pageshow", restore);
    };
  }, []);

  return <><div hidden={!visible}>{children}</div>
    {!visible && <p role="status">正在核对组织访问权限。</p>}</>;
}
