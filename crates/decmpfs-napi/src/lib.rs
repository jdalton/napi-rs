//! Self-loading trampoline stub. The compressed addon ships AS this `.node` —
//! `[stub image][zstd payload][footer]` in one file; Node `dlopen`s it and calls
//! `napi_register_module_v1`, which:
//!   1. finds its own path (the stub installed as e.g. `foo.node`),
//!   2. `decmpfs::resolve_self`s it to a loadable raw addon (rewrite the file in place
//!      into the FS-compressed addon where the OS supports it; else decode the
//!      appended payload to the ephemeral cache — only the footer is read on a warm
//!      cache hit),
//!   3. `dlopen`s that and forwards the SAME (env, exports) to its register,
//!   4. returns the real addon's exports as its own.
//!
//! Zero wiring: no JS loader, no optionalDependency, no enable. The stub never
//! calls a napi API itself — it only forwards opaque pointers.

use std::ffi::c_void;
use std::path::{Path, PathBuf};

type NapiEnv = *mut c_void;
type NapiValue = *mut c_void;
type RegisterFn = unsafe extern "C" fn(NapiEnv, NapiValue) -> NapiValue;

/// Node's entry point for a native addon. Fail-soft: on any failure we return the
/// (empty) exports we were given rather than crash the host.
///
/// # Safety
/// Called by Node with a valid env/exports during module load.
#[no_mangle]
pub unsafe extern "C" fn napi_register_module_v1(env: NapiEnv, exports: NapiValue) -> NapiValue {
  match trampoline(env, exports) {
    Some(real_exports) => real_exports,
    None => exports,
  }
}

unsafe fn trampoline(env: NapiEnv, exports: NapiValue) -> Option<NapiValue> {
  let stub = own_path()?;
  // The stub's own file is [stub image][zstd payload][footer]; resolve_self reads its
  // own trailer to return a loadable raw addon (self-rewritten in place on a
  // compressing FS, else cached). It reads only the footer on a warm cache hit — no
  // payload read, no decode — so we hand it the path, not the bytes.
  let loadable = decmpfs::resolve_self(&stub)?;
  let register = load_register(&loadable)?;
  Some(register(env, exports))
}

#[cfg(unix)]
unsafe fn own_path() -> Option<PathBuf> {
  use std::os::unix::ffi::OsStrExt;
  let mut info: libc::Dl_info = std::mem::zeroed();
  if libc::dladdr(napi_register_module_v1 as *const c_void, &mut info) == 0
    || info.dli_fname.is_null()
  {
    return None;
  }
  let bytes = std::ffi::CStr::from_ptr(info.dli_fname).to_bytes();
  Some(PathBuf::from(std::ffi::OsStr::from_bytes(bytes)))
}

#[cfg(unix)]
unsafe fn load_register(path: &Path) -> Option<RegisterFn> {
  use std::os::unix::ffi::OsStrExt;
  let cpath = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
  let handle = libc::dlopen(cpath.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL);
  if handle.is_null() {
    return None;
  }
  let sym = libc::dlsym(handle, c"napi_register_module_v1".as_ptr());
  if sym.is_null() {
    return None;
  }
  Some(std::mem::transmute::<*mut c_void, RegisterFn>(sym))
}

#[cfg(windows)]
unsafe fn own_path() -> Option<PathBuf> {
  use std::os::windows::ffi::OsStringExt;

  use windows_sys::Win32::System::LibraryLoader::{
    GetModuleFileNameW, GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
    GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
  };

  let mut module = std::ptr::null_mut();
  let ok = GetModuleHandleExW(
    GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
    napi_register_module_v1 as *const u16,
    &mut module,
  );
  if ok == 0 {
    return None;
  }
  let mut buf = [0u16; 32768];
  let len = GetModuleFileNameW(module, buf.as_mut_ptr(), buf.len() as u32);
  if len == 0 {
    return None;
  }
  Some(PathBuf::from(std::ffi::OsString::from_wide(
    &buf[..len as usize],
  )))
}

#[cfg(windows)]
unsafe fn load_register(path: &Path) -> Option<RegisterFn> {
  use std::os::windows::ffi::OsStrExt;

  use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

  let wide: Vec<u16> = path
    .as_os_str()
    .encode_wide()
    .chain(std::iter::once(0))
    .collect();
  let module = LoadLibraryW(wide.as_ptr());
  if module.is_null() {
    return None;
  }
  let proc = GetProcAddress(module, c"napi_register_module_v1".as_ptr().cast())?;
  Some(std::mem::transmute::<
    unsafe extern "system" fn() -> isize,
    RegisterFn,
  >(proc))
}
