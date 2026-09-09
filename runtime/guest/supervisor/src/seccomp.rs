use crate::error::{ErrorCode, GuestError};

const SECCOMP_SET_MODE_FILTER: libc::c_int = 1;
const SECCOMP_FILTER_FLAG_TSYNC: libc::c_ulong = 1;
const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
const AUDIT_ARCH_X86_64: u32 = 0xc000_003e;
const SECCOMP_DATA_NR: u32 = 0;
const SECCOMP_DATA_ARCH: u32 = 4;
const SECCOMP_DATA_ARG0_LO: u32 = 16;
const SECCOMP_DATA_ARG0_HI: u32 = 20;
const BPF_LD_W_ABS: u16 = 0x20;
const BPF_ALU_AND_K: u16 = 0x54;
const BPF_JMP_JEQ_K: u16 = 0x15;
const BPF_RET_K: u16 = 0x06;
const EPERM: u32 = 1;
const ENOSYS: u32 = 38;
const CLONE_SAFE_FLAGS: u32 = (libc::CLONE_VM
    | libc::CLONE_FS
    | libc::CLONE_FILES
    | libc::CLONE_SIGHAND
    | libc::CLONE_THREAD
    | libc::CLONE_SYSVSEM
    | libc::CLONE_SETTLS
    | libc::CLONE_PARENT_SETTID
    | libc::CLONE_CHILD_CLEARTID
    | libc::CLONE_CHILD_SETTID
    | libc::CLONE_DETACHED
    | libc::CLONE_VFORK) as u32;

const ANONYMOUS_UID: libc::uid_t = 65_532;
const ANONYMOUS_GID: libc::gid_t = 65_532;

/// Resolves a per-agent guest user to its uid/gid. Fail-closed: a missing
/// account is an error, never a silent fallback to root or nobody.
pub(crate) fn resolve_user_ids(
    name: Option<&str>,
) -> Result<(libc::uid_t, libc::gid_t), GuestError> {
    let Some(name) = name else {
        return Ok((ANONYMOUS_UID, ANONYMOUS_GID));
    };
    let user = match std::ffi::CString::new(name) {
        Ok(value) => value,
        Err(_) => {
            return Err(GuestError::new(
                ErrorCode::SandboxSetupFailed,
                "Worker identity is invalid.",
            ));
        }
    };
    unsafe {
        let entry = libc::getpwnam(user.as_ptr());
        if entry.is_null() {
            return Err(GuestError::new(
                ErrorCode::SandboxSetupFailed,
                "Worker account could not be resolved.",
            ));
        }
        let uid = (*entry).pw_uid;
        let gid = (*entry).pw_gid;
        if uid == 0 || gid == 0 {
            return Err(GuestError::new(
                ErrorCode::SandboxSetupFailed,
                "Worker account must not be privileged.",
            ));
        }
        Ok((uid, gid))
    }
}

pub fn drop_privileges(uid: libc::uid_t, gid: libc::gid_t) -> Result<(), GuestError> {
    unsafe {
        if libc::setgroups(0, std::ptr::null()) != 0 {
            return Err(GuestError::new(
                ErrorCode::SandboxSetupFailed,
                "Worker supplementary groups could not be cleared.",
            ));
        }
        if libc::setresgid(gid, gid, gid) != 0 || libc::setresuid(uid, uid, uid) != 0 {
            return Err(GuestError::new(
                ErrorCode::SandboxSetupFailed,
                "Worker privilege drop failed.",
            ));
        }
        for capability in 0..=40 {
            libc::prctl(libc::PR_CAPBSET_DROP, capability, 0, 0, 0);
        }
    }
    Ok(())
}

pub fn install() -> Result<(), GuestError> {
    unsafe {
        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
            return Err(GuestError::new(
                ErrorCode::SandboxSetupFailed,
                "no_new_privs could not be enabled.",
            ));
        }
    }
    let mut filter = build_filter();
    let program = libc::sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_mut_ptr(),
    };
    let result =
        unsafe { libc::syscall(libc::SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0_u32, &program) };
    if result != 0 {
        return Err(GuestError::new(
            ErrorCode::SandboxSetupFailed,
            "seccomp could not be enabled.",
        ));
    }
    let _ = SECCOMP_FILTER_FLAG_TSYNC;
    Ok(())
}

pub fn is_active() -> bool {
    unsafe { libc::prctl(libc::PR_GET_SECCOMP, 0, 0, 0, 0) == 2 }
}

fn build_filter() -> Vec<libc::sock_filter> {
    let mut filter = vec![
        stmt(BPF_LD_W_ABS, SECCOMP_DATA_ARCH),
        jump(BPF_JMP_JEQ_K, AUDIT_ARCH_X86_64, 1, 0),
        stmt(BPF_RET_K, SECCOMP_RET_KILL_PROCESS),
        stmt(BPF_LD_W_ABS, SECCOMP_DATA_NR),
    ];
    for syscall in allowed_syscalls() {
        filter.push(jump(BPF_JMP_JEQ_K, syscall, 0, 1));
        filter.push(stmt(BPF_RET_K, SECCOMP_RET_ALLOW));
    }
    append_clone3_fallback_rule(&mut filter);
    append_clone_rule(&mut filter);
    filter.push(stmt(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM));
    filter
}

fn append_clone3_fallback_rule(filter: &mut Vec<libc::sock_filter>) {
    // clone3() takes a pointer to clone_args, so seccomp cannot safely inspect
    // its flags. Return ENOSYS so libc/libuv use the constrained clone path
    // below instead of treating the policy denial as a hard EPERM failure.
    filter.push(jump(BPF_JMP_JEQ_K, libc::SYS_clone3 as u32, 0, 1));
    filter.push(stmt(BPF_RET_K, SECCOMP_RET_ERRNO | ENOSYS));
}

fn append_clone_rule(filter: &mut Vec<libc::sock_filter>) {
    filter.push(jump(BPF_JMP_JEQ_K, libc::SYS_clone as u32, 0, 10));
    filter.push(stmt(BPF_LD_W_ABS, SECCOMP_DATA_ARG0_HI));
    filter.push(jump(BPF_JMP_JEQ_K, 0, 0, 8));
    filter.push(stmt(BPF_LD_W_ABS, SECCOMP_DATA_ARG0_LO));
    filter.push(stmt(BPF_ALU_AND_K, !CLONE_SAFE_FLAGS));
    filter.push(jump(BPF_JMP_JEQ_K, 0, 0, 5));
    filter.push(stmt(BPF_LD_W_ABS, SECCOMP_DATA_ARG0_LO));
    filter.push(stmt(BPF_ALU_AND_K, 0xff));
    filter.push(jump(BPF_JMP_JEQ_K, 0, 1, 0));
    filter.push(jump(BPF_JMP_JEQ_K, libc::SIGCHLD as u32, 0, 1));
    filter.push(stmt(BPF_RET_K, SECCOMP_RET_ALLOW));
}

fn allowed_syscalls() -> Vec<u32> {
    vec![
        libc::SYS_read as u32,
        libc::SYS_write as u32,
        libc::SYS_close as u32,
        libc::SYS_close_range as u32,
        libc::SYS_fcntl as u32,
        libc::SYS_fstat as u32,
        libc::SYS_fstatfs as u32,
        libc::SYS_newfstatat as u32,
        libc::SYS_stat as u32,
        libc::SYS_statfs as u32,
        libc::SYS_lstat as u32,
        libc::SYS_faccessat as u32,
        libc::SYS_faccessat2 as u32,
        libc::SYS_getdents64 as u32,
        libc::SYS_lseek as u32,
        libc::SYS_mmap as u32,
        libc::SYS_mprotect as u32,
        libc::SYS_munmap as u32,
        libc::SYS_mremap as u32,
        libc::SYS_madvise as u32,
        libc::SYS_brk as u32,
        libc::SYS_rt_sigaction as u32,
        libc::SYS_rt_sigprocmask as u32,
        libc::SYS_rt_sigreturn as u32,
        libc::SYS_ioctl as u32,
        libc::SYS_pread64 as u32,
        libc::SYS_pwrite64 as u32,
        libc::SYS_ftruncate as u32,
        libc::SYS_fsync as u32,
        libc::SYS_fdatasync as u32,
        libc::SYS_fallocate as u32,
        libc::SYS_readv as u32,
        libc::SYS_writev as u32,
        libc::SYS_sendfile as u32,
        libc::SYS_copy_file_range as u32,
        libc::SYS_shutdown as u32,
        libc::SYS_access as u32,
        libc::SYS_pipe as u32,
        libc::SYS_pipe2 as u32,
        libc::SYS_socketpair as u32,
        libc::SYS_dup as u32,
        libc::SYS_dup2 as u32,
        libc::SYS_dup3 as u32,
        libc::SYS_nanosleep as u32,
        libc::SYS_clock_gettime as u32,
        libc::SYS_clock_nanosleep as u32,
        libc::SYS_setitimer as u32,
        libc::SYS_getpid as u32,
        libc::SYS_getppid as u32,
        libc::SYS_gettid as u32,
        libc::SYS_futex as u32,
        libc::SYS_set_tid_address as u32,
        libc::SYS_set_robust_list as u32,
        libc::SYS_arch_prctl as u32,
        libc::SYS_prlimit64 as u32,
        libc::SYS_getrlimit as u32,
        libc::SYS_getrusage as u32,
        libc::SYS_sysinfo as u32,
        libc::SYS_getrandom as u32,
        libc::SYS_rseq as u32,
        libc::SYS_prctl as u32,
        libc::SYS_uname as u32,
        libc::SYS_umask as u32,
        libc::SYS_readlink as u32,
        libc::SYS_readlinkat as u32,
        libc::SYS_chdir as u32,
        libc::SYS_fchdir as u32,
        libc::SYS_getcwd as u32,
        libc::SYS_mkdir as u32,
        libc::SYS_mkdirat as u32,
        libc::SYS_rmdir as u32,
        libc::SYS_unlink as u32,
        libc::SYS_unlinkat as u32,
        libc::SYS_rename as u32,
        libc::SYS_renameat as u32,
        libc::SYS_renameat2 as u32,
        libc::SYS_chmod as u32,
        libc::SYS_fchmod as u32,
        libc::SYS_fchmodat as u32,
        libc::SYS_utimensat as u32,
        libc::SYS_open as u32,
        libc::SYS_openat as u32,
        libc::SYS_openat2 as u32,
        libc::SYS_execve as u32,
        libc::SYS_execveat as u32,
        libc::SYS_fork as u32,
        libc::SYS_vfork as u32,
        libc::SYS_exit as u32,
        libc::SYS_exit_group as u32,
        libc::SYS_wait4 as u32,
        libc::SYS_waitid as u32,
        libc::SYS_setpgid as u32,
        libc::SYS_getpgid as u32,
        libc::SYS_setsid as u32,
        libc::SYS_sigaltstack as u32,
        libc::SYS_sched_getaffinity as u32,
        libc::SYS_sched_yield as u32,
        libc::SYS_epoll_create1 as u32,
        libc::SYS_epoll_ctl as u32,
        libc::SYS_epoll_wait as u32,
        libc::SYS_epoll_pwait as u32,
        libc::SYS_epoll_pwait2 as u32,
        libc::SYS_poll as u32,
        libc::SYS_ppoll as u32,
        libc::SYS_eventfd2 as u32,
        libc::SYS_timerfd_create as u32,
        libc::SYS_timerfd_settime as u32,
        libc::SYS_membarrier as u32,
        libc::SYS_statx as u32,
        libc::SYS_geteuid as u32,
        libc::SYS_getuid as u32,
        libc::SYS_getegid as u32,
        libc::SYS_getgid as u32,
    ]
}

fn stmt(code: u16, k: u32) -> libc::sock_filter {
    libc::sock_filter {
        code,
        jt: 0,
        jf: 0,
        k,
    }
}

fn jump(code: u16, k: u32, jt: u8, jf: u8) -> libc::sock_filter {
    libc::sock_filter { code, jt, jf, k }
}

#[cfg(test)]
mod tests {
    use std::ffi::CString;
    use std::path::Path;

    use super::{allowed_syscalls, build_filter, resolve_user_ids, ANONYMOUS_GID, ANONYMOUS_UID};

    #[test]
    fn identity_resolution_defaults_to_nobody_and_rejects_root() {
        assert_eq!(
            resolve_user_ids(None).unwrap(),
            (ANONYMOUS_UID, ANONYMOUS_GID)
        );
        assert!(resolve_user_ids(Some("root")).is_err());
    }

    #[test]
    fn filter_has_arch_guard_and_deny_tail() {
        let filter = build_filter();
        assert!(filter.len() > 10);
        assert_eq!(filter[0].k, 4);
        assert_eq!(
            filter.last().map(|item| item.k & 0xffff_0000),
            Some(0x0005_0000)
        );
    }

    #[test]
    fn process_run_has_required_filesystem_calls_without_namespace_escape() {
        let allowed = allowed_syscalls();

        for syscall in [
            libc::SYS_fcntl,
            libc::SYS_ftruncate,
            libc::SYS_fsync,
            libc::SYS_fdatasync,
            libc::SYS_fstatfs,
            libc::SYS_statfs,
            libc::SYS_mkdir,
            libc::SYS_mkdirat,
            libc::SYS_rmdir,
            libc::SYS_unlink,
            libc::SYS_unlinkat,
            libc::SYS_rename,
            libc::SYS_renameat,
            libc::SYS_renameat2,
            libc::SYS_chmod,
            libc::SYS_fchmod,
            libc::SYS_fchmodat,
            libc::SYS_utimensat,
            libc::SYS_open,
            libc::SYS_openat2,
            libc::SYS_close_range,
            libc::SYS_epoll_pwait,
            libc::SYS_epoll_pwait2,
            libc::SYS_timerfd_create,
            libc::SYS_timerfd_settime,
            libc::SYS_waitid,
            libc::SYS_sigaltstack,
            libc::SYS_getrusage,
            libc::SYS_sysinfo,
            libc::SYS_umask,
            libc::SYS_socketpair,
            libc::SYS_shutdown,
            libc::SYS_fork,
            libc::SYS_vfork,
        ] {
            assert!(
                allowed.contains(&(syscall as u32)),
                "missing syscall {syscall}"
            );
        }

        for syscall in [
            libc::SYS_clone,
            libc::SYS_clone3,
            libc::SYS_unshare,
            libc::SYS_setns,
            libc::SYS_mount,
            libc::SYS_umount2,
            libc::SYS_pivot_root,
            libc::SYS_ptrace,
            libc::SYS_bpf,
        ] {
            assert!(
                !allowed.contains(&(syscall as u32)),
                "dangerous syscall {syscall}"
            );
        }
    }

    #[test]
    fn seccomp_stays_active_for_a_basic_node_process() {
        if !Path::new("/usr/bin/node").is_file() {
            return;
        }
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0, "could not fork seccomp smoke process");
        if pid == 0 {
            if super::install().is_err() || !super::is_active() {
                unsafe { libc::_exit(125) };
            }
            let executable = CString::new("/usr/bin/node").unwrap();
            let argument = CString::new("-e").unwrap();
            let eval = CString::new("process.stdout.write('ok')").unwrap();
            let mut argv = [
                executable.as_ptr(),
                argument.as_ptr(),
                eval.as_ptr(),
                std::ptr::null(),
            ];
            let envp = [std::ptr::null()];
            unsafe {
                libc::execve(executable.as_ptr(), argv.as_mut_ptr(), envp.as_ptr());
                libc::_exit(126);
            }
        }
        let mut status = 0;
        unsafe { libc::waitpid(pid, &mut status, 0) };
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 0);
    }

    #[test]
    fn seccomp_allows_node_spawn_sync_without_opening_the_syscall_surface() {
        if !Path::new("/usr/bin/node").is_file() {
            return;
        }
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0, "could not fork seccomp spawnSync smoke process");
        if pid == 0 {
            if super::install().is_err() || !super::is_active() {
                unsafe { libc::_exit(125) };
            }
            let executable = CString::new("/usr/bin/node").unwrap();
            let argument = CString::new("-e").unwrap();
            let eval = CString::new(
                "const c=require('node:child_process').spawnSync(process.execPath,['-e',\"process.stdout.write('child-ok')\"],{encoding:'utf8'}); if(c.error||c.status!==0) { process.stderr.write(String(c.error?.code||c.stderr||c.status)); process.exit(126); } process.stdout.write(c.stdout);",
            )
            .unwrap();
            let mut argv = [
                executable.as_ptr(),
                argument.as_ptr(),
                eval.as_ptr(),
                std::ptr::null(),
            ];
            let envp = [std::ptr::null()];
            unsafe {
                libc::execve(executable.as_ptr(), argv.as_mut_ptr(), envp.as_ptr());
                libc::_exit(126);
            }
        }
        let mut status = 0;
        unsafe { libc::waitpid(pid, &mut status, 0) };
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 0);
    }
}
