fn main() {
    // Build scripts run for the host, so cfg!(target_os) is wrong while
    // cross-compiling from Windows to Android. Cargo exposes the actual target.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-lib=advapi32");
    }
}
