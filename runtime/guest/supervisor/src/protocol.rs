use std::collections::BTreeMap;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

use crate::error::{ErrorCode, GuestError};
use crate::policy::GuestPolicy;

pub const MAX_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_ID_BYTES: usize = 256;
pub const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_STDIN_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FrameType {
    Start,
    Health,
    Acquire,
    Run,
    Release,
    Stop,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u8,
    #[serde(rename = "type")]
    pub frame_type: FrameType,
    #[serde(rename = "runtimeBootId")]
    pub runtime_boot_id: Option<String>,
    #[serde(rename = "leaseId")]
    pub lease_id: Option<String>,
    #[serde(rename = "agentId")]
    pub agent_id: Option<String>,
    pub nonce: String,
    pub deadline: u64,
    #[serde(rename = "policyDigest")]
    pub policy_digest: String,
    pub payload: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcquirePayload {
    #[serde(rename = "leaseId")]
    pub lease_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "runtimeBootId")]
    pub runtime_boot_id: String,
    pub capability: Capability,
    #[serde(rename = "policyDigest")]
    pub policy_digest: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Capability {
    pub kind: String,
    #[serde(rename = "networkProfile")]
    pub network_profile: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunPayload {
    pub operation: String,
    pub executable: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: Option<BTreeMap<String, String>>,
    pub stdin: Option<String>,
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: u64,
    #[serde(rename = "networkProfile")]
    pub network_profile: String,
    #[serde(rename = "workspaceWindowsPath")]
    pub workspace_windows_path: String,
    /// Per-agent Linux user the child must run as (melhoria 4). Absent on
    /// older hosts: the child falls back to the anonymous nobody account.
    #[serde(rename = "linuxUser", default)]
    pub linux_user: Option<String>,
}

/// Per-agent guest users are provisioned by the host and follow
/// `ob-` + a sanitized agent id. Anything else is rejected here as
/// defense in depth: the supervisor never elevates arbitrary names.
pub fn validate_linux_user(name: &str) -> Result<(), GuestError> {
    let valid = name.len() >= 3
        && name.len() <= 32
        && name.starts_with("ob-")
        && name
            .chars()
            .skip(3)
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if valid {
        Ok(())
    } else {
        Err(GuestError::new(
            ErrorCode::RuntimeProtocolError,
            "Runtime agent identity is invalid.",
        ))
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleasePayload {
    #[serde(rename = "sandboxId")]
    pub sandbox_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StopPayload {
    #[serde(rename = "reason")]
    pub _reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootResponse {
    pub runtime_boot_id: String,
    pub runtime_version: String,
    pub image_digest: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxResponse {
    pub sandbox_id: String,
    pub lease_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessResponse {
    pub ok: bool,
    pub operation: &'static str,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
    pub duration_ms: u64,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

pub fn parse_frame(input: &[u8], now_ms: u64) -> Result<Frame, GuestError> {
    if input.is_empty() || input.len() > MAX_FRAME_BYTES {
        return Err(GuestError::new(
            ErrorCode::RuntimeProtocolError,
            "Runtime frame is invalid.",
        ));
    }
    let mut deserializer = serde_json::Deserializer::from_slice(input);
    let frame = Frame::deserialize(&mut deserializer).map_err(|_| {
        GuestError::new(ErrorCode::RuntimeProtocolError, "Runtime frame is invalid.")
    })?;
    deserializer.end().map_err(|_| {
        GuestError::new(
            ErrorCode::RuntimeProtocolError,
            "Runtime frame has trailing data.",
        )
    })?;
    if frame.protocol_version != 1
        || frame.deadline <= now_ms
        || frame.policy_digest.len() != 64
        || !frame
            .policy_digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(GuestError::new(
            ErrorCode::RuntimeProtocolError,
            "Runtime frame is invalid.",
        ));
    }
    validate_id(&frame.nonce)?;
    validate_optional_id(frame.runtime_boot_id.as_deref())?;
    validate_optional_id(frame.lease_id.as_deref())?;
    validate_optional_id(frame.agent_id.as_deref())?;
    Ok(frame)
}

pub fn payload<T: DeserializeOwned>(value: Value) -> Result<T, GuestError> {
    serde_json::from_value(value).map_err(|_| {
        GuestError::new(
            ErrorCode::RuntimeProtocolError,
            "Runtime frame payload is invalid.",
        )
    })
}

pub fn validate_id(value: &str) -> Result<(), GuestError> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || value.bytes().any(|byte| byte == 0 || byte < 0x20)
    {
        return Err(GuestError::new(
            ErrorCode::RuntimeProtocolError,
            "Runtime identifier is invalid.",
        ));
    }
    Ok(())
}

fn validate_optional_id(value: Option<&str>) -> Result<(), GuestError> {
    if let Some(value) = value {
        validate_id(value)?;
    }
    Ok(())
}

pub fn validate_run(payload: &RunPayload) -> Result<(), GuestError> {
    validate_run_shape(payload)
}

pub fn validate_run_with_policy(
    payload: &RunPayload,
    policy: &GuestPolicy,
) -> Result<(), GuestError> {
    validate_run_shape(payload)?;
    if !policy.allows(payload) {
        return Err(GuestError::new(
            ErrorCode::ProcessNotAllowed,
            "Executable is not allowlisted.",
        ));
    }
    Ok(())
}

fn validate_run_shape(payload: &RunPayload) -> Result<(), GuestError> {
    if let Some(user) = payload.linux_user.as_deref() {
        validate_linux_user(user)?;
    }
    if payload.operation != "process.run"
        || payload.network_profile != "none"
        || payload.executable.is_empty()
        || payload.executable.contains('/')
        || payload.executable.contains('\\')
        || payload.executable.contains("..")
        || payload.argv.len() > 64
        || payload
            .argv
            .iter()
            .any(|value| value.contains('\0') || value.len() > 4096)
        || payload.cwd.is_empty()
        || payload.cwd.starts_with('/')
        || payload.cwd.split('/').any(|part| part == "..")
        || payload.timeout_ms == 0
        || payload.timeout_ms > 5 * 60 * 1000
        || payload
            .stdin
            .as_ref()
            .is_some_and(|value| value.len() > MAX_STDIN_BYTES)
        || payload.workspace_windows_path.is_empty()
    {
        return Err(GuestError::new(
            ErrorCode::ProcessNotAllowed,
            "Process capability is not allowed.",
        ));
    }
    if let Some(env) = &payload.env {
        if env.len() > 64
            || env.iter().any(|(key, value)| {
                key.is_empty()
                    || !key
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                    || value.contains('\0')
                    || value.len() > 4096
            })
        {
            return Err(GuestError::new(
                ErrorCode::ProcessNotAllowed,
                "Process environment is not allowed.",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
#[derive(Default)]
pub struct ReplayGuard {
    values: std::collections::VecDeque<String>,
    seen: std::collections::HashSet<String>,
}

#[cfg(test)]
impl ReplayGuard {
    pub fn accept(&mut self, nonce: &str) -> bool {
        if self.seen.contains(nonce) {
            return false;
        }
        self.seen.insert(nonce.to_owned());
        self.values.push_back(nonce.to_owned());
        while self.values.len() > 4096 {
            if let Some(oldest) = self.values.pop_front() {
                self.seen.remove(&oldest);
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame() -> String {
        serde_json::json!({
            "protocolVersion": 1,
            "type": "run",
            "runtimeBootId": "boot",
            "leaseId": "lease",
            "agentId": "agent",
            "nonce": "nonce",
            "deadline": 9_999_999_999_u64,
            "policyDigest": "a".repeat(64),
            "payload": {}
        })
        .to_string()
    }

    #[test]
    fn rejects_trailing_json_and_replays() {
        assert!(parse_frame(frame().as_bytes(), 1).is_ok());
        assert!(parse_frame(format!("{}x", frame()).as_bytes(), 1).is_err());
        let mut guard = ReplayGuard::default();
        assert!(guard.accept("nonce"));
        assert!(!guard.accept("nonce"));
    }

    #[test]
    fn rejects_shell_network_and_path_escape() {
        let payload = RunPayload {
            operation: "process.run".to_owned(),
            executable: "sh".to_owned(),
            argv: vec!["-c".to_owned(), "id".to_owned()],
            cwd: "../".to_owned(),
            env: None,
            stdin: None,
            timeout_ms: 1_000,
            network_profile: "web".to_owned(),
            workspace_windows_path: r"C:\Users\agent".to_owned(),
            linux_user: None,
        };
        assert!(validate_run(&payload).is_err());
    }
}
