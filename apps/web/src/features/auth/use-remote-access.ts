"use client";

import {
  type HostRemoteStatus,
  hostRemoteStatusSchema,
} from "@chorus/contracts";
import { useEffect, useState } from "react";

export function useRemoteAccess() {
  const [data, setData] = useState<HostRemoteStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("My computer");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const response = await fetch("/api/hosting/remote", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error("remote status unavailable");
        }
        const next = hostRemoteStatusSchema.parse(await response.json());
        if (controller.signal.aborted) {
          return;
        }
        setData(next);
        if (next.availability === "available") {
          timer = setTimeout(refresh, 5000);
        }
      } catch {
        if (!controller.signal.aborted) {
          setError(
            "Could not check internet access. Reopen this panel to try again."
          );
        }
      }
    }
    refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  async function change(
    path: "enrollment" | "connection",
    body: { label: string } | { enabled: boolean }
  ) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/hosting/remote/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new Error(
          "Could not update internet access. Check your connection and try again."
        );
      }
      setData(hostRemoteStatusSchema.parse(await response.json()));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not update internet access."
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyAddress() {
    if (!data?.publicOrigin) {
      return;
    }
    try {
      await navigator.clipboard.writeText(data.publicOrigin);
      setCopied(true);
    } catch {
      setError("Clipboard unavailable. Select the address and copy it.");
    }
  }

  return { data, error, busy, label, setLabel, copied, change, copyAddress };
}
