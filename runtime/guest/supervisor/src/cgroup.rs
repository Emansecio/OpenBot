use std::ffi::CString;
use std::fs::{self, read_to_string, symlink_metadata, write};
use std::mem::MaybeUninit;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use crate::error::{ErrorCode, GuestError};

const CGROUP_ROOT: &str = "/sys/fs/cgroup/openbot";
const MAX_PIDS: &str = "128";
const MAX_MEMORY: &str = "536870912";
const MAX_SWAP: &str = "0";
const CPU_MAX: &str = "100000 100000";
const ENABLED_CONTROLLERS: &str = "+cpu +memory +pids";
const REQUIRED_CONTROLLERS: [&str; 3] = ["cpu", "memory", "pids"];
const CGROUP2_SUPER_MAGIC: u64 = 0x6367_7270;

pub fn expected_path(boot_id: &str, lease_id: &str) -> Result<PathBuf, GuestError> {
    validate_component(boot_id)?;
    validate_component(lease_id)?;
    Ok(PathBuf::from(CGROUP_ROOT).join(boot_id).join(lease_id))
}

pub fn check_cgroup_v2() -> Result<(), GuestError> {
    let root = Path::new("/sys/fs/cgroup");
    let root_metadata = symlink_metadata(root)
        .map_err(|_| GuestError::new(ErrorCode::RuntimeUnhealthy, "cgroup v2 is unavailable."))?;
    if !root_metadata.is_dir()
        || root_metadata.file_type().is_symlink()
        || !is_cgroup2_filesystem(root)
    {
        return Err(GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "cgroup v2 filesystem is unavailable.",
        ));
    }
    let controllers = root.join("cgroup.controllers");
    let metadata = symlink_metadata(controllers)
        .map_err(|_| GuestError::new(ErrorCode::RuntimeUnhealthy, "cgroup v2 is unavailable."))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "cgroup v2 is unavailable.",
        ));
    }
    let available = read_to_string(root.join("cgroup.controllers")).map_err(|_| {
        GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "required cgroup controllers are unavailable.",
        )
    })?;
    if !has_required_controllers(&available) {
        return Err(GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "required cgroup controllers are unavailable.",
        ));
    }
    Ok(())
}

#[derive(Debug)]
pub struct LeaseCgroup {
    path: PathBuf,
}

impl LeaseCgroup {
    pub fn create(boot_id: &str, lease_id: &str) -> Result<Self, GuestError> {
        check_cgroup_v2()?;
        let path = expected_path(boot_id, lease_id)?;
        let root = PathBuf::from(CGROUP_ROOT);
        let boot = root.join(boot_id);
        let mut root_created = false;
        let mut boot_created = false;
        let mut lease_created = false;
        let result = (|| {
            // WSL exposes the controllers at the cgroup v2 mount root but leaves
            // subtree_control empty. Delegate the allowlisted controllers before
            // creating OpenBot's managed subtree.
            enable_controllers(Path::new("/sys/fs/cgroup"))?;
            root_created = ensure_directory(&root)?;
            enable_controllers(&root)?;
            boot_created = ensure_directory(&boot)?;
            enable_controllers(&boot)?;
            debug_assert_eq!(path, boot.join(lease_id));
            fs::create_dir(&path).map_err(|_| {
                GuestError::new(ErrorCode::SandboxSetupFailed, "cgroup setup failed.")
            })?;
            lease_created = true;
            assert_directory(&path)?;
            for (name, value) in [
                ("pids.max", MAX_PIDS),
                ("memory.max", MAX_MEMORY),
                ("memory.swap.max", MAX_SWAP),
                ("cpu.max", CPU_MAX),
            ] {
                write(path.join(name), value).map_err(|_| {
                    GuestError::new(
                        ErrorCode::SandboxSetupFailed,
                        "cgroup limits are unavailable.",
                    )
                })?;
            }
            Ok(())
        })();
        match result {
            Ok(_) => Ok(Self { path }),
            Err(error) => {
                // Best effort only: the setup error is the actionable failure,
                // and cleanup must never mask it. Remove every object created by
                // this attempt, including a cgroup whose limit write failed.
                cleanup_partial(
                    &path,
                    lease_created,
                    &boot,
                    boot_created,
                    &root,
                    root_created,
                );
                Err(error)
            }
        }
    }

    pub fn for_lease(boot_id: &str, lease_id: &str) -> Result<Self, GuestError> {
        let path = expected_path(boot_id, lease_id)?;
        assert_directory(Path::new(CGROUP_ROOT))?;
        let boot = path.parent().ok_or_else(|| {
            GuestError::new(ErrorCode::SandboxSetupFailed, "cgroup path is unavailable.")
        })?;
        assert_directory(boot)?;
        assert_directory(&path)?;
        Ok(Self { path })
    }

    /// Resolve a persisted lease cgroup during recovery. A cgroup can already
    /// be gone after a previous partial teardown; that is a successful
    /// cleanup state. Unsafe objects and other filesystem failures remain
    /// errors so recovery stays fail-closed.
    pub fn for_lease_if_present(boot_id: &str, lease_id: &str) -> Result<Option<Self>, GuestError> {
        let path = expected_path(boot_id, lease_id)?;
        if !assert_directory_if_present(Path::new(CGROUP_ROOT))? {
            return Ok(None);
        }
        let boot = path.parent().ok_or_else(|| {
            GuestError::new(ErrorCode::SandboxSetupFailed, "cgroup path is unavailable.")
        })?;
        if !assert_directory_if_present(boot)? {
            return Ok(None);
        }
        if !assert_directory_if_present(&path)? {
            return Ok(None);
        }
        Ok(Some(Self { path }))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn add_pid(&self, pid: libc::pid_t) -> Result<(), GuestError> {
        write(self.path.join("cgroup.procs"), pid.to_string()).map_err(|_| {
            GuestError::new(ErrorCode::SandboxSetupFailed, "cgroup assignment failed.")
        })
    }

    pub fn kill_all(&self) -> Result<(), GuestError> {
        let kill_file = self.path.join("cgroup.kill");
        if kill_file.exists() {
            write(kill_file, "1").map_err(|_| {
                GuestError::new(ErrorCode::TeardownIncomplete, "cgroup cleanup failed.")
            })?;
        } else {
            let pids = read_to_string(self.path.join("cgroup.procs")).map_err(|_| {
                GuestError::new(ErrorCode::TeardownIncomplete, "cgroup cleanup failed.")
            })?;
            for line in pids.lines() {
                if let Ok(pid) = line.parse::<libc::pid_t>() {
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                    }
                }
            }
        }
        self.wait_empty(Duration::from_secs(2))
    }

    pub fn wait_empty(&self, timeout: Duration) -> Result<(), GuestError> {
        let deadline = Instant::now() + timeout;
        loop {
            let pids = read_to_string(self.path.join("cgroup.procs")).map_err(|_| {
                GuestError::new(ErrorCode::TeardownIncomplete, "cgroup cleanup failed.")
            })?;
            if pids.lines().all(|line| line.trim().is_empty()) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(GuestError::new(
                    ErrorCode::TeardownIncomplete,
                    "cgroup cleanup failed.",
                ));
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn remove(self) -> Result<(), GuestError> {
        match fs::remove_dir(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => {
                return Err(GuestError::new(
                    ErrorCode::TeardownIncomplete,
                    "cgroup cleanup failed.",
                ))
            }
        }
        let boot_id = self
            .path
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                GuestError::new(ErrorCode::TeardownIncomplete, "cgroup cleanup failed.")
            })?;
        Self::remove_boot_if_empty(boot_id)
    }

    pub fn remove_boot_if_empty(boot_id: &str) -> Result<(), GuestError> {
        validate_component(boot_id)?;
        let root = Path::new(CGROUP_ROOT);
        if !assert_directory_if_present(root)? {
            return Ok(());
        }
        let boot = root.join(boot_id);
        if !assert_directory_if_present(&boot)? {
            return Ok(());
        }
        match fs::remove_dir(boot) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => Ok(()),
            Err(_) => Err(GuestError::new(
                ErrorCode::TeardownIncomplete,
                "cgroup cleanup failed.",
            )),
        }
    }

    pub fn sweep_empty_boots() -> Result<(), GuestError> {
        let root = Path::new(CGROUP_ROOT);
        if !assert_directory_if_present(root)? {
            return Ok(());
        }
        sweep_empty_boot_directories(root)
    }
}

fn sweep_empty_boot_directories(root: &Path) -> Result<(), GuestError> {
    for entry in fs::read_dir(root)
        .map_err(|_| GuestError::new(ErrorCode::TeardownIncomplete, "cgroup cleanup failed."))?
    {
        let entry = entry.map_err(|_| {
            GuestError::new(ErrorCode::TeardownIncomplete, "cgroup cleanup failed.")
        })?;
        let file_type = entry.file_type().map_err(|_| {
            GuestError::new(ErrorCode::TeardownIncomplete, "cgroup cleanup failed.")
        })?;
        if file_type.is_symlink() {
            return Err(GuestError::new(
                ErrorCode::TeardownIncomplete,
                "cgroup cleanup failed.",
            ));
        }
        if !file_type.is_dir() {
            continue;
        }
        let boot_id = entry.file_name().into_string().map_err(|_| {
            GuestError::new(ErrorCode::TeardownIncomplete, "cgroup cleanup failed.")
        })?;
        validate_component(&boot_id)?;
        match fs::remove_dir(entry.path()) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => {}
            Err(_) => {
                return Err(GuestError::new(
                    ErrorCode::TeardownIncomplete,
                    "cgroup cleanup failed.",
                ))
            }
        }
    }
    Ok(())
}

fn enable_controllers(path: &Path) -> Result<(), GuestError> {
    write(path.join("cgroup.subtree_control"), ENABLED_CONTROLLERS).map_err(|_| {
        GuestError::new(
            ErrorCode::SandboxSetupFailed,
            "cgroup controllers are unavailable.",
        )
    })
}

fn validate_component(value: &str) -> Result<(), GuestError> {
    if value.is_empty()
        || value.len() > 256
        || value.contains('/')
        || value.contains('\\')
        || value == "."
        || value == ".."
        || value.bytes().any(|byte| byte == 0 || byte < 0x20)
    {
        return Err(GuestError::new(
            ErrorCode::SandboxSetupFailed,
            "cgroup identity is invalid.",
        ));
    }
    Ok(())
}

fn assert_directory(path: &Path) -> Result<(), GuestError> {
    let metadata = symlink_metadata(path).map_err(|_| {
        GuestError::new(ErrorCode::SandboxSetupFailed, "cgroup path is unavailable.")
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(GuestError::new(
            ErrorCode::SandboxSetupFailed,
            "cgroup path is unsafe.",
        ));
    }
    Ok(())
}

fn assert_directory_if_present(path: &Path) -> Result<bool, GuestError> {
    let metadata = match symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => {
            return Err(GuestError::new(
                ErrorCode::SandboxSetupFailed,
                "cgroup path is unavailable.",
            ))
        }
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(GuestError::new(
            ErrorCode::SandboxSetupFailed,
            "cgroup path is unsafe.",
        ));
    }
    Ok(true)
}

fn ensure_directory(path: &Path) -> Result<bool, GuestError> {
    match symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(false),
        Ok(_) => Err(GuestError::new(
            ErrorCode::SandboxSetupFailed,
            "cgroup path is unsafe.",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|_| {
                GuestError::new(ErrorCode::SandboxSetupFailed, "cgroup setup failed.")
            })?;
            assert_directory(path)?;
            Ok(true)
        }
        Err(_) => Err(GuestError::new(
            ErrorCode::SandboxSetupFailed,
            "cgroup setup failed.",
        )),
    }
}

fn cleanup_partial(
    path: &Path,
    lease_created: bool,
    boot: &Path,
    boot_created: bool,
    root: &Path,
    root_created: bool,
) {
    if lease_created {
        let _ = fs::remove_dir(path);
    }
    if boot_created {
        let _ = fs::remove_dir(boot);
    }
    if root_created {
        let _ = fs::remove_dir(root);
    }
}

fn is_cgroup2_filesystem(path: &Path) -> bool {
    let Ok(path) = CString::new(path.to_string_lossy().as_bytes()) else {
        return false;
    };
    let mut stats = MaybeUninit::<libc::statfs>::zeroed();
    let result = unsafe { libc::statfs(path.as_ptr(), stats.as_mut_ptr()) };
    if result != 0 {
        return false;
    }
    let stats = unsafe { stats.assume_init() };
    stats.f_type as u64 == CGROUP2_SUPER_MAGIC
}

fn has_required_controllers(available: &str) -> bool {
    REQUIRED_CONTROLLERS
        .iter()
        .all(|required| available.split_whitespace().any(|item| item == *required))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::time::Duration;

    use super::{has_required_controllers, sweep_empty_boot_directories, LeaseCgroup};

    #[test]
    fn required_controllers_fail_closed_when_one_is_missing() {
        assert!(has_required_controllers("cpu memory pids"));
        assert!(!has_required_controllers("cpu memory"));
        assert!(!has_required_controllers("cpu memory pids-extra"));
    }

    #[test]
    fn wait_empty_propagates_a_read_failure() {
        let path = std::env::temp_dir().join(format!(
            "openbot-cgroup-read-failure-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir(&path).expect("create test cgroup directory");
        let result = LeaseCgroup { path: path.clone() }
            .wait_empty(Duration::ZERO)
            .expect_err("missing cgroup.procs must not be treated as empty");
        assert_eq!(result.code.as_str(), "teardown_incomplete");
        fs::remove_dir_all(path).expect("remove test cgroup directory");
    }

    #[test]
    fn empty_boot_sweep_preserves_active_directories_and_rejects_links() {
        let root =
            std::env::temp_dir().join(format!("openbot-cgroup-sweep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("boot-empty")).unwrap();
        fs::create_dir_all(root.join("boot-active").join("lease-active")).unwrap();

        sweep_empty_boot_directories(&root).unwrap();

        assert!(!root.join("boot-empty").exists());
        assert!(root.join("boot-active").join("lease-active").exists());
        symlink(root.join("boot-active"), root.join("boot-link")).unwrap();
        assert!(sweep_empty_boot_directories(&root).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
