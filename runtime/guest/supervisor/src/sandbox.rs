use std::ffi::CString;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{FromRawFd, RawFd};
use std::thread;
use std::time::{Duration, Instant};

use crate::cgroup::LeaseCgroup;
use crate::error::{ErrorCode, GuestError};
use crate::mounts::MountTree;
use crate::policy::GuestPolicy;
use crate::protocol::{validate_run_with_policy, ProcessResponse, RunPayload, MAX_OUTPUT_BYTES};
use crate::seccomp;
use crate::state::LeaseRecord;

const CHILD_SETUP_FAILED: i32 = 125;

pub fn run(lease: &LeaseRecord, payload: &RunPayload) -> Result<ProcessResponse, GuestError> {
    let policy = GuestPolicy::load()?;
    validate_run_with_policy(payload, &policy)?;
    let cgroup = LeaseCgroup::for_lease(&lease.runtime_boot_id, &lease.lease_id)?;
    let (stdin_read, stdin_write) = pipe()?;
    let (stdout_read, stdout_write) = pipe()?;
    let (stderr_read, stderr_write) = pipe()?;
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(GuestError::new(
            ErrorCode::SandboxSetupFailed,
            "Process setup failed.",
        ));
    }
    if pid == 0 {
        close(stdin_write);
        close(stdout_read);
        close(stderr_read);
        child_entry(
            stdin_read,
            stdout_write,
            stderr_write,
            &lease.lease_id,
            payload,
        );
    }
    close(stdin_read);
    close(stdout_write);
    close(stderr_write);
    if let Err(error) = cgroup.add_pid(pid) {
        unsafe {
            libc::kill(pid, libc::SIGKILL);
            libc::waitpid(pid, std::ptr::null_mut(), 0);
        }
        close(stdin_write);
        close(stdout_read);
        close(stderr_read);
        return Err(error);
    }
    unsafe {
        libc::kill(pid, libc::SIGCONT);
    }

    let input = payload.stdin.clone().unwrap_or_default().into_bytes();
    let input_thread = thread::spawn(move || {
        let mut file = unsafe { File::from_raw_fd(stdin_write) };
        let _ = file.write_all(&input);
    });
    let stdout_thread = thread::spawn(move || read_limited(stdout_read));
    let stderr_thread = thread::spawn(move || read_limited(stderr_read));

    let started = Instant::now();
    let deadline = started + Duration::from_millis(payload.timeout_ms);
    let mut status = 0;
    let mut timed_out = false;
    loop {
        let result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if result == pid {
            break;
        }
        if result < 0 {
            let _ = cgroup.kill_all();
            return Err(GuestError::new(
                ErrorCode::SandboxSetupFailed,
                "Process wait failed.",
            ));
        }
        if Instant::now() >= deadline {
            timed_out = true;
            cgroup.kill_all()?;
            unsafe {
                libc::waitpid(pid, &mut status, 0);
            }
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    let _ = input_thread.join();
    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();
    cgroup.wait_empty(Duration::from_secs(2))?;
    if timed_out {
        return Err(GuestError::new(
            ErrorCode::ProcessTimeout,
            "Process execution timed out.",
        ));
    }

    let (exit_code, signal) = if libc::WIFEXITED(status) {
        (Some(libc::WEXITSTATUS(status)), None)
    } else if libc::WIFSIGNALED(status) {
        (None, Some(format!("SIG{}", libc::WTERMSIG(status))))
    } else {
        (None, None)
    };
    if exit_code == Some(CHILD_SETUP_FAILED) {
        return Err(GuestError::new(
            ErrorCode::SandboxSetupFailed,
            setup_failure_message(&stderr.text),
        ));
    }
    let duration_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    Ok(ProcessResponse {
        ok: true,
        operation: "process.run",
        stdout: stdout.text,
        stderr: stderr.text,
        exit_code,
        signal,
        duration_ms,
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
    })
}

fn child_entry(
    stdin: RawFd,
    stdout: RawFd,
    stderr: RawFd,
    lease_id: &str,
    payload: &RunPayload,
) -> ! {
    unsafe {
        libc::dup2(stdin, libc::STDIN_FILENO);
        libc::dup2(stdout, libc::STDOUT_FILENO);
        libc::dup2(stderr, libc::STDERR_FILENO);
        close(stdin);
        close(stdout);
        close(stderr);
        libc::kill(libc::getpid(), libc::SIGSTOP);
        let flags = libc::CLONE_NEWNS
            | libc::CLONE_NEWPID
            | libc::CLONE_NEWIPC
            | libc::CLONE_NEWUTS
            | libc::CLONE_NEWNET;
        if libc::unshare(flags) != 0 {
            child_setup_failed("unshare-failed");
        }
        let nested = libc::fork();
        if nested < 0 {
            child_setup_failed("nested-fork-failed");
        }
        if nested > 0 {
            let mut status = 0;
            libc::waitpid(nested, &mut status, 0);
            if libc::WIFEXITED(status) {
                libc::_exit(libc::WEXITSTATUS(status));
            }
            if libc::WIFSIGNALED(status) {
                child_setup_failed("nested-process-signal");
            }
            child_setup_failed("nested-wait-failed");
        }
    }
    // Resolve the per-agent account against the distro's /etc/passwd before
    // entering the immutable rootfs. The numeric identity remains valid after
    // chroot and avoids mutating the packaged rootfs for every agent.
    let (uid, gid) = match seccomp::resolve_user_ids(payload.linux_user.as_deref()) {
        Ok(identity) => identity,
        Err(error) => child_setup_failed(error.message),
    };
    let mounts = match MountTree::prepare(lease_id, &payload.workspace_windows_path, uid, gid) {
        Ok(mounts) => mounts,
        Err(error) => child_setup_failed(error.message),
    };
    if mounts.enter().is_err() {
        child_setup_failed("chroot-failed");
    }
    let cwd = format!("/workspace/{}", payload.cwd);
    let cwd = match CString::new(cwd) {
        Ok(value) => value,
        Err(_) => unsafe { libc::_exit(CHILD_SETUP_FAILED) },
    };
    if unsafe { libc::chdir(cwd.as_ptr()) } != 0 {
        child_setup_failed("cwd-failed");
    }
    if seccomp::drop_privileges(uid, gid).is_err() {
        child_setup_failed("privilege-drop-failed");
    }
    if seccomp::install().is_err() || !seccomp::is_active() {
        child_setup_failed("seccomp-failed");
    }
    exec_allowlisted(payload);
}

fn exec_allowlisted(payload: &RunPayload) -> ! {
    let executable = format!("/usr/bin/{}", payload.executable);
    let executable = match CString::new(executable) {
        Ok(value) => value,
        Err(_) => unsafe { libc::_exit(CHILD_SETUP_FAILED) },
    };
    let mut arguments = Vec::with_capacity(payload.argv.len() + 1);
    arguments.push(executable.clone());
    for argument in &payload.argv {
        match CString::new(argument.as_str()) {
            Ok(value) => arguments.push(value),
            Err(_) => unsafe { libc::_exit(CHILD_SETUP_FAILED) },
        }
    }
    let mut argv: Vec<*const libc::c_char> = arguments.iter().map(|value| value.as_ptr()).collect();
    argv.push(std::ptr::null());
    let mut environment = vec![
        CString::new("HOME=/home/openbot").unwrap(),
        CString::new("PATH=/usr/bin:/bin").unwrap(),
    ];
    if let Some(entries) = &payload.env {
        for (key, value) in entries {
            if let Ok(variable) = CString::new(format!("{key}={value}")) {
                environment.push(variable);
            }
        }
    }
    let mut envp: Vec<*const libc::c_char> =
        environment.iter().map(|value| value.as_ptr()).collect();
    envp.push(std::ptr::null());
    unsafe {
        libc::execve(executable.as_ptr(), argv.as_ptr(), envp.as_ptr());
        child_setup_failed("exec-failed");
    }
}

fn setup_failure_message(stderr: &str) -> &'static str {
    match stderr.trim() {
        "unshare-failed" => "Sandbox namespace setup failed.",
        "nested-fork-failed" => "Sandbox nested process setup failed.",
        "nested-wait-failed" => "Sandbox nested process wait failed.",
        "nested-process-signal" => "Sandbox worker was terminated by a signal.",
        "DrvFs mount permission denied." => "Sandbox workspace drive mount permission denied.",
        "DrvFs mount arguments rejected." => "Sandbox workspace drive mount arguments rejected.",
        "DrvFs mount source unavailable." => "Sandbox workspace drive mount source unavailable.",
        "DrvFs filesystem unavailable." => "Sandbox workspace drive filesystem unavailable.",
        "DrvFs mount target busy." => "Sandbox workspace drive mount target busy.",
        "DrvFs mount helper failed." => "Sandbox workspace drive mount helper failed.",
        "DrvFs mount failed." => "Sandbox workspace drive mount failed.",
        "Tmpfs mount permission denied." => "Sandbox tmpfs mount permission denied.",
        "Tmpfs mount failed." => "Sandbox tmpfs mount failed.",
        "Proc mount permission denied." => "Sandbox proc mount permission denied.",
        "Proc mount failed." => "Sandbox proc mount failed.",
        "Mount setup failed." => "Sandbox filesystem mount failed.",
        "Rootfs bind mount failed." => "Sandbox rootfs bind mount failed.",
        "Workspace bind mount failed." => "Sandbox workspace bind mount failed.",
        "Bind mount failed." => "Sandbox bind mount failed.",
        "Rootfs read-only mount failed." => "Sandbox rootfs protection failed.",
        "Mount namespace setup failed." => "Sandbox mount namespace setup failed.",
        "Sandbox directory is unavailable." => "Sandbox directory setup failed.",
        "Workspace bridge is unavailable." => "Sandbox workspace bridge setup failed.",
        "Sandbox path is unavailable." => "Sandbox path setup failed.",
        "Workspace path is invalid." => "Sandbox workspace path setup failed.",
        "mount-prepare-failed" => "Sandbox mount preparation failed.",
        "chroot-failed" => "Sandbox root setup failed.",
        "cwd-failed" => "Sandbox working directory setup failed.",
        "privilege-drop-failed" => "Sandbox privilege drop failed.",
        "seccomp-failed" => "Sandbox seccomp setup failed.",
        "exec-failed" => "Sandbox executable launch failed.",
        _ => "Sandbox setup failed.",
    }
}

fn child_setup_failed(message: &str) -> ! {
    unsafe {
        let bytes = message.as_bytes();
        libc::write(libc::STDERR_FILENO, bytes.as_ptr().cast(), bytes.len());
        libc::write(libc::STDERR_FILENO, b"\n".as_ptr().cast(), 1);
        libc::_exit(CHILD_SETUP_FAILED);
    }
}

#[derive(Default)]
struct Capture {
    text: String,
    truncated: bool,
}

fn read_limited(fd: RawFd) -> Capture {
    let mut file = unsafe { File::from_raw_fd(fd) };
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(bytes) => {
                if output.len() < MAX_OUTPUT_BYTES {
                    let keep = bytes.min(MAX_OUTPUT_BYTES - output.len());
                    output.extend_from_slice(&buffer[..keep]);
                    if keep < bytes {
                        truncated = true;
                    }
                } else {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    Capture {
        text: String::from_utf8_lossy(&output).into_owned(),
        truncated,
    }
}

fn pipe() -> Result<(RawFd, RawFd), GuestError> {
    let mut descriptors = [0; 2];
    if unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(GuestError::new(
            ErrorCode::SandboxSetupFailed,
            "Process pipes could not be created.",
        ));
    }
    Ok((descriptors[0], descriptors[1]))
}

fn close(fd: RawFd) {
    unsafe {
        libc::close(fd);
    }
}
