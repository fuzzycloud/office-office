fn main() {
    connectrpc_build::Config::new()
        .files(&["../../proto/office/v1/office.proto"])
        .includes(&["../../proto"])
        .include_file("_connectrpc.rs")
        .compile()
        .expect("compile OfficeService protobuf definitions");
}
