export interface Note {
  id: string;
  path: string;
  title: string;
  content: string;
  hash: string;
  tags: string[];
  modified: number;
}
export interface SyncStatus {
  state: string;
  pending: number;
  conflicts: number;
  last_sync: number | null;
  message: string | null;
}
export interface VaultInfo {
  root: string;
  name: string;
  notes: Note[];
  folders: string[];
  status: SyncStatus;
}
export interface Revision {
  id: string;
  item_id: string;
  parents: string[];
  path: string;
  kind: 'note' | 'attachment';
  deleted: boolean;
  content: string | null;
  blob_id: string | null;
  dependencies: string[];
}
export interface Conflict {
  item_id: string;
  path: string;
  reason: string;
  versions: Revision[];
}
export interface NoteLink {
  target: string;
  resolved_id: string | null;
  status: 'resolved' | 'broken' | 'ambiguous';
}
export interface LinkInfo {
  outbound: NoteLink[];
  backlinks: Note[];
}
export interface AccountInfo {
  encrypted: boolean;
  unlocked: boolean;
  connected: boolean;
  bundled_client: boolean;
  settings: { client_id: string; client_secret: string | null };
}
export interface RemoteVault {
  id: string;
  name: string;
}
