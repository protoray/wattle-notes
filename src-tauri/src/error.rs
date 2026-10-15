#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Message(String),
    #[error("File operation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("Local index failed: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("Invalid data: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Invalid frontmatter: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("Network request failed: {0}")]
    Http(reqwest::Error),
}
impl From<reqwest::Error> for Error {
    fn from(error: reqwest::Error) -> Self {
        Self::Http(error.without_url())
    }
}
pub type Result<T> = std::result::Result<T, Error>;
pub fn fail(message: impl Into<String>) -> Error {
    Error::Message(message.into())
}
