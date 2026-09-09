use serde::Serialize;

#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
pub enum ErrorCode {
    RuntimeUnavailable,
    RuntimeProtocolError,
    RuntimeUnhealthy,
    LeaseExpired,
    LeaseReplayed,
    AgentNotRegistered,
    SandboxSetupFailed,
    ProcessNotAllowed,
    ProcessTimeout,
    ProcessAborted,
    ProcessOutputLimit,
    TeardownIncomplete,
}

impl ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RuntimeUnavailable => "runtime_unavailable",
            Self::RuntimeProtocolError => "runtime_protocol_error",
            Self::RuntimeUnhealthy => "runtime_unhealthy",
            Self::LeaseExpired => "lease_expired",
            Self::LeaseReplayed => "lease_replayed",
            Self::AgentNotRegistered => "agent_not_registered",
            Self::SandboxSetupFailed => "sandbox_setup_failed",
            Self::ProcessNotAllowed => "process_not_allowed",
            Self::ProcessTimeout => "process_timeout",
            Self::ProcessAborted => "process_aborted",
            Self::ProcessOutputLimit => "process_output_limit",
            Self::TeardownIncomplete => "teardown_incomplete",
        }
    }
}

#[derive(Debug)]
pub struct GuestError {
    pub code: ErrorCode,
    pub message: &'static str,
}

impl GuestError {
    pub const fn new(code: ErrorCode, message: &'static str) -> Self {
        Self { code, message }
    }
}

#[derive(Serialize)]
pub struct ErrorResponse {
    pub ok: bool,
    pub code: &'static str,
    pub message: &'static str,
}

impl From<GuestError> for ErrorResponse {
    fn from(error: GuestError) -> Self {
        Self {
            ok: false,
            code: error.code.as_str(),
            message: error.message,
        }
    }
}
