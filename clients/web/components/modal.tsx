import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

export function Modal({ children, label, close, className = "", returnFocus }: {
  children: ReactNode;
  label: string;
  close: () => void;
  className?: string;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    const opener = returnFocus?.current;
    element?.showModal();
    return () => {
      // Drop native modal inertness before focusing its opener in the same commit.
      element?.close();
      if (opener?.isConnected) opener.focus();
    };
  }, [returnFocus]);
  return <dialog ref={dialog} className={className} aria-label={label} onCancel={(event) => {
    event.preventDefault();
    event.stopPropagation();
    close();
  }}>{children}</dialog>;
}
