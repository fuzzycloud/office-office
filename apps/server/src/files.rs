//! Private object bytes with event-sourced metadata and live member authorization.
use super::*;
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path as AxumPath, Query, State as AxumState},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response as HttpResponse},
    routing::{get, post},
};
use image::{ImageFormat, ImageReader};
use std::{io::Cursor, time::Duration};

pub const MAX_FILE_BYTES: usize = 10 * 1024 * 1024;
const MAX_AVATAR_BYTES: usize = 2 * 1024 * 1024;
const MAX_PREVIEW_BYTES: usize = 12 * 1024 * 1024;
// Shared across service instances. A permit moves into blocking work so cancelling
// an HTTP request cannot release capacity while its decoder is still running.
static PREVIEW_PERMITS: std::sync::LazyLock<Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(2)));

#[async_trait::async_trait]
pub trait BlobStore: Send + Sync {
    async fn put(&self, id: &str, data: &[u8], content_type: &str) -> anyhow::Result<()>;
    async fn get(&self, id: &str) -> anyhow::Result<Vec<u8>>;
    async fn remove(&self, id: &str) -> anyhow::Result<()>;
}

struct S3Store {
    bucket: Box<s3::Bucket>,
    prefix: String,
}
impl S3Store {
    fn from_env() -> anyhow::Result<Option<Self>> {
        let Ok(bucket_name) = std::env::var("OFFICE_FILES_BUCKET") else {
            return Ok(None);
        };
        anyhow::ensure!(
            !bucket_name.trim().is_empty(),
            "OFFICE_FILES_BUCKET must not be empty"
        );
        let prefix =
            std::env::var("OFFICE_FILES_PREFIX").unwrap_or_else(|_| "office-office/files".into());
        anyhow::ensure!(
            !prefix.trim_matches('/').is_empty()
                && !prefix.split('/').any(|s| s == "." || s == ".."),
            "OFFICE_FILES_PREFIX must be a dedicated object prefix"
        );
        let region_name = std::env::var("AWS_REGION")
            .map_err(|_| anyhow::anyhow!("file storage requires AWS_REGION"))?;
        let region = match std::env::var("AWS_ENDPOINT_URL_S3") {
            Ok(endpoint) if !endpoint.is_empty() => {
                let parsed = url::Url::parse(&endpoint)
                    .map_err(|_| anyhow::anyhow!("invalid S3 endpoint"))?;
                anyhow::ensure!(
                    parsed.scheme() == "https"
                        || parsed.scheme() == "http"
                            && parsed
                                .host_str()
                                .is_some_and(|h| matches!(h, "localhost" | "127.0.0.1" | "[::1]")),
                    "S3 endpoint requires HTTPS (HTTP is allowed only on loopback for tests)"
                );
                anyhow::ensure!(
                    parsed.username().is_empty()
                        && parsed.password().is_none()
                        && parsed.query().is_none(),
                    "S3 endpoint must not contain credentials or a query"
                );
                s3::Region::Custom {
                    region: region_name,
                    endpoint,
                }
            }
            _ => region_name
                .parse()
                .map_err(|_| anyhow::anyhow!("invalid AWS_REGION"))?,
        };
        let credentials = s3::creds::Credentials::from_env().map_err(|_| {
            anyhow::anyhow!("file storage requires valid AWS environment credentials")
        })?;
        let mut bucket = s3::Bucket::new(&bucket_name, region, credentials)
            .map_err(|_| anyhow::anyhow!("could not configure file storage"))?
            .with_path_style();
        bucket.set_request_timeout(Some(Duration::from_secs(30)));
        Ok(Some(Self {
            bucket,
            prefix: prefix.trim_matches('/').into(),
        }))
    }
    fn key(&self, id: &str) -> String {
        format!("{}/{}", self.prefix, id)
    }
}
#[async_trait::async_trait]
impl BlobStore for S3Store {
    async fn put(&self, id: &str, data: &[u8], content_type: &str) -> anyhow::Result<()> {
        let response = self
            .bucket
            .put_object_with_content_type(self.key(id), data, content_type)
            .await
            .map_err(|_| anyhow::anyhow!("object upload failed"))?;
        anyhow::ensure!(
            (200..300).contains(&response.status_code()),
            "object upload failed"
        );
        Ok(())
    }
    async fn get(&self, id: &str) -> anyhow::Result<Vec<u8>> {
        let response = self
            .bucket
            .get_object(self.key(id))
            .await
            .map_err(|_| anyhow::anyhow!("object download failed"))?;
        anyhow::ensure!(response.status_code() == 200, "object download failed");
        Ok(response.to_vec())
    }
    async fn remove(&self, id: &str) -> anyhow::Result<()> {
        let response = self
            .bucket
            .delete_object(self.key(id))
            .await
            .map_err(|_| anyhow::anyhow!("object cleanup failed"))?;
        anyhow::ensure!(
            (200..300).contains(&response.status_code()),
            "object cleanup failed"
        );
        Ok(())
    }
}

impl WorkspaceActor {
    pub(super) fn authorize_file(
        &self,
        token: &str,
        module: &str,
        record: &str,
        write: bool,
    ) -> Result<Member, ConnectError> {
        let actor = self.user(token)?;
        allowed(module, &["projects", "reports", "profile"], "file module")?;
        if module == "profile" {
            Self::permit(&actor, "team", false)?;
            if write && record != actor.id {
                return Err(denied());
            }
            if !self.state.members.iter().any(|m| m.id == record) {
                return Err(ConnectError::not_found("member not found"));
            }
        } else {
            Self::permit(&actor, module, write)?;
            if !record.is_empty()
                && !(if module == "projects" {
                    self.state.projects.iter().any(|p| p.id == record)
                } else {
                    self.state.reports.iter().any(|r| r.id == record)
                })
            {
                return Err(ConnectError::not_found("file parent record not found"));
            }
        }
        Ok(actor.member)
    }
    pub(super) fn register_file(
        &mut self,
        token: String,
        mut file: FileRecord,
    ) -> Result<FileRecord, ConnectError> {
        let actor = self.authorize_file(&token, &file.module, &file.record_id, true)?;
        if Uuid::parse_str(&file.id).is_err() || self.state.files.iter().any(|f| f.id == file.id) {
            return Err(bad("file id must be a new UUID"));
        }
        required(&file.name, "filename", 240)?;
        if file
            .name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\'))
        {
            return Err(bad("invalid filename"));
        }
        required(&file.content_type, "content type", 120)?;
        if file.size_bytes == 0 || file.size_bytes > MAX_FILE_BYTES as u64 {
            return Err(bad("file must contain 1 byte to 10 MiB"));
        }
        if file.sha256.len() != 64 || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(bad("invalid file digest"));
        }
        file.uploaded_by = actor.id;
        file.created_at = Utc::now().to_rfc3339();
        file.deleted = false;
        file.revision = 1;
        self.commit(Edit::File(file.clone()), &actor.name, "File uploaded");
        Ok(file)
    }
    pub(super) fn get_file_as(&self, token: &str, id: &str) -> Result<FileRecord, ConnectError> {
        self.user(token)?;
        let file = self
            .state
            .files
            .iter()
            .find(|f| f.id == id && !f.deleted)
            .ok_or_else(|| ConnectError::not_found("file not found"))?;
        self.authorize_file(token, &file.module, &file.record_id, false)?;
        Ok(file.clone())
    }
    pub(super) fn list_files_as(
        &self,
        token: &str,
        request: ListFilesRequest,
    ) -> Result<ListFilesResponse, ConnectError> {
        self.user(token)?;
        if !request.module.is_empty() {
            allowed(
                &request.module,
                &["projects", "reports", "profile"],
                "file module",
            )?;
        }
        let files = self
            .state
            .files
            .iter()
            .rev()
            .filter(|f| {
                !f.deleted
                    && (request.module.is_empty() || f.module == request.module)
                    && (request.record_id.is_empty() || f.record_id == request.record_id)
                    && self
                        .authorize_file(token, &f.module, &f.record_id, false)
                        .is_ok()
            })
            .cloned()
            .collect();
        Ok(ListFilesResponse {
            files,
            ..Default::default()
        })
    }
    pub(super) fn delete_file_record(
        &mut self,
        token: String,
        request: DeleteFileRequest,
    ) -> Result<FileRecord, ConnectError> {
        let mut file = self.get_file_as(&token, &request.id)?;
        let actor = self.user(&token)?;
        if file.module == "profile" {
            if file.uploaded_by != actor.id && actor.role != "admin" {
                return Err(denied());
            }
        } else {
            self.authorize_file(&token, &file.module, &file.record_id, true)?;
        }
        if request.expected_revision != file.revision {
            return Err(ConnectError::aborted(
                "file changed; refresh before retrying",
            ));
        }
        file.deleted = true;
        file.revision += 1;
        self.commit(Edit::File(file.clone()), &actor.name, "File deleted");
        let members: Vec<_> = self
            .state
            .members
            .iter()
            .filter(|m| m.avatar_file_id == file.id)
            .cloned()
            .collect();
        for mut member in members {
            member.avatar_file_id.clear();
            self.commit(
                Edit::Member(member),
                &actor.name,
                "Deleted profile image removed",
            );
        }
        Ok(file)
    }
    pub(super) fn validate_avatar_file(
        &self,
        actor: &Principal,
        file_id: &str,
        external_url: &str,
    ) -> Result<(), ConnectError> {
        let mut member = actor.member.clone();
        member.avatar_file_id = file_id.into();
        member.avatar_url = external_url.into();
        self.validate_member_avatar(&member)
    }
    pub(super) fn validate_member_avatar(&self, member: &Member) -> Result<(), ConnectError> {
        if member.avatar_file_id.is_empty() {
            return Ok(());
        }
        if !member.avatar_url.is_empty() {
            return Err(bad(
                "choose either an uploaded image or an external image URL",
            ));
        }
        if !self.state.files.iter().any(|f| {
            f.id == member.avatar_file_id
                && f.module == "profile"
                && f.record_id == member.id
                && !f.deleted
        }) {
            return Err(bad(
                "profile image must be an active image uploaded by this member",
            ));
        }
        Ok(())
    }
}

impl OfficePreviewService {
    pub fn with_file_storage_from_env(mut self) -> anyhow::Result<Self> {
        self.file_storage = S3Store::from_env()?.map(|store| Arc::new(store) as Arc<dyn BlobStore>);
        Ok(self)
    }
    pub fn with_file_storage(mut self, storage: Arc<dyn BlobStore>) -> Self {
        self.file_storage = Some(storage);
        self
    }
    pub async fn list_files(
        &self,
        token: &str,
        request: ListFilesRequest,
    ) -> Result<ListFilesResponse, ConnectError> {
        let mut response = self
            .ask(|tx| Command::ListFiles(token.into(), request, tx))
            .await?;
        response.storage_configured = self.file_storage.is_some();
        Ok(response)
    }
    pub async fn get_file(&self, token: &str, id: &str) -> Result<FileRecord, ConnectError> {
        self.ask(|tx| Command::GetFile(token.into(), id.into(), tx))
            .await
    }
    async fn file_token(&self, headers: &HeaderMap) -> Result<String, ConnectError> {
        let token = headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .filter(|t| !t.is_empty())
            .ok_or_else(|| ConnectError::unauthenticated("bearer token required"))?;
        if token.starts_with("oo_") {
            Ok(self.exchange_agent_key(token).await?.token)
        } else {
            self.agent_validate_token(token).await?;
            Ok(token.into())
        }
    }
    pub async fn upload_file(
        &self,
        token: &str,
        module: &str,
        record_id: &str,
        name: &str,
        content_type: &str,
        data: Vec<u8>,
    ) -> Result<FileRecord, ConnectError> {
        let record_id = if module == "profile" && record_id.is_empty() {
            self.workspace(token)
                .await?
                .current_user
                .ok_or_else(denied)?
                .id
                .clone()
        } else {
            record_id.into()
        };
        self.ask(|tx| Command::AuthorizeFile(token.into(), module.into(), record_id.clone(), tx))
            .await?;
        let store = self
            .file_storage
            .as_ref()
            .ok_or_else(|| ConnectError::failed_precondition("file storage is not configured"))?;
        required(name, "filename", 240)?;
        if name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\'))
        {
            return Err(bad("invalid filename"));
        }
        if data.is_empty() || data.len() > MAX_FILE_BYTES {
            return Err(bad("file must contain 1 byte to 10 MiB"));
        }
        let (name, content_type, data) = if module == "profile" {
            tokio::task::spawn_blocking({
                let name = name.to_owned();
                move || normalize_avatar(&name, &data)
            })
            .await
            .map_err(|_| ConnectError::internal("profile image processing failed"))??
        } else {
            let mime = content_type
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if !mime.contains('/')
                || mime.len() > 120
                || !mime
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"/!#$&^_.+-".contains(&b))
            {
                return Err(bad("valid Content-Type required"));
            }
            (name.to_owned(), mime, data)
        };
        let file = FileRecord {
            id: id(),
            name,
            content_type,
            size_bytes: data.len() as u64,
            module: module.into(),
            record_id,
            sha256: format!("{:x}", Sha256::digest(&data)),
            ..Default::default()
        };
        store
            .put(&file.id, &data, &file.content_type)
            .await
            .map_err(|_| ConnectError::unavailable("file upload failed; metadata was not saved"))?;
        let result = self
            .execute(token, EngineCommand::RegisterFile(file.clone()))
            .await;
        match result {
            Ok(EngineOutcome::File(file)) => Ok(file),
            Ok(_) => unreachable!(),
            Err(error) => {
                if store.remove(&file.id).await.is_err() {
                    tracing::warn!("uncommitted file object cleanup failed");
                }
                Err(error)
            }
        }
    }
    async fn preview_file(
        &self,
        token: &str,
        id: &str,
        size: PreviewSize,
    ) -> Result<Vec<u8>, ConnectError> {
        self.get_file(token, id).await?;
        let permit = PREVIEW_PERMITS
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ConnectError::unavailable("image preview is unavailable"))?;
        // Bound concurrent object downloads as well as decoding memory.
        let (_, data) = self.download_file(token, id).await?;
        let output = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            render_preview(&data, size)
        })
        .await
        .map_err(|_| ConnectError::unavailable("image preview is unavailable"))??;
        self.get_file(token, id).await?; // Recheck after potentially slow decode too.
        Ok(output)
    }
    pub async fn download_file(
        &self,
        token: &str,
        id: &str,
    ) -> Result<(FileRecord, Vec<u8>), ConnectError> {
        let file = self.get_file(token, id).await?;
        let store = self
            .file_storage
            .as_ref()
            .ok_or_else(|| ConnectError::failed_precondition("file storage is not configured"))?;
        let data = store
            .get(&file.id)
            .await
            .map_err(|_| ConnectError::unavailable("file content is unavailable"))?;
        if data.len() as u64 != file.size_bytes
            || format!("{:x}", Sha256::digest(&data)) != file.sha256
        {
            return Err(ConnectError::data_loss(
                "file content did not match its metadata",
            ));
        }
        self.get_file(token, id).await?; // Recheck revocation/deletion after object I/O.
        Ok((file, data))
    }
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum PreviewSize {
    Thumbnail,
    #[default]
    Full,
}
#[derive(Default, Deserialize)]
struct PreviewQuery {
    #[serde(default)]
    size: PreviewSize,
}

fn render_preview(data: &[u8], size: PreviewSize) -> Result<Vec<u8>, ConnectError> {
    if data.is_empty() || data.len() > MAX_FILE_BYTES {
        return Err(bad("image preview input must contain 1 byte to 10 MiB"));
    }
    let format = image::guess_format(data)
        .map_err(|_| bad("image preview requires valid PNG, JPEG or WebP"))?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        return Err(bad("image preview requires valid PNG, JPEG or WebP"));
    }
    let mut reader = ImageReader::with_format(Cursor::new(data), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|_| bad("image is invalid or exceeds 4096 × 4096 pixels"))?;
    let edge = match size {
        PreviewSize::Thumbnail => 384,
        PreviewSize::Full => 1600,
    };
    let image = if image.width() > edge || image.height() > edge {
        image.thumbnail(edge, edge)
    } else {
        image
    };
    // Normalize bit depth too: at most 1600² RGBA8 pixels keeps PNG encoding
    // bounded below 12 MiB even for incompressible input.
    let image = image::DynamicImage::ImageRgba8(image.to_rgba8());
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|_| bad("image preview could not be processed"))?;
    let output = output.into_inner();
    if output.len() > MAX_PREVIEW_BYTES {
        return Err(bad("processed image preview is too large"));
    }
    Ok(output)
}

fn normalize_avatar(name: &str, data: &[u8]) -> Result<(String, String, Vec<u8>), ConnectError> {
    if data.len() > MAX_AVATAR_BYTES {
        return Err(bad("profile image must be at most 2 MiB"));
    }
    let format =
        image::guess_format(data).map_err(|_| bad("profile image must be PNG, JPEG or WebP"))?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        return Err(bad("profile image must be PNG, JPEG or WebP"));
    }
    let mut reader = ImageReader::with_format(Cursor::new(data), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|_| bad("profile image is invalid or exceeds 4096 × 4096 pixels"))?;
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|_| bad("profile image could not be processed"))?;
    let output = output.into_inner();
    if output.len() > MAX_AVATAR_BYTES {
        return Err(bad(
            "processed profile image exceeds 2 MiB; choose a smaller image",
        ));
    }
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    let mut end = stem.len().min(236);
    while !stem.is_char_boundary(end) {
        end -= 1;
    }
    let name = format!("{}.png", &stem[..end]);
    Ok((name, "image/png".into(), output))
}

#[derive(Deserialize)]
struct UploadQuery {
    module: String,
    #[serde(default)]
    record_id: String,
    name: String,
}
pub fn router(service: Arc<OfficePreviewService>) -> Router {
    Router::new()
        .route("/api/files", post(upload))
        .route("/api/files/{id}/content", get(download))
        .route("/api/files/{id}/preview", get(preview))
        .layer(DefaultBodyLimit::max(MAX_FILE_BYTES))
        .with_state(service)
}
fn http_error(error: ConnectError) -> HttpResponse {
    use connectrpc::ErrorCode;
    let status = match error.code {
        ErrorCode::Unauthenticated => StatusCode::UNAUTHORIZED,
        ErrorCode::PermissionDenied => StatusCode::FORBIDDEN,
        ErrorCode::NotFound => StatusCode::NOT_FOUND,
        ErrorCode::InvalidArgument => StatusCode::BAD_REQUEST,
        ErrorCode::Aborted => StatusCode::CONFLICT,
        ErrorCode::FailedPrecondition => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::BAD_GATEWAY,
    };
    (status, Json(serde_json::json!({"error": error.message.unwrap_or_else(|| "file operation failed".into())}))).into_response()
}
async fn upload(
    AxumState(service): AxumState<Arc<OfficePreviewService>>,
    Query(query): Query<UploadQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> HttpResponse {
    let result = async {
        let token = service.file_token(&headers).await?;
        let mime = headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream");
        service
            .upload_file(
                &token,
                &query.module,
                &query.record_id,
                &query.name,
                mime,
                body.to_vec(),
            )
            .await
    }
    .await;
    match result {
        Ok(file) => (StatusCode::CREATED, Json(serde_json::json!({"file": file}))).into_response(),
        Err(error) => http_error(error),
    }
}
async fn preview(
    AxumState(service): AxumState<Arc<OfficePreviewService>>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<PreviewQuery>,
    headers: HeaderMap,
) -> HttpResponse {
    let result = async {
        let token = service.file_token(&headers).await?;
        service.preview_file(&token, &id, query.size).await
    }
    .await;
    match result {
        Err(error) => http_error(error),
        Ok(data) => (
            [
                (header::CONTENT_TYPE, "image/png"),
                (header::CONTENT_DISPOSITION, "inline"),
                (header::CACHE_CONTROL, "private, no-store"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                (
                    header::CONTENT_SECURITY_POLICY,
                    "default-src 'none'; sandbox",
                ),
            ],
            data,
        )
            .into_response(),
    }
}
async fn download(
    AxumState(service): AxumState<Arc<OfficePreviewService>>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> HttpResponse {
    let result = async {
        let token = service.file_token(&headers).await?;
        service.download_file(&token, &id).await
    }
    .await;
    match result {
        Err(error) => http_error(error),
        Ok((file, data)) => {
            let disposition = if file.module == "profile" {
                "inline"
            } else {
                "attachment"
            };
            let filename: String = file
                .name
                .bytes()
                .map(|b| {
                    if b.is_ascii_alphanumeric() || b"._-".contains(&b) {
                        (b as char).to_string()
                    } else {
                        format!("%{b:02X}")
                    }
                })
                .collect();
            (
                [
                    (
                        header::CONTENT_TYPE,
                        if file.module == "profile" {
                            "image/png".to_owned()
                        } else {
                            "application/octet-stream".to_owned()
                        },
                    ),
                    (
                        header::CONTENT_DISPOSITION,
                        format!("{disposition}; filename*=UTF-8''{filename}"),
                    ),
                    (header::CACHE_CONTROL, "private, no-store".into()),
                    (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
                    (
                        header::CONTENT_SECURITY_POLICY,
                        "default-src 'none'; sandbox".into(),
                    ),
                ],
                data,
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    #[derive(Default)]
    struct MemoryStore {
        objects: Mutex<HashMap<String, Vec<u8>>>,
        fail_put: AtomicBool,
    }
    #[async_trait::async_trait]
    impl BlobStore for MemoryStore {
        async fn put(&self, id: &str, data: &[u8], _: &str) -> anyhow::Result<()> {
            anyhow::ensure!(!self.fail_put.load(Ordering::Relaxed), "simulated outage");
            self.objects.lock().unwrap().insert(id.into(), data.into());
            Ok(())
        }
        async fn get(&self, id: &str) -> anyhow::Result<Vec<u8>> {
            self.objects
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("missing"))
        }
        async fn remove(&self, id: &str) -> anyhow::Result<()> {
            self.objects.lock().unwrap().remove(id);
            Ok(())
        }
    }
    async fn bootstrap(service: &OfficePreviewService) -> BootstrapAdminResponse {
        service
            .bootstrap(BootstrapAdminRequest {
                name: "Admin".into(),
                email: "admin@example.test".into(),
                password: "test-admin-password".into(),
                workspace_name: "Files test".into(),
                ..Default::default()
            })
            .await
            .unwrap()
    }
    async fn ai(service: &OfficePreviewService, token: &str, role: &str) -> SaveMemberResponse {
        let EngineOutcome::Member(result) = service
            .execute(
                token,
                EngineCommand::SaveMember(SaveMemberRequest {
                    member: Some(Member {
                        name: "File agent".into(),
                        kind: "agent".into(),
                        role: role.into(),
                        status: "active".into(),
                        ..Default::default()
                    })
                    .into(),
                    ..Default::default()
                }),
            )
            .await
            .unwrap()
        else {
            panic!()
        };
        result
    }
    fn png() -> Vec<u8> {
        let image = image::DynamicImage::new_rgb8(2, 2);
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        bytes.into_inner()
    }
    #[tokio::test]
    async fn gallery_previews_are_bounded_authorized_and_read_only() {
        use axum::{body::Body, http::Request};
        use http_body_util::BodyExt;
        use tower::ServiceExt;
        let store = Arc::new(MemoryStore::default());
        let service = Arc::new(OfficePreviewService::new().with_file_storage(store.clone()));
        let admin = bootstrap(&service).await;
        let viewer = ai(&service, &admin.token, "viewer").await;
        let mut original = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2400, 1200)
            .write_to(&mut original, ImageFormat::Png)
            .unwrap();
        let original = original.into_inner();
        let file = service
            .upload_file(
                &admin.token,
                "projects",
                "",
                "wide.png",
                "image/png",
                original.clone(),
            )
            .await
            .unwrap();
        let before = service.workspace(&admin.token).await.unwrap();
        let files_before = service
            .list_files(&admin.token, ListFilesRequest::default())
            .await
            .unwrap()
            .files;
        store.fail_put.store(true, Ordering::Relaxed);
        let app = router(service.clone());
        let request = |id: &str, size: &str, token: &str| {
            Request::builder()
                .uri(format!("/api/files/{id}/preview{size}"))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap()
        };
        for (query, expected, credential) in [
            ("?size=thumbnail", (384, 192), viewer.secret.as_str()),
            ("?size=full", (1600, 800), admin.token.as_str()),
            ("", (1600, 800), viewer.secret.as_str()),
        ] {
            let response = app
                .clone()
                .oneshot(request(&file.id, query, credential))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
            assert_eq!(response.headers()[header::CONTENT_DISPOSITION], "inline");
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "private, no-store"
            );
            assert_eq!(
                response.headers()[header::X_CONTENT_TYPE_OPTIONS],
                "nosniff"
            );
            assert_eq!(
                response.headers()[header::CONTENT_SECURITY_POLICY],
                "default-src 'none'; sandbox"
            );
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            assert!(bytes.len() <= MAX_PREVIEW_BYTES);
            let image = image::load_from_memory_with_format(&bytes, ImageFormat::Png).unwrap();
            assert_eq!((image.width(), image.height()), expected);
        }
        assert_eq!(
            app.clone()
                .oneshot(request(&file.id, "?size=other", &admin.token))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            app.clone()
                .oneshot(request(&file.id, "", "invalid"))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            store.objects.lock().unwrap().get(&file.id).unwrap(),
            &original
        );
        assert_eq!(store.objects.lock().unwrap().len(), 1);
        assert_eq!(
            service.workspace(&admin.token).await.unwrap().activity,
            before.activity
        );
        assert_eq!(
            service
                .list_files(&admin.token, ListFilesRequest::default())
                .await
                .unwrap()
                .files,
            files_before
        );
        service
            .execute(
                &admin.token,
                EngineCommand::DeleteFile(DeleteFileRequest {
                    id: file.id.clone(),
                    expected_revision: file.revision,
                    ..Default::default()
                }),
            )
            .await
            .unwrap();
        assert_eq!(
            app.clone()
                .oneshot(request(&file.id, "", &viewer.secret))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        // Revoking the raw key is checked before even looking for the file.
        service
            .rotate_agent_key(&admin.token, &viewer.member.unwrap().id)
            .await
            .unwrap();
        assert_eq!(
            app.oneshot(request(&file.id, "", &viewer.secret))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        service.close().await.unwrap();
    }
    #[tokio::test]
    async fn gallery_preview_rejects_spoofed_or_oversized_images() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let service = Arc::new(
            OfficePreviewService::new().with_file_storage(Arc::new(MemoryStore::default())),
        );
        let admin = bootstrap(&service).await;
        let app = router(service.clone());
        let mut oversized = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(4097, 1)
            .write_to(&mut oversized, ImageFormat::Png)
            .unwrap();
        for bytes in [
            b"<html><script>bad()</script></html>".to_vec(),
            b"<svg xmlns='http://www.w3.org/2000/svg'/>".to_vec(),
            b"GIF89a".to_vec(),
            oversized.into_inner(),
        ] {
            let file = service
                .upload_file(&admin.token, "reports", "", "spoof.png", "image/png", bytes)
                .await
                .unwrap();
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/files/{}/preview", file.id))
                        .header("authorization", format!("Bearer {}", admin.token))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
            assert!(!response.headers().contains_key(header::CONTENT_DISPOSITION));
        }
        service.close().await.unwrap();
    }
    #[tokio::test]
    async fn file_metadata_replays_and_soft_delete_retains_object_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("office.sqlite");
        let store = Arc::new(MemoryStore::default());
        let service = OfficePreviewService::open(&db)
            .await
            .unwrap()
            .with_file_storage(store.clone());
        let admin = bootstrap(&service).await;
        let file = service
            .upload_file(
                &admin.token,
                "reports",
                "",
                "research.md",
                "text/markdown",
                b"# Findings".to_vec(),
            )
            .await
            .unwrap();
        assert_eq!(file.uploaded_by, admin.user.clone().unwrap().id);
        service.close().await.unwrap();
        drop(service);
        let service = OfficePreviewService::open(&db)
            .await
            .unwrap()
            .with_file_storage(store.clone());
        assert_eq!(
            service
                .download_file(&admin.token, &file.id)
                .await
                .unwrap()
                .1,
            b"# Findings"
        );
        let stale = service
            .execute(
                &admin.token,
                EngineCommand::DeleteFile(DeleteFileRequest {
                    id: file.id.clone(),
                    expected_revision: 0,
                    ..Default::default()
                }),
            )
            .await
            .err()
            .unwrap();
        assert_eq!(stale.code, connectrpc::ErrorCode::Aborted);
        service
            .execute(
                &admin.token,
                EngineCommand::DeleteFile(DeleteFileRequest {
                    id: file.id.clone(),
                    expected_revision: file.revision,
                    ..Default::default()
                }),
            )
            .await
            .unwrap();
        assert_eq!(
            service
                .get_file(&admin.token, &file.id)
                .await
                .unwrap_err()
                .code,
            connectrpc::ErrorCode::NotFound
        );
        assert!(store.objects.lock().unwrap().contains_key(&file.id));
        service.close().await.unwrap();
        drop(service);
        let service = OfficePreviewService::open(&db)
            .await
            .unwrap()
            .with_file_storage(store);
        assert!(
            service
                .list_files(&admin.token, ListFilesRequest::default())
                .await
                .unwrap()
                .files
                .is_empty()
        );
        service.close().await.unwrap();
    }
    #[tokio::test]
    async fn viewer_can_upload_own_validated_avatar_but_cannot_write_attachments() {
        let store = Arc::new(MemoryStore::default());
        let service = OfficePreviewService::new().with_file_storage(store);
        let admin = bootstrap(&service).await;
        let viewer = ai(&service, &admin.token, "viewer").await;
        let token = service
            .exchange_agent_key(&viewer.secret)
            .await
            .unwrap()
            .token;
        assert_eq!(
            service
                .upload_file(
                    &token,
                    "projects",
                    "",
                    "x.txt",
                    "text/plain",
                    b"test".to_vec()
                )
                .await
                .unwrap_err()
                .code,
            connectrpc::ErrorCode::PermissionDenied
        );
        assert!(
            service
                .upload_file(
                    &token,
                    "profile",
                    "",
                    "bad.svg",
                    "image/png",
                    b"<svg/>".to_vec()
                )
                .await
                .is_err()
        );
        let file = service
            .upload_file(&token, "profile", "", &"界".repeat(80), "image/png", png())
            .await
            .unwrap();
        assert!(file.name.len() <= 240);
        service
            .execute(
                &token,
                EngineCommand::SaveProfile(SaveProfileRequest {
                    bio: "Research".into(),
                    avatar_file_id: file.id.clone(),
                    ..Default::default()
                }),
            )
            .await
            .unwrap();
        assert_eq!(
            service
                .workspace(&token)
                .await
                .unwrap()
                .current_user
                .unwrap()
                .avatar_file_id,
            file.id
        );
        assert!(
            service
                .execute(
                    &admin.token,
                    EngineCommand::SaveProfile(SaveProfileRequest {
                        avatar_file_id: file.id.clone(),
                        ..Default::default()
                    })
                )
                .await
                .is_err()
        );
        service
            .execute(
                &token,
                EngineCommand::DeleteFile(DeleteFileRequest {
                    id: file.id.clone(),
                    expected_revision: 1,
                    ..Default::default()
                }),
            )
            .await
            .unwrap();
        assert!(
            service
                .workspace(&token)
                .await
                .unwrap()
                .current_user
                .unwrap()
                .avatar_file_id
                .is_empty()
        );
        service.close().await.unwrap();
    }
    #[tokio::test]
    async fn storage_failure_does_not_commit_metadata_and_download_checks_digest() {
        let store = Arc::new(MemoryStore::default());
        let service = OfficePreviewService::new().with_file_storage(store.clone());
        let admin = bootstrap(&service).await;
        store.fail_put.store(true, Ordering::Relaxed);
        assert!(
            service
                .upload_file(
                    &admin.token,
                    "projects",
                    "",
                    "x.txt",
                    "text/plain",
                    b"test".to_vec()
                )
                .await
                .is_err()
        );
        assert!(
            service
                .list_files(&admin.token, ListFilesRequest::default())
                .await
                .unwrap()
                .files
                .is_empty()
        );
        store.fail_put.store(false, Ordering::Relaxed);
        let file = service
            .upload_file(
                &admin.token,
                "projects",
                "",
                "x.txt",
                "text/plain",
                b"test".to_vec(),
            )
            .await
            .unwrap();
        store
            .objects
            .lock()
            .unwrap()
            .insert(file.id.clone(), b"evil".to_vec());
        assert_eq!(
            service
                .download_file(&admin.token, &file.id)
                .await
                .unwrap_err()
                .code,
            connectrpc::ErrorCode::DataLoss
        );
        service.close().await.unwrap();
    }
    #[tokio::test]
    async fn raw_ai_key_http_access_rechecks_revocation_and_forces_attachment_download() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let service = Arc::new(
            OfficePreviewService::new().with_file_storage(Arc::new(MemoryStore::default())),
        );
        let admin = bootstrap(&service).await;
        let agent = ai(&service, &admin.token, "member").await;
        let app = router(service.clone());
        let request = Request::builder()
            .method("POST")
            .uri("/api/files?module=projects&name=proof.html")
            .header("authorization", format!("Bearer {}", agent.secret))
            .header("content-type", "text/html")
            .body(Body::from("<script>bad()</script>"))
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        use http_body_util::BodyExt;
        let value: serde_json::Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        let path = format!(
            "/api/files/{}/content",
            value["file"]["id"].as_str().unwrap()
        );
        let request = || {
            Request::builder()
                .uri(&path)
                .header("authorization", format!("Bearer {}", agent.secret))
                .body(Body::empty())
                .unwrap()
        };
        let response = app.clone().oneshot(request()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response.headers()[header::CONTENT_DISPOSITION]
                .to_str()
                .unwrap()
                .starts_with("attachment;")
        );
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        service
            .rotate_agent_key(&admin.token, &agent.member.unwrap().id)
            .await
            .unwrap();
        assert_eq!(
            app.oneshot(request()).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        service.close().await.unwrap();
    }
}
