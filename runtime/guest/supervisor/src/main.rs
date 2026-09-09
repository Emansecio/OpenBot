mod cgroup;
mod error;
mod mounts;
mod policy;
mod protocol;
mod sandbox;
mod seccomp;
mod state;

use std::env;
use std::io::{self, Read};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::{ErrorCode, ErrorResponse, GuestError};
use crate::protocol::{
    parse_frame, payload, AcquirePayload, BootResponse, Frame, FrameType, ReleasePayload,
    RunPayload, SandboxResponse, StopPayload,
};
use crate::state::{BootState, LeaseRecord, StateStore};

fn main() {
    let result = dispatch();
    match result {
        Ok(value) => print_json(&value),
        Err(error) => {
            let response = if is_process_error() {
                json!({ "ok": false, "operation": "process.run", "code": error.code.as_str(), "message": error.message })
            } else {
                serde_json::to_value(ErrorResponse::from(error)).unwrap_or_else(|_| json!({ "ok": false, "code": "runtime_protocol_error", "message": "Runtime protocol failed." }))
            };
            print_json(&response);
        }
    }
}

fn dispatch() -> Result<Value, GuestError> {
    let args: Vec<String> = env::args().skip(1).collect();
    let mut meaningful = args
        .iter()
        .filter(|arg| arg.as_str() != "--protocol-version" && arg.as_str() != "1");
    match meaningful.next().map(String::as_str) {
        Some("start") => start(),
        Some("health") => {
            let boot_id = meaningful.next().ok_or_else(|| {
                GuestError::new(
                    ErrorCode::RuntimeProtocolError,
                    "Runtime health request is invalid.",
                )
            })?;
            health(boot_id)
        }
        Some("version") => version(),
        Some("frame") => {
            let mut input = Vec::new();
            io::stdin().read_to_end(&mut input).map_err(|_| {
                GuestError::new(
                    ErrorCode::RuntimeProtocolError,
                    "Runtime frame could not be read.",
                )
            })?;
            let frame = parse_frame(&input, now_ms())?;
            handle_frame(frame)
        }
        _ => Err(GuestError::new(
            ErrorCode::RuntimeProtocolError,
            "Runtime command is invalid.",
        )),
    }
}

fn start() -> Result<Value, GuestError> {
    let (_, rootfs_digest) = state::configured_manifest()?;
    mounts::check_rootfs_digest(&rootfs_digest)?;
    policy::GuestPolicy::load()?;
    let store = StateStore::new();
    for lease in store.leases()? {
        cleanup_lease(&lease)?;
        store.delete_lease(&lease.lease_id)?;
    }
    cgroup::LeaseCgroup::sweep_empty_boots()?;
    store.reset_nonces()?;
    let boot = store.start_boot()?;
    Ok(serde_json::to_value(BootResponse::from(boot)).map_err(|_| {
        GuestError::new(
            ErrorCode::RuntimeProtocolError,
            "Runtime response is invalid.",
        )
    })?)
}

fn version() -> Result<Value, GuestError> {
    let bytes = std::fs::read("/proc/self/exe").map_err(|_| {
        GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "Runtime supervisor identity is unavailable.",
        )
    })?;
    let digest = Sha256::digest(bytes);
    Ok(json!({
        "supervisorVersion": env!("CARGO_PKG_VERSION"),
        "supervisorDigest": format!("sha256:{digest:x}"),
    }))
}

fn health(expected_boot_id: &str) -> Result<Value, GuestError> {
    let store = StateStore::new();
    let boot = store.boot()?;
    if boot.runtime_boot_id != expected_boot_id {
        return Err(GuestError::new(
            ErrorCode::RuntimeProtocolError,
            "Runtime boot identity is stale.",
        ));
    }
    let (runtime_version, image_digest) = state::configured_manifest()?;
    if boot.runtime_version != runtime_version || boot.image_digest != image_digest {
        return Err(GuestError::new(
            ErrorCode::RuntimeUnhealthy,
            "Runtime manifest changed.",
        ));
    }
    cgroup::check_cgroup_v2()?;
    mounts::check_rootfs_digest(&image_digest)?;
    policy::GuestPolicy::load()?;
    Ok(json!({ "ok": true }))
}

fn handle_frame(frame: Frame) -> Result<Value, GuestError> {
    let store = StateStore::new();
    if !store.accept_nonce(&frame.nonce)? {
        return Err(GuestError::new(
            ErrorCode::LeaseReplayed,
            "Runtime frame was replayed.",
        ));
    }
    match frame.frame_type {
        FrameType::Start => start(),
        FrameType::Health => {
            let boot_id = frame.runtime_boot_id.as_deref().ok_or_else(|| {
                GuestError::new(
                    ErrorCode::RuntimeProtocolError,
                    "Runtime boot identity is missing.",
                )
            })?;
            health(boot_id)
        }
        FrameType::Acquire => acquire(&store, &frame),
        FrameType::Run => run(&store, &frame),
        FrameType::Release => release(&store, &frame),
        FrameType::Stop => stop(&store, &frame),
    }
}

fn acquire(store: &StateStore, frame: &Frame) -> Result<Value, GuestError> {
    let boot = require_boot(store, frame)?;
    let request: AcquirePayload = payload(frame.payload.clone())?;
    if frame.lease_id.as_deref() != Some(request.lease_id.as_str())
        || frame.agent_id.as_deref() != Some(request.agent_id.as_str())
        || frame.runtime_boot_id.as_deref() != Some(request.runtime_boot_id.as_str())
        || frame.policy_digest != request.policy_digest
        || request.runtime_boot_id != boot.runtime_boot_id
        || request.capability.kind != "process.run"
        || request.capability.network_profile != "none"
        || request.expires_at <= now_ms()
    {
        return Err(GuestError::new(
            ErrorCode::RuntimeProtocolError,
            "Runtime lease request is invalid.",
        ));
    }
    if store.lease(&request.lease_id).is_ok() {
        return Err(GuestError::new(
            ErrorCode::LeaseReplayed,
            "Runtime lease was already allocated.",
        ));
    }
    let cgroup = cgroup::LeaseCgroup::create(&boot.runtime_boot_id, &request.lease_id)?;
    let sandbox_id = format!("sandbox-{}", request.lease_id);
    let lease = LeaseRecord {
        lease_id: request.lease_id.clone(),
        agent_id: request.agent_id,
        runtime_boot_id: request.runtime_boot_id,
        policy_digest: request.policy_digest,
        expires_at: request.expires_at,
        sandbox_id: sandbox_id.clone(),
        active_run: false,
        cgroup_path: cgroup.path().to_string_lossy().into_owned(),
        sandbox_path: format!("/run/openbot/sandboxes/{}", request.lease_id),
    };
    if let Err(error) = store.save_lease(&lease) {
        let _ = cgroup.kill_all();
        let _ = cgroup.remove();
        return Err(error);
    }
    Ok(serde_json::to_value(SandboxResponse {
        sandbox_id,
        lease_id: lease.lease_id,
    })
    .map_err(|_| {
        GuestError::new(
            ErrorCode::RuntimeProtocolError,
            "Runtime response is invalid.",
        )
    })?)
}

fn run(store: &StateStore, frame: &Frame) -> Result<Value, GuestError> {
    let boot = require_boot(store, frame)?;
    let payload: RunPayload = payload(frame.payload.clone())?;
    protocol::validate_run(&payload)?;
    let lease_id = frame.lease_id.as_deref().ok_or_else(|| {
        GuestError::new(
            ErrorCode::LeaseExpired,
            "Runtime lease is no longer active.",
        )
    })?;
    let agent_id = frame.agent_id.as_deref().ok_or_else(|| {
        GuestError::new(ErrorCode::AgentNotRegistered, "Runtime agent is missing.")
    })?;
    let mut lease = store.lease(lease_id)?;
    if lease.runtime_boot_id != boot.runtime_boot_id
        || lease.agent_id != agent_id
        || lease.expires_at <= now_ms()
        || lease.policy_digest != frame.policy_digest
        || lease.active_run
    {
        return Err(GuestError::new(
            ErrorCode::LeaseExpired,
            "Runtime lease is no longer active.",
        ));
    }
    lease.active_run = true;
    store.update_lease(&lease)?;
    let result = sandbox::run(&lease, &payload);
    lease.active_run = false;
    store.update_lease(&lease)?;
    match result {
        Ok(response) => serde_json::to_value(response).map_err(|_| {
            GuestError::new(
                ErrorCode::RuntimeProtocolError,
                "Runtime response is invalid.",
            )
        }),
        Err(error) => Err(error),
    }
}

fn release(store: &StateStore, frame: &Frame) -> Result<Value, GuestError> {
    let _boot = require_boot(store, frame)?;
    let lease_id = frame.lease_id.as_deref().ok_or_else(|| {
        GuestError::new(
            ErrorCode::LeaseExpired,
            "Runtime lease is no longer active.",
        )
    })?;
    let request: ReleasePayload = payload(frame.payload.clone())?;
    let lease = store.lease(lease_id)?;
    if lease.sandbox_id != request.sandbox_id {
        return Err(GuestError::new(
            ErrorCode::TeardownIncomplete,
            "Runtime lease identity does not match.",
        ));
    }
    // A host-side timeout/abort closes its wsl.exe relay but does not
    // necessarily terminate the Linux worker. Release is the compensating
    // cancellation boundary: cgroup.kill removes an active worker before the
    // lease identity is deleted. update_lease is update-only, so the detached
    // run handler cannot resurrect the record after this point.
    cleanup_lease(&lease)?;
    store.delete_lease(lease_id)?;
    Ok(json!({ "ok": true }))
}

fn stop(store: &StateStore, frame: &Frame) -> Result<Value, GuestError> {
    let _ = payload::<StopPayload>(frame.payload.clone())?;
    let _boot = require_boot(store, frame)?;
    for lease in store.leases()? {
        cleanup_lease(&lease)?;
        store.delete_lease(&lease.lease_id)?;
    }
    store.clear_boot()?;
    Ok(json!({ "ok": true }))
}

fn require_boot(store: &StateStore, frame: &Frame) -> Result<BootState, GuestError> {
    let boot = store.boot()?;
    if frame.runtime_boot_id.as_deref() != Some(boot.runtime_boot_id.as_str()) {
        return Err(GuestError::new(
            ErrorCode::RuntimeProtocolError,
            "Runtime boot identity is stale.",
        ));
    }
    Ok(boot)
}

fn cleanup_lease(lease: &LeaseRecord) -> Result<(), GuestError> {
    state::validate_lease_record(lease)?;
    for path in [Path::new("/run/openbot")] {
        let metadata = std::fs::symlink_metadata(path).map_err(|_| {
            GuestError::new(ErrorCode::TeardownIncomplete, "Sandbox cleanup failed.")
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(GuestError::new(
                ErrorCode::TeardownIncomplete,
                "Sandbox cleanup failed.",
            ));
        }
    }
    if let Some(cgroup) =
        cgroup::LeaseCgroup::for_lease_if_present(&lease.runtime_boot_id, &lease.lease_id)?
    {
        cgroup.kill_all()?;
        cgroup.remove()?;
    }
    cgroup::LeaseCgroup::remove_boot_if_empty(&lease.runtime_boot_id)?;
    remove_exact_runtime_directory(
        Path::new(&state::expected_sandbox_path(&lease.lease_id)),
        "Sandbox cleanup failed.",
    )?;
    let host_root = Path::new("/run/openbot/host");
    match std::fs::symlink_metadata(host_root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(GuestError::new(
                ErrorCode::TeardownIncomplete,
                "Workspace bridge cleanup failed.",
            ));
        }
        Ok(_) => remove_exact_runtime_directory(
            Path::new(&state::expected_host_bridge_path(&lease.lease_id)),
            "Workspace bridge cleanup failed.",
        )?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {
            return Err(GuestError::new(
                ErrorCode::TeardownIncomplete,
                "Workspace bridge cleanup failed.",
            ));
        }
    }
    Ok(())
}

fn remove_exact_runtime_directory(path: &Path, message: &'static str) -> Result<(), GuestError> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(GuestError::new(ErrorCode::TeardownIncomplete, message));
        }
    }
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(GuestError::new(ErrorCode::TeardownIncomplete, message)),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn is_process_error() -> bool {
    env::args().any(|argument| argument == "frame")
}

fn print_json(value: &Value) {
    println!("{}", serde_json::to_string(value).unwrap_or_else(|_| "{\"ok\":false,\"code\":\"runtime_protocol_error\",\"message\":\"Runtime protocol failed.\"}".to_owned()));
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::cleanup_lease;
    use crate::state::{expected_host_bridge_path, expected_sandbox_path, LeaseRecord, StateStore};

    fn test_lease(id: &str) -> LeaseRecord {
        LeaseRecord {
            lease_id: id.to_owned(),
            agent_id: "agent".to_owned(),
            runtime_boot_id: format!("boot-{id}"),
            policy_digest: "a".repeat(64),
            expires_at: 1,
            sandbox_id: format!("sandbox-{id}"),
            active_run: false,
            cgroup_path: crate::cgroup::expected_path(&format!("boot-{id}"), id)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            sandbox_path: expected_sandbox_path(id),
        }
    }

    #[test]
    fn recovery_continues_when_cgroup_is_absent_and_sandbox_remains() {
        let id = format!("cleanup-cgroup-absent-{}", std::process::id());
        let lease = test_lease(&id);
        let sandbox = expected_sandbox_path(&id);
        let _ = fs::remove_dir_all(&sandbox);
        fs::create_dir_all("/run/openbot/sandboxes").expect("create runtime sandbox root");
        fs::create_dir_all(&sandbox).expect("create sandbox fixture");

        cleanup_lease(&lease).expect("missing cgroup is already cleaned");
        assert!(!std::path::Path::new(&sandbox).exists());
    }

    #[test]
    fn cleanup_removes_only_the_exact_host_bridge_for_the_lease() {
        let id = format!("cleanup-host-{}", std::process::id());
        let lease = test_lease(&id);
        let sandbox = expected_sandbox_path(&id);
        let host_bridge = expected_host_bridge_path(&id);
        let _ = fs::remove_dir_all(&sandbox);
        let _ = fs::remove_dir_all(&host_bridge);
        fs::create_dir_all(&sandbox).expect("create sandbox fixture");
        fs::create_dir_all(&host_bridge).expect("create host bridge fixture");

        cleanup_lease(&lease).expect("exact host bridge cleanup should finish");

        assert!(!std::path::Path::new(&sandbox).exists());
        assert!(!std::path::Path::new(&host_bridge).exists());
    }

    #[test]
    fn delete_lease_retry_is_idempotent_after_partial_cleanup() {
        let id = format!("cleanup-delete-retry-{}", std::process::id());
        let lease = test_lease(&id);
        let root = std::env::temp_dir().join(format!("openbot-supervisor-delete-retry-{id}"));
        let _ = fs::remove_dir_all(&root);
        let store = StateStore::for_test(root.clone());
        store.ensure().expect("create state fixture");
        store.save_lease(&lease).expect("persist lease fixture");

        let sandbox = expected_sandbox_path(&id);
        let _ = fs::remove_dir_all(&sandbox);
        fs::create_dir_all("/run/openbot/sandboxes").expect("create runtime sandbox root");
        fs::create_dir_all(&sandbox).expect("create sandbox fixture");
        cleanup_lease(&lease).expect("partial cleanup should finish");
        store.delete_lease(&id).expect("first delete should finish");
        store
            .delete_lease(&id)
            .expect("retry delete should be idempotent");
        assert!(store.leases().expect("read state fixture").is_empty());
        let _ = fs::remove_dir_all(root);
    }
}
