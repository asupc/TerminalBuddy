/// 为浏览器终端提供宿主机的 ConPTY 渲染参数；Linux 返回空值。
#[cfg(windows)]
pub fn windows_build_number() -> Option<u32> {
    #[repr(C)]
    struct VersionInfo { size: u32, major: u32, minor: u32, build: u32, platform: u32, service_pack: [u16; 128] }
    #[link(name = "ntdll")]
    extern "system" {
        #[link_name = "RtlGetVersion"]
        fn get_version(info: *mut VersionInfo) -> i32;
    }
    unsafe {
        let mut info: VersionInfo = std::mem::zeroed();
        info.size = std::mem::size_of::<VersionInfo>() as u32;
        (get_version(&mut info) >= 0).then_some(info.build)
    }
}
#[cfg(not(windows))]
pub fn windows_build_number() -> Option<u32> { None }
