use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Note,
    Attachment,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Revision {
    pub id: String,
    #[serde(default)]
    pub created_at: u64,
    pub item_id: String,
    pub parents: Vec<String>,
    pub path: String,
    pub kind: ItemKind,
    pub deleted: bool,
    pub content: Option<String>,
    pub blob_id: Option<String>,
    pub dependencies: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub path: String,
    pub title: String,
    pub content: String,
    pub hash: String,
    pub tags: Vec<String>,
    pub modified: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Link {
    pub target: String,
    pub resolved_id: Option<String>,
    pub status: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Conflict {
    pub item_id: String,
    pub path: String,
    pub reason: String,
    pub versions: Vec<Revision>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct SyncStatus {
    pub state: String,
    pub pending: usize,
    pub conflicts: usize,
    pub last_sync: Option<u64>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SyncProgress {
    pub stage: String,
    pub completed: usize,
    pub total: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VaultInfo {
    pub root: String,
    pub name: String,
    pub notes: Vec<Note>,
    pub folders: Vec<String>,
    pub status: SyncStatus,
}
