/*
 * genie-launch.exe — HOW GENIE STARTS A PROCESS ON WINDOWS WHEN WHAT IT INHERITS, OR WHAT IT STARTS, MATTERS (#1628, #1639).
 *
 * Node's spawn is CreateProcess with bInheritHandles=TRUE: the child keeps every inheritable handle of its parent (CI
 * measured genie-host holding the first window's DevTools socket after that window was ended, so a relaunched window
 * could not serve its port). And a process tree on Windows cannot be walked reliably after the fact (Git's MSYS sh starts
 * background children from fork processes that exit at once, so their parent id names nothing). This starts the child
 * the way Node cannot:
 *
 *   genie-launch.exe detach <log file> <program> [args...]
 *     The child inherits ONLY its three standard handles (the log file, twice, and NUL as input): a handle list
 *     (PROC_THREAD_ATTRIBUTE_HANDLE_LIST), never the rest of this process's. Detached, in its own process group, hidden,
 *     out of any job this one is in where the job allows it. Prints the child's pid and exits: the caller waits for the
 *     child itself, never for this.
 *
 *   genie-launch.exe job <program> [args...]
 *     The child inherits ONLY this process's three standard handles, and runs inside a job object created here, with
 *     KILL_ON_JOB_CLOSE: everything it starts, however it starts it, is in the job. It is created suspended, put in the
 *     job, then resumed, so nothing it starts can run before. This waits for it and exits with its exit code. Ending THIS
 *     process (the caller's limit) closes the job, and the job ends every process in it. A child that ends by itself
 *     leaves what it started as it is: the kill is lifted first (the behaviour without the job).
 *
 * Exit 125 = this could not start the child (the reason on stderr). No CRT beyond what MSVC links; no other dependency.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

#define LAUNCH_FAILED 125

static void say(const wchar_t *what, DWORD error) {
    fwprintf(stderr, L"genie-launch: %ls (error %lu)\n", what, (unsigned long)error);
}

/* One argument, quoted the way CommandLineToArgvW and the MSVC runtime read it back. */
static int append_arg(wchar_t **buf, size_t *len, size_t *cap, const wchar_t *arg) {
    size_t n = wcslen(arg);
    size_t need = *len + n * 2 + 4;
    if (need > *cap) {
        size_t next = need * 2;
        wchar_t *grown = (wchar_t *)realloc(*buf, next * sizeof(wchar_t));
        if (!grown) return 0;
        *buf = grown;
        *cap = next;
    }
    wchar_t *out = *buf + *len;
    if (*len > 0) *out++ = L' ';
    int plain = n > 0 && wcspbrk(arg, L" \t\n\v\"") == NULL;
    if (plain) {
        wmemcpy(out, arg, n);
        out += n;
    } else {
        *out++ = L'"';
        for (size_t i = 0; ; i++) {
            size_t slashes = 0;
            while (i < n && arg[i] == L'\\') { slashes++; i++; }
            if (i == n) { for (size_t k = 0; k < slashes * 2; k++) *out++ = L'\\'; break; }
            if (arg[i] == L'"') { for (size_t k = 0; k < slashes * 2 + 1; k++) *out++ = L'\\'; *out++ = L'"'; }
            else { for (size_t k = 0; k < slashes; k++) *out++ = L'\\'; *out++ = arg[i]; }
        }
        *out++ = L'"';
    }
    *out = L'\0';
    *len = (size_t)(out - *buf);
    return 1;
}

static wchar_t *command_line(int argc, wchar_t **argv, int from) {
    size_t len = 0, cap = 256;
    wchar_t *buf = (wchar_t *)malloc(cap * sizeof(wchar_t));
    if (!buf) return NULL;
    buf[0] = L'\0';
    for (int i = from; i < argc; i++) if (!append_arg(&buf, &len, &cap, argv[i])) { free(buf); return NULL; }
    return buf;
}

static HANDLE inheritable(HANDLE h) {
    if (h == NULL || h == INVALID_HANDLE_VALUE) return NULL;
    HANDLE copy = NULL;
    if (!DuplicateHandle(GetCurrentProcess(), h, GetCurrentProcess(), &copy, 0, TRUE, DUPLICATE_SAME_ACCESS)) return NULL;
    return copy;
}

/* The child, with exactly these standard handles inheritable and nothing else (the handle list). */
static BOOL start(wchar_t *program, wchar_t *cmd, HANDLE in, HANDLE out, HANDLE err, DWORD flags, PROCESS_INFORMATION *pi) {
    HANDLE list[3];
    DWORD count = 0;
    HANDLE std3[3] = { in, out, err };
    for (int i = 0; i < 3; i++) {
        if (std3[i] == NULL) continue;
        int dup = 0;
        for (DWORD k = 0; k < count; k++) if (list[k] == std3[i]) dup = 1;
        if (!dup) list[count++] = std3[i];
    }
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(NULL, 1, 0, &size);
    LPPROC_THREAD_ATTRIBUTE_LIST attrs = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, size);
    if (!attrs || !InitializeProcThreadAttributeList(attrs, 1, 0, &size)) { say(L"no attribute list", GetLastError()); return FALSE; }
    BOOL inherit = count > 0;
    if (inherit && !UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, list, count * sizeof(HANDLE), NULL, NULL)) {
        say(L"the handle list could not be set", GetLastError());
        DeleteProcThreadAttributeList(attrs);
        return FALSE;
    }
    STARTUPINFOEXW si;
    ZeroMemory(&si, sizeof(si));
    si.StartupInfo.cb = sizeof(si);
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.StartupInfo.wShowWindow = SW_HIDE;
    si.StartupInfo.hStdInput = in;
    si.StartupInfo.hStdOutput = out;
    si.StartupInfo.hStdError = err;
    si.lpAttributeList = attrs;
    BOOL ok = CreateProcessW(program, cmd, NULL, NULL, inherit, flags | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, NULL, NULL, &si.StartupInfo, pi);
    DWORD error = ok ? 0 : GetLastError();
    DeleteProcThreadAttributeList(attrs);
    HeapFree(GetProcessHeap(), 0, attrs);
    SetLastError(error);
    return ok;
}

static int detach(int argc, wchar_t **argv) {
    if (argc < 4) { fwprintf(stderr, L"genie-launch: detach <log file> <program> [args...]\n"); return LAUNCH_FAILED; }
    SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
    HANDLE log = CreateFileW(argv[2], FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, &sa, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (log == INVALID_HANDLE_VALUE) { say(L"the log file could not be opened", GetLastError()); return LAUNCH_FAILED; }
    HANDLE nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, NULL);
    if (nul == INVALID_HANDLE_VALUE) nul = NULL;
    wchar_t *cmd = command_line(argc, argv, 3);
    if (!cmd) { say(L"out of memory", ERROR_OUTOFMEMORY); return LAUNCH_FAILED; }
    PROCESS_INFORMATION pi;
    DWORD flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    BOOL ok = start(argv[3], cmd, nul, log, log, flags | CREATE_BREAKAWAY_FROM_JOB, &pi);
    if (!ok && GetLastError() == ERROR_ACCESS_DENIED) ok = start(argv[3], cmd, nul, log, log, flags, &pi);
    if (!ok) { say(L"the program could not be started", GetLastError()); return LAUNCH_FAILED; }
    wprintf(L"%lu\n", (unsigned long)pi.dwProcessId);
    fflush(stdout);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return 0;
}

static int job(int argc, wchar_t **argv) {
    if (argc < 3) { fwprintf(stderr, L"genie-launch: job <program> [args...]\n"); return LAUNCH_FAILED; }
    HANDLE jobh = CreateJobObjectW(NULL, NULL);
    if (!jobh) { say(L"no job object", GetLastError()); return LAUNCH_FAILED; }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    ZeroMemory(&limits, sizeof(limits));
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(jobh, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) { say(L"the job could not be set to end its processes", GetLastError()); return LAUNCH_FAILED; }
    HANDLE in = inheritable(GetStdHandle(STD_INPUT_HANDLE));
    HANDLE out = inheritable(GetStdHandle(STD_OUTPUT_HANDLE));
    HANDLE err = inheritable(GetStdHandle(STD_ERROR_HANDLE));
    wchar_t *cmd = command_line(argc, argv, 2);
    if (!cmd) { say(L"out of memory", ERROR_OUTOFMEMORY); return LAUNCH_FAILED; }
    PROCESS_INFORMATION pi;
    if (!start(argv[2], cmd, in, out, err, CREATE_SUSPENDED, &pi)) { say(L"the program could not be started", GetLastError()); return LAUNCH_FAILED; }
    if (!AssignProcessToJobObject(jobh, pi.hProcess)) {
        // Nothing it starts may escape: a child that cannot be put in the job is not run.
        say(L"the program could not be put in the job", GetLastError());
        TerminateProcess(pi.hProcess, LAUNCH_FAILED);
        return LAUNCH_FAILED;
    }
    if (in) CloseHandle(in);
    if (out) CloseHandle(out);
    if (err) CloseHandle(err);
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = LAUNCH_FAILED;
    GetExitCodeProcess(pi.hProcess, &code);
    // Ended by itself: what it started is left as it would be without the job. Only this process ending early ends it all.
    limits.BasicLimitInformation.LimitFlags = 0;
    SetInformationJobObject(jobh, JobObjectExtendedLimitInformation, &limits, sizeof(limits));
    CloseHandle(pi.hProcess);
    CloseHandle(jobh);
    return (int)code;
}

int wmain(int argc, wchar_t **argv) {
    if (argc >= 2 && wcscmp(argv[1], L"detach") == 0) return detach(argc, argv);
    if (argc >= 2 && wcscmp(argv[1], L"job") == 0) return job(argc, argv);
    fwprintf(stderr, L"genie-launch: detach <log file> <program> [args...] | job <program> [args...]\n");
    return LAUNCH_FAILED;
}
