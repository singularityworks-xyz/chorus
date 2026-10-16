"use client";

import {
  deviceRevocationResponseSchema,
  type PairedDeviceList,
  pairedDeviceListSchema,
} from "@chorus/contracts";
import { useEffect, useState } from "react";

async function loadDevices(signal?: AbortSignal): Promise<PairedDeviceList> {
  const response = await fetch("/api/auth/devices", {
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    throw new Error("Could not load connected devices. Refresh to try again.");
  }
  return pairedDeviceListSchema.parse(await response.json());
}

export function PairedDevices() {
  const [data, setData] = useState<PairedDeviceList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadDevices(controller.signal)
      .then(setData)
      .catch(() => {
        if (!controller.signal.aborted) {
          setError("Could not load connected devices. Refresh to try again.");
        }
      });
    return () => controller.abort();
  }, []);

  async function disconnect(id: string) {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/auth/devices/${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );
      const result = deviceRevocationResponseSchema.safeParse(
        await response.json()
      );
      if (!result.success && response.status !== 404) {
        throw new Error(
          "Could not finish disconnecting this device. Refresh to check its status."
        );
      }
      setData(await loadDevices());
      setConfirmId(null);
      if (result.success && result.data.code === "device_cleanup_pending") {
        setNotice(
          "Access ended. Chorus is still cleaning up this device's notifications."
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not disconnect this device."
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section
      aria-label="Paired devices"
      className="space-y-3 border-white/8 border-t pt-4"
    >
      <h3 className="font-medium text-[12px] text-white/88">Paired devices</h3>
      <p className="text-[11px] text-white/48">
        Disconnect a device to end its access immediately.
      </p>
      {error ? (
        <p className="text-[11px] text-rose-300" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="text-[11px] text-white/60" role="status">
          {notice}
        </p>
      ) : null}
      {data || error ? null : (
        <p className="text-[11px] text-white/48" role="status">
          Loading devices…
        </p>
      )}
      {data?.devices.map((device) => (
        <div
          className="space-y-2 border border-white/8 p-2.5"
          key={device.deviceId}
        >
          <div className="flex items-start justify-between gap-2 text-[11px]">
            <span className="text-white/80">
              {device.label}
              <span className="mt-1 block text-[10px] text-white/40">
                Connected {new Date(device.createdAt).toLocaleString()}
              </span>
            </span>
            {device.deviceId === data.currentDeviceId ? (
              <span className="shrink-0 text-white/45">This device</span>
            ) : (
              <button
                className="text-rose-300 disabled:opacity-50"
                disabled={busyId !== null}
                onClick={() => setConfirmId(device.deviceId)}
                type="button"
              >
                Disconnect
              </button>
            )}
          </div>
          {confirmId === device.deviceId ? (
            <div className="space-y-2 text-[11px]">
              <p className="text-white/60">
                This device will need a new pairing code to return.
              </p>
              <div className="flex gap-3">
                <button
                  className="text-rose-300 disabled:opacity-50"
                  disabled={busyId !== null}
                  onClick={() => disconnect(device.deviceId)}
                  type="button"
                >
                  {busyId === device.deviceId
                    ? "Disconnecting…"
                    : "Disconnect device"}
                </button>
                <button
                  className="text-white/60"
                  disabled={busyId !== null}
                  onClick={() => setConfirmId(null)}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}
