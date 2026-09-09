use std::collections::BTreeSet;
use std::fs::{self, symlink_metadata};
use std::path::Path;

use serde::Deserialize;

use crate::error::{ErrorCode, GuestError};
use crate::protocol::{validate_id, RunPayload};

const POLICY_PATH: &str = "/etc/openbot/guest-policy.json";

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyFile {
    #[serde(rename = "schemaVersion")]
    schema_version: u8,
    #[serde(rename = "networkProfile")]
    network_profile: String,
    executables: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct GuestPolicy {
    executables: BTreeSet<String>,
}

impl GuestPolicy {
    pub fn load() -> Result<Self, GuestError> {
        let path = Path::new(POLICY_PATH);
        let metadata = symlink_metadata(path).map_err(|_| {
            GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime policy is unavailable.",
            )
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime policy is unsafe.",
            ));
        }
        let raw = fs::read(path).map_err(|_| {
            GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime policy is unavailable.",
            )
        })?;
        let file: PolicyFile = serde_json::from_slice(&raw).map_err(|_| {
            GuestError::new(ErrorCode::RuntimeUnhealthy, "Runtime policy is invalid.")
        })?;
        Self::from_file(file)
    }

    fn from_file(file: PolicyFile) -> Result<Self, GuestError> {
        if file.schema_version != 1
            || file.network_profile != "none"
            || file.executables.is_empty()
            || file.executables.len() > 64
        {
            return Err(GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime policy is invalid.",
            ));
        }
        let mut executables = BTreeSet::new();
        for executable in file.executables {
            if executable.len() > 64
                || validate_id(&executable).is_err()
                || !executable
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'+'))
            {
                return Err(GuestError::new(
                    ErrorCode::RuntimeUnhealthy,
                    "Runtime policy is invalid.",
                ));
            }
            executables.insert(executable);
        }
        if executables.is_empty() {
            return Err(GuestError::new(
                ErrorCode::RuntimeUnhealthy,
                "Runtime policy is invalid.",
            ));
        }
        Ok(Self { executables })
    }

    pub fn allows(&self, payload: &RunPayload) -> bool {
        self.executables.contains(&payload.executable)
    }

    #[cfg(test)]
    fn from_json(raw: &str) -> Result<Self, GuestError> {
        let file: PolicyFile = serde_json::from_str(raw).map_err(|_| {
            GuestError::new(ErrorCode::RuntimeUnhealthy, "Runtime policy is invalid.")
        })?;
        Self::from_file(file)
    }
}

#[cfg(test)]
mod tests {
    use super::GuestPolicy;

    #[test]
    fn policy_is_strict_and_allowlists_only_names() {
        let policy = GuestPolicy::from_json(
            r#"{"schemaVersion":1,"networkProfile":"none","executables":["node","python3"]}"#,
        )
        .unwrap();
        assert!(policy.executables.contains("node"));
        assert!(GuestPolicy::from_json(
            r#"{"schemaVersion":1,"networkProfile":"none","executables":["/bin/sh"]}"#,
        )
        .is_err());
        assert!(GuestPolicy::from_json(
            r#"{"schemaVersion":1,"networkProfile":"none","executables":[]}"#,
        )
        .is_err());
        assert!(GuestPolicy::from_json(
            r#"{"schemaVersion":1,"networkProfile":"none","executables":["node"],"extra":true}"#,
        )
        .is_err());
    }
}
