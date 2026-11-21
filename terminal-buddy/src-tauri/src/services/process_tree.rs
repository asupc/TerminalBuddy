//! 子进程树的统一终止：Windows 用 Job Object，不再 spawn `taskkill`。
//!
//! 此前 Windows 侧用 `taskkill /T /F /PID <pid>` 结束 CLI 进程树，有两个硬伤：
//! - TB 是 GUI 子系统程序（`windows_subsystem = "windows"`），spawn 控制台程序会
//!   弹出黑色控制台窗口，并在进程已自然退出时打出 `ERROR: The process ... not found`
//!   之类的提示——关闭 TB 时用户看到的就是这个报错；
//! - 父进程先退出后 PID 会被系统复用，`/T` 沿已复用的 PID 找错对象，可能杀掉无关进程。
//!
//! Job Object 是纯内核句柄操作：spawn 后立即把子进程加入 job，`TerminateJobObject`
//! 一次性结束整棵树，`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 保证 Drop 关闭句柄时
//! 残留后代也被回收。已知固有窗口：spawn 到 `AssignProcessToJobObject` 之间派生的
//! 后代会逃出 job；消除它需要 `CREATE_SUSPENDED` + 恢复主线程的额外机制，这里按
//! 可接受的残余风险处理（与 `commands/git.rs` 的既有取舍一致）。
//!
//! Unix 侧不建 job：调用方仍按进程组发信号，`terminate` 退化为 `child.kill()`。

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

/// 一个子进程的树生命周期。必须在 `spawn` 之后立即构造，并和 `Child` 同生共死。
pub(crate) struct ProcessTree {
    #[cfg(windows)]
    job: Option<windows::Win32::Foundation::HANDLE>,
}

// Windows 内核句柄没有线程亲和性：`ProcessTree` 独占该 HANDLE，只会整体 move 到
// 回收线程，并在 Drop 时关闭一次，因此跨线程转移所有权是安全的。实时会话的
// `Process::drop` 正是在独立线程里终止进程树，需要这个 `Send`。
#[cfg(windows)]
unsafe impl Send for ProcessTree {}

impl ProcessTree {
    /// spawn 之后立即调用。建 job 失败（老系统、权限受限）时退化为只杀直接子进程。
    pub(crate) fn attach(child: &std::process::Child) -> Self {
        #[cfg(windows)]
        {
            use windows::Win32::Foundation::{CloseHandle, HANDLE};
            use windows::Win32::System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            };

            let Ok(job) = (unsafe { CreateJobObjectW(None, None) }) else {
                return Self { job: None };
            };
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            }
            .is_ok();
            // Windows 8 起支持嵌套 job，子进程已在别的 job 里也能加入成功。
            let assigned = unsafe {
                AssignProcessToJobObject(job, HANDLE(child.as_raw_handle() as _))
            }
            .is_ok();
            if configured && assigned {
                Self { job: Some(job) }
            } else {
                unsafe { let _ = CloseHandle(job); }
                Self { job: None }
            }
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            Self {}
        }
    }

    /// 终止整棵进程树。Windows 先走 `TerminateJobObject`，失败或未建 job 时退回
    /// `child.kill()`；Unix 直接 `child.kill()`（进程组信号由调用方自行补发）。
    pub(crate) fn terminate(&mut self, child: &mut std::process::Child) {
        #[cfg(windows)]
        if let Some(job) = self.job {
            use windows::Win32::System::JobObjects::TerminateJobObject;
            if unsafe { TerminateJobObject(job, 1) }.is_ok() {
                return;
            }
        }
        let _ = child.kill();
    }
}

#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        if let Some(job) = self.job.take() {
            // KILL_ON_JOB_CLOSE：最后一个句柄关闭即回收所有仍存活的后代。
            unsafe { let _ = windows::Win32::Foundation::CloseHandle(job); }
        }
    }
}
