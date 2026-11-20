export interface StoredEvent {
  boardId: string | null;
  payload: string;
  seq: number;
  ts: number;
  type: string;
}

export interface StoredSnapshot {
  blob: string;
  seq: number;
  ts: number;
}

export interface EventToAppend {
  boardId: string | null;
  payload: string;
  ts: number;
  type: string;
}

export interface MetaChange {
  key: string;
  value: string | null;
}

export interface StoredPushSubscription {
  createdAt: number | null;
  deviceId: string | null;
  endpoint: string;
  expirationAt: number | null;
  keyId: string | null;
  keys: string;
  updatedAt: number | null;
}

export interface PushSubscriptionRow {
  createdAt: number;
  deviceId: string;
  endpoint: string;
  expirationAt: number | null;
  keyId: string;
  keys: string;
  updatedAt: number;
}
