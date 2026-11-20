import type { ChorusSyncSocket } from "./types";

export function createBrowserSocket(url: string): ChorusSyncSocket {
  const socket = new WebSocket(url);
  const adapter: ChorusSyncSocket = {
    close: () => socket.close(),
    onclose: null,
    onerror: null,
    onmessage: null,
    onopen: null,
    send: (data) => socket.send(data),
  };

  socket.onclose = (event) => adapter.onclose?.(event);
  socket.onerror = (event) => adapter.onerror?.(event);
  socket.onmessage = (event) => adapter.onmessage?.({ data: event.data });
  socket.onopen = () => adapter.onopen?.();

  return adapter;
}
