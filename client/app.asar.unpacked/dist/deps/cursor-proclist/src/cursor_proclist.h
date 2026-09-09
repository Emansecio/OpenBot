#ifndef CURSOR_PROCLIST_H
#define CURSOR_PROCLIST_H

// ============================================================================
// cursor-proclist: Native module for process tree enumeration
// ============================================================================
//
// This module provides a single function `cursor_proclist()` that returns
// detailed information about a given root process (typically the Cursor main
// process) and all of its descendant processes.
//
// For each process, it collects:
//   - Identity: PID, PPID, process name/title
//   - Metrics: CPU time (ms), memory usage (MB)
//   - Attribution: Environment variables for extension/agent tracking (where
//     available; Windows currently does not populate extensionId/ownerAgentId).
// =========================================================================

#if defined(__APPLE__) || defined(__linux__)

#include <sys/types.h>

#elif defined(_WIN32)

// Windows process IDs are DWORD (unsigned 32-bit)
typedef unsigned int pid_t;

#endif

#include <string>
#include <vector>
#include <cstdint>

/**
 * Structure to hold process information
 */
struct ProcessInfo {
    pid_t pid;
    pid_t ppid;
    std::string name;
    std::vector<std::string> argv;  // Full argument vector (macOS/Linux only; empty on Windows)

    // Performance metrics (raw values)
    uint64_t cpuTimeMs;             // Total CPU time in milliseconds (user + system)
    uint64_t memoryMB;              // Memory in MB (resident set size)

    // Attribution (optional)
    std::string extensionId;        // From CURSOR_SPAWNED_BY_EXTENSION_ID
    std::string ownerAgentId;       // From CURSOR_OWNER_AGENT_ID
};

/**
 * Get all information for a process (identity, metrics, attribution).
 * Returns true on success, false if process info cannot be retrieved.
 */
bool getProcessInformation(pid_t pid, ProcessInfo& info);

/**
 * Return the union of every root in `rootPids` and their descendants, walked as
 * a bounded per-root breadth-first traversal that de-duplicates overlapping
 * subtrees.
 * `includeRoot` controls whether the roots themselves are included in the output.
 * Platform-specific implementation may use OS-optimized enumeration.
 */
std::vector<pid_t> getDescendantPids(const std::vector<pid_t>& rootPids, bool includeRoot);

/**
 * System-wide memory availability. Implemented for macOS ONLY: it is the one
 * platform where userland JS cannot obtain a truthful "available" figure
 * (Node's os.freemem() reports only the free list, excluding reclaimable
 * inactive/purgeable memory). Windows (os.freemem() == ullAvailPhys) and Linux
 * (/proc/meminfo MemAvailable, read JS-side) already have canonical userland
 * sources, so their implementations are stubs returning false and callers fall
 * back to those.
 *
 * macOS source: host_statistics64(HOST_VM_INFO64) + sysctlbyname("hw.memsize");
 * availableBytes = (free + inactive + purgeable − compressor) pages — the
 * ecosystem-consensus formula (Rust sysinfo; Chromium computes a close
 * variant). pressureLevel = kern.memorystatus_vm_pressure_level (1 = normal,
 * 2 = warning, 4 = critical) when readable.
 */
struct SystemMemoryInfo {
    uint64_t totalBytes = 0;
    uint64_t availableBytes = 0;
    int pressureLevel = 0;          // meaningful only when hasPressureLevel
    bool hasPressureLevel = false;  // macOS only
};

/**
 * Fill `out` with current system memory availability.
 * Returns false when unsupported on this platform or unreadable (callers fall back).
 */
bool getSystemMemoryInfo(SystemMemoryInfo& out);

#endif  // CURSOR_PROCLIST_H
