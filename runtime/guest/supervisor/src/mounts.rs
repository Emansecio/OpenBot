use std::ffi::CString;
use std::fs::{self, symlink_metadata};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use sha2::{Digest, Sha256};

use crate::error::{ErrorCode, GuestError};

const ROOTFS: &str = "/usr/lib/openbot/rootfs";

pub fn check_rootfs() -> Result<(), GuestError> {
    let metadata = symlink_metadata(ROOTFS).map_err(|_| {
        GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "Runtime rootfs is unavailable.",
        )
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "Runtime rootfs is unsafe.",
        ));
    }
    Ok(())
}

pub fn check_rootfs_digest(expected: &str) -> Result<(), GuestError> {
    check_rootfs()?;
    if !expected.starts_with("sha256:")
        || expected.len() != 71
        || !expected[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "Runtime rootfs digest is invalid.",
        ));
    }
    let actual = digest_tree(Path::new(ROOTFS))?;
    if actual != expected[7..] {
        return Err(GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "Runtime rootfs digest mismatch.",
        ));
    }
    Ok(())
}

fn digest_tree(root: &Path) -> Result<String, GuestError> {
    let metadata = symlink_metadata(root).map_err(|_| {
        GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "Runtime rootfs is unavailable.",
        )
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "Runtime rootfs is unsafe.",
        ));
    }
    let mut entries = Vec::new();
    collect_entries(root, root, &mut entries)?;
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    let mut digest = Sha256::new();
    for entry in entries {
        digest.update(entry.kind);
        digest.update([0]);
        digest.update(&entry.name);
        digest.update([0]);
        digest.update(entry.mode.to_string().as_bytes());
        digest.update([0]);
        if let Some(bytes) = entry.content {
            digest.update(bytes);
        }
        digest.update([0]);
    }
    let digest = digest.finalize();
    Ok(format!("{digest:x}"))
}

struct DigestEntry {
    name: Vec<u8>,
    kind: &'static [u8],
    mode: u32,
    content: Option<Vec<u8>>,
}

fn collect_entries(
    root: &Path,
    directory: &Path,
    entries: &mut Vec<DigestEntry>,
) -> Result<(), GuestError> {
    let mut children = fs::read_dir(directory)
        .map_err(|_| {
            GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime rootfs is unavailable.",
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| {
            GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime rootfs is unavailable.",
            )
        })?;
    children.sort_by(|left, right| {
        left.file_name()
            .as_bytes()
            .cmp(right.file_name().as_bytes())
    });
    for child in children {
        let path = child.path();
        let metadata = symlink_metadata(&path).map_err(|_| {
            GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime rootfs is unavailable.",
            )
        })?;
        let relative = path.strip_prefix(root).map_err(|_| {
            GuestError::new(ErrorCode::RuntimeUnhealthy, "Runtime rootfs is unsafe.")
        })?;
        let name = relative.as_os_str().as_bytes().to_vec();
        let mode = metadata.permissions().mode() & 0o7777;
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            let target = fs::read_link(&path).map_err(|_| {
                GuestError::new(ErrorCode::RuntimeUnhealthy, "Runtime rootfs is invalid.")
            })?;
            let target_bytes = target.as_os_str().as_bytes().to_vec();
            let target_string = target.to_str().ok_or_else(|| {
                GuestError::new(ErrorCode::RuntimeUnhealthy, "Runtime rootfs is invalid.")
            })?;
            let target_path = lexical_symlink_target(root, directory, target_string)?;
            symlink_metadata(target_path).map_err(|_| {
                GuestError::new(ErrorCode::RuntimeUnhealthy, "Runtime rootfs is invalid.")
            })?;
            entries.push(DigestEntry {
                name,
                kind: b"symlink",
                mode,
                content: Some(target_bytes),
            });
        } else if file_type.is_dir() {
            entries.push(DigestEntry {
                name,
                kind: b"directory",
                mode,
                content: None,
            });
            collect_entries(root, &path, entries)?;
        } else if file_type.is_file() {
            let content = fs::read(&path).map_err(|_| {
                GuestError::new(
                    ErrorCode::RuntimeUnhealthy,
                    "Runtime rootfs is unavailable.",
                )
            })?;
            entries.push(DigestEntry {
                name,
                kind: b"file",
                mode,
                content: Some(content),
            });
        } else {
            return Err(GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime rootfs contains an unsupported entry.",
            ));
        }
    }
    Ok(())
}

fn lexical_symlink_target(root: &Path, parent: &Path, target: &str) -> Result<PathBuf, GuestError> {
    if target.is_empty() || target.contains('\0') {
        return Err(GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "Runtime rootfs contains an invalid symbolic link.",
        ));
    }
    let (base, components) = if target.starts_with('/') {
        (
            root.to_path_buf(),
            Path::new(target).components().skip(1).collect::<Vec<_>>(),
        )
    } else {
        (
            parent.to_path_buf(),
            Path::new(target).components().collect::<Vec<_>>(),
        )
    };
    let mut result = base;
    for component in components {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => result.push(value),
            Component::ParentDir => {
                if result == *root || !result.starts_with(root) || !result.pop() {
                    return Err(GuestError::new(
                        ErrorCode::RuntimeUnhealthy,
                        "Runtime rootfs symbolic link escapes rootfs.",
                    ));
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(GuestError::new(
                    ErrorCode::RuntimeUnhealthy,
                    "Runtime rootfs contains an invalid symbolic link.",
                ));
            }
        }
    }
    if !result.starts_with(root) {
        return Err(GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "Runtime rootfs symbolic link escapes rootfs.",
        ));
    }
    Ok(result)
}

pub struct MountTree {
    root: PathBuf,
    host_bridge: PathBuf,
    mounted: bool,
}

impl MountTree {
    pub fn prepare(
        lease_id: &str,
        workspace_windows_path: &str,
        workspace_uid: libc::uid_t,
        workspace_gid: libc::gid_t,
    ) -> Result<Self, GuestError> {
        check_rootfs()?;
        validate_component(lease_id)?;
        let runtime_root = Path::new("/run/openbot");
        assert_directory(runtime_root)?;
        let sandbox_root = runtime_root.join("sandboxes");
        let host_root = runtime_root.join("host");
        ensure_directory(&sandbox_root, "Sandbox directory is unavailable.")?;
        ensure_directory(&host_root, "Workspace bridge is unavailable.")?;
        let root = sandbox_root.join(lease_id);
        let host_bridge = host_root.join(lease_id);
        ensure_directory(&root, "Sandbox directory is unavailable.")?;
        ensure_directory(&host_bridge, "Workspace bridge is unavailable.")?;
        for name in ["workspace", "tmp", "run", "proc", "dev"] {
            ensure_directory(&root.join(name), "Sandbox directory is unavailable.")?;
        }
        make_private_root()?;
        let workspace_source = windows_path_to_wsl(workspace_windows_path)?;
        let drive = workspace_source
            .strip_prefix("/mnt/")
            .and_then(|value| value.split('/').next())
            .ok_or_else(|| {
                GuestError::new(ErrorCode::SandboxSetupFailed, "Workspace path is invalid.")
            })?;
        let relative = workspace_source
            .strip_prefix(&format!("/mnt/{drive}/"))
            .ok_or_else(|| {
                GuestError::new(ErrorCode::SandboxSetupFailed, "Workspace path is invalid.")
            })?;
        let drvfs_options = drvfs_mount_options(workspace_uid, workspace_gid)?;
        mount_fs(
            &format!("{}:", drive.to_ascii_uppercase()),
            &host_bridge,
            "drvfs",
            libc::MS_NOSUID | libc::MS_NODEV,
            &drvfs_options,
        )?;
        mount_bind(Path::new(ROOTFS), &root, false)?;
        remount_read_only(&root)?;
        mount_tmpfs(&root.join("tmp"), "size=64m,mode=1777")?;
        mount_tmpfs(&root.join("run"), "size=16m,mode=755")?;
        mount_dev_tmpfs(&root.join("dev"))?;
        mount_proc(&root.join("proc"))?;
        let workspace_host = host_bridge.join(relative);
        let workspace_guest = root.join("workspace");
        mount_bind(&workspace_host, &workspace_guest, false)?;
        // `.openbot` contains host-owned policy and grants metadata. Developer
        // processes may write the rest of their workspace, but must never be
        // able to promote their own access by replacing this trust root.
        let metadata_host = workspace_host.join(".openbot");
        let metadata_guest = workspace_guest.join(".openbot");
        assert_directory(&metadata_host)?;
        assert_directory(&metadata_guest)?;
        mount_bind(&metadata_host, &metadata_guest, false)?;
        remount_read_only(&metadata_guest)?;
        unmount(&host_bridge);
        Ok(Self {
            root,
            host_bridge,
            mounted: true,
        })
    }

    pub fn enter(&self) -> Result<(), GuestError> {
        let root = CString::new(self.root.as_os_str().as_bytes()).map_err(|_| {
            GuestError::new(ErrorCode::SandboxSetupFailed, "Sandbox root is invalid.")
        })?;
        if unsafe { libc::chroot(root.as_ptr()) } != 0
            || unsafe { libc::chdir(b"/\0".as_ptr().cast()) } != 0
        {
            return Err(GuestError::new(
                ErrorCode::SandboxSetupFailed,
                "Sandbox root setup failed.",
            ));
        }
        Ok(())
    }

    pub fn cleanup(&mut self) -> Result<(), GuestError> {
        if !self.mounted {
            return Ok(());
        }
        for name in ["workspace", "proc", "dev", "run", "tmp"] {
            unmount(&self.root.join(name));
        }
        unmount(&self.root);
        unmount(&self.host_bridge);
        self.mounted = false;
        fs::remove_dir_all(&self.root).map_err(|_| {
            GuestError::new(ErrorCode::TeardownIncomplete, "Sandbox cleanup failed.")
        })?;
        let _ = fs::remove_dir_all(&self.host_bridge);
        Ok(())
    }
}

fn drvfs_mount_options(uid: libc::uid_t, gid: libc::gid_t) -> Result<String, GuestError> {
    if uid == 0 || gid == 0 {
        return Err(GuestError::new(
            ErrorCode::SandboxSetupFailed,
            "Workspace owner must not be privileged.",
        ));
    }
    Ok(format!("metadata,uid={uid},gid={gid},umask=077"))
}

impl Drop for MountTree {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

pub fn windows_path_to_wsl(value: &str) -> Result<String, GuestError> {
    if value.len() < 3
        || value.as_bytes()[1] != b':'
        || !matches!(value.as_bytes()[2], b'\\' | b'/')
        || value.starts_with("\\\\")
        || value.contains('\0')
    {
        return Err(GuestError::new(
            ErrorCode::SandboxSetupFailed,
            "Workspace path is invalid.",
        ));
    }
    let drive = value.as_bytes()[0];
    if !drive.is_ascii_alphabetic() {
        return Err(GuestError::new(
            ErrorCode::SandboxSetupFailed,
            "Workspace path is invalid.",
        ));
    }
    let tail = value[3..].replace('\\', "/");
    let components: Vec<&str> = tail.split('/').filter(|part| !part.is_empty()).collect();
    if components
        .iter()
        .any(|part| *part == ".." || part.contains('\0'))
    {
        return Err(GuestError::new(
            ErrorCode::SandboxSetupFailed,
            "Workspace path is invalid.",
        ));
    }
    Ok(format!(
        "/mnt/{}/{}",
        (drive as char).to_ascii_lowercase(),
        components.join("/")
    ))
}

fn make_private_root() -> Result<(), GuestError> {
    if unsafe {
        libc::mount(
            std::ptr::null(),
            b"/\0".as_ptr().cast(),
            std::ptr::null(),
            libc::MS_REC | libc::MS_PRIVATE,
            std::ptr::null(),
        )
    } != 0
    {
        Err(GuestError::new(
            ErrorCode::SandboxSetupFailed,
            "Mount namespace setup failed.",
        ))
    } else {
        Ok(())
    }
}

fn mount_bind(source: &Path, target: &Path, read_only: bool) -> Result<(), GuestError> {
    let is_rootfs = source == Path::new(ROOTFS);
    let source = cstring(source)?;
    let target = cstring(target)?;
    let mut flags = libc::MS_BIND | libc::MS_REC;
    if read_only {
        flags |= libc::MS_RDONLY;
    }
    if unsafe {
        libc::mount(
            source.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            flags,
            std::ptr::null(),
        )
    } != 0
    {
        let message = if is_rootfs {
            "Rootfs bind mount failed."
        } else {
            "Workspace bind mount failed."
        };
        return Err(GuestError::new(ErrorCode::SandboxSetupFailed, message));
    }
    Ok(())
}

fn remount_read_only(target: &Path) -> Result<(), GuestError> {
    let target = cstring(target)?;
    if unsafe {
        libc::mount(
            std::ptr::null(),
            target.as_ptr(),
            std::ptr::null(),
            libc::MS_BIND | libc::MS_REMOUNT | libc::MS_RDONLY | libc::MS_REC,
            std::ptr::null(),
        )
    } != 0
    {
        Err(GuestError::new(
            ErrorCode::SandboxSetupFailed,
            "Rootfs read-only mount failed.",
        ))
    } else {
        Ok(())
    }
}

fn mount_tmpfs(target: &Path, options: &str) -> Result<(), GuestError> {
    mount_fs(
        "tmpfs",
        target,
        "tmpfs",
        libc::MS_NOSUID | libc::MS_NODEV,
        options,
    )
}

fn mount_dev_tmpfs(target: &Path) -> Result<(), GuestError> {
    mount_fs(
        "tmpfs",
        target,
        "tmpfs",
        libc::MS_NOSUID,
        "size=8m,mode=755",
    )?;
    for (name, major, minor) in [
        ("null", 1, 3),
        ("zero", 1, 5),
        ("random", 1, 8),
        ("urandom", 1, 9),
    ] {
        let path = target.join(name);
        let path_c = cstring(&path)?;
        match symlink_metadata(&path) {
            Ok(_) => {
                return Err(GuestError::new(
                    ErrorCode::SandboxSetupFailed,
                    "Sandbox device setup failed.",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(GuestError::new(
                    ErrorCode::SandboxSetupFailed,
                    "Sandbox device setup failed.",
                ));
            }
        }
        if unsafe {
            libc::mknod(
                path_c.as_ptr(),
                libc::S_IFCHR | 0o666,
                libc::makedev(major, minor),
            )
        } != 0
        {
            return Err(GuestError::new(
                ErrorCode::SandboxSetupFailed,
                "Sandbox device setup failed.",
            ));
        }
    }
    Ok(())
}

fn mount_proc(target: &Path) -> Result<(), GuestError> {
    mount_fs(
        "proc",
        target,
        "proc",
        libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
        "hidepid=2",
    )
}

fn mount_fs(
    source: &str,
    target: &Path,
    filesystem: &str,
    flags: libc::c_ulong,
    options: &str,
) -> Result<(), GuestError> {
    if filesystem == "drvfs" {
        let helper_options = format!("nosuid,nodev,{options}");
        let target = target.to_string_lossy().into_owned();
        let status = Command::new("/sbin/mount.drvfs")
            .args([source, target.as_str(), "-o", &helper_options])
            .status();
        if !status.is_ok_and(|value| value.success()) {
            return Err(GuestError::new(
                ErrorCode::SandboxSetupFailed,
                "DrvFs mount helper failed.",
            ));
        }
        return Ok(());
    }
    let source = CString::new(source)
        .map_err(|_| GuestError::new(ErrorCode::SandboxSetupFailed, "Mount source is invalid."))?;
    let target = cstring(target)?;
    let filesystem = CString::new(filesystem)
        .map_err(|_| GuestError::new(ErrorCode::SandboxSetupFailed, "Mount type is invalid."))?;
    let options = CString::new(options).map_err(|_| {
        GuestError::new(ErrorCode::SandboxSetupFailed, "Mount options are invalid.")
    })?;
    if unsafe {
        libc::mount(
            source.as_ptr(),
            target.as_ptr(),
            filesystem.as_ptr(),
            flags,
            options.as_ptr().cast(),
        )
    } != 0
    {
        let errno = std::io::Error::last_os_error()
            .raw_os_error()
            .unwrap_or_default();
        let message = match (filesystem.to_bytes(), errno) {
            (b"drvfs", libc::EPERM) => "DrvFs mount permission denied.",
            (b"drvfs", libc::EINVAL) => "DrvFs mount arguments rejected.",
            (b"drvfs", libc::ENOENT) => "DrvFs mount source unavailable.",
            (b"drvfs", libc::ENODEV) => "DrvFs filesystem unavailable.",
            (b"drvfs", libc::EBUSY) => "DrvFs mount target busy.",
            (b"drvfs", _) => "DrvFs mount failed.",
            (b"tmpfs", libc::EPERM) => "Tmpfs mount permission denied.",
            (b"tmpfs", _) => "Tmpfs mount failed.",
            (b"proc", libc::EPERM) => "Proc mount permission denied.",
            (b"proc", _) => "Proc mount failed.",
            _ => "Mount setup failed.",
        };
        Err(GuestError::new(ErrorCode::SandboxSetupFailed, message))
    } else {
        Ok(())
    }
}

fn unmount(path: &Path) {
    if let Ok(target) = cstring(path) {
        unsafe {
            libc::umount2(target.as_ptr(), libc::MNT_DETACH);
        }
    }
}

fn cstring(path: &Path) -> Result<CString, GuestError> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| GuestError::new(ErrorCode::SandboxSetupFailed, "Mount path is invalid."))
}

fn validate_component(value: &str) -> Result<(), GuestError> {
    if value.is_empty()
        || value.len() > 256
        || value.contains('/')
        || value.contains('\\')
        || value == "."
        || value == ".."
    {
        Err(GuestError::new(
            ErrorCode::SandboxSetupFailed,
            "Sandbox identity is invalid.",
        ))
    } else {
        Ok(())
    }
}

fn assert_directory(path: &Path) -> Result<(), GuestError> {
    let metadata = symlink_metadata(path).map_err(|_| {
        GuestError::new(
            ErrorCode::SandboxSetupFailed,
            "Sandbox path is unavailable.",
        )
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        Err(GuestError::new(
            ErrorCode::SandboxSetupFailed,
            "Sandbox path is unsafe.",
        ))
    } else {
        Ok(())
    }
}

fn ensure_directory(path: &Path, message: &'static str) -> Result<(), GuestError> {
    match symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(GuestError::new(ErrorCode::SandboxSetupFailed, message)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path)
                .map_err(|_| GuestError::new(ErrorCode::SandboxSetupFailed, message))?;
            assert_directory(path)
        }
        Err(_) => Err(GuestError::new(ErrorCode::SandboxSetupFailed, message)),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;

    use super::{digest_tree, drvfs_mount_options, ensure_directory, windows_path_to_wsl};

    fn temporary_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("openbot-supervisor-{name}-{}", std::process::id()))
    }

    #[test]
    fn converts_only_drive_absolute_paths() {
        assert_eq!(
            windows_path_to_wsl(r"C:\Users\agent-a").unwrap(),
            "/mnt/c/Users/agent-a"
        );
        assert!(windows_path_to_wsl(r"C:\Users\..\secret").is_err());
        assert!(windows_path_to_wsl(r"\\server\share").is_err());
    }

    #[test]
    fn drvfs_workspace_owner_matches_the_worker_identity() {
        assert_eq!(
            drvfs_mount_options(100, 65_533).unwrap(),
            "metadata,uid=100,gid=65533,umask=077"
        );
        assert!(drvfs_mount_options(0, 65_533).is_err());
        assert!(drvfs_mount_options(100, 0).is_err());
    }

    #[test]
    fn rootfs_digest_changes_with_content_and_rejects_escaping_links() {
        let root = temporary_root("rootfs-digest");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("usr")).unwrap();
        fs::write(root.join("usr/tool"), b"one").unwrap();
        let first = digest_tree(&root).unwrap();
        fs::write(root.join("usr/tool"), b"two").unwrap();
        let second = digest_tree(&root).unwrap();
        assert_ne!(first, second);
        fs::remove_file(root.join("usr/tool")).unwrap();
        symlink("../../outside", root.join("usr/tool")).unwrap();
        assert!(digest_tree(&root).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn derived_sandbox_directories_reject_symlink_parents() {
        let root = temporary_root("sandbox-parent");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let target = root.join("target");
        fs::create_dir_all(&target).unwrap();
        let link = root.join("link");
        symlink(&target, &link).unwrap();
        assert!(ensure_directory(&link, "unsafe").is_err());
        let _ = fs::remove_dir_all(root);
    }
}
