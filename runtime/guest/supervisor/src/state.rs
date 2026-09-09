use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{ErrorCode, GuestError};
use crate::protocol::{validate_id, BootResponse};

const STATE_ROOT: &str = "/run/openbot";
const BOOT_FILE: &str = "boot.json";
const MAX_NONCE_MARKERS: usize = 4096;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuestManifest {
    runtime_version: String,
    rootfs_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootState {
    pub runtime_boot_id: String,
    pub runtime_version: String,
    pub image_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct LeaseRecord {
    pub lease_id: String,
    pub agent_id: String,
    pub runtime_boot_id: String,
    pub policy_digest: String,
    pub expires_at: u64,
    pub sandbox_id: String,
    pub active_run: bool,
    pub cgroup_path: String,
    pub sandbox_path: String,
}

pub struct StateStore {
    root: PathBuf,
}

pub struct StateLock(File);

impl Drop for StateLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

impl StateStore {
    pub fn new() -> Self {
        Self {
            root: PathBuf::from(STATE_ROOT),
        }
    }

    #[cfg(test)]
    pub fn for_test(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn ensure(&self) -> Result<(), GuestError> {
        fs::create_dir_all(&self.root).map_err(|_| {
            GuestError::new(ErrorCode::RuntimeUnhealthy, "Runtime state is unavailable.")
        })?;
        let metadata = fs::symlink_metadata(&self.root).map_err(|_| {
            GuestError::new(ErrorCode::RuntimeUnhealthy, "Runtime state is unavailable.")
        })?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime state is unsafe.",
            ));
        }
        let leases = self.root.join("leases");
        fs::create_dir_all(&leases).map_err(|_| {
            GuestError::new(ErrorCode::RuntimeUnhealthy, "Runtime state is unavailable.")
        })?;
        let metadata = fs::symlink_metadata(leases).map_err(|_| {
            GuestError::new(ErrorCode::RuntimeUnhealthy, "Runtime state is unavailable.")
        })?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime state is unsafe.",
            ));
        }
        Ok(())
    }

    pub fn lock(&self) -> Result<StateLock, GuestError> {
        self.ensure()?;
        let lock_path = self.root.join("state.lock");
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(lock_path)
            .map_err(|_| {
                GuestError::new(
                    ErrorCode::RuntimeUnhealthy,
                    "Runtime state lock is unavailable.",
                )
            })?;
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
        if result != 0 {
            return Err(GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime state lock is unavailable.",
            ));
        }
        Ok(StateLock(file))
    }

    pub fn start_boot(&self) -> Result<BootState, GuestError> {
        let _lock = self.lock()?;
        let (runtime_version, image_digest) = configured_manifest()?;
        let boot = BootState {
            runtime_boot_id: random_id()?,
            runtime_version,
            image_digest,
        };
        write_json_atomic(&self.root.join(BOOT_FILE), &boot)?;
        Ok(boot)
    }

    pub fn boot(&self) -> Result<BootState, GuestError> {
        let mut file = File::open(self.root.join(BOOT_FILE)).map_err(|_| {
            GuestError::new(
                ErrorCode::RuntimeUnavailable,
                "Runtime boot is unavailable.",
            )
        })?;
        let mut raw = Vec::new();
        file.read_to_end(&mut raw).map_err(|_| {
            GuestError::new(
                ErrorCode::RuntimeProtocolError,
                "Runtime boot state is invalid.",
            )
        })?;
        let boot: BootState = serde_json::from_slice(&raw).map_err(|_| {
            GuestError::new(
                ErrorCode::RuntimeProtocolError,
                "Runtime boot state is invalid.",
            )
        })?;
        validate_id(&boot.runtime_boot_id)?;
        if boot.runtime_version.is_empty()
            || !boot.image_digest.starts_with("sha256:")
            || boot.image_digest.len() != 71
            || !boot.image_digest[7..]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(GuestError::new(
                ErrorCode::RuntimeProtocolError,
                "Runtime boot state is invalid.",
            ));
        }
        Ok(boot)
    }

    pub fn accept_nonce(&self, nonce: &str) -> Result<bool, GuestError> {
        let _lock = self.lock()?;
        validate_id(nonce)?;
        let directory = self.root.join("nonces");
        fs::create_dir_all(&directory).map_err(|_| {
            GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime replay state is unavailable.",
            )
        })?;
        let marker = directory.join(nonce);
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&marker)
        {
            Ok(_) => {
                trim_nonce_markers(&directory, &marker)?;
                Ok(true)
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(_) => Err(GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime replay state is unavailable.",
            )),
        }
    }

    pub fn reset_nonces(&self) -> Result<(), GuestError> {
        let directory = self.root.join("nonces");
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(directory).map_err(|_| {
            GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime replay state is unavailable.",
            )
        })
    }

    pub fn save_lease(&self, lease: &LeaseRecord) -> Result<(), GuestError> {
        validate_lease_record(lease)?;
        let _lock = self.lock()?;
        validate_id(&lease.lease_id)?;
        validate_id(&lease.agent_id)?;
        validate_id(&lease.runtime_boot_id)?;
        let directory = self.lease_dir(&lease.lease_id)?;
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(GuestError::new(
                    ErrorCode::RuntimeUnhealthy,
                    "Runtime lease state is unsafe.",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&directory).map_err(|_| {
                    GuestError::new(
                        ErrorCode::RuntimeUnhealthy,
                        "Runtime lease state is unavailable.",
                    )
                })?;
            }
            Err(_) => {
                return Err(GuestError::new(
                    ErrorCode::RuntimeUnhealthy,
                    "Runtime lease state is unavailable.",
                ));
            }
        }
        write_json_atomic(&directory.join("lease.json"), lease)
    }

    /// Updates an already-persisted lease without recreating an identity that
    /// a concurrent cancellation/release has deleted.
    pub fn update_lease(&self, lease: &LeaseRecord) -> Result<(), GuestError> {
        validate_lease_record(lease)?;
        let _lock = self.lock()?;
        let directory = self.lease_dir(&lease.lease_id)?;
        let metadata = fs::symlink_metadata(&directory).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                GuestError::new(
                    ErrorCode::LeaseExpired,
                    "Runtime lease is no longer active.",
                )
            } else {
                GuestError::new(
                    ErrorCode::RuntimeUnhealthy,
                    "Runtime lease state is unavailable.",
                )
            }
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime lease state is unsafe.",
            ));
        }
        write_json_atomic(&directory.join("lease.json"), lease)
    }

    pub fn lease(&self, lease_id: &str) -> Result<LeaseRecord, GuestError> {
        let _lock = self.lock()?;
        validate_id(lease_id)?;
        let directory = self.lease_dir(lease_id)?;
        let directory_metadata = fs::symlink_metadata(&directory).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                GuestError::new(
                    ErrorCode::LeaseExpired,
                    "Runtime lease is no longer active.",
                )
            } else {
                GuestError::new(
                    ErrorCode::RuntimeUnhealthy,
                    "Runtime lease state is invalid.",
                )
            }
        })?;
        if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
            return Err(GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime lease state is invalid.",
            ));
        }
        let record_path = directory.join("lease.json");
        let record_metadata = fs::symlink_metadata(&record_path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                GuestError::new(
                    ErrorCode::LeaseExpired,
                    "Runtime lease is no longer active.",
                )
            } else {
                GuestError::new(
                    ErrorCode::RuntimeUnhealthy,
                    "Runtime lease state is invalid.",
                )
            }
        })?;
        if record_metadata.file_type().is_symlink() || !record_metadata.is_file() {
            return Err(GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime lease state is invalid.",
            ));
        }
        let mut file = File::open(record_path).map_err(|_| {
            GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime lease state is invalid.",
            )
        })?;
        let mut raw = Vec::new();
        file.read_to_end(&mut raw).map_err(|_| {
            GuestError::new(
                ErrorCode::RuntimeProtocolError,
                "Runtime lease state is invalid.",
            )
        })?;
        let lease: LeaseRecord = serde_json::from_slice(&raw).map_err(|_| {
            GuestError::new(
                ErrorCode::RuntimeProtocolError,
                "Runtime lease state is invalid.",
            )
        })?;
        validate_lease_record(&lease)?;
        Ok(lease)
    }

    pub fn leases(&self) -> Result<Vec<LeaseRecord>, GuestError> {
        self.ensure()?;
        let mut result = Vec::new();
        let entries = fs::read_dir(self.root.join("leases")).map_err(|_| {
            GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime lease state is unavailable.",
            )
        })?;
        for entry in entries {
            let entry = entry.map_err(|_| {
                GuestError::new(
                    ErrorCode::RuntimeUnhealthy,
                    "Runtime lease state is unavailable.",
                )
            })?;
            let file_type = entry.file_type().map_err(|_| {
                GuestError::new(
                    ErrorCode::RuntimeUnhealthy,
                    "Runtime lease state is unavailable.",
                )
            })?;
            if file_type.is_symlink() || !file_type.is_dir() {
                return Err(GuestError::new(
                    ErrorCode::RuntimeUnhealthy,
                    "Runtime lease state is invalid.",
                ));
            }
            let lease_id = entry.file_name().into_string().map_err(|_| {
                GuestError::new(
                    ErrorCode::RuntimeUnhealthy,
                    "Runtime lease state is invalid.",
                )
            })?;
            validate_id(&lease_id)?;
            result.push(self.lease(&lease_id)?);
        }
        Ok(result)
    }

    pub fn delete_lease(&self, lease_id: &str) -> Result<(), GuestError> {
        let _lock = self.lock()?;
        validate_id(lease_id)?;
        let directory = self.lease_dir(lease_id)?;
        let metadata = match fs::symlink_metadata(&directory) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => {
                return Err(GuestError::new(
                    ErrorCode::RuntimeUnhealthy,
                    "Runtime lease state is unsafe.",
                ))
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime lease state is unsafe.",
            ));
        }
        match fs::remove_dir_all(directory) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // A previous recovery attempt may have removed the record
                // after its resource teardown. Treat the retry as complete.
                Ok(())
            }
            Err(_) => Err(GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime lease cleanup failed.",
            )),
        }
    }

    pub fn clear_boot(&self) -> Result<(), GuestError> {
        let _lock = self.lock()?;
        fs::remove_file(self.root.join(BOOT_FILE)).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                GuestError::new(
                    ErrorCode::RuntimeUnavailable,
                    "Runtime boot is unavailable.",
                )
            } else {
                GuestError::new(ErrorCode::RuntimeUnhealthy, "Runtime boot cleanup failed.")
            }
        })
    }

    fn lease_dir(&self, lease_id: &str) -> Result<PathBuf, GuestError> {
        validate_id(lease_id)?;
        Ok(self.root.join("leases").join(lease_id))
    }
}

fn trim_nonce_markers(directory: &Path, protected: &Path) -> Result<(), GuestError> {
    let mut markers = Vec::new();
    for entry in fs::read_dir(directory).map_err(|_| {
        GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "Runtime replay state is unavailable.",
        )
    })? {
        let entry = entry.map_err(|_| {
            GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime replay state is unavailable.",
            )
        })?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| {
            GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime replay state is unavailable.",
            )
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime replay state is unsafe.",
            ));
        }
        let modified = metadata.modified().map_err(|_| {
            GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime replay state is unavailable.",
            )
        })?;
        markers.push((modified, path));
    }
    markers.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    let remove_count = markers.len().saturating_sub(MAX_NONCE_MARKERS);
    for (_, path) in markers
        .into_iter()
        .filter(|(_, path)| path.as_path() != protected)
        .take(remove_count)
    {
        fs::remove_file(path).map_err(|_| {
            GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime replay state is unavailable.",
            )
        })?;
    }
    Ok(())
}

pub fn configured_manifest() -> Result<(String, String), GuestError> {
    let path = Path::new("/etc/openbot/manifest.json");
    let metadata = fs::symlink_metadata(path).map_err(|_| {
        GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "Runtime manifest is unavailable.",
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "Runtime manifest is unsafe.",
        ));
    }
    let raw = fs::read(path).map_err(|_| {
        GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "Runtime manifest is unavailable.",
        )
    })?;
    let manifest: GuestManifest = serde_json::from_slice(&raw).map_err(|_| {
        GuestError::new(ErrorCode::RuntimeUnhealthy, "Runtime manifest is invalid.")
    })?;
    let digest = manifest.rootfs_digest.strip_prefix("sha256:");
    if manifest.runtime_version.is_empty()
        || digest.is_none()
        || digest.is_some_and(|value| {
            value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err(GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "Runtime manifest is invalid.",
        ));
    }
    Ok((manifest.runtime_version, manifest.rootfs_digest))
}

pub fn validate_lease_record(lease: &LeaseRecord) -> Result<(), GuestError> {
    validate_id(&lease.lease_id)?;
    validate_id(&lease.agent_id)?;
    validate_id(&lease.runtime_boot_id)?;
    if lease.sandbox_id != format!("sandbox-{}", lease.lease_id)
        || lease.sandbox_path != expected_sandbox_path(&lease.lease_id)
        || lease.cgroup_path
            != crate::cgroup::expected_path(&lease.runtime_boot_id, &lease.lease_id)?
                .to_string_lossy()
        || lease.policy_digest.len() != 64
        || !lease
            .policy_digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "Runtime lease state is invalid.",
        ));
    }
    Ok(())
}

pub fn expected_sandbox_path(lease_id: &str) -> String {
    format!("/run/openbot/sandboxes/{lease_id}")
}

pub fn expected_host_bridge_path(lease_id: &str) -> String {
    format!("/run/openbot/host/{lease_id}")
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), GuestError> {
    let temporary = path.with_extension(format!(
        "tmp-{}",
        random_id().unwrap_or_else(|_| "write".to_owned())
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|_| GuestError::new(ErrorCode::RuntimeUnhealthy, "Runtime state write failed."))?;
    let encoded = serde_json::to_vec(value).map_err(|_| {
        GuestError::new(ErrorCode::RuntimeProtocolError, "Runtime state is invalid.")
    })?;
    file.write_all(&encoded)
        .map_err(|_| GuestError::new(ErrorCode::RuntimeUnhealthy, "Runtime state write failed."))?;
    file.sync_all()
        .map_err(|_| GuestError::new(ErrorCode::RuntimeUnhealthy, "Runtime state write failed."))?;
    fs::rename(&temporary, path)
        .map_err(|_| GuestError::new(ErrorCode::RuntimeUnhealthy, "Runtime state commit failed."))
}

fn random_id() -> Result<String, GuestError> {
    let mut bytes = [0_u8; 16];
    let mut file = File::open("/dev/urandom").map_err(|_| {
        GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "Runtime entropy is unavailable.",
        )
    })?;
    file.read_exact(&mut bytes).map_err(|_| {
        GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "Runtime entropy is unavailable.",
        )
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

impl From<BootState> for BootResponse {
    fn from(boot: BootState) -> Self {
        Self {
            runtime_boot_id: boot.runtime_boot_id,
            runtime_version: boot.runtime_version,
            image_digest: boot.image_digest,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;

    fn temporary_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "openbot-supervisor-state-{name}-{}",
            std::process::id()
        ))
    }

    fn valid_lease() -> LeaseRecord {
        LeaseRecord {
            lease_id: "lease".to_owned(),
            agent_id: "agent".to_owned(),
            runtime_boot_id: "boot".to_owned(),
            policy_digest: "a".repeat(64),
            expires_at: 1,
            sandbox_id: "sandbox-lease".to_owned(),
            active_run: false,
            cgroup_path: crate::cgroup::expected_path("boot", "lease")
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            sandbox_path: expected_sandbox_path("lease"),
        }
    }

    #[test]
    fn recovery_rejects_a_symlinked_lease_record() {
        let root = temporary_root("symlink-record");
        let _ = fs::remove_dir_all(&root);
        let lease_dir = root.join("leases").join("lease");
        fs::create_dir_all(&lease_dir).unwrap();
        let raw = serde_json::to_vec(&valid_lease()).unwrap();
        fs::write(lease_dir.join("target.json"), raw).unwrap();
        symlink("target.json", lease_dir.join("lease.json")).unwrap();

        let store = StateStore { root: root.clone() };
        let error = store.leases().unwrap_err();
        assert_eq!(error.code.as_str(), "runtime_unhealthy");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn lease_write_rejects_a_symlinked_lease_directory() {
        let root = temporary_root("symlink-directory");
        let _ = fs::remove_dir_all(&root);
        let leases = root.join("leases");
        let outside = root.join("outside");
        fs::create_dir_all(&leases).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, leases.join("lease")).unwrap();

        let store = StateStore { root: root.clone() };
        let error = store.save_lease(&valid_lease()).unwrap_err();
        assert_eq!(error.code.as_str(), "runtime_unhealthy");
        assert!(!outside.join("lease.json").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn lease_update_never_recreates_a_released_identity() {
        let root = temporary_root("update-after-release");
        let _ = fs::remove_dir_all(&root);
        let store = StateStore { root: root.clone() };
        store.ensure().unwrap();
        let mut lease = valid_lease();
        store.save_lease(&lease).unwrap();
        store.delete_lease(&lease.lease_id).unwrap();
        lease.active_run = false;

        let error = store.update_lease(&lease).unwrap_err();

        assert_eq!(error.code.as_str(), "lease_expired");
        assert!(!root.join("leases").join(&lease.lease_id).exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn replay_markers_are_bounded_and_the_newest_nonce_stays_replayed() {
        let root = temporary_root("bounded-nonces");
        let _ = fs::remove_dir_all(&root);
        let store = StateStore { root: root.clone() };
        store.ensure().unwrap();
        for index in 0..=MAX_NONCE_MARKERS {
            assert!(store.accept_nonce(&format!("nonce-{index}")).unwrap());
        }

        let count = fs::read_dir(root.join("nonces")).unwrap().count();
        assert_eq!(count, MAX_NONCE_MARKERS);
        assert!(!store
            .accept_nonce(&format!("nonce-{MAX_NONCE_MARKERS}"))
            .unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn nonce_trim_never_evicts_the_marker_that_was_just_accepted() {
        let root = temporary_root("protected-nonce");
        let _ = fs::remove_dir_all(&root);
        let store = StateStore { root: root.clone() };
        store.ensure().unwrap();
        let directory = root.join("nonces");
        fs::create_dir_all(&directory).unwrap();
        let protected = directory.join("nonce-current");
        fs::write(&protected, b"").unwrap();
        for index in 0..MAX_NONCE_MARKERS {
            fs::write(directory.join(format!("nonce-old-{index}")), b"").unwrap();
        }

        trim_nonce_markers(&directory, &protected).unwrap();

        assert!(protected.exists());
        assert_eq!(fs::read_dir(directory).unwrap().count(), MAX_NONCE_MARKERS);
        let _ = fs::remove_dir_all(root);
    }
}
